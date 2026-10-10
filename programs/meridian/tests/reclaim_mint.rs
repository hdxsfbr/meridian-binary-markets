//! `reclaim_mint` tests (Token-2022 migration follow-up, audit item 4).
//!
//! `close_market` only closes a Yes/No Token-2022 mint when its supply is already
//! zero at settlement-close time (`close.rs`'s `close_mint_if_reclaimable`) -- the
//! losing side's mint almost never qualifies, since its holders still have
//! unredeemed, now-worthless tokens. `close_market` deletes `Market` regardless, which
//! would otherwise leave that mint's rent permanently unreclaimable. `reclaim_mint`
//! re-derives the market PDA from its seeds alone (no `Market` account required) and
//! closes such a mint once its supply actually reaches zero. Covers: closes after
//! holders burn the losing side; refuses while supply is still outstanding; refuses a
//! mint/seed combination that doesn't match. All helpers below are private to this
//! file (no cross-file test helper sharing, per this program's test convention).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_instruction::account_meta::AccountMeta as SdkAccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use meridian::errors::MeridianError;

use common::*;

const DAY: u32 = 20261007;
const CAPACITY: u16 = 16;
const SIDE_BID: u8 = 0;
const TIF_LIMIT: u8 = 0;

fn far_future_close_ts(env: &Env) -> i64 {
    env.now() + 3600
}

fn new_user(env: &mut Env) -> Keypair {
    let user = Keypair::new();
    env.airdrop(user.pubkey_pk(), 10_000_000_000);
    user
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

/// Warps to `close_ts`, writes a mock price for AAPL, and settles `market`. Yes wins
/// whenever `price_micro >= strike` (`Market::resolve`); every test below uses a price
/// above the strike, so No is always the losing side.
fn settle_with_price(env: &mut Env, market: Pubkey, close_ts: i64, price_micro: i64) {
    let feed_id = aapl_feed_id(env);
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, price_micro, 10_000, -6, close_ts).expect("mock_write_price should succeed");
    settle_market_as(env, &admin, market, mock_price_pda(&feed_id)).expect("settle_market should succeed");
}

fn mint_usdc(env: &mut Env, destination: Pubkey, amount: u64) {
    let admin = env.admin.insecure_clone();
    let usdc_mint_addr = addr(env.usdc_mint);
    let dest_addr = addr(destination);
    TokenMintTo::new(&mut env.svm, &admin, &usdc_mint_addr, &dest_addr, amount)
        .send()
        .expect("mint test USDC should succeed");
}

fn create_usdc_ata(env: &mut Env, user: &Keypair) -> Pubkey {
    let usdc_mint_addr = addr(env.usdc_mint);
    let ata = litesvm_token::CreateAssociatedTokenAccount::new(&mut env.svm, user, &usdc_mint_addr)
        .send()
        .expect("create user USDC ata should succeed");
    pk(ata)
}

fn yes_ata(user: &Keypair, market: &CreateMarketResult) -> Pubkey {
    get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID)
}

fn no_ata(user: &Keypair, market: &CreateMarketResult) -> Pubkey {
    get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.no_mint, &anchor_spl::token_2022::ID)
}

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

/// Raw SPL token account `amount` field (bytes 64..72); plain SPL accounts have no
/// Anchor discriminator (private copy; see `tests/close.rs`'s `read_token_amount`).
fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env
        .svm
        .get_account(&addr(account))
        .unwrap_or_else(|| panic!("token account {account} missing"));
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Seeds one maker resting a `qty`-token Yes bid at `price`; returns the maker
/// keypair, their USDC ATA, and their Yes ATA (for `buy_no_market`'s
/// `remaining_accounts` and the maker's eventual `redeem_winning` once the market
/// settles -- Yes wins in every test below).
fn seed_one_bid(env: &mut Env, market: &CreateMarketResult, qty: u64, price: u64) -> (Keypair, Pubkey, Pubkey) {
    let maker = new_user(env);
    let maker_usdc = create_usdc_ata(env, &maker);
    mint_usdc(env, maker_usdc, 10_000 * 1_000_000);
    // `buy_no_market`'s Yes-leg transfer to a bid maker is a raw `token::transfer`
    // (not `init_if_needed`), so the maker's Yes ATA must already exist even though a
    // bid maker never minted/held any Yes themselves.
    let maker_yes = pk(CreateAssociatedTokenAccount::new(&mut env.svm, &maker, &addr(market.yes_mint))
        .token_program_id(&addr(anchor_spl::token_2022::ID))
        .send()
        .expect("create maker Yes ata should succeed"));

    let accounts = meridian::accounts::PlaceOrder {
        user: maker.pubkey_pk(),
        config: config_pda(),
        market: market.market,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        user_usdc: maker_usdc,
        yes_mint: market.yes_mint,
        user_yes: maker_yes,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::PlaceOrder {
        side: SIDE_BID,
        price,
        qty,
        tif: TIF_LIMIT,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let maker_clone = maker.insecure_clone();
    env.send(&[ix], &[&maker_clone]).expect("maker bid should rest");

    (maker, maker_usdc, maker_yes)
}

/// `buy_no_market(qty, min_yes_price)`: mints `qty` pairs for `taker`, then IOC-sells
/// the Yes leg into `remaining` resting bids -- a real directional "Buy No" trade, so
/// a fully-filled `taker` ends up holding only No, not a hedged pair (unlike a bare
/// `mint_pair`, which is always risk-free and redeemable via `redeem_pair` regardless
/// of settlement).
fn send_buy_no_market(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64, min_yes_price: u64, remaining: &[Pubkey]) -> TransactionResult {
    let accounts = meridian::accounts::BuyNoMarket {
        user: user.pubkey_pk(),
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        book: market.book,
        usdc_escrow: market.usdc_escrow,
        yes_escrow: market.yes_escrow,
        user_usdc,
        user_yes: yes_ata(user, market),
        user_no: no_ata(user, market),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::BuyNoMarket { qty, min_yes_price }.data();
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

fn send_redeem_winning(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, user_winning: Pubkey, side: u8, qty: u64) -> TransactionResult {
    let accounts = meridian::accounts::RedeemWinning {
        user: user.pubkey_pk(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_winning,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
    };
    let data = meridian::instruction::RedeemWinning { side, qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
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
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
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

/// Burns `amount` of `mint` from `owner`'s own token account, as the user-signed
/// "Remove from wallet" flow (`PositionRow.tsx`) would -- a plain Token-2022 burn, not
/// a program instruction.
///
/// Built by hand (discriminant `8`, data `[amount_le_u64]`), not via
/// `litesvm_token::Burn`/`anchor_spl::token::burn`: both go through
/// `spl_token_interface`'s client-side instruction builder, which calls
/// `check_program_account` and hard-rejects any program id other than classic Token's
/// own (see `common/mod.rs`'s `yes_no_transfer_checked_ix`, which hits the exact same
/// issue for `TransferChecked` and documents it in full).
fn burn_tokens(env: &mut Env, owner: &Keypair, mint: Pubkey, account: Pubkey, amount: u64) {
    let ix = Instruction {
        program_id: addr(anchor_spl::token_2022::ID),
        accounts: vec![
            SdkAccountMeta { pubkey: addr(account), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(mint), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(owner.pubkey_pk()), is_signer: true, is_writable: false },
        ],
        data: {
            let mut data = Vec::with_capacity(9);
            data.push(8u8); // TokenInstruction::Burn discriminant
            data.extend_from_slice(&amount.to_le_bytes());
            data
        },
    };
    let owner_clone = owner.insecure_clone();
    env.send(&[ix], &[&owner_clone]).expect("burn should succeed");
}

const TICKER: [u8; 8] = *b"AAPL\0\0\0\0";
const STRIKE: u64 = 100_000_000;

#[allow(clippy::too_many_arguments)]
fn send_reclaim_mint(env: &mut Env, admin: Pubkey, mint: Pubkey, ticker: [u8; 8], trading_day: u32, strike: u64, side: u8) -> TransactionResult {
    let market = market_pda(&ticker, trading_day, strike);
    let accounts = meridian::accounts::ReclaimMint {
        config: config_pda(),
        market,
        mint,
        admin,
        token_program: anchor_spl::token_2022::ID,
    };
    let data = meridian::instruction::ReclaimMint {
        ticker,
        trading_day,
        strike,
        side,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    // Permissionless: the payer need not be the admin. A fresh throwaway keypair
    // (airdropped) stands in for "anyone", distinct from `admin` (the lamport
    // destination) below.
    let caller = Keypair::new();
    env.airdrop(caller.pubkey_pk(), 1_000_000_000);
    env.send(&[ix], &[&caller])
}

/// Sets up one `Env` with an initialized config and one open AAPL market, book
/// capacity `CAPACITY`.
fn setup(strike: u64) -> (Env, CreateMarketResult, i64) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", strike, DAY, close_ts, CAPACITY))
        .expect("create_market should succeed");
    (env, market, close_ts)
}

fn account_is_closed(env: &Env, pubkey: Pubkey) -> bool {
    match env.svm.get_account(&addr(pubkey)) {
        None => true,
        Some(acc) => acc.owner == addr(anchor_lang::system_program::ID) && acc.data.is_empty(),
    }
}

/// Full lifecycle up through `close_market`, with the loser (No) left holding `qty`
/// unredeemed tokens -- the scenario `reclaim_mint` exists for.
///
/// A `buy_no_market` trade (not a bare `mint_pair`, which is always a risk-free,
/// `redeem_pair`-able hedge regardless of outcome) is what actually leaves a trader
/// holding only one side: `taker` mints `qty` pairs and immediately sells the whole
/// Yes leg IOC into `maker`'s resting bid, ending up with `qty` No and zero Yes;
/// `maker` ends up with `qty` Yes and zero No. Price settles above the strike, so Yes
/// wins (`maker`) and No loses (`taker`). `maker` redeems in full, so `close_market`
/// closes `yes_mint` immediately (zero supply); `no_mint` (supply `qty`, held by
/// `taker`) is left for `reclaim_mint` to pick up once `taker` burns it.
fn setup_settled_with_losing_side_outstanding(qty: u64) -> (Env, CreateMarketResult, Keypair, Pubkey) {
    let (mut env, market, close_ts) = setup(STRIKE);

    let price = 600_000u64; // $0.60/contract -- strictly between 0 and 1.
    let (maker, maker_usdc, maker_yes) = seed_one_bid(&mut env, &market, qty, price);

    let taker = new_user(&mut env);
    let taker_usdc = create_usdc_ata(&mut env, &taker);
    mint_usdc(&mut env, taker_usdc, qty * 1_000_000);
    send_buy_no_market(&mut env, &taker, &market, taker_usdc, qty, price, &[maker_yes]).expect("buy_no_market should fully fill against the resting bid");

    assert_eq!(read_token_amount(&env, no_ata(&taker, &market)), qty * 1_000_000, "taker should hold exactly qty No");
    assert_eq!(read_token_amount(&env, yes_ata(&taker, &market)), 0, "taker should hold zero Yes after a full fill");

    // Price above strike: Yes wins, No loses.
    settle_with_price(&mut env, market.market, close_ts, (STRIKE as i64) + 50_000_000);

    send_redeem_winning(&mut env, &maker, &market, maker_usdc, maker_yes, 1, qty).expect("maker redeem_winning should succeed");

    let admin = env.admin.insecure_clone();
    send_close_book_as(&mut env, &admin, &market).expect("close_book should succeed");
    send_close_market_as(&mut env, &admin, &market).expect("close_market should succeed");

    assert!(account_is_closed(&env, market.market), "close_market should have deleted Market");
    assert!(account_is_closed(&env, market.yes_mint), "yes_mint should already be closed (zero supply at close time)");
    assert!(!account_is_closed(&env, market.no_mint), "no_mint should still be outstanding (taker never burned it)");

    let taker_no = no_ata(&taker, &market);
    (env, market, taker, taker_no)
}

#[test]
fn reclaim_mint_closes_after_the_losing_side_is_burned() {
    let qty = 5u64;
    let (mut env, market, loser, loser_no) = setup_settled_with_losing_side_outstanding(qty);
    let admin = env.admin.pubkey_pk();

    let no_mint_rent = env.balance(market.no_mint).expect("no_mint should exist before reclaim");
    let admin_before = env.balance(admin).expect("admin should exist");

    // The holder burns their own losing tokens (plain Token-2022 burn, not a program
    // instruction -- the user-signed "Remove from wallet" flow).
    burn_tokens(&mut env, &loser, market.no_mint, loser_no, qty * 1_000_000);

    send_reclaim_mint(&mut env, admin, market.no_mint, TICKER, DAY, STRIKE, 2).expect("reclaim_mint should succeed once supply is zero");

    assert!(account_is_closed(&env, market.no_mint), "no_mint should be closed after reclaim_mint");
    let admin_after = env.balance(admin).expect("admin should still exist");
    assert_eq!(admin_after - admin_before, no_mint_rent, "no_mint's rent should go to admin exactly");
}

#[test]
fn reclaim_mint_refuses_while_supply_is_still_outstanding() {
    let qty = 5u64;
    let (mut env, market, _loser, _loser_no) = setup_settled_with_losing_side_outstanding(qty);
    let admin = env.admin.pubkey_pk();

    // The loser never burned anything -- no_mint still has `qty` outstanding.
    let result = send_reclaim_mint(&mut env, admin, market.no_mint, TICKER, DAY, STRIKE, 2);
    assert_err(&result, MeridianError::NotEmpty);
    assert!(!account_is_closed(&env, market.no_mint));
}

#[test]
fn reclaim_mint_refuses_a_mint_address_that_does_not_match_the_derived_seeds() {
    let qty = 5u64;
    let (mut env, market, loser, loser_no) = setup_settled_with_losing_side_outstanding(qty);
    let admin = env.admin.pubkey_pk();

    burn_tokens(&mut env, &loser, market.no_mint, loser_no, qty * 1_000_000);

    // `side = 1` (Yes) with `no_mint`'s address: the `mint` account's `seeds`/`bump`
    // constraint expects the Yes mint PDA, not the No mint's address -- a seeds
    // mismatch, not a business-logic rejection.
    let result = send_reclaim_mint(&mut env, admin, market.no_mint, TICKER, DAY, STRIKE, 1);
    assert_anchor_err(&result, 2006); // ConstraintSeeds
    assert!(!account_is_closed(&env, market.no_mint));

    // A wrong trading day shifts the derived market PDA entirely, so the supplied
    // `market`/`mint` no longer match their own seeds either.
    let wrong_day = DAY + 1;
    let result = send_reclaim_mint(&mut env, admin, market.no_mint, TICKER, wrong_day, STRIKE, 2);
    assert_anchor_err(&result, 2006);
    assert!(!account_is_closed(&env, market.no_mint));
}

#[test]
fn reclaim_mint_refuses_a_classic_mint() {
    // `create_classic_market_fixture` (see `common/mod.rs`) builds a legacy, pre-
    // migration market whose Yes/No mints are classic SPL Token, not Token-2022 --
    // `reclaim_mint` must reject these outright rather than attempting to close them.
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env.create_classic_market_fixture(CreateMarketArgs::new("AAPL", STRIKE, DAY, close_ts, CAPACITY));
    let admin = env.admin.pubkey_pk();

    let result = send_reclaim_mint(&mut env, admin, market.no_mint, TICKER, DAY, STRIKE, 2);
    // A classic mint is owned by the classic Token program, so even constructing the
    // instruction's `mint`/`token_program` accounts against it mismatches what
    // `reclaim_mint` requires; whichever check trips first (seeds, owner, or the
    // declared `token_program`), it must not succeed.
    assert!(result.is_err(), "reclaim_mint must refuse a classic-Token mint");
    assert!(!account_is_closed(&env, market.no_mint));
}
