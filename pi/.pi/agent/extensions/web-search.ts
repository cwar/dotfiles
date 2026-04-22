/**
 * Web Search & Fetch Extension
 *
 * Two tools:
 *
 * 1. `web_search` — Uses Anthropic's native web search beta via claude-haiku-4-5
 *    (cheap/fast) to search the internet. No third-party API key needed beyond
 *    your existing Anthropic key. Credit: bsmithgall/pi-pi-pi
 *
 * 2. `fetch_content` — Fetches a URL and returns readable content. Uses Jina
 *    Reader (r.jina.ai) for HTML→markdown conversion with a raw fetch fallback.
 *    No API key required. Blocks local/private network addresses for safety.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ─── Web Search ──────────────────────────────────────────────────────────────

const SEARCH_MODEL_ID = "claude-haiku-4-5";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_SEARCH_USES = 5;
const SEARCH_MAX_TOKENS = 2048;

type SearchResult = { ok: true; text: string } | { ok: false; error: string };

async function runWebSearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const isOAuth = apiKey.includes("sk-ant-oat");

  const headers: Record<string, string> = isOAuth
    ? {
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05,oauth-2025-04-20",
        "content-type": "application/json",
        "x-app": "cli",
        "user-agent": "claude-cli/1.0.72 (external, cli)",
      }
    : {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      };

  const body = {
    model: SEARCH_MODEL_ID,
    max_tokens: SEARCH_MAX_TOKENS,
    temperature: 0,
    system:
      "You are a concise web research assistant. Search the web and return a focused summary with key findings and full source URLs. Be brief and direct.",
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: MAX_SEARCH_USES,
      },
    ],
    messages: [{ role: "user", content: query }],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }

  const raw = await res.text();

  if (!res.ok) {
    return { ok: false, error: `Anthropic API error (${res.status}): ${raw.slice(0, 300)}` };
  }

  let parsed: { content?: Array<{ type: string; text?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Failed to parse Anthropic response as JSON" };
  }

  const text = (parsed.content ?? [])
    .filter(
      (b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  if (!text) {
    return { ok: false, error: "Anthropic returned no text content" };
  }

  return { ok: true, text };
}

// ─── Fetch Content ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 40_000;
const JINA_PREFIX = "https://r.jina.ai/";

/**
 * Block private/loopback/link-local addresses to prevent SSRF.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Loopback
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]") {
    return true;
  }

  // Private IPv4 ranges
  if (/^10\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;

  // Link-local
  if (/^169\.254\./.test(lower)) return true;
  if (lower.startsWith("fe80")) return true;

  // .local mDNS
  if (lower.endsWith(".local")) return true;

  return false;
}

type FetchResult =
  | { ok: true; text: string; source: "jina" | "raw" }
  | { ok: false; error: string };

async function fetchContent(
  url: string,
  timeoutMs: number,
  maxChars: number,
  signal?: AbortSignal,
): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: `Blocked: ${parsed.hostname} is a private/local address` };
  }

  // Try Jina Reader first for nice markdown conversion
  const jinaResult = await fetchWithTimeout(
    `${JINA_PREFIX}${url}`,
    {
      headers: {
        Accept: "text/markdown",
        "X-Return-Format": "markdown",
      },
      signal,
    },
    timeoutMs,
  );

  if (jinaResult.ok) {
    const text = jinaResult.text.slice(0, maxChars);
    return { ok: true, text, source: "jina" };
  }

  // Fallback: raw fetch
  const rawResult = await fetchWithTimeout(url, { signal }, timeoutMs);

  if (rawResult.ok) {
    const text = rawResult.text.slice(0, maxChars);
    return { ok: true, text, source: "raw" };
  }

  return { ok: false, error: `Both Jina and raw fetch failed. Jina: ${jinaResult.error}. Raw: ${rawResult.error}` };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Combine with caller's signal if present
  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: "Aborted" };
    }
    callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    const text = await res.text();
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function webSearchExtension(pi: ExtensionAPI): void {
  // ── web_search tool ──

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      `Search the internet for current information. Uses Anthropic's native web search ` +
      `via ${SEARCH_MODEL_ID}. Returns a concise summary with source URLs. ` +
      `Use when you need up-to-date facts, documentation, news, or anything not in your training data.`,
    parameters: Type.Object({
      query: Type.String({
        description: "The search query. Be specific and concise for best results.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.modelRegistry.find("anthropic", SEARCH_MODEL_ID);
      if (!model) {
        return {
          content: [{ type: "text", text: `Error: model ${SEARCH_MODEL_ID} not found in registry` }],
          details: { query: params.query, error: "model not found" },
          isError: true,
        };
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        return {
          content: [{ type: "text", text: `Error: ${auth.error}` }],
          details: { query: params.query, error: auth.error },
          isError: true,
        };
      }
      const apiKey = auth.apiKey;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: `Error: no API key available for ${SEARCH_MODEL_ID}` }],
          details: { query: params.query, error: "no api key" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching: ${params.query}` }],
        details: { query: params.query, status: "searching" },
      });

      const result = await runWebSearch(params.query, apiKey, signal);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${result.error}` }],
          details: { query: params.query, error: result.error },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: result.text }],
        details: { query: params.query, result: result.text },
      };
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "";
      const preview = query.length > 60 ? `${query.slice(0, 60)}…` : query;
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("dim", `"${preview}"`),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | { query?: string; result?: string; error?: string; status?: string }
        | undefined;

      if (isPartial) {
        const query = details?.query ?? "";
        return new Text(
          theme.fg("toolTitle", "web_search ") + theme.fg("muted", `searching: "${query}"…`),
          0,
          0,
        );
      }

      if (result.isError || details?.error) {
        return new Text(
          theme.fg("error", `✗ Search failed: ${details?.error ?? "unknown error"}`),
          0,
          0,
        );
      }

      const text = details?.result ?? "";
      if (!text) {
        return new Text(theme.fg("muted", "✓ No results"), 0, 0);
      }

      if (expanded) {
        return new Text(text, 0, 0);
      }

      const lines = text.split("\n").filter((l) => l.trim());
      const preview = lines.slice(0, 2).join(" ").slice(0, 120);
      const hasMore = lines.length > 2 || text.length > 120;
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("toolOutput", preview) +
          (hasMore ? theme.fg("dim", " … (Ctrl+O to expand)") : ""),
        0,
        0,
      );
    },
  });

  // ── fetch_content tool ──

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      `Fetch a web page and return its content as readable text/markdown. ` +
      `Uses Jina Reader for HTML→markdown conversion with a raw fetch fallback. ` +
      `No API key required. Use when you have a specific URL to read — for searching, use web_search instead. ` +
      `Blocks private/local network addresses for safety.`,
    parameters: Type.Object({
      url: Type.String({
        description: "The URL to fetch. Must be a full URL including https://.",
      }),
      maxChars: Type.Optional(
        Type.Number({
          description: `Maximum characters to return. Defaults to ${DEFAULT_MAX_CHARS}. Reduce for large pages when you only need the beginning.`,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const url = params.url;
      const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      onUpdate?.({
        content: [{ type: "text", text: `Fetching: ${url}` }],
        details: { url, status: "fetching" },
      });

      const result = await fetchContent(url, timeoutMs, maxChars, signal);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Fetch failed: ${result.error}` }],
          details: { url, error: result.error },
          isError: true,
        };
      }

      const truncated = result.text.length >= maxChars;
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          url,
          source: result.source,
          chars: result.text.length,
          truncated,
        },
      };
    },

    renderCall(args, theme) {
      const url = typeof args.url === "string" ? args.url : "";
      const preview = url.length > 60 ? `${url.slice(0, 60)}…` : url;
      return new Text(
        theme.fg("toolTitle", theme.bold("fetch_content ")) + theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | { url?: string; source?: string; chars?: number; truncated?: boolean; error?: string; status?: string }
        | undefined;

      if (isPartial) {
        const url = details?.url ?? "";
        return new Text(
          theme.fg("toolTitle", "fetch_content ") + theme.fg("muted", `fetching: ${url}…`),
          0,
          0,
        );
      }

      if (result.isError || details?.error) {
        return new Text(
          theme.fg("error", `✗ Fetch failed: ${details?.error ?? "unknown error"}`),
          0,
          0,
        );
      }

      const chars = details?.chars ?? 0;
      const source = details?.source ?? "unknown";
      const truncated = details?.truncated ? " (truncated)" : "";
      const summary = `${chars.toLocaleString()} chars via ${source}${truncated}`;

      if (expanded) {
        const content = result.content
          ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n") ?? "";
        return new Text(
          theme.fg("success", `✓ `) + theme.fg("dim", summary) + "\n" + content,
          0,
          0,
        );
      }

      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("toolOutput", summary) +
          theme.fg("dim", " (Ctrl+O to expand)"),
        0,
        0,
      );
    },
  });
}
