import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { TxBuildError } from "./errors.js";

export function resolveRpcUrl(override?: string): string {
  const url = (override !== undefined ? override : (process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "")).trim();
  if (!url) {
    throw new TxBuildError("No RPC URL. Pass rpcUrl or set SOLANA_RPC_URL. Nothing was built or submitted.");
  }
  return url;
}

export function parsePublicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new TxBuildError(`${field} is not a base58 public key`);
  }
}

export function generateKeypair(): Keypair {
  return Keypair.generate();
}

/** Raw token units as a decimal integer string. `1.5` and `1e9` are rejected. */
export function parseRawAmount(value: string, field: string): { raw: string; bn: BN } {
  if (!/^\d+$/.test(value)) {
    throw new TxBuildError(`${field} must be a base-unit integer string, got ${value}`);
  }
  const bn = new BN(value, 10);
  return { raw: bn.toString(), bn };
}

/**
 * A human decimal token amount, e.g. "1.5", converted to the base-unit
 * integer string the raw builders take. Exponent notation and negatives are
 * refused because an LLM that wants them is confusing two scales.
 */
export function parseUiAmountToRaw(value: string, decimals: number, field: string): string {
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new TxBuildError(
      `${field} must be a non-negative decimal token amount like "1.5", got ${value}. Exponent notation and negatives are refused.`,
    );
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new TxBuildError(
      `${field} is too precise: the token has ${decimals} decimal places, and ${text} has ${fraction.length}. The extra digits would be discarded.`,
    );
  }
  if (whole.length > 15) {
    throw new TxBuildError(
      `${field} is too large for exact whole-token arithmetic. Use the _raw tool with a base-unit integer string.`,
    );
  }
  if (/^0+(\.0+)?$/.test(text)) return "0";
  const scale = 10 ** decimals;
  const scaled = Number(text) * scale;
  if (!Number.isSafeInteger(scaled)) {
    throw new TxBuildError(
      `${field} is ${text}, which becomes more than 2^53 base units at ${decimals} decimals. Use the _raw tool with a base-unit integer string.`,
    );
  }
  const digits = BigInt(Math.round(scaled)).toString();
  if (digits === "0") {
    throw new TxBuildError(
      `${field} is ${text}, which is below one base unit at ${decimals} decimals and would deposit nothing. Use a bigger amount or the _raw tool.`,
    );
  }
  return digits;
}

export function asBn(value: unknown): BN {
  if (BN.isBN(value)) return value;
  if (typeof value === "bigint") return new BN(value.toString(), 10);
  if (typeof value === "number" && Number.isFinite(value)) return new BN(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return new BN(value, 10);
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(value);
    if (/^-?\d+$/.test(text)) return new BN(text, 10);
  }
  return new BN(0);
}