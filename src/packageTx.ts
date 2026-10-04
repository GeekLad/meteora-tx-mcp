import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TxBuildError, errorText } from "./errors.js";

export const SIGNING_NOTE =
  "The fee payer has not signed these transactions and this server did not submit them. " +
  "Sign with that wallet and submit in order before the blockhash expires. " +
  "Ephemeral position signatures, when present, are bound to this blockhash; rebuild if it expires.";

export interface ComputeBudget {
  limit: number | null;
  replace: boolean;
}

export interface PackagedTransaction {
  index: number;
  label: string;
  /** Base64 version-0 transaction. Deserialize with VersionedTransaction.deserialize. */
  base64: string;
  version: "v0";
  feePayer: string;
  requiredSigners: string[];
  /** Ephemeral keys already signed. The fee payer is never in this list. */
  signedBy: string[];
  /** Keys the wallet still has to sign. This is the fee payer. */
  unsignedSigners: string[];
  computeUnitLimit: number | null;
  priorityFeeMicroLamports: number | null;
  bytes: number;
}

export interface UnsignedTxPackage {
  feePayer: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  blockhashCommitment: "confirmed";
  lookupTableAddress: string | null;
  submitInOrder: true;
  note: string;
  transactions: PackagedTransaction[];
}

export interface PackageInput {
  payer: PublicKey;
  transactions: Transaction[];
  labels: string[];
  ephemeralSigners?: Keypair[];
  recentBlockhash: { blockhash: string; lastValidBlockHeight: number };
  lookupTable: AddressLookupTableAccount | null;
  priorityFeeMicroLamports: number;
  /** Used for every transaction when `budgets` is omitted. */
  computeUnitLimit?: number | null;
  replaceComputeUnitLimit?: boolean;
  budgets?: ComputeBudget[];
}

const COMPUTE_BUDGET = ComputeBudgetProgram.programId;

function isComputeUnitLimit(ix: TransactionInstruction): boolean {
  return ix.programId.equals(COMPUTE_BUDGET) && ix.data.length > 0 && ix.data[0] === 2;
}

function isComputeUnitPrice(ix: TransactionInstruction): boolean {
  return ix.programId.equals(COMPUTE_BUDGET) && ix.data.length > 0 && ix.data[0] === 3;
}

function isZeroSignature(signature: Uint8Array): boolean {
  for (const byte of signature) if (byte !== 0) return false;
  return true;
}

function applyComputeBudget(
  instructions: TransactionInstruction[],
  priorityFeeMicroLamports: number,
  budget: ComputeBudget,
): TransactionInstruction[] {
  let next = budget.replace ? instructions.filter((ix) => !isComputeUnitLimit(ix)) : [...instructions];
  const hasLimit = next.some(isComputeUnitLimit);
  if (budget.limit != null && (budget.replace || !hasLimit)) {
    next = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: budget.limit }),
      ...next.filter((ix) => !isComputeUnitLimit(ix)),
    ];
  }
  if (priorityFeeMicroLamports > 0 && !next.some(isComputeUnitPrice)) {
    next = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }), ...next];
  }
  return next;
}

function oversizedMessage(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /overruns Uint8Array|transaction too large|1232/i.test(text);
}

function packetTooBig(index: number, lookupTable: AddressLookupTableAccount | null, error: unknown): TxBuildError {
  const table = lookupTable
    ? `The address lookup table ${lookupTable.key.toBase58()} was applied.`
    : "No address lookup table was applied.";
  return new TxBuildError(
    `Transaction ${index} does not fit in a ${PACKET_DATA_SIZE}-byte packet. ${table} Narrow the bin window. ${errorText(error)}`,
  );
}

function readU32(data: Uint8Array): number {
  return Buffer.from(data).readUInt32LE(1);
}

function readU64(data: Uint8Array): number {
  return Number(Buffer.from(data).readBigUInt64LE(1));
}

/**
 * Compile legacy instruction lists into version-0 transactions a wallet can sign.
 * Ephemeral position keypairs are partial-signed here. The fee payer is not.
 */
export function packageLegacyTransactions(input: PackageInput): UnsignedTxPackage {
  if (input.transactions.length === 0) throw new TxBuildError("No transactions to package.");
  if (input.labels.length !== input.transactions.length) {
    throw new TxBuildError(
      `Expected ${input.transactions.length} labels, got ${input.labels.length}.`,
    );
  }
  const ephemeral = input.ephemeralSigners ?? [];
  for (const signer of ephemeral) {
    if (signer.publicKey.equals(input.payer)) {
      throw new TxBuildError("Refusing to sign the fee payer. The wallet signs that key.");
    }
  }

  const transactions: PackagedTransaction[] = input.transactions.map((tx, index) => {
    const budget = input.budgets?.[index] ?? {
      limit: input.computeUnitLimit ?? null,
      replace: input.replaceComputeUnitLimit ?? false,
    };
    const instructions = applyComputeBudget([...tx.instructions], input.priorityFeeMicroLamports, budget);
    let message: ReturnType<TransactionMessage["compileToV0Message"]>;
    try {
      message = new TransactionMessage({
        payerKey: input.payer,
        recentBlockhash: input.recentBlockhash.blockhash,
        instructions,
      }).compileToV0Message(input.lookupTable ? [input.lookupTable] : undefined);
    } catch (error) {
      if (!oversizedMessage(error)) throw error;
      throw packetTooBig(index, input.lookupTable, error);
    }
    const versioned = new VersionedTransaction(message);
    const required = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
    const requiredKeys = required.map((key) => key.toBase58());
    const payerKey = input.payer.toBase58();
    if (!requiredKeys.includes(payerKey)) {
      throw new TxBuildError(`Transaction ${index} does not require the fee payer ${payerKey} to sign.`);
    }
    const needed = ephemeral.filter((signer) => requiredKeys.includes(signer.publicKey.toBase58()));
    if (needed.length > 0) versioned.sign(needed);
    const payerIndex = requiredKeys.indexOf(payerKey);
    if (!isZeroSignature(versioned.signatures[payerIndex]!)) {
      throw new TxBuildError("Fee payer signature was set. This server must leave it empty.");
    }
    const signedBy: string[] = [];
    const unsignedSigners: string[] = [];
    requiredKeys.forEach((key, signerIndex) => {
      if (isZeroSignature(versioned.signatures[signerIndex]!)) unsignedSigners.push(key);
      else signedBy.push(key);
    });
    const unexpected = unsignedSigners.filter((key) => key !== payerKey);
    if (unexpected.length > 0) {
      throw new TxBuildError(
        `Transaction ${index} still needs a signature from ${unexpected.join(", ")}, which is not the fee payer.`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(versioned.serialize());
    } catch (error) {
      if (!oversizedMessage(error)) throw error;
      throw packetTooBig(index, input.lookupTable, error);
    }
    if (bytes.length > PACKET_DATA_SIZE) {
      const table = input.lookupTable
        ? `The address lookup table ${input.lookupTable.key.toBase58()} was applied.`
        : "No address lookup table was applied.";
      throw new TxBuildError(
        `Transaction ${index} is ${bytes.length} bytes, over the ${PACKET_DATA_SIZE}-byte packet limit. ${table} Narrow the bin window.`,
      );
    }
    const limitIx = instructions.find(isComputeUnitLimit);
    const priceIx = instructions.find(isComputeUnitPrice);
    return {
      index,
      label: input.labels[index]!,
      base64: bytes.toString("base64"),
      version: "v0",
      feePayer: payerKey,
      requiredSigners: requiredKeys,
      signedBy,
      unsignedSigners,
      computeUnitLimit: limitIx ? readU32(limitIx.data) : null,
      priorityFeeMicroLamports: priceIx ? readU64(priceIx.data) : null,
      bytes: bytes.length,
    };
  });

  return {
    feePayer: input.payer.toBase58(),
    recentBlockhash: input.recentBlockhash.blockhash,
    lastValidBlockHeight: input.recentBlockhash.lastValidBlockHeight,
    blockhashCommitment: "confirmed",
    lookupTableAddress: input.lookupTable?.key.toBase58() ?? null,
    submitInOrder: true,
    note: SIGNING_NOTE,
    transactions,
  };
}

export async function packageForWallet(
  input: Omit<PackageInput, "recentBlockhash" | "lookupTable"> & {
    connection: Connection;
    lookupTableAddress: PublicKey | null;
  },
): Promise<{ package: UnsignedTxPackage; warnings: string[] }> {
  const warnings: string[] = [];
  let recentBlockhash: { blockhash: string; lastValidBlockHeight: number };
  try {
    recentBlockhash = await input.connection.getLatestBlockhash("confirmed");
  } catch (error) {
    throw new TxBuildError(`Could not fetch a recent blockhash. Nothing was submitted. ${errorText(error)}`);
  }

  let lookupTable: AddressLookupTableAccount | null = null;
  if (input.lookupTableAddress) {
    const address = input.lookupTableAddress.toBase58();
    try {
      const loaded = await input.connection.getAddressLookupTable(input.lookupTableAddress);
      lookupTable = loaded.value;
      if (!lookupTable) {
        warnings.push(`Address lookup table ${address} was not found. Transactions are packed without it.`);
      }
    } catch (error) {
      warnings.push(
        `Could not load address lookup table ${address} (${errorText(error)}). Transactions are packed without it.`,
      );
    }
  }

  return {
    package: packageLegacyTransactions({ ...input, recentBlockhash, lookupTable }),
    warnings,
  };
}
