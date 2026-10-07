//! `create_book()` (Wave 2, T020 split -- see create_market.rs's module doc
//! comment and contracts/program-instructions.md's "Split note").
//!
//! Solana caps how much any one account's data length may grow *within a single
//! transaction* at `MAX_PERMITTED_DATA_INCREASE` (10,240 bytes), enforced identically
//! whether the growth happens via a CPI `system_program::create_account` or a direct
//! `AccountInfo::resize`. `book_space(capacity)` exceeds that for capacity above ~79
//! (`128 + 128 * capacity`; capacity 128, the non-demo default, needs 16,512 bytes). So
//! this instruction is idempotent and incremental: call it repeatedly (each call is a
//! separate transaction, so each gets its own fresh 10,240-byte budget) until
//! `market.book` is no longer `Pubkey::default()`. The first call creates the Book
//! account (owned by this program) at `min(book_space(capacity), MAX_PERMITTED_DATA_INCREASE)`
//! bytes; each subsequent call grows it by up to `MAX_PERMITTED_DATA_INCREASE` more
//! bytes via `resize` (which zero-extends); the call that reaches the final size writes
//! the header and sets `market.book`. Rent for the *final* size is funded up front on
//! the first call, so no call after the first needs to transfer more lamports.
//!
//! Takes **no `capacity` argument**: it reads `market.book_capacity`, set by
//! `create_market`/`add_strike` from their own `capacity` arg, so a call with a
//! mismatched capacity can never start a second, differently sized book for the same
//! market (Wave 2 review fix, 2026-10-06). Calling this again once `market.book` is
//! already set re-validates the existing account (address, owner, data length, header)
//! and returns `Ok(())` as a no-op instead of erroring, so a client retrying a call
//! whose confirmation it missed doesn't need to special-case "already done."
//!
//! The first call must also tolerate the Book PDA already holding lamports with no data
//! (e.g. someone sent it SOL before `create_book` ever ran): `system_program::create_account`
//! fails outright against a non-zero-lamport account, so that path transfers only the
//! rent *shortfall* and then `allocate`s/`assign`s the account (both signed with the PDA's
//! seeds) instead of using `create_account` at all.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE;
use anchor_lang::system_program::{self, Allocate, Assign, Transfer};

use crate::errors::MeridianError;
use crate::state::book::{book_space, read_header, write_header, BookHeader, BOOK_SEED};
use crate::state::config::Config;
use crate::state::market::Market;

/// Validates an already-complete Book account against `market`/`capacity` without
/// touching its contents. Used both by the no-op re-validation path below and could be
/// reused by future instructions that read the Book.
fn validate_existing_book(
    book_ai: &AccountInfo,
    expected_key: &Pubkey,
    market_key: &Pubkey,
    capacity: u16,
) -> Result<()> {
    if book_ai.key() != *expected_key {
        msg!("create_book: book account address does not match the expected PDA");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if book_ai.owner != &crate::ID {
        msg!("create_book: book account is not owned by this program");
        return Err(error!(MeridianError::InvariantViolated));
    }
    let data = book_ai.try_borrow_data()?;
    if data.len() != book_space(capacity) {
        msg!("create_book: existing book account length does not match book_space(capacity)");
        return Err(error!(MeridianError::InvariantViolated));
    }
    let header = read_header(&data)?;
    if header.market != market_key.to_bytes() {
        msg!("create_book: existing book header market does not match");
        return Err(error!(MeridianError::InvariantViolated));
    }
    if header.capacity != capacity {
        msg!("create_book: existing book header capacity does not match");
        return Err(error!(MeridianError::InvariantViolated));
    }
    Ok(())
}

pub fn handle_create_book(ctx: Context<CreateBook>) -> Result<()> {
    let capacity = ctx.accounts.market.book_capacity;
    if capacity == 0 {
        msg!("create_book: market.book_capacity must be greater than zero");
        return Err(error!(MeridianError::InvariantViolated));
    }

    let market_key = ctx.accounts.market.key();
    let book_ai = ctx.accounts.book.to_account_info();
    let expected_book_key = Pubkey::find_program_address(&[BOOK_SEED, market_key.as_ref()], &crate::ID).0;

    if ctx.accounts.market.book != Pubkey::default() {
        // Idempotent no-op: re-validate the existing account instead of erroring, so a
        // client retrying a call whose confirmation it missed doesn't need to
        // special-case "already done."
        validate_existing_book(&book_ai, &ctx.accounts.market.book, &market_key, capacity)?;
        return Ok(());
    }

    let target_space = book_space(capacity);
    let current_len = book_ai.data_len();

    if current_len == 0 {
        let initial_space = target_space.min(MAX_PERMITTED_DATA_INCREASE);
        let rent_lamports = Rent::get()?.minimum_balance(target_space);
        let existing_lamports = book_ai.lamports();
        let bump = ctx.bumps.book;
        let seeds: &[&[u8]] = &[BOOK_SEED, market_key.as_ref(), &[bump]];

        if existing_lamports == 0 {
            system_program::create_account(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::CreateAccount {
                        from: ctx.accounts.payer.to_account_info(),
                        to: book_ai.clone(),
                    },
                    &[seeds],
                ),
                rent_lamports,
                initial_space as u64,
                &crate::ID,
            )?;
        } else {
            // The PDA already holds lamports (system-owned, zero data): `create_account`
            // refuses a non-zero-lamport destination outright, so top up only the rent
            // shortfall (if any -- a PDA prefunded past the rent-exempt minimum needs no
            // further transfer) and then `allocate`/`assign` instead.
            let shortfall = rent_lamports.saturating_sub(existing_lamports);
            if shortfall > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: book_ai.clone(),
                        },
                    ),
                    shortfall,
                )?;
            }
            system_program::allocate(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Allocate {
                        account_to_allocate: book_ai.clone(),
                    },
                    &[seeds],
                ),
                initial_space as u64,
            )?;
            system_program::assign(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Assign {
                        account_to_assign: book_ai.clone(),
                    },
                    &[seeds],
                ),
                &crate::ID,
            )?;
        }
    } else if current_len < target_space {
        let grow_by = (target_space - current_len).min(MAX_PERMITTED_DATA_INCREASE);
        book_ai.resize(current_len + grow_by)?;
    } else if current_len > target_space {
        // Only possible if `market.book_capacity` changed after this market's book was
        // already started, which nothing in this program does; defensive only.
        msg!("create_book: in-progress book size exceeds book_space(market.book_capacity)");
        return Err(error!(MeridianError::InvariantViolated));
    }

    if book_ai.data_len() == target_space {
        let usdc_escrow =
            Pubkey::find_program_address(&[b"escrow_usdc", market_key.as_ref()], &crate::ID).0;
        let yes_escrow =
            Pubkey::find_program_address(&[b"escrow_yes", market_key.as_ref()], &crate::ID).0;

        {
            let mut data = book_ai.try_borrow_mut_data()?;
            let header = BookHeader::init(&market_key, &usdc_escrow, &yes_escrow, capacity);
            write_header(&mut data, &header);
        }

        require_keys_eq!(book_ai.key(), expected_book_key, MeridianError::InvariantViolated);
        ctx.accounts.market.book = book_ai.key();
    }

    Ok(())
}

#[derive(Accounts)]
pub struct CreateBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub admin: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
        has_one = admin @ MeridianError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub market: Account<'info, Market>,

    /// CHECK: raw program-owned Book account for `market`. Starts out owned by the
    /// system program with zero lamports/data (or, if prefunded, zero data but nonzero
    /// lamports); `handle_create_book` creates and grows it via manual CPI/`resize`
    /// across one or more calls (see this file's module doc comment), so it cannot be
    /// declared `init` the normal Anchor way. The `seeds`/`bump` constraint below
    /// verifies the address regardless.
    #[account(mut, seeds = [BOOK_SEED, market.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
