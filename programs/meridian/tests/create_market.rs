//! Rust port of `create_market` / `add_strike` (T020) on litesvm 0.12.0, plus the Wave 2
//! review follow-ups: `create_book`'s capacity-stable idempotency (no own `capacity`
//! arg, reads `Market.book_capacity`) and prefunded-PDA handling.

mod common;

use anchor_lang::prelude::Pubkey;

use meridian::errors::MeridianError;
use meridian::state::book::book_space;
use meridian::state::market::{Market, MarketState, Outcome};

use common::*;

const DAY: u32 = 20261006;

fn far_future_close_ts(env: &Env) -> i64 {
    env.now() + 3600
}

fn read_mint_decimals(env: &Env, mint: Pubkey) -> u8 {
    let account = env.svm.get_account(&addr(mint)).expect("mint account missing");
    account.data[44]
}

fn read_mint_supply(env: &Env, mint: Pubkey) -> u64 {
    let account = env.svm.get_account(&addr(mint)).expect("mint account missing");
    u64::from_le_bytes(account.data[36..44].try_into().unwrap())
}

fn read_mint_authority(env: &Env, mint: Pubkey) -> Option<Pubkey> {
    let account = env.svm.get_account(&addr(mint)).expect("mint account missing");
    let tag = u32::from_le_bytes(account.data[0..4].try_into().unwrap());
    if tag == 0 {
        return None;
    }
    let bytes: [u8; 32] = account.data[4..36].try_into().unwrap();
    Some(Pubkey::new_from_array(bytes))
}

fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env.svm.get_account(&addr(account)).expect("token account missing");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

fn read_token_account_owner(env: &Env, account: Pubkey) -> Pubkey {
    let acc = env.svm.get_account(&addr(account)).expect("token account missing");
    let bytes: [u8; 32] = acc.data[32..64].try_into().unwrap();
    Pubkey::new_from_array(bytes)
}

fn read_token_account_mint(env: &Env, account: Pubkey) -> Pubkey {
    let acc = env.svm.get_account(&addr(account)).expect("token account missing");
    let bytes: [u8; 32] = acc.data[0..32].try_into().unwrap();
    Pubkey::new_from_array(bytes)
}

#[test]
fn creates_market_with_correct_fields_mints_vault_escrows_and_book_header() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 230_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let market: Market = env.fetch(result.market);
    assert_eq!(market.strike, 230_000_000);
    assert_eq!(market.trading_day, DAY);
    assert_eq!(market.close_ts, close_ts);
    assert_eq!(market.state, MarketState::Open);
    assert_eq!(market.outcome, Outcome::Unset);
    assert_eq!(market.pairs_outstanding, 0);
    assert_eq!(market.yes_mint, result.yes_mint);
    assert_eq!(market.no_mint, result.no_mint);
    assert_eq!(market.vault, result.vault);
    assert_eq!(market.book, result.book);
    assert_eq!(market.book_capacity, 16);

    for mint in [result.yes_mint, result.no_mint] {
        assert_eq!(read_mint_decimals(&env, mint), 6);
        assert_eq!(read_mint_supply(&env, mint), 0);
        assert_eq!(read_mint_authority(&env, mint), Some(result.market));
    }

    assert_eq!(read_token_account_owner(&env, result.vault), result.market);
    assert_eq!(read_token_account_mint(&env, result.vault), env.usdc_mint);
    assert_eq!(read_token_amount(&env, result.vault), 0);

    assert_eq!(read_token_account_owner(&env, result.usdc_escrow), result.market);
    assert_eq!(read_token_account_mint(&env, result.usdc_escrow), env.usdc_mint);
    assert_eq!(read_token_amount(&env, result.usdc_escrow), 0);

    assert_eq!(read_token_account_owner(&env, result.yes_escrow), result.market);
    assert_eq!(read_token_account_mint(&env, result.yes_escrow), result.yes_mint);
    assert_eq!(read_token_amount(&env, result.yes_escrow), 0);

    let header = env.read_book_header(result.book);
    assert_eq!(header.capacity, 16);
    assert_eq!(header.bid_count, 0);
    assert_eq!(header.ask_count, 0);
    assert_eq!(header.market, result.market.to_bytes());
    assert_eq!(header.usdc_escrow, result.usdc_escrow.to_bytes());
    assert_eq!(header.yes_escrow, result.yes_escrow.to_bytes());
    assert_eq!(env.account_data_len(result.book), Some(book_space(16)));
}

#[test]
fn market_created_event_is_present_in_logs() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let config = config_pda();
    let market = market_pda(&{
        let mut t = [0u8; 8];
        t[..4].copy_from_slice(b"AAPL");
        t
    }, DAY, 555_000_000);
    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: env.admin.pubkey_pk(),
        config,
        market,
        yes_mint: derive_for_test(&[b"yes_mint", market.as_ref()]),
        no_mint: derive_for_test(&[b"no_mint", market.as_ref()]),
        vault: derive_for_test(&[b"vault", market.as_ref()]),
        usdc_escrow: derive_for_test(&[b"escrow_usdc", market.as_ref()]),
        yes_escrow: derive_for_test(&[b"escrow_yes", market.as_ref()]),
        usdc_mint: env.usdc_mint,
        token_program: anchor_spl::token_2022::ID,
        usdc_token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::prelude::rent::ID,
    };
    let data = meridian::instruction::CreateMarket {
        ticker: {
            let mut t = [0u8; 8];
            t[..4].copy_from_slice(b"AAPL");
            t
        },
        strike: 555_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 16,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    let meta = env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");
    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected a `Program data:` log line for the MarketCreated event, got:\n{}",
        meta.logs.join("\n")
    );
}

fn derive_for_test(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &meridian::ID).0
}

#[test]
fn add_strike_works_after_warping_forward_but_before_close() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    env.create_market(CreateMarketArgs::new("AAPL", 200_000_000, DAY, close_ts, 16))
        .expect("first strike should succeed");

    let now = env.now();
    env.warp_to(now + 60);

    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 210_000_000, DAY, close_ts, 16).as_add_strike())
        .expect("add_strike should succeed");

    let market: Market = env.fetch(result.market);
    assert_eq!(market.strike, 210_000_000);
}

#[test]
fn works_at_capacity_16_and_128() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let small = env
        .create_market(CreateMarketArgs::new("AAPL", 3_000_000, DAY, close_ts, 16))
        .expect("capacity 16 should succeed");
    let big = env
        .create_market(CreateMarketArgs::new("AAPL", 4_000_000, DAY, close_ts, 128))
        .expect("capacity 128 should succeed");

    assert_eq!(env.account_data_len(small.book), Some(book_space(16)));
    assert_eq!(env.account_data_len(big.book), Some(book_space(128)));

    let big_market: Market = env.fetch(big.market);
    assert_eq!(big_market.book_capacity, 128);
}

#[test]
fn capacity_128_needs_exactly_two_create_book_calls_and_a_third_is_a_no_op() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let market = market_pda(b"AAPL\0\0\0\0", DAY, 7_000_000);
    let config = config_pda();
    let yes_mint = derive_for_test(&[b"yes_mint", market.as_ref()]);
    let no_mint = derive_for_test(&[b"no_mint", market.as_ref()]);
    let vault = derive_for_test(&[b"vault", market.as_ref()]);
    let usdc_escrow = derive_for_test(&[b"escrow_usdc", market.as_ref()]);
    let yes_escrow = derive_for_test(&[b"escrow_yes", market.as_ref()]);

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
        ticker: *b"AAPL\0\0\0\0",
        strike: 7_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 128,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");

    let mut calls = 0;
    loop {
        let m: Market = env.fetch(market);
        if m.book != Pubkey::default() {
            break;
        }
        env.create_book(market).expect("create_book call should succeed");
        calls += 1;
        assert!(calls <= 4, "too many create_book calls for capacity 128");
    }
    assert_eq!(calls, 2, "capacity 128 should need exactly two create_book calls");

    // A further call once the book is complete is a no-op (re-validates and returns Ok).
    env.create_book(market).expect("extra create_book call should be a no-op, not an error");
    assert_eq!(env.account_data_len(book_pda(market)), Some(book_space(128)));
}

#[test]
fn create_book_survives_a_prefunded_pda() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let market = market_pda(b"AAPL\0\0\0\0", DAY, 8_000_000);
    let book = book_pda(market);
    env.airdrop(book, 1_000_000_000);
    let prefunded_lamports = env.balance(book).expect("book should have the airdropped lamports");
    assert_eq!(prefunded_lamports, 1_000_000_000);

    let config = config_pda();
    let yes_mint = derive_for_test(&[b"yes_mint", market.as_ref()]);
    let no_mint = derive_for_test(&[b"no_mint", market.as_ref()]);
    let vault = derive_for_test(&[b"vault", market.as_ref()]);
    let usdc_escrow = derive_for_test(&[b"escrow_usdc", market.as_ref()]);
    let yes_escrow = derive_for_test(&[b"escrow_yes", market.as_ref()]);
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
        ticker: *b"AAPL\0\0\0\0",
        strike: 8_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 16,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");

    env.create_book(market).expect("create_book should succeed against a prefunded PDA");

    let m: Market = env.fetch(market);
    assert_eq!(m.book, book);
    assert_eq!(env.account_data_len(book), Some(book_space(16)));
    // The PDA was already well past rent-exempt for the final size, so create_book
    // should not have transferred any more lamports into it.
    assert_eq!(env.balance(book), Some(prefunded_lamports));
}

#[test]
fn disabled_ticker_is_refused() {
    let mut env = Env::new();
    let admin_pk = env.admin.pubkey_pk();
    let mut args = default_config_args(admin_pk, 16);
    for t in args.tickers.iter_mut() {
        t.enabled = false;
    }
    env.init_config_with(args).expect("init_config should succeed");

    let close_ts = far_future_close_ts(&env);
    let result = env.create_market(CreateMarketArgs::new("AAPL", 1_000_000, DAY, close_ts, 16));
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn close_ts_in_the_past_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let past = env.now() - 10;

    let result = env.create_market(CreateMarketArgs::new("AAPL", 1_000_000, DAY, past, 16));
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn zero_strike_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let result = env.create_market(CreateMarketArgs::new("AAPL", 0, DAY, close_ts, 16));
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn zero_capacity_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let result = env.create_market(CreateMarketArgs::new("AAPL", 1_000_000, DAY, close_ts, 0));
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn duplicate_market_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    env.create_market(CreateMarketArgs::new("AAPL", 9_000_000, DAY, close_ts, 16))
        .expect("first create_market should succeed");
    let result = env.create_market(CreateMarketArgs::new("AAPL", 9_000_000, DAY, close_ts, 16));
    assert!(result.is_err(), "duplicate create_market should fail");
}

#[test]
fn non_admin_create_market_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let stranger = solana_keypair::Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let market = market_pda(b"AAPL\0\0\0\0", DAY, 11_000_000);
    let config = config_pda();
    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: stranger.pubkey_pk(),
        config,
        market,
        yes_mint: derive_for_test(&[b"yes_mint", market.as_ref()]),
        no_mint: derive_for_test(&[b"no_mint", market.as_ref()]),
        vault: derive_for_test(&[b"vault", market.as_ref()]),
        usdc_escrow: derive_for_test(&[b"escrow_usdc", market.as_ref()]),
        yes_escrow: derive_for_test(&[b"escrow_yes", market.as_ref()]),
        usdc_mint: env.usdc_mint,
        token_program: anchor_spl::token_2022::ID,
        usdc_token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::prelude::rent::ID,
    };
    let data = meridian::instruction::CreateMarket {
        ticker: *b"AAPL\0\0\0\0",
        strike: 11_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 16,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let result = env.send(&[ix], &[&payer, &stranger]);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn create_book_by_non_admin_is_refused() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    // Use capacity 128 so the market's own create_market call does not already
    // complete the book, leaving a real in-progress book for create_book to touch.
    let market = market_pda(b"AAPL\0\0\0\0", DAY, 12_000_000);
    let config = config_pda();
    let accounts = meridian::accounts::CreateMarket {
        payer: env.payer.pubkey_pk(),
        admin: env.admin.pubkey_pk(),
        config,
        market,
        yes_mint: derive_for_test(&[b"yes_mint", market.as_ref()]),
        no_mint: derive_for_test(&[b"no_mint", market.as_ref()]),
        vault: derive_for_test(&[b"vault", market.as_ref()]),
        usdc_escrow: derive_for_test(&[b"escrow_usdc", market.as_ref()]),
        yes_escrow: derive_for_test(&[b"escrow_yes", market.as_ref()]),
        usdc_mint: env.usdc_mint,
        token_program: anchor_spl::token_2022::ID,
        usdc_token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        rent: anchor_lang::prelude::rent::ID,
    };
    let data = meridian::instruction::CreateMarket {
        ticker: *b"AAPL\0\0\0\0",
        strike: 12_000_000,
        trading_day: DAY,
        close_ts,
        capacity: 128,
    };
    let ix = build_ix(meridian::ID, accounts, data);
    let payer = env.payer.insecure_clone();
    let admin = env.admin.insecure_clone();
    env.send(&[ix], &[&payer, &admin]).expect("create_market should succeed");

    let stranger = solana_keypair::Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);
    let result = env.create_book_as(market, &stranger);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn create_book_on_a_completed_book_is_a_no_op() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);

    let result = env
        .create_market(CreateMarketArgs::new("AAPL", 13_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let before: Market = env.fetch(result.market);
    assert_ne!(before.book, Pubkey::default());

    env.create_book(result.market)
        .expect("create_book on a completed book should be a no-op, not an error");

    let after: Market = env.fetch(result.market);
    assert_eq!(after.book, before.book);
}
