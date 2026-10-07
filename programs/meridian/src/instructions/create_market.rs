//! `create_market` / `add_strike` (Wave 2, T020).
//!
//! Both instructions share one handler and one `Accounts` struct: a strike market is the
//! same kind of object whether it is the first for a trading day or added mid-session;
//! only the entry point name differs (contracts/program-instructions.md "Add Strike").
//!
//! Creates: the `Market` PDA, Yes/No SPL mints (6 decimals, mint authority = market PDA),
//! a USDC vault token account, a USDC escrow token account, and a Yes escrow token
//! account. The Book is created by a *separate* instruction, `create_book` (see
//! `create_book.rs`) -- see that file's doc comment and
//! `specs/001-binary-outcome-markets/contracts/program-instructions.md`'s "Split note"
//! for why. `market.book` is `Pubkey::default()` until `create_book` finishes sizing and
//! initializing it.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::MeridianError;
use crate::events::MarketCreated;
use crate::state::config::Config;
use crate::state::market::{Market, MarketState, Outcome, SEED as MARKET_SEED};

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    ticker: [u8; 8],
    strike: u64,
    trading_day: u32,
    close_ts: i64,
    capacity: u16,
) -> Result<()> {
    create_or_add_strike(ctx, ticker, strike, trading_day, close_ts, capacity)
}

pub fn handle_add_strike(
    ctx: Context<CreateMarket>,
    ticker: [u8; 8],
    strike: u64,
    trading_day: u32,
    close_ts: i64,
    capacity: u16,
) -> Result<()> {
    create_or_add_strike(ctx, ticker, strike, trading_day, close_ts, capacity)
}

fn create_or_add_strike(
    ctx: Context<CreateMarket>,
    ticker: [u8; 8],
    strike: u64,
    trading_day: u32,
    close_ts: i64,
    capacity: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    if ctx.accounts.config.ticker(&ticker).is_none() {
        msg!("create_market: ticker not enabled");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if close_ts <= now {
        msg!("create_market: close_ts must be in the future");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if strike == 0 {
        msg!("create_market: strike must be greater than zero");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if capacity == 0 {
        msg!("create_market: capacity must be greater than zero");
        return Err(error!(MeridianError::InvariantViolated));
    }

    let market_key = ctx.accounts.market.key();
    let yes_mint_key = ctx.accounts.yes_mint.key();
    let no_mint_key = ctx.accounts.no_mint.key();
    let vault_key = ctx.accounts.vault.key();
    let market_bump = ctx.bumps.market;
    let vault_bump = ctx.bumps.vault;

    let market = &mut ctx.accounts.market;
    market.ticker = ticker;
    market.strike = strike;
    market.trading_day = trading_day;
    market.close_ts = close_ts;
    market.state = MarketState::Open;
    market.outcome = Outcome::Unset;
    market.settlement_price = 0;
    market.settled_at = 0;
    market.settled_by_override = false;
    market.yes_mint = yes_mint_key;
    market.no_mint = no_mint_key;
    market.vault = vault_key;
    // Set for real by `create_book` once the Book account reaches its final size;
    // `Pubkey::default()` until then (see this file's module doc comment).
    market.book = Pubkey::default();
    market.book_closed = false;
    market.book_capacity = capacity;
    market.pairs_outstanding = 0;
    market.bump = market_bump;
    market.vault_bump = vault_bump;

    emit!(MarketCreated {
        market: market_key,
        ticker,
        strike,
        trading_day,
        close_ts,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticker: [u8; 8], strike: u64, trading_day: u32, close_ts: i64, capacity: u16)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, ticker.as_ref(), &trading_day.to_le_bytes(), &strike.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"escrow_usdc", market.key().as_ref()],
        bump,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [b"escrow_yes", market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    // `mint::decimals = 6` is defense in depth: `initialize_config` already rejects a
    // non-6-decimal mint (`InvariantViolated`), and `config.usdc_mint` cannot change
    // after that without going through `update_config`, which does not touch the mint.
    #[account(address = config.usdc_mint, mint::decimals = 6)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
