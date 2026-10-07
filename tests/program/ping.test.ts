import { fromWorkspace, LiteSVMProvider } from "anchor-litesvm";
import { Program, type Idl } from "@coral-xyz/anchor";
import { expect } from "chai";
import { loadIdl } from "@meridian/sdk";

describe("ping (Wave 0 toolchain gate)", () => {
  it("builds, loads the compiled program into LiteSVM, and the ping instruction succeeds", async () => {
    const litesvm = fromWorkspace("..");
    const provider = new LiteSVMProvider(litesvm);
    const idl = loadIdl() as unknown as Idl;
    const program = new Program(idl, provider);

    // A successful signature means the `ping` instruction executed without
    // error inside LiteSVM, i.e. the Rust -> .so -> IDL -> TS pipeline works.
    const signature = await program.methods.ping().rpc();
    expect(signature).to.be.a("string").with.length.greaterThan(0);
  });
});
