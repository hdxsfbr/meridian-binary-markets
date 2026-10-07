//! Order book engine: pure matching (`matching.rs`) and escrow CPI helpers
//! (`escrow.rs`), both consumed by `instructions/place_order.rs`/`cancel_order.rs`
//! (Wave 4B, T051-T055).
pub mod escrow;
pub mod matching;
