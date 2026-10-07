//! `admin_settle_override` (Wave 4, T029).
//!
//! Admin-only escape hatch for settlement when the automated oracle path never fires
//! (FR-033). Mirrors `settle_market`'s state transition exactly (same fields written,
//! same `Settled` event shape) except: only the admin may call it, it takes the price
//! directly as an argument instead of reading an oracle account, and it may only run
//! once `config.effective_override_delay()` seconds have elapsed past `close_ts` (never
//! less than `MIN_OVERRIDE_DELAY_SECS`, regardless of what `config.override_delay_secs`
//! is configured to -- see `state/config.rs`). See
//! `specs/001-binary-outcome-markets/data-model.md` "Validation rules carried into
//! instructions" (`admin_settle_override(price)`) and `contracts/program-instructions.md`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::Settled;
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

pub fn handle_admin_settle_override(ctx: Context<AdminSettleOverride>, price: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(ctx.accounts.market.is_open(), MeridianError::AlreadySettled);

    let delay = ctx.accounts.config.effective_override_delay() as i64;
    let earliest = ctx
        .accounts
        .market
        .close_ts
        .checked_add(delay)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    require!(now >= earliest, MeridianError::OverrideTooEarly);

    require!(price > 0, MeridianError::OracleBadPrice);

    let outcome = ctx.accounts.market.resolve(price);

    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.state = crate::state::market::MarketState::Settled;
    market.outcome = outcome;
    market.settlement_price = price;
    market.settled_at = now;
    market.settled_by_override = true;

    emit!(Settled {
        market: market_key,
        price,
        outcome: outcome as u8,
        by_override: true,
        ts: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AdminSettleOverride<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            MARKET_SEED,
            market.ticker.as_ref(),
            &market.trading_day.to_le_bytes(),
            &market.strike.to_le_bytes(),
        ],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
}
