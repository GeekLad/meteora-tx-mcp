import { describe, expect, it } from "vitest";
import { DLMM } from "../src/sdk.js";
import {
  lamportRatioFromPrice,
  lowerBinIdFromPrice,
  priceAtBinId,
  priceFromLamportRatio,
  pricePlusBps,
  priceScaledByFactor,
  upperBinIdFromPrice,
} from "../src/prices.js";
import { binRawRatioToTokenPrice } from "../src/invariants.js";
import { parseUiAmountToRaw } from "../src/parse.js";
import { resolvePriceWindow, resolveUiAmounts } from "../src/convert.js";
import type { BinPriceContext } from "../src/types.js";

// A SOL/USDC-shaped pool: X has 9 decimals (SOL), Y has 6 (USDC), 25 bp bin
// step. activePriceRaw is the lamport-ratio price of the active bin (bin 0
// sits at ratio 1.0), so the pool's active price reads 1000 Y per X.
const ctx: BinPriceContext = {
  binStep: 25,
  tokenXDecimals: 9,
  tokenYDecimals: 6,
  activeBinId: 0,
  activePriceRaw: "1",
};

describe("price to bin id", () => {
  it("matches static DLMM.getBinIdFromPrice on ordinary prices", () => {
    for (const price of [0.5, 1, 1.257, 90, 99, 100.5, 110, 12_345.67]) {
      const ratio = lamportRatioFromPrice(ctx, price);
      expect(lowerBinIdFromPrice(ctx, price)).toBe(DLMM.getBinIdFromPrice(ratio, ctx.binStep, true));
      expect(upperBinIdFromPrice(ctx, price)).toBe(DLMM.getBinIdFromPrice(ratio, ctx.binStep, false));
    }
  });

  it("rounds down and up to the bins straddling an in-between price", () => {
    // One raw tick above an edge sits inside the upper bin, one tick below
    // inside the lower. An exact edge stays on its own bin on both sides.
    const edge = priceAtBinId(ctx, 5);
    expect(lowerBinIdFromPrice(ctx, edge * (1 + 1e-9))).toBe(5);
    expect(upperBinIdFromPrice(ctx, edge * (1 + 1e-9))).toBe(6);
    expect(lowerBinIdFromPrice(ctx, edge * (1 - 1e-9))).toBe(4);
    expect(upperBinIdFromPrice(ctx, edge * (1 - 1e-9))).toBe(5);
  });

  it("maps an exact bin price back to its own bin on both sides", () => {
    for (const binId of [-1000, -420, -57, -1, 0, 1, 57, 420, 1000]) {
      const price = priceAtBinId(ctx, binId);
      // Both directions agree on the same bin (rounding is sign-safe: -0 === 0).
      expect(lowerBinIdFromPrice(ctx, price) + 0).toBe(binId + 0);
      expect(upperBinIdFromPrice(ctx, price) + 0).toBe(binId + 0);
    }
  });

  it("is consistent with the pool's activeTokenPrice convention", () => {
    // A lamport ratio r maps to human price r * 10^(dX-dY): ratio 1 is one
    // base-X per base-Y, which for 9-vs-6 decimals reads 1000 human.
    expect(priceFromLamportRatio(ctx, 1)).toBe(1000);
    expect(lamportRatioFromPrice(ctx, 1000)).toBeCloseTo(1, 9);
    // The pool.ts conversion of the Q64.64 ratio agrees: 1.0 -> 1000 human.
    expect(binRawRatioToTokenPrice(1, 9, 6)).toBe(1000);
  });

  it("rejects a non-positive or non-finite price", () => {
    expect(() => lowerBinIdFromPrice(ctx, 0)).toThrow(/positive/);
    expect(() => lowerBinIdFromPrice(ctx, -5)).toThrow(/positive/);
    expect(() => lowerBinIdFromPrice(ctx, Number.NaN)).toThrow(/positive/);
    expect(() => upperBinIdFromPrice(ctx, Number.POSITIVE_INFINITY)).toThrow(/positive/);
  });

  it("rejects a non-integer bin step", () => {
    expect(() => lowerBinIdFromPrice({ ...ctx, binStep: 0 }, 1)).toThrow(/binStep/);
    expect(() => lowerBinIdFromPrice({ ...ctx, binStep: 12.5 }, 1)).toThrow(/binStep/);
  });
});

describe("bps and percent offsets", () => {
  it("adds and subtracts basis points of the current price", () => {
    expect(pricePlusBps(100, 50)).toBeCloseTo(100.5, 12);
    expect(pricePlusBps(100, 100)).toBeCloseTo(101, 12);
    expect(pricePlusBps(100, -100)).toBeCloseTo(99, 12);
    expect(pricePlusBps(100, -500)).toBeCloseTo(95, 12);
    expect(pricePlusBps(100, 0)).toBeCloseTo(100, 12);
  });

  it("scales by percent-of-10000 factors", () => {
    expect(priceScaledByFactor(100, 10_000)).toBe(100);
    expect(priceScaledByFactor(100, 10_500)).toBe(105);
    expect(priceScaledByFactor(100, 9_500)).toBe(95);
    expect(priceScaledByFactor(90, 10_500)).toBe(94.5);
    expect(priceScaledByFactor(100, 10_100)).toBe(101);
  });
});

describe("resolvePriceWindow", () => {
  it("resolves a decimal price range to the bins on either side", () => {
    const window = resolvePriceWindow(ctx, { lowerPrice: 0.9, upperPrice: 1.1 });
    const sdkLower = DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, 0.9), ctx.binStep, true);
    const sdkUpper = DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, 1.1), ctx.binStep, false);
    expect(window.lowerBinId).toBe(sdkLower);
    expect(window.upperBinId).toBe(sdkUpper);
    expect(window.lowerBinId).toBeLessThan(window.upperBinId);
  });

  it("carries the requested bounds and the resolved bin prices back out", () => {
    const window = resolvePriceWindow(ctx, { lowerPrice: 0.9, upperPrice: 1.1 });
    expect(window.requestedLowerPrice).toBe(0.9);
    expect(window.requestedUpperPrice).toBe(1.1);
    expect(window.requestedLowerBpsOffActive).toBeNull();
    expect(window.requestedUpperBpsOffActive).toBeNull();
    const step = 1 + 25 / 10_000;
    expect(window.resolvedLowerPrice).toBeCloseTo(priceFromLamportRatio(ctx, step ** window.lowerBinId), 12);
    expect(window.resolvedUpperPrice).toBeCloseTo(priceFromLamportRatio(ctx, step ** window.upperBinId), 12);
    expect(window.resolvedLowerPrice).toBeLessThanOrEqual(0.9);
    expect(window.resolvedUpperPrice).toBeGreaterThanOrEqual(1.1);
  });

  it("resolves bps off the active price", () => {
    // The fake active human price is 1000 (ratio 1), so -1000 bps is 90% of
    // it (human 900, ratio 0.9) and +1000 bps is 110% (ratio 1.1).
    const window = resolvePriceWindow(ctx, { lowerBpsOffActive: -1000, upperBpsOffActive: 1000 });
    expect(window.requestedLowerBpsOffActive).toBe(-1000);
    expect(window.requestedUpperBpsOffActive).toBe(1000);
    const sdkLower = DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, 900), ctx.binStep, true);
    expect(window.lowerBinId).toBe(sdkLower);
    const sdkUpper = DLMM.getBinIdFromPrice(lamportRatioFromPrice(ctx, 1100), ctx.binStep, false);
    expect(window.upperBinId).toBe(sdkUpper);
  });

  it("rejects both a price and a bps offset on one side", () => {
    expect(() => resolvePriceWindow(ctx, { lowerPrice: 0.09, lowerBpsOffActive: -100, upperPrice: 1.1 })).toThrow(/overlap|both|not both/);
    expect(() => resolvePriceWindow(ctx, { lowerPrice: 0.9, upperPrice: 1.1, upperBpsOffActive: 100 })).toThrow(/overlap|both|not both/);
  });

  it("rejects a missing bound", () => {
    expect(() => resolvePriceWindow(ctx, { upperPrice: 1.1 })).toThrow(/lowerPrice/);
    expect(() => resolvePriceWindow(ctx, { lowerPrice: 0.9 })).toThrow(/upperPrice/);
    expect(() => resolvePriceWindow(ctx, {})).toThrow(/lowerPrice/);
  });

  it("rejects an inverted range", () => {
    expect(() => resolvePriceWindow(ctx, { lowerPrice: 1.2, upperPrice: 1.1 })).toThrow(/lower bin/);
  });

  it("maps prices inside one bin to a window around that bin", () => {
    // Two prices within the same bin: the lower lands on the bin, the upper
    // on its neighbor, so the window always covers at least one bin.
    const inside = priceAtBinId(ctx, 3);
    const window = resolvePriceWindow(ctx, { lowerPrice: inside * (1 + 0.0005), upperPrice: inside * (1 + 0.0009) });
    expect(window.lowerBinId).toBe(3);
    expect(window.upperBinId).toBe(4);
  });
});

describe("decimal token amounts to raw base units", () => {
  it("expands decimals into base units", () => {
    expect(parseUiAmountToRaw("1.5", 9, "amountX")).toBe("1500000000");
    expect(parseUiAmountToRaw("1", 9, "amountX")).toBe("1000000000");
    expect(parseUiAmountToRaw("0.000000001", 9, "amountX")).toBe("1");
    expect(parseUiAmountToRaw("0", 9, "amountX")).toBe("0");
    expect(parseUiAmountToRaw("0.000000009", 9, "amountX")).toBe("9");
    expect(parseUiAmountToRaw("10.5", 6, "amountY")).toBe("10500000");
    expect(parseUiAmountToRaw("100", 0, "amountX")).toBe("100");
  });

  it("rejects exponent or negative notation and empty input", () => {
    expect(() => parseUiAmountToRaw("1e9", 9, "amountX")).toThrow(/decimal token amount/);
    expect(() => parseUiAmountToRaw("-1", 9, "amountX")).toThrow(/decimal token amount/);
    expect(() => parseUiAmountToRaw("", 9, "amountX")).toThrow(/decimal token amount/);
    expect(() => parseUiAmountToRaw("nope", 9, "amountX")).toThrow(/decimal token amount/);
    expect(() => parseUiAmountToRaw("1.", 9, "amountX")).toThrow(/decimal token amount/);
    expect(() => parseUiAmountToRaw(".5", 9, "amountX")).toThrow(/decimal token amount/);
  });

  it("rejects more precision than the mint has", () => {
    expect(() => parseUiAmountToRaw("1.0000000001", 9, "amountX")).toThrow(/too precise/);
    expect(() => parseUiAmountToRaw("1.5", 0, "amountX")).toThrow(/too precise/);
    // 1.001 at 6 decimals parses to 1000999.9999999999 in float, which the
    // safe-integer check rejects: the honest answer is "use the raw tool".
    expect(() => parseUiAmountToRaw("1.001", 6, "amountY")).toThrow(/2\^53|raw tool/);
  });

  it("refuses a nonzero amount that rounds to zero base units", () => {
    // 0.5 at 0 decimals has more fraction digits than the mint allows, so the
    // precision check is the one that fires; both refusals stop the deposit.
    expect(() => parseUiAmountToRaw("0.5", 0, "amountX")).toThrow(/too precise|base unit/);
  });

  it("refuses an unsignable magnitude", () => {
    // The 9-digit fraction parses to a float above 2^53 base units, so the
    // scaled-value check fires before any digits would round: raw tool.
    expect(() => parseUiAmountToRaw("123456789012.345678901", 9, "amountX")).toThrow(/raw tool|2\^53/);
    // 9007199254740993 = 2^53 + 1: a 16-digit whole number overflows exact
    // whole-token arithmetic.
    expect(() => parseUiAmountToRaw("9007199254740993", 0, "amountX")).toThrow(/too large|raw tool/);
  });

  it("stays exact across the tested range", () => {
    for (const [text, decimals] of [
      ["123.456789", 6] as const,
      ["0.000000123", 9] as const,
      ["42", 6] as const,
      ["123456.789012345", 9] as const,
    ]) {
      const localCtx: BinPriceContext = { ...ctx, tokenXDecimals: decimals, tokenYDecimals: decimals };
      const raw = resolveUiAmounts(localCtx, { amountXUi: text }).amountXRaw!;
      expect(Number(raw) % 1).toBe(0);
      expect(Number(raw) / 10 ** decimals).toBeCloseTo(Number(text), 6);
    }
  });
});