"use client";

/**
 * Transaction confirmation feedback (Andre's complaint: after placing a
 * market order nothing confirms success; you only find out on Portfolio).
 * A lightweight toast stack: `ToastProvider` mounts once in `layout.tsx`
 * above every page; `useToast()` gives any component a `notify()` call.
 *
 * The queue/dismiss logic below (`enqueueToast`/`dismissToast`/
 * `visibleToasts`) and the timer bookkeeping (`ToastTimers`) are pure and
 * unit-tested in `Toast.test.ts` (no DOM renderer is wired into this
 * package's Vitest config, so the timer *scheduling* -- when a dismiss
 * fires, what a pause/resume/promotion does to it -- is tested directly
 * against `ToastTimers` with fake timers, independent of React); the
 * component below wraps that engine with real `setTimeout`s, hover/focus
 * handlers, and the actual markup.
 */

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "success" | "error" | "info";

export type ToastInput = {
  title: string;
  detail?: string;
  href?: string;
  linkLabel?: string;
  tone: ToastTone;
};

export type ToastItem = ToastInput & { id: number };

/** At most this many toasts are ever shown at once; the rest wait their turn as older ones dismiss. */
export const MAX_VISIBLE_TOASTS = 3;

/** How long a toast stays up before auto-dismissing, absent any hover/focus pause. */
export const TOAST_DURATION_MS = 6_000;

/** Pure: appends one toast to the queue. */
export function enqueueToast(items: readonly ToastItem[], toast: ToastItem): ToastItem[] {
  return [...items, toast];
}

/** Pure: removes one toast by id, wherever it sits in the queue. */
export function dismissToast(items: readonly ToastItem[], id: number): ToastItem[] {
  return items.filter((item) => item.id !== id);
}

/** Pure: the slice of the queue that is actually shown right now. */
export function visibleToasts(items: readonly ToastItem[]): ToastItem[] {
  return items.slice(0, MAX_VISIBLE_TOASTS);
}

type ToastContextValue = {
  notify: (input: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/** `notify({ title, detail?, href?, linkLabel?, tone })` -- throws outside a `ToastProvider`. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === undefined) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

const TONE_BORDER: Record<ToastTone, string> = {
  success: "border-success/50",
  error: "border-no/50",
  info: "border-border",
};

const TONE_DOT: Record<ToastTone, string> = {
  success: "bg-success",
  error: "bg-no",
  info: "bg-indigo",
};

/** Why a toast's dismiss timer is currently held off: the pointer is over it, or focus is inside it. Tracked separately so one leaving doesn't resume a timer the other is still holding. */
export type PauseReason = "hover" | "focus";

type TimerRecord = {
  timeoutId: ReturnType<typeof setTimeout> | null;
  expiresAt: number;
  remainingMs: number;
  pauseReasons: Set<PauseReason>;
};

/**
 * Pure (no React) scheduling engine for toast dismiss timers, injected with
 * an `onExpire` callback and (for tests) a clock. A timer is only ever
 * created by an explicit `start` call -- the provider calls that exactly
 * once per toast, the moment it *first becomes visible* (not when it's
 * enqueued), so a toast waiting behind a full stack never burns down its
 * duration unseen, and a toast promoted into the visible stack later always
 * gets its own full `TOAST_DURATION_MS`, counted from that moment.
 *
 * `pause`/`resume` take a `PauseReason` and track a *set* of active reasons
 * per id: a toast paused by both hover and keyboard focus only actually
 * resumes once neither reason is active, so a mouse leaving while focus is
 * still inside (e.g. tabbing to "Dismiss" then moving the mouse away) can
 * never silently resume a timer under a focused control.
 */
export class ToastTimers {
  private readonly timers = new Map<number, TimerRecord>();

  constructor(
    private readonly onExpire: (id: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts (or restarts) `id`'s timer for the full `durationMs`, clearing any reasons it was previously paused for. */
  start(id: number, durationMs: number): void {
    this.clearTimeoutOnly(id);
    const timeoutId = setTimeout(() => this.expire(id), durationMs);
    this.timers.set(id, {
      timeoutId,
      expiresAt: this.now() + durationMs,
      remainingMs: durationMs,
      pauseReasons: new Set(),
    });
  }

  /** Marks `id` paused for `reason`; stops its running timer (if any) and remembers the time left. */
  pause(id: number, reason: PauseReason): void {
    const timer = this.timers.get(id);
    if (timer === undefined) {
      return;
    }
    timer.pauseReasons.add(reason);
    if (timer.timeoutId !== null) {
      clearTimeout(timer.timeoutId);
      timer.remainingMs = Math.max(0, timer.expiresAt - this.now());
      timer.timeoutId = null;
    }
  }

  /** Clears `id`'s pause for `reason`; only actually restarts the timer once no reason remains. */
  resume(id: number, reason: PauseReason): void {
    const timer = this.timers.get(id);
    if (timer === undefined) {
      return;
    }
    timer.pauseReasons.delete(reason);
    if (timer.pauseReasons.size > 0 || timer.timeoutId !== null) {
      return;
    }
    const timeoutId = setTimeout(() => this.expire(id), timer.remainingMs);
    timer.timeoutId = timeoutId;
    timer.expiresAt = this.now() + timer.remainingMs;
  }

  /** Stops and forgets `id`'s timer entirely (the toast was dismissed). */
  clear(id: number): void {
    this.clearTimeoutOnly(id);
    this.timers.delete(id);
  }

  /** Stops and forgets every timer (provider unmount). */
  clearAll(): void {
    for (const id of [...this.timers.keys()]) {
      this.clearTimeoutOnly(id);
    }
    this.timers.clear();
  }

  /** True if `id` currently has a tracked timer (started and not yet cleared). */
  has(id: number): boolean {
    return this.timers.has(id);
  }

  private expire(id: number): void {
    this.timers.delete(id);
    this.onExpire(id);
  }

  private clearTimeoutOnly(id: number): void {
    const timer = this.timers.get(id);
    if (timer?.timeoutId !== null && timer?.timeoutId !== undefined) {
      clearTimeout(timer.timeoutId);
    }
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const nextIdRef = useRef(0);
  const shownIdsRef = useRef<Set<number>>(new Set());

  const dismiss = useCallback((id: number) => {
    timersRef.current?.clear(id);
    setItems((prev) => dismissToast(prev, id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timersRef = useRef<ToastTimers | null>(null);
  if (timersRef.current === null) {
    timersRef.current = new ToastTimers((id) => dismiss(id));
  }

  // Starts a fresh, full-duration timer the moment a toast first enters the
  // visible (top `MAX_VISIBLE_TOASTS`) slice -- never at enqueue time, so a
  // toast waiting behind a full stack isn't silently burning down a timer
  // nobody can see, and a toast promoted into view later (an older one
  // dismissed) gets its own full `TOAST_DURATION_MS` from that moment.
  useEffect(() => {
    const shown = visibleToasts(items);
    for (const item of shown) {
      if (!shownIdsRef.current.has(item.id)) {
        timersRef.current?.start(item.id, TOAST_DURATION_MS);
      }
    }
    shownIdsRef.current = new Set(shown.map((item) => item.id));
  }, [items]);

  // Provider unmount: every pending timeout is cleared so none can fire
  // `dismiss` -> `setItems` after this component is gone.
  useEffect(() => {
    return () => {
      timersRef.current?.clearAll();
    };
  }, []);

  const pause = useCallback((id: number, reason: PauseReason) => {
    timersRef.current?.pause(id, reason);
  }, []);

  const resume = useCallback((id: number, reason: PauseReason) => {
    timersRef.current?.resume(id, reason);
  }, []);

  const notify = useCallback((input: ToastInput) => {
    nextIdRef.current += 1;
    const id = nextIdRef.current;
    setItems((prev) => enqueueToast(prev, { ...input, id }));
    setAnnouncement(input.detail !== undefined ? `${input.title}: ${input.detail}` : input.title);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);
  const shown = visibleToasts(items);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
       * A single persistent, initially-empty live region, separate from the
       * visual toast stack below: screen readers reliably announce text
       * changes inside an already-mounted live region, but not the initial
       * content of a region inserted fresh (the mistake the three visible
       * toast `div`s made before -- each one was its own live region, born
       * already containing its message). Only the message text goes here,
       * never the Dismiss/"View in Portfolio" controls, so a screen reader
       * announces what happened, not a list of buttons.
       */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end sm:px-0">
        {shown.map((item) => (
          <div
            key={item.id}
            onMouseEnter={() => pause(item.id, "hover")}
            onMouseLeave={() => resume(item.id, "hover")}
            onFocus={() => pause(item.id, "focus")}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                resume(item.id, "focus");
              }
            }}
            className={`pointer-events-auto flex w-full max-w-[380px] items-start gap-3 rounded-md border bg-surface p-3 text-text shadow-lg transition-opacity duration-200 ${TONE_BORDER[item.tone]}`}
          >
            <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{item.title}</p>
              {item.detail !== undefined ? <p className="mt-0.5 text-text-muted">{item.detail}</p> : null}
              {item.href !== undefined ? (
                <Link href={item.href} className="mt-1 inline-block text-cyan underline">
                  {item.linkLabel ?? item.href}
                </Link>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(item.id)}
              className="shrink-0 rounded-sm px-1 text-text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
