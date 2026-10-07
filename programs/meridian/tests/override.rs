//! `admin_settle_override` tests (Wave 4, T029/T030 proof).
//!
//! See `specs/001-binary-outcome-markets/data-model.md` "Validation rules carried into
//! instructions" (`admin_settle_override(price)`) and `contracts/program-instructions.md`.
//! All helpers below are private to this file (no cross-file test helper sharing, per
//! this wave's brief).

mod common;

use anchor_lang::prelude::Pubkey;
use litesvm::types::TransactionResult;
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::instructions::UpdateConfigArgs;
use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261006;

/// Calls `admin_settle_override(price)`, signed by `signer`.
fn override_as(env: &mut Env, signer: &Keypair, market: Pubkey, price: u64) -> TransactionResult {
    let accounts = meridian::accounts::AdminSettleOverride {
        admin: signer.pubkey_pk(),
        config: config_pda(),
        market,
    };
    let data = meridian::instruction::AdminSettleOverride { price };
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

/// Creates an AAPL market at `strike`, with `close_ts` 3600s in the future at creation
/// time. Returns `(env, market, close_ts)`. Does not warp the clock or write any price.
fn setup_market(strike: u64) -> (Env, Pubkey, i64) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", strike, DAY, close_ts, 16))
        .expect("create_market should succeed");
    (env, result.market, close_ts)
}

#[test]
fn override_before_delay_elapsed_is_refused() {
    let (mut env, market, close_ts) = setup_market(300_000_000);
    // Exactly 1 second short of close_ts + 3600 (the default override_delay_secs).
    env.warp_to(close_ts + 3599);
    let admin = env.admin.insecure_clone();

    let result = override_as(&mut env, &admin, market, 333_000_000);
    assert_err(&result, MeridianError::OverrideTooEarly);

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Open);
}

#[test]
fn override_at_exactly_delay_elapsed_succeeds_and_writes_state() {
    let (mut env, market, close_ts) = setup_market(300_000_000);
    env.warp_to(close_ts + 3600);
    let admin = env.admin.insecure_clone();

    let meta = override_as(&mut env, &admin, market, 333_000_000)
        .expect("override at exactly close_ts + 3600 should succeed");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);
    assert_eq!(m.settlement_price, 333_000_000);
    assert_eq!(m.settled_at, close_ts + 3600);
    assert!(m.settled_by_override);

    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected a `Program data:` log line for the Settled event, got:\n{}",
        meta.logs.join("\n")
    );
}

#[test]
fn override_by_non_admin_is_refused() {
    let (mut env, market, close_ts) = setup_market(300_000_000);
    env.warp_to(close_ts + 3600);

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = override_as(&mut env, &stranger, market, 333_000_000);
    assert_err(&result, MeridianError::Unauthorized);

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Open);
}

#[test]
fn override_on_already_settled_market_is_refused() {
    let (mut env, market, close_ts) = setup_market(300_000_000);
    env.warp_to(close_ts + 3600);
    let admin = env.admin.insecure_clone();

    override_as(&mut env, &admin, market, 333_000_000).expect("first override should succeed");
    let before: Market = env.fetch(market);

    let result = override_as(&mut env, &admin, market, 400_000_000);
    assert_err(&result, MeridianError::AlreadySettled);

    let after: Market = env.fetch(market);
    assert_eq!(after.state, before.state);
    assert_eq!(after.outcome, before.outcome);
    assert_eq!(after.settlement_price, before.settlement_price);
    assert_eq!(after.settled_at, before.settled_at);
}

#[test]
fn override_with_zero_price_is_refused() {
    let (mut env, market, close_ts) = setup_market(300_000_000);
    env.warp_to(close_ts + 3600);
    let admin = env.admin.insecure_clone();

    let result = override_as(&mut env, &admin, market, 0);
    assert_err(&result, MeridianError::OracleBadPrice);

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Open);
}

#[test]
fn configured_override_delay_larger_than_minimum_is_the_effective_one() {
    let (mut env, market, close_ts) = setup_market(300_000_000);

    let admin = env.admin.insecure_clone();
    env.update_config(UpdateConfigArgs {
        override_delay_secs: Some(7200),
        ..Default::default()
    })
    .expect("update_config raising override_delay_secs should succeed");

    // +3600 (the bare minimum) must now be refused: the configured 7200s is larger.
    env.warp_to(close_ts + 3600);
    let too_early = override_as(&mut env, &admin, market, 333_000_000);
    assert_err(&too_early, MeridianError::OverrideTooEarly);

    // +7200 is accepted.
    env.warp_to(close_ts + 7200);
    override_as(&mut env, &admin, market, 333_000_000)
        .expect("override at the configured 7200s delay should succeed");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
}

#[test]
fn tie_price_equal_to_strike_resolves_yes() {
    let (mut env, market, close_ts) = setup_market(680_000_000);
    env.warp_to(close_ts + 3600);
    let admin = env.admin.insecure_clone();

    override_as(&mut env, &admin, market, 680_000_000).expect("override should succeed");

    let m: Market = env.fetch(market);
    assert_eq!(m.outcome, Outcome::Yes);
}

#[test]
fn override_delay_overflow_near_i64_max_close_ts_fails_cleanly_instead_of_panicking() {
    // close_ts near i64::MAX is still a valid future timestamp for create_market (it
    // only requires close_ts > now); `close_ts.checked_add(delay)` inside
    // admin_settle_override must then fail cleanly with InvariantViolated rather than
    // panicking on overflow (Wave 4 review fix 8).
    let mut env = Env::new();
    env.init_config();
    let close_ts = i64::MAX - 10;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 300_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed with a close_ts near i64::MAX");
    let market = result.market;

    let admin = env.admin.insecure_clone();
    let result = override_as(&mut env, &admin, market, 333_000_000);
    assert_err(&result, MeridianError::InvariantViolated);

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Open);
}
