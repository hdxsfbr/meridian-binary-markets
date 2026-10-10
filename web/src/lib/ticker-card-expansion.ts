/**
 * Per-ticker-card expand/collapse state for the Markets page (REVAMP_PLAN.md
 * polish: "Markets cards collapse"). Each `TickerCard` shows only its
 * at-the-money strike row by default; expanding it to the full ladder is
 * remembered per ticker for the rest of the browser tab's session, so
 * navigating away and back (or a background re-render) doesn't collapse a
 * card the trader just opened.
 *
 * Wrapped the same way as `price-history.ts`: reading `window.sessionStorage`
 * itself can throw (SecurityError in some privacy modes), so every access is
 * try/catch guarded and falls back to "not expanded" rather than crashing the
 * card.
 */

const STORAGE_PREFIX = "meridian:ticker-card-expanded:";

function storageKey(ticker: string): string {
  return `${STORAGE_PREFIX}${ticker}`;
}

function trySessionStorage(): Storage | undefined {
  try {
    if (typeof window === "undefined") {
      return undefined;
    }
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Whether `ticker`'s card was last left expanded in this tab session. */
export function isCardExpanded(ticker: string): boolean {
  try {
    const storage = trySessionStorage();
    if (storage === undefined) {
      return false;
    }
    return storage.getItem(storageKey(ticker)) === "1";
  } catch {
    return false;
  }
}

/** Persists `ticker`'s card expand/collapse state for the rest of this tab session. */
export function setCardExpanded(ticker: string, expanded: boolean): void {
  try {
    const storage = trySessionStorage();
    if (storage === undefined) {
      return;
    }
    if (expanded) {
      storage.setItem(storageKey(ticker), "1");
    } else {
      storage.removeItem(storageKey(ticker));
    }
  } catch {
    // sessionStorage full/unavailable (private mode, quota); the card's own
    // in-memory React state still works for the rest of this page view.
  }
}
