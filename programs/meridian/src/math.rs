//! Integer money math for the meridian program.
//!
//! Every value on the money path is an integer. USDC and the Yes/No mints use
//! 6 decimals ("micro-units"); Yes prices are micro-USDC per token in
//! `1..=999_999` (`data-model.md`, first paragraph on units).

use crate::errors::MeridianError;
use anchor_lang::prelude::*;

/// One whole USDC, in micro-units (6 decimals).
pub const ONE_USDC: u64 = 1_000_000;

/// Maximum valid Yes price, in micro-USDC per token.
pub const PRICE_MAX: u64 = 999_999;

/// Smallest supported Pyth-style exponent (`price * 10^expo`).
const MIN_EXPO: i32 = -12;
/// Largest supported Pyth-style exponent.
const MAX_EXPO: i32 = 6;

/// `a * b / d` with a `u128` intermediate; refuses overflow and division by
/// zero with `InvariantViolated`.
pub fn checked_mul_div(a: u64, b: u64, d: u64) -> Result<u64> {
    if d == 0 {
        return Err(error!(MeridianError::InvariantViolated));
    }
    let product = (a as u128)
        .checked_mul(b as u128)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    let result = product
        .checked_div(d as u128)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    u64::try_from(result).map_err(|_| error!(MeridianError::InvariantViolated))
}

/// Scales a non-negative `value * 10^expo` into micro-units (6 decimals),
/// i.e. `value * 10^(expo + 6)`. Shared by `normalize_price` and
/// `normalize_conf`. When scaling down (negative shift), `round_up` selects
/// ceiling division (used by `normalize_conf`, so a confidence interval is
/// never under-reported) vs. floor division (used by `normalize_price`).
fn scale_to_micro(value: u128, expo: i32, round_up: bool) -> Result<u64> {
    if expo < MIN_EXPO || expo > MAX_EXPO {
        return Err(error!(MeridianError::OracleBadPrice));
    }
    let shift = expo + 6;
    let scaled: u128 = if shift >= 0 {
        let factor = 10u128
            .checked_pow(shift as u32)
            .ok_or_else(|| error!(MeridianError::OracleBadPrice))?;
        value
            .checked_mul(factor)
            .ok_or_else(|| error!(MeridianError::OracleBadPrice))?
    } else {
        let divisor = 10u128
            .checked_pow((-shift) as u32)
            .ok_or_else(|| error!(MeridianError::OracleBadPrice))?;
        if round_up {
            let numerator = value
                .checked_add(divisor - 1)
                .ok_or_else(|| error!(MeridianError::OracleBadPrice))?;
            numerator / divisor
        } else {
            value / divisor
        }
    };
    u64::try_from(scaled).map_err(|_| error!(MeridianError::OracleBadPrice))
}

/// Converts a Pyth-style `(price, expo)` pair into micro-USD (6 decimals).
/// Refuses non-positive prices and refuses overflow, an out-of-range
/// exponent, or a result that rounds down to zero, all with
/// `OracleBadPrice`.
pub fn normalize_price(price: i64, expo: i32) -> Result<u64> {
    if price <= 0 {
        return Err(error!(MeridianError::OracleBadPrice));
    }
    let micro = scale_to_micro(price as u128, expo, false)?;
    if micro == 0 {
        return Err(error!(MeridianError::OracleBadPrice));
    }
    Ok(micro)
}

/// Converts a Pyth-style confidence interval `(conf, expo)` into micro-USD
/// (6 decimals). `conf` may be zero. Rounds up when scaling down, so the
/// confidence check cannot accept an interval that exceeds the limit due to
/// flooring.
pub fn normalize_conf(conf: u64, expo: i32) -> Result<u64> {
    scale_to_micro(conf as u128, expo, true)
}

/// True when the confidence interval is within `max_bps` of the price:
/// `conf * 10_000 <= price * max_bps`, computed over `u128`.
pub fn conf_within_bps(price_micro: u64, conf_micro: u64, max_bps: u16) -> bool {
    let lhs = (conf_micro as u128) * 10_000u128;
    let rhs = (price_micro as u128) * (max_bps as u128);
    lhs <= rhs
}

/// `qty * ONE_USDC`, checked.
pub fn pairs_to_usdc(qty: u64) -> Result<u64> {
    qty.checked_mul(ONE_USDC)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_price_matches_worked_example() {
        assert_eq!(normalize_price(33_341_000_000, -8).unwrap(), 333_410_000);
    }

    #[test]
    fn normalize_price_expo_minus_6_is_identity() {
        assert_eq!(normalize_price(680_000_000, -6).unwrap(), 680_000_000);
    }

    #[test]
    fn normalize_price_expo_minus_5_multiplies_by_ten() {
        assert_eq!(normalize_price(68_000_000, -5).unwrap(), 680_000_000);
    }

    #[test]
    fn normalize_price_expo_minus_9_divides_by_one_thousand() {
        assert_eq!(normalize_price(680_000_000_000, -9).unwrap(), 680_000_000);
    }

    #[test]
    fn normalize_price_positive_expo_multiplies_up() {
        // price 68, expo 2 -> 6800 * 10^6 micro-USD = 6_800_000_000
        assert_eq!(normalize_price(68, 2).unwrap(), 6_800_000_000);
    }

    #[test]
    fn normalize_price_refuses_negative_price() {
        assert!(normalize_price(-1, -6).is_err());
    }

    #[test]
    fn normalize_price_refuses_zero_price() {
        assert!(normalize_price(0, -6).is_err());
    }

    #[test]
    fn normalize_price_refuses_overflow() {
        assert!(normalize_price(i64::MAX, MAX_EXPO).is_err());
    }

    #[test]
    fn normalize_conf_zero_is_allowed() {
        assert_eq!(normalize_conf(0, -6).unwrap(), 0);
    }

    #[test]
    fn normalize_conf_scales_like_price() {
        assert_eq!(normalize_conf(1_000_000, -8).unwrap(), 10_000);
    }

    #[test]
    fn conf_within_bps_boundary_exactly_equal_passes() {
        // conf * 10_000 == price * max_bps
        // price 1_000_000, max_bps 25 -> rhs = 25_000_000; conf = 2_500
        assert!(conf_within_bps(1_000_000, 2_500, 25));
    }

    #[test]
    fn conf_within_bps_one_over_fails() {
        assert!(!conf_within_bps(1_000_000, 2_501, 25));
    }

    #[test]
    fn conf_within_bps_zero_conf_passes() {
        assert!(conf_within_bps(1_000_000, 0, 25));
    }

    #[test]
    fn checked_mul_div_overflow_is_refused() {
        assert!(checked_mul_div(u64::MAX, u64::MAX, 1).is_err());
    }

    #[test]
    fn checked_mul_div_div_by_zero_is_refused() {
        assert!(checked_mul_div(10, 10, 0).is_err());
    }

    #[test]
    fn checked_mul_div_happy_path() {
        assert_eq!(checked_mul_div(6, 1_000_000, 1).unwrap(), 6_000_000);
    }

    #[test]
    fn pairs_to_usdc_overflow_is_refused() {
        assert!(pairs_to_usdc(u64::MAX).is_err());
    }

    #[test]
    fn pairs_to_usdc_happy_path() {
        assert_eq!(pairs_to_usdc(6).unwrap(), 6_000_000);
    }

    #[test]
    fn normalize_conf_rounds_up_so_conf_check_cannot_be_evaded_by_flooring() {
        // Regression: price=40_000, conf=101, expo=-8 must FAIL conf_within_bps(..., 25)
        // after normalization. With floor rounding, conf would normalize to 1 (not 2),
        // which would incorrectly pass the 25 bps check.
        let price_micro = normalize_price(40_000, -8).unwrap();
        let conf_micro = normalize_conf(101, -8).unwrap();
        assert_eq!(price_micro, 400);
        assert_eq!(conf_micro, 2);
        assert!(!conf_within_bps(price_micro, conf_micro, 25));
    }

    #[test]
    fn normalize_price_rejects_result_that_floors_to_zero() {
        assert!(normalize_price(1, -8).is_err());
    }

    #[test]
    fn normalize_price_accepts_smallest_positive_representable_price() {
        assert_eq!(normalize_price(1, -6).unwrap(), 1);
    }

    #[test]
    fn checked_mul_div_max_values_round_trip_to_max() {
        assert_eq!(checked_mul_div(u64::MAX, u64::MAX, u64::MAX).unwrap(), u64::MAX);
    }

    #[test]
    fn checked_mul_div_non_divisible_quotient_truncates() {
        assert_eq!(checked_mul_div(7, 3, 2).unwrap(), 10);
    }

    #[test]
    fn scale_to_micro_accepts_min_expo_boundary() {
        assert!(scale_to_micro(10u128.pow(12), MIN_EXPO, false).is_ok());
    }

    #[test]
    fn scale_to_micro_accepts_max_expo_boundary() {
        assert!(scale_to_micro(1, MAX_EXPO, false).is_ok());
    }

    #[test]
    fn scale_to_micro_rejects_below_min_expo() {
        assert!(scale_to_micro(10u128.pow(12), MIN_EXPO - 1, false).is_err());
    }

    #[test]
    fn scale_to_micro_rejects_above_max_expo() {
        assert!(scale_to_micro(1, MAX_EXPO + 1, false).is_err());
    }

    #[test]
    fn pairs_to_usdc_accepts_largest_non_overflowing_qty() {
        let qty = u64::MAX / ONE_USDC;
        assert!(pairs_to_usdc(qty).is_ok());
    }

    #[test]
    fn pairs_to_usdc_overflows_one_past_largest_qty() {
        let qty = u64::MAX / ONE_USDC + 1;
        assert!(pairs_to_usdc(qty).is_err());
    }
}
