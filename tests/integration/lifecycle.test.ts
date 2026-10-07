/**
 * Integration test for `scripts/lifecycle.ts` (tasks.md T087): runs the
 * full create -> mint -> trade -> settle -> redeem lifecycle against a
 * local validator the Makefile's `test-integration` target has already
 * started/deployed/initialized, and asserts the PRD §7 multi-user scenario
 * ("one user mints and quotes, another takes, and both redeem" -- exactly
 * steps 5-9 of the lifecycle script) via the report `runLifecycle` returns.
 *
 * Imports `scripts/lifecycle.ts`'s `runLifecycle` directly (a dynamic
 * `import()`, since this package is CommonJS and `scripts/lifecycle.ts` is
 * an ESM module) rather than shelling out to it, so this test sees the
 * same typed report object the CLI prints from.
 */

import { expect } from "chai";

describe("lifecycle integration (PRD §7: mint, quote, take, redeem)", function () {
  this.timeout(600_000);

  it("runs end to end and settles the multi-user scenario correctly", async function () {
    if (process.env.CLUSTER !== "localnet") {
      this.skip();
    }

    const closeInSeconds = process.env.LIFECYCLE_CLOSE_IN ? Number(process.env.LIFECYCLE_CLOSE_IN) : 45;
    const tickers = process.env.LIFECYCLE_TICKERS
      ? (process.env.LIFECYCLE_TICKERS.split(",") as Array<"AAPL" | "MSFT" | "GOOGL" | "AMZN" | "NVDA" | "META" | "TSLA">)
      : undefined;

    // A non-literal specifier keeps `tsc` (this package's CommonJS config) from statically
    // resolving and type-checking `scripts/lifecycle.ts` (an ESM module using subpath
    // imports/`import.meta` that only its own, differently-configured tsconfig understands);
    // the dynamic `import()` itself works at runtime regardless (Node loads ESM from CJS
    // via `import()` natively).
    const lifecycleModulePath = "../../scripts/lifecycle.js";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycleModule: any = await import(lifecycleModulePath);
    const report = await lifecycleModule.runLifecycle({ closeInSeconds, tickers });

    // Every market created this run settled.
    expect(report.markets.length).to.be.greaterThan(0);
    for (const m of report.markets) {
      expect(m.state).to.equal("Settled");
      expect(m.outcome).to.not.equal("Unset");
    }

    // The traded (ATM, first-ticker) market resolved Yes, per the fixed
    // "price = strike + $5" publish step.
    expect(report.tradedMarket.outcome).to.equal("Yes");

    // PRD §7: "one user mints and quotes [A], another takes [B], and both
    // redeem" -- both ended up with exactly the hand-computed P&L
    // (trading-math.ts: maker +1.00 USDC, taker -1.00 USDC, zero-sum).
    const pnlMaker = report.userA.finalUsdcMicro - report.userA.initialUsdcMicro;
    const pnlTaker = report.userB.finalUsdcMicro - report.userB.initialUsdcMicro;
    expect(pnlMaker.toString()).to.equal("1000000");
    expect(pnlTaker.toString()).to.equal("-1000000");
    expect((pnlMaker + pnlTaker).toString()).to.equal("0");

    // The traded market's vault is fully drained once both winners redeemed.
    expect(report.vaultFinalMicro.toString()).to.equal("0");

    // The report carries the program id / config PDA / market addresses
    // the brief's step 10 requires printing.
    expect(report.programId).to.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(report.configAddress).to.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(report.reportText).to.be.a("string").with.length.greaterThan(0);
  });
});
