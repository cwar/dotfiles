/**
 * PR Queue Extension
 *
 * Shows PRs awaiting your review in the current repo and lets you launch
 * reviews via the pr-review skill.
 *
 * Commands:
 *   /prs              — Show PRs awaiting review (overlay picker)
 *   /prs all          — Review all PRs sequentially
 *   /prs refresh      — Force-refresh the cache
 *
 * Shortcut: Alt+R
 *
 * Integration:
 *   - Shares PR data with the statusline extension (segPrReviews reads the same cache)
 *   - Selecting a PR sends "review <url>" as a user message, triggering the pr-review skill
 *   - "review all" mode queues PRs and auto-sends the next one after each review completes
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";

interface SelectListThemeLike {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

interface PrSelectItem extends SelectItem {
  disabled?: boolean;
}

// ── Types ──────────────────────────────────────────────────────────

interface PrInfo {
  number: number;
  title: string;
  author: string;
  url: string;
}

interface PrReviewState {
  count: number;
  prs: PrInfo[];
}

interface RepoInfo {
  host: string;
  ownerRepo: string;
}

// ── State ──────────────────────────────────────────────────────────

const PR_EMPTY: PrReviewState = { count: 0, prs: [] };
const CACHE_TTL = 180_000; // 3 minutes

let cache: { state: PrReviewState; ts: number; repoKey: string } | null = null;
let pending: Promise<PrReviewState> | null = null;
let repoInfo: RepoInfo | null = null;
let ghLogin: string | null = null;

// Review-all queue
let reviewQueue: PrInfo[] = [];
let reviewingAll = false;

// ── Helpers ────────────────────────────────────────────────────────

function runCmd(cmd: string, args: string[], timeoutMs = 15_000): Promise<string | null> {
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

async function resolveRepoInfo(): Promise<RepoInfo | null> {
  const remote = await runCmd("git", ["remote", "get-url", "origin"], 2000);
  if (!remote) return null;

  const httpsMatch = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return { host: httpsMatch[1], ownerRepo: httpsMatch[2] };

  const sshMatch = remote.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return { host: sshMatch[1], ownerRepo: sshMatch[2] };

  return null;
}

async function resolveLogin(host: string): Promise<string | null> {
  const hostArgs = host !== "github.com" ? ["--hostname", host] : [];
  return runCmd("gh", ["api", "user", ...hostArgs, "-q", ".login"]);
}

async function fetchPrs(): Promise<PrReviewState> {
  if (!repoInfo) {
    repoInfo = await resolveRepoInfo();
    if (!repoInfo) return PR_EMPTY;
  }

  const { host, ownerRepo } = repoInfo;

  if (!ghLogin) {
    ghLogin = await resolveLogin(host);
    if (!ghLogin) return PR_EMPTY;
  }

  const repoUrl = `https://${host}/${ownerRepo}`;
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

    const login = ghLogin!;
    const filtered = prs.filter(pr => {
      if (pr.isDraft) return false;
      if (pr.author.login === login) return false;
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

async function getPrs(forceRefresh = false): Promise<PrReviewState> {
  const repoKey = repoInfo ? `${repoInfo.host}/${repoInfo.ownerRepo}` : "";
  const now = Date.now();

  if (!forceRefresh && cache && cache.repoKey === repoKey && now - cache.ts < CACHE_TTL) {
    return cache.state;
  }

  if (pending) return pending;

  pending = fetchPrs().then((state) => {
    const key = repoInfo ? `${repoInfo.host}/${repoInfo.ownerRepo}` : "";
    cache = { state, ts: Date.now(), repoKey: key };
    pending = null;
    return state;
  }).catch(() => {
    pending = null;
    return PR_EMPTY;
  });

  return pending;
}

// ── Overlay UI ─────────────────────────────────────────────────────

function identity(text: string): string {
  return text;
}

function resolveThemeFn(theme: any, candidates: string[]): (text: string) => string {
  for (const key of candidates) {
    if (typeof theme?.[key] === "function") return theme[key].bind(theme);
  }
  return identity;
}

function normalizeSelectListTheme(theme: any): SelectListThemeLike {
  return {
    selectedPrefix: resolveThemeFn(theme, ["selectedPrefix", "selectedText", "primary", "accent"]),
    selectedText: resolveThemeFn(theme, ["selectedText", "selected", "primary", "accent"]),
    description: resolveThemeFn(theme, ["description", "muted", "dim", "secondaryText", "subtle"]),
    scrollInfo: resolveThemeFn(theme, ["scrollInfo", "muted", "dim", "secondaryText", "subtle"]),
    noMatch: resolveThemeFn(theme, ["noMatch", "muted", "dim", "secondaryText", "subtle"]),
  };
}

function isSelectableItem(item: SelectItem | null | undefined): boolean {
  return !!item && !(item as PrSelectItem).disabled;
}

function findFirstSelectableIndex(items: SelectItem[]): number {
  return items.findIndex(isSelectableItem);
}

function moveSelectionToNearestSelectable(selectList: any, direction: 1 | -1): void {
  const items = (selectList as any).filteredItems as SelectItem[] | undefined;
  if (!items || items.length === 0) return;

  let index = typeof (selectList as any).selectedIndex === "number" ? (selectList as any).selectedIndex : 0;
  for (let attempts = 0; attempts < items.length; attempts++) {
    const item = items[index];
    if (isSelectableItem(item)) {
      selectList.setSelectedIndex(index);
      return;
    }
    index = (index + direction + items.length) % items.length;
  }
}

function buildItems(prs: PrInfo[]): PrSelectItem[] {
  if (prs.length === 0) {
    return [{
      label: "  ✅ No PRs awaiting review",
      value: "empty",
      disabled: true,
    }];
  }

  const items: PrSelectItem[] = [];

  // Header
  const repo = repoInfo ? repoInfo.ownerRepo : "this repo";
  items.push({
    label: `  󰊤 ${prs.length} PR${prs.length !== 1 ? "s" : ""} awaiting review in ${repo}`,
    value: "header",
    disabled: true,
  });
  items.push({ label: "", value: "sep", disabled: true });

  // PR entries
  for (const pr of prs) {
    const maxTitleLen = 60;
    const title = pr.title.length > maxTitleLen
      ? pr.title.slice(0, maxTitleLen - 1) + "…"
      : pr.title;
    items.push({
      label: `  #${pr.number}  ${title}  \x1b[38;5;242m(${pr.author})\x1b[0m`,
      value: String(pr.number),
    });
  }

  // Footer actions
  if (prs.length > 1) {
    items.push({ label: "", value: "sep2", disabled: true });
    items.push({
      label: `  \x1b[38;5;117m⚡ Review all ${prs.length} PRs sequentially\x1b[0m`,
      value: "review-all",
    });
  }

  return items;
}

// ── Extension ──────────────────────────────────────────────────────

export default function prQueue(pi: ExtensionAPI) {

  function launchReview(pr: PrInfo, ctx: any): void {
    const prompt = `review ${pr.url}`;
    try {
      // sendUserMessage throws if the agent is streaming and no deliverAs
      // is passed — so pick the right mode based on idleness.
      if (ctx.isIdle && ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
      ctx.ui.notify(`Launching review: PR #${pr.number}`, "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to launch review: ${msg}`, "warning");
      // Fallback: at least populate the editor so the user can submit manually
      ctx.ui.setEditorText(prompt);
    }
  }

  function advanceQueue(ctx: any): void {
    if (!reviewingAll || reviewQueue.length === 0) {
      if (reviewingAll) {
        reviewingAll = false;
        ctx.ui.notify("✅ All PR reviews complete!", "info");
        // Clear the status indicator
        ctx.ui.setStatus("pr-queue", "");
      }
      return;
    }

    const next = reviewQueue.shift()!;
    const remaining = reviewQueue.length;
    const status = remaining > 0
      ? `📋 reviewing ${next.number} (${remaining} left)`
      : `📋 reviewing #${next.number} (last one)`;
    ctx.ui.setStatus("pr-queue", status);
    launchReview(next, ctx);
  }

  async function showPrPicker(ctx: any): Promise<void> {
    ctx.ui.notify("Fetching PRs…", "info");
    const state = await getPrs();

    const result = await ctx.ui.custom<string | null>(
      (tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
        const items = buildItems(state.prs);
        const visibleCount = Math.min(items.length, 15);
        const selectList = new SelectList(items, visibleCount, normalizeSelectListTheme(theme));

        const firstSelectableIndex = findFirstSelectableIndex(items);
        if (firstSelectableIndex >= 0) {
          selectList.setSelectedIndex(firstSelectableIndex);
        }

        selectList.onCancel = () => done(null);
        selectList.onSelect = (item) => {
          const selected = item as PrSelectItem;
          if (!isSelectableItem(selected)) return;
          done(selected.value);
        };

        return {
          render(width: number): string[] {
            return selectList.render(width);
          },
          handleInput(key: any): void {
            if (key.name === "o") {
              const selected = selectList.getSelectedItem() as PrSelectItem | null;
              if (isSelectableItem(selected)) {
                const pr = state.prs.find(p => String(p.number) === selected.value);
                if (pr) {
                  spawn("xdg-open", [pr.url], { detached: true, stdio: "ignore" }).unref();
                  ctx.ui.notify(`Opened PR #${pr.number} in browser`, "info");
                }
              }
              tui.requestRender();
              return;
            }

            const isUp = key.name === "up" || key.name === "k" || (key.ctrl && key.name === "p");
            const isDown = key.name === "down" || key.name === "j" || (key.ctrl && key.name === "n");

            selectList.handleInput(key);

            if (isUp) moveSelectionToNearestSelectable(selectList, -1);
            if (isDown) moveSelectionToNearestSelectable(selectList, 1);
            tui.requestRender();
          },
          invalidate(): void {
            selectList.invalidate();
          },
          dispose() {},
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({
          anchor: "center" as const,
          width: "70%" as const,
          maxHeight: "60%" as const,
        }),
      },
    );

    if (result === "review-all") {
      reviewQueue = [...state.prs];
      reviewingAll = true;
    } else if (result) {
      const pr = state.prs.find(p => String(p.number) === result);
      if (pr) {
        reviewQueue = [pr];
        reviewingAll = false;
      }
    }

    // After overlay closes, check if we queued anything
    if (reviewQueue.length > 0) {
      if (reviewingAll) {
        const count = reviewQueue.length;
        ctx.ui.notify(`Starting review of ${count} PR${count !== 1 ? "s" : ""}…`, "info");
      }
      advanceQueue(ctx);
    }
  }

  // ── Commands ─────────────────────────────────────────────────────

  pi.registerCommand("prs", {
    description: "Show PRs awaiting your review",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      if (arg === "refresh") {
        cache = null;
        repoInfo = null;
        ghLogin = null;
        ctx.ui.notify("PR cache cleared", "info");
        await showPrPicker(ctx);
        return;
      }

      if (arg === "all") {
        ctx.ui.notify("Fetching PRs…", "info");
        const state = await getPrs();
        if (state.prs.length === 0) {
          ctx.ui.notify("✅ No PRs awaiting review", "info");
          return;
        }
        reviewQueue = [...state.prs];
        reviewingAll = true;
        ctx.ui.notify(`Starting review of ${state.prs.length} PR${state.prs.length !== 1 ? "s" : ""}…`, "info");
        advanceQueue(ctx);
        return;
      }

      await showPrPicker(ctx);
    },
  });

  // ── Keyboard shortcut ────────────────────────────────────────────

  pi.registerShortcut("alt+r", async (ctx) => {
    await showPrPicker(ctx);
  });

  // ── Manual advance for review-all mode ───────────────────────────
  //
  // PR reviews are multi-turn (evidence gathering, HTML generation,
  // reviewer feedback loops). We can't auto-advance on agent_end.
  // Instead, use /prs next to move to the next PR.

  pi.registerCommand("prs-next", {
    description: "Advance to the next PR in the review queue",
    handler: async (_args, ctx) => {
      if (!reviewingAll || reviewQueue.length === 0) {
        reviewingAll = false;
        ctx.ui.setStatus("pr-queue", "");
        ctx.ui.notify("No more PRs in queue", "info");
        return;
      }
      advanceQueue(ctx);
    },
  });

  // ── Remind user about queue after each review turn ─────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (reviewingAll && reviewQueue.length > 0) {
      const n = reviewQueue.length;
      ctx.ui.setStatus("pr-queue", `📋 ${n} PR${n !== 1 ? "s" : ""} left — /prs-next`);
    }
  });

  // ── Session lifecycle ────────────────────────────────────────────

  pi.on("session_start", async () => {
    // Reset repo info for new session (might be different cwd)
    repoInfo = null;
    ghLogin = null;
    cache = null;
    reviewQueue = [];
    reviewingAll = false;
  });
}
