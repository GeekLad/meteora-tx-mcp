import { ALT_ADDRESS, StrategyType } from "../src/sdk.js";
import { describe, expect, it } from "vitest";
import { DLMM_LOOKUP_TABLE, strategyTypeValue } from "../src/invariants.js";

describe("SDK pin", () => {
  it("uses the mainnet lookup table and strategy numbers from DLMM SDK 1.9.14", () => {
    expect(ALT_ADDRESS["mainnet-beta"]).toBe(DLMM_LOOKUP_TABLE);
    expect(StrategyType.Spot).toBe(strategyTypeValue("spot"));
    expect(StrategyType.Curve).toBe(strategyTypeValue("curve"));
    expect(StrategyType.BidAsk).toBe(strategyTypeValue("bidAsk"));
  });
});
