//! `settle_market` (stub; implemented in Wave 4, T039).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Anyone may call `settle_market` (the automation service, in practice).
    pub caller: Signer<'info>,
}

pub fn handle_settle_market(_ctx: Context<SettleMarket>) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
