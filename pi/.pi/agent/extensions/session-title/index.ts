/**
 * Session Title — Context-aware session naming for the statusline.
 *
 * Problem: Sessions are just timestamps. Glancing at the status bar doesn't
 *          tell you what this conversation is about.
 * Solution: After the first meaningful exchange, call Claude Haiku to generate
 *           a short, descriptive title. Updates if the topic drifts.
 *
 * Display: Sets ctx.ui.setStatus() so the statusline extension picks it up.
 *
 * Commands:
 *   /title         — Show or manually set the current session title
 *   /title rename  — Interactively rename (opens editor with current title)
 *   /title clear   — Remove the title for this session
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Config ─────────────────────────────────────────────────────────

const TITLES_DIR = join(homedir(), ".pi", "session-titles");
const TITLES_FILE = join(TITLES_DIR, "titles.json");
const WIDGET_KEY = "session-title";

/** Max time to wait for the title generation API call. */
const API_TIMEOUT_MS = 10_000;

/** Don't generate a title until we have at least this many user+assistant messages. */
const MIN_MESSAGES_FOR_TITLE = 2;

/** Re-evaluate the title every N turns after the initial generation. */
const RETITLE_INTERVAL = 3;

/** Max conversation chars sent to the title generator. */
const MAX_CHARS = 6_000;

/** How much of the budget to reserve for the tail (most recent messages). */
const TAIL_BUDGET_RATIO = 0.65;

/** Models to try — fast and cheap. */
const TITLE_MODELS = ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"];

// ── Types ──────────────────────────────────────────────────────────

interface TitleStore {
  [sessionId: string]: {
    title: string;
    generatedAt: string;
    turnCount: number;
  };
}

// ── Persistence ────────────────────────────────────────────────────

async function loadTitles(): Promise<TitleStore> {
  try {
    const content = await readFile(TITLES_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveTitles(store: TitleStore): Promise<void> {
  await mkdir(TITLES_DIR, { recursive: true });
  await writeFile(TITLES_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function getTitle(sessionId: string): Promise<{ title: string; turnCount: number } | null> {
  const store = await loadTitles();
  const entry = store[sessionId];
  return entry ? { title: entry.title, turnCount: entry.turnCount } : null;
}

async function setTitle(sessionId: string, title: string, turnCount: number): Promise<void> {
  const store = await loadTitles();

  // Prune old entries (keep last 200 sessions)
  const entries = Object.entries(store);
  if (entries.length > 200) {
    const sorted = entries.sort(([, a], [, b]) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );
    const pruned: TitleStore = {};
    for (const [k, v] of sorted.slice(0, 200)) {
      pruned[k] = v;
    }
    Object.assign(store, pruned);
    for (const key of Object.keys(store)) {
      if (!pruned[key]) delete store[key];
    }
  }

  store[sessionId] = { title, generatedAt: new Date().toISOString(), turnCount };
  await saveTitles(store);
}

async function clearTitle(sessionId: string): Promise<void> {
  const store = await loadTitles();
  delete store[sessionId];
  await saveTitles(store);
}

// ── Conversation Extraction ────────────────────────────────────────

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return undefined;
}

/**
 * Build a segment string from a session entry, or null if it should be skipped.
 */
function entryToSegment(entry: any): string | null {
  if (entry.type !== "message") return null;
  const msg = entry.message;
  if (!msg?.role) return null;

  if (msg.role === "user" || msg.role === "assistant") {
    const text = extractText(msg.content);
    if (!text?.trim()) return null;
    const label = msg.role === "user" ? "User" : "Assistant";
    return `${label}: ${text.trim()}`;
  }

  if (msg.role === "toolResult" && !msg.isError) {
    const tool = msg.toolName;
    if (tool === "write" || tool === "edit") {
      const path = msg.details?.path || msg.details?.filePath || "";
      return `[Tool: ${tool} ${path}]`;
    }
    if (tool === "bash") {
      const cmd = (msg.details?.command || "").slice(0, 80);
      return `[Tool: bash "${cmd}"]`;
    }
  }

  return null;
}

/**
 * Extract conversation with head+tail weighting.
 *
 * Short conversations are taken in full. Longer ones keep the first ~35%
 * (establishes the original topic) and the last ~65% (captures where we
 * are *now*), separated by a "[...earlier messages omitted...]" marker.
 * This way Haiku always sees the latest tangent without losing the origin.
 */
function extractConversation(entries: any[]): { text: string; turnCount: number } {
  // First pass: convert all entries to segments
  const segments: string[] = [];
  let turnCount = 0;

  for (const entry of entries) {
    const seg = entryToSegment(entry);
    if (seg === null) continue;
    segments.push(seg);
    const msg = entry.message;
    if (msg?.role === "user" || msg?.role === "assistant") turnCount++;
  }

  // Short conversations — just join everything up to MAX_CHARS
  const fullText = segments.join("\n");
  if (fullText.length <= MAX_CHARS) {
    return { text: fullText, turnCount };
  }

  // Longer conversations — head + tail strategy
  const headBudget = Math.floor(MAX_CHARS * (1 - TAIL_BUDGET_RATIO));
  const tailBudget = MAX_CHARS - headBudget;

  // Build head (oldest messages first)
  const headParts: string[] = [];
  let headLen = 0;
  for (const seg of segments) {
    if (headLen + seg.length + 1 > headBudget) break;
    headParts.push(seg);
    headLen += seg.length + 1;
  }

  // Build tail (newest messages first, then reverse)
  const tailParts: string[] = [];
  let tailLen = 0;
  for (let i = segments.length - 1; i >= headParts.length; i--) {
    const seg = segments[i];
    if (tailLen + seg.length + 1 > tailBudget) break;
    tailParts.unshift(seg);
    tailLen += seg.length + 1;
  }

  const parts = [...headParts, "\n[...earlier messages omitted...]\n", ...tailParts];
  return { text: parts.join("\n"), turnCount };
}

// ── Claude API ─────────────────────────────────────────────────────

const INITIAL_TITLE_PROMPT = `Generate a concise title (3-6 words) for this coding session. The title should capture the core task or topic.

Rules:
- 3 to 6 words, no more
- Be specific: name the actual thing being worked on
- Use title case
- No quotes, no trailing punctuation
- If there's a clear action, lead with a verb (e.g. "Fixing", "Adding", "Refactoring")
- If it's exploratory, describe the topic (e.g. "Redis Cache Architecture")

Good examples:
- "Fixing Auth Token Refresh"
- "Adding Redis Cache Layer"  
- "Session Title Status Extension"
- "Debugging Flaky CI Tests"
- "GraphQL Schema Migration"

Bad examples (too vague):
- "Coding Session"
- "Working on Project"
- "Bug Fix"
- "Various Changes"

Session transcript:
{CONVERSATION}

Respond with ONLY the title text, nothing else.`;

const RETITLE_PROMPT = `You are updating the title of an ongoing coding session. The current title is:
"{CURRENT_TITLE}"

The session has continued. Review the latest conversation and decide:
- If the session is still on the same topic, respond with exactly: KEEP
- If the topic has shifted or expanded significantly, respond with a new 3-6 word title

Rules for new titles:
- 3 to 6 words, no more
- Be specific: name the actual thing being worked on now
- Use title case
- No quotes, no trailing punctuation
- If the session covered multiple topics, title the most recent/active one
- If topics are related, a broader title that covers both is fine

Session transcript:
{CONVERSATION}

Respond with ONLY "KEEP" or the new title text, nothing else.`;

function isOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function buildHeaders(apiKey: string): Record<string, string> {
  if (isOAuthToken(apiKey)) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

let workingModel: string | undefined;

/** Sentinel returned by retitle prompt when the current title is still good. */
const KEEP_SENTINEL = "KEEP";

function cleanTitle(raw: string): string {
  let title = raw.replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").trim();
  if (title.length > 50) title = title.slice(0, 47) + "...";
  return title;
}

/**
 * Generate a title for the session. If `currentTitle` is provided, uses the
 * retitle prompt which can return KEEP (no change needed) or a new title.
 * Returns null on error, the existing title if KEEP, or the new title.
 */
async function generateTitle(
  conversation: string,
  apiKey: string,
  baseUrl: string,
  currentTitle?: string | null,
): Promise<string | null> {
  let prompt: string;
  if (currentTitle) {
    prompt = RETITLE_PROMPT
      .replace("{CURRENT_TITLE}", currentTitle)
      .replace("{CONVERSATION}", conversation);
  } else {
    prompt = INITIAL_TITLE_PROMPT.replace("{CONVERSATION}", conversation);
  }

  const headers = buildHeaders(apiKey);
  const modelsToTry = workingModel ? [workingModel] : TITLE_MODELS;

  for (const model of modelsToTry) {
    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (response.status === 404) continue;

      if (!response.ok) {
        console.debug(`[session-title] API ${response.status}: ${await response.text().catch(() => "")}`);
        continue;
      }

      workingModel = model;
      const data = await response.json() as any;
      const text = data?.content?.[0]?.text?.trim();
      if (!text) return null;

      // If retitling and model says KEEP, return the existing title unchanged
      if (currentTitle && text.toUpperCase() === KEEP_SENTINEL) {
        return currentTitle;
      }

      return cleanTitle(text);
    } catch (err) {
      console.debug(`[session-title] Error with ${model}:`, err);
      continue;
    }
  }

  return null;
}

// ── Extension ──────────────────────────────────────────────────────

export default function sessionTitle(pi: ExtensionAPI) {
  let currentSessionId: string | null = null;
  let currentTitle: string | null = null;
  let lastTitleTurnCount = 0;
  let generating = false;

  /** Extract session ID from session file path. */
  function getSessionId(ctx: any): string | null {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile) return null;
    const fileBase = basename(sessionFile, ".jsonl");
    const uuidIdx = fileBase.indexOf("_");
    return uuidIdx >= 0 ? fileBase.slice(uuidIdx + 1) : fileBase;
  }

  /** Display the current title below the editor. */
  function showTitle(ctx: any): void {
    if (!ctx.hasUI || !currentTitle) return;
    ctx.ui.setWidget(WIDGET_KEY, [`\x1b[38;5;244m  ✏️ ${currentTitle}\x1b[0m`], { placement: "belowEditor" });
  }

  /** Clear the title display. */
  function hideTitle(ctx: any): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  /** Generate (or regenerate) a title from the current conversation. */
  async function maybeGenerateTitle(ctx: any, force = false): Promise<void> {
    if (generating) return;
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;

    // Get conversation data
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const { text: conversation, turnCount } = extractConversation(entries);

    // Not enough conversation yet
    if (turnCount < MIN_MESSAGES_FOR_TITLE) return;

    // Already have a title — only regenerate at intervals or if forced
    if (currentTitle && !force) {
      if (turnCount - lastTitleTurnCount < RETITLE_INTERVAL) return;
    }

    // Check persisted title (another session might have generated it)
    if (!currentTitle && !force) {
      const persisted = await getTitle(sessionId).catch(() => null);
      if (persisted) {
        currentTitle = persisted.title;
        lastTitleTurnCount = persisted.turnCount;
        showTitle(ctx);
        return;
      }
    }

    generating = true;
    try {
      const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.("anthropic");
      if (!apiKey) return;

      const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

      // Pass current title for retitling (so model can KEEP or update)
      const isRetitle = !!currentTitle && !force;
      const title = await generateTitle(conversation, apiKey, baseUrl, isRetitle ? currentTitle : null);
      if (!title) return;

      const changed = title !== currentTitle;
      currentTitle = title;
      lastTitleTurnCount = turnCount;

      // Persist and display (even on KEEP, update the turnCount)
      await setTitle(sessionId, title, turnCount).catch(() => {});
      if (changed) showTitle(ctx);
    } catch (err) {
      console.debug("[session-title] Generation failed:", err);
    } finally {
      generating = false;
    }
  }

  // ── Lifecycle Events ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentTitle = null;
    lastTitleTurnCount = 0;
    currentSessionId = getSessionId(ctx);

    // Restore persisted title if we have one
    if (currentSessionId) {
      const persisted = await getTitle(currentSessionId).catch(() => null);
      if (persisted) {
        currentTitle = persisted.title;
        lastTitleTurnCount = persisted.turnCount;
        showTitle(ctx);
      }
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    currentTitle = null;
    lastTitleTurnCount = 0;
    currentSessionId = getSessionId(ctx);

    if (currentSessionId) {
      const persisted = await getTitle(currentSessionId).catch(() => null);
      if (persisted) {
        currentTitle = persisted.title;
        lastTitleTurnCount = persisted.turnCount;
        showTitle(ctx);
      } else {
        hideTitle(ctx);
      }
    }
  });

  // Generate title after each agent turn completes
  pi.on("agent_end", async (_event, ctx) => {
    // Fire and forget — don't block the UI
    maybeGenerateTitle(ctx).catch(() => {});
  });

  // ── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("title", {
    description: "Show, set, or clear the session title",
    handler: async (args, ctx) => {
      const arg = (args || "").trim();
      const sessionId = getSessionId(ctx);

      if (arg === "clear") {
        currentTitle = null;
        lastTitleTurnCount = 0;
        hideTitle(ctx);
        if (sessionId) await clearTitle(sessionId).catch(() => {});
        ctx.ui.notify("Session title cleared", "info");
        return;
      }

      if (arg === "rename" || arg === "set") {
        // Let the user type a new title
        ctx.ui.notify("Type the new title after /title: e.g. /title My New Title", "info");
        return;
      }

      if (arg === "regen" || arg === "regenerate") {
        ctx.ui.notify("Regenerating title...", "info");
        currentTitle = null;
        await maybeGenerateTitle(ctx, true);
        if (currentTitle) {
          ctx.ui.notify(`Title: ${currentTitle}`, "info");
        } else {
          ctx.ui.notify("Couldn't generate a title yet — need more conversation", "warning");
        }
        return;
      }

      if (arg) {
        // Manual title set: /title My Custom Title
        currentTitle = arg;
        lastTitleTurnCount = 999; // Prevent auto-overwrite
        showTitle(ctx);
        if (sessionId) await setTitle(sessionId, arg, 999).catch(() => {});
        ctx.ui.notify(`Title set: ${currentTitle}`, "info");
        return;
      }

      // No args — show current title
      if (currentTitle) {
        ctx.ui.notify(`Session title: ${currentTitle}`, "info");
      } else {
        ctx.ui.notify("No title yet — will generate after the first exchange", "info");
      }
    },
  });
}
