//! `pause` / `unpause` (Wave 3B, T040).
//!
//! Admin-only. Flips `Config.paused` (FR-034: blocks mint and order placement, never
//! redemption) and emits `Paused`/`Unpaused`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::{Paused, Unpaused};
use crate::state::config::Config;

pub fn handle_pause(ctx: Context<SetPause>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.config.paused = true;
    emit!(Paused {
        admin: ctx.accounts.admin.key(),
        ts: now,
    });
    Ok(())
}

pub fn handle_unpause(ctx: Context<SetPause>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.config.paused = false;
    emit!(Unpaused {
        admin: ctx.accounts.admin.key(),
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [crate::state::config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}
