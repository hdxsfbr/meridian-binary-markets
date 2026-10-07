//! `place_order` / `cancel_order` tests (Wave 4B, T048 proof).
//!
//! Covers the Book's sort/escrow invariants (data-model.md "Book") across limit and
//! IOC orders, crossing fills at the maker's price, FR-010 arrival-order ties, the
//! 8-fill cap, `BookFull`, cancellation (including while paused and post-settlement),
//! and the adversarial `remaining_accounts` case.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_instruction::account_meta::AccountMeta as SdkAccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::math::ONE_USDC;
use meridian::state::book::{asks_mut, bids_mut, read_header};
use meridian::state::market::{Market, MarketState};

use common::*;

const DAY: u32 = 20261007;
const CAPACITY: u16 = 16;

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

/// Builds and sends a `mint_pair(qty)` instruction for `user` against `market`, so the
/// user holds Yes/No tokens to place asks with or receive from fills.
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

/// Converts Anchor's `AccountMeta`s to litesvm/`solana_instruction`'s `AccountMeta`
/// type (private copy of `common::to_sdk_metas`, which is not `pub`; see this file's
/// brief: no cross-file test helper sharing).
fn to_sdk_metas(metas: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<SdkAccountMeta> {
    metas
        .into_iter()
        .map(|m| SdkAccountMeta {
            pubkey: addr(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}

/// Builds and sends a `place_order(side, price, qty, tif)` instruction, appending
/// `remaining` as the makers' receiving token accounts (writable, non-signer), in
/// order.
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
    remaining: &[Pubkey],
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
    let data = meridian::instruction::PlaceOrder { side, price, qty, tif }.data();
    let mut metas = to_sdk_metas(accounts.to_account_metas(None));
    for r in remaining {
        metas.push(SdkAccountMeta {
            pubkey: addr(*r),
            is_signer: false,
            is_writable: true,
        });
    }
    let ix = Instruction {
        program_id: addr(meridian::ID),
        accounts: metas,
        data,
    };
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

/// Builds and sends a `cancel_order(order_id)` instruction, signed by `owner`.
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

/// Calls `pause()`/`unpause()`, signed by `signer` (private copy, see `send_mint_pair`'s
/// doc comment: no cross-file test helper sharing).
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

/// This market's AAPL feed id (private copy; see `pause_as`'s doc comment).
fn aapl_feed_id(env: &Env) -> [u8; 32] {
    let cfg: meridian::state::config::Config = env.fetch(config_pda());
    cfg.tickers
        .iter()
        .find(|t| &t.symbol == b"AAPL\0\0\0\0")
        .expect("AAPL ticker should be enabled")
        .feed_id
}

fn mock_price_pda(feed_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[meridian::state::mock_price::SEED, feed_id.as_ref()], &meridian::ID).0
}

fn write_mock_price(env: &mut Env, signer: &Keypair, feed_id: [u8; 32], price: i64, conf: u64, expo: i32, publish_time: i64) -> TransactionResult {
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

/// Warps to `close_ts`, writes a good AAPL mock price, and settles `market`.
fn settle_with_good_price(env: &mut Env, market: Pubkey, close_ts: i64) {
    let feed_id = aapl_feed_id(env);
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, 333_000_000, 10_000, -6, close_ts).expect("mock_write_price should succeed");
    let price_account = mock_price_pda(&feed_id);
    settle_market_as(env, &admin, market, price_account).expect("settle_market should succeed");
}

/// One `Env` with an initialized config and one open, capacity-16 market.
fn setup() -> (Env, CreateMarketResult) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, CAPACITY))
        .expect("create_market should succeed");
    (env, market)
}

/// A fresh user with `usdc_funding` test USDC already in their own ATA.
fn funded_user(env: &mut Env, usdc_funding: u64) -> (Keypair, Pubkey) {
    let user = new_user(env);
    let user_usdc = create_usdc_ata(env, &user);
    if usdc_funding > 0 {
        mint_usdc(env, user_usdc, usdc_funding);
    }
    (user, user_usdc)
}

/// Mints `qty` pairs for `user` (so they hold Yes/No to place asks or receive fills
/// with), given they already hold at least `qty * ONE_USDC` in `user_usdc`.
fn mint_pairs_for(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) {
    send_mint_pair(env, user, market, user_usdc, qty).expect("mint_pair should succeed");
}

fn yes_ata(user: &Keypair, market: &CreateMarketResult) -> Pubkey {
    get_associated_token_address(&user.pubkey_pk(), &market.yes_mint)
}

/// Re-derives the book's expected escrow totals from its own live orders and asserts
/// they match the escrow token accounts' actual balances (data-model.md "Book").
fn assert_escrow_invariants(env: &Env, market: &CreateMarketResult) {
    let account = env.svm.get_account(&addr(market.book)).expect("book account should exist");
    let mut data = account.data.clone();
    let header = read_header(&data).expect("book header should validate");
    let capacity = header.capacity;

    let bid_total: u64 = {
        let bids = bids_mut(&mut data, capacity).expect("bids slice");
        bids[..header.bid_count as usize]
            .iter()
            .map(|o| o.price * o.remaining)
            .sum()
    };
    let ask_total: u64 = {
        let asks = asks_mut(&mut data, capacity).expect("asks slice");
        asks[..header.ask_count as usize].iter().map(|o| o.remaining * 1_000_000).sum()
    };

    // `>=`, not `==` (Wave 4 review fix): the invariant tolerates unsolicited deposits
    // straight into an escrow token account -- see `assert_escrow_invariants_tolerate_a_direct_deposit_into_escrow`.
    assert!(
        read_token_amount(env, market.usdc_escrow) >= bid_total,
        "usdc_escrow invariant violated: want >= {bid_total}, got {}",
        read_token_amount(env, market.usdc_escrow)
    );
    assert!(
        read_token_amount(env, market.yes_escrow) >= ask_total,
        "yes_escrow invariant violated: want >= {ask_total}, got {}",
        read_token_amount(env, market.yes_escrow)
    );
}

/// Directly bumps a raw SPL token account's `amount` field (bytes 64..72) by `delta`,
/// bypassing any mint/transfer CPI entirely -- used to simulate an unsolicited deposit
/// landing straight in an escrow token account (e.g. sent by mistake, or by some other
/// program), which the escrow invariant must tolerate (Wave 4 review fix 2).
fn bump_token_amount(env: &mut Env, account: Pubkey, delta: u64) {
    let address = addr(account);
    let mut acc = env.svm.get_account(&address).expect("token account should exist");
    let current = u64::from_le_bytes(acc.data[64..72].try_into().unwrap());
    let new_amount = current.checked_add(delta).expect("test amount should not overflow");
    acc.data[64..72].copy_from_slice(&new_amount.to_le_bytes());
    env.svm.set_account(address, acc).expect("set_account should succeed");
}

const SIDE_BID: u8 = 0;
const SIDE_ASK: u8 = 1;
const TIF_LIMIT: u8 = 0;
const TIF_IOC: u8 = 1;

#[test]
fn limit_bid_escrows_price_times_qty_and_appears_sorted() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[])
        .expect("limit bid should rest");

    assert_eq!(read_token_amount(&env, market.usdc_escrow), 650_000 * 4);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 1);
    assert_eq!(header.ask_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn limit_ask_escrows_qty_yes() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &user, &market, user_usdc, 3);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 700_000, 3, TIF_LIMIT, &[])
        .expect("limit ask should rest");

    assert_eq!(read_token_amount(&env, market.yes_escrow), 3 * ONE_USDC);
    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 1);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn crossing_bid_fills_at_makers_price_and_refunds_limit_difference() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 5);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker ask should rest");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);
    let taker_usdc_before = read_token_amount(&env, taker_usdc);

    let meta = send_place_order(
        &mut env,
        &taker,
        &market,
        taker_usdc,
        taker_yes,
        SIDE_BID,
        650_000,
        5,
        TIF_LIMIT,
        &[maker_usdc],
    )
    .expect("crossing bid should fill");

    // Filled at the maker's price (600_000), not the taker's limit (650_000).
    assert_eq!(read_token_amount(&env, maker_usdc), 10_000 * ONE_USDC - 5 * ONE_USDC + 600_000 * 5);
    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before - 600_000 * 5);
    assert_eq!(read_token_amount(&env, taker_yes), 5 * ONE_USDC);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0, "fully filled bid should not rest");
    assert_eq!(header.ask_count, 0, "fully consumed maker ask should be removed");

    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected Program data log lines for OrderPlaced/Fill, got:\n{}",
        meta.logs.join("\n")
    );
    assert_escrow_invariants(&env, &market);
}

#[test]
fn equal_price_makers_fill_in_arrival_order() {
    let (mut env, market) = setup();

    let (maker1, maker1_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker1, &market, maker1_usdc, 2);
    let maker1_yes = yes_ata(&maker1, &market);
    send_place_order(&mut env, &maker1, &market, maker1_usdc, maker1_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[])
        .expect("maker1 ask should rest");

    let (maker2, maker2_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker2, &market, maker2_usdc, 2);
    let maker2_yes = yes_ata(&maker2, &market);
    send_place_order(&mut env, &maker2, &market, maker2_usdc, maker2_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[])
        .expect("maker2 ask should rest");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    // Needs 3: maker1 (arrived first) should be filled in full (2), maker2 only 1.
    send_place_order(
        &mut env,
        &taker,
        &market,
        taker_usdc,
        taker_yes,
        SIDE_BID,
        500_000,
        3,
        TIF_IOC,
        &[maker1_usdc, maker2_usdc],
    )
    .expect("ioc bid should partially fill both makers");

    assert_eq!(read_token_amount(&env, maker1_usdc), 10_000 * ONE_USDC - 2 * ONE_USDC + 500_000 * 2);
    assert_eq!(read_token_amount(&env, maker2_usdc), 10_000 * ONE_USDC - 2 * ONE_USDC + 500_000 * 1);

    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 1, "maker1 fully consumed, maker2 partially rests");
    assert_escrow_invariants(&env, &market);
}

#[test]
fn taker_needing_nine_fills_limit_rests_the_remainder() {
    let (mut env, market) = setup();

    let mut maker_usdcs = Vec::new();
    for _ in 0..9 {
        let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
        mint_pairs_for(&mut env, &maker, &market, maker_usdc, 1);
        let maker_yes = yes_ata(&maker, &market);
        send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 500_000, 1, TIF_LIMIT, &[])
            .expect("maker ask should rest");
        maker_usdcs.push(maker_usdc);
    }

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    let meta = send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 500_000, 9, TIF_LIMIT, &maker_usdcs)
        .expect("limit bid needing 9 fills should fill 8 and rest 1");

    eprintln!("place_order 8-fill compute units consumed: {}", meta.compute_units_consumed);

    assert_eq!(read_token_amount(&env, taker_yes), 8 * ONE_USDC, "exactly 8 fills applied");

    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 1, "the 9th maker (uncrossed-against) should still rest");
    assert_eq!(header.bid_count, 1, "the taker's unfilled 1 unit should rest as a resting bid");
    assert_escrow_invariants(&env, &market);
}

#[test]
fn taker_needing_nine_fills_ioc_refunds_the_remainder() {
    let (mut env, market) = setup();

    let mut maker_usdcs = Vec::new();
    for _ in 0..9 {
        let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
        mint_pairs_for(&mut env, &maker, &market, maker_usdc, 1);
        let maker_yes = yes_ata(&maker, &market);
        send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 500_000, 1, TIF_LIMIT, &[])
            .expect("maker ask should rest");
        maker_usdcs.push(maker_usdc);
    }

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);
    let taker_usdc_before = read_token_amount(&env, taker_usdc);

    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 500_000, 9, TIF_IOC, &maker_usdcs)
        .expect("ioc bid needing 9 fills should fill 8 and refund 1");

    assert_eq!(read_token_amount(&env, taker_yes), 8 * ONE_USDC);
    // Spent exactly 8 * price; the 9th unit's escrow (500_000) was refunded, not kept.
    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before - 500_000 * 8);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0, "IOC never rests");
    assert_eq!(header.ask_count, 1);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn seventeenth_resting_bid_at_capacity_is_bookfull_and_takes_no_funds() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 1_000_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    for i in 0..CAPACITY {
        let price = 1 + i as u64; // distinct prices, all non-crossing (no asks exist)
        send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, price, 1, TIF_LIMIT, &[])
            .unwrap_or_else(|e| panic!("bid {i} should rest: {e:?}"));
    }

    let usdc_before = read_token_amount(&env, user_usdc);
    let escrow_before = read_token_amount(&env, market.usdc_escrow);

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 1000, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::BookFull);

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before, "no funds should move on a rejected BookFull order");
    assert_eq!(read_token_amount(&env, market.usdc_escrow), escrow_before);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, CAPACITY);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn price_zero_is_price_out_of_range() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 0, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::PriceOutOfRange);
}

#[test]
fn price_one_million_is_price_out_of_range() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 1_000_000, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::PriceOutOfRange);
}

#[test]
fn zero_quantity_is_refused() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 0, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::ZeroQuantity);
}

#[test]
fn place_order_while_paused_is_refused() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    let admin = env.admin.insecure_clone();
    pause_as(&mut env, &admin).expect("pause should succeed");

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::Paused);
}

#[test]
fn place_order_on_a_settled_market_is_refused() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    let m: Market = env.fetch(market.market);
    settle_with_good_price(&mut env, market.market, m.close_ts);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);

    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::MarketSettled);
}

#[test]
fn wrong_maker_account_in_remaining_accounts_fails_and_changes_nothing() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 5);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker ask should rest");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    // A stranger's USDC account, not the maker's -- owner mismatch.
    let (stranger, stranger_usdc) = funded_user(&mut env, 0);
    let _ = stranger; // keep alive; only its ATA address is used below

    let taker_usdc_before = read_token_amount(&env, taker_usdc);
    let maker_usdc_before = read_token_amount(&env, maker_usdc);
    let escrow_usdc_before = read_token_amount(&env, market.usdc_escrow);
    let escrow_yes_before = read_token_amount(&env, market.yes_escrow);

    let result = send_place_order(
        &mut env,
        &taker,
        &market,
        taker_usdc,
        taker_yes,
        SIDE_BID,
        650_000,
        5,
        TIF_LIMIT,
        &[stranger_usdc],
    );
    assert!(result.is_err(), "a wrong maker account should fail the whole transaction");

    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before, "taker's escrow deposit should have rolled back too");
    assert_eq!(read_token_amount(&env, maker_usdc), maker_usdc_before);
    assert_eq!(read_token_amount(&env, market.usdc_escrow), escrow_usdc_before);
    assert_eq!(read_token_amount(&env, market.yes_escrow), escrow_yes_before);

    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 1, "maker's resting ask should be untouched");
    assert_eq!(header.bid_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn cancel_refunds_exact_bid_escrow() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[]).expect("bid should rest");
    let usdc_before = read_token_amount(&env, user_usdc);

    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel should succeed");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 650_000 * 4);
    assert_eq!(read_token_amount(&env, market.usdc_escrow), 0);
    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn cancel_refunds_exact_ask_escrow() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &user, &market, user_usdc, 3);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 700_000, 3, TIF_LIMIT, &[]).expect("ask should rest");
    let yes_before = read_token_amount(&env, user_yes);

    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel should succeed");

    assert_eq!(read_token_amount(&env, user_yes), yes_before + 3 * ONE_USDC);
    assert_eq!(read_token_amount(&env, market.yes_escrow), 0);
    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn cancel_works_while_paused() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[]).expect("bid should rest");

    let admin = env.admin.insecure_clone();
    pause_as(&mut env, &admin).expect("pause should succeed");

    let usdc_before = read_token_amount(&env, user_usdc);
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel should succeed while paused");
    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 650_000 * 4);
}

#[test]
fn cancel_works_after_settlement() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[]).expect("bid should rest");

    let m: Market = env.fetch(market.market);
    settle_with_good_price(&mut env, market.market, m.close_ts);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);

    let usdc_before = read_token_amount(&env, user_usdc);
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel should succeed after settlement");
    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 650_000 * 4);
}

#[test]
fn cancel_someone_elses_order_is_unauthorized() {
    let (mut env, market) = setup();
    let (owner, owner_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let owner_yes = yes_ata(&owner, &market);
    send_place_order(&mut env, &owner, &market, owner_usdc, owner_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[]).expect("bid should rest");

    let (stranger, stranger_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    // `cancel_order`'s `user_yes` is not `init_if_needed` (unlike `place_order`'s), so
    // the stranger needs a real Yes ATA to even reach the handler's ownership check.
    mint_pairs_for(&mut env, &stranger, &market, stranger_usdc, 1);
    let stranger_yes = yes_ata(&stranger, &market);

    let result = send_cancel_order(&mut env, &stranger, &market, stranger_usdc, stranger_yes, 1);
    assert_err(&result, MeridianError::Unauthorized);

    // Untouched: the order still rests, still escrowed.
    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 1);
    assert_eq!(read_token_amount(&env, market.usdc_escrow), 650_000 * 4);
}

#[test]
fn escrow_invariants_hold_after_a_sequence_of_operations() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 10);
    let maker_yes = yes_ata(&maker, &market);

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 600_000, 6, TIF_LIMIT, &[]).expect("ask 1");
    assert_escrow_invariants(&env, &market);

    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 500_000, 2, TIF_LIMIT, &[]).expect("bid 1 rests (no cross)");
    assert_escrow_invariants(&env, &market);

    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 650_000, 3, TIF_LIMIT, &[maker_usdc])
        .expect("bid 2 crosses the ask");
    assert_escrow_invariants(&env, &market);

    send_cancel_order(&mut env, &taker, &market, taker_usdc, taker_yes, 2).expect("cancel the resting bid 1");
    assert_escrow_invariants(&env, &market);

    send_cancel_order(&mut env, &maker, &market, maker_usdc, maker_yes, 1).expect("cancel the remainder of the ask");
    assert_escrow_invariants(&env, &market);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0);
    assert_eq!(header.ask_count, 0);
    assert_eq!(read_token_amount(&env, market.usdc_escrow), 0);
    assert_eq!(read_token_amount(&env, market.yes_escrow), 0);
}

// ---- Wave 4 review fixes ----

#[test]
fn escrow_invariants_tolerate_a_direct_deposit_into_escrow() {
    let (mut env, market) = setup();

    // Simulate an unsolicited deposit landing directly in both escrows (e.g. sent by
    // mistake, or by some other program), bypassing mint_pair/place_order entirely.
    bump_token_amount(&mut env, market.usdc_escrow, 1);
    bump_token_amount(&mut env, market.yes_escrow, 1);

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 5);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker ask should rest despite the surplus already sitting in yes_escrow");
    assert_escrow_invariants(&env, &market);

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);
    let taker_usdc_before = read_token_amount(&env, taker_usdc);

    // Partial fill (3 of 5): maker's ask rests with 2 remaining afterward.
    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 650_000, 3, TIF_LIMIT, &[maker_usdc])
        .expect("crossing bid should fill despite the surplus already sitting in usdc_escrow");

    // Fills still pay out exactly the contractual amounts -- the surplus is never
    // distributed to either party.
    assert_eq!(read_token_amount(&env, maker_usdc), 10_000 * ONE_USDC - 5 * ONE_USDC + 600_000 * 3);
    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before - 600_000 * 3);
    assert_eq!(read_token_amount(&env, taker_yes), 3 * ONE_USDC);
    assert_escrow_invariants(&env, &market);

    // Cancel the exact remainder: refund is exactly 2 * ONE_USDC, not touched by the
    // surplus.
    let maker_yes_before = read_token_amount(&env, maker_yes);
    send_cancel_order(&mut env, &maker, &market, maker_usdc, maker_yes, 1).expect("cancel the remainder should succeed");
    assert_eq!(read_token_amount(&env, maker_yes), maker_yes_before + 2 * ONE_USDC);

    // The original surplus (1 micro-USDC, 1 Yes base unit) is still sitting there,
    // untouched, at the end.
    assert_eq!(read_token_amount(&env, market.usdc_escrow), 1);
    assert_eq!(read_token_amount(&env, market.yes_escrow), 1);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn crossing_bid_with_zero_maker_accounts_is_refused_and_nothing_moves() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 5);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker ask should rest");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    let taker_usdc_before = read_token_amount(&env, taker_usdc);
    let escrow_usdc_before = read_token_amount(&env, market.usdc_escrow);

    // Crosses the maker's ask, but supplies zero remaining_accounts: must fail outright
    // rather than silently rest a crossed order.
    let result = send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 650_000, 5, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::InvariantViolated);

    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before, "no funds should move");
    assert_eq!(read_token_amount(&env, market.usdc_escrow), escrow_usdc_before);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0, "the crossed order must not rest");
    assert_eq!(header.ask_count, 1, "maker's resting ask should be untouched");
    assert_escrow_invariants(&env, &market);
}

#[test]
fn limit_order_that_fully_fills_against_a_full_opposite_side_succeeds() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 1_000_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);

    // Fill the taker's own side (bids) to capacity with non-crossing resting bids.
    for i in 0..CAPACITY {
        let price = 1 + i as u64;
        send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, price, 1, TIF_LIMIT, &[])
            .unwrap_or_else(|e| panic!("bid {i} should rest: {e:?}"));
    }
    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, CAPACITY, "bid side should be full going in");

    // A maker rests an ask that the next bid will fully cross and fully consume.
    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 3);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 500_000, 3, TIF_LIMIT, &[])
        .expect("maker ask should rest");

    // The taker's bid fully fills against the maker's ask (remaining_qty == 0), so it
    // never needs to rest -- it must succeed even though the taker's own (bid) side is
    // already at capacity.
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 500_000, 3, TIF_LIMIT, &[maker_usdc])
        .expect("a fully-filling limit bid should succeed even with its own side full");

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, CAPACITY, "bid side count unchanged: nothing rested");
    assert_eq!(header.ask_count, 0, "maker's ask fully consumed");
    assert_escrow_invariants(&env, &market);
}

#[test]
fn crossing_ask_fills_at_makers_price_with_exact_usdc_and_yes_on_both_sides() {
    let (mut env, market) = setup();

    // Maker rests a bid: escrows USDC, wants to buy Yes at 600_000.
    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 1); // creates maker's Yes ATA
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_BID, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker bid should rest");

    // Taker sells Yes (ask) at a price that crosses the maker's bid.
    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &taker, &market, taker_usdc, 5);
    let taker_yes = yes_ata(&taker, &market);

    let maker_yes_before = read_token_amount(&env, maker_yes);
    let taker_usdc_before = read_token_amount(&env, taker_usdc);
    let taker_yes_before = read_token_amount(&env, taker_yes);

    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_ASK, 550_000, 5, TIF_LIMIT, &[maker_yes])
        .expect("crossing ask should fill");

    // Filled at the maker's resting price (600_000), not the taker's limit (550_000).
    assert_eq!(read_token_amount(&env, maker_yes), maker_yes_before + 5 * ONE_USDC, "maker receives exactly 5 Yes");
    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before + 600_000 * 5, "taker receives exactly maker-price USDC");
    assert_eq!(read_token_amount(&env, taker_yes), taker_yes_before - 5 * ONE_USDC, "taker's Yes leg fully spent");

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 0, "fully consumed maker bid should be removed");
    assert_eq!(header.ask_count, 0, "fully filled ask should not rest");
    assert_escrow_invariants(&env, &market);
}

#[test]
fn wrong_mint_maker_account_in_remaining_accounts_is_refused() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 1);
    let maker_yes = yes_ata(&maker, &market);
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_BID, 600_000, 5, TIF_LIMIT, &[])
        .expect("maker bid should rest");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &taker, &market, taker_usdc, 5);
    let taker_yes = yes_ata(&taker, &market);

    let taker_usdc_before = read_token_amount(&env, taker_usdc);
    let taker_yes_before = read_token_amount(&env, taker_yes);
    let maker_usdc_before = read_token_amount(&env, maker_usdc);
    let escrow_usdc_before = read_token_amount(&env, market.usdc_escrow);
    let escrow_yes_before = read_token_amount(&env, market.yes_escrow);

    // Ask-taker fills expect the maker's *Yes* account; supply their USDC account
    // instead -- same owner, wrong mint.
    let result = send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_ASK, 550_000, 5, TIF_LIMIT, &[maker_usdc]);
    assert!(result.is_err(), "a wrong-mint maker account should fail the whole transaction");

    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before);
    assert_eq!(read_token_amount(&env, taker_yes), taker_yes_before);
    assert_eq!(read_token_amount(&env, maker_usdc), maker_usdc_before);
    assert_eq!(read_token_amount(&env, market.usdc_escrow), escrow_usdc_before);
    assert_eq!(read_token_amount(&env, market.yes_escrow), escrow_yes_before);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 1, "maker's resting bid should be untouched");
    assert_eq!(header.ask_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn duplicate_maker_account_for_two_fills_to_the_same_maker_is_accepted() {
    let (mut env, market) = setup();

    let (maker, maker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker, &market, maker_usdc, 4);
    let maker_yes = yes_ata(&maker, &market);
    // Two separate resting asks from the SAME maker at the same price (two orders).
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[]).expect("maker ask 1");
    send_place_order(&mut env, &maker, &market, maker_usdc, maker_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[]).expect("maker ask 2");

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    let maker_usdc_before = read_token_amount(&env, maker_usdc);

    // One taker bid needs both fills (qty 4): pass the SAME maker account twice, one
    // per fill.
    send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 500_000, 4, TIF_LIMIT, &[maker_usdc, maker_usdc])
        .expect("duplicate maker account across two fills to the same maker should be accepted");

    assert_eq!(
        read_token_amount(&env, maker_usdc),
        maker_usdc_before + 500_000 * 4,
        "maker paid for both fills via the same account"
    );
    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 0);
    assert_escrow_invariants(&env, &market);
}

#[test]
fn substituted_maker_account_for_a_different_maker_is_refused() {
    let (mut env, market) = setup();

    let (maker1, maker1_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &maker1, &market, maker1_usdc, 4);
    let maker1_yes = yes_ata(&maker1, &market);
    send_place_order(&mut env, &maker1, &market, maker1_usdc, maker1_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[]).expect("maker1 ask 1");
    send_place_order(&mut env, &maker1, &market, maker1_usdc, maker1_yes, SIDE_ASK, 500_000, 2, TIF_LIMIT, &[]).expect("maker1 ask 2");

    // A stranger, not maker1, whose USDC account should never be credited.
    let (_maker2, maker2_usdc) = funded_user(&mut env, 0);

    let (taker, taker_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let taker_yes = yes_ata(&taker, &market);

    let taker_usdc_before = read_token_amount(&env, taker_usdc);
    let maker1_usdc_before = read_token_amount(&env, maker1_usdc);

    // Both fills are maker1's orders, but the second fill's account is substituted for
    // a different maker's account.
    let result = send_place_order(&mut env, &taker, &market, taker_usdc, taker_yes, SIDE_BID, 500_000, 4, TIF_LIMIT, &[maker1_usdc, maker2_usdc]);
    assert!(result.is_err(), "a substituted account for a different maker's fill should fail the whole transaction");

    assert_eq!(read_token_amount(&env, taker_usdc), taker_usdc_before);
    assert_eq!(read_token_amount(&env, maker1_usdc), maker1_usdc_before);
    let header = env.read_book_header(market.book);
    assert_eq!(header.ask_count, 2, "both of maker1's orders should remain untouched");
}

#[test]
fn removed_orders_leave_zeroed_tail_slots_in_raw_book_bytes() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &user, &market, user_usdc, 3);
    let user_yes = yes_ata(&user, &market);

    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 500_000, 1, TIF_LIMIT, &[]).expect("ask 1");
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 600_000, 1, TIF_LIMIT, &[]).expect("ask 2");
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_ASK, 700_000, 1, TIF_LIMIT, &[]).expect("ask 3");

    // Remove the first two (lowest-priced, so front-of-array) orders, leaving the third
    // shifted into slot 0 and the old slots 1/2 zeroed.
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel ask 1");
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 2).expect("cancel ask 2");

    let account = env.svm.get_account(&addr(market.book)).expect("book account should exist");
    let mut data = account.data.clone();
    let header = read_header(&data).expect("book header should validate");
    let capacity = header.capacity;
    assert_eq!(header.ask_count, 1);

    let asks = asks_mut(&mut data, capacity).expect("asks slice");
    assert_eq!(asks[0].id, 3, "the remaining order should have shifted to the front");
    for (i, slot) in asks[header.ask_count as usize..].iter().enumerate() {
        assert_eq!(slot.id, 0, "tail slot {i} beyond ask_count should be zeroed");
        assert_eq!(slot.price, 0, "tail slot {i} beyond ask_count should be zeroed");
        assert_eq!(slot.remaining, 0, "tail slot {i} beyond ask_count should be zeroed");
    }
}

#[test]
fn place_order_ask_crossing_the_takers_own_resting_bid_is_refused_and_nothing_moves() {
    let (mut env, market) = setup();

    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    mint_pairs_for(&mut env, &user, &market, user_usdc, 5);
    let user_yes = yes_ata(&user, &market);

    // Rest a bid for this same user first.
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 5, TIF_LIMIT, &[])
        .expect("resting bid should succeed");

    let usdc_before = read_token_amount(&env, user_usdc);
    let yes_before = read_token_amount(&env, user_yes);
    let escrow_usdc_before = read_token_amount(&env, market.usdc_escrow);
    let escrow_yes_before = read_token_amount(&env, market.yes_escrow);

    // An ask at or below 650_000 crosses the user's own resting bid -- must be refused
    // (Wave 5 review fix, 2026-10-06) before anything moves, not matched against
    // themselves.
    let result = send_place_order(
        &mut env,
        &user,
        &market,
        user_usdc,
        user_yes,
        SIDE_ASK,
        600_000,
        5,
        TIF_LIMIT,
        &[user_usdc],
    );
    assert_err(&result, MeridianError::InvariantViolated);

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before, "nothing should have moved");
    assert_eq!(read_token_amount(&env, user_yes), yes_before, "nothing should have moved");
    assert_eq!(read_token_amount(&env, market.usdc_escrow), escrow_usdc_before);
    assert_eq!(read_token_amount(&env, market.yes_escrow), escrow_yes_before);

    let header = env.read_book_header(market.book);
    assert_eq!(header.bid_count, 1, "the user's resting bid should be untouched");
    assert_eq!(header.ask_count, 0, "no ask should have been rested or matched");
}

#[test]
fn place_order_refused_once_close_ts_has_passed() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);
    let close_ts = env.fetch::<Market>(market.market).close_ts;

    env.warp_to(close_ts);
    let result = send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 1, TIF_LIMIT, &[]);
    assert_err(&result, MeridianError::MarketClosed);
    assert_eq!(read_token_amount(&env, user_usdc), 10_000 * ONE_USDC, "a refused order takes no funds");
    assert_eq!(env.read_book_header(market.book).bid_count, 0);
}

#[test]
fn mint_pair_refused_once_close_ts_has_passed() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let close_ts = env.fetch::<Market>(market.market).close_ts;

    env.warp_to(close_ts + 1);
    let result = send_mint_pair(&mut env, &user, &market, user_usdc, 1);
    assert_err(&result, MeridianError::MarketClosed);
    assert_eq!(read_token_amount(&env, user_usdc), 10_000 * ONE_USDC);
}

#[test]
fn cancel_order_still_works_after_close_ts() {
    let (mut env, market) = setup();
    let (user, user_usdc) = funded_user(&mut env, 10_000 * ONE_USDC);
    let user_yes = yes_ata(&user, &market);
    send_place_order(&mut env, &user, &market, user_usdc, user_yes, SIDE_BID, 650_000, 4, TIF_LIMIT, &[]).expect("bid should rest");
    let usdc_before = read_token_amount(&env, user_usdc);
    let close_ts = env.fetch::<Market>(market.market).close_ts;

    env.warp_to(close_ts + 60);
    send_cancel_order(&mut env, &user, &market, user_usdc, user_yes, 1).expect("cancel must stay available after close");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 650_000 * 4);
    assert_eq!(env.read_book_header(market.book).bid_count, 0);
    assert_escrow_invariants(&env, &market);
}
