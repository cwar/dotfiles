/**
 * Web Search & Fetch Extension
 *
 * Two tools:
 *
 * 1. `web_search` — Uses the conversation's selected model and that provider's
 *    native web-search capability. Authentication comes from pi's model registry,
 *    so search never silently switches to a different provider or model.
 *
 * 2. `fetch_content` — Fetches a URL and returns readable content. Uses Jina
 *    Reader (r.jina.ai) for HTML→markdown conversion with a raw fetch fallback.
 *    No API key required. Blocks local/private network addresses for safety.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { addNativeWebSearchTool, extractAssistantText } from "./web-search/core.ts";

// ─── Web Search ──────────────────────────────────────────────────────────────

const SEARCH_MAX_TOKENS = 2048;
const SEARCH_SYSTEM_PROMPT =
  "You are a concise web research assistant. Use native web search and return a focused summary with key findings and full source URLs. Be brief and direct.";

function withAnthropicSearchBeta(
  api: string,
  headers: Record<string, string | null> | undefined,
): Record<string, string | null> | undefined {
  if (api !== "anthropic-messages") return headers;

  const existing = headers?.["anthropic-beta"];
  const betaValues = new Set(
    ["web-search-2025-03-05", ...(typeof existing === "string" ? existing.split(",") : [])]
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return {
    ...headers,
    "anthropic-beta": [...betaValues].join(","),
  };
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
      `Search the internet for current information using the conversation's selected model ` +
      `and its provider-native web search. Returns a concise summary with source URLs. ` +
      `Fails explicitly if the selected model API has no native-search adapter. ` +
      `Use when you need up-to-date facts, documentation, news, or anything not in your training data.`,
    parameters: Type.Object({
      query: Type.String({
        description: "The search query. Be specific and concise for best results.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model;
      if (!model) {
        throw new Error("Cannot search the web because no conversation model is selected");
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key available for ${model.provider}/${model.id}` : auth.error);
      }

      const modelName = `${model.provider}/${model.id}`;
      onUpdate?.({
        content: [{ type: "text", text: `Searching with ${modelName}: ${params.query}` }],
        details: { query: params.query, model: modelName, status: "searching" },
      });

      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: params.query }],
        timestamp: Date.now(),
      };

      const response = await complete(
        model,
        {
          systemPrompt: SEARCH_SYSTEM_PROMPT,
          messages: [userMessage],
        },
        {
          apiKey: auth.apiKey,
          headers: withAnthropicSearchBeta(model.api, auth.headers),
          env: auth.env,
          maxTokens: SEARCH_MAX_TOKENS,
          signal,
          onPayload(payload, requestModel) {
            return addNativeWebSearchTool(payload, requestModel.api);
          },
        },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Web search ${response.stopReason}`);
      }

      const text = extractAssistantText(response);
      return {
        content: [{ type: "text", text }],
        details: { query: params.query, model: modelName, result: text },
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
