//! `redeem_winning` tests (Wave 4, T025/T028/T030 proof).
//!
//! Covers `specs/001-binary-outcome-markets/data-model.md`'s post-settlement invariant
//! (`vault.amount >= winning_mint.supply`) and `contracts/program-instructions.md`'s
//! "Redeem Winning" row across Yes/tie/No outcomes, partial redemption, over-redemption,
//! pre-settlement, paused, a week-later redemption, and interplay with `redeem_pair`.
//! All helpers below are private to this file (no cross-file test helper sharing, per
//! this wave's brief).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm::types::TransactionResult;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::math::ONE_USDC;
use meridian::state::market::{Market, Outcome};

use common::*;

const DAY: u32 = 20261007;

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

/// Raw SPL token account `amount` field (bytes 64..72); plain SPL accounts have no
/// Anchor discriminator, so `Env::fetch`'s Anchor deserialization doesn't apply.
fn read_token_amount(env: &Env, account: Pubkey) -> u64 {
    let acc = env
        .svm
        .get_account(&addr(account))
        .expect("token account missing");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

/// Builds and sends a `mint_pair(qty)` instruction for `user` against `market`.
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
/// account shape.
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

/// Builds and sends a `redeem_winning(side, qty)` instruction for `user` against
/// `market`. `user_usdc`/`user_winning` must already exist (this instruction does not
/// `init_if_needed` either -- the user got them from minting or a transfer earlier).
/// `user_winning` is the single token account this instruction touches (Wave 4 review
/// fix: replaces the old `user_yes`/`user_no` pair) -- see `winning_ata` for the usual
/// case of a holder's own associated token account; a test exercising a non-ATA token
/// account (received by transfer into a manually created account) builds it directly.
#[allow(clippy::too_many_arguments)]
fn send_redeem_winning(
    env: &mut Env,
    user: &Keypair,
    market: Pubkey,
    yes_mint: Pubkey,
    no_mint: Pubkey,
    vault: Pubkey,
    user_usdc: Pubkey,
    user_winning: Pubkey,
    side: u8,
    qty: u64,
) -> TransactionResult {
    let user_pk = user.pubkey_pk();
    let accounts = meridian::accounts::RedeemWinning {
        user: user_pk,
        market,
        yes_mint,
        no_mint,
        vault,
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

/// The associated token account `redeem_winning(side, ..)` expects as `user_winning`
/// for `user`: `yes_mint`'s ATA for `side == 1`, `no_mint`'s for `side == 2`.
fn winning_ata(user: &Keypair, yes_mint: Pubkey, no_mint: Pubkey, side: u8) -> Pubkey {
    let mint = if side == 1 { yes_mint } else { no_mint };
    get_associated_token_address_with_program_id(&user.pubkey_pk(), &mint, &anchor_spl::token_2022::ID)
}

/// Calls `pause()`, signed by `signer` (private copy of other test files' helper, per
/// this file's brief: no cross-file test helper sharing).
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

/// Warps to `close_ts`, writes a mock price of `price_micro` for AAPL, and settles
/// `market` via `settle_market` (the real oracle path, not the override).
fn settle_with_price(env: &mut Env, market: Pubkey, close_ts: i64, price_micro: i64) {
    let feed_id = aapl_feed_id(env);
    let admin = env.admin.insecure_clone();
    env.warp_to(close_ts);
    write_mock_price(env, &admin, feed_id, price_micro, 10_000, -6, close_ts)
        .expect("mock_write_price should succeed");
    let price_account = mock_price_pda(&feed_id);
    settle_market_as(env, &admin, market, price_account).expect("settle_market should succeed");
}

fn yes_balance(env: &Env, user: &Keypair, yes_mint: Pubkey) -> u64 {
    read_token_amount(env, get_associated_token_address_with_program_id(&user.pubkey_pk(), &yes_mint, &anchor_spl::token_2022::ID))
}

fn no_balance(env: &Env, user: &Keypair, no_mint: Pubkey) -> u64 {
    read_token_amount(env, get_associated_token_address_with_program_id(&user.pubkey_pk(), &no_mint, &anchor_spl::token_2022::ID))
}

/// Sets up one `Env` with an initialized config, one open AAPL market at `strike`, and
/// two funded users A and B who each mint `n_a`/`n_b` pairs. Returns everything a test
/// needs to settle and redeem.
struct Setup {
    env: Env,
    market: CreateMarketResult,
    close_ts: i64,
    user_a: Keypair,
    user_a_usdc: Pubkey,
    user_b: Keypair,
    user_b_usdc: Pubkey,
}

fn setup(strike: u64, n_a: u64, n_b: u64) -> Setup {
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", strike, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let user_a = new_user(&mut env);
    let user_a_usdc = create_usdc_ata(&mut env, &user_a);
    mint_usdc(&mut env, user_a_usdc, 10_000 * ONE_USDC);
    if n_a > 0 {
        send_mint_pair(
            &mut env,
            &user_a,
            market.market,
            market.yes_mint,
            market.no_mint,
            market.vault,
            user_a_usdc,
            n_a,
        )
        .expect("user A mint_pair should succeed");
    }

    let user_b = new_user(&mut env);
    let user_b_usdc = create_usdc_ata(&mut env, &user_b);
    mint_usdc(&mut env, user_b_usdc, 10_000 * ONE_USDC);
    if n_b > 0 {
        send_mint_pair(
            &mut env,
            &user_b,
            market.market,
            market.yes_mint,
            market.no_mint,
            market.vault,
            user_b_usdc,
            n_b,
        )
        .expect("user B mint_pair should succeed");
    }

    Setup {
        env,
        market,
        close_ts,
        user_a,
        user_a_usdc,
        user_b,
        user_b_usdc,
    }
}

#[test]
fn yes_wins_redeems_full_amount_and_burns_only_yes() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::Yes);

    let usdc_before = read_token_amount(&s.env, s.user_a_usdc);
    let no_before = no_balance(&s.env, &s.user_a, s.market.no_mint);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        10,
    )
    .expect("redeem_winning Yes should succeed");

    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), usdc_before + 10 * ONE_USDC);
    assert_eq!(yes_balance(&s.env, &s.user_a, s.market.yes_mint), 0);
    // No side is untouched by redeem_winning.
    assert_eq!(no_balance(&s.env, &s.user_a, s.market.no_mint), no_before);
}

#[test]
fn wrong_side_is_refused_when_redeeming_the_losing_token() {
    let mut s = setup(680_000_000, 10, 5);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::Yes);

    // User B holds No (the losing side) and tries to redeem it as if it won.
    let result = send_redeem_winning(
        &mut s.env,
        &s.user_b,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_b_usdc,
        winning_ata(&s.user_b, s.market.yes_mint, s.market.no_mint, 2),
        2,
        5,
    );
    assert_err(&result, MeridianError::WrongSide);
}

#[test]
fn tie_price_equals_strike_resolves_yes() {
    let mut s = setup(680_000_000, 4, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 680_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::Yes);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        4,
    )
    .expect("redeem_winning Yes should succeed on a tie");
}

#[test]
fn no_wins_mirror_case() {
    let mut s = setup(680_000_000, 0, 6);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 675_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::No);

    let usdc_before = read_token_amount(&s.env, s.user_b_usdc);

    send_redeem_winning(
        &mut s.env,
        &s.user_b,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_b_usdc,
        winning_ata(&s.user_b, s.market.yes_mint, s.market.no_mint, 2),
        2,
        6,
    )
    .expect("redeem_winning No should succeed");

    assert_eq!(read_token_amount(&s.env, s.user_b_usdc), usdc_before + 6 * ONE_USDC);
    assert_eq!(no_balance(&s.env, &s.user_b, s.market.no_mint), 0);
}

#[test]
fn partial_redemption_in_two_steps() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    let usdc_before = read_token_amount(&s.env, s.user_a_usdc);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        3,
    )
    .expect("first partial redeem (3) should succeed");
    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), usdc_before + 3 * ONE_USDC);
    assert_eq!(yes_balance(&s.env, &s.user_a, s.market.yes_mint), 7 * ONE_USDC);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        7,
    )
    .expect("second partial redeem (7) should succeed");
    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), usdc_before + 10 * ONE_USDC);
    assert_eq!(yes_balance(&s.env, &s.user_a, s.market.yes_mint), 0);
}

#[test]
fn redeeming_more_than_held_fails_and_state_unchanged() {
    let mut s = setup(680_000_000, 5, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    let usdc_before = read_token_amount(&s.env, s.user_a_usdc);
    let yes_before = yes_balance(&s.env, &s.user_a, s.market.yes_mint);
    let vault_before = read_token_amount(&s.env, s.market.vault);

    let result = send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        6,
    );
    assert!(result.is_err(), "redeeming more Yes than held should fail");

    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), usdc_before);
    assert_eq!(yes_balance(&s.env, &s.user_a, s.market.yes_mint), yes_before);
    assert_eq!(read_token_amount(&s.env, s.market.vault), vault_before);
}

#[test]
fn redeem_before_settlement_is_refused() {
    let mut s = setup(680_000_000, 5, 0);
    // Market is still Open -- no settle_with_price call.
    let result = send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        1,
    );
    assert_err(&result, MeridianError::MarketNotSettled);
}

#[test]
fn redeem_while_paused_succeeds() {
    let mut s = setup(680_000_000, 5, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    let admin = s.env.admin.insecure_clone();
    pause_as(&mut s.env, &admin).expect("pause should succeed");

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        5,
    )
    .expect("redeem_winning should succeed while paused (no Config account, no pause guard)");
}

#[test]
fn redeem_one_week_later_succeeds() {
    let mut s = setup(680_000_000, 5, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    s.env.warp_to(s.close_ts + 7 * 24 * 3600);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        5,
    )
    .expect("redeem_winning a week later should succeed");
}

#[test]
fn after_all_yes_redeemed_vault_is_empty_and_invariant_holds() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        10,
    )
    .expect("redeem_winning should succeed");

    assert_eq!(read_token_amount(&s.env, s.market.vault), 0);
    let yes_mint_account: anchor_spl::token_interface::Mint = s.env.fetch(s.market.yes_mint);
    assert_eq!(yes_mint_account.supply, 0);
    // vault.amount >= yes_mint.supply holds trivially: 0 >= 0.
    assert!(read_token_amount(&s.env, s.market.vault) >= yes_mint_account.supply);
}

#[test]
fn redeem_pair_after_settlement_still_works_for_a_both_sides_holder_and_redeem_winning_stays_consistent() {
    // User B holds both Yes and No (never traded them away). After settlement they can
    // still use redeem_pair to cash out both legs at once; this must not disturb the
    // post-settlement invariant that redeem_winning (used by user A on the winning Yes
    // side) relies on.
    let mut s = setup(680_000_000, 10, 4);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::Yes);

    // User B redeems their pair (both Yes and No) via redeem_pair, the ordinary
    // any-state instruction.
    let b_usdc_before = read_token_amount(&s.env, s.user_b_usdc);
    send_redeem_pair(
        &mut s.env,
        &s.user_b,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_b_usdc,
        4,
    )
    .expect("redeem_pair after settlement should still work for a both-sides holder");
    assert_eq!(read_token_amount(&s.env, s.user_b_usdc), b_usdc_before + 4 * ONE_USDC);

    // User A then redeems their winning Yes via redeem_winning; the vault must still
    // have enough to pay them (vault.amount >= yes_mint.supply before this redemption).
    let yes_mint_account: anchor_spl::token_interface::Mint = s.env.fetch(s.market.yes_mint);
    assert!(read_token_amount(&s.env, s.market.vault) >= yes_mint_account.supply);

    let a_usdc_before = read_token_amount(&s.env, s.user_a_usdc);
    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        10,
    )
    .expect("redeem_winning should still succeed after another holder's redeem_pair");
    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), a_usdc_before + 10 * ONE_USDC);

    // Vault is now exactly empty: all Yes (the winning side) has been redeemed one way
    // or another, and No (the losing side) pays out nothing.
    assert_eq!(read_token_amount(&s.env, s.market.vault), 0);
}

// ---- Wave 4 review fixes (items 6, 38) ----

/// Directly bumps the vault's raw SPL `amount` field (bytes 64..72) by `delta`,
/// bypassing any CPI entirely -- simulates an unsolicited extra deposit landing
/// straight in the vault.
fn bump_vault(env: &mut Env, vault: Pubkey, delta: u64) {
    let address = addr(vault);
    let mut acc = env.svm.get_account(&address).expect("vault should exist");
    let current = u64::from_le_bytes(acc.data[64..72].try_into().unwrap());
    let new_amount = current.checked_add(delta).expect("test amount should not overflow");
    acc.data[64..72].copy_from_slice(&new_amount.to_le_bytes());
    env.svm.set_account(address, acc).expect("set_account should succeed");
}

#[test]
fn holder_who_only_received_yes_by_transfer_and_never_minted_redeems_successfully() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);
    let m: Market = s.env.fetch(s.market.market);
    assert_eq!(m.outcome, Outcome::Yes);

    // User C never mints a pair; they receive 4 Yes tokens from user A via a plain SPL
    // transfer (not `mint_pair`), yet `redeem_winning` must still work for them --
    // nothing in the instruction should assume the redeemer ever minted.
    let user_c = new_user(&mut s.env);
    let user_c_usdc = create_usdc_ata(&mut s.env, &user_c);
    let yes_mint_addr = addr(s.market.yes_mint);
    let user_c_yes_addr = CreateAssociatedTokenAccount::new(&mut s.env.svm, &user_c, &yes_mint_addr)
        .token_program_id(&addr(anchor_spl::token_2022::ID))
        .send()
        .expect("create user C's Yes ata should succeed");
    let user_c_yes = pk(user_c_yes_addr);

    let user_a = s.user_a.insecure_clone();
    let user_a_yes = get_associated_token_address_with_program_id(&user_a.pubkey_pk(), &s.market.yes_mint, &anchor_spl::token_2022::ID);
    let transfer_ix =
        yes_no_transfer_checked_ix(s.market.yes_mint, user_a_yes, pk(user_c_yes_addr), user_a.pubkey_pk(), 4 * ONE_USDC);
    s.env
        .send(&[transfer_ix], &[&user_a])
        .expect("transfer of Yes from user A to user C should succeed");
    assert_eq!(read_token_amount(&s.env, user_c_yes), 4 * ONE_USDC);

    let usdc_before = read_token_amount(&s.env, user_c_usdc);
    send_redeem_winning(
        &mut s.env,
        &user_c,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        user_c_usdc,
        user_c_yes,
        1,
        4,
    )
    .expect("redeem_winning should succeed for a holder who only ever received Yes by transfer");

    assert_eq!(read_token_amount(&s.env, user_c_usdc), usdc_before + 4 * ONE_USDC);
    assert_eq!(read_token_amount(&s.env, user_c_yes), 0);
}

#[test]
fn surplus_in_vault_is_preserved_after_all_winners_redeem() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    // Simulate an unsolicited extra micro-USDC landing directly in the vault.
    let vault_before_bump = read_token_amount(&s.env, s.market.vault);
    bump_vault(&mut s.env, s.market.vault, 1);
    assert_eq!(read_token_amount(&s.env, s.market.vault), vault_before_bump + 1);

    let usdc_before = read_token_amount(&s.env, s.user_a_usdc);
    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        10,
    )
    .expect("redeem_winning should succeed with a surplus sitting in the vault");

    // Paid out exactly 10 * ONE_USDC -- the pre-existing surplus micro-USDC is never
    // distributed.
    assert_eq!(read_token_amount(&s.env, s.user_a_usdc), usdc_before + 10 * ONE_USDC);
    assert_eq!(read_token_amount(&s.env, s.market.vault), 1, "the surplus should still be sitting in the vault");
}

#[test]
fn pairs_outstanding_is_unchanged_by_redeem_winning() {
    let mut s = setup(680_000_000, 10, 0);
    settle_with_price(&mut s.env, s.market.market, s.close_ts, 685_000_000);

    let before: Market = s.env.fetch(s.market.market);
    let pairs_before = before.pairs_outstanding;

    send_redeem_winning(
        &mut s.env,
        &s.user_a,
        s.market.market,
        s.market.yes_mint,
        s.market.no_mint,
        s.market.vault,
        s.user_a_usdc,
        winning_ata(&s.user_a, s.market.yes_mint, s.market.no_mint, 1),
        1,
        10,
    )
    .expect("redeem_winning should succeed");

    let after: Market = s.env.fetch(s.market.market);
    assert_eq!(
        after.pairs_outstanding, pairs_before,
        "redeem_winning must not touch pairs_outstanding (only redeem_pair/mint_pair do)"
    );
}
