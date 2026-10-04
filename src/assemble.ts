import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TxBuildError } from "./errors.js";
import {
  accountInitTarget,
  dropRedundantAccountInits,
  isInitializePosition2,
  stripRepeatedPositionInits,
} from "./invariants.js";

export interface OpenGroup {
  positionKeypair: Keypair;
  transactionInstructions: TransactionInstruction[][];
}

export interface AssembledOpen {
  transactions: Transaction[];
  /** Position keypairs, in group order. Partial-signed, then discarded. */
  signers: Keypair[];
  positionAddresses: string[];
  labels: string[];
}

/** Accounts an open bundle would initialize, after repeated position creates are stripped. */
export function referencedInitAccounts(groups: OpenGroup[]): string[] {
  const accounts: string[] = [];
  for (const group of groups) {
    for (const ixs of stripRepeatedPositionInits(group.transactionInstructions)) {
      for (const ix of ixs) {
        const account = accountInitTarget(ix);
        if (account) accounts.push(account);
      }
    }
  }
  return accounts;
}

/**
 * One ordered transaction list for every position group. Repeated position
 * creates stay on the first chunk of each position. Bin-array inits that
 * already exist, or that an earlier transaction in the whole list creates,
 * are dropped — including across positions.
 */
export function assembleOpenGroups(groups: OpenGroup[], existing: ReadonlySet<string>): AssembledOpen {
  if (groups.length === 0) throw new TxBuildError("The SDK returned no position groups.");

  const stripped = groups.map((group) => ({
    position: group.positionKeypair.publicKey,
    lists: stripRepeatedPositionInits(group.transactionInstructions),
  }));
  const flat: { position: PublicKey; ixs: TransactionInstruction[] }[] = [];
  for (const group of stripped) {
    for (const ixs of group.lists) flat.push({ position: group.position, ixs });
  }

  const dropped = dropRedundantAccountInits(
    flat.map((row) => row.ixs),
    existing,
  );
  const kept = dropped
    .map((ixs, index) => ({ position: flat[index]!.position, ixs }))
    .filter((row) => row.ixs.length > 0);
  if (kept.length === 0) throw new TxBuildError("Open assembly produced no instructions.");

  const totals = new Map<string, number>();
  for (const row of kept) {
    const key = row.position.toBase58();
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels = kept.map((row) => {
    const key = row.position.toBase58();
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    const count = totals.get(key) ?? 1;
    const stem = row.ixs.some(isInitializePosition2)
      ? `create position ${key} and deposit`
      : `deposit into ${key}`;
    return count === 1 ? stem : `${stem} (${index}/${count})`;
  });

  const transactions = kept.map((row) => {
    const tx = new Transaction();
    tx.add(...row.ixs);
    return tx;
  });

  return {
    transactions,
    signers: groups.map((group) => group.positionKeypair),
    positionAddresses: groups.map((group) => group.positionKeypair.publicKey.toBase58()),
    labels,
  };
}
