import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, ToastTimers, dismissToast, enqueueToast, visibleToasts, type ToastItem } from "./Toast";

function item(id: number, title = `toast ${id}`): ToastItem {
  return { id, title, tone: "info" };
}

describe("enqueueToast", () => {
  it("appends to the end of the queue, keeping arrival order", () => {
    const queue = enqueueToast(enqueueToast([], item(1)), item(2));
    expect(queue.map((t) => t.id)).toEqual([1, 2]);
  });

  it("does not mutate the input array", () => {
    const original = [item(1)];
    const result = enqueueToast(original, item(2));
    expect(original).toHaveLength(1);
    expect(result).toHaveLength(2);
  });
});

describe("dismissToast", () => {
  it("removes exactly the toast with the matching id", () => {
    const queue = [item(1), item(2), item(3)];
    expect(dismissToast(queue, 2).map((t) => t.id)).toEqual([1, 3]);
  });

  it("is a no-op when the id is not present", () => {
    const queue = [item(1)];
    expect(dismissToast(queue, 99)).toEqual(queue);
  });

  it("dismissing from the middle lets a later-queued toast become visible", () => {
    const queue = [item(1), item(2), item(3), item(4)];
    expect(visibleToasts(queue).map((t) => t.id)).toEqual([1, 2, 3]);
    const next = dismissToast(queue, 2);
    expect(visibleToasts(next).map((t) => t.id)).toEqual([1, 3, 4]);
  });
});

describe("visibleToasts", () => {
  it(`shows at most ${MAX_VISIBLE_TOASTS} toasts`, () => {
    const queue = [item(1), item(2), item(3), item(4), item(5)];
    expect(visibleToasts(queue)).toHaveLength(MAX_VISIBLE_TOASTS);
  });

  it("shows every toast when there are 3 or fewer", () => {
    const queue = [item(1), item(2)];
    expect(visibleToasts(queue)).toEqual(queue);
  });

  it("shows the oldest-queued toasts first (FIFO, not most-recent-first)", () => {
    const queue = [item(1), item(2), item(3), item(4)];
    expect(visibleToasts(queue).map((t) => t.id)).toEqual([1, 2, 3]);
  });
});

const TOAST_DURATION_MS = 6_000;

describe("ToastTimers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("four simultaneous toasts: a timer started for each of the first three fires on schedule, and a fourth promoted later (the provider's real behaviour -- it only calls `start` once a toast enters the visible slice) gets its own full duration from the moment it's promoted, not from when the other three were created", () => {
    const expired: number[] = [];
    const timers = new ToastTimers((id) => expired.push(id));

    // Toasts 1-3 become visible immediately (the full MAX_VISIBLE_TOASTS
    // slice); toast 4 is enqueued but stays hidden behind the stack, so the
    // provider never calls `start` for it yet.
    timers.start(1, TOAST_DURATION_MS);
    timers.start(2, TOAST_DURATION_MS);
    timers.start(3, TOAST_DURATION_MS);

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(expired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1, 2, 3]);

    // Toast 1 dismissing promotes toast 4 into view; the provider starts its
    // timer only now.
    timers.clear(1);
    timers.start(4, TOAST_DURATION_MS);

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(expired).toEqual([1, 2, 3]);

    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1, 2, 3, 4]);
  });

  it("paused-visible-stack: hovering a visible toast holds off its dismissal indefinitely, and it resumes counting down only the remaining time once the hover ends", () => {
    const expired: number[] = [];
    const timers = new ToastTimers((id) => expired.push(id));

    timers.start(1, TOAST_DURATION_MS);
    timers.start(2, TOAST_DURATION_MS);

    // Hover toast 1 shortly before it would have expired.
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1_000);
    timers.pause(1, "hover");

    // Toast 2 (never hovered) expires on schedule; toast 1 does not, even
    // once well past its original expiry.
    vi.advanceTimersByTime(5_000);
    expect(expired).toEqual([2]);

    // The hover ends: toast 1 gets exactly its remaining 1s, not a fresh
    // full duration and not an immediate expiry.
    timers.resume(1, "hover");
    vi.advanceTimersByTime(999);
    expect(expired).toEqual([2]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([2, 1]);
  });

  it("tracks hover and focus as separate pause reasons: leaving with the mouse while focus is still inside never resumes the timer", () => {
    const expired: number[] = [];
    const timers = new ToastTimers((id) => expired.push(id));

    timers.start(1, TOAST_DURATION_MS);
    timers.pause(1, "hover");
    timers.pause(1, "focus");

    // Mouse leaves, but a "Dismiss" button inside the toast still has focus.
    timers.resume(1, "hover");
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(expired).toEqual([]);

    // Focus leaves too: only now does the remaining time start counting down.
    timers.resume(1, "focus");
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("clearAll stops every pending timer (provider unmount) so none can fire afterward", () => {
    const expired: number[] = [];
    const timers = new ToastTimers((id) => expired.push(id));

    timers.start(1, TOAST_DURATION_MS);
    timers.start(2, TOAST_DURATION_MS);
    timers.clearAll();

    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(expired).toEqual([]);
    expect(timers.has(1)).toBe(false);
    expect(timers.has(2)).toBe(false);
  });
});
