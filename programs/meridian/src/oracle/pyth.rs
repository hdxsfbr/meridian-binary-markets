//! PythReceiver provider arm (Wave 3B, T038).
//!
//! Validates and parses a `PriceUpdateV2` account (`pyth-solana-receiver-sdk`): owned by
//! `Config.oracle_program`, fully verified (`VerificationLevel::Full`), and carrying the
//! ticker's `feed_id`.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::errors::MeridianError;
use crate::state::config::{Config, TickerInfo};

/// Parses and validates `price_account` as a fully-verified `PriceUpdateV2` for
/// `ticker`. Returns `(price, conf, expo, publish_time)` for the common guards in
/// `oracle::read_quote`.
pub fn parse(
    config: &Config,
    ticker: &TickerInfo,
    price_account: &AccountInfo,
) -> Result<(i64, u64, i32, i64)> {
    if price_account.owner != &config.oracle_program {
        return Err(error!(MeridianError::OracleOwnerMismatch));
    }

    let data_ref = price_account.try_borrow_data()?;
    let mut data: &[u8] = &data_ref;
    let update = PriceUpdateV2::try_deserialize(&mut data)?;

    if update.verification_level != VerificationLevel::Full {
        return Err(error!(MeridianError::OracleVerificationLevel));
    }

    if update.price_message.feed_id != ticker.feed_id {
        return Err(error!(MeridianError::OracleFeedMismatch));
    }

    Ok((
        update.price_message.price,
        update.price_message.conf,
        update.price_message.exponent,
        update.price_message.publish_time,
    ))
}
