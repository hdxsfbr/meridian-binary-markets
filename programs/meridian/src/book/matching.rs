//! Pure matching logic over Book slices (Wave 4B, T052).
//!
//! `match_against` never touches account data or escrows -- it reads a resting side's
//! live orders and a taker's intent and returns a plan of fills for the caller
//! (`place_order.rs`) to apply (transfers, order mutation, events). Price-time priority
//! falls out of the slice's own sort order (`state::book::insert_sorted`'s invariant):
//! walking the resting side front-to-back already visits makers in exactly the order
//! that should fill first.

use anchor_lang::prelude::Pubkey;

use crate::state::book::Order;

/// Which side of the book an order (taker or maker) sits on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid = 0,
    Ask = 1,
}

impl Side {
    /// Decodes the `side: u8` instruction argument. `0` = Bid, `1` = Ask.
    pub fn from_u8(v: u8) -> Option<Side> {
        match v {
            0 => Some(Side::Bid),
            1 => Some(Side::Ask),
            _ => None,
        }
    }
}

/// One proposed fill against a resting maker order.
#[derive(Clone, Copy, Debug)]
pub struct FillPlan {
    /// Index of the maker order within the resting slice passed to `match_against`.
    pub idx: usize,
    /// The maker's order id, for `Fill`'s `maker_order_id` field.
    pub maker_order_id: u64,
    /// The maker's wallet.
    pub maker: Pubkey,
    /// Fill price: always the maker's resting price.
    pub price: u64,
    /// Fill quantity, whole tokens.
    pub qty: u64,
}

/// The result of matching a taker's order against one resting side.
#[derive(Clone, Debug, Default)]
pub struct MatchPlan {
    /// Proposed fills, in the order they should be applied (price-time priority,
    /// strictly increasing `idx` since live orders are packed contiguously from 0).
    pub fills: Vec<FillPlan>,
    /// Quantity left unmatched after `fills` (either because the resting side ran dry,
    /// crossed out of range, or `max_fills` was reached).
    pub remaining_qty: u64,
}

/// Matches a taker's intent (`taker_side`, `limit_price`, `qty`) against `resting`'s
/// first `count` live orders (the *opposite* side of the book from the taker), price-
/// time priority, capped at `max_fills` fills.
///
/// A bid taker crosses an ask maker when `maker.price <= limit_price`; an ask taker
/// crosses a bid maker when `maker.price >= limit_price`. Fills always happen at the
/// maker's price. Because the resting side is sorted best-price-first, the first maker
/// that fails to cross means no later one can either, so the scan stops there.
pub fn match_against(
    resting: &[Order],
    count: u16,
    taker_side: Side,
    limit_price: u64,
    qty: u64,
    max_fills: usize,
) -> MatchPlan {
    let mut remaining_qty = qty;
    let mut fills = Vec::new();

    for (idx, maker) in resting.iter().enumerate().take(count as usize) {
        if remaining_qty == 0 || fills.len() >= max_fills {
            break;
        }
        if maker.id == 0 || maker.remaining == 0 {
            // Should not happen for a well-formed book (live orders are packed
            // contiguously), but skip rather than fill a phantom order.
            continue;
        }

        let crosses = match taker_side {
            Side::Bid => maker.price <= limit_price,
            Side::Ask => maker.price >= limit_price,
        };
        if !crosses {
            break;
        }

        let fill_qty = remaining_qty.min(maker.remaining);
        fills.push(FillPlan {
            idx,
            maker_order_id: maker.id,
            maker: Pubkey::new_from_array(maker.owner),
            price: maker.price,
            qty: fill_qty,
        });
        remaining_qty -= fill_qty;
    }

    MatchPlan { fills, remaining_qty }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(id: u64, price: u64, remaining: u64) -> Order {
        Order {
            id,
            owner: Pubkey::new_unique().to_bytes(),
            price,
            remaining,
            seq: id,
        }
    }

    #[test]
    fn bid_taker_fills_asks_at_or_below_limit_at_maker_price() {
        let asks = [order(1, 500_000, 3), order(2, 600_000, 5), order(3, 900_000, 10)];
        let plan = match_against(&asks, 3, Side::Bid, 650_000, 10, 8);

        assert_eq!(plan.fills.len(), 2);
        assert_eq!(plan.fills[0].price, 500_000);
        assert_eq!(plan.fills[0].qty, 3);
        assert_eq!(plan.fills[1].price, 600_000);
        assert_eq!(plan.fills[1].qty, 5);
        assert_eq!(plan.remaining_qty, 2);
    }

    #[test]
    fn ask_taker_fills_bids_at_or_above_limit_at_maker_price() {
        let bids = [order(1, 700_000, 2), order(2, 650_000, 4), order(3, 400_000, 10)];
        let plan = match_against(&bids, 3, Side::Ask, 600_000, 10, 8);

        assert_eq!(plan.fills.len(), 2);
        assert_eq!(plan.fills[0].price, 700_000);
        assert_eq!(plan.fills[1].price, 650_000);
        assert_eq!(plan.remaining_qty, 4);
    }

    #[test]
    fn stops_scanning_at_the_first_non_crossing_maker() {
        // Sorted ascending for asks; once one maker fails to cross, later (worse-priced)
        // makers can't either, so the scan should not even look at order 3.
        let asks = [order(1, 500_000, 3), order(2, 900_000, 5), order(3, 100, 100)];
        let plan = match_against(&asks, 3, Side::Bid, 600_000, 10, 8);

        assert_eq!(plan.fills.len(), 1);
        assert_eq!(plan.fills[0].maker_order_id, 1);
        assert_eq!(plan.remaining_qty, 7);
    }

    #[test]
    fn equal_price_makers_fill_in_arrival_order() {
        // Resting slice already reflects arrival order (FR-010) via insert_sorted; this
        // test just checks match_against preserves that order rather than re-sorting.
        let asks = [order(10, 500_000, 2), order(20, 500_000, 2), order(30, 500_000, 2)];
        let plan = match_against(&asks, 3, Side::Bid, 500_000, 6, 8);

        let ids: Vec<u64> = plan.fills.iter().map(|f| f.maker_order_id).collect();
        assert_eq!(ids, vec![10, 20, 30]);
    }

    #[test]
    fn caps_fills_at_max_fills_leaving_the_remainder_unmatched() {
        let mut asks = Vec::new();
        for i in 0..9u64 {
            asks.push(order(i + 1, 500_000, 1));
        }
        let plan = match_against(&asks, 9, Side::Bid, 500_000, 9, 8);

        assert_eq!(plan.fills.len(), 8);
        assert_eq!(plan.remaining_qty, 1);
    }

    #[test]
    fn partial_maker_fill_consumes_only_what_the_taker_needs() {
        let asks = [order(1, 500_000, 10)];
        let plan = match_against(&asks, 1, Side::Bid, 500_000, 4, 8);

        assert_eq!(plan.fills.len(), 1);
        assert_eq!(plan.fills[0].qty, 4);
        assert_eq!(plan.remaining_qty, 0);
    }

    #[test]
    fn empty_resting_side_yields_no_fills() {
        let asks: [Order; 0] = [];
        let plan = match_against(&asks, 0, Side::Bid, 500_000, 4, 8);
        assert!(plan.fills.is_empty());
        assert_eq!(plan.remaining_qty, 4);
    }

    #[test]
    fn fill_indices_are_the_makers_actual_slice_positions() {
        let asks = [order(1, 500_000, 1), order(2, 500_000, 1), order(3, 500_000, 1)];
        let plan = match_against(&asks, 3, Side::Bid, 500_000, 3, 8);
        let idxs: Vec<usize> = plan.fills.iter().map(|f| f.idx).collect();
        assert_eq!(idxs, vec![0, 1, 2]);
    }
}
