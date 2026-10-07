//! `redeem_pair` (Wave 3, T027).
//!
//! Yes+No in, USDC out, allowed in any state and while paused (FR-006, FR-034). See
//! `specs/001-binary-outcome-markets/data-model.md` "Validation rules carried into
//! instructions" (`redeem_pair(qty)`) and `contracts/program-instructions.md`
//! ("Redeem Pair" row, "Invariant checks executed in code").

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::PairRedeemed;
use crate::math::pairs_to_usdc;
use crate::state::config::Config;
use crate::state::market::{Market, MarketState, Outcome, SEED as MARKET_SEED};

pub fn handle_redeem_pair(ctx: Context<RedeemPair>, qty: u64) -> Result<()> {
    let accounts = ctx.accounts;
    redeem_pair_core(
        &mut accounts.market,
        &mut accounts.yes_mint,
        &mut accounts.no_mint,
        &mut accounts.vault,
        &accounts.user,
        &accounts.user_usdc,
        &accounts.user_yes,
        &accounts.user_no,
        &accounts.token_program,
        qty,
    )
}

/// Core of `redeem_pair`: qty guard, burn `qty` of each of the user's Yes/No, USDC
/// vault -> user with the market PDA as signer, `pairs_outstanding -= qty` (skipped once
/// the market is `Settled`, per data-model.md: the field is frozen post-settlement), the
/// vault-equation invariant check, and the `PairRedeemed` event.
///
/// Factored out of `handle_redeem_pair` (Wave 5, T056-058 refactor: takes explicit
/// account references rather than a typed `Context<RedeemPair>`) for the same reason as
/// `mint_pair_core` in `mint_pair.rs` -- see that function's doc comment for the reuse
/// contract a caller needs to match (account roles/types, not necessarily names).
///
/// Unlike `mint_pair`, `redeem_pair` has no paused/open guard: it is allowed in any
/// market state and while `config.paused` (FR-006, FR-034), so this function takes no
/// `Config` account at all.
#[allow(clippy::too_many_arguments)]
pub(crate) fn redeem_pair_core<'info>(
    market: &mut Account<'info, Market>,
    yes_mint: &mut Account<'info, Mint>,
    no_mint: &mut Account<'info, Mint>,
    vault: &mut Account<'info, TokenAccount>,
    user: &Signer<'info>,
    user_usdc: &Account<'info, TokenAccount>,
    user_yes: &Account<'info, TokenAccount>,
    user_no: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    qty: u64,
) -> Result<()> {
    require!(qty > 0, MeridianError::ZeroQuantity);

    // Yes/No mints and the USDC vault all use the same 6-decimal scale (data-model.md
    // "All money is `u64` in USDC micro-units (6 decimals)"), so `qty` pairs is
    // `qty * ONE_USDC` base units on every one of the three legs below.
    let usdc_amount = pairs_to_usdc(qty)?;

    token::burn(
        CpiContext::new(
            token_program.key(),
            Burn {
                mint: yes_mint.to_account_info(),
                from: user_yes.to_account_info(),
                authority: user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    token::burn(
        CpiContext::new(
            token_program.key(),
            Burn {
                mint: no_mint.to_account_info(),
                from: user_no.to_account_info(),
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

    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: user_usdc.to_account_info(),
                authority: market.to_account_info(),
            },
            signer_seeds,
        ),
        usdc_amount,
    )?;

    // `pairs_outstanding` is frozen once the market is `Settled` (data-model.md
    // "Market"); the live invariant then becomes `vault.amount == winning_supply *
    // 1_000_000`, which `redeem_winning` (not this instruction) is responsible for. A
    // still-`Open` market keeps the ordinary `vault.amount == pairs_outstanding *
    // 1_000_000` form, which this decrement maintains.
    let is_open = market.state == MarketState::Open;
    let pairs_outstanding = if is_open {
        market.pairs_outstanding = market
            .pairs_outstanding
            .checked_sub(qty)
            .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
        Some(market.pairs_outstanding)
    } else {
        None
    };

    // Invariant (data-model.md "Market", program-instructions.md "Invariant checks
    // executed in code"): reload the vault, since the `burn`/`transfer` CPIs above
    // mutated the underlying account data without updating this in-memory
    // `Account<TokenAccount>`.
    //
    // `Open` form: the vault must hold *at least* the backing for `pairs_outstanding`,
    // tolerating unsolicited direct transfers into the vault (surplus is never paid
    // out -- redemptions always pay exactly `qty * 1_000_000`, as above).
    //
    // `Settled` form: `pairs_outstanding` is frozen, so the live invariant becomes
    // `vault.amount >= winning_mint.supply` -- both already in base units (6 decimals),
    // so no scaling is needed. The winning mint is whichever of Yes/No matches
    // `market.outcome`; reload it too, since the `burn` CPIs above mutated its supply
    // without updating this in-memory `Account<Mint>`.
    vault.reload()?;
    match pairs_outstanding {
        Some(pairs_outstanding) => {
            let expected_vault_amount = pairs_to_usdc(pairs_outstanding)?;
            require!(
                vault.amount >= expected_vault_amount,
                MeridianError::InvariantViolated
            );
        }
        None => {
            let winning_supply = match market.outcome {
                Outcome::Yes => {
                    yes_mint.reload()?;
                    yes_mint.supply
                }
                Outcome::No => {
                    no_mint.reload()?;
                    no_mint.supply
                }
                Outcome::Unset => {
                    msg!("redeem_pair: settled market has Unset outcome");
                    return Err(error!(MeridianError::InvariantViolated));
                }
            };
            require!(
                vault.amount >= winning_supply,
                MeridianError::InvariantViolated
            );
        }
    }

    emit!(PairRedeemed {
        market: market_key,
        user: user.key(),
        qty,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RedeemPair<'info> {
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
    pub yes_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut, address = market.no_mint @ MeridianError::InvariantViolated)]
    pub no_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut, address = market.vault @ MeridianError::InvariantViolated)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.usdc_mint,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}
