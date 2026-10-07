//! `settle_market` tests (Wave 3B, T032/T039 proof).

mod common;

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::instructions::UpdateConfigArgs;
use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261006;

fn feed_id_for(env: &Env, symbol: &str) -> [u8; 32] {
    let mut sym = [0u8; 8];
    sym[..symbol.len()].copy_from_slice(symbol.as_bytes());
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| t.symbol == sym)
        .expect("ticker should be enabled")
        .feed_id
}

fn mock_price_pda(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[meridian::state::mock_price::SEED, feed_id.as_ref()],
        &meridian::ID,
    )
    .0
}

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

fn settle_market_as(
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

/// Creates an AAPL market at `strike` with `close_ts` 3600s in the future, and a mock
/// price write of `price_micro` ready to settle it (not yet settled).
fn setup_market_with_price(env: &mut Env, strike: u64, price_micro: i64) -> (Pubkey, i64, [u8; 32]) {
    env.init_config();
    let close_ts = env.now() + 3600;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", strike, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let feed_id = feed_id_for(env, "AAPL");
    env.warp_to(close_ts);
    let admin = env.admin.insecure_clone();
    write_mock_price(env, &admin, feed_id, price_micro, 10_000, -6, close_ts)
        .expect("mock_write_price should succeed");

    (result.market, close_ts, feed_id)
}

#[test]
fn settle_before_close_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 300_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let feed_id = feed_id_for(&env, "AAPL");
    let admin = env.admin.insecure_clone();
    // publish_time offset check uses close_ts, which hasn't arrived -- write a price far
    // enough in the past relative to close_ts to not matter; the BeforeClose guard fires
    // first regardless.
    let now = env.now();
    write_mock_price(&mut env, &admin, feed_id, 333_000_000, 10_000, -6, now)
        .expect("mock_write_price should succeed");

    let result2 = settle_market_as(&mut env, &admin, result.market, mock_price_pda(&feed_id));
    assert_err(&result2, MeridianError::BeforeClose);
}

#[test]
fn settle_at_close_with_good_quote_settles_and_logs_event() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 300_000_000, 333_000_000);
    let admin = env.admin.insecure_clone();

    let meta = settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);
    assert_eq!(m.settlement_price, 333_000_000);
    assert!(m.settled_at > 0);
    assert!(!m.settled_by_override);

    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected a `Program data:` log line for the Settled event, got:\n{}",
        meta.logs.join("\n")
    );
}

#[test]
fn second_settle_is_refused_and_state_unchanged() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 300_000_000, 333_000_000);
    let admin = env.admin.insecure_clone();

    settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("first settle should succeed");
    let before: Market = env.fetch(market);

    let result = settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id));
    assert_err(&result, MeridianError::AlreadySettled);

    let after: Market = env.fetch(market);
    assert_eq!(after.state, before.state);
    assert_eq!(after.outcome, before.outcome);
    assert_eq!(after.settlement_price, before.settlement_price);
    assert_eq!(after.settled_at, before.settled_at);
}

#[test]
fn at_or_above_rule_above_strike_is_yes() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 680_000_000, 685_000_000);
    let admin = env.admin.insecure_clone();

    settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id)).expect("settle should succeed");
    let m: Market = env.fetch(market);
    assert_eq!(m.outcome, Outcome::Yes);
}

#[test]
fn at_or_above_rule_equal_strike_is_yes() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 680_000_000, 680_000_000);
    let admin = env.admin.insecure_clone();

    settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id)).expect("settle should succeed");
    let m: Market = env.fetch(market);
    assert_eq!(m.outcome, Outcome::Yes);
}

#[test]
fn at_or_above_rule_below_strike_is_no() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 680_000_000, 675_000_000);
    let admin = env.admin.insecure_clone();

    settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id)).expect("settle should succeed");
    let m: Market = env.fetch(market);
    assert_eq!(m.outcome, Outcome::No);
}

#[test]
fn zero_mint_market_settles() {
    // No mint_pair call anywhere in this test: `pairs_outstanding` stays 0 throughout,
    // proving settlement does not depend on any minting having happened (FR scenario 6).
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 300_000_000, 333_000_000);
    let admin = env.admin.insecure_clone();

    let before: Market = env.fetch(market);
    assert_eq!(before.pairs_outstanding, 0);

    settle_market_as(&mut env, &admin, market, mock_price_pda(&feed_id))
        .expect("a zero-mint market should still settle");

    let after: Market = env.fetch(market);
    assert_eq!(after.state, MarketState::Settled);
    assert_eq!(after.pairs_outstanding, 0);
}

#[test]
fn settle_succeeds_after_ticker_is_disabled_for_an_already_open_market() {
    // Wave 3 review fix item 3: disabling a ticker must only block *new* markets
    // (`create_market`/`add_strike`), not settlement of markets that already exist on
    // it. `settle_market` must use `Config::ticker_any`, not the `enabled`-filtered
    // `Config::ticker`.
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 300_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed while AAPL is still enabled");

    let feed_id = feed_id_for(&env, "AAPL");

    // Disable the AAPL ticker via update_config (every other ticker stays as-is).
    let mut tickers = default_tickers();
    assert_eq!(tickers[0].symbol, *b"AAPL\0\0\0\0", "default_tickers()[0] must be AAPL");
    tickers[0].enabled = false;
    let admin = env.admin.insecure_clone();
    env.update_config(UpdateConfigArgs {
        tickers: Some(tickers),
        ..Default::default()
    })
    .expect("update_config disabling AAPL should succeed");

    env.warp_to(close_ts);
    write_mock_price(&mut env, &admin, feed_id, 333_000_000, 10_000, -6, close_ts)
        .expect("mock_write_price should still succeed for a disabled ticker's existing feed");

    settle_market_as(&mut env, &admin, result.market, mock_price_pda(&feed_id))
        .expect("settle_market should succeed even though the ticker is now disabled");

    let m: Market = env.fetch(result.market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);
}

#[test]
fn settle_callable_by_a_random_non_admin_signer() {
    let mut env = Env::new();
    let (market, _close_ts, feed_id) = setup_market_with_price(&mut env, 300_000_000, 333_000_000);

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    settle_market_as(&mut env, &stranger, market, mock_price_pda(&feed_id))
        .expect("settle_market should be callable by anyone");

    let m: Market = env.fetch(market);
    assert_eq!(m.state, MarketState::Settled);
}
