//! `sell_no_market` (stub; implemented in Wave 5, T058).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SellNoMarket<'info> {
    pub user: Signer<'info>,
}

pub fn handle_sell_no_market(
    _ctx: Context<SellNoMarket>,
    _qty: u64,
    _max_yes_price: u64,
) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
