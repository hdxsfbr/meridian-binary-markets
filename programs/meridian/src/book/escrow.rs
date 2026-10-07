//! CPI helpers for the order book's escrow token accounts (Wave 4B, T053).
//!
//! `place_order`/`cancel_order` move funds in and out of `usdc_escrow` (bids' USDC) and
//! `yes_escrow` (asks' Yes tokens), both owned by the market PDA. These wrappers centralize
//! the two transfer shapes (user-signed in, PDA-signed out) and the maker-account
//! validation `place_order` needs for its `remaining_accounts`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer, TokenAccount};

use crate::errors::MeridianError;

/// Transfers `amount` from a user-owned token account into an escrow, signed by the
/// user. A no-op for `amount == 0` (callers pass computed deltas that are sometimes
/// zero, e.g. no refund due).
pub fn transfer_user_to_escrow<'info>(
    token_program_key: Pubkey,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    user: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            token_program_key,
            Transfer {
                from: from.clone(),
                to: to.clone(),
                authority: user.clone(),
            },
        ),
        amount,
    )
}

/// Transfers `amount` out of an escrow token account to `to`, signed by the market PDA
/// via `signer_seeds`. A no-op for `amount == 0`.
pub fn transfer_escrow_out<'info>(
    token_program_key: Pubkey,
    escrow: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    market_authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            token_program_key,
            Transfer {
                from: escrow.clone(),
                to: to.clone(),
                authority: market_authority.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Validates a maker's receiving token account arriving as an untyped
/// `remaining_accounts` entry: deserializes it as an SPL `TokenAccount` and checks that
/// its owner is the maker and its mint is the expected one (USDC for a bid-taker fill,
/// Yes for an ask-taker fill). `InvariantViolated` (with a `msg!`) on any mismatch,
/// including "not a token account at all".
pub fn validate_maker_account(
    account_info: &AccountInfo,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    let data = account_info.try_borrow_data().map_err(|_| {
        msg!("book::escrow: could not borrow maker account data");
        error!(MeridianError::InvariantViolated)
    })?;
    let token_account = TokenAccount::try_deserialize(&mut data.as_ref()).map_err(|_| {
        msg!("book::escrow: maker account is not a valid SPL token account");
        error!(MeridianError::InvariantViolated)
    })?;
    if token_account.owner != *expected_owner {
        msg!("book::escrow: maker account owner does not match the maker");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if token_account.mint != *expected_mint {
        msg!("book::escrow: maker account mint does not match the expected mint");
        return Err(error!(MeridianError::InvariantViolated));
    }
    Ok(())
}
