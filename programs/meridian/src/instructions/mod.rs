//! Instruction handlers (Wave 2 scaffold).
//!
//! `initialize_config`/`update_config` (config.rs) and `create_market`/`add_strike`
//! (create_market.rs) are implemented for real. Every other instruction here is a
//! minimal stub returning `MeridianError::NotImplemented`, wired into `lib.rs` so later
//! waves only ever edit their own file in this directory.

pub mod admin_settle_override;
pub mod buy_no_limit;
pub mod buy_no_market;
pub mod cancel_order;
pub mod close;
pub mod config;
pub mod create_book;
pub mod create_market;
pub mod mint_pair;
pub mod mock_write_price;
pub mod pause;
pub mod place_order;
pub mod redeem_pair;
pub mod redeem_winning;
pub mod sell_no_market;
pub mod settle_market;

pub use admin_settle_override::*;
pub use buy_no_limit::*;
pub use buy_no_market::*;
pub use cancel_order::*;
pub use close::*;
pub use config::*;
pub use create_book::*;
pub use create_market::*;
pub use mint_pair::*;
pub use mock_write_price::*;
pub use pause::*;
pub use place_order::*;
pub use redeem_pair::*;
pub use redeem_winning::*;
pub use sell_no_market::*;
pub use settle_market::*;
