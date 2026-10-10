import Link from "next/link";

const FACTS: ReadonlyArray<string> = [
  "Settles on the official 4 PM close",
  "Every contract pays exactly $1.00",
  "Your wallet, your funds",
];

/** Trust pills plus the closing CTA band (brand gradient rule); static markup, no client JS needed. */
export function TrustStrip() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="flex flex-wrap items-center justify-center gap-3">
        {FACTS.map((fact) => (
          <span
            key={fact}
            className="rounded-full border border-border bg-surface px-4 py-2 text-sm text-text-muted"
          >
            {fact}
          </span>
        ))}
      </div>
      <div className="relative mt-12 overflow-hidden rounded-2xl p-10 text-center brand-gradient-rule">
        <h2 className="text-2xl font-semibold text-on-brand sm:text-3xl">Ready to make your first call?</h2>
        <p className="mt-2 text-on-brand/80">Pick a ticker, pick a side, and watch the price move in real time.</p>
        <Link
          href="/markets"
          className="mt-6 inline-block rounded-md bg-midnight px-5 py-2.5 text-sm font-medium text-text hover:bg-midnight/80"
        >
          Browse markets
        </Link>
      </div>
    </section>
  );
}
