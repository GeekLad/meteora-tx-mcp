import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAddLiquidity,
  buildClaimFees,
  buildClosePosition,
  buildOpenPosition,
  buildRebalancePosition,
  buildRemoveLiquidity,
} from "./actions.js";
import { resolvePriceWindow, resolveUiAmounts, type PriceWindowResolved } from "./convert.js";
import { connectPool, type PoolContext } from "./pool.js";
import { resolveRpcUrl } from "./parse.js";
import { errorText } from "./errors.js";
import { formatBuilt } from "./format.js";
import {
  DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_PRIORITY_FEE_MICRO_LAMPORTS,
} from "./invariants.js";
import type { BuiltAction } from "./types.js";
import { TxBuildError } from "./errors.js";

const rpcUrl = z
  .string()
  .optional()
  .describe("Solana RPC HTTP URL. Falls back to the SOLANA_RPC_URL environment variable. Mainnet.");
const userPublicKey = z
  .string()
  .describe("Fee payer and position owner, base58. Never a secret key. The wallet signs later.");
const poolAddress = z.string().describe("Meteora DLMM pool address, base58.");
const positionAddress = z.string().describe("Existing position account address, base58.");
const slippageBps = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .optional()
  .describe(
    `Slippage in basis points. ${DEFAULT_SLIPPAGE_BPS} means 15 percent, which is what the SDK receives. Do not pass 15 to mean 15 percent, and do not pass a fraction.`,
  );
const priorityFeeMicroLamports = z
  .number()
  .int()
  .min(0)
  .max(MAX_PRIORITY_FEE_MICRO_LAMPORTS)
  .optional()
  .describe(
    `Compute-unit price in micro-lamports. Default ${DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS}. Pass 0 to omit it. This is not a Jito tip.`,
  );
const strategy = z
  .enum(["spot", "curve", "bidAsk"])
  .describe("Liquidity shape. spot is uniform, curve concentrates at the active bin, bidAsk leans toward the edges.");
const amountXRaw = z
  .string()
  .describe("Token X amount as a base-unit integer string. Not a decimal. 0 deposits none of token X.");
const amountYRaw = z
  .string()
  .describe("Token Y amount as a base-unit integer string. SOL is lamports, so 1 SOL is 1000000000. Not a decimal.");
const singleSidedX = z
  .boolean()
  .optional()
  .describe(
    "When true, the deposit targets token X. Default false. A token-Y bid below the active bin must leave this false or the deposit is empty.",
  );
// The decimal-input tools take human amounts and decimal prices or bps off
// the active price. The _raw tools keep the base-unit and bin-id inputs.
const amountXUi = z
  .string()
  .describe(
    "Token X amount as a decimal number of whole tokens, like 1.5 for 1.5 tokens. 0.000000001 is one base unit on a 9-decimal token.",
  );
const amountYUi = z
  .string()
  .describe("Token Y amount as a decimal number of whole tokens, like 100.25. SOL is token Y with 9 decimals, so 1 means 1 SOL.");
const lowerPrice = z
  .number()
  .positive()
  .describe("Bottom of the range as the decimal price of token X in token Y at that bin, like 150.25.");
const upperPrice = z
  .number()
  .positive()
  .describe("Top of the range as the decimal price of token X in token Y at that bin. Keep it above lowerPrice.");
const lowerBpsOffActive = z
  .number()
  .describe("Bottom of the range as basis points below (negative) or above (positive) the current pool price. -500 is 5 percent below.");
const upperBpsOffActive = z
  .number()
  .describe("Top of the range as basis points below (negative) or above (positive) the current pool price. 1000 is 10 percent above.");
const removeSharePercent = z
  .number()
  .min(0)
  .max(100)
  .describe("Share of the liquidity to remove, in percent. 100 removes everything.");
const newLowerPrice = z
  .number()
  .positive()
  .describe("New bottom of the range as the decimal price of token X in token Y at that bin.");
const newUpperPrice = z
  .number()
  .positive()
  .describe("New top of the range as the decimal price of token X in token Y at that bin. Keep it above newLowerPrice.");
const newLowerBpsOffActive = z
  .number()
  .describe("New bottom of the range as basis points below (negative) or above (positive) the current pool price.");
const newUpperBpsOffActive = z
  .number()
  .describe("New top of the range as basis points below (negative) or above (positive) the current pool price.");
const topUpXUi = z
  .string()
  .optional()
  .describe("Extra token X to add, as a decimal number of whole tokens. Omit for none.");
const topUpYUi = z
  .string()
  .optional()
  .describe("Extra token Y to add, as a decimal number of whole tokens. Omit for none.");

function ok(built: BuiltAction) {
  return { content: [{ type: "text" as const, text: formatBuilt(built) }] };
}

function fail(error: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: errorText(error) }] };
}

const annotations = { readOnlyHint: true, openWorldHint: true, destructiveHint: false } as const;

/** The window and amount echo a decimal-input tool adds to the response. */
interface UiEcho {
  requestedLowerPrice: number | null;
  requestedUpperPrice: number | null;
  requestedLowerBpsOffActive: number | null;
  requestedUpperBpsOffActive: number | null;
  resolvedLowerPrice: number | null;
  resolvedUpperPrice: number | null;
  requestedAmounts: { xUi: string | null; yUi: string | null } | null;
}

function withEcho(built: BuiltAction, echo: UiEcho): BuiltAction {
  return { ...built, binWindow: { ...built.binWindow, ...echo }, requestedAmounts: echo.requestedAmounts };
}

function windowEcho(window: PriceWindowResolved | null): Pick<
  UiEcho,
  | "requestedLowerPrice"
  | "requestedUpperPrice"
  | "requestedLowerBpsOffActive"
  | "requestedUpperBpsOffActive"
  | "resolvedLowerPrice"
  | "resolvedUpperPrice"
> {
  if (window === null) {
    return {
      requestedLowerPrice: null,
      requestedUpperPrice: null,
      requestedLowerBpsOffActive: null,
      requestedUpperBpsOffActive: null,
      resolvedLowerPrice: null,
      resolvedUpperPrice: null,
    };
  }
  return {
    requestedLowerPrice: window.requestedLowerPrice,
    requestedUpperPrice: window.requestedUpperPrice,
    requestedLowerBpsOffActive: window.requestedLowerBpsOffActive,
    requestedUpperBpsOffActive: window.requestedUpperBpsOffActive,
    resolvedLowerPrice: window.resolvedLowerPrice,
    resolvedUpperPrice: window.resolvedUpperPrice,
  };
}

function amountsEcho(_ctx: PoolContext, amounts: { amountXUi?: string; amountYUi?: string }) {
  return {
    xUi: amounts.amountXUi ?? null,
    yUi: amounts.amountYUi ?? null,
  };
}

/** Pool snapshot reduced to what the converters need. */
function priceContext(ctx: PoolContext) {
  return {
    binStep: ctx.binStep,
    tokenXDecimals: ctx.tokenX.decimals,
    tokenYDecimals: ctx.tokenY.decimals,
    activeBinId: ctx.activeBinId,
    activePriceRaw: ctx.activePriceRaw,
  };
}

/** Pool fields in the shape resolvePriceWindowFromPool takes. */
function poolShape(ctx: PoolContext) {
  return {
    binStep: ctx.binStep,
    tokenX: ctx.tokenX,
    tokenY: ctx.tokenY,
    activeBinId: ctx.activeBinId,
    activePriceRaw: ctx.activePriceRaw,
  };
}

type PoolShape = ReturnType<typeof poolShape>;

export interface ServerOptions {
  /** Register only the `_raw` tools: integer bin ids and base-unit amounts. Default false. */
  rawOnly?: boolean;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "meteora-tx",
    version: "0.1.0",
  });
  // MCP_RAW_TOOLS=true serves only the _raw set; the decimal tools are left
  // unregistered so a host cannot call or even list them.
  const decimalEnabled = !options.rawOnly;

  server.registerTool(
    "build_open_position_raw",
    {
      title: "Build an unsigned open-position transaction, raw bin ids and amounts",
      description:
        "Build version-0 transactions that create a Meteora DLMM position and deposit into it. " +
        "Nothing is signed by the fee payer and nothing is submitted. The response is base64 a wallet signs, in order, the way a dapp hands transactions to a wallet extension. " +
        "New position accounts are partial-signed by ephemeral keys inside the package; those signatures die with the blockhash. " +
        "This is the raw variant: bin ids are integers and amounts are raw base-unit integer strings. " +
        "Most callers want build_open_position, which takes decimal amounts and computes bin ids from decimal prices or bps off the active price. " +
        "Ranges wider than 525 bins become more than one position. The maximum window is 1400 bins. " +
        "reanchorTopToActiveBin keeps the width and moves the top bin onto the active bin.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        lowerBinId: z.number().int().describe("Inclusive lower bin id."),
        upperBinId: z.number().int().describe("Inclusive upper bin id."),
        amountXRaw,
        amountYRaw,
        strategy,
        singleSidedX,
        slippageBps,
        reanchorTopToActiveBin: z
          .boolean()
          .optional()
          .describe("Move the window so its top bin is the active bin, preserving width. Default false."),
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildOpenPosition(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (decimalEnabled) {
    server.registerTool(
      "build_open_position",
      {
        title: "Build an unsigned open-position transaction from decimal amounts and prices",
        description:
          "Build version-0 transactions that create a Meteora DLMM position and deposit into it, from decimal inputs. " +
          "Nothing is signed by the fee payer and nothing is submitted. The response is base64 a wallet signs, in order, the way a dapp hands transactions to a wallet extension. " +
          "New position accounts are partial-signed by ephemeral keys inside the package; those signatures die with the blockhash. " +
          "amountX and amountY are decimal numbers of whole tokens, like 1.5. " +
          "Describe the bin window with prices or with bps off the current pool price: give lowerPrice and upperPrice in token-X-in-token-Y units, " +
          "or lowerBpsOffActive and upperBpsOffActive where negative means below the current price (a lower bound is normally negative, an upper bound positive). " +
          "The lower price maps to the nearest bin at or below it and the upper price to the nearest bin at or above it; " +
          "the response reports the resolved bin ids and their exact bin prices so you can check the rounding. " +
          "Ranges wider than 525 bins become more than one position. The maximum window is 1400 bins. " +
          "reanchorTopToActiveBin keeps the width and moves the top bin onto the active bin.",
        inputSchema: {
          rpcUrl,
          poolAddress,
          userPublicKey,
          lowerPrice: z
            .number()
            .positive()
            .optional()
            .describe("Bottom of the range as the decimal price of token X in token Y at that bin, like 150.25."),
          lowerBpsOffActive: lowerBpsOffActive.optional(),
          upperPrice: z
            .number()
            .positive()
            .optional()
            .describe("Top of the range as the decimal price of token X in token Y at that bin. Keep it above lowerPrice."),
          upperBpsOffActive: upperBpsOffActive.optional(),
          amountXUi,
          amountYUi,
          strategy,
          singleSidedX,
          slippageBps,
          reanchorTopToActiveBin: z
            .boolean()
            .optional()
            .describe("Move the window so its top bin is the active bin, preserving width. Default false."),
          priorityFeeMicroLamports,
        },
        annotations,
      },
      async (args) => {
        try {
          const ctx = await connectPool(resolveRpcUrl(args.rpcUrl), args.poolAddress);
          const snap = poolShape(ctx);
          const window = resolvePriceWindowOn(snap, {
            lowerPrice: args.lowerPrice,
            upperPrice: args.upperPrice,
            lowerBpsOffActive: args.lowerBpsOffActive,
            upperBpsOffActive: args.upperBpsOffActive,
          });
          const amounts = resolveUiAmounts(priceContext(ctx), { amountXUi: args.amountXUi, amountYUi: args.amountYUi });
          const built = await buildOpenPosition({
            rpcUrl: args.rpcUrl,
            poolAddress: args.poolAddress,
            userPublicKey: args.userPublicKey,
            lowerBinId: window.lowerBinId,
            upperBinId: window.upperBinId,
            amountXRaw: amounts.amountXRaw ?? "0",
            amountYRaw: amounts.amountYRaw ?? "0",
            strategy: args.strategy,
            singleSidedX: args.singleSidedX,
            slippageBps: args.slippageBps,
            reanchorTopToActiveBin: args.reanchorTopToActiveBin,
            priorityFeeMicroLamports: args.priorityFeeMicroLamports,
          });
          return ok(
            withEcho(built, {
              ...windowEcho(window),
              requestedAmounts: amountsEcho(ctx, { amountXUi: args.amountXUi, amountYUi: args.amountYUi }),
            }),
          );
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  server.registerTool(
    "build_add_liquidity_raw",
    {
      title: "Build an unsigned add-liquidity transaction, raw bin ids and amounts",
      description:
        "Build unsigned transactions that add liquidity to an existing position. This is the raw variant: bin ids are integers and amounts are raw base-unit integer strings. " +
        "Most callers want build_add_liquidity, which takes decimal amounts and computes bin ids from decimal prices or bps off the active price. " +
        "Omit the bin range to use the position's current bins. The fee payer still has to sign. Nothing is submitted.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        positionAddress,
        lowerBinId: z.number().int().optional().describe("Inclusive lower bin. Defaults to the position's lower bin."),
        upperBinId: z.number().int().optional().describe("Inclusive upper bin. Defaults to the position's upper bin."),
        amountXRaw,
        amountYRaw,
        strategy,
        singleSidedX,
        slippageBps,
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildAddLiquidity(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (decimalEnabled) {
    server.registerTool(
      "build_add_liquidity",
      {
        title: "Build an unsigned add-liquidity transaction from decimal amounts and prices",
        description:
          "Build unsigned transactions that add liquidity to an existing position, from decimal inputs. " +
          "amountX and amountY are decimal numbers of whole tokens, like 1.5. " +
          "Describe the bin window with prices or with bps off the current pool price, the same way build_open_position does; omit the price group entirely to add inside the position's current bins. " +
          "A requested range that goes past the position extends it. The fee payer still has to sign. Nothing is submitted.",
        inputSchema: {
          rpcUrl,
          poolAddress,
          userPublicKey,
          positionAddress,
          lowerPrice: lowerPrice.optional(),
          lowerBpsOffActive: lowerBpsOffActive.optional(),
          upperPrice: upperPrice.optional(),
          upperBpsOffActive: upperBpsOffActive.optional(),
          amountXUi,
          amountYUi,
          strategy,
          singleSidedX,
          slippageBps,
          priorityFeeMicroLamports,
        },
        annotations,
      },
      async (args) => {
        try {
          const ctx = await connectPool(resolveRpcUrl(args.rpcUrl), args.poolAddress);
          const amounts = resolveUiAmounts(priceContext(ctx), { amountXUi: args.amountXUi, amountYUi: args.amountYUi });
          const hasWindow =
            args.lowerPrice !== undefined ||
            args.upperPrice !== undefined ||
            args.lowerBpsOffActive !== undefined ||
            args.upperBpsOffActive !== undefined;
          const window = hasWindow
            ? resolvePriceWindowOn(poolShape(ctx), {
                lowerPrice: args.lowerPrice,
                upperPrice: args.upperPrice,
                lowerBpsOffActive: args.lowerBpsOffActive,
                upperBpsOffActive: args.upperBpsOffActive,
              })
            : null;
          const built = await buildAddLiquidity({
            rpcUrl: args.rpcUrl,
            poolAddress: args.poolAddress,
            userPublicKey: args.userPublicKey,
            positionAddress: args.positionAddress,
            lowerBinId: window?.lowerBinId,
            upperBinId: window?.upperBinId,
            amountXRaw: amounts.amountXRaw ?? "0",
            amountYRaw: amounts.amountYRaw ?? "0",
            strategy: args.strategy,
            singleSidedX: args.singleSidedX,
            slippageBps: args.slippageBps,
            priorityFeeMicroLamports: args.priorityFeeMicroLamports,
          });
          return ok(
            withEcho(built, {
              ...windowEcho(window),
              requestedAmounts: amountsEcho(ctx, { amountXUi: args.amountXUi, amountYUi: args.amountYUi }),
            }),
          );
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  server.registerTool(
    "build_remove_liquidity_raw",
    {
      title: "Build an unsigned remove-liquidity transaction, raw bin ids and bps share",
      description:
        "Build unsigned transactions that remove liquidity. This is the raw variant: the share to remove is bps out of 10000, so 5000 removes half, and a partial range is integer bin ids. " +
        "Most callers want build_remove_liquidity, which takes the share in percent and a price or bps range. " +
        "shouldClaimAndClose defaults to false and is only valid with bps 10000: that claims fees and closes the position in the same transactions. " +
        "Omit the bin range to use the full position. Submit the returned transactions in order. Nothing is submitted by this server.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        positionAddress,
        fromBinId: z.number().int().optional().describe("First bin to remove from. Defaults to the position's lower bin."),
        toBinId: z.number().int().optional().describe("Last bin to remove from. Defaults to the position's upper bin."),
        bps: z.number().int().min(1).max(10_000).describe("Share to remove, out of 10000. 10000 removes all of the range."),
        shouldClaimAndClose: z
          .boolean()
          .optional()
          .describe("Claim fees and close the position. Requires bps 10000. Default false."),
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildRemoveLiquidity(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (decimalEnabled) {
    server.registerTool(
      "build_remove_liquidity",
      {
        title: "Build an unsigned remove-liquidity transaction from percent and price bounds",
        description:
          "Build unsigned transactions that remove liquidity, from decimal inputs. " +
          "removeSharePercent is out of 100: 100 removes everything, 50 removes half. " +
          "Optionally restrict the removal to a smaller range with prices or bps off the current price, the same way build_open_position does; " +
          "omit the price group to remove from the position's own bins. " +
          "shouldClaimAndClose is only valid with removeSharePercent 100: that claims fees and closes the position in the same transactions. " +
          "Submit the returned transactions in order. Nothing is submitted by this server.",
        inputSchema: {
          rpcUrl,
          poolAddress,
          userPublicKey,
          positionAddress,
          lowerPrice: lowerPrice.optional(),
          lowerBpsOffActive: lowerBpsOffActive.optional(),
          upperPrice: upperPrice.optional(),
          upperBpsOffActive: upperBpsOffActive.optional(),
          removeSharePercent,
          shouldClaimAndClose: z
            .boolean()
            .optional()
            .describe("Claim fees and close the position. Requires removeSharePercent 100. Default false."),
          priorityFeeMicroLamports,
        },
        annotations,
      },
      async (args) => {
        try {
          const raw: Parameters<typeof buildRemoveLiquidity>[0] = {
            rpcUrl: args.rpcUrl,
            poolAddress: args.poolAddress,
            userPublicKey: args.userPublicKey,
            positionAddress: args.positionAddress,
            bps: Math.round(args.removeSharePercent * 100),
            shouldClaimAndClose: args.shouldClaimAndClose,
            priorityFeeMicroLamports: args.priorityFeeMicroLamports,
          };
          const hasWindow =
            args.lowerPrice !== undefined ||
            args.upperPrice !== undefined ||
            args.lowerBpsOffActive !== undefined ||
            args.upperBpsOffActive !== undefined;
          let window: PriceWindowResolved | null = null;
          if (hasWindow) {
            const ctx = await connectPool(resolveRpcUrl(args.rpcUrl), args.poolAddress);
            window = resolvePriceWindowOn(poolShape(ctx), {
              lowerPrice: args.lowerPrice,
              upperPrice: args.upperPrice,
              lowerBpsOffActive: args.lowerBpsOffActive,
              upperBpsOffActive: args.upperBpsOffActive,
            });
            raw.fromBinId = window.lowerBinId;
            raw.toBinId = window.upperBinId;
          }
          const built = await buildRemoveLiquidity(raw);
          return ok(withEcho(built, { ...windowEcho(window), requestedAmounts: null }));
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  server.registerTool(
    "build_claim_fees",
    {
      title: "Build an unsigned claim-fees transaction",
      description:
        "Build unsigned transactions that claim swap fees on an open position. " +
        "Set includeRewards true to also claim liquidity-mining rewards. The position stays open. Nothing is submitted.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        positionAddress,
        includeRewards: z.boolean().optional().describe("Also claim liquidity-mining rewards. Default false."),
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildClaimFees(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "build_close_position",
    {
      title: "Build an unsigned close-position transaction",
      description:
        "Build an unsigned transaction that closes a position which is already empty: no tokens and no unclaimed swap fees. " +
        "If it still holds liquidity, use build_remove_liquidity with removeSharePercent 100 and shouldClaimAndClose true instead. Nothing is submitted.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        positionAddress,
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildClosePosition(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "build_rebalance_position_raw",
    {
      title: "Build an unsigned rebalance transaction, raw bin ids and amounts",
      description:
        "Build unsigned transactions that withdraw the current range and redeposit into newLowerBinId..newUpperBinId on the same position. " +
        "This is the raw variant: bin ids are integers and top-up amounts are raw base-unit integer strings. " +
        "Most callers want build_rebalance_position, which takes decimal amounts and computes bin ids from decimal prices or bps off the active price. " +
        "With strategy bidAsk, no top-up, and both withdraw shares at 10000, this is the one-sided token-Y path: it redeposits the position's token Y, and a simulation that would deposit token X is refused unless allowTokenX is true. " +
        "Every other request withdraws the current range in full, then redeposits the share of each token that was not withdrawn plus any top-up, using the requested strategy. Claim flags default to false. " +
        "The rebalance transaction requests 1400000 compute units. reanchorTopToActiveBin pins the top of the new window to the active bin. Nothing is submitted.",
      inputSchema: {
        rpcUrl,
        poolAddress,
        userPublicKey,
        positionAddress,
        newLowerBinId: z.number().int().describe("Inclusive lower bin of the new range."),
        newUpperBinId: z.number().int().describe("Inclusive upper bin of the new range."),
        strategy: strategy.optional().describe("Shape for the redeposit. Default bidAsk."),
        topUpXRaw: z.string().optional().describe("Extra token X to add, raw integer string. Default 0."),
        topUpYRaw: z.string().optional().describe("Extra token Y to add, raw integer string. Default 0."),
        xWithdrawBps: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "Share of current token X that is not redeposited, out of 10000. Default 10000. The one-sided token-Y path still redeposits token Y when this is 10000.",
          ),
        yWithdrawBps: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            "Share of current token Y that is not redeposited, out of 10000. Default 10000. The one-sided token-Y path still redeposits token Y when this is 10000.",
          ),
        shouldClaimFee: z.boolean().optional().describe("Claim swap fees during the rebalance. Default false."),
        shouldClaimReward: z.boolean().optional().describe("Claim rewards during the rebalance. Default false."),
        allowTokenX: z
          .boolean()
          .optional()
          .describe("On the one-sided path, build even if the simulation deposits token X. Default false."),
        slippageBps,
        reanchorTopToActiveBin: z
          .boolean()
          .optional()
          .describe("Move the new window so its top bin is the active bin. Default false."),
        priorityFeeMicroLamports,
      },
      annotations,
    },
    async (args) => {
      try {
        return ok(await buildRebalancePosition(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (decimalEnabled) {
    server.registerTool(
      "build_rebalance_position",
      {
        title: "Build an unsigned rebalance transaction from decimal amounts and prices",
        description:
          "Build unsigned transactions that withdraw the current range and redeposit into a new range on the same position, from decimal inputs. " +
          "The new window comes from prices or bps off the current pool price, the same way build_open_position does a range. " +
          "topUpX and topUpY are decimal numbers of whole tokens. " +
          "With strategy bidAsk, no top-up, and both withdraw shares at 100 percent, this is the one-sided token-Y path: it redeposits the position's token Y, and a simulation that would deposit token X is refused unless allowTokenX is true. " +
          "Every other request withdraws the current range in full, or the shares set by xWithdrawPercent and yWithdrawPercent, then redeposits what was not withdrawn plus any top-up, using the requested strategy. Claim flags default to false. " +
          "The rebalance transaction requests 1400000 compute units. reanchorTopToActiveBin pins the top of the new window to the active bin. Nothing is submitted.",
        inputSchema: {
          rpcUrl,
          poolAddress,
          userPublicKey,
          positionAddress,
          newLowerPrice,
          newLowerBpsOffActive: newLowerBpsOffActive.optional(),
          newUpperPrice,
          newUpperBpsOffActive: newUpperBpsOffActive.optional(),
          strategy: strategy.optional().describe("Shape for the redeposit. Default bidAsk."),
          topUpXUi,
          topUpYUi,
          xWithdrawPercent: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Share of current token X that is not redeposited, in percent. Default 100. The one-sided token-Y path still redeposits token Y at 100."),
          yWithdrawPercent: z
            .number()
            .min(0)
            .max(100)
            .optional()
            .describe("Share of current token Y that is not redeposited, in percent. Default 100. The one-sided token-Y path still redeposits token Y at 100."),
          shouldClaimFee: z.boolean().optional().describe("Claim swap fees during the rebalance. Default false."),
          shouldClaimReward: z.boolean().optional().describe("Claim rewards during the rebalance. Default false."),
          allowTokenX: z
            .boolean()
            .optional()
            .describe("On the one-sided path, build even if the simulation deposits token X. Default false."),
          slippageBps,
          reanchorTopToActiveBin: z
            .boolean()
            .optional()
            .describe("Move the new window so its top bin is the active bin. Default false."),
          priorityFeeMicroLamports,
        },
        annotations,
      },
      async (args) => {
        try {
          const ctx = await connectPool(resolveRpcUrl(args.rpcUrl), args.poolAddress);
          const window = resolvePriceWindowOn(poolShape(ctx), {
            lowerPrice: args.newLowerPrice,
            upperPrice: args.newUpperPrice,
            lowerBpsOffActive: args.newLowerBpsOffActive,
            upperBpsOffActive: args.newUpperBpsOffActive,
          });
          const amounts = resolveUiAmounts(priceContext(ctx), { amountXUi: args.topUpXUi, amountYUi: args.topUpYUi });
          const built = await buildRebalancePosition({
            rpcUrl: args.rpcUrl,
            poolAddress: args.poolAddress,
            userPublicKey: args.userPublicKey,
            positionAddress: args.positionAddress,
            newLowerBinId: window.lowerBinId,
            newUpperBinId: window.upperBinId,
            strategy: args.strategy,
            topUpXRaw: amounts.amountXRaw,
            topUpYRaw: amounts.amountYRaw,
            xWithdrawBps: args.xWithdrawPercent === undefined ? undefined : Math.round(args.xWithdrawPercent * 100),
            yWithdrawBps: args.yWithdrawPercent === undefined ? undefined : Math.round(args.yWithdrawPercent * 100),
            shouldClaimFee: args.shouldClaimFee,
            shouldClaimReward: args.shouldClaimReward,
            allowTokenX: args.allowTokenX,
            slippageBps: args.slippageBps,
            reanchorTopToActiveBin: args.reanchorTopToActiveBin,
            priorityFeeMicroLamports: args.priorityFeeMicroLamports,
          });
          return ok(
            withEcho(built, {
              ...windowEcho(window),
              requestedAmounts: amountsEcho(ctx, { amountXUi: args.topUpXUi, amountYUi: args.topUpYUi }),
            }),
          );
        } catch (error) {
          return fail(error);
        }
      },
    );
  }

  return server;
}

/** Convert both window bounds with one pool snapshot passed explicitly. */
function resolvePriceWindowOn(
  pool: PoolShape,
  bounds: { lowerPrice?: number; upperPrice?: number; lowerBpsOffActive?: number; upperBpsOffActive?: number },
): PriceWindowResolved {
  return resolvePriceWindow(
    {
      binStep: pool.binStep,
      tokenXDecimals: pool.tokenX.decimals,
      tokenYDecimals: pool.tokenY.decimals,
      activeBinId: pool.activeBinId,
      activePriceRaw: pool.activePriceRaw,
    },
    bounds,
  );
}