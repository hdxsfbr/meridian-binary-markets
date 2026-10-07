//! `redeem_winning` (stub; implemented in Wave 3, T028).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct RedeemWinning<'info> {
    pub user: Signer<'info>,
}

pub fn handle_redeem_winning(_ctx: Context<RedeemWinning>, _side: u8, _qty: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
