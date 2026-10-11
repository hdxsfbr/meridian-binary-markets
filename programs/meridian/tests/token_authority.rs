//! Negative invariant test (PRD §5.2 "Tokens can only be created via Mint Pair and only
//! destroyed via Redeem"): a direct, program-bypassing `mint_to`/`burn` against a
//! market's Yes mint must fail no matter who signs it, because the mint's authority is
//! the Market PDA -- which nothing outside this program's own CPIs (`mint_pair`'s
//! `mint_to`, `redeem_pair`'s/`redeem_winning`'s `burn`) can ever sign for. Covers both
//! the admin and an unrelated random user as the would-be signer, and asserts supply is
//! unchanged by every attempt. Token-2022, since `create_market` only ever creates
//! Token-2022 Yes/No mints (see `instructions/create_market.rs`'s module doc comment).
//!
//! All helpers below are private to this file (no cross-file test helper sharing, per
//! the existing test files' convention).

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use litesvm_token::{CreateAssociatedTokenAccount, MintTo as TokenMintTo};
use solana_instruction::account_meta::AccountMeta as SdkAccountMeta;
use solana_instruction::Instruction;
use solana_keypair::Keypair;

use meridian::math::ONE_USDC;

use common::*;

const DAY: u32 = 20261007;

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

fn send_mint_pair(env: &mut Env, user: &Keypair, market: &CreateMarketResult, user_usdc: Pubkey, qty: u64) {
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
    env.send(&[ix], &[&user_clone]).expect("mint_pair should succeed");
}

/// Raw Token-2022 `TokenInstruction::MintTo` (discriminant `7`, data `[amount_le_u64]`,
/// non-checked form -- no `decimals` byte). Built by hand, same reasoning as
/// `common::yes_no_transfer_checked_ix`: `litesvm_token`'s client-side builders are
/// hard-wired to classic Token's program id.
fn mint_to_ix(mint: Pubkey, destination: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(7u8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: addr(anchor_spl::token_2022::ID),
        accounts: vec![
            SdkAccountMeta { pubkey: addr(mint), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(destination), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(authority), is_signer: true, is_writable: false },
        ],
        data,
    }
}

/// Raw Token-2022 `TokenInstruction::Burn` (discriminant `8`, data `[amount_le_u64]`,
/// non-checked form). Same reasoning as `mint_to_ix` above.
fn burn_ix(account: Pubkey, mint: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(8u8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: addr(anchor_spl::token_2022::ID),
        accounts: vec![
            SdkAccountMeta { pubkey: addr(account), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(mint), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(authority), is_signer: true, is_writable: false },
        ],
        data,
    }
}

fn mint_supply(env: &Env, mint: Pubkey) -> u64 {
    let acc = env.svm.get_account(&addr(mint)).expect("mint should exist");
    u64::from_le_bytes(acc.data[36..44].try_into().unwrap())
}

fn token_balance(env: &Env, account: Pubkey) -> u64 {
    let acc = env.svm.get_account(&addr(account)).expect("token account should exist");
    u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
}

#[test]
fn direct_mint_to_outside_mint_pair_always_fails_regardless_of_signer() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * ONE_USDC);
    send_mint_pair(&mut env, &user, &market, user_usdc, 5);

    let supply_before = mint_supply(&env, market.yes_mint);
    assert_eq!(supply_before, 5 * ONE_USDC);

    let user_yes = get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID);

    // The mint authority is the Market PDA (`create_market`'s doc comment): neither the
    // admin nor a random user can ever sign for it, so both direct `mint_to` attempts
    // must fail and leave supply untouched.
    let admin = env.admin.insecure_clone();
    let admin_ix = mint_to_ix(market.yes_mint, user_yes, admin.pubkey_pk(), 1_000_000);
    let admin_result = env.send(&[admin_ix], &[&admin]);
    assert!(admin_result.is_err(), "direct mint_to signed by admin must fail (admin is not the mint authority)");
    assert_eq!(mint_supply(&env, market.yes_mint), supply_before, "supply must be unchanged after the failed admin mint_to");

    let random_user = new_user(&mut env);
    let random_ix = mint_to_ix(market.yes_mint, user_yes, random_user.pubkey_pk(), 1_000_000);
    let random_result = env.send(&[random_ix], &[&random_user]);
    assert!(random_result.is_err(), "direct mint_to signed by a random user must fail (not the mint authority either)");
    assert_eq!(mint_supply(&env, market.yes_mint), supply_before, "supply must be unchanged after the failed random-user mint_to");
}

#[test]
fn direct_burn_outside_redeem_always_fails_regardless_of_signer() {
    let mut env = Env::new();
    env.init_config();
    let close_ts = env.now() + 3600;
    let market = env
        .create_market(CreateMarketArgs::new("AAPL", 100_000_000, DAY, close_ts, 16))
        .expect("create_market should succeed");

    let user = new_user(&mut env);
    let user_usdc = create_usdc_ata(&mut env, &user);
    mint_usdc(&mut env, user_usdc, 10 * ONE_USDC);
    send_mint_pair(&mut env, &user, &market, user_usdc, 5);

    let user_yes = get_associated_token_address_with_program_id(&user.pubkey_pk(), &market.yes_mint, &anchor_spl::token_2022::ID);
    let supply_before = mint_supply(&env, market.yes_mint);
    let balance_before = token_balance(&env, user_yes);
    assert_eq!(balance_before, 5 * ONE_USDC);

    // Neither the admin nor a random user is `user_yes`'s owner (the SPL program's own
    // authority check, independent of the mint authority), so both direct `burn`
    // attempts must fail -- there is no way to destroy this holder's tokens except
    // through `redeem_pair`/`redeem_winning`, which burn with the holder as authority.
    let admin = env.admin.insecure_clone();
    let admin_ix = burn_ix(user_yes, market.yes_mint, admin.pubkey_pk(), 1_000_000);
    let admin_result = env.send(&[admin_ix], &[&admin]);
    assert!(admin_result.is_err(), "direct burn signed by admin must fail (admin does not own user_yes)");
    assert_eq!(mint_supply(&env, market.yes_mint), supply_before, "supply must be unchanged after the failed admin burn");
    assert_eq!(token_balance(&env, user_yes), balance_before, "balance must be unchanged after the failed admin burn");

    let random_user = new_user(&mut env);
    let random_ix = burn_ix(user_yes, market.yes_mint, random_user.pubkey_pk(), 1_000_000);
    let random_result = env.send(&[random_ix], &[&random_user]);
    assert!(random_result.is_err(), "direct burn signed by a random user must fail (not the owner either)");
    assert_eq!(mint_supply(&env, market.yes_mint), supply_before, "supply must be unchanged after the failed random-user burn");
    assert_eq!(token_balance(&env, user_yes), balance_before, "balance must be unchanged after the failed random-user burn");
}
