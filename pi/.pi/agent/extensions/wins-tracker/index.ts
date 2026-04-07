/**
 * Wins Tracker — Automatic accomplishment logging for performance reviews.
 *
 * Problem: You forget to track what you accomplished with AI assistance.
 * Solution: Every session is silently analyzed on exit. Wins are auto-logged.
 *
 * How it works:
 *   - On session_shutdown, extracts the conversation
 *   - Calls Claude Haiku to identify concrete accomplishments
 *   - Appends wins to ~/.pi/wins/wins.jsonl (structured, append-only)
 *   - Never blocks exit — fails silently on errors
 *
 * Commands:
 *   /wins              — Browse recent accomplishments
 *   /wins all          — Browse all accomplishments
 *   /wins report       — Generate a markdown report (current month)
 *   /wins report week  — Report for this week
 *   /wins report quarter — Report for this quarter
 *   /wins report 2026-03 — Report for a specific month
 *   /wins clear        — Clear all wins (with confirmation)
 *   /wins backfill     — Retroactively analyze all past sessions for wins
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, appendFile, mkdir, writeFile, readdir, stat, open as fsOpen } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ── Config ─────────────────────────────────────────────────────────

const WINS_DIR = join(homedir(), ".pi", "wins");
const WINS_FILE = join(WINS_DIR, "wins.jsonl");
const CUSTOM_TYPE = "wins-tracker";

/** Max time to wait for the analysis API call before giving up. */
const ANALYSIS_TIMEOUT_MS = 15_000;

/** Sessions with fewer than this many user+assistant messages are skipped. */
const MIN_MESSAGE_COUNT = 4;

/** Sessions with less conversation text than this are skipped. */
const MIN_CONVERSATION_CHARS = 300;

/** Max conversation text sent to the analysis model. */
const MAX_CHARS_FOR_ANALYSIS = 12_000;

/** Models to try in order — best available first, with fallbacks. */
const ANALYSIS_MODELS = ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"];

// ── Types ──────────────────────────────────────────────────────────

interface Win {
	id: string;
	timestamp: string;
	project: string;
	cwd: string;
	sessionId: string;
	summary: string;
	category: string;
	impact: string;
}

interface DetectedWin {
	summary: string;
	category: string;
	impact: string;
}

// ── Helpers: Text Extraction ───────────────────────────────────────

/** Pull the first text string out of a message content field. */
function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block?.type === "text" && typeof block.text === "string") {
				return block.text;
			}
		}
	}
	return undefined;
}

/**
 * Build a compact transcript from session entries.
 * Includes user/assistant messages and brief tool-use annotations
 * so the analyzer knows what actions were taken (files written, commands run).
 */
function extractConversation(entries: any[]): string {
	const parts: string[] = [];
	let total = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg?.role) continue;

		let segment: string | undefined;

		if (msg.role === "user" || msg.role === "assistant") {
			const text = extractText(msg.content);
			if (!text?.trim()) continue;
			const label = msg.role === "user" ? "User" : "Assistant";
			segment = `${label}: ${text.trim()}`;
		} else if (msg.role === "toolResult" && !msg.isError) {
			// Include brief tool annotations for context (what actions were taken)
			const tool = msg.toolName;
			if (tool === "write" || tool === "edit") {
				const path = msg.details?.path || msg.details?.filePath || "";
				segment = `[Tool: ${tool} ${path}]`;
			} else if (tool === "bash") {
				const cmd = (msg.details?.command || "").slice(0, 120);
				segment = `[Tool: bash "${cmd}"]`;
			}
			// Skip other tools to stay concise
		}

		if (!segment) continue;

		if (total + segment.length > MAX_CHARS_FOR_ANALYSIS) {
			parts.push("[...conversation truncated...]");
			break;
		}

		parts.push(segment);
		total += segment.length;
	}

	return parts.join("\n\n");
}

// ── Helpers: Win Storage ───────────────────────────────────────────

async function ensureDir(): Promise<void> {
	await mkdir(WINS_DIR, { recursive: true });
}

async function appendWin(win: Win): Promise<void> {
	await ensureDir();
	await appendFile(WINS_FILE, JSON.stringify(win) + "\n", "utf8");
}

async function readAllWins(): Promise<Win[]> {
	try {
		const content = await readFile(WINS_FILE, "utf8");
		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

async function sessionAlreadyAnalyzed(sessionId: string): Promise<boolean> {
	const wins = await readAllWins();
	return wins.some((w) => w.sessionId === sessionId);
}

// ── Helpers: Session Discovery (for backfill) ─────────────────────

const SESSIONS_BASE = join(homedir(), ".pi", "agent", "sessions");

interface SessionFile {
	filePath: string;
	sessionId: string;
	timestamp: string;
	cwd: string;
	project: string;
}

/** Parse session header + entries from a JSONL file on disk. */
async function parseSessionFile(filePath: string): Promise<{ meta: SessionFile; entries: any[] } | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		if (lines.length === 0) return null;

		const header = JSON.parse(lines[0]);
		if (header.type !== "session" || !header.id) return null;

		const entries: any[] = [];
		for (let i = 1; i < lines.length; i++) {
			try {
				entries.push(JSON.parse(lines[i]));
			} catch {
				// skip malformed lines
			}
		}

		return {
			meta: {
				filePath,
				sessionId: header.id,
				timestamp: header.timestamp,
				cwd: header.cwd || "",
				project: basename(header.cwd || "unknown"),
			},
			entries,
		};
	} catch {
		return null;
	}
}

/** Discover all session JSONL files under the sessions directory. */
async function discoverSessionFiles(): Promise<string[]> {
	const paths: string[] = [];
	try {
		const dirs = await readdir(SESSIONS_BASE);
		for (const dir of dirs) {
			const dirPath = join(SESSIONS_BASE, dir);
			const dirStat = await stat(dirPath).catch(() => null);
			if (!dirStat?.isDirectory()) continue;

			const files = await readdir(dirPath).catch(() => []);
			for (const file of files) {
				if (file.endsWith(".jsonl")) {
					paths.push(join(dirPath, file));
				}
			}
		}
	} catch {
		// sessions dir might not exist
	}
	return paths;
}

/** Get all session IDs already in the wins log. */
async function getAnalyzedSessionIds(): Promise<Set<string>> {
	const wins = await readAllWins();
	return new Set(wins.map((w) => w.sessionId));
}

// ── Helpers: Claude API Call ───────────────────────────────────────

const ANALYSIS_PROMPT = `You are reviewing an AI-assisted coding session to identify accomplishments worth mentioning in a performance review.

CRITICAL RULES:
- Return AT MOST 1-2 wins per session. Most sessions have exactly 1 win or 0.
- CONSOLIDATE related work into a SINGLE win. If someone built 5 features for the same tool, that is ONE win, not 5.
- Each win should be a COMPLETE DELIVERABLE, not an individual step. "Added method X" is a step. "Built feature Y" is a deliverable.
- The summary should be what you'd tell your manager in a standup — one sentence covering the whole achievement.
- Do NOT count: asking questions, exploring options, investigations that didn't lead to action, verifying tests pass, trivial config changes, routine maintenance, or things that are just part of normal workflow.
- If the session was just exploration, Q&A, or small fixes, return an empty array. Not every session produces a win.
- A win means: "I shipped/built/fixed/designed something meaningful." Be stingy.

Project: {PROJECT}

Session transcript:
{CONVERSATION}

Respond with ONLY a JSON array (no markdown fences, no explanation). Each item:
{"summary": "one-sentence description of the complete deliverable", "category": "feature|bugfix|refactor|docs|devops|investigation|tooling|testing|design|review", "impact": "who benefits and why it matters"}

If nothing meaningful was accomplished, return exactly: []`;

/** Track which model works to avoid retrying 404s on every call. */
let workingModel: string | undefined;

/** OAuth tokens (from `pi login`) use Bearer auth + special beta headers. */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
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

async function analyzeForWins(
	conversation: string,
	project: string,
	apiKey: string,
	baseUrl: string,
): Promise<DetectedWin[]> {
	const prompt = ANALYSIS_PROMPT.replace("{PROJECT}", project).replace("{CONVERSATION}", conversation);
	const headers = buildHeaders(apiKey);

	// Try models in order until one works, then remember it
	const modelsToTry = workingModel ? [workingModel] : ANALYSIS_MODELS;

	for (const model of modelsToTry) {
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
		});

		if (response.status === 404) {
			// Model not available — try next
			continue;
		}

		if (!response.ok) {
			throw new Error(`Anthropic API ${response.status}: ${await response.text().catch(() => "unknown")}`);
		}

		// This model works — remember it for future calls
		workingModel = model;

		const data = await response.json();
		const text = data?.content?.[0]?.text;
		if (!text) return [];

		// Parse JSON — handle models that wrap in markdown fences
		const cleaned = text
			.replace(/```json\n?/g, "")
			.replace(/```\n?/g, "")
			.trim();
		const parsed = JSON.parse(cleaned);

		if (!Array.isArray(parsed)) return [];
		return parsed.filter((w: any) => w.summary && w.category);
	}

	throw new Error(`No working model found. Tried: ${ANALYSIS_MODELS.join(", ")}`);
}

// ── Helpers: JSON Parsing ───────────────────────────────────────────

/** Parse JSON with recovery for truncated arrays (from max_tokens cutoff). */
function parseJsonSafe(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		// Try to recover truncated JSON arrays by finding the last complete object
		const lastClose = text.lastIndexOf("}");
		if (lastClose > 0) {
			const truncated = text.slice(0, lastClose + 1) + "]";
			try {
				return JSON.parse(truncated);
			} catch {
				// ignore
			}
		}
		return [];
	}
}

// ── Helpers: Report Consolidation (LLM-powered) ───────────────────

const CONSOLIDATION_PROMPT = `You are helping an engineer prepare their performance review. Below are session-level notes from their AI-assisted coding work. Each note is one coding session.

YOUR JOB: Synthesize these into 10-20 HIGH-LEVEL accomplishments grouped by project or theme. This is for a performance review — think big picture, not individual tasks.

RULES:
- MERGE all sessions about the same project/area into ONE accomplishment. 46 sessions on "babka-osd-infra" might become 2-3 accomplishments about different aspects of that work.
- Write each accomplishment as one impactful sentence a manager would appreciate.
- Group related work by project or theme (e.g., "Infrastructure Automation", "Developer Tooling", "Data Platform").
- Focus on OUTCOMES and BUSINESS VALUE, not technical minutiae.
- Include scope when possible ("across 5 environments", "reducing X by Y%", "for N users").
- If multiple sessions were about building the same tool or feature, that's ONE accomplishment about the tool, not N accomplishments about N sessions.
- Target 10-20 total accomplishments. Fewer is better if the work naturally consolidates.

SESSION NOTES ({NOTE_COUNT} sessions, {PROJECT_COUNT} projects):
{NOTES}

Return ONLY a JSON array (no markdown, no explanation). Each item:
{"theme": "project or area grouping", "summary": "one impactful sentence about the accomplishment", "impact": "business value — who benefits and how", "sessions": N}

Order by impact/importance (most significant first).`;

interface ConsolidatedWin {
	theme: string;
	summary: string;
	impact: string;
	sessions: number;
}

async function consolidateForReport(
	wins: Win[],
	title: string,
	apiKey: string,
	baseUrl: string,
): Promise<ConsolidatedWin[]> {
	// Build the session notes summary for the LLM
	const noteLines = wins.map((w) => {
		const date = new Date(w.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
		return `- [${date}] (${w.project}) ${w.summary}`;
	});

	const projects = new Set(wins.map((w) => w.project));
	const prompt = CONSOLIDATION_PROMPT.replace("{NOTE_COUNT}", String(wins.length))
		.replace("{PROJECT_COUNT}", String(projects.size))
		.replace("{NOTES}", noteLines.join("\n"));

	const headers = buildHeaders(apiKey);
	const modelsToTry = workingModel ? [workingModel] : ANALYSIS_MODELS;

	for (const model of modelsToTry) {
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				max_tokens: 4096,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(30_000), // Consolidation may take longer
		});

		if (response.status === 404) continue;

		if (!response.ok) {
			throw new Error(`Anthropic API ${response.status}: ${await response.text().catch(() => "unknown")}`);
		}

		workingModel = model;
		const data = await response.json();
		const text = data?.content?.[0]?.text;
		if (!text) return [];

		const cleaned = text
			.replace(/```json\n?/g, "")
			.replace(/```\n?/g, "")
			.trim();

		const parsed = parseJsonSafe(cleaned);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((w: any) => w.summary && w.theme);
	}

	throw new Error(`No working model found. Tried: ${ANALYSIS_MODELS.join(", ")}`);
}

function formatConsolidatedReport(consolidated: ConsolidatedWin[], rawWins: Win[], title: string): string {
	if (consolidated.length === 0) {
		return `# ${title}\n\nNo significant accomplishments found for this period.\n`;
	}

	const lines: string[] = [];
	lines.push(`# ${title}\n`);

	// Group by theme
	const byTheme = new Map<string, ConsolidatedWin[]>();
	for (const c of consolidated) {
		if (!byTheme.has(c.theme)) byTheme.set(c.theme, []);
		byTheme.get(c.theme)!.push(c);
	}

	for (const [theme, items] of byTheme) {
		lines.push(`## ${theme}\n`);
		for (const item of items) {
			lines.push(`- **${item.summary}**`);
			if (item.impact) {
				lines.push(`  — _${item.impact}_`);
			}
		}
		lines.push("");
	}

	// Footer
	const projects = new Set(rawWins.map((w) => w.project));
	const sessionCount = new Set(rawWins.map((w) => w.sessionId)).size;
	lines.push("---");
	lines.push(
		`_${consolidated.length} accomplishments consolidated from ${sessionCount} AI-assisted sessions across ${projects.size} projects · Auto-tracked by wins-tracker_`,
	);

	return lines.join("\n");
}

// ── Helpers: Report Generation (raw, for /wins browse) ─────────────

const CATEGORY_LABELS: Record<string, string> = {
	feature: "Features & Enhancements",
	bugfix: "Bug Fixes",
	refactor: "Refactoring",
	docs: "Documentation",
	devops: "Infrastructure & DevOps",
	investigation: "Investigations & Research",
	tooling: "Tooling & Developer Experience",
	testing: "Testing",
	design: "Design & Architecture",
	review: "Code Review & Collaboration",
};

const CATEGORY_EMOJI: Record<string, string> = {
	feature: "✨",
	bugfix: "🐛",
	refactor: "♻️",
	docs: "📝",
	devops: "🔧",
	investigation: "🔍",
	tooling: "🛠️",
	testing: "🧪",
	design: "📐",
	review: "👀",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

function getWeekMonday(date: Date): Date {
	const d = new Date(date);
	const day = d.getDay();
	const diff = d.getDate() - day + (day === 0 ? -6 : 1);
	d.setDate(diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

function formatWeekRange(monday: Date): string {
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
	return `Week of ${fmt(monday)}–${fmt(sunday)}`;
}

function groupByWeek(wins: Win[]): Map<string, Win[]> {
	const groups = new Map<string, Win[]>();
	for (const win of wins) {
		const monday = getWeekMonday(new Date(win.timestamp));
		const key = monday.toISOString().split("T")[0];
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(win);
	}
	return groups;
}

function generateReport(wins: Win[], title?: string): string {
	if (wins.length === 0) return "# No accomplishments recorded for this period.\n\nWins are logged automatically at the end of productive AI sessions.\n";

	const sorted = [...wins].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const weeks = groupByWeek(sorted);
	const lines: string[] = [];

	lines.push(`# ${title || "Accomplishments Report"}\n`);

	for (const [weekKey, weekWins] of [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
		lines.push(`## ${formatWeekRange(new Date(weekKey + "T00:00:00"))}\n`);

		// Group by category
		const byCat = new Map<string, Win[]>();
		for (const w of weekWins) {
			const cat = w.category || "other";
			if (!byCat.has(cat)) byCat.set(cat, []);
			byCat.get(cat)!.push(w);
		}

		const sortedCats = [...byCat.keys()].sort(
			(a, b) => (CATEGORY_ORDER.indexOf(a) === -1 ? 99 : CATEGORY_ORDER.indexOf(a)) - (CATEGORY_ORDER.indexOf(b) === -1 ? 99 : CATEGORY_ORDER.indexOf(b)),
		);

		for (const cat of sortedCats) {
			const emoji = CATEGORY_EMOJI[cat] || "📌";
			const label = CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
			lines.push(`### ${emoji} ${label}\n`);

			for (const w of byCat.get(cat)!) {
				lines.push(`- **${w.summary}** _(${w.project})_`);
				if (w.impact) {
					lines.push(`  — ${w.impact}`);
				}
			}
			lines.push("");
		}
	}

	const projects = new Set(wins.map((w) => w.project));
	const sessionCount = new Set(wins.map((w) => w.sessionId)).size;
	lines.push("---");
	lines.push(
		`_${wins.length} accomplishment${wins.length !== 1 ? "s" : ""} from ${sessionCount} session${sessionCount !== 1 ? "s" : ""} across ${projects.size} project${projects.size !== 1 ? "s" : ""} · Auto-tracked by wins-tracker_`,
	);

	return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Auto-detect wins at session end ────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			// Extract the UUID session ID from the session file path.
			// File names are like "2026-03-04T16-32-36-960Z_<uuid>.jsonl"
			// We want just the UUID to match the header ID used by backfill.
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (!sessionFile) return;
			const fileBase = basename(sessionFile, ".jsonl");
			const uuidIdx = fileBase.indexOf("_");
			const sessionId = uuidIdx >= 0 ? fileBase.slice(uuidIdx + 1) : fileBase;
			if (!sessionId) return;

			// Don't re-analyze the same session
			if (await sessionAlreadyAnalyzed(sessionId)) return;

			// Get current conversation branch
			const entries = ctx.sessionManager.getBranch();

			// Skip trivial sessions (quick questions, accidental opens, etc.)
			const messageCount = entries.filter(
				(e: any) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
			).length;
			if (messageCount < MIN_MESSAGE_COUNT) return;

			const conversation = extractConversation(entries);
			if (conversation.length < MIN_CONVERSATION_CHARS) return;

			const project = basename(ctx.cwd);

			// Get API key from pi's auth system (covers login, env vars, etc.)
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			if (!apiKey) return; // No key available — skip silently

			const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

			// Show brief status while analyzing
			if (ctx.hasUI) {
				ctx.ui.setStatus(CUSTOM_TYPE, "📝 Checking for wins...");
			}

			const detected = await analyzeForWins(conversation, project, apiKey, baseUrl);

			if (detected.length > 0) {
				const now = new Date().toISOString();
				for (const d of detected) {
					await appendWin({
						id: randomUUID(),
						timestamp: now,
						project,
						cwd: ctx.cwd,
						sessionId,
						summary: d.summary,
						category: d.category,
						impact: d.impact || "",
					});
				}

				if (ctx.hasUI) {
					const s = detected.length !== 1 ? "s" : "";
					ctx.ui.setStatus(CUSTOM_TYPE, `🏆 Logged ${detected.length} win${s}!`);
				}
			} else {
				if (ctx.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		} catch {
			// Never block exit — silently move on
			try {
				if (ctx.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			} catch {
				// Even clearing status can fail during shutdown
			}
		}
	});

	// ── Command: /wins ─────────────────────────────────────────────

	pi.registerCommand("wins", {
		description: "Browse and export your AI-assisted accomplishments",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "report", label: "report — Generate consolidated review (current quarter)" },
				{ value: "report half", label: "report half — This half-year's review" },
				{ value: "report quarter", label: "report quarter — This quarter's review" },
				{ value: "report week", label: "report week — This week's review" },
				{ value: "all", label: "all — Browse all wins" },
				{ value: "backfill", label: "backfill — Analyze all past sessions for wins" },
				{ value: "clear", label: "clear — Clear all wins" },
			];
			return options.filter((o) => o.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			// ── /wins report [period] ──────────────────────────────
			if (trimmed === "report" || trimmed.startsWith("report ")) {
				const period = trimmed.replace(/^report\s*/, "").trim();
				let wins = await readAllWins();
				let title: string | undefined;
				const now = new Date();

				if (period === "week") {
					const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
					wins = wins.filter((w) => w.timestamp >= weekAgo);
					title = "Accomplishments — This Week";
				} else if (period === "quarter") {
					const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
					wins = wins.filter((w) => w.timestamp >= qStart.toISOString());
					const q = Math.floor(now.getMonth() / 3) + 1;
					title = `Accomplishments — Q${q} ${now.getFullYear()}`;
				} else if (period === "half" || period === "h1" || period === "h2") {
					const half = now.getMonth() < 6 ? 0 : 1;
					const hStart = new Date(now.getFullYear(), half * 6, 1);
					wins = wins.filter((w) => w.timestamp >= hStart.toISOString());
					title = `Accomplishments — H${half + 1} ${now.getFullYear()}`;
				} else if (period === "all") {
					title = "All Accomplishments";
				} else if (/^\d{4}-\d{2}$/.test(period)) {
					wins = wins.filter((w) => w.timestamp.startsWith(period));
					const d = new Date(period + "-01T00:00:00");
					title = `Accomplishments — ${d.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`;
				} else {
					// Default: current quarter
					const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
					wins = wins.filter((w) => w.timestamp >= qStart.toISOString());
					const q = Math.floor(now.getMonth() / 3) + 1;
					title = `Accomplishments — Q${q} ${now.getFullYear()}`;
				}

				if (wins.length === 0) {
					ctx.ui.notify("No session notes found for this period.", "warning");
					return;
				}

				// Get API key for LLM consolidation
				const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
				if (!apiKey) {
					ctx.ui.notify("No Anthropic API key — can't generate consolidated report.", "error");
					return;
				}
				const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

				ctx.ui.setStatus(CUSTOM_TYPE, `📝 Consolidating ${wins.length} session notes into review...`);

				try {
					const consolidated = await consolidateForReport(wins, title || "Accomplishments", apiKey, baseUrl);
					const report = formatConsolidatedReport(consolidated, wins, title || "Accomplishments");
					const reportPath = join(WINS_DIR, "report.md");
					await ensureDir();
					await writeFile(reportPath, report, "utf8");
					ctx.ui.setStatus(CUSTOM_TYPE, undefined);
					ctx.ui.notify(`📄 Report saved to ${reportPath}`, "info");
					await ctx.ui.editor("Wins Report:", report);
				} catch (e: any) {
					ctx.ui.setStatus(CUSTOM_TYPE, undefined);
					ctx.ui.notify(`Report generation failed: ${e?.message?.slice(0, 100)}`, "error");
				}
				return;
			}

			// ── /wins backfill ─────────────────────────────────────
			if (trimmed === "backfill") {
				const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
				if (!apiKey) {
					ctx.ui.notify("No Anthropic API key available. Run `pi login` first.", "error");
					return;
				}
				const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

				// Discover all sessions and filter to unanalyzed ones
				ctx.ui.setStatus(CUSTOM_TYPE, "🔍 Scanning sessions...");
				const sessionPaths = await discoverSessionFiles();
				const alreadyDone = await getAnalyzedSessionIds();

				// Also exclude the current session
				const currentFile = ctx.sessionManager.getSessionFile?.();
				const currentId = currentFile ? basename(currentFile, ".jsonl") : undefined;

				// Parse all sessions and filter
				const candidates: { meta: SessionFile; entries: any[] }[] = [];
				for (const path of sessionPaths) {
					const parsed = await parseSessionFile(path);
					if (!parsed) continue;
					if (alreadyDone.has(parsed.meta.sessionId)) continue;
					if (parsed.meta.sessionId === currentId) continue;

					const msgCount = parsed.entries.filter(
						(e: any) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
					).length;
					if (msgCount < MIN_MESSAGE_COUNT) continue;

					const convo = extractConversation(parsed.entries);
					if (convo.length < MIN_CONVERSATION_CHARS) continue;

					candidates.push(parsed);
				}

				if (candidates.length === 0) {
					ctx.ui.setStatus(CUSTOM_TYPE, undefined);
					ctx.ui.notify("All sessions have already been analyzed. Nothing to backfill!", "info");
					return;
				}

				// Sort oldest-first so wins log builds chronologically
				candidates.sort((a, b) => (a.meta.timestamp || "").localeCompare(b.meta.timestamp || ""));

				const ok = await ctx.ui.confirm(
					"Backfill wins from past sessions?",
					`Found ${candidates.length} unanalyzed session${candidates.length !== 1 ? "s" : ""}. ` +
						`This will call Claude Haiku for each one (~$${(candidates.length * 0.001).toFixed(2)} estimated). Continue?`,
				);
				if (!ok) {
					ctx.ui.setStatus(CUSTOM_TYPE, undefined);
					return;
				}

				let totalWins = 0;
				let analyzed = 0;
				let errors = 0;
				let firstError: string | undefined;

				for (const { meta, entries } of candidates) {
					analyzed++;
					ctx.ui.setStatus(
						CUSTOM_TYPE,
						`📝 Analyzing session ${analyzed}/${candidates.length} (${meta.project}, ${totalWins} wins so far)...`,
					);

					try {
						const conversation = extractConversation(entries);
						const detected = await analyzeForWins(conversation, meta.project, apiKey, baseUrl);

						if (detected.length > 0) {
							// Use the session's original timestamp so wins appear in the right week
							const winTimestamp = meta.timestamp || new Date().toISOString();
							for (const d of detected) {
								await appendWin({
									id: randomUUID(),
									timestamp: winTimestamp,
									project: meta.project,
									cwd: meta.cwd,
									sessionId: meta.sessionId,
									summary: d.summary,
									category: d.category,
									impact: d.impact || "",
								});
							}
							totalWins += detected.length;
						}
					} catch (e: any) {
						errors++;
						if (!firstError) {
							firstError = e?.message || String(e);
						}
					}

					// Small delay between calls to be a good API citizen
					if (analyzed < candidates.length) {
						await new Promise((r) => setTimeout(r, 300));
					}
				}

				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
				if (errors > 0 && totalWins === 0) {
					// All failures — show the actual error so user can debug
					ctx.ui.notify(
						`❌ Backfill failed: ${errors}/${analyzed} sessions errored. First error: ${firstError?.slice(0, 120)}`,
						"error",
					);
				} else {
					const errMsg = errors > 0 ? ` (${errors} failed)` : "";
					ctx.ui.notify(
						`🏆 Backfill complete! Found ${totalWins} win${totalWins !== 1 ? "s" : ""} across ${analyzed} sessions${errMsg}.`,
						totalWins > 0 ? "info" : "warning",
					);
				}
				return;
			}

			// ── /wins clear ────────────────────────────────────────
			if (trimmed === "clear") {
				const ok = await ctx.ui.confirm("Clear all wins?", "This permanently deletes all recorded accomplishments.");
				if (ok) {
					await ensureDir();
					await writeFile(WINS_FILE, "", "utf8");
					ctx.ui.notify("🗑️ All wins cleared.", "info");
				}
				return;
			}

			// ── /wins [all] — Browse ───────────────────────────────
			const wins = await readAllWins();
			if (wins.length === 0) {
				ctx.ui.notify("No wins recorded yet. They're logged automatically when you end a productive session.", "info");
				return;
			}

			const sorted = [...wins].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
			const showAll = trimmed === "all";
			const display = showAll ? sorted : sorted.slice(0, 30);

			const options = display.map((w) => {
				const date = new Date(w.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
				const emoji = CATEGORY_EMOJI[w.category] || "📌";
				const summary = w.summary.length > 55 ? w.summary.slice(0, 52) + "..." : w.summary;
				return `${date}  ${emoji} ${summary}  (${w.project})`;
			});

			const header = showAll
				? `🏆 All ${wins.length} wins`
				: `🏆 ${wins.length} total wins (showing recent ${display.length})`;

			const choice = await ctx.ui.select(header, options);

			if (choice != null) {
				const idx = options.indexOf(choice);
				if (idx >= 0) {
					const w = display[idx];
					const emoji = CATEGORY_EMOJI[w.category] || "📌";
					const catLabel = CATEGORY_LABELS[w.category] || w.category;
					const detail = [
						`${emoji}  ${w.summary}`,
						"",
						`Category:  ${catLabel}`,
						`Project:   ${w.project}`,
						`Date:      ${new Date(w.timestamp).toLocaleString()}`,
						`Impact:    ${w.impact || "—"}`,
						`Session:   ${w.sessionId.slice(0, 8)}`,
						`Path:      ${w.cwd}`,
					].join("\n");
					await ctx.ui.editor("Win Details:", detail);
				}
			}
		},
	});
}
