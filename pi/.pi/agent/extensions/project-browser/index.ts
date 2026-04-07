/**
 * Project Browser — Discover and navigate your local projects.
 *
 * Scans multiple locations to find projects you've worked on:
 *   - Git repos in ~/code/ (recursive)
 *   - Experiments in ~/Work/tries/
 *   - Pi extensions in ~/.pi/agent/extensions/
 *   - Claude skills in ~/.claude/skills/
 *   - Standalone repos (~/dotfiles, etc.)
 *
 * For each project, shows:
 *   - Name, path, and category (repo, extension, skill, experiment)
 *   - Git status: branch, dirty file count, remote
 *   - Pi session count (how many sessions you've run there)
 *   - Primary language/tech and last modified date
 *
 * Commands:
 *   /projects           — Open the project browser
 *   /projects <query>   — Open browser pre-filtered by query
 *
 * Shortcut: Alt+P — Quick-open the project browser
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────

type ProjectCategory = "repo" | "extension" | "skill" | "experiment" | "config" | "script";

interface Project {
	name: string;
	path: string;
	category: ProjectCategory;
	git?: {
		branch: string;
		dirty: number;
		ahead: number; // commits ahead of upstream (0 = in sync)
		remote?: string;
		lastCommit?: string; // ISO date
	};
	sessions: number;
	language?: string;
	lastModified?: string; // ISO date
	description?: string;
}

// ── Config ─────────────────────────────────────────────────────────

const HOME = homedir();
const PI_SESSIONS_DIR = join(HOME, ".pi", "agent", "sessions");
const PI_EXTENSIONS_DIR = join(HOME, ".pi", "agent", "extensions");
const SKILLS_DIR = join(HOME, ".claude", "skills");

/** Directories to scan for git repos (recursive to depth). */
const REPO_SCAN_DIRS: Array<{ dir: string; maxDepth: number }> = [
	{ dir: join(HOME, "code"), maxDepth: 3 },
	{ dir: join(HOME, "projects"), maxDepth: 2 },
];

/** Standalone repos to always check. */
const STANDALONE_REPOS = [
	join(HOME, "dotfiles"),
	join(HOME, "pi-hcl-syntax"),
];

const TRIES_DIR = join(HOME, "Work", "tries");

// ── Category badges & colors ───────────────────────────────────────

const CATEGORY_BADGE: Record<ProjectCategory, string> = {
	repo: "repo",
	extension: "ext",
	skill: "skill",
	experiment: "try",
	config: "cfg",
	script: "bin",
};

const CATEGORY_ANSI: Record<ProjectCategory, string> = {
	repo: "\x1b[38;5;75m",      // blue
	extension: "\x1b[38;5;213m", // pink
	skill: "\x1b[38;5;114m",    // green
	experiment: "\x1b[38;5;222m", // yellow
	config: "\x1b[38;5;246m",   // gray
	script: "\x1b[38;5;180m",   // tan/orange
};

// ── Discovery ──────────────────────────────────────────────────────

/** Run a git command in a directory with timeout. */
function gitCmd(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
		const timer = setTimeout(() => {
			proc.kill();
			resolve("");
		}, 3000);
		proc.on("close", () => {
			clearTimeout(timer);
			resolve(out.trim());
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
	});
}

/** Get git metadata for a directory. */
async function getGitInfo(dir: string): Promise<Project["git"]> {
	if (!existsSync(join(dir, ".git"))) return undefined;

	const [branch, dirtyRaw, remote, logDate, aheadRaw] = await Promise.all([
		gitCmd(dir, ["branch", "--show-current"]),
		gitCmd(dir, ["status", "--porcelain"]),
		gitCmd(dir, ["remote", "get-url", "origin"]).catch(() => ""),
		gitCmd(dir, ["log", "-1", "--format=%cI"]).catch(() => ""),
		// Count local commits not on upstream. Errors (no upstream) → treat as local work.
		gitCmd(dir, ["rev-list", "--count", "@{u}..HEAD"]).catch(() => ""),
	]);

	const dirty = dirtyRaw ? dirtyRaw.split("\n").filter(Boolean).length : 0;
	// If rev-list failed (no upstream tracking branch), assume local work
	const ahead = aheadRaw === "" ? 1 : parseInt(aheadRaw, 10) || 0;

	return {
		branch: branch || "(detached)",
		dirty,
		ahead,
		remote: remote || undefined,
		lastCommit: logDate || undefined,
	};
}

/** Encode a CWD path to the session directory name, matching pi's encoding. */
function encodeSessionDir(cwd: string): string {
	return `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`;
}

/** Count pi sessions for a given project path. */
function getSessionCount(projectPath: string): number {
	const encoded = encodeSessionDir(projectPath);
	const sessionDir = join(PI_SESSIONS_DIR, encoded);
	try {
		if (!existsSync(sessionDir)) return 0;
		const files = readdirSync(sessionDir);
		return files.filter((f: string) => f.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

/** Detect primary language from file extensions. */
async function detectLanguage(dir: string): Promise<string | undefined> {
	const langMap: Record<string, string> = {
		".ts": "TypeScript",
		".tsx": "TypeScript",
		".js": "JavaScript",
		".py": "Python",
		".java": "Java",
		".go": "Go",
		".rs": "Rust",
		".tf": "Terraform",
		".hcl": "HCL",
		".md": "Markdown",
		".sh": "Shell",
	};

	const counts: Record<string, number> = {};

	try {
		const entries = await readdir(dir, { withFileTypes: true, recursive: false });
		// Check top-level + one level deep for speed
		const toScan = [...entries];

		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
				try {
					const sub = await readdir(join(dir, entry.name), { withFileTypes: true, recursive: false });
					toScan.push(...sub);
				} catch { /* skip unreadable */ }
			}
		}

		for (const entry of toScan) {
			if (!entry.isFile()) continue;
			const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop() : "";
			const lang = langMap[ext];
			if (lang) counts[lang] = (counts[lang] || 0) + 1;
		}
	} catch { /* skip unreadable dirs */ }

	const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	return sorted[0]?.[0];
}

/** Get the last modification time of a directory (best effort). */
async function getLastModified(dir: string): Promise<string | undefined> {
	try {
		const s = await stat(dir);
		return s.mtime.toISOString();
	} catch {
		return undefined;
	}
}

/** Discover git repos in a scan directory. */
async function discoverRepos(scanDir: string, maxDepth: number): Promise<Project[]> {
	const projects: Project[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;
		try {
			const entries = await readdir(dir, { withFileTypes: true });

			if (entries.some((e) => e.name === ".git" && e.isDirectory())) {
				const [git, lang, modified] = await Promise.all([
					getGitInfo(dir),
					detectLanguage(dir),
					getLastModified(dir),
				]);

				projects.push({
					name: basename(dir),
					path: dir,
					category: "repo",
					git,
					sessions: getSessionCount(dir),
					language: lang,
					lastModified: modified,
					description: shortRemote(git?.remote),
				});
				return; // Don't recurse into git repos
			}

			// Recurse into subdirectories
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
				await walk(join(dir, entry.name), depth + 1);
			}
		} catch { /* skip unreadable dirs */ }
	}

	if (existsSync(scanDir)) await walk(scanDir, 1);
	return projects;
}

/** Discover pi extensions. */
async function discoverExtensions(): Promise<Project[]> {
	const projects: Project[] = [];

	try {
		const entries = await readdir(PI_EXTENSIONS_DIR, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(PI_EXTENSIONS_DIR, entry.name);

			if (entry.isDirectory()) {
				const indexPath = join(fullPath, "index.ts");
				if (existsSync(indexPath)) {
					const [modified, lines] = await Promise.all([
						getLastModified(indexPath),
						countLines(indexPath),
					]);

					projects.push({
						name: entry.name,
						path: fullPath,
						category: "extension",
						sessions: getSessionCount(fullPath),
						language: "TypeScript",
						lastModified: modified,
						description: `${lines}L`,
					});
				}
			} else if (entry.name.endsWith(".ts")) {
				const [modified, lines] = await Promise.all([
					getLastModified(fullPath),
					countLines(fullPath),
				]);

				projects.push({
					name: entry.name.replace(/\.ts$/, ""),
					path: fullPath,
					category: "extension",
					sessions: 0,
					language: "TypeScript",
					lastModified: modified,
					description: `${lines}L`,
				});
			}
		}
	} catch { /* skip if not found */ }

	return projects;
}

/** Discover claude skills. */
async function discoverSkills(): Promise<Project[]> {
	const projects: Project[] = [];

	try {
		const entries = await readdir(SKILLS_DIR, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const fullPath = join(SKILLS_DIR, entry.name);
			const skillFile = join(fullPath, "SKILL.md");

			if (existsSync(skillFile)) {
				const [modified, git] = await Promise.all([
					getLastModified(fullPath),
					getGitInfo(fullPath),
				]);

				// Try to read first line of SKILL.md for description
				let desc: string | undefined;
				try {
					const content = await readFile(skillFile, "utf-8");
					const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#"));
					if (firstLine) desc = firstLine.trim().slice(0, 80);
				} catch { /* skip */ }

				projects.push({
					name: entry.name,
					path: fullPath,
					category: "skill",
					git,
					sessions: getSessionCount(fullPath),
					language: "Markdown",
					lastModified: modified,
					description: desc,
				});
			}
		}
	} catch { /* skip if not found */ }

	return projects;
}

/** Discover experiment/try projects. */
async function discoverExperiments(): Promise<Project[]> {
	const projects: Project[] = [];

	try {
		if (!existsSync(TRIES_DIR)) return projects;

		const entries = await readdir(TRIES_DIR, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const fullPath = join(TRIES_DIR, entry.name);

			const [git, lang, modified] = await Promise.all([
				getGitInfo(fullPath),
				detectLanguage(fullPath),
				getLastModified(fullPath),
			]);

			// Parse date from folder name (YYYY-MM-DD-name)
			const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
			const name = dateMatch ? dateMatch[2] : entry.name;

			projects.push({
				name,
				path: fullPath,
				category: "experiment",
				git,
				sessions: getSessionCount(fullPath),
				language: lang,
				lastModified: modified,
				description: dateMatch ? dateMatch[1] : undefined,
			});
		}
	} catch { /* skip if not found */ }

	return projects;
}

/** Discover non-git project directories in ~/code/ (like gizz-tapes). */
async function discoverNonGitDirs(): Promise<Project[]> {
	const projects: Project[] = [];
	const codeDir = join(HOME, "code");

	try {
		if (!existsSync(codeDir)) return projects;
		const entries = await readdir(codeDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const fullPath = join(codeDir, entry.name);

			// Skip if it has .git — discoverRepos already handles those
			if (existsSync(join(fullPath, ".git"))) continue;

			// Must have actual code files (not just empty dirs or subdirectory containers like ~/code/spotify/)
			const files = await readdir(fullPath, { withFileTypes: true });
			const codeFiles = files.filter((f) => f.isFile() && !f.name.startsWith(".") && f.name !== "README.md");
			const srcDirs = files.filter((f) => f.isDirectory() && ["bin", "lib", "src", "cmd"].includes(f.name));

			// Skip if it's just a container for other git repos (like ~/code/spotify/)
			const subDirsWithGit = files.filter((f) => f.isDirectory() && existsSync(join(fullPath, f.name, ".git")));
			if (subDirsWithGit.length > 0 && codeFiles.length === 0 && srcDirs.length === 0) continue;

			// Must have some real content
			if (codeFiles.length === 0 && srcDirs.length === 0) continue;

			const [lang, modified] = await Promise.all([
				detectLanguage(fullPath),
				getLastModified(fullPath),
			]);

			projects.push({
				name: entry.name,
				path: fullPath,
				category: "repo", // show as repo — it lives in ~/code/
				sessions: getSessionCount(fullPath),
				language: lang,
				lastModified: modified,
				description: "no git",
			});
		}
	} catch { /* skip */ }

	return projects;
}

/** Minimum size (bytes) for a script in ~/.local/bin to be considered a "project". */
const MIN_SCRIPT_SIZE = 2000;

/** Discover substantial standalone scripts in ~/.local/bin/. */
async function discoverScripts(): Promise<Project[]> {
	const projects: Project[] = [];
	const binDir = join(HOME, ".local", "bin");

	try {
		if (!existsSync(binDir)) return projects;
		const entries = await readdir(binDir, { withFileTypes: true });

		for (const entry of entries) {
			// Only regular files, not symlinks (those point to real projects)
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".node") || entry.name.endsWith(".bak")) continue;
			if (entry.name.startsWith(".") || entry.name.includes("__pycache__")) continue;

			const fullPath = join(binDir, entry.name);
			const s = await stat(fullPath).catch(() => null);
			if (!s || s.size < MIN_SCRIPT_SIZE) continue;

			// Skip giant binaries (>1MB is likely a compiled binary, not a script)
			if (s.size > 1_000_000) continue;

			// Detect language from shebang
			let lang: string | undefined;
			try {
				const head = await readFile(fullPath, { encoding: "utf-8", flag: "r" });
				const firstLine = head.slice(0, 200).split("\n")[0];
				if (firstLine.includes("python")) lang = "Python";
				else if (firstLine.includes("bash") || firstLine.includes("/sh")) lang = "Shell";
				else if (firstLine.includes("node")) lang = "JavaScript";
				else if (firstLine.includes("ruby")) lang = "Ruby";
				else if (firstLine.includes("perl")) lang = "Perl";
			} catch { /* binary or unreadable */ }

			if (!lang) continue; // Skip if we can't detect — probably a binary

			projects.push({
				name: entry.name,
				path: fullPath,
				category: "script",
				sessions: 0,
				language: lang,
				lastModified: s.mtime.toISOString(),
				description: `${Math.round(s.size / 1024)}KB`,
			});
		}
	} catch { /* skip */ }

	return projects;
}

/** Discover standalone repos. */
async function discoverStandalone(): Promise<Project[]> {
	const projects: Project[] = [];

	for (const dir of STANDALONE_REPOS) {
		if (!existsSync(dir)) continue;

		const [git, lang, modified] = await Promise.all([
			getGitInfo(dir),
			detectLanguage(dir),
			getLastModified(dir),
		]);

		projects.push({
			name: basename(dir),
			path: dir,
			category: "config",
			git,
			sessions: getSessionCount(dir),
			language: lang,
			lastModified: modified,
			description: shortRemote(git?.remote),
		});
	}

	return projects;
}

/** Check whether a project has any local work (dirty files OR unpushed commits). */
function hasLocalWork(p: Project): boolean {
	if (!p.git) return true; // non-git projects always count
	if (p.sessions > 0) return true; // pi sessions = you worked on it
	return p.git.dirty > 0 || p.git.ahead > 0;
}

/** Categories that are always shown regardless of git status. */
const ALWAYS_SHOW: Set<ProjectCategory> = new Set(["extension", "skill", "config", "script"]);

/** Run all discovery in parallel. */
async function discoverAll(): Promise<Project[]> {
	const results = await Promise.all([
		...REPO_SCAN_DIRS.map((s) => discoverRepos(s.dir, s.maxDepth)),
		discoverExtensions(),
		discoverSkills(),
		discoverExperiments(),
		discoverStandalone(),
		discoverNonGitDirs(),
		discoverScripts(),
	]);

	const all = results.flat();

	// Deduplicate by path
	const seen = new Set<string>();
	const deduped: Project[] = [];
	for (const p of all) {
		if (seen.has(p.path)) continue;
		seen.add(p.path);
		deduped.push(p);
	}

	// Filter out untouched clones in repo/experiment categories.
	// If a repo in ~/code/ or ~/Work/tries/ has no dirty files AND no
	// unpushed commits, it's just a clone sitting there — skip it.
	const filtered = deduped.filter((p) => {
		if (ALWAYS_SHOW.has(p.category)) return true;
		return hasLocalWork(p);
	});

	// Filter out markdown-only projects that aren't skills.
	// Skills are explicitly markdown and that's fine — but a random
	// directory whose only detected language is Markdown is just docs.
	const meaningful = filtered.filter((p) => {
		if (p.category === "skill") return true;
		if (p.language === "Markdown" && !p.git && p.sessions === 0) return false;
		return true;
	});

	// Sort: by category order, then by last modified (newest first)
	const catOrder: ProjectCategory[] = ["repo", "extension", "skill", "experiment", "config", "script"];
	meaningful.sort((a, b) => {
		const ca = catOrder.indexOf(a.category);
		const cb = catOrder.indexOf(b.category);
		if (ca !== cb) return ca - cb;
		// Within category: most sessions first, then newest
		if (a.sessions !== b.sessions) return b.sessions - a.sessions;
		const da = a.lastModified || a.git?.lastCommit || "";
		const db = b.lastModified || b.git?.lastCommit || "";
		return db.localeCompare(da);
	});

	return meaningful;
}

// ── Helpers ────────────────────────────────────────────────────────

function shortRemote(remote?: string): string | undefined {
	if (!remote) return undefined;
	// git@ghe.spotify.net:holocron/archdruid.git → holocron/archdruid
	// https://spotify.ghe.com/data/data.git → data/data
	return remote
		.replace(/\.git$/, "")
		.replace(/^git@[^:]+:/, "")
		.replace(/^https?:\/\/[^/]+\//, "");
}

async function countLines(filePath: string): Promise<number> {
	try {
		const content = await readFile(filePath, "utf-8");
		return content.split("\n").length;
	} catch {
		return 0;
	}
}

function shortPath(fullPath: string): string {
	if (fullPath.startsWith(HOME)) {
		return "~" + fullPath.slice(HOME.length);
	}
	return fullPath;
}

function relativeDate(isoDate?: string): string {
	if (!isoDate) return "";
	const diff = Date.now() - new Date(isoDate).getTime();
	const days = Math.floor(diff / 86400000);
	if (days === 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

/** Copy text to system clipboard. */
function copyToClipboard(text: string): Promise<void> {
	return new Promise((resolve) => {
		// Try wl-copy (Wayland), then xclip, then pbcopy (macOS)
		const cmds = [
			["wl-copy", [text]],
			["xclip", ["-selection", "clipboard"]],
		];

		function tryNext(i: number): void {
			if (i >= cmds.length) {
				resolve();
				return;
			}

			const [cmd, args] = cmds[i] as [string, string[]];
			const proc = spawn(cmd, cmd === "wl-copy" ? [] : args, {
				stdio: cmd === "wl-copy" ? ["pipe", "ignore", "ignore"] : ["pipe", "ignore", "ignore"],
			});

			if (cmd === "wl-copy") {
				proc.stdin!.write(text);
				proc.stdin!.end();
			} else {
				proc.stdin!.write(text);
				proc.stdin!.end();
			}

			proc.on("close", (code) => {
				if (code === 0) resolve();
				else tryNext(i + 1);
			});

			proc.on("error", () => tryNext(i + 1));
		}

		tryNext(0);
	});
}

// ── UI ─────────────────────────────────────────────────────────────

function renderProjectBrowser(
	projects: Project[],
	ctx: ExtensionCommandContext,
	initialFilter?: string,
): Promise<string | null> {
	const RST = "\x1b[0m";
	const DIM = "\x1b[38;5;242m";
	const BOLD = "\x1b[1m";
	const WHITE = "\x1b[38;5;255m";
	const YELLOW = "\x1b[38;5;222m";
	const CYAN = "\x1b[38;5;117m";

	return ctx.ui.custom(
		(tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
			let filterText = initialFilter || "";
			let cursorVisible = true;
			let cursorTimer: ReturnType<typeof setInterval>;

			function getFiltered(): Project[] {
				if (!filterText) return projects;
				const q = filterText.toLowerCase();
				return projects.filter(
					(p) =>
						p.name.toLowerCase().includes(q) ||
						p.category.includes(q) ||
						p.language?.toLowerCase().includes(q) ||
						p.path.toLowerCase().includes(q) ||
						p.description?.toLowerCase().includes(q),
				);
			}

			let filtered = getFiltered();

			const listTheme = {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			};

			let selectList = new SelectList(
				filtered.map((p) => toSelectItem(p)),
				Math.min(filtered.length, 18),
				listTheme,
			);

			selectList.onSelect = (item) => done(`select:${item.value}`);
			selectList.onCancel = () => done(null);

			function toSelectItem(p: Project): SelectItem {
				return {
					value: p.path,
					label: formatProjectLabel(p),
					description: formatProjectDescription(p),
				};
			}

			function formatProjectLabel(p: Project): string {
				const catColor = CATEGORY_ANSI[p.category];
				const badge = `${catColor}[${CATEGORY_BADGE[p.category]}]${RST}`;
				const nameStr = `${WHITE}${BOLD}${p.name}${RST}`;

				const parts = [badge, nameStr];

				// Git status
				if (p.git) {
					const branchStr = `${DIM}${p.git.branch}${RST}`;
					parts.push(branchStr);
					if (p.git.dirty > 0) {
						parts.push(`${YELLOW}±${p.git.dirty}${RST}`);
					}
					if (p.git.ahead > 0) {
						parts.push(`${CYAN}↑${p.git.ahead}${RST}`);
					}
				}

				// Sessions
				if (p.sessions > 0) {
					parts.push(`${CYAN}${p.sessions}s${RST}`);
				}

				return parts.join(" ");
			}

			function formatProjectDescription(p: Project): string {
				const parts: string[] = [];

				// Path (shortened)
				parts.push(shortPath(p.path));

				// Language
				if (p.language) parts.push(p.language);

				// Last modified
				const date = p.lastModified || p.git?.lastCommit;
				if (date) parts.push(relativeDate(date));

				return parts.join(" · ");
			}

			function rebuildList(): void {
				filtered = getFiltered();
				const items = filtered.map((p) => toSelectItem(p));
				selectList = new SelectList(items, Math.min(items.length, 18), listTheme);
				selectList.onSelect = (item) => done(`select:${item.value}`);
				selectList.onCancel = () => done(null);
			}

			// Cursor blink
			cursorTimer = setInterval(() => {
				cursorVisible = !cursorVisible;
				tui.requestRender();
			}, 530);

			const border = (t: string) => theme.fg("dim", t);
			const wrap = (t: string, w: number) =>
				`${border("│")} ${truncateToWidth(t, Math.max(1, w - 2), "…", true)} ${border("│")}`;
			const wrapFull = (t: string, w: number) =>
				`${border("│")}${truncateToWidth(t, w, "…", true)}${border("│")}`;

			return {
				render: (width: number) => {
					const iw = Math.max(1, width - 2);
					const lines: string[] = [];

					// Top border
					lines.push(border(`╭${"─".repeat(iw)}╮`));

					// Title
					const title = `${WHITE}${BOLD}Projects${RST} ${DIM}(${projects.length})${RST}`;
					lines.push(wrapFull(` ${title}`, iw));

					// Filter input
					const cursor = cursorVisible ? "▌" : " ";
					const filterLine = filterText
						? `${DIM}/${RST} ${WHITE}${filterText}${RST}${DIM}${cursor}${RST}`
						: `${DIM}/ type to filter${cursor}${RST}`;
					lines.push(wrapFull(` ${filterLine}`, iw));

					// Separator
					lines.push(border(`├${"─".repeat(iw)}┤`));

					// Project list
					const listLines = selectList.render(Math.max(1, iw - 2));
					for (const line of listLines) {
						lines.push(wrap(line, iw));
					}

					// Bottom help
					lines.push(border(`├${"─".repeat(iw)}┤`));
					const help = `${DIM}enter${RST} open  ${DIM}c${RST} copy path  ${DIM}t${RST} terminal  ${DIM}esc${RST} close`;
					lines.push(wrapFull(` ${help}`, iw));
					lines.push(border(`╰${"─".repeat(iw)}╯`));

					return lines;
				},
				invalidate: () => selectList.invalidate(),
				handleInput: (data: string) => {
					// 'c' — copy path (only when not typing in filter)
					if (data === "c" && !filterText) {
						const sel = selectList.getSelectedItem();
						if (sel) {
							done(`copy:${sel.value}`);
							return;
						}
					}

					// 't' — open terminal (only when not typing in filter)
					if (data === "t" && !filterText) {
						const sel = selectList.getSelectedItem();
						if (sel) {
							done(`terminal:${sel.value}`);
							return;
						}
					}

					// 'd' — details (only when not typing in filter)
					if (data === "d" && !filterText) {
						const sel = selectList.getSelectedItem();
						if (sel) {
							done(`details:${sel.value}`);
							return;
						}
					}

					// Typing filter
					if (data.length === 1 && data >= " " && data <= "~") {
						filterText += data;
						rebuildList();
						tui.requestRender();
						return;
					}

					// Backspace
					if (data === "\x7f" || data === "\b") {
						if (filterText.length > 0) {
							filterText = filterText.slice(0, -1);
							rebuildList();
							tui.requestRender();
							return;
						}
					}

					// Ctrl+U — clear filter
					if (data === "\x15") {
						filterText = "";
						rebuildList();
						tui.requestRender();
						return;
					}

					selectList.handleInput(data);
					tui.requestRender();
				},
				dispose: () => {
					if (cursorTimer) clearInterval(cursorTimer);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: () => ({
				anchor: "center" as const,
				width: "80%" as const,
				maxHeight: "80%" as const,
			}),
		},
	);
}

/** Show project details in a simple info overlay. */
async function showProjectDetails(
	project: Project,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const RST = "\x1b[0m";
	const DIM = "\x1b[38;5;242m";
	const BOLD = "\x1b[1m";
	const WHITE = "\x1b[38;5;255m";
	const CYAN = "\x1b[38;5;117m";
	const GREEN = "\x1b[38;5;114m";
	const YELLOW = "\x1b[38;5;222m";

	return ctx.ui.custom(
		(_tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
			const border = (t: string) => theme.fg("dim", t);
			const wrap = (t: string, w: number) =>
				`${border("│")} ${truncateToWidth(t, Math.max(1, w - 2), "…", true)} ${border("│")}`;

			return {
				render: (width: number) => {
					const iw = Math.max(1, width - 2);
					const lines: string[] = [];
					const catColor = CATEGORY_ANSI[project.category];

					lines.push(border(`╭${"─".repeat(iw)}╮`));
					lines.push(wrap(`${WHITE}${BOLD}${project.name}${RST}  ${catColor}${CATEGORY_BADGE[project.category]}${RST}`, iw));
					lines.push(border(`├${"─".repeat(iw)}┤`));

					// Path
					lines.push(wrap(`${DIM}Path:${RST}  ${shortPath(project.path)}`, iw));

					// Language
					if (project.language) {
						lines.push(wrap(`${DIM}Lang:${RST}  ${project.language}`, iw));
					}

					// Sessions
					lines.push(wrap(`${DIM}Sessions:${RST}  ${project.sessions > 0 ? `${CYAN}${project.sessions}${RST}` : `${DIM}0${RST}`}`, iw));

					// Git info
					if (project.git) {
						lines.push(wrap("", iw));
						lines.push(wrap(`${WHITE}${BOLD}Git${RST}`, iw));
						lines.push(wrap(`${DIM}Branch:${RST}  ${project.git.branch}`, iw));

						if (project.git.dirty > 0) {
							lines.push(wrap(`${DIM}Dirty:${RST}   ${YELLOW}${project.git.dirty} files${RST}`, iw));
						} else {
							lines.push(wrap(`${DIM}Dirty:${RST}   ${GREEN}clean${RST}`, iw));
						}

						if (project.git.ahead > 0) {
							lines.push(wrap(`${DIM}Ahead:${RST}   ${CYAN}${project.git.ahead} commits unpushed${RST}`, iw));
						}

						if (project.git.remote) {
							lines.push(wrap(`${DIM}Remote:${RST}  ${shortRemote(project.git.remote)}`, iw));
						}

						if (project.git.lastCommit) {
							lines.push(wrap(`${DIM}Last commit:${RST} ${relativeDate(project.git.lastCommit)}`, iw));
						}
					}

					// Description
					if (project.description) {
						lines.push(wrap("", iw));
						lines.push(wrap(`${DIM}${project.description}${RST}`, iw));
					}

					// Last modified
					if (project.lastModified) {
						lines.push(wrap(`${DIM}Modified:${RST} ${relativeDate(project.lastModified)}`, iw));
					}

					lines.push(border(`├${"─".repeat(iw)}┤`));
					lines.push(wrap(`${DIM}enter${RST} back  ${DIM}c${RST} copy  ${DIM}t${RST} terminal  ${DIM}esc${RST} close`, iw));
					lines.push(border(`╰${"─".repeat(iw)}╯`));

					return lines;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (data === "\r" || data === "\n") {
						done("back");
					} else if (data === "\x1b" || data === "q") {
						done(null);
					} else if (data === "c") {
						done(`copy:${project.path}`);
					} else if (data === "t") {
						done(`terminal:${project.path}`);
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: () => ({
				anchor: "center" as const,
				width: "60%" as const,
			}),
		},
	);
}

// ── Extension Entry ────────────────────────────────────────────────

export default function projectBrowser(pi: ExtensionAPI): void {
	let cachedProjects: Project[] | null = null;
	let cacheTime = 0;
	const CACHE_TTL = 30_000; // 30 seconds

	async function getProjects(): Promise<Project[]> {
		const now = Date.now();
		if (cachedProjects && now - cacheTime < CACHE_TTL) {
			return cachedProjects;
		}
		cachedProjects = await discoverAll();
		cacheTime = now;
		return cachedProjects;
	}

	/** Invalidate cache so next open re-discovers. */
	function invalidateCache(): void {
		cachedProjects = null;
		cacheTime = 0;
	}

	async function openBrowser(ctx: ExtensionCommandContext, initialFilter?: string): Promise<void> {
		ctx.ui.notify("Scanning projects…", "info");
		const projects = await getProjects();

		if (projects.length === 0) {
			ctx.ui.notify("No projects found", "warning");
			return;
		}

		let keepBrowsing = true;

		while (keepBrowsing) {
			const result = await renderProjectBrowser(projects, ctx, initialFilter);
			initialFilter = undefined; // Only apply filter on first open

			if (!result) {
				keepBrowsing = false;
				break;
			}

			if (result.startsWith("select:") || result.startsWith("details:")) {
				const path = result.replace(/^(select|details):/, "");
				const project = projects.find((p) => p.path === path);
				if (!project) continue;

				const detailResult = await showProjectDetails(project, ctx);
				if (!detailResult) {
					keepBrowsing = false;
				} else if (detailResult === "back") {
					continue; // Back to browser
				} else if (detailResult.startsWith("copy:")) {
					await handleCopy(detailResult.slice(5), ctx);
					keepBrowsing = false;
				} else if (detailResult.startsWith("terminal:")) {
					await handleTerminal(detailResult.slice(9), ctx);
					keepBrowsing = false;
				}
			} else if (result.startsWith("copy:")) {
				await handleCopy(result.slice(5), ctx);
				keepBrowsing = false;
			} else if (result.startsWith("terminal:")) {
				await handleTerminal(result.slice(9), ctx);
				keepBrowsing = false;
			}
		}
	}

	async function handleCopy(path: string, ctx: ExtensionCommandContext): Promise<void> {
		await copyToClipboard(path);
		ctx.ui.notify(`Copied: ${shortPath(path)}`, "info");
	}

	async function handleTerminal(path: string, ctx: ExtensionCommandContext): Promise<void> {
		// Open a new terminal window at the project path
		const terminal = process.env.TERMINAL || "ghostty";
		spawn(terminal, [], {
			cwd: path,
			detached: true,
			stdio: "ignore",
		}).unref();
		ctx.ui.notify(`Terminal opened: ${shortPath(path)}`, "info");
	}

	// ── Command ──────────────────────────────────────────────────────

	pi.registerCommand("projects", {
		description: "Browse local projects",
		handler: async (args, ctx) => {
			await openBrowser(ctx, args.trim() || undefined);
		},
	});

	// ── Shortcut ─────────────────────────────────────────────────────

	pi.registerShortcut("alt+p", {
		description: "Open project browser",
		handler: async (ctx) => {
			// Shortcut handler gets ExtensionContext, but we need command context.
			// Cast since we know we're in interactive mode.
			await openBrowser(ctx as unknown as ExtensionCommandContext);
		},
	});

	// ── Invalidate cache on relevant events ──────────────────────────

	pi.on("session_start", async () => {
		invalidateCache();
	});

	pi.on("session_switch", async () => {
		invalidateCache();
	});
}
