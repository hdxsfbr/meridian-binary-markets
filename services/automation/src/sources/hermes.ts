/**
 * Hermes client for Pyth price updates (research.md R4/R5, tasks.md T089).
 *
 * `GET {baseUrl}/v2/updates/price/latest?ids[]=<feedIdHex>&encoding=base64&parsed=true`
 * with `Authorization: Bearer <apiKey>`. Returns the raw accumulator update bytes
 * (decoded from the `binary.data[0]` base64 string) alongside the parsed price fields,
 * so the caller (`PythReceiverProvider`) can both post the update on chain and read the
 * price without a second round trip.
 *
 * Auth/entitlement failures (401/403/429) are never retried in a loop here: per the
 * "probe vs changelog" rule, a 403 means the key isn't entitled to this feed yet (read
 * the pricing/entitlement page), not a transient fault to hammer. The caller gets a
 * typed `HermesError` carrying the status and the raw response body so a probe script
 * can print exactly what Hermes said.
 */

const FETCH_TIMEOUT_MS = 5_000;

/** Typed error for Hermes HTTP failures, carrying the status and raw response text. */
export class HermesError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Hermes returned HTTP ${status}: ${body}`);
    this.name = "HermesError";
    this.status = status;
    this.body = body;
  }
}

/** Reminder printed (not thrown) alongside 401/403/429 -- see this module's doc comment. */
export const ENTITLEMENT_REMINDER =
  "Hermes auth/entitlement error: check the Pyth pricing/entitlement page for this feed " +
  "before retrying; this client does not retry 401/403/429 in a loop.";

export interface HermesParsedPrice {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}

export interface HermesUpdate {
  /** Base64-decoded accumulator update bytes, suitable for posting to the receiver program. */
  binary: Uint8Array;
  parsed: HermesParsedPrice;
}

export interface FetchHermesOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

interface HermesPriceField {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesParsedEntry {
  id: string;
  price: HermesPriceField;
}

interface HermesResponseBody {
  binary?: { encoding?: string; data?: string[] };
  parsed?: HermesParsedEntry[];
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/**
 * Runs `fetchImpl` and reads the full response body as text, both against a single 5s
 * deadline that aborts the request if it trips.
 *
 * Fix #5: the deadline (and the `AbortController` backing it) stays active through
 * body consumption, not just until headers arrive -- `response.text()` is raced
 * against the *same* still-pending deadline promise as the `fetchImpl` call, so a
 * server that sends headers promptly but then stalls the body indefinitely still gets
 * cut off at 5s total, rather than hanging settlement forever.
 */
async function fetchTextWithDeadline(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  let timeoutId!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`hermes: request timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), deadline]);
    const text = await Promise.race([response.text(), deadline]);
    return { status: response.status, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestAndParse(url: string, apiKey: string, fetchImpl: typeof fetch): Promise<HermesUpdate> {
  const { status, text } = await fetchTextWithDeadline(url, { headers: { Authorization: `Bearer ${apiKey}` } }, fetchImpl);

  if (status === 401 || status === 403 || status === 429) {
    // eslint-disable-next-line no-console
    console.error(ENTITLEMENT_REMINDER);
    throw new HermesError(status, text);
  }

  if (status !== 200) {
    throw new HermesError(status, text);
  }

  let body: HermesResponseBody;
  try {
    body = JSON.parse(text) as HermesResponseBody;
  } catch (err) {
    throw new Error(`hermes: response is not valid JSON: ${(err as Error).message}`);
  }

  const binaryEntry = body.binary?.data?.[0];
  if (!binaryEntry) {
    throw new Error("hermes: response is missing binary.data[0]");
  }
  const parsedEntry = body.parsed?.[0];
  if (!parsedEntry) {
    throw new Error("hermes: response is missing parsed[0]");
  }

  return {
    binary: base64ToBytes(binaryEntry),
    parsed: {
      price: BigInt(parsedEntry.price.price),
      conf: BigInt(parsedEntry.price.conf),
      expo: parsedEntry.price.expo,
      publishTime: parsedEntry.price.publish_time,
    },
  };
}

/**
 * Fetches the latest Hermes update for `feedIdHex` (a 64-character hex string, no `0x`
 * prefix). Throws `HermesError` on a non-200 response (401/403/429 logged with the
 * entitlement reminder first), or a plain `Error` on a malformed body.
 */
export async function fetchLatestUpdate(feedIdHex: string, opts: FetchHermesOptions): Promise<HermesUpdate> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedIdHex)}&encoding=base64&parsed=true`;
  return requestAndParse(url, opts.apiKey, fetchImpl);
}

/**
 * Fetches the Hermes update for `feedIdHex` closest to (at or after) `unixTs` -- used by
 * `PythReceiverProvider.previousClose` to read the previous trading day's close.
 */
export async function fetchHistoricalUpdate(
  feedIdHex: string,
  unixTs: number,
  opts: FetchHermesOptions,
): Promise<HermesUpdate> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl}/v2/updates/price/${unixTs}?ids[]=${encodeURIComponent(feedIdHex)}&encoding=base64&parsed=true`;
  return requestAndParse(url, opts.apiKey, fetchImpl);
}
