import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

// ── Configuration ──────────────────────────────────────────────────
const DEFAULT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes with no activity
const POLL_INTERVAL_MS = 30 * 1000; // check every 30 seconds
const REMINDER_INTERVAL_MS = 10 * 60 * 1000; // re-notify every 10 minutes
const SOUND_FILE = "/usr/share/sounds/freedesktop/stereo/complete.oga";
const WIDGET_KEY = "stuck-detector";
const STATE_DIR = `${homedir()}/.cache/pi-stuck`;
const STATE_FILE = `${STATE_DIR}/${process.pid}.json`;

// ── State ──────────────────────────────────────────────────────────
let agentRunning = false;
let agentStartTime: number | null = null;
let lastActivityTime: number | null = null;
let lastNotifyTime: number | null = null;
let currentToolName: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let alerted = false;
let enabled = true;
let stuckThresholdMs = DEFAULT_THRESHOLD_MS;
let projectLabel = "";

export default function stuckDetector(pi: ExtensionAPI) {
  // Ensure state dir exists
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ok */ }

  // ── Helpers ────────────────────────────────────────────────────────

  function writeStateFile(stuck: boolean) {
    try {
      const data = {
        pid: process.pid,
        project: projectLabel,
        stuck,
        agentRunning,
        lastActivityTime,
        agentStartTime,
        currentToolName,
        updatedAt: Date.now(),
      };
      writeFileSync(STATE_FILE, JSON.stringify(data) + "\n");
    } catch { /* best effort */ }
  }

  function removeStateFile() {
    try { unlinkSync(STATE_FILE); } catch { /* ok if missing */ }
  }

  function resetState() {
    agentRunning = false;
    agentStartTime = null;
    lastActivityTime = null;
    lastNotifyTime = null;
    currentToolName = null;
    alerted = false;
  }

  function sendDesktopNotification(title: string, body: string, urgency: "low" | "normal" | "critical" = "critical") {
    execFile("notify-send", [
      "--urgency", urgency,
      "--app-name", "pi",
      "--icon", "dialog-warning",
      "--expire-time", "0", // persist until dismissed
      title,
      body,
    ], (err) => {
      if (err) { /* silent — notification daemon might not be running */ }
    });
  }

  function playSound() {
    // Play twice with a short gap — first play may be silent on bluetooth
    // as the audio sink needs a moment to wake up
    execFile("paplay", [SOUND_FILE], (err) => {
      if (err) {
        process.stdout.write("\x07");
        return;
      }
      setTimeout(() => execFile("paplay", [SOUND_FILE], () => {}), 600);
    });
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return sec > 0 ? `${min}m${sec}s` : `${min}m`;
    const hr = Math.floor(min / 60);
    const rm = min % 60;
    return rm > 0 ? `${hr}h${rm}m` : `${hr}h`;
  }

  function checkForStuck(ctx: ExtensionContext) {
    if (!enabled || !agentRunning || !lastActivityTime) return;

    const now = Date.now();
    const idleMs = now - lastActivityTime;

    if (idleMs < stuckThresholdMs) {
      // not stuck yet — clear any previous alert
      if (alerted) {
        alerted = false;
        lastNotifyTime = null;
        ctx.ui.setWidget(WIDGET_KEY, []);
      }
      return;
    }

    // We're stuck — show in-TUI widget
    const elapsed = formatDuration(now - (agentStartTime ?? lastActivityTime));
    const idleStr = formatDuration(idleMs);
    const toolInfo = currentToolName ? ` (last tool: ${currentToolName})` : "";
    const line = `⚠️  Session appears stuck — idle ${idleStr}, running for ${elapsed}${toolInfo}`;
    ctx.ui.setWidget(WIDGET_KEY, [line], { placement: "belowEditor" });

    // Update state file for waybar
    writeStateFile(true);

    // Desktop notification (with cooldown)
    if (!alerted || (lastNotifyTime && (now - lastNotifyTime) >= REMINDER_INTERVAL_MS)) {
      const proj = projectLabel || "unknown project";
      sendDesktopNotification(
        `🔴 pi session stuck (${proj})`,
        `Idle for ${idleStr}${toolInfo}\nRunning for ${elapsed} total`,
      );
      playSound();
      lastNotifyTime = now;
      alerted = true;
    }
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    resetState();
    projectLabel = basename(ctx.cwd);
    ctx.ui.setWidget(WIDGET_KEY, []);
  });

  pi.on("session_shutdown", async () => {
    resetState();
    removeStateFile();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    agentStartTime = Date.now();
    lastActivityTime = Date.now();
    currentToolName = null;
    alerted = false;
    lastNotifyTime = null;
    ctx.ui.setWidget(WIDGET_KEY, []);
    writeStateFile(false);

    // Start polling if not already
    if (!pollTimer) {
      pollTimer = setInterval(() => checkForStuck(ctx), POLL_INTERVAL_MS);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;
    agentStartTime = null;
    lastActivityTime = null;
    currentToolName = null;

    // If we had alerted, send a "resolved" notification
    if (alerted) {
      sendDesktopNotification(
        `✅ pi session resumed (${projectLabel})`,
        "Agent turn completed.",
        "normal",
      );
      alerted = false;
      lastNotifyTime = null;
    }

    ctx.ui.setWidget(WIDGET_KEY, []);
    writeStateFile(false);
  });

  // Track activity — each tool event means progress is happening
  pi.on("tool_execution_start", async (event, _ctx) => {
    lastActivityTime = Date.now();
    currentToolName = event.toolName;
  });

  pi.on("tool_execution_end", async (_event, _ctx) => {
    lastActivityTime = Date.now();
  });

  pi.on("tool_execution_update", async (_event, _ctx) => {
    lastActivityTime = Date.now();
  });

  // LLM streaming also counts as activity
  pi.on("message_update", async (_event, _ctx) => {
    lastActivityTime = Date.now();
  });

  pi.on("turn_start", async (_event, _ctx) => {
    lastActivityTime = Date.now();
  });

  pi.on("turn_end", async (_event, _ctx) => {
    lastActivityTime = Date.now();
  });

  // ── Commands ───────────────────────────────────────────────────────

  pi.registerCommand("stuck", {
    description: "Stuck detector: status/on/off/test/threshold <minutes>",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "on") {
        enabled = true;
        ctx.ui.notify("Stuck detector enabled", "info");
      } else if (arg === "off") {
        enabled = false;
        ctx.ui.setWidget(WIDGET_KEY, []);
        ctx.ui.notify("Stuck detector disabled", "info");
      } else if (arg === "test") {
        // Send a test notification — temporarily mark as stuck so click handler works
        writeStateFile(true);
        sendDesktopNotification(
          `🔴 pi session stuck (${projectLabel || "test"})`,
          "This is a test notification.\nIdle for 5m (last tool: bash)",
        );
        playSound();
        // Clear stuck state after a longer delay so click handler works
        setTimeout(() => writeStateFile(false), 5 * 60_000);
        ctx.ui.notify("Test notification sent", "info");
      } else if (arg.startsWith("threshold")) {
        const mins = parseInt(arg.replace("threshold", "").trim(), 10);
        if (isNaN(mins) || mins < 1) {
          ctx.ui.notify(`Current threshold: ${stuckThresholdMs / 60000}m`, "info");
        } else {
          stuckThresholdMs = mins * 60 * 1000;
          ctx.ui.notify(`Threshold set to ${mins}m`, "info");
        }
      } else {
        // Status
        const status = [
          `Stuck detector: ${enabled ? "ON" : "OFF"}`,
          `Agent running: ${agentRunning}`,
          `Threshold: ${stuckThresholdMs / 60000}m`,
          `Poll interval: ${POLL_INTERVAL_MS / 1000}s`,
        ];
        if (agentRunning && lastActivityTime) {
          const idle = formatDuration(Date.now() - lastActivityTime);
          status.push(`Last activity: ${idle} ago`);
          if (currentToolName) status.push(`Current tool: ${currentToolName}`);
        }
        if (alerted) status.push("⚠️ Currently in STUCK state");
        ctx.ui.notify(status.join("\n"), "info");
      }
    },
  });
}
