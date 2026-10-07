//! Program events for the meridian program.
//!
//! Exact event set and fields from
//! `specs/001-binary-outcome-markets/data-model.md` "Events".

use anchor_lang::prelude::*;

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub ticker: [u8; 8],
    pub strike: u64,
    pub trading_day: u32,
    pub close_ts: i64,
}

#[event]
pub struct Minted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub qty: u64,
}

#[event]
pub struct PairRedeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub qty: u64,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: u8,
    pub price: u64,
    pub qty: u64,
}

#[event]
pub struct OrderCancelled {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
    pub remaining_refunded: u64,
}

#[event]
pub struct Fill {
    pub market: Pubkey,
    pub maker_order_id: u64,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub side_of_taker: u8,
    pub price: u64,
    pub qty: u64,
    pub ts: i64,
}

#[event]
pub struct Settled {
    pub market: Pubkey,
    pub price: u64,
    pub outcome: u8,
    pub by_override: bool,
    pub ts: i64,
}

#[event]
pub struct WinningRedeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub qty: u64,
    pub payout: u64,
}

#[event]
pub struct Paused {
    pub admin: Pubkey,
    pub ts: i64,
}

#[event]
pub struct Unpaused {
    pub admin: Pubkey,
    pub ts: i64,
}
