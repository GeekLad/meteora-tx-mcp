// The human-input tool handlers resolve decimal token amounts and decimal or
// bps-relative prices into the raw inputs the underlying action builders
// take, then call those builders. This module owns the resolution so both
// the handlers and the tests see one implementation.
import { TxBuildError } from "./errors.js";
import { parseUiAmountToRaw } from "./parse.js";
import { lowerBinIdFromPrice, priceAtBinId, pricePlusBps, priceFromLamportRatio, upperBinIdFromPrice } from "./prices.js";
import type { BinPriceContext } from "./types.js";

export interface AmountsUi {
  amountXUi?: string;
  amountYUi?: string;
}

export interface PriceWindowUi {
  lowerPrice?: number;
  upperPrice?: number;
  lowerBpsOffActive?: number;
  upperBpsOffActive?: number;
}

export interface PriceWindowResolved {
  lowerBinId: number;
  upperBinId: number;
  requestedLowerPrice: number | null;
  requestedUpperPrice: number | null;
  requestedLowerBpsOffActive: number | null;
  requestedUpperBpsOffActive: number | null;
  /** Exact token-X-in-token-Y price of the resolved bin. */
  resolvedLowerPrice: number;
  resolvedUpperPrice: number;
}

/**
 * The active price as a human token-X-in-token-Y decimal, from snapshot
 * state. `activePriceRaw` is the price-per-lamport ratio the SDK reports for
 * the active bin, the same quantity `priceAtBinId` produces.
 */
export function activePriceUi(ctx: BinPriceContext): number {
  return priceAtBinId(ctx, ctx.activeBinId);
}

/** Turn human token amounts into the raw base-unit strings, keyed by field. */
export function resolveUiAmounts(
  ctx: BinPriceContext,
  amounts: AmountsUi,
): { amountXRaw?: string; amountYRaw?: string } {
  const out: { amountXRaw?: string; amountYRaw?: string } = {};
  if (amounts.amountXUi !== undefined) {
    out.amountXRaw = parseUiAmountToRaw(amounts.amountXUi, ctx.tokenXDecimals, "amountX");
  }
  if (amounts.amountYUi !== undefined) {
    out.amountYRaw = parseUiAmountToRaw(amounts.amountYUi, ctx.tokenYDecimals, "amountY");
  }
  return out;
}

function boundPrice(
  ctx: BinPriceContext,
  side: "lower" | "upper",
  price: number | undefined,
  bpsOffActive: number | undefined,
): number {
  if (price !== undefined && bpsOffActive !== undefined) {
    throw new TxBuildError(`Pass ${side}Price or ${side}BpsOffActive, not both.`);
  }
  if (price !== undefined) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new TxBuildError(`${side}Price must be a positive finite number, got ${String(price)}`);
    }
    return price;
  }
  if (bpsOffActive !== undefined) {
    if (!Number.isFinite(bpsOffActive)) {
      throw new TxBuildError(`${side}BpsOffActive must be a finite number, got ${String(bpsOffActive)}`);
    }
    // The offset anchors on this snapshot's active bin price, the exact
    // number priceAtBinId reports for activeBinId in the same snapshot.
    return pricePlusBps(priceAtBinId(ctx, ctx.activeBinId), bpsOffActive);
  }
  throw new TxBuildError(
    side === "lower" ? "Pass lowerPrice or lowerBpsOffActive" : "Pass upperPrice or upperBpsOffActive",
  );
}

/**
 * Both window bounds at once. The lower bound rounds down to the nearest bin
 * at or below its price and the upper bound rounds up to the nearest bin at
 * or above its price, so a range never falls short of what was asked for.
 */
export function resolvePriceWindow(ctx: BinPriceContext, bounds: PriceWindowUi): PriceWindowResolved {
  const lower = lowerBinIdFromPrice(ctx, boundPrice(ctx, "lower", bounds.lowerPrice, bounds.lowerBpsOffActive));
  const upper = upperBinIdFromPrice(ctx, boundPrice(ctx, "upper", bounds.upperPrice, bounds.upperBpsOffActive));
  if (lower > upper) {
    throw new TxBuildError(
      `The requested price range puts the lower bin at ${lower} and the upper at ${upper}. Give a lowerPrice below the upperPrice.`,
    );
  }
  return {
    lowerBinId: lower,
    upperBinId: upper,
    requestedLowerPrice: bounds.lowerPrice ?? null,
    requestedUpperPrice: bounds.upperPrice ?? null,
    requestedLowerBpsOffActive: bounds.lowerBpsOffActive ?? null,
    requestedUpperBpsOffActive: bounds.upperBpsOffActive ?? null,
    resolvedLowerPrice: priceAtBinId(ctx, lower),
    resolvedUpperPrice: priceAtBinId(ctx, upper),
  };
}