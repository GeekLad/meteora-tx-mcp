// dotenv is optional. It is loaded when installed, so a bare `npm install` of
// this server's dependencies still works without it.
let dotenvConfig: {
  config?: (options?: { path?: string; quiet?: boolean }) => unknown;
} | null = null;
try {
  dotenvConfig = (await import("dotenv")).default;
} catch {
  dotenvConfig = null;
}

/** Load `.env` from the current working directory once, before config is read. */
export function loadDotenv(): void {
  // Existing process env wins over .env values (dotenv default). quiet
  // suppresses dotenv's startup banner, which keeps stderr clean.
  if (dotenvConfig?.config) dotenvConfig.config({ quiet: true });
}

export interface HttpConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export const DEFAULT_HTTP_PORT = 5150;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

function parsePort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return DEFAULT_HTTP_PORT;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`MCP_HTTP_PORT must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65_535) throw new Error(`MCP_HTTP_PORT ${port} is outside 1..65535`);
  return port;
}

/** HTTP listener settings from the environment; blank values fall back to defaults. The default state matches the README: enabled on 127.0.0.1:5150. */
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const enabledRaw = env.MCP_HTTP_ENABLED?.trim().toLowerCase();
  if (enabledRaw !== undefined && enabledRaw !== "" && !["true", "false"].includes(enabledRaw)) {
    throw new Error(`MCP_HTTP_ENABLED must be true or false, got ${JSON.stringify(env.MCP_HTTP_ENABLED)}`);
  }
  const enabled = enabledRaw === undefined || enabledRaw === "" ? true : enabledRaw === "true";
  const host = (env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST).trim() || DEFAULT_HTTP_HOST;
  return { enabled, port: parsePort(env.MCP_HTTP_PORT), host };
}

export interface ToolConfig {
  /**
   * When true, the server registers only the `_raw` tools (integer bin ids,
   * base-unit amounts, bps shares) and leaves the decimal tools out
   * entirely, so an MCP host cannot even list them. Default false: the
   * decimal tools are the default surface and the `_raw` tools stay
   * alongside them.
   */
  rawOnly: boolean;
}

/** Which tool set the server exposes; `MCP_RAW_TOOLS=true` serves only the `_raw` tools. Default false. */
export function resolveToolConfig(env: NodeJS.ProcessEnv = process.env): ToolConfig {
  const rawOnlyRaw = env.MCP_RAW_TOOLS?.trim().toLowerCase();
  if (rawOnlyRaw !== undefined && rawOnlyRaw !== "" && !["true", "false"].includes(rawOnlyRaw)) {
    throw new Error(`MCP_RAW_TOOLS must be true or false, got ${JSON.stringify(env.MCP_RAW_TOOLS)}`);
  }
  return { rawOnly: rawOnlyRaw === "true" };
}