//! `close_book` / `close_market` (Wave 5, T081).
//!
//! Admin-only rent reclamation for a `Settled` market whose book and escrows (and, for
//! `close_market`, vault) are empty -- see `specs/001-binary-outcome-markets/data-model.md`
//! "Validation rules carried into instructions" (`close_book`/`close_market`) and
//! DECISIONS.md §6 ("a compact books at settlement and reclaim the rent"). Both
//! instructions share one `Accounts` struct (`CloseAccounts`, wired into `lib.rs` as two
//! separate `#[program]` entry points) because they close the same market's accounts in
//! sequence and differ only in which accounts they actually touch.
//!
//! `close_book` must run first: if the Book finished sizing (`market.book !=
//! Pubkey::default()`), it requires the Book empty (`bid_count == ask_count == 0`);
//! either way it requires both escrow token accounts empty, then closes the two
//! escrows and whatever the Book PDA currently holds (a fully-sized Book, or a
//! partially-allocated one left behind by a `create_book` that never finished -- see
//! "Unfinished books" below), resets `market.book` to `Pubkey::default()`, and sets the
//! new `market.book_closed` flag. `close_market` then requires `market.book_closed`
//! (not `market.book == Pubkey::default()` -- see that field's doc comment in
//! `state/market.rs` for why that alone is ambiguous) plus, independently re-derived
//! on chain, that the Book PDA and both escrow PDAs no longer exist, and the vault
//! empty; it closes the vault and the `Market` account itself. Calling `close_market`
//! before `close_book` is rejected with `NotEmpty`, not a different error, since from
//! the caller's point of view the precondition is the same shape: "something that
//! still needs to be emptied/closed first exists."
//!
//! Unfinished books: `create_book` sizes a Book account incrementally (see its own
//! module doc comment) and only writes `market.book` once the final size is reached.
//! A market that called `create_market` but never (or never finished) calling
//! `create_book` has `market.book == Pubkey::default()` with the Book PDA either
//! nonexistent (owned by the system program, no data) or partially allocated (owned by
//! this program, sized below `book_space(capacity)`, header not yet written). Neither
//! shape can hold a live order -- the header, which is what `bid_count`/`ask_count`
//! live in, is only ever written by the call that reaches the final size -- so
//! `close_book` treats both as trivially empty and reclaims whatever is there (nothing,
//! or the partial allocation) instead of requiring a finished, validated header.
//!
//! All rent lamports recovered (escrows, Book, vault, Market) go to `admin`, per
//! data-model.md's "rent returned to the admin" and DECISIONS §6.
//!
//! The Yes/No SPL mints: a classic-Token mint can never be closed (there is no
//! `close_account`-style instruction for a classic mint, with or without outstanding
//! supply -- closing is a token-account-only operation there), so `handle_close_market`
//! leaves a legacy market's mints in place, inert, after its market closes, exactly as
//! before this file's Token-2022 migration. A Token-2022 mint created by `create_market`
//! (see that file's module doc comment) carries a `MintCloseAuthority` extension with
//! authority = market PDA specifically so this instruction *can* reclaim it once
//! `supply == 0` -- i.e. once every Yes/No token from this market has been burned via
//! `redeem_pair`/`redeem_winning`/the various trade paths. `handle_close_market` checks
//! each mint's owner at call time and closes it via `token_interface::close_account`
//! when it's Token-2022 and empty, or skips it with a `msg!` log otherwise (classic mint,
//! or Token-2022 mint that still has outstanding supply) -- it never errors either way,
//! since neither case is a precondition failure, just "nothing to reclaim here yet/ever."
//!
//! `remove_strike` (PRD FR-10 "adjust strikes"; see DECISIONS.md "Adjusting a strike
//! means replacing an unused one"): an admin-only instruction for an *Open* (not yet
//! settled) market whose strike turned out to be the wrong one -- unlike `close_book`/
//! `close_market`, which only ever run after settlement. It reuses `CloseAccounts`
//! unchanged (same accounts a `close_market` call would build) and the exact same
//! escrow/book/vault/mint closing sequence as `handle_close_book` followed by
//! `handle_close_market`, collapsed into one call since there is no settled book to
//! leave half-closed between two transactions here. Two guards neither close
//! instruction needs come first: the market must still be `Open` (`MarketSettled` --
//! a settled market's strike is retired through `close_book`/`close_market` instead,
//! not this instruction) and nothing has ever traded against this strike --
//! `pairs_outstanding == 0` and both Yes/No mint supplies `== 0` (`StrikeInUse`). Only
//! once every guard passes does it close escrows, book, vault, Token-2022 mints (when
//! closable, exactly as `close_mint_if_reclaimable` already decides), and the `Market`
//! account itself, rent to `admin` -- freeing the `(ticker, trading_day, strike)` PDA
//! seeds for a later `create_market`/`add_strike` call.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};
use anchor_spl::token_interface::{self, TokenInterface};

use crate::errors::MeridianError;
use crate::state::book::{read_header, BOOK_SEED};
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

/// Builds the Market PDA's signer seeds, in the documented order (data-model.md
/// "Market": `["market", ticker, trading_day_le, strike_le, bump]`). Shared by both
/// handlers below, each of which needs the market PDA to sign the escrow/vault
/// `close_account` CPIs.
fn market_signer_seeds(market: &Market) -> [Vec<u8>; 5] {
    [
        MARKET_SEED.to_vec(),
        market.ticker.to_vec(),
        market.trading_day.to_le_bytes().to_vec(),
        market.strike.to_le_bytes().to_vec(),
        vec![market.bump],
    ]
}

/// An SPL token account's `amount` field (bytes `[64, 72)`, little-endian -- the same
/// raw layout approach the Rust test harness uses for plain SPL accounts, which carry
/// no Anchor discriminator). Used instead of a typed `Account<'info, TokenAccount>`
/// because `usdc_escrow`/`yes_escrow` must still be *declarable* in `CloseAccounts` for
/// `close_market`'s call even after `close_book` has already closed them (see this
/// struct's doc comment on those two fields) -- a typed `Account<TokenAccount>` would
/// fail `AccountNotInitialized` at that point regardless of whether the handler ever
/// reads it. `InvariantViolated` if the account isn't owned by the SPL Token program or
/// is too short to hold an `amount` field.
fn token_account_amount(account_info: &AccountInfo, token_program_id: &Pubkey) -> Result<u64> {
    require!(account_info.owner == token_program_id, MeridianError::InvariantViolated);
    let data = account_info.try_borrow_data()?;
    require!(data.len() >= 72, MeridianError::InvariantViolated);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Manually closes the raw Book account: it is not an Anchor `#[account]` (see
/// `state/book.rs`'s module doc comment), so Anchor's `close = destination` constraint
/// does not apply to it and this instruction cannot declare it `close = admin`. Mirrors
/// what that constraint does under the hood (lamports to `destination`, shrink to zero
/// length, reassign to the system program), plus an explicit zero of the data first --
/// the Book's raw bytes are the one account in this instruction whose contents
/// (resting order owners/prices) aren't already covered by a typed `Account<T>`'s own
/// close path, and `close_book`'s own `NotEmpty` guard means there is never a live
/// order left in it by this point regardless, but zeroing first is cheap and removes
/// any doubt a stray read could see stale bytes before the resize takes effect.
///
/// Safe to call on `book_ai` here specifically because `book` is declared
/// `UncheckedAccount` in `CloseAccounts`: Anchor's generated end-of-instruction `exit()`
/// is a no-op for `UncheckedAccount` (unlike `Account<T>`, which would otherwise try to
/// re-serialize over what this function just wrote).
fn close_raw_book_account<'info>(book_ai: &AccountInfo<'info>, destination: &AccountInfo<'info>) -> Result<()> {
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        data.fill(0);
    }

    let lamports = book_ai.lamports();
    let dest_starting = destination.lamports();
    **destination.try_borrow_mut_lamports()? = dest_starting
        .checked_add(lamports)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    **book_ai.try_borrow_mut_lamports()? = 0;

    book_ai.assign(&System::id());
    book_ai.resize(0).map_err(Into::into)
}

/// Closes a Yes/No mint if, and only if, it's a Token-2022 mint (carrying the
/// `MintCloseAuthority` extension `create_market` always sets, authority = market PDA)
/// with zero outstanding supply. A classic-Token mint is never closeable this way
/// regardless of supply (classic Token has no mint-closing instruction at all); a
/// Token-2022 mint with nonzero supply isn't reclaimable *yet* (some Yes/No token from
/// this market is still sitting unredeemed in some wallet, which `redeem_pair`/
/// `redeem_winning` never force). Neither case is an error -- both just log and return.
/// Lamports go to `admin`, matching this file's convention for every other account this
/// pair of instructions reclaims.
fn close_mint_if_reclaimable<'info>(
    mint_ai: AccountInfo<'info>,
    mint_label: &str,
    admin_ai: &AccountInfo<'info>,
    market_ai: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if mint_ai.owner != &anchor_spl::token_2022::ID {
        msg!(
            "close_market: {} is a classic-Token mint, no close authority extension -- skipping",
            mint_label
        );
        return Ok(());
    }

    let data = mint_ai.try_borrow_data()?;
    let mint_state = token_interface::spl_token_2022::extension::StateWithExtensions::<
        token_interface::spl_token_2022::state::Mint,
    >::unpack(&data)
    .map_err(|_| error!(MeridianError::InvariantViolated))?;
    let supply = mint_state.base.supply;
    drop(data);

    if supply != 0 {
        msg!(
            "close_market: {} still has {} outstanding, not reclaimable yet -- skipping",
            mint_label,
            supply
        );
        return Ok(());
    }

    token_interface::close_account(CpiContext::new_with_signer(
        anchor_spl::token_2022::ID,
        token_interface::CloseAccount {
            account: mint_ai,
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))
}

/// A mint account's `supply` field (bytes `[36, 44)`, little-endian). Classic-Token and
/// Token-2022 mints share an identical base `Mint` layout (`mint_authority: COption<Pubkey>`
/// at `[0, 36)`, `supply: u64` at `[36, 44)`, ...) -- Token-2022's extension TLV data, if
/// any, always comes *after* this base region, never inside it -- so this reads correctly
/// regardless of which program owns the mint, exactly like `token_account_amount` above
/// does for a token account's `amount` field. Used by `handle_remove_strike`'s
/// `StrikeInUse` guard, which must *error* on nonzero supply rather than silently skip the
/// mint (unlike `close_mint_if_reclaimable`'s skip-and-log, appropriate only for the
/// already-settled, no-longer-adjustable markets `close_market` runs on).
fn mint_supply(mint_ai: &AccountInfo) -> Result<u64> {
    let data = mint_ai.try_borrow_data()?;
    require!(data.len() >= 44, MeridianError::InvariantViolated);
    Ok(u64::from_le_bytes(data[36..44].try_into().unwrap()))
}

/// Admin-only strike removal for an *Open* market -- see this file's module doc comment
/// ("`remove_strike`") for the full guard/effect rationale. Reuses `CloseAccounts`
/// unchanged and collapses `handle_close_book`'s escrow/book-closing sequence and
/// `handle_close_market`'s vault/mint/Market-closing sequence into one call.
pub fn handle_remove_strike(ctx: Context<CloseAccounts>) -> Result<()> {
    // Only ever runs pre-settlement; a Settled market's strike is retired through
    // close_book/close_market instead (see module doc comment).
    require!(ctx.accounts.market.is_open(), MeridianError::MarketSettled);

    // Nothing has ever traded against this strike: no pair minted, and (redundantly,
    // but checked independently in case `pairs_outstanding` and actual mint supply
    // ever disagree) no outstanding Yes/No token of either side.
    require!(ctx.accounts.market.pairs_outstanding == 0, MeridianError::StrikeInUse);
    require!(mint_supply(&ctx.accounts.yes_mint.to_account_info())? == 0, MeridianError::StrikeInUse);
    require!(mint_supply(&ctx.accounts.no_mint.to_account_info())? == 0, MeridianError::StrikeInUse);

    // `book`'s `seeds`/`bump` constraint already proves this is the correct derived
    // Book PDA for `market`, regardless of whether `market.book` has been set -- same
    // reasoning as `handle_close_book`.
    let market_key = ctx.accounts.market.key();
    let book_ai = ctx.accounts.book.to_account_info();
    let book_is_finished = ctx.accounts.market.book != Pubkey::default();

    if book_is_finished {
        require_keys_eq!(ctx.accounts.market.book, book_ai.key(), MeridianError::InvariantViolated);
        require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);
        let data = book_ai.try_borrow_data()?;
        let header = read_header(&data)?;
        require!(header.bid_count == 0 && header.ask_count == 0, MeridianError::NotEmpty);
    }
    // Else: an unfinished book -- see `handle_close_book`'s "Unfinished books" comment;
    // the same reasoning applies verbatim here.

    let usdc_token_program_key = ctx.accounts.usdc_token_program.key();
    let yesno_token_program_key = ctx.accounts.yesno_token_program.key();
    let usdc_escrow_ai = ctx.accounts.usdc_escrow.to_account_info();
    let yes_escrow_ai = ctx.accounts.yes_escrow.to_account_info();
    require!(
        token_account_amount(&usdc_escrow_ai, &usdc_token_program_key)? == 0,
        MeridianError::NotEmpty
    );
    require!(
        token_account_amount(&yes_escrow_ai, &yesno_token_program_key)? == 0,
        MeridianError::NotEmpty
    );
    require!(ctx.accounts.vault.amount == 0, MeridianError::NotEmpty);

    let seeds_owned = market_signer_seeds(&ctx.accounts.market);
    let seeds: Vec<&[u8]> = seeds_owned.iter().map(|s| s.as_slice()).collect();
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    let market_ai = ctx.accounts.market.to_account_info();
    let admin_ai = ctx.accounts.admin.to_account_info();

    // Escrows (same CPIs as `handle_close_book`).
    token::close_account(CpiContext::new_with_signer(
        usdc_token_program_key,
        CloseAccount {
            account: usdc_escrow_ai,
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    token_interface::close_account(CpiContext::new_with_signer(
        yesno_token_program_key,
        token_interface::CloseAccount {
            account: yes_escrow_ai,
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    // Vault (same CPI as `handle_close_market`).
    token::close_account(CpiContext::new_with_signer(
        usdc_token_program_key,
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    // Mints: closable (Token-2022, zero supply -- already proven above) or left inert
    // (classic, or Token-2022 whose supply check above hasn't run against -- it has,
    // so in practice this always closes a Token-2022 mint here) -- same helper
    // `handle_close_market` uses.
    close_mint_if_reclaimable(
        ctx.accounts.yes_mint.to_account_info(),
        "yes_mint",
        &admin_ai,
        &market_ai,
        signer_seeds,
    )?;
    close_mint_if_reclaimable(
        ctx.accounts.no_mint.to_account_info(),
        "no_mint",
        &admin_ai,
        &market_ai,
        signer_seeds,
    )?;

    // Book: finished, partial, or never-allocated -- same three-way handling as
    // `handle_close_book`. Done *last*, after every remaining CPI in this
    // instruction: both branches mutate `book_ai`'s lamports/owner/data directly
    // (no CPI), and litesvm's/the native loader's balance-conservation check runs
    // when the *next* CPI is dispatched -- issuing one after a direct, non-CPI
    // ownership/lamport change on an account not involved in that next CPI trips it
    // (confirmed directly: moving this block earlier, before the vault/mint CPIs
    // above, reproduces `InstructionError::UnbalancedInstruction` even though the
    // move itself is correct and the exact same code/order `handle_close_book`
    // already uses standalone). Putting every direct mutation (book, then Market
    // itself below) after the last CPI sidesteps the check entirely.
    if book_ai.owner == &crate::ID {
        close_raw_book_account(&book_ai, &admin_ai)?;
    } else if book_ai.lamports() > 0 {
        let book_bump = [ctx.bumps.book];
        let book_seeds: &[&[u8]] = &[BOOK_SEED, market_key.as_ref(), &book_bump];
        let book_signer_seeds: &[&[&[u8]]] = &[book_seeds];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: book_ai.clone(),
                    to: admin_ai.clone(),
                },
                book_signer_seeds,
            ),
            book_ai.lamports(),
        )?;
    }

    // The Market account itself, freeing the (ticker, trading_day, strike) PDA seeds
    // for a later create_market/add_strike call -- see `handle_close_market`'s own
    // doc comment for why this is a manual `close()` rather than a `close =
    // destination` constraint (shared `CloseAccounts` struct).
    ctx.accounts.market.close(admin_ai)?;

    Ok(())
}

pub fn handle_close_book(ctx: Context<CloseAccounts>) -> Result<()> {
    require!(ctx.accounts.market.is_settled(), MeridianError::MarketNotSettled);
    // Idempotent no-op if `close_book` already ran (mirrors `create_book`'s own
    // idempotent re-validation path): a client retrying a call whose confirmation it
    // missed doesn't need to special-case "already done."
    if ctx.accounts.market.book_closed {
        return Ok(());
    }

    // `book`'s `seeds`/`bump` constraint (see `CloseAccounts` below) already proves
    // this account is the correct derived Book PDA for `market`, regardless of whether
    // `market.book` has been set yet -- the PDA's address never depends on that.
    let market_key = ctx.accounts.market.key();
    let book_ai = ctx.accounts.book.to_account_info();
    let book_is_finished = ctx.accounts.market.book != Pubkey::default();

    if book_is_finished {
        require_keys_eq!(ctx.accounts.market.book, book_ai.key(), MeridianError::InvariantViolated);
        require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);
        let data = book_ai.try_borrow_data()?;
        let header = read_header(&data)?;
        require!(header.bid_count == 0 && header.ask_count == 0, MeridianError::NotEmpty);
    }
    // Else: an unfinished book (see this file's module doc comment, "Unfinished
    // books") -- its header, if any bytes are even allocated yet, was never fully
    // written, so there can be no live order to check for.

    let usdc_token_program_key = ctx.accounts.usdc_token_program.key();
    let yesno_token_program_key = ctx.accounts.yesno_token_program.key();
    let usdc_escrow_ai = ctx.accounts.usdc_escrow.to_account_info();
    let yes_escrow_ai = ctx.accounts.yes_escrow.to_account_info();
    require!(
        token_account_amount(&usdc_escrow_ai, &usdc_token_program_key)? == 0,
        MeridianError::NotEmpty
    );
    require!(
        token_account_amount(&yes_escrow_ai, &yesno_token_program_key)? == 0,
        MeridianError::NotEmpty
    );

    let seeds_owned = market_signer_seeds(&ctx.accounts.market);
    let seeds: Vec<&[u8]> = seeds_owned.iter().map(|s| s.as_slice()).collect();
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    let market_ai = ctx.accounts.market.to_account_info();
    let admin_ai = ctx.accounts.admin.to_account_info();

    token::close_account(CpiContext::new_with_signer(
        usdc_token_program_key,
        CloseAccount {
            account: usdc_escrow_ai,
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    token_interface::close_account(CpiContext::new_with_signer(
        yesno_token_program_key,
        token_interface::CloseAccount {
            account: yes_escrow_ai,
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    // Reclaim whatever the Book PDA currently holds: a fully-sized, finished book
    // (owned by this program; `book_is_finished` above already validated it empty); a
    // partial allocation from a `create_book` that started but never finished (also
    // owned by this program, just undersized -- `close_raw_book_account` zeroes
    // whatever is there regardless of size); or, for a market whose `create_book` never
    // ran at all, nothing (system-owned, no data) or a prefunded-but-never-allocated
    // PDA (system-owned, nonzero lamports, no data) -- swept via a plain signed
    // `system_program::transfer` instead, since a system-owned account's lamports
    // cannot be debited directly by a program that doesn't own it.
    if book_ai.owner == &crate::ID {
        close_raw_book_account(&book_ai, &admin_ai)?;
    } else if book_ai.lamports() > 0 {
        // System-owned but prefunded (someone sent it SOL before `create_book` ever
        // ran -- see `create_book.rs`'s own module doc comment for the same scenario).
        // A system-owned account's lamports cannot be debited directly by a program
        // that doesn't own it, so this sweeps them via a signed `system_program::transfer`
        // instead, using the *Book* PDA's own seeds/bump (not the market's).
        let book_bump = [ctx.bumps.book];
        let book_seeds: &[&[u8]] = &[BOOK_SEED, market_key.as_ref(), &book_bump];
        let book_signer_seeds: &[&[&[u8]]] = &[book_seeds];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: book_ai.clone(),
                    to: admin_ai.clone(),
                },
                book_signer_seeds,
            ),
            book_ai.lamports(),
        )?;
    }

    ctx.accounts.market.book = Pubkey::default();
    ctx.accounts.market.book_closed = true;

    Ok(())
}

pub fn handle_close_market(ctx: Context<CloseAccounts>) -> Result<()> {
    require!(ctx.accounts.market.is_settled(), MeridianError::MarketNotSettled);
    // `close_book` must run first; its completion is witnessed by the explicit
    // `book_closed` flag, not `market.book == Pubkey::default()` alone -- that's true
    // both before `create_book` ever finishes *and* after `close_book` has run, so it
    // can't tell the two apart (Wave 5 review fix, 2026-10-06; see `book_closed`'s doc
    // comment in `state/market.rs`). Reported as the same `NotEmpty` error a caller
    // would see from any other "something here still needs emptying/closing" guard.
    require!(ctx.accounts.market.book_closed, MeridianError::NotEmpty);
    // Independently re-verify on chain, rather than just trusting the flag, that
    // neither the Book PDA nor either escrow PDA still exists. `book`'s `seeds`/`bump`
    // constraint (below) already proves these are the correct derived PDAs.
    require!(ctx.accounts.book.to_account_info().lamports() == 0, MeridianError::NotEmpty);
    require!(ctx.accounts.usdc_escrow.to_account_info().lamports() == 0, MeridianError::NotEmpty);
    require!(ctx.accounts.yes_escrow.to_account_info().lamports() == 0, MeridianError::NotEmpty);
    require!(ctx.accounts.vault.amount == 0, MeridianError::NotEmpty);

    let seeds_owned = market_signer_seeds(&ctx.accounts.market);
    let seeds: Vec<&[u8]> = seeds_owned.iter().map(|s| s.as_slice()).collect();
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    let market_ai = ctx.accounts.market.to_account_info();
    let admin_ai = ctx.accounts.admin.to_account_info();
    let usdc_token_program_key = ctx.accounts.usdc_token_program.key();

    token::close_account(CpiContext::new_with_signer(
        usdc_token_program_key,
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: admin_ai.clone(),
            authority: market_ai.clone(),
        },
        signer_seeds,
    ))?;

    // Reclaim the Yes/No mints, Token-2022's `MintCloseAuthority` extension makes
    // possible but classic Token never does -- see this file's module doc comment.
    // Both mints are checked and (maybe) closed independently: a market's two mints
    // are created together and so always share one owning program, but nothing stops
    // one side's supply from hitting zero before the other's.
    close_mint_if_reclaimable(
        ctx.accounts.yes_mint.to_account_info(),
        "yes_mint",
        &admin_ai,
        &market_ai,
        signer_seeds,
    )?;
    close_mint_if_reclaimable(
        ctx.accounts.no_mint.to_account_info(),
        "no_mint",
        &admin_ai,
        &market_ai,
        signer_seeds,
    )?;

    // `Account<Market>::close` (from the `AccountsClose` trait, blanket-implemented for
    // any `#[account]` type -- see `anchor_lang::accounts::account`) does exactly what
    // Anchor's own `close = destination` constraint macro would: lamports to `admin`,
    // reassign to the system program, shrink to zero length. Doing it here manually
    // (rather than via that constraint) is required because `CloseAccounts` is shared
    // with `close_book`, which must *not* close `market` -- see this file's module doc
    // comment. Marking the account closed this way also makes Anchor's generated
    // end-of-instruction `exit()` skip re-serializing the in-memory `Market` struct back
    // over what this just wrote (`AccountsExit::exit` checks `common::is_closed`).
    ctx.accounts.market.close(admin_ai)?;

    Ok(())
}

#[derive(Accounts)]
pub struct CloseAccounts<'info> {
    #[account(mut)]
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

    /// CHECK: raw program-owned (or, for an unfinished book, still system-owned) Book
    /// account for `market` (see `state/book.rs`'s module doc comment). `seeds`/`bump`
    /// derive and verify its address the same way for both instructions -- the Book
    /// PDA's address never depends on whether `market.book` has been set -- so unlike
    /// before this Wave 5 review fix, a caller cannot substitute an arbitrary account
    /// here. `close_book` additionally checks ownership/contents in the handler;
    /// `close_market` only checks `lamports() == 0`.
    #[account(mut, seeds = [BOOK_SEED, market.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,

    /// CHECK: SPL USDC escrow for `market`'s book. Not a typed `Account<TokenAccount>`:
    /// `close_market` must still be able to declare this field even after `close_book`
    /// has already closed it (a typed account would fail `AccountNotInitialized` at
    /// that point regardless of whether the handler reads it). `close_book` manually
    /// validates ownership and reads `amount` via `token_account_amount`.
    #[account(mut, seeds = [b"escrow_usdc", market.key().as_ref()], bump)]
    pub usdc_escrow: UncheckedAccount<'info>,

    /// CHECK: see `usdc_escrow`'s doc comment; same reasoning for the Yes escrow.
    #[account(mut, seeds = [b"escrow_yes", market.key().as_ref()], bump)]
    pub yes_escrow: UncheckedAccount<'info>,

    #[account(mut, address = market.vault @ MeridianError::InvariantViolated)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: closed by `close_market` iff Token-2022 with zero supply; left in place
    /// otherwise -- see this file's module doc comment and `close_mint_if_reclaimable`.
    /// Not a `Box<InterfaceAccount<Mint>>`: the handler needs the raw `AccountInfo` to
    /// read `supply` off either a classic or a Token-2022 mint without the typed
    /// wrapper's `AccountDeserialize` rejecting a to-be-closed account on a retry, so
    /// this (like `usdc_escrow`/`yes_escrow` above) stays `UncheckedAccount`, with
    /// `address` as the one constraint Anchor still checks for us.
    #[account(mut, address = market.yes_mint @ MeridianError::InvariantViolated)]
    pub yes_mint: UncheckedAccount<'info>,

    /// CHECK: see `yes_mint`'s doc comment; same reasoning for the No mint.
    #[account(mut, address = market.no_mint @ MeridianError::InvariantViolated)]
    pub no_mint: UncheckedAccount<'info>,

    /// Classic SPL Token: owns the USDC vault/escrow. Always classic -- USDC's real
    /// mint never migrates.
    pub usdc_token_program: Program<'info, Token>,
    /// Whichever program owns `yes_escrow`/the Yes/No mints for this market --
    /// Token-2022 for a market created after this migration, classic Token for a
    /// legacy market. `token_account_amount`/`close_mint_if_reclaimable` check the
    /// actual account owner at call time rather than trusting this blindly.
    pub yesno_token_program: Interface<'info, TokenInterface>,
    /// Needed only by `close_book`'s unfinished-book path, to sweep a prefunded-but-
    /// never-allocated Book PDA's lamports via a signed `system_program::transfer`.
    pub system_program: Program<'info, System>,
}
