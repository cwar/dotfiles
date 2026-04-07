/**
 * Action Needed — Notifies you when Claude is waiting for you to do something.
 *
 * Problem: Claude asks you to "click the Window tab" or "trigger a capture",
 *          but you're in another tab and don't see it. By the time you check
 *          back, you have to scroll up to find what it wanted.
 *
 * Solution: On agent_end, analyze the last response with Haiku to detect
 *           blocking action items. If found:
 *           - Desktop notification (mako/notify-send)
 *           - Waybar module shows the task
 *           - Widget above the editor shows the task
 *
 * Cleared when: user types (input event), agent starts again, or /task clear.
 *
 * Commands:
 *   /task         — Show the current pending task
 *   /task clear   — Dismiss the current task
 *   /task on|off  — Enable/disable notifications
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Config ─────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".cache");
const STATE_FILE = join(CACHE_DIR, "pi-action-needed.json");
const WIDGET_KEY = "action-needed";
const WAYBAR_SIGNAL = 13;

/** Max chars of assistant text to send to Haiku for classification. */
const MAX_CLASSIFY_CHARS = 1500;

/** Timeout for the Haiku classification call. */
const API_TIMEOUT_MS = 8_000;

/** Minimum assistant text length to bother classifying. */
const MIN_TEXT_LENGTH = 40;

/** Models to try — fast and cheap. */
const MODELS = ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"];

/** Notification timeout in milliseconds. */
const NOTIFY_TIMEOUT_MS = 15_000;

// ── State ──────────────────────────────────────────────────────────

interface TaskState {
  task: string;
  timestamp: string;
  sessionTitle?: string;
  cwd?: string;
}

// ── Haiku Classification ───────────────────────────────────────────

const CLASSIFY_PROMPT = `You analyze if an AI coding assistant is BLOCKED waiting for the human to do something.

Reply format:
- If waiting: a 1-line task description (≤80 chars, imperative mood, e.g. "Click the Window tab and pick a window")
- If NOT waiting: reply with exactly "NONE"

"BLOCKED waiting" means the assistant cannot continue without the human doing something specific:
- Test/trigger something outside the terminal (click UI, open URL, etc.)
- Make a selection or choice the assistant asked about
- Provide information the assistant explicitly requested
- Run something in a different terminal or environment
- Physically verify something (screen, audio, etc.)

NOT blocked if the assistant:
- Just completed work and is reporting the result
- Offered optional suggestions or next steps
- Said "let me know if..." or "feel free to..."
- Asked a rhetorical or clarifying question while still working
- Is explaining something

Messages from the latest assistant turn:
{MESSAGES}`;

function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
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

async function classifyTask(
  assistantText: string,
  apiKey: string,
  baseUrl: string,
): Promise<string | null> {
  const prompt = CLASSIFY_PROMPT.replace("{MESSAGES}", assistantText);
  const headers = buildHeaders(apiKey);
  const modelsToTry = workingModel ? [workingModel] : MODELS;

  for (const model of modelsToTry) {
    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 100,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (response.status === 404) continue;
      if (!response.ok) continue;

      workingModel = model;
      const data = (await response.json()) as any;
      const text = data?.content?.[0]?.text?.trim();
      if (!text) return null;

      if (text.toUpperCase() === "NONE") return null;

      // Clean up: remove quotes, trailing punctuation, truncate
      let task = text.replace(/^["']|["']$/g, "").trim();
      if (task.length > 100) task = task.slice(0, 97) + "...";
      return task;
    } catch {
      continue;
    }
  }
  return null;
}

// ── Assistant Text Extraction ──────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    return texts.join("\n");
  }
  return "";
}

/**
 * Extract assistant text from agent_end messages.
 * Takes the tail to stay within budget.
 */
function extractAssistantText(messages: any[]): string {
  const segments: string[] = [];

  for (const msg of messages) {
    if (msg?.type !== "message") continue;
    const m = msg?.message ?? msg;
    if (m?.role === "assistant") {
      const text = extractText(m.content);
      if (text.trim()) segments.push(text.trim());
    }
  }

  const full = segments.join("\n\n---\n\n");

  // Take the tail if too long
  if (full.length > MAX_CLASSIFY_CHARS) {
    return "...\n" + full.slice(-MAX_CLASSIFY_CHARS);
  }
  return full;
}

// ── Notification & Waybar ──────────────────────────────────────────

async function sendDesktopNotification(task: string): Promise<void> {
  try {
    await execFileAsync("notify-send", [
      "--app-name=pi",
      "--urgency=normal",
      `--expire-time=${NOTIFY_TIMEOUT_MS}`,
      "--icon=dialog-information",
      "--category=im.received",
      "⏳ Action needed",
      task,
    ]);
  } catch {
    // Notification failed — not critical
  }
}

async function writeStateFile(state: TaskState | null): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    // State file write failed — not critical
  }
}

async function signalWaybar(): Promise<void> {
  try {
    await execFileAsync("pkill", [`-RTMIN+${WAYBAR_SIGNAL}`, "waybar"]);
  } catch {
    // pkill can fail if waybar isn't running — fine
  }
}

// ── Extension ──────────────────────────────────────────────────────

export default function actionNeeded(pi: ExtensionAPI) {
  let currentTask: string | null = null;
  let enabled = true;
  let classifying = false;

  function showWidget(ctx: any): void {
    if (!ctx.hasUI || !currentTask) return;
    const line = `\x1b[38;5;214m  ⏳ ${currentTask}\x1b[0m`;
    ctx.ui.setWidget(WIDGET_KEY, [line], { placement: "aboveEditor" });
  }

  function hideWidget(ctx: any): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  async function clearTask(ctx: any): Promise<void> {
    if (!currentTask) return;
    currentTask = null;
    hideWidget(ctx);
    await writeStateFile(null);
    await signalWaybar();
  }

  async function setTask(task: string, ctx: any): Promise<void> {
    currentTask = task;
    showWidget(ctx);

    const state: TaskState = {
      task,
      timestamp: new Date().toISOString(),
      cwd: ctx.cwd,
    };

    await writeStateFile(state);
    await signalWaybar();
    await sendDesktopNotification(task);
  }

  // ── Events ─────────────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled || classifying) return;

    const text = extractAssistantText(event.messages);
    if (text.length < MIN_TEXT_LENGTH) return;

    classifying = true;
    try {
      const apiKey = await (ctx as any).modelRegistry?.getApiKeyForProvider?.("anthropic");
      if (!apiKey) return;

      const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
      const task = await classifyTask(text, apiKey, baseUrl);

      if (task) {
        await setTask(task, ctx);
      }
    } catch (err) {
      console.debug("[action-needed] Classification failed:", err);
    } finally {
      classifying = false;
    }
  });

  // Clear task when the user engages
  pi.on("agent_start", async (_event, ctx) => {
    await clearTask(ctx);
  });

  pi.on("input", async (_event, ctx) => {
    await clearTask(ctx);
  });

  // Clear on session switch
  pi.on("session_switch", async (_event, ctx) => {
    await clearTask(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    currentTask = null;
    // Read any existing state from a previous session that might still be showing
    try {
      const content = await readFile(STATE_FILE, "utf8");
      const state = JSON.parse(content) as TaskState | null;
      if (state?.task) {
        // Stale task from a previous session — clear it
        await writeStateFile(null);
        await signalWaybar();
      }
    } catch {
      // No state file — fine
    }
  });

  // ── Commands ───────────────────────────────────────────────────

  pi.registerCommand("task", {
    description: "Show, clear, or toggle action-needed notifications",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "clear" || arg === "dismiss") {
        await clearTask(ctx);
        ctx.ui.notify("Task cleared", "info");
        return;
      }

      if (arg === "off" || arg === "disable") {
        enabled = false;
        await clearTask(ctx);
        ctx.ui.notify("Action-needed notifications disabled", "info");
        return;
      }

      if (arg === "on" || arg === "enable") {
        enabled = true;
        ctx.ui.notify("Action-needed notifications enabled", "info");
        return;
      }

      // No args — show current task
      if (currentTask) {
        ctx.ui.notify(`⏳ Pending: ${currentTask}`, "info");
      } else {
        ctx.ui.notify("No pending task", "info");
      }
    },
  });
}
