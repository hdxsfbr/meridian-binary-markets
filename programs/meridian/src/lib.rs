use anchor_lang::prelude::*;

pub mod book;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn");

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

    // Named lifetime (unlike every other entry point above): `place_order` is the only
    // instruction that reads `ctx.remaining_accounts` alongside its typed `ctx.accounts`
    // fields in the same CPI, which needs the compiler to know both carry the *same*
    // `'info` rather than two independently-elided ones. See
    // `instructions/place_order.rs`'s `handle_place_order` doc comment.
    pub fn place_order<'info>(
        ctx: Context<'info, PlaceOrder<'info>>,
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

    // Named lifetime (same reason as `place_order` above): `buy_no_market` reads
    // `ctx.remaining_accounts` (bid makers' Yes token accounts) alongside its typed
    // `ctx.accounts` fields in the same CPIs. See `instructions/buy_no_market.rs`'s
    // `handle_buy_no_market` doc comment.
    pub fn buy_no_market<'info>(
        ctx: Context<'info, BuyNoMarket<'info>>,
        qty: u64,
        min_yes_price: u64,
    ) -> Result<()> {
        instructions::handle_buy_no_market(ctx, qty, min_yes_price)
    }

    pub fn buy_no_limit(ctx: Context<BuyNoLimit>, qty: u64, price: u64) -> Result<()> {
        instructions::handle_buy_no_limit(ctx, qty, price)
    }

    // Named lifetime (same reason as `buy_no_market` above): `sell_no_market` reads
    // `ctx.remaining_accounts` (ask makers' USDC token accounts) alongside its typed
    // `ctx.accounts` fields in the same CPIs. See `instructions/sell_no_market.rs`'s
    // `handle_sell_no_market` doc comment.
    pub fn sell_no_market<'info>(
        ctx: Context<'info, SellNoMarket<'info>>,
        qty: u64,
        max_yes_price: u64,
    ) -> Result<()> {
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

    /// Permissionless cleanup for a Yes/No Token-2022 mint `close_market` could not
    /// close because it still had outstanding supply (see `reclaim_mint.rs`'s module
    /// doc comment). `side` is `1` for Yes, `2` for No, matching `redeem_winning`'s
    /// convention.
    pub fn reclaim_mint(ctx: Context<ReclaimMint>, ticker: [u8; 8], trading_day: u32, strike: u64, side: u8) -> Result<()> {
        instructions::handle_reclaim_mint(ctx, ticker, trading_day, strike, side)
    }
}
