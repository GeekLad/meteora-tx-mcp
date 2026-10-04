// Streamable-HTTP listener alongside the stdio transport. Every POST to /mcp
// gets a fresh stateless McpServer so parallel clients never share state.
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import type { HttpConfig, ToolConfig } from "./env.js";

const MCP_ENDPOINT = "/mcp";

/** Host header check. A mismatched Host is refused before any body is read; the port part of the header is ignored. */
function hostAllowed(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return false;
  if (bindHost === "0.0.0.0" || bindHost === "::") return true;
  const hostname = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === bindHost.toLowerCase()) return true;
  // A loopback bind accepts the standard loopback names.
  return (
    (bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost") &&
    (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]".slice(1, -1))
  );
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HttpConfig,
  tools: ToolConfig,
): Promise<void> {
  const url = req.url ?? "";
  if (url !== MCP_ENDPOINT && !url.startsWith(`${MCP_ENDPOINT}?`)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Not found. POST JSON-RPC to ${MCP_ENDPOINT}.` }));
    return;
  }
  if (!hostAllowed(req.headers.host, cfg.host)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Invalid Host header: ${String(req.headers.host)}` }));
    return;
  }

  // Stateless mode: sessionIdGenerator undefined, a new transport and McpServer
  // per request, JSON responses for simple clients. The SDK refuses a reused
  // stateless transport, so no state is shared across requests.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcpServer = createServer({ rawOnly: tools.rawOnly });
  await mcpServer.connect(transport);
  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });
  await transport.handleRequest(req, res);
}

export interface HttpListener {
  server: HttpServer;
  port: number;
  close: () => Promise<void>;
}

export function startHttpListener(cfg: HttpConfig, tools: ToolConfig = { rawOnly: false }): Promise<HttpListener> {
  const server = createHttpServer((req, res) => {
    void handle(req, res, cfg, tools).catch((error) => {
      console.error("meteora-tx-mcp http error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}