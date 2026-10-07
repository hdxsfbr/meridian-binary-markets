//! MockPriceUpdate account (Wave 3B, T035).
//!
//! PDA `["mock_price", feed_id]`, provider `MockPyth` only. See
//! `specs/001-binary-outcome-markets/data-model.md` "MockPriceUpdate". Mirrors the
//! fields the program reads from Pyth's `PriceUpdateV2` (`PriceFeedMessage`), so
//! `oracle::read_quote` can return the same `OracleQuote` from either provider arm.

use anchor_lang::prelude::*;

/// Seed prefix for the MockPriceUpdate PDA: `["mock_price", feed_id]`.
pub const SEED: &[u8] = b"mock_price";

/// A publisher-written price observation for one feed, used only when
/// `Config.oracle_provider == MockPyth`.
#[account]
#[derive(InitSpace)]
pub struct MockPriceUpdate {
    /// Matches `TickerInfo.feed_id`.
    pub feed_id: [u8; 32],
    /// Same scale as Pyth: `price * 10^expo`.
    pub price: i64,
    /// Confidence interval, same scale as `price`.
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    /// Must be in `Config.publishers` at write time; checked again at settle.
    pub publisher: Pubkey,
    /// Slot at which this update was written.
    pub write_slot: u64,
    /// PDA bump.
    pub bump: u8,
}
