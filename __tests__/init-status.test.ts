import { describe, expect, it, vi } from "vitest";
import { updateStatusBar } from "../init.ts";

function createState(ui: unknown) {
  return {
    ui,
    config: { mcpServers: { demo: { command: "demo" } } },
    manager: { getAllConnections: vi.fn(() => new Map()) },
  } as any;
}

describe("updateStatusBar", () => {
  it("updates a usable UI even when its theme is unavailable", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus, theme: undefined });

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 0/1 servers");
  });

  it("does not count a needs-auth connection as connected", () => {
    const setStatus = vi.fn();
    const state = createState({ setStatus, theme: undefined });
    state.manager.getAllConnections.mockReturnValue(new Map([["demo", { status: "needs-auth" }]]));

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 0/1 servers");
  });

  it("keeps themed status text when a theme is available", () => {
    const setStatus = vi.fn();
    const state = createState({
      setStatus,
      theme: { fg: vi.fn((_name: string, text: string) => `styled:${text}`) },
    });

    updateStatusBar(state);

    expect(setStatus).toHaveBeenCalledWith("mcp", "styled:🔌 MCP: 0/1 servers");
  });
});
