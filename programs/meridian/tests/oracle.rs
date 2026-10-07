//! Oracle provider interface tests (Wave 3B, T031/T037/T038 proof).
//!
//! Covers both `read_quote` arms end to end: `MockPyth` via `mock_write_price` +
//! `settle_market`, and `PythReceiver` via a hand-built `PriceUpdateV2` account planted
//! with `svm.set_account` (real-VAA verification is Phase 10, out of scope here).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorSerialize, Discriminator};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account as SvmAccount;
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::instructions::UpdateConfigArgs;
use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261006;
/// $333.00 in micro-USD, matching the brief's worked example.
const GOOD_PRICE_MICRO: i64 = 333_000_000;
const AAPL_STRIKE: u64 = 300_000_000;

fn aapl_feed_id(env: &Env) -> [u8; 32] {
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| &t.symbol == b"AAPL\0\0\0\0")
        .expect("AAPL ticker should be enabled")
        .feed_id
}

fn amzn_feed_id(env: &Env) -> [u8; 32] {
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| &t.symbol == b"AMZN\0\0\0\0")
        .expect("AMZN ticker should be enabled")
        .feed_id
}

fn mock_price_pda(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[meridian::state::mock_price::SEED, feed_id.as_ref()],
        &meridian::ID,
    )
    .0
}

/// Calls `mock_write_price`, signed by `signer` (who pays for `init_if_needed`).
fn write_mock_price(
    env: &mut Env,
    signer: &Keypair,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> litesvm::types::TransactionResult {
    let accounts = meridian::accounts::MockWritePrice {
        publisher: signer.pubkey_pk(),
        config: config_pda(),
        price: mock_price_pda(&feed_id),
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MockWritePrice {
        feed_id,
        price,
        conf,
        expo,
        publish_time,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

/// Calls `settle_market`, signed by `caller` (anyone may call it).
fn settle_market(
    env: &mut Env,
    caller: &Keypair,
    market: Pubkey,
    price_account: Pubkey,
) -> litesvm::types::TransactionResult {
    let accounts = meridian::accounts::SettleMarket {
        caller: caller.pubkey_pk(),
        config: config_pda(),
        market,
        price_account,
    };
    let data = meridian::instruction::SettleMarket {};
    let ix = build_ix(meridian::ID, accounts, data);
    let caller = caller.insecure_clone();
    env.send(&[ix], &[&caller])
}

/// Creates an AAPL market whose `close_ts` is 3600s in the future (so tests can warp to
/// it), with `AAPL_STRIKE`.
fn setup_market(env: &mut Env) -> (Pubkey, i64) {
    env.init_config();
    let close_ts = env.now() + 3600;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", AAPL_STRIKE, DAY, close_ts, 16))
        .expect("create_market should succeed");
    (result.market, close_ts)
}

// ---- mock_write_price ----

#[test]
fn allowlisted_publisher_write_succeeds_and_fields_round_trip() {
    let mut env = Env::new();
    env.init_config();
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, 1_000)
        .expect("write by allowlisted publisher should succeed");

    let update: meridian::state::mock_price::MockPriceUpdate = env.fetch(mock_price_pda(&feed_id));
    assert_eq!(update.feed_id, feed_id);
    assert_eq!(update.price, GOOD_PRICE_MICRO);
    assert_eq!(update.conf, 10_000);
    assert_eq!(update.expo, -6);
    assert_eq!(update.publish_time, 1_000);
    assert_eq!(update.publisher, admin.pubkey_pk());
}

#[test]
fn write_by_stranger_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let feed_id = aapl_feed_id(&env);

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = write_mock_price(&mut env, &stranger, feed_id, GOOD_PRICE_MICRO, 10_000, -6, 1_000);
    assert_err(&result, MeridianError::PublisherNotAllowed);
}

#[test]
fn write_for_unknown_feed_id_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let admin = env.admin.insecure_clone();

    let unknown_feed = [0xAAu8; 32];
    let result = write_mock_price(&mut env, &admin, unknown_feed, GOOD_PRICE_MICRO, 10_000, -6, 1_000);
    assert_err(&result, MeridianError::OracleFeedMismatch);
}

// ---- settle_market / MockPyth arm ----

#[test]
fn settle_with_valid_quote_succeeds() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts)
        .expect("write should succeed");

    settle_market(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed with a valid quote");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.settlement_price, GOOD_PRICE_MICRO as u64);
}

#[test]
fn stale_price_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    // 301s before "now" (close_ts), past the 300s staleness window.
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts - 301)
        .expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleStale);
}

#[test]
fn too_old_price_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    // publish_time < close_ts - min_publish_offset_secs (60), but still fresh enough to
    // pass the staleness check on its own.
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts - 61)
        .expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleTooOld);
}

#[test]
fn wide_confidence_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    // conf 1_000_000 / price 333_000_000 ~= 30 bps > the 25 bps limit.
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 1_000_000, -6, close_ts)
        .expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleLowConfidence);
}

#[test]
fn non_positive_price_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, 0, 10_000, -6, close_ts).expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleBadPrice);
}

#[test]
fn wrong_feed_account_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let aapl_feed = aapl_feed_id(&env);
    let amzn_feed = amzn_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    // Write a valid price for AMZN's feed, but try to settle the AAPL market with it.
    write_mock_price(&mut env, &admin, amzn_feed, GOOD_PRICE_MICRO, 10_000, -6, close_ts)
        .expect("write should succeed");
    // Sanity: the two feeds really are different PDAs.
    assert_ne!(mock_price_pda(&aapl_feed), mock_price_pda(&amzn_feed));

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&amzn_feed));
    // The AMZN PDA is not the AAPL ticker's mock_price PDA, so the PDA-address guard
    // fires (`OracleOwnerMismatch` in this implementation; see oracle/mock.rs).
    assert_err(&result, MeridianError::OracleOwnerMismatch);
}

#[test]
fn non_program_owned_account_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);

    // A fresh system-owned account (never written to) is not owned by this program.
    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = settle_market(&mut env, &admin, market, stranger.pubkey_pk());
    assert_err(&result, MeridianError::OracleOwnerMismatch);
}

// ---- PythReceiver arm ----

/// Builds the raw account bytes for a `PriceUpdateV2`: 8-byte Anchor discriminator +
/// borsh-serialized struct, matching what the real Pyth receiver program would write.
fn price_update_v2_bytes(
    feed_id: [u8; 32],
    verification_level: VerificationLevel,
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) -> Vec<u8> {
    let update = PriceUpdateV2 {
        write_authority: Pubkey::default(),
        verification_level,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time,
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot: 0,
    };
    let mut data = PriceUpdateV2::DISCRIMINATOR.to_vec();
    update.serialize(&mut data).expect("serialize PriceUpdateV2");
    data
}

/// Plants a `PriceUpdateV2` account at `address`, owned by `owner`, via `svm.set_account`.
fn plant_pyth_account(
    env: &mut Env,
    address: Pubkey,
    owner: Pubkey,
    feed_id: [u8; 32],
    verification_level: VerificationLevel,
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) {
    let data = price_update_v2_bytes(feed_id, verification_level, price, conf, exponent, publish_time);
    let account = SvmAccount {
        lamports: 1_000_000_000,
        data,
        owner: addr(owner),
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(addr(address), account).expect("set_account should succeed");
}

/// Switches `Config.oracle_provider` to `PythReceiver` with `oracle_program` as the
/// receiver program owner.
fn switch_to_pyth(env: &mut Env, oracle_program: Pubkey) {
    env.update_config(UpdateConfigArgs {
        oracle_provider: Some(meridian::state::config::OracleProvider::PythReceiver),
        oracle_program: Some(oracle_program),
        ..Default::default()
    })
    .expect("update_config to PythReceiver should succeed");
}

#[test]
fn pyth_full_verification_settles_correctly() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    let receiver_program = Pubkey::new_unique();
    switch_to_pyth(&mut env, receiver_program);

    env.warp_to(close_ts);
    let price_account = Pubkey::new_unique();
    plant_pyth_account(
        &mut env,
        price_account,
        receiver_program,
        feed_id,
        VerificationLevel::Full,
        GOOD_PRICE_MICRO,
        10_000,
        -6,
        close_ts,
    );

    settle_market(&mut env, &admin, market, price_account)
        .expect("settle_market should succeed against a fully-verified PriceUpdateV2");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.settlement_price, GOOD_PRICE_MICRO as u64);
}

#[test]
fn pyth_partial_verification_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    let receiver_program = Pubkey::new_unique();
    switch_to_pyth(&mut env, receiver_program);

    env.warp_to(close_ts);
    let price_account = Pubkey::new_unique();
    plant_pyth_account(
        &mut env,
        price_account,
        receiver_program,
        feed_id,
        VerificationLevel::Partial { num_signatures: 1 },
        GOOD_PRICE_MICRO,
        10_000,
        -6,
        close_ts,
    );

    let result = settle_market(&mut env, &admin, market, price_account);
    assert_err(&result, MeridianError::OracleVerificationLevel);
}

#[test]
fn pyth_wrong_feed_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let admin = env.admin.insecure_clone();

    let receiver_program = Pubkey::new_unique();
    switch_to_pyth(&mut env, receiver_program);

    env.warp_to(close_ts);
    let price_account = Pubkey::new_unique();
    // A feed id that does not belong to the AAPL ticker.
    plant_pyth_account(
        &mut env,
        price_account,
        receiver_program,
        [0x42u8; 32],
        VerificationLevel::Full,
        GOOD_PRICE_MICRO,
        10_000,
        -6,
        close_ts,
    );

    let result = settle_market(&mut env, &admin, market, price_account);
    assert_err(&result, MeridianError::OracleFeedMismatch);
}

// ---- Boundary tests (Wave 3 review fix item 6) ----

/// Asserts the market is still `Open` with `Outcome::Unset` -- i.e. a rejected
/// `settle_market` call left no trace of itself on the market account.
fn assert_still_open_and_unset(env: &Env, market: Pubkey) {
    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.outcome, Outcome::Unset);
}

#[test]
fn staleness_exactly_at_300s_passes() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    // publish_time = close_ts (clears the OracleTooOld floor of close_ts - 60 with room
    // to spare); warp "now" to close_ts + 300 so age is exactly the 300s ceiling.
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts)
        .expect("write should succeed");
    env.warp_to(close_ts + 300);

    settle_market(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed with age exactly at the 300s staleness ceiling");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
}

#[test]
fn staleness_one_second_past_300s_fails() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts)
        .expect("write should succeed");
    env.warp_to(close_ts + 301);

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleStale);
    assert_still_open_and_unset(&env, market);
}

#[test]
fn publish_time_exactly_60s_before_close_passes() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts - 60)
        .expect("write should succeed");

    settle_market(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed with publish_time exactly at close_ts - 60");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
}

#[test]
fn publish_time_61s_before_close_fails() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts - 61)
        .expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleTooOld);
    assert_still_open_and_unset(&env, market);
}

#[test]
fn confidence_exactly_at_25bps_passes() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    // conf_micro * 10_000 == price_micro * 25 at conf_micro = 832_500 (price 333_000_000).
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 832_500, -6, close_ts)
        .expect("write should succeed");

    settle_market(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed with confidence exactly at the 25bps limit");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
}

#[test]
fn confidence_one_unit_past_25bps_fails() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 832_501, -6, close_ts)
        .expect("write should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::OracleLowConfidence);
    assert_still_open_and_unset(&env, market);
}

#[test]
fn publisher_removed_from_allowlist_after_writing_fails_settle() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, GOOD_PRICE_MICRO, 10_000, -6, close_ts)
        .expect("write by the still-allowlisted admin should succeed");

    // Replace the publisher allowlist with an unrelated key, after the write.
    env.update_config(UpdateConfigArgs {
        publishers: Some(vec![Pubkey::new_unique()]),
        ..Default::default()
    })
    .expect("update_config removing admin from publishers should succeed");

    let result = settle_market(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::PublisherNotAllowed);
    assert_still_open_and_unset(&env, market);
}

#[test]
fn pyth_account_owned_by_wrong_program_is_refused() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let feed_id = aapl_feed_id(&env);
    let admin = env.admin.insecure_clone();

    let receiver_program = Pubkey::new_unique();
    switch_to_pyth(&mut env, receiver_program);

    env.warp_to(close_ts);
    let price_account = Pubkey::new_unique();
    let wrong_owner = Pubkey::new_unique();
    plant_pyth_account(
        &mut env,
        price_account,
        wrong_owner,
        feed_id,
        VerificationLevel::Full,
        GOOD_PRICE_MICRO,
        10_000,
        -6,
        close_ts,
    );

    let result = settle_market(&mut env, &admin, market, price_account);
    assert_err(&result, MeridianError::OracleOwnerMismatch);
    assert_still_open_and_unset(&env, market);
}

#[test]
fn pyth_malformed_too_short_account_fails_with_some_oracle_error() {
    let mut env = Env::new();
    let (market, close_ts) = setup_market(&mut env);
    let admin = env.admin.insecure_clone();

    let receiver_program = Pubkey::new_unique();
    switch_to_pyth(&mut env, receiver_program);

    env.warp_to(close_ts);
    let price_account = Pubkey::new_unique();
    // Far too short to be a discriminator-prefixed `PriceUpdateV2`.
    let account = SvmAccount {
        lamports: 1_000_000_000,
        data: vec![0u8; 4],
        owner: addr(receiver_program),
        executable: false,
        rent_epoch: 0,
    };
    env.svm
        .set_account(addr(price_account), account)
        .expect("set_account should succeed");

    let result = settle_market(&mut env, &admin, market, price_account);
    assert!(result.is_err(), "settling against a malformed too-short account should fail");
    assert_still_open_and_unset(&env, market);
}
