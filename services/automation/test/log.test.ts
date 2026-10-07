import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, logError } from "../src/log";

describe("log / logError", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("log() serializes a bigint field as a decimal string and writes an ISO ts to stdout", () => {
    log({ job: "mint", step: "sent", ok: true, qty: 123_456_789_012_345n });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trimEnd());

    expect(parsed.qty).toBe("123456789012345");
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("logError() serializes a bigint field as a decimal string and writes an ISO ts to stderr", () => {
    logError({ job: "settle", step: "failed", ok: false, error: "boom", payout: 42n });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trimEnd());

    expect(parsed.payout).toBe("42");
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
