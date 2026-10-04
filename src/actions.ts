import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { assembleOpenGroups, referencedInitAccounts } from "./assemble.js";
import { TxBuildError, errorText } from "./errors.js";
import { tokenLabel } from "./format.js";
import {
  DLMM_LOOKUP_TABLE,
  DEFAULT_SLIPPAGE_BPS,
  MAX_TRANSACTIONS,
  SIMPLE_COMPUTE_UNIT_LIMIT,
  WIDE_COMPUTE_UNIT_LIMIT,
  formatRawAmount,
  parsePriorityFee,
  parseRemoveBps,
  reanchorBelowActive,
  sdkSlippagePercent,
  strategyTypeValue,
  validateBinWindow,
  type StrategyName,
} from "./invariants.js";
import { type ComputeBudget, packageForWallet } from "./packageTx.js";
import { asBn, parsePublicKey, parseRawAmount, resolveRpcUrl } from "./parse.js";
import { connectPool, existingAccounts, requireUserPosition, type PoolContext } from "./pool.js";
import {
  StrategyType,
  buildLiquidityStrategyParameters,
  getLiquidityStrategyParameterBuilder,
} from "./sdk.js";
import type { BuiltAction } from "./types.js";

export interface OpenPositionInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  lowerBinId: number;
  upperBinId: number;
  amountXRaw: string;
  amountYRaw: string;
  strategy: StrategyName;
  singleSidedX?: boolean;
  slippageBps?: number;
  reanchorTopToActiveBin?: boolean;
  priorityFeeMicroLamports?: number;
}

export interface AddLiquidityInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  positionAddress: string;
  lowerBinId?: number;
  upperBinId?: number;
  amountXRaw: string;
  amountYRaw: string;
  strategy: StrategyName;
  singleSidedX?: boolean;
  slippageBps?: number;
  priorityFeeMicroLamports?: number;
}

export interface RemoveLiquidityInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  positionAddress: string;
  fromBinId?: number;
  toBinId?: number;
  bps: number;
  shouldClaimAndClose?: boolean;
  priorityFeeMicroLamports?: number;
}

export interface ClaimFeesInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  positionAddress: string;
  includeRewards?: boolean;
  priorityFeeMicroLamports?: number;
}

export interface ClosePositionInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  positionAddress: string;
  priorityFeeMicroLamports?: number;
}

export interface RebalancePositionInput {
  rpcUrl?: string;
  poolAddress: string;
  userPublicKey: string;
  positionAddress: string;
  newLowerBinId: number;
  newUpperBinId: number;
  strategy?: StrategyName;
  topUpXRaw?: string;
  topUpYRaw?: string;
  xWithdrawBps?: number;
  yWithdrawBps?: number;
  shouldClaimFee?: boolean;
  shouldClaimReward?: boolean;
  allowTokenX?: boolean;
  slippageBps?: number;
  reanchorTopToActiveBin?: boolean;
  priorityFeeMicroLamports?: number;
}

function submissionWarning(count: number): string[] {
  if (count <= 1) return [];
  return [
    "These transactions share one confirmed blockhash and must be submitted in order. If the hash expires before the last one lands, rebuild. Do not retry an expired package.",
  ];
}

function poolSnapshot(ctx: PoolContext): BuiltAction["pool"] {
  return {
    address: ctx.poolAddress.toBase58(),
    binStep: ctx.binStep,
    activeBinId: ctx.activeBinId,
    activePriceRaw: ctx.activePriceRaw,
    activeTokenPrice: ctx.activeTokenPrice,
    tokenX: ctx.tokenX,
    tokenY: ctx.tokenY,
  };
}

function assertTxCount(count: number): void {
  if (count > MAX_TRANSACTIONS) {
    throw new TxBuildError(
      `This action needs ${count} transactions, above the ${MAX_TRANSACTIONS} limit. Narrow the bin window.`,
    );
  }
}

async function publish(args: {
  ctx: PoolContext;
  payer: PublicKey;
  transactions: Transaction[];
  labels: string[];
  ephemeralSigners?: Keypair[];
  priorityFeeMicroLamports: number;
  budget: ComputeBudget;
  budgets?: ComputeBudget[];
}): Promise<{ package: BuiltAction["package"]; warnings: string[] }> {
  assertTxCount(args.transactions.length);
  const published = await packageForWallet({
    connection: args.ctx.connection,
    payer: args.payer,
    transactions: args.transactions,
    labels: args.labels,
    ephemeralSigners: args.ephemeralSigners,
    lookupTableAddress: new PublicKey(DLMM_LOOKUP_TABLE),
    priorityFeeMicroLamports: args.priorityFeeMicroLamports,
    computeUnitLimit: args.budget.limit,
    replaceComputeUnitLimit: args.budget.replace,
    budgets: args.budgets,
  });
  return {
    package: published.package,
    warnings: [...published.warnings, ...submissionWarning(published.package.transactions.length)],
  };
}

function asTransactions(built: Transaction | Transaction[]): Transaction[] {
  return Array.isArray(built) ? built : [built];
}

/** Share of `total` that stays in the position when `withdrawBps` leaves it. */
function keptAfterWithdraw(total: BN, withdrawBps: number): BN {
  return total.mul(new BN(10_000 - withdrawBps)).div(new BN(10_000));
}

function sideWarnings(args: {
  singleSidedX: boolean;
  amountX: BN;
  amountY: BN;
  upperBinId: number;
  activeBinId: number;
  reanchored: boolean;
}): string[] {
  const warnings: string[] = [];
  if (args.singleSidedX && args.amountX.isZero() && !args.amountY.isZero()) {
    warnings.push(
      "singleSidedX is true while only token Y is funded. That flag targets the token-X side and the deposit can be all zeros. Leave singleSidedX false for a token-Y bid.",
    );
  }
  if (!args.reanchored && args.upperBinId > args.activeBinId && args.amountX.isZero() && !args.amountY.isZero()) {
    warnings.push(
      "The window extends above the active bin while the token-X amount is 0. A one-sided token-Y bid keeps the top bin on the active bin. Pass reanchorTopToActiveBin to move it there.",
    );
  }
  return warnings;
}

export async function buildOpenPosition(input: OpenPositionInput): Promise<BuiltAction> {
  const amountX = parseRawAmount(input.amountXRaw, "amountXRaw");
  const amountY = parseRawAmount(input.amountYRaw, "amountYRaw");
  if (amountX.bn.isZero() && amountY.bn.isZero()) {
    throw new TxBuildError("Both token amounts are zero. Nothing was built.");
  }
  validateBinWindow(input.lowerBinId, input.upperBinId);
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  const singleSidedX = input.singleSidedX ?? false;
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const slippagePercent = sdkSlippagePercent(slippageBps);
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);

  let lowerBinId = input.lowerBinId;
  let upperBinId = input.upperBinId;
  let reanchored = false;
  if (input.reanchorTopToActiveBin) {
    const anchored = reanchorBelowActive(lowerBinId, upperBinId, ctx.activeBinId);
    reanchored = anchored.lowerBinId !== lowerBinId || anchored.upperBinId !== upperBinId;
    lowerBinId = anchored.lowerBinId;
    upperBinId = anchored.upperBinId;
    validateBinWindow(lowerBinId, upperBinId);
  }

  const strategy = {
    minBinId: lowerBinId,
    maxBinId: upperBinId,
    strategyType: strategyTypeValue(input.strategy) as StrategyType,
    // Token Y is SOL on the pools this bot trades. singleSidedX true sends the
    // deposit to the ask side; a below-range bid then deposits nothing.
    singleSidedX,
  };

  let rentSol: number | null = null;
  try {
    const quote = await ctx.sdk.quoteCreatePosition({ strategy });
    const rent =
      Number(quote.positionCost) +
      Number(quote.positionReallocCost) +
      Number(quote.binArrayCost) +
      Number(quote.bitmapExtensionCost ?? 0);
    rentSol = Number.isFinite(rent) ? rent : null;
  } catch {
    rentSol = null;
  }

  let response: Awaited<ReturnType<PoolContext["sdk"]["initializeMultiplePositionAndAddLiquidityByStrategy2"]>>;
  try {
    response = await ctx.sdk.initializeMultiplePositionAndAddLiquidityByStrategy2(
      async (count: number) => Array.from({ length: count }, () => Keypair.generate()),
      amountX.bn,
      amountY.bn,
      strategy,
      payer,
      payer,
      slippagePercent,
      new PublicKey(DLMM_LOOKUP_TABLE),
    );
  } catch (error) {
    throw new TxBuildError(
      `Could not build the open transactions. Nothing was submitted. ${errorText(error)} The SDK simulates each chunk while sizing compute units. A failure here usually means the wallet cannot cover the deposit plus rent, or the amounts do not fit this bin window.`,
    );
  }

  const groups = response.instructionsByPositions;
  const onChain = await existingAccounts(ctx.connection, referencedInitAccounts(groups));
  const assembled = assembleOpenGroups(groups, onChain);
  const published = await publish({
    ctx,
    payer,
    transactions: assembled.transactions,
    labels: assembled.labels,
    ephemeralSigners: assembled.signers,
    priorityFeeMicroLamports,
    budget: { limit: WIDE_COMPUTE_UNIT_LIMIT, replace: false },
  });

  const warnings = [
    ...sideWarnings({
      singleSidedX,
      amountX: amountX.bn,
      amountY: amountY.bn,
      upperBinId,
      activeBinId: ctx.activeBinId,
      reanchored,
    }),
    ...published.warnings,
  ];
  const where = reanchored
    ? `bins ${lowerBinId}..${upperBinId} (reanchored from ${input.lowerBinId}..${input.upperBinId} onto active bin ${ctx.activeBinId})`
    : `bins ${lowerBinId}..${upperBinId}`;
  const summary = [
    `Open ${input.strategy} position on ${ctx.poolAddress.toBase58()}, ${where}.`,
    `Deposit ${formatRawAmount(amountX.raw, ctx.tokenX.decimals)} ${tokenLabel(ctx.tokenX)} and ${formatRawAmount(amountY.raw, ctx.tokenY.decimals)} ${tokenLabel(ctx.tokenY)}.`,
    `Slippage ${slippageBps} bps is ${slippagePercent}% in the SDK.`,
    `${assembled.transactions.length} unsigned transaction(s). Position account(s): ${assembled.positionAddresses.join(", ")}.`,
    rentSol == null ? "" : `Quoted rent ${rentSol} SOL.`,
    `Fee payer ${payer.toBase58()} still has to sign. New position keys are already signed.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    action: "open_position",
    summary,
    warnings,
    pool: poolSnapshot(ctx),
    positionAddresses: assembled.positionAddresses,
    binWindow: {
      requestedLowerBinId: input.lowerBinId,
      requestedUpperBinId: input.upperBinId,
      lowerBinId,
      upperBinId,
      reanchored,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: {
      xRaw: amountX.raw,
      yRaw: amountY.raw,
      xUi: formatRawAmount(amountX.raw, ctx.tokenX.decimals),
      yUi: formatRawAmount(amountY.raw, ctx.tokenY.decimals),
    },
    slippage: { bps: slippageBps, sdkPercent: slippagePercent },
    rentSol,
    simulation: null,
    package: published.package,
  };
}

export async function buildAddLiquidity(input: AddLiquidityInput): Promise<BuiltAction> {
  const amountX = parseRawAmount(input.amountXRaw, "amountXRaw");
  const amountY = parseRawAmount(input.amountYRaw, "amountYRaw");
  if (amountX.bn.isZero() && amountY.bn.isZero()) {
    throw new TxBuildError("Both token amounts are zero. Nothing was built.");
  }
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const slippagePercent = sdkSlippagePercent(slippageBps);
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const singleSidedX = input.singleSidedX ?? false;
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);
  const position = await requireUserPosition(ctx, payer, input.positionAddress);
  const lowerBinId = input.lowerBinId ?? position.positionData.lowerBinId;
  const upperBinId = input.upperBinId ?? position.positionData.upperBinId;
  validateBinWindow(lowerBinId, upperBinId);

  const warnings = sideWarnings({
    singleSidedX,
    amountX: amountX.bn,
    amountY: amountY.bn,
    upperBinId,
    activeBinId: ctx.activeBinId,
    reanchored: false,
  });
  if (lowerBinId < position.positionData.lowerBinId || upperBinId > position.positionData.upperBinId) {
    warnings.push(
      `The deposit range ${lowerBinId}..${upperBinId} extends past the position ${position.positionData.lowerBinId}..${position.positionData.upperBinId}. The SDK will try to expand the position.`,
    );
  }

  let built: Transaction | Transaction[];
  try {
    built = await ctx.sdk.addLiquidityByStrategyChunkable({
      positionPubKey: position.publicKey,
      user: payer,
      totalXAmount: amountX.bn,
      totalYAmount: amountY.bn,
      strategy: {
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        strategyType: strategyTypeValue(input.strategy) as StrategyType,
        singleSidedX,
      },
      slippage: slippagePercent,
    });
  } catch (error) {
    throw new TxBuildError(`Could not build the add-liquidity transactions. Nothing was submitted. ${errorText(error)}`);
  }
  const transactions = asTransactions(built);
  const labels = transactions.map((_, index) =>
    transactions.length === 1
      ? `add liquidity to ${position.publicKey.toBase58()} bins ${lowerBinId}..${upperBinId}`
      : `add liquidity to ${position.publicKey.toBase58()} (${index + 1}/${transactions.length})`,
  );
  const published = await publish({
    ctx,
    payer,
    transactions,
    labels,
    priorityFeeMicroLamports,
    budget: { limit: WIDE_COMPUTE_UNIT_LIMIT, replace: false },
  });

  return {
    action: "add_liquidity",
    summary: `Add ${formatRawAmount(amountX.raw, ctx.tokenX.decimals)} ${tokenLabel(ctx.tokenX)} and ${formatRawAmount(amountY.raw, ctx.tokenY.decimals)} ${tokenLabel(ctx.tokenY)} to ${position.publicKey.toBase58()} on bins ${lowerBinId}..${upperBinId}. Slippage ${slippageBps} bps is ${slippagePercent}% in the SDK. ${transactions.length} unsigned transaction(s). Fee payer ${payer.toBase58()} still has to sign.`,
    warnings: [...warnings, ...published.warnings],
    pool: poolSnapshot(ctx),
    positionAddresses: [position.publicKey.toBase58()],
    binWindow: {
      requestedLowerBinId: input.lowerBinId ?? null,
      requestedUpperBinId: input.upperBinId ?? null,
      lowerBinId,
      upperBinId,
      reanchored: false,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: {
      xRaw: amountX.raw,
      yRaw: amountY.raw,
      xUi: formatRawAmount(amountX.raw, ctx.tokenX.decimals),
      yUi: formatRawAmount(amountY.raw, ctx.tokenY.decimals),
    },
    slippage: { bps: slippageBps, sdkPercent: slippagePercent },
    rentSol: null,
    simulation: null,
    package: published.package,
  };
}

export async function buildRemoveLiquidity(input: RemoveLiquidityInput): Promise<BuiltAction> {
  const shouldClaimAndClose = input.shouldClaimAndClose ?? false;
  const bps = parseRemoveBps(input.bps, shouldClaimAndClose);
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);
  const position = await requireUserPosition(ctx, payer, input.positionAddress);
  const fromBinId = input.fromBinId ?? position.positionData.lowerBinId;
  const toBinId = input.toBinId ?? position.positionData.upperBinId;
  if (
    !Number.isInteger(fromBinId) ||
    !Number.isInteger(toBinId) ||
    fromBinId > toBinId ||
    fromBinId < position.positionData.lowerBinId ||
    toBinId > position.positionData.upperBinId
  ) {
    throw new TxBuildError(
      `Bin range ${fromBinId}..${toBinId} is outside the position ${position.positionData.lowerBinId}..${position.positionData.upperBinId}.`,
    );
  }

  let built: Transaction[];
  try {
    built = await ctx.sdk.removeLiquidity({
      user: payer,
      position: position.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(bps),
      shouldClaimAndClose,
    });
  } catch (error) {
    throw new TxBuildError(`Could not build the remove-liquidity transactions. Nothing was submitted. ${errorText(error)}`);
  }
  const transactions = asTransactions(built);
  const verb = shouldClaimAndClose ? "remove liquidity, claim fees, and close" : "remove liquidity from";
  const labels = transactions.map((_, index) =>
    transactions.length === 1
      ? `${verb} ${position.publicKey.toBase58()}`
      : `${verb} ${position.publicKey.toBase58()} (${index + 1}/${transactions.length})`,
  );
  const published = await publish({
    ctx,
    payer,
    transactions,
    labels,
    priorityFeeMicroLamports,
    budget: { limit: WIDE_COMPUTE_UNIT_LIMIT, replace: false },
  });
  const percent = bps / 100;
  return {
    action: "remove_liquidity",
    summary: `${shouldClaimAndClose ? "Remove all liquidity, claim fees, and close" : `Remove ${percent}% of the liquidity from`} ${position.publicKey.toBase58()} bins ${fromBinId}..${toBinId}. ${transactions.length} unsigned transaction(s). Fee payer ${payer.toBase58()} still has to sign.`,
    warnings: published.warnings,
    pool: poolSnapshot(ctx),
    positionAddresses: [position.publicKey.toBase58()],
    binWindow: {
      requestedLowerBinId: input.fromBinId ?? null,
      requestedUpperBinId: input.toBinId ?? null,
      lowerBinId: fromBinId,
      upperBinId: toBinId,
      reanchored: false,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: null,
    slippage: null,
    rentSol: null,
    simulation: null,
    package: published.package,
  };
}

export async function buildClaimFees(input: ClaimFeesInput): Promise<BuiltAction> {
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const includeRewards = input.includeRewards ?? false;
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);
  const position = await requireUserPosition(ctx, payer, input.positionAddress);

  let transactions: Transaction[];
  try {
    transactions = asTransactions(await ctx.sdk.claimSwapFee({ owner: payer, position }));
    if (includeRewards) {
      const rewards = asTransactions(await ctx.sdk.claimLMReward({ owner: payer, position }));
      transactions = transactions.concat(rewards);
    }
  } catch (error) {
    throw new TxBuildError(`Could not build the claim transactions. Nothing was submitted. ${errorText(error)}`);
  }
  const claimLabel = includeRewards ? "claim fees or rewards" : "claim swap fees";
  const labels = transactions.map((_, index) =>
    transactions.length === 1
      ? `${claimLabel} on ${position.publicKey.toBase58()}`
      : `${claimLabel} on ${position.publicKey.toBase58()} (${index + 1}/${transactions.length})`,
  );
  const published = await publish({
    ctx,
    payer,
    transactions,
    labels,
    priorityFeeMicroLamports,
    budget: { limit: SIMPLE_COMPUTE_UNIT_LIMIT, replace: false },
  });
  return {
    action: "claim_fees",
    summary: `Claim swap fees${includeRewards ? " and liquidity-mining rewards" : ""} on ${position.publicKey.toBase58()}. The position stays open. ${transactions.length} unsigned transaction(s). Fee payer ${payer.toBase58()} still has to sign.`,
    warnings: published.warnings,
    pool: poolSnapshot(ctx),
    positionAddresses: [position.publicKey.toBase58()],
    binWindow: {
      requestedLowerBinId: null,
      requestedUpperBinId: null,
      lowerBinId: position.positionData.lowerBinId,
      upperBinId: position.positionData.upperBinId,
      reanchored: false,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: null,
    slippage: null,
    rentSol: null,
    simulation: null,
    package: published.package,
  };
}

export async function buildClosePosition(input: ClosePositionInput): Promise<BuiltAction> {
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);
  const position = await requireUserPosition(ctx, payer, input.positionAddress);
  const amountX = asBn(position.positionData.totalXAmount);
  const amountY = asBn(position.positionData.totalYAmount);
  const feeX = asBn(position.positionData.feeX);
  const feeY = asBn(position.positionData.feeY);
  if (amountX.gtn(0) || amountY.gtn(0)) {
    throw new TxBuildError(
      "Position still holds liquidity. Use build_remove_liquidity with bps 10000 and shouldClaimAndClose true to withdraw, claim, and close in one step.",
    );
  }
  if (feeX.gtn(0) || feeY.gtn(0)) {
    throw new TxBuildError(
      "Position still has unclaimed swap fees. Use build_claim_fees, or build_remove_liquidity with shouldClaimAndClose true.",
    );
  }

  let built: Transaction;
  try {
    built = await ctx.sdk.closePositionIfEmpty({ owner: payer, position });
  } catch (error) {
    throw new TxBuildError(`Could not build the close transaction. Nothing was submitted. ${errorText(error)}`);
  }
  const published = await publish({
    ctx,
    payer,
    transactions: [built],
    labels: [`close empty position ${position.publicKey.toBase58()}`],
    priorityFeeMicroLamports,
    budget: { limit: SIMPLE_COMPUTE_UNIT_LIMIT, replace: false },
  });
  return {
    action: "close_position",
    summary: `Close empty position ${position.publicKey.toBase58()} and recover its rent. 1 unsigned transaction. Fee payer ${payer.toBase58()} still has to sign.`,
    warnings: published.warnings,
    pool: poolSnapshot(ctx),
    positionAddresses: [position.publicKey.toBase58()],
    binWindow: {
      requestedLowerBinId: null,
      requestedUpperBinId: null,
      lowerBinId: position.positionData.lowerBinId,
      upperBinId: position.positionData.upperBinId,
      reanchored: false,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: null,
    slippage: null,
    rentSol: null,
    simulation: null,
    package: published.package,
  };
}

export async function buildRebalancePosition(input: RebalancePositionInput): Promise<BuiltAction> {
  const payer = parsePublicKey(input.userPublicKey, "userPublicKey");
  validateBinWindow(input.newLowerBinId, input.newUpperBinId);
  const strategyName = input.strategy ?? "bidAsk";
  const topUpX = parseRawAmount(input.topUpXRaw ?? "0", "topUpXRaw");
  const topUpY = parseRawAmount(input.topUpYRaw ?? "0", "topUpYRaw");
  const xWithdrawBps = input.xWithdrawBps ?? 10_000;
  const yWithdrawBps = input.yWithdrawBps ?? 10_000;
  if (!Number.isInteger(xWithdrawBps) || xWithdrawBps < 0 || xWithdrawBps > 10_000) {
    throw new TxBuildError(`xWithdrawBps must be an integer from 0 to 10000, got ${String(input.xWithdrawBps)}`);
  }
  if (!Number.isInteger(yWithdrawBps) || yWithdrawBps < 0 || yWithdrawBps > 10_000) {
    throw new TxBuildError(`yWithdrawBps must be an integer from 0 to 10000, got ${String(input.yWithdrawBps)}`);
  }
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const slippagePercent = sdkSlippagePercent(slippageBps);
  const priorityFeeMicroLamports = parsePriorityFee(input.priorityFeeMicroLamports);
  const shouldClaimFee = input.shouldClaimFee ?? false;
  const shouldClaimReward = input.shouldClaimReward ?? false;
  const allowTokenX = input.allowTokenX ?? false;
  const ctx = await connectPool(resolveRpcUrl(input.rpcUrl), input.poolAddress);
  if (ctx.binStep <= 0) throw new TxBuildError(`Pool bin step ${ctx.binStep} is not usable.`);
  const position = await requireUserPosition(ctx, payer, input.positionAddress);

  let lowerBinId = input.newLowerBinId;
  let upperBinId = input.newUpperBinId;
  let reanchored = false;
  if (input.reanchorTopToActiveBin) {
    const anchored = reanchorBelowActive(lowerBinId, upperBinId, ctx.activeBinId);
    reanchored = anchored.lowerBinId !== lowerBinId || anchored.upperBinId !== upperBinId;
    lowerBinId = anchored.lowerBinId;
    upperBinId = anchored.upperBinId;
    validateBinWindow(lowerBinId, upperBinId);
  }

  const oneSided =
    strategyName === "bidAsk" &&
    topUpX.bn.isZero() &&
    topUpY.bn.isZero() &&
    xWithdrawBps === 10_000 &&
    yWithdrawBps === 10_000;
  const maxActiveBinSlippage = new BN(Math.max(1, Math.ceil(slippagePercent / (ctx.binStep / 100))));

  let initIxs: TransactionInstruction[];
  let rebalanceIxs: TransactionInstruction[];
  let depositedX = new BN(0);
  let depositedY = new BN(0);
  let withdrawnX = new BN(0);
  let withdrawnY = new BN(0);
  try {
    if (oneSided) {
      const amountY = asBn(position.positionData.totalYAmount);
      if (amountY.lten(0)) {
        throw new TxBuildError(
          "This one-sided BidAsk path redeposits token Y, and the position has none. Pass a top-up amount to use the balanced rebalance builder.",
        );
      }
      const activeId = new BN(ctx.activeBinId);
      const minDeltaId = new BN(lowerBinId - ctx.activeBinId);
      const maxDeltaId = new BN(upperBinId - ctx.activeBinId);
      const params = buildLiquidityStrategyParameters(
        new BN(0),
        amountY,
        minDeltaId,
        maxDeltaId,
        new BN(ctx.binStep),
        false,
        activeId,
        getLiquidityStrategyParameterBuilder(StrategyType.BidAsk),
      );
      const simulated = await ctx.sdk.simulateRebalancePosition(
        position.publicKey,
        position.positionData,
        shouldClaimFee,
        shouldClaimReward,
        [
          {
            minDeltaId,
            maxDeltaId,
            x0: params.x0,
            y0: params.y0,
            deltaX: params.deltaX,
            deltaY: params.deltaY,
            favorXInActiveBin: false,
          },
        ],
        [
          {
            minBinId: new BN(position.positionData.lowerBinId),
            maxBinId: new BN(position.positionData.upperBinId),
            bps: new BN(10_000),
          },
        ],
      );
      depositedX = simulated.simulationResult.actualAmountXDeposited;
      depositedY = simulated.simulationResult.actualAmountYDeposited;
      withdrawnX = simulated.simulationResult.actualAmountXWithdrawn;
      withdrawnY = simulated.simulationResult.actualAmountYWithdrawn;
      if (depositedX.gtn(0) && !allowTokenX) {
        throw new TxBuildError(
          `Rebalance simulation would deposit ${depositedX.toString()} raw token X. The one-sided path stops there. Pass allowTokenX true to build it anyway, or set reanchorTopToActiveBin so the top bin is the active bin.`,
        );
      }
      const built = await ctx.sdk.rebalancePosition(simulated, maxActiveBinSlippage, payer, slippagePercent);
      initIxs = built.initBinArrayInstructions;
      rebalanceIxs = built.rebalancePositionInstruction;
    } else {
      // The SDK's balanced helper recenters the old width on the active bin and
      // always claims fees and rewards. The requested window and claim flags win.
      let inventoryX = asBn(position.positionData.totalXAmount);
      let inventoryY = asBn(position.positionData.totalYAmount);
      if (shouldClaimFee) {
        inventoryX = inventoryX.add(asBn(position.positionData.feeX));
        inventoryY = inventoryY.add(asBn(position.positionData.feeY));
      }
      const depositX = topUpX.bn.add(keptAfterWithdraw(inventoryX, xWithdrawBps));
      const depositY = topUpY.bn.add(keptAfterWithdraw(inventoryY, yWithdrawBps));
      const activeId = new BN(ctx.activeBinId);
      const minDeltaId = new BN(lowerBinId - ctx.activeBinId);
      const maxDeltaId = new BN(upperBinId - ctx.activeBinId);
      const params = buildLiquidityStrategyParameters(
        depositX,
        depositY,
        minDeltaId,
        maxDeltaId,
        new BN(ctx.binStep),
        false,
        activeId,
        getLiquidityStrategyParameterBuilder(strategyTypeValue(strategyName) as StrategyType),
      );
      const simulated = await ctx.sdk.simulateRebalancePosition(
        position.publicKey,
        position.positionData,
        shouldClaimFee,
        shouldClaimReward,
        [
          {
            minDeltaId,
            maxDeltaId,
            x0: params.x0,
            y0: params.y0,
            deltaX: params.deltaX,
            deltaY: params.deltaY,
            favorXInActiveBin: false,
          },
        ],
        [
          {
            minBinId: new BN(position.positionData.lowerBinId),
            maxBinId: new BN(position.positionData.upperBinId),
            bps: new BN(10_000),
          },
        ],
      );
      depositedX = simulated.simulationResult.actualAmountXDeposited;
      depositedY = simulated.simulationResult.actualAmountYDeposited;
      withdrawnX = simulated.simulationResult.actualAmountXWithdrawn;
      withdrawnY = simulated.simulationResult.actualAmountYWithdrawn;
      const built = await ctx.sdk.rebalancePosition(simulated, maxActiveBinSlippage, payer, slippagePercent);
      initIxs = built.initBinArrayInstructions;
      rebalanceIxs = built.rebalancePositionInstruction;
    }
  } catch (error) {
    if (error instanceof TxBuildError) throw error;
    throw new TxBuildError(`Could not build the rebalance transactions. Nothing was submitted. ${errorText(error)}`);
  }

  const transactions: Transaction[] = [];
  const labels: string[] = [];
  const budgets: ComputeBudget[] = [];
  if (initIxs.length > 0) {
    const initTx = new Transaction();
    initTx.add(...initIxs);
    transactions.push(initTx);
    labels.push(`initialize bin arrays for ${position.publicKey.toBase58()}`);
    budgets.push({ limit: SIMPLE_COMPUTE_UNIT_LIMIT, replace: true });
  }
  const rebalanceTx = new Transaction();
  rebalanceTx.add(...rebalanceIxs);
  transactions.push(rebalanceTx);
  labels.push(`rebalance ${position.publicKey.toBase58()} into bins ${lowerBinId}..${upperBinId}`);
  // A wide withdraw-and-redeposit exceeds the SDK's own compute estimate.
  budgets.push({ limit: WIDE_COMPUTE_UNIT_LIMIT, replace: true });

  const published = await publish({
    ctx,
    payer,
    transactions,
    labels,
    priorityFeeMicroLamports,
    budget: budgets[0]!,
    budgets,
  });
  const warnings = [...published.warnings];
  if (
    !oneSided &&
    xWithdrawBps === 10_000 &&
    yWithdrawBps === 10_000 &&
    topUpX.bn.isZero() &&
    topUpY.bn.isZero()
  ) {
    warnings.push(
      "Both withdraw shares are 10000 and there is no top-up, so the current liquidity is removed and nothing is redeposited. The position stays open.",
    );
  }
  if (depositedX.gtn(0)) {
    warnings.push(
      `Simulation deposits ${depositedX.toString()} raw token X (${formatRawAmount(depositedX.toString(), ctx.tokenX.decimals)} ${tokenLabel(ctx.tokenX)}).`,
    );
  }
  if (withdrawnX.gtn(0) && depositedX.isZero()) {
    warnings.push(
      `Simulation withdraws ${withdrawnX.toString()} raw token X and does not redeposit it. That amount returns to the wallet.`,
    );
  }

  const where = reanchored
    ? `bins ${lowerBinId}..${upperBinId} (reanchored from ${input.newLowerBinId}..${input.newUpperBinId})`
    : `bins ${lowerBinId}..${upperBinId}`;
  return {
    action: "rebalance_position",
    summary: `Rebalance ${position.publicKey.toBase58()} into ${where} as ${strategyName}. Slippage ${slippageBps} bps is ${slippagePercent}% in the SDK. Simulation deposits ${depositedX.toString()} raw X and ${depositedY.toString()} raw Y, and withdraws ${withdrawnX.toString()} raw X and ${withdrawnY.toString()} raw Y. ${transactions.length} unsigned transaction(s). Fee payer ${payer.toBase58()} still has to sign.`,
    warnings,
    pool: poolSnapshot(ctx),
    positionAddresses: [position.publicKey.toBase58()],
    binWindow: {
      requestedLowerBinId: input.newLowerBinId,
      requestedUpperBinId: input.newUpperBinId,
      lowerBinId,
      upperBinId,
      reanchored,
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    },
    requestedAmounts: null,
    amounts: {
      xRaw: topUpX.raw,
      yRaw: topUpY.raw,
      xUi: formatRawAmount(topUpX.raw, ctx.tokenX.decimals),
      yUi: formatRawAmount(topUpY.raw, ctx.tokenY.decimals),
    },
    slippage: { bps: slippageBps, sdkPercent: slippagePercent },
    rentSol: null,
    simulation: {
      xDepositedRaw: depositedX.toString(),
      yDepositedRaw: depositedY.toString(),
      xWithdrawnRaw: withdrawnX.toString(),
      yWithdrawnRaw: withdrawnY.toString(),
      depositsTokenX: depositedX.gtn(0),
    },
    package: published.package,
  };
}
