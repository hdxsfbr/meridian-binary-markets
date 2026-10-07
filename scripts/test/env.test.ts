import { describe, expect, it } from "vitest";
import { loadScriptEnv } from "../lib/env.js";

const VALID_PUBKEY = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CLUSTER: "localnet",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadScriptEnv", () => {
  it("accepts localnet with defaults", () => {
    const env = loadScriptEnv(baseEnv());
    expect(env.cluster).toBe("localnet");
    expect(env.solanaRpcUrl).toBe("http://127.0.0.1:8899");
    expect(env.adminKeypairPath).toBe("/run/keys/admin.json");
    expect(env.publisherKeypairPath).toBe("/run/keys/publisher.json");
    expect(env.oracleProvider).toBe("mock");
    expect(env.demoScale).toBe(false);
  });

  it("accepts devnet and defaults its RPC URL", () => {
    const env = loadScriptEnv(baseEnv({ CLUSTER: "devnet" }));
    expect(env.cluster).toBe("devnet");
    expect(env.solanaRpcUrl).toBe("https://api.devnet.solana.com");
  });

  it("refuses mainnet-beta", () => {
    expect(() => loadScriptEnv(baseEnv({ CLUSTER: "mainnet-beta" }))).toThrow(/refused/i);
  });

  it("refuses an arbitrary bad cluster value", () => {
    expect(() => loadScriptEnv(baseEnv({ CLUSTER: "testnet" }))).toThrow();
  });

  it("refuses a missing CLUSTER", () => {
    expect(() => loadScriptEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it("refuses an invalid ORACLE_PROVIDER", () => {
    expect(() => loadScriptEnv(baseEnv({ ORACLE_PROVIDER: "chainlink" }))).toThrow();
  });

  it("refuses a malformed USDC_MINT", () => {
    expect(() => loadScriptEnv(baseEnv({ USDC_MINT: "not-a-pubkey" }))).toThrow(/USDC_MINT/);
  });

  it("accepts a valid USDC_MINT", () => {
    const env = loadScriptEnv(baseEnv({ USDC_MINT: VALID_PUBKEY }));
    expect(env.usdcMint).toBe(VALID_PUBKEY);
  });

  it("parses DEMO_SCALE=1 as true", () => {
    const env = loadScriptEnv(baseEnv({ DEMO_SCALE: "1" }));
    expect(env.demoScale).toBe(true);
  });

  it("respects an explicit SOLANA_RPC_URL override", () => {
    const env = loadScriptEnv(baseEnv({ CLUSTER: "devnet", SOLANA_RPC_URL: "https://custom.example/rpc" }));
    expect(env.solanaRpcUrl).toBe("https://custom.example/rpc");
  });

  it("refuses a malformed PYTH_RECEIVER_PROGRAM", () => {
    expect(() => loadScriptEnv(baseEnv({ PYTH_RECEIVER_PROGRAM: "nope" }))).toThrow(/PYTH_RECEIVER_PROGRAM/);
  });
});
