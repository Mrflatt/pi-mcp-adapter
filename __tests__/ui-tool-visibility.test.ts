import { describe, expect, it } from "vitest";
import { reconstructToolMetadata, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import type { McpTool, ServerCacheEntry } from "../types.ts";

const tools: McpTool[] = [
  { name: "visible", description: "Visible" },
  { name: "app_only", description: "App only", _meta: { ui: { visibility: ["app"] } } },
  { name: "both", description: "Both", _meta: { ui: { visibility: ["model", "app"] } } },
];

describe("MCP Apps tool visibility", () => {
  it("omits app-only tools from live model metadata", () => {
    const { metadata } = buildToolMetadata(tools, [], {}, "demo", "server");

    expect(metadata.map((tool) => tool.originalName)).toEqual(["visible", "both"]);
    expect(metadata.find((tool) => tool.originalName === "both")?.uiVisibility).toEqual(["model", "app"]);
  });

  it("omits cached app-only tools when reconstructing model metadata", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      tools: serializeTools(tools),
      resources: [],
      cachedAt: Date.now(),
    };

    const metadata = reconstructToolMetadata("demo", entry, "server", {});

    expect(metadata.map((tool) => tool.originalName)).toEqual(["visible", "both"]);
  });
});
