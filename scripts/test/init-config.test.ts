import { PublicKey } from "@solana/web3.js";
import { TICKERS } from "@meridian/sdk";
import { describe, expect, it } from "vitest";
import { buildInitializeConfigArgs, THRESHOLDS } from "../init-config.js";

const PROGRAM_ID = new PublicKey("8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PUBLISHER = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

describe("buildInitializeConfigArgs", () => {
  it("mock provider: oracle_program is the program id, oracle_provider is mockPyth", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.oracleProvider).toEqual({ mockPyth: {} });
    expect(args.oracleProgram.equals(PROGRAM_ID)).toBe(true);
  });

  it("pyth provider: oracle_program is PYTH_RECEIVER_PROGRAM, oracle_provider is pythReceiver", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "pyth",
      programId: PROGRAM_ID,
      pythReceiverProgram: PYTH_RECEIVER,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.oracleProvider).toEqual({ pythReceiver: {} });
    expect(args.oracleProgram.equals(PYTH_RECEIVER)).toBe(true);
  });

  it("pyth provider without PYTH_RECEIVER_PROGRAM throws", () => {
    expect(() =>
      buildInitializeConfigArgs({
        oracleProvider: "pyth",
        programId: PROGRAM_ID,
        publisher: PUBLISHER,
        demoScale: false,
      }),
    ).toThrow(/PYTH_RECEIVER_PROGRAM/);
  });

  it("demo scale sets capacity 16", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: true,
    });
    expect(args.defaultBookCapacity).toBe(16);
  });

  it("non-demo scale sets capacity 128", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.defaultBookCapacity).toBe(128);
  });

  it("publishers is exactly [publisher pubkey]", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.publishers).toHaveLength(1);
    expect(args.publishers[0].equals(PUBLISHER)).toBe(true);
  });

  it("applies the thresholds: 300s staleness / 25bps confidence / 0s publish offset (quote at or after the close) / 3600s override delay", () => {
    expect(THRESHOLDS).toEqual({
      maxStalenessSecs: 300,
      maxConfBps: 25,
      minPublishOffsetSecs: 0,
      overrideDelaySecs: 3600,
    });
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.maxStalenessSecs).toBe(300);
    expect(args.maxConfBps).toBe(25);
    expect(args.minPublishOffsetSecs).toBe(0);
    expect(args.overrideDelaySecs).toBe(3600);
  });

  it("accepts BTC via an explicit --tickers list (DECISIONS.md §30)", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
      tickers: ["BTC"],
    });
    expect(args.tickers).toHaveLength(1);
    expect(args.tickers[0].enabled).toBe(true);
    expect(args.tickers[0].feedId).toHaveLength(32);
  });

  it("produces exactly seven enabled tickers", () => {
    const args = buildInitializeConfigArgs({
      oracleProvider: "mock",
      programId: PROGRAM_ID,
      publisher: PUBLISHER,
      demoScale: false,
    });
    expect(args.tickers).toHaveLength(TICKERS.length);
    for (const t of args.tickers) {
      expect(t.enabled).toBe(true);
      expect(t.symbol).toHaveLength(8);
      expect(t.feedId).toHaveLength(32);
    }
  });
});
