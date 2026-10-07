//! `initialize_config` / `update_config` (Wave 2, T018).
//!
//! Creates and updates the singleton `Config` PDA (`["config"]`). Every rule lives in
//! `Config::validate` (state/config.rs, Wave 1B); this file only assembles the struct from
//! instruction args and calls it.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::MeridianError;
use crate::state::config::{Config, OracleProvider, TickerInfo, MAX_PUBLISHERS, SEED, TICKER_COUNT};

/// Collateral mints on this program are always 6-decimal USDC (data-model.md: "All money
/// is `u64` in USDC micro-units (6 decimals)"); accepting any other mint here would
/// silently break every downstream micro-USDC calculation.
const REQUIRED_USDC_DECIMALS: u8 = 6;

/// Args for `initialize_config`. `publishers`/`tickers` are `Vec` for a friendlier client
/// API; the handler pads them into the fixed-size arrays `Config` actually stores.
/// `tickers` must have exactly `TICKER_COUNT` (7) entries.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeConfigArgs {
    pub oracle_provider: OracleProvider,
    pub oracle_program: Pubkey,
    pub publishers: Vec<Pubkey>,
    pub max_staleness_secs: u32,
    pub max_conf_bps: u16,
    pub min_publish_offset_secs: u32,
    pub override_delay_secs: u32,
    pub tickers: Vec<TickerInfo>,
    pub default_book_capacity: u16,
}

/// Args for `update_config`. Every field is optional; only `Some(..)` fields are applied.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct UpdateConfigArgs {
    pub oracle_provider: Option<OracleProvider>,
    pub oracle_program: Option<Pubkey>,
    pub publishers: Option<Vec<Pubkey>>,
    pub max_staleness_secs: Option<u32>,
    pub max_conf_bps: Option<u16>,
    pub min_publish_offset_secs: Option<u32>,
    pub override_delay_secs: Option<u32>,
    pub tickers: Option<Vec<TickerInfo>>,
    pub default_book_capacity: Option<u16>,
}

fn empty_ticker() -> TickerInfo {
    TickerInfo {
        symbol: [0u8; 8],
        feed_id: [0u8; 32],
        enabled: false,
    }
}

fn pad_publishers(publishers: &[Pubkey]) -> Result<([Pubkey; MAX_PUBLISHERS], u8)> {
    require!(
        publishers.len() <= MAX_PUBLISHERS,
        MeridianError::InvariantViolated
    );
    let mut out = [Pubkey::default(); MAX_PUBLISHERS];
    for (slot, p) in out.iter_mut().zip(publishers.iter()) {
        *slot = *p;
    }
    Ok((out, publishers.len() as u8))
}

fn pad_tickers(tickers: &[TickerInfo]) -> Result<[TickerInfo; TICKER_COUNT]> {
    require!(
        tickers.len() == TICKER_COUNT,
        MeridianError::InvariantViolated
    );
    let mut out = [empty_ticker(); TICKER_COUNT];
    for (slot, t) in out.iter_mut().zip(tickers.iter()) {
        *slot = *t;
    }
    Ok(out)
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    args: InitializeConfigArgs,
) -> Result<()> {
    if ctx.accounts.usdc_mint.decimals != REQUIRED_USDC_DECIMALS {
        msg!("initialize_config: usdc_mint must have exactly 6 decimals");
        return Err(error!(MeridianError::InvariantViolated));
    }

    let (publishers, publishers_len) = pad_publishers(&args.publishers)?;
    let tickers = pad_tickers(&args.tickers)?;
    let bump = ctx.bumps.config;

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.paused = false;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.oracle_provider = args.oracle_provider;
    config.oracle_program = args.oracle_program;
    config.publishers = publishers;
    config.publishers_len = publishers_len;
    config.max_staleness_secs = args.max_staleness_secs;
    config.max_conf_bps = args.max_conf_bps;
    config.min_publish_offset_secs = args.min_publish_offset_secs;
    config.override_delay_secs = args.override_delay_secs;
    config.tickers = tickers;
    config.default_book_capacity = args.default_book_capacity;
    config.bump = bump;

    config.validate(&crate::ID)?;
    Ok(())
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(provider) = args.oracle_provider {
        config.oracle_provider = provider;
    }
    if let Some(oracle_program) = args.oracle_program {
        config.oracle_program = oracle_program;
    }
    if let Some(publishers) = args.publishers {
        let (publishers, publishers_len) = pad_publishers(&publishers)?;
        config.publishers = publishers;
        config.publishers_len = publishers_len;
    }
    if let Some(v) = args.max_staleness_secs {
        config.max_staleness_secs = v;
    }
    if let Some(v) = args.max_conf_bps {
        config.max_conf_bps = v;
    }
    if let Some(v) = args.min_publish_offset_secs {
        config.min_publish_offset_secs = v;
    }
    if let Some(v) = args.override_delay_secs {
        config.override_delay_secs = v;
    }
    if let Some(tickers) = args.tickers {
        config.tickers = pad_tickers(&tickers)?;
    }
    if let Some(v) = args.default_book_capacity {
        config.default_book_capacity = v;
    }

    config.validate(&crate::ID)?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The admin recorded on `Config.admin`. May be the same key as `payer`.
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// The collateral mint, checked for 6 decimals in the handler (`InvariantViolated`
    /// if not -- data-model.md requires every money amount be USDC micro-units).
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}
