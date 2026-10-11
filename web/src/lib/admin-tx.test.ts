/**
 * Unit coverage for `removeStrike`/`adjustStrike` (FR-10 "adjust strikes"):
 * `adjustStrike` is removeStrike-then-addStrike with a stop-on-failure and a
 * per-stage progress callback, so these tests mock the Anchor `program`
 * (methods/accounts/connection) rather than hitting a real validator --
 * `instruction-accounts.test.ts` already covers the account-list shape
 * against the real regenerated IDL for the trade-panel builders; the
 * `removeStrike` account list gets the same real-IDL coverage below once
 * `remove_strike` exists in `@meridian/sdk`'s IDL.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program } from "@anchor-lang/core";
import { IDL, marketPda, type Ticker } from "@meridian/sdk";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_2022_PROGRAM_ID } from "./ata";
import { PROGRAM_ID } from "./rpc";
import { addStrike, adjustStrike, removeStrike, type AddStrikeArgs, type RemoveStrikeArgs } from "./admin-tx";

const HAS_REMOVE_STRIKE = IDL.instructions.some((ix) => ix.name === "remove_strike");

describe.runIf(HAS_REMOVE_STRIKE)("removeStrike against the real Program + regenerated IDL", () => {
  it("builds without a missing-account rejection", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const admin = Keypair.generate().publicKey;
    const provider = { connection, publicKey: admin };
    const program = new Program(IDL, provider) as unknown as import("@anchor-lang/core").Program;
    // `fetchYesNoTokenProgram` reads the Yes mint's owner over the connection;
    // stub it so this stays a pure account-shape test, no live RPC.
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue({ owner: TOKEN_2022_PROGRAM_ID } as never);

    const args: RemoveStrikeArgs = { ticker: "AAPL" as Ticker, strike: 100_000_000n, tradingDay: 20261001 };
    // No live validator at this address: `sendTx`'s own `getLatestBlockhash`
    // call fails and is caught into a generic `{ ok: false }` (`describeError`
    // never surfaces the raw message). What this test actually asserts is
    // that account assembly -- `.instruction()` against the real IDL -- never
    // throws "Account ... not provided": capture the raw error via the
    // `console.error` call `sendTx` makes before mapping it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await removeStrike(program, connection, vi.fn(), admin, args);
    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    const loggedError = errorSpy.mock.calls.at(-1)?.[1];
    expect(String((loggedError as { message?: unknown } | undefined)?.message ?? loggedError)).not.toMatch(/not provided/i);
    errorSpy.mockRestore();
  });
});

/** A fake Anchor `program.methods` builder: records every call, returns a fixed instruction. */
function fakeMethods(calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }>) {
  return new Proxy(
    {},
    {
      get(_target, methodName: string) {
        return (...args: unknown[]) => ({
          accountsPartial(accounts: Record<string, unknown>) {
            calls.push({ name: methodName, args, accounts });
            return {
              instruction: async () => ({ keys: [], programId: PROGRAM_ID, data: Buffer.alloc(0) }),
            };
          },
        });
      },
    },
  );
}

type FakeProgramOpts = {
  getAccountInfoOwner?: PublicKey;
  confirmErr?: unknown;
};

function fakeProgram(calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }>, opts: FakeProgramOpts = {}) {
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue({ owner: opts.getAccountInfoOwner ?? TOKEN_2022_PROGRAM_ID }),
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "hash", lastValidBlockHeight: 1 }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: opts.confirmErr ?? null } }),
  };

  const marketFetch = vi.fn();

  const program = {
    methods: fakeMethods(calls),
    provider: { connection },
    account: {
      market: {
        fetch: marketFetch,
      },
    },
  } as unknown as import("@anchor-lang/core").Program;

  return { program, connection, marketFetch };
}

describe("removeStrike", () => {
  it("calls the removeStrike method with the close_market-shaped accounts and no args", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection } = fakeProgram(calls);
    const admin = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockResolvedValue("sig1");

    const args: RemoveStrikeArgs = { ticker: "AAPL" as Ticker, strike: 100_000_000n, tradingDay: 20261001 };
    const result = await removeStrike(program, connection as unknown as Connection, sendTransaction, admin, args);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("removeStrike");
    expect(calls[0]?.args).toEqual([]);
    const accounts = calls[0]?.accounts ?? {};
    for (const key of [
      "admin",
      "config",
      "market",
      "book",
      "usdcEscrow",
      "yesEscrow",
      "vault",
      "yesMint",
      "noMint",
      "usdcTokenProgram",
      "yesnoTokenProgram",
      "systemProgram",
    ]) {
      expect(accounts).toHaveProperty(key);
    }
  });

  it("propagates a failed send as TxResult.ok === false", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection } = fakeProgram(calls);
    const admin = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockRejectedValue(new Error("boom"));

    const args: RemoveStrikeArgs = { ticker: "AAPL" as Ticker, strike: 100_000_000n, tradingDay: 20261001 };
    const result = await removeStrike(program, connection as unknown as Connection, sendTransaction, admin, args);
    expect(result.ok).toBe(false);
  });
});

describe("adjustStrike", () => {
  const oldStrike: RemoveStrikeArgs = { ticker: "AAPL" as Ticker, strike: 100_000_000n, tradingDay: 20261001 };
  const newStrikeArgs: AddStrikeArgs = {
    ticker: "AAPL" as Ticker,
    strike: 110_000_000n,
    tradingDay: 20261001,
    closeTs: 1_900_000_000,
    capacity: 16,
  };

  it("removes the old strike, then adds the new one, in that order", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection, marketFetch } = fakeProgram(calls);
    // `addStrike`'s create_book loop re-fetches `Market.book`; report it as
    // already matching so the loop exits after zero `createBook` calls.
    const [newMarket] = marketPda(PROGRAM_ID, newStrikeArgs.ticker, newStrikeArgs.tradingDay, newStrikeArgs.strike);
    const { bookPda } = await import("@meridian/sdk");
    const [expectedBook] = bookPda(PROGRAM_ID, newMarket);
    marketFetch.mockResolvedValue({ book: expectedBook });

    const admin = Keypair.generate().publicKey;
    const usdcMint = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockResolvedValue("sig");
    const stages: string[] = [];

    const result = await adjustStrike(
      program,
      connection as unknown as Connection,
      sendTransaction,
      admin,
      usdcMint,
      oldStrike,
      newStrikeArgs,
      false,
      (stage) => stages.push(stage),
    );

    expect(result.ok).toBe(true);
    expect(stages).toEqual(["removing", "creating"]);
    expect(calls.map((c) => c.name)).toEqual(["removeStrike", "addStrike"]);
  });

  it("stops after the failed removal and never attempts to add the new strike", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection } = fakeProgram(calls);
    const admin = Keypair.generate().publicKey;
    const usdcMint = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockRejectedValue(new Error("removal rejected"));
    const stages: string[] = [];

    const result = await adjustStrike(
      program,
      connection as unknown as Connection,
      sendTransaction,
      admin,
      usdcMint,
      oldStrike,
      newStrikeArgs,
      false,
      (stage) => stages.push(stage),
    );

    expect(result.ok).toBe(false);
    expect(stages).toEqual(["removing"]);
    expect(calls.map((c) => c.name)).toEqual(["removeStrike"]);
    // The removal itself never happened, so a retry of the *full* adjust
    // flow is safe -- `removed` must be false, not just `ok: false`.
    expect(result).toMatchObject({ ok: false, removed: false });
  });

  it("carries removed: true when the wallet rejects the create step after removal succeeds, and resuming only runs addStrike", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection } = fakeProgram(calls);
    const admin = Keypair.generate().publicKey;
    const usdcMint = Keypair.generate().publicKey;
    const stages: string[] = [];

    // First send (removeStrike) succeeds; second send (createMarket/addStrike)
    // is rejected by the wallet.
    const sendTransaction = vi.fn().mockResolvedValueOnce("sig-remove").mockRejectedValueOnce(new Error("User rejected the request."));

    const result = await adjustStrike(
      program,
      connection as unknown as Connection,
      sendTransaction,
      admin,
      usdcMint,
      oldStrike,
      newStrikeArgs,
      false,
      (stage) => stages.push(stage),
    );

    expect(stages).toEqual(["removing", "creating"]);
    expect(calls.map((c) => c.name)).toEqual(["removeStrike", "addStrike"]);
    expect(result).toMatchObject({ ok: false, removed: true });

    // Resuming must run addStrike alone -- never removeStrike again, since
    // the old strike's accounts no longer exist.
    const resumeCalls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program: resumeProgram, connection: resumeConnection, marketFetch } = fakeProgram(resumeCalls);
    const { bookPda } = await import("@meridian/sdk");
    const [resumeMarket] = marketPda(PROGRAM_ID, newStrikeArgs.ticker, newStrikeArgs.tradingDay, newStrikeArgs.strike);
    const [expectedBook] = bookPda(PROGRAM_ID, resumeMarket);
    marketFetch.mockResolvedValue({ book: expectedBook });
    const resumeSend = vi.fn().mockResolvedValue("sig-create");

    const resumeResult = await addStrike(resumeProgram, resumeConnection as unknown as Connection, resumeSend, admin, usdcMint, newStrikeArgs, false);

    expect(resumeResult.ok).toBe(true);
    expect(resumeCalls.map((c) => c.name)).toEqual(["addStrike"]);
  });

  it("rejects an out-of-bounds new strike before sending anything -- removeStrike is never called", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection } = fakeProgram(calls);
    const admin = Keypair.generate().publicKey;
    const usdcMint = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockResolvedValue("sig");
    const stages: string[] = [];

    const tooLarge: AddStrikeArgs = { ...newStrikeArgs, strike: 20_000_000_000_000n }; // $20,000,000, above the $10,000,000 cap

    const result = await adjustStrike(
      program,
      connection as unknown as Connection,
      sendTransaction,
      admin,
      usdcMint,
      oldStrike,
      tooLarge,
      false,
      (stage) => stages.push(stage),
    );

    expect(result).toMatchObject({ ok: false, removed: false });
    expect(stages).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("uses createMarket (not addStrike) for the new strike when isFirstForTicker is true", async () => {
    const calls: Array<{ name: string; args: unknown[]; accounts: Record<string, unknown> }> = [];
    const { program, connection, marketFetch } = fakeProgram(calls);
    const [newMarket] = marketPda(PROGRAM_ID, newStrikeArgs.ticker, newStrikeArgs.tradingDay, newStrikeArgs.strike);
    const { bookPda } = await import("@meridian/sdk");
    const [expectedBook] = bookPda(PROGRAM_ID, newMarket);
    marketFetch.mockResolvedValue({ book: expectedBook });

    const admin = Keypair.generate().publicKey;
    const usdcMint = Keypair.generate().publicKey;
    const sendTransaction = vi.fn().mockResolvedValue("sig");

    await adjustStrike(program, connection as unknown as Connection, sendTransaction, admin, usdcMint, oldStrike, newStrikeArgs, true);

    expect(calls.map((c) => c.name)).toEqual(["removeStrike", "createMarket"]);
  });
});
