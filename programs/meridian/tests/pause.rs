//! `pause` / `unpause` tests (Wave 3B, T033/T040 proof).
//!
//! Mint-refused-while-paused is Wave 4A (place_order etc. are still stubs here), so this
//! file only covers the flag flip, authorization, and events.

mod common;

use solana_keypair::Keypair;

use meridian::errors::MeridianError;
use meridian::state::config::Config;

use common::*;

fn pause_as(env: &mut Env, signer: &Keypair) -> litesvm::types::TransactionResult {
    let accounts = meridian::accounts::SetPause {
        admin: signer.pubkey_pk(),
        config: config_pda(),
    };
    let data = meridian::instruction::Pause {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

fn unpause_as(env: &mut Env, signer: &Keypair) -> litesvm::types::TransactionResult {
    let accounts = meridian::accounts::SetPause {
        admin: signer.pubkey_pk(),
        config: config_pda(),
    };
    let data = meridian::instruction::Unpause {};
    let ix = build_ix(meridian::ID, accounts, data);
    let signer = signer.insecure_clone();
    env.send(&[ix], &[&signer])
}

#[test]
fn admin_pause_flips_flag_and_emits() {
    let mut env = Env::new();
    env.init_config();
    let admin = env.admin.insecure_clone();

    let before: Config = env.fetch(config_pda());
    assert!(!before.paused);

    let meta = pause_as(&mut env, &admin).expect("admin pause should succeed");

    let after: Config = env.fetch(config_pda());
    assert!(after.paused);
    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected a `Program data:` log line for the Paused event, got:\n{}",
        meta.logs.join("\n")
    );
}

#[test]
fn non_admin_pause_is_refused_as_unauthorized() {
    let mut env = Env::new();
    env.init_config();

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = pause_as(&mut env, &stranger);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn non_admin_unpause_is_refused_as_unauthorized() {
    let mut env = Env::new();
    env.init_config();

    let stranger = Keypair::new();
    env.airdrop(stranger.pubkey_pk(), 1_000_000_000);

    let result = unpause_as(&mut env, &stranger);
    assert_err(&result, MeridianError::Unauthorized);
}

#[test]
fn unpause_restores() {
    let mut env = Env::new();
    env.init_config();
    let admin = env.admin.insecure_clone();

    pause_as(&mut env, &admin).expect("pause should succeed");
    let paused: Config = env.fetch(config_pda());
    assert!(paused.paused);

    let meta = unpause_as(&mut env, &admin).expect("unpause should succeed");

    let after: Config = env.fetch(config_pda());
    assert!(!after.paused);
    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data:")),
        "expected a `Program data:` log line for the Unpaused event, got:\n{}",
        meta.logs.join("\n")
    );
}
