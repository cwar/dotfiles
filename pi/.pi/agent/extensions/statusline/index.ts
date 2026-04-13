/**
 * Statusline Extension
 *
 * Renders a clean status line in the editor's top border — no separate footer.
 * Shows model, thinking level, path, git status, PR reviews, context %, and cost.
 *
 * Features:
 *   - Async git status with 1s cache TTL, auto-invalidation on file writes
 *   - Color-coded context warnings at 70% (yellow) and 90% (red)
 *   - Nerd Font auto-detection with ASCII fallbacks
 *   - Responsive: segments overflow gracefully on narrow terminals
 *   - Smart token formatting (1.2k, 45M)
 *   - Subscription vs dollar cost detection
 *
 * Toggle: /statusline
 */

import {
  type ExtensionAPI,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

// ── Nerd Font Detection ────────────────────────────────────────────────

function hasNerdFonts(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some(t => term.includes(t));
}

// ── OS Detection ───────────────────────────────────────────────────────

function detectOsIcon(): string {
  const platform = process.platform;
  if (platform === "darwin") return "\uF179";   // Apple 
  if (platform === "win32") return "\uE70F";    // Windows 
  // Linux — detect distro from /etc/os-release
  try {
    const osRelease = readFileSync("/etc/os-release", "utf-8");
    const idMatch = osRelease.match(/^ID=(.+)$/m);
    const id = idMatch?.[1]?.replace(/"/g, "").toLowerCase() ?? "";
    const distroIcons: Record<string, string> = {
      arch:     "\uF303",  // 
      ubuntu:   "\uF31B",  // 
      fedora:   "\uF30A",  // 
      debian:   "\uF306",  // 
      nixos:    "\uF313",  // 
      manjaro:  "\uF312",  // 
      opensuse: "\uF314",  // 
      centos:   "\uF304",  // 
      gentoo:   "\uF30D",  // 
      void:     "\uF32E",  // (closest)
      alpine:   "\uF300",  // 
    };
    if (id in distroIcons) return distroIcons[id];
  } catch {}
  return "\uF17C"; // Tux 🐧 (generic Linux)
}

// Cache it — OS doesn't change mid-session
let _osIcon: string | null = null;
function osIcon(): string {
  if (_osIcon === null) _osIcon = detectOsIcon();
  return _osIcon;
}

// ── Icons ──────────────────────────────────────────────────────────────

interface Icons {
  model: string; folder: string; branch: string;
  context: string; auto: string; sep: string;
}

const NERD: Icons = {
  model: "\uEC19", folder: "\uF115", branch: "\uF126",
  context: "OS",   auto: "\u{F0068}", sep: "\uE0B1",
};

const ASCII: Icons = {
  model: "◈", folder: "📁", branch: "⎇",
  context: "◫", auto: "⚡", sep: "|",
};

function icons(): Icons {
  const ic = hasNerdFonts() ? { ...NERD } : { ...ASCII };
  if (ic.context === "OS") ic.context = osIcon();
  return ic;
}

// ── Async Git Status ───────────────────────────────────────────────────
//
// Non-blocking git status with stale-while-revalidate caching.
// Renders return the last known value immediately while a background
// fetch refreshes the cache. File writes invalidate instantly.

interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}

const GIT_EMPTY: GitStatus = { branch: null, staged: 0, unstaged: 0, untracked: 0 };

let gitCache: { status: GitStatus; ts: number } | null = null;
let gitBranchCache: { branch: string | null; ts: number } | null = null;
let gitPending: Promise<void> | null = null;
let gitBranchPending: Promise<void> | null = null;
let gitGeneration = 0;     // bumped on invalidation to discard stale fetches
let branchGeneration = 0;

const STATUS_TTL = 1000;   // 1s for file status
const BRANCH_TTL = 500;    // 500ms for branch (shorter so switches show fast)

function runGit(args: string[], timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "", done = false;
    const finish = (r: string | null) => { if (done) return; done = true; clearTimeout(tid); resolve(r); };
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.on("close", (code) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", () => finish(null));
    const tid = setTimeout(() => { proc.kill(); finish(null); }, timeoutMs);
  });
}

function parseStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0], y = line[1];
    if (x === "?" && y === "?") { untracked++; continue; }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
}

async function fetchBranch(): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"]);
  if (branch === null) return null;
  if (branch) return branch;
  const sha = await runGit(["rev-parse", "--short", "HEAD"]);
  return sha ? `${sha} (detached)` : "detached";
}

function getCurrentBranch(providerBranch: string | null): string | null {
  const now = Date.now();
  if (gitBranchCache && now - gitBranchCache.ts < BRANCH_TTL) return gitBranchCache.branch;
  if (!gitBranchPending) {
    const gen = branchGeneration;
    gitBranchPending = fetchBranch().then((b) => {
      if (gen === branchGeneration) gitBranchCache = { branch: b, ts: Date.now() };
      gitBranchPending = null;
    });
  }
  return gitBranchCache?.branch ?? providerBranch;
}

function getGitStatus(providerBranch: string | null): GitStatus {
  const branch = getCurrentBranch(providerBranch);
  const now = Date.now();
  if (gitCache && now - gitCache.ts < STATUS_TTL) {
    return { ...gitCache.status, branch };
  }
  if (!gitPending) {
    const gen = gitGeneration;
    gitPending = runGit(["status", "--porcelain"], 500).then((output) => {
      if (gen === gitGeneration) {
        const s = output ? parseStatusOutput(output) : { staged: 0, unstaged: 0, untracked: 0 };
        gitCache = { status: { ...s, branch }, ts: Date.now() };
      }
      gitPending = null;
    });
  }
  if (gitCache) return { ...gitCache.status, branch };
  return { ...GIT_EMPTY, branch };
}

function invalidateGitStatus(): void { gitCache = null; gitGeneration++; }
function invalidateGitBranch(): void { gitBranchCache = null; branchGeneration++; }

// ── Async PR Reviews ───────────────────────────────────────────────────
//
// Non-blocking PR review count with long TTL caching.
// Queries the `gh` CLI for open PRs needing review, filters out:
//   - Draft PRs
//   - PRs authored by the current user
//   - PRs where the user already left APPROVED or CHANGES_REQUESTED
//     on the current head commit (stale reviews DO show up again)

interface PrReviewState {
  count: number;
  prs: Array<{ number: number; title: string; author: string; url: string }>;
}

const PR_EMPTY: PrReviewState = { count: 0, prs: [] };
const PR_TTL = 180_000; // 3 minutes

let prCache: { state: PrReviewState; ts: number; repoKey: string } | null = null;
let prPending: Promise<void> | null = null;
let prRepoInfo: { host: string; ownerRepo: string } | null = null;
let prRepoResolved = false;
let prLogin: string | null = null;

function runCmd(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "", done = false;
    const finish = (r: string | null) => { if (done) return; done = true; clearTimeout(tid); resolve(r); };
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d: Buffer) => { stdout += d; });
    proc.on("close", (code: number | null) => finish(code === 0 ? stdout.trim() : null));
    proc.on("error", () => finish(null));
    const tid = setTimeout(() => { proc.kill(); finish(null); }, timeoutMs);
  });
}

async function resolveRepoInfo(): Promise<{ host: string; ownerRepo: string } | null> {
  const remote = await runGit(["remote", "get-url", "origin"], 500);
  if (!remote) return null;

  let host: string, ownerRepo: string;

  // HTTPS: https://host/owner/repo.git
  const httpsMatch = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    host = httpsMatch[1];
    ownerRepo = httpsMatch[2];
  } else {
    // SSH: git@host:owner/repo.git
    const sshMatch = remote.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
    if (!sshMatch) return null;
    host = sshMatch[1];
    ownerRepo = sshMatch[2];
  }

  return { host, ownerRepo };
}

async function resolveGhLogin(host: string): Promise<string | null> {
  const hostArgs = host !== "github.com" ? ["--hostname", host] : [];
  return runCmd("gh", ["api", "user", ...hostArgs, "-q", ".login"]);
}

async function fetchPrReviews(): Promise<PrReviewState> {
  if (!prRepoInfo) {
    prRepoInfo = await resolveRepoInfo();
    prRepoResolved = true;
    if (!prRepoInfo) return PR_EMPTY;
  }

  const { host, ownerRepo } = prRepoInfo;
  const repoUrl = `https://${host}/${ownerRepo}`;

  if (!prLogin) {
    prLogin = await resolveGhLogin(host);
    if (!prLogin) return PR_EMPTY;
  }

  const json = await runCmd("gh", [
    "pr", "list",
    "-R", repoUrl,
    "--state", "open",
    "--json", "number,title,isDraft,author,headRefOid,reviews,url",
    "--limit", "100",
  ]);
  if (!json) return PR_EMPTY;

  try {
    const prs = JSON.parse(json) as Array<{
      number: number; title: string; isDraft: boolean;
      author: { login: string }; headRefOid: string;
      reviews: Array<{ author: { login: string }; state: string; commit: { oid: string } }>;
      url: string;
    }>;

    const login = prLogin!;
    const filtered = prs.filter(pr => {
      if (pr.isDraft) return false;
      if (pr.author.login === login) return false;
      // Check if I have a non-stale substantive review
      const hasReview = pr.reviews.some(r =>
        r.author.login === login &&
        (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") &&
        r.commit.oid === pr.headRefOid
      );
      return !hasReview;
    });

    return {
      count: filtered.length,
      prs: filtered.map(pr => ({
        number: pr.number,
        title: pr.title,
        author: pr.author.login,
        url: pr.url,
      })),
    };
  } catch {
    return PR_EMPTY;
  }
}

function getPrReviews(): PrReviewState {
  const now = Date.now();
  const repoKey = prRepoInfo ? `${prRepoInfo.host}/${prRepoInfo.ownerRepo}` : "";

  if (prCache && prCache.repoKey === repoKey && now - prCache.ts < PR_TTL) {
    return prCache.state;
  }

  if (!prPending) {
    prPending = fetchPrReviews().then((state) => {
      const key = prRepoInfo ? `${prRepoInfo.host}/${prRepoInfo.ownerRepo}` : "";
      prCache = { state, ts: Date.now(), repoKey: key };
      prPending = null;
    }).catch(() => { prPending = null; });
  }

  return prCache?.state ?? PR_EMPTY;
}

function invalidatePrReviews(): void {
  prCache = null;
  prRepoInfo = null;
  prRepoResolved = false;
}

// ── Formatting Helpers ─────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

// ── Segment Rendering ──────────────────────────────────────────────────
//
// Each segment is a pure function: (ctx) => string | null
// Returns null if nothing to show. All styling is done via theme.fg().

interface SegCtx {
  theme: Theme;
  model: any;
  thinkingLevel: string;
  git: GitStatus;
  prReviews: PrReviewState;
  contextPct: number;
  contextWindow: number;
  autoCompact: boolean;
  cost: number;
  usingSubscription: boolean;
  cacheRead: number;
  extensionStatuses: ReadonlyMap<string, string>;
}

type Segment = (ctx: SegCtx) => string | null;

const RAINBOW = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9"];

function hexAnsi(hex: string): string {
  const h = hex.replace("#", "");
  return `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`;
}

function rainbow(text: string): string {
  let r = "", ci = 0;
  for (const ch of text) {
    if (ch === " " || ch === ":") { r += ch; continue; }
    r += hexAnsi(RAINBOW[ci % RAINBOW.length]) + ch;
    ci++;
  }
  return r + "\x1b[0m";
}

// Hex color helpers (theme.fg() only accepts ThemeColor, not hex)
function hex(color: string, text: string): string {
  return `${hexAnsi(color)}${text}\x1b[39m`;
}

const MODEL_COLOR = "#d787af";  // Pink/mauve
const PATH_COLOR = "#00afaf";   // Teal/cyan

const segModel: Segment = ({ theme, model, thinkingLevel }) => {
  if (!model) return null;
  let name = model.name || model.id || "unknown";
  if (name.startsWith("Claude ")) name = name.slice(7);
  const ic = icons();
  let text = ic.model ? `${ic.model} ${name}` : name;

  // Show thinking level inline if model supports it
  if (model.reasoning && thinkingLevel !== "off") {
    const abbr: Record<string, string> = { minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi" };
    const label = abbr[thinkingLevel] || thinkingLevel;
    if (thinkingLevel === "high" || thinkingLevel === "xhigh") {
      return hex(MODEL_COLOR, text) + " " + rainbow(`[${label}]`);
    }
    text += ` [${label}]`;
  }
  return hex(MODEL_COLOR, text);
};

const segPath: Segment = () => {
  const ic = icons();
  const cwd = basename(process.cwd()) || process.cwd();
  return hex(PATH_COLOR, ic.folder ? `${ic.folder} ${cwd}` : cwd);
};

const segGit: Segment = ({ theme, git }) => {
  const { branch, staged, unstaged, untracked } = git;
  if (!branch) return null;
  const dirty = staged > 0 || unstaged > 0 || untracked > 0;
  const ic = icons();
  const branchColor = dirty ? "warning" : "success";
  let text = theme.fg(branchColor, ic.branch ? `${ic.branch} ${branch}` : branch);

  const parts: string[] = [];
  if (unstaged > 0) parts.push(theme.fg("warning", `*${unstaged}`));
  if (staged > 0) parts.push(theme.fg("success", `+${staged}`));
  if (untracked > 0) parts.push(theme.fg("muted", `?${untracked}`));
  if (parts.length > 0) text += " " + parts.join(" ");
  return text;
};

const PR_COLOR = "#b4befe"; // Lavender — stands out but not alarming
const PR_WARN_COLOR = "#e5a855"; // Amber for high counts

const segPrReviews: Segment = ({ prReviews }) => {
  if (prReviews.count === 0) return null;
  const icon = hasNerdFonts() ? "\uEB29" : "PR"; // nf-cod-git_pull_request
  const color = prReviews.count >= 5 ? PR_WARN_COLOR : PR_COLOR;
  return hex(color, `${icon} ${prReviews.count}`);
};

const segContext: Segment = ({ theme, contextPct, contextWindow, autoCompact }) => {
  const ic = icons();
  const autoStr = autoCompact && ic.auto ? ` ${ic.auto}` : "";
  const label = `${contextPct.toFixed(1)}%/${fmtTokens(contextWindow)}${autoStr}`;
  const color = contextPct > 90 ? "error" : contextPct > 70 ? "warning" : "dim";
  const inner = theme.fg(color, label);
  return ic.context ? `${ic.context} ${inner}` : inner;
};

const segCost: Segment = ({ theme, cost, usingSubscription }) => {
  if (!cost && !usingSubscription) return null;
  const text = usingSubscription ? "(sub)" : `$${cost.toFixed(2)}`;
  return theme.fg("text", text);
};

const segCacheRead: Segment = ({ theme, cacheRead }) => {
  if (!cacheRead) return null;
  return theme.fg("muted", `cache:${fmtTokens(cacheRead)}`);
};

let lastMessageTime: Date | null = null;

const segTimestamp: Segment = ({ theme }) => {
  if (!lastMessageTime) return null;
  const now = Date.now();
  const diffMs = now - lastMessageTime.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  // Format: "HH:MM (Xm ago)" or just "HH:MM (now)" if < 30s
  const hh = String(lastMessageTime.getHours()).padStart(2, "0");
  const mm = String(lastMessageTime.getMinutes()).padStart(2, "0");
  const timeStr = `${hh}:${mm}`;

  let ago: string;
  if (diffSec < 30) ago = "now";
  else if (diffMin < 1) ago = `${diffSec}s ago`;
  else if (diffHr < 1) ago = `${diffMin}m ago`;
  else ago = `${diffHr}h${diffMin % 60}m ago`;

  return theme.fg("dim", `${timeStr} (${ago})`);
};

const segExtStatuses: Segment = ({ extensionStatuses }) => {
  if (!extensionStatuses || extensionStatuses.size === 0) return null;
  const parts: string[] = [];
  for (const [key, value] of extensionStatuses.entries()) {
    if (key === "ghost-text") continue; // rendered as ghost text inside the editor
    if (!value || value.trimStart().startsWith("[")) continue; // skip notification-style
    const stripped = value.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
    if (visibleWidth(stripped) > 0) parts.push(stripped);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
};

// Ordered list of segments to render
const SEGMENTS: Segment[] = [segModel, segPath, segGit, segPrReviews, segContext, segCacheRead, segCost, segTimestamp, segExtStatuses];

// ── Status Line Assembly ───────────────────────────────────────────────

function buildStatusLine(ctx: SegCtx, maxWidth: number): string {
  const ic = icons();
  const sepChar = ic.sep;
  const sepAnsi = ctx.theme.fg("dim", ` ${sepChar} `);
  const sepWidth = visibleWidth(` ${sepChar} `);

  // Render all segments that have content
  const rendered: { text: string; width: number }[] = [];
  for (const seg of SEGMENTS) {
    const text = seg(ctx);
    if (text === null) continue;
    rendered.push({ text, width: visibleWidth(text) });
  }

  if (rendered.length === 0) return "";

  // Fit as many segments as possible into the available width (2 chars margin)
  const available = maxWidth - 2;
  const fitted: string[] = [];
  let usedWidth = 0;

  for (const { text, width } of rendered) {
    const needed = width + (fitted.length > 0 ? sepWidth : 0);
    if (usedWidth + needed > available) break;
    fitted.push(text);
    usedWidth += needed;
  }

  if (fitted.length === 0) return "";
  return " " + fitted.join(sepAnsi) + "\x1b[0m ";
}

// ── Extension ──────────────────────────────────────────────────────────

export default function statusline(pi: ExtensionAPI) {
  let enabled = true;
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let tuiRef: any = null;


  // ── Git branch change patterns ───────────────────────────────────

  const GIT_BRANCH_RE = [
    /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
    /\bgit\s+stash\s+(pop|apply)/,
  ];
  const mightChangeBranch = (cmd: string) => GIT_BRANCH_RE.some(r => r.test(cmd));

  // ── Build segment context from session state ─────────────────────

  function buildCtx(theme: Theme): SegCtx {
    const ctx = currentCtx;
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevel = "off";

    const events = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const e of events) {
      if (e.type === "thinking_level_change" && e.thinkingLevel) thinkingLevel = e.thinkingLevel;
      if (e.type === "message" && e.message?.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") continue;
        input += m.usage.input;
        output += m.usage.output;
        cacheRead += m.usage.cacheRead;
        cacheWrite += m.usage.cacheWrite;
        cost += m.usage.cost.total;
        lastAssistant = m;
      }
    }

    const ctxTokens = lastAssistant
      ? lastAssistant.usage.input + lastAssistant.usage.output + lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite
      : 0;
    const ctxWindow = ctx?.model?.contextWindow || 0;
    const ctxPct = ctxWindow > 0 ? (ctxTokens / ctxWindow) * 100 : 0;
    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const usingSubscription = ctx?.model ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false : false;

    // Use getThinkingLevel from ctx if available (more current than session entries)
    if (typeof ctx?.getThinkingLevel === "function") {
      const live = ctx.getThinkingLevel();
      if (live) thinkingLevel = live;
    }

    return {
      theme,
      model: ctx?.model,
      thinkingLevel,
      git: getGitStatus(gitBranch),
      prReviews: getPrReviews(),
      contextPct: ctxPct,
      contextWindow: ctxWindow,
      autoCompact: ctx?.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      cost,
      usingSubscription,
      cacheRead,
      extensionStatuses: footerDataRef?.getExtensionStatuses() ?? new Map(),
    };
  }

  // ── Custom editor with status in top border ──────────────────────

  function setupEditor(ctx: any): void {
    import("@mariozechner/pi-coding-agent").then(({ CustomEditor }) => {
      if (!enabled) return;

      const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        const originalRender = editor.render.bind(editor);

        editor.render = (width: number): string[] => {
          if (width < 10 || !currentCtx) return originalRender(width);

          const bc = (s: string) => `\x1b[38;5;244m${s}\x1b[0m`;
          const prompt = `\x1b[38;2;200;200;200m>\x1b[0m`;
          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);

          const lines = originalRender(contentWidth);
          if (lines.length === 0) return lines;

          // Find bottom border (the last line starting with ───)
          let bottomIdx = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (/^─{3,}/.test(stripped)) { bottomIdx = i; break; }
          }

          const result: string[] = [];

          // Status line (above top border)
          const segCtx = buildCtx(ctx.ui.theme);
          result.push(buildStatusLine(segCtx, width));

          // Top border
          result.push(" " + bc("─".repeat(width - 2)));

          // Ghost text: show suggestion when editor is empty
          const editorEmpty = editor.getText() === "";
          const ghostRaw = editorEmpty ? (segCtx.extensionStatuses?.get("ghost-text") ?? null) : null;
          let ghostLine: string | null = null;
          if (ghostRaw) {
            const firstLine = ghostRaw.split("\n")[0] + (ghostRaw.includes("\n") ? " …" : "");
            // Truncate to fit available width to prevent TUI overflow (gh: statusline#1)
            const truncated = truncateToWidth(firstLine, contentWidth, "…");
            ghostLine = `\x1b[38;5;242m${truncated}\x1b[0m`;
          }

          // Content lines with prompt prefix
          for (let i = 1; i < bottomIdx; i++) {
            result.push((i === 1 ? promptPrefix : contPrefix) + (i === 1 && ghostLine ? ghostLine : (lines[i] || "")));
          }
          if (bottomIdx === 1) {
            result.push(promptPrefix + (ghostLine ?? " ".repeat(contentWidth)));
          }

          // Bottom border
          result.push(" " + bc("─".repeat(width - 2)));

          // Autocomplete lines after bottom border
          for (let i = bottomIdx + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }

          return result;
        };

        return editor;
      };

      ctx.ui.setEditorComponent(editorFactory);

      // Capture footer data provider (for git branch + extension statuses)
      // We render an empty footer — all status is in the editor top border
      ctx.ui.setFooter((tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => {
        footerDataRef = footerData;
        tuiRef = tui;
        const unsub = footerData.onBranchChange(() => tui.requestRender());
        return {
          dispose: unsub,
          invalidate() {},
          render(): string[] { return []; },
        };
      });
    }).catch((err) => {
      console.debug("[statusline] Failed to setup custom editor:", err);
    });
  }

  function teardown(ctx: any): void {
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
    footerDataRef = null;
    tuiRef = null;
  }

  // ── Events ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    invalidatePrReviews();
    if (enabled && ctx.hasUI) setupEditor(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    currentCtx = ctx;
    invalidatePrReviews();
  });

  pi.on("agent_end", async () => {
    lastMessageTime = new Date();
    tuiRef?.requestRender();
  });

  // Invalidate git on file changes
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeBranch(cmd)) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => tuiRef?.requestRender(), 100);
      }
    }
  });

  pi.on("user_bash", async (event) => {
    if (mightChangeBranch(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => tuiRef?.requestRender(), 100);
      setTimeout(() => tuiRef?.requestRender(), 500);
    }
  });

  // ── Toggle command ─────────────────────────────────────────────────

  pi.registerCommand("statusline", {
    description: "Toggle the status line",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      currentCtx = ctx;
      if (enabled) {
        setupEditor(ctx);
        ctx.ui.notify("Statusline enabled", "info");
      } else {
        teardown(ctx);
        ctx.ui.notify("Statusline disabled", "info");
      }
    },
  });
}
