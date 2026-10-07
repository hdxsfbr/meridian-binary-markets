//! `close_book` / `close_market` (stub; implemented in Wave 6, T081).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct CloseAccounts<'info> {
    pub admin: Signer<'info>,
}

pub fn handle_close_book(_ctx: Context<CloseAccounts>) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}

pub fn handle_close_market(_ctx: Context<CloseAccounts>) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
