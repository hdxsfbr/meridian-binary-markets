//! `reclaim_mint(ticker, trading_day, strike, side)` -- permissionless cleanup for a
//! Yes/No Token-2022 mint `close_market` could not close (see `close.rs`'s module doc
//! comment and `close_mint_if_reclaimable`): `close_market` only closes a mint when its
//! supply is already zero *at settlement-close time*, which the losing side's mint
//! almost never is (its holders still have unredeemed, now-worthless tokens). Deleting
//! `Market` anyway (which `close_market` always does, once the book/vault/escrows are
//! empty) would otherwise leave that mint's rent permanently unreclaimable -- there is
//! no other instruction that can CPI `close_account` with the market PDA as
//! `authority` once `Market` itself is gone.
//!
//! This instruction re-derives the market PDA straight from `(ticker, trading_day,
//! strike)` -- seeds/bump signing never requires the `Market` account to actually
//! exist, only the formula that produced its address -- so it still works after
//! `close_market` has deleted it, which is the common case. It also tolerates the
//! (far rarer) case where `Market` has not been closed yet: a holder could burn the
//! losing side's last outstanding tokens (`PositionRow`'s "Remove from wallet",
//! `web/src/components/PositionRow.tsx`) after settlement but before the admin/worker
//! gets around to calling `close_book`/`close_market`. Either way the Yes/No token
//! supply, not `Market`'s lifecycle, is the only thing this instruction actually gates
//! on reclaiming the mint; it additionally requires the market be at least settled and
//! have run `close_book` (`book_closed`) if `Market` still exists, so a mint can never
//! be reclaimed out from under a market that is still open or still trading.
//!
//! Every check is re-derived from the mint/market accounts themselves, not trusted from
//! the caller, since this is permissionless (no signer beyond whichever transaction fee
//! payer submits it) and always pays `Config.admin`, never the caller:
//! - `mint` must be owned by Token-2022 (`token_program` must be too) -- a classic mint
//!   is never closeable this way (classic Token has no mint-closing instruction at all;
//!   see `close.rs`), so one is rejected with `TokenProgramMismatch`, not silently
//!   skipped.
//! - `mint`'s address must itself be the Yes or No mint PDA for the re-derived market
//!   (`seeds`/`bump` on the `mint` field below), matching `side`.
//! - `mint`'s own `MintCloseAuthority` extension must name the re-derived market PDA,
//!   exactly as `create_market.rs` sets it -- not assumed just because the address
//!   matched.
//! - `mint`'s supply must be exactly zero.
//! - If a `Market` account still exists at the derived PDA, it must be settled and
//!   have `book_closed` set; if none exists (the common path -- `close_market` already
//!   ran), there is nothing further to check.

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{
    self,
    spl_token_2022::extension::{mint_close_authority::MintCloseAuthority, BaseStateWithExtensions},
    TokenInterface,
};

use crate::errors::MeridianError;
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

/// The two Yes/No mint PDAs share `create_market.rs`'s seed prefixes exactly
/// (`[b"yes_mint", market]` / `[b"no_mint", market]`); `side` selects which one `mint`
/// is expected to be. Any `side` other than `1`/`2` falls through to the `no_mint`
/// prefix, which simply makes the `mint` seeds constraint below fail for every caller
/// that doesn't also pass a matching mint address -- there is no way to reclaim
/// anything with a bogus `side`.
fn mint_seed_prefix(side: u8) -> &'static [u8] {
    if side == 1 {
        b"yes_mint"
    } else {
        b"no_mint"
    }
}

pub fn handle_reclaim_mint(ctx: Context<ReclaimMint>, ticker: [u8; 8], trading_day: u32, strike: u64, side: u8) -> Result<()> {
    require!(side == 1 || side == 2, MeridianError::WrongSide);

    let mint_ai = ctx.accounts.mint.to_account_info();
    require!(mint_ai.owner == &token_2022::ID, MeridianError::TokenProgramMismatch);
    require_keys_eq!(ctx.accounts.token_program.key(), token_2022::ID, MeridianError::TokenProgramMismatch);

    let market_ai = ctx.accounts.market.to_account_info();

    // `Market` may already be gone (the common path: `close_market` deleted it while
    // this mint still had outstanding supply). If it isn't gone, it must be settled
    // and have already run `close_book` -- a mint can never be reclaimed while its
    // market is still open or still trading.
    if market_ai.lamports() > 0 {
        require!(market_ai.owner == &crate::ID, MeridianError::InvariantViolated);
        let data = market_ai.try_borrow_data()?;
        let market = Market::try_deserialize(&mut &data[..])?;
        drop(data);
        require!(market.is_settled() && market.book_closed, MeridianError::MarketNotSettled);
    }

    let data = mint_ai.try_borrow_data()?;
    let mint_state = token_interface::spl_token_2022::extension::StateWithExtensions::<
        token_interface::spl_token_2022::state::Mint,
    >::unpack(&data)
    .map_err(|_| error!(MeridianError::InvariantViolated))?;
    require!(mint_state.base.supply == 0, MeridianError::NotEmpty);

    let close_authority_ext = mint_state
        .get_extension::<MintCloseAuthority>()
        .map_err(|_| error!(MeridianError::InvariantViolated))?;
    let close_authority: Option<Pubkey> = close_authority_ext.close_authority.into();
    require_keys_eq!(
        close_authority.ok_or_else(|| error!(MeridianError::InvariantViolated))?,
        market_ai.key(),
        MeridianError::InvariantViolated
    );
    drop(data);

    let bump = [ctx.bumps.market];
    let trading_day_bytes = trading_day.to_le_bytes();
    let strike_bytes = strike.to_le_bytes();
    let seeds: &[&[u8]] = &[MARKET_SEED, &ticker, &trading_day_bytes, &strike_bytes, &bump];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token_interface::close_account(CpiContext::new_with_signer(
        token_2022::ID,
        token_interface::CloseAccount {
            account: mint_ai,
            destination: ctx.accounts.admin.to_account_info(),
            authority: market_ai,
        },
        signer_seeds,
    ))
}

#[derive(Accounts)]
#[instruction(ticker: [u8; 8], trading_day: u32, strike: u64, side: u8)]
pub struct ReclaimMint<'info> {
    #[account(seeds = [crate::state::config::SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: the Market PDA for `(ticker, trading_day, strike)`, re-derived from its
    /// seeds alone -- deliberately `UncheckedAccount`, not `Account<Market>`, since
    /// the whole point of this instruction is to still work once `close_market` has
    /// already closed it (see module doc comment). `bump` with no explicit value
    /// makes Anchor compute the canonical bump itself and verify the caller's address
    /// matches it, exactly like every other Market-PDA constraint in this program --
    /// a caller cannot substitute an unrelated account here.
    #[account(seeds = [MARKET_SEED, &ticker, &trading_day.to_le_bytes(), &strike.to_le_bytes()], bump)]
    pub market: UncheckedAccount<'info>,

    /// CHECK: the Yes or No mint PDA for `market`, selected by `side`. `seeds`/`bump`
    /// prove the address; the handler independently checks owner, supply, and the
    /// mint's own `MintCloseAuthority` extension before ever closing it.
    #[account(mut, seeds = [mint_seed_prefix(side), market.key().as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: `Config.admin`, destination for the reclaimed mint rent. Deliberately
    /// not a `Signer` -- this instruction is permissionless (anyone -- typically the
    /// automation worker, or a wallet that just burned its losing tokens -- can
    /// trigger the cleanup once the preconditions hold), but it always pays the
    /// configured admin, never whoever happens to submit the transaction.
    #[account(mut, address = config.admin @ MeridianError::Unauthorized)]
    pub admin: UncheckedAccount<'info>,

    /// Must be Token-2022: a classic mint is never reclaimable this way (see module
    /// doc comment). Checked again against `mint`'s own owner in the handler rather
    /// than trusted from this account's type alone.
    pub token_program: Interface<'info, TokenInterface>,
}
