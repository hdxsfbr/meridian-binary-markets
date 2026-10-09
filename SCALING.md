# Scaling Meridian: 10 to 100,000 users

This note asks one question at five sizes: what breaks first, and what has to change in the
design or the infrastructure to carry that load. "Users" means wallets that visit the app on a
trading day; "active traders" means wallets that send at least one transaction. The ratios below
assume roughly one trader for every five visitors, and that an active trader sends about ten
transactions a day, concentrated in the first and last half hour of the session.

The system as built is sized for a demo: seven tickers, five to seven strikes each, one order book
per strike with 16 order slots per side, one automation worker, one RPC key, and a browser that
polls the chain directly. Most of what follows is about replacing "every browser reads the chain"
with "one indexer reads the chain and everyone reads the indexer", and about moving from one book
account per strike with a fixed slot array to a design that does not put every trade on the same
tiny account.

## Where the limits are today

| Component | Limit today | Why |
| --- | --- | --- |
| Order book | 16 orders per side per strike (demo); 128 in the production constant | Fixed-size array inside one account; a full side rejects new orders |
| Trade path | At most 8 quotes consumed per market order | Compute budget per transaction and the single-pass matching loop |
| Book account | One account per strike, every trade writes it | Solana serialises writes to the same account; one hot book is one lane |
| Capacity per day | About 46 markets, 46 books, 92 token mints | Rent paid by the admin wallet, reclaimed after settlement |
| RPC | One Helius free key, 10 requests per second, shared by every browser, the worker and the scripts | Browser polls the chain directly |
| Browser reads | Per visitor roughly 8 to 10 RPC calls a minute (markets every 30 s, books every 15 s, positions every 30 s, config, event delta) | No shared cache except the worker's event index |
| Event history | Worker holds the full program history in memory and serves it as one JSON blob (612 transactions after one day, about 190 KB uncompressed) | Simplest thing that removed the three-minute browser replay |
| Automation | One worker, one admin key, one publisher key, cron in-process | A single point of failure for creation and settlement |
| Prices | One Hermes key behind a server-side proxy with a 5 s cache | Browser never holds the key |
| Settlement | One transaction per market, sequential, 46 markets in 12 s | Fine until thousands of markets |

Those are the dials. Now the five sizes.

## 10 users (friends and reviewers)

Roughly 2 traders, 20 transactions a day, 100 RPC calls a minute at peak.

Nothing breaks. The free RPC tier has headroom of about six times this load. The 16-slot books are
enough because two traders cannot fill them. The one thing worth doing at this size is already
done: the event index on the worker, so a fresh browser does not spend three minutes replaying
history.

Changes required: none. Keep the demo-scale capacity of 16 so the admin wallet's rent stays within
one faucet grant.

## 100 users (a pilot)

Roughly 20 traders, 200 transactions a day, 1,000 RPC calls a minute at peak.

What breaks first:

- **RPC budget.** A hundred browsers each polling the chain is about 15 requests per second,
  above the free Helius tier. Either rate limits hit and pages show stale data, or the bill starts.
- **Book slots.** Twenty traders placing resting quotes on the at-the-money strikes will fill 16
  slots on the popular side within minutes. Rejected orders look like bugs to users.
- **Event payload.** A hundred days of history is tens of thousands of transactions; serving the
  whole index as one blob to every new browser becomes a multi-megabyte download.

Changes required:

- Raise book capacity to the production constant of 128 per side. Rent per book goes from about
  2 KB to about 16 KB; across 46 books that is around 5 SOL locked per day at devnet rent rates,
  reclaimed nightly, so the admin wallet needs a larger float, not more spending.
- Paid RPC plan (Helius developer tier or equivalent) with one key for the worker and a separate,
  domain-restricted key for browsers, so a scraper cannot burn the worker's quota.
- Make the event index incremental on the wire: the worker already supports `?after=`, so a
  browser only downloads once; add gzip and an HTTP cache header on `/events`, and prune the index
  to the current and previous trading day for Portfolio, keeping older history behind a separate
  per-wallet query.
- Alerting that someone reads: the Slack webhook exists; add a second channel (email or pager) for
  the settlement failure path, because at a hundred users a missed settlement is a support queue.

## 1,000 users (a real product in one market)

Roughly 200 traders, 2,000 transactions a day, 10,000 RPC calls a minute at peak if browsers still
poll the chain.

What breaks first:

- **Browsers polling the chain.** This is the end of the road for direct reads. Ten thousand calls a
  minute is a mid-tier RPC bill for data that is identical for every user: the same 46 books and
  the same prices. The fix is architectural, not a bigger key.
- **Hot books.** At the open, a few hundred orders land on the two or three at-the-money strikes.
  Every one of them writes the same Book account, so the validator processes them one at a time
  for that account; throughput on one book is bounded by block time and transaction size, in
  practice a few hundred trades a second, which is fine, but every failed transaction (slot full,
  price moved, would cross) is a retry the user pays for and notices.
- **Single worker.** If the Railway container restarts during the 15-minute settlement window the
  cron is lost until it comes back. At this size that is a real risk, not a theoretical one.
- **Admin key on a hosted box.** The upgrade authority and the market-creation key live as
  environment variables on a PaaS. Any compromise is total.

Changes required:

- **Indexer in front of the chain.** Run one process that subscribes to program accounts and
  transactions (Helius webhooks or a Geyser gRPC stream, or at minimum WebSocket account
  subscriptions) and writes to Postgres: markets, books, fills, positions per wallet, price
  history. The web app reads from that service over HTTP and a WebSocket for live book updates.
  Browsers stop talking to the RPC except to send transactions. This cuts RPC load by two orders
  of magnitude and makes every page load the same speed regardless of chain history. The worker's
  event index is the seed of this service; it should move out of the automation process into its
  own service with its own database.
- **Order placement UX for contention.** Fetch the book from the indexer right before signing,
  simulate the transaction, and show "slot full" or "price moved" before the wallet prompt. Add
  priority fees at the open and close.
- **Book redesign.** Keep one account per strike but switch from a fixed array to a page of orders
  per price level, or adopt a proven on-chain book (Phoenix or OpenBook v2 style) with a critbit or
  slab structure, so capacity is thousands of orders and cancels do not shift arrays. This is a
  program change with a migration; it is the largest single item on this list.
- **Worker redundancy.** Two worker instances with a leader lock (a Postgres advisory lock or a
  Redis key) so exactly one runs each job, plus a scheduled external check that alerts if the
  morning or settlement job has not reported within its window. Keep the jobs idempotent, which
  they already are.
- **Key management.** Move the admin and publisher keys to a KMS-backed signer or a hardware
  wallet with a small hot key that can only call `settle_market` and `create_market`, and keep the
  upgrade authority offline or behind a multisig (Squads). Split the roles in the program: a
  creator key, a settler key, an upgrade key.
- **Rent float.** 46 books at 128 slots plus mints and vaults is roughly 6 to 8 SOL cycling daily;
  on mainnet that is real money and the reclaim job becomes a cost control, not a cleanup.

## 10,000 users (a serious venue)

Roughly 2,000 traders, 20,000 transactions a day, with opens and closes at several hundred
transactions a minute.

What breaks first:

- **One book per strike as a hot account.** With thousands of traders, the at-the-money book is
  written hundreds of times a minute. Solana can do it, but every transaction that lands after a
  conflicting write re-executes against a changed book: more failures, more retries, more priority
  fee bidding. The single-account design is now the throughput ceiling for the popular strikes.
- **Settlement in one sequential loop.** With more tickers or more strikes (users will ask for
  more), settling a few hundred markets one transaction at a time from one process stretches the
  settlement window.
- **Event and position history.** Millions of rows; cost basis per wallet computed by folding every
  event is no longer something a browser or a single JSON file does.
- **Price proxy.** One Hermes key behind one Next.js route with a 5 s cache serves ten thousand
  browsers fine only if that route is cached at the edge; otherwise the origin is the bottleneck.
- **Operational visibility.** No metrics, no dashboards, logs are stdout on a PaaS.

Changes required:

- **Program changes.** Per-price-level order queues or a crank-based matching design (orders land
  in an event queue, a permissionless crank matches and settles), which turns a hot account into
  an append-only queue and spreads the matching across cranker transactions. Batch settlement:
  one `settle_markets` instruction that settles up to N markets of one ticker in one transaction,
  sharing one oracle update. Both are upgrades with a migration day.
- **Indexer becomes the system of record for reads.** Postgres with per-wallet position tables
  maintained incrementally, a materialised daily P&L, Redis for the live book snapshot, and a
  WebSocket fan-out service (one upstream subscription, N downstream clients). Cost basis moves to
  the server, computed once per fill, not per page load.
- **Edge caching.** Prices and the market list behind a CDN with a few seconds of TTL. The Next.js
  app runs on more than one instance behind a load balancer; it is stateless already.
- **Dedicated RPC.** A dedicated node or a dedicated-rate plan with sendTransaction forwarding to
  staked connections, so trades land in the next block at the open.
- **Observability.** Prometheus-style metrics from the worker and the indexer (job duration,
  settlement lag, transaction failure rate by error, book fill ratio), a dashboard, and alerts on
  the Liveness metric from the brief: markets exist before the open, every market settled within
  ten minutes of the close.
- **Market making.** At this size the venue needs continuous quotes. The maker panel is a manual
  tool; a market-making service with model-priced quotes on every strike, repricing on the live
  price, is a separate product.

## 100,000 users (an exchange)

Roughly 20,000 traders, 200,000 transactions a day, thousands of transactions a minute at the open
and the close, and users who expect sub-second book updates.

What breaks first: the shape of the whole thing. One program, one book per strike, one worker and
one indexer is the architecture of a product, not an exchange. The specific walls:

- **Per-account write serialisation** on popular strikes caps trades per second per book
  regardless of how fast the cluster is. The design has to avoid making every trade write the same
  account.
- **Rent and account churn.** Hundreds of markets a day, each with a book, two mints, a vault and
  token accounts for every trader, is millions of accounts a year and tens of thousands of SOL in
  rent float, even with nightly reclaim.
- **Oracle dependence at the close.** One Pyth feed per ticker, one settler, and a 15-minute retry
  window is a liveness risk that now affects real money every day.
- **Centralised operator.** One admin creates markets, settles, pauses and can override prices
  after an hour. For a hundred thousand users this is a trust problem and a regulatory one.

Changes required:

- **Off-chain matching with on-chain settlement**, or a sharded on-chain design. The common
  pattern at this size is a sequencer that matches orders off chain with signed intents and posts
  batched fills on chain, with the vault and redemption logic staying on chain. Alternatively,
  shard each strike into several book accounts keyed by price band so concurrent trades at
  different prices do not collide. Either is a rewrite of the trading core; the mint, pair and
  redemption logic survives unchanged because it is already simple and does not contend.
- **Token-2022 or compressed accounts** for the per-trader Yes and No balances to cut account
  rent, and a permissionless `close` crank with incentives so reclaim is not an operator job.
- **Settlement robustness.** Multiple oracle sources with an on-chain median, a permissionless
  settle instruction (anyone can post a valid Pyth update after the close and claim a small fee),
  and a governance-controlled override instead of a single admin key, with a longer delay and a
  public dispute window.
- **Infrastructure.** Multi-region read replicas of the indexer, a WebSocket tier that can hold
  tens of thousands of connections, a queue between the chain stream and the database, dedicated
  validators or a Jito bundle path for the open and the close, and a status page.
- **Organisation.** On-call rotation, incident process, a security audit of the program before
  mainnet, key ceremonies, and the legal work that a 0DTE options-like venue requires; none of
  that is code, all of it is required.

## What does not change

Three parts of the design hold at every size and are worth keeping as they are:

- **The contract itself.** A Yes and a No token per strike, the dollar invariant, pairs mintable
  and redeemable at any time, winners redeemable forever. This is already the simplest correct
  design and it does not contend.
- **One book per strike with the No side derived.** Even in a sharded or off-chain design, quoting
  one instrument and deriving the other halves the liquidity problem.
- **Oracle guards.** Freshness, confidence, publish time at or after the close, and a time-locked
  override are the right checks at any size; what changes is who is allowed to call settle and
  how many sources feed it.

## Summary table

| Users | First thing that breaks | Smallest change that fixes it |
| --- | --- | --- |
| 10 | Nothing | None |
| 100 | Free RPC tier, 16-slot books | Paid RPC key per audience, capacity 128, gzip the event index |
| 1,000 | Browsers polling the chain, one worker, hosted keys | Indexer plus database in front of the chain, worker leader lock, KMS or multisig keys |
| 10,000 | Hot book account, sequential settlement, no metrics | Per-level queues or crank matching, batch settle, WebSocket fan-out, dedicated RPC, dashboards |
| 100,000 | The single-book, single-operator architecture | Off-chain matching with on-chain settlement or sharded books, permissionless settle and reclaim, multisig governance, audit |

The next concrete step from where the code is today is the 1,000-user item: take the event index
out of the automation worker, give it a database and a WebSocket, and point the web app at it. That
work is additive, needs no program change, and removes the only cost that grows with the number of
visitors.
