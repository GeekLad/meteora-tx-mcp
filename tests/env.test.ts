import { describe, expect, it } from "vitest";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, resolveHttpConfig, resolveToolConfig } from "../src/env.js";

function envWith(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe("resolveToolConfig", () => {
  it("defaults to the decimal tools with the _raw tools alongside", () => {
    expect(resolveToolConfig(envWith({}))).toEqual({ rawOnly: false });
  });

  it("exposes only the _raw tools when MCP_RAW_TOOLS=true", () => {
    expect(resolveToolConfig(envWith({ MCP_RAW_TOOLS: "true" }))).toEqual({ rawOnly: true });
    expect(resolveToolConfig(envWith({ MCP_RAW_TOOLS: "TRUE" }))).toEqual({ rawOnly: true });
  });

  it("stays on the decimal tools for an explicit false or a blank value", () => {
    expect(resolveToolConfig(envWith({ MCP_RAW_TOOLS: "false" })).rawOnly).toBe(false);
    expect(resolveToolConfig(envWith({ MCP_RAW_TOOLS: "False" })).rawOnly).toBe(false);
    expect(resolveToolConfig(envWith({ MCP_RAW_TOOLS: "" })).rawOnly).toBe(false);
  });

  it("rejects an invalid MCP_RAW_TOOLS", () => {
    expect(() => resolveToolConfig(envWith({ MCP_RAW_TOOLS: "raw only" }))).toThrow(/MCP_RAW_TOOLS/);
    expect(() => resolveToolConfig(envWith({ MCP_RAW_TOOLS: "1" }))).toThrow(/MCP_RAW_TOOLS/);
  });
});

describe("resolveHttpConfig", () => {
  it("defaults to enabled on 127.0.0.1:5150", () => {
    const config = resolveHttpConfig(envWith({}));
    expect(config).toEqual({ enabled: true, port: DEFAULT_HTTP_PORT, host: DEFAULT_HTTP_HOST });
    expect(config.port).toBe(5150);
    expect(config.host).toBe("127.0.0.1");
  });

  it("reads MCP_HTTP_ENABLED, MCP_HTTP_PORT, and MCP_HTTP_HOST", () => {
    const config = resolveHttpConfig(
      envWith({ MCP_HTTP_ENABLED: "false", MCP_HTTP_PORT: "8080", MCP_HTTP_HOST: "0.0.0.0" }),
    );
    expect(config).toEqual({ enabled: false, port: 8080, host: "0.0.0.0" });
  });

  it("accepts case-insensitive true/false and blank values", () => {
    expect(resolveHttpConfig(envWith({ MCP_HTTP_ENABLED: "TRUE" })).enabled).toBe(true);
    expect(resolveHttpConfig(envWith({ MCP_HTTP_ENABLED: "False" })).enabled).toBe(false);
    expect(resolveHttpConfig(envWith({ MCP_HTTP_ENABLED: "" })).enabled).toBe(true);
    expect(resolveHttpConfig(envWith({ MCP_HTTP_PORT: "" })).port).toBe(5150);
    expect(resolveHttpConfig(envWith({ MCP_HTTP_HOST: "" })).host).toBe("127.0.0.1");
  });

  it("rejects invalid values", () => {
    expect(() => resolveHttpConfig(envWith({ MCP_HTTP_ENABLED: "yes" }))).toThrow(/MCP_HTTP_ENABLED/);
    expect(() => resolveHttpConfig(envWith({ MCP_HTTP_PORT: "5150x" }))).toThrow(/MCP_HTTP_PORT/);
    expect(() => resolveHttpConfig(envWith({ MCP_HTTP_PORT: "0" }))).toThrow(/outside 1..65535/);
    expect(() => resolveHttpConfig(envWith({ MCP_HTTP_PORT: "70000" }))).toThrow(/outside 1..65535/);
  });
});