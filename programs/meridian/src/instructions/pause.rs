//! `pause` / `unpause` (stub; implemented in Wave 4, T040).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub admin: Signer<'info>,
}

pub fn handle_pause(_ctx: Context<SetPause>) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}

pub fn handle_unpause(_ctx: Context<SetPause>) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
