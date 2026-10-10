/**
 * Pure helpers for `GET /api/token/[mint]` (the standard token metadata JSON a wallet
 * fetches via a Yes/No mint's on-chain `uri`, see `programs/meridian/src/instructions/
 * create_market.rs`'s `TOKEN_METADATA_BASE_URI`/`mint_metadata_uri`). Kept free of any
 * RPC/Next.js plumbing so the JSON shape is unit-testable as a pure function; the route
 * itself (`web/src/app/api/token/[mint]/route.ts`) only does the on-chain lookup and
 * HTTP wiring around this.
 */

/** The standard token metadata JSON shape (Metaplex/Phantom-compatible). */
export type TokenMetadataJson = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
};

/**
 * Pulls the ticker out of a Yes/No mint's on-chain `name` field, when `mint_name`
 * (`programs/meridian/src/instructions/create_market.rs`) kept it -- the leading token
 * before `"≥ $"` or `">= $"`. Returns `null` for the last-resort fallback form that
 * drops the ticker entirely (`">=$<strike> <Y|N> <ISO date>"`), since there is nothing to
 * recover there.
 */
export function deriveTickerFromMintName(name: string): string | null {
  const match = name.match(/^([A-Za-z]+)\s+(?:≥|>=)\s*\$/);
  return match ? match[1] : null;
}

/**
 * Builds the standard token metadata JSON body for a Yes/No mint, given its on-chain
 * `name`/`symbol` (from `parseTokenMetadataExtension`, `@meridian/sdk`) and the app's own
 * origin (so `image`/`external_url` are absolute, as the standard requires). `external_url`
 * points at the mint's trade page (`/trade/<ticker>`) when the ticker can be recovered from
 * `name`, else the home page.
 */
export function buildTokenMetadataJson(params: { name: string; symbol: string; origin: string }): TokenMetadataJson {
  const origin = params.origin.replace(/\/+$/, "");
  const ticker = deriveTickerFromMintName(params.name);
  return {
    name: params.name,
    symbol: params.symbol,
    description: `Meridian binary market token: ${params.name}. Pays $1.00 if the market settles on this side, otherwise $0.`,
    image: `${origin}/brand/token-logo.png`,
    external_url: ticker !== null ? `${origin}/trade/${ticker}` : `${origin}/`,
  };
}
