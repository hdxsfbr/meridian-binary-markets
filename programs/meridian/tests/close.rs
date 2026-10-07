//! `close_book` / `close_market` tests (Wave 5, T081 proof).
//!
//! Covers data-model.md's close rules (admin; `Settled`; counts zero and escrows
//! empty for `close_book`; vault empty too for `close_market`; rent to admin) across
//! the happy path (zero-activity market, rent actually reclaimed), every `NotEmpty`
//! guard (resting order, escrow surplus, book not yet closed, unredeemed vault),
//! `MarketNotSettled`, `Unauthorized`, and a full mint/settle/redeem lifecycle. All
//! helpers below are private to this file (no cross-file test helper sharing, per this
//! wave's brief).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::Space;
use anchor_spl::associated_token::get_associated_token_address;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo, Transfer as TokenTransfer};
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::state::book::book_space;
use meridian::state::market::{Market, MarketState};

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

/// Raw SPL token account `amount` field (bytes 64..72); plain SPL accounts have no
/// Anchor discriminator, so `Env::fetch`'s Anchor deserialization doesn't apply (same
/// approach as `tests/mint_redeem.rs`'s private copy of this helper).
fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env
        .svm
        .get_account(&addr(account))
        .unwrap_or_else(|| panic!("token account {account} missing"));
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
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
        user_yes: get_associated_token_address(&user_pk, &market.yes_mint),
        user_no: get_associated_token_address(&user_pk, &market.no_mint),
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MintPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

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
        user_yes: get_associated_token_address(&user_pk, &market.yes_mint),
        user_no: get_associated_token_address(&user_pk, &market.no_mint),
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::RedeemPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

#[allow(clippy::too_many_arguments)]
fn send_redeem_winning(
    env: &mut Env,
    user: &Keypair,
    market: &CreateMarketResult,
    user_usdc: Pubkey,
    user_winning: Pubkey,
    side: u8,
    qty: u64,
) -> TransactionResult {
    let accounts = meridian::accounts::RedeemWinning {
        user: user.pubkey_pk(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_winning,
        token_program: anchor_spl::token::ID,
    };
    let data = meridian::instruction::RedeemWinning { side, qty };
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
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::PlaceOrder { side, price, qty, tif };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

fn send_cancel_order(
    env: &mut Env,
    owner: &Keypair,
    market: &CreateMarketResult,
    user_usdc: Pubkey,
    user_yes: Pubkey,
    order_id: u64,
) -> TransactionResult {
    let accounts = meridian::accounts::CancelOrder {
        owner: owner.pubkey_pk(),
        market: market.market,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        user_usdc,
        user_yes,
        token_program: anchor_spl::token::ID,
    };
    let data = meridian::instruction::CancelOrder { order_id };
    let ix = build_ix(meridian::ID, accounts, data);
    let owner_clone = owner.insecure_clone();
    env.send(&[ix], &[&owner_clone])
}

fn close_accounts(market: &CreateMarketResult, admin: Pubkey) -> meridian::accounts::CloseAccounts {
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
        token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
    }
}

fn send_close_book_as(env: &mut Env, signer: &Keypair, market: &CreateMarketResult) -> TransactionResult {
    let accounts = close_accounts(market, signer.pubkey_pk());
    let data = meridian::instruction::CloseBook {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

fn send_close_market_as(env: &mut Env, signer: &Keypair, market: &CreateMarketResult) -> TransactionResult {
    let accounts = close_accounts(market, signer.pubkey_pk());
    let data = meridian::instruction::CloseMarket {};
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
/// `create_book` at all -- so `market.book` stays `Pubkey::default()` and the Book PDA
/// itself does not exist (owned by the system program, zero lamports/data). Models an
/// "unfinished book" market for the `close_book`/`close_market` "Unfinished books" fix
/// (Wave 5 review, 2026-10-06; see `instructions/close.rs`'s module doc comment).
/// Private copy of `Env::create_market`'s account derivation, minus its `create_book`
/// loop (no cross-file test helper sharing, per this file's brief).
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
        token_program: anchor_spl::token::ID,
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

/// Returns `true` if the account is gone (per data-model.md's close rules: absent, or
/// present with zero data owned by the system program -- litesvm may or may not prune a
/// zero-lamport account from its account store, and either is a correct "closed").
fn account_is_closed(env: &Env, pubkey: Pubkey) -> bool {
    match env.svm.get_account(&addr(pubkey)) {
        None => true,
        Some(acc) => acc.owner == addr(anchor_lang::system_program::ID) && acc.data.is_empty(),
    }
}

#[test]
fn close_book_then_close_market_succeed_on_zero_activity_market_and_reclaim_rent() {
    let (mut env, market, close_ts) = setup(100_000_000);
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let book_rent = env.svm.minimum_balance_for_rent_exemption(book_space(CAPACITY));
    let token_account_rent = env.svm.minimum_balance_for_rent_exemption(165); // spl_token::state::Account::LEN
    let market_rent = env.svm.minimum_balance_for_rent_exemption(8 + Market::INIT_SPACE);
    let expected_rent = book_rent + 3 * token_account_rent + market_rent;

    let admin = env.admin.insecure_clone();
    let admin_before = env.balance(admin.pubkey_pk()).expect("admin should exist");

    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed");

    let m: Market = env.fetch(market.market);
    assert_eq!(m.book, Pubkey::default(), "close_book should reset market.book");

    send_close_market_as(&mut env, &admin, &market).expect("close_market should succeed");

    let admin_after = env.balance(admin.pubkey_pk()).expect("admin should still exist");
    let reclaimed = admin_after - admin_before;

    // Approximately the summed rent of the five closed accounts, minus the (small,
    // fixed-fee) cost of the two transactions that did the closing.
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
}

#[test]
fn close_book_on_open_market_is_refused() {
    let (mut env, market, _close_ts) = setup(100_000_000);
    let admin = env.admin.insecure_clone();

    let result = send_close_book_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::MarketNotSettled);
}

#[test]
fn close_book_with_resting_order_is_refused_until_cancelled() {
    let (mut env, market, close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    let user_yes = get_associated_token_address(&user.pubkey_pk(), &market.yes_mint);

    let meta = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 2, TIF_LIMIT)
        .expect("place_order should succeed");
    // Order id is always 1, the first ever assigned to a fresh book.
    let order_id = 1u64;
    let _ = meta;

    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let admin = env.admin.insecure_clone();
    let result = send_close_book_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);

    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, order_id).expect("cancel_order should succeed");

    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed after cancelling the resting order");
}

#[test]
fn close_book_with_escrow_surplus_is_refused() {
    let (mut env, market, close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 1);

    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    // Unsolicited direct deposit of 1 base unit into the USDC escrow, bypassing
    // `place_order` entirely -- the book's own counts stay zero, but the escrow is not.
    TokenTransfer::new(&mut env.svm, &user, &addr(env.usdc_mint), &addr(market.usdc_escrow), 1)
        .owner(&user)
        .source(&addr(user_usdc))
        .send()
        .expect("direct transfer into the escrow should succeed");

    let admin = env.admin.insecure_clone();
    let result = send_close_book_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);
}

#[test]
fn close_market_before_close_book_is_refused() {
    let (mut env, market, close_ts) = setup(100_000_000);
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let admin = env.admin.insecure_clone();
    let result = send_close_market_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);
}

#[test]
fn close_market_with_vault_nonempty_is_refused() {
    let (mut env, market, close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    send_mint_pair(&mut env, &user, &market, user_usdc, 1).expect("mint_pair should succeed");

    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let admin = env.admin.insecure_clone();
    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed (book was never touched)");

    let result = send_close_market_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);
}

#[test]
fn close_book_then_close_market_succeed_on_an_unfinished_book_market() {
    // `create_market` only -- `create_book` never ran, so `market.book ==
    // Pubkey::default()` and the Book PDA itself does not exist yet. `close_book` must
    // still succeed (there's nothing to empty-check: an unfinished book can hold no
    // live order) and reclaim the escrows `create_market` already made; `close_market`
    // must then succeed too (Wave 5 review fix, 2026-10-06).
    let (mut env, market, close_ts) = setup_with_unfinished_book(100_000_000);
    assert!(
        env.svm.get_account(&addr(market.book)).is_none(),
        "the Book PDA should not exist before create_book ever ran"
    );

    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.book, Pubkey::default());
    assert!(!m.book_closed);

    let admin = env.admin.insecure_clone();
    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed on an unfinished book");

    assert!(account_is_closed(&env, market.usdc_escrow), "escrows from create_market should be reclaimed");
    assert!(account_is_closed(&env, market.yes_escrow));

    let m: Market = env.fetch(market.market);
    assert!(m.book_closed, "close_book should set book_closed");
    assert_eq!(m.book, Pubkey::default());

    send_close_market_as(&mut env, &admin, &market).expect("close_market should succeed after close_book");
    assert!(account_is_closed(&env, market.market));
}

#[test]
fn close_market_with_unfinished_book_not_yet_closed_is_refused() {
    // Same unfinished-book market, but `close_book` never ran: `book_closed` is still
    // false and the escrows are still open. `close_market` must be refused on the flag
    // alone, the same `NotEmpty` shape as every other "something still needs
    // emptying/closing" guard.
    let (mut env, market, close_ts) = setup_with_unfinished_book(100_000_000);
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let m: Market = env.fetch(market.market);
    assert!(!m.book_closed);
    assert!(read_token_amount(&env, market.usdc_escrow) == 0); // untouched, just open
    assert!(env.svm.get_account(&addr(market.usdc_escrow)).is_some(), "escrow should still exist");

    let admin = env.admin.insecure_clone();
    let result = send_close_market_as(&mut env, &admin, &market);
    assert_err(&result, MeridianError::NotEmpty);
}

#[test]
fn close_book_by_non_admin_is_refused() {
    let (mut env, market, close_ts) = setup(100_000_000);
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let not_admin = new_user(&mut env);
    let result = send_close_book_as(&mut env, &not_admin, &market);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn full_lifecycle_mint_settle_redeem_winning_and_redeem_pair_then_both_closes_succeed() {
    let (mut env, market, close_ts) = setup(100_000_000);

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    send_mint_pair(&mut env, &user, &market, user_usdc, 3).expect("mint_pair should succeed");

    // Settles Yes (price above strike).
    settle_with_price(&mut env, market.market, close_ts, 150_000_000);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);

    let user_yes = get_associated_token_address(&user.pubkey_pk(), &market.yes_mint);
    send_redeem_winning(&mut env, &user, &market, user_usdc, user_yes, 1, 2)
        .expect("redeem_winning should succeed post-settlement");

    send_redeem_pair(&mut env, &user, &market, user_usdc, 1).expect("redeem_pair should succeed post-settlement");

    assert_eq!(read_token_amount(&env, market.vault), 0, "vault should be fully drained");

    let admin = env.admin.insecure_clone();
    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed");
    send_close_market_as(&mut env, &admin, &market).expect("close_market should succeed");

    assert!(account_is_closed(&env, market.market));
}
