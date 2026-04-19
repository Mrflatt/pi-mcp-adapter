import {
  Client,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  UnauthorizedError,
  AjvJsonSchemaValidator,
} from "@modelcontextprotocol/client";
import type { AuthProvider, ReadResourceResult, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { ElicitationCompleteNotificationSchema } from "@modelcontextprotocol/client";
import _Ajv from "ajv";
import _addFormats from "ajv-formats";
// CJS default-export compat for module: NodeNext
const Ajv = (_Ajv as any).default ?? _Ajv;
const addFormats = (_addFormats as any).default ?? _addFormats;
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";
import { serverStreamResultPatchNotificationSchema, SERVER_STREAM_RESULT_PATCH_METHOD } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { fetchGoogleAccessToken, fetchGoogleIdentityToken } from "./google-auth.ts";
import { getStoredTokens, writeStoredToken, clearStoredTokens } from "./oauth-handler.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";

interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
}

// Pre-configured AJV validator — adds formats not in ajv-formats that MCP servers use
const _ajv = new Ajv({
  strict: false,
  validateFormats: true,
  validateSchema: false,
  allErrors: true,
});
addFormats(_ajv);
const EXTRA_FORMATS = [
  "uint32",
  "uint64",
  "google-duration",
  "google-datetime",
  "google-fieldmask",
  "google-int64",
  "google-uint32",
  "google-uint64",
];
for (const fmt of EXTRA_FORMATS) _ajv.addFormat(fmt, { validate: () => true });
const schemaValidator = new AjvJsonSchemaValidator(_ajv);

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {
    // Dedupe concurrent connection attempts
    if (this.connectPromises.has(name)) {
      return this.connectPromises.get(name)!;
    }

    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, definition);
    this.connectPromises.set(name, promise);

    try {
      const connection = await promise;
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
    }
  }

  private async createConnection(
    name: string,
    definition: ServerDefinition
  ): Promise<ServerConnection> {
    const client = this.createClient(name);


    let transport: Transport;

    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: resolveConfigPath(definition.cwd),
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(definition, name);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }

    try {
      await client.connect(transport);
      this.attachAdapterNotificationHandlers(name, client);

      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
      ]);

      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // Google auth: clear cached token on 401 so the next connect fetches a fresh one
      const isGoogleAuth = definition.auth === "google-access-token" || definition.auth === "google-identity-token";
      if (error instanceof UnauthorizedError && isGoogleAuth) {
        clearStoredTokens(name);
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        throw error;
      }

      // OAuth servers: return needs-auth so the caller can start the OAuth flow
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Clean up both client and transport before reporting needs-auth.
        await client.close().catch(() => {});
        await transport.close().catch(() => {});

        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }

      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const options: Record<string, unknown> = { jsonSchemaValidator: schemaValidator };
    if (Object.keys(capabilities).length > 0) options.capabilities = capabilities;
    const client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      options as any,
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private async createHttpTransport(
    definition: ServerDefinition,
    serverName: string
  ): Promise<Transport> {
    const url = new URL(definition.url!);

    // Build headers first (including any bearer token)
    const headers = resolveHeaders(definition.headers) ?? {};

    // For bearer auth, add the token to headers BEFORE creating requestInit
    if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    // For Google auth, create an AuthProvider that dynamically provides a fresh
    // token on every request.  Tokens are cached for 55 min (see oauth-handler)
    // and transparently refreshed when the cache expires.
    let googleAuthProvider: AuthProvider | undefined;
    if (definition.auth === "google-access-token") {
      googleAuthProvider = createGoogleAuthProvider(serverName, () => fetchGoogleAccessToken());
    }
    if (definition.auth === "google-identity-token") {
      const { audience, serviceAccount } = definition.googleAuth ?? {} as any;
      if (!audience) throw new Error(`google-identity-token requires googleAuth.audience for server "${serverName}"`);
      if (!serviceAccount) throw new Error(`google-identity-token requires googleAuth.serviceAccount for server "${serverName}"`);
      googleAuthProvider = createGoogleAuthProvider(serverName, () => fetchGoogleIdentityToken(serviceAccount, audience));
    }


    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // For OAuth servers, create an auth provider
    let oauthProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      const oauthConfig = extractOAuthConfig(definition);
      oauthProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        oauthConfig,
        {
          onRedirect: async (_authUrl) => {
            // URL is captured by startAuth, no need to log
          },
        }
      );
    }
    
    const authProvider: AuthProvider | McpOAuthProvider | undefined = googleAuthProvider ?? oauthProvider;
    const transportOpts = { requestInit, authProvider };

    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, transportOpts);
    
    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" }, { jsonSchemaValidator: schemaValidator });
      await testClient.connect(streamableTransport);
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});

      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, transportOpts);
    } catch (error) {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});

      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      // SSE is the legacy transport
      return new SSEClientTransport(url, { requestInit, authProvider });
    }
  }

  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  private async fetchAllResources(client: Client): Promise<McpResource[]> {
    if (!client.getServerCapabilities()?.resources) return [];
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);

      return allResources;
    } catch {
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method !== SERVER_STREAM_RESULT_PATCH_METHOD) return;
      const params = (notification as ServerStreamResultPatchNotification).params;
      const listener = this.uiStreamListeners.get(params.streamToken);
      if (!listener) return;
      listener(serverName, params);
    };
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri });
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map(name => this.close(name)));
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Create an AuthProvider that dynamically provides a fresh Google auth token.
 * Tokens are cached for 55 min and refreshed transparently.
 */
function createGoogleAuthProvider(
  serverName: string,
  refreshToken: () => Promise<string>,
): AuthProvider {
  return {
    async token() {
      const cached = getStoredTokens(serverName);
      if (cached?.access_token) return cached.access_token;
      const token = await refreshToken();
      writeStoredToken(serverName, token);
      return token;
    },
    async onUnauthorized() {
      clearStoredTokens(serverName);
      const token = await refreshToken();
      writeStoredToken(serverName, token);
    },
  };
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  if (!env) return resolved;

  const overrides = interpolateEnvRecord(env);
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  return interpolateEnvRecord(headers);
}
