/**
 * Task Queue Extension
 *
 * Queue instructions to run automatically after the current task completes.
 *
 * Shortcuts:
 *   Alt+Q          — Queue editor text as next instruction
 *   Ctrl+Alt+Q     — Queue with context clear (like /new first)
 *   Alt+Shift+Q    — Browse/manage queue
 *
 * Commands:
 *   /queue          — Queue editor text (or show queue if editor empty)
 *   /queue new      — Queue editor text with context clear
 *   /queue list     — Show queued instructions
 *   /queue clear    — Clear all queued instructions
 *   /queue pause    — Pause auto-execution
 *   /queue resume   — Resume auto-execution
 *   /queue next     — Execute next item immediately (skip wait)
 *
 * Behavior:
 *   - Queue instructions while the agent is working
 *   - On agent_end, automatically sends the next queued instruction
 *   - FIFO execution order
 *   - Items marked with /new clear context before executing
 *   - Pause/resume to control auto-execution
 *   - Status indicator shows queue state
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ──────────────────────────────────────────────────────────────

interface QueueItem {
  id: number;
  text: string;
  queuedAt: number;
  clearContext: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function hasText(text: string): boolean {
  return text.trim().length > 0;
}

function preview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  if (visibleWidth(compact) <= maxWidth) return compact;
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

function itemLabel(item: QueueItem, index: number, previewWidth: number): string {
  const prefix = item.clearContext ? "🔄 " : "   ";
  return `${prefix}${index + 1}. ${preview(item.text, previewWidth)}`;
}

function relativeTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function taskQueue(pi: ExtensionAPI) {
  let queue: QueueItem[] = [];
  let nextId = 1;
  let paused = false;
  let executing = false;
  let agentRunning = false;

  // Trampoline state: holds the item being executed through /queue-exec
  // when we need newSession() (only available in command context)
  let pendingExecItem: QueueItem | null = null;
  let preserveQueueOnSwitch = false;
  // Text to send after session switch completes (deferred from command handler)
  let deferredSendText: string | null = null;

  // ── Queue operations ───────────────────────────────────────────────

  function enqueue(text: string, clearContext: boolean, ctx: any): void {
    queue.push({ id: nextId++, text, queuedAt: Date.now(), clearContext });
    updateStatus(ctx);

    // If agent is idle, auto-execute immediately — don't wait for an
    // agent_end that already fired (or may never come).
    if (!agentRunning && !paused && !executing) {
      executing = true;
      // Small delay so the "Queued #N" notification is visible before we fire
      setTimeout(() => {
        const item = dequeue();
        if (item) {
          updateStatus(ctx);
          executeItem(item, ctx);
        }
        executing = false;
      }, 400);
    }
  }

  function dequeue(): QueueItem | undefined {
    return queue.shift();
  }

  function clearQueue(ctx: any): void {
    queue = [];
    updateStatus(ctx);
  }

  function removeItem(id: number, ctx: any): boolean {
    const idx = queue.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    updateStatus(ctx);
    return true;
  }

  // ── Status ─────────────────────────────────────────────────────────

  function updateStatus(ctx: any): void {
    if (!ctx.hasUI) return;
    if (queue.length === 0) {
      ctx.ui.setStatus("task-queue", undefined);
    } else if (paused) {
      ctx.ui.setStatus("task-queue", `⏸ ${queue.length} queued`);
    } else {
      ctx.ui.setStatus("task-queue", `⏳ ${queue.length} queued`);
    }
  }

  // ── Execute an item ────────────────────────────────────────────────

  function executeItem(item: QueueItem, ctx: any): void {
    const remaining = queue.length;
    const suffix = remaining > 0 ? ` (${remaining} more)` : "";
    const newFlag = item.clearContext ? " [/new]" : "";
    ctx.ui.notify(`▶ Executing queued task${newFlag}${suffix}`, "info");

    if (item.clearContext) {
      // Trampoline: stash the item and bounce through a command handler
      // where we have access to ctx.newSession()
      pendingExecItem = item;
      preserveQueueOnSwitch = true;
      pi.sendUserMessage("/__queue-exec");
    } else {
      pi.sendUserMessage(item.text);
    }
  }

  // ── Queue manager overlay ──────────────────────────────────────────

  async function openQueueManager(ctx: any): Promise<void> {
    if (queue.length === 0) {
      ctx.ui.notify("Queue is empty", "info");
      return;
    }

    const PREVIEW_WIDTH = 56;

    const result: string | null = await ctx.ui.custom(
      (tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
        const buildItems = (): SelectItem[] =>
          queue.map((entry, i) => ({
            value: String(entry.id),
            label: itemLabel(entry, i, PREVIEW_WIDTH),
            description: relativeTime(Date.now() - entry.queuedAt),
          }));

        let items = buildItems();
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });

        selectList.onSelect = (item) => done(`select:${item.value}`);
        selectList.onCancel = () => done(null);

        const border = (t: string) => theme.fg("dim", t);
        const wrap = (t: string, w: number) =>
          `${border("│")}${truncateToWidth(t, w, "…", true)}${border("│")}`;

        return {
          render: (width: number) => {
            const iw = Math.max(1, width - 2);
            const lines: string[] = [];
            const statusText = paused ? " ⏸ PAUSED" : "";
            const title = `Task Queue (${queue.length})${statusText}`;
            lines.push(border(`╭${"─".repeat(iw)}╮`));
            lines.push(wrap(theme.fg("accent", theme.bold(title)), iw));
            lines.push(border(`├${"─".repeat(iw)}┤`));
            for (const line of selectList.render(iw)) lines.push(wrap(line, iw));
            lines.push(border(`├${"─".repeat(iw)}┤`));
            lines.push(wrap(theme.fg("dim", "enter manage • esc close • 🔄 = /new"), iw));
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

    if (!result) return;

    if (result.startsWith("select:")) {
      const id = Number.parseInt(result.slice(7), 10);
      const item = queue.find((q) => q.id === id);
      if (!item) return;

      const toggleLabel = item.clearContext ? "Remove /new flag" : "Add /new flag (clear context)";
      const action = await ctx.ui.select(`"${preview(item.text, 50)}"`, [
        "Remove from queue",
        "Move to front",
        toggleLabel,
        "Edit & re-queue",
        "Cancel",
      ]);

      if (action === "Remove from queue") {
        removeItem(id, ctx);
        ctx.ui.notify("Removed from queue", "info");
        if (queue.length > 0) await openQueueManager(ctx);
      } else if (action === "Move to front") {
        const idx = queue.findIndex((q) => q.id === id);
        if (idx > 0) {
          const [moved] = queue.splice(idx, 1);
          queue.unshift(moved);
          ctx.ui.notify("Moved to front", "info");
        }
        if (queue.length > 0) await openQueueManager(ctx);
      } else if (action === toggleLabel) {
        item.clearContext = !item.clearContext;
        ctx.ui.notify(item.clearContext ? "Will clear context (/new) before executing" : "/new flag removed", "info");
        if (queue.length > 0) await openQueueManager(ctx);
      } else if (action === "Edit & re-queue") {
        const edited = await ctx.ui.editor("Edit instruction:", item.text);
        if (edited && hasText(edited)) {
          item.text = edited.trim();
          item.queuedAt = Date.now();
          ctx.ui.notify("Updated", "info");
        }
        if (queue.length > 0) await openQueueManager(ctx);
      }
    }
  }

  // ── Enqueue via modal editor ─────────────────────────────────────

  async function doEnqueue(ctx: any, clearContext: boolean): Promise<void> {
    // Pre-populate with editor text (if any)
    const prefill = ctx.ui.getEditorText().trim();
    const flag = clearContext ? " [/new]" : "";
    const title = `Queue Task${flag}`;

    const text = await ctx.ui.editor(title, prefill);
    if (!text || !hasText(text)) {
      // Cancelled or empty — no-op, leave editor untouched
      return;
    }

    enqueue(text.trim(), clearContext, ctx);

    // Clear editor only if we consumed its text
    if (prefill && ctx.ui.getEditorText().trim() === prefill) {
      ctx.ui.setEditorText("");
    }

    const count = queue.length;
    ctx.ui.notify(`Queued #${count}${flag}: ${preview(text.trim(), 45)}`, "info");
  }

  // ── Track agent lifecycle ──────────────────────────────────────────

  pi.on("agent_start", async (_event, _ctx) => {
    agentRunning = true;
  });

  // ── Auto-execute on agent_end ──────────────────────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;
    if (!ctx.hasUI) return;
    if (paused || queue.length === 0 || executing) return;

    executing = true;
    const item = dequeue();
    if (!item) {
      executing = false;
      return;
    }

    updateStatus(ctx);

    // Small delay so user can see the previous output
    await new Promise((r) => setTimeout(r, 300));

    executeItem(item, ctx);
    executing = false;
  });

  // ── Internal trampoline command for /new items ─────────────────────
  // We need ExtensionCommandContext (with newSession()) to clear context.
  // Event handlers only get ExtensionContext. So we bounce through this
  // command via pi.sendUserMessage("/__queue-exec").

  pi.registerCommand("__queue-exec", {
    description: "Internal: execute queued task with context clear",
    handler: async (_args, ctx) => {
      const item = pendingExecItem;
      pendingExecItem = null;

      if (!item) return;

      if (item.clearContext) {
        preserveQueueOnSwitch = true;
        deferredSendText = item.text;
        const result = await ctx.newSession();
        if (result.cancelled) {
          deferredSendText = null;
          // Put it back at the front
          queue.unshift(item);
          updateStatus(ctx);
          ctx.ui.notify("Session switch cancelled — item re-queued", "warning");
          return;
        }
        // Don't send here — sendUserMessage inside a command handler
        // during a session switch gets silently dropped. The
        // session_switch event handler will pick up deferredSendText.
      } else {
        pi.sendUserMessage(item.text);
      }
    },
  });

  // ── Session events ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    queue = [];
    nextId = 1;
    paused = false;
    executing = false;
    agentRunning = false;
    pendingExecItem = null;
    preserveQueueOnSwitch = false;
    deferredSendText = null;
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (preserveQueueOnSwitch) {
      // Queue survives — this switch was triggered by a clearContext item
      preserveQueueOnSwitch = false;
      updateStatus(ctx);

      // Send the deferred task text now that the new session is active.
      // Use setTimeout to ensure the session is fully settled and the
      // command handler has unwound before we inject a new user message.
      const text = deferredSendText;
      deferredSendText = null;
      if (text) {
        setTimeout(() => pi.sendUserMessage(text), 400);
      }
    } else {
      queue = [];
      nextId = 1;
      paused = false;
      executing = false;
      agentRunning = false;
      pendingExecItem = null;
      deferredSendText = null;
      ctx.ui.setStatus("task-queue", undefined);
    }
  });

  // ── Shortcuts ──────────────────────────────────────────────────────

  pi.registerShortcut("alt+q", {
    description: "Queue editor text as next instruction",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await doEnqueue(ctx, false);
    },
  });

  pi.registerShortcut("ctrl+alt+q", {
    description: "Queue editor text with context clear (/new)",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await doEnqueue(ctx, true);
    },
  });

  pi.registerShortcut("alt+shift+q", {
    description: "Open queue manager",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await openQueueManager(ctx);
    },
  });

  // ── Commands ───────────────────────────────────────────────────────

  pi.registerCommand("queue", {
    description: "Manage the task queue (new | clear | pause | resume | next | list)",
    getArgumentCompletions: (prefix: string) => {
      const subs = [
        { value: "new", label: "new", description: "Queue editor text with context clear (/new)" },
        { value: "clear", label: "clear", description: "Clear all queued instructions" },
        { value: "pause", label: "pause", description: "Pause auto-execution" },
        { value: "resume", label: "resume", description: "Resume auto-execution" },
        { value: "next", label: "next", description: "Execute next item now" },
        { value: "list", label: "list", description: "Show queued instructions" },
      ];
      const filtered = subs.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const sub = (args || "").trim().toLowerCase();

      if (sub === "new") {
        await doEnqueue(ctx, true);
        return;
      }

      if (sub === "clear") {
        if (queue.length === 0) {
          ctx.ui.notify("Queue is already empty", "info");
          return;
        }
        const ok = await ctx.ui.confirm("Clear queue?", `Remove ${queue.length} queued instruction(s)?`);
        if (ok) {
          clearQueue(ctx);
          ctx.ui.notify("Queue cleared", "info");
        }
        return;
      }

      if (sub === "pause") {
        paused = true;
        updateStatus(ctx);
        ctx.ui.notify("Queue paused — instructions won't auto-execute", "info");
        return;
      }

      if (sub === "resume") {
        paused = false;
        updateStatus(ctx);
        ctx.ui.notify("Queue resumed — will execute after next agent completion", "info");
        return;
      }

      if (sub === "next") {
        if (queue.length === 0) {
          ctx.ui.notify("Queue is empty", "info");
          return;
        }
        const item = dequeue()!;
        updateStatus(ctx);
        executeItem(item, ctx);
        return;
      }

      if (sub === "list") {
        if (queue.length === 0) {
          ctx.ui.notify("Queue is empty", "info");
          return;
        }
        await openQueueManager(ctx);
        return;
      }

      // No subcommand: open modal to queue (or show manager if queue exists and editor empty)
      const editorText = ctx.ui.getEditorText();
      if (hasText(editorText)) {
        await doEnqueue(ctx, false);
      } else if (queue.length > 0) {
        await openQueueManager(ctx);
      } else {
        await doEnqueue(ctx, false);
      }
    },
  });
}
