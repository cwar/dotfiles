/**
 * Session Reference Extension
 *
 * Lets you reference previous pi sessions in your current conversation.
 *
 * Usage:
 *   /ref         — Browse sessions from this project and insert a reference tag
 *   /ref all     — Browse ALL sessions across all projects
 *
 * Then just talk normally:
 *   "Continue from [session:5eb45466] where we left off with the auth refactor"
 *
 * The extension auto-detects [session:ID] tags, loads the referenced conversation,
 * and injects it as context for the LLM. The LLM can also call the `load_session`
 * tool to inspect sessions on its own.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { open as fsOpen, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Text } from "@mariozechner/pi-tui";

// ── Constants ──────────────────────────────────────────────────────────

const SESSIONS_BASE = join(homedir(), ".pi", "agent", "sessions");
const SESSION_REF_PATTERN = /\[session:([a-f0-9-]+)\]/gi;
const MAX_CONTEXT_CHARS = 30_000;
const META_READ_BYTES = 16_384;
const CUSTOM_TYPE = "session-ref";

// ── Types ──────────────────────────────────────────────────────────────

interface SessionMeta {
	filePath: string;
	id: string;
	shortId: string;
	timestamp: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
}

// ── Helpers: File I/O ──────────────────────────────────────────────────

/** Read the first N bytes of a file without loading the whole thing. */
async function readFirstChunk(path: string, bytes = META_READ_BYTES): Promise<string> {
	const fh = await fsOpen(path, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await fh.read(buf, 0, bytes, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await fh.close();
	}
}

// ── Helpers: Parsing ───────────────────────────────────────────────────

/** Extract the first text string from a message content field. */
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

/** Parse session metadata from the first chunk of a JSONL file. */
async function readSessionMeta(filePath: string): Promise<SessionMeta | null> {
	try {
		const chunk = await readFirstChunk(filePath);
		const lines = chunk.split("\n").filter((l) => l.trim());
		if (lines.length === 0) return null;

		const header = JSON.parse(lines[0]);
		if (header.type !== "session") return null;

		let name: string | undefined;
		let firstMessage: string | undefined;

		for (let i = 1; i < lines.length; i++) {
			try {
				const entry = JSON.parse(lines[i]);
				if (entry.type === "session_info" && entry.name) {
					name = entry.name;
				}
				if (!firstMessage && entry.type === "message" && entry.message?.role === "user") {
					firstMessage = extractText(entry.message.content)?.slice(0, 120);
				}
				if (name && firstMessage) break;
			} catch {
				// skip malformed lines (e.g., partial line from chunk boundary)
			}
		}

		return {
			filePath,
			id: header.id,
			shortId: header.id.split("-")[0],
			timestamp: header.timestamp,
			cwd: header.cwd,
			name,
			firstMessage,
		};
	} catch {
		return null;
	}
}

// ── Helpers: Session Discovery ─────────────────────────────────────────

/** Walk the sessions directory and return metadata for all sessions. */
async function discoverSessions(filterCwd?: string): Promise<SessionMeta[]> {
	const results: SessionMeta[] = [];
	try {
		const dirs = await readdir(SESSIONS_BASE);
		for (const dir of dirs) {
			const dirPath = join(SESSIONS_BASE, dir);
			const dirStat = await stat(dirPath).catch(() => null);
			if (!dirStat?.isDirectory()) continue;

			const files = await readdir(dirPath).catch(() => []);
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const meta = await readSessionMeta(join(dirPath, file));
				if (meta && (!filterCwd || meta.cwd === filterCwd)) {
					results.push(meta);
				}
			}
		}
	} catch {
		// sessions dir might not exist
	}
	return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Find a single session by full or partial UUID. */
async function findSession(partialId: string): Promise<SessionMeta | null> {
	const all = await discoverSessions();
	const normalized = partialId.toLowerCase();
	return all.find((s) => s.id === normalized || s.id.startsWith(normalized)) ?? null;
}

// ── Helpers: Conversation Extraction ───────────────────────────────────

/** Read a session file and extract the user/assistant conversation as text. */
async function extractConversation(filePath: string, maxChars = MAX_CONTEXT_CHARS): Promise<string> {
	const content = await readFile(filePath, "utf8");
	const lines = content.split("\n").filter((l) => l.trim());
	const parts: string[] = [];
	let totalLength = 0;

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "compaction") {
				parts.push(`[Compaction summary: ${entry.summary?.slice(0, 200)}...]`);
				continue;
			}
			if (entry.type !== "message") continue;

			const msg = entry.message;
			if (!msg?.role) continue;

			let segment: string | undefined;

			if (msg.role === "user" || msg.role === "assistant") {
				const text = extractText(msg.content);
				if (!text?.trim()) continue;
				const label = msg.role === "user" ? "User" : "Assistant";
				segment = `${label}: ${text.trim()}`;
			} else if (msg.role === "toolResult" && msg.isError) {
				// Include error results — they're often important context
				const text = extractText(msg.content);
				if (text) segment = `Tool Error (${msg.toolName}): ${text.trim().slice(0, 200)}`;
			}

			if (!segment) continue;

			if (totalLength + segment.length > maxChars) {
				parts.push("[...conversation truncated...]");
				break;
			}

			parts.push(segment);
			totalLength += segment.length;
		} catch {
			// skip unparseable lines
		}
	}

	return parts.join("\n\n");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Track which sessions have already been injected in this conversation
	// to avoid duplicate context on repeated references.
	const loadedSessions = new Set<string>();

	/** Rebuild the loadedSessions set from the current session entries. */
	function rebuildLoadedSet(entries: any[]) {
		loadedSessions.clear();
		for (const entry of entries) {
			if (entry.type === "custom_message" && entry.customType === CUSTOM_TYPE) {
				const ids: string[] = entry.details?.sessionIds ?? [];
				for (const id of ids) loadedSessions.add(id);
			}
		}
	}

	// ── State Reconstruction ───────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		rebuildLoadedSet(ctx.sessionManager.getEntries());
	});

	pi.on("session_switch", async (_event, ctx) => {
		rebuildLoadedSet(ctx.sessionManager.getEntries());
	});

	// ── Command: /ref ──────────────────────────────────────────────────

	pi.registerCommand("ref", {
		description: "Browse sessions and insert a [session:ID] reference",
		handler: async (args, ctx) => {
			const showAll = args.trim().toLowerCase() === "all";

			ctx.ui.setStatus(CUSTOM_TYPE, "Loading sessions...");
			const sessions = await discoverSessions(showAll ? undefined : ctx.cwd);
			ctx.ui.setStatus(CUSTOM_TYPE, undefined);

			// Exclude the current session
			const currentId = ctx.sessionManager.getSessionId();
			const filtered = sessions.filter((s) => s.id !== currentId);

			if (filtered.length === 0) {
				ctx.ui.notify(
					showAll
						? "No other sessions found."
						: "No sessions for this project. Try /ref all for all projects.",
					"warning",
				);
				return;
			}

			// Build display options
			const options = filtered.slice(0, 80).map((s) => {
				const date = new Date(s.timestamp).toLocaleDateString("en-US", {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				});
				const label = s.name ?? s.firstMessage ?? "(empty session)";
				const truncatedLabel = label.length > 70 ? label.slice(0, 67) + "..." : label;
				const project = showAll && s.cwd !== ctx.cwd ? ` 📁 ${s.cwd.split("/").slice(-2).join("/")}` : "";
				return `${s.shortId}  ${date}  ${truncatedLabel}${project}`;
			});

			const choice = await ctx.ui.select("Select a session to reference:", options);
			if (choice == null) return;

			const idx = options.indexOf(choice);
			if (idx < 0) return;

			const session = filtered[idx];
			ctx.ui.pasteToEditor(`[session:${session.shortId}] `);
			ctx.ui.notify(`Inserted reference to: ${session.name ?? session.firstMessage?.slice(0, 50) ?? session.shortId}`, "info");
		},
	});

	// ── Auto-Injection: Detect [session:ID] and inject context ─────────

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.prompt;
		if (!prompt) return;

		// Find all session references in the prompt
		const refs: string[] = [];
		let match;
		const pattern = new RegExp(SESSION_REF_PATTERN.source, SESSION_REF_PATTERN.flags);
		while ((match = pattern.exec(prompt)) !== null) {
			refs.push(match[1]);
		}

		if (refs.length === 0) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		const contextParts: string[] = [];
		const resolvedIds: string[] = [];

		for (const ref of refs) {
			const session = await findSession(ref);

			if (!session) {
				contextParts.push(`⚠ Session "${ref}" not found.`);
				continue;
			}

			// Skip self-references
			if (session.id === currentSessionId) {
				contextParts.push(`⚠ Session "${ref}" is the current session — skipped.`);
				continue;
			}

			// Skip already-loaded sessions
			if (loadedSessions.has(session.id)) {
				contextParts.push(
					`ℹ Session "${session.name ?? session.shortId}" was already loaded earlier in this conversation.`,
				);
				continue;
			}

			const conversation = await extractConversation(session.filePath);
			const label = session.name ?? session.firstMessage?.slice(0, 80) ?? "unnamed session";
			const date = new Date(session.timestamp).toISOString().split("T")[0];

			contextParts.push(
				[
					`━━ Referenced Session: ${label} ━━`,
					`ID: ${session.shortId} | Date: ${date} | Project: ${session.cwd}`,
					"",
					conversation || "(empty conversation)",
					"",
					`━━ End of referenced session ━━`,
				].join("\n"),
			);

			resolvedIds.push(session.id);
			loadedSessions.add(session.id);
		}

		if (contextParts.length === 0) return;

		const content = [
			"The user is referencing previous conversation session(s). Here is the context from those sessions. Use this to understand what was previously discussed and continue the work:",
			"",
			...contextParts,
		].join("\n");

		return {
			message: {
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details: {
					sessionIds: resolvedIds,
					sessionCount: resolvedIds.length,
				},
			},
		};
	});

	// ── Tool: load_session ─────────────────────────────────────────────

	pi.registerTool({
		name: "load_session",
		label: "Load Session",
		description:
			"Load conversation context from a previous pi session by its ID. " +
			"Use when the user references a past session or when you need to look up what was discussed in a previous conversation. " +
			"The session ID is the UUID shown in [session:ID] tags or the short hex prefix.",
		promptSnippet: "Load context from a previous pi session by ID",
		promptGuidelines: [
			"When a user references a previous session with [session:ID], context is auto-injected. Use load_session only if you need to re-examine or load additional detail from a session.",
		],
		parameters: Type.Object({
			sessionId: Type.String({
				description: "Full or partial session UUID (e.g. '5eb45466' or '5eb45466-14a8-401b-a6c1-3de8294cb141')",
			}),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum characters of conversation to return (default: 30000)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const session = await findSession(params.sessionId);
			if (!session) {
				throw new Error(
					`Session not found for ID: "${params.sessionId}". ` +
						"Ensure the ID is correct — it should be the UUID or first 8 hex chars shown in [session:ID] tags.",
				);
			}

			const conversation = await extractConversation(session.filePath, params.maxChars ?? MAX_CONTEXT_CHARS);
			const label = session.name ?? session.firstMessage?.slice(0, 80) ?? "unnamed session";
			const date = new Date(session.timestamp).toISOString().split("T")[0];

			const result = [
				`Session: ${label}`,
				`ID: ${session.id}`,
				`Short ID: ${session.shortId}`,
				`Date: ${date}`,
				`Project: ${session.cwd}`,
				"",
				"─── Conversation ───",
				"",
				conversation || "(empty conversation)",
			].join("\n");

			return {
				content: [{ type: "text", text: result }],
				details: {
					sessionId: session.id,
					shortId: session.shortId,
					name: label,
					cwd: session.cwd,
					timestamp: session.timestamp,
				},
			};
		},
	});

	// ── Message Renderer ───────────────────────────────────────────────

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, options, theme) => {
		const { expanded } = options;
		const count = (message as any).details?.sessionCount ?? 0;
		const ids: string[] = (message as any).details?.sessionIds ?? [];
		const shortIds = ids.map((id: string) => id.slice(0, 8));

		if (!expanded) {
			// Collapsed view: compact one-liner
			const label = count === 1 ? `Referenced session: ${shortIds[0]}` : `Referenced ${count} session(s): ${shortIds.join(", ")}`;
			const line = theme.fg("accent", "📎 ") + theme.fg("muted", label) + theme.fg("dim", "  (Ctrl+O to expand)");
			return new Text(line, 0, 0);
		}

		// Expanded view: show the full injected content
		const content = typeof message.content === "string" ? message.content : "(no content)";
		const header = theme.fg("accent", "📎 Session Reference Context") + "\n";
		return new Text(header + theme.fg("dim", content), 0, 0);
	});
}
