/**
 * MCP Bridge Extension for pi
 *
 * Connects to MCP servers and registers their tools as pi tools.
 *
 * Configuration: ~/.pi/agent/mcp.json and/or .pi/mcp.json (project-local)
 *
 * Example mcp.json:
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
 *     },
 *     "github": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "env": { "GITHUB_TOKEN": "ghp_..." }
 *     },
 *     "authenticated-stdio": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "auth": {
 *         "type": "env",
 *         "env": { "GITHUB_TOKEN": "GITHUB_TOKEN" }
 *       }
 *     },
 *     "remote-bearer": {
 *       "url": "http://localhost:3001/mcp",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "bearer",
 *         "token": "my-secret-token"
 *       }
 *     },
 *     "remote-bearer-env": {
 *       "url": "http://localhost:3001/mcp",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "bearer",
 *         "tokenEnvVar": "MY_API_TOKEN"
 *       }
 *     },
 *     "remote-header": {
 *       "url": "http://localhost:3001/mcp",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "header",
 *         "name": "X-API-Key",
 *         "value": "my-api-key"
 *       }
 *     },
 *     "remote-header-env": {
 *       "url": "http://localhost:3001/mcp",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "header",
 *         "name": "X-API-Key",
 *         "valueEnvVar": "MY_API_KEY"
 *       }
 *     },
 *     "remote-oauth-credentials": {
 *       "url": "http://localhost:3001/mcp",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "oauth-client-credentials",
 *         "clientId": "my-client",
 *         "clientSecret": "my-secret",
 *         "scope": "read write"
 *       }
 *     },
 *     "backstage-server": {
 *       "url": "https://mcp.example.com/api",
 *       "transport": "streamable-http",
 *       "auth": {
 *         "type": "oauth",
 *         "callbackPort": 0
 *       }
 *     },
 *     "legacy-sse": {
 *       "url": "http://localhost:3001/sse",
 *       "transport": "sse"
 *     }
 *   }
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, matchesKey, type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js";
import { InteractiveOAuthProvider, findFreePort } from "./oauth-provider.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Auth: pass env vars to the spawned process.
 * Values are environment variable names to read from the current process,
 * or literal values if no matching env var is found.
 */
interface EnvAuth {
  type: "env";
  /** Map of VAR_NAME_IN_CHILD -> env var name to read from parent (or literal value) */
  env: Record<string, string>;
}

/** Auth: send a Bearer token in the Authorization header. */
interface BearerAuth {
  type: "bearer";
  /** Literal token value */
  token?: string;
  /** Env var name containing the token */
  tokenEnvVar?: string;
}

/** Auth: send a custom header with a value. */
interface HeaderAuth {
  type: "header";
  /** Header name, e.g. "X-API-Key" */
  name: string;
  /** Literal header value */
  value?: string;
  /** Env var name containing the header value */
  valueEnvVar?: string;
}

/** Auth: OAuth 2.0 client_credentials grant (machine-to-machine). */
interface OAuthClientCredentialsAuth {
  type: "oauth-client-credentials";
  clientId?: string;
  clientSecret?: string;
  /** Env var names for client credentials */
  clientIdEnvVar?: string;
  clientSecretEnvVar?: string;
  scope?: string;
}

/**
 * Auth: OAuth 2.0 authorization code flow with PKCE (interactive).
 * Opens browser for user to authenticate, catches callback with local server.
 * Tokens are persisted to ~/.pi/agent/mcp-auth/ and refreshed automatically.
 */
interface OAuthInteractiveAuth {
  type: "oauth";
  /** Port for the local callback server (0 = auto-assign, default: 0) */
  callbackPort?: number;
  /** Timeout in seconds for waiting for the callback (default: 120) */
  callbackTimeoutSeconds?: number;
}

type AuthConfig = EnvAuth | BearerAuth | HeaderAuth | OAuthClientCredentialsAuth | OAuthInteractiveAuth;

interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  auth?: EnvAuth;
}

interface HttpServerConfig {
  url: string;
  transport: "sse" | "streamable-http";
  headers?: Record<string, string>;
  auth?: BearerAuth | HeaderAuth | OAuthClientCredentialsAuth | OAuthInteractiveAuth;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

interface McpConfig {
  mcpServers: Record<string, ServerConfig>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  tools: MCPTool[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
  return "url" in config;
}

/**
 * Resolve a value that might be a literal or an env var reference.
 * Returns the env var value if it exists, otherwise returns the literal.
 */
function resolveEnvOrLiteral(envVarName: string | undefined, literal: string | undefined): string | undefined {
  if (envVarName) {
    const val = process.env[envVarName];
    if (val !== undefined) return val;
  }
  return literal;
}

/**
 * Build auth headers from an HTTP auth config.
 * Returns a headers record to merge into requestInit, or undefined.
 */
function buildAuthHeaders(auth: HttpServerConfig["auth"]): Record<string, string> | undefined {
  if (!auth) return undefined;

  switch (auth.type) {
    case "bearer": {
      const token = resolveEnvOrLiteral(auth.tokenEnvVar, auth.token);
      if (!token) return undefined;
      return { Authorization: `Bearer ${token}` };
    }
    case "header": {
      const value = resolveEnvOrLiteral(auth.valueEnvVar, auth.value);
      if (!value || !auth.name) return undefined;
      return { [auth.name]: value };
    }
    default:
      return undefined;
  }
}

/**
 * Build an OAuthClientProvider for client_credentials auth, or undefined.
 */
function buildOAuthProvider(auth: OAuthClientCredentialsAuth): OAuthClientProvider | undefined {
  const clientId = resolveEnvOrLiteral(auth.clientIdEnvVar, auth.clientId);
  const clientSecret = resolveEnvOrLiteral(auth.clientSecretEnvVar, auth.clientSecret);
  if (!clientId || !clientSecret) return undefined;

  return new ClientCredentialsProvider({
    clientId,
    clientSecret,
    scope: auth.scope,
  });
}

/**
 * Build the env record for a stdio server, incorporating auth.
 */
function buildStdioEnv(config: StdioServerConfig): Record<string, string> {
  const env = { ...process.env, ...(config.env || {}) } as Record<string, string>;

  if (config.auth?.type === "env") {
    for (const [childVar, source] of Object.entries(config.auth.env)) {
      // source is either an env var name to read, or a literal value
      const resolved = process.env[source] ?? source;
      env[childVar] = resolved;
    }
  }

  return env;
}

/**
 * Convert a JSON Schema property definition to a TypeBox schema.
 * Handles common types; falls back to Type.Any() for complex schemas.
 */
function jsonSchemaPropertyToTypebox(prop: any): any {
  if (!prop || typeof prop !== "object") return Type.Any();

  switch (prop.type) {
    case "string":
      if (prop.enum) {
        return Type.Union(prop.enum.map((v: string) => Type.Literal(v)));
      }
      return Type.String(prop.description ? { description: prop.description } : {});
    case "number":
    case "integer":
      return Type.Number(prop.description ? { description: prop.description } : {});
    case "boolean":
      return Type.Boolean(prop.description ? { description: prop.description } : {});
    case "array":
      if (prop.items) {
        return Type.Array(jsonSchemaPropertyToTypebox(prop.items), prop.description ? { description: prop.description } : {});
      }
      return Type.Array(Type.Any(), prop.description ? { description: prop.description } : {});
    case "object":
      if (prop.properties) {
        const objProps: TProperties = {};
        const required = new Set(prop.required || []);
        for (const [key, val] of Object.entries(prop.properties)) {
          const schema = jsonSchemaPropertyToTypebox(val);
          objProps[key] = required.has(key) ? schema : Type.Optional(schema);
        }
        return Type.Object(objProps, prop.description ? { description: prop.description } : {});
      }
      return Type.Record(Type.String(), Type.Any(), prop.description ? { description: prop.description } : {});
    default:
      return Type.Any(prop.description ? { description: prop.description } : {});
  }
}

/**
 * Convert an MCP tool's inputSchema (JSON Schema) to a TypeBox TObject.
 */
function mcpInputSchemaToTypebox(inputSchema: MCPTool["inputSchema"]): TObject {
  if (!inputSchema || !inputSchema.properties) {
    return Type.Object({});
  }

  const props: TProperties = {};
  const required = new Set(inputSchema.required || []);

  for (const [key, val] of Object.entries(inputSchema.properties)) {
    const schema = jsonSchemaPropertyToTypebox(val);
    props[key] = required.has(key) ? schema : Type.Optional(schema);
  }

  return Type.Object(props);
}

/**
 * Resolve the global and project-local config file paths.
 */
function getConfigPaths(cwd: string) {
  return {
    global: path.join(process.env.HOME || "~", ".pi", "agent", "mcp.json"),
    project: path.join(cwd, ".pi", "mcp.json"),
  };
}

/**
 * Load a single MCP config file. Returns empty config on missing/invalid files.
 */
function loadSingleConfig(configPath: string): McpConfig {
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as McpConfig;
      return { mcpServers: config.mcpServers || {} };
    }
  } catch {
    // Ignore parse errors
  }
  return { mcpServers: {} };
}

/**
 * Save an MCP config to a file. Creates parent dirs if needed.
 */
function saveMcpConfig(configPath: string, config: McpConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Load and merge MCP configs from global and project-local locations.
 */
function loadMcpConfig(cwd: string): McpConfig {
  const merged: McpConfig = { mcpServers: {} };
  const paths = getConfigPaths(cwd);

  for (const configPath of [paths.global, paths.project]) {
    const config = loadSingleConfig(configPath);
    // Project-local overrides global for same server name
    Object.assign(merged.mcpServers, config.mcpServers);
  }

  return merged;
}

/**
 * Describe the auth config for display purposes.
 */
function describeAuth(auth: AuthConfig | undefined): string {
  if (!auth) return "none";
  switch (auth.type) {
    case "env":
      return `env (${Object.keys(auth.env).join(", ")})`;
    case "bearer":
      return auth.tokenEnvVar ? `bearer ($${auth.tokenEnvVar})` : "bearer (token)";
    case "header":
      return auth.valueEnvVar ? `header ${auth.name} ($${auth.valueEnvVar})` : `header ${auth.name}`;
    case "oauth-client-credentials":
      return auth.clientIdEnvVar ? `oauth-credentials ($${auth.clientIdEnvVar})` : `oauth-credentials (${auth.clientId || "?"})`;
    case "oauth":
      return "oauth (interactive browser flow)";
  }
}

/**
 * Connect to a single MCP server.
 *
 * For servers with auth.type === "oauth", this handles the full interactive
 * authorization code flow:
 * 1. First connect attempt may throw UnauthorizedError
 * 2. The InteractiveOAuthProvider opens the browser + starts a callback server
 * 3. We wait for the user to complete auth in the browser
 * 4. Exchange the code for tokens via transport.finishAuth()
 * 5. Reconnect with the new tokens
 */
async function connectServer(
  name: string,
  config: ServerConfig,
  onAuthUrl?: (serverName: string, url: string) => void,
): Promise<ConnectedServer> {
  const client = new Client(
    { name: `pi-mcp-bridge`, version: "1.0.0" },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  let oauthProvider: InteractiveOAuthProvider | undefined;

  if (isHttpConfig(config)) {
    const url = new URL(config.url);

    // Build combined headers: explicit headers + non-oauth auth headers
    const authHeaders = config.auth && config.auth.type !== "oauth-client-credentials" && config.auth.type !== "oauth"
      ? buildAuthHeaders(config.auth)
      : undefined;
    const allHeaders = { ...(config.headers || {}), ...(authHeaders || {}) };
    const hasHeaders = Object.keys(allHeaders).length > 0;

    // Build the appropriate auth provider
    let authProvider: OAuthClientProvider | undefined;

    if (config.auth?.type === "oauth-client-credentials") {
      authProvider = buildOAuthProvider(config.auth);
    } else if (config.auth?.type === "oauth") {
      // Pre-resolve port 0 to a real port BEFORE creating the provider.
      // The SDK calls clientMetadata (for client registration) and redirectUrl
      // (for the auth URL) BEFORE redirectToAuthorization, so the port must be
      // known upfront. Otherwise client registration uses fallback port 19876
      // but the callback server binds to a different random port → auth fails.
      let callbackPort = config.auth.callbackPort ?? 0;
      if (callbackPort === 0) {
        callbackPort = await findFreePort();
      }
      oauthProvider = new InteractiveOAuthProvider({
        serverName: name,
        callbackPort,
        callbackTimeoutMs: (config.auth.callbackTimeoutSeconds ?? 120) * 1000,
        onAuthUrl: (authUrl) => {
          if (onAuthUrl) {
            onAuthUrl(name, authUrl);
          }
        },
      });
      authProvider = oauthProvider;
    }

    if (config.transport === "sse") {
      transport = new SSEClientTransport(url, {
        requestInit: hasHeaders ? { headers: allHeaders } : undefined,
        authProvider,
      });
    } else {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: hasHeaders ? { headers: allHeaders } : undefined,
        authProvider,
      });
    }
  } else {
    const env = buildStdioEnv(config);
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
      cwd: config.cwd,
      stderr: "pipe",
    });
  }

  try {
    await client.connect(transport);
  } catch (err: any) {
    // Debug: log the actual error details so we can see what's happening
    const errName = err?.constructor?.name || "unknown";
    const errMsg = err?.message || String(err);
    const errCode = err?.code || err?.statusCode || "none";
    console.error(`[mcp-bridge] connectServer catch for "${name}": class=${errName} code=${errCode} hasPending=${oauthProvider?.hasPendingAuth} msg=${errMsg}`);

    // Handle interactive OAuth: the transport throws UnauthorizedError after
    // calling redirectToAuthorization on our provider. We need to wait for the
    // user to complete auth in the browser, then finishAuth and reconnect.
    const isAuthError = err instanceof UnauthorizedError
      || /unauthori[zs]ed|authori[zs]ation|401/i.test(err?.message || "")
      || err?.statusCode === 401
      || err?.code === 401;
    console.error(`[mcp-bridge] isAuthError=${isAuthError} instanceof=${err instanceof UnauthorizedError}`);
    if (oauthProvider?.hasPendingAuth && isAuthError) {
      // Wait for the browser callback
      const code = await oauthProvider.waitForAuthorizationCode();

      // Exchange the code for tokens
      if ("finishAuth" in transport && typeof (transport as any).finishAuth === "function") {
        await (transport as any).finishAuth(code);
      }

      // Reconnect with fresh tokens — create new transport & client
      const freshClient = new Client(
        { name: `pi-mcp-bridge`, version: "1.0.0" },
        { capabilities: {} },
      );

      // Re-create transport with the same provider (now has tokens)
      if (isHttpConfig(config)) {
        const url = new URL(config.url);
        const authHeaders = config.auth && config.auth.type !== "oauth-client-credentials" && config.auth.type !== "oauth"
          ? buildAuthHeaders(config.auth)
          : undefined;
        const allHeaders = { ...(config.headers || {}), ...(authHeaders || {}) };
        const hasHeaders = Object.keys(allHeaders).length > 0;

        if (config.transport === "sse") {
          transport = new SSEClientTransport(url, {
            requestInit: hasHeaders ? { headers: allHeaders } : undefined,
            authProvider: oauthProvider,
          });
        } else {
          transport = new StreamableHTTPClientTransport(url, {
            requestInit: hasHeaders ? { headers: allHeaders } : undefined,
            authProvider: oauthProvider,
          });
        }
      }

      await freshClient.connect(transport);

      const toolsResult = await freshClient.listTools();
      return {
        name,
        client: freshClient,
        transport,
        tools: toolsResult.tools,
      };
    }

    // If we have an oauth provider but the SDK didn't reach redirectToAuthorization
    // (e.g. client registration failed), clean up and give a more helpful error
    if (oauthProvider && isAuthError) {
      oauthProvider.cleanup();
      throw new Error(
        `OAuth authentication failed for "${name}". ` +
        `Try clearing all auth state with /mcp-auth and reconnecting. ` +
        `Original error: ${err?.message || err}`
      );
    }

    // Clean up oauth provider if auth wasn't the issue
    oauthProvider?.cleanup();
    throw err;
  }

  // List available tools
  const toolsResult = await client.listTools();

  return {
    name,
    client,
    transport,
    tools: toolsResult.tools,
  };
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function mcpBridgeExtension(pi: ExtensionAPI) {
  const servers: ConnectedServer[] = [];

  /**
   * Connect to all configured MCP servers and register their tools.
   * Non-OAuth servers connect in parallel. OAuth servers connect sequentially
   * to avoid concurrent auth flows against the same auth server.
   */
  async function initServers(ctx: ExtensionContext) {
    const config = loadMcpConfig(ctx.cwd);
    const serverNames = Object.keys(config.mcpServers);

    if (serverNames.length === 0) {
      return;
    }

    ctx.ui.notify(`MCP: connecting to ${serverNames.length} server(s)...`, "info");

    // Split into non-OAuth (can parallelize) and OAuth (must serialize)
    const nonOAuthNames: string[] = [];
    const oauthNames: string[] = [];
    for (const name of serverNames) {
      const sc = config.mcpServers[name];
      if (isHttpConfig(sc) && sc.auth?.type === "oauth") {
        oauthNames.push(name);
      } else {
        nonOAuthNames.push(name);
      }
    }

    const onAuthUrl = (serverName: string, authUrl: string) => {
      ctx.ui.notify(
        `MCP: "${serverName}" requires authentication.\n\n` +
        `  Opening browser... If it doesn't open, visit:\n` +
        `  ${authUrl}`,
        "warning",
      );
    };

    // Phase 1: Connect non-OAuth servers in parallel
    const nonOAuthResults = await Promise.allSettled(
      nonOAuthNames.map((name) => connectServer(name, config.mcpServers[name], onAuthUrl)),
    );

    for (let i = 0; i < nonOAuthResults.length; i++) {
      const result = nonOAuthResults[i];
      const name = nonOAuthNames[i];
      if (result.status === "rejected") {
        ctx.ui.notify(`MCP: failed to connect to "${name}": ${result.reason?.message || result.reason}`, "error");
      } else {
        servers.push(result.value);
        registerServerTools(result.value);
      }
    }

    // Phase 2: Connect OAuth servers sequentially (one auth flow at a time)
    for (const name of oauthNames) {
      try {
        const server = await connectServer(name, config.mcpServers[name], onAuthUrl);
        servers.push(server);
        registerServerTools(server);
      } catch (err: any) {
        ctx.ui.notify(`MCP: failed to connect to "${name}": ${err?.message || err}`, "error");
      }
    }

    const totalTools = servers.reduce((sum, s) => sum + s.tools.length, 0);
    if (totalTools > 0) {
      const serverSummary = servers.map((s) => `${s.name} (${s.tools.length} tools)`).join(", ");
      ctx.ui.notify(`MCP: ${totalTools} tool(s) registered from: ${serverSummary}`, "success");
    }
  }

  /**
   * Register all tools from a connected server as pi tools.
   */
  function registerServerTools(server: ConnectedServer) {
    for (const mcpTool of server.tools) {
      const toolName = `mcp_${server.name}_${mcpTool.name}`;
      const parameters = mcpInputSchemaToTypebox(mcpTool.inputSchema);

      pi.registerTool({
        name: toolName,
        label: `${mcpTool.name} (${server.name})`,
        description: mcpTool.description || `MCP tool "${mcpTool.name}" from server "${server.name}"`,
        promptSnippet: `[MCP:${server.name}] ${mcpTool.description || mcpTool.name}`,
        parameters,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
          try {
            const result = await server.client.callTool(
              { name: mcpTool.name, arguments: params },
              undefined,
              { signal },
            );

            const textParts: string[] = [];
            const images: Array<{ type: "image"; source: { type: "base64"; mediaType: string; data: string } }> = [];

            if (result.content && Array.isArray(result.content)) {
              for (const block of result.content) {
                if (block.type === "text") {
                  textParts.push(block.text as string);
                } else if (block.type === "image") {
                  images.push({
                    type: "image",
                    source: {
                      type: "base64",
                      mediaType: (block as any).mimeType || "image/png",
                      data: (block as any).data || "",
                    },
                  });
                } else if (block.type === "resource") {
                  const resource = (block as any).resource;
                  if (resource?.text) {
                    textParts.push(`[Resource: ${resource.uri || "unknown"}]\n${resource.text}`);
                  }
                }
              }
            }

            const content: any[] = [];
            if (textParts.length > 0) {
              content.push({ type: "text" as const, text: textParts.join("\n") });
            }
            content.push(...images);

            if (content.length === 0) {
              content.push({ type: "text" as const, text: "(empty response)" });
            }

            return {
              content,
              isError: result.isError === true,
              details: { server: server.name, tool: mcpTool.name },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text" as const, text: `MCP error: ${err.message || err}` }],
              isError: true,
              details: { server: server.name, tool: mcpTool.name, error: err.message },
            };
          }
        },
      });
    }
  }

  /**
   * Disconnect all servers gracefully.
   */
  async function shutdownServers() {
    for (const server of servers) {
      try {
        await server.client.close();
      } catch {
        // Ignore shutdown errors
      }
    }
    servers.length = 0;
  }

  /**
   * Disconnect a single server by name.
   */
  async function disconnectServer(name: string) {
    const idx = servers.findIndex((s) => s.name === name);
    if (idx >= 0) {
      try {
        await servers[idx].client.close();
      } catch {
        // Ignore
      }
      servers.splice(idx, 1);
    }
  }

  /**
   * Connect a single server by name and register its tools.
   * Returns true on success.
   */
  async function connectSingleServer(
    name: string,
    serverConfig: ServerConfig,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    try {
      const server = await connectServer(name, serverConfig, (serverName, authUrl) => {
        ctx.ui.notify(
          `MCP: "${serverName}" requires authentication.\n\n` +
          `  Opening browser... If it doesn't open, visit:\n` +
          `  ${authUrl}`,
          "warning",
        );
      });

      servers.push(server);
      registerServerTools(server);
      return true;
    } catch (err: any) {
      console.error(`[mcp-bridge] connectSingleServer failed for "${name}": class=${err?.constructor?.name} msg=${err?.message || err}`);
      ctx.ui.notify(`MCP: failed to connect to "${name}": ${err.message || err}`, "error");
      return false;
    }
  }

  /**
   * Clear all OAuth state for a server (tokens, client registration, discovery cache).
   * Deletes the entire auth state file so the next connect does a fresh OAuth flow.
   * We can't selectively preserve discovery/client state because stale cache
   * (e.g. wrong authorizationServerUrl from a previous failed attempt) causes
   * subsequent connections to fail with InvalidTokenError.
   */
  function clearOAuthTokens(serverName: string): boolean {
    const authDir = path.join(process.env.HOME || "~", ".pi", "agent", "mcp-auth");
    const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const tokenPath = path.join(authDir, `${sanitized}.json`);
    try {
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Check if a server has saved OAuth tokens.
   */
  function hasOAuthTokens(serverName: string): boolean {
    const authDir = path.join(process.env.HOME || "~", ".pi", "agent", "mcp-auth");
    const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const tokenPath = path.join(authDir, `${sanitized}.json`);
    try {
      if (fs.existsSync(tokenPath)) {
        const raw = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
        return !!raw.tokens?.access_token;
      }
    } catch {
      // Ignore
    }
    return false;
  }

  // ── Lifecycle events ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await initServers(ctx);
  });

  pi.on("session_shutdown", async () => {
    await shutdownServers();
  });

  // ── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("mcp", {
    description: "Show configured and connected MCP servers",
    handler: async (_args, ctx) => {
      const paths = getConfigPaths(ctx.cwd);
      const globalConfig = loadSingleConfig(paths.global);
      const projectConfig = loadSingleConfig(paths.project);
      const allConfigured = { ...globalConfig.mcpServers, ...projectConfig.mcpServers };
      const configuredNames = Object.keys(allConfigured);

      if (configuredNames.length === 0 && servers.length === 0) {
        ctx.ui.notify(
          "MCP: no servers configured.\n\n" +
          "  Use /mcp-add to add a server, or edit:\n" +
          `  • Global:  ${paths.global}\n` +
          `  • Project: ${paths.project}`,
          "warning",
        );
        return;
      }

      const connectedNames = new Set(servers.map((s) => s.name));

      // Build selectable items for each server
      const items: SelectItem[] = configuredNames.map((name) => {
        const config = allConfigured[name];
        const isConnected = connectedNames.has(name);
        const scope = name in projectConfig.mcpServers ? "project" : "global";
        const transport = isHttpConfig(config) ? config.transport : "stdio";
        const icon = isConnected ? "●" : "○";

        let toolsInfo = "";
        if (isConnected) {
          const toolCount = servers.find((s) => s.name === name)?.tools.length ?? 0;
          toolsInfo = ` · ${toolCount} tool${toolCount !== 1 ? "s" : ""}`;
        }

        const auth = describeAuth((config as any).auth);
        const authInfo = auth !== "none" ? ` · ${auth}` : "";

        return {
          value: name,
          label: `${icon} ${name}`,
          description: `${scope} · ${transport}${toolsInfo}${authInfo}`,
        };
      });

      // Show interactive server list
      const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        const connectedCount = servers.length;
        const totalCount = configuredNames.length;
        container.addChild(new Text(
          theme.fg("accent", theme.bold(" MCP Servers"))
          + "  " + theme.fg("muted", `${connectedCount}/${totalCount} connected`),
          0, 0,
        ));

        const maxVisible = Math.min(items.length, 12);
        const selectList = new SelectList(items, maxVisible, {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("dim", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item: SelectItem) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(new Text(
          theme.fg("dim", " ↑↓") + theme.fg("muted", " navigate") +
          theme.fg("dim", "  enter") + theme.fg("muted", " actions") +
          theme.fg("dim", "  esc") + theme.fg("muted", " close"),
          0, 0,
        ));

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!selected) return;

      // Server selected — show action submenu
      const serverConfig = allConfigured[selected];
      const isConnected = connectedNames.has(selected);
      const isOAuth = isHttpConfig(serverConfig) && (serverConfig as HttpServerConfig).auth?.type === "oauth";
      const hasTokens = hasOAuthTokens(selected);

      const actions: string[] = [];
      if (isOAuth) {
        actions.push(hasTokens
          ? "re-auth   — clear auth state & re-authenticate"
          : "auth      — authenticate (no saved state)",
        );
      }
      actions.push(
        isConnected
          ? "reconnect — disconnect & reconnect"
          : "connect   — connect to server",
      );
      actions.push("remove    — remove from config");
      actions.push("cancel");

      const action = await ctx.ui.select(`"${selected}"`, actions);
      if (!action || action === "cancel") return;

      if (action.startsWith("re-auth") || action.startsWith("auth")) {
        // Wipe all auth state (tokens, client info, discovery cache) + reconnect
        clearOAuthTokens(selected);
        ctx.ui.notify(`MCP: cleared all auth state for "${selected}"`, "info");
        await disconnectServer(selected);
        ctx.ui.notify(`MCP: re-authenticating "${selected}"...`, "info");
        const ok = await connectSingleServer(selected, serverConfig, ctx);
        if (ok) {
          const toolCount = servers.find((s) => s.name === selected)?.tools.length ?? 0;
          ctx.ui.notify(`MCP: "${selected}" connected (${toolCount} tools)`, "success");
        }
      } else if (action.startsWith("reconnect") || action.startsWith("connect")) {
        await disconnectServer(selected);
        ctx.ui.notify(`MCP: reconnecting "${selected}"...`, "info");
        const ok = await connectSingleServer(selected, serverConfig, ctx);
        if (ok) {
          const toolCount = servers.find((s) => s.name === selected)?.tools.length ?? 0;
          ctx.ui.notify(`MCP: "${selected}" connected (${toolCount} tools)`, "success");
        }
      } else if (action.startsWith("remove")) {
        const scope = selected in projectConfig.mcpServers ? "project" : "global";
        const configPath = scope === "project" ? paths.project : paths.global;
        const confirmed = await ctx.ui.confirm("Remove?", `Remove "${selected}" from ${scope} config?`);
        if (!confirmed) return;

        const config = loadSingleConfig(configPath);
        delete config.mcpServers[selected];
        saveMcpConfig(configPath, config);

        await disconnectServer(selected);
        ctx.ui.notify(`MCP: removed "${selected}" from ${configPath}`, "success");
      }
    },
  });

  pi.registerCommand("mcp-add", {
    description: "Add an MCP server: /mcp-add [name command ...args] or interactive",
    handler: async (args, ctx) => {
      // ── Quick mode: /mcp-add name command arg1 arg2 ... ──
      if (args && args.trim().length > 0) {
        const parts = args.trim().split(/\s+/);
        if (parts.length >= 2) {
          const [name, command, ...cmdArgs] = parts;

          const scope = await ctx.ui.select("Save to:", [
            "global (~/.pi/agent/mcp.json)",
            "project (.pi/mcp.json)",
          ]);
          if (scope === undefined) return;

          const paths = getConfigPaths(ctx.cwd);
          const configPath = scope.startsWith("global") ? paths.global : paths.project;
          const config = loadSingleConfig(configPath);

          if (config.mcpServers[name]) {
            const overwrite = await ctx.ui.confirm("Overwrite?", `Server "${name}" already exists in this config. Replace it?`);
            if (!overwrite) return;
          }

          config.mcpServers[name] = {
            command,
            args: cmdArgs.length > 0 ? cmdArgs : undefined,
          } as StdioServerConfig;

          saveMcpConfig(configPath, config);
          ctx.ui.notify(`MCP: added "${name}" (${command} ${cmdArgs.join(" ")}) to ${configPath}`, "success");

          const connect = await ctx.ui.confirm("Connect now?", `Connect to "${name}" immediately?`);
          if (connect) {
            const ok = await connectSingleServer(name, config.mcpServers[name], ctx);
            if (ok) {
              const toolCount = servers.find((s) => s.name === name)?.tools.length ?? 0;
              ctx.ui.notify(`MCP: "${name}" connected (${toolCount} tools)`, "success");
            }
          }
          return;
        }
      }

      // ── Interactive mode ──

      // 1. Transport type
      const transportType = await ctx.ui.select("Server type:", [
        "stdio (local command)",
        "streamable-http (remote URL)",
        "sse (remote URL, legacy)",
      ]);
      if (transportType === undefined) return;

      // 2. Server name
      const name = await ctx.ui.input("Server name:", "my-server");
      if (!name || !name.trim()) {
        ctx.ui.notify("MCP: server name is required", "error");
        return;
      }
      const serverName = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-");

      // 3. Transport-specific config
      let serverConfig: ServerConfig;

      if (transportType.startsWith("stdio")) {
        const command = await ctx.ui.input("Command:", "npx");
        if (!command || !command.trim()) {
          ctx.ui.notify("MCP: command is required", "error");
          return;
        }

        const argsStr = await ctx.ui.input("Arguments (space-separated):", "-y @modelcontextprotocol/server-...");
        const cmdArgs = argsStr ? argsStr.trim().split(/\s+/).filter(Boolean) : [];

        // Auth for stdio
        const authChoice = await ctx.ui.select("Authentication:", [
          "none",
          "env — pass environment variables to the server process",
        ]);

        let auth: EnvAuth | undefined;
        if (authChoice?.startsWith("env")) {
          const envMap: Record<string, string> = {};
          let addMore = true;
          while (addMore) {
            const childVar = await ctx.ui.input("Env var name in server process:", "API_KEY");
            if (!childVar || !childVar.trim()) break;

            const source = await ctx.ui.input(
              `Source for ${childVar.trim()} (env var name or literal value):`,
              childVar.trim(),
            );
            if (source !== undefined) {
              envMap[childVar.trim()] = source;
            }

            addMore = await ctx.ui.confirm("More?", "Add another environment variable?");
          }
          if (Object.keys(envMap).length > 0) {
            auth = { type: "env", env: envMap };
          }
        }

        // Legacy env support (non-auth env vars)
        const addEnv = await ctx.ui.confirm("Extra environment?", "Add non-auth environment variables?");
        let env: Record<string, string> | undefined;
        if (addEnv) {
          env = {};
          let addMore = true;
          while (addMore) {
            const key = await ctx.ui.input("Env var name:", "NODE_ENV");
            if (!key || !key.trim()) break;
            const value = await ctx.ui.input(`Value for ${key.trim()}:`, "");
            if (value !== undefined) {
              env[key.trim()] = value;
            }
            addMore = await ctx.ui.confirm("More?", "Add another environment variable?");
          }
          if (Object.keys(env).length === 0) env = undefined;
        }

        serverConfig = {
          command: command.trim(),
          args: cmdArgs.length > 0 ? cmdArgs : undefined,
          env,
          auth,
        } as StdioServerConfig;

      } else {
        // HTTP transport
        const url = await ctx.ui.input("Server URL:", "http://localhost:3001/mcp");
        if (!url || !url.trim()) {
          ctx.ui.notify("MCP: URL is required", "error");
          return;
        }

        const transport: "streamable-http" | "sse" = transportType.startsWith("streamable") ? "streamable-http" : "sse";

        // Auth for HTTP
        const authChoice = await ctx.ui.select("Authentication:", [
          "none",
          "oauth  — browser login (Backstage, SSO, etc.)",
          "bearer — Authorization: Bearer <token>",
          "header — custom header (e.g. X-API-Key)",
          "oauth-credentials — OAuth 2.0 client_credentials (M2M)",
        ]);

        let auth: BearerAuth | HeaderAuth | OAuthClientCredentialsAuth | OAuthInteractiveAuth | undefined;

        if (authChoice?.startsWith("oauth  ")) {
          // Interactive OAuth — browser-based login
          const portStr = await ctx.ui.input("Callback port (0 = auto-assign):", "0");
          const callbackPort = parseInt(portStr || "0", 10) || 0;
          const timeoutStr = await ctx.ui.input("Auth timeout in seconds:", "120");
          const callbackTimeoutSeconds = parseInt(timeoutStr || "120", 10) || 120;
          auth = { type: "oauth", callbackPort, callbackTimeoutSeconds };
        } else if (authChoice?.startsWith("bearer")) {
          const tokenSource = await ctx.ui.select("Token source:", [
            "env — read from environment variable (recommended)",
            "literal — store token directly in config",
          ]);

          if (tokenSource?.startsWith("env")) {
            const envVar = await ctx.ui.input("Environment variable name:", "MCP_API_TOKEN");
            if (envVar?.trim()) {
              auth = { type: "bearer", tokenEnvVar: envVar.trim() };
            }
          } else if (tokenSource?.startsWith("literal")) {
            const token = await ctx.ui.input("Bearer token:", "");
            if (token) {
              auth = { type: "bearer", token };
            }
          }
        } else if (authChoice?.startsWith("header")) {
          const headerName = await ctx.ui.input("Header name:", "X-API-Key");
          if (!headerName?.trim()) {
            ctx.ui.notify("MCP: header name is required", "error");
            return;
          }

          const valueSource = await ctx.ui.select("Value source:", [
            "env — read from environment variable (recommended)",
            "literal — store value directly in config",
          ]);

          if (valueSource?.startsWith("env")) {
            const envVar = await ctx.ui.input("Environment variable name:", "MCP_API_KEY");
            if (envVar?.trim()) {
              auth = { type: "header", name: headerName.trim(), valueEnvVar: envVar.trim() };
            }
          } else if (valueSource?.startsWith("literal")) {
            const value = await ctx.ui.input(`Value for ${headerName.trim()}:`, "");
            if (value) {
              auth = { type: "header", name: headerName.trim(), value };
            }
          }
        } else if (authChoice?.startsWith("oauth-credentials")) {
          const credSource = await ctx.ui.select("Credentials source:", [
            "env — read from environment variables (recommended)",
            "literal — store credentials directly in config",
          ]);

          if (credSource?.startsWith("env")) {
            const clientIdVar = await ctx.ui.input("Client ID env var:", "MCP_CLIENT_ID");
            const clientSecretVar = await ctx.ui.input("Client Secret env var:", "MCP_CLIENT_SECRET");
            const scope = await ctx.ui.input("Scopes (space-separated, optional):", "");
            auth = {
              type: "oauth-client-credentials",
              clientIdEnvVar: clientIdVar?.trim() || undefined,
              clientSecretEnvVar: clientSecretVar?.trim() || undefined,
              scope: scope?.trim() || undefined,
            };
          } else if (credSource?.startsWith("literal")) {
            const clientId = await ctx.ui.input("Client ID:", "");
            const clientSecret = await ctx.ui.input("Client Secret:", "");
            const scope = await ctx.ui.input("Scopes (space-separated, optional):", "");
            auth = {
              type: "oauth-client-credentials",
              clientId: clientId?.trim() || undefined,
              clientSecret: clientSecret?.trim() || undefined,
              scope: scope?.trim() || undefined,
            };
          }
        }

        serverConfig = {
          url: url.trim(),
          transport,
          auth,
        } as HttpServerConfig;
      }

      // 4. Scope
      const scope = await ctx.ui.select("Save to:", [
        "global (~/.pi/agent/mcp.json)",
        "project (.pi/mcp.json)",
      ]);
      if (scope === undefined) return;

      const paths = getConfigPaths(ctx.cwd);
      const configPath = scope.startsWith("global") ? paths.global : paths.project;
      const config = loadSingleConfig(configPath);

      if (config.mcpServers[serverName]) {
        const overwrite = await ctx.ui.confirm("Overwrite?", `Server "${serverName}" already exists. Replace it?`);
        if (!overwrite) return;
      }

      config.mcpServers[serverName] = serverConfig;
      saveMcpConfig(configPath, config);

      const detail = isHttpConfig(serverConfig)
        ? `${serverConfig.transport} → ${serverConfig.url}`
        : `${(serverConfig as StdioServerConfig).command} ${(serverConfig as StdioServerConfig).args?.join(" ") || ""}`;

      const authDesc = describeAuth((serverConfig as any).auth);
      ctx.ui.notify(
        `MCP: added "${serverName}" to ${configPath}\n  ${detail}${authDesc !== "none" ? `\n  auth: ${authDesc}` : ""}`,
        "success",
      );

      // 5. Connect now?
      const connect = await ctx.ui.confirm("Connect now?", `Connect to "${serverName}" immediately?`);
      if (connect) {
        const ok = await connectSingleServer(serverName, serverConfig, ctx);
        if (ok) {
          const toolCount = servers.find((s) => s.name === serverName)?.tools.length ?? 0;
          ctx.ui.notify(`MCP: "${serverName}" connected (${toolCount} tools)`, "success");
        }
      }
    },
  });

  pi.registerCommand("mcp-remove", {
    description: "Remove an MCP server from config",
    handler: async (_args, ctx) => {
      const paths = getConfigPaths(ctx.cwd);
      const globalConfig = loadSingleConfig(paths.global);
      const projectConfig = loadSingleConfig(paths.project);

      const entries: Array<{ label: string; name: string; scope: "global" | "project"; configPath: string }> = [];

      for (const name of Object.keys(globalConfig.mcpServers)) {
        const config = globalConfig.mcpServers[name];
        const detail = isHttpConfig(config) ? config.url : `${config.command} ${config.args?.join(" ") || ""}`;
        entries.push({
          label: `${name} (global) — ${detail}`,
          name,
          scope: "global",
          configPath: paths.global,
        });
      }

      for (const name of Object.keys(projectConfig.mcpServers)) {
        const config = projectConfig.mcpServers[name];
        const detail = isHttpConfig(config) ? config.url : `${config.command} ${config.args?.join(" ") || ""}`;
        entries.push({
          label: `${name} (project) — ${detail}`,
          name,
          scope: "project",
          configPath: paths.project,
        });
      }

      if (entries.length === 0) {
        ctx.ui.notify("MCP: no servers configured to remove", "warning");
        return;
      }

      const selected = await ctx.ui.select("Remove which server?", entries.map((e) => e.label));
      if (selected === undefined) return;

      const entry = entries.find((e) => e.label === selected);
      if (!entry) return;

      const confirmed = await ctx.ui.confirm("Remove?", `Remove "${entry.name}" from ${entry.scope} config?`);
      if (!confirmed) return;

      const config = loadSingleConfig(entry.configPath);
      delete config.mcpServers[entry.name];
      saveMcpConfig(entry.configPath, config);

      ctx.ui.notify(`MCP: removed "${entry.name}" from ${entry.configPath}`, "success");

      const connectedIdx = servers.findIndex((s) => s.name === entry.name);
      if (connectedIdx >= 0) {
        try {
          await servers[connectedIdx].client.close();
        } catch {
          // Ignore
        }
        servers.splice(connectedIdx, 1);
        ctx.ui.notify(`MCP: disconnected "${entry.name}"`, "info");
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Manage OAuth tokens for MCP servers",
    handler: async (_args, ctx) => {
      const authDir = path.join(process.env.HOME || "~", ".pi", "agent", "mcp-auth");

      // List all persisted auth states
      let files: string[] = [];
      try {
        if (fs.existsSync(authDir)) {
          files = fs.readdirSync(authDir).filter((f) => f.endsWith(".json"));
        }
      } catch {
        // Ignore
      }

      if (files.length === 0) {
        ctx.ui.notify("MCP: no saved OAuth tokens", "info");
        return;
      }

      const entries = files.map((f) => {
        const name = f.replace(/\.json$/, "");
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(authDir, f), "utf-8"));
          const hasTokens = !!raw.tokens?.access_token;
          const hasRefresh = !!raw.tokens?.refresh_token;
          return {
            label: `${name} — ${hasTokens ? "✓ has token" : "✗ no token"}${hasRefresh ? " (+ refresh)" : ""}`,
            name,
            filePath: path.join(authDir, f),
          };
        } catch {
          return { label: `${name} — (invalid)`, name, filePath: path.join(authDir, f) };
        }
      });

      const action = await ctx.ui.select("OAuth tokens:", [
        ...entries.map((e) => e.label),
        "── clear all tokens ──",
      ]);
      if (action === undefined) return;

      if (action === "── clear all tokens ──") {
        const confirmed = await ctx.ui.confirm("Clear all?", "Delete all saved OAuth tokens? You'll need to re-authenticate.");
        if (!confirmed) return;
        for (const entry of entries) {
          try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ }
        }
        ctx.ui.notify("MCP: cleared all OAuth tokens", "success");
        return;
      }

      const entry = entries.find((e) => e.label === action);
      if (!entry) return;

      const entryAction = await ctx.ui.select(`"${entry.name}" tokens:`, [
        "clear — delete saved tokens (will re-auth on next connect)",
        "cancel",
      ]);

      if (entryAction?.startsWith("clear")) {
        try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ }
        ctx.ui.notify(`MCP: cleared OAuth tokens for "${entry.name}"`, "success");
      }
    },
  });

  pi.registerCommand("mcp-discover", {
    description: "Browse and add MCP servers from the Spotify catalog",
    handler: async (_args, ctx) => {
      // Check if MCP Explorer is connected
      const explorerServer = servers.find((s) => s.name === "MCP-Explorer");
      if (!explorerServer) {
        ctx.ui.notify(
          "MCP: MCP-Explorer server is not connected.\n\n" +
          "  Add it first with /mcp-add or edit ~/.pi/agent/mcp.json:\n" +
          '  "MCP-Explorer": {\n' +
          '    "url": "https://mcp-gateway.spotify.net/mcp-explorer-mcp",\n' +
          '    "transport": "streamable-http",\n' +
          '    "auth": { "type": "oauth" }\n' +
          "  }",
          "warning",
        );
        return;
      }

      // Fetch server list from MCP Explorer
      ctx.ui.notify("MCP: fetching server catalog...", "info");

      let catalogServers: Array<{
        name: string;
        title: string;
        description: string;
        owner: string;
        lifecycle: string;
      }>;

      try {
        const result = await explorerServer.client.callTool(
          { name: "list_mcp_servers", arguments: {} },
          undefined,
        );
        const text = (result.content as any[])?.find((b: any) => b.type === "text")?.text;
        if (!text) throw new Error("Empty response");
        const parsed = JSON.parse(text);
        catalogServers = parsed.servers ?? [];
      } catch (err: any) {
        ctx.ui.notify(`MCP: failed to fetch catalog: ${err.message || err}`, "error");
        return;
      }

      // Filter out legacy servers (deprecated duplicates with active replacements)
      catalogServers = catalogServers.filter((s) => !s.name.endsWith("-legacy"));

      if (catalogServers.length === 0) {
        ctx.ui.notify("MCP: no servers found in catalog", "warning");
        return;
      }

      // Figure out which ones are already configured
      const currentConfig = loadMcpConfig(ctx.cwd);
      const configuredUrls = new Set(
        Object.values(currentConfig.mcpServers)
          .filter((c) => isHttpConfig(c))
          .map((c) => (c as HttpServerConfig).url),
      );

      // Build select list items
      const items: SelectItem[] = catalogServers
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => {
          const url = `https://mcp-gateway.spotify.net/${s.name}`;
          const installed = configuredUrls.has(url);
          return {
            value: s.name,
            label: `${installed ? "✓" : " "} ${s.title || s.name}`,
            description: `${s.owner} · ${s.lifecycle}${s.description ? " — " + s.description : ""}`,
          };
        });

      // Show selection UI
      const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        container.addChild(new Text(
          theme.fg("accent", theme.bold(" Discover MCP Servers"))
          + "  " + theme.fg("muted", `${catalogServers.length} available`),
          0, 0,
        ));

        const maxVisible = Math.min(items.length, 16);
        const selectList = new SelectList(items, maxVisible, {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("dim", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item: SelectItem) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(new Text(
          theme.fg("dim", " ↑↓") + theme.fg("muted", " navigate") +
          theme.fg("dim", "  type") + theme.fg("muted", " to filter") +
          theme.fg("dim", "  enter") + theme.fg("muted", " add") +
          theme.fg("dim", "  esc") + theme.fg("muted", " cancel") +
          theme.fg("dim", "  ✓") + theme.fg("muted", " = installed"),
          0, 0,
        ));

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!selected) return;

      // Fetch details for the selected server
      let serverDetail: { name: string; title: string; description: string; connection_url: string };
      try {
        const result = await explorerServer.client.callTool(
          { name: "get_mcp_server", arguments: { name: selected } },
          undefined,
        );
        const text = (result.content as any[])?.find((b: any) => b.type === "text")?.text;
        if (!text) throw new Error("Empty response");
        const parsed = JSON.parse(text);
        serverDetail = parsed.server;
      } catch (err: any) {
        ctx.ui.notify(`MCP: failed to fetch server details: ${err.message || err}`, "error");
        return;
      }

      const url = serverDetail.connection_url || `https://mcp-gateway.spotify.net/${selected}`;

      // Check if already configured
      if (configuredUrls.has(url)) {
        ctx.ui.notify(`MCP: "${serverDetail.title || selected}" is already configured`, "info");
        return;
      }

      // Confirm and choose scope
      const scope = await ctx.ui.select(
        `Add "${serverDetail.title || selected}"?`,
        [
          "global (~/.pi/agent/mcp.json)",
          "project (.pi/mcp.json)",
          "cancel",
        ],
      );
      if (!scope || scope === "cancel") return;

      const paths = getConfigPaths(ctx.cwd);
      const configPath = scope.startsWith("global") ? paths.global : paths.project;
      const config = loadSingleConfig(configPath);

      config.mcpServers[selected] = {
        url,
        transport: "streamable-http",
        auth: {
          type: "oauth",
          callbackPort: 0,
          callbackTimeoutSeconds: 120,
        },
      } as HttpServerConfig;

      saveMcpConfig(configPath, config);
      ctx.ui.notify(
        `MCP: added "${serverDetail.title || selected}" → ${url}`,
        "success",
      );

      const connect = await ctx.ui.confirm("Connect now?", `Connect to "${selected}" immediately?`);
      if (connect) {
        const ok = await connectSingleServer(selected, config.mcpServers[selected], ctx);
        if (ok) {
          const toolCount = servers.find((s) => s.name === selected)?.tools.length ?? 0;
          ctx.ui.notify(`MCP: "${selected}" connected (${toolCount} tools)`, "success");
        }
      }
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "Reconnect to all MCP servers",
    handler: async (_args, ctx) => {
      await shutdownServers();
      await initServers(ctx);
    },
  });
}
