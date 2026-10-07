//! Config account (Wave 1B).
//!
//! Singleton PDA `["config"]`. See `specs/001-binary-outcome-markets/data-model.md` "Config".

use anchor_lang::prelude::*;

use crate::errors::MeridianError;

/// Seed prefix for the Config PDA: `["config"]`.
pub const SEED: &[u8] = b"config";

/// Minimum override delay enforced in code regardless of config (FR-033).
pub const MIN_OVERRIDE_DELAY_SECS: u32 = 3600;

/// Maximum allowed staleness window for oracle prices (R4/R5, 5 minutes).
pub const MAX_STALENESS_SECS: u32 = 300;

/// Maximum number of mock publishers in the allowlist.
pub const MAX_PUBLISHERS: usize = 4;

/// Number of tickers tracked by the config (the demo ladder, R4).
pub const TICKER_COUNT: usize = 7;

/// Which oracle backend `settle_market` parses (DECISIONS §4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
#[borsh(use_discriminant = true)]
pub enum OracleProvider {
    MockPyth = 0,
    PythReceiver = 1,
}

/// A single ticker's identity and Pyth feed binding.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, InitSpace, Debug)]
pub struct TickerInfo {
    /// Ticker symbol, ASCII, NUL-padded (e.g. `AAPL\0\0\0\0`).
    pub symbol: [u8; 8],
    /// Pyth `Equity.US.<SYM>/USD` feed id (R4).
    pub feed_id: [u8; 32],
    /// Whether `create_market`/`add_strike` may use this ticker.
    pub enabled: bool,
}

/// Program-wide configuration singleton.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Operator authority for admin instructions.
    pub admin: Pubkey,
    /// FR-034: blocks mint and order placement, never redemption.
    pub paused: bool,
    /// Collateral mint (Circle devnet USDC by default, R6).
    pub usdc_mint: Pubkey,
    /// Selects the parser in `settle_market` (DECISIONS §4).
    pub oracle_provider: OracleProvider,
    /// Owner required of the price account: this program (mock) or the Pyth receiver.
    pub oracle_program: Pubkey,
    /// Allowlist of mock publisher signers (Principle IV).
    pub publishers: [Pubkey; MAX_PUBLISHERS],
    /// Number of valid entries in `publishers`.
    pub publishers_len: u8,
    /// Maximum age, in seconds, of an oracle price used for settlement.
    pub max_staleness_secs: u32,
    /// Confidence guard: `conf * 10_000 <= price * max_conf_bps`.
    pub max_conf_bps: u16,
    /// Minimum `publish_time` offset from `close_ts` required to settle.
    pub min_publish_offset_secs: u32,
    /// Minimum delay (seconds) after `close_ts` before admin override is allowed.
    pub override_delay_secs: u32,
    /// The seven tracked tickers and their feed bindings.
    pub tickers: [TickerInfo; TICKER_COUNT],
    /// Default order book capacity (per side) for newly created markets.
    pub default_book_capacity: u16,
    /// PDA bump.
    pub bump: u8,
}

impl Config {
    /// Validates every config invariant. Returns `InvariantViolated` with a `msg!`
    /// describing which rule failed; all rules share one error variant by design.
    pub fn validate(&self, program_id: &Pubkey) -> Result<()> {
        if self.override_delay_secs < MIN_OVERRIDE_DELAY_SECS {
            msg!("Config.validate: override_delay_secs below MIN_OVERRIDE_DELAY_SECS");
            return Err(MeridianError::InvariantViolated.into());
        }

        if self.max_staleness_secs == 0 || self.max_staleness_secs > MAX_STALENESS_SECS {
            msg!("Config.validate: max_staleness_secs out of range (0, MAX_STALENESS_SECS]");
            return Err(MeridianError::InvariantViolated.into());
        }

        if self.max_conf_bps == 0 {
            msg!("Config.validate: max_conf_bps must be greater than zero");
            return Err(MeridianError::InvariantViolated.into());
        }

        if self.default_book_capacity == 0 {
            msg!("Config.validate: default_book_capacity must be greater than zero");
            return Err(MeridianError::InvariantViolated.into());
        }

        if self.publishers_len as usize > MAX_PUBLISHERS {
            msg!("Config.validate: publishers_len exceeds MAX_PUBLISHERS");
            return Err(MeridianError::InvariantViolated.into());
        }

        if self.oracle_provider == OracleProvider::MockPyth {
            if self.publishers_len < 1 {
                msg!("Config.validate: MockPyth requires at least one publisher");
                return Err(MeridianError::InvariantViolated.into());
            }
            if self.oracle_program != *program_id {
                msg!("Config.validate: MockPyth requires oracle_program == program_id");
                return Err(MeridianError::InvariantViolated.into());
            }
        }

        Ok(())
    }

    /// Whether `key` is in the publisher allowlist (only the first `publishers_len` slots count).
    pub fn is_publisher(&self, key: &Pubkey) -> bool {
        let len = self.publishers_len as usize;
        self.publishers
            .iter()
            .take(len.min(MAX_PUBLISHERS))
            .any(|p| p == key)
    }

    /// Looks up an *enabled* ticker by symbol. Disabled tickers are treated as absent.
    pub fn ticker(&self, symbol: &[u8; 8]) -> Option<&TickerInfo> {
        self.tickers
            .iter()
            .find(|t| t.enabled && &t.symbol == symbol)
    }

    /// The override delay actually enforced: at least `MIN_OVERRIDE_DELAY_SECS` regardless
    /// of what is configured (FR-033).
    pub fn effective_override_delay(&self) -> u32 {
        self.override_delay_secs.max(MIN_OVERRIDE_DELAY_SECS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(s: &str) -> [u8; 8] {
        let mut out = [0u8; 8];
        out[..s.len()].copy_from_slice(s.as_bytes());
        out
    }

    fn base_config(program_id: Pubkey) -> Config {
        let mut publishers = [Pubkey::default(); MAX_PUBLISHERS];
        publishers[0] = Pubkey::new_unique();

        Config {
            admin: Pubkey::new_unique(),
            paused: false,
            usdc_mint: Pubkey::new_unique(),
            oracle_provider: OracleProvider::MockPyth,
            oracle_program: program_id,
            publishers,
            publishers_len: 1,
            max_staleness_secs: 300,
            max_conf_bps: 25,
            min_publish_offset_secs: 60,
            override_delay_secs: 3600,
            tickers: [TickerInfo {
                symbol: symbol("AAPL"),
                feed_id: [0u8; 32],
                enabled: true,
            }; TICKER_COUNT],
            default_book_capacity: 16,
            bump: 0,
        }
    }

    #[test]
    fn validate_accepts_minimal_valid_config() {
        let program_id = Pubkey::new_unique();
        let cfg = base_config(program_id);
        assert!(cfg.validate(&program_id).is_ok());
    }

    #[test]
    fn validate_rejects_override_delay_below_minimum() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.override_delay_secs = MIN_OVERRIDE_DELAY_SECS - 1;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_zero_max_staleness() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.max_staleness_secs = 0;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_max_staleness_above_cap() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.max_staleness_secs = MAX_STALENESS_SECS + 1;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_zero_max_conf_bps() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.max_conf_bps = 0;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_mock_pyth_with_no_publishers() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.publishers_len = 0;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_mock_pyth_with_wrong_oracle_program() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.oracle_program = Pubkey::new_unique();
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_allows_pyth_receiver_without_publishers() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.oracle_provider = OracleProvider::PythReceiver;
        cfg.publishers_len = 0;
        cfg.oracle_program = Pubkey::new_unique();
        assert!(cfg.validate(&program_id).is_ok());
    }

    #[test]
    fn validate_rejects_zero_default_book_capacity() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.default_book_capacity = 0;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn validate_rejects_publishers_len_above_max() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.publishers_len = MAX_PUBLISHERS as u8 + 1;
        assert!(cfg.validate(&program_id).is_err());
    }

    #[test]
    fn is_publisher_true_for_allowlisted_key() {
        let program_id = Pubkey::new_unique();
        let cfg = base_config(program_id);
        assert!(cfg.is_publisher(&cfg.publishers[0]));
    }

    #[test]
    fn is_publisher_false_for_unknown_key() {
        let program_id = Pubkey::new_unique();
        let cfg = base_config(program_id);
        assert!(!cfg.is_publisher(&Pubkey::new_unique()));
    }

    #[test]
    fn is_publisher_ignores_slots_past_publishers_len() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        // Slot 1 holds a real pubkey but publishers_len says only slot 0 counts.
        cfg.publishers[1] = Pubkey::new_unique();
        assert!(!cfg.is_publisher(&cfg.publishers[1]));
    }

    #[test]
    fn ticker_returns_enabled_match() {
        let program_id = Pubkey::new_unique();
        let cfg = base_config(program_id);
        let sym = symbol("AAPL");
        assert!(cfg.ticker(&sym).is_some());
    }

    #[test]
    fn ticker_returns_none_when_disabled() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        for t in cfg.tickers.iter_mut() {
            t.enabled = false;
        }
        let sym = symbol("AAPL");
        assert!(cfg.ticker(&sym).is_none());
    }

    #[test]
    fn ticker_returns_none_when_symbol_not_found() {
        let program_id = Pubkey::new_unique();
        let cfg = base_config(program_id);
        let sym = symbol("ZZZZ");
        assert!(cfg.ticker(&sym).is_none());
    }

    #[test]
    fn effective_override_delay_floors_at_minimum() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.override_delay_secs = 0;
        // validate() would reject this, but effective_override_delay() is a pure
        // defense-in-depth floor independent of validate() having run.
        assert_eq!(cfg.effective_override_delay(), MIN_OVERRIDE_DELAY_SECS);
    }

    #[test]
    fn effective_override_delay_passes_through_larger_values() {
        let program_id = Pubkey::new_unique();
        let mut cfg = base_config(program_id);
        cfg.override_delay_secs = 7200;
        assert_eq!(cfg.effective_override_delay(), 7200);
    }
}
