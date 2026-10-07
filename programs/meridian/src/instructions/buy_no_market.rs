//! `buy_no_market` (stub; implemented in Wave 5, T056).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct BuyNoMarket<'info> {
    pub user: Signer<'info>,
}

pub fn handle_buy_no_market(_ctx: Context<BuyNoMarket>, _qty: u64, _min_yes_price: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
