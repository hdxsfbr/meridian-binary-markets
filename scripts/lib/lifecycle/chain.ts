/**
 * Thin Anchor client for `scripts/lifecycle.ts` (tasks.md T086), covering
 * every instruction the lifecycle needs that `scripts/lib/client.ts` and
 * `services/automation/src/chain.ts` don't already wrap: `mint_pair`,
 * `place_order`, `buy_no_market`, `sell_no_market`, `cancel_order`,
 * `redeem_winning`, `redeem_pair`, plus `create_market`/`create_book`/
 * `mock_write_price`/`settle_market` (reimplemented here rather than
 * imported from `services/automation/src/chain.ts` -- Wave 6 brief: this
 * script must not import from `services/automation`).
 *
 * Account lists below are transcribed directly from each instruction's
 * `#[derive(Accounts)]` struct in `programs/meridian/src/instructions/*.rs`
 * (field names and constraints, read at the start of this wave) -- not
 * guessed or inferred from the IDL's `accounts` ordering.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import AnchorLangCore from "@anchor-lang/core";
import {
  IDL,
  PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  bookPda,
  configPda,
  decodeBook,
  marketPda,
  mockPricePda,
  noMintPda,
  tickerSymbolBytes,
  tokenProgramForMint,
  usdcEscrowPda,
  vaultPda,
  yesEscrowPda,
  yesMintPda,
  type Book,
  type Ticker,
} from "@meridian/sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  getOrCreateAta,
} from "../client.js";

const { AnchorProvider, BN, Program, Wallet } = AnchorLangCore;

export interface MarketAccountDecoded {
  ticker: Ticker;
  strike: bigint;
  tradingDay: number;
  closeTs: number;
  state: "Open" | "Settled";
  outcome: "Unset" | "Yes" | "No";
  settlementPrice: bigint;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  book: PublicKey;
  bookCapacity: number;
  pairsOutstanding: bigint;
  /** Token program owning `yesMint`/`noMint` -- classic for a legacy market, Token-2022 for one `createMarket`/`addStrike` created (every market, going forward). Resolved from chain by `fetchMarket`, not stored on-chain. */
  yesNoTokenProgram: PublicKey;
}

export interface ConfigAccountDecoded {
  admin: PublicKey;
  usdcMint: PublicKey;
  defaultBookCapacity: number;
  oracleProvider: "MockPyth" | "PythReceiver";
  /** Only the first `publishersLen` slots of `Config.publishers` (the rest are padding). */
  publishers: PublicKey[];
}

function bnToBigint(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (v instanceof (BN as any)) return BigInt((v as InstanceType<typeof BN>).toString());
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`chain: cannot convert ${String(v)} to bigint`);
}

function tickerFromSymbolBytes(bytes: Uint8Array | number[]): Ticker {
  const arr = Uint8Array.from(bytes as Iterable<number>);
  let end = arr.length;
  while (end > 0 && arr[end - 1] === 0) end -= 1;
  return Buffer.from(arr.slice(0, end)).toString("ascii") as Ticker;
}

function isOpenStateVariant(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && "open" in (v as Record<string, unknown>));
}

function outcomeFromVariant(v: unknown): "Unset" | "Yes" | "No" {
  if (v && typeof v === "object") {
    if ("yes" in (v as Record<string, unknown>)) return "Yes";
    if ("no" in (v as Record<string, unknown>)) return "No";
  }
  return "Unset";
}

/**
 * `yesNoTokenProgram` is not stored on-chain (see `MarketAccountDecoded`'s
 * doc comment) -- the caller (`fetchMarket`) resolves it separately via an
 * RPC call and passes it in here, since this decoder has no connection.
 */
function decodeMarket(raw: Record<string, unknown>, yesNoTokenProgram: PublicKey): MarketAccountDecoded {
  return {
    ticker: tickerFromSymbolBytes(raw.ticker as number[]),
    strike: bnToBigint(raw.strike),
    tradingDay: Number(raw.tradingDay),
    closeTs: Number(bnToBigint(raw.closeTs)),
    state: isOpenStateVariant(raw.state) ? "Open" : "Settled",
    outcome: outcomeFromVariant(raw.outcome),
    settlementPrice: bnToBigint(raw.settlementPrice),
    yesMint: raw.yesMint as PublicKey,
    noMint: raw.noMint as PublicKey,
    vault: raw.vault as PublicKey,
    book: raw.book as PublicKey,
    bookCapacity: Number(raw.bookCapacity),
    pairsOutstanding: bnToBigint(raw.pairsOutstanding),
    yesNoTokenProgram,
  };
}

/** Classic Token program `MintTo` (instruction tag 7): used to fund demo users with test USDC. */
function mintToInstruction(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface RemainingAccount {
  pubkey: PublicKey;
  isWritable: boolean;
  isSigner: boolean;
}

/** `remaining_accounts` helper: a maker's receiving token account, read-write, non-signer. */
export function makerAccount(pubkey: PublicKey): RemainingAccount {
  return { pubkey, isWritable: true, isSigner: false };
}

export class LifecycleChain {
  readonly connection: Connection;
  readonly admin: Keypair;
  readonly publisher: Keypair;
  readonly usdcMint: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly program: any;

  /**
   * Delay inserted between consecutive on-chain steps (market creation, book
   * growth polling). 0 on localnet; `lifecycle.ts` sets it on devnet, where the
   * public RPC rate-limits bursts of the same call and web3.js's own retries
   * run out mid-ladder.
   */
  paceMs = 0;

  async pace(): Promise<void> {
    if (this.paceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.paceMs));
    }
  }

  constructor(connection: Connection, admin: Keypair, publisher: Keypair, usdcMint: PublicKey) {
    this.connection = connection;
    this.admin = admin;
    this.publisher = publisher;
    this.usdcMint = usdcMint;
    const wallet = new Wallet(admin);
    // `AnchorProvider.defaultOptions()` confirms at "processed", not "confirmed" (see
    // `init-config.ts`'s matching comment) -- every balance assertion in `lifecycle.ts`
    // reads back via the connection's own "confirmed" commitment immediately after a
    // `.rpc()` call returns, which races a "processed"-only confirm and can read stale
    // pre-transaction state. Pin both preflight and confirm to "confirmed" so `.rpc()`
    // itself only resolves once every subsequent read is guaranteed to see its effects.
    const provider = new AnchorProvider(connection, wallet, { preflightCommitment: "confirmed", commitment: "confirmed" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.program = new (Program as any)(IDL, provider);
  }

  marketAddress(ticker: Ticker, tradingDay: number, strike: bigint): PublicKey {
    return marketPda(PROGRAM_ID, ticker, tradingDay, strike)[0];
  }

  private marketAccounts(market: PublicKey) {
    const [yesMint] = yesMintPda(PROGRAM_ID, market);
    const [noMint] = noMintPda(PROGRAM_ID, market);
    const [vault] = vaultPda(PROGRAM_ID, market);
    const [usdcEscrow] = usdcEscrowPda(PROGRAM_ID, market);
    const [yesEscrow] = yesEscrowPda(PROGRAM_ID, market);
    const [config] = configPda(PROGRAM_ID);
    const [book] = bookPda(PROGRAM_ID, market);
    return { yesMint, noMint, vault, usdcEscrow, yesEscrow, config, book };
  }

  /**
   * `initialize_config`: creates the `Config` singleton. `args` is the same
   * shape `scripts/init-config.ts`'s `buildInitializeConfigArgs` returns
   * (reused directly by `scripts/lifecycle.ts`'s `ensureConfig` step rather
   * than re-derived here).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async initializeConfig(args: Record<string, unknown>, usdcMint: PublicKey): Promise<void> {
    const [config] = configPda(PROGRAM_ID);
    await this.program.methods
      .initializeConfig(args)
      .accountsStrict({
        payer: this.admin.publicKey,
        admin: this.admin.publicKey,
        config,
        usdcMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.admin])
      .rpc();
  }

  async fetchConfig(): Promise<ConfigAccountDecoded | null> {
    const [config] = configPda(PROGRAM_ID);
    const raw = await this.program.account.config.fetchNullable(config);
    if (!raw) return null;
    const providerKey =
      raw.oracleProvider && typeof raw.oracleProvider === "object"
        ? Object.keys(raw.oracleProvider as Record<string, unknown>)[0]
        : String(raw.oracleProvider);
    const oracleProvider = providerKey === "mockPyth" ? "MockPyth" : "PythReceiver";
    const publishersLen = Number(raw.publishersLen ?? 0);
    const publishers = (raw.publishers as PublicKey[]).slice(0, publishersLen);
    return {
      admin: raw.admin as PublicKey,
      usdcMint: raw.usdcMint as PublicKey,
      defaultBookCapacity: Number(raw.defaultBookCapacity),
      oracleProvider,
      publishers,
    };
  }

  /**
   * Which of `markets` already exist on chain, as one `getMultipleAccounts`
   * call per 100 addresses rather than one `getAccountInfo` each. Public
   * devnet RPC rate-limits bursts of the same call ("Too many requests for a
   * specific RPC call"), which made a 45-market freshness probe fail outright.
   */
  async marketsExist(markets: PublicKey[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let i = 0; i < markets.length; i += 100) {
      const infos = await this.connection.getMultipleAccountsInfo(markets.slice(i, i + 100), "confirmed");
      out.push(...infos.map((info) => info !== null));
    }
    return out;
  }

  async fetchMarket(market: PublicKey): Promise<MarketAccountDecoded | null> {
    const raw = await this.program.account.market.fetchNullable(market);
    if (!raw) return null;
    const yesNoTokenProgram = await tokenProgramForMint(this.connection, raw.yesMint as PublicKey);
    return decodeMarket(raw, yesNoTokenProgram);
  }

  async fetchBook(book: PublicKey): Promise<Book> {
    const info = await this.connection.getAccountInfo(book, "confirmed");
    if (!info) throw new Error(`fetchBook: no account at ${book.toBase58()}`);
    return decodeBook(info.data);
  }

  async getTokenBalance(ata: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(ata, "confirmed");
    if (!info) return 0n;
    const res = await this.connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(res.value.amount);
  }

  async createMarket(ticker: Ticker, strike: bigint, tradingDay: number, closeTs: number, capacity: number): Promise<PublicKey> {
    const market = this.marketAddress(ticker, tradingDay, strike);
    const accts = this.marketAccounts(market);
    await this.program.methods
      .createMarket(Array.from(tickerSymbolBytes(ticker)), new BN(strike.toString()), tradingDay, new BN(closeTs), capacity)
      .accountsStrict({
        payer: this.admin.publicKey,
        admin: this.admin.publicKey,
        config: accts.config,
        market,
        yesMint: accts.yesMint,
        noMint: accts.noMint,
        vault: accts.vault,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        usdcMint: this.usdcMint,
        // `createMarket` always creates Token-2022 Yes/No mints (every
        // market created from the migration on; see create_market.rs's
        // module doc) -- there is no existing mint to resolve a token
        // program from here.
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.admin])
      .rpc();
    return market;
  }

  /** `create_book`, repeated until `market.book` is set (demo-scale capacity 16 always finishes in one call). */
  async createBookUntilDone(market: PublicKey): Promise<PublicKey> {
    const [config] = configPda(PROGRAM_ID);
    const [book] = bookPda(PROGRAM_ID, market);
    for (let i = 0; i < 32; i += 1) {
      await this.pace();
      await this.program.methods
        .createBook()
        .accountsStrict({
          payer: this.admin.publicKey,
          admin: this.admin.publicKey,
          config,
          market,
          book,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.admin])
        .rpc();
      const fresh = await this.fetchMarket(market);
      if (fresh && fresh.book.toBase58() !== PublicKey.default.toBase58()) {
        return book;
      }
    }
    throw new Error(`createBookUntilDone: book for ${market.toBase58()} did not finish after 32 calls`);
  }

  async mockWritePrice(feedId: Uint8Array, price: bigint, conf: bigint, expo: number, publishTime: number): Promise<PublicKey> {
    const [config] = configPda(PROGRAM_ID);
    const [priceAccount] = mockPricePda(PROGRAM_ID, feedId);
    await this.program.methods
      .mockWritePrice(Array.from(feedId), new BN(price.toString()), new BN(conf.toString()), expo, new BN(publishTime))
      .accountsStrict({
        publisher: this.publisher.publicKey,
        config,
        price: priceAccount,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.publisher])
      .rpc();
    return priceAccount;
  }

  async settleMarket(market: PublicKey, priceAccount: PublicKey): Promise<void> {
    const [config] = configPda(PROGRAM_ID);
    await this.program.methods
      .settleMarket()
      .accountsStrict({ caller: this.admin.publicKey, config, market, priceAccount })
      .signers([this.admin])
      .rpc();
  }

  /** Funds `destination` (an existing USDC ATA) with `amountMicro` test USDC; admin must be the mint authority. */
  async fundUsdc(destination: PublicKey, amountMicro: bigint): Promise<void> {
    const tx = new Transaction().add(mintToInstruction(this.usdcMint, destination, this.admin.publicKey, amountMicro));
    tx.feePayer = this.admin.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(this.admin);
    const sig = await this.connection.sendRawTransaction(tx.serialize());
    const result = await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (result.value.err) {
      throw new Error(`fundUsdc: transaction ${sig} failed: ${JSON.stringify(result.value.err)}`);
    }
  }

  async usdcAta(owner: PublicKey): Promise<PublicKey> {
    return getOrCreateAta(this.connection, this.admin, this.usdcMint, owner);
  }

  /** Synchronous USDC ATA address derivation (no RPC) -- for makers whose ATA is already known to exist. */
  usdcAtaAddress(owner: PublicKey): PublicKey {
    return associatedTokenAddress(owner, this.usdcMint);
  }

  yesAtaAddress(owner: PublicKey, yesMint: PublicKey, tokenProgram: PublicKey): PublicKey {
    return associatedTokenAddress(owner, yesMint, tokenProgram);
  }

  noAtaAddress(owner: PublicKey, noMint: PublicKey, tokenProgram: PublicKey): PublicKey {
    return associatedTokenAddress(owner, noMint, tokenProgram);
  }

  /** `mint_pair(qty)`: USDC in, Yes+No out. */
  async mintPair(user: Keypair, market: PublicKey, m: MarketAccountDecoded, qty: bigint): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(user.publicKey);
    const userYes = this.yesAtaAddress(user.publicKey, m.yesMint, m.yesNoTokenProgram);
    const userNo = this.noAtaAddress(user.publicKey, m.noMint, m.yesNoTokenProgram);
    await this.program.methods
      .mintPair(new BN(qty.toString()))
      .accountsStrict({
        user: user.publicKey,
        config: accts.config,
        market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        vault: m.vault,
        userUsdc,
        userYes,
        userNo,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  /** `place_order(side, price, qty, tif)`: `side` 0=Bid 1=Ask, `tif` 0=Limit 1=IOC. */
  async placeOrder(
    user: Keypair,
    market: PublicKey,
    m: MarketAccountDecoded,
    side: 0 | 1,
    price: bigint,
    qty: bigint,
    tif: 0 | 1,
    remainingAccounts: RemainingAccount[] = [],
  ): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(user.publicKey);
    const userYes = this.yesAtaAddress(user.publicKey, m.yesMint, m.yesNoTokenProgram);
    await this.program.methods
      .placeOrder(side, new BN(price.toString()), new BN(qty.toString()), tif)
      .accountsStrict({
        user: user.publicKey,
        config: accts.config,
        market,
        book: m.book,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        userUsdc,
        yesMint: m.yesMint,
        userYes,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  /** `buy_no_market(qty, min_yes_price)`: mint qty pairs, IOC-sell the Yes leg into resting bids. */
  async buyNoMarket(
    user: Keypair,
    market: PublicKey,
    m: MarketAccountDecoded,
    qty: bigint,
    minYesPrice: bigint,
    remainingAccounts: RemainingAccount[],
  ): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(user.publicKey);
    const userYes = this.yesAtaAddress(user.publicKey, m.yesMint, m.yesNoTokenProgram);
    const userNo = this.noAtaAddress(user.publicKey, m.noMint, m.yesNoTokenProgram);
    await this.program.methods
      .buyNoMarket(new BN(qty.toString()), new BN(minYesPrice.toString()))
      .accountsStrict({
        user: user.publicKey,
        config: accts.config,
        market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        vault: m.vault,
        book: m.book,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        userUsdc,
        userYes,
        userNo,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  /** `sell_no_market(qty, max_yes_price)`: IOC-buy the Yes leg from resting asks, then redeem the filled pairs. */
  async sellNoMarket(
    user: Keypair,
    market: PublicKey,
    m: MarketAccountDecoded,
    qty: bigint,
    maxYesPrice: bigint,
    remainingAccounts: RemainingAccount[],
  ): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(user.publicKey);
    const userYes = this.yesAtaAddress(user.publicKey, m.yesMint, m.yesNoTokenProgram);
    const userNo = this.noAtaAddress(user.publicKey, m.noMint, m.yesNoTokenProgram);
    await this.program.methods
      .sellNoMarket(new BN(qty.toString()), new BN(maxYesPrice.toString()))
      .accountsStrict({
        user: user.publicKey,
        config: accts.config,
        market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        vault: m.vault,
        book: m.book,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        userUsdc,
        userYes,
        userNo,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  /** `cancel_order(order_id)`. */
  async cancelOrder(owner: Keypair, market: PublicKey, m: MarketAccountDecoded, orderId: bigint): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(owner.publicKey);
    const userYes = this.yesAtaAddress(owner.publicKey, m.yesMint, m.yesNoTokenProgram);
    await this.program.methods
      .cancelOrder(new BN(orderId.toString()))
      .accountsStrict({
        owner: owner.publicKey,
        market,
        book: m.book,
        usdcEscrow: accts.usdcEscrow,
        yesEscrow: accts.yesEscrow,
        yesMint: m.yesMint,
        userUsdc,
        userYes,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
      })
      .signers([owner])
      .rpc();
  }

  /** `redeem_winning(side, qty)`: `side` 1=Yes 2=No, must match the settled outcome. */
  async redeemWinning(
    user: Keypair,
    market: PublicKey,
    m: MarketAccountDecoded,
    side: 1 | 2,
    qty: bigint,
  ): Promise<void> {
    const winningMint = side === 1 ? m.yesMint : m.noMint;
    const userWinning = associatedTokenAddress(user.publicKey, winningMint, m.yesNoTokenProgram);
    await this.program.methods
      .redeemWinning(side, new BN(qty.toString()))
      .accountsStrict({
        user: user.publicKey,
        market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        vault: m.vault,
        userUsdc: await this.usdcAta(user.publicKey),
        userWinning,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
      })
      .signers([user])
      .rpc();
  }

  /** `redeem_pair(qty)`: Yes+No in, USDC out, in any market state. */
  async redeemPair(user: Keypair, market: PublicKey, m: MarketAccountDecoded, qty: bigint): Promise<void> {
    const accts = this.marketAccounts(market);
    const userUsdc = await this.usdcAta(user.publicKey);
    const userYes = this.yesAtaAddress(user.publicKey, m.yesMint, m.yesNoTokenProgram);
    const userNo = this.noAtaAddress(user.publicKey, m.noMint, m.yesNoTokenProgram);
    await this.program.methods
      .redeemPair(new BN(qty.toString()))
      .accountsStrict({
        user: user.publicKey,
        config: accts.config,
        market,
        yesMint: m.yesMint,
        noMint: m.noMint,
        vault: m.vault,
        userUsdc,
        userYes,
        userNo,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        yesnoTokenProgram: m.yesNoTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }
}
