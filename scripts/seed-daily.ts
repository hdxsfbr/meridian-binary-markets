/**
 * Daily demo quotes: for every enabled ticker with open markets for today, mint two pairs with
 * the maker wallet and post a two-sided Yes quote on the strike nearest the live Pyth price
 * (lib/quote-pricing.ts). Skips a strike that already has orders, so re-runs are harmless.
 *
 * Run from the host cron (see docs/deployment.md "Demo liquidity") inside the dev container:
 *   docker exec -e CLUSTER=devnet -w /work/scripts <container> node_modules/.bin/tsx seed-daily.ts [--dry-run] [--day YYYYMMDD] [--pairs N]
 * Maker key: MAKER_KEYPAIR_PATH (default /run/keys/user-a.json). Pyth key: PYTH_API_KEY or
 * /run/keys/pyth_api_key. Exits non-zero only when nothing could be read; a single failed strike
 * is logged and skipped.
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { FEED_IDS } from "@meridian/sdk";
import { loadScriptEnv } from "./lib/env.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";
import { LifecycleChain } from "./lib/lifecycle/chain.js";
import { configPda, PROGRAM_ID } from "@meridian/sdk";
import { nearestStrike, planQuote } from "./lib/quote-pricing.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const pairs = BigInt(flag("--pairs") ?? "2");

function tradingDayTodayEt(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  return Number(`${get("year")}${get("month")}${get("day")}`);
}

function pythKey(): string {
  const fromEnv = process.env.PYTH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readFileSync(process.env.PYTH_API_KEY_FILE ?? "/run/keys/pyth_api_key", "utf8").trim();
}

async function livePrices(tickers: string[]): Promise<Map<string, number>> {
  const ids = tickers.map((t) => FEED_IDS[t]).filter((x): x is string => Boolean(x));
  const url = `https://pyth.dourolabs.app/hermes/v2/updates/price/latest?${ids.map((id) => `ids[]=${id}`).join("&")}&parsed=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${pythKey()}` } });
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const body = (await res.json()) as { parsed: Array<{ id: string; price: { price: string; expo: number } }> };
  const out = new Map<string, number>();
  for (const p of body.parsed) {
    const ticker = tickers.find((t) => FEED_IDS[t] === p.id);
    if (ticker) out.set(ticker, Number(p.price.price) * 10 ** p.price.expo);
  }
  return out;
}

const env = loadScriptEnv();
const connection = new Connection(env.solanaRpcUrl, "confirmed");
const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: false });
const maker = resolveKeypair(process.env.MAKER_KEYPAIR_PATH ?? "/run/keys/user-a.json", { createIfMissing: false });
const boot = new LifecycleChain(connection, admin, publisher, PublicKey.default);
const cfg = (await boot.fetchConfig())!;
const chain = new LifecycleChain(connection, admin, publisher, cfg.usdcMint);
chain.paceMs = 750;

const day = Number(flag("--day") ?? tradingDayTodayEt());
const rawConfig = (await chain.program.account.config.fetch(configPda(PROGRAM_ID)[0])) as unknown as {
  tickers: Array<{ symbol: number[]; enabled: boolean }>;
};
const enabled = rawConfig.tickers
  .filter((t) => t.enabled)
  .map((t) => Buffer.from(t.symbol).toString("ascii").replace(/\0+$/, ""))
  .filter((t) => t.length > 0);
const all = (await chain.program.account.market.all()) as Array<{ publicKey: PublicKey; account: any }>;
const todays = all.filter((m) => m.account.tradingDay === day && Object.keys(m.account.state)[0] === "open");
console.log(`seed-daily: day ${day}, ${todays.length} open markets across ${enabled.length} enabled tickers${dryRun ? " (dry run)" : ""}`);
if (todays.length === 0) {
  console.log("seed-daily: nothing to quote");
  process.exit(0);
}
const prices = await livePrices(enabled);
let quoted = 0;
let failed = 0;
for (const ticker of enabled) {
  const mine = todays.filter((m) => Buffer.from(m.account.ticker).toString("ascii").replace(/\0+$/, "") === ticker);
  const price = prices.get(ticker);
  if (mine.length === 0 || price === undefined) {
    console.log(`${ticker}: ${mine.length === 0 ? "no open markets today" : "no live price"}; skipped`);
    continue;
  }
  const strikes = mine.map((m) => Number(m.account.strike) / 1e6);
  const strike = nearestStrike(price, strikes)!;
  const record = mine.find((m) => Number(m.account.strike) / 1e6 === strike)!;
  const plan = planQuote(price, strike);
  const label = `${ticker} $${strike} (price ${price.toFixed(2)}, p=${plan.probability.toFixed(2)}): bid ${Number(plan.bidMicro) / 1e6} ask ${Number(plan.askMicro) / 1e6} x${pairs}`;
  try {
    const market = (await chain.fetchMarket(record.publicKey))!;
    const book = await chain.fetchBook(market.book);
    if (book.asks.length > 0 || book.bids.length > 0) {
      console.log(`${label}: book already has orders; skipped`);
      continue;
    }
    if (dryRun) {
      console.log(`${label}: would quote`);
      continue;
    }
    const yesHeld = await chain.getTokenBalance(chain.yesAtaAddress(maker.publicKey, market.yesMint, market.yesNoTokenProgram)).catch(() => 0n);
    if (yesHeld < pairs * 1_000_000n) {
      await chain.mintPair(maker, record.publicKey, market, pairs);
      await chain.pace();
    }
    await chain.placeOrder(maker, record.publicKey, market, 1, plan.askMicro, pairs, 0, []);
    await chain.pace();
    await chain.placeOrder(maker, record.publicKey, market, 0, plan.bidMicro, pairs, 0, []);
    await chain.pace();
    quoted += 1;
    console.log(`${label}: quoted`);
  } catch (err) {
    failed += 1;
    console.log(`${label}: failed: ${(err as Error).message.slice(0, 160)}`);
  }
}
console.log(`seed-daily: quoted ${quoted}, failed ${failed}, maker USDC ${Number(await chain.getTokenBalance(await chain.usdcAta(maker.publicKey)).catch(() => 0n)) / 1e6}`);
process.exit(failed > 0 && quoted === 0 ? 1 : 0);
