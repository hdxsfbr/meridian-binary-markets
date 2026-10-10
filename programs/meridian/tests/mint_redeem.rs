//! `mint_pair` / `redeem_pair` (Wave 3, T024/T026/T027).
//!
//! Covers the dollar invariant from `specs/001-binary-outcome-markets/data-model.md`
//! ("Market": `vault.amount == pairs_outstanding * 1_000_000` while `Open`) across the
//! happy path, a random mint/redeem sequence, and the guard/boundary cases listed in
//! `contracts/program-instructions.md`.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::math::ONE_USDC;
use meridian::state::config::Config;
use meridian::state::market::{Market, MarketState};

use common::*;

const DAY: u32 = 20261007;

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

/// Mints `amount` test USDC into `destination`, signed by `admin` (the test USDC mint's
/// authority, set in `Env::new`).
fn mint_usdc(env: &mut Env, destination: Pubkey, amount: u64) {
    let admin = env.admin.insecure_clone();
    let usdc_mint_addr = addr(env.usdc_mint);
    let dest_addr = addr(destination);
    TokenMintTo::new(&mut env.svm, &admin, &usdc_mint_addr, &dest_addr, amount)
        .send()
        .expect("mint test USDC should succeed");
}

/// Raw SPL token account `amount` field (bytes 64..72), same approach as
/// `tests/create_market.rs`'s `read_token_amount` (plain SPL accounts have no Anchor
/// discriminator, so `Env::fetch`'s Anchor deserialization doesn't apply).
fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env
        .svm
        .get_account(&addr(account))
        .expect("token account missing");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Builds and sends a `mint_pair(qty)` instruction for `user` against `market`, using
/// `market`'s own yes/no mints and vault and `user`'s associated Yes/No accounts
/// (created `init_if_needed` by the instruction itself).
#[allow(clippy::too_many_arguments)]
fn send_mint_pair(
    env: &mut Env,
    user: &Keypair,
    market: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    vault: Pubkey,
    user_usdc: Pubkey,
    qty: u64,
) -> TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::MintPair {
        user: user_pk,
        config: config_pda(),
        market,
        yes_mint,
        no_mint,
        vault,
        user_usdc,
        user_yes: get_associated_token_address_with_program_id(&user_pk, &yes_mint, &anchor_spl::token_2022::ID),
        user_no: get_associated_token_address_with_program_id(&user_pk, &no_mint, &anchor_spl::token_2022::ID),
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

/// Builds and sends a `redeem_pair(qty)` instruction, mirroring `send_mint_pair`'s
/// account shape (the user's Yes/No ATAs must already exist -- `redeem_pair` does not
/// `init_if_needed` them).
#[allow(clippy::too_many_arguments)]
fn send_redeem_pair(
    env: &mut Env,
    user: &Keypair,
    market: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    vault: Pubkey,
    user_usdc: Pubkey,
    qty: u64,
) -> TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::RedeemPair {
        user: user_pk,
        config: config_pda(),
        market,
        yes_mint,
        no_mint,
        vault,
        user_usdc,
        user_yes: get_associated_token_address_with_program_id(&user_pk, &yes_mint, &anchor_spl::token_2022::ID),
        user_no: get_associated_token_address_with_program_id(&user_pk, &no_mint, &anchor_spl::token_2022::ID),
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

/// Sets up one `Env` with an initialized config, one open market, and one user holding
/// `usdc_funding` test USDC in their own ATA. Returns `(env, user, market_result,
/// user_usdc)`.
fn setup(usdc_funding: u64) -> (Env, Keypair, CreateMarketResult, Pubkey) {
    let mut env = Env::new();
    env.init_config();
    let close_ts = far_future_close_ts(&env);
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    if usdc_funding > 0 {
        mint_usdc(&mut env, user_usdc, usdc_funding);
    }

    (env, user, market, user_usdc)
}

/// Calls `pause()`/`unpause()`, signed by `signer` (private copies of
/// `tests/pause.rs`'s helpers, per this file's brief: no cross-file test helper sharing).
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

/// This market's AAPL feed id (private copy of `tests/oracle.rs`/`tests/settle.rs`'s
/// helper, see `pause_as` above).
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

/// Calls `mock_write_price`, signed by `signer` (who pays for `init_if_needed`).
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

/// Calls `settle_market`, signed by `caller` (anyone may call it).
fn settle_market_as(
    env: &mut Env,
    caller: &Keypair,
    market: Pubkey,
    price_account: Pubkey,
) -> TransactionResult {
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

/// Warps to `close_ts`, writes a good mock price for AAPL, and settles `market`. Returns
/// the price account pubkey.
fn settle_with_good_price(env: &mut Env, market: Pubkey, close_ts: i64) -> Pubkey {
    let feed_id = aapl_feed_id(env);
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, 333_000_000, 10_000, -6, close_ts)
        .expect("mock_write_price should succeed");
    let price_account = mock_price_pda(&feed_id);
    settle_market_as(env, &admin, market, price_account).expect("settle_market should succeed");
    price_account
}

fn yes_balance(env: &Env, user: &Keypair, yes_mint: Pubkey) -> u64 {
    let ata = get_associated_token_address_with_program_id(&user.pubkey_pk(), &yes_mint, &anchor_spl::token_2022::ID);
    read_token_amount(env, ata)
}

fn no_balance(env: &Env, user: &Keypair, no_mint: Pubkey) -> u64 {
    let ata = get_associated_token_address_with_program_id(&user.pubkey_pk(), &no_mint, &anchor_spl::token_2022::ID);
    read_token_amount(env, ata)
}

#[test]
fn mint_one_pair_credits_yes_no_and_vault_and_bumps_pairs_outstanding() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed");

    assert_eq!(yes_balance(&env, &user, market.yes_mint), 1_000_000);
    assert_eq!(no_balance(&env, &user, market.no_mint), 1_000_000);
    assert_eq!(read_token_amount(&env, market.vault), 1_000_000);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 1);
}

#[test]
fn redeem_one_pair_returns_exactly_one_usdc_and_burns_both_sides() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed");

    let usdc_before = read_token_amount(&env, user_usdc);

    send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("redeem_pair should succeed");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 1_000_000);
    assert_eq!(yes_balance(&env, &user, market.yes_mint), 0);
    assert_eq!(no_balance(&env, &user, market.no_mint), 0);
    assert_eq!(read_token_amount(&env, market.vault), 0);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 0);
}

/// Tiny deterministic PRNG (splitmix64-ish LCG) so the property test is reproducible
/// without pulling in a `rand` dependency.
fn next_rand(state: &mut u64) -> u64 {
    *state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
    *state
}

#[test]
fn property_random_mint_redeem_sequence_preserves_vault_equation() {
    let (mut env, user, market, user_usdc) = setup(10_000 * ONE_USDC);

    let mut rng_state: u64 = 0xA5A5_5A5A_1234_5678;
    let mut held: u64 = 0;

    for step in 0..25u32 {
        let want_mint = held == 0 || next_rand(&mut rng_state) % 2 == 0;

        if want_mint {
            let qty = 1 + (next_rand(&mut rng_state) % 5);
            send_mint_pair(
                &mut env,
                &user,
                market.market,
                market.yes_mint,
                market.no_mint,
                market.vault,
                user_usdc,
                qty,
            )
            .unwrap_or_else(|e| panic!("step {step}: mint {qty} should succeed: {e:?}"));
            held += qty;
        } else {
            let qty = 1 + (next_rand(&mut rng_state) % held);
            send_redeem_pair(
                &mut env,
                &user,
                market.market,
                market.yes_mint,
                market.no_mint,
                market.vault,
                user_usdc,
                qty,
            )
            .unwrap_or_else(|e| panic!("step {step}: redeem {qty} should succeed: {e:?}"));
            held -= qty;
        }

        let m: Market = env.fetch(market.market);
        let expected_vault = m
            .pairs_outstanding
            .checked_mul(ONE_USDC)
            .expect("pairs_outstanding * ONE_USDC should not overflow in this test");
        assert_eq!(
            read_token_amount(&env, market.vault),
            expected_vault,
            "step {step}: vault equation violated"
        );
        assert_eq!(m.pairs_outstanding, held, "step {step}: pairs_outstanding drifted from local tracking");
    }
}

#[test]
fn mint_zero_is_refused() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    let result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        0,
    );
    assert_err(&result, MeridianError::ZeroQuantity);
}

#[test]
fn redeem_zero_is_refused() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    // Mint 1 first so the user's Yes/No ATAs exist (redeem_pair does not
    // `init_if_needed` them).
    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed");

    let result = send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        0,
    );
    assert_err(&result, MeridianError::ZeroQuantity);

    // Untouched: still holding the 1 pair minted above.
    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 1);
}

#[test]
fn redeem_more_than_held_fails() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed");

    let result = send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        2,
    );
    assert!(result.is_err(), "redeeming more than held should fail");
}

#[test]
fn mint_with_insufficient_usdc_fails() {
    // No USDC funding at all.
    let (mut env, user, market, user_usdc) = setup(0);

    let result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    );
    assert!(result.is_err(), "minting without enough USDC should fail");
}

#[test]
fn mint_against_another_markets_vault_is_refused_by_constraint() {
    let (mut env, user, market_a, user_usdc) = setup(10 * ONE_USDC);

    let close_ts = far_future_close_ts(&env);
    let market_b = env
        .create_market(CreateMarketArgs::new("AAPL", 110_000_000, DAY, close_ts, 16))
        .expect("second create_market should succeed");

    // Correct market/mints for A, but B's vault.
    let result = send_mint_pair(
        &mut env,
        &user,
        market_a.market,
        market_a.yes_mint,
        market_a.no_mint,
        market_b.vault,
        user_usdc,
        1,
    );
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn mint_u64_max_fails_cleanly() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    let result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        u64::MAX,
    );
    assert!(result.is_err(), "minting u64::MAX pairs should fail cleanly, not overflow silently");
}

#[test]
fn mint_after_settlement_is_refused() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    let close_ts: Market = env.fetch(market.market);
    let close_ts = close_ts.close_ts;
    settle_with_good_price(&mut env, market.market, close_ts);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);

    let result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    );
    assert_err(&result, MeridianError::MarketSettled);
}

#[test]
fn redeem_pair_succeeds_while_paused_then_mint_resumes_after_unpause() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    // Mint 1 pair before pausing, so there is something to redeem while paused.
    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed before pausing");

    let admin = env.admin.insecure_clone();
    pause_as(&mut env, &admin).expect("pause should succeed");

    // mint_pair while paused -> Paused.
    let mint_result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    );
    assert_err(&mint_result, MeridianError::Paused);

    // redeem_pair while paused -> succeeds (FR-006, FR-034).
    send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("redeem_pair should succeed while paused");

    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 0);

    // unpause -> mint works again.
    unpause_as(&mut env, &admin).expect("unpause should succeed");
    let cfg: Config = env.fetch(config_pda());
    assert!(!cfg.paused);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed again after unpause");
}

// ---- Vault invariant tolerates unsolicited deposits (Wave 3 review fix item 1) ----

#[test]
fn unsolicited_vault_deposit_is_tolerated_and_never_paid_out() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    // An "airdrop"-style direct transfer straight into the vault token account, with no
    // corresponding mint_pair call -- simulates a stray/unsolicited deposit.
    mint_usdc(&mut env, market.vault, 1);
    assert_eq!(read_token_amount(&env, market.vault), 1);

    // mint_pair must still succeed: the invariant is `vault.amount >= pairs_outstanding *
    // 1_000_000`, not equality, so the extra 1 micro-USDC does not block it.
    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair should succeed despite the unsolicited surplus in the vault");

    assert_eq!(read_token_amount(&env, market.vault), 1_000_001);

    let usdc_before = read_token_amount(&env, user_usdc);

    // redeem_pair must still succeed and must pay out exactly qty * 1_000_000 -- the
    // surplus is never paid out.
    send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        1,
    )
    .expect("redeem_pair should succeed despite the unsolicited surplus in the vault");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 1_000_000);
    // The 1 micro-USDC surplus is still sitting in the vault, untouched.
    assert_eq!(read_token_amount(&env, market.vault), 1);

    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 0);
}

// ---- Post-settlement redeem_pair invariant (Wave 3 review fix item 2) ----

#[test]
fn redeem_pair_after_settlement_pays_exact_amount_and_holds_winning_supply_invariant() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);
    let close_ts = far_future_close_ts(&env);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        3,
    )
    .expect("mint_pair should succeed");

    settle_with_good_price(&mut env, market.market, close_ts);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.state, MarketState::Settled);
    // settle_with_good_price writes a price of 333_000_000, above this market's strike
    // (100_000_000), so the winning side is Yes.
    assert_eq!(m.outcome, meridian::state::market::Outcome::Yes);

    let usdc_before = read_token_amount(&env, user_usdc);

    send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        2,
    )
    .expect("redeem_pair should succeed post-settlement");

    // Exact payout: 2 pairs * 1_000_000, no more, no less.
    assert_eq!(read_token_amount(&env, user_usdc), usdc_before + 2_000_000);
    assert_eq!(yes_balance(&env, &user, market.yes_mint), 1_000_000);
    assert_eq!(no_balance(&env, &user, market.no_mint), 1_000_000);

    // `pairs_outstanding` stays frozen at its pre-settlement value.
    let after: Market = env.fetch(market.market);
    assert_eq!(after.pairs_outstanding, 3);

    // The on-chain invariant the instruction itself enforced: vault.amount >=
    // winning_mint.supply (both base units, no scaling). Re-derive and check it here too.
    let yes_mint_account: anchor_spl::token_interface::Mint = env.fetch(market.yes_mint);
    assert_eq!(read_token_amount(&env, market.vault), yes_mint_account.supply);
}

// ---- Adversarial account substitution (Wave 3 review fix item 5) ----
//
// Each test below must fail *and* leave every balance, mint supply, and
// `pairs_outstanding` unchanged.

#[test]
fn redeem_with_another_markets_yes_mint_is_refused_and_state_unchanged() {
    let (mut env, user, market_a, user_usdc) = setup(10 * ONE_USDC);
    let close_ts = far_future_close_ts(&env);
    let market_b = env
        .create_market(CreateMarketArgs::new("AAPL", 110_000_000, DAY, close_ts, 16))
        .expect("second create_market should succeed");

    send_mint_pair(
        &mut env,
        &user,
        market_a.market,
        market_a.yes_mint,
        market_a.no_mint,
        market_a.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair on market A should succeed");

    // The user also mints 1 pair on market B, purely so their Yes ATA for market B's
    // yes_mint already exists -- otherwise the adversarial call below would fail on
    // `user_yes` deserialization (AccountNotInitialized) instead of isolating the
    // `yes_mint` address-constraint violation this test is actually about.
    send_mint_pair(
        &mut env,
        &user,
        market_b.market,
        market_b.yes_mint,
        market_b.no_mint,
        market_b.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair on market B should succeed");

    let usdc_before = read_token_amount(&env, user_usdc);
    let yes_a_before = yes_balance(&env, &user, market_a.yes_mint);
    let no_before = no_balance(&env, &user, market_a.no_mint);
    let vault_before = read_token_amount(&env, market_a.vault);
    let yes_b_before = yes_balance(&env, &user, market_b.yes_mint);

    // Market A's own vault/no_mint, but market B's yes_mint.
    let result = send_redeem_pair(
        &mut env,
        &user,
        market_a.market,
        market_b.yes_mint,
        market_a.no_mint,
        market_a.vault,
        user_usdc,
        1,
    );
    assert_err(&result, MeridianError::InvariantViolated);
    assert_eq!(yes_balance(&env, &user, market_b.yes_mint), yes_b_before);

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before);
    assert_eq!(yes_balance(&env, &user, market_a.yes_mint), yes_a_before);
    assert_eq!(no_balance(&env, &user, market_a.no_mint), no_before);
    assert_eq!(read_token_amount(&env, market_a.vault), vault_before);
    let m: Market = env.fetch(market_a.market);
    assert_eq!(m.pairs_outstanding, 1);
}

#[test]
fn redeem_with_another_markets_vault_is_refused_and_state_unchanged() {
    let (mut env, user, market_a, user_usdc) = setup(10 * ONE_USDC);
    let close_ts = far_future_close_ts(&env);
    let market_b = env
        .create_market(CreateMarketArgs::new("AAPL", 110_000_000, DAY, close_ts, 16))
        .expect("second create_market should succeed");

    send_mint_pair(
        &mut env,
        &user,
        market_a.market,
        market_a.yes_mint,
        market_a.no_mint,
        market_a.vault,
        user_usdc,
        1,
    )
    .expect("mint_pair on market A should succeed");

    let usdc_before = read_token_amount(&env, user_usdc);
    let yes_before = yes_balance(&env, &user, market_a.yes_mint);
    let no_before = no_balance(&env, &user, market_a.no_mint);
    let vault_a_before = read_token_amount(&env, market_a.vault);
    let vault_b_before = read_token_amount(&env, market_b.vault);

    let result = send_redeem_pair(
        &mut env,
        &user,
        market_a.market,
        market_a.yes_mint,
        market_a.no_mint,
        market_b.vault,
        user_usdc,
        1,
    );
    assert_err(&result, MeridianError::InvariantViolated);

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before);
    assert_eq!(yes_balance(&env, &user, market_a.yes_mint), yes_before);
    assert_eq!(no_balance(&env, &user, market_a.no_mint), no_before);
    assert_eq!(read_token_amount(&env, market_a.vault), vault_a_before);
    assert_eq!(read_token_amount(&env, market_b.vault), vault_b_before);
    let m: Market = env.fetch(market_a.market);
    assert_eq!(m.pairs_outstanding, 1);
}

#[test]
fn mint_with_user_usdc_owned_by_a_stranger_is_refused_and_state_unchanged() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    let stranger = new_user(&mut env);
    let stranger_usdc = create_usdc_ata(&mut env, &stranger);
    mint_usdc(&mut env, stranger_usdc, 10 * ONE_USDC);

    let usdc_before = read_token_amount(&env, user_usdc);
    let stranger_usdc_before = read_token_amount(&env, stranger_usdc);
    let vault_before = read_token_amount(&env, market.vault);

    // `user` signs, but `user_usdc` is the stranger's token account, not `user`'s --
    // violates the `token::authority = user` constraint.
    let result = send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        stranger_usdc,
        1,
    );
    assert!(result.is_err(), "minting against a stranger-owned user_usdc should fail");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before);
    assert_eq!(read_token_amount(&env, stranger_usdc), stranger_usdc_before);
    assert_eq!(read_token_amount(&env, market.vault), vault_before);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 0);
}

#[test]
fn mint_with_user_yes_ata_belonging_to_another_wallet_is_refused_and_state_unchanged() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    let other_wallet = new_user(&mut env);
    // Another wallet's Yes ATA for this same market -- a valid address, just not `user`'s.
    let other_wallet_yes = get_associated_token_address_with_program_id(&other_wallet.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID);

    let usdc_before = read_token_amount(&env, user_usdc);
    let vault_before = read_token_amount(&env, market.vault);

    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::MintPair {
        user: user_pk,
        config: config_pda(),
        market: market.market,
        yes_mint: market.yes_mint,
        no_mint: market.no_mint,
        vault: market.vault,
        user_usdc,
        user_yes: other_wallet_yes,
        user_no: get_associated_token_address_with_program_id(&user_pk, &market.no_mint, &anchor_spl::token_2022::ID),
        usdc_token_program: anchor_spl::token::ID,
        yesno_token_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let data = meridian::instruction::MintPair { qty: 1 };
    let ix = build_ix(meridian::ID, accounts, data);
    let user_clone = user.insecure_clone();
    let result = env.send(&[ix], &[&user_clone]);
    assert!(
        result.is_err(),
        "minting with user_yes belonging to another wallet should fail"
    );

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before);
    assert_eq!(read_token_amount(&env, market.vault), vault_before);
    assert_eq!(
        env.account_data_len(other_wallet_yes),
        None,
        "the other wallet's Yes ATA should not have been created"
    );
    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 0);
}

#[test]
fn redeem_with_sufficient_yes_but_insufficient_no_rolls_back_entirely() {
    let (mut env, user, market, user_usdc) = setup(10 * ONE_USDC);

    send_mint_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        2,
    )
    .expect("mint_pair should succeed");

    // Drain 1 No token away to another wallet, leaving the user with 2 Yes but only 1 No.
    let other_wallet = new_user(&mut env);
    let other_no_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &other_wallet, &addr(market.no_mint))
        .token_program_id(&addr(anchor_spl::token_2022::ID))
        .send()
        .expect("create other wallet's No ata should succeed");
    let user_clone = user.insecure_clone();
    let user_no_ata = get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.no_mint, &anchor_spl::token_2022::ID);
    let drain_ix = yes_no_transfer_checked_ix(market.no_mint, user_no_ata, pk(other_no_ata), user.pubkey_pk(), 1_000_000);
    env.send(&[drain_ix], &[&user_clone])
        .expect("draining 1 No token to another wallet should succeed");

    assert_eq!(yes_balance(&env, &user, market.yes_mint), 2_000_000);
    assert_eq!(no_balance(&env, &user, market.no_mint), 1_000_000);

    let usdc_before = read_token_amount(&env, user_usdc);
    let yes_before = yes_balance(&env, &user, market.yes_mint);
    let no_before = no_balance(&env, &user, market.no_mint);
    let vault_before = read_token_amount(&env, market.vault);

    // qty=2: the Yes burn (2_000_000) succeeds, but the No burn (2_000_000, user only has
    // 1_000_000) fails -- the whole transaction must roll back, including the Yes burn.
    let result = send_redeem_pair(
        &mut env,
        &user,
        market.market,
        market.yes_mint,
        market.no_mint,
        market.vault,
        user_usdc,
        2,
    );
    assert!(result.is_err(), "redeeming with insufficient No should fail");

    assert_eq!(read_token_amount(&env, user_usdc), usdc_before);
    assert_eq!(yes_balance(&env, &user, market.yes_mint), yes_before);
    assert_eq!(no_balance(&env, &user, market.no_mint), no_before);
    assert_eq!(read_token_amount(&env, market.vault), vault_before);
    let m: Market = env.fetch(market.market);
    assert_eq!(m.pairs_outstanding, 2);
}
