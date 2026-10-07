use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod math;
pub mod state;

declare_id!("8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia");

// Wave 0 skeleton: proves the Rust + Anchor + Agave toolchain builds and runs
// end to end before any product code is written. `ping` is replaced once
// `initialize_config` lands (tasks.md T018).
#[program]
pub mod meridian {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("pong");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
