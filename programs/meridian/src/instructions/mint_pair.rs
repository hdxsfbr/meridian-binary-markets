//! `mint_pair` (stub; implemented in Wave 3, T026).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct MintPair<'info> {
    pub user: Signer<'info>,
}

pub fn handle_mint_pair(_ctx: Context<MintPair>, _qty: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
