# Devnet test plan

Hands-on checks against the devnet deployment recorded in `deployment.md` §2, run from the web
app with a browser wallet. Each case says what to do and what you should see. Program errors are
shown in plain language in the panel; anything that reads like a raw error code is a bug.

## Setup (once)

1. **Wallet on devnet.** In Phantom: Settings → Developer Settings → Testnet Mode on, network
   **Solana Devnet**. Solflare: switch the network selector to Devnet.
2. **Devnet SOL.** `https://faucet.solana.com`, paste your wallet address, request 1 SOL (fees and
   token-account rent only; a few hundredths of a SOL is used in total).
3. **Devnet USDC.** `https://faucet.circle.com`, asset USDC, network **Solana Devnet**, paste your
   address, Send 20 USDC. One request per address every two hours; 20 USDC covers every case below.
4. **Open the app.** `make web` on the machine running the stack serves `http://localhost:3000`
   against devnet (`.env` carries the devnet RPC and program id). From another machine, tunnel
   just the web port: `ssh -N -L 3000:localhost:3000 <host>` and open `http://localhost:3000`.
   Phantom needs a `localhost` or HTTPS origin to connect.
5. **Connect.** Click Select Wallet, pick your wallet, approve. The nav shows your shortened
   address. Portfolio shows your USDC balance.

The listed tickers are TSLA, QQQ and VOO (the feeds the Pyth key is entitled to; see
`DECISIONS.md` §20). Each has a ladder for the current trading day closing 4:00 PM ET, and on each
ladder the at-the-money strike has a resting ask of 5 Yes at $0.60 and a resting bid of 5 Yes at
$0.40 from a demo maker. Earlier AAPL ladders still exist on chain for wallets that hold
positions there (reachable at `/trade/AAPL`) but are no longer listed.

## Trader cases

| # | Case | Steps | Expect |
| --- | --- | --- | --- |
| T1 | Browse | Markets page | TSLA, QQQ and VOO each show their open contracts, a live last price, and a countdown to 4:00 PM ET. |
| T2 | Pick a strike | Trade → TSLA → click the highlighted at-the-money strike | Yes $0.60 / No $0.40, Chance 60%; payoff line "You pay $0.60. You win $1.00 if TSLA closes at or above $<strike>." |
| T3 | Buy Yes at market | Market, quantity 1, Buy Yes, approve in wallet | Holdings "1 Yes · 0 No". USDC down $0.60 on Portfolio. Book ask qty drops to 4. |
| T4 | Opposite side is gated | With Yes held, look at Buy No | Buy No is greyed with "Close your Yes position first"; Sell Yes sits directly below it. Holding a minted pair gates nothing: either leg can be sold. |
| T5 | Sell Yes at market | Sell Yes, quantity 1 | Fills against the $0.40 bid. Holdings back to 0 · 0; USDC up $0.40. |
| T6 | Buy No at market | Market, quantity 1, Buy No | Holdings "0 Yes · 1 No". Cost shown as $0.60 (No price = $1 − $0.40 bid). |
| T7 | Sell No at market | Sell No, quantity 1 | Fills against the $0.60 ask. Holdings 0 · 0. |
| T8 | Limit order rests | Limit, Buy Yes, price 0.50, quantity 1 | Portfolio → Your quotes → Open quotes lists it, Side "Buy Yes", $0.50 reserved. Book shows a new bid. |
| T9 | Cancel | Cancel the resting order | Row disappears; USDC refunded in full. |
| T10 | Self-match refused | With your own Yes bid resting at 0.50, place a market or limit Buy No at 0.55 (or a limit Buy Yes at 0.70 while your own ask rests) | Refused with a message about matching your own order, before the wallet opens. A No limit that would trade immediately runs as a market order, so the book is never left crossed. |
| T11 | Mint a pair | Portfolio → Your quotes → pick AAPL $330 → Pairs to mint 2 → Mint pair | USDC down $2.00; position row shows "Pairs — qty 2"; both Yes and No 2. |
| T12 | Quote both sides | Your quotes → AAPL $330, Offer to sell Yes at 0.65, qty 1 → Add to queue → Submit | Appears under Open quotes with 1 Yes reserved. |
| T13 | Cancel all | "Cancel all on this market" | Open quotes empty; Yes back in holdings. |
| T14 | Redeem a pair | Portfolio → Redeem pair on the AAPL $330 row | USDC up $1.00 per pair; pair count drops. |
| T15 | History | History page | One row per action above, newest first, each with a "View" explorer link that opens on devnet. |
| T16 | Closed market | Open a ladder whose close time has passed (yesterday's AAPL after 10:00 AM ET Oct 8) | Trade panel says settlement is pending; Market/Limit hidden. Portfolio's Your quotes no longer lists it. |

## Operator cases (admin wallet only)

The admin page needs the deployer wallet. Non-admin wallets see "Admin access requires the
operator wallet" (test that too, it's case O1).

| # | Case | Steps | Expect |
| --- | --- | --- | --- |
| O1 | Access control | Open /admin with a non-admin wallet | Access message, no controls. |
| O2 | Pause | Admin → Pause | Config shows Paused: Yes. Trader's panel says trading is paused; Market/Limit disabled; redeem still works. |
| O3 | Unpause | Admin → Unpause | Trading re-enabled. |
| O4 | Add strike | Admin → Add strike: TSLA, Strike 450, Capacity 16 → Add strike | Green "Added TSLA $450." The trade page lists $450. Costs ~0.02 SOL. |
| O5 | Unsettled list | After a ladder's close passes | Admin lists each unsettled market with "Closed since" and the override time (close + 1 hour, ET). Override button disabled until then. |
| O6 | Override | After the delay: enter a settlement price, Override | Market moves to "Settled by override"; trade page shows the outcome; holders can Redeem winning. |

## Settlement with the mock oracle

Devnet runs the mock oracle, so no automation job settles markets. To settle a ladder after its
close for case O6 or a Redeem winning check, run from the machine with the admin key:

```
make shell
CLUSTER=devnet pnpm --filter @meridian/scripts run lifecycle -- --help   # see flags
```

or ask the operator to settle via the admin override once the one-hour delay has elapsed.

## Known limits on devnet

- Public RPC rate limits: a page may show "Retrying…" briefly; reload if it persists.
- Admin "Status" column reads the automation service and shows "Status unavailable" unless
  `make jobs` is running.
- Circle faucet: 20 USDC per address every two hours. Solana faucet: a few SOL per day.
