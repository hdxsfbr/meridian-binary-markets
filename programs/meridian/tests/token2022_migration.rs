//! Token-2022 migration proof (create_market's new mints + metadata, backward
//! compatibility with hand-built classic-Token legacy markets, and the `close_market`
//! mint-reclaim path for both fixture shapes).
//!
//! `common::Env::create_market` already exercises the real, now-Token-2022-only
//! `create_market` instruction (every other test file uses it too), so this file's
//! "Token-2022 market" coverage is the metadata readback specifically; the
//! `common::Env::create_classic_market_fixture` fixture (hand-built, never touching
//! `create_market`) is what proves the *backward-compatibility* half: every instruction
//! that touches Yes/No mints derives which token program owns them from the mint
//! account's own `owner` at call time, so a legacy market's mints keep working even
//! though every new market's mints are Token-2022.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_interface::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_interface::spl_token_2022::state::Mint as RawMint;
use anchor_spl::token_interface::spl_token_metadata_interface::state::TokenMetadata;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_keypair::Keypair;

use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261007;

fn far_future_close_ts(env: &Env) -> i64 {
    env.now() + 3600
}

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

fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env
        .svm
        .get_account(&addr(account))
        .unwrap_or_else(|| panic!("token account {account} missing"));
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Reads a mint account's on-mint `TokenMetadata` TLV extension (name/symbol/uri).
fn read_token_metadata(env: &Env, mint: Pubkey) -> TokenMetadata {
    let account = env.svm.get_account(&addr(mint)).expect("mint account missing");
    let state = StateWithExtensions::<RawMint>::unpack(&account.data).expect("mint should unpack with extensions");
    state
        .get_variable_len_extension::<TokenMetadata>()
        .expect("mint should carry a TokenMetadata extension")
}

// ==================== create_market's Token-2022 metadata ====================

#[test]
fn create_market_mint_metadata_matches_ticker_strike_side_and_date() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 150_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let yes_meta = read_token_metadata(&env, market.yes_mint);
    assert_eq!(yes_meta.name, "AAPL \u{2265} $150 Yes Oct 7");
    assert_eq!(yes_meta.symbol, "MERIDIAN");
    assert_eq!(yes_meta.uri, "");

    let no_meta = read_token_metadata(&env, market.no_mint);
    assert_eq!(no_meta.name, "AAPL \u{2265} $150 No Oct 7");
    assert_eq!(no_meta.symbol, "MERIDIAN");
    assert_eq!(no_meta.uri, "");
}

/// Measures `create_market`'s compute units now that it creates two Token-2022 mints
/// with extensions + on-mint metadata instead of two plain classic mints. Logged, not
/// asserted against a hard ceiling here -- the SDK side (not this slice) is what needs
/// to react if this crosses a compute-budget-instruction threshold.
#[test]
fn create_market_compute_units_consumed() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let market = Pubkey::find_program_address(
        &[
            meridian::state::market::SEED,
            b"AAPL\0\0\0\0",
            &DAY.to_le_bytes(),
            &150_000_000u64.to_le_bytes(),
        ],
        &meridian::ID,
    )
    .0;
    let yes_mint = Pubkey::find_program_address(&[b"yes_mint", market.as_ref()], &meridian::ID).0;
    let no_mint = Pubkey::find_program_address(&[b"no_mint", market.as_ref()], &meridian::ID).0;
    let vault = Pubkey::find_program_address(&[b"vault", market.as_ref()], &meridian::ID).0;
    let usdc_escrow = Pubkey::find_program_address(&[b"escrow_usdc", market.as_ref()], &meridian::ID).0;
    let yes_escrow = Pubkey::find_program_address(&[b"escrow_yes", market.as_ref()], &meridian::ID).0;

    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: env.admin.pubkey_pk(),
        config: config_pda(),
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
        ticker: *b"AAPL\0\0\0\0",
        strike: 150_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 16,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    let meta = env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");

    eprintln!("create_market compute units consumed: {}", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed > 0, "sanity: some compute should have been consumed");
}

#[test]
fn create_market_mints_are_owned_by_token_2022() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("MSFT", 400_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let yes_account = env.svm.get_account(&addr(market.yes_mint)).expect("yes_mint missing");
    let no_account = env.svm.get_account(&addr(market.no_mint)).expect("no_mint missing");
    assert_eq!(yes_account.owner, addr(anchor_spl::token_2022::ID));
    assert_eq!(no_account.owner, addr(anchor_spl::token_2022::ID));
}

// ==================== backward compatibility: classic-mint legacy market ====================

/// Builds and sends a `mint_pair(qty)` instruction against a classic-mint fixture.
#[allow(clippy::too_many_arguments)]
fn send_mint_pair_classic(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) -> litesvm::types::TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::MintPair {
        user: user_pk,
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_yes: anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.yes_mint),
        user_no: anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.no_mint),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MintPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

#[allow(clippy::too_many_arguments)]
fn send_redeem_pair_classic(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) -> litesvm::types::TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::RedeemPair {
        user: user_pk,
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_yes: anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.yes_mint),
        user_no: anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.no_mint),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::RedeemPair { qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

#[allow(clippy::too_many_arguments)]
fn send_redeem_winning_classic(
    env: &mut Env,
    user: &Keypair,
    market: &CreateMarketResult,
    user_usdc: Pubkey,
    user_winning: Pubkey,
    side: u8,
    qty: u64,
) -> litesvm::types::TransactionResult {
    let accounts = meridian::accounts::RedeemWinning {
        user: user.pubkey_pk(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_winning,
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token::ID,
    };
    let data = meridian::instruction::RedeemWinning { side, qty };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    env.send(&[ix], &[&user_clone])
}

fn settle_classic(env: &mut Env, market: Pubkey, close_ts: i64, price_micro: i64) {
    let feed_id = {
        let cfg: meridian::state::config::Config = env.fetch(config_pda());
        cfg.tickers
            .iter()
            .find(|t| &t.symbol == b"AAPL\0\0\0\0")
            .expect("AAPL ticker enabled")
            .feed_id
    };
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    let price_pda = Pubkey::find_program_address(&[meridian::state::mock_price::SEED, feed_id.as_ref()], &meridian::ID).0;
    let accounts = meridian::accounts::MockWritePrice {
        publisher: admin.pubkey_pk(),
        config: config_pda(),
        price: price_pda,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MockWritePrice {
        feed_id,
        price: price_micro,
        conf: 10_000,
        expo: -6,
        publish_time: close_ts,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let admin_clone = admin.insecure_clone();
    env.send(&[ix], &[&admin_clone]).expect("mock_write_price should succeed");

    let accounts = meridian::accounts::SettleMarket {
        caller: admin.pubkey_pk(),
        config: config_pda(),
        market,
        price_account: price_pda,
    };
    let data = meridian::instruction::SettleMarket {};
    let ix = build_ix(meridian::ID, accounts, data);
    env.send(&[ix], &[&admin]).expect("settle_market should succeed");
}

#[test]
fn classic_market_fixture_mint_pair_and_redeem_pair_round_trip() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env.create_classic_market_fixture(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16));

    // Sanity: the fixture's mints really are classic Token, not Token-2022.
    let yes_account = env.svm.get_account(&addr(market.yes_mint)).expect("yes_mint missing");
    assert_eq!(yes_account.owner, addr(anchor_spl::token::ID));

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);

    send_mint_pair_classic(&mut env, &user, &market, user_usdc, 3).expect("mint_pair should succeed on a classic market");

    let user_pk = user.pubkey_pk();
    let user_yes = anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.yes_mint);
    let user_no = anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.no_mint);
    assert_eq!(read_token_amount(&env, user_yes), 3_000_000);
    assert_eq!(read_token_amount(&env, user_no), 3_000_000);
    assert_eq!(read_token_amount(&env, market.vault), 3_000_000);

    send_redeem_pair_classic(&mut env, &user, &market, user_usdc, 2).expect("redeem_pair should succeed on a classic market");
    assert_eq!(read_token_amount(&env, user_yes), 1_000_000);
    assert_eq!(read_token_amount(&env, user_no), 1_000_000);
    assert_eq!(read_token_amount(&env, market.vault), 1_000_000);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 1);
}

#[test]
fn classic_market_fixture_settles_and_redeems_winning_side() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env.create_classic_market_fixture(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16));

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * 1_000_000);
    send_mint_pair_classic(&mut env, &user, &market, user_usdc, 2).expect("mint_pair should succeed");

    // 333_000_000 > strike (100_000_000) -> Yes wins.
    settle_classic(&mut env, market.market, close_ts, 333_000_000);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);
    assert_eq!(m.outcome, Outcome::Yes);

    let user_pk = user.pubkey_pk();
    let user_yes = anchor_spl::associated_token::get_associated_token_address(&user_pk, &market.yes_mint);
    let usdc_before = read_token_amount(&env, user_usdc);

    send_redeem_winning_classic(&mut env, &user, &market, user_usdc, user_yes, 1, 2)
        .expect("redeem_winning should succeed on a classic market");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 2_000_000);
    assert_eq!(read_token_amount(&env, user_yes), 0);
}

// ==================== close_market's mint-reclaim path ====================

fn close_accounts(market: &CreateMarketResult, admin: Pubkey, yesno_token_program: Pubkey) -> meridian::accounts::CloseAccounts {
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
        yesno_token_program,
        system_program: anchor_lang::system_program::ID,
    }
}

/// `close_market` must skip (not error on, not close) a classic market's Yes/No mints:
/// classic Token has no mint-closing instruction at all, regardless of supply.
#[test]
fn close_market_skips_classic_mints_even_at_zero_supply() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env.create_classic_market_fixture(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16));

    // Zero-activity market: settle it (so close_market's `is_settled` guard passes),
    // vault/escrows are already empty, book_closed is already true on this fixture.
    settle_classic(&mut env, market.market, close_ts, 50_000_000); // below strike -> No wins, doesn't matter here.

    let admin = env.admin.insecure_clone();
    let accounts = close_accounts(&market, admin.pubkey_pk(), anchor_spl::token::ID);
    let data = meridian::instruction::CloseMarket {};
    let ix = build_ix(meridian::ID, accounts, data);
    env.send(&[ix], &[&admin]).expect("close_market should succeed even though the mints are classic");

    // The classic mints are untouched: still present, still owned by classic Token.
    let yes_account = env.svm.get_account(&addr(market.yes_mint)).expect("classic yes_mint should still exist");
    assert_eq!(yes_account.owner, addr(anchor_spl::token::ID));
    let no_account = env.svm.get_account(&addr(market.no_mint)).expect("classic no_mint should still exist");
    assert_eq!(no_account.owner, addr(anchor_spl::token::ID));

    // But the Market account itself is still closed/reclaimed as usual.
    assert!(env.svm.get_account(&addr(market.market)).map(|a| a.data.is_empty()).unwrap_or(true));
}

/// `close_market` must reclaim a Token-2022 market's Yes/No mints once their supply is
/// zero (both sides fully redeemed) -- the `MintCloseAuthority` extension exists
/// specifically for this.
#[test]
fn close_market_closes_token_2022_mints_once_supply_is_zero() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    // Zero-activity market (never minted): settle, close_book, close_market.
    let feed_id = {
        let cfg: meridian::state::config::Config = env.fetch(config_pda());
        cfg.tickers.iter().find(|t| &t.symbol == b"AAPL\0\0\0\0").unwrap().feed_id
    };
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    let price_pda = Pubkey::find_program_address(&[meridian::state::mock_price::SEED, feed_id.as_ref()], &meridian::ID).0;
    let accounts = meridian::accounts::MockWritePrice {
        publisher: admin.pubkey_pk(),
        config: config_pda(),
        price: price_pda,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MockWritePrice {
        feed_id,
        price: 50_000_000,
        conf: 10_000,
        expo: -6,
        publish_time: close_ts,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    env.send(&[ix], &[&admin]).expect("mock_write_price should succeed");

    let accounts = meridian::accounts::SettleMarket {
        caller: admin.pubkey_pk(),
        config: config_pda(),
        market: market.market,
        price_account: price_pda,
    };
    let data = meridian::instruction::SettleMarket {};
    let ix = build_ix(meridian::ID, accounts, data);
    env.send(&[ix], &[&admin]).expect("settle_market should succeed");

    let close_book_accounts = close_accounts(&market, admin.pubkey_pk(), anchor_spl::token_2022::ID);
    let ix = build_ix(meridian::ID, close_book_accounts, meridian::instruction::CloseBook {});
    env.send(&[ix], &[&admin]).expect("close_book should succeed");

    let close_market_accounts = close_accounts(&market, admin.pubkey_pk(), anchor_spl::token_2022::ID);
    let ix = build_ix(meridian::ID, close_market_accounts, meridian::instruction::CloseMarket {});
    env.send(&[ix], &[&admin]).expect("close_market should succeed and reclaim the Token-2022 mints");

    assert!(account_is_closed(&env, market.yes_mint), "zero-supply Token-2022 yes_mint should be closed");
    assert!(account_is_closed(&env, market.no_mint), "zero-supply Token-2022 no_mint should be closed");
}

fn account_is_closed(env: &Env, pubkey: Pubkey) -> bool {
    match env.svm.get_account(&addr(pubkey)) {
        None => true,
        Some(a) => a.data.is_empty() && a.lamports == 0,
    }
}
