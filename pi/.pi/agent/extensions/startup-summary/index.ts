/**
 * Startup Summary Extension
 *
 * Replaces pi's verbose startup listing with a compact one-liner showing
 * counts of loaded resources. Works with quietStartup: true to suppress
 * the built-in verbose display, then renders its own compact summary.
 *
 * The compact summary is shown as a footer status line (not a widget above
 * the editor) to avoid layout shifts during startup that can disrupt typing.
 *
 * The summary line shows: Context · Extensions · Skills · MCP
 *
 * Commands:
 *   /startup        — Toggle between compact status and expanded widget
 *   /startup full   — Show expanded view (like verbose startup)
 *
 * The expanded view groups items by scope (global, project, package)
 * and can be collapsed back to the one-liner.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────

interface ResourceCounts {
  context: string[];
  skills: { name: string; path: string; scope: string }[];
  extensions: { name: string; path: string; scope: string }[];
  prompts: { name: string; path: string; scope: string }[];
  mcp: string[];
}

// ── Filesystem Discovery ───────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function findContextFiles(cwd: string): string[] {
  const files: string[] = [];
  const names = ["AGENTS.md", "CLAUDE.md"];

  // Global
  for (const name of names) {
    const p = join(homedir(), ".pi", "agent", name);
    if (existsSync(p)) files.push(p);
  }

  // Project-local
  for (const name of names) {
    const p = join(cwd, ".pi", name);
    if (existsSync(p)) files.push(p);
  }

  // CWD root
  for (const name of names) {
    const p = join(cwd, name);
    if (existsSync(p)) files.push(p);
  }

  return files;
}

function findSkills(settingsSkillPaths: string[]): { name: string; path: string; scope: string }[] {
  const skills: { name: string; path: string; scope: string }[] = [];

  for (const dir of settingsSkillPaths) {
    const resolved = expandHome(dir);
    if (!existsSync(resolved)) continue;

    const scope = resolved.includes(".claude/skills") && !resolved.includes("plugins")
      ? "user"
      : resolved.includes("plugins") || resolved.includes("packages")
        ? "package"
        : "project";

    // Walk one or two levels looking for SKILL.md
    walkForSkills(resolved, scope, skills, 0, 4);
  }

  // Project-local skills
  const localSkills = join(process.cwd(), ".pi", "skills");
  if (existsSync(localSkills)) {
    walkForSkills(localSkills, "project", skills, 0, 4);
  }

  return skills;
}

function walkForSkills(
  dir: string,
  scope: string,
  out: { name: string; path: string; scope: string }[],
  depth: number,
  maxDepth: number
): void {
  if (depth > maxDepth || !existsSync(dir)) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") {
        out.push({ name: basename(dirname(full)), path: full, scope });
      } else if (entry.isDirectory()) {
        walkForSkills(full, scope, out, depth + 1, maxDepth);
      }
    }
  } catch { /* ignore permission errors */ }
}

function findExtensions(cwd: string): { name: string; path: string; scope: string }[] {
  const exts: { name: string; path: string; scope: string }[] = [];

  // Global extensions
  const globalDir = join(homedir(), ".pi", "agent", "extensions");
  if (existsSync(globalDir)) {
    try {
      for (const entry of readdirSync(globalDir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        if (entry.name === "startup-summary") continue; // don't count ourselves
        const full = join(globalDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          exts.push({ name: entry.name.replace(/\.ts$/, ""), path: full, scope: "global" });
        } else if (entry.isDirectory() && existsSync(join(full, "index.ts"))) {
          exts.push({ name: entry.name, path: full, scope: "global" });
        }
      }
    } catch { /* ignore */ }
  }

  // Project-local extensions
  const localDir = join(cwd, ".pi", "extensions");
  if (existsSync(localDir)) {
    try {
      for (const entry of readdirSync(localDir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = join(localDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          exts.push({ name: entry.name.replace(/\.ts$/, ""), path: full, scope: "project" });
        } else if (entry.isDirectory() && existsSync(join(full, "index.ts"))) {
          exts.push({ name: entry.name, path: full, scope: "project" });
        }
      }
    } catch { /* ignore */ }
  }

  return exts;
}

function findMcpServers(): string[] {
  const servers: string[] = [];
  const mcpPaths = [
    join(homedir(), ".pi", "agent", "mcp.json"),
    join(process.cwd(), ".pi", "mcp.json"),
  ];

  for (const p of mcpPaths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const mcpServers = data.mcpServers || data.servers || {};
      for (const name of Object.keys(mcpServers)) {
        if (!servers.includes(name)) servers.push(name);
      }
    } catch { /* ignore */ }
  }

  return servers;
}

function getSkillPaths(): string[] {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      return settings.skills || [];
    }
  } catch { /* ignore */ }
  return [];
}

// ── Formatting ─────────────────────────────────────────────────────────

function formatPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Build compact summary as a plain string (for footer status line). */
function compactSummary(counts: ResourceCounts, theme: any): string {
  const parts: string[] = [];

  if (counts.context.length > 0) {
    parts.push(`${counts.context.length} context`);
  }
  if (counts.extensions.length > 0) {
    parts.push(`${counts.extensions.length} extensions`);
  }
  if (counts.skills.length > 0) {
    parts.push(`${counts.skills.length} skills`);
  }
  if (counts.mcp.length > 0) {
    parts.push(`${counts.mcp.length} mcp`);
  }

  const summary = parts.join(theme.fg("dim", " · "));
  const hint = theme.fg("dim", "/startup to expand");
  return `${theme.fg("dim", "▸")} ${summary}  ${hint}`;
}

function expandedLines(counts: ResourceCounts, theme: any): string[] {
  const lines: string[] = [];
  const section = (name: string) => theme.fg("mdHeading", `[${name}]`);

  if (counts.context.length > 0) {
    lines.push(section("Context"));
    for (const f of counts.context) {
      lines.push(theme.fg("dim", `  ${formatPath(f)}`));
    }
    lines.push("");
  }

  if (counts.extensions.length > 0) {
    lines.push(section("Extensions"));
    const byScope = groupByScope(counts.extensions);
    for (const [scope, items] of byScope) {
      if (byScope.size > 1) {
        lines.push(theme.fg("dim", `  ${scopeLabel(scope)}`));
      }
      for (const item of items) {
        const prefix = byScope.size > 1 ? "    " : "  ";
        lines.push(theme.fg("dim", `${prefix}${item.name}`));
      }
    }
    lines.push("");
  }

  if (counts.skills.length > 0) {
    lines.push(section("Skills"));
    const byScope = groupByScope(counts.skills);
    for (const [scope, items] of byScope) {
      if (byScope.size > 1) {
        lines.push(theme.fg("dim", `  ${scopeLabel(scope)}`));
      }
      for (const item of items) {
        const prefix = byScope.size > 1 ? "    " : "  ";
        lines.push(theme.fg("dim", `${prefix}${item.name}`));
      }
    }
    lines.push("");
  }

  if (counts.mcp.length > 0) {
    lines.push(section("MCP Servers"));
    for (const name of counts.mcp) {
      lines.push(theme.fg("dim", `  ${name}`));
    }
    lines.push("");
  }

  const hint = theme.fg("dim", "/startup to collapse");
  lines.push(`${theme.fg("dim", "▾")} ${hint}`);

  return lines;
}

function groupByScope<T extends { scope: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const arr = groups.get(item.scope) || [];
    arr.push(item);
    groups.set(item.scope, arr);
  }
  return groups;
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "global": return "Global:";
    case "project": return "Project:";
    case "user": return "User:";
    case "package": return "Package:";
    default: return `${scope}:`;
  }
}

// ── Extension ──────────────────────────────────────────────────────────

const STATUS_KEY = "startup-summary";
const WIDGET_KEY = "startup-summary";

export default function startupSummary(pi: ExtensionAPI) {
  let expanded = false;
  let counts: ResourceCounts | null = null;
  let currentCtx: ExtensionContext | null = null;

  function discover(cwd: string): ResourceCounts {
    const skillPaths = getSkillPaths();
    return {
      context: findContextFiles(cwd),
      skills: findSkills(skillPaths),
      extensions: findExtensions(cwd),
      prompts: [],
      mcp: findMcpServers(),
    };
  }

  /**
   * Show compact summary in the footer status line (no layout shift).
   * Show expanded view in a widget above the editor (explicit user request).
   */
  function render(ctx: ExtensionContext) {
    if (!counts) return;

    if (expanded) {
      // Expanded: show as widget above editor + clear status
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
        const lines = expandedLines(counts!, theme);
        const container = new Container();
        for (const line of lines) {
          container.addChild(new Text(line, 1, 0));
        }
        return container;
      }, { placement: "aboveEditor" });
    } else {
      // Compact: show as footer status line (no layout shift above editor)
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, compactSummary(counts!, ctx.ui.theme));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    counts = discover(ctx.cwd);
    expanded = false;
    render(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    currentCtx = ctx;
    counts = discover(ctx.cwd);
    expanded = false;
    render(ctx);
  });

  // Clear once the user sends their first message
  pi.on("before_agent_start", async (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("startup", {
    description: "Toggle startup resource summary (compact ↔ expanded)",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      if (!counts) counts = discover(ctx.cwd);

      if (args?.trim() === "full") {
        expanded = true;
      } else if (args?.trim() === "compact") {
        expanded = false;
      } else {
        expanded = !expanded;
      }
      render(ctx);
    },
  });
}
