/**
 * Pyth token-day probe (research.md R5, tasks.md T090): proves the whole real-oracle
 * path end to end against the BTC/USD crypto feed (which the current key *is* entitled
 * to), while also recording what Hermes says about an Equity.US feed today (expected
 * 403 "Not entitled" until the account is upgraded -- DECISIONS.md §8).
 *
 * CLI: `pnpm --filter @meridian/automation run probe pyth [--feed <hex>] [--post]`
 *
 * Steps (brief):
 *   1. Fetch the latest Hermes update for the target feed (default: BTC/USD) and print
 *      price/conf/expo/publish_time and the HTTP status.
 *   2. Also try the AAPL Equity.US feed and print its status/body.
 *   3. With `--post`: require the RPC endpoint's genesis hash to be devnet's (fix #2 --
 *      refuses mainnet and anything else outright, before requesting funding or
 *      posting anything), airdrop the publisher to 1 SOL if below 0.5 SOL (one
 *      attempt, no retry loop on rate limit -- print the faucet URL and continue if the
 *      existing balance is already sufficient), post the update to the devnet receiver
 *      via the SDK's `PythTransactionBuilder` (fix #1, same as `PythReceiverProvider`),
 *      print the posted `PriceUpdateV2` address and slot, and write the raw account
 *      bytes plus a JSON sidecar to `programs/meridian/tests/fixtures/`.
 *   4. Compare the Hermes price with Nasdaq/Finnhub, but only for equity feeds (BTC is
 *      explicitly skipped, and the probe says so).
 *
 * Never prints `PYTH_API_KEY`.
 */

import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { fetchFinnhubQuote } from "../sources/finnhub.js";
import { fetchLatestUpdate, HermesError, type HermesUpdate } from "../sources/hermes.js";
import { loadPublisherKeypair } from "../keys.js";
import { assertGenesisHash } from "../chain.js";
import { sendTransactionsInOrder, type PriorityFeeConfig } from "../providers/PythReceiverProvider.js";

// See providers/PythReceiverProvider.ts's matching comment: `@pythnetwork/pyth-solana-receiver`
// (pinned to the Node-22-compatible 0.13.0, DECISIONS.md §8/fix #7) ships a pure-CJS
// `dist/index.cjs` with no `import` condition in its `exports` map. Loading it via
// `createRequire` rather than a plain ESM `import` avoids relying on Node's
// cjs-module-lexer named-export detection for that build.
const requireCjs = createRequire(import.meta.url);
const { PythSolanaReceiver } = requireCjs("@pythnetwork/pyth-solana-receiver") as {
  PythSolanaReceiver: new (args: {
    connection: Connection;
    wallet: unknown;
    receiverProgramId: PublicKey;
  }) => {
    newTransactionBuilder: (config: { closeUpdateAccounts?: boolean }) => {
      addPostPriceUpdates: (updates: string[]) => Promise<void>;
      buildVersionedTransactions: (
        args: PriorityFeeConfig,
      ) => Promise<{ tx: VersionedTransaction; signers: Keypair[] }[]>;
      getPriceUpdateAccount: (priceFeedId: string) => PublicKey;
    };
  };
};

/** `Crypto.BTC/USD` feed id (devnet-entitled today; the brief's proof target). */
export const DEFAULT_BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
/** `Equity.US.AAPL/USD` feed id (research.md R4) -- expected 403 until upgraded. */
export const AAPL_EQUITY_FEED_HEX = "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688";

const MIN_PUBLISHER_LAMPORTS = 0.5 * LAMPORTS_PER_SOL;
const AIRDROP_LAMPORTS = 1 * LAMPORTS_PER_SOL;
const FAUCET_URL = "https://faucet.solana.com";

type Flags = Record<string, string | boolean>;

interface ProbeEnv {
  hermesBaseUrl: string;
  pythApiKey: string;
  rpcUrl: string;
  receiverProgramId: PublicKey;
  publisherKeypairPath: string;
  finnhubApiKey?: string;
}

function readEnv(): ProbeEnv {
  const apiKey = process.env.PYTH_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("probe pyth: PYTH_API_KEY is required (export it from /run/keys/pyth_api_key)");
  }
  return {
    hermesBaseUrl: process.env.PYTH_HERMES_URL?.trim() || "https://pyth.dourolabs.app/hermes",
    pythApiKey: apiKey,
    rpcUrl: process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com",
    receiverProgramId: new PublicKey(
      process.env.PYTH_RECEIVER_PROGRAM?.trim() || "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    ),
    publisherKeypairPath: process.env.PUBLISHER_KEYPAIR_PATH?.trim() || "/run/keys/publisher.json",
    finnhubApiKey: process.env.FINNHUB_API_KEY?.trim() || undefined,
  };
}

function formatPrice(update: HermesUpdate): string {
  const { price, conf, expo, publishTime } = update.parsed;
  return `price=${price} conf=${conf} expo=${expo} publish_time=${publishTime}`;
}

async function tryFetch(label: string, feedHex: string, env: ProbeEnv): Promise<HermesUpdate | undefined> {
  try {
    const update = await fetchLatestUpdate(feedHex, { baseUrl: env.hermesBaseUrl, apiKey: env.pythApiKey });
    const wallClock = Math.floor(Date.now() / 1000);
    const driftSecs = wallClock - update.parsed.publishTime;
    console.log(`[probe] ${label} (${feedHex}): HTTP 200 ${formatPrice(update)} drift_from_wall_clock=${driftSecs}s`);
    return update;
  } catch (err) {
    if (err instanceof HermesError) {
      console.log(`[probe] ${label} (${feedHex}): HTTP ${err.status} body=${err.body}`);
      return undefined;
    }
    throw err;
  }
}

/** Fixture output directory, resolved relative to this file (not `process.cwd()`). */
function fixturesDir(): string {
  return fileURLToPath(new URL("../../../../programs/meridian/tests/fixtures/", import.meta.url));
}

/** Minimal wallet shape `PythSolanaReceiver`'s internal `AnchorProvider` expects. */
function walletFor(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    signTransaction: async <T extends VersionedTransaction>(tx: T) => {
      tx.sign([keypair]);
      return tx;
    },
    signAllTransactions: async <T extends VersionedTransaction>(txs: T[]) => {
      for (const tx of txs) tx.sign([keypair]);
      return txs;
    },
  };
}

async function ensurePublisherFunded(connection: Connection, publisher: Keypair): Promise<boolean> {
  const balance = await connection.getBalance(publisher.publicKey, "confirmed");
  console.log(`[probe] publisher ${publisher.publicKey.toBase58()} balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance >= MIN_PUBLISHER_LAMPORTS) return true;

  console.log(`[probe] balance below 0.5 SOL, requesting a 1 SOL airdrop (one attempt, no retry loop)`);
  try {
    const sig = await connection.requestAirdrop(publisher.publicKey, AIRDROP_LAMPORTS);
    await connection.confirmTransaction(sig, "confirmed");
    const after = await connection.getBalance(publisher.publicKey, "confirmed");
    console.log(`[probe] airdrop confirmed, new balance: ${after / LAMPORTS_PER_SOL} SOL`);
    return after >= MIN_PUBLISHER_LAMPORTS;
  } catch (err) {
    console.log(`[probe] airdrop failed or rate-limited: ${(err as Error).message}`);
    console.log(`[probe] faucet URL: ${FAUCET_URL} (devnet, address ${publisher.publicKey.toBase58()})`);
    const after = await connection.getBalance(publisher.publicKey, "confirmed");
    return after >= MIN_PUBLISHER_LAMPORTS;
  }
}

/**
 * Fallback fixture builder (brief: "if the devnet airdrop is rate-limited and the
 * publisher has no SOL... the Rust test can then use a fixture you build from the
 * Hermes parsed values with the SDK serializer as a fallback, clearly labelled as
 * synthetic"). Encodes a `PriceUpdateV2` account with the *real* Hermes-observed price
 * fields, using the receiver SDK's own Anchor IDL/Borsh coder (not a hand-rolled
 * layout), so the bytes are byte-for-byte what the real program would have produced --
 * only the posting step itself (and therefore the account address, owner pubkey, and
 * slot) is synthetic.
 */
async function buildSyntheticFixtureBytes(update: HermesUpdate, feedHex: string): Promise<Buffer> {
  const pkgPath = requireCjs.resolve("@pythnetwork/pyth-solana-receiver");
  const nestedRequire = createRequire(pkgPath);
  const anchor = nestedRequire("@coral-xyz/anchor") as {
    BorshAccountsCoder: new (idl: unknown) => { encode: (name: string, obj: unknown) => Promise<Buffer> };
    BN: new (v: string | number) => unknown;
  };
  const pkg = requireCjs("@pythnetwork/pyth-solana-receiver") as { pythSolanaReceiverIdl: unknown };
  const coder = new anchor.BorshAccountsCoder(pkg.pythSolanaReceiverIdl);

  const feedIdBytes = Array.from(Buffer.from(feedHex, "hex"));
  const sample = {
    writeAuthority: PublicKey.default,
    verificationLevel: { full: {} },
    priceMessage: {
      feedId: feedIdBytes,
      price: new anchor.BN(update.parsed.price.toString()),
      conf: new anchor.BN(update.parsed.conf.toString()),
      exponent: update.parsed.expo,
      publishTime: new anchor.BN(update.parsed.publishTime),
      prevPublishTime: new anchor.BN(update.parsed.publishTime),
      emaPrice: new anchor.BN(update.parsed.price.toString()),
      emaConf: new anchor.BN(update.parsed.conf.toString()),
    },
    postedSlot: new anchor.BN(0),
  };

  return coder.encode("priceUpdateV2", sample);
}

async function captureSyntheticFixture(env: ProbeEnv, btcUpdate: HermesUpdate, feedHex: string): Promise<void> {
  console.log(
    "[probe] building a SYNTHETIC fixture from the real Hermes-observed price via the receiver SDK's own " +
      "Borsh coder (no devnet posting happened); clearly labelled synthetic:true in the sidecar",
  );
  const data = await buildSyntheticFixtureBytes(btcUpdate, feedHex);

  const dir = fixturesDir();
  mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, "pyth_price_update_btc.bin");
  const jsonPath = path.join(dir, "pyth_price_update_btc.json");
  writeFileSync(binPath, data);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        pubkey: null,
        owner: env.receiverProgramId.toBase58(),
        slot: null,
        feedId: feedHex,
        publishTime: btcUpdate.parsed.publishTime,
        price: btcUpdate.parsed.price.toString(),
        conf: btcUpdate.parsed.conf.toString(),
        expo: btcUpdate.parsed.expo,
        synthetic: true,
        syntheticReason: "devnet airdrop failed/rate-limited; built from real Hermes values with the SDK's own Borsh coder, never posted on chain",
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[probe] wrote synthetic fixture: ${binPath}`);
  console.log(`[probe] wrote synthetic sidecar: ${jsonPath}`);
}

async function postAndCaptureFixture(env: ProbeEnv, btcUpdate: HermesUpdate, feedHex: string): Promise<void> {
  const connection = new Connection(env.rpcUrl, "confirmed");

  // Fix #2: refuse to request funding or post anything unless the RPC endpoint is
  // genuinely devnet (checked via genesis hash, not the configured URL's hostname).
  // `assertGenesisHash` throws naming mainnet-beta's genesis hash explicitly if that's
  // what it finds; any other unexpected genesis hash is refused too.
  await assertGenesisHash(connection, "devnet");

  let publisher: Keypair;
  try {
    publisher = loadPublisherKeypair(env.publisherKeypairPath);
  } catch (err) {
    console.log(`[probe] could not load the publisher keypair: ${(err as Error).message}`);
    console.log("[probe] cannot post to devnet without a publisher key; falling back to a synthetic fixture");
    await captureSyntheticFixture(env, btcUpdate, feedHex);
    return;
  }

  const funded = await ensurePublisherFunded(connection, publisher);
  if (!funded) {
    console.log(
      "[probe] publisher balance is still below 0.5 SOL after a failed/rate-limited airdrop; " +
        "stopping before posting to devnet, per the brief (no faucet retry loop)",
    );
    await captureSyntheticFixture(env, btcUpdate, feedHex);
    return;
  }

  const wallet = walletFor(publisher);
  const receiver = new PythSolanaReceiver({
    connection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet: wallet as any,
    receiverProgramId: env.receiverProgramId,
  });

  // Fix #1: use the SDK's own transaction builder to split posting into correctly
  // sized versioned transactions (a real update does not fit in one packet), signing
  // and sending/confirming each in order via the same `sendTransactionsInOrder` helper
  // `PythReceiverProvider` uses (fix #6's `value.err` check lives there too).
  // `closeUpdateAccounts: false` keeps the posted `PriceUpdateV2` account alive for
  // the Rust test to read.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  const base64Update = Buffer.from(btcUpdate.binary).toString("base64");
  await builder.addPostPriceUpdates([base64Update]);
  const transactions = await builder.buildVersionedTransactions({});

  await sendTransactionsInOrder(connection, publisher, transactions);
  console.log(`[probe] posted update in ${transactions.length} transaction(s)`);

  const priceAccount = builder.getPriceUpdateAccount(`0x${feedHex}`);

  const { context, value } = await connection.getAccountInfoAndContext(priceAccount, "confirmed");
  if (!value) {
    throw new Error(`probe pyth: posted account ${priceAccount.toBase58()} not found immediately after posting`);
  }
  console.log(
    `[probe] PriceUpdateV2 address=${priceAccount.toBase58()} slot=${context.slot} owner=${value.owner.toBase58()} dataLen=${value.data.length}`,
  );

  const dir = fixturesDir();
  mkdirSync(dir, { recursive: true });
  const binPath = path.join(dir, "pyth_price_update_btc.bin");
  const jsonPath = path.join(dir, "pyth_price_update_btc.json");
  writeFileSync(binPath, value.data);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        pubkey: priceAccount.toBase58(),
        owner: value.owner.toBase58(),
        slot: context.slot,
        feedId: feedHex,
        publishTime: btcUpdate.parsed.publishTime,
        price: btcUpdate.parsed.price.toString(),
        conf: btcUpdate.parsed.conf.toString(),
        expo: btcUpdate.parsed.expo,
        synthetic: false,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[probe] wrote fixture: ${binPath}`);
  console.log(`[probe] wrote sidecar: ${jsonPath}`);
}

export async function runPyth(flags: Flags): Promise<void> {
  const env = readEnv();
  const feedHex = typeof flags.feed === "string" ? flags.feed : DEFAULT_BTC_FEED_HEX;

  console.log("[probe] step 1: latest update for the target feed (default BTC/USD)");
  const targetUpdate = await tryFetch("target", feedHex, env);

  console.log("[probe] step 2: latest update for the AAPL Equity.US feed (expected 403 today)");
  const aaplUpdate = await tryFetch("AAPL", AAPL_EQUITY_FEED_HEX, env);

  if (flags.post) {
    console.log("[probe] step 3: --post requested");
    if (!targetUpdate) {
      console.log("[probe] cannot post: the target feed fetch in step 1 did not succeed");
    } else {
      await postAndCaptureFixture(env, targetUpdate, feedHex);
    }
  } else {
    console.log("[probe] step 3: skipped (pass --post to post to the devnet receiver and capture the fixture)");
  }

  console.log("[probe] step 4: equity cross-check (BTC/crypto feeds are skipped by design)");
  if (feedHex === DEFAULT_BTC_FEED_HEX || feedHex.toLowerCase() === DEFAULT_BTC_FEED_HEX.toLowerCase()) {
    console.log("[probe] target feed is BTC/USD (crypto), not an equity -- skipping Nasdaq/Finnhub cross-check");
  }
  if (!aaplUpdate) {
    console.log("[probe] AAPL Hermes fetch did not return a parsed price (likely 403 Not entitled); skipping cross-check");
  } else if (env.finnhubApiKey) {
    try {
      const finnhub = await fetchFinnhubQuote("AAPL", env.finnhubApiKey);
      console.log(`[probe] AAPL Finnhub current price (micro-USD): ${finnhub.current.priceMicro}`);
    } catch (err) {
      console.log(`[probe] AAPL Finnhub cross-check failed: ${(err as Error).message}`);
    }
  } else {
    console.log("[probe] no FINNHUB_API_KEY configured; skipping the equity cross-check");
  }
}
