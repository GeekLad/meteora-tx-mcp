import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("the server never submits or exports a signer secret", () => {
  it("source does not send transactions or read secret keys", () => {
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    const forbidden = [
      /sendRawTransaction/,
      /sendAndConfirm/,
      /sendBundle/,
      /sendTransaction\s*\(/,
      /requestAirdrop/,
      /secretKey/,
    ];
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
