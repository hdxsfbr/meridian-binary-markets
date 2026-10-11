# Test results

Latest full run: **2026-10-11**, commit `ead0d9e` and the e2e additions that followed it, on the
Docker dev container (the host carries no toolchain; `make` targets run everything inside the
container). Reproduce with the commands in each section. Counts are from the run's own output, not
estimates.

| Suite | Command | Result |
|---|---|---|
| Program (Rust, litesvm) | `make test-program` | 296 passed, 0 failed, 20 test binaries |
| SDK (vitest) | `pnpm --filter @meridian/sdk test` | 138 passed, 9 files |
| Scripts (vitest) | `pnpm --filter @meridian/scripts test` | 75 passed, 8 files |
| Automation worker (vitest) | `pnpm --filter automation test` | 194 passed, 1 skipped, 18 files (incl. 25 for the reconcile job) |
| Web unit (vitest) | `pnpm --filter web test` | 342 passed, 22 files |
| Integration: full lifecycle on a fresh local validator | `make test-integration` | 1 passing, 1 min; 155 transactions confirmed, median 416 ms, p95 436 ms |
| Frontend (Playwright, local validator) | `make test-web` | 7 passed, 1.4 min (plus the 342 web unit tests the target runs first) |

## What each suite proves against the PRD (§7)

**Program.** Every §5.1 instruction has its own test file (`config`, `create_market`, `book`,
`mint_redeem`, `settle`, `override`, `redeem_winning`, `pause`, `close`, `reclaim_mint`,
`remove_strike`, `token2022_migration`, `trade_paths`, `oracle`, `oracle_pyth_real`,
`harness_stress`, `token_authority`). Named PRD items:

- settlement at, above and below the strike: `at_or_above_rule_above_strike_is_yes`,
  `at_or_above_rule_equal_strike_is_yes`, `at_or_above_rule_below_strike_is_no`;
- $1.00 invariant across prices:
  `settlement_price_sweep_pays_exactly_one_dollar_per_pair_and_only_the_winning_side_redeems`
  (20 settlement prices around the strike; the winner pays exactly $1.00 per token, the loser is
  refused, the vault ends at zero);
- vault invariant after every mint and redeem:
  `property_random_mint_redeem_sequence_preserves_vault_equation` (25 random steps),
  `after_all_yes_redeemed_vault_is_empty_and_invariant_holds`,
  `unsolicited_vault_deposit_is_tolerated_and_never_paid_out`;
- oracle stale, wide-confidence and valid: `stale_price_is_refused`, `too_old_price_is_refused`,
  `wide_confidence_is_refused`, `settle_with_valid_quote_succeeds`, plus boundary tests at exactly
  300 s / 301 s and 25 bps / 26 bps;
- override delay: `override_before_delay_elapsed_is_refused`,
  `override_at_exactly_delay_elapsed_succeeds_and_writes_state`,
  `configured_override_delay_larger_than_minimum_is_the_effective_one`;
- tokens only via Mint Pair / Redeem: `direct_mint_to_outside_mint_pair_always_fails_regardless_of_signer`,
  `direct_burn_outside_redeem_always_fails_regardless_of_signer`;
- settlement immutable: `second_settle_is_refused_and_state_unchanged` and its override mirror.

**Integration.** `tests/integration/lifecycle.test.ts` drives `scripts/lifecycle.ts` against a
fresh `solana-test-validator`: deploy, config, seven ladders, mint, all four trade paths (each fill
checked against a hand-computed expectation), cancel, close, oracle publish, settle every market,
both users redeem, zero-sum P&L and an empty vault. The run also reports transaction confirmation
latency (see `KEY_METRICS.md`).

**Frontend.** `web/e2e/trade.spec.ts`, `portfolio.spec.ts`, `admin.spec.ts` on a local validator
with the test wallet: wallet connection, order placement and signing, live order book update in a
second browser, order book from both perspectives, position-constraint guidance, portfolio cost
basis and P&L figures (`flow 6`, hand-computed from the SDK's cost rules), settlement display and
redeem, admin pause/unpause, override and strike management. Two older specs read token balances
through the classic token program and were fixed on 2026-10-11 to use Token-2022.

**Devnet.** Unattended settlement days are recorded in `KEY_METRICS.md`; the demo video is a
recorded devnet lifecycle with a live Pyth settlement.

## Notes

- The integration target was killed twice on 2026-10-11 when it ran alongside a program build in
  another container; alone it passes in about a minute with under 800 MB of container memory.
- `automation`'s one skipped test is the Pyth live-network check, skipped without a key.
- The integration test skips itself unless `CLUSTER=localnet` is set; `make test-integration` sets it. A
  run that reports "pending" rather than "passing" did not execute.
