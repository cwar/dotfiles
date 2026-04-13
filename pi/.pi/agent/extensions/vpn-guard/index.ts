/**
 * VPN Guard -- Detect VPN-protected resource failures and prevent workarounds.
 *
 * When the AI runs a command that fails because VPN is disconnected, this
 * extension intercepts the tool result and injects a clear warning so the
 * LLM knows to ask the user to connect rather than attempting workarounds.
 *
 * Also provides a `check_vpn` tool for proactive status checks and injects
 * VPN-awareness into the system prompt.
 *
 * Detection covers:
 *   - GHE IP allow-list rejections (spotify.ghe.com)
 *   - Connection refused/timeouts to known internal domains
 *   - DNS resolution failures for internal hostnames
 *   - SSH connection failures to internal hosts
 *   - Generic "network unreachable" to internal IPs/hosts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";

// -- VPN-Protected Domain Patterns ------------------------------------------

/** Domains/patterns that require Spotify GlobalProtect VPN */
const VPN_REQUIRED_DOMAINS: Array<string | RegExp> = [
  "spotify.ghe.com",
  "backstage.spotify.net",
  "backstage-backend.spotify.net",
  "go.spotify.net",
  // Generic internal patterns
  /[a-z0-9-]+\.spotify\.net\b/,
  /[a-z0-9-]+\.spotilocal\.com\b/,
  /[a-z0-9-]+\.spotify\.internal\b/,
];

/** Domains that do NOT require VPN (explicit exceptions) */
const VPN_NOT_REQUIRED = [
  "ghe.spotify.net",        // accessible without VPN
  "spotify.com",            // public
  "open.spotify.com",       // public
  "developer.spotify.com",  // public
  "spotify.gpcloudservice.com", // the VPN portal itself
];

// -- Failure Pattern Matchers -----------------------------------------------

interface VpnFailurePattern {
  /** Regex to match against tool output */
  pattern: RegExp;
  /** Human-readable description of what was detected */
  description: string;
}

/** Internal host pattern fragment (reused across regexes) */
const INTERNAL = String.raw`(?:spotify\.net|spotify\.ghe\.com|spotilocal\.com|spotify\.internal)`;
const TIMEOUT = String.raw`(?:Connection timed out|connect timed out|Operation timed out)`;
const DNS_FAIL = String.raw`(?:Could not resolve host|Name or service not known|Temporary failure in name resolution)`;
const CONN_REFUSED = String.raw`Connection refused`;

const FAILURE_PATTERNS: VpnFailurePattern[] = [
  // GHE IP allow-list rejection
  {
    pattern: /IP allow list enabled.*not permitted to access/is,
    description: "GHE IP allow-list rejection -- spotify.ghe.com requires VPN",
  },
  // 403 from spotify.ghe.com (either ordering in the error message)
  {
    pattern: new RegExp(
      String.raw`(?:The requested URL returned error: 403.*spotify\.ghe\.com|spotify\.ghe\.com.*The requested URL returned error: 403)`,
      "is",
    ),
    description: "403 from spotify.ghe.com -- VPN required",
  },
  // Connection refused to internal hosts (both orderings)
  {
    pattern: new RegExp(`${CONN_REFUSED}.*${INTERNAL}`, "is"),
    description: "Connection refused to internal Spotify host",
  },
  {
    pattern: new RegExp(`${INTERNAL}.*${CONN_REFUSED}`, "is"),
    description: "Connection refused to internal Spotify host",
  },
  // Connection timeout to internal hosts (both orderings)
  {
    pattern: new RegExp(`${TIMEOUT}.*${INTERNAL}`, "is"),
    description: "Connection timeout to internal Spotify host",
  },
  {
    pattern: new RegExp(`${INTERNAL}.*${TIMEOUT}`, "is"),
    description: "Connection timeout to internal Spotify host",
  },
  // DNS resolution failures for internal hosts (both orderings)
  {
    pattern: new RegExp(`${DNS_FAIL}.*${INTERNAL}`, "is"),
    description: "DNS resolution failure for internal Spotify host",
  },
  {
    pattern: new RegExp(`${INTERNAL}.*${DNS_FAIL}`, "is"),
    description: "DNS resolution failure for internal Spotify host",
  },
  // SSH failures to internal hosts
  {
    pattern: new RegExp(
      String.raw`ssh:.*(?:Connection refused|Connection timed out|No route to host).*(?:spotify\.net|spotilocal\.com)`,
      "is",
    ),
    description: "SSH connection failure to internal Spotify host",
  },
  // curl specific error codes to internal hosts
  {
    pattern: new RegExp(String.raw`curl:.*(?:\(7\)|\(28\)|\(6\)).*${INTERNAL}`, "is"),
    description: "curl connection failure to internal Spotify host",
  },
  {
    pattern: new RegExp(String.raw`${INTERNAL}.*curl:.*(?:\(7\)|\(28\)|\(6\))`, "is"),
    description: "curl connection failure to internal Spotify host",
  },
  // Network unreachable to 10.x internal ranges (common with VPN)
  {
    pattern: /(?:Network is unreachable|No route to host).*10\.\d+\.\d+\.\d+/is,
    description: "Network unreachable to internal IP range (likely VPN-dependent)",
  },
  {
    pattern: /10\.\d+\.\d+\.\d+.*(?:Network is unreachable|No route to host)/is,
    description: "Network unreachable to internal IP range (likely VPN-dependent)",
  },
];

// -- Helpers ----------------------------------------------------------------

function checkGpConnected(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ip", ["link", "show", "gpd0"], (err) => {
      resolve(!err);
    });
  });
}

function detectVpnFailure(output: string): VpnFailurePattern | null {
  for (const fp of FAILURE_PATTERNS) {
    if (fp.pattern.test(output)) {
      return fp;
    }
  }
  return null;
}

// -- The VPN failure banner injected into tool results --

const VPN_BANNER = [
  "",
  "================================================================",
  "  WARNING: VPN DISCONNECTED",
  "",
  "  This failure is because GlobalProtect VPN is off.",
  "  DO NOT attempt workarounds or alternative approaches.",
  "  Ask the user to connect to VPN first:",
  "",
  '    Run: vpn   (then choose "GP: Quick connect (US East)")',
  "",
  "  Once connected, retry the original command.",
  "================================================================",
  "",
].join("\n");

// -- Extension --------------------------------------------------------------

export default function vpnGuard(pi: ExtensionAPI) {

  // -- Intercept tool results for VPN failure detection ---------------------
  pi.on("tool_result", async (event, _ctx) => {
    // Only inspect bash tool results (where network errors surface)
    if (!isBashToolResult(event)) return;

    // Extract text content from the result
    const textParts = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text);
    const fullOutput = textParts.join("\n");

    // Check for known VPN failure patterns
    const failure = detectVpnFailure(fullOutput);
    if (!failure) return;

    // Confirm VPN is actually disconnected (avoid false positives)
    const gpConnected = await checkGpConnected();
    if (gpConnected) return; // GP is up -- this error is something else

    // Inject the VPN banner into the tool result
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: VPN_BANNER + "Detected: " + failure.description },
      ],
    };
  });

  // -- Custom tool: check_vpn -----------------------------------------------
  pi.registerTool({
    name: "check_vpn",
    label: "Check VPN",
    description:
      "Check if the Spotify GlobalProtect VPN is connected. Use this before " +
      "accessing internal Spotify resources (spotify.ghe.com, *.spotify.net, etc.) " +
      "if you suspect VPN might be disconnected.",
    promptSnippet: "Check Spotify VPN (GlobalProtect) connection status",
    promptGuidelines: [
      "Before accessing spotify.ghe.com or other VPN-protected internal resources, " +
      "use check_vpn if a previous attempt failed with connection errors.",
      "If check_vpn reports disconnected, tell the user to run `vpn` and connect " +
      "before retrying. Do NOT attempt workarounds or public internet alternatives.",
    ],
    parameters: Type.Object({}),

    async execute() {
      const gpConnected = await checkGpConnected();

      if (gpConnected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "GlobalProtect VPN is connected (gpd0 interface is up).",
            },
          ],
          details: { connected: true },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "GlobalProtect VPN is NOT connected.",
              "",
              "The user needs to connect before accessing internal Spotify resources.",
              'Tell them to run: vpn  then select "GP: Quick connect (US East)"',
              "",
              "Do NOT attempt workarounds. Wait for VPN to be connected, then retry.",
            ].join("\n"),
          },
        ],
        details: { connected: false },
      };
    },
  });

  // -- System prompt injection for VPN awareness ----------------------------
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        "## VPN Awareness\n" +
        "Some Spotify resources require GlobalProtect VPN (spotify.ghe.com, most *.spotify.net hosts). " +
        "If you encounter connection failures (refused, timeout, DNS failure, 403) to internal hosts, " +
        "this likely means VPN is disconnected. Do NOT try workarounds. Ask the user to run `vpn` to reconnect. " +
        "Use the check_vpn tool if uncertain.",
    };
  });
}
