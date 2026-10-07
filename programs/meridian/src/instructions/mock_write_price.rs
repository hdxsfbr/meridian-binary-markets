//! `mock_write_price` (stub; implemented in Wave 4, T035).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct MockWritePrice<'info> {
    pub publisher: Signer<'info>,
}

pub fn handle_mock_write_price(
    _ctx: Context<MockWritePrice>,
    _feed_id: [u8; 32],
    _price: i64,
    _conf: u64,
    _expo: i32,
    _publish_time: i64,
) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
