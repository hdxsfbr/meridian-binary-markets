//! Oracle provider interface (Wave 3B, T036).
//!
//! `read_quote` dispatches on `Config.oracle_provider` to the `mock` or `pyth` arm for
//! owner/parse/attestation checks, then applies four guards common to both providers, in
//! the order fixed by `specs/001-binary-outcome-markets/contracts/oracle-provider.md`:
//! bad price, stale, too old, low confidence. Only a quote that passes all four reaches
//! `Market::resolve`.

pub mod mock;
pub mod pyth;

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::math::{conf_within_bps, normalize_conf, normalize_price};
use crate::state::config::{Config, OracleProvider, TickerInfo};
use crate::state::market::Market;

/// A normalised price observation, not stored on chain.
#[derive(Clone, Copy, Debug)]
pub struct OracleQuote {
    pub price_micro: u64,
    pub conf_micro: u64,
    pub publish_time: i64,
}

/// Reads and validates a price quote for `ticker` from `price_account`, per
/// `Config.oracle_provider`. See this module's doc comment for the guard order.
pub fn read_quote(
    config: &Config,
    ticker: &TickerInfo,
    market: &Market,
    price_account: &AccountInfo,
    clock: &Clock,
) -> Result<OracleQuote> {
    let (price, conf, expo, publish_time) = match config.oracle_provider {
        OracleProvider::MockPyth => mock::parse(config, ticker, price_account)?,
        OracleProvider::PythReceiver => pyth::parse(config, ticker, price_account)?,
    };

    // 1. OracleBadPrice: non-positive price or normalisation overflow/underflow.
    let price_micro = normalize_price(price, expo)?;
    let conf_micro = normalize_conf(conf, expo)?;

    // 2. OracleStale: price is older than the configured staleness window.
    let age = clock
        .unix_timestamp
        .checked_sub(publish_time)
        .ok_or_else(|| error!(MeridianError::OracleBadPrice))?;
    if age > config.max_staleness_secs as i64 {
        return Err(error!(MeridianError::OracleStale));
    }

    // 3. OracleTooOld: price must be from at/after close, not mid-session.
    let min_publish_time = market
        .close_ts
        .checked_sub(config.min_publish_offset_secs as i64)
        .ok_or_else(|| error!(MeridianError::OracleBadPrice))?;
    if publish_time < min_publish_time {
        return Err(error!(MeridianError::OracleTooOld));
    }

    // 4. OracleLowConfidence: confidence interval too wide relative to price.
    if !conf_within_bps(price_micro, conf_micro, config.max_conf_bps) {
        return Err(error!(MeridianError::OracleLowConfidence));
    }

    Ok(OracleQuote {
        price_micro,
        conf_micro,
        publish_time,
    })
}
