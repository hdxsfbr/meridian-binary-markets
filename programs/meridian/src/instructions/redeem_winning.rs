//! `redeem_winning` (Wave 4, T028).
//!
//! Winning Yes-or-No token in, USDC out, only after settlement (FR scenario from
//! `specs/001-binary-outcome-markets/data-model.md` "Validation rules carried into
//! instructions" (`redeem_winning(side, qty)`) and `contracts/program-instructions.md`
//! ("Redeem Winning" row, "Invariant checks executed in code")).
//!
//! Unlike `redeem_pair`, this instruction has no `Config` account at all: redemption of
//! the winning side must never be blocked by `config.paused` (FR-006, FR-034), and there
//! is no other guard that needs `Config`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Token, TokenAccount, Transfer};

use crate::errors::MeridianError;
use crate::events::WinningRedeemed;
use crate::math::pairs_to_usdc;
use crate::state::market::{Market, Outcome, SEED as MARKET_SEED};

pub fn handle_redeem_winning(ctx: Context<RedeemWinning>, side: u8, qty: u64) -> Result<()> {
    require!(ctx.accounts.market.is_settled(), MeridianError::MarketNotSettled);
    require!(qty > 0, MeridianError::ZeroQuantity);

    let outcome_side = ctx.accounts.market.outcome as u8;
    require!(
        (side == 1 || side == 2) && side == outcome_side,
        MeridianError::WrongSide
    );

    // `user_winning` is the single token account this instruction touches (Wave 4
    // review fix: previously both `user_yes`/`user_no` were listed and only one was
    // ever used). Its mint must be the mint that actually won -- checked here in code,
    // not as an Anchor account constraint, so a pre-settlement call still fails with
    // `MarketNotSettled` above rather than `WrongSide`.
    let winning_mint_key = match ctx.accounts.market.outcome {
        Outcome::Yes => ctx.accounts.yes_mint.key(),
        Outcome::No => ctx.accounts.no_mint.key(),
        Outcome::Unset => {
            msg!("redeem_winning: settled market has Unset outcome");
            return Err(error!(MeridianError::InvariantViolated));
        }
    };
    require!(ctx.accounts.user_winning.mint == winning_mint_key, MeridianError::WrongSide);

    let payout = pairs_to_usdc(qty)?;

    // Burn `qty` base units of whichever mint won, from `user_winning`, with the user
    // as burn authority.
    let (winning_mint_info, winning_user_ata_info) = match ctx.accounts.market.outcome {
        Outcome::Yes => (
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.user_winning.to_account_info(),
        ),
        Outcome::No => (
            ctx.accounts.no_mint.to_account_info(),
            ctx.accounts.user_winning.to_account_info(),
        ),
        Outcome::Unset => unreachable!("Unset already handled above"),
    };

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: winning_mint_info,
                from: winning_user_ata_info,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        payout,
    )?;

    // Market PDA signer seeds, in the documented order (data-model.md "Market"):
    // `["market", ticker, trading_day_le, strike_le, bump]`.
    let ticker = ctx.accounts.market.ticker;
    let trading_day_bytes = ctx.accounts.market.trading_day.to_le_bytes();
    let strike_bytes = ctx.accounts.market.strike.to_le_bytes();
    let bump = [ctx.accounts.market.bump];
    let market_key = ctx.accounts.market.key();
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
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
    )?;

    // Post-settlement invariant (data-model.md "Market", program-instructions.md
    // "Invariant checks executed in code"): vault.amount >= winning_mint.supply, both
    // already in base units (6 decimals), no scaling needed. Reload both: the burn/
    // transfer CPIs above mutated their underlying account data without updating these
    // in-memory `Account<...>` wrappers.
    ctx.accounts.vault.reload()?;
    let winning_supply = match ctx.accounts.market.outcome {
        Outcome::Yes => {
            ctx.accounts.yes_mint.reload()?;
            ctx.accounts.yes_mint.supply
        }
        Outcome::No => {
            ctx.accounts.no_mint.reload()?;
            ctx.accounts.no_mint.supply
        }
        Outcome::Unset => unreachable!("Unset already handled above"),
    };
    require!(
        ctx.accounts.vault.amount >= winning_supply,
        MeridianError::InvariantViolated
    );

    emit!(WinningRedeemed {
        market: market_key,
        user: ctx.accounts.user.key(),
        side,
        qty,
        payout,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RedeemWinning<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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

    // Both mints stay in the account list (needed to look up whichever one actually
    // won -- see `handle_redeem_winning`), even though only the winning one is ever
    // burned from per call; which one that is varies by market, not statically, so
    // both still need to arrive writable.
    #[account(mut, address = market.yes_mint @ MeridianError::InvariantViolated)]
    pub yes_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut, address = market.no_mint @ MeridianError::InvariantViolated)]
    pub no_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(mut, address = market.vault @ MeridianError::InvariantViolated)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = vault.mint,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    /// The user's token account for whichever side actually won -- replaces the old
    /// `user_yes`/`user_no` pair (Wave 4 review fix: the losing side's user token
    /// account was never touched and is dropped here). Mint is validated in the
    /// handler (`WrongSide` on mismatch, after the `MarketNotSettled` guard); owner is
    /// validated here via `token::authority`.
    #[account(mut, token::authority = user)]
    pub user_winning: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
