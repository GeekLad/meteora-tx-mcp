import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { assembleOpenGroups } from "../src/assemble.js";
import { OPEN_IX_DISC } from "../src/invariants.js";

function ix(data: Buffer, accounts: PublicKey[] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: PublicKey.default,
    keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data,
  });
}

const deposit = ix(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

describe("assembleOpenGroups", () => {
  it("keeps position create on the first chunk and drops the repeats", () => {
    const position = Keypair.generate();
    const init = ix(OPEN_IX_DISC.initPosition2);
    const extend = ix(OPEN_IX_DISC.increasePositionLength2);
    const assembled = assembleOpenGroups(
      [
        {
          positionKeypair: position,
          transactionInstructions: [
            [init, extend, deposit],
            [init, extend, deposit],
          ],
        },
      ],
      new Set(),
    );
    expect(assembled.transactions).toHaveLength(2);
    expect(assembled.transactions[0]!.instructions).toHaveLength(3);
    expect(assembled.transactions[1]!.instructions).toEqual([deposit]);
    expect(assembled.labels[0]).toContain("create position");
    expect(assembled.labels[1]).toContain("deposit into");
    expect(assembled.positionAddresses).toEqual([position.publicKey.toBase58()]);
  });

  it("drops a bin-array init the previous position already creates", () => {
    const bin = Keypair.generate().publicKey;
    const first = Keypair.generate();
    const second = Keypair.generate();
    const initBin = ix(OPEN_IX_DISC.initBinArray, [PublicKey.default, bin]);
    const assembled = assembleOpenGroups(
      [
        {
          positionKeypair: first,
          transactionInstructions: [[ix(OPEN_IX_DISC.initPosition2), initBin, deposit]],
        },
        {
          positionKeypair: second,
          transactionInstructions: [[ix(OPEN_IX_DISC.initPosition2), initBin, deposit]],
        },
      ],
      new Set(),
    );
    const hasBinInit = (index: number) =>
      assembled.transactions[index]!.instructions.some((instruction) =>
        Buffer.from(instruction.data.subarray(0, 8)).equals(OPEN_IX_DISC.initBinArray),
      );
    expect(hasBinInit(0)).toBe(true);
    expect(hasBinInit(1)).toBe(false);
    expect(assembled.transactions[1]!.instructions.some((instruction) =>
      Buffer.from(instruction.data.subarray(0, 8)).equals(OPEN_IX_DISC.initPosition2),
    )).toBe(true);
  });

  it("drops a bin-array init that is already on chain", () => {
    const bin = Keypair.generate().publicKey;
    const position = Keypair.generate();
    const assembled = assembleOpenGroups(
      [
        {
          positionKeypair: position,
          transactionInstructions: [[ix(OPEN_IX_DISC.initPosition2), ix(OPEN_IX_DISC.initBinArray, [PublicKey.default, bin]), deposit]],
        },
      ],
      new Set([bin.toBase58()]),
    );
    expect(assembled.transactions[0]!.instructions.map((instruction) => Buffer.from(instruction.data))).toEqual([
      OPEN_IX_DISC.initPosition2,
      deposit.data,
    ]);
  });
});
