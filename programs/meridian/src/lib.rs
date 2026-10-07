use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia");

// Do not edit: instruction bodies live in instructions/<name>.rs. This file only wires
// each `#[program]` entry point to its handler and `Accounts` struct. Wave 2 scaffolded
// every instruction named in contracts/program-instructions.md; later waves replace a
// stub's `Err(NotImplemented)` body in its own file without touching this one. Every
// `Accounts` struct still carrying a `NotImplemented` stub body is provisional -- its
// implementing wave may need to add, remove, or re-constrain accounts, so nothing about
// a stub's current account list should be relied on outside its own instruction file.
#[program]
pub mod meridian {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        instructions::handle_initialize_config(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::handle_update_config(ctx, args)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        ticker: [u8; 8],
        strike: u64,
        trading_day: u32,
        close_ts: i64,
        capacity: u16,
    ) -> Result<()> {
        instructions::handle_create_market(ctx, ticker, strike, trading_day, close_ts, capacity)
    }

    pub fn add_strike(
        ctx: Context<CreateMarket>,
        ticker: [u8; 8],
        strike: u64,
        trading_day: u32,
        close_ts: i64,
        capacity: u16,
    ) -> Result<()> {
        instructions::handle_add_strike(ctx, ticker, strike, trading_day, close_ts, capacity)
    }

    /// Split out of `create_market`/`add_strike`: see create_book.rs's module doc
    /// comment. Call repeatedly (one call per transaction) until `market.book` is set.
    /// Takes no `capacity` argument; reads `market.book_capacity` instead.
    pub fn create_book(ctx: Context<CreateBook>) -> Result<()> {
        instructions::handle_create_book(ctx)
    }

    pub fn mint_pair(ctx: Context<MintPair>, qty: u64) -> Result<()> {
        instructions::handle_mint_pair(ctx, qty)
    }

    pub fn redeem_pair(ctx: Context<RedeemPair>, qty: u64) -> Result<()> {
        instructions::handle_redeem_pair(ctx, qty)
    }

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::handle_settle_market(ctx)
    }

    pub fn admin_settle_override(ctx: Context<AdminSettleOverride>, price: u64) -> Result<()> {
        instructions::handle_admin_settle_override(ctx, price)
    }

    pub fn redeem_winning(ctx: Context<RedeemWinning>, side: u8, qty: u64) -> Result<()> {
        instructions::handle_redeem_winning(ctx, side, qty)
    }

    pub fn pause(ctx: Context<SetPause>) -> Result<()> {
        instructions::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<SetPause>) -> Result<()> {
        instructions::handle_unpause(ctx)
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: u8,
        price: u64,
        qty: u64,
        tif: u8,
    ) -> Result<()> {
        instructions::handle_place_order(ctx, side, price, qty, tif)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        instructions::handle_cancel_order(ctx, order_id)
    }

    pub fn buy_no_market(ctx: Context<BuyNoMarket>, qty: u64, min_yes_price: u64) -> Result<()> {
        instructions::handle_buy_no_market(ctx, qty, min_yes_price)
    }

    pub fn buy_no_limit(ctx: Context<BuyNoLimit>, qty: u64, price: u64) -> Result<()> {
        instructions::handle_buy_no_limit(ctx, qty, price)
    }

    pub fn sell_no_market(ctx: Context<SellNoMarket>, qty: u64, max_yes_price: u64) -> Result<()> {
        instructions::handle_sell_no_market(ctx, qty, max_yes_price)
    }

    pub fn mock_write_price(
        ctx: Context<MockWritePrice>,
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Result<()> {
        instructions::handle_mock_write_price(ctx, feed_id, price, conf, expo, publish_time)
    }

    pub fn close_book(ctx: Context<CloseAccounts>) -> Result<()> {
        instructions::handle_close_book(ctx)
    }

    pub fn close_market(ctx: Context<CloseAccounts>) -> Result<()> {
        instructions::handle_close_market(ctx)
    }
}
