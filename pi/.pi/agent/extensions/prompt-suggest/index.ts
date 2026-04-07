/**
 * Prompt Suggest Extension
 *
 * After each agent turn, suggests the user's likely next prompt.
 * Shows suggestion as ghost text in the editor when empty.
 * Press Ctrl+Space on an empty editor to accept the suggestion.
 *
 * Features:
 *   - Ghost text suggestions after assistant completions
 *   - Ctrl+Space to accept when editor is empty
 *   - Learns from accept/reject patterns (steering)
 *   - Reads CLAUDE.md for lightweight project context
 *   - Toggle with /suggest
 *
 * Commands:
 *   /suggest         — show status
 *   /suggest on|off  — enable/disable
 *
 * Design: Uses setStatus("ghost-text") to communicate with the statusline
 * extension which renders it as ghost text inside the custom editor.
 * Stays compatible with other editor-wrapping extensions.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  completeSimple,
  type UserMessage,
  type AssistantMessage,
} from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Config ─────────────────────────────────────────────────────────────

const MAX_SUGGESTION_CHARS = 200;
const MAX_ASSISTANT_CHARS = 80_000;
const MAX_RECENT_PROMPTS = 15;
const MAX_RECENT_PROMPT_CHARS = 400;
const MAX_TOOL_SIGNALS = 8;
const MAX_STEERING_HISTORY = 5;
const NO_SUGGESTION_TOKEN = "[no suggestion]";
const GHOST_KEY = "ghost-text";
const STATUS_KEY = "prompt-suggest";

// ── State ──────────────────────────────────────────────────────────────

let enabled = true;
let currentSuggestion: string | undefined;
let lastSuggestionForSteering: string | undefined;
let generating = false;

interface SteeringEntry {
  suggested: string;
  actual: string;
  kind: "accepted" | "edited" | "changed";
}

const steeringHistory: SteeringEntry[] = [];

// ── Project Context ────────────────────────────────────────────────────

let projectContext: string | null = null;
let projectContextLoaded = false;

async function loadProjectContext(cwd: string): Promise<string | null> {
  if (projectContextLoaded) return projectContext;
  projectContextLoaded = true;

  for (const file of ["CLAUDE.md", ".pi/AGENTS.md"]) {
    try {
      const content = await readFile(join(cwd, file), "utf8");
      if (content.trim().length > 0) {
        projectContext = content.slice(0, 3000);
        return projectContext;
      }
    } catch {
      // File doesn't exist
    }
  }
  return null;
}

// ── Turn Context ───────────────────────────────────────────────────────

interface TurnContext {
  assistantText: string;
  status: "success" | "error" | "aborted";
  recentUserPrompts: string[];
  toolSignals: string[];
  touchedFiles: string[];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type?: string }).type === "text" &&
        "text" in block
      ) {
        return String((block as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("\n")
    .trim();
}

function extractTurnContext(
  messages: unknown[],
  branchMessages: unknown[]
): TurnContext | null {
  const lastMsg = (messages as any[]).at(-1);
  if (!lastMsg) return null;

  let assistantText = "";
  let status: TurnContext["status"] = "success";

  if (lastMsg.role === "assistant") {
    assistantText = extractText(lastMsg.content);
    status =
      lastMsg.stopReason === "error"
        ? "error"
        : lastMsg.stopReason === "aborted"
          ? "aborted"
          : "success";
  } else if (lastMsg.role === "toolResult") {
    assistantText = lastMsg.isError ? "[tool error]" : "[tool call completed]";
    status = lastMsg.isError ? "error" : "success";
  } else {
    return null;
  }

  const recentUserPrompts = [...(branchMessages as any[])]
    .reverse()
    .filter((m) => m.role === "user")
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .slice(0, MAX_RECENT_PROMPTS)
    .map((p) =>
      p.length > MAX_RECENT_PROMPT_CHARS
        ? p.slice(0, MAX_RECENT_PROMPT_CHARS) + "…"
        : p
    );

  const toolSignals: string[] = [];
  const touchedFiles = new Set<string>();

  for (const msg of messages as any[]) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const target =
            (typeof args.path === "string" ? args.path : null) ??
            (typeof args.file === "string" ? args.file : null) ??
            (typeof args.command === "string"
              ? (args.command as string).slice(0, 60)
              : null);
          toolSignals.push(`${block.name}${target ? `(${target})` : ""}`);
          if (typeof args.path === "string")
            touchedFiles.add(args.path.replace(/^@/, ""));
          if (typeof args.file === "string")
            touchedFiles.add(args.file.replace(/^@/, ""));
        }
      }
    }
    if (msg.role === "toolResult" && msg.isError) {
      toolSignals.push(`${msg.toolName}:error`);
    }
  }

  return {
    assistantText:
      assistantText.length > MAX_ASSISTANT_CHARS
        ? assistantText.slice(0, MAX_ASSISTANT_CHARS) + "…"
        : assistantText,
    status,
    recentUserPrompts,
    toolSignals: toolSignals.slice(0, MAX_TOOL_SIGNALS),
    touchedFiles: [...touchedFiles].slice(0, 8),
  };
}

// ── Suggestion Prompt ──────────────────────────────────────────────────

function buildSuggestionPrompt(
  turn: TurnContext,
  projectCtx: string | null
): string {
  const steeringSection =
    steeringHistory.length > 0
      ? `RecentUserCorrections:\n${steeringHistory
          .map(
            (e) =>
              `- instead of ${JSON.stringify(e.suggested)}\n  the user wrote: ${JSON.stringify(e.actual)}`
          )
          .join("\n")}`
      : "RecentUserCorrections:\n(none)";

  return `Write the next message the user would most likely send in this pi coding session.

Return only the user's message text.
Do not explain.
Do not describe the instructions you were given.
If no plausible next user message is clear, return exactly ${NO_SUGGESTION_TOKEN}.

TurnStatus:
${turn.status}

${projectCtx ? `ProjectContext:\n${projectCtx}\n` : ""}RecentUserMessages:
${turn.recentUserPrompts.length > 0 ? turn.recentUserPrompts.map((p) => `- ${p}`).join("\n") : "(none)"}

ToolSignals:
${turn.toolSignals.length > 0 ? turn.toolSignals.map((s) => `- ${s}`).join("\n") : "(none)"}

TouchedFiles:
${turn.touchedFiles.length > 0 ? turn.touchedFiles.map((f) => `- ${f}`).join("\n") : "(none)"}

${steeringSection}

LatestAssistantMessage:
\`\`\`
${turn.assistantText || "(empty)"}
\`\`\`

Guidance:
- Stay close to the user's recent style and current trajectory.
- Treat RecentUserMessages as the strongest signal.
- If the assistant proposed a next step and it fits, prefer a short reply like "yes", "go ahead", "looks good, proceed", "continue".
- Only add detail when it provides new information (constraint, correction, emphasis).
- Do not restate or summarize the assistant's proposal.
- If nothing new needs to be added, prefer brief affirmation.
- If the assistant's direction conflicts with the user's recent behavior, write a natural pivot instead.
- Learn from RecentUserCorrections: avoid repeating directions the user moved away from.
- Keep the result under ${MAX_SUGGESTION_CHARS} characters. Prefer fewer when possible.`;
}

// ── LLM Call ───────────────────────────────────────────────────────────

async function generateSuggestion(
  ctx: ExtensionContext,
  turn: TurnContext
): Promise<string | null> {
  if (!ctx.model) return null;

  const projectCtx = await loadProjectContext(process.cwd());
  const prompt = buildSuggestionPrompt(turn, projectCtx);

  try {
    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    const userMsg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };

    const response: AssistantMessage = await completeSimple(
      ctx.model,
      {
        systemPrompt:
          "You are the internal model for a prompt suggestion extension. Follow the user prompt exactly and return only the requested format.",
        messages: [userMsg],
      },
      { apiKey, reasoning: "minimal" }
    );

    const text = extractText(response.content);
    if (!text || text === NO_SUGGESTION_TOKEN) return null;

    const normalized = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return normalized.length > MAX_SUGGESTION_CHARS
      ? normalized.slice(0, MAX_SUGGESTION_CHARS).trimEnd()
      : normalized;
  } catch {
    return null;
  }
}

// ── Steering ───────────────────────────────────────────────────────────

function classifySteering(
  suggested: string,
  actual: string
): SteeringEntry["kind"] {
  const norm = (s: string) => s.trim().toLowerCase();
  if (norm(suggested) === norm(actual)) return "accepted";
  if (norm(actual).startsWith(norm(suggested))) return "edited";

  const sugWords = new Set(norm(suggested).split(/\s+/));
  const actWords = norm(actual).split(/\s+/);
  const overlap = actWords.filter((w) => sugWords.has(w)).length;
  if (sugWords.size > 0 && overlap / sugWords.size > 0.7) return "edited";

  return "changed";
}

function recordSteering(actual: string): void {
  if (!lastSuggestionForSteering) return;

  const entry: SteeringEntry = {
    suggested: lastSuggestionForSteering,
    actual,
    kind: classifySteering(lastSuggestionForSteering, actual),
  };

  // Only record "changed" entries — those teach us what NOT to suggest
  if (entry.kind === "changed") {
    steeringHistory.push(entry);
    if (steeringHistory.length > MAX_STEERING_HISTORY) {
      steeringHistory.shift();
    }
  }

  lastSuggestionForSteering = undefined;
}

// ── UI Helpers ─────────────────────────────────────────────────────────

function showSuggestionGhost(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !currentSuggestion) {
    hideSuggestionGhost(ctx);
    return;
  }
  ctx.ui.setStatus(GHOST_KEY, currentSuggestion);
}

function hideSuggestionGhost(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(GHOST_KEY, undefined);
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (!enabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    hideSuggestionGhost(ctx);
    return;
  }
  if (generating) {
    ctx.ui.setStatus(STATUS_KEY, "💡 thinking…");
  } else if (currentSuggestion) {
    ctx.ui.setStatus(STATUS_KEY, "💡 ^Space");
  } else {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

// ── Extension Entry ────────────────────────────────────────────────────

export default function promptSuggest(pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;

  function setSuggestion(
    text: string | null,
    ctx?: ExtensionContext
  ): void {
    currentSuggestion = text ?? undefined;
    lastSuggestionForSteering = text ?? undefined;
    const c = ctx ?? currentCtx;
    if (c) {
      if (text) {
        showSuggestionGhost(c);
      } else {
        hideSuggestionGhost(c);
      }
      updateStatus(c);
    }
  }

  // ── Ctrl+Space to accept suggestion ─────────────────────────────

  pi.registerShortcut("ctrl+space", {
    description: "Accept prompt suggestion (when editor is empty)",
    handler: (ctx) => {
      if (!enabled || !currentSuggestion) return;

      const editorText = ctx.ui.getEditorText();
      if (editorText.trim().length > 0) return; // Don't interfere with non-empty editor

      ctx.ui.setEditorText(currentSuggestion);
      setSuggestion(null, ctx);
    },
  });

  // ── Session lifecycle ──────────────────────────────────────────────

  const handleSession = async (_ev: unknown, ctx: ExtensionContext) => {
    currentCtx = ctx;
    projectContextLoaded = false;
    projectContext = null;
    setSuggestion(null, ctx);
  };

  pi.on("session_start", handleSession);
  pi.on("session_tree", handleSession);
  pi.on("session_fork", handleSession);
  pi.on("session_switch", handleSession);

  // ── Agent end: generate suggestion ─────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    currentCtx = ctx;
    if (!enabled) return;

    const branchEntries = ctx.sessionManager.getBranch();
    const branchMessages = branchEntries
      .filter(
        (
          entry
        ): entry is (typeof branchEntries)[number] & { type: "message" } =>
          entry.type === "message"
      )
      .map((entry) => entry.message);

    const turn = extractTurnContext(event.messages, branchMessages);
    if (!turn) return;

    // Fast path: on error/abort, suggest "continue"
    if (turn.status !== "success") {
      setSuggestion("continue", ctx);
      return;
    }

    generating = true;
    updateStatus(ctx);

    try {
      const suggestion = await generateSuggestion(ctx, turn);
      if (currentCtx === ctx) {
        setSuggestion(suggestion, ctx);
      }
    } catch {
      if (currentCtx === ctx) {
        setSuggestion(null, ctx);
      }
    } finally {
      generating = false;
      if (currentCtx === ctx) {
        updateStatus(ctx);
      }
    }
  });

  // ── Input: track steering ──────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    currentCtx = ctx;
    if (event.text.trim()) {
      recordSteering(event.text.trim());
    }
    setSuggestion(null, ctx);
    return { action: "continue" };
  });

  // ── Command ────────────────────────────────────────────────────────

  pi.registerCommand("suggest", {
    description: "Prompt suggestion controls: status | on | off",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "on") {
        enabled = true;
        ctx.ui.notify("💡 Prompt suggestions enabled", "info");
        updateStatus(ctx);
        return;
      }

      if (sub === "off") {
        enabled = false;
        setSuggestion(null, ctx);
        ctx.ui.notify("💡 Prompt suggestions disabled", "info");
        return;
      }

      // Default: show status
      const status = [
        `💡 Prompt Suggest`,
        ``,
        `  Status:     ${enabled ? "✅ enabled" : "❌ disabled"}`,
        `  Generating: ${generating ? "yes" : "no"}`,
        `  Suggestion: ${currentSuggestion ? `"${currentSuggestion}"` : "(none)"}`,
        `  Steering:   ${steeringHistory.length} correction(s) recorded`,
        ``,
        `  Usage:`,
        `    Ctrl+Space    — accept suggestion (when editor is empty)`,
        `    /suggest on   — enable suggestions`,
        `    /suggest off  — disable suggestions`,
      ];

      pi.sendMessage(
        {
          customType: "prompt-suggest-status",
          content: status.join("\n"),
          display: true,
        },
        { triggerTurn: false }
      );
    },
  });
}
