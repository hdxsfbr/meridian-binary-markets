//! `remove_strike` tests (PRD FR-10 "adjust strikes").
//!
//! Covers `instructions/close.rs`'s `handle_remove_strike` guards (admin; `Open`;
//! `pairs_outstanding == 0`; both mint supplies `== 0`; book empty/unfinished; escrows
//! empty; vault empty) and its effect (everything closed, rent to admin, and the
//! `(ticker, trading_day, strike)` PDA seeds free for a later `create_market` call).
//! All helpers below are private to this file (no cross-file test helper sharing, per
//! the existing `tests/close.rs` convention this file follows).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::state::book::book_space;
use meridian::state::market::Market;

use common::*;

const DAY: u32 = 20261007;
const CAPACITY: u16 = 16;
const SIDE_BID: u8 = 0;
const TIF_LIMIT: u8 = 0;

fn far_future_close_ts(env: &Env) -> i64 {
    env.now() + 3600
}

/// A fresh funded (SOL) user keypair.
fn new_user(env: &mut Env) -> Keypair {
    let user = Keypair::new();
    env.airdrop(user.pubkey_pk(), 10_000_000_000);
    user
}

/// Creates `user`'s USDC associated token account (payer = owner = `user`).
fn create_usdc_ata(env: &mut Env, user: &Keypair) -> Pubkey {
    let usdc_mint_addr = addr(env.usdc_mint);
    let ata = CreateAssociatedTokenAccount::new(&mut env.svm, user, &usdc_mint_addr)
        .send()
        .expect("create user USDC ata should succeed");
    pk(ata)
}

/// Mints `amount` test USDC into `destination`, signed by `admin`.
fn mint_usdc(env: &mut Env, destination: Pubkey, amount: u64) {
    let admin = env.admin.insecure_clone();
    let usdc_mint_addr = addr(env.usdc_mint);
    let dest_addr = addr(destination);
    TokenMintTo::new(&mut env.svm, &admin, &usdc_mint_addr, &dest_addr, amount)
        .send()
        .expect("mint test USDC should succeed");
}

fn aapl_feed_id(env: &Env) -> [u8; 32] {
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| &t.symbol == b"AAPL\0\0\0\0")
        .expect("AAPL ticker should be enabled")
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
) -> TransactionResult {
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

/// Warps to `close_ts`, writes a mock price for AAPL, and settles `market`.
fn settle_with_price(env: &mut Env, market: Pubkey, close_ts: i64, price_micro: i64) {
    let feed_id = aapl_feed_id(env);
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, price_micro, 10_000, -6, close_ts)
        .expect("mock_write_price should succeed");
    settle_market_as(env, &admin, market, mock_price_pda(&feed_id)).expect("settle_market should succeed");
}

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

fn remove_strike_accounts(market: &CreateMarketResult, admin: Pubkey) -> meridian::accounts::CloseAccounts {
    meridian::accounts::CloseAccounts {
        admin,
        config: config_pda(),
        market: market.market,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        vault: market.vault,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        system_program: anchor_lang::system_program::ID,
    }
}

fn send_remove_strike_as(env: &mut Env, signer: &Keypair, market: &CreateMarketResult) -> TransactionResult {
    let accounts = remove_strike_accounts(market, signer.pubkey_pk());
    let data = meridian::instruction::RemoveStrike {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

/// Sets up one `Env` with an initialized config and one open AAPL market at `strike`,
/// book capacity `CAPACITY`.
fn setup(strike: u64) -> (Env, CreateMarketResult, i64) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", strike, DAY, close_ts, CAPACITY))
        .expect("create_market should succeed");
    (env, market, close_ts)
}

/// Like `setup`, but sends only the raw `create_market` instruction -- never calling
/// `create_book` -- so `market.book` stays `Pubkey::default()` and the Book PDA itself
/// does not exist. Private copy of `tests/close.rs`'s identically named helper.
fn setup_with_unfinished_book(strike: u64) -> (Env, CreateMarketResult, i64) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let ticker = *b"AAPL\0\0\0\0";
    let config = config_pda();
    let market = market_pda(&ticker, DAY, strike);
    let yes_mint = Pubkey::find_program_address(&[b"yes_mint", market.as_ref()], &meridian::ID).0;
    let no_mint = Pubkey::find_program_address(&[b"no_mint", market.as_ref()], &meridian::ID).0;
    let vault = Pubkey::find_program_address(&[b"vault", market.as_ref()], &meridian::ID).0;
    let usdc_escrow = Pubkey::find_program_address(&[b"escrow_usdc", market.as_ref()], &meridian::ID).0;
    let yes_escrow = Pubkey::find_program_address(&[b"escrow_yes", market.as_ref()], &meridian::ID).0;
    let book = book_pda(market);

    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: env.admin.pubkey_pk(),
        config,
        market,
        yes_mint,
        no_mint,
        vault,
        usdc_escrow,
        yes_escrow,
        usdc_mint: env.usdc_mint,
        token_program: anchor_spl::token_2022::ID,
        usdc_token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::prelude::rent::ID,
    };
    let data = meridian::instruction::CreateMarket {
        ticker,
        strike,
        trading_day: DAY,
        close_ts,
        capacity: CAPACITY,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");

    let result = CreateMarketResult {
        market,
        yes_mint,
        no_mint,
        vault,
        usdc_escrow,
        yes_escrow,
        book,
    };
    (env, result, close_ts)
}

/// Returns `true` if the account is gone (absent, or present with zero data owned by
/// the system program).
fn account_is_closed(env: &Env, pubkey: Pubkey) -> bool {
    match env.svm.get_account(&addr(pubkey)) {
        None => true,
        Some(acc) => acc.owner == addr(anchor_lang::system_program::ID) && acc.data.is_empty(),
    }
}

#[test]
fn remove_strike_on_zero_activity_market_closes_everything_and_reclaims_rent_then_create_market_succeeds_again() {
    let (mut env, market, _close_ts) = setup(100_000_000);

    let book_rent = env.svm.minimum_balance_for_rent_exemption(book_space(CAPACITY));
    let token_account_rent = env.svm.minimum_balance_for_rent_exemption(165); // spl_token::state::Account::LEN
    let market_rent = env.svm.minimum_balance_for_rent_exemption(8 + <Market as anchor_lang::Space>::INIT_SPACE);
    let yes_mint_rent = env.balance(market.yes_mint).expect("yes_mint should exist before remove_strike");
    let no_mint_rent = env.balance(market.no_mint).expect("no_mint should exist before remove_strike");
    let expected_rent = book_rent + 3 * token_account_rent + market_rent + yes_mint_rent + no_mint_rent;

    let admin = env.admin.insecure_clone();
    let admin_before = env.balance(admin.pubkey_pk()).expect("admin should exist");

    send_remove_strike_as(&mut env, &admin, &market).expect("remove_strike should succeed on a zero-activity market");

    let admin_after = env.balance(admin.pubkey_pk()).expect("admin should still exist");
    let reclaimed = admin_after - admin_before;
    assert!(
        reclaimed <= expected_rent,
        "reclaimed {reclaimed} should not exceed gross rent {expected_rent}"
    );
    assert!(
        reclaimed + 50_000 >= expected_rent,
        "reclaimed {reclaimed} should be within fees of gross rent {expected_rent}"
    );

    assert!(account_is_closed(&env, market.book));
    assert!(account_is_closed(&env, market.usdc_escrow));
    assert!(account_is_closed(&env, market.yes_escrow));
    assert!(account_is_closed(&env, market.vault));
    assert!(account_is_closed(&env, market.market));
    assert!(account_is_closed(&env, market.yes_mint), "zero-supply Token-2022 yes_mint should be closed too");
    assert!(account_is_closed(&env, market.no_mint), "zero-supply Token-2022 no_mint should be closed too");

    // The (ticker, trading_day, strike) PDA seeds are free again: create_market should
    // succeed a second time at the exact same strike.
    let close_ts2 = far_future_close_ts(&env);
    env.create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts2, CAPACITY))
        .expect("create_market should succeed again on the same seeds after remove_strike");
}

#[test]
fn remove_strike_is_refused_once_a_pair_has_been_minted() {
    let (mut env, market, _close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    send_mint_pair(&mut env, &user, &market, user_usdc, 1).expect("mint_pair should succeed");

    let admin = env.admin.insecure_clone();
    let result = send_remove_strike_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::StrikeInUse);
}

#[test]
fn remove_strike_is_refused_while_an_order_rests_on_the_book() {
    let (mut env, market, _close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    let user_yes = get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 2, TIF_LIMIT)
        .expect("place_order should succeed");

    let admin = env.admin.insecure_clone();
    let result = send_remove_strike_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);
}

#[test]
fn remove_strike_is_refused_on_a_settled_market() {
    let (mut env, market, close_ts) = setup(100_000_000);
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let admin = env.admin.insecure_clone();
    let result = send_remove_strike_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::MarketSettled);
}

#[test]
fn remove_strike_by_non_admin_is_refused() {
    let (mut env, market, _close_ts) = setup(100_000_000);

    let not_admin = new_user(&mut env);
    let result = send_remove_strike_as(&mut env, &not_admin, &market);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn remove_strike_succeeds_on_a_market_whose_create_book_never_finished() {
    let (mut env, market, _close_ts) = setup_with_unfinished_book(100_000_000);
    assert!(
        env.svm.get_account(&addr(market.book)).is_none(),
        "the Book PDA should not exist before create_book ever ran"
    );

    let admin = env.admin.insecure_clone();
    send_remove_strike_as(&mut env, &admin, &market).expect("remove_strike should succeed on an unfinished book");

    assert!(account_is_closed(&env, market.usdc_escrow));
    assert!(account_is_closed(&env, market.yes_escrow));
    assert!(account_is_closed(&env, market.vault));
    assert!(account_is_closed(&env, market.market));
}
