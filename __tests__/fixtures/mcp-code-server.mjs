import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-code-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: {} },
      },
    },
    {
      name: "fail",
      description: "Return an MCP tool error",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fail") {
    return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  }
  return {
    content: [{ type: "text", text: String(request.params.arguments?.value ?? "") }],
    structuredContent: { echoed: request.params.arguments?.value },
  };
});

await server.connect(new StdioServerTransport());
