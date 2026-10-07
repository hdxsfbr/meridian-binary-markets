import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_WS_URL: "wss://api.devnet.solana.com",
    ADMIN_KEYPAIR_PATH: "/run/keys/admin.json",
    PUBLISHER_KEYPAIR_PATH: "/run/keys/publisher.json",
    USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    ORACLE_PROVIDER: "mock",
    PYTH_HERMES_URL: "https://pyth.dourolabs.app/hermes",
    PYTH_API_KEY: "",
    PYTH_RECEIVER_PROGRAM: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    FINNHUB_API_KEY: "",
    ALERT_WEBHOOK_URL: "",
    AUTOMATION_STATUS_PORT: "8787",
    DEMO_SCALE: "1",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const config = loadConfig(baseEnv());
    expect(config.solanaCluster).toBe("devnet");
    expect(config.oracleProvider).toBe("mock");
    expect(config.automationStatusPort).toBe(8787);
    expect(config.demoScale).toBe(true);
    expect(config.pythApiKey).toBeUndefined();
  });

  it("refuses mainnet-beta with a clear message", () => {
    expect(() => loadConfig(baseEnv({ SOLANA_CLUSTER: "mainnet-beta" }))).toThrow(/mainnet-beta/i);
  });

  it("refuses ORACLE_PROVIDER=pyth without PYTH_API_KEY", () => {
    expect(() =>
      loadConfig(baseEnv({ ORACLE_PROVIDER: "pyth", PYTH_API_KEY: "" })),
    ).toThrow(/PYTH_API_KEY/);
  });

  it("accepts ORACLE_PROVIDER=pyth when PYTH_API_KEY is set", () => {
    const config = loadConfig(baseEnv({ ORACLE_PROVIDER: "pyth", PYTH_API_KEY: "secret" }));
    expect(config.oracleProvider).toBe("pyth");
    expect(config.pythApiKey).toBe("secret");
  });

  it("coerces DEMO_SCALE '0' to false and '1' to true", () => {
    expect(loadConfig(baseEnv({ DEMO_SCALE: "0" })).demoScale).toBe(false);
    expect(loadConfig(baseEnv({ DEMO_SCALE: "1" })).demoScale).toBe(true);
  });

  it("lists the missing field name when a required variable is absent", () => {
    expect(() => loadConfig(baseEnv({ USDC_MINT: undefined }))).toThrow(/USDC_MINT/);
  });

  it("aggregates multiple invalid fields in one error", () => {
    let threw = false;
    try {
      loadConfig(baseEnv({ USDC_MINT: undefined, ADMIN_KEYPAIR_PATH: undefined }));
    } catch (err) {
      threw = true;
      const message = (err as Error).message;
      expect(message).toMatch(/USDC_MINT/);
      expect(message).toMatch(/ADMIN_KEYPAIR_PATH/);
    }
    expect(threw).toBe(true);
  });

  it("refuses ORACLE_PROVIDER=pyth when PYTH_API_KEY is whitespace-only", () => {
    expect(() =>
      loadConfig(baseEnv({ ORACLE_PROVIDER: "pyth", PYTH_API_KEY: "   " })),
    ).toThrow(/PYTH_API_KEY/);
  });

  it("trims whitespace around PYTH_API_KEY and FINNHUB_API_KEY", () => {
    const config = loadConfig(
      baseEnv({
        ORACLE_PROVIDER: "pyth",
        PYTH_API_KEY: "  secret  ",
        FINNHUB_API_KEY: "  fh-key  ",
      }),
    );
    expect(config.pythApiKey).toBe("secret");
    expect(config.finnhubApiKey).toBe("fh-key");
  });

  it("refuses a USDC_MINT that is not a valid Solana public key", () => {
    expect(() => loadConfig(baseEnv({ USDC_MINT: "not-a-pubkey" }))).toThrow(/USDC_MINT/);
  });

  it("refuses a PYTH_RECEIVER_PROGRAM that is not a valid Solana public key", () => {
    expect(() => loadConfig(baseEnv({ PYTH_RECEIVER_PROGRAM: "not-a-pubkey" }))).toThrow(
      /PYTH_RECEIVER_PROGRAM/,
    );
  });

  it("refuses a non-http(s) SOLANA_RPC_URL", () => {
    expect(() => loadConfig(baseEnv({ SOLANA_RPC_URL: "ftp://api.devnet.solana.com" }))).toThrow(
      /SOLANA_RPC_URL/,
    );
  });

  it("refuses a non-http(s) PYTH_HERMES_URL", () => {
    expect(() =>
      loadConfig(baseEnv({ PYTH_HERMES_URL: "ftp://pyth.dourolabs.app/hermes" })),
    ).toThrow(/PYTH_HERMES_URL/);
  });

  it("refuses a non-http(s) ALERT_WEBHOOK_URL", () => {
    expect(() =>
      loadConfig(baseEnv({ ALERT_WEBHOOK_URL: "ftp://example.com/hook" })),
    ).toThrow(/ALERT_WEBHOOK_URL/);
  });

  it("refuses a non-ws(s) SOLANA_WS_URL", () => {
    expect(() => loadConfig(baseEnv({ SOLANA_WS_URL: "https://api.devnet.solana.com" }))).toThrow(
      /SOLANA_WS_URL/,
    );
  });
});
