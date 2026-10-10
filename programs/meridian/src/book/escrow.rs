//! CPI helpers for the order book's escrow token accounts (Wave 4B, T053).
//!
//! `place_order`/`cancel_order` move funds in and out of `usdc_escrow` (bids' USDC) and
//! `yes_escrow` (asks' Yes tokens), both owned by the market PDA. These wrappers centralize
//! the two transfer shapes (user-signed in, PDA-signed out) and the maker-account
//! validation `place_order` needs for its `remaining_accounts`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use anchor_spl::token_interface;

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

/// Yes-leg counterpart of `transfer_user_to_escrow`: CPIs via
/// `token_interface::transfer_checked` instead of the classic `token::transfer`, since
/// `yes_escrow`/the user's Yes ATA may be owned by Token-2022 (new markets) or classic
/// Token (legacy markets) -- `transfer_checked` works against either program through the
/// `TokenInterface` CPI program id the caller passes in. A no-op for `amount == 0`.
pub fn transfer_user_to_escrow_checked<'info>(
    token_program_key: Pubkey,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    user: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program_key,
            token_interface::TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: user.clone(),
            },
        ),
        amount,
        decimals,
    )
}

/// Yes-leg counterpart of `transfer_escrow_out`: see
/// `transfer_user_to_escrow_checked`'s doc comment for why this uses
/// `token_interface::transfer_checked`. A no-op for `amount == 0`.
#[allow(clippy::too_many_arguments)]
pub fn transfer_escrow_out_checked<'info>(
    token_program_key: Pubkey,
    escrow: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    market_authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program_key,
            token_interface::TransferChecked {
                from: escrow.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: market_authority.clone(),
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )
}

/// Validates a maker's receiving token account arriving as an untyped
/// `remaining_accounts` entry: deserializes it as an SPL `TokenAccount` and checks that
/// its owner is the maker and its mint is the expected one (USDC for a bid-taker fill,
/// Yes for an ask-taker fill). `InvariantViolated` (with a `msg!`) on any mismatch,
/// including "not a token account at all".
///
/// Deserializes via `token_interface::TokenAccount` (`StateWithExtensions`-aware), not
/// the classic `anchor_spl::token::TokenAccount` -- the classic type's `Pack::unpack`
/// requires the account data to be *exactly* 165 bytes, which a Token-2022 Yes/No
/// account carrying extension TLV data never is, so a Yes-side maker account on a
/// Token-2022 market would otherwise always fail this check. `token_interface`'s version
/// parses either shape correctly.
pub fn validate_maker_account(
    account_info: &AccountInfo,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    let data = account_info.try_borrow_data().map_err(|_| {
        msg!("book::escrow: could not borrow maker account data");
        error!(MeridianError::InvariantViolated)
    })?;
    let token_account =
        token_interface::TokenAccount::try_deserialize(&mut data.as_ref()).map_err(|_| {
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
