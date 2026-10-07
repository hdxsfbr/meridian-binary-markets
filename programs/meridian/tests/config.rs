//! Rust port of `initialize_config` / `update_config` (T018) on litesvm 0.12.0.
//!
//! Ports every case from the retired TypeScript `tests/program/config.test.ts`, plus the
//! full on-chain rejection matrix that TS harness couldn't run (see DECISIONS.md §7): the
//! old `anchor-litesvm`/litesvm-JS 0.8.0 combo corrupted its native heap after a handful
//! of failed transactions in one process, so only one on-chain failure assertion could be
//! spent for the whole `tests/program/**` suite. litesvm 0.12.0 (Rust) has no such limit;
//! every `Config::validate()` rule gets its own on-chain assertion here, on top of the
//! pure-function unit tests already in `src/state/config.rs`.

mod common;

use anchor_lang::prelude::Pubkey;
use litesvm_token::CreateMint;
use solana_signer::Signer;

use meridian::errors::MeridianError;
use meridian::state::config::{Config, OracleProvider};

use common::*;

#[test]
fn initializes_and_every_field_round_trips() {
    let mut env = Env::new();
    let config_pda_key = env.init_config();

    let cfg: Config = env.fetch(config_pda_key);
    assert_eq!(cfg.admin, env.admin.pubkey_pk());
    assert!(!cfg.paused);
    assert_eq!(cfg.usdc_mint, env.usdc_mint);
    assert_eq!(cfg.publishers_len, 1);
    assert_eq!(cfg.max_staleness_secs, 300);
    assert_eq!(cfg.max_conf_bps, 25);
    assert_eq!(cfg.min_publish_offset_secs, 60);
    assert_eq!(cfg.override_delay_secs, 3600);
    assert_eq!(cfg.default_book_capacity, 16);
    assert_eq!(cfg.tickers.len(), 7);
    assert!(cfg.tickers.iter().all(|t| t.enabled));
}

#[test]
fn admin_update_config_changes_oracle_provider_and_revalidates() {
    let mut env = Env::new();
    let config_pda_key = env.init_config();

    let payer_pk = env.payer.pubkey_pk();
    let result = env.update_config(UpdateConfigArgs {
        oracle_provider: Some(OracleProvider::PythReceiver),
        oracle_program: Some(payer_pk),
        ..Default::default()
    });
    assert!(result.is_ok(), "update_config should succeed: {result:?}");

    let cfg: Config = env.fetch(config_pda_key);
    assert_eq!(cfg.oracle_provider, OracleProvider::PythReceiver);
    assert_eq!(cfg.oracle_program, payer_pk);
}

#[test]
fn bad_update_is_rejected_and_state_is_unchanged() {
    let mut env = Env::new();
    let config_pda_key = env.init_config();

    let before: Config = env.fetch(config_pda_key);

    let result = env.update_config(UpdateConfigArgs {
        override_delay_secs: Some(100),
        ..Default::default()
    });
    assert_err(&result, MeridianError::InvariantViolated);

    let after: Config = env.fetch(config_pda_key);
    assert_eq!(after.override_delay_secs, before.override_delay_secs);
    assert_eq!(after.max_staleness_secs, before.max_staleness_secs);
}

#[test]
fn non_admin_update_is_rejected_with_has_one_error() {
    let mut env = Env::new();
    env.init_config();

    let stranger = solana_keypair::Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = env.update_config_as(&stranger, UpdateConfigArgs::default());
    // `has_one = admin @ MeridianError::Unauthorized` resolves to this program's own
    // custom error, not Anchor's generic `ConstraintHasOne` (2001), because the
    // constraint names an explicit error.
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn duplicate_init_is_rejected() {
    let mut env = Env::new();
    env.init_config();

    let admin_pk = env.admin.pubkey_pk();
    let result = env.init_config_with(default_config_args(admin_pk, 16));
    // The `config` PDA's `init` constraint fails with Anchor's built-in
    // `AccountAlreadyInUse`-flavored error surfaced through the system program /
    // Anchor's own account-already-initialized path as a custom instruction error, not
    // one of this program's own `MeridianError` variants.
    assert!(result.is_err(), "second initialize_config should fail");
}

#[test]
fn rejects_usdc_mint_with_wrong_decimals() {
    let mut env = Env::new();
    let bad_mint = CreateMint::new(&mut env.svm, &env.payer)
        .authority(&env.admin.pubkey())
        .decimals(9)
        .send()
        .expect("create 9-decimal mint");
    env.usdc_mint = pk(bad_mint);

    let admin_pk = env.admin.pubkey_pk();
    let result = env.init_config_with(default_config_args(admin_pk, 16));
    assert_err(&result, MeridianError::InvariantViolated);
}

fn rejection_case(mutate: impl FnOnce(&mut InitializeConfigArgs)) {
    let mut env = Env::new();
    let admin_pk = env.admin.pubkey_pk();
    let mut args = default_config_args(admin_pk, 16);
    mutate(&mut args);
    let result = env.init_config_with(args);
    assert_err(&result, MeridianError::InvariantViolated);
}

#[test]
fn rejects_override_delay_below_minimum() {
    rejection_case(|args| args.override_delay_secs = 3599);
}

#[test]
fn rejects_zero_max_staleness() {
    rejection_case(|args| args.max_staleness_secs = 0);
}

#[test]
fn rejects_max_staleness_above_cap() {
    rejection_case(|args| args.max_staleness_secs = 301);
}

#[test]
fn rejects_zero_max_conf_bps() {
    rejection_case(|args| args.max_conf_bps = 0);
}

#[test]
fn rejects_mock_pyth_with_zero_publishers() {
    rejection_case(|args| args.publishers = vec![]);
}

#[test]
fn rejects_mock_pyth_with_oracle_program_not_equal_to_program_id() {
    rejection_case(|args| args.oracle_program = Pubkey::new_unique());
}

#[test]
fn rejects_zero_capacity() {
    rejection_case(|args| args.default_book_capacity = 0);
}
