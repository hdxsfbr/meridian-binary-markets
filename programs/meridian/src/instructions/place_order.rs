//! `place_order` (stub; implemented in Wave 4, T054).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub user: Signer<'info>,
}

pub fn handle_place_order(
    _ctx: Context<PlaceOrder>,
    _side: u8,
    _price: u64,
    _qty: u64,
    _tif: u8,
) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
