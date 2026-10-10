/**
 * "Remove from wallet" (Portfolio, settled losing positions): burns a
 * wallet's now-worthless losing-side tokens and closes the token account,
 * returning its rent to the wallet itself. Plain SPL Token instructions
 * (`Burn` then `CloseAccount`), not a `meridian` program instruction -- this
 * works the same way for a classic-Token market and a Token-2022 one, since
 * both programs share the same wire format for these two instructions (see
 * `programs/meridian/tests/common/mod.rs`'s `yes_no_transfer_checked_ix` for
 * the same reasoning applied to `TransferChecked`).
 *
 * This is the user-signed half of the mint-lifecycle story `reclaim_mint`
 * completes on the program side (DECISIONS.md §29): once every holder of a
 * losing mint has run this, that mint's supply is zero and
 * `services/automation/src/jobs/reclaim.ts` (or anyone, since `reclaim_mint`
 * is permissionless) can close it and return its rent to the admin.
 */

import { PublicKey, type Connection, type Transaction, type TransactionInstruction, type TransactionSignature } from "@solana/web3.js";
import { sendTx } from "./tx";

type SendFn = (tx: Transaction, connection: Connection) => Promise<TransactionSignature>;

/** `TokenInstruction::Burn`'s discriminant (byte 0), shared by classic SPL Token and Token-2022. */
const BURN_DISCRIMINANT = 8;
/** `TokenInstruction::CloseAccount`'s discriminant (byte 0), shared by classic SPL Token and Token-2022. */
const CLOSE_ACCOUNT_DISCRIMINANT = 9;

function burnInstruction(tokenProgram: PublicKey, tokenAccount: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  // DataView, not Buffer.writeBigUInt64LE: the browser Buffer polyfill lacks
  // the BigInt writers (the SDK avoids them for the same reason).
  const bytes = new Uint8Array(9);
  bytes[0] = BURN_DISCRIMINANT;
  new DataView(bytes.buffer).setBigUint64(1, amount, true);
  const data = Buffer.from(bytes);
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

function closeAccountInstruction(tokenProgram: PublicKey, tokenAccount: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return {
    programId: tokenProgram,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([CLOSE_ACCOUNT_DISCRIMINANT]),
  };
}

/**
 * Builds the burn + close-account instruction pair for removing `amount`
 * (base units, not whole contracts) of `mint` from `wallet`'s own
 * `tokenAccount`. Pure (no RPC calls) so callers/tests can inspect the
 * exact instructions before sending.
 */
export function buildRemoveFromWalletInstructions(
  wallet: PublicKey,
  mint: PublicKey,
  tokenAccount: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint,
): TransactionInstruction[] {
  return [
    burnInstruction(tokenProgram, tokenAccount, mint, wallet, amount),
    closeAccountInstruction(tokenProgram, tokenAccount, wallet, wallet),
  ];
}

/**
 * Burns `amount` of `mint` out of `tokenAccount` and closes it, rent back to
 * `wallet`. One wallet approval for both instructions together.
 */
export async function removeFromWallet(
  connection: Connection,
  sendTransaction: SendFn,
  wallet: PublicKey,
  mint: PublicKey,
  tokenAccount: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint,
): Promise<TransactionSignature> {
  const ixs = buildRemoveFromWalletInstructions(wallet, mint, tokenAccount, tokenProgram, amount);
  return sendTx(connection, sendTransaction, ixs, wallet);
}
