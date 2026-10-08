/**
 * Turns a Hermes `GET /v2/updates/price/latest?parsed=true` body into the
 * micro-USD prices the web app displays, keyed by feed id (lowercase hex,
 * no `0x`). Pure, so `app/api/prices/route.ts` stays a thin proxy and this
 * can be unit-tested.
 */

export type DisplayPrice = { priceMicro: string; publishTime: number };

type HermesParsed = { id: string; price: { price: string; expo: number; publish_time: number } };

export function scaleToMicroUsd(price: bigint, expo: number): bigint {
  const shift = expo + 6;
  return shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
}

export function hermesToDisplayPrices(body: unknown): Record<string, DisplayPrice> {
  const out: Record<string, DisplayPrice> = {};
  const parsed = (body as { parsed?: HermesParsed[] } | null)?.parsed;
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item.id !== "string" || !item.price) continue;
    const id = item.id.toLowerCase().replace(/^0x/, "");
    out[id] = {
      priceMicro: scaleToMicroUsd(BigInt(item.price.price), Number(item.price.expo)).toString(),
      publishTime: Number(item.price.publish_time),
    };
  }
  return out;
}
