//! `sell_no_market(qty, max_yes_price)` (Wave 5, T058).
//!
//! Sell No (market) = buy the Yes leg IOC from resting asks at or below
//! `max_yes_price`, then redeem the filled pairs so the user receives
//! `filled * (1_000_000 - price)` net USDC (`specs/001-binary-outcome-markets/research.md`
//! R8). `InsufficientFill` fires before anything moves if the IOC leg would fill zero.
//! If the user doesn't hold at least `filled` No, the redeem's `burn` CPI fails and the
//! whole instruction reverts (no separate balance check needed).
//!
//! Flow: guards -> compute the match plan against resting asks (no funds moved yet) ->
//! `InsufficientFill` if the plan is empty, or missing `remaining_accounts` for the
//! planned fills -> for each fill, pay the maker USDC directly from the user and pay
//! the user Yes out of `yes_escrow` (the ask maker's escrowed Yes) -> decrement/remove
//! the filled ask makers -> redeem the filled pairs (reusing `redeem_pair_core`) ->
//! assert the escrow invariant.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::book::escrow;
use crate::book::matching::{self, Side};
use crate::errors::MeridianError;
use crate::events::Fill;
use crate::instructions::redeem_pair::redeem_pair_core;
use crate::math::{checked_mul_div, pairs_to_usdc, PRICE_MAX};
use crate::state::book::{asks_mut, read_header, remove_at, sum_ask_escrow, write_header};
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

/// Maximum number of fills matched in a single `sell_no_market` call (R7, same cap as
/// `place_order`).
const MAX_FILLS: usize = 8;

// Named lifetime (see `place_order.rs`'s `handle_place_order` doc comment): this
// handler reads `ctx.remaining_accounts` alongside `ctx.accounts` in the same CPIs
// (the USDC-transfer-to-maker loop below), which needs the compiler to know both carry
// the *same* `'info` rather than two independently elided ones.
pub fn handle_sell_no_market<'info>(
    ctx: Context<'info, SellNoMarket<'info>>,
    qty: u64,
    max_yes_price: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(ctx.accounts.market.is_open(), MeridianError::MarketSettled);
    require!(qty > 0, MeridianError::ZeroQuantity);
    require!(
        max_yes_price >= 1 && max_yes_price <= PRICE_MAX,
        MeridianError::PriceOutOfRange
    );

    let book_ai = ctx.accounts.book.to_account_info();
    require_keys_eq!(book_ai.key(), ctx.accounts.market.book, MeridianError::InvariantViolated);
    require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();
    let now = Clock::get()?.unix_timestamp;

    // Compute the match plan against resting asks first; nothing moves if it comes
    // back empty (taker side here is Bid: buying the Yes leg from the asks).
    let (mut header, capacity, plan) = {
        let mut data = book_ai.try_borrow_mut_data()?;
        let header = read_header(&data)?;
        let capacity = header.capacity;
        let ask_count = header.ask_count;
        let plan = {
            let asks = asks_mut(&mut data, capacity)?;
            matching::match_against(asks, ask_count, Side::Bid, max_yes_price, qty, MAX_FILLS)
        };
        (header, capacity, plan)
    };

    require!(!plan.fills.is_empty(), MeridianError::InsufficientFill);
    // Before anything moves (no transfers/redeem yet): a resting ask belonging to this
    // same taker must never cross against their own `sell_no_market` (Wave 5 review
    // fix, 2026-10-06).
    matching::reject_self_match(&plan, &user_key)?;
    require!(
        ctx.remaining_accounts.len() >= plan.fills.len(),
        MeridianError::InvariantViolated
    );

    let filled: u64 = plan.fills.iter().map(|f| f.qty).sum();

    // Market PDA signer seeds, for paying the user Yes out of `yes_escrow`.
    let ticker = ctx.accounts.market.ticker;
    let trading_day_bytes = ctx.accounts.market.trading_day.to_le_bytes();
    let strike_bytes = ctx.accounts.market.strike.to_le_bytes();
    let bump = [ctx.accounts.market.bump];
    let seeds: [&[u8]; 5] = [
        MARKET_SEED,
        ticker.as_ref(),
        trading_day_bytes.as_ref(),
        strike_bytes.as_ref(),
        &bump,
    ];
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    let token_program_key = ctx.accounts.token_program.key();
    let market_ai = ctx.accounts.market.to_account_info();
    let usdc_mint_key = ctx.accounts.config.usdc_mint;

    for (i, fill) in plan.fills.iter().enumerate() {
        let maker_ai = &ctx.remaining_accounts[i];
        escrow::validate_maker_account(maker_ai, &fill.maker, &usdc_mint_key)?;

        // USDC leg: the user's own USDC, straight to the maker (not escrowed -- this
        // is an immediate IOC fill, not a resting order).
        let usdc_amt = checked_mul_div(fill.price, fill.qty, 1)?;
        token::transfer(
            CpiContext::new(
                token_program_key,
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: maker_ai.clone(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_amt,
        )?;

        // Yes leg: the ask maker's escrowed Yes pays the taker.
        let yes_amt = pairs_to_usdc(fill.qty)?;
        escrow::transfer_escrow_out(
            token_program_key,
            &ctx.accounts.yes_escrow.to_account_info(),
            &ctx.accounts.user_yes.to_account_info(),
            &market_ai,
            signer_seeds,
            yes_amt,
        )?;

        emit!(Fill {
            market: market_key,
            maker_order_id: fill.maker_order_id,
            maker: fill.maker,
            taker: user_key,
            side_of_taker: Side::Bid as u8,
            price: fill.price,
            qty: fill.qty,
            ts: now,
        });
    }

    // Decrement/remove the filled ask makers. Descending `idx` order so an earlier
    // removal's left-shift never invalidates a later index (idx is strictly increasing
    // from `match_against`, since live orders are packed contiguously).
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let asks = asks_mut(&mut data, capacity)?;
        let mut new_ask_count = header.ask_count;
        for fill in plan.fills.iter().rev() {
            let order = &mut asks[fill.idx];
            order.remaining = order
                .remaining
                .checked_sub(fill.qty)
                .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
            if order.remaining == 0 {
                new_ask_count = remove_at(asks, new_ask_count, fill.idx);
            }
        }
        header.ask_count = new_ask_count;
        write_header(&mut data, &header);
    }

    // Redeem the filled pairs: burns `filled` Yes (just received above) and `filled`
    // No (the user's existing position) for `filled * 1_000_000` USDC from the vault.
    // If the user doesn't hold at least `filled` No, the `burn` CPI inside fails and
    // the whole instruction reverts.
    redeem_pair_core(
        &mut ctx.accounts.market,
        &mut ctx.accounts.yes_mint,
        &mut ctx.accounts.no_mint,
        &mut ctx.accounts.vault,
        &ctx.accounts.user,
        &ctx.accounts.user_usdc,
        &ctx.accounts.user_yes,
        &ctx.accounts.user_no,
        &ctx.accounts.token_program,
        filled,
    )?;

    // Escrow invariant: yes_escrow must still cover every remaining live ask.
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
pub struct SellNoMarket<'info> {
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
    // Remaining accounts: ask makers' USDC token accounts, in fill (book priority)
    // order -- one per fill.
}
