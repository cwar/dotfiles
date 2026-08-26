/**
 * Tribal Knowledge — Automatic durable learning capture for pi sessions.
 *
 * Problem: useful repo/system facts get rediscovered and then forgotten.
 * Solution: productive sessions are analyzed on shutdown for reusable tribal knowledge.
 *
 * How it works:
 *   - On session_shutdown, extracts a compact transcript with tool annotations
 *   - Calls Claude Haiku to identify durable, evidence-backed knowledge notes
 *   - Appends notes to ~/.pi/tribal-knowledge/knowledge.jsonl
 *   - Records analyzed sessions so sessions with 0 notes are not reprocessed
 *   - Never blocks exit — failures are swallowed during shutdown
 *
 * Commands:
 *   /knowledge                 — Browse recent notes
 *   /knowledge all             — Browse all notes
 *   /knowledge search <query>  — Search notes with AND semantics
 *   /knowledge report          — Generate a markdown knowledge report
 *   /knowledge backfill        — Scan past sessions and show a non-blocking plan
 *   /knowledge backfill start  — Start background analysis of past sessions
 *   /knowledge backfill status — Show current backfill progress
 *   /knowledge backfill stop   — Stop after the current session finishes
 *   /knowledge clear           — Show destructive clear instructions
 *   /knowledge clear confirm   — Clear notes and analyzed-session markers
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";

// ── Config ─────────────────────────────────────────────────────────

const KNOWLEDGE_DIR = join(homedir(), ".pi", "tribal-knowledge");
const KNOWLEDGE_FILE = join(KNOWLEDGE_DIR, "knowledge.jsonl");
const ANALYZED_SESSIONS_FILE = join(KNOWLEDGE_DIR, "analyzed-sessions.json");
const CUSTOM_TYPE = "tribal-knowledge";
const SESSIONS_BASE = join(homedir(), ".pi", "agent", "sessions");

/** Max time to wait for an analysis API call before giving up. */
const ANALYSIS_TIMEOUT_MS = 20_000;

/** Sessions with fewer than this many user+assistant messages are skipped. */
const MIN_MESSAGE_COUNT = 4;

/** Sessions with less conversation text than this are skipped. */
const MIN_CONVERSATION_CHARS = 500;

/** Max conversation text sent to the analysis model. */
const MAX_CHARS_FOR_ANALYSIS = 16_000;

/** Prefer latest cheap/fast models, with fallbacks for older installations. */
const ANALYSIS_MODELS = ["claude-haiku-4-5", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"];

/** Truncation favors recent context while keeping the original goal. */
const TAIL_BUDGET_RATIO = 0.65;

// ── Types ──────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

/**
 * Surface a knowledge note was gleaned from.
 *
 * Bounded but extensible taxonomy. Each surface ingester is responsible
 * for stamping the correct `source_type` on notes it produces; the
 * analysis LLM doesn't need to know about source types.
 */
export type SourceType =
	| "ai-session"
	| "slack-thread"
	| "slack-message"
	| "commit"
	| "pr-description"
	| "pr-comment"
	| "code-comment"
	| "doc"
	| "runbook";

export interface KnowledgeNote {
	id: string;
	/** Where this note was gleaned from. See {@link SourceType}. */
	source_type: SourceType;
	/**
	 * Surface-specific identifier for the source artifact.
	 * For `ai-session` this equals `sessionId`. For Slack it's the
	 * thread/message ts. For commits/PRs it's the SHA / PR number.
	 */
	source_id: string;
	timestamp: string;
	project: string;
	cwd: string;
	/**
	 * Pi session ID. Populated for `ai-session` notes; empty string for
	 * notes from other surfaces. Kept as a distinct field for backwards
	 * compatibility with existing notes and downstream consumers like
	 * formatDetail / formatKnowledgeStats.
	 */
	sessionId: string;
	title: string;
	topic: string;
	summary: string;
	details: string;
	evidence: string[];
	relatedFiles: string[];
	tags: string[];
	confidence: Confidence;
}

interface DetectedKnowledge {
	title?: string;
	topic?: string;
	summary?: string;
	details?: string;
	evidence?: string[];
	relatedFiles?: string[];
	tags?: string[];
	confidence?: string;
}

interface SessionFile {
	filePath: string;
	sessionId: string;
	timestamp: string;
	cwd: string;
	project: string;
}

// ── Helpers: Transcript Extraction ─────────────────────────────────

/** Pull every text string out of a message content field. */
function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as { type?: string; text?: unknown };
		if (maybeText.type === "text" && typeof maybeText.text === "string") {
			parts.push(maybeText.text);
		}
	}
	return parts;
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function toolPath(details: any): string {
	return details?.path || details?.filePath || details?.absolutePath || details?.targetPath || "";
}

/**
 * Convert one session entry into compact text for the analyzer.
 * Tool annotations matter for tribal knowledge because they provide evidence:
 * what files were read/edited and what commands revealed the behavior.
 */
function entryToSegment(entry: any): string | null {
	if (entry.type !== "message") return null;
	const msg = entry.message;
	if (!msg?.role) return null;

	if (msg.role === "user" || msg.role === "assistant") {
		const text = compactWhitespace(extractTextParts(msg.content).join("\n"));
		if (!text) return null;
		const label = msg.role === "user" ? "User" : "Assistant";
		return `${label}: ${text}`;
	}

	if (msg.role !== "toolResult" || msg.isError) return null;

	const tool = msg.toolName;
	if (tool === "read" || tool === "write" || tool === "edit") {
		const path = toolPath(msg.details);
		return path ? `[Tool: ${tool} ${path}]` : `[Tool: ${tool}]`;
	}

	if (tool === "bash") {
		const cmd = compactWhitespace(String(msg.details?.command || "")).slice(0, 160);
		return cmd ? `[Tool: bash "${cmd}"]` : "[Tool: bash]";
	}

	if (tool === "grep" || tool === "find" || tool === "ls" || tool === "repo_map" || tool === "recall") {
		const details = JSON.stringify(msg.details ?? {}).slice(0, 180);
		return details && details !== "{}" ? `[Tool: ${tool} ${details}]` : `[Tool: ${tool}]`;
	}

	// Include only the name for MCP/internal tools to avoid leaking bulky payloads.
	if (typeof tool === "string" && (tool.startsWith("mcp_") || tool.includes("search") || tool.includes("metadata"))) {
		return `[Tool: ${tool}]`;
	}

	return null;
}

/**
 * Build a compact transcript from session entries.
 * Uses head+tail truncation so the analyzer sees both initial intent and final outcome.
 */
export function extractConversation(entries: any[], maxChars = MAX_CHARS_FOR_ANALYSIS): string {
	const segments: string[] = [];

	for (const entry of entries) {
		const segment = entryToSegment(entry);
		if (segment) segments.push(segment);
	}

	const fullText = segments.join("\n\n");
	if (fullText.length <= maxChars) return fullText;

	const headBudget = Math.floor(maxChars * (1 - TAIL_BUDGET_RATIO));
	const tailBudget = maxChars - headBudget;

	const headParts: string[] = [];
	let headLen = 0;
	for (const segment of segments) {
		if (headLen + segment.length + 2 > headBudget) break;
		headParts.push(segment);
		headLen += segment.length + 2;
	}

	const tailParts: string[] = [];
	let tailLen = 0;
	for (let i = segments.length - 1; i >= headParts.length; i--) {
		const segment = segments[i];
		if (tailLen + segment.length + 2 > tailBudget) break;
		tailParts.unshift(segment);
		tailLen += segment.length + 2;
	}

	return [...headParts, "[...conversation truncated: middle omitted...]", ...tailParts].join("\n\n");
}

function countConversationMessages(entries: any[]): number {
	return entries.filter(
		(e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"),
	).length;
}

// ── Helpers: Note Normalization / Search / Reporting ───────────────

function uniqueStrings(values: unknown, options: { lower?: boolean; stripAt?: boolean } = {}): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	const out: string[] = [];

	for (const value of values) {
		if (typeof value !== "string") continue;
		let normalized = value.trim();
		if (options.stripAt) normalized = normalized.replace(/^@/, "");
		if (options.lower) normalized = normalized.toLowerCase();
		normalized = normalized.replace(/\s+/g, " ");
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function normalizeConfidence(value: unknown): Confidence {
	return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeTopic(topic: unknown): string {
	const value = typeof topic === "string" ? topic.trim().toLowerCase() : "general";
	return value.replace(/\s+/g, "-") || "general";
}

function oneLine(value: unknown, fallback: string): string {
	const text = typeof value === "string" ? compactWhitespace(value) : "";
	return text || fallback;
}

export function normalizeKnowledgeNote(
	raw: DetectedKnowledge,
): Omit<KnowledgeNote, "id" | "source_type" | "source_id" | "timestamp" | "project" | "cwd" | "sessionId"> {
	const summary = oneLine(raw.summary, oneLine(raw.title, "Untitled knowledge note"));
	const title = oneLine(raw.title, summary).slice(0, 90);
	const topic = normalizeTopic(raw.topic);
	const tags = uniqueStrings([...(Array.isArray(raw.tags) ? raw.tags : []), topic], { lower: true });

	return {
		title,
		topic,
		summary,
		details: typeof raw.details === "string" ? raw.details.trim() : summary,
		evidence: uniqueStrings(raw.evidence),
		relatedFiles: uniqueStrings(raw.relatedFiles, { stripAt: true }),
		tags,
		confidence: normalizeConfidence(raw.confidence),
	};
}

function makeKnowledgeNote(
	raw: DetectedKnowledge,
	meta: {
		project: string;
		cwd: string;
		sessionId: string;
		timestamp: string;
		/** Defaults to "ai-session" since that's the only surface today. */
		source_type?: SourceType;
		/** Defaults to sessionId when source_type is "ai-session". */
		source_id?: string;
	},
): KnowledgeNote {
	const source_type = meta.source_type ?? "ai-session";
	const source_id = meta.source_id ?? meta.sessionId ?? "";
	return {
		id: randomUUID(),
		source_type,
		source_id,
		timestamp: meta.timestamp,
		project: meta.project,
		cwd: meta.cwd,
		sessionId: meta.sessionId,
		...normalizeKnowledgeNote(raw),
	};
}

function searchableText(note: KnowledgeNote): string {
	return [
		note.title,
		note.topic,
		note.summary,
		note.details,
		note.project,
		note.cwd,
		...note.evidence,
		...note.relatedFiles,
		...note.tags,
	]
		.join("\n")
		.toLowerCase();
}

export function knowledgeMatchesQuery(note: KnowledgeNote, query: string): boolean {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (tokens.length === 0) return true;

	const haystack = searchableText(note);
	return tokens.every((token) => haystack.includes(token));
}

function noteFingerprint(note: Pick<KnowledgeNote, "topic" | "title" | "summary">): string {
	return `${note.topic}|${note.title}|${note.summary}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function isDuplicateKnowledge(candidate: KnowledgeNote, existing: KnowledgeNote[]): boolean {
	const key = noteFingerprint(candidate);
	return existing.some((note) => noteFingerprint(note) === key);
}

function formatDate(timestamp: string): string {
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return timestamp;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatKnowledgeReport(notes: KnowledgeNote[], title = "Tribal Knowledge Report"): string {
	if (notes.length === 0) return `# ${title}\n\nNo tribal knowledge notes recorded yet.\n`;

	const sorted = [...notes].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	const byTopic = new Map<string, KnowledgeNote[]>();
	for (const note of sorted) {
		if (!byTopic.has(note.topic)) byTopic.set(note.topic, []);
		byTopic.get(note.topic)!.push(note);
	}

	const lines: string[] = [`# ${title}`, ""];
	for (const [topic, topicNotes] of [...byTopic.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`## ${topic}`, "");
		for (const note of topicNotes) {
			lines.push(`- **${note.title}** _(${note.project}, ${formatDate(note.timestamp)}, ${note.confidence} confidence)_`);
			lines.push(`  ${note.summary}`);
			if (note.details && note.details !== note.summary) lines.push(`  ${note.details}`);
			if (note.relatedFiles.length > 0) lines.push(`  Files: ${note.relatedFiles.join(", ")}`);
			if (note.tags.length > 0) lines.push(`  Tags: ${note.tags.join(", ")}`);
		}
		lines.push("");
	}

	const projects = new Set(notes.map((n) => n.project));
	const sessions = new Set(notes.map((n) => n.sessionId));
	lines.push("---");
	lines.push(
		`_${notes.length} knowledge note${notes.length !== 1 ? "s" : ""} from ${sessions.size} session${sessions.size !== 1 ? "s" : ""} across ${projects.size} project${projects.size !== 1 ? "s" : ""} · Auto-tracked by tribal-knowledge_`,
	);

	return lines.join("\n");
}

function formatBrowseLine(note: KnowledgeNote): string {
	const date = new Date(note.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
	const summary = note.title.length > 58 ? note.title.slice(0, 55) + "..." : note.title;
	return `${date}  🧠 ${summary}  [${note.topic}] (${note.project})`;
}

function formatDetail(note: KnowledgeNote): string {
	return [
		`🧠  ${note.title}`,
		"",
		`Topic:      ${note.topic}`,
		`Project:    ${note.project}`,
		`Date:       ${new Date(note.timestamp).toLocaleString()}`,
		`Confidence: ${note.confidence}`,
		`Session:    ${note.sessionId.slice(0, 8)}`,
		`Path:       ${note.cwd}`,
		"",
		"Summary:",
		note.summary,
		"",
		"Details:",
		note.details || "—",
		"",
		`Files:      ${note.relatedFiles.length > 0 ? note.relatedFiles.join(", ") : "—"}`,
		`Tags:       ${note.tags.length > 0 ? note.tags.join(", ") : "—"}`,
		"",
		"Evidence:",
		...(note.evidence.length > 0 ? note.evidence.map((e) => `- ${e}`) : ["—"]),
	].join("\n");
}

export function formatKnowledgeStats(notes: KnowledgeNote[], analyzedSessionCount: number): string {
	const projects = new Set(notes.map((note) => note.project));
	const sessionsWithNotes = new Set(notes.map((note) => note.sessionId));
	return [
		"🧠 Tribal knowledge is loaded.",
		`Notes: ${notes.length}`,
		`Sessions with notes: ${sessionsWithNotes.size}`,
		`Analyzed sessions: ${analyzedSessionCount}`,
		`Projects: ${projects.size}`,
		`Storage: ${KNOWLEDGE_FILE}`,
	].join("\n");
}

export type BackfillAction = "scan" | "start" | "status" | "stop";

export function parseBackfillAction(args: string): BackfillAction | undefined {
	const lower = args.trim().toLowerCase().replace(/\s+/g, " ");
	if (lower === "backfill") return "scan";
	if (lower === "backfill start" || lower === "backfill run" || lower === "backfill yes" || lower === "backfill --yes") return "start";
	if (lower === "backfill status" || lower === "backfill progress") return "status";
	if (lower === "backfill stop" || lower === "backfill cancel") return "stop";
	return undefined;
}

export function formatBackfillPlan(scannedCount: number, candidateCount: number): string {
	if (candidateCount === 0) {
		return `Scanned ${scannedCount} session file${scannedCount !== 1 ? "s" : ""}; all substantial sessions have already been analyzed.`;
	}

	return [
		`Found ${candidateCount} unanalyzed substantial session${candidateCount !== 1 ? "s" : ""}.`,
		"Nothing is running yet, so your prompt is free.",
		"Run `/knowledge backfill start` to begin analyzing them.",
		"The backfill will run in the background and update the footer/status as it progresses.",
		"Use `/knowledge backfill status` to check progress or `/knowledge backfill stop` to stop after the current session finishes.",
	].join("\n");
}

interface BackfillJobState {
	status: "idle" | "running" | "stopping" | "done" | "failed" | "cancelled";
	startedAt?: string;
	finishedAt?: string;
	total: number;
	processed: number;
	added: number;
	errors: number;
	firstError?: string;
	currentProject?: string;
	stopRequested: boolean;
	lastScanAt?: string;
	lastScannedCount?: number;
	lastCandidateCount?: number;
}

function createIdleBackfillState(): BackfillJobState {
	return {
		status: "idle",
		total: 0,
		processed: 0,
		added: 0,
		errors: 0,
		stopRequested: false,
	};
}

function formatBackfillStatus(state: BackfillJobState): string {
	const lines = [`🧠 Backfill status: ${state.status}`];
	if (state.lastScanAt) {
		lines.push(`Last scan: ${state.lastCandidateCount ?? 0} candidate(s) from ${state.lastScannedCount ?? 0} session file(s)`);
	}
	if (state.total > 0) {
		lines.push(`Progress: ${state.processed}/${state.total}`);
		lines.push(`Added notes: ${state.added}`);
		lines.push(`Errors: ${state.errors}`);
		if (state.currentProject) lines.push(`Current project: ${state.currentProject}`);
	}
	if (state.firstError) lines.push(`First error: ${state.firstError.slice(0, 160)}`);
	if (state.startedAt) lines.push(`Started: ${state.startedAt}`);
	if (state.finishedAt) lines.push(`Finished: ${state.finishedAt}`);
	return lines.join("\n");
}

function isStaleContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("ctx is stale") || message.includes("stale after session replacement or reload");
}

function safeSetStatus(ctx: any, text: string | undefined): void {
	try {
		if (ctx?.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, text);
	} catch {
		// The command context can become stale after /reload or session replacement.
	}
}

function safeNotify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	} catch {
		// Avoid surfacing stale-context errors after /reload.
	}
}

// ── Helpers: Storage ───────────────────────────────────────────────

async function ensureDir(): Promise<void> {
	await mkdir(KNOWLEDGE_DIR, { recursive: true });
}

async function appendKnowledge(note: KnowledgeNote): Promise<void> {
	await ensureDir();
	await appendFile(KNOWLEDGE_FILE, JSON.stringify(note) + "\n", "utf8");
}

async function readAllKnowledge(): Promise<KnowledgeNote[]> {
	try {
		const content = await readFile(KNOWLEDGE_FILE, "utf8");
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function writeKnowledge(notes: KnowledgeNote[]): Promise<void> {
	await ensureDir();
	await writeFile(KNOWLEDGE_FILE, notes.map((note) => JSON.stringify(note)).join("\n") + (notes.length ? "\n" : ""), "utf8");
}

async function readAnalyzedSessionIds(): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		const content = await readFile(ANALYZED_SESSIONS_FILE, "utf8");
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) {
			for (const id of parsed) if (typeof id === "string") ids.add(id);
		}
	} catch {
		// Missing or malformed marker file — fall back to notes below.
	}

	for (const note of await readAllKnowledge()) {
		if (note.sessionId) ids.add(note.sessionId);
	}
	return ids;
}

async function markSessionAnalyzed(sessionId: string): Promise<void> {
	if (!sessionId) return;
	const ids = await readAnalyzedSessionIds();
	ids.add(sessionId);
	await ensureDir();
	await writeFile(ANALYZED_SESSIONS_FILE, JSON.stringify([...ids].sort(), null, 2) + "\n", "utf8");
}

async function sessionAlreadyAnalyzed(sessionId: string): Promise<boolean> {
	return (await readAnalyzedSessionIds()).has(sessionId);
}

// ── Helpers: Session Discovery (for backfill) ──────────────────────

async function parseSessionFile(filePath: string): Promise<{ meta: SessionFile; entries: any[] } | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n").filter((line) => line.trim());
		if (lines.length === 0) return null;

		const header = JSON.parse(lines[0]);
		if (header.type !== "session" || !header.id) return null;

		const entries: any[] = [];
		for (let i = 1; i < lines.length; i++) {
			try {
				entries.push(JSON.parse(lines[i]));
			} catch {
				// Ignore malformed trailing/partial lines.
			}
		}

		const cwd = header.cwd || "";
		return {
			meta: {
				filePath,
				sessionId: header.id,
				timestamp: header.timestamp || new Date().toISOString(),
				cwd,
				project: basename(cwd || "unknown"),
			},
			entries,
		};
	} catch {
		return null;
	}
}

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
				if (file.endsWith(".jsonl")) paths.push(join(dirPath, file));
			}
		}
	} catch {
		// Sessions directory might not exist yet.
	}
	return paths;
}

async function discoverBackfillCandidates(currentSessionId?: string): Promise<{ paths: string[]; candidates: { meta: SessionFile; entries: any[] }[] }> {
	const paths = await discoverSessionFiles();
	const analyzed = await readAnalyzedSessionIds();
	const candidates: { meta: SessionFile; entries: any[] }[] = [];

	for (const path of paths) {
		const parsed = await parseSessionFile(path);
		if (!parsed) continue;
		if (parsed.meta.sessionId === currentSessionId) continue;
		if (analyzed.has(parsed.meta.sessionId)) continue;
		if (countConversationMessages(parsed.entries) < MIN_MESSAGE_COUNT) continue;
		if (extractConversation(parsed.entries).length < MIN_CONVERSATION_CHARS) continue;
		candidates.push(parsed);
	}

	candidates.sort((a, b) => (a.meta.timestamp || "").localeCompare(b.meta.timestamp || ""));
	return { paths, candidates };
}

function sessionIdFromContext(ctx: any): string | undefined {
	const direct = ctx.sessionManager.getSessionId?.();
	if (typeof direct === "string" && direct) return direct;

	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (!sessionFile) return undefined;
	const fileBase = basename(sessionFile, ".jsonl");
	const uuidIdx = fileBase.indexOf("_");
	return uuidIdx >= 0 ? fileBase.slice(uuidIdx + 1) : fileBase;
}

// ── Helpers: Claude API Calls ──────────────────────────────────────

const ANALYSIS_PROMPT = `You are reviewing an AI-assisted engineering session to capture TRIBAL KNOWLEDGE: durable facts, gotchas, procedures, architecture context, project conventions, and debugging lessons that would help a future engineer or AI agent avoid rediscovery.

CRITICAL RULES:
- Return AT MOST 0-4 notes. Most sessions have 0-2.
- Be conservative. Only capture knowledge that is reusable beyond this single conversation.
- Each note must be supported by the transcript. Do not infer beyond evidence.
- Capture surprising or undocumented things: repo conventions, deployment quirks, debugging commands that worked, architecture relationships, operational runbooks, test/build gotchas, naming/location conventions.
- Do NOT capture generic programming advice, normal workflow steps, transient plans, todos, opinions, speculation, secrets, credentials, tokens, personal/private info, or performance-review accomplishments.
- Prefer specific, future-useful notes over broad summaries.
- If nothing durable was learned, return exactly: []

Project: {PROJECT}

Session transcript:
{CONVERSATION}

Respond with ONLY a JSON array (no markdown fences, no explanation). Each item:
{
  "title": "short human-readable title",
  "topic": "kebab-case topic like deployment|testing|architecture|repo-layout|debugging|tooling|auth",
  "summary": "one sentence future-useful takeaway",
  "details": "2-4 sentences with concrete context, commands, constraints, or caveats",
  "evidence": ["brief transcript-backed evidence, e.g. file/command/observed behavior"],
  "relatedFiles": ["relative/file/path if any"],
  "tags": ["searchable", "keywords"],
  "confidence": "high|medium|low"
}`;

/** Track which model works to avoid retrying 404s on every call. */
let workingModel: string | undefined;

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

function parseJsonArray(text: string): any[] {
	const cleaned = text
		.replace(/```json\n?/g, "")
		.replace(/```\n?/g, "")
		.trim();

	try {
		const parsed = JSON.parse(cleaned);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		const lastClose = cleaned.lastIndexOf("}");
		if (lastClose > 0) {
			try {
				const recovered = JSON.parse(cleaned.slice(0, lastClose + 1) + "]");
				return Array.isArray(recovered) ? recovered : [];
			} catch {
				return [];
			}
		}
		return [];
	}
}

async function analyzeForKnowledge(
	conversation: string,
	project: string,
	apiKey: string,
	baseUrl: string,
): Promise<DetectedKnowledge[]> {
	const prompt = ANALYSIS_PROMPT.replace("{PROJECT}", project).replace("{CONVERSATION}", conversation);
	const headers = buildHeaders(apiKey);
	const modelsToTry = workingModel ? [workingModel] : ANALYSIS_MODELS;

	for (const model of modelsToTry) {
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				max_tokens: 2048,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
		});

		if (response.status === 404) continue;
		if (!response.ok) {
			throw new Error(`Anthropic API ${response.status}: ${await response.text().catch(() => "unknown")}`);
		}

		workingModel = model;
		const data = await response.json();
		const text = data?.content?.[0]?.text;
		if (!text) return [];

		return parseJsonArray(text).filter((note: any) => note?.summary || note?.title || note?.details);
	}

	throw new Error(`No working model found. Tried: ${ANALYSIS_MODELS.join(", ")}`);
}

async function analyzeAndStoreSession(meta: SessionFile, entries: any[], apiKey: string, baseUrl: string): Promise<number> {
	const conversation = extractConversation(entries);
	if (countConversationMessages(entries) < MIN_MESSAGE_COUNT || conversation.length < MIN_CONVERSATION_CHARS) {
		await markSessionAnalyzed(meta.sessionId);
		return 0;
	}

	const detected = await analyzeForKnowledge(conversation, meta.project, apiKey, baseUrl);
	const existing = await readAllKnowledge();
	let added = 0;

	for (const raw of detected) {
		const note = makeKnowledgeNote(raw, meta);
		if (isDuplicateKnowledge(note, existing)) continue;
		await appendKnowledge(note);
		existing.push(note);
		added++;
	}

	await markSessionAnalyzed(meta.sessionId);
	return added;
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let backfillState = createIdleBackfillState();

	function startBackfillJob(candidates: { meta: SessionFile; entries: any[] }[], apiKey: string, baseUrl: string, ctx: any): void {
		backfillState = {
			status: "running",
			startedAt: new Date().toISOString(),
			total: candidates.length,
			processed: 0,
			added: 0,
			errors: 0,
			stopRequested: false,
			lastScanAt: backfillState.lastScanAt,
			lastScannedCount: backfillState.lastScannedCount,
			lastCandidateCount: candidates.length,
		};

		void (async () => {
			for (const candidate of candidates) {
				if (backfillState.stopRequested) {
					backfillState.status = "cancelled";
					break;
				}

				backfillState.processed++;
				backfillState.currentProject = candidate.meta.project;
				safeSetStatus(
					ctx,
					`🧠 Backfill ${backfillState.processed}/${backfillState.total} (${candidate.meta.project}, ${backfillState.added} notes)...`,
				);

				try {
					backfillState.added += await analyzeAndStoreSession(candidate.meta, candidate.entries, apiKey, baseUrl);
				} catch (e: any) {
					backfillState.errors++;
					backfillState.firstError ??= e?.message || String(e);
				}

				if (backfillState.processed < backfillState.total) await new Promise((resolve) => setTimeout(resolve, 300));
			}

			backfillState.finishedAt = new Date().toISOString();
			backfillState.currentProject = undefined;
			if (backfillState.status === "running") {
				backfillState.status = backfillState.errors > 0 && backfillState.added === 0 ? "failed" : "done";
			}

			if (backfillState.status === "cancelled") {
				safeNotify(ctx, `🛑 Tribal knowledge backfill stopped after ${backfillState.processed}/${backfillState.total} sessions.`, "warning");
			} else if (backfillState.status === "failed") {
				safeNotify(ctx, `❌ Backfill failed: ${backfillState.errors}/${backfillState.processed} sessions errored. First error: ${backfillState.firstError?.slice(0, 120)}`, "error");
			} else {
				const errMsg = backfillState.errors > 0 ? ` (${backfillState.errors} failed)` : "";
				safeNotify(
					ctx,
					`🧠 Backfill complete! Added ${backfillState.added} knowledge note${backfillState.added !== 1 ? "s" : ""} across ${backfillState.processed} sessions${errMsg}.`,
					backfillState.added > 0 ? "info" : "warning",
				);
			}
			safeSetStatus(ctx, undefined);
		})().catch((error) => {
			backfillState.status = "failed";
			backfillState.finishedAt = new Date().toISOString();
			backfillState.firstError = error instanceof Error ? error.message : String(error);
			safeNotify(ctx, `Knowledge backfill failed: ${backfillState.firstError.slice(0, 160)}`, "error");
			safeSetStatus(ctx, undefined);
		});
	}

	// ── Auto-detect tribal knowledge at session end ────────────────

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			// Reloads are usually development/config churn, not a real session ending.
			if ((event as any).reason === "reload") {
				backfillState.stopRequested = true;
				return;
			}

			const sessionId = sessionIdFromContext(ctx);
			if (!sessionId) return;
			if (await sessionAlreadyAnalyzed(sessionId)) return;

			const entries = ctx.sessionManager.getBranch();
			if (countConversationMessages(entries) < MIN_MESSAGE_COUNT) return;

			const conversation = extractConversation(entries);
			if (conversation.length < MIN_CONVERSATION_CHARS) return;

			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			if (!apiKey) return;

			const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
			safeSetStatus(ctx, "🧠 Checking for tribal knowledge...");

			const added = await analyzeAndStoreSession(
				{
					filePath: ctx.sessionManager.getSessionFile?.() || "",
					sessionId,
					timestamp: new Date().toISOString(),
					cwd: ctx.cwd,
					project: basename(ctx.cwd),
				},
				entries,
				apiKey,
				baseUrl,
			);

			safeSetStatus(ctx, added > 0 ? `🧠 Logged ${added} knowledge note${added !== 1 ? "s" : ""}!` : undefined);
		} catch {
			safeSetStatus(ctx, undefined);
		}
	});

	// ── Command: /knowledge ────────────────────────────────────────

	pi.registerCommand("knowledge", {
		description: "Browse, search, and export auto-captured tribal knowledge",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				{ value: "status", label: "status — Show extension state and storage path" },
				{ value: "search", label: "search <query> — Search stored knowledge" },
				{ value: "report", label: "report — Generate a markdown knowledge report" },
				{ value: "all", label: "all — Browse all knowledge notes" },
				{ value: "backfill", label: "backfill — Scan past sessions and show non-blocking plan" },
				{ value: "backfill start", label: "backfill start — Start background analysis" },
				{ value: "backfill status", label: "backfill status — Show current backfill progress" },
				{ value: "backfill stop", label: "backfill stop — Stop after current session finishes" },
				{ value: "clear", label: "clear — Show clear instructions" },
				{ value: "clear confirm", label: "clear confirm — Clear all stored knowledge" },
			];
			return options.filter((option) => option.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			safeSetStatus(ctx, "🧠 Starting tribal knowledge command...");
			let keepStatus = false;

			try {
				// ── /knowledge status ───────────────────────────────────
				if (lower === "status") {
					safeSetStatus(ctx, "🧠 Reading tribal knowledge status...");
					const notes = await readAllKnowledge();
					const analyzed = await readAnalyzedSessionIds();
					await ctx.ui.editor("Tribal Knowledge Status:", formatKnowledgeStats(notes, analyzed.size));
					return;
				}

				// ── /knowledge report ───────────────────────────────────
				if (lower === "report") {
					safeSetStatus(ctx, "🧠 Loading notes for knowledge report...");
					const notes = await readAllKnowledge();
					if (notes.length === 0) {
						safeNotify(ctx, "No tribal knowledge notes recorded yet.", "info");
						return;
					}

					safeSetStatus(ctx, `🧠 Building report from ${notes.length} note${notes.length !== 1 ? "s" : ""}...`);
					const report = formatKnowledgeReport(notes, "Tribal Knowledge Report");
					const reportPath = join(KNOWLEDGE_DIR, "report.md");
					await ensureDir();
					await writeFile(reportPath, report, "utf8");
					safeNotify(ctx, `📄 Knowledge report saved to ${reportPath}`, "info");
					await ctx.ui.editor("Tribal Knowledge Report:", report);
					return;
				}

				// ── /knowledge search <query> ───────────────────────────
				if (lower === "search" || lower.startsWith("search ")) {
					safeSetStatus(ctx, "🧠 Preparing knowledge search...");
					let query = trimmed.replace(/^search\s*/i, "").trim();
					if (!query) {
						safeNotify(ctx, "Opening tribal knowledge search prompt...", "info");
						const input = await ctx.ui.input("Search tribal knowledge:", "deployment gotcha");
						query = input?.trim() || "";
					}
					if (!query) {
						safeNotify(ctx, "Knowledge search cancelled.", "info");
						return;
					}

					safeSetStatus(ctx, `🧠 Searching tribal knowledge for "${query}"...`);
					const notes = (await readAllKnowledge()).filter((note) => knowledgeMatchesQuery(note, query));
					if (notes.length === 0) {
						safeNotify(ctx, `No tribal knowledge matching "${query}".`, "warning");
						return;
					}

					safeSetStatus(ctx, `🧠 Found ${notes.length} matching note${notes.length !== 1 ? "s" : ""}; opening picker...`);
					const sortedNotes = notes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
					const options = sortedNotes.map(formatBrowseLine);
					const choice = await ctx.ui.select(`🧠 ${notes.length} matching knowledge note${notes.length !== 1 ? "s" : ""}`, options);
					if (choice != null) {
						const idx = options.indexOf(choice);
						if (idx >= 0) await ctx.ui.editor("Knowledge Note:", formatDetail(sortedNotes[idx]));
					} else {
						safeNotify(ctx, "Knowledge search closed.", "info");
					}
					return;
				}

				// ── /knowledge backfill [start|status|stop] ──────────────
				const backfillAction = parseBackfillAction(lower);
				if (backfillAction) {
					if (backfillAction === "status") {
						await ctx.ui.editor("Tribal Knowledge Backfill Status:", formatBackfillStatus(backfillState));
						return;
					}

					if (backfillAction === "stop") {
						if (backfillState.status !== "running") {
							safeNotify(ctx, `No backfill is currently running. Current state: ${backfillState.status}.`, "info");
							return;
						}
						backfillState.stopRequested = true;
						backfillState.status = "stopping";
						safeNotify(ctx, "🛑 Backfill will stop after the current session finishes analyzing.", "warning");
						keepStatus = true;
						return;
					}

					safeSetStatus(ctx, "🔍 Scanning sessions for tribal knowledge...");
					const { paths, candidates } = await discoverBackfillCandidates(sessionIdFromContext(ctx));
					backfillState.lastScanAt = new Date().toISOString();
					backfillState.lastScannedCount = paths.length;
					backfillState.lastCandidateCount = candidates.length;

					if (backfillAction === "scan") {
						const plan = formatBackfillPlan(paths.length, candidates.length);
						safeNotify(ctx, candidates.length > 0 ? `Found ${candidates.length} unanalyzed substantial sessions. Run /knowledge backfill start to begin.` : plan, candidates.length > 0 ? "warning" : "info");
						await ctx.ui.editor("Tribal Knowledge Backfill Plan:", plan);
						return;
					}

					if (backfillState.status === "running" || backfillState.status === "stopping") {
						safeNotify(ctx, "A tribal knowledge backfill is already running. Use /knowledge backfill status or /knowledge backfill stop.", "warning");
						keepStatus = true;
						return;
					}

					if (candidates.length === 0) {
						safeNotify(ctx, formatBackfillPlan(paths.length, 0), "info");
						return;
					}

					const apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
					if (!apiKey) {
						safeNotify(ctx, "No Anthropic API key available. Run `pi login` first.", "error");
						return;
					}
					const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

					safeNotify(ctx, `🧠 Started background backfill for ${candidates.length} session${candidates.length !== 1 ? "s" : ""}. Use /knowledge backfill status to check progress.`, "info");
					startBackfillJob(candidates, apiKey, baseUrl, ctx);
					keepStatus = true;
					return;
				}

				// ── /knowledge clear [confirm] ──────────────────────────
				if (lower === "clear") {
					safeNotify(ctx, "Clear is a destructive action. Run /knowledge clear confirm to delete stored notes and analyzed-session markers.", "warning");
					return;
				}
				if (lower === "clear confirm") {
					safeSetStatus(ctx, "🧠 Clearing stored tribal knowledge...");
					await ensureDir();
					await writeKnowledge([]);
					await writeFile(ANALYZED_SESSIONS_FILE, "[]\n", "utf8");
					safeNotify(ctx, "🗑️ Tribal knowledge cleared.", "info");
					return;
				}

				// ── /knowledge [all] — Browse ───────────────────────────
				safeSetStatus(ctx, "🧠 Loading stored tribal knowledge...");
				const allNotes = await readAllKnowledge();
				if (allNotes.length === 0) {
					safeNotify(ctx, "No tribal knowledge recorded yet. Notes are logged automatically when sessions end.", "info");
					return;
				}

				const sorted = [...allNotes].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
				const showAll = lower === "all";
				const display = showAll ? sorted : sorted.slice(0, 40);
				const options = display.map(formatBrowseLine);
				const header = showAll
					? `🧠 All ${allNotes.length} tribal knowledge notes`
					: `🧠 ${allNotes.length} total notes (showing recent ${display.length})`;
				safeSetStatus(ctx, `🧠 Loaded ${allNotes.length} note${allNotes.length !== 1 ? "s" : ""}; opening browser...`);
				safeNotify(ctx, `Loaded ${allNotes.length} tribal knowledge note${allNotes.length !== 1 ? "s" : ""}.`, "info");
				const choice = await ctx.ui.select(header, options);

				if (choice != null) {
					const idx = options.indexOf(choice);
					if (idx >= 0) await ctx.ui.editor("Knowledge Note:", formatDetail(display[idx]));
				} else {
					safeNotify(ctx, "Knowledge browser closed.", "info");
				}
			} catch (error) {
				if (isStaleContextError(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				safeNotify(ctx, `Knowledge command failed: ${message.slice(0, 160)}`, "error");
			} finally {
				if (!keepStatus && backfillState.status !== "running" && backfillState.status !== "stopping") safeSetStatus(ctx, undefined);
			}
		},
	});
}
