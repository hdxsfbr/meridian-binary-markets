import { describe, expect, it } from "vitest";
import { parseProgramIdFromDeployOutput } from "../deploy.js";

describe("parseProgramIdFromDeployOutput", () => {
  it("parses modern anchor CLI output (\"Program Id:\")", () => {
    const output = [
      "Deploying cluster: http://127.0.0.1:8899",
      "Deploying program \"meridian\"...",
      "Program Id: 8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia",
      "Deploy success",
    ].join("\n");
    expect(parseProgramIdFromDeployOutput(output)).toBe("8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia");
  });

  it("is case-insensitive (\"Program ID:\")", () => {
    const output = "Program ID: 8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia\nDeploy success";
    expect(parseProgramIdFromDeployOutput(output)).toBe("8Xf2M9XCYadh2mM8cTSDvwFpMCr3EX3TbU35P3SPkEia");
  });

  it("throws when no program id line is present", () => {
    expect(() => parseProgramIdFromDeployOutput("Deploy success\n")).toThrow();
  });
});
