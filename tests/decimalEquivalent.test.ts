// The decimal-input tools must reach the same bins and amounts as the _raw
// tools would when a caller does the conversion by hand. This suite runs
// both conversions on one pool snapshot and requires them to agree.
import { describe, expect, it } from "vitest";
import { lamportRatioFromPrice } from "../src/prices.js";
import { resolvePriceWindow, resolveUiAmounts } from "../src/convert.js";
import { DLMM } from "../src/sdk.js";
import type { BinPriceContext } from "../src/types.js";

// A SOL/USDC-shaped pool: X has 9 decimals (SOL), Y has 6 (USDC), 25 bp bin
// step, active bin 0, active lamport ratio 1 (human price 1000 Y per X).
const ctx: BinPriceContext = {
  binStep: 25,
  tokenXDecimals: 9,
  tokenYDecimals: 6,
  activeBinId: 0,
  activePriceRaw: "1",
};

describe("the decimal converters agree with what a raw caller computes", () => {
  it("picks the bin ids DLMM.getBinIdFromPrice returns for both bounds", () => {
    for (const [lower, upper] of [
      [900, 1100],
      [0.95, 1.05],
      [90, 110],
      [0.02, 0.04],
    ] as const) {
      const window = resolvePriceWindow(ctx, { lowerPrice: lower, upperPrice: upper });
      expect(window.lowerBinId).toBe(DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, lower), ctx.binStep, true));
      expect(window.upperBinId).toBe(DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, upper), ctx.binStep, false));
    }
  });

  it("maps a bps range to the same bins as the prices it describes", () => {
    // The fake active price is 1000 human, so ±500 bps spans 950..1050.
    const byBps = resolvePriceWindow(ctx, { lowerBpsOffActive: -500, upperBpsOffActive: 500 });
    const byPrice = resolvePriceWindow(ctx, { lowerPrice: 950, upperPrice: 1050 });
    expect(byBps.lowerBinId).toBe(byPrice.lowerBinId);
    expect(byBps.upperBinId).toBe(byPrice.upperBinId);
  });

  it("expands decimal amounts exactly on both tokens", () => {
    expect(resolveUiAmounts(ctx, { amountXUi: "2", amountYUi: "500" })).toEqual({
      amountXRaw: "2000000000",
      amountYRaw: "500000000",
    });
  });

  it("produces raw fields the builder regex accepts", () => {
    const amounts = resolveUiAmounts(ctx, { amountXUi: "0.75", amountYUi: "1234.5" });
    for (const raw of Object.values(amounts)) {
      expect(/^[0-9]+$/.test(raw!)).toBe(true);
    }
  });
});