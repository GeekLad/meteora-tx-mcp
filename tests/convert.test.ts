import { describe, expect, it } from "vitest";
import { lamportRatioFromPrice } from "../src/prices.js";
import { resolvePriceWindow, resolveUiAmounts, type PriceWindowResolved } from "../src/convert.js";
import type { BinPriceContext } from "../src/types.js";

// A SOL/USDC-shaped pool: X has 9 decimals (SOL), Y has 6 (USDC), 25 bp bin
// step. activePriceRaw is the lamport-ratio price of active bin 0 (ratio
// 1.0), so the active price reads 1000 token Y per token X.
const binContext: BinPriceContext = {
  binStep: 25,
  tokenXDecimals: 9,
  tokenYDecimals: 6,
  activeBinId: 0,
  activePriceRaw: "1",
};

/** resolveUiAmounts against this pool's token decimals. */
function resolveAmounts(amountXUi?: string, amountYUi?: string) {
  return resolveUiAmounts(binContext, { amountXUi, amountYUi });
}

/** resolvePriceWindow against this pool. */
function resolveWindow(bounds: {
  lowerPrice?: number;
  upperPrice?: number;
  lowerBpsOffActive?: number;
  upperBpsOffActive?: number;
}): PriceWindowResolved {
  return resolvePriceWindow(binContext, bounds);
}

describe("open position decimal resolution", () => {
  it("builds the raw open input with a decimal price window around the active price", () => {
    const amounts = resolveAmounts("1.5", "100.5");
    expect(amounts.amountXRaw).toBe("1500000000");
    expect(amounts.amountYRaw).toBe("100500000");
    const window = resolveWindow({ lowerPrice: 900, upperPrice: 1100 });
    expect(window.lowerBinId).toBeLessThan(binContext.activeBinId);
    expect(window.upperBinId).toBeGreaterThan(binContext.activeBinId);
    expect(window.requestedLowerPrice).toBe(900);
  });

  it("builds the raw open input with a bps-off-active window", () => {
    const window = resolveWindow({ lowerBpsOffActive: -1000, upperBpsOffActive: 1000 });
    expect(window.requestedLowerBpsOffActive).toBe(-1000);
    expect(window.requestedUpperBpsOffActive).toBe(1000);
    // ±1000 bps on the active price spans the same bins the prices 900 and
    // 1100 name directly.
    const byPrice = resolveWindow({ lowerPrice: 900, upperPrice: 1100 });
    expect(window.lowerBinId).toBe(byPrice.lowerBinId);
    expect(window.upperBinId).toBe(byPrice.upperBinId);
  });

  it("reaches an active-anchored range through a zero upper bps offset", () => {
    const window = resolveWindow({ lowerBpsOffActive: -1200, upperBpsOffActive: 0 });
    expect(window.upperBinId + 0).toBe(binContext.activeBinId + 0);
  });

  it("carries the whole-token amounts into the echo", () => {
    expect(resolveAmounts("0.25", "9000")).toEqual({
      amountXRaw: "250000000",
      amountYRaw: "9000000000",
    });
  });

  it("echoes lamport-ratio equivalence for the active-price convention", () => {
    // Human 1000 maps back to lamport ratio 1 on a 9-vs-6 decimal pool.
    expect(lamportRatioFromPrice(binContext, 1000)).toBeCloseTo(1, 9);
  });
});

describe("add and remove decimal resolution", () => {
  it("resolves add amounts with the token decimals", () => {
    expect(resolveAmounts("0.01", "1")).toEqual({ amountXRaw: "10000000", amountYRaw: "1000000" });
  });

  it("keeps a percentage remove an exact bps", () => {
    for (const [percent, bps] of [
      [0, 0],
      [1, 100],
      [12.5, 1250],
      [50, 5000],
      [99.99, 9999],
      [100, 10_000],
    ] as const) {
      expect(Math.round(percent * 100)).toBe(bps);
    }
  });

  it("clamps a remove range to the bins the prices resolve to", () => {
    const window = resolveWindow({ lowerPrice: 900, upperPrice: 1100 });
    expect(window.lowerBinId).toBeLessThan(window.upperBinId);
  });
});

describe("rebalance decimal resolution", () => {
  it("converts top-up amounts and the new price window", () => {
    expect(resolveAmounts("2.5", "0.25")).toEqual({
      amountXRaw: "2500000000",
      amountYRaw: "250000",
    });
    const window = resolveWindow({ lowerBpsOffActive: -1000, upperBpsOffActive: 1000 });
    expect(window.lowerBinId).toBeLessThan(binContext.activeBinId);
    expect(window.upperBinId).toBeGreaterThan(binContext.activeBinId);
  });

  it("maps a zero top-up to the raw zero strings", () => {
    expect(resolveAmounts("0", "0")).toEqual({ amountXRaw: "0", amountYRaw: "0" });
  });

  it("keeps withdraw percentages an exact bps", () => {
    expect(Math.round(100 * 100)).toBe(10_000);
    expect(Math.round(0 * 100)).toBe(0);
    expect(Math.round(12.34 * 100)).toBe(1234);
  });
});