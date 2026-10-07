//! Proves the TS harness's heap-corruption bug (DECISIONS.md §7) is gone on Rust/litesvm
//! 0.12.0: 60 deliberately failing transactions in a loop, followed by a successful
//! `create_market`, all in one process/one `LiteSVM` instance.

mod common;

use meridian::errors::MeridianError;

use common::*;

#[test]
fn sixty_failures_then_a_success_in_one_litesvm_instance() {
    let mut env = Env::new();
    env.init_config();

    for i in 0..60 {
        let stranger = solana_keypair::Keypair::new();
        env.airdrop(stranger.pubkey_pk(), 1_000_000_000);
        let result = env.update_config_as(&stranger, UpdateConfigArgs::default());
        assert_err(&result, MeridianError::Unauthorized);
        if i == 0 {
            // Sanity: the first failure really is the expected rejection, not some
            // unrelated setup error masquerading as one.
            assert!(result.is_err());
        }
    }

    let close_ts = env.now() + 3600;
    let result = env.create_market(CreateMarketArgs::new("AAPL", 123_000_000, 20261006, close_ts, 16));
    assert!(
        result.is_ok(),
        "create_market after 60 failed transactions should still succeed: {:?}",
        result.err().map(|e| e.meta.logs)
    );
}
