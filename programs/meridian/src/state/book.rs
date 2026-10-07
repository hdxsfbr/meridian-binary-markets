//! Book layout (Wave 1B).
//!
//! The Book is a raw, program-owned account (PDA `["book", market]`), **not** an Anchor
//! `#[account]` — its body is a variable-length byte region (fixed header + two
//! fixed-capacity arrays of 64-byte `Order` records) cast via `bytemuck`, because Anchor's
//! `zero_copy` structs require compile-time sizes (R7). Integrity is checked by a leading
//! 8-byte discriminator, read with `read_header`/checked by `write_header`.
//!
//! Slice helpers for bids/asks (`bids_mut`/`asks_mut`/`insert_sorted`/`remove_at`/
//! `find_order`) and the escrow-sum helpers (`sum_bid_escrow`/`sum_ask_escrow`) that
//! maintain the sort invariants (price-time priority) are added in Wave 4B (T051); see
//! their doc comments below.

use std::mem::size_of;

use anchor_lang::prelude::*;
use bytemuck::{Pod, Zeroable};

use crate::errors::MeridianError;

/// Seed prefix for the Book PDA: `["book", market]`.
pub const BOOK_SEED: &[u8] = b"book";

/// Leading 8 bytes of every Book account, checked by `read_header`/`write_header`.
///
/// The Book is not an Anchor `#[account]` (Anchor's 8-byte discriminator is
/// `sha256("account:<Name>")[..8]`, which requires an IDL-visible struct), so this is a
/// plain literal tag identifying the raw layout instead.
pub const BOOK_DISCRIMINATOR: [u8; 8] = *b"MERIBOOK";

/// A single resting (or being-matched) order. Exactly 64 bytes so the book body can be
/// addressed as a flat array of records.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Order {
    /// User-facing cancel handle.
    pub id: u64,
    /// Owner's wallet, stored as raw bytes (`Pubkey` itself is not `Pod`).
    pub owner: [u8; 32],
    /// Micro-USDC per Yes token.
    pub price: u64,
    /// Remaining tokens on this order.
    pub remaining: u64,
    /// Arrival order; tie-break at equal price (FR-010).
    pub seq: u64,
}

const _: () = assert!(size_of::<Order>() == 64);

/// Fixed-size header at the front of a Book account's data, after the 8-byte discriminator.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct BookHeader {
    /// The Market this book belongs to, raw bytes.
    pub market: [u8; 32],
    /// USDC escrow token account, raw bytes. Sum of `price * remaining` over bids equals
    /// this account's balance.
    pub usdc_escrow: [u8; 32],
    /// Yes-token escrow token account, raw bytes. Sum of `remaining` over asks equals
    /// this account's balance.
    pub yes_escrow: [u8; 32],
    /// Next order id to assign.
    pub next_order_id: u64,
    /// Next sequence number to assign.
    pub next_seq: u64,
    /// Capacity per side (bids array length == asks array length == capacity).
    pub capacity: u16,
    /// Number of live resting bids.
    pub bid_count: u16,
    /// Number of live resting asks.
    pub ask_count: u16,
    /// Padding to keep the struct's size a multiple of 8 bytes for `Pod`.
    pub _pad: [u8; 2],
}

const _: () = assert!(size_of::<BookHeader>() % 8 == 0);

/// Total byte size of a Book account for a given per-side `capacity`: 8-byte
/// discriminator + header + two (bids, asks) arrays of 64-byte `Order` records.
pub fn book_space(capacity: u16) -> usize {
    8 + size_of::<BookHeader>() + 2 * capacity as usize * size_of::<Order>()
}

impl BookHeader {
    /// Builds a fresh header for a newly created market's book.
    pub fn init(market: &Pubkey, usdc_escrow: &Pubkey, yes_escrow: &Pubkey, capacity: u16) -> Self {
        Self {
            market: market.to_bytes(),
            usdc_escrow: usdc_escrow.to_bytes(),
            yes_escrow: yes_escrow.to_bytes(),
            next_order_id: 1,
            next_seq: 1,
            capacity,
            bid_count: 0,
            ask_count: 0,
            _pad: [0; 2],
        }
    }
}

/// Writes the discriminator and header into the front of a Book account's data buffer.
///
/// # Panics
/// Panics if `data` is shorter than `8 + size_of::<BookHeader>()`.
pub fn write_header(data: &mut [u8], header: &BookHeader) {
    let header_len = size_of::<BookHeader>();
    assert!(data.len() >= 8 + header_len, "book buffer too small for header");
    data[..8].copy_from_slice(&BOOK_DISCRIMINATOR);
    data[8..8 + header_len].copy_from_slice(bytemuck::bytes_of(header));
}

// ---- Slice helpers (Wave 4B, T051) ----
//
// Body layout after the header: `capacity` bids, then `capacity` asks, each a 64-byte
// `Order`. Bids are kept sorted `(price desc, seq asc)`, asks `(price asc, seq asc)`. A
// zero `id` marks an empty slot; live orders are always packed contiguously at the front
// of each side's array (indices `0..count`), with the tail zeroed -- `insert_sorted` and
// `remove_at` both maintain this.

/// Byte offset of the bids array, right after the discriminator and header.
fn bids_offset() -> usize {
    8 + size_of::<BookHeader>()
}

/// Byte offset of the asks array: right after the bids array.
fn asks_offset(capacity: u16) -> usize {
    bids_offset() + capacity as usize * size_of::<Order>()
}

/// Casts the byte range `[start, start + capacity * 64)` to a mutable `Order` slice.
/// Returns `InvariantViolated` if the range is out of bounds or misaligned (the latter
/// should not happen for a real account's data, whose base address Solana's runtime
/// aligns to 8 bytes, but a test harness's `Vec<u8>` is not contractually guaranteed to
/// be).
fn cast_orders_mut(data: &mut [u8], start: usize, capacity: u16) -> Result<&mut [Order]> {
    let len_bytes = capacity as usize * size_of::<Order>();
    let end = start
        .checked_add(len_bytes)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    let slice = data
        .get_mut(start..end)
        .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    bytemuck::try_cast_slice_mut(slice).map_err(|_| {
        msg!("book: Order slice is misaligned or mis-sized");
        error!(MeridianError::InvariantViolated)
    })
}

/// The bids side of a Book account's data: `capacity` 64-byte `Order` records,
/// contiguous, sorted `(price desc, seq asc)` over `[0..bid_count]`.
pub fn bids_mut(data: &mut [u8], capacity: u16) -> Result<&mut [Order]> {
    cast_orders_mut(data, bids_offset(), capacity)
}

/// The asks side of a Book account's data: `capacity` 64-byte `Order` records,
/// contiguous, sorted `(price asc, seq asc)` over `[0..ask_count]`.
pub fn asks_mut(data: &mut [u8], capacity: u16) -> Result<&mut [Order]> {
    cast_orders_mut(data, asks_offset(capacity), capacity)
}

/// Inserts `order` into `slice` (a bids or asks side array) at the position its sort key
/// demands, shifting later live entries right by one. `desc` selects the bids
/// comparator (`price desc`) vs. the asks comparator (`price asc`); `seq asc` tie-break
/// falls out for free because a newly built `order` always carries the largest `seq`
/// handed out so far, so it is never inserted before an existing equal-price entry.
///
/// Returns the new live count, or `BookFull` if `count` already equals `slice.len()`
/// (the side's capacity).
pub fn insert_sorted(slice: &mut [Order], count: u16, order: Order, desc: bool) -> Result<u16> {
    let capacity = slice.len();
    let count_usize = count as usize;
    require!(count_usize < capacity, MeridianError::BookFull);

    let mut idx = 0usize;
    while idx < count_usize {
        let worse_than_new = if desc {
            slice[idx].price < order.price
        } else {
            slice[idx].price > order.price
        };
        if worse_than_new {
            break;
        }
        idx += 1;
    }

    // Shift [idx, count) right by one to open a gap at idx.
    let mut i = count_usize;
    while i > idx {
        slice[i] = slice[i - 1];
        i -= 1;
    }
    slice[idx] = order;

    Ok(count + 1)
}

/// Removes the live order at `idx` from `slice` (a bids or asks side array of `count`
/// live entries), shifting everything after it left by one and zeroing the now-unused
/// tail slot. Returns the new live count.
///
/// # Panics
/// Panics (via indexing) if `idx >= count as usize` or `count as usize > slice.len()`.
pub fn remove_at(slice: &mut [Order], count: u16, idx: usize) -> u16 {
    let count_usize = count as usize;
    let mut i = idx;
    while i + 1 < count_usize {
        slice[i] = slice[i + 1];
        i += 1;
    }
    slice[count_usize - 1] = Order::zeroed();
    count - 1
}

/// Finds the index of the live order with `id == order_id` in `slice[0..count]`, or
/// `None` if not present. `id == 0` never matches (it marks an empty slot).
pub fn find_order(slice: &[Order], count: u16, order_id: u64) -> Option<usize> {
    if order_id == 0 {
        return None;
    }
    slice[..count as usize].iter().position(|o| o.id == order_id)
}

/// Checked `Σ price * remaining` over the first `count` live bids, in micro-USDC.
pub fn sum_bid_escrow(slice: &[Order], count: u16) -> Result<u64> {
    let mut total: u128 = 0;
    for order in &slice[..count as usize] {
        let leg = (order.price as u128)
            .checked_mul(order.remaining as u128)
            .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
        total = total
            .checked_add(leg)
            .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    }
    u64::try_from(total).map_err(|_| error!(MeridianError::InvariantViolated))
}

/// Checked `Σ remaining * 1_000_000` over the first `count` live asks, in Yes base
/// units.
pub fn sum_ask_escrow(slice: &[Order], count: u16) -> Result<u64> {
    let mut total: u128 = 0;
    for order in &slice[..count as usize] {
        let leg = (order.remaining as u128)
            .checked_mul(1_000_000u128)
            .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
        total = total
            .checked_add(leg)
            .ok_or_else(|| error!(MeridianError::InvariantViolated))?;
    }
    u64::try_from(total).map_err(|_| error!(MeridianError::InvariantViolated))
}

/// Reads and validates the discriminator, then decodes the header from a Book account's
/// data buffer. Also validates that the buffer is exactly `book_space(header.capacity)`
/// long and that `bid_count`/`ask_count` do not exceed `capacity`.
pub fn read_header(data: &[u8]) -> Result<BookHeader> {
    let header_len = size_of::<BookHeader>();
    if data.len() < 8 + header_len {
        msg!("Book.read_header: account data too short");
        return Err(MeridianError::InvariantViolated.into());
    }
    if data[..8] != BOOK_DISCRIMINATOR {
        msg!("Book.read_header: discriminator mismatch");
        return Err(MeridianError::InvariantViolated.into());
    }
    // `pod_read_unaligned` (not `from_bytes`) because the slice itself is not guaranteed to
    // be aligned to `BookHeader`'s alignment; `from_bytes` panics on an unaligned slice.
    let header: BookHeader = bytemuck::pod_read_unaligned(&data[8..8 + header_len]);

    if data.len() != book_space(header.capacity) {
        msg!("Book.read_header: account data length does not match book_space(capacity)");
        return Err(MeridianError::InvariantViolated.into());
    }
    if header.bid_count > header.capacity || header.ask_count > header.capacity {
        msg!("Book.read_header: bid_count/ask_count exceeds capacity");
        return Err(MeridianError::InvariantViolated.into());
    }

    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_is_exactly_64_bytes() {
        assert_eq!(size_of::<Order>(), 64);
    }

    #[test]
    fn book_header_size_is_multiple_of_8() {
        assert_eq!(size_of::<BookHeader>() % 8, 0);
    }

    #[test]
    fn book_space_for_demo_scale_capacity_16() {
        let expected = 8 + size_of::<BookHeader>() + 2 * 16 * 64;
        assert_eq!(book_space(16), expected);
    }

    #[test]
    fn book_space_for_default_capacity_128() {
        let expected = 8 + size_of::<BookHeader>() + 2 * 128 * 64;
        assert_eq!(book_space(128), expected);
    }

    #[test]
    fn header_round_trips_through_a_byte_buffer() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);

        let mut buf = vec![0u8; book_space(16)];
        write_header(&mut buf, &header);

        let decoded = read_header(&buf).expect("header should decode");
        assert_eq!(decoded.market, market.to_bytes());
        assert_eq!(decoded.usdc_escrow, usdc_escrow.to_bytes());
        assert_eq!(decoded.yes_escrow, yes_escrow.to_bytes());
        assert_eq!(decoded.next_order_id, 1);
        assert_eq!(decoded.next_seq, 1);
        assert_eq!(decoded.capacity, 16);
        assert_eq!(decoded.bid_count, 0);
        assert_eq!(decoded.ask_count, 0);
    }

    #[test]
    fn read_header_rejects_wrong_discriminator() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);

        let mut buf = vec![0u8; book_space(16)];
        write_header(&mut buf, &header);
        buf[0] = b'X';

        assert!(read_header(&buf).is_err());
    }

    #[test]
    fn read_header_rejects_too_short_buffer() {
        let buf = vec![0u8; 4];
        assert!(read_header(&buf).is_err());
    }

    #[test]
    fn read_header_reads_from_a_misaligned_buffer_without_panicking() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);

        // Offset by 1 byte into a larger buffer so the header region starts unaligned
        // relative to BookHeader's 8-byte alignment.
        let mut outer = vec![0u8; 1 + book_space(16)];
        write_header(&mut outer[1..], &header);

        let decoded = read_header(&outer[1..]).expect("misaligned header should decode");
        assert_eq!(decoded.market, market.to_bytes());
        assert_eq!(decoded.capacity, 16);
    }

    #[test]
    fn read_header_rejects_data_len_not_matching_book_space_of_capacity() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);

        // Buffer sized for capacity 16's header but padded with extra trailing bytes, so
        // data.len() != book_space(header.capacity).
        let mut buf = vec![0u8; book_space(16) + 64];
        write_header(&mut buf, &header);

        assert!(read_header(&buf).is_err());
    }

    #[test]
    fn read_header_rejects_bid_count_exceeding_capacity() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let mut header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);
        header.bid_count = 17;

        let mut buf = vec![0u8; book_space(16)];
        write_header(&mut buf, &header);

        assert!(read_header(&buf).is_err());
    }

    #[test]
    fn read_header_rejects_ask_count_exceeding_capacity() {
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let mut header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, 16);
        header.ask_count = 17;

        let mut buf = vec![0u8; book_space(16)];
        write_header(&mut buf, &header);

        assert!(read_header(&buf).is_err());
    }

    fn make_order(id: u64, price: u64, remaining: u64, seq: u64) -> Order {
        Order {
            id,
            owner: Pubkey::new_unique().to_bytes(),
            price,
            remaining,
            seq,
        }
    }

    #[test]
    fn insert_sorted_bids_keeps_price_desc_seq_asc() {
        let mut buf = vec![Order::zeroed(); 4];
        let mut count = 0u16;
        count = insert_sorted(&mut buf, count, make_order(1, 100, 1, 1), true).unwrap();
        count = insert_sorted(&mut buf, count, make_order(2, 300, 1, 2), true).unwrap();
        count = insert_sorted(&mut buf, count, make_order(3, 200, 1, 3), true).unwrap();
        // Equal price to id 2 (300): arrives later, must land after it (seq asc).
        count = insert_sorted(&mut buf, count, make_order(4, 300, 1, 4), true).unwrap();

        assert_eq!(count, 4);
        let prices: Vec<u64> = buf[..4].iter().map(|o| o.price).collect();
        let ids: Vec<u64> = buf[..4].iter().map(|o| o.id).collect();
        assert_eq!(prices, vec![300, 300, 200, 100]);
        assert_eq!(ids, vec![2, 4, 3, 1]);
    }

    #[test]
    fn insert_sorted_asks_keeps_price_asc_seq_asc() {
        let mut buf = vec![Order::zeroed(); 4];
        let mut count = 0u16;
        count = insert_sorted(&mut buf, count, make_order(1, 300, 1, 1), false).unwrap();
        count = insert_sorted(&mut buf, count, make_order(2, 100, 1, 2), false).unwrap();
        count = insert_sorted(&mut buf, count, make_order(3, 200, 1, 3), false).unwrap();
        count = insert_sorted(&mut buf, count, make_order(4, 100, 1, 4), false).unwrap();

        assert_eq!(count, 4);
        let prices: Vec<u64> = buf[..4].iter().map(|o| o.price).collect();
        let ids: Vec<u64> = buf[..4].iter().map(|o| o.id).collect();
        assert_eq!(prices, vec![100, 100, 200, 300]);
        assert_eq!(ids, vec![2, 4, 3, 1]);
    }

    #[test]
    fn insert_sorted_rejects_full_side() {
        let mut buf = vec![Order::zeroed(); 2];
        let mut count = 0u16;
        count = insert_sorted(&mut buf, count, make_order(1, 100, 1, 1), true).unwrap();
        count = insert_sorted(&mut buf, count, make_order(2, 200, 1, 2), true).unwrap();
        assert_eq!(count, 2);
        assert!(insert_sorted(&mut buf, count, make_order(3, 150, 1, 3), true).is_err());
    }

    #[test]
    fn remove_at_shifts_left_and_zeroes_tail() {
        let mut buf = vec![Order::zeroed(); 4];
        let mut count = 0u16;
        count = insert_sorted(&mut buf, count, make_order(1, 300, 1, 1), true).unwrap();
        count = insert_sorted(&mut buf, count, make_order(2, 200, 1, 2), true).unwrap();
        count = insert_sorted(&mut buf, count, make_order(3, 100, 1, 3), true).unwrap();

        count = remove_at(&mut buf, count, 1); // remove id 2 (middle)

        assert_eq!(count, 2);
        let ids: Vec<u64> = buf[..2].iter().map(|o| o.id).collect();
        assert_eq!(ids, vec![1, 3]);
        assert_eq!(buf[2].id, 0, "tail slot should be zeroed");
        assert_eq!(buf[3].id, 0);
    }

    #[test]
    fn find_order_locates_live_order_and_ignores_zero_id() {
        let mut buf = vec![Order::zeroed(); 4];
        let count = insert_sorted(&mut buf, 0, make_order(7, 100, 1, 1), true).unwrap();
        assert_eq!(find_order(&buf, count, 7), Some(0));
        assert_eq!(find_order(&buf, count, 0), None);
        assert_eq!(find_order(&buf, count, 99), None);
    }

    #[test]
    fn sum_bid_escrow_and_sum_ask_escrow_match_worked_examples() {
        let mut bids = vec![Order::zeroed(); 4];
        let mut count = insert_sorted(&mut bids, 0, make_order(1, 650_000, 6, 1), true).unwrap();
        count = insert_sorted(&mut bids, count, make_order(2, 500_000, 4, 2), true).unwrap();
        assert_eq!(sum_bid_escrow(&bids, count).unwrap(), 650_000 * 6 + 500_000 * 4);

        let mut asks = vec![Order::zeroed(); 4];
        let count = insert_sorted(&mut asks, 0, make_order(3, 700_000, 5, 3), false).unwrap();
        assert_eq!(sum_ask_escrow(&asks, count).unwrap(), 5 * 1_000_000);
    }

    #[test]
    fn bids_mut_and_asks_mut_address_disjoint_regions() {
        let capacity = 4u16;
        let market = Pubkey::new_unique();
        let usdc_escrow = Pubkey::new_unique();
        let yes_escrow = Pubkey::new_unique();
        let header = BookHeader::init(&market, &usdc_escrow, &yes_escrow, capacity);
        let mut buf = vec![0u8; book_space(capacity)];
        write_header(&mut buf, &header);

        {
            let bids = bids_mut(&mut buf, capacity).unwrap();
            assert_eq!(bids.len(), capacity as usize);
            bids[0] = make_order(42, 1, 1, 1);
        }
        {
            let asks = asks_mut(&mut buf, capacity).unwrap();
            assert_eq!(asks.len(), capacity as usize);
            // Writing into bids must not have touched the asks region.
            assert_eq!(asks[0].id, 0);
        }
        {
            let bids = bids_mut(&mut buf, capacity).unwrap();
            assert_eq!(bids[0].id, 42);
        }
    }
}
