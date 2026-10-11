/**
 * Nightly maker cleanup for the demo quotes (scripts/seed-daily.ts): for every settled market,
 * cancel the test wallets' remaining orders, redeem pairs and winning tokens so the USDC
 * returns to the maker and the nightly reclaim can close the market. Run from the host cron
 * after settlement (docs/deployment.md "Demo liquidity"). MAKER_WALLETS=user-a,demo-maker,...
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadScriptEnv } from "./lib/env.js";
import { resolveAdminKeypair, resolveKeypair } from "./lib/keys.js";
import { LifecycleChain } from "./lib/lifecycle/chain.js";
const env = loadScriptEnv();
const connection = new Connection(env.solanaRpcUrl, "confirmed");
const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: false });
const boot = new LifecycleChain(connection, admin, publisher, PublicKey.default);
const cfg = (await boot.fetchConfig())!;
const chain = new LifecycleChain(connection, admin, publisher, cfg.usdcMint);
chain.paceMs = 750;
const all = (await chain.program.account.market.all()) as Array<{ publicKey: PublicKey; account: any }>;
const settled = all.filter((x) => Object.keys(x.account.state)[0] === "settled");
console.log("settled markets", settled.length);
const wallets = (process.env.MAKER_WALLETS ?? "user-a,demo-maker,demo-taker,user-b").split(",").map((n) => [n, resolveKeypair(`/run/keys/${n}.json`, { createIfMissing: false })] as const);
for (const { publicKey: address } of settled) {
  const m = await chain.fetchMarket(address);
  if (m === null) continue;
  const label = `${Buffer.from(m.ticker as any).toString("ascii").replace(/\0+$/, "")} ${Number(m.strike) / 1e6}`;
  const book = await chain.fetchBook(m.book).catch(() => null);
  for (const [name, w] of wallets) {
    if (book) for (const o of [...book.bids, ...book.asks]) {
      if (!o.owner.equals(w.publicKey)) continue;
      try { await chain.cancelOrder(w, address, m, o.id); await chain.pace(); console.log(name, "cancelled", label, o.id.toString()); } catch (e) { console.log(name, "cancel failed", label, (e as Error).message.slice(0, 80)); }
    }
    // Cancellations above return tokens asynchronously; give them a moment before reading balances.
    await new Promise((r) => setTimeout(r, 4000));
    const yes = await chain.getTokenBalance(chain.yesAtaAddress(w.publicKey, m.yesMint, m.yesNoTokenProgram)).catch(() => 0n);
    const no = await chain.getTokenBalance(chain.noAtaAddress(w.publicKey, m.noMint, m.yesNoTokenProgram)).catch(() => 0n);
    const pairs = yes < no ? yes : no;
    try {
      if (pairs > 0n) { await chain.redeemPair(w, address, m, pairs / 1_000_000n); await chain.pace(); console.log(name, "redeemed pairs", label, pairs / 1_000_000n); }
      const side = String(m.outcome).toLowerCase() === "yes" ? 1 : String(m.outcome).toLowerCase() === "no" ? 2 : 0;
      const winLeft = side === 1 ? yes - pairs : side === 2 ? no - pairs : 0n;
      if (side !== 0 && winLeft > 0n) { await chain.redeemWinning(w, address, m, side as 1 | 2, winLeft / 1_000_000n); await chain.pace(); console.log(name, "redeemed winning", label, winLeft / 1_000_000n); }
    } catch (e) { console.log(name, "redeem failed", label, (e as Error).message.slice(0, 80)); }
  }
}
console.log("maker-cleanup done"); process.exit(0);
