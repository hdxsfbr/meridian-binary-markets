import { Connection, PublicKey } from "@solana/web3.js";
import { loadScriptEnv } from "/work/scripts/lib/env.ts";
import { resolveAdminKeypair, resolveKeypair } from "/work/scripts/lib/keys.ts";
import { LifecycleChain } from "/work/scripts/lib/lifecycle/chain.ts";
const env = loadScriptEnv();
const connection = new Connection(env.solanaRpcUrl, "confirmed");
const admin = resolveAdminKeypair(env.adminKeypairPath, { createIfMissing: false, allowCliFallback: true });
const publisher = resolveKeypair(env.publisherKeypairPath, { createIfMissing: false });
const taker = resolveKeypair("/run/keys/user-b.json", { createIfMissing: false });
const boot = new LifecycleChain(connection, admin, publisher, PublicKey.default);
const cfg = (await boot.fetchConfig())!;
const chain = new LifecycleChain(connection, admin, publisher, cfg.usdcMint);
chain.paceMs = 750;
const tradingDay = 20261010; // Saturday: never a real trading day (DECISIONS §25)
const closeTs = Date.UTC(2026, 9, 10, 20, 0, 0) / 1000;
const strike = 341n * 1_000_000n;
const address = chain.marketAddress("AAPL", tradingDay, strike);
let m = await chain.fetchMarket(address);
if (m === null) { await chain.createMarket("AAPL", strike, tradingDay, closeTs, 16); await chain.pace(); console.log("created", address.toBase58()); }
await chain.createBookUntilDone(address);
m = (await chain.fetchMarket(address))!;
console.log("yesMint", m.yesMint.toBase58(), "noMint", m.noMint.toBase58(), "tokenProgram", m.yesNoTokenProgram.toBase58());
const yesBal = await chain.getTokenBalance(chain.yesAtaAddress(taker.publicKey, m.yesMint, m.yesNoTokenProgram)).catch(() => 0n);
if (yesBal < 2n) { await chain.mintPair(taker, address, m, 2n); console.log("minted 2 pairs to taker"); }
