import type { BuiltAction, TokenInfo } from "./types.js";

export function tokenLabel(token: TokenInfo): string {
  return token.isSol ? "SOL" : `token ${token.mint}`;
}

export function formatBuilt(built: BuiltAction): string {
  const warnings = built.warnings.length === 0 ? "" : `${built.warnings.map((warning) => `Warning: ${warning}`).join("\n")}\n\n`;
  return `${built.summary}\n\n${warnings}${JSON.stringify(built, null, 2)}`;
}
