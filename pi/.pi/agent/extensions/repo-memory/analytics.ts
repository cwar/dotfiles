import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────

export interface SessionMetrics {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  extensionActive: boolean;

  // Tool call counts
  toolCalls: Record<string, number>;

  // File access patterns
  filesRead: Record<string, number>; // path → read count
  uniqueFilesRead: number;
  totalFileReads: number;
  repeatedFileReads: number; // reads of already-seen files

  // Orientation cost: tool calls before first edit/write
  callsBeforeFirstEdit: number;
  firstEditAt?: number; // turn index

  // Turns
  totalTurns: number;

  // Memory usage
  repoMapCalls: number;
  recallCalls: number;
  rememberCalls: number;
  memoriesInjected: number; // auto-injected via before_agent_start
  memoriesAvailable: number; // total at session start

  // Timing
  totalAgentTimeMs: number;
}

export interface AnalyticsSnapshot {
  version: number;
  sessions: SessionMetrics[];
}

// ── Analytics Tracker ─────────────────────────────────────

export class Analytics {
  private filePath: string;
  private current: SessionMetrics | null = null;
  private agentStartTime = 0;
  private hasEdited = false;
  private callCountBeforeEdit = 0;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "analytics.json");
  }

  // ── Session lifecycle ───────────────────────────────

  startSession(sessionId: string, memoriesAvailable: number): void {
    this.current = {
      sessionId,
      startedAt: Date.now(),
      extensionActive: true,
      toolCalls: {},
      filesRead: {},
      uniqueFilesRead: 0,
      totalFileReads: 0,
      repeatedFileReads: 0,
      callsBeforeFirstEdit: 0,
      totalTurns: 0,
      repoMapCalls: 0,
      recallCalls: 0,
      rememberCalls: 0,
      memoriesInjected: 0,
      memoriesAvailable,
      totalAgentTimeMs: 0,
    };
    this.hasEdited = false;
    this.callCountBeforeEdit = 0;
  }

  endSession(): void {
    if (!this.current) return;
    this.current.endedAt = Date.now();
    if (!this.hasEdited) {
      this.current.callsBeforeFirstEdit = this.callCountBeforeEdit;
    }
    this.save();
    this.current = null;
  }

  // ── Event tracking ──────────────────────────────────

  trackToolCall(toolName: string, input: Record<string, any>): void {
    if (!this.current) return;

    // Count by tool name
    this.current.toolCalls[toolName] = (this.current.toolCalls[toolName] || 0) + 1;

    // Track orientation cost
    if (!this.hasEdited) {
      if (toolName === "edit" || toolName === "write") {
        this.hasEdited = true;
        this.current.callsBeforeFirstEdit = this.callCountBeforeEdit;
        this.current.firstEditAt = this.current.totalTurns;
      } else {
        this.callCountBeforeEdit++;
      }
    }

    // Track file reads
    if (toolName === "read" && input?.path) {
      const filePath = input.path;
      const prevCount = this.current.filesRead[filePath] || 0;
      this.current.filesRead[filePath] = prevCount + 1;
      this.current.totalFileReads++;
      if (prevCount === 0) {
        this.current.uniqueFilesRead++;
      } else {
        this.current.repeatedFileReads++;
      }
    }

    // Track our tools
    if (toolName === "repo_map") this.current.repoMapCalls++;
    if (toolName === "recall") this.current.recallCalls++;
    if (toolName === "remember") this.current.rememberCalls++;
  }

  trackTurn(): void {
    if (!this.current) return;
    this.current.totalTurns++;
  }

  trackAgentStart(): void {
    this.agentStartTime = Date.now();
  }

  trackAgentEnd(): void {
    if (!this.current) return;
    if (this.agentStartTime > 0) {
      this.current.totalAgentTimeMs += Date.now() - this.agentStartTime;
      this.agentStartTime = 0;
    }
  }

  trackMemoryInjection(count: number): void {
    if (!this.current) return;
    this.current.memoriesInjected = count;
  }

  // ── Persistence ─────────────────────────────────────

  private load(): AnalyticsSnapshot {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      }
    } catch {}
    return { version: 1, sessions: [] };
  }

  private save(): void {
    if (!this.current) return;
    const data = this.load();
    data.sessions.push(this.current);

    // Keep last 100 sessions
    if (data.sessions.length > 100) {
      data.sessions = data.sessions.slice(-100);
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  // ── Reporting ───────────────────────────────────────

  generateReport(): string {
    const data = this.load();
    const sessions = data.sessions;

    if (sessions.length === 0) {
      return "No analytics data yet. Use the agent for a few sessions and check back.";
    }

    const lines: string[] = [];
    lines.push(`# Repo Memory Analytics`);
    lines.push(`Sessions tracked: ${sessions.length}`);
    lines.push("");

    // Overall averages
    const avg = (arr: number[]) =>
      arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const totalReads = sessions.map((s) => s.totalFileReads);
    const uniqueReads = sessions.map((s) => s.uniqueFilesRead);
    const repeatedReads = sessions.map((s) => s.repeatedFileReads);
    const orientationCost = sessions.map((s) => s.callsBeforeFirstEdit);
    const turns = sessions.map((s) => s.totalTurns);
    const totalToolCalls = sessions.map((s) =>
      Object.values(s.toolCalls).reduce((a, b) => a + b, 0)
    );

    lines.push(`## Averages Across Sessions`);
    lines.push(`| Metric | Average | Min | Max |`);
    lines.push(`|--------|---------|-----|-----|`);
    lines.push(
      `| Total tool calls | ${avg(totalToolCalls).toFixed(1)} | ${Math.min(...totalToolCalls)} | ${Math.max(...totalToolCalls)} |`
    );
    lines.push(
      `| File reads (total) | ${avg(totalReads).toFixed(1)} | ${Math.min(...totalReads)} | ${Math.max(...totalReads)} |`
    );
    lines.push(
      `| File reads (unique) | ${avg(uniqueReads).toFixed(1)} | ${Math.min(...uniqueReads)} | ${Math.max(...uniqueReads)} |`
    );
    lines.push(
      `| File re-reads | ${avg(repeatedReads).toFixed(1)} | ${Math.min(...repeatedReads)} | ${Math.max(...repeatedReads)} |`
    );
    lines.push(
      `| Calls before first edit | ${avg(orientationCost).toFixed(1)} | ${Math.min(...orientationCost)} | ${Math.max(...orientationCost)} |`
    );
    lines.push(
      `| Turns per task | ${avg(turns).toFixed(1)} | ${Math.min(...turns)} | ${Math.max(...turns)} |`
    );
    lines.push("");

    // Re-read ratio
    const rereadRatios = sessions
      .filter((s) => s.totalFileReads > 0)
      .map((s) => s.repeatedFileReads / s.totalFileReads);
    if (rereadRatios.length > 0) {
      lines.push(
        `**Re-read ratio**: ${(avg(rereadRatios) * 100).toFixed(1)}% of file reads are re-reads of already-seen files`
      );
      lines.push("");
    }

    // Memory tool usage
    const withMemoryTools = sessions.filter(
      (s) => s.repoMapCalls > 0 || s.recallCalls > 0 || s.rememberCalls > 0
    );
    const withoutMemoryTools = sessions.filter(
      (s) => s.repoMapCalls === 0 && s.recallCalls === 0 && s.rememberCalls === 0
    );

    if (withMemoryTools.length > 0 && withoutMemoryTools.length > 0) {
      lines.push(`## With vs Without Memory Tools`);
      lines.push(
        `| Metric | With (${withMemoryTools.length} sessions) | Without (${withoutMemoryTools.length} sessions) | Delta |`
      );
      lines.push(`|--------|------|---------|-------|`);

      const metrics: [string, (s: SessionMetrics) => number][] = [
        ["Total tool calls", (s) => Object.values(s.toolCalls).reduce((a, b) => a + b, 0)],
        ["File re-reads", (s) => s.repeatedFileReads],
        ["Calls before edit", (s) => s.callsBeforeFirstEdit],
        ["Turns", (s) => s.totalTurns],
      ];

      for (const [name, fn] of metrics) {
        const withAvg = avg(withMemoryTools.map(fn));
        const withoutAvg = avg(withoutMemoryTools.map(fn));
        const delta = withAvg - withoutAvg;
        const pct =
          withoutAvg > 0 ? ((delta / withoutAvg) * 100).toFixed(0) + "%" : "N/A";
        lines.push(
          `| ${name} | ${withAvg.toFixed(1)} | ${withoutAvg.toFixed(1)} | ${delta > 0 ? "+" : ""}${delta.toFixed(1)} (${pct}) |`
        );
      }
      lines.push("");
    }

    // Memory injection stats
    const injected = sessions.filter((s) => s.memoriesInjected > 0);
    if (injected.length > 0) {
      lines.push(`## Auto-Injection`);
      lines.push(
        `${injected.length} of ${sessions.length} sessions had memories auto-injected`
      );
      lines.push(
        `Average memories injected: ${avg(injected.map((s) => s.memoriesInjected)).toFixed(1)}`
      );
      lines.push("");
    }

    // Most re-read files across all sessions
    const fileReadCounts: Record<string, number> = {};
    for (const s of sessions) {
      for (const [filePath, count] of Object.entries(s.filesRead)) {
        if (count > 1) {
          fileReadCounts[filePath] = (fileReadCounts[filePath] || 0) + (count - 1);
        }
      }
    }
    const topReReads = Object.entries(fileReadCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (topReReads.length > 0) {
      lines.push(`## Most Re-Read Files (candidates for \`remember\`)`);
      for (const [filePath, extraReads] of topReReads) {
        lines.push(`  ${extraReads} extra reads: ${filePath}`);
      }
      lines.push("");
    }

    // Recent session details
    const recent = sessions.slice(-5).reverse();
    lines.push(`## Recent Sessions`);
    for (const s of recent) {
      const duration = s.endedAt
        ? `${((s.endedAt - s.startedAt) / 1000).toFixed(0)}s`
        : "ongoing";
      const tools = Object.values(s.toolCalls).reduce((a, b) => a + b, 0);
      const date = new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ");
      lines.push(
        `- **${date}** — ${s.totalTurns} turns, ${tools} tool calls, ` +
          `${s.totalFileReads} reads (${s.repeatedFileReads} re-reads), ` +
          `${s.callsBeforeFirstEdit} calls before edit, ` +
          `memory: ${s.repoMapCalls}map/${s.recallCalls}recall/${s.rememberCalls}remember ` +
          `(${duration})`
      );
    }

    return lines.join("\n");
  }
}
