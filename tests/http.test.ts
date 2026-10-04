// Drives the real HTTP listener with the MCP SDK's streamable-HTTP client,
// against the tools' validation paths that run before any RPC call.
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { resolveHttpConfig } from "../src/env.js";
import { startHttpListener } from "../src/http.js";

/** Raw POST with an arbitrary Host header. Node's fetch forbids setting Host. */
function postWithHost(port: number, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { port, host: "127.0.0.1", path: "/mcp", method: "POST", headers: { Host: host, "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("streamable HTTP listener", () => {
  it("answers tools/list and returns a tool error without an RPC URL", async () => {
    // Port 0 lets the OS pick a free port for the test.
    const listener = await startHttpListener({ ...resolveHttpConfig({}), port: 0 });
    const url = new URL(`http://127.0.0.1:${listener.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toContain("build_open_position");
    expect(names).toContain("build_open_position_raw");

    const result = await client.callTool({
      name: "build_open_position_raw",
      arguments: {
        rpcUrl: "",
        poolAddress: "So11111111111111111111111111111111111111112",
        userPublicKey: "So11111111111111111111111111111111111111112",
        lowerBinId: -5,
        upperBinId: 0,
        amountXRaw: "0",
        amountYRaw: "1000000",
        strategy: "bidAsk",
      },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/No RPC URL/);
    await client.close();
    await listener.close();
  });

  it("refuses requests with a foreign Host header", async () => {
    const listener = await startHttpListener({ ...resolveHttpConfig({}), port: 0 });
    const status = await postWithHost(listener.port, "evil.example.com", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(status).toBe(403);
    const loopback = await postWithHost(listener.port, `127.0.0.1:${listener.port}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    // A bare POST without Accept is rejected 406 inside the transport, which
    // proves the loopback Host passed the 403 gate.
    expect(loopback).toBe(406);
    await listener.close();
  });

  it("answers 404 off the /mcp endpoint", async () => {
    const listener = await startHttpListener({ ...resolveHttpConfig({}), port: 0 });
    const response = await fetch(`http://127.0.0.1:${listener.port}/other`, { method: "POST" });
    expect(response.status).toBe(404);
    const root = await fetch(`http://127.0.0.1:${listener.port}/`);
    expect(root.status).toBe(404);
    await listener.close();
  });
});