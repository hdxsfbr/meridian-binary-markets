//! `buy_no_limit(qty, price)` (Wave 5, T057).
//!
//! Buy No (limit) = mint `qty` pairs, then post a resting Yes ask at `price` so the
//! user holds `qty` No plus a resting Yes ask until it fills (FR-014's transient
//! state; see `specs/001-binary-outcome-markets/research.md` R8). `BookFull` is
//! checked on the ask side *before* anything mints, so a full book never leaves the
//! user holding an unwanted pair.
//!
//! Flow: guards -> `BookFull` check on the ask side (no funds moved yet) -> mint `qty`
//! pairs (reusing `mint_pair_core`) -> escrow the qty Yes the user just minted into
//! `yes_escrow` -> insert a resting ask owned by the user -> assert the escrow
//! invariant.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::book::escrow;
use crate::book::matching::Side;
use crate::errors::MeridianError;
use crate::events::OrderPlaced;
use crate::instructions::mint_pair::mint_pair_core;
use crate::math::{pairs_to_usdc, PRICE_MAX};
use crate::state::book::{asks_mut, insert_sorted, read_header, sum_ask_escrow, write_header, Order};
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

pub fn handle_buy_no_limit(ctx: Context<BuyNoLimit>, qty: u64, price: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(ctx.accounts.market.is_open(), MeridianError::MarketSettled);
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.market.close_ts,
        MeridianError::MarketClosed
    );
    require!(qty > 0, MeridianError::ZeroQuantity);
    require!(price >= 1 && price <= PRICE_MAX, MeridianError::PriceOutOfRange);

    let book_ai = ctx.accounts.book.to_account_info();
    require_keys_eq!(book_ai.key(), ctx.accounts.market.book, MeridianError::InvariantViolated);
    require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();

    // BookFull guard, checked before any funds move (and before minting).
    let (mut header, capacity) = {
        let data = book_ai.try_borrow_data()?;
        let header = read_header(&data)?;
        (header, header.capacity)
    };
    require!(header.ask_count < capacity, MeridianError::BookFull);

    // Mint qty pairs: USDC user -> vault, Yes+No to user. Emits `Minted`.
    mint_pair_core(
        &ctx.accounts.config,
        &mut ctx.accounts.market,
        &ctx.accounts.yes_mint,
        &ctx.accounts.no_mint,
        &mut ctx.accounts.vault,
        &ctx.accounts.user,
        &ctx.accounts.user_usdc,
        &ctx.accounts.user_yes,
        &ctx.accounts.user_no,
        &ctx.accounts.token_program,
        qty,
    )?;

    // Escrow the qty Yes the user just minted into yes_escrow.
    let yes_amt = pairs_to_usdc(qty)?;
    escrow::transfer_user_to_escrow(
        ctx.accounts.token_program.key(),
        &ctx.accounts.user_yes.to_account_info(),
        &ctx.accounts.yes_escrow.to_account_info(),
        &ctx.accounts.user.to_account_info(),
        yes_amt,
    )?;

    // Rest the ask at `price`.
    let order_id = header.next_order_id;
    let seq = header.next_seq;
    header.next_order_id = header
        .next_order_id
        .checked_add(1)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    header.next_seq = header
        .next_seq
        .checked_add(1)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;

    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let asks = asks_mut(&mut data, capacity)?;
        let order = Order {
            id: order_id,
            owner: user_key.to_bytes(),
            price,
            remaining: qty,
            seq,
        };
        let new_count = insert_sorted(asks, header.ask_count, order, false)?;
        header.ask_count = new_count;
        write_header(&mut data, &header);
    }

    emit!(OrderPlaced {
        market: market_key,
        order_id,
        owner: user_key,
        side: Side::Ask as u8,
        price,
        qty,
    });

    // Escrow invariant: yes_escrow must cover every live ask, including the one just
    // inserted.
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let asks = asks_mut(&mut data, capacity)?;
        let expected_yes = sum_ask_escrow(asks, header.ask_count)?;
        drop(data);
        ctx.accounts.yes_escrow.reload()?;
        require!(
            ctx.accounts.yes_escrow.amount >= expected_yes,
            MeridianError::InvariantViolated
        );
    }

    Ok(())
}

#[derive(Accounts)]
pub struct BuyNoLimit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [crate::state::config::SEED], bump = config.bump)]
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
    pub yes_mint: Account<'info, Mint>,

    #[account(mut, address = market.no_mint @ MeridianError::InvariantViolated)]
    pub no_mint: Account<'info, Mint>,

    #[account(mut, address = market.vault @ MeridianError::InvariantViolated)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: raw program-owned Book account for `market`; address/owner/discriminator
    /// validated in the handler.
    #[account(mut, address = market.book @ MeridianError::InvariantViolated)]
    pub book: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"escrow_usdc", market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [b"escrow_yes", market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
