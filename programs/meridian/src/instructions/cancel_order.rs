//! `cancel_order(order_id)` (Wave 4B, T055).
//!
//! Allowed in any market state and regardless of `config.paused` (cancellation only
//! returns escrowed funds, it never takes new ones). Searches both sides for the order
//! id, checks ownership, refunds the exact remaining escrow, removes the order, and
//! re-asserts the escrow invariants.

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::book::escrow;
use crate::errors::MeridianError;
use crate::events::OrderCancelled;
use crate::math::{checked_mul_div, pairs_to_usdc};
use crate::state::book::{
    asks_mut, bids_mut, find_order, read_header, remove_at, sum_ask_escrow, sum_bid_escrow,
    write_header,
};
use crate::state::market::{Market, SEED as MARKET_SEED};

pub fn handle_cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
    let book_ai = ctx.accounts.book.to_account_info();
    require_keys_eq!(book_ai.key(), ctx.accounts.market.book, MeridianError::InvariantViolated);
    require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);

    let market_key = ctx.accounts.market.key();
    let owner_key = ctx.accounts.owner.key();

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

    // Find the order on either side.
    let found_on_bids = {
        let slice = bids_mut(&mut data, capacity)?;
        find_order(slice, header.bid_count, order_id)
    };
    let (is_bid, idx) = match found_on_bids {
        Some(idx) => (true, idx),
        None => {
            let slice = asks_mut(&mut data, capacity)?;
            match find_order(slice, header.ask_count, order_id) {
                Some(idx) => (false, idx),
                None => {
                    msg!("cancel_order: order id not found on either side");
                    return Err(error!(MeridianError::InvariantViolated));
                }
            }
        }
    };

    let (order_owner, price, remaining) = if is_bid {
        let slice = bids_mut(&mut data, capacity)?;
        let order = slice[idx];
        (Pubkey::new_from_array(order.owner), order.price, order.remaining)
    } else {
        let slice = asks_mut(&mut data, capacity)?;
        let order = slice[idx];
        (Pubkey::new_from_array(order.owner), order.price, order.remaining)
    };

    require_keys_eq!(order_owner, owner_key, MeridianError::Unauthorized);

    // Remove the order and update counts before issuing the refund, so the header
    // persisted below and the escrow invariant check at the end both reflect the
    // post-cancel book regardless of what happens next.
    if is_bid {
        let slice = bids_mut(&mut data, capacity)?;
        header.bid_count = remove_at(slice, header.bid_count, idx);
    } else {
        let slice = asks_mut(&mut data, capacity)?;
        header.ask_count = remove_at(slice, header.ask_count, idx);
    }
    write_header(&mut data, &header);

    let bids_count = header.bid_count;
    let asks_count = header.ask_count;
    let expected_usdc = sum_bid_escrow(bids_mut(&mut data, capacity)?, bids_count)?;
    let expected_yes = sum_ask_escrow(asks_mut(&mut data, capacity)?, asks_count)?;
    drop(data);

    // Refund the exact remaining escrow.
    let refunded = if is_bid {
        let amount = checked_mul_div(price, remaining, 1)?;
        escrow::transfer_escrow_out(
            token_program_key,
            &ctx.accounts.usdc_escrow.to_account_info(),
            &ctx.accounts.user_usdc.to_account_info(),
            &market_ai,
            signer_seeds,
            amount,
        )?;
        amount
    } else {
        let amount = pairs_to_usdc(remaining)?;
        escrow::transfer_escrow_out(
            token_program_key,
            &ctx.accounts.yes_escrow.to_account_info(),
            &ctx.accounts.user_yes.to_account_info(),
            &market_ai,
            signer_seeds,
            amount,
        )?;
        amount
    };

    emit!(OrderCancelled {
        market: market_key,
        order_id,
        owner: owner_key,
        remaining_refunded: refunded,
    });

    ctx.accounts.usdc_escrow.reload()?;
    ctx.accounts.yes_escrow.reload()?;
    // `>=`, not `==`: see place_order.rs's matching comment -- an unsolicited deposit
    // into an escrow token account must not break cancellation either.
    require!(ctx.accounts.usdc_escrow.amount >= expected_usdc, MeridianError::InvariantViolated);
    require!(ctx.accounts.yes_escrow.amount >= expected_yes, MeridianError::InvariantViolated);

    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub owner: Signer<'info>,

    #[account(
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
    /// validated in the handler.
    #[account(mut, address = market.book @ MeridianError::InvariantViolated)]
    pub book: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"escrow_usdc", market.key().as_ref()], bump)]
    pub usdc_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [b"escrow_yes", market.key().as_ref()], bump)]
    pub yes_escrow: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
