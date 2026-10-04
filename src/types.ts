import type { UnsignedTxPackage } from "./packageTx.js";

export interface TokenInfo {
  mint: string;
  decimals: number;
  isSol: boolean;
}

/** What the price-to-bin converters need from a pool snapshot. */
export interface BinPriceContext {
  binStep: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
  activeBinId: number;
  activePriceRaw: string;
}

export interface BuiltAction {
  action:
    | "open_position"
    | "add_liquidity"
    | "remove_liquidity"
    | "claim_fees"
    | "close_position"
    | "rebalance_position";
  summary: string;
  warnings: string[];
  pool: {
    address: string;
    binStep: number;
    activeBinId: number;
    activePriceRaw: string;
    activeTokenPrice: number;
    tokenX: TokenInfo;
    tokenY: TokenInfo;
  };
  positionAddresses: string[];
  binWindow: {
    requestedLowerBinId: number | null;
    requestedUpperBinId: number | null;
    lowerBinId: number | null;
    upperBinId: number | null;
    reanchored: boolean;
    /** Decimal token-X-in-token-Y prices the decimal tools were given. */
    requestedLowerPrice: number | null;
    requestedUpperPrice: number | null;
    requestedLowerBpsOffActive: number | null;
    requestedUpperBpsOffActive: number | null;
    /** The exact prices the resolved bin ids sit at. */
    resolvedLowerPrice: number | null;
    resolvedUpperPrice: number | null;
  };
  /** The decimal whole-token amounts the decimal tools were given. */
  requestedAmounts: {
    xUi: string | null;
    yUi: string | null;
  } | null;
  amounts: {
    xRaw: string;
    yRaw: string;
    xUi: string;
    yUi: string;
  } | null;
  slippage: { bps: number; sdkPercent: number } | null;
  /** SDK quote in SOL, not lamports. */
  rentSol: number | null;
  simulation: {
    xDepositedRaw: string;
    yDepositedRaw: string;
    xWithdrawnRaw: string;
    yWithdrawnRaw: string;
    depositsTokenX: boolean;
  } | null;
  package: UnsignedTxPackage;
}