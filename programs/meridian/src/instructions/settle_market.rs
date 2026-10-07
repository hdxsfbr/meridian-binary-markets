//! `settle_market` (Wave 3B, T039).
//!
//! Anyone may call `settle_market` (the automation service, in practice): `now >=
//! close_ts` (FR-031), the market must still be `Open` (a second call is `AlreadySettled`,
//! which the service treats as success per FR-021), and the price account must pass
//! every guard in `oracle::read_quote`. Resolution is at-or-above (FR-018, `Market::resolve`).

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::events::Settled;
use crate::oracle::read_quote;
use crate::state::config::Config;
use crate::state::market::{Market, MarketState};

pub fn handle_settle_market(ctx: Context<SettleMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    if now < ctx.accounts.market.close_ts {
        return Err(error!(MeridianError::BeforeClose));
    }
    if !ctx.accounts.market.is_open() {
        return Err(error!(MeridianError::AlreadySettled));
    }

    // `ticker_any`, not `ticker`: an existing, already-open market must still be
    // settleable even if its ticker has since been disabled (disabling only blocks
    // *new* markets via `create_market`/`add_strike`).
    let ticker = ctx
        .accounts
        .config
        .ticker_any(&ctx.accounts.market.ticker)
        .ok_or_else(|| {
            msg!("settle_market: market ticker is not a config ticker");
            error!(MeridianError::InvariantViolated)
        })?
        .clone();

    let clock = Clock::get()?;
    let quote = read_quote(
        &ctx.accounts.config,
        &ticker,
        &ctx.accounts.market,
        &ctx.accounts.price_account.to_account_info(),
        &clock,
    )?;

    let outcome = ctx.accounts.market.resolve(quote.price_micro);

    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.state = MarketState::Settled;
    market.outcome = outcome;
    market.settlement_price = quote.price_micro;
    market.settled_at = now;
    market.settled_by_override = false;

    emit!(Settled {
        market: market_key,
        price: quote.price_micro,
        outcome: outcome as u8,
        by_override: false,
        ts: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Anyone may call `settle_market` (the automation service, in practice).
    pub caller: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    /// CHECK: owner/parse/attestation checks happen inside `oracle::read_quote`, which
    /// dispatches on `config.oracle_provider` (mock PDA-and-owner check or Pyth
    /// owner-and-verification-level check) before any field is trusted.
    pub price_account: UncheckedAccount<'info>,
}
