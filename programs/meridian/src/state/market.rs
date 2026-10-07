//! Market account (Wave 1B).
//!
//! PDA `["market", ticker_symbol, trading_day_le_u32, strike_le_u64]`. See
//! `specs/001-binary-outcome-markets/data-model.md` "Market".

use anchor_lang::prelude::*;

/// Seed prefix for the Market PDA. Full seed order is
/// `[SEED, ticker, trading_day.to_le_bytes(), strike.to_le_bytes()]`.
pub const SEED: &[u8] = b"market";

/// Lifecycle state of a market. `Open -> Settled` is the only transition.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
#[borsh(use_discriminant = true)]
pub enum MarketState {
    Open = 0,
    Settled = 1,
}

/// Settlement outcome. `Unset` until settlement; immutable once set (FR-036).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
#[borsh(use_discriminant = true)]
pub enum Outcome {
    Unset = 0,
    Yes = 1,
    No = 2,
}

/// A single binary outcome market: one ticker, one strike, one trading day.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Ticker symbol, ASCII, NUL-padded.
    pub ticker: [u8; 8],
    /// Strike price, micro-USD.
    pub strike: u64,
    /// Trading day as `YYYYMMDD`.
    pub trading_day: u32,
    /// 16:00:00 ET of `trading_day`, computed off chain (R9).
    pub close_ts: i64,
    /// Open or Settled.
    pub state: MarketState,
    /// Unset, Yes, or No. Immutable once set (FR-036).
    pub outcome: Outcome,
    /// Settlement price, micro-USD; 0 until settled.
    pub settlement_price: u64,
    /// Unix timestamp of settlement; 0 until settled.
    pub settled_at: i64,
    /// Whether settlement came from `admin_settle_override` (FR-033).
    pub settled_by_override: bool,
    /// Yes SPL mint, 6 decimals, authority = market PDA.
    pub yes_mint: Pubkey,
    /// No SPL mint, 6 decimals, authority = market PDA.
    pub no_mint: Pubkey,
    /// USDC token account owned by the market PDA.
    pub vault: Pubkey,
    /// This market's Book account.
    pub book: Pubkey,
    /// Per-side capacity `create_book` builds `book` at. Set from `create_market`'s/
    /// `add_strike`'s `capacity` arg; `create_book` reads this instead of taking its own
    /// `capacity` argument, so a stray mismatched call can't start a second, differently
    /// sized book for the same market (Wave 2 review fix, 2026-10-06).
    pub book_capacity: u16,
    /// Tokens minted via `mint_pair` net of `redeem_pair`. While `Open`,
    /// `vault.amount == pairs_outstanding * 1_000_000`. Frozen and informational
    /// after settlement.
    pub pairs_outstanding: u64,
    /// PDA bump for the Market account.
    pub bump: u8,
    /// PDA bump for the vault token account.
    pub vault_bump: u8,
}

impl Market {
    /// Builds the seeds for the Market PDA in the documented order:
    /// `["market", ticker, trading_day_le, strike_le]`.
    pub fn seeds(ticker: &[u8; 8], trading_day: u32, strike: u64) -> [Vec<u8>; 4] {
        [
            SEED.to_vec(),
            ticker.to_vec(),
            trading_day.to_le_bytes().to_vec(),
            strike.to_le_bytes().to_vec(),
        ]
    }

    /// Whether the market still accepts mint, place_order, buy_no_*, sell_no_market.
    pub fn is_open(&self) -> bool {
        self.state == MarketState::Open
    }

    /// Whether the market has settled (redeem_pair/redeem_winning/cancel_order allowed).
    pub fn is_settled(&self) -> bool {
        self.state == MarketState::Settled
    }

    /// At-or-above resolution: `price >= strike` resolves Yes, otherwise No (FR-018).
    pub fn resolve(&self, price: u64) -> Outcome {
        if price >= self.strike {
            Outcome::Yes
        } else {
            Outcome::No
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market_with_strike(strike: u64) -> Market {
        Market {
            ticker: *b"AAPL\0\0\0\0",
            strike,
            trading_day: 20261006,
            close_ts: 0,
            state: MarketState::Open,
            outcome: Outcome::Unset,
            settlement_price: 0,
            settled_at: 0,
            settled_by_override: false,
            yes_mint: Pubkey::default(),
            no_mint: Pubkey::default(),
            vault: Pubkey::default(),
            book: Pubkey::default(),
            book_capacity: 16,
            pairs_outstanding: 0,
            bump: 0,
            vault_bump: 0,
        }
    }

    #[test]
    fn resolve_above_strike_is_yes() {
        let m = market_with_strike(100_000_000);
        assert_eq!(m.resolve(100_000_001), Outcome::Yes);
    }

    #[test]
    fn resolve_equal_strike_is_yes() {
        let m = market_with_strike(100_000_000);
        assert_eq!(m.resolve(100_000_000), Outcome::Yes);
    }

    #[test]
    fn resolve_below_strike_is_no() {
        let m = market_with_strike(100_000_000);
        assert_eq!(m.resolve(99_999_999), Outcome::No);
    }

    #[test]
    fn is_open_and_is_settled_match_state() {
        let mut m = market_with_strike(1);
        assert!(m.is_open());
        assert!(!m.is_settled());
        m.state = MarketState::Settled;
        assert!(!m.is_open());
        assert!(m.is_settled());
    }

    #[test]
    fn seeds_are_in_documented_order() {
        let ticker = *b"AAPL\0\0\0\0";
        let trading_day: u32 = 20261006;
        let strike: u64 = 100_000_000;
        let seeds = Market::seeds(&ticker, trading_day, strike);
        assert_eq!(seeds[0], SEED.to_vec());
        assert_eq!(seeds[1], ticker.to_vec());
        assert_eq!(seeds[2], trading_day.to_le_bytes().to_vec());
        assert_eq!(seeds[3], strike.to_le_bytes().to_vec());
    }
}
