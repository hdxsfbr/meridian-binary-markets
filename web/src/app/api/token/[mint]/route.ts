/**
 * `GET /api/token/[mint]` (also accepts `[mint].json`, since that's the literal `uri`
 * every Yes/No mint carries on chain -- see `programs/meridian/src/instructions/
 * create_market.rs`'s `TOKEN_METADATA_BASE_URI`/`mint_metadata_uri`): the standard token
 * metadata JSON a wallet fetches for `mint`'s logo/name/description.
 *
 * Looks `mint` up via the server-side RPC (`SOLANA_RPC_URL` if set -- a private RPC,
 * same convention as `services/automation`'s server env -- else the public
 * `NEXT_PUBLIC_RPC_URL` this app already bakes in at build time), confirms it is owned
 * by the Token-2022 program (a classic-Token mint has no on-mint metadata extension and
 * never reaches this route in practice, since `create_market` only ever writes this
 * `uri` into Token-2022 mints), and decodes its on-mint `TokenMetadata` TLV extension via
 * `@meridian/sdk`'s `parseTokenMetadataExtension` (no `@solana/spl-token` dependency in
 * this app -- see that function's module doc comment). The actual JSON shape is built by
 * the pure, unit-tested `buildTokenMetadataJson` (`@/lib/token-metadata`).
 *
 * Unknown mint, non-Token-2022 mint, or a Token-2022 mint with no `TokenMetadata`
 * extension all return a 404 JSON body -- there is nothing useful to serve a wallet in
 * any of those cases.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, parseTokenMetadataExtension } from "@meridian/sdk";
import { buildTokenMetadataJson } from "@/lib/token-metadata";

export const dynamic = "force-dynamic";

const RPC_ENDPOINT = process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

let cachedConnection: Connection | null = null;
function getServerConnection(): Connection {
  if (cachedConnection === null) {
    cachedConnection = new Connection(RPC_ENDPOINT, "confirmed");
  }
  return cachedConnection;
}

function notFound(error: string): Response {
  return Response.json({ error }, { status: 404 });
}

export async function GET(request: Request, { params }: { params: Promise<{ mint: string }> }): Promise<Response> {
  const { mint: rawMint } = await params;
  const mintStr = rawMint.endsWith(".json") ? rawMint.slice(0, -".json".length) : rawMint;

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return notFound("not a valid mint address");
  }

  const connection = getServerConnection();
  const account = await connection.getAccountInfo(mint, "confirmed");
  if (account === null) {
    return notFound("mint not found");
  }
  if (!account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return notFound("mint is not a Token-2022 mint");
  }

  const metadata = parseTokenMetadataExtension(account.data);
  if (metadata === null) {
    return notFound("mint has no on-chain token metadata");
  }

  const origin = new URL(request.url).origin;
  const body = buildTokenMetadataJson({ name: metadata.name, symbol: metadata.symbol, origin });

  return Response.json(body, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
