import { Connection, PublicKey } from "@solana/web3.js";
import { DLMM } from "./sdk.js";
import { TxBuildError, errorText } from "./errors.js";
import { SOL_MINT, binRawRatioToTokenPrice } from "./invariants.js";
import { parsePublicKey } from "./parse.js";
import type { TokenInfo } from "./types.js";

export interface PoolContext {
  connection: Connection;
  sdk: DLMM;
  poolAddress: PublicKey;
  tokenX: TokenInfo;
  tokenY: TokenInfo;
  binStep: number;
  activeBinId: number;
  activePriceRaw: string;
  /** Human price of token X in token Y at the active bin. Display only. */
  activeTokenPrice: number;
}
type UserPositions = Awaited<ReturnType<DLMM["getPositionsByUserAndLbPair"]>>["userPositions"];
export type LoadedPosition = UserPositions[number];

function tokenInfo(mint: PublicKey, decimals: number): TokenInfo {
  const address = mint.toBase58();
  return { mint: address, decimals, isSol: address === SOL_MINT };
}

export async function connectPool(rpcUrl: string, poolAddress: string): Promise<PoolContext> {
  const poolKey = parsePublicKey(poolAddress, "poolAddress");
  const connection = new Connection(rpcUrl, "confirmed");
  let sdk: DLMM;
  try {
    sdk = await DLMM.create(connection, poolKey, { cluster: "mainnet-beta" });
    await sdk.refetchStates();
  } catch (error) {
    throw new TxBuildError(`Could not load DLMM pool ${poolAddress}. Nothing was submitted. ${errorText(error)}`);
  }
  const active = await sdk.getActiveBin();
  const activePriceRaw = String(active.price);
  const rawPrice = Number(activePriceRaw);
  return {
    connection,
    sdk,
    poolAddress: poolKey,
    tokenX: tokenInfo(sdk.tokenX.publicKey, sdk.tokenX.mint.decimals),
    tokenY: tokenInfo(sdk.tokenY.publicKey, sdk.tokenY.mint.decimals),
    binStep: sdk.lbPair.binStep,
    activeBinId: active.binId,
    activePriceRaw,
    activeTokenPrice: binRawRatioToTokenPrice(
      Number.isFinite(rawPrice) ? rawPrice : 0,
      sdk.tokenX.mint.decimals,
      sdk.tokenY.mint.decimals,
    ),
  };
}

export async function requireUserPosition(
  ctx: PoolContext,
  user: PublicKey,
  positionAddress: string,
): Promise<LoadedPosition> {
  parsePublicKey(positionAddress, "positionAddress");
  let positions: UserPositions;
  try {
    const loaded = await ctx.sdk.getPositionsByUserAndLbPair(user);
    positions = loaded.userPositions;
  } catch (error) {
    throw new TxBuildError(`Could not load positions for ${user.toBase58()}. ${errorText(error)}`);
  }
  const position = positions.find((candidate) => candidate.publicKey.toBase58() === positionAddress);
  if (!position) {
    throw new TxBuildError(
      `Position ${positionAddress} is not open for ${user.toBase58()} on pool ${ctx.poolAddress.toBase58()}.`,
    );
  }
  return position;
}

export async function existingAccounts(connection: Connection, addresses: string[]): Promise<Set<string>> {
  const unique = [...new Set(addresses)];
  const existing = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const slice = unique.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(slice.map((address) => new PublicKey(address)));
    slice.forEach((address, index) => {
      if (infos[index]) existing.add(address);
    });
  }
  return existing;
}
