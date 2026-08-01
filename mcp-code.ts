import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { formatWithOptions } from "node:util";
import vm from "node:vm";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { executeCall } from "./proxy-modes.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import type { ContentBlock } from "./types.ts";

export const DEFAULT_MCP_CODE_TIMEOUT_MS = 30_000;
const TOOLS_ENUMERATION_ERROR = "tools is not enumerable — use mcp({ search })";

class McpCodeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`mcp_code timed out after ${timeoutMs}ms`);
    this.name = "McpCodeTimeoutError";
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toContentBlock(value: unknown): ContentBlock {
  if (typeof value === "object" && value !== null) {
    const block = value as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
  }
  return { type: "text", text: formatValue(value) };
}

function textFromContent(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function isVmTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
    || (typeof value.message === "string" && value.message.includes("Script execution timed out"));
}

export async function runMcpCode(
  state: McpExtensionState,
  code: string,
  timeoutMs = DEFAULT_MCP_CODE_TIMEOUT_MS,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
) {
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MCP_CODE_TIMEOUT_MS;
  const output: ContentBlock[] = [];
  const externalSignal = combineAbortSignals(state.owner?.signal, signal);
  const timeoutController = new AbortController();
  const callSignal = combineAbortSignals(externalSignal, timeoutController.signal);

  const emit = (value: unknown): void => {
    output.push(toContentBlock(value));
  };

  const capturedConsole = Object.freeze({
    log: (...args: unknown[]) => emit(`[console.log] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`),
    info: (...args: unknown[]) => emit(`[console.info] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`),
    warn: (...args: unknown[]) => emit(`[console.warn] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`),
    error: (...args: unknown[]) => emit(`[console.error] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`),
    debug: (...args: unknown[]) => emit(`[console.debug] ${formatWithOptions({ colors: false, depth: 4 }, ...args)}`),
  });

  const tools = new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return async (args?: Record<string, unknown>) => {
        const result = await executeCall(state, property, args, undefined, getPiTools, callSignal);
        const details = result.details;
        if (details.error !== undefined) {
          const message = typeof details.message === "string"
            ? details.message
            : textFromContent(result.content);
          return {
            ok: false as const,
            error: { code: String(details.error), message },
          };
        }
        return {
          ok: true as const,
          data: details.mcpResult !== undefined ? details.mcpResult : textFromContent(result.content),
        };
      };
    },
    ownKeys() {
      throw new Error(TOOLS_ENUMERATION_ERROR);
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  let errorCode: "timeout" | "aborted" | "script_error" | undefined;
  let errorMessage: string | undefined;

  try {
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new Error(String(externalSignal.reason ?? "MCP request aborted"));
    }

    const context = vm.createContext(Object.assign(Object.create(null), {
      tools,
      emit,
      console: capturedConsole,
    }), {
      codeGeneration: { strings: false, wasm: false },
      name: "mcp_code",
    });
    const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "mcp_code.js" });
    const execution = Promise.resolve(script.runInContext(context, { timeout: resolvedTimeoutMs }));
    const timeoutError = new McpCodeTimeoutError(resolvedTimeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timeoutController.abort(timeoutError);
        reject(timeoutError);
      }, resolvedTimeoutMs);
    });
    const aborted = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(externalSignal.reason instanceof Error
            ? externalSignal.reason
            : new Error(String(externalSignal.reason ?? "MCP request aborted")));
          externalSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
        })
      : new Promise<never>(() => {});

    const returnValue = await Promise.race([execution, timeout, aborted]);
    if (returnValue !== undefined) output.push(toContentBlock(returnValue));
  } catch (error) {
    if (error instanceof McpCodeTimeoutError || isVmTimeout(error)) {
      errorCode = "timeout";
      errorMessage = `mcp_code timed out after ${resolvedTimeoutMs}ms`;
      timeoutController.abort(error);
    } else if (externalSignal?.aborted) {
      errorCode = "aborted";
      errorMessage = error instanceof Error ? error.message : String(error);
    } else {
      errorCode = "script_error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    output.push({ type: "text", text: errorMessage });
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }

  // Snapshot: a timed-out script may still be running and emitting into `output`.
  const guarded = await guardMcpOutput(
    output.length > 0 ? [...output] : [{ type: "text", text: "(no output)" }],
    resolveMcpOutputGuardOptions(state.config.settings),
  );
  return {
    content: guarded.content,
    details: {
      mode: "code",
      ...(errorCode ? { error: errorCode, message: errorMessage } : {}),
      timeoutMs: resolvedTimeoutMs,
      ...guardedMcpDetails(guarded),
    },
  };
}
