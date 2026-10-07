//! `mock_write_price` (Wave 3B, T035).
//!
//! Upserts the `MockPriceUpdate` PDA for `feed_id`. Only usable when
//! `Config.oracle_provider == MockPyth`, and only by a signer in `Config.publishers`
//! (Principle IV). `feed_id` must belong to one of the config's *enabled* tickers, so a
//! stray or retired feed id can't be written and later read back by `settle_market`.

use anchor_lang::prelude::*;

use crate::errors::MeridianError;
use crate::state::config::Config;
use crate::state::mock_price::{MockPriceUpdate, SEED as MOCK_PRICE_SEED};

pub fn handle_mock_write_price(
    ctx: Context<MockWritePrice>,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;

    if config.oracle_provider != crate::state::config::OracleProvider::MockPyth {
        msg!("mock_write_price: provider is not MockPyth");
        return Err(error!(MeridianError::InvariantViolated));
    }

    if !config.is_publisher(&ctx.accounts.publisher.key()) {
        return Err(error!(MeridianError::PublisherNotAllowed));
    }

    // `feed_any`, not an `enabled`-filtered lookup: a disabled ticker's existing markets
    // must still be settleable, which means the automation service must still be able to
    // publish (and `settle_market` read back) that feed.
    if config.feed_any(&feed_id).is_none() {
        return Err(error!(MeridianError::OracleFeedMismatch));
    }

    let write_slot = Clock::get()?.slot;
    let bump = ctx.bumps.price;

    let account = &mut ctx.accounts.price;
    account.feed_id = feed_id;
    account.price = price;
    account.conf = conf;
    account.expo = expo;
    account.publish_time = publish_time;
    account.publisher = ctx.accounts.publisher.key();
    account.write_slot = write_slot;
    account.bump = bump;

    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct MockWritePrice<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,

    #[account(
        seeds = [crate::state::config::SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = publisher,
        space = 8 + MockPriceUpdate::INIT_SPACE,
        seeds = [MOCK_PRICE_SEED, feed_id.as_ref()],
        bump,
    )]
    pub price: Account<'info, MockPriceUpdate>,

    pub system_program: Program<'info, System>,
}
