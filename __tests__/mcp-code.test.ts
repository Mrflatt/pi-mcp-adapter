import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createMcpAdapter } from "../index.ts";
import { runMcpScript } from "../mcp-code.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
let manager: McpServerManager;
let state: McpExtensionState;

function textBlocks(result: Awaited<ReturnType<typeof runMcpScript>>): string[] {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text);
}

describe("runMcpScript", () => {
  it("registers mcp_script only when script mode is enabled", () => {
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: { scriptMode: true }, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
    } as any);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp_script" }));
  });

  beforeAll(async () => {
    manager = new McpServerManager();
    await manager.connect("fixture", definition);
    state = {
      config: { settings: {}, mcpServers: { fixture: definition } },
      toolMetadata: new Map([
        ["fixture", [
          { name: "fixture_echo", originalName: "echo", description: "Echo a value" },
          { name: "fixture_fail", originalName: "fail", description: "Return an MCP tool error" },
        ]],
      ]),
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;
  });

  afterAll(async () => {
    await manager.closeAll();
  });

  it("searches the script-visible tool catalog with pagination and server filtering", async () => {
    const result = await runMcpScript(
      state,
      'return { first: tools.search({ query: "fixture", limit: 1 }), second: tools.search({ query: "fixture", limit: 1, offset: 1, server: "fixture" }), empty: tools.search({ query: "" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      first: {
        items: [{ path: "fixture_echo", name: "echo", server: "fixture", description: "Echo a value", score: expect.any(Number) }],
        total: 2,
        hasMore: true,
        nextOffset: 1,
      },
      second: {
        items: [{ path: "fixture_fail", name: "fail", server: "fixture", description: "Return an MCP tool error", score: expect.any(Number) }],
        total: 2,
        hasMore: false,
        nextOffset: null,
      },
      empty: { items: [], total: 0, hasMore: false, nextOffset: null },
    });
  });

  it("describes exact script-visible paths and suggests corrections without throwing", async () => {
    const result = await runMcpScript(
      state,
      'return { found: tools.describe({ path: "fixture_echo" }), missing: tools.describe({ path: "fixture_ech" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      found: {
        path: "fixture_echo",
        name: "echo",
        server: "fixture",
        description: "Echo a value",
      },
      missing: {
        path: "fixture_ech",
        name: "fixture_ech",
        server: null,
        error: {
          code: "tool_not_found",
          message: "Tool not found: fixture_ech",
          suggestions: ["fixture_echo"],
        },
      },
    });
  });

  it("calls a prefixed MCP tool through the flat tools proxy", async () => {
    const result = await runMcpScript(
      state,
      'return await tools.fixture_echo({ value: "round trip" });',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "round trip" }],
        structuredContent: { echoed: "round trip" },
      },
    });
  });

  it("returns a failure envelope and lets the script continue", async () => {
    const result = await runMcpScript(
      state,
      "const failure = await tools.fixture_fail({}); return { failure, continued: true };",
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      continued: true,
      failure: {
        ok: false,
        error: { code: "tool_error", message: expect.stringContaining("fixture failure") },
      },
    });
    expect(result.details).not.toHaveProperty("error");
  });

  it("bounds synchronous runaway code and preserves partial emits", async () => {
    const result = await runMcpScript(state, 'emit("before timeout"); while (true) {}', 20);

    expect(textBlocks(result)[0]).toBe("before timeout");
    expect(result.details).toMatchObject({ error: "timeout", timeoutMs: 20 });
    expect(textBlocks(result).at(-1)).toBe("mcp_script timed out after 20ms");
  });

  it("orders emitted and captured console blocks before the return value", async () => {
    const result = await runMcpScript(
      state,
      'emit("first"); console.log("second"); return "last";',
    );

    expect(textBlocks(result)).toEqual(["first", "[console.log] second", "last"]);
  });

  it("rejects tools enumeration with discovery guidance without exposing host globals", async () => {
    const result = await runMcpScript(
      state,
      `let message;
      try { Object.keys(tools); } catch (error) { message = error.message; }
      return { message, globals: [typeof require, typeof fetch, typeof process] };`,
    );

    expect(JSON.parse(textBlocks(result)[0])).toEqual({
      message: "tools is not enumerable — use tools.search({ query })",
      globals: ["undefined", "undefined", "undefined"],
    });
  });
});
