/**
 * Interactive OAuth provider for MCP servers.
 *
 * Implements the full OAuth authorization code flow with PKCE:
 * 1. Server returns 401 → SDK discovers OAuth metadata
 * 2. SDK calls redirectToAuthorization() → we open browser + start local callback server
 * 3. User authenticates in browser → redirected to http://localhost:{port}/callback
 * 4. We catch the code → SDK exchanges it for tokens
 *
 * Tokens, client info, and PKCE verifiers are persisted to ~/.pi/agent/mcp-auth/
 * so they survive restarts.
 */

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

interface PersistedOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  server: http.Server;
  state: string;
}

// ── Storage ────────────────────────────────────────────────────────────────

const AUTH_DIR = path.join(process.env.HOME || "~", ".pi", "agent", "mcp-auth");

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getStatePath(serverName: string): string {
  return path.join(AUTH_DIR, `${sanitizeFileName(serverName)}.json`);
}

function loadState(serverName: string): PersistedOAuthState {
  try {
    const filePath = getStatePath(serverName);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return {};
}

function saveState(serverName: string, state: PersistedOAuthState): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  fs.writeFileSync(getStatePath(serverName), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ── Callback Server ────────────────────────────────────────────────────────

/**
 * Find a free port by binding to 0 and reading what the OS assigned.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not find free port")));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * Start a local HTTP server that waits for the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
function startCallbackServer(
  port: number,
  expectedState: string,
  timeoutMs: number = 120_000,
): { promise: Promise<string>; server: http.Server } {
  let resolve: (code: string) => void;
  let reject: (err: Error) => void;

  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authorization failed</h2><p>${errorDesc || error}</p><p>You can close this tab.</p></body></html>`);
        reject!(new Error(`OAuth error: ${errorDesc || error}`));
        return;
      }

      if (state && state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>State mismatch</h2><p>OAuth state parameter does not match. Please try again.</p></body></html>`);
        reject!(new Error("OAuth state mismatch"));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Missing code</h2><p>No authorization code received.</p></body></html>`);
        reject!(new Error("No authorization code received"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h2>✓ Authorized</h2><p>You can close this tab and return to your terminal.</p></body></html>`);
      resolve!(code);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, "127.0.0.1");

  // Timeout
  const timer = setTimeout(() => {
    reject!(new Error(`OAuth callback timed out after ${timeoutMs / 1000}s`));
    server.close();
  }, timeoutMs);

  // Clean up timer on resolution
  promise.finally(() => {
    clearTimeout(timer);
    server.close();
  });

  return { promise, server };
}

// ── Provider ───────────────────────────────────────────────────────────────

export interface InteractiveOAuthProviderOptions {
  /** Unique name for this server (used for file-based persistence) */
  serverName: string;
  /** Callback port to use (0 = auto-assign) */
  callbackPort?: number;
  /** Called when the user needs to visit a URL to authenticate */
  onAuthUrl: (url: string) => void;
  /** Timeout for waiting for the OAuth callback (default: 120s) */
  callbackTimeoutMs?: number;
}

export class InteractiveOAuthProvider implements OAuthClientProvider {
  private _serverName: string;
  private _state: PersistedOAuthState;
  private _callbackPort: number;
  private _onAuthUrl: (url: string) => void;
  private _callbackTimeoutMs: number;

  // Runtime state for pending auth flow
  private _pendingAuth?: PendingAuth;
  private _oauthState: string = randomUUID();
  private _resolvedPort?: number;

  constructor(options: InteractiveOAuthProviderOptions) {
    this._serverName = options.serverName;
    this._state = loadState(options.serverName);
    this._callbackPort = options.callbackPort ?? 0;
    this._onAuthUrl = options.onAuthUrl;
    this._callbackTimeoutMs = options.callbackTimeoutMs ?? 120_000;
  }

  get redirectUrl(): string | URL {
    // Use resolved port if we have one, otherwise a placeholder that gets
    // replaced when we actually start the callback server
    const port = this._resolvedPort || this._callbackPort || 19876;
    return new URL(`http://127.0.0.1:${port}/callback`);
  }

  get clientMetadata(): OAuthClientMetadata {
    const port = this._resolvedPort || this._callbackPort || 19876;
    return {
      redirect_uris: [`http://127.0.0.1:${port}/callback`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: `pi-mcp-bridge (${this._serverName})`,
      scope: "openid profile",
    };
  }

  state(): string {
    return this._oauthState;
  }

  // ── Client Information ─────────────────────────────────────────────────

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._state.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._state.clientInformation = info;
    saveState(this._serverName, this._state);
  }

  // ── Tokens ─────────────────────────────────────────────────────────────

  tokens(): OAuthTokens | undefined {
    return this._state.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._state.tokens = tokens;
    saveState(this._serverName, this._state);
  }

  // ── PKCE ───────────────────────────────────────────────────────────────

  saveCodeVerifier(codeVerifier: string): void {
    this._state.codeVerifier = codeVerifier;
    saveState(this._serverName, this._state);
  }

  codeVerifier(): string {
    return this._state.codeVerifier || "";
  }

  // ── Discovery State ────────────────────────────────────────────────────

  saveDiscoveryState(ds: OAuthDiscoveryState): void {
    this._state.discoveryState = ds;
    saveState(this._serverName, this._state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._state.discoveryState;
  }

  // ── Authorization Flow ─────────────────────────────────────────────────

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Allocate a port for the callback server
    const port = this._callbackPort || await findFreePort();
    this._resolvedPort = port;

    // Start the local callback server
    const { promise, server } = startCallbackServer(port, this._oauthState, this._callbackTimeoutMs);

    // Store pending auth so we can retrieve the code later
    this._pendingAuth = {
      resolve: () => {},
      reject: () => {},
      server,
      state: this._oauthState,
    };

    // Update the authorization URL to use our actual callback port
    // (in case it was registered with a different port during client registration)
    const authUrl = authorizationUrl.toString();

    // Notify the user
    this._onAuthUrl(authUrl);

    // Try to open the browser
    try {
      const { exec } = await import("node:child_process");
      const platform = process.platform;
      const openCmd = platform === "darwin" ? "open"
        : platform === "win32" ? "start"
        : "xdg-open";
      exec(`${openCmd} '${authUrl.replace(/'/g, "'\\''")}'`);
    } catch {
      // Browser open failed, user will use the URL from notification
    }

    // Wait for the callback — this blocks until the user completes auth
    // The SDK's auth() function calls redirectToAuthorization and then returns
    // 'REDIRECT'. The transport catches UnauthorizedError and retries.
    // We need to store the promise so finishAuth can retrieve the code.
    this._pendingAuthPromise = promise;
  }

  // The pending auth promise (set by redirectToAuthorization)
  private _pendingAuthPromise?: Promise<string>;

  /**
   * Wait for the user to complete the OAuth flow and return the authorization code.
   * This is called externally after redirectToAuthorization to block until the
   * callback arrives.
   */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this._pendingAuthPromise) {
      throw new Error("No pending authorization flow");
    }
    const code = await this._pendingAuthPromise;
    this._pendingAuthPromise = undefined;
    return code;
  }

  /**
   * Whether there's a pending auth flow waiting for a callback.
   */
  get hasPendingAuth(): boolean {
    return this._pendingAuthPromise !== undefined;
  }

  // ── Credential Invalidation ────────────────────────────────────────────

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    switch (scope) {
      case "all":
        this._state = {};
        break;
      case "client":
        delete this._state.clientInformation;
        break;
      case "tokens":
        delete this._state.tokens;
        break;
      case "verifier":
        delete this._state.codeVerifier;
        break;
      case "discovery":
        delete this._state.discoveryState;
        break;
    }
    saveState(this._serverName, this._state);
  }

  /**
   * Clean up any running servers.
   */
  cleanup(): void {
    if (this._pendingAuth?.server) {
      try {
        this._pendingAuth.server.close();
      } catch {
        // Ignore
      }
    }
  }
}
