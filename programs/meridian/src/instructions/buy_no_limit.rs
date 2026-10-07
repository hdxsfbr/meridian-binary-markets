//! `buy_no_limit` (stub; implemented in Wave 5, T057).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct BuyNoLimit<'info> {
    pub user: Signer<'info>,
}

pub fn handle_buy_no_limit(_ctx: Context<BuyNoLimit>, _qty: u64, _price: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
