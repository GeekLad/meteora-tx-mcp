import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { packageLegacyTransactions } from "../src/packageTx.js";

function recentBlockhash() {
  return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 250_000_000 };
}

function lookupTable(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses,
    },
  });
}

function requireSigners(payer: PublicKey, extra: PublicKey[]): Transaction {
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        ...extra.map((pubkey) => ({ pubkey, isSigner: true, isWritable: true })),
      ],
      data: Buffer.alloc(0),
    }),
  );
  return tx;
}

describe("packageLegacyTransactions", () => {
  it("partial-signs the position key and leaves the fee payer empty", () => {
    const payer = Keypair.generate();
    const position = Keypair.generate();
    const hash = recentBlockhash();
    const packaged = packageLegacyTransactions({
      payer: payer.publicKey,
      transactions: [requireSigners(payer.publicKey, [position.publicKey])],
      labels: ["create position"],
      ephemeralSigners: [position],
      recentBlockhash: hash,
      lookupTable: null,
      priorityFeeMicroLamports: 200_000,
      computeUnitLimit: 1_400_000,
    });

    const tx = packaged.transactions[0]!;
    expect(tx.version).toBe("v0");
    expect(tx.feePayer).toBe(payer.publicKey.toBase58());
    expect(tx.signedBy).toEqual([position.publicKey.toBase58()]);
    expect(tx.unsignedSigners).toEqual([payer.publicKey.toBase58()]);
    expect(tx.computeUnitLimit).toBe(1_400_000);
    expect(tx.priorityFeeMicroLamports).toBe(200_000);
    expect(packaged.recentBlockhash).toBe(hash.blockhash);
    expect(packaged.submitInOrder).toBe(true);

    const signed = VersionedTransaction.deserialize(Buffer.from(tx.base64, "base64"));
    const required = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
    const payerIndex = required.findIndex((key) => key.equals(payer.publicKey));
    const positionIndex = required.findIndex((key) => key.equals(position.publicKey));
    expect(Buffer.from(signed.signatures[payerIndex]!).equals(Buffer.alloc(64))).toBe(true);
    expect(Buffer.from(signed.signatures[positionIndex]!).equals(Buffer.alloc(64))).toBe(false);
    signed.sign([payer]);
    expect(Buffer.from(signed.signatures[payerIndex]!).equals(Buffer.alloc(64))).toBe(false);
    expect(Buffer.from(signed.signatures[positionIndex]!).equals(Buffer.alloc(64))).toBe(false);
  });

  it("refuses to sign the fee payer", () => {
    const payer = Keypair.generate();
    expect(() =>
      packageLegacyTransactions({
        payer: payer.publicKey,
        transactions: [requireSigners(payer.publicKey, [])],
        labels: ["transfer"],
        ephemeralSigners: [payer],
        recentBlockhash: recentBlockhash(),
        lookupTable: null,
        priorityFeeMicroLamports: 0,
      }),
    ).toThrow(/fee payer/);
  });

  it("rejects an extra required signer it cannot partial-sign", () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    expect(() =>
      packageLegacyTransactions({
        payer: payer.publicKey,
        transactions: [requireSigners(payer.publicKey, [other.publicKey])],
        labels: ["needs another signer"],
        recentBlockhash: recentBlockhash(),
        lookupTable: null,
        priorityFeeMicroLamports: 0,
      }),
    ).toThrow(/not the fee payer/);
  });

  it("replaces a compute-unit limit and leaves an existing one when asked", () => {
    const payer = Keypair.generate();
    const seeded = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }),
    );
    const before = seeded.instructions.length;
    const replaced = packageLegacyTransactions({
      payer: payer.publicKey,
      transactions: [seeded],
      labels: ["rebalance"],
      recentBlockhash: recentBlockhash(),
      lookupTable: null,
      priorityFeeMicroLamports: 200_000,
      budgets: [{ limit: 1_400_000, replace: true }],
    });
    expect(seeded.instructions).toHaveLength(before);
    expect(replaced.transactions[0]!.computeUnitLimit).toBe(1_400_000);

    const kept = packageLegacyTransactions({
      payer: payer.publicKey,
      transactions: [seeded],
      labels: ["keep"],
      recentBlockhash: recentBlockhash(),
      lookupTable: null,
      priorityFeeMicroLamports: 0,
      budgets: [{ limit: 1_400_000, replace: false }],
    });
    expect(kept.transactions[0]!.computeUnitLimit).toBe(50_000);
    expect(kept.transactions[0]!.priorityFeeMicroLamports).toBeNull();

    const message = TransactionMessage.decompile(
      VersionedTransaction.deserialize(Buffer.from(replaced.transactions[0]!.base64, "base64")).message,
    );
    const limits = message.instructions.filter(
      (instruction) => instruction.programId.equals(ComputeBudgetProgram.programId) && instruction.data[0] === 2,
    );
    expect(limits).toHaveLength(1);
    expect(Buffer.from(limits[0]!.data).readUInt32LE(1)).toBe(1_400_000);
  });

  it("rejects a transaction over 1232 bytes and fits the same accounts through a lookup table", () => {
    const payer = Keypair.generate();
    const extras = Array.from({ length: 40 }, () => Keypair.generate().publicKey);
    const wide = new Transaction().add(
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          ...extras.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ],
        data: Buffer.alloc(8),
      }),
    );
    const base = {
      payer: payer.publicKey,
      transactions: [wide],
      labels: ["wide"],
      recentBlockhash: recentBlockhash(),
      priorityFeeMicroLamports: 0,
      computeUnitLimit: null,
    };
    expect(() => packageLegacyTransactions({ ...base, lookupTable: null })).toThrow(/1232/);
    const packed = packageLegacyTransactions({ ...base, lookupTable: lookupTable(extras) });
    expect(packed.transactions[0]!.bytes).toBeLessThanOrEqual(1232);
    expect(packed.lookupTableAddress).toBeTruthy();
    const message = VersionedTransaction.deserialize(Buffer.from(packed.transactions[0]!.base64, "base64")).message;
    expect(message.addressTableLookups.length).toBe(1);
  });
});
