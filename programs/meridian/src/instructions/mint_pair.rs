//! `mint_pair` (Wave 3, T026).
//!
//! USDC in, Yes+No out. See `specs/001-binary-outcome-markets/data-model.md`
//! "Validation rules carried into instructions" (`mint_pair(qty)`) and
//! `contracts/program-instructions.md` ("Mint Pair", "Invariant checks executed in
//! code").
//!
//! Token-2022 migration: the USDC leg always uses the classic SPL Token program
//! (`usdc_token_program`); the Yes/No mint_to CPIs use whichever program actually owns
//! `yes_mint`/`no_mint` (`yesno_token_program`, checked against each mint's own `owner`
//! via `require_matching_token_program` -- Token-2022 for markets created after this
//! migration, classic Token for legacy markets; see `state/market.rs`).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{self, TokenInterface};

use crate::errors::MeridianError;
use crate::events::Minted;
use crate::math::pairs_to_usdc;
use crate::state::config::Config;
use crate::state::market::{require_matching_token_program, Market, SEED as MARKET_SEED};

pub fn handle_mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
    let accounts = ctx.accounts;
    mint_pair_core(
        &accounts.config,
        &mut accounts.market,
        &accounts.yes_mint,
        &accounts.no_mint,
        &mut accounts.vault,
        &accounts.user,
        &accounts.user_usdc,
        &accounts.user_yes,
        &accounts.user_no,
        &accounts.usdc_token_program,
        &accounts.yesno_token_program,
        qty,
    )
}

/// Core of `mint_pair`: not-paused/open/qty guards, USDC user -> vault, two `mint_to`s
/// (Yes and No) to the user with the market PDA as signer, `pairs_outstanding += qty`,
/// the vault-equation invariant check, and the `Minted` event.
///
/// Factored out of `handle_mint_pair` (Wave 5, T056-058 refactor: takes explicit
/// account references rather than a typed `Context<MintPair>`) so `buy_no_market` /
/// `buy_no_limit` (`contracts/program-instructions.md`: both mint a pair as their first
/// step before trading the Yes side away) can reuse this logic in-process instead of
/// issuing a self-CPI back into this program's own `mint_pair` instruction. Any caller
/// whose accounts fill the same roles can reuse this directly.
///
/// Guard order: `!config.paused` (`Paused`), `market.is_open()` (`MarketSettled`), `now < close_ts` (`MarketClosed`),
/// `qty > 0` (`ZeroQuantity`).
#[allow(clippy::too_many_arguments)]
pub(crate) fn mint_pair_core<'info>(
    config: &Account<'info, Config>,
    market: &mut Account<'info, Market>,
    yes_mint: &InterfaceAccount<'info, token_interface::Mint>,
    no_mint: &InterfaceAccount<'info, token_interface::Mint>,
    vault: &mut Account<'info, TokenAccount>,
    user: &Signer<'info>,
    user_usdc: &Account<'info, TokenAccount>,
    user_yes: &InterfaceAccount<'info, token_interface::TokenAccount>,
    user_no: &InterfaceAccount<'info, token_interface::TokenAccount>,
    usdc_token_program: &Program<'info, Token>,
    yesno_token_program: &Interface<'info, TokenInterface>,
    qty: u64,
) -> Result<()> {
    require!(!config.paused, MeridianError::Paused);
    require!(market.is_open(), MeridianError::MarketSettled);
    require!(
        Clock::get()?.unix_timestamp < market.close_ts,
        MeridianError::MarketClosed
    );
    require!(qty > 0, MeridianError::ZeroQuantity);

    require_matching_token_program(yes_mint.to_account_info().owner, &yesno_token_program.key())?;
    require_matching_token_program(no_mint.to_account_info().owner, &yesno_token_program.key())?;

    // Yes/No mints and the USDC vault all use the same 6-decimal scale (data-model.md
    // "All money is `u64` in USDC micro-units (6 decimals)"), so `qty` pairs is
    // `qty * ONE_USDC` base units on every one of the three legs below.
    let usdc_amount = pairs_to_usdc(qty)?;

    token::transfer(
        CpiContext::new(
            usdc_token_program.key(),
            Transfer {
                from: user_usdc.to_account_info(),
                to: vault.to_account_info(),
                authority: user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Market PDA signer seeds, in the documented order (data-model.md "Market"):
    // `["market", ticker, trading_day_le, strike_le, bump]`.
    let ticker = market.ticker;
    let trading_day_bytes = market.trading_day.to_le_bytes();
    let strike_bytes = market.strike.to_le_bytes();
    let bump = [market.bump];
    let market_key = market.key();
    let seeds: [&[u8]; 5] = [
        MARKET_SEED,
        ticker.as_ref(),
        trading_day_bytes.as_ref(),
        strike_bytes.as_ref(),
        &bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[&seeds];

    token_interface::mint_to(
        CpiContext::new_with_signer(
            yesno_token_program.key(),
            token_interface::MintTo {
                mint: yes_mint.to_account_info(),
                to: user_yes.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_amount,
    )?;

    token_interface::mint_to(
        CpiContext::new_with_signer(
            yesno_token_program.key(),
            token_interface::MintTo {
                mint: no_mint.to_account_info(),
                to: user_no.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_amount,
    )?;

    market.pairs_outstanding = market
        .pairs_outstanding
        .checked_add(qty)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    let pairs_outstanding = market.pairs_outstanding;

    // Invariant (data-model.md "Market", program-instructions.md "Invariant checks
    // executed in code"): reload the vault, since the `transfer` CPI above mutated its
    // underlying account data without updating this in-memory `Account<TokenAccount>`.
    // The check tolerates unsolicited direct transfers into the vault: it must hold *at
    // least* the backing for `pairs_outstanding`, not exactly that amount. Surplus from
    // such transfers is never paid out -- redemptions always pay exactly `qty *
    // 1_000_000` (see `redeem_pair.rs`).
    vault.reload()?;
    let expected_vault_amount = pairs_to_usdc(pairs_outstanding)?;
    require!(
        vault.amount >= expected_vault_amount,
        MeridianError::InvariantViolated
    );

    emit!(Minted {
        market: market_key,
        user: user.key(),
        qty,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct MintPair<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
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

    #[account(mut, address = market.yes_mint @ MeridianError::InvariantViolated)]
    pub yes_mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(mut, address = market.no_mint @ MeridianError::InvariantViolated)]
    pub no_mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(mut, address = market.vault @ MeridianError::InvariantViolated)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
        associated_token::token_program = yesno_token_program,
    )]
    pub user_yes: InterfaceAccount<'info, token_interface::TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
        associated_token::token_program = yesno_token_program,
    )]
    pub user_no: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub usdc_token_program: Program<'info, Token>,
    pub yesno_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
