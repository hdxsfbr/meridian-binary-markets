//! `redeem_pair` (stub; implemented in Wave 3, T027).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct RedeemPair<'info> {
    pub user: Signer<'info>,
}

pub fn handle_redeem_pair(_ctx: Context<RedeemPair>, _qty: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
