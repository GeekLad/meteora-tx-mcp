import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

/** Shared by both modes; the only tools with nothing to convert. */
const SHARED_TOOLS = ["build_claim_fees", "build_close_position"];

const DECIMAL_TOOLS = [
  "build_add_liquidity",
  "build_open_position",
  "build_rebalance_position",
  "build_remove_liquidity",
];

const RAW_TOOLS = [
  "build_add_liquidity_raw",
  "build_open_position_raw",
  "build_rebalance_position_raw",
  "build_remove_liquidity_raw",
];

async function connectedClient(options: { rawOnly?: boolean } = {}) {
  const server = createServer(options);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("meteora-tx MCP", () => {
  it("lists both tool families and does not list a send tool by default", async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...SHARED_TOOLS, ...DECIMAL_TOOLS, ...RAW_TOOLS].sort());
    expect(names.filter((name) => !name.startsWith("build_"))).toEqual([]);
    await client.close();
  });

  it("serves only the _raw tools when rawOnly is set", async () => {
    const client = await connectedClient({ rawOnly: true });
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...SHARED_TOOLS, ...RAW_TOOLS].sort());
    expect(names).not.toContain("build_open_position");
    await client.close();
  });

  it("hides the decimal tools entirely when rawOnly is set", async () => {
    const client = await connectedClient({ rawOnly: true });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [...DECIMAL_TOOLS]) {
      expect(names, `${name} must be unregistered in raw-only mode`).not.toContain(name);
    }
    // A hidden tool is refused, not silent: calling it must fail cleanly.
    const result = await client.callTool({
      name: "build_open_position",
      arguments: {
        poolAddress: "So11111111111111111111111111111111111111112",
        userPublicKey: "So11111111111111111111111111111111111111112",
        lowerPrice: 1,
        upperPrice: 2,
        amountXUi: "0",
        amountYUi: "1",
        strategy: "bidAsk",
      },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/not found|MCP error -32602/i);
    await client.close();
  });

  it("keeps the shared claim and close tools working in raw-only mode", async () => {
    const client = await connectedClient({ rawOnly: true });
    const result = await client.callTool({
      name: "build_claim_fees",
      arguments: {
        rpcUrl: "",
        poolAddress: "So11111111111111111111111111111111111111112",
        userPublicKey: "So11111111111111111111111111111111111111112",
        positionAddress: "So11111111111111111111111111111111111111112",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/No RPC URL/);
    await client.close();
  });

  it("returns a tool error when no RPC is configured", async () => {
    const client = await connectedClient();
    for (const [name, extra] of [
      ["build_open_position_raw", { lowerBinId: -5, upperBinId: 0, amountXRaw: "0", amountYRaw: "1000000", strategy: "bidAsk" }],
      ["build_open_position", { lowerPrice: 1, upperPrice: 2, amountXUi: "0", amountYUi: "1", strategy: "bidAsk" }],
      ["build_add_liquidity_raw", { positionAddress: "x", amountXRaw: "0", amountYRaw: "1", strategy: "bidAsk" }],
      ["build_add_liquidity", { positionAddress: "x", amountXUi: "0", amountYUi: "1", strategy: "bidAsk" }],
      ["build_remove_liquidity_raw", { positionAddress: "x", bps: 1000 }],
      ["build_remove_liquidity", { positionAddress: "x", removeSharePercent: 10 }],
      ["build_rebalance_position_raw", { positionAddress: "x", newLowerBinId: -5, newUpperBinId: 0, strategy: "bidAsk" }],
      ["build_rebalance_position", { positionAddress: "x", newLowerPrice: 1, newUpperPrice: 2, strategy: "bidAsk" }],
    ] as const) {
      const result = await client.callTool({
        name,
        arguments: {
          rpcUrl: "",
          poolAddress: "So11111111111111111111111111111111111111112",
          userPublicKey: "So11111111111111111111111111111111111111112",
          ...extra,
        },
      });
      expect(result.isError, `${name} should fail with an error result`).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text, `${name} should hide the connection error`).toMatch(/No RPC URL/);
      expect(text, `${name} should hide the low-level cause`).not.toMatch(/ECONNREFUSED/);
    }
    await client.close();
  });
});