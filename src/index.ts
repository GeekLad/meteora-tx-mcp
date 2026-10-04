#!/usr/bin/env node
// MCP server over stdio and streamable HTTP. Builds unsigned Meteora DLMM
// transactions. The fee payer is not signed here, and nothing is submitted.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotenv, resolveHttpConfig, resolveToolConfig } from "./env.js";
import { startHttpListener } from "./http.js";
import { createServer } from "./server.js";

// Hosts parse stdout as JSON-RPC. Library logs go to stderr.
console.log = console.error;

loadDotenv();

const main = async (): Promise<void> => {
  const toolConfig = resolveToolConfig();
  const stdioServer = createServer({ rawOnly: toolConfig.rawOnly });
  await stdioServer.connect(new StdioServerTransport());
  console.error(
    toolConfig.rawOnly
      ? "meteora-tx-mcp listening on stdio (raw tools only, MCP_RAW_TOOLS=true)"
      : "meteora-tx-mcp listening on stdio",
  );

  const httpConfig = resolveHttpConfig();
  if (httpConfig.enabled) {
    const listener = await startHttpListener(httpConfig, toolConfig);
    console.error(`meteora-tx-mcp listening on http://${httpConfig.host}:${listener.port}/mcp`);
    const shutdown = (): void => {
      void listener.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    console.error("meteora-tx-mcp http disabled (MCP_HTTP_ENABLED=false)");
  }
};

main().catch((error) => {
  console.error("meteora-tx-mcp failed to start:", error);
  process.exit(1);
});