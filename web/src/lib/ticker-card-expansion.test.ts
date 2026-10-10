import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCardExpanded, setCardExpanded } from "./ticker-card-expansion";

/** Minimal `Storage` stand-in: vitest's default (node) environment has no `window`/`sessionStorage`. */
function fakeSessionStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe("ticker-card-expansion", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { sessionStorage: fakeSessionStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts collapsed for a ticker with no stored state", () => {
    expect(isCardExpanded("AAPL")).toBe(false);
  });

  it("remembers an expanded card and keeps tickers independent", () => {
    setCardExpanded("AAPL", true);
    expect(isCardExpanded("AAPL")).toBe(true);
    expect(isCardExpanded("MSFT")).toBe(false);
  });

  it("forgets a card collapsed again", () => {
    setCardExpanded("AAPL", true);
    setCardExpanded("AAPL", false);
    expect(isCardExpanded("AAPL")).toBe(false);
  });

  it("degrades to collapsed, without throwing, when window.sessionStorage itself throws", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("SecurityError: sessionStorage is blocked");
      },
    });

    expect(() => setCardExpanded("AAPL", true)).not.toThrow();
    expect(isCardExpanded("AAPL")).toBe(false);
  });

  it("is a no-op, without throwing, when there is no window at all (SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(() => setCardExpanded("AAPL", true)).not.toThrow();
    expect(isCardExpanded("AAPL")).toBe(false);
  });
});
