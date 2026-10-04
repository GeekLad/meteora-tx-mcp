// @meteora-ag/dlmm's ESM bundle imports @coral-xyz/anchor/dist/cjs/utils/bytes
// as a directory. Node refuses that import. The CommonJS build is the one
// live-dlmm loads, and require() resolves the directory. Named exports are
// copied onto the DLMM class by the package's CJS footer.
import { createRequire } from "node:module";
import type { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type BN from "bn.js";
import type {
  BinLiquidity,
  InitializeMultiplePositionAndAddLiquidityByStrategyResponse2,
  LbPair,
  LbPosition,
  LiquidityStrategyParameterBuilder,
  LiquidityStrategyParameters,
  Opt,
  RebalancePositionBinArrayRentalCostQuote,
  RebalancePositionResponse,
  StrategyParameters,
  StrategyType as StrategyTypeEnum,
  TInitializePositionAndAddLiquidityParamsByStrategy,
  TQuoteCreatePositionParams,
  TokenReserve,
} from "@meteora-ag/dlmm";

const require = createRequire(import.meta.url);

export interface DlmmClient {
  lbPair: LbPair;
  tokenX: TokenReserve;
  tokenY: TokenReserve;
  refetchStates(): Promise<void>;
  getActiveBin(): Promise<BinLiquidity>;
  getPositionsByUserAndLbPair(userPubKey?: PublicKey): Promise<{
    activeBin: BinLiquidity;
    userPositions: LbPosition[];
  }>;
  quoteCreatePosition(params: TQuoteCreatePositionParams): Promise<{
    positionCount: number;
    positionCost: number;
    positionReallocCost: number;
    bitmapExtensionCost: number;
    binArraysCount: number;
    binArrayCost: number;
    transactionCount: number;
  }>;
  initializeMultiplePositionAndAddLiquidityByStrategy2(
    positionKeypairGenerator: (count: number) => Promise<Keypair[]>,
    totalXAmount: BN,
    totalYAmount: BN,
    strategy: StrategyParameters,
    owner: PublicKey,
    payer: PublicKey,
    slippagePercentage: number,
    altAddress?: PublicKey,
  ): Promise<InitializeMultiplePositionAndAddLiquidityByStrategyResponse2>;
  addLiquidityByStrategyChunkable(
    params: TInitializePositionAndAddLiquidityParamsByStrategy,
  ): Promise<Transaction[]>;
  removeLiquidity(params: {
    user: PublicKey;
    position: PublicKey;
    fromBinId: number;
    toBinId: number;
    bps: BN;
    shouldClaimAndClose?: boolean;
  }): Promise<Transaction[]>;
  closePositionIfEmpty(params: { owner: PublicKey; position: LbPosition }): Promise<Transaction>;
  claimLMReward(params: { owner: PublicKey; position: LbPosition }): Promise<Transaction[]>;
  claimSwapFee(params: { owner: PublicKey; position: LbPosition }): Promise<Transaction[]>;
  simulateRebalancePosition(
    positionAddress: PublicKey,
    positionData: LbPosition["positionData"],
    shouldClaimFee: boolean,
    shouldClaimReward: boolean,
    deposits: Array<{
      minDeltaId: BN;
      maxDeltaId: BN;
      x0: BN;
      y0: BN;
      deltaX: BN;
      deltaY: BN;
      favorXInActiveBin: boolean;
    }>,
    withdraws: Array<{ minBinId: BN; maxBinId: BN; bps: BN }>,
  ): Promise<RebalancePositionResponse & RebalancePositionBinArrayRentalCostQuote>;
  rebalancePosition(
    rebalancePositionResponse: RebalancePositionResponse,
    maxActiveBinSlippage: BN,
    rentPayer?: PublicKey,
    slippage?: number,
  ): Promise<{
    initBinArrayInstructions: TransactionInstruction[];
    rebalancePositionInstruction: TransactionInstruction[];
  }>;
}

interface DlmmSdk {
  create(connection: Connection, dlmm: PublicKey, opt?: Opt): Promise<DlmmClient>;
  StrategyType: typeof StrategyTypeEnum;
  ALT_ADDRESS: { "mainnet-beta": string; devnet: string };
  buildLiquidityStrategyParameters(
    amountX: BN,
    amountY: BN,
    minDeltaId: BN,
    maxDeltaId: BN,
    binStep: BN,
    favorXInActiveId: boolean,
    activeId: BN,
    strategyParameterBuilder: LiquidityStrategyParameterBuilder,
  ): LiquidityStrategyParameters;
  getLiquidityStrategyParameterBuilder(strategyType: StrategyTypeEnum): LiquidityStrategyParameterBuilder;
}

function loadSdk(): DlmmSdk {
  const loaded: unknown = require("@meteora-ag/dlmm");
  if (typeof loaded !== "function") {
    throw new Error("@meteora-ag/dlmm CommonJS build did not export the DLMM class.");
  }
  const sdk = loaded as Partial<DlmmSdk>;
  if (
    typeof sdk.create !== "function" ||
    typeof sdk.buildLiquidityStrategyParameters !== "function" ||
    typeof sdk.getLiquidityStrategyParameterBuilder !== "function" ||
    typeof sdk.StrategyType !== "object" ||
    sdk.StrategyType === null ||
    typeof sdk.ALT_ADDRESS !== "object" ||
    sdk.ALT_ADDRESS === null
  ) {
    throw new Error("@meteora-ag/dlmm CommonJS build is missing create or its named exports.");
  }
  return loaded as unknown as DlmmSdk;
}

const sdk = loadSdk();

/** Value is the constructor. Type is an open pool client. */
export const DLMM: DlmmSdk = sdk;
export type DLMM = DlmmClient;

export const StrategyType = sdk.StrategyType;
export type StrategyType = StrategyTypeEnum;
export const ALT_ADDRESS = sdk.ALT_ADDRESS;
export const buildLiquidityStrategyParameters = sdk.buildLiquidityStrategyParameters;
export const getLiquidityStrategyParameterBuilder = sdk.getLiquidityStrategyParameterBuilder;
