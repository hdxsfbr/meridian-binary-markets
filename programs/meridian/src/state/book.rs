//! Book layout (Wave 1B).
//!
//! The Book is a raw, program-owned account (PDA `["book", market]`), **not** an Anchor
//! `#[account]` — its body is a variable-length byte region (fixed header + two
//! fixed-capacity arrays of 64-byte `Order` records) cast via `bytemuck`, because Anchor's
//! `zero_copy` structs require compile-time sizes (R7). Integrity is checked by a leading
//! 8-byte discriminator, read with `read_header`/checked by `write_header`.
//!
//! Slice helpers for bids/asks and the sort invariants (price-time priority) are out of
//! scope here; they land in Wave 5 (T051).

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
}
