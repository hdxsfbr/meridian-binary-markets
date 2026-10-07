/**
 * Price provider interface (contracts/oracle-provider.md "Service side").
 * `MockPythProvider` (this wave) and a future `PythReceiverProvider` (Wave
 * 10) both implement this; the jobs (`morning`, `settle`, `publisher`) only
 * ever depend on this interface, never on a concrete implementation.
 */

import type { PublicKey } from "@solana/web3.js";
import type { MicroUsd, Ticker } from "@meridian/sdk";

export interface PublishResult {
  /** The on-chain account `settle_market` should read to resolve this ticker's price. */
  priceAccount: PublicKey;
  /** Unix seconds the price was published at. */
  publishTime: number;
}

export interface PriceProvider {
  /**
   * Fetches the latest close-relevant price and makes it readable on chain.
   * Returns the account to pass to `settle_market`. Must throw (and write
   * nothing) if a reliable price cannot be produced.
   */
  publish(ticker: Ticker): Promise<PublishResult>;

  /**
   * Morning read for the strike ladder; does not touch the chain. Must
   * throw if a reliable previous close cannot be produced.
   */
  previousClose(ticker: Ticker): Promise<MicroUsd>;
}
