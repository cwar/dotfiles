/**
 * Editor Stash Extension
 *
 * Save your editor content, fire off a quick prompt, and auto-restore when done.
 *
 * Shortcuts:
 *   Alt+S          — Stash/restore editor text (toggle)
 *   Ctrl+Alt+H     — Browse stash history
 *   Ctrl+Alt+C     — Copy editor content to clipboard
 *   Ctrl+Alt+X     — Cut editor content to clipboard
 *
 * Behavior:
 *   - Editor has text, no stash  → stash text, clear editor
 *   - Editor empty, has stash    → restore stash into editor
 *   - Editor has text, has stash → update stash, clear editor
 *   - Auto-restores after agent finishes (if editor is still empty)
 *   - History persists across sessions (up to 12 entries)
 */

import {
  copyToClipboard,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Constants ──────────────────────────────────────────────────────────

const HISTORY_LIMIT = 12;
const PREVIEW_WIDTH = 72;
const HISTORY_PATH = join(
  process.env.HOME || process.env.USERPROFILE || homedir(),
  ".pi", "agent", "stash", "history.json",
);

// ── Persistence ────────────────────────────────────────────────────────

function readHistory(): string[] {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const data = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.history)) return [];
    return data.history
      .filter((e: unknown): e is string => typeof e === "string" && e.trim().length > 0)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeHistory(history: string[]): void {
  try {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    writeFileSync(HISTORY_PATH, JSON.stringify({ version: 1, history: history.slice(0, HISTORY_LIMIT) }, null, 2) + "\n");
  } catch (err) {
    console.debug("[editor-stash] Failed to persist history:", err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function hasText(text: string): boolean {
  return text.trim().length > 0;
}

function preview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  if (visibleWidth(compact) <= maxWidth) return compact;
  // Truncate by visible width
  let w = 0;
  let i = 0;
  for (const ch of compact) {
    const cw = visibleWidth(ch);
    if (w + cw > maxWidth - 1) break;
    w += cw;
    i += ch.length;
  }
  return compact.slice(0, i).trimEnd() + "…";
}

// ── Extension ──────────────────────────────────────────────────────────

export default function editorStash(pi: ExtensionAPI) {
  let stashed: string | null = null;
  let history: string[] = readHistory();

  // ── History management ─────────────────────────────────────────────

  function pushHistory(text: string): void {
    if (!hasText(text)) return;
    if (history[0] === text) return; // dedup top
    history.unshift(text);
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    writeHistory(history);
  }

  // ── Stash lifecycle ────────────────────────────────────────────────

  function doStash(ctx: any, text: string): void {
    stashed = text;
    pushHistory(text);
    ctx.ui.setEditorText("");
    ctx.ui.setStatus("stash", "📋 stash");
    ctx.ui.notify(stashed === text ? "Text stashed" : "Stash updated", "info");
  }

  function doRestore(ctx: any): void {
    if (stashed === null) return;
    ctx.ui.setEditorText(stashed);
    stashed = null;
    ctx.ui.setStatus("stash", undefined);
    ctx.ui.notify("Stash restored", "info");
  }

  // ── History picker ─────────────────────────────────────────────────

  async function openHistory(ctx: any): Promise<void> {
    if (history.length === 0) {
      ctx.ui.notify("No stash history yet", "info");
      return;
    }

    const items: SelectItem[] = history.map((entry, i) => ({
      value: String(i),
      label: `#${i + 1} ${preview(entry, PREVIEW_WIDTH)}`,
    }));

    const selected: SelectItem | null = await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (r: SelectItem | null) => void) => {
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        const border = (t: string) => theme.fg("dim", t);
        const wrap = (t: string, w: number) =>
          `${border("│")}${truncateToWidth(t, w, "…", true)}${border("│")}`;

        selectList.onSelect = (item) => done(item);
        selectList.onCancel = () => done(null);

        return {
          render: (width: number) => {
            const iw = Math.max(1, width - 2);
            const lines: string[] = [];
            lines.push(border(`╭${"─".repeat(iw)}╮`));
            lines.push(wrap(theme.fg("accent", theme.bold("Stash history")), iw));
            lines.push(border(`├${"─".repeat(iw)}┤`));
            for (const line of selectList.render(iw)) lines.push(wrap(line, iw));
            lines.push(border(`├${"─".repeat(iw)}┤`));
            lines.push(wrap(theme.fg("dim", "↑↓ navigate • enter insert • esc cancel"), iw));
            lines.push(border(`╰${"─".repeat(iw)}╯`));
            return lines;
          },
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true, overlayOptions: () => ({ verticalAlign: "center", horizontalAlign: "center" }) },
    );

    if (!selected) return;
    const idx = Number.parseInt(selected.value, 10);
    const entry = history[idx];
    if (!entry) return;

    // Insert into editor (replace if empty, ask if has content)
    const current = ctx.ui.getEditorText();
    if (!hasText(current)) {
      ctx.ui.setEditorText(entry);
      ctx.ui.notify("Inserted stashed prompt", "info");
      return;
    }
    const action = await ctx.ui.select("Insert stashed prompt", ["Replace", "Append", "Cancel"]);
    if (action === "Replace") {
      ctx.ui.setEditorText(entry);
    } else if (action === "Append") {
      const sep = current.endsWith("\n") || entry.startsWith("\n") ? "" : "\n";
      ctx.ui.setEditorText(current + sep + entry);
    }
  }

  // ── Events ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    stashed = null;
    history = readHistory();
  });

  pi.on("session_switch", async (_event, ctx) => {
    stashed = null;
    history = readHistory();
    ctx.ui.setStatus("stash", undefined);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI || stashed === null) return;
    // Auto-restore only if editor is still empty
    if (!hasText(ctx.ui.getEditorText())) {
      ctx.ui.setEditorText(stashed);
      stashed = null;
      ctx.ui.setStatus("stash", undefined);
      ctx.ui.notify("Stash restored", "info");
    } else {
      ctx.ui.notify("Stash preserved — clear editor then Alt+S to restore", "info");
    }
  });

  // ── Shortcuts ──────────────────────────────────────────────────────

  pi.registerShortcut("alt+s", {
    description: "Stash/restore editor text",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const text = ctx.ui.getEditorText();
      const hasContent = hasText(text);
      const hasStash = stashed !== null;

      if (hasContent) {
        doStash(ctx, text);
      } else if (hasStash) {
        doRestore(ctx);
      } else {
        ctx.ui.notify("Nothing to stash", "info");
      }
    },
  });

  pi.registerShortcut("ctrl+alt+h", {
    description: "Open stash history",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await openHistory(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+c", {
    description: "Copy editor content",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const text = ctx.ui.getEditorText();
      if (!hasText(text)) { ctx.ui.notify("Editor is empty", "info"); return; }
      copyToClipboard(text);
      ctx.ui.notify("Copied editor text", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+x", {
    description: "Cut editor content",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const text = ctx.ui.getEditorText();
      if (!hasText(text)) { ctx.ui.notify("Editor is empty", "info"); return; }
      copyToClipboard(text);
      ctx.ui.setEditorText("");
      ctx.ui.notify("Cut editor text", "info");
    },
  });

  // ── Commands ───────────────────────────────────────────────────────

  pi.registerCommand("stash-history", {
    description: "Browse stash history",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await openHistory(ctx);
    },
  });
}
