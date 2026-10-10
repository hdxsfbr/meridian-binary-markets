//! `create_market` / `add_strike` (Wave 2, T020; Token-2022 migration, Wave N).
//!
//! Both instructions share one handler and one `Accounts` struct: a strike market is the
//! same kind of object whether it is the first for a trading day or added mid-session;
//! only the entry point name differs (contracts/program-instructions.md "Add Strike").
//!
//! Creates: the `Market` PDA, Yes/No SPL mints, a USDC vault token account, a USDC
//! escrow token account, and a Yes escrow token account. The Book is created by a
//! *separate* instruction, `create_book` (see `create_book.rs`) -- see that file's doc
//! comment and `specs/001-binary-outcome-markets/contracts/program-instructions.md`'s
//! "Split note" for why. `market.book` is `Pubkey::default()` until `create_book`
//! finishes sizing and initializing it.
//!
//! Token-2022 migration: every Yes/No mint `create_market`/`add_strike` creates from
//! here on is a Token-2022 mint (6 decimals, mint authority = market PDA) with two fixed-
//! size extensions -- `MetadataPointer` (pointed at the mint account itself) and
//! `MintCloseAuthority` (close authority = market PDA, so `close.rs` can reclaim a fully
//! redeemed market's mint rent) -- plus variable-length on-mint `TokenMetadata`
//! (name/symbol/uri). There is no "classic mode" left in this instruction: classic-Token
//! Yes/No mints only exist as already-on-chain legacy state from before this migration.
//! `Market`'s account layout is unchanged (see `state/market.rs`'s module doc comment) --
//! every other instruction derives which token program owns a market's mints from the
//! mint account's own `owner` at call time (`state::market::require_matching_token_program`),
//! so legacy markets keep working without any new field or migration instruction.
//!
//! The two fixed-size extensions are initialized declaratively by Anchor's own
//! `extensions::metadata_pointer::...`/`extensions::close_authority::...` constraints on
//! `yes_mint`/`no_mint` below (anchor-lang 1.2.1 supports these; see
//! `anchor-syn-1.2.1/src/{parser,codegen}/accounts/constraints.rs`) -- that codegen sizes
//! the mint account for exactly those two extensions, initializes them, and calls
//! `initialize_mint2`, all before this handler body ever runs. `TokenMetadata` is *not*
//! covered by a declarative constraint in this anchor-lang version (it is variable-length
//! and self-referential in a way the fixed-size extension constraints aren't), so
//! `init_token_metadata` below hand-rolls the standard manual pattern instead: compute the
//! final size from `TokenMetadata::tlv_size_of`, realloc the mint account (topping up
//! rent-exempt lamports from `payer` first), then CPI
//! `token_2022_extensions::token_metadata::token_metadata_initialize`.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{Mint as UsdcMint, Token, TokenAccount};
use anchor_spl::token_interface::{self, TokenInterface};

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

/// Trims a `[u8; 8]` ASCII NUL-padded ticker down to its printable prefix.
fn ticker_str(ticker: &[u8; 8]) -> String {
    let end = ticker.iter().position(|&b| b == 0).unwrap_or(8);
    String::from_utf8_lossy(&ticker[..end]).into_owned()
}

/// Formats a micro-USD strike (`u64`, 6 decimals) as a human price, trimming trailing
/// fractional zeros (and the decimal point itself when the strike is a whole dollar
/// amount). Never drops a significant digit -- only trailing zeros.
fn format_strike(strike: u64) -> String {
    let whole = strike / 1_000_000;
    let frac = strike % 1_000_000;
    if frac == 0 {
        whole.to_string()
    } else {
        let mut frac_str = format!("{:06}", frac);
        while frac_str.ends_with('0') {
            frac_str.pop();
        }
        format!("{whole}.{frac_str}")
    }
}

/// Formats a `YYYYMMDD` `trading_day` as `YYYY-MM-DD`.
/// `"Oct 10"`: the short wallet-friendly date used in the mint name. The year is
/// implied by the market (each key is one trading day), and wallets truncate long
/// names in list views, so the shortest unambiguous form wins.
fn format_date(trading_day: u32) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = ((trading_day / 100) % 100) as usize;
    let day = trading_day % 100;
    let month_s = MONTHS.get(month.wrapping_sub(1)).copied().unwrap_or("???");
    format!("{month_s} {day}")
}

/// `"2026-10-10"`: the full ISO date, used only by the last-resort fallback of
/// `mint_name` where the ticker has been dropped and the day must stay unambiguous.
fn format_date_iso(trading_day: u32) -> String {
    let year = trading_day / 10_000;
    let month = (trading_day / 100) % 100;
    let day = trading_day % 100;
    format!("{year:04}-{month:02}-{day:02}")
}

/// Builds a Yes/No mint's on-chain `name` metadata field: `"<TICKER> ≥ $<strike> <Yes|No>
/// <Mon D>"` (e.g. `"AAPL ≥ $337 Yes Oct 10"`), kept within the 32-byte token-name limit.
/// Fallbacks, in order, if it does not fit: ASCII `">="` instead of `"≥"`, then `"Y"`/`"N"`
/// for the side, then the ticker is dropped and the full ISO date used -- the strike
/// digits and the date are never truncated at any step.
pub(crate) fn mint_name(ticker: &[u8; 8], strike: u64, trading_day: u32, is_yes: bool) -> String {
    let ticker_s = ticker_str(ticker);
    let strike_s = format_strike(strike);
    let date_s = format_date(trading_day);
    let side_long = if is_yes { "Yes" } else { "No" };
    let side_short = if is_yes { "Y" } else { "N" };

    let candidates = [
        format!("{ticker_s} \u{2265} ${strike_s} {side_long} {date_s}"),
        format!("{ticker_s} >= ${strike_s} {side_long} {date_s}"),
        format!("{ticker_s} >= ${strike_s} {side_short} {date_s}"),
    ];
    for candidate in candidates {
        if candidate.len() <= 32 {
            return candidate;
        }
    }

    // Drop the ticker rather than ever touch the strike digits or the date.
    format!(">=${strike_s} {side_short} {}", format_date_iso(trading_day))
}

/// Builds a Yes/No mint's on-chain `symbol` metadata field. Every Meridian token carries
/// the brand as its symbol so a wallet list reads "<name> / 1 MERIDIAN": the side and
/// the market are already in the name, and a non-crypto holder mostly wants to know
/// where the token came from.
pub(crate) fn mint_symbol(_ticker: &[u8; 8], _is_yes: bool) -> String {
    "MERIDIAN".to_string()
}

/// Reallocs `mint_ai` to fit `TokenMetadata(name, symbol, uri)` on top of whatever space
/// the declarative `extensions::...` constraints already allocated for `MetadataPointer`/
/// `MintCloseAuthority`, topping up rent-exempt lamports from `payer` first, then CPIs
/// `token_metadata_initialize` with the market PDA as both update authority and mint
/// authority (signed via `signer_seeds`).
#[allow(clippy::too_many_arguments)]
fn init_token_metadata<'info>(
    mint_ai: AccountInfo<'info>,
    token_program_ai: AccountInfo<'info>,
    token_program_id: Pubkey,
    market_ai: AccountInfo<'info>,
    market_key: Pubkey,
    payer_ai: AccountInfo<'info>,
    system_program_id: Pubkey,
    signer_seeds: &[&[&[u8]]],
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    use anchor_spl::token_interface::spl_pod::optional_keys::OptionalNonZeroPubkey;
    use anchor_spl::token_interface::spl_token_metadata_interface::state::TokenMetadata;

    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(market_key))
            .map_err(|_| error!(MeridianError::InvariantViolated))?,
        mint: mint_ai.key(),
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let additional_space = metadata
        .tlv_size_of()
        .map_err(|_| error!(MeridianError::InvariantViolated))?;

    let old_len = mint_ai.data_len();
    let new_len = old_len
        .checked_add(additional_space)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;

    let new_min_balance = Rent::get()?.minimum_balance(new_len);
    let current_lamports = mint_ai.lamports();
    if new_min_balance > current_lamports {
        let top_up = new_min_balance - current_lamports;
        system_program::transfer(
            CpiContext::new(
                system_program_id,
                system_program::Transfer {
                    from: payer_ai,
                    to: mint_ai.clone(),
                },
            ),
            top_up,
        )?;
    }

    // No `mint_ai.resize(new_len)` here: the mint is owned by the token program, not by
    // this program, so a direct `AccountInfo::resize` on it would be rejected by the
    // runtime as "account data size changed by a program other than the owner" (this
    // was tried and confirmed to fail that way). The token program's own
    // `TokenMetadataInitialize` processor does the realloc itself -- legally, since it
    // *is* the owner -- once the account is rent-exempt at the new size, which the
    // lamport top-up above already ensures.
    token_interface::token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program_id,
            token_interface::TokenMetadataInitialize {
                program_id: token_program_ai,
                metadata: mint_ai.clone(),
                update_authority: market_ai.clone(),
                mint_authority: market_ai,
                mint: mint_ai,
            },
            signer_seeds,
        ),
        name,
        symbol,
        uri,
    )
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

    {
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
    }

    // Market PDA signer seeds, in the documented order (data-model.md "Market":
    // `["market", ticker, trading_day_le, strike_le, bump]`), needed to sign the
    // `token_metadata_initialize` CPIs below (update authority = mint authority =
    // market PDA).
    let trading_day_bytes = trading_day.to_le_bytes();
    let strike_bytes = strike.to_le_bytes();
    let bump = [market_bump];
    let seeds: [&[u8]; 5] = [MARKET_SEED, ticker.as_ref(), &trading_day_bytes, &strike_bytes, &bump];
    let signer_seeds: &[&[&[u8]]] = &[&seeds];

    let token_program_id = ctx.accounts.token_program.key();
    let token_program_ai = ctx.accounts.token_program.to_account_info();
    let market_ai = ctx.accounts.market.to_account_info();
    let payer_ai = ctx.accounts.payer.to_account_info();
    let system_program_id = ctx.accounts.system_program.key();

    init_token_metadata(
        ctx.accounts.yes_mint.to_account_info(),
        token_program_ai.clone(),
        token_program_id,
        market_ai.clone(),
        market_key,
        payer_ai.clone(),
        system_program_id,
        signer_seeds,
        mint_name(&ticker, strike, trading_day, true),
        mint_symbol(&ticker, true),
        String::new(),
    )?;

    init_token_metadata(
        ctx.accounts.no_mint.to_account_info(),
        token_program_ai,
        token_program_id,
        market_ai,
        market_key,
        payer_ai,
        system_program_id,
        signer_seeds,
        mint_name(&ticker, strike, trading_day, false),
        mint_symbol(&ticker, false),
        String::new(),
    )?;

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

    /// Token-2022 mint with `MetadataPointer` (self-pointing) and `MintCloseAuthority`
    /// (authority = market PDA) extensions, plus on-mint `TokenMetadata` (initialized by
    /// `init_token_metadata` in the handler -- see this file's module doc comment).
    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = market,
        mint::token_program = token_program,
        extensions::metadata_pointer::authority = market,
        extensions::metadata_pointer::metadata_address = yes_mint,
        extensions::close_authority::authority = market,
        seeds = [b"yes_mint", market.key().as_ref()],
        bump,
    )]
    pub yes_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    /// See `yes_mint`'s doc comment -- same shape, the No side.
    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = market,
        mint::token_program = token_program,
        extensions::metadata_pointer::authority = market,
        extensions::metadata_pointer::metadata_address = no_mint,
        extensions::close_authority::authority = market,
        seeds = [b"no_mint", market.key().as_ref()],
        bump,
    )]
    pub no_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    #[account(
        init,
        payer = payer,
        token::mint = usdc_mint,
        token::authority = market,
        token::token_program = usdc_token_program,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        token::mint = usdc_mint,
        token::authority = market,
        token::token_program = usdc_token_program,
        seeds = [b"escrow_usdc", market.key().as_ref()],
        bump,
    )]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        token::mint = yes_mint,
        token::authority = market,
        token::token_program = token_program,
        seeds = [b"escrow_yes", market.key().as_ref()],
        bump,
    )]
    pub yes_escrow: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,

    // `mint::decimals = 6` is defense in depth: `initialize_config` already rejects a
    // non-6-decimal mint (`InvariantViolated`), and `config.usdc_mint` cannot change
    // after that without going through `update_config`, which does not touch the mint.
    // USDC's real mint is always classic SPL Token -- never Token-2022.
    #[account(address = config.usdc_mint, mint::decimals = 6)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,

    /// Token-2022: owns the newly created Yes/No mints and the Yes escrow.
    pub token_program: Interface<'info, TokenInterface>,
    /// Classic SPL Token: owns the USDC vault/escrow and (via `config.usdc_mint`) USDC
    /// itself. Always classic -- see `usdc_mint`'s doc comment.
    pub usdc_token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_name_fits_32_bytes_for_a_typical_market() {
        let ticker = *b"AAPL\0\0\0\0";
        let name = mint_name(&ticker, 150_000_000, 20261006, true);
        assert_eq!(name, "AAPL \u{2265} $150 Yes Oct 6");
        assert!(name.len() <= 32);
    }

    #[test]
    fn mint_name_trims_strike_fraction_trailing_zeros() {
        let ticker = *b"MSFT\0\0\0\0";
        let name = mint_name(&ticker, 150_500_000, 20261006, false);
        assert_eq!(name, "MSFT \u{2265} $150.5 No Oct 6");
    }

    #[test]
    fn mint_name_long_ticker_large_strike_never_truncates_strike_or_date() {
        // Longest possible ticker (8 bytes, no NUL padding) and a strike whose fraction
        // uses every one of the 6 decimals -- together these push every candidate format
        // past 32 bytes, so the fallback must drop the ticker, never a strike digit or
        // part of the date.
        let ticker = *b"ABCDEFGH";
        let strike = 999_999_999_999u64; // $999999.999999
        let trading_day = 20991231u32;

        let name = mint_name(&ticker, strike, trading_day, true);
        assert!(
            name.contains("999999.999999"),
            "strike digits must never be truncated: {name}"
        );
        assert!(name.contains("2099-12-31"), "date must never be truncated: {name}");
        assert!(!name.contains("ABCDEFGH"), "ticker is the first thing dropped: {name}");

        let name_no = mint_name(&ticker, strike, trading_day, false);
        assert!(name_no.contains("999999.999999"));
        assert!(name_no.contains("2099-12-31"));
    }

    #[test]
    fn mint_symbol_is_the_brand() {
        let ticker = *b"AAPL\0\0\0\0";
        assert_eq!(mint_symbol(&ticker, true), "MERIDIAN");
        assert_eq!(mint_symbol(&ticker, false), "MERIDIAN");
    }

    #[test]
    fn format_strike_handles_whole_and_fractional_values() {
        assert_eq!(format_strike(100_000_000), "100");
        assert_eq!(format_strike(150_500_000), "150.5");
        assert_eq!(format_strike(1), "0.000001");
    }

    #[test]
    fn format_date_renders_short_and_iso_forms() {
        assert_eq!(format_date(20261006), "Oct 6");
        assert_eq!(format_date(20261231), "Dec 31");
        assert_eq!(format_date_iso(20261006), "2026-10-06");
    }
}
