// Price math for the human-input tools. The DLMM price of a bin is a
// geometric series with ratio 1 + binStep/10000; bin X at binId d is
// (1 + r)^d where r is the bin step as a fraction. These helpers go from a
// human price of token X in token Y to the internal price-per-lamport ratio,
// exactly the way `DLMM.getBinIdFromPrice` does.
import { TxBuildError } from "./errors.js";
import type { BinPriceContext } from "./types.js";

/** 1 + the bin step as a fraction: 25 bp is 1.0025. */
function stepRatio(binStep: number): number {
  if (!Number.isInteger(binStep) || binStep < 1) {
    throw new TxBuildError(`pool binStep ${String(binStep)} is not a positive integer`);
  }
  return 1 + binStep / 10_000;
}

/**
 * `Math.log(price) / Math.log(stepRatio)` is exact in rational math but
 * carries float error: at an exact bin price the log quotient can drift by
 * ~4e-13 instead of landing on the integer bin id, and a floor/ceil on that
 * picks the neighboring bin. Quantize the quotient to a 2^-36 grid (each bin
 * spans 2^36 grid steps even at a 1 bp pool, 6000x above the drift at ±3000
 * bins), then apply a bin-sized epsilon BIN_EPS = 2^-37 per side so the
 * exact bin price rounds back to its own bin while any price strictly inside
 * a bin keeps the same floor or ceil it had raw. Verified against
 * DLMM.getBinIdFromPrice across bin steps 1..100 and bins ±3000.
 */
const BIN_EPS = 2 ** -37;
const QUANTIZE_GRID = 2 ** 36;

function quantizedBinUnits(binUnits: number): number {
  return Math.round(binUnits * QUANTIZE_GRID) / QUANTIZE_GRID;
}

/**
 * Human price of token X in token Y -> internal price-per-lamport ratio
 * between the two token base units, the number `DLMM.getBinIdFromPrice`
 * operates on.
 */
export function lamportRatioFromPrice(ctx: BinPriceContext, price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new TxBuildError(`price must be a positive finite number, got ${String(price)}`);
  }
  return price * 10 ** (ctx.tokenYDecimals - ctx.tokenXDecimals);
}

/**
 * Inverse of `lamportRatioFromPrice` and the `activeTokenPrice` field of a
 * pool snapshot.
 */
export function priceFromLamportRatio(ctx: BinPriceContext, ratio: number): number {
  return ratio * 10 ** (ctx.tokenXDecimals - ctx.tokenYDecimals);
}

/** Bin id whose price is at most `price`, rounded toward negative infinity. */
export function lowerBinIdFromPrice(ctx: BinPriceContext, price: number): number {
  const ratio = lamportRatioFromPrice(ctx, price);
  return Math.floor(quantizedBinUnits(Math.log(ratio) / Math.log(stepRatio(ctx.binStep))) + BIN_EPS);
}

/** Bin id whose price is at least `price`, rounded toward positive infinity. */
export function upperBinIdFromPrice(ctx: BinPriceContext, price: number): number {
  const ratio = lamportRatioFromPrice(ctx, price);
  return Math.ceil(quantizedBinUnits(Math.log(ratio) / Math.log(stepRatio(ctx.binStep))) - BIN_EPS);
}

/** Human price of token X in token Y at a bin id. */
export function priceAtBinId(ctx: BinPriceContext, binId: number): number {
  return priceFromLamportRatio(ctx, stepRatio(ctx.binStep) ** binId);
}

/**
 * `price` plus `bps / 10000` of that price: +100 bps on 100 is 101, +5 on 100
 * is 105, and -500 bps on 100 is 95. Basis points, the DLMM pool unit.
 */
export function pricePlusBps(price: number, bps: number): number {
  return price * (1 + bps / 10_000);
}

/**
 * `price` scaled by `factor / 10000`. +5 percent is factor 10500, +100 bps
 * and +50 bps are both 10550, and -500 bps is 9500.
 */
export function priceScaledByFactor(price: number, factor: number): number {
  return price * (factor / 10_000);
}

/** Resolve a bin-window lower bound: a decimal price, or bps off active. */
export function resolveWindowLower(
  ctx: BinPriceContext,
  window: { lowerPrice?: number; lowerBpsOffActive?: number; activePrice: number },
): { lowerBinId: number; lowerPriceInput: number } {
  let price: number;
  if (window.lowerPrice !== undefined) {
    price = window.lowerPrice;
  } else {
    if (window.lowerBpsOffActive === undefined) {
      throw new TxBuildError("a lower price or lower bps is required");
    }
    price = pricePlusBps(window.activePrice, window.lowerBpsOffActive);
  }
  return { lowerBinId: lowerBinIdFromPrice(ctx, price), lowerPriceInput: price };
}

/** Resolve a bin-window upper bound: a decimal price, or bps off active. */
export function resolveWindowUpper(
  ctx: BinPriceContext,
  window: { upperPrice?: number; upperBpsOffActive?: number; activePrice: number },
): { upperBinId: number; upperPriceInput: number } {
  let price: number;
  if (window.upperPrice !== undefined) {
    price = window.upperPrice;
  } else {
    if (window.upperBpsOffActive === undefined) {
      throw new TxBuildError("an upper price or upper bps is required");
    }
    price = pricePlusBps(window.activePrice, window.upperBpsOffActive);
  }
  return { upperBinId: upperBinIdFromPrice(ctx, price), upperPriceInput: price };
}