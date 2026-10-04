import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ABSOLUTE_MAX_BINS,
  MAX_BINS_PER_EXTENDED_POSITION,
  MAX_TRANSACTIONS,
  OPEN_IX_DISC,
  SLICE_MAX_BINS,
  accountInitTarget,
  chunkBinRange,
  formatRawAmount,
  parsePriorityFee,
  parseRemoveBps,
  positionWindows,
  reanchorBelowActive,
  redundantInitIndexes,
  sdkSlippagePercent,
  strategyTypeValue,
  stripRepeatedPositionInits,
  validateBinWindow,
} from "../src/invariants.js";

function ix(disc: Buffer, account?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PublicKey.default,
    keys: account
      ? [
          { pubkey: account, isSigner: false, isWritable: true },
          { pubkey: account, isSigner: false, isWritable: true },
        ]
      : [],
    data: Buffer.from(disc),
  });
}

describe("chunkBinRange", () => {
  it("splits 280 bins into 4 chunks of 70", () => {
    expect(chunkBinRange(-140, 139)).toEqual([
      [-140, -71],
      [-70, -1],
      [0, 69],
      [70, 139],
    ]);
  });

  it("splits an uneven count without overlap", () => {
    const parts = chunkBinRange(0, 278);
    expect(parts).toHaveLength(4);
    expect(parts[3]![1] - parts[3]![0] + 1).toBe(69);
    for (let i = 1; i < parts.length; i++) expect(parts[i]![0]).toBe(parts[i - 1]![1] + 1);
  });

  it("covers a book that fits in one chunk", () => {
    expect(chunkBinRange(-30, 39)).toEqual([[-30, 39]]);
  });

  it("stays inside a bundle-sized book and the absolute maximum", () => {
    for (const nBins of [100, 186, 231, 240, 280]) {
      const chunks = chunkBinRange(0, nBins - 1);
      expect(chunks.length).toBeLessThanOrEqual(4);
      for (const [lo, hi] of chunks) expect(hi - lo + 1).toBeLessThanOrEqual(SLICE_MAX_BINS);
      expect(chunks[0]![0]).toBe(0);
      expect(chunks.at(-1)![1]).toBe(nBins - 1);
    }
    const full = positionWindows(0, ABSOLUTE_MAX_BINS - 1);
    const txs = full.reduce((sum, [lo, hi]) => sum + chunkBinRange(lo, hi).length, 0);
    expect(full).toHaveLength(3);
    expect(txs).toBeLessThanOrEqual(MAX_TRANSACTIONS);
    expect(MAX_BINS_PER_EXTENDED_POSITION).toBe(525);
  });
});

describe("strategy and slippage", () => {
  it("pins Spot, Curve, and BidAsk to 0, 1, and 2", () => {
    expect(strategyTypeValue("spot")).toBe(0);
    expect(strategyTypeValue("curve")).toBe(1);
    expect(strategyTypeValue("bidAsk")).toBe(2);
  });

  it("converts basis points to the SDK percent", () => {
    expect(sdkSlippagePercent(1500)).toBe(15);
    expect(Math.ceil(sdkSlippagePercent(1500) / (80 / 100))).toBe(19);
    expect(Math.ceil(0.15 / (80 / 100))).toBe(1);
    expect(() => sdkSlippagePercent(0.15)).toThrow(/slippageBps/);
    expect(() => sdkSlippagePercent(10_001)).toThrow(/slippageBps/);
  });
});

describe("reanchorBelowActive", () => {
  it("keeps a window whose top is already the active bin", () => {
    expect(reanchorBelowActive(-279, 0, 0)).toEqual({ lowerBinId: -279, upperBinId: 0 });
  });

  it("slides the width so the top bin follows the active bin", () => {
    expect(reanchorBelowActive(-279, 0, -10)).toEqual({ lowerBinId: -289, upperBinId: -10 });
    expect(reanchorBelowActive(-279, 0, 5)).toEqual({ lowerBinId: -274, upperBinId: 5 });
  });
});

describe("open instruction cleanup", () => {
  it("keeps initializePosition2 and extends on the first transaction only", () => {
    const deposit = ix(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const init = ix(OPEN_IX_DISC.initPosition2);
    const extend = ix(OPEN_IX_DISC.increasePositionLength2);
    const out = stripRepeatedPositionInits([
      [init, extend, deposit],
      [init, extend, deposit],
      [init, extend, deposit],
    ]);
    expect(out[0]).toHaveLength(3);
    expect(out[1]).toEqual([deposit]);
    expect(out[2]).toEqual([deposit]);
  });

  it("reads the created account from key index 1", () => {
    const created = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const instruction = new TransactionInstruction({
      programId: PublicKey.default,
      keys: [
        { pubkey: other, isSigner: false, isWritable: true },
        { pubkey: created, isSigner: false, isWritable: true },
      ],
      data: OPEN_IX_DISC.initBinArray,
    });
    expect(accountInitTarget(instruction)).toBe(created.toBase58());
    expect(accountInitTarget(ix(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])))).toBeNull();
  });

  it("drops inits that already exist or were created earlier", () => {
    const drop = redundantInitIndexes(
      [
        { tx: 0, ix: 2, account: "already" },
        { tx: 0, ix: 3, account: "fresh" },
        { tx: 1, ix: 1, account: "fresh" },
        { tx: 1, ix: 2, account: "other" },
      ],
      new Set(["already"]),
    );
    expect(drop).toEqual(new Set(["0:2", "1:1"]));
  });
});

describe("input bounds", () => {
  it("rejects an over-wide or inverted window", () => {
    expect(validateBinWindow(0, 1399)).toBe(1400);
    expect(() => validateBinWindow(0, 1400)).toThrow(/1401 bins/);
    expect(() => validateBinWindow(2, 1)).toThrow(/above/);
  });

  it("allows a full remove to stay open, and requires a full remove to close", () => {
    expect(parseRemoveBps(10_000, false)).toBe(10_000);
    expect(parseRemoveBps(10_000, true)).toBe(10_000);
    expect(() => parseRemoveBps(5_000, true)).toThrow(/leave the position open/);
    expect(() => parseRemoveBps(0, false)).toThrow(/bps/);
  });

  it("caps the priority fee", () => {
    expect(parsePriorityFee(undefined)).toBe(200_000);
    expect(parsePriorityFee(0)).toBe(0);
    expect(() => parsePriorityFee(5_000_001)).toThrow(/priorityFeeMicroLamports/);
  });

  it("formats raw token units without floating point", () => {
    expect(formatRawAmount("1000000000", 9)).toBe("1");
    expect(formatRawAmount("1500000000", 9)).toBe("1.5");
    expect(formatRawAmount("1", 9)).toBe("0.000000001");
    expect(formatRawAmount("0", 9)).toBe("0");
    expect(formatRawAmount("1010000000", 9)).toBe("1.01");
  });
});
