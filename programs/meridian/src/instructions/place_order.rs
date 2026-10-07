//! `place_order(side, price, qty, tif)` (Wave 4B, T054).
//!
//! `side`: `0` = Bid (buying Yes, escrowing USDC), `1` = Ask (selling Yes, escrowing
//! Yes). `tif`: `0` = Limit (unfilled remainder rests), `1` = ImmediateOrCancel
//! (unfilled remainder refunds). See `specs/001-binary-outcome-markets/data-model.md`
//! "Book" for the account layout and sort invariants, and this crate's Wave 4 brief for
//! the escrow/fill equations this function implements.
//!
//! Flow: guards -> compute the match plan against the opposite side (no funds moved,
//! nothing mutated yet) -> fail outright if fewer `remaining_accounts` were supplied
//! than planned fills -> (Limit only) BookFull check, but only when a non-zero
//! remainder would need to rest -> escrow the taker's full leg -> apply each fill
//! (maker leg, taker leg, bid-side price-improvement refund, order decrement/removal)
//! -> rest the remainder (Limit) or refund it (IOC) -> persist the header -> assert the
//! escrow invariants (`>=`, tolerating unsolicited deposits).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::book::escrow;
use crate::book::matching::{self, Side};
use crate::errors::MeridianError;
use crate::events::{Fill, OrderPlaced};
use crate::math::{checked_mul_div, pairs_to_usdc, PRICE_MAX};
use crate::state::book::{
    asks_mut, bids_mut, insert_sorted, read_header, remove_at, sum_ask_escrow, sum_bid_escrow,
    write_header, Order,
};
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

/// `tif` argument: `0` = Limit, `1` = ImmediateOrCancel.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tif {
    Limit,
    Ioc,
}

impl Tif {
    fn from_u8(v: u8) -> Result<Tif> {
        match v {
            0 => Ok(Tif::Limit),
            1 => Ok(Tif::Ioc),
            _ => {
                msg!("place_order: tif must be 0 (Limit) or 1 (ImmediateOrCancel)");
                Err(error!(MeridianError::InvariantViolated))
            }
        }
    }
}

/// Maximum number of fills matched in a single `place_order` call (R7).
const MAX_FILLS: usize = 8;

// Named lifetime (rather than `Context<PlaceOrder>`'s usual elision): the
// `remaining_accounts`/escrow `AccountInfo` references this function juggles across
// several `escrow::transfer_*` calls need `ctx.accounts`'s `'info` and `Context`'s own
// lifetime to be provably the *same* lifetime, which plain elision gives two anonymous
// (and thus unrelated) ones for.
pub fn handle_place_order<'info>(
    ctx: Context<'info, PlaceOrder<'info>>,
    side: u8,
    price: u64,
    qty: u64,
    tif: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(ctx.accounts.market.is_open(), MeridianError::MarketSettled);
    require!(price >= 1 && price <= PRICE_MAX, MeridianError::PriceOutOfRange);
    require!(qty > 0, MeridianError::ZeroQuantity);

    let side = Side::from_u8(side).ok_or_else(|| {
        msg!("place_order: side must be 0 (Bid) or 1 (Ask)");
        error!(MeridianError::InvariantViolated)
    })?;
    let tif = Tif::from_u8(tif)?;

    let book_ai = ctx.accounts.book.to_account_info();
    require_keys_eq!(book_ai.key(), ctx.accounts.market.book, MeridianError::InvariantViolated);
    require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();
    let now = Clock::get()?.unix_timestamp;

    // Market PDA signer seeds (data-model.md "Market": `["market", ticker,
    // trading_day_le, strike_le, bump]`), used for every escrow-out CPI below.
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

    let mut data = book_ai.try_borrow_mut_data()?;
    let mut header = read_header(&data)?;
    let capacity = header.capacity;

    // Compute the match plan *before* any funds move or any account is mutated:
    // escrowing the taker's leg and resting a remainder are both downstream decisions
    // that depend on what this plan says, not the other way around.
    let opposite_count = match side {
        Side::Bid => header.ask_count,
        Side::Ask => header.bid_count,
    };
    let plan = {
        let opposite_slice: &mut [Order] = match side {
            Side::Bid => asks_mut(&mut data, capacity)?,
            Side::Ask => bids_mut(&mut data, capacity)?,
        };
        matching::match_against(opposite_slice, opposite_count, side, price, qty, MAX_FILLS)
    };

    // Before any funds move or anything is mutated: a resting order belonging to this
    // same taker must never cross against their own `place_order` (Wave 5 review fix,
    // 2026-10-06).
    matching::reject_self_match(&plan, &user_key)?;

    // Fewer `remaining_accounts` than planned fills must FAIL the instruction outright
    // -- never silently drop fills and rest the leftover as a crossed order.
    if ctx.remaining_accounts.len() < plan.fills.len() {
        msg!("place_order: maker account missing for fill");
        return Err(error!(MeridianError::InvariantViolated));
    }
    let usable = plan.fills.len();
    let unfilled_qty = plan.remaining_qty;

    // BookFull applies only when a non-zero remainder must rest on the taker's own
    // side (Limit only) -- a Limit order that fully fills against a full opposite side
    // must succeed, and still no funds have moved yet at this point.
    if tif == Tif::Limit && unfilled_qty > 0 {
        let own_count = match side {
            Side::Bid => header.bid_count,
            Side::Ask => header.ask_count,
        };
        require!(own_count < capacity, MeridianError::BookFull);
    }

    // Now escrow the taker's full leg.
    match side {
        Side::Bid => {
            let amount = checked_mul_div(price, qty, 1)?;
            escrow::transfer_user_to_escrow(
                token_program_key,
                &ctx.accounts.user_usdc.to_account_info(),
                &ctx.accounts.usdc_escrow.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                amount,
            )?;
        }
        Side::Ask => {
            let amount = pairs_to_usdc(qty)?; // qty * 1_000_000 Yes base units
            escrow::transfer_user_to_escrow(
                token_program_key,
                &ctx.accounts.user_yes.to_account_info(),
                &ctx.accounts.yes_escrow.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                amount,
            )?;
        }
    }

    // Apply each usable fill's transfers and emit `Fill`. Validation failures here
    // abort the whole transaction (and roll back everything above), which is exactly
    // what "wrong maker account -> fails, nothing changes" requires.
    for i in 0..usable {
        let fill = &plan.fills[i];
        let maker_ai = &ctx.remaining_accounts[i];

        match side {
            Side::Bid => {
                escrow::validate_maker_account(maker_ai, &fill.maker, &ctx.accounts.config.usdc_mint)?;

                let yes_amt = pairs_to_usdc(fill.qty)?;
                escrow::transfer_escrow_out(
                    token_program_key,
                    &ctx.accounts.yes_escrow.to_account_info(),
                    &ctx.accounts.user_yes.to_account_info(),
                    &market_ai,
                    signer_seeds,
                    yes_amt,
                )?;

                let usdc_amt = checked_mul_div(fill.price, fill.qty, 1)?;
                escrow::transfer_escrow_out(
                    token_program_key,
                    &ctx.accounts.usdc_escrow.to_account_info(),
                    maker_ai,
                    &market_ai,
                    signer_seeds,
                    usdc_amt,
                )?;

                if price > fill.price {
                    let diff = price - fill.price;
                    let refund = checked_mul_div(diff, fill.qty, 1)?;
                    escrow::transfer_escrow_out(
                        token_program_key,
                        &ctx.accounts.usdc_escrow.to_account_info(),
                        &ctx.accounts.user_usdc.to_account_info(),
                        &market_ai,
                        signer_seeds,
                        refund,
                    )?;
                }
            }
            Side::Ask => {
                escrow::validate_maker_account(maker_ai, &fill.maker, &ctx.accounts.market.yes_mint)?;

                let usdc_amt = checked_mul_div(fill.price, fill.qty, 1)?;
                escrow::transfer_escrow_out(
                    token_program_key,
                    &ctx.accounts.usdc_escrow.to_account_info(),
                    &ctx.accounts.user_usdc.to_account_info(),
                    &market_ai,
                    signer_seeds,
                    usdc_amt,
                )?;

                let yes_amt = pairs_to_usdc(fill.qty)?;
                escrow::transfer_escrow_out(
                    token_program_key,
                    &ctx.accounts.yes_escrow.to_account_info(),
                    maker_ai,
                    &market_ai,
                    signer_seeds,
                    yes_amt,
                )?;
            }
        }

        emit!(Fill {
            market: market_key,
            maker_order_id: fill.maker_order_id,
            maker: fill.maker,
            taker: user_key,
            side_of_taker: side as u8,
            price: fill.price,
            qty: fill.qty,
            ts: now,
        });
    }

    // Mutate the opposite side: decrement/remove filled makers. Process in descending
    // `idx` order so an earlier removal's left-shift never invalidates an index this
    // loop hasn't processed yet (idx values from `match_against` are strictly
    // increasing, since live orders are packed contiguously).
    let mut new_opposite_count = opposite_count;
    {
        let opposite_slice: &mut [Order] = match side {
            Side::Bid => asks_mut(&mut data, capacity)?,
            Side::Ask => bids_mut(&mut data, capacity)?,
        };
        for i in (0..usable).rev() {
            let fill = &plan.fills[i];
            let order = &mut opposite_slice[fill.idx];
            order.remaining = order
                .remaining
                .checked_sub(fill.qty)
                .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
            if order.remaining == 0 {
                new_opposite_count = remove_at(opposite_slice, new_opposite_count, fill.idx);
            }
        }
    }
    match side {
        Side::Bid => header.ask_count = new_opposite_count,
        Side::Ask => header.bid_count = new_opposite_count,
    }

    // Assign the order id/seq unconditionally -- OrderPlaced fires even for a pure IOC
    // that fills entirely or finds nothing to match.
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

    if unfilled_qty > 0 {
        match tif {
            Tif::Limit => {
                let own_count = match side {
                    Side::Bid => header.bid_count,
                    Side::Ask => header.ask_count,
                };
                let own_slice: &mut [Order] = match side {
                    Side::Bid => bids_mut(&mut data, capacity)?,
                    Side::Ask => asks_mut(&mut data, capacity)?,
                };
                let order = Order {
                    id: order_id,
                    owner: user_key.to_bytes(),
                    price,
                    remaining: unfilled_qty,
                    seq,
                };
                let new_count = insert_sorted(own_slice, own_count, order, side == Side::Bid)?;
                match side {
                    Side::Bid => header.bid_count = new_count,
                    Side::Ask => header.ask_count = new_count,
                }
            }
            Tif::Ioc => match side {
                Side::Bid => {
                    let refund = checked_mul_div(price, unfilled_qty, 1)?;
                    escrow::transfer_escrow_out(
                        token_program_key,
                        &ctx.accounts.usdc_escrow.to_account_info(),
                        &ctx.accounts.user_usdc.to_account_info(),
                        &market_ai,
                        signer_seeds,
                        refund,
                    )?;
                }
                Side::Ask => {
                    let refund = pairs_to_usdc(unfilled_qty)?;
                    escrow::transfer_escrow_out(
                        token_program_key,
                        &ctx.accounts.yes_escrow.to_account_info(),
                        &ctx.accounts.user_yes.to_account_info(),
                        &market_ai,
                        signer_seeds,
                        refund,
                    )?;
                }
            },
        }
    }

    write_header(&mut data, &header);

    emit!(OrderPlaced {
        market: market_key,
        order_id,
        owner: user_key,
        side: side as u8,
        price,
        qty,
    });

    // Escrow invariants (data-model.md "Book"): reload both escrows (CPIs above
    // mutated their underlying account data without updating these in-memory
    // `Account<TokenAccount>`s) and recompute the expected totals from the book's own
    // live orders. `>=`, not `==`: an unsolicited deposit straight into an escrow
    // token account must not break every subsequent `place_order`/`cancel_order` --
    // refunds and fills still only ever pay out the exact contractual amounts, so any
    // surplus just sits there, never distributed.
    let bids_count = header.bid_count;
    let asks_count = header.ask_count;
    let expected_usdc = sum_bid_escrow(bids_mut(&mut data, capacity)?, bids_count)?;
    let expected_yes = sum_ask_escrow(asks_mut(&mut data, capacity)?, asks_count)?;
    drop(data);

    ctx.accounts.usdc_escrow.reload()?;
    ctx.accounts.yes_escrow.reload()?;
    require!(ctx.accounts.usdc_escrow.amount >= expected_usdc, MeridianError::InvariantViolated);
    require!(ctx.accounts.yes_escrow.amount >= expected_yes, MeridianError::InvariantViolated);

    Ok(())
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
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

    /// CHECK: raw program-owned Book account for `market`; address/owner/discriminator
    /// validated in the handler (`read_header`, plus the explicit checks at the top of
    /// `handle_place_order`).
    #[account(mut, address = market.book @ MeridianError::InvariantViolated)]
    pub book: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"escrow_usdc", market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [b"escrow_yes", market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    /// Anchor's `init_if_needed`/`associated_token::mint` constraint needs an account
    /// field, not a raw `Pubkey` (`market.yes_mint` alone won't do) -- this is the same
    /// `yes_mint` account `mint_pair.rs`'s `MintPair` struct carries, just re-validated
    /// here against `market.yes_mint`.
    #[account(address = market.yes_mint @ MeridianError::InvariantViolated)]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: makers' receiving token accounts, in fill (book priority)
    // order -- one per fill, bounded by however many are supplied (see this file's
    // module doc comment).
}
