//! US7 admin test matrix (Wave 5, T073 proof).
//!
//! One file covering the full admin surface end to end: `add_strike` mid-session,
//! authorization on every admin-only instruction, the override delay window,
//! pause/unpause's effect on each trading instruction, `update_config` authorization,
//! and ticker-disable scoping (blocks new markets, not settlement of existing ones).
//! Helpers below are private to this file -- no cross-file test helper sharing, per
//! this wave's brief. Patterns are copied from `tests/{override,pause,create_market,
//! settle,book,mint_redeem}.rs`.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::math::ONE_USDC;
use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261006;
const CAPACITY: u16 = 16;
const SIDE_BID: u8 = 0;
const SIDE_ASK: u8 = 1;
const TIF_LIMIT: u8 = 0;

fn far_future_close_ts(env: &Env) -> i64 {
    env.now() + 3600
}

// ---- generic signer-agnostic admin instruction senders ----

fn pause_as(env: &mut Env, signer: &Keypair) -> TransactionResult {
    let accounts = meridian::accounts::SetPause {
        admin: signer.pubkey_pk(),
        config: config_pda(),
    };
    let data = meridian::instruction::Pause {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

fn unpause_as(env: &mut Env, signer: &Keypair) -> TransactionResult {
    let accounts = meridian::accounts::SetPause {
        admin: signer.pubkey_pk(),
        config: config_pda(),
    };
    let data = meridian::instruction::Unpause {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

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

// ---- oracle plumbing (mirrors tests/settle.rs) ----

fn feed_id_for(env: &Env, symbol: &str) -> [u8; 32] {
    let mut sym = [0u8; 8];
    sym[..symbol.len()].copy_from_slice(symbol.as_bytes());
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| t.symbol == sym)
        .expect("ticker should be in config")
        .feed_id
}

fn mock_price_pda(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[meridian::state::mock_price::SEED, feed_id.as_ref()], &meridian::ID).0
}

fn write_mock_price(env: &mut Env, signer: &Keypair, feed_id: [u8; 32], price: i64, publish_time: i64) -> TransactionResult {
    let accounts = meridian::accounts::MockWritePrice {
        publisher: signer.pubkey_pk(),
        config: config_pda(),
        price: mock_price_pda(&feed_id),
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MockWritePrice {
        feed_id,
        price,
        conf: 10_000,
        expo: -6,
        publish_time,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

fn settle_market_as(env: &mut Env, caller: &Keypair, market: Pubkey, price_account: Pubkey) -> TransactionResult {
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

/// Warps to `close_ts`, writes a good AAPL mock price (above every strike used in this
/// file), and settles `market`.
fn settle_with_good_price(env: &mut Env, market: Pubkey, close_ts: i64) {
    let feed_id = feed_id_for(env, "AAPL");
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, 333_000_000, close_ts).expect("mock_write_price should succeed");
    let price_account = mock_price_pda(&feed_id);
    settle_market_as(env, &admin, market, price_account).expect("settle_market should succeed");
}

// ---- user/token plumbing (mirrors tests/book.rs and tests/mint_redeem.rs) ----

fn new_user(env: &mut Env) -> Keypair {
    let user = Keypair::new();
    env.airdrop(user.pubkey_pk(), 10_000_000_000);
    user
}

fn create_usdc_ata(env: &mut Env, user: &Keypair) -> Pubkey {
    let usdc_mint_addr = addr(env.usdc_mint);
    let ata = CreateAssociatedTokenAccount::new(&mut env.svm, user, &usdc_mint_addr)
        .send()
        .expect("create user USDC ata should succeed");
    pk(ata)
}

fn mint_usdc(env: &mut Env, destination: Pubkey, amount: u64) {
    let admin = env.admin.insecure_clone();
    let usdc_mint_addr = addr(env.usdc_mint);
    let dest_addr = addr(destination);
    TokenMintTo::new(&mut env.svm, &admin, &usdc_mint_addr, &dest_addr, amount)
        .send()
        .expect("mint test USDC should succeed");
}

fn funded_user(env: &mut Env, usdc_funding: u64) -> (Keypair, Pubkey) {
    let user = new_user(env);
    let user_usdc = create_usdc_ata(env, &user);
    if usdc_funding > 0 {
        mint_usdc(env, user_usdc, usdc_funding);
    }
    (user, user_usdc)
}

fn yes_ata(user: &Keypair, market: &CreateMarketResult) -> Pubkey {
    get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID)
}

#[allow(clippy::too_many_arguments)]
fn send_mint_pair(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) -> TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::MintPair {
        user: user_pk,
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_yes: get_associated_token_address_with_program_id(&user_pk, &market.yes_mint, &anchor_spl::token_2022::ID),
        user_no: get_associated_token_address_with_program_id(&user_pk, &market.no_mint, &anchor_spl::token_2022::ID),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MintPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

#[allow(clippy::too_many_arguments)]
fn send_redeem_pair(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) -> TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::RedeemPair {
        user: user_pk,
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_yes: get_associated_token_address_with_program_id(&user_pk, &market.yes_mint, &anchor_spl::token_2022::ID),
        user_no: get_associated_token_address_with_program_id(&user_pk, &market.no_mint, &anchor_spl::token_2022::ID),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::RedeemPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

#[allow(clippy::too_many_arguments)]
fn send_place_order(
    env: &mut Env,
    user: &Keypair,
    market: &CreateMarketResult,
    user_usdc: Pubkey,
    user_yes: Pubkey,
    side: u8,
    price: u64,
    qty: u64,
    tif: u8,
) -> TransactionResult {
    let accounts = meridian::accounts::PlaceOrder {
        user: user.pubkey_pk(),
        config: config_pda(),
        market: market.market,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        user_usdc,
        yes_mint: market.yes_mint,
        user_yes,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::PlaceOrder { side, price, qty, tif };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

fn send_cancel_order(env: &mut Env, owner: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, user_yes: Pubkey, order_id: u64) -> TransactionResult {
    let accounts = meridian::accounts::CancelOrder {
        owner: owner.pubkey_pk(),
        market: market.market,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        yes_mint: market.yes_mint,
        user_usdc,
        user_yes,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
    };
    let data = meridian::instruction::CancelOrder { order_id };
    let ix = build_ix(meridian::ID, accounts, data);
    let owner_clone = owner.insecure_clone();
    env.send(&[ix], &[&owner_clone])
}

fn mint_pairs_for(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) {
    send_mint_pair(env, user, market, user_usdc, qty).expect("mint_pair should succeed");
}

/// One `Env` with an initialized config and one open, capacity-16 AAPL market, plus the
/// market's `close_ts`.
fn setup() -> (Env, CreateMarketResult, i64) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, CAPACITY))
        .expect("create_market should succeed");
    (env, market, close_ts)
}

// ==================== add_strike mid-session ====================

#[test]
fn add_strike_mid_session_by_admin_is_tradeable_and_settles_with_the_rest() {
    let (mut env, first, close_ts) = setup();

    // Warp forward (still well before close) and add a second strike to the same
    // trading day/ticker/close_ts, as the admin would do mid-session.
    let now = env.now();
    env.warp_to(now + 60);
    let second = env
        .create_market(CreateMarketArgs::new("AAPL", 110_000_000, DAY, close_ts, CAPACITY).as_add_strike())
        .expect("add_strike by admin should succeed");

    let m: Market = env.fetch(second.market);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.strike, 110_000_000);

    // Tradeable: mint_pair works on the newly added strike.
    let (user, user_usdc) = funded_user(&mut env, 10 * ONE_USDC);
    send_mint_pair(&mut env, &user, &second, user_usdc, 1).expect("mint_pair on the added strike should succeed");
    let after_mint: Market = env.fetch(second.market);
    assert_eq!(after_mint.pairs_outstanding, 1);

    // Settles with the rest on the same mock price (above both strikes -> Yes on both).
    settle_with_good_price(&mut env, first.market, close_ts);
    let settle_feed_id = feed_id_for(&env, "AAPL");
    let admin = env.admin.insecure_clone();
    settle_market_as(&mut env, &admin, second.market, mock_price_pda(&settle_feed_id)).expect("settle_market on the added strike should succeed");

    let first_after: Market = env.fetch(first.market);
    let second_after: Market = env.fetch(second.market);
    assert_eq!(first_after.state, MarketState::Settled);
    assert_eq!(second_after.state, MarketState::Settled);
    assert_eq!(first_after.outcome, Outcome::Yes);
    assert_eq!(second_after.outcome, Outcome::Yes);
}

#[test]
fn add_strike_by_non_admin_is_unauthorized() {
    let (mut env, _first, close_ts) = setup();

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let market = market_pda(b"AAPL\0\0\0\0", DAY, 110_000_000);
    let config = config_pda();
    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: stranger.pubkey_pk(),
        config,
        market,
        yes_mint: Pubkey::find_program_address(&[b"yes_mint", market.as_ref()], &meridian::ID).0,
        no_mint: Pubkey::find_program_address(&[b"no_mint", market.as_ref()], &meridian::ID).0,
        vault: Pubkey::find_program_address(&[b"vault", market.as_ref()], &meridian::ID).0,
        usdc_escrow: Pubkey::find_program_address(&[b"escrow_usdc", market.as_ref()], &meridian::ID).0,
        yes_escrow: Pubkey::find_program_address(&[b"escrow_yes", market.as_ref()], &meridian::ID).0,
        usdc_mint: env.usdc_mint,
        token_program: anchor_spl::token_2022::ID,
        usdc_token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::prelude::rent::ID,
    };
    let data = meridian::instruction::AddStrike {
        ticker: *b"AAPL\0\0\0\0",
        strike: 110_000_000,
        trading_day: DAY,
        close_ts,
        capacity: CAPACITY,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let result = env.send(&[ix], &[&payer, &stranger]);
    assert_err(&result, MeridianError::Unauthorized);
}

// ==================== pause/unpause/override authorization ====================

#[test]
fn non_admin_pause_is_unauthorized() {
    let (mut env, _market, _close_ts) = setup();
    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = pause_as(&mut env, &stranger);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn non_admin_unpause_is_unauthorized() {
    let (mut env, _market, _close_ts) = setup();
    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = unpause_as(&mut env, &stranger);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn non_admin_override_is_unauthorized() {
    let (mut env, market, close_ts) = setup();
    env.warp_to(close_ts + 3600);

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = override_as(&mut env, &stranger, market.market, 333_000_000);
    assert_err(&result, MeridianError::Unauthorized);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Open);
}

// ==================== override delay window ====================

#[test]
fn override_refused_before_delay_accepted_after_and_marks_settled_by_override() {
    let (mut env, market, close_ts) = setup();
    let admin = env.admin.insecure_clone();

    env.warp_to(close_ts + 3599);
    let too_early = override_as(&mut env, &admin, market.market, 333_000_000);
    assert_err(&too_early, MeridianError::OverrideTooEarly);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Open);

    env.warp_to(close_ts + 3600);
    override_as(&mut env, &admin, market.market, 333_000_000).expect("override at the delay boundary should succeed");

    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);
    assert_eq!(m.settlement_price, 333_000_000);
    assert!(m.settled_by_override);
}

#[test]
fn second_override_on_a_settled_market_is_already_settled() {
    let (mut env, market, close_ts) = setup();
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts + 3600);

    override_as(&mut env, &admin, market.market, 333_000_000).expect("first override should succeed");
    let before: Market = env.fetch(market.market);

    let result = override_as(&mut env, &admin, market.market, 400_000_000);
    assert_err(&result, MeridianError::AlreadySettled);

    let after: Market = env.fetch(market.market);
    assert_eq!(after.settlement_price, before.settlement_price);
    assert_eq!(after.outcome, before.outcome);
}

// ==================== pause blocks mint/place_order, not redeem/cancel ====================

#[test]
fn pause_blocks_mint_pair_and_place_order_but_not_redeem_pair_or_cancel_order_unpause_restores() {
    let (mut env, market, _close_ts) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    // Mint a pair and rest a bid before pausing, so there's something to redeem/cancel.
    mint_pairs_for(&mut env, &user, &market, user_usdc, 1);
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 1, TIF_LIMIT).expect("bid should rest before pausing");

    let admin = env.admin.insecure_clone();
    pause_as(&mut env, &admin).expect("pause should succeed");

    // mint_pair and place_order are both refused while paused.
    let mint_result = send_mint_pair(&mut env, &user, &market, user_usdc, 1);
    assert_err(&mint_result, MeridianError::Paused);

    let order_result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 600_000, 1, TIF_LIMIT);
    assert_err(&order_result, MeridianError::Paused);

    // redeem_pair and cancel_order both still work while paused.
    send_redeem_pair(&mut env, &user, &market, user_usdc, 1).expect("redeem_pair should succeed while paused");
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel_order should succeed while paused");

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0);

    // unpause restores mint_pair and place_order.
    unpause_as(&mut env, &admin).expect("unpause should succeed");
    send_mint_pair(&mut env, &user, &market, user_usdc, 1).expect("mint_pair should succeed again after unpause");
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 1, TIF_LIMIT).expect("place_order should succeed again after unpause");
}

// ==================== update_config authorization ====================

#[test]
fn non_admin_update_config_is_unauthorized() {
    let (mut env, _market, _close_ts) = setup();
    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = env.update_config_as(
        &stranger,
        UpdateConfigArgs {
            override_delay_secs: Some(7200),
            ..Default::default()
        },
    );
    assert_err(&result, MeridianError::Unauthorized);
}

// ==================== ticker disable scoping ====================

#[test]
fn disabling_a_ticker_blocks_new_create_market_but_not_settlement_of_existing_markets() {
    let (mut env, market, close_ts) = setup();

    // Disable the AAPL ticker (every other ticker stays as-is).
    let mut tickers = default_tickers();
    assert_eq!(tickers[0].symbol, *b"AAPL\0\0\0\0", "default_tickers()[0] must be AAPL");
    tickers[0].enabled = false;
    env.update_config(UpdateConfigArgs {
        tickers: Some(tickers),
        ..Default::default()
    })
    .expect("update_config disabling AAPL should succeed");

    // New create_market for the now-disabled ticker is refused.
    let blocked = env.create_market(CreateMarketArgs::new("AAPL", 999_000_000, DAY, close_ts, CAPACITY));
    assert!(blocked.is_err(), "create_market for a disabled ticker should fail");

    // Settlement of the market that already existed on this ticker still works.
    settle_with_good_price(&mut env, market.market, close_ts);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);
}
