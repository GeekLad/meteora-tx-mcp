// Construction rules pinned by the live bot's DLMM tests. The strategy the
// caller asks for is a parameter; these rules are how a transaction is built.
import { TransactionInstruction } from "@solana/web3.js";
import { TxBuildError } from "./errors.js";

export const SLICE_MAX_BINS = 70;
export const MAX_RESIZE_LENGTH = 91;
/** With the mainnet address lookup table the SDK allows 5 length increases. */
export const MAX_RESIZE_INSTRUCTIONS_WITH_ALT = 5;
/** 70 + 91 * 5. Wider requests become additional position accounts. */
export const MAX_BINS_PER_EXTENDED_POSITION =
  SLICE_MAX_BINS + MAX_RESIZE_LENGTH * MAX_RESIZE_INSTRUCTIONS_WITH_ALT;
/** On-chain PositionV2 maximum. */
export const ABSOLUTE_MAX_BINS = 1400;
/** 1400 bins split into 525-bin positions is 21 deposit transactions. */
export const MAX_TRANSACTIONS = 24;

export const WIDE_COMPUTE_UNIT_LIMIT = 1_400_000;
export const SIMPLE_COMPUTE_UNIT_LIMIT = 400_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 200_000;
export const MAX_PRIORITY_FEE_MICRO_LAMPORTS = 5_000_000;
export const DEFAULT_SLIPPAGE_BPS = 1500;

/** Mainnet DLMM address lookup table. Wide instructions exceed 1232 bytes without it. */
export const DLMM_LOOKUP_TABLE = "JA5F83HUK9L78Y12TRLCsJZbu3Tv8pCK1GfK8mVNp1sz";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Anchor discriminators for the instructions the open path has to rewrite. */
export const OPEN_IX_DISC = {
  initPosition2: Buffer.from([143, 19, 242, 145, 213, 15, 104, 115]),
  increasePositionLength2: Buffer.from([255, 210, 204, 71, 115, 137, 225, 113]),
  initBinArray: Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]),
  initBinArrayBitmap: Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]),
};

export type StrategyName = "spot" | "curve" | "bidAsk";

export function strategyTypeValue(name: StrategyName): 0 | 1 | 2 {
  if (name === "curve") return 1;
  if (name === "bidAsk") return 2;
  return 0;
}

/**
 * SDK `slippagePercentage` is a percent (15 means 15%), not a fraction and not
 * basis points. `amount * (100 + slippage) / 100`. Passing bps/10000 (0.15)
 * was read as 0.15% and RebalanceLiquidity failed ExceededBinSlippageTolerance.
 */
export function sdkSlippagePercent(lpSlippageBps: number): number {
  if (!Number.isInteger(lpSlippageBps) || lpSlippageBps < 0 || lpSlippageBps > 10_000) {
    throw new TxBuildError(`slippageBps must be an integer from 0 to 10000, got ${String(lpSlippageBps)}`);
  }
  return lpSlippageBps / 100;
}

export function parsePriorityFee(value: number | undefined): number {
  const fee = value ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  if (!Number.isInteger(fee) || fee < 0 || fee > MAX_PRIORITY_FEE_MICRO_LAMPORTS) {
    throw new TxBuildError(
      `priorityFeeMicroLamports must be an integer from 0 to ${MAX_PRIORITY_FEE_MICRO_LAMPORTS}, got ${String(value)}`,
    );
  }
  return fee;
}

/** Partial removes stay open. Closing is only valid when the whole position is removed. */
export function parseRemoveBps(bps: number, shouldClaimAndClose: boolean): number {
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
    throw new TxBuildError(`bps must be an integer from 1 to 10000, got ${String(bps)}`);
  }
  if (shouldClaimAndClose && bps !== 10_000) {
    throw new TxBuildError(
      "shouldClaimAndClose requires bps 10000. A partial remove has to leave the position open.",
    );
  }
  return bps;
}

export function validateBinWindow(lowerBinId: number, upperBinId: number): number {
  if (!Number.isInteger(lowerBinId) || !Number.isInteger(upperBinId)) {
    throw new TxBuildError("bin ids must be integers");
  }
  if (lowerBinId > upperBinId) {
    throw new TxBuildError(`lowerBinId ${lowerBinId} is above upperBinId ${upperBinId}`);
  }
  const bins = upperBinId - lowerBinId + 1;
  if (bins > ABSOLUTE_MAX_BINS) {
    throw new TxBuildError(`bin window is ${bins} bins; the maximum is ${ABSOLUTE_MAX_BINS}`);
  }
  return bins;
}

/** Keep the top of a one-sided bid on the active bin. The width stays the same. */
export function reanchorBelowActive(
  lowerBinId: number,
  upperBinId: number,
  activeBinId: number,
): { lowerBinId: number; upperBinId: number } {
  if (upperBinId === activeBinId) return { lowerBinId, upperBinId };
  const width = upperBinId - lowerBinId;
  return { lowerBinId: activeBinId - width, upperBinId: activeBinId };
}

/** Contiguous deposit chunks of at most 70 bins, matching the SDK's chunking. */
export function chunkBinRange(lowerBinId: number, upperBinId: number): [number, number][] {
  const out: [number, number][] = [];
  let start = lowerBinId;
  while (start <= upperBinId) {
    const end = Math.min(start + SLICE_MAX_BINS - 1, upperBinId);
    out.push([start, end]);
    start = end + 1;
  }
  return out;
}

/**
 * Windows the SDK's extended-position builder uses when the lookup table is
 * available. Each window is one PositionV2, created and then extended.
 */
export function positionWindows(lowerBinId: number, upperBinId: number): [number, number][] {
  const out: [number, number][] = [];
  let start = lowerBinId;
  while (start <= upperBinId) {
    const end = Math.min(start + MAX_BINS_PER_EXTENDED_POSITION - 1, upperBinId);
    out.push([start, end]);
    start = end + 1;
  }
  return out;
}

export function binRawRatioToTokenPrice(raw: number, decimalsX: number, decimalsY: number): number {
  return raw * 10 ** (decimalsX - decimalsY);
}

function discEq(ix: TransactionInstruction, disc: Buffer): boolean {
  return ix.data.length >= 8 && Buffer.from(ix.data.subarray(0, 8)).equals(disc);
}

export function isInitializePosition2(ix: TransactionInstruction): boolean {
  return discEq(ix, OPEN_IX_DISC.initPosition2);
}

/**
 * The SDK repeats initializePosition2 and every increasePositionLength2 on
 * each 70-bin chunk so a chunk can land alone. Sent in order, chunk 2 would
 * recreate the position chunk 1 already created. Keep create and extend on
 * the first transaction only.
 */
export function stripRepeatedPositionInits(txs: TransactionInstruction[][]): TransactionInstruction[][] {
  return txs.map((ixs, index) => {
    if (index === 0) return ixs;
    return ixs.filter(
      (ix) => !discEq(ix, OPEN_IX_DISC.initPosition2) && !discEq(ix, OPEN_IX_DISC.increasePositionLength2),
    );
  });
}

/** IDL order for initBinArray / initBinArrayBitmap: lb_pair, then the account being created. */
export function accountInitTarget(ix: TransactionInstruction): string | null {
  if (!discEq(ix, OPEN_IX_DISC.initBinArray) && !discEq(ix, OPEN_IX_DISC.initBinArrayBitmap)) return null;
  const key = ix.keys[1]?.pubkey;
  return key ? key.toBase58() : null;
}

/** Keys are `${txIndex}:${ixIndex}` into the flattened transaction list. */
export function redundantInitIndexes(
  inits: { tx: number; ix: number; account: string }[],
  existing: ReadonlySet<string>,
): Set<string> {
  const drop = new Set<string>();
  const created = new Set(existing);
  for (const init of inits) {
    if (created.has(init.account)) drop.add(`${init.tx}:${init.ix}`);
    else created.add(init.account);
  }
  return drop;
}

export function dropRedundantAccountInits(
  txs: TransactionInstruction[][],
  existing: ReadonlySet<string>,
): TransactionInstruction[][] {
  const inits: { tx: number; ix: number; account: string }[] = [];
  txs.forEach((ixs, tx) => {
    ixs.forEach((ix, ixIdx) => {
      const account = accountInitTarget(ix);
      if (account) inits.push({ tx, ix: ixIdx, account });
    });
  });
  if (inits.length === 0) return txs;
  const drop = redundantInitIndexes(inits, existing);
  if (drop.size === 0) return txs;
  return txs.map((ixs, tx) => ixs.filter((_, ix) => !drop.has(`${tx}:${ix}`)));
}

export function formatRawAmount(raw: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TxBuildError(`token decimals ${String(decimals)} are outside 0..18`);
  }
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) throw new TxBuildError(`amount is not an integer string: ${raw}`);
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole.replace(/^0+(?=\d)/, "") || "0";
  const normalized = body === "" ? "0" : body;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}
