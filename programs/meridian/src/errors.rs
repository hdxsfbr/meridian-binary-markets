//! Error codes for the meridian program.
//!
//! Exact variant set from `specs/001-binary-outcome-markets/contracts/program-instructions.md`
//! "Error codes" plus `NotImplemented`, reserved for Wave 2 instruction stubs.

use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Trading is paused")]
    Paused,
    #[msg("Market is already settled")]
    MarketSettled,
    #[msg("Market is not settled yet")]
    MarketNotSettled,
    #[msg("Action is not allowed before close_ts")]
    BeforeClose,
    #[msg("Market has already been settled")]
    AlreadySettled,
    #[msg("Override is not allowed until the override delay has elapsed")]
    OverrideTooEarly,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Publisher is not in the configured allowlist")]
    PublisherNotAllowed,
    #[msg("Oracle account owner does not match the expected program")]
    OracleOwnerMismatch,
    #[msg("Oracle account feed id does not match the ticker's feed id")]
    OracleFeedMismatch,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle price publish time is too old for this market")]
    OracleTooOld,
    #[msg("Oracle confidence interval is too wide")]
    OracleLowConfidence,
    #[msg("Oracle price is not a valid positive price")]
    OracleBadPrice,
    #[msg("Oracle update does not meet the required verification level")]
    OracleVerificationLevel,
    #[msg("Order book side is full")]
    BookFull,
    #[msg("Price is out of the valid 1..=999_999 range")]
    PriceOutOfRange,
    #[msg("Quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Side does not match the settled outcome")]
    WrongSide,
    #[msg("Immediate-or-cancel order could not meet the minimum fill")]
    InsufficientFill,
    #[msg("Account must be empty for this action")]
    NotEmpty,
    #[msg("An on-chain invariant was violated")]
    InvariantViolated,
    #[msg("Instruction is not implemented yet")]
    NotImplemented,
    #[msg("Market has closed and is awaiting settlement")]
    MarketClosed,
    #[msg("Order would cross the book; use a market order instead")]
    WouldCross,
}
