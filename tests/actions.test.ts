import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenPosition, buildRemoveLiquidity } from "../src/actions.js";
import { resolveRpcUrl } from "../src/parse.js";

const payer = Keypair.generate().publicKey.toBase58();
const pool = Keypair.generate().publicKey.toBase58();

describe("validation happens before any RPC call", () => {
  const previous = process.env.SOLANA_RPC_URL;

  afterEach(() => {
    if (previous === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = previous;
  });

  it("rejects a decimal amount", async () => {
    await expect(
      buildOpenPosition({
        rpcUrl: "http://127.0.0.1:9",
        poolAddress: pool,
        userPublicKey: payer,
        lowerBinId: -10,
        upperBinId: 0,
        amountXRaw: "1.5",
        amountYRaw: "0",
        strategy: "bidAsk",
      }),
    ).rejects.toThrow(/base-unit/);
  });

  it("rejects an empty deposit", async () => {
    await expect(
      buildOpenPosition({
        rpcUrl: "http://127.0.0.1:9",
        poolAddress: pool,
        userPublicKey: payer,
        lowerBinId: 0,
        upperBinId: 10,
        amountXRaw: "0",
        amountYRaw: "0",
        strategy: "spot",
      }),
    ).rejects.toThrow(/zero/);
  });

  it("rejects a window past 1400 bins", async () => {
    await expect(
      buildOpenPosition({
        rpcUrl: "http://127.0.0.1:9",
        poolAddress: pool,
        userPublicKey: payer,
        lowerBinId: 0,
        upperBinId: 1400,
        amountXRaw: "1",
        amountYRaw: "0",
        strategy: "curve",
      }),
    ).rejects.toThrow(/1401 bins/);
  });

  it("rejects a partial remove that also closes", async () => {
    await expect(
      buildRemoveLiquidity({
        rpcUrl: "http://127.0.0.1:9",
        poolAddress: pool,
        userPublicKey: payer,
        positionAddress: pool,
        bps: 5000,
        shouldClaimAndClose: true,
      }),
    ).rejects.toThrow(/leave the position open/);
  });

  it("does not fall through an empty rpcUrl to the environment", () => {
    process.env.SOLANA_RPC_URL = "https://example.invalid";
    expect(() => resolveRpcUrl("")).toThrow(/No RPC URL/);
    expect(resolveRpcUrl(undefined)).toBe("https://example.invalid");
  });
});
