//! Shared Rust/litesvm test bootstrap for `programs/meridian/tests/*.rs` (Wave 2 review
//! follow-up, 2026-10-06: replaces the retired TypeScript `anchor-litesvm` harness --
//! see DECISIONS.md §7).
//!
//! `litesvm` 0.12.0 is a different crate generation from the TS harness's pinned
//! `litesvm` 0.8.0: its public API (`LiteSVM::airdrop`, `get_account`, ...) takes
//! `solana_address::Address`, not `anchor_lang::prelude::Pubkey`. The two are
//! byte-for-byte identical 32-byte addresses but, depending on which of anchor-lang's
//! `solana-v3`/`solana-v4` pubkey features resolve where in the dependency graph, are
//! not always provably the same Rust type to the compiler; `addr`/`pk` below convert
//! between them at the few call sites that need both (building raw `Instruction`s to
//! hand to litesvm, and reading `Address`-keyed accounts back out). Everything else
//! (PDA derivation, `meridian::accounts::*`/`instruction::*`) uses
//! `anchor_lang::prelude::Pubkey` throughout, matching the program's own code.

#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use litesvm::types::{FailedTransactionMetadata, TransactionResult};
use litesvm::LiteSVM;
use litesvm_token::CreateMint;
use solana_account::Account as SolanaAccount;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::account_meta::AccountMeta as SdkAccountMeta;
use solana_instruction::Instruction;
use solana_instruction::error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

use meridian::errors::MeridianError;
use meridian::state::book::{read_header, BookHeader};
use meridian::state::config::{OracleProvider, TickerInfo};
use meridian::state::market::{Market, MarketState, Outcome};

/// Anchor's custom program error codes start at 6000 (`anchor_lang::error::ERROR_CODE_OFFSET`);
/// `MeridianError` variants are plain fieldless enum members, so `as u32` gives the
/// variant's 0-based declaration order, matching the offset the `#[error_code]` macro
/// actually assigns on chain.
const ANCHOR_ERROR_CODE_OFFSET: u32 = 6000;

/// Converts an `anchor_lang`/program-side `Pubkey` to the `solana_address::Address`
/// litesvm's public API expects. See this module's doc comment.
pub fn addr(pk: Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

/// Converts a litesvm-side `Address` back to the program-side `Pubkey`.
pub fn pk(address: Address) -> Pubkey {
    Pubkey::new_from_array(address.to_bytes())
}

/// Test environment: one `LiteSVM` with the `meridian` program loaded, an admin/payer
/// keypair pair (both airdropped), and a 6-decimal test USDC mint minted by `admin`.
pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub payer: Keypair,
    pub usdc_mint: Pubkey,
}

impl Env {
    /// Boots a fresh `LiteSVM`, loads the built `meridian.so`, airdrops `admin`/`payer`,
    /// and creates a 6-decimal test USDC mint with `admin` as mint authority. Does
    /// *not* initialize `Config`; call `init_config`/`default_config_args` for that.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();

        let so_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/meridian.so");
        svm.add_program_from_file(addr(meridian::ID), so_path)
            .expect("failed to load target/deploy/meridian.so -- run `bash scripts/anchor-build.sh` first");

        let admin = Keypair::new();
        let payer = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).expect("airdrop admin");
        svm.airdrop(&payer.pubkey(), 10_000_000_000).expect("airdrop payer");

        let usdc_mint_address = CreateMint::new(&mut svm, &payer)
            .authority(&admin.pubkey())
            .decimals(6)
            .send()
            .expect("create test USDC mint");
        let usdc_mint = pk(usdc_mint_address);

        Self {
            svm,
            admin,
            payer,
            usdc_mint,
        }
    }

    /// Overwrites the clock sysvar's `unix_timestamp`, leaving slot/epoch fields
    /// unchanged.
    pub fn warp_to(&mut self, unix_ts: i64) {
        let current: Clock = self.svm.get_sysvar();
        let next = Clock {
            unix_timestamp: unix_ts,
            ..current
        };
        self.svm.set_sysvar::<Clock>(&next);
    }

    /// Current clock's `unix_timestamp`.
    pub fn now(&self) -> i64 {
        let clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp
    }

    /// Airdrops `lamports` to `pubkey`.
    pub fn airdrop(&mut self, pubkey: Pubkey, lamports: u64) {
        self.svm
            .airdrop(&addr(pubkey), lamports)
            .expect("airdrop failed");
    }

    /// Builds and sends one transaction containing `ixs`, signed by `signers`. The
    /// first signer pays fees.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
        // Repeated calls with byte-identical instructions (e.g. `create_book`, which
        // takes no args, called in a loop) would otherwise produce byte-identical
        // transactions -- same message, same blockhash -- which litesvm's own duplicate-
        // signature check rejects as `AlreadyProcessed` even though the account state
        // changed between calls. Expire the blockhash before every send so each
        // transaction gets a fresh one.
        self.svm.expire_blockhash();
        let payer_address = signers[0].pubkey();
        let blockhash = self.svm.latest_blockhash();
        let message = Message::new(ixs, Some(&payer_address));
        let tx = Transaction::new(signers, message, blockhash);
        self.svm.send_transaction(tx)
    }

    /// Fetches and Anchor-deserializes the account at `pubkey`.
    pub fn fetch<T: AccountDeserialize>(&self, pubkey: Pubkey) -> T {
        let account = self
            .svm
            .get_account(&addr(pubkey))
            .unwrap_or_else(|| panic!("account {pubkey} not found"));
        T::try_deserialize(&mut account.data.as_slice())
            .unwrap_or_else(|e| panic!("failed to deserialize account {pubkey}: {e:?}"))
    }

    /// Reads and validates the raw Book header at `pubkey` (see `state/book.rs`).
    pub fn read_book_header(&self, pubkey: Pubkey) -> BookHeader {
        let account = self
            .svm
            .get_account(&addr(pubkey))
            .unwrap_or_else(|| panic!("book account {pubkey} not found"));
        read_header(&account.data).expect("book header failed to validate")
    }

    /// The raw account data length at `pubkey`, or `None` if the account doesn't exist.
    pub fn account_data_len(&self, pubkey: Pubkey) -> Option<usize> {
        self.svm.get_account(&addr(pubkey)).map(|a| a.data.len())
    }

    /// The raw lamport balance at `pubkey`, or `None` if the account doesn't exist.
    pub fn balance(&self, pubkey: Pubkey) -> Option<u64> {
        self.svm.get_balance(&addr(pubkey))
    }

    /// `initialize_config`, defaulting args to `default_config_args(16)`. Returns the
    /// Config PDA.
    pub fn init_config(&mut self) -> Pubkey {
        self.init_config_with(default_config_args(self.admin.pubkey_pk(), 16))
            .expect("init_config should succeed");
        config_pda()
    }

    /// `initialize_config` with explicit args, so callers can assert on a rejection.
    pub fn init_config_with(&mut self, args: InitializeConfigArgs) -> TransactionResult {
        let config = config_pda();
        let accounts = meridian::accounts::InitializeConfig {
            payer: self.payer.pubkey_pk(),
            admin: self.admin.pubkey_pk(),
            config,
            usdc_mint: self.usdc_mint,
            system_program: anchor_lang::system_program::ID,
        };
        let data = meridian::instruction::InitializeConfig { args };
        let ix = build_ix(meridian::ID, accounts, data);
        let payer = self.payer.insecure_clone();
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&payer, &admin])
    }

    /// `update_config`, signed by `admin` (use `update_config_as` for a different
    /// signer).
    pub fn update_config(&mut self, args: UpdateConfigArgs) -> TransactionResult {
        let admin = self.admin.insecure_clone();
        self.update_config_as(&admin, args)
    }

    /// `update_config`, signed by an arbitrary keypair (for authorization-failure
    /// tests).
    pub fn update_config_as(&mut self, signer: &Keypair, args: UpdateConfigArgs) -> TransactionResult {
        let config = config_pda();
        let accounts = meridian::accounts::UpdateConfig {
            admin: pk(signer.pubkey()),
            config,
        };
        let data = meridian::instruction::UpdateConfig { args };
        let ix = build_ix(meridian::ID, accounts, data);
        let signer = signer.insecure_clone();
        self.send(&[ix], &[&signer])
    }

    /// Calls `create_market` (or `add_strike`), deriving every account via the PDA
    /// helpers below, then loops `create_book` until `Market.book` is set. Signed by
    /// `admin`/`payer`.
    pub fn create_market(&mut self, args: CreateMarketArgs) -> Result<CreateMarketResult, FailedTransactionMetadata> {
        let config = config_pda();
        let market = market_pda(&args.ticker, args.trading_day, args.strike);
        let yes_mint = derive_pda(&[b"yes_mint", market.as_ref()]);
        let no_mint = derive_pda(&[b"no_mint", market.as_ref()]);
        let vault = derive_pda(&[b"vault", market.as_ref()]);
        let usdc_escrow = derive_pda(&[b"escrow_usdc", market.as_ref()]);
        let yes_escrow = derive_pda(&[b"escrow_yes", market.as_ref()]);
        let book = derive_pda(&[b"book", market.as_ref()]);

        let accounts = meridian::accounts::CreateMarket {
            payer: self.payer.pubkey_pk(),
            admin: self.admin.pubkey_pk(),
            config,
            market,
            yes_mint,
            no_mint,
            vault,
            usdc_escrow,
            yes_escrow,
            usdc_mint: self.usdc_mint,
            token_program: anchor_spl::token_2022::ID,
            usdc_token_program: anchor_spl::token::ID,
            system_program: anchor_lang::system_program::ID,
            rent: anchor_lang::prelude::rent::ID,
        };
        let data: Vec<u8> = match args.method {
            CreateMarketMethod::CreateMarket => meridian::instruction::CreateMarket {
                ticker: args.ticker,
                strike: args.strike,
                trading_day: args.trading_day,
                close_ts: args.close_ts,
                capacity: args.capacity,
            }
            .data(),
            CreateMarketMethod::AddStrike => meridian::instruction::AddStrike {
                ticker: args.ticker,
                strike: args.strike,
                trading_day: args.trading_day,
                close_ts: args.close_ts,
                capacity: args.capacity,
            }
            .data(),
        };
        let ix = Instruction {
            program_id: addr(meridian::ID),
            accounts: to_sdk_metas(accounts.to_account_metas(None)),
            data,
        };
        let payer = self.payer.insecure_clone();
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&payer, &admin])?;

        // `create_book` is split out of `create_market`/`add_strike` -- see
        // `programs/meridian/src/instructions/create_book.rs`'s module doc comment.
        // Call it once per transaction until `market.book` is set.
        for _ in 0..8 {
            let m: Market = self.fetch(market);
            if m.book != Pubkey::default() {
                break;
            }
            self.create_book(market)?;
        }

        Ok(CreateMarketResult {
            market,
            yes_mint,
            no_mint,
            vault,
            usdc_escrow,
            yes_escrow,
            book,
        })
    }

    /// Calls `create_book()` once for `market`, signed by `admin`/`payer`.
    pub fn create_book(&mut self, market: Pubkey) -> TransactionResult {
        self.create_book_as(market, &self.admin.insecure_clone())
    }

    /// Calls `create_book()` once for `market`, signed by an arbitrary admin keypair
    /// (for authorization-failure tests).
    pub fn create_book_as(&mut self, market: Pubkey, admin_signer: &Keypair) -> TransactionResult {
        let config = config_pda();
        let book = derive_pda(&[b"book", market.as_ref()]);
        let accounts = meridian::accounts::CreateBook {
            payer: self.payer.pubkey_pk(),
            admin: pk(admin_signer.pubkey()),
            config,
            market,
            book,
            system_program: anchor_lang::system_program::ID,
        };
        let data = meridian::instruction::CreateBook;
        let ix = build_ix(meridian::ID, accounts, data);
        let payer = self.payer.insecure_clone();
        let admin_signer = admin_signer.insecure_clone();
        self.send(&[ix], &[&payer, &admin_signer])
    }

    /// Builds a "classic market" fixture by hand, mimicking pre-Token-2022-migration
    /// on-chain state, *without* ever calling the real `create_market` instruction
    /// (which, after the migration, only ever creates Token-2022 mints -- see
    /// `instructions/create_market.rs`'s module doc comment). Proves backward
    /// compatibility: every instruction touching Yes/No mints derives which token
    /// program owns them from the mint account's own `owner` at call time
    /// (`state::market::require_matching_token_program`), so a legacy market whose
    /// mints were never migrated must keep working unmodified.
    ///
    /// Yes/No mints are built via a real transaction (`litesvm_token::CreateMint`,
    /// classic Token by construction since this crate's `token-2022` feature is never
    /// enabled -- see `book/escrow.rs`'s `validate_maker_account` doc comment for why
    /// that feature can't be turned on here); they don't need to be PDAs, since every
    /// instruction only ever checks them via `address = market.yes_mint` equality,
    /// never their own `seeds`.
    ///
    /// `vault`/`usdc_escrow`/`yes_escrow`, the `Market` account itself, and the one
    /// field a real `create_market` would let `create_book` fill in (`market.book`)
    /// *do* need to sit at their real PDAs: `place_order`/`cancel_order`/`close.rs`
    /// constrain those three token accounts by `seeds`/`bump`, not just address
    /// equality, and `market` is the same story (every instruction's `market` field
    /// constrains `seeds`/`bump` against the account's own `ticker`/`trading_day`/
    /// `strike`). A PDA can't sign its own `system_program::create_account`, so these
    /// four are built as plain Rust structs/raw SPL byte layouts and injected directly
    /// via `LiteSVM::set_account` rather than through any instruction. `book`/
    /// `book_closed` are left at `Pubkey::default()`/`true` (no Book PDA for this
    /// fixture -- tests exercising it stick to the book-free paths: `mint_pair`,
    /// `redeem_pair`, `redeem_winning`, `close_market`), which also means `close_market`
    /// is immediately callable without a separate `close_book` call.
    pub fn create_classic_market_fixture(&mut self, args: CreateMarketArgs) -> CreateMarketResult {
        let seeds_owned = Market::seeds(&args.ticker, args.trading_day, args.strike);
        let seed_refs: Vec<&[u8]> = seeds_owned.iter().map(|s| s.as_slice()).collect();
        let (market, market_bump) = Pubkey::find_program_address(&seed_refs, &meridian::ID);
        let market_addr = addr(market);

        let payer = self.payer.insecure_clone();

        let yes_mint = pk(CreateMint::new(&mut self.svm, &payer)
            .authority(&market_addr)
            .decimals(6)
            .send()
            .expect("create classic yes_mint"));
        let no_mint = pk(CreateMint::new(&mut self.svm, &payer)
            .authority(&market_addr)
            .decimals(6)
            .send()
            .expect("create classic no_mint"));

        // `usdc_escrow`/`yes_escrow` are deliberately left nonexistent (system-owned, 0
        // lamports) rather than injected as live-but-empty token accounts: this
        // fixture's `book_closed: true`/`book: Pubkey::default()` claims "no book ever
        // existed for this market," and `close_market` treats a nonexistent escrow as
        // "already closed" (`lamports() == 0`) exactly like a real market whose
        // `close_book` already ran -- consistent with that claim, and sufficient for
        // this fixture's book-free test paths (`mint_pair`/`redeem_pair`/
        // `redeem_winning`/`close_market`, none of which touch the escrows).
        let (vault, vault_bump) = Pubkey::find_program_address(&[b"vault", market.as_ref()], &meridian::ID);
        let (usdc_escrow, _) = Pubkey::find_program_address(&[b"escrow_usdc", market.as_ref()], &meridian::ID);
        let (yes_escrow, _) = Pubkey::find_program_address(&[b"escrow_yes", market.as_ref()], &meridian::ID);
        self.inject_classic_token_account(vault, self.usdc_mint, market, 0);

        let market_struct = Market {
            ticker: args.ticker,
            strike: args.strike,
            trading_day: args.trading_day,
            close_ts: args.close_ts,
            state: MarketState::Open,
            outcome: Outcome::Unset,
            settlement_price: 0,
            settled_at: 0,
            settled_by_override: false,
            yes_mint,
            no_mint,
            vault,
            book: Pubkey::default(),
            book_closed: true,
            book_capacity: args.capacity,
            pairs_outstanding: 0,
            bump: market_bump,
            vault_bump,
        };
        let mut data = Vec::new();
        market_struct.try_serialize(&mut data).expect("serialize classic Market fixture");
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                market_addr,
                SolanaAccount {
                    lamports,
                    data,
                    owner: addr(meridian::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("inject classic Market fixture account");

        CreateMarketResult {
            market,
            yes_mint,
            no_mint,
            vault,
            usdc_escrow,
            yes_escrow,
            book: book_pda(market),
        }
    }

    /// Injects a raw classic-SPL-Token `Account` (165 bytes, owned by classic Token)
    /// directly into the LiteSVM accounts store at `address`, with the given
    /// `mint`/`owner` and `amount`, bypassing any instruction. Used by
    /// `create_classic_market_fixture` for `vault`/`usdc_escrow`/`yes_escrow`, which
    /// need to sit at real PDAs (seeds relative to `market`) that nothing except the
    /// system program could otherwise sign for.
    fn inject_classic_token_account(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        use anchor_lang::solana_program::program_pack::Pack;
        use anchor_spl::token::spl_token::state::{Account as SplTokenAccount, AccountState};

        let account = SplTokenAccount {
            mint: addr(mint),
            owner: addr(owner),
            amount,
            state: AccountState::Initialized,
            ..Default::default()
        };
        let mut data = vec![0u8; SplTokenAccount::LEN];
        account.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                addr(address),
                SolanaAccount {
                    lamports,
                    data,
                    owner: addr(anchor_spl::token::ID),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("inject classic token account fixture");
    }
}

/// Builds a raw `Instruction` from a typed Anchor `Accounts` struct and instruction-data
/// struct (`meridian::accounts::*` / `meridian::instruction::*`), converting account
/// pubkeys to the `Address` type litesvm/`solana_instruction` expect.
pub fn build_ix<A: ToAccountMetas, I: InstructionData>(program_id: Pubkey, accounts: A, data: I) -> Instruction {
    Instruction {
        program_id: addr(program_id),
        accounts: to_sdk_metas(accounts.to_account_metas(None)),
        data: data.data(),
    }
}

/// Builds a raw Token-2022 `TransferChecked` instruction (discriminant `12`, data
/// `[amount_le_u64, decimals]`) for moving a Yes/No token directly between two token
/// accounts outside of any `meridian` instruction (e.g. simulating a wallet-to-wallet
/// transfer in a test fixture).
///
/// Not built via `litesvm_token::Transfer`/`anchor_spl::token::transfer`: both go
/// through `spl_token_interface`'s client-side instruction builder, which calls
/// `check_program_account` and hard-rejects any program id other than classic Token's
/// own -- there is no way to point it at Token-2022 short of enabling
/// `litesvm-token`'s `token-2022` Cargo feature, which would flip that crate's *other*
/// helpers (`CreateMint`, `MintTo`, ...) over to Token-2022 too and break every USDC
/// (always-classic) call site that uses them. `spl_token_2022_interface::instruction::
/// transfer_checked`'s own builder calls the lenient `check_spl_token_program_account`
/// (accepts either program), so building the raw instruction by hand here sidesteps
/// the problem entirely.
pub fn yes_no_transfer_checked_ix(
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    authority: Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // TokenInstruction::TransferChecked discriminant
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(6u8); // Yes/No mints are always 6 decimals
    Instruction {
        program_id: addr(anchor_spl::token_2022::ID),
        accounts: vec![
            SdkAccountMeta { pubkey: addr(source), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(mint), is_signer: false, is_writable: false },
            SdkAccountMeta { pubkey: addr(destination), is_signer: false, is_writable: true },
            SdkAccountMeta { pubkey: addr(authority), is_signer: true, is_writable: false },
        ],
        data,
    }
}

fn to_sdk_metas(metas: Vec<anchor_lang::prelude::AccountMeta>) -> Vec<SdkAccountMeta> {
    metas
        .into_iter()
        .map(|m| SdkAccountMeta {
            pubkey: addr(m.pubkey),
            is_signer: m.is_signer,
            is_writable: m.is_writable,
        })
        .collect()
}

/// Small helper trait so call sites can write `keypair.pubkey_pk()` for the
/// `anchor_lang`-side `Pubkey`, instead of `pk(keypair.pubkey())` everywhere.
pub trait KeypairPubkeyExt {
    fn pubkey_pk(&self) -> Pubkey;
}

impl KeypairPubkeyExt for Keypair {
    fn pubkey_pk(&self) -> Pubkey {
        pk(self.pubkey())
    }
}

fn derive_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &meridian::ID).0
}

pub fn config_pda() -> Pubkey {
    derive_pda(&[meridian::state::config::SEED])
}

pub fn market_pda(ticker: &[u8; 8], trading_day: u32, strike: u64) -> Pubkey {
    derive_pda(&[
        meridian::state::market::SEED,
        ticker.as_ref(),
        &trading_day.to_le_bytes(),
        &strike.to_le_bytes(),
    ])
}

pub fn book_pda(market: Pubkey) -> Pubkey {
    derive_pda(&[b"book", market.as_ref()])
}

/// The seven tickers Meridian lists and their Pyth `Equity.US.<SYM>/USD` feed ids, copied
/// from `packages/sdk/src/types.ts`'s `FEED_IDS` (same order, same hex).
const TICKER_FEED_HEX: [(&str, &str); 7] = [
    ("AAPL", "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688"),
    ("AMZN", "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a"),
    ("GOOGL", "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6"),
    ("META", "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe"),
    ("MSFT", "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1"),
    ("NVDA", "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593"),
    ("TSLA", "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1"),
];

fn symbol_bytes(s: &str) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[..s.len()].copy_from_slice(s.as_bytes());
    out
}

fn hex_to_32(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64, "feed id hex must decode to exactly 32 bytes");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("feed id hex must be valid");
    }
    out
}

/// The seven `TickerInfo` entries built from `TICKER_FEED_HEX`, all `enabled`.
pub fn default_tickers() -> Vec<TickerInfo> {
    TICKER_FEED_HEX
        .iter()
        .map(|(sym, hex)| TickerInfo {
            symbol: symbol_bytes(sym),
            feed_id: hex_to_32(hex),
            enabled: true,
        })
        .collect()
}

pub use meridian::instructions::{InitializeConfigArgs, UpdateConfigArgs};

/// `InitializeConfigArgs` for a MockPyth config: `admin` is the sole publisher, the
/// seven tickers all enabled, and the thresholds from data-model.md / research.md (300s
/// staleness, 25 bps confidence, 60s publish offset, 3600s override delay).
pub fn default_config_args(admin: Pubkey, capacity: u16) -> InitializeConfigArgs {
    InitializeConfigArgs {
        oracle_provider: OracleProvider::MockPyth,
        oracle_program: meridian::ID,
        publishers: vec![admin],
        max_staleness_secs: 300,
        max_conf_bps: 25,
        min_publish_offset_secs: 60,
        override_delay_secs: 3600,
        tickers: default_tickers(),
        default_book_capacity: capacity,
    }
}

#[derive(Clone, Copy, Debug)]
pub enum CreateMarketMethod {
    CreateMarket,
    AddStrike,
}

#[derive(Clone, Debug)]
pub struct CreateMarketArgs {
    pub ticker: [u8; 8],
    pub strike: u64,
    pub trading_day: u32,
    pub close_ts: i64,
    pub capacity: u16,
    pub method: CreateMarketMethod,
}

impl CreateMarketArgs {
    pub fn new(ticker: &str, strike: u64, trading_day: u32, close_ts: i64, capacity: u16) -> Self {
        Self {
            ticker: symbol_bytes(ticker),
            strike,
            trading_day,
            close_ts,
            capacity,
            method: CreateMarketMethod::CreateMarket,
        }
    }

    pub fn as_add_strike(mut self) -> Self {
        self.method = CreateMarketMethod::AddStrike;
        self
    }
}

#[derive(Debug)]
pub struct CreateMarketResult {
    pub market: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub usdc_escrow: Pubkey,
    pub yes_escrow: Pubkey,
    pub book: Pubkey,
}

/// Extracts the Anchor custom error code (`6000 + variant index`) from a failed
/// transaction (or any other `Result` whose error type is `FailedTransactionMetadata`,
/// e.g. `Env::create_market`'s `Result<CreateMarketResult, _>`) and asserts it matches
/// `expected`.
pub fn assert_err<T: std::fmt::Debug>(result: &Result<T, FailedTransactionMetadata>, expected: MeridianError) {
    let expected_code = ANCHOR_ERROR_CODE_OFFSET + anchor_error_index(&expected);
    assert_anchor_err(result, expected_code);
}

/// Asserts a failed transaction's `InstructionError::Custom` code matches `expected_code`
/// exactly (for Anchor's own built-in error codes, e.g. `ConstraintHasOne` 2001,
/// `ConstraintSeeds` 2006, `AccountNotInitialized` 3012, as well as this program's own
/// `6000 + variant` codes).
pub fn assert_anchor_err<T: std::fmt::Debug>(result: &Result<T, FailedTransactionMetadata>, expected_code: u32) {
    match result {
        Err(FailedTransactionMetadata { err, meta }) => match err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
                assert_eq!(
                    *code, expected_code,
                    "unexpected error code: got {code}, want {expected_code}\nlogs:\n{}",
                    meta.logs.join("\n")
                );
            }
            other => panic!("expected InstructionError::Custom({expected_code}), got {other:?}"),
        },
        Ok(value) => panic!(
            "expected transaction to fail with Custom({expected_code}), but it succeeded: {value:?}"
        ),
    }
}

/// `MeridianError`'s 0-based declaration order (fieldless enum, so `as u32` is exactly
/// the discriminant `anchor_lang`'s `#[error_code]` macro assigns its code from).
fn anchor_error_index(e: &MeridianError) -> u32 {
    *e as u32
}
