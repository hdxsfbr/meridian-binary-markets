//! `admin_settle_override` (stub; implemented in Wave 3, T029).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

#[derive(Accounts)]
pub struct AdminSettleOverride<'info> {
    pub admin: Signer<'info>,
}

pub fn handle_admin_settle_override(_ctx: Context<AdminSettleOverride>, _price: u64) -> Result<()> {
    Err(error!(MeridianError::NotImplemented))
}
