# Contract: oracle provider interface (Constitution IV, DECISIONS §4)

## Program side

```
fn read_quote(config: &Config, ticker: &TickerInfo, price_account: &AccountInfo, clock: &Clock)
    -> Result<OracleQuote>
```

Dispatch on `config.oracle_provider`:

| Provider | Owner check | Parse | Attestation guard |
|---|---|---|---|
| `PythReceiver` | `price_account.owner == config.oracle_program` (Pyth receiver) | `PriceUpdateV2` via `pyth-solana-receiver-sdk`; `feed_id == ticker.feed_id` | `verification_level == Full` |
| `MockPyth` | `price_account.owner == crate::ID` and PDA `["mock_price", feed_id]` | `MockPriceUpdate` | `publisher ∈ config.publishers` |

Then the common guards, in order, each failing closed with its own error:

1. `OracleBadPrice` if `price ≤ 0` or normalisation overflows.
2. `OracleStale` if `clock.unix_timestamp − publish_time > max_staleness_secs`.
3. `OracleTooOld` if `publish_time < market.close_ts − min_publish_offset_secs` (the price must be
   from the close, not from mid-session).
4. `OracleLowConfidence` if `conf × 10_000 > price × max_conf_bps`.

Only a quote that passes all four reaches the at-or-above comparison. The two provider arms differ
only in owner check, parse and attestation; the guards are one function.

## Service side

```ts
interface PriceProvider {
  /** Fetch the latest close-relevant price and make it readable on chain. Returns the account to pass to settle. */
  publish(ticker: Ticker): Promise<{ priceAccount: PublicKey; publishTime: number }>;
  /** Morning read for the strike ladder; does not touch the chain. */
  previousClose(ticker: Ticker): Promise<MicroUsd>;
}
```

| Implementation | `publish` | `previousClose` |
|---|---|---|
| `MockPythProvider` | read Finnhub + Nasdaq, `conf = max(|a − b|, 10_000)`, sign `mock_write_price` with the publisher key | Finnhub `pc` cross-checked with Nasdaq |
| `PythReceiverProvider` | `GET {HERMES_URL}/v2/updates/price/latest?ids[]=<feed>` with `Authorization: Bearer`, post via `@pythnetwork/pyth-solana-receiver`, return the `PriceUpdateV2` address | Hermes historical endpoint for `close_ts` of the previous trading day, with Finnhub as fallback |

Selection: `ORACLE_PROVIDER=mock | pyth` in the environment, which must agree with
`Config.oracle_provider`; the service refuses to start on mismatch. `ORACLE_PROVIDER=mock` is refused
when `SOLANA_CLUSTER` is not `devnet` or `localnet`.

## Environment variables (`.env.example`)

```
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WS_URL=wss://api.devnet.solana.com
ADMIN_KEYPAIR_PATH=/run/keys/admin.json
PUBLISHER_KEYPAIR_PATH=/run/keys/publisher.json
USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
ORACLE_PROVIDER=mock
PYTH_HERMES_URL=https://pyth.dourolabs.app/hermes
PYTH_API_KEY=
PYTH_RECEIVER_PROGRAM=rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
FINNHUB_API_KEY=
ALERT_WEBHOOK_URL=
AUTOMATION_STATUS_PORT=8787
DEMO_SCALE=1            # 1 = book capacity 16 so a full seven-ticker day fits one airdrop; 0 = capacity 128
NEXT_PUBLIC_CLUSTER=devnet
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_WS_URL=wss://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=
NEXT_PUBLIC_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
NEXT_PUBLIC_AUTOMATION_STATUS_URL=http://localhost:8787/status
```

Keypairs are mounted read-only into the container and never committed (`.gitignore` already covers
`**/keypairs/` and `id.json`).
