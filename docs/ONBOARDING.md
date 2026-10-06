# Onboarding: Meridian for engineers new to finance and blockchain

You are a competent engineer. You have probably not spent much time in trading systems or on
Solana. This document assumes exactly that: it explains the domain, not programming.

Read it in order. Part 1 is finance, Part 2 is blockchain, Part 3 is how they combine in this
codebase. If you only have twenty minutes, read Part 1 and §3.1 — that is where most of the "wait,
what?" lives.

---

## 0. What we are building, in one paragraph

Every morning before the US stock market opens, we automatically create a set of yes/no bets about
where seven big tech stocks will close that day — things like *"will META close at or above
$680?"*. People buy and sell positions on those questions all day on an exchange we run. At 4:00 PM
the market closes, we read the real closing price from an external data source, and every bet pays
out $1 to the winning side and $0 to the losing side. All of it runs on a public blockchain, which
means we never hold anyone's money: users keep their own funds and approve every transaction
themselves.

---

# Part 1 — The finance

## 1.1 A binary contract

A **binary contract** (also called a binary option or digital option) asks one yes/no question with
a fixed payout. Ours:

> **Will META close at or above $680 today?**

Two tokens exist for this question:

| Token | Pays $1.00 if… | Pays $0.00 if… |
|---|---|---|
| **Yes** | META closes **at or above** $680 | META closes below $680 |
| **No** | META closes **below** $680 | META closes at or above $680 |

The **$680** is called the **strike** (or strike price). It is the threshold the question is about.

**The invariant that defines the whole system:**

```
Yes payout  +  No payout  =  exactly $1.00     ...always, for every contract
```

Exactly one of the two tokens is worth a dollar after the market closes. The other is worth
nothing. There is no third outcome. A tie — the stock closing at *exactly* $680 — resolves to
**Yes**, because the rule is "at or above".

### Why anyone wants this

Compare it to a stock option, the traditional way to bet on a stock's direction. Options have
Greeks (delta, gamma, theta, vega — sensitivities you must model), time decay, assignment risk, and
if you sell them your losses can be unbounded. You need real training to use them safely.

A binary contract has none of that. You pay $0.35 for a No token; the worst that happens is you
lose $0.35, and the best is you receive $1.00. **Maximum gain and maximum loss are both known the
moment you enter.** That is the product pitch, and it is why the partner (Peak6) cares: it makes
directional trading legible to retail participants.

### 0DTE

Our contracts are **0DTE** — "zero days to expiry". Created in the morning, resolved after that
day's close, done. No overnight risk, no multi-day positions. This matters architecturally more
than you would guess: because nothing survives the night, we can delete each day's data structures
after settlement and recycle their storage costs. See §2.6.

## 1.2 Price *is* probability

Because Yes + No always equals $1.00, the two prices are locked together:

```
No price  =  $1.00  −  Yes price
```

If Yes trades at $0.65, No is implicitly $0.35. You never need to quote them separately.

More interestingly, **the Yes price is the market's estimate of the probability**. Yes at $0.65
means the market collectively thinks there is roughly a 65% chance META closes at or above $680. If
you pay $0.65 for something that pays $1.00 with 65% probability, your expected value is zero —
which is what a fair price means. Traders who think the real probability is 80% will buy at $0.65;
traders who think it is 50% will sell. That disagreement is what makes a market.

This is why prices live between $0.00 and $1.00 and are quoted in cents. A strike far above the
current price trades near $0.00 (almost certainly won't happen); a strike far below trades near
$1.00 (almost certainly will). The action is near the current price, where the outcome is genuinely
uncertain.

## 1.3 Order books, bids and asks

An **order book** is how an exchange matches buyers and sellers. Two sides:

- **Bids** — people wanting to buy, and the highest price each will pay.
- **Asks** (or offers) — people wanting to sell, and the lowest price each will accept.

```
            ASKS (sellers)
   $0.68  ×  400
   $0.67  ×  250
   $0.66  ×  100   ← best ask: cheapest you can buy at right now
   ─────────────   ← the spread
   $0.64  ×  150   ← best bid: most you can sell at right now
   $0.63  ×  500
   $0.62  ×  300
            BIDS (buyers)
```

The gap between best bid and best ask is the **spread**. A trade happens when someone crosses it.

Two kinds of order:

- **Limit order** — "buy 100 at $0.64 or better". If nobody will sell that cheap, your order
  *rests* on the book waiting. You are now providing liquidity; you are a **maker**.
- **Market order** — "buy 100 at whatever the going rate is". It executes immediately against
  resting orders. You are consuming liquidity; you are a **taker**.

**Price-time priority** is the matching rule: better prices match first, and among orders at the
same price, whoever arrived first matches first. It is a queue per price level. This rule is not
optional — it is what makes the exchange fair and predictable, and we have to implement it
correctly.

A **market maker** is someone who posts limit orders on both sides continuously, profiting from the
spread. Without market makers a book is empty and nobody can trade, which is why we build a
dedicated dashboard for them (FR-028).

## 1.4 The clever bit: one book, two perspectives

**This is the single most important idea in the project.** If you understand nothing else, read
this section twice.

A naive design would give each contract two order books — one for Yes tokens, one for No tokens.
**We do not.** Each contract has **exactly one order book: Yes tokens traded against dollars.**

Why we can get away with that: since Yes + No = $1.00, *selling a Yes is economically identical to
buying a No*. They are the same trade seen from opposite ends. So the "No book" is just the Yes
book read upside down — no second book needed.

The user, however, still gets four plain buttons. Here is how each one maps onto that single book:

| User clicks | What actually happens | Which side of the book |
|---|---|---|
| **Buy Yes** | Buy Yes tokens from the ask side | buying Yes |
| **Buy No** | Mint a Yes+No pair for $1.00, immediately sell the Yes on the bid side, keep the No | **selling** Yes |
| **Sell Yes** | Sell your Yes tokens on the ask side | selling Yes |
| **Sell No** | Buy a Yes token; now you hold Yes+No = $1.00 redeemable, so your No exposure is closed | **buying** Yes |

Read the right-hand column again:

- **Buy Yes** and **Sell No** are the *same side* of the book — both are buying Yes.
- **Buy No** and **Sell Yes** are the *same side* — both are selling Yes.

Four user actions. Two book operations. One book.

### Worked example: Buy No

Say Yes is bid at $0.65 and you want to bet against META.

1. You deposit **$1.00** and receive 1 Yes + 1 No token. (This is "minting a pair" — §1.5.)
2. You immediately sell the Yes on the bid side for **$0.65**.
3. You are left holding 1 No token, having spent $1.00 and received $0.65.

**Your net cost for the No token: $0.35** — exactly $1.00 − $0.65, as the pricing relationship
promised. If META closes below $680 your No pays $1.00 and you made $0.65. If not, you lose the
$0.35.

The user should never be shown any of this. They click "Buy No", approve one transaction, and end
up holding No tokens at $0.35. The three steps above happen atomically inside one transaction
(§2.5) — that is requirement **FR-013**, and it is a hard requirement, not a nicety.

## 1.5 Minting and redeeming

Where do Yes and No tokens come from? Not from us — we don't pre-issue them. Anyone can **mint** a
pair:

- **Mint:** hand over $1.00 → receive 1 Yes + 1 No.
- **Redeem (before settlement):** hand back 1 Yes + 1 No → receive $1.00.
- **Redeem (after settlement):** hand back the winning token → receive $1.00. The losing token is
  worth nothing.

Tokens are always created and destroyed **in pairs**, against exactly one dollar held as
**collateral**. This is what makes the system solvent by construction: the dollars we hold always
equal the pairs outstanding, so we can always pay everyone. There is no scenario where we owe more
than we hold.

> **Collateral** is just money set aside to guarantee a future obligation. Here, the $1.00 backing
> every pair.

After settlement, redemption **never expires**. If you forget about a winning token for six months,
it is still worth $1.00.

## 1.6 Strikes: which contracts exist each day

We don't create contracts at arbitrary prices. Each morning, for each of the seven stocks, we read
yesterday's closing price and generate strikes at **±3%, ±6% and ±9%** around it, each rounded to
the nearest **$10**.

**META, previous close $680:**

| Offset | Raw | Rounded |
|---|---|---|
| −9% | $618.80 | **$620** |
| −6% | $639.20 | **$640** |
| −3% | $659.60 | **$660** |
| close | $680.00 | **$680** |
| +3% | $700.40 | **$700** |
| +6% | $720.80 | **$720** |
| +9% | $741.20 | **$740** |

Seven strikes. Now a cheaper stock, **AAPL, previous close $230:**

| Offset | Raw | Rounded |
|---|---|---|
| −9% | $209.30 | **$210** |
| −6% | $216.20 | **$220** |
| −3% | $223.10 | **$220** ← same as −6% |
| close | $230.00 | **$230** |
| +3% | $236.90 | **$240** |
| +6% | $243.80 | **$240** ← same as +3% |
| +9% | $250.70 | **$250** |

Only **five** unique strikes, because $10 rounding collapses adjacent percentages on a lower-priced
stock. **Deduplication is mandatory** — two identical contracts would split liquidity between two
books for the same question, which is strictly worse than one. This is requirement FR-003 and a
favourite source of off-by-one bugs.

Seven tickers × 5–7 strikes ≈ **45 contracts per day**, each with its own order book. Remember that
number; it drives the cost analysis in §2.6.

---

# Part 2 — The blockchain

## 2.1 Why a blockchain at all

The honest answer for this project: because the partner asked for it, and because it demonstrates a
real property. **Non-custodial** means we never hold user funds. Compare:

- **A normal exchange:** you wire money in, they hold it, you trust them to let you withdraw. This
  is custody, and it is why exchange failures wipe people out.
- **Meridian:** your funds stay in your own wallet. To trade, *you* sign a transaction that moves
  them. We cannot touch your money, freeze your account, or go bankrupt holding it.

Everything is also publicly auditable: anyone can verify that our collateral matches our
outstanding obligations, in real time, without trusting our word.

## 2.2 Wallets, keys and signing

A **wallet** is a keypair. The public key is your address — like an account number, safe to share.
The private key proves ownership and must never leave the user's control.

To change anything on chain, you build a **transaction** and **sign** it with your private key.
Users do this through a browser wallet extension (Phantom, Solflare), which pops up and asks them
to approve. This is the "one wallet approval" the requirements keep referring to: **every approval
is a friction point and a decision point for the user**, which is why FR-013 insists Buy No be a
single one rather than three.

## 2.3 Programs and accounts — the mental model shift

This is where most engineers' intuitions misfire, so slow down here.

On Solana, **code and data are completely separate.**

- A **program** is deployed code. It is **stateless**. It has no fields, no memory between calls. If
  you are coming from object-oriented thinking, a program is closer to a module of pure functions
  than to a class. ("Smart contract" is the generic industry term; on Solana they are called
  programs.)
- An **account** is a blob of bytes at an address. All state lives in accounts. Each account records
  which program *owns* it, and only that program may modify it.

So a program doesn't "have" data — it is **passed** the accounts it should read and write, on every
single call. A transaction must declare up front every account it will touch. (That constraint is
what lets Solana execute non-overlapping transactions in parallel.)

For Meridian, that means a contract like "META ≥ $680 on 2026-10-05" is **an account** holding the
ticker, strike, date, state, and settlement result — and our program is the code that knows how to
mutate it correctly.

### PDAs

A **Program Derived Address** (PDA) is an account address computed deterministically from a program
ID plus some seeds — for example `["contract", "META", 680_00, "2026-10-05"]`. Two useful
properties:

1. **Addresses are derivable.** Anyone can compute where the META $680 contract for today lives,
   without a lookup table.
2. **The program can sign for it.** PDAs have no private key; the runtime lets the owning program
   authorize actions on their behalf. This is how our program holds the collateral pool without any
   human holding its keys — the solvency guarantee is enforced by code, not by trust.

### Anchor

**Anchor** is the Rust framework we use. It handles serialization, account validation and
boilerplate that is painful and security-critical to write by hand. Roughly what a web framework is
to raw socket handling.

## 2.4 Tokens and stablecoins

**SPL Token** is Solana's token standard. Two account types matter:

- A **mint account** defines a kind of token (its supply, decimals, who may issue it).
- A **token account** holds one wallet's balance of one specific mint.

Meridian creates **two mints per contract** — a Yes mint and a No mint. Minting a pair issues one of
each; redeeming burns them.

**USDC** is a **stablecoin**: a token designed to stay worth exactly one US dollar, backed by real
reserves. It is the dollar in "pays $1.00". Blockchains have no native concept of dollars, so a
stablecoin is how dollars are represented. USDC has **6 decimals**, meaning balances are integers of
millionths: `$1.00` is stored as `1_000_000`.

> **Integer money, always.** Every monetary value in this codebase is an integer in base units.
> Never a float. `0.1 + 0.2 != 0.3` in binary floating point, and on a system whose entire promise
> is an exact $1.00 invariant, a rounding error is not a cosmetic bug — it is the product failing.
> This is Principle I of the constitution and it is marked NON-NEGOTIABLE.

## 2.5 Transactions are atomic

A transaction can bundle several instructions, and **either all of them succeed or none of them
do.** There is no partial application; a failure rolls everything back.

This is the property that makes Buy No possible as a single user action. "Mint a pair, then sell the
Yes" either happens completely or not at all. The user can never end up in the broken intermediate
state of having paid $1.00 and holding an unsold Yes they didn't want.

**Cross-Program Invocation (CPI)** is one program calling another within a transaction — our program
calling the SPL Token program to move tokens, for instance. Composable, and still atomic across the
whole call tree.

## 2.6 Rent, and why it decided our architecture

Accounts occupy validator memory, so they must hold a minimum SOL balance proportional to their
size, called **rent-exempt minimum**. It is refundable: close the account, get the SOL back.

This sounds like an accounting footnote. It determined a central design decision.

We evaluated integrating **Phoenix**, an existing on-chain order book on Solana, instead of writing
our own. Phoenix is live on devnet — we checked — but its market accounts are 84KB–232KB each. At
~45 fresh markets per day:

| | Rent per market | Per day (45 markets) |
|---|---|---|
| Phoenix market | 0.43 – 1.18 SOL | **19 – 53 SOL**, consumed |
| Our own book (128 orders/side) | 0.085 SOL | **3.8 SOL**, reclaimed nightly |

And the test network's faucet hands out around **2 SOL per day**. Phoenix would need ten to
twenty-five times what we can actually obtain, every day, before a single trade happens — making the
reviewer-reproducible demo impossible.

Because our contracts are 0DTE (§1.1), we can close each day's accounts after settlement and recover
the rent. Phoenix's lifecycle does not offer that. (The faucet still binds us on day one — 3.8 SOL is
more than one airdrop — so the scripts ship a smaller demo configuration that fits a single grant.)

Phoenix also gates resting orders behind an approved **seat** — a per-trader, per-market permission
granted by the market authority. With 45 markets a day that is a permissioning service we would have
to run, inside a product whose premise is "no KYC".

So: **we build our own order book.** Full reasoning, with reproducible figures, in
[`spikes/2026-10-05-phoenix-devnet.md`](spikes/2026-10-05-phoenix-devnet.md).

## 2.7 Oracles

A blockchain cannot see outside itself. Our program has no way to know what META closed at — there
is no HTTP call from inside a program. An **oracle** bridges that gap: a service that publishes
real-world data on chain, where programs can read it.

Whatever the source, the thing it posts on chain must carry three pieces of information:

- the **price**;
- a **confidence interval** — an uncertainty band. A wide band means the sources disagree and the
  number should not be trusted;
- a **publish timestamp** — how fresh the number is.

### Which oracle we use: Pyth, through a provider interface

The program never talks to a vendor directly. It reads a **provider**: anything that can hand back a
price, a confidence interval and a publish timestamp, or refuse. Config names which provider is active.
The guards below are applied to whatever the provider returns, so changing vendor changes a config
value, not the program.

The target provider is **Pyth**, the standard oracle on Solana. Pyth is "pull" based: its publishers
sign price updates off chain, our service fetches one from Pyth's Hermes API and posts it to Pyth's
receiver program on devnet, and our settle instruction reads the resulting account. The account
carries the price, an **exponent**, a **confidence interval** supplied by Pyth's aggregation, and the
publish time. That confidence interval is exactly what the second guard needs.

### The mock, and why it is not cheating

Pyth put US equity feeds behind a paid plan in 2026. Pyth grants access to Gauntlet participants who ask
on its developer forum, and our request is in, but we are not waiting for it. Until then the active provider is **`MockPyth`**:
our automation service reads the close from a free stock API (Finnhub, cross-checked against Nasdaq),
signs it with an allowlisted publisher key, and posts an account with the **same fields** Pyth's would
have. The program reads it through the same interface and applies the same guards.

This is also the **tested fallback** Principle IV requires, so it is not throwaway. What it cannot
prove is that the real Pyth account parses and that a real equity update passes the guards; that is
one integration task on the day the token arrives. Two rules: the mock is refused on any cluster but
devnet, and the product UI never mentions it. The oracle status page names the active provider,
because that is a diagnostic the operator needs; the trading screens do not.

### Why the source has changed three times, and the lesson in it

Pyth was the obvious choice and we planned on it. The spike found its older devnet feeds last updated
**2.4 to 3.5 years ago**, and that during 2026 it moved US equity data onto plans starting at
**$5,000/month**. We then verified RedStone, the one network still serving MAG7 free on devnet, and
chose it for a day. Reading its on-chain program showed real integration cost: an unpublished SDK, a
program ID that did not match its source, and an account that stores only a median. When a Pyth token
became plausible, Pyth's published SDK and native confidence interval won.

The lesson: **the blocker was commercial, not technical.** Nothing was broken. The capability existed
and had a price tag, and no amount of engineering changes that. It is found by reading changelogs and
pricing pages, never by debugging. And because the provider interface was the first decision, three
changes of vendor moved no spec and no guard. If Pyth falls through, RedStone plugs into the same
interface; the findings are in the spike.

### Being honest about the limitations

Two, both written into the project's risks note rather than left for a reviewer to discover:

- **No free source carries the official closing *auction* print.** That specific number is a licensed
  product. What we settle on is a consolidated price that agrees with the official close to a few
  hundredths of a percent — fine for devnet with no real money, and not something our documentation
  should overstate.
- **Until the Pyth Pro token arrives, the demo settles on a price our own service signed.** The
  guards are real and tested, but the trust model is one publisher we control. The risks note says so,
  and names Pyth as the production path — which is exactly why Principle IV insists the fallback be
  *tested* rather than aspirational.

Full workings: [`spikes/2026-10-05-pyth-devnet.md`](spikes/2026-10-05-pyth-devnet.md). Settled position:
[`../DECISIONS.md`](../DECISIONS.md) §4.

### The guards

**The oracle is the single most dangerous component in the system.** It is the only place where
outside reality enters, and therefore the only place where a silent failure translates directly
into paying the wrong person. Hence three mandatory guards on every read:

1. **Staleness** — reject any price older than 5 minutes.
2. **Confidence** — reject any price whose confidence interval is too wide.
3. **Attestation** — reject any price not signed by an allowlisted publisher.

These guards are the reason the source is swappable at all. They are written once, on chain, and
they do not care which adapter produced the price. When the oracle decision changed, the guards did
not move — and neither did our requirements. That is not luck; it is what you get for specifying
*behaviour* instead of naming a vendor.

And the rule for what happens when a guard trips: **fail closed.** Refuse to settle; do not settle
on a doubtful price.

That ordering is deliberate and you should internalize it. Settling late is an inconvenience we can
explain and recover from. Settling *wrong* takes money from the person who was right and gives it
to the person who was wrong. It is unrecoverable and it breaks the only promise the product makes.
**Correctness outranks liveness, every time.**

## 2.8 Networks: devnet vs mainnet

Solana runs several networks with identical software:

- **mainnet-beta** — the real one, real money.
- **devnet** — a public test network. Tokens are worthless; you obtain test SOL from a **faucet**,
  an API that gives it away (rate-limited, as §2.6 explained).

**Meridian deploys to devnet only. Never mainnet, never real funds.** This is a hard rule from the
brief and from our constitution — not a phase we graduate out of.

---

# Part 3 — How it fits together

## 3.1 The daily lifecycle

This schedule *is* the product. All times US Eastern.

| Time | What happens |
|---|---|
| **8:00 AM** | Automation service reads yesterday's close through the oracle adapter, computes the strike ladder (§1.6) |
| **8:30 AM** | Creates on-chain contracts and order books for every strike |
| **9:00 AM** | Markets visible in the UI; minting enabled |
| **9:30 AM** | US market opens — live trading |
| **4:00 PM** | US market closes |
| **~4:05 PM** | Service reads the official closing price through the guards (§2.7) and settles every contract |
| **4:05 PM +** | Winners redeem for $1.00 each — open indefinitely |

Two graded targets live here: markets must exist **before** the open, and settlement must complete
**within 10 minutes** of the close.

## 3.2 The three pieces of the system

```
  ┌─────────────────┐     reads/writes      ┌──────────────────────┐
  │  web/           │  ──────────────────▶  │  programs/           │
  │  Next.js + TS   │   user-signed txns    │  Rust + Anchor       │
  │                 │                       │                      │
  │  wallet connect │                       │  contracts           │
  │  order book UI  │                       │  mint / redeem       │
  │  4 trade paths  │                       │  order book+matching │
  │  portfolio/P&L  │                       │  settlement          │
  └─────────────────┘                       └──────────────────────┘
                                                   ▲          ▲
  ┌─────────────────┐   create / settle            │          │ guarded
  │  services/      │  ────────────────────────────┘          │ read
  │  Node.js        │                                  ┌────────────────┐
  │  cron lifecycle │   posts signed price             │  price account │
  │  oracle adapter │  ──────────────────────────────▶ │  (on chain)    │
  └────────┬────────┘                                  └────────────────┘
           │ reads the closing price
           ▼
   stock data API (off chain)
```

- **`programs/`** — Rust/Anchor, on chain. Owns contract state, the collateral pool, minting,
  redemption, the order book and matching engine, and settlement. **Every rule that must not be
  broken is enforced here**, because this is the only layer a malicious user cannot bypass.
- **`web/`** — Next.js/TypeScript. Wallet connection, the order book display, the four trade
  buttons, portfolio and P&L. Translates user intent into transactions.
- **`services/`** — Node.js. The scheduler: creates markets each morning, publishes the signed
  closing price, triggers settlement each afternoon. It **cannot touch user funds** — it cannot move
  anyone's tokens or USDC. But note the one real power it does hold: its key is on the publisher
  allowlist, so it is the thing that tells the system what the closing price was. That is why §2.7
  cares so much about the guards around it.

## 3.3 Rules that are not negotiable

These come from [`.specify/memory/constitution.md`](../.specify/memory/constitution.md). Violating
one is a bug by definition, not a trade-off to discuss.

1. **Yes payout + No payout = exactly $1.00.** Collateral held always equals pairs outstanding, to
   the base unit.
2. **Integer base units everywhere.** No floats on the money path, ever.
3. **Ties go to Yes.** `close >= strike` means Yes wins.
4. **Enforce on chain.** A client-side check is a convenience. If the rule matters, the program
   enforces it — anyone can call the program directly, bypassing our UI entirely.
5. **Oracle guards fail closed.** Stale or low-confidence price → refuse to settle.
6. **Settlement is idempotent.** A contract settles exactly once; a repeat attempt is a no-op. Not
   a double payout.
7. **Never mainnet, never real funds.**
8. **One approval for Buy No market orders.**
9. **No persistent simultaneous Yes and No** in the same contract via the trading UI. (Market makers
   who mint inventory hold both on purpose; the rule is about the four trade buttons.)
10. **Settle only after the close; override only after a delay.** The admin can settle with a manual
    price if the oracle fails, but not until at least an hour after the close, and the result is
    marked as an override.
11. **A pause never traps funds.** Pausing stops minting and trading; redemption keeps working.

## 3.4 Where things live

| Path | What it is |
|---|---|
| [`PRD.md`](PRD.md) | Requirements FR-1…FR-12. **Start here** — the authoritative statement of what we're building |
| [`Gauntlet-Project-Meridian.pdf`](Gauntlet-Project-Meridian.pdf) | The partner's original brief |
| [`../.specify/memory/constitution.md`](../.specify/memory/constitution.md) | Engineering principles — the rules above, with rationale |
| [`../specs/001-binary-outcome-markets/spec.md`](../specs/001-binary-outcome-markets/spec.md) | Feature spec: user stories, edge cases, 36 testable requirements |
| [`../DECISIONS.md`](../DECISIONS.md) | Why things are the way they are. Read before proposing a change |
| [`spikes/`](spikes/) | Investigations behind specific decisions |
| [`../AI_USAGE.md`](../AI_USAGE.md) | AI usage log (a graded deliverable) |

We work spec-first using [spec-kit](https://github.com/github/spec-kit):
`/speckit-specify → /speckit-plan → /speckit-tasks → /speckit-implement`. Commits reference the
requirement they advance, e.g. `FR-5: oracle settlement with staleness check`.

---

## 4. Traps for newcomers

Things that have genuinely caught people out:

- **"I'll just use a float for the price."** No. Integer base units. See §2.4.
- **"Let's add a No order book."** No — that is the one-book insight (§1.4). A second book would
  halve the liquidity on each.
- **"Buy No is just Sell Yes."** Nearly, and the distinction matters. Buy No *mints a new pair*
  first, which Sell Yes does not. They put you on the same side of the book by different routes.
- **"We can validate that in the frontend."** Only for UX. Anyone can call the program directly
  without touching our UI, so any rule that matters is enforced on chain.
- **"Settlement failed, let's just retry with the last known price."** Absolutely not. A guard
  tripped for a reason. Fail closed (§2.7).
- **"Rounding to the nearest $10 produced a duplicate strike, I'll just allow both."** No — dedupe
  (§1.6). Two books for the same question is strictly worse than one.
- **"The stock closed exactly at the strike, that's an edge case we can punt on."** It is specified:
  ties go to Yes. It is also the exact kind of thing a reviewer will test first.

## 5. Glossary

**Ask** — lowest price a seller will accept. · **Atomic** — all-or-nothing; a transaction either
fully succeeds or fully rolls back. · **Bid** — highest price a buyer will pay. · **Binary
contract** — a fixed yes/no payout bet; ours pay $1 or $0. · **CLOB** — Central Limit Order Book;
the matching mechanism in §1.3. · **Collateral** — money held to guarantee an obligation; here $1
per outstanding pair. · **CPI** — Cross-Program Invocation; one program calling another. · **0DTE**
— zero days to expiry; same-day contracts. · **Devnet** — Solana's public test network; worthless
tokens. · **Faucet** — service handing out free test tokens on devnet. · **Fill** — an executed
match between two orders. · **Limit order** — buy/sell at a specified price or better; rests on the
book if unmatched. · **MAG7** — the seven mega-cap tech stocks we support. · **Maker** — someone
posting resting orders, providing liquidity. · **Market maker** — a participant quoting both sides
continuously. · **Market order** — execute immediately at the best available price. · **Mint**
(verb) — create tokens; (noun) the account defining a token type. · **Non-custodial** — users keep
control of their own funds. · **Oracle** — service publishing real-world data on chain. · **Oracle adapter** — the swappable
interface our program reads prices through. · **PDA** —
Program Derived Address; an account a program can sign for. · **Price-time priority** — better
prices match first; ties broken by arrival order. · **Program** — deployed on-chain code; Solana's
term for a smart contract. · **Publisher allowlist** — the set of keys whose signed prices the program will accept. · **Redeem** — exchange tokens back
for USDC. · **Rent** — minimum balance an account holds for its storage; refundable on close. ·
**Seat** — Phoenix's per-trader permission to post resting orders (not used by us). · **Settlement**
— resolving contracts against the official close. · **SPL Token** — Solana's token standard. ·
**Spread** — the gap between best bid and best ask. · **Stablecoin** — a token pegged to a currency;
USDC here. · **Staleness** — how old a price is; we reject anything over 5 minutes. · **Strike** —
the price threshold a contract asks about. · **Taker** — someone consuming liquidity with an
immediate order. · **USDC** — the dollar stablecoin we settle in; 6 decimals.

---

## 6. Your first day

1. Read [`PRD.md`](PRD.md) end to end. It is the source of truth.
2. Re-read §1.4 above (one book, two perspectives) until the four-paths table feels obvious. Most
   design conversations assume it.
3. Skim [`../specs/001-binary-outcome-markets/spec.md`](../specs/001-binary-outcome-markets/spec.md),
   especially the Edge Cases section — it is the clearest statement of what "correct" means here.
4. Read [`../DECISIONS.md`](../DECISIONS.md) so you don't reopen a settled question.
5. Ask about anything in §3.3 that doesn't yet feel obviously right. Those eleven rules are load
   bearing, and understanding *why* each exists matters more than memorizing them.

Setup instructions land in the README as the project takes shape.
