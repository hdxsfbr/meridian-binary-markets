//! `cancel_order` (stub; implemented in Wave 4, T055).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,
}

pub fn handle_cancel_order(_ctx: Context<CancelOrder>, _order_id: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
