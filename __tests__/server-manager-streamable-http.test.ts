import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  servers.length = 0;
});

describe("McpServerManager StreamableHTTP transport", () => {
  it("does not fall back to SSE when optional GET stream returns 405", async () => {
    const requests: string[] = [];
    const server = http.createServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);

      if (req.method === "GET") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { id?: string | number; method?: string };

      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "post-only", version: "1.0.0" },
          },
        }));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [] },
        }));
        return;
      }

      if (message.method === "resources/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { resources: [] },
        }));
        return;
      }

      res.writeHead(500).end(`unexpected method: ${message.method}`);
    });
    servers.push(server);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    try {
      const connection = await manager.connect("post-only", {
        url: `http://127.0.0.1:${address.port}/mcp`,
      });

      for (let attempt = 0; attempt < 20 && !requests.includes("GET /mcp"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(connection.status).toBe("connected");
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(requests).toContain("GET /mcp");
      // SDK v2 probes the optional GET stream once, then keeps the successful
      // POST-based session without an SSE fallback or retry storm.
      expect(requests.filter(request => request === "GET /mcp")).toHaveLength(1);
    } finally {
      await manager.close("post-only").catch(() => {});
    }
  });
});
