//! `buy_no_market(qty, min_yes_price)` (Wave 5, T056).
//!
//! Buy No (market) = mint `qty` pairs, sell the Yes leg IOC into resting bids at or
//! above `min_yes_price`, then redeem whatever didn't fill back to USDC in the same
//! instruction -- so the user ends holding only No, in one approval (FR-013; see
//! `specs/001-binary-outcome-markets/research.md` R8). `InsufficientFill` fires before
//! anything moves if the IOC leg would fill zero.
//!
//! Flow: guards -> compute the match plan against resting bids (no funds moved yet) ->
//! `InsufficientFill` if the plan is empty, or missing `remaining_accounts` for the
//! planned fills -> mint `qty` pairs (reusing `mint_pair_core`) -> for each fill,
//! transfer the Yes leg user -> maker directly and pay the taker out of `usdc_escrow`
//! (the bid maker's escrowed USDC) -> decrement/remove the filled bid makers -> redeem
//! the unfilled remainder (reusing `redeem_pair_core`) -> assert the vault/escrow
//! invariants.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::book::escrow;
use crate::book::matching::{self, Side};
use crate::errors::MeridianError;
use crate::events::Fill;
use crate::instructions::mint_pair::mint_pair_core;
use crate::instructions::redeem_pair::redeem_pair_core;
use crate::math::{checked_mul_div, pairs_to_usdc, PRICE_MAX};
use crate::state::book::{bids_mut, read_header, remove_at, sum_bid_escrow, write_header};
use crate::state::config::Config;
use crate::state::market::{Market, SEED as MARKET_SEED};

/// Maximum number of fills matched in a single `buy_no_market` call (R7, same cap as
/// `place_order`).
const MAX_FILLS: usize = 8;

// Named lifetime (see `place_order.rs`'s `handle_place_order` doc comment): this
// handler reads `ctx.remaining_accounts` alongside `ctx.accounts` in the same CPIs
// (the Yes-transfer-to-maker loop below), which needs the compiler to know both carry
// the *same* `'info` rather than two independently elided ones.
pub fn handle_buy_no_market<'info>(
    ctx: Context<'info, BuyNoMarket<'info>>,
    qty: u64,
    min_yes_price: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, MeridianError::Paused);
    require!(ctx.accounts.market.is_open(), MeridianError::MarketSettled);
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.market.close_ts,
        MeridianError::MarketClosed
    );
    require!(qty > 0, MeridianError::ZeroQuantity);
    require!(
        min_yes_price >= 1 && min_yes_price <= PRICE_MAX,
        MeridianError::PriceOutOfRange
    );

    let book_ai = ctx.accounts.book.to_account_info();
    require_keys_eq!(book_ai.key(), ctx.accounts.market.book, MeridianError::InvariantViolated);
    require!(book_ai.owner == &crate::ID, MeridianError::InvariantViolated);

    let market_key = ctx.accounts.market.key();
    let user_key = ctx.accounts.user.key();
    let now = Clock::get()?.unix_timestamp;

    // Compute the match plan against resting bids first; nothing moves if it comes
    // back empty (taker side here is Ask: selling the Yes leg into the bids).
    let (mut header, capacity, plan) = {
        let mut data = book_ai.try_borrow_mut_data()?;
        let header = read_header(&data)?;
        let capacity = header.capacity;
        let bid_count = header.bid_count;
        let plan = {
            let bids = bids_mut(&mut data, capacity)?;
            matching::match_against(bids, bid_count, Side::Ask, min_yes_price, qty, MAX_FILLS)
        };
        (header, capacity, plan)
    };

    require!(!plan.fills.is_empty(), MeridianError::InsufficientFill);
    // Before anything moves (no minting yet): a resting bid belonging to this same
    // taker must never cross against their own `buy_no_market` (Wave 5 review fix,
    // 2026-10-06).
    matching::reject_self_match(&plan, &user_key)?;
    require!(
        ctx.remaining_accounts.len() >= plan.fills.len(),
        MeridianError::InvariantViolated
    );

    let unfilled = plan.remaining_qty;

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

    // Market PDA signer seeds, for paying bid makers out of `usdc_escrow`.
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
    let yes_mint_key = ctx.accounts.yes_mint.key();

    for (i, fill) in plan.fills.iter().enumerate() {
        let maker_ai = &ctx.remaining_accounts[i];
        escrow::validate_maker_account(maker_ai, &fill.maker, &yes_mint_key)?;

        // Yes leg: the user's own freshly minted Yes, straight to the maker (not
        // escrowed -- this is an immediate IOC fill, not a resting order).
        let yes_amt = pairs_to_usdc(fill.qty)?;
        token::transfer(
            CpiContext::new(
                token_program_key,
                Transfer {
                    from: ctx.accounts.user_yes.to_account_info(),
                    to: maker_ai.clone(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            yes_amt,
        )?;

        // USDC leg: the bid maker's escrowed USDC pays the taker.
        let usdc_amt = checked_mul_div(fill.price, fill.qty, 1)?;
        escrow::transfer_escrow_out(
            token_program_key,
            &ctx.accounts.usdc_escrow.to_account_info(),
            &ctx.accounts.user_usdc.to_account_info(),
            &market_ai,
            signer_seeds,
            usdc_amt,
        )?;

        emit!(Fill {
            market: market_key,
            maker_order_id: fill.maker_order_id,
            maker: fill.maker,
            taker: user_key,
            side_of_taker: Side::Ask as u8,
            price: fill.price,
            qty: fill.qty,
            ts: now,
        });
    }

    // Decrement/remove the filled bid makers. Descending `idx` order so an earlier
    // removal's left-shift never invalidates a later index (idx is strictly increasing
    // from `match_against`, since live orders are packed contiguously).
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let bids = bids_mut(&mut data, capacity)?;
        let mut new_bid_count = header.bid_count;
        for fill in plan.fills.iter().rev() {
            let order = &mut bids[fill.idx];
            order.remaining = order
                .remaining
                .checked_sub(fill.qty)
                .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
            if order.remaining == 0 {
                new_bid_count = remove_at(bids, new_bid_count, fill.idx);
            }
        }
        header.bid_count = new_bid_count;
        write_header(&mut data, &header);
    }

    // Redeem the unfilled pairs back to USDC in the same instruction, so the user ends
    // holding only No. Emits `PairRedeemed` when there is anything to redeem.
    if unfilled > 0 {
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
            unfilled,
        )?;
    }

    // Escrow invariant: `usdc_escrow` must still cover every remaining live bid.
    {
        let mut data = book_ai.try_borrow_mut_data()?;
        let bids = bids_mut(&mut data, capacity)?;
        let expected_usdc = sum_bid_escrow(bids, header.bid_count)?;
        drop(data);
        ctx.accounts.usdc_escrow.reload()?;
        require!(
            ctx.accounts.usdc_escrow.amount >= expected_usdc,
            MeridianError::InvariantViolated
        );
    }

    Ok(())
}

#[derive(Accounts)]
pub struct BuyNoMarket<'info> {
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
    // Remaining accounts: bid makers' Yes token accounts, in fill (book priority)
    // order -- one per fill.
}
