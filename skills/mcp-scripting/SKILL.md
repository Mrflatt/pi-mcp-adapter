---
name: mcp-scripting
description: Write mcp_script JavaScript for discovering, inspecting, and calling MCP tools.
---

# MCP scripting

Use `mcp_script` when a task needs to discover, filter, or orchestrate MCP tools in one JavaScript request.

## Workflow

1. Find candidate tools with `tools.search({ query, server?, limit?, offset? })`.
2. Inspect the exact returned path with `tools.describe({ path })`.
3. Call it with `tools.call(path, args)`.

```js
const { items } = tools.search({ query: "search issues", server: "github" });
const candidate = items[0];
if (!candidate) return { error: "No matching tool" };

const details = tools.describe({ path: candidate.path });
if (details.error) return details;

const result = await tools.call(details.path, { query: "is:open label:bug" });
if (!result.ok) return result;
emit({ tool: details.path, completed: true });
return result.data;
```

Calls resolve to `{ ok: true, data }` or `{ ok: false, error }`; handle failed calls instead of expecting them to stop the script. `emit(value)` adds user-visible output before the final `return` value. `console` output is captured too.

`tools` is a non-enumerable proxy: `Object.keys(tools)` throws. Always use `tools.search` for discovery. When a known flat path is a valid identifier, direct calls such as `tools.github_search_issues(args)` are supported; use bracket syntax for hyphenated names: `tools["server_tool-name"](args)`.

The default script timeout is 30 seconds. Every invocation still uses normal lazy connection, authentication, output guarding, and approval gates. Result details contain a concise `calls` trace with each path and outcome.

Use plain JavaScript loops and Promise utilities for composition. Fluent helpers such as `tools.find(...).one()`, `tools.parallel(...)`, and `tools.retry(...)` are not provided.
