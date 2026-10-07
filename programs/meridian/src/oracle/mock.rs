//! MockPyth provider arm (Wave 3B, T037).
//!
//! Validates and parses a `MockPriceUpdate` account: owned by this program, at the
//! expected `["mock_price", feed_id]` PDA, with a `feed_id` matching the ticker and a
//! `publisher` still in `Config.publishers`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::config::{Config, TickerInfo};
use crate::state::mock_price::{MockPriceUpdate, SEED as MOCK_PRICE_SEED};

/// Parses and validates `price_account` as the `MockPriceUpdate` for `ticker`. Returns
/// `(price, conf, expo, publish_time)` for the common guards in `oracle::read_quote`.
pub fn parse(
    config: &Config,
    ticker: &TickerInfo,
    price_account: &AccountInfo,
) -> Result<(i64, u64, i32, i64)> {
    if price_account.owner != &crate::ID {
        return Err(error!(MeridianError::OracleOwnerMismatch));
    }

    let (expected_pda, _bump) =
        Pubkey::find_program_address(&[MOCK_PRICE_SEED, ticker.feed_id.as_ref()], &crate::ID);
    if price_account.key() != expected_pda {
        return Err(error!(MeridianError::OracleOwnerMismatch));
    }

    let data_ref = price_account.try_borrow_data()?;
    let mut data: &[u8] = &data_ref;
    let update = MockPriceUpdate::try_deserialize(&mut data)?;

    if update.feed_id != ticker.feed_id {
        return Err(error!(MeridianError::OracleFeedMismatch));
    }

    if !config.is_publisher(&update.publisher) {
        return Err(error!(MeridianError::PublisherNotAllowed));
    }

    Ok((update.price, update.conf, update.expo, update.publish_time))
}
