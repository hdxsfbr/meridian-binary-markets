/**
 * Chain client plumbing shared by the operational scripts: a `Connection`,
 * an Anchor `Program` built from the generated IDL (`@meridian/sdk`), a
 * `confirm` helper, and the handful of raw classic-SPL-Token instructions
 * the scripts need (mint creation, associated-token-account creation).
 *
 * There is no `@solana/spl-token` dependency in this package (Wave 5 brief:
 * no new dependencies), so the token-program instructions below are built
 * by hand against the classic Token program's well-known binary layout --
 * the same layout `@solana/spl-token` itself encodes, just inlined here.
 * `services/automation/src/chain.ts` takes the same "wrap the generated IDL
 * in a Program" approach for the Anchor side; mirrored below.
 */

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Commitment,
  type TransactionSignature,
} from "@solana/web3.js";
import AnchorLangCore from "@anchor-lang/core";
import { IDL, PROGRAM_ID } from "@meridian/sdk";

const { AnchorProvider, Program, Wallet } = AnchorLangCore;

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Byte size of a classic SPL Token `Mint` account. */
export const MINT_SPACE = 82;
/** Byte size of a classic SPL Token `Account` (token account). */
export const TOKEN_ACCOUNT_SPACE = 165;

/** The commitment level every script in this package confirms against. */
export const DEFAULT_COMMITMENT: Commitment = "confirmed";

export { PROGRAM_ID };

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, DEFAULT_COMMITMENT);
}

/** mainnet-beta's well-known genesis hash. Refused outright, regardless of `CLUSTER`. */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** devnet's well-known genesis hash. Required when `CLUSTER=devnet`. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Refuses to proceed if `connection` is pointed at the wrong cluster, checked
 * via its genesis hash rather than trusting `SOLANA_RPC_URL`'s hostname:
 * mainnet-beta's genesis hash is refused unconditionally (these scripts
 * never target mainnet, no matter what `CLUSTER` says), `CLUSTER=devnet`
 * additionally requires devnet's own genesis hash (catching an RPC URL that
 * silently points somewhere else), and `CLUSTER=localnet` accepts any
 * genesis hash that isn't mainnet's (a fresh `solana-test-validator --reset`
 * mints a new one every time). Call this once, before sending any
 * transaction.
 */
export async function assertGenesisHash(connection: Connection, cluster: "localnet" | "devnet"): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash === MAINNET_GENESIS_HASH) {
    throw new Error(
      `assertGenesisHash: refusing to proceed -- the RPC endpoint's genesis hash (${genesisHash}) is mainnet-beta's; these scripts never target mainnet`,
    );
  }
  if (cluster === "devnet" && genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `assertGenesisHash: refusing to proceed -- CLUSTER=devnet but the RPC endpoint's genesis hash is "${genesisHash}", expected devnet's "${DEVNET_GENESIS_HASH}"`,
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadProgram(connection: Connection, payer: Keypair): any {
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (Program as any)(IDL, provider);
}

/** Sends and confirms `signature`, throwing with the transaction logs on failure. */
export async function confirm(connection: Connection, signature: TransactionSignature): Promise<void> {
  const latest = await connection.getLatestBlockhash(DEFAULT_COMMITMENT);
  const result = await connection.confirmTransaction(
    { signature, ...latest },
    DEFAULT_COMMITMENT,
  );
  if (result.value.err) {
    throw new Error(`confirm: transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  }
}

async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<TransactionSignature> {
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(DEFAULT_COMMITMENT);
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    DEFAULT_COMMITMENT,
  );
  if (result.value.err) {
    throw new Error(`sendAndConfirm: transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}

/** Classic Token program `InitializeMint` (instruction tag 0). */
function initializeMintInstruction(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
  let offset = 0;
  data.writeUInt8(0, offset); // InitializeMint
  offset += 1;
  data.writeUInt8(decimals, offset);
  offset += 1;
  mintAuthority.toBuffer().copy(data, offset);
  offset += 32;
  data.writeUInt8(freezeAuthority ? 1 : 0, offset);
  offset += 1;
  (freezeAuthority ?? PublicKey.default).toBuffer().copy(data, offset);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      // Rent sysvar, required by classic InitializeMint.
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Classic Associated Token Account program `Create` (no instruction data). */
function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

/** Associated token account address for `owner`/`mint` (classic SPL Token program). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Creates a fresh 6-decimal SPL mint with `payer` as both account funder
 * and mint authority (unless `mintAuthority` is given). Used by
 * `init-config.ts` on localnet when no `USDC_MINT` is configured.
 */
export async function createTestMint(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  mintAuthority: PublicKey = payer.publicKey,
): Promise<PublicKey> {
  const mintKeypair = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SPACE);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: MINT_SPACE,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    initializeMintInstruction(mintKeypair.publicKey, decimals, mintAuthority, null),
  );
  await sendAndConfirm(connection, tx, [payer, mintKeypair]);
  return mintKeypair.publicKey;
}

/**
 * Returns the associated token account for `owner`/`mint`, creating it
 * (funded by `payer`) if it does not already exist.
 */
export async function getOrCreateAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = associatedTokenAddress(owner, mint);
  const info = await connection.getAccountInfo(ata, DEFAULT_COMMITMENT);
  if (info !== null) {
    return ata;
  }
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint),
  );
  await sendAndConfirm(connection, tx, [payer]);
  return ata;
}

/**
 * Reads a classic SPL `Mint` account's `decimals` field (byte offset 44 in
 * the 82-byte layout: 36-byte `COption<Pubkey>` mint authority, 8-byte
 * `u64` supply, then 1-byte decimals). Throws if the account does not
 * exist or is not `MINT_SPACE` bytes.
 */
export async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint, DEFAULT_COMMITMENT);
  if (info === null) {
    throw new Error(`getMintDecimals: no account found at ${mint.toBase58()}`);
  }
  if (info.data.length !== MINT_SPACE) {
    throw new Error(
      `getMintDecimals: account ${mint.toBase58()} is ${info.data.length} bytes, expected ${MINT_SPACE} (not an SPL mint)`,
    );
  }
  return info.data.readUInt8(44);
}

/** Reads a JSON IDL file off disk, for diagnostics only. */
export function readIdlFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
