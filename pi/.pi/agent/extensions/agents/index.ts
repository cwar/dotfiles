/**
 * Agent View extension — Claude-Code-style background pi sessions.
 *
 * Provides a full-screen view of every background pi session, lets you
 * dispatch new ones from a prompt, peek at their latest output, reply
 * without leaving the view, and attach to take over the conversation.
 *
 * User surface:
 *   /agents             open the agent view
 *   /dispatch <prompt>  start a background session running <prompt>
 *   /bgsessions         alias for /agents
 *   Alt+A               shortcut for /agents
 *   pi tool: agent_dispatch (also exposed to the AI for delegation)
 *   pi tool: agent_list
 *   pi tool: agent_stop
 *
 * Self-disable inside background runners:
 *   When AGENTS_RUNNER=1 is set in the environment (which the runner sets
 *   for its child pi), the dispatch tool / commands are still registered
 *   but they refuse to spawn additional background sessions. This avoids
 *   accidentally creating an exponentially-branching tree of detached pi
 *   processes when an agent decides "let me delegate this to another
 *   agent" several levels deep. The AI can still LIST and PEEK at sibling
 *   sessions but cannot create new ones.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

import * as supervisor from "./supervisor.js";
import { formatActivity, formatFooterStatus, parseDispatchInput } from "./presentation.js";
import { AgentView, type ViewResult } from "./view.js";

const IS_RUNNER = process.env.AGENTS_RUNNER === "1";

export default function agentView(pi: ExtensionAPI): void {
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let viewOpen = false;

	pi.on("session_start", async (_event, ctx) => {
		try {
			const r = await supervisor.reconcile();
			if (r.rescued > 0) ctx.ui.notify(`agents: marked ${r.rescued} stale session(s) as failed`, "info");
			if (r.reaped > 0) ctx.ui.notify(`agents: reaped ${r.reaped} orphaned session(s)`, "warning");
		} catch (e: any) {
			ctx.ui.notify(`agents: reconcile failed: ${e?.message ?? e}`, "warning");
		}
		if (IS_RUNNER || ctx.mode !== "tui") return;
		let ownTimer: ReturnType<typeof setInterval> | null = null;
		const stop = () => {
			if (ownTimer) clearInterval(ownTimer);
			if (statusTimer === ownTimer) statusTimer = null;
			ownTimer = null;
		};
		const tick = async () => {
			try {
				await refresh();
			} catch {
				// ctx goes stale after reload/session switch; this timer belongs to the old session.
				stop();
			}
		};
		const refresh = async () => {
			const status = formatFooterStatus(supervisor.list());
			ctx.ui.setStatus("agents", status ? ctx.ui.theme.fg("accent", status) : undefined);
			if (viewOpen || !ctx.isIdle()) return;
			const selectedId = consumeOpenRequest(process.pid);
			if (!selectedId) return;
			viewOpen = true;
			try {
				await openAgentView(pi, ctx, selectedId);
			} finally {
				viewOpen = false;
			}
		};
		if (statusTimer) clearInterval(statusTimer);
		await tick();
		ownTimer = statusTimer = setInterval(() => void tick(), 1000);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = null;
		ctx.ui.setStatus("agents", undefined);
	});

	// ── Slash commands ───────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "Open the agent view (background pi sessions)",
		handler: async (_args, ctx) => {
			await openAgentView(pi, ctx);
		},
	});
	pi.registerCommand("bgsessions", {
		description: "Alias for /agents",
		handler: async (_args, ctx) => {
			await openAgentView(pi, ctx);
		},
	});

	pi.registerCommand("dispatch", {
		description: "Spawn a background session: [--idle=N] [--hard=N] <prompt>",
		handler: async (args, ctx) => {
			const parsed = parseDispatchInput(args || "");
			const prompt = parsed.prompt;
			if (prompt.length < 4) {
				ctx.ui.notify("dispatch: prompt too short (min 4 chars)", "warning");
				return;
			}
			if (IS_RUNNER) {
				ctx.ui.notify("dispatch: refusing — already inside a background runner", "warning");
				return;
			}
			try {
				const rec = supervisor.dispatch({
					prompt,
					cwd: ctx.cwd,
					idleTimeoutMinutes: parsed.idleTimeoutMinutes,
					hardTimeoutMinutes: parsed.hardTimeoutMinutes,
				});
				ctx.ui.notify(`dispatched ${rec.id} (${rec.name})`, "info");
			} catch (e: any) {
				ctx.ui.notify(`dispatch failed: ${e?.message ?? e}`, "error");
			}
		},
	});

	// ── Shortcut: Alt+A opens the view ───────────────────────────
	//
	// Ctrl+A is a built-in tree filter shortcut and Ctrl+Alt+A is used by
	// the permissions extension, so use a nearby mnemonic that avoids both.
	pi.registerShortcut("alt+a", {
		description: "Open agent view",
		handler: async (ctx) => {
			// Shortcuts only get ExtensionContext, not the full command ctx.
			// We can still open the view; for attach we fall back to a notify.
			await openAgentView(pi, ctx as any);
		},
	});

	// ── AI-callable tools ────────────────────────────────────────

	pi.registerTool({
		name: "agent_dispatch",
		label: "Dispatch Agent",
		description:
			"Start a new background pi session running the given prompt. Sessions stop after " +
			"10 idle minutes or 120 total minutes by default; both limits are overridable. Returns the " +
			"session id. The new session is independent: it can use any tools the user " +
			"has enabled, and its conversation persists in pi's session tree even after " +
			"this turn ends. Use this to delegate a self-contained task (investigate a " +
			"flaky test, draft a PR review, run a long-running experiment) instead of " +
			"doing it inline. Use agent_list / agent_peek to check on it later.",
		promptSnippet: "Start a background pi session for a delegated task",
		promptGuidelines: [
			"Use agent_dispatch when a task is self-contained, will take many tool calls, and the user would benefit from being able to keep working in this session in parallel.",
			"Don't use agent_dispatch for trivial tasks that take one or two tool calls — just do them inline.",
			"Always pass a clear, actionable prompt to agent_dispatch — it becomes the entire instruction for the new session.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Initial task instruction for the new session (>= 4 chars)" }),
			name: Type.Optional(Type.String({ description: "Optional short name for the session" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: this session's cwd)" })),
			model: Type.Optional(Type.String({ description: "Optional model pattern, e.g. 'anthropic/claude-sonnet-4-5'" })),
			idleTimeoutMinutes: Type.Optional(Type.Number({ minimum: 0, description: "Stop after this many idle minutes; 0 disables (default: 10)" })),
			hardTimeoutMinutes: Type.Optional(Type.Number({ minimum: 0, description: "Maximum total runtime in minutes; 0 disables (default: 120)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (IS_RUNNER) {
				throw new Error("agent_dispatch refused: already running inside a background agent runner");
			}
			if ((params.prompt || "").trim().length < 4) {
				throw new Error("prompt too short (min 4 chars)");
			}
			const rec = supervisor.dispatch({
				prompt: params.prompt,
				name: params.name,
				cwd: params.cwd || ctx.cwd,
				model: params.model,
				idleTimeoutMinutes: params.idleTimeoutMinutes,
				hardTimeoutMinutes: params.hardTimeoutMinutes,
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Dispatched background session ${rec.id} (${rec.name}).\n` +
							`Session file: ${rec.sessionFile}\n` +
							`Use agent_list to see all sessions, agent_peek("${rec.id}") to read its progress, ` +
							`agent_reply("${rec.id}", ...) to send it a follow-up.`,
					},
				],
				details: { job: rec },
			};
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "List Agents",
		description:
			"List all background pi sessions (running + recently exited). Returns id, " +
			"name, state, summary, and last update for each.",
		promptSnippet: "List all background pi sessions and their states",
		parameters: Type.Object({}),
		async execute() {
			const rows = supervisor.list();
			if (rows.length === 0) {
				return { content: [{ type: "text", text: "No background sessions." }], details: { jobs: [] } };
			}
			const lines = rows.map(
				(r) =>
					`${r.id}  ${r.state.padEnd(12)}  ${r.alive ? "•" : "∙"} ${r.name.padEnd(28)}  ${formatActivity(r).padEnd(24)}  ${shorten(r.summary, 50)}`,
			);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { jobs: rows },
			};
		},
	});

	pi.registerTool({
		name: "agent_peek",
		label: "Peek Agent",
		description:
			"Show the trailing transcript of a background pi session (last assistant text " +
			"and recent activity). Use to check on progress without taking over the session.",
		promptSnippet: "Read the trailing transcript of a background pi session",
		parameters: Type.Object({
			id: Type.String({ description: "Session id from agent_list" }),
			bytes: Type.Optional(Type.Number({ description: "Max bytes to return (default 8192)" })),
		}),
		async execute(_id, params) {
			const rec = supervisor.get(params.id);
			if (!rec) throw new Error(`unknown session: ${params.id}`);
			const text = supervisor.peek(params.id, params.bytes ?? 8 * 1024);
			const header =
				`${rec.id} · ${rec.state} · ${rec.summary}\n` +
				`Updated: ${rec.lastUpdate}\n` +
				"─".repeat(40) +
				"\n";
			return {
				content: [{ type: "text", text: header + (text || "(no output yet)") }],
				details: { job: rec },
			};
		},
	});

	pi.registerTool({
		name: "agent_reply",
		label: "Reply to Agent",
		description:
			"Send a follow-up message to a background pi session. Use to answer a " +
			"needs_input prompt or to push it in a new direction.",
		promptSnippet: "Send a follow-up message to a background pi session",
		parameters: Type.Object({
			id: Type.String({ description: "Session id from agent_list" }),
			message: Type.String({ description: "Message text to send" }),
		}),
		async execute(_id, params) {
			const rec = supervisor.get(params.id);
			if (!rec) throw new Error(`unknown session: ${params.id}`);
			const result = await supervisor.reply(params.id, params.message);
			if (!result?.ok) throw new Error(`reply failed: ${result?.error ?? "unknown"}`);
			return {
				content: [{ type: "text", text: `Replied to ${params.id}.` }],
				details: { job: supervisor.get(params.id), result },
			};
		},
	});

	pi.registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		description:
			"Gracefully stop a background pi session. Releases the session file so the " +
			"foreground or another runner can resume it later. The conversation transcript " +
			"is preserved in pi's session tree.",
		promptSnippet: "Stop a background pi session",
		parameters: Type.Object({
			id: Type.String({ description: "Session id from agent_list" }),
		}),
		async execute(_id, params) {
			const rec = supervisor.get(params.id);
			if (!rec) throw new Error(`unknown session: ${params.id}`);
			const stopped = await supervisor.stop(params.id);
			return {
				content: [{ type: "text", text: stopped ? `Stopped ${params.id}.` : `Stop requested for ${params.id} but runner did not exit cleanly.` }],
				details: { job: supervisor.get(params.id), stopped },
			};
		},
	});
}

// ── Open the agent view ─────────────────────────────────────────

/**
 * Open the agent view as a full-screen custom component, then act on its
 * result (attach / dispatch / reply / stop / remove). Re-opens itself in a
 * loop so that "dispatch" or "reply" return the user to the view rather
 * than dumping them at the prompt.
 *
 * `attach` is the only action that exits the loop — it takes over the
 * foreground session and the user is now in the bg session's conversation.
 */
async function openAgentView(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	initialSelectedId?: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("agents: requires interactive mode", "warning");
		return;
	}

	// Loop so the view re-opens after non-terminal actions (dispatch / reply).
	let keepOpen = true;
	while (keepOpen) {
		keepOpen = false; // default: exit after handling one action

		const result: ViewResult = await ctx.ui.custom<ViewResult>((tui, theme, _kb, done) => {
			// We need to give the AgentView a way to ask the TUI to redraw.
			// The factory's `tui` argument exposes that as `requestRender()`.
			const view = new AgentView(theme, done as (r: ViewResult) => void, () => tui.requestRender(), initialSelectedId);
			return view as any;
		});

		switch (result.action) {
			case "exit":
				return;
			case "dispatch": {
				try {
					const rec = supervisor.dispatch({ prompt: result.prompt, cwd: ctx.cwd });
					ctx.ui.notify(`dispatched ${rec.id} (${rec.name})`, "info");
				} catch (e: any) {
					ctx.ui.notify(`dispatch failed: ${e?.message ?? e}`, "error");
				}
				keepOpen = true;
				break;
			}
			case "reply": {
				try {
					const r = await supervisor.reply(result.id, result.message);
					if (!r?.ok) ctx.ui.notify(`reply failed: ${r?.error ?? "unknown"}`, "warning");
					else ctx.ui.notify(`replied to ${result.id}`, "info");
				} catch (e: any) {
					ctx.ui.notify(`reply failed: ${e?.message ?? e}`, "error");
				}
				keepOpen = true;
				break;
			}
			case "stop": {
				try {
					const stopped = await supervisor.stop(result.id);
					ctx.ui.notify(
						stopped ? `stopped ${result.id}` : `stop failed: processes still alive for ${result.id}`,
						stopped ? "info" : "error",
					);
				} catch (e: any) {
					ctx.ui.notify(`stop failed: ${e?.message ?? e}`, "error");
				}
				keepOpen = true;
				break;
			}
			case "remove": {
				try {
					await supervisor.remove(result.id);
					ctx.ui.notify(`removed ${result.id}`, "info");
				} catch (e: any) {
					ctx.ui.notify(`remove failed: ${e?.message ?? e}`, "error");
				}
				keepOpen = true;
				break;
			}
			case "attach": {
				await attachToSession(pi, ctx, result.id, result.sessionFile);
				return;
			}
		}
	}
}

/**
 * Attach to a background session:
 *   1. Gracefully stop the runner (so it releases the session file).
 *   2. Switch the foreground pi to that session file.
 *
 * Step 2 requires `ExtensionCommandContext` (ctx.switchSession). If we were
 * invoked from the Alt+A shortcut handler, `ctx` is only `ExtensionContext`
 * and we have to fall back to a notify + manual `pi --session <file>` hint.
 */
async function attachToSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	id: string,
	sessionFile: string,
): Promise<void> {
	ctx.ui.notify(`stopping ${id} to release session file…`, "info");
	try {
		const stopped = await supervisor.stop(id);
		if (!stopped) {
			ctx.ui.notify(`attach blocked: processes still alive for ${id}`, "error");
			return;
		}
	} catch (e: any) {
		ctx.ui.notify(`stop failed: ${e?.message ?? e}`, "error");
		return;
	}

	// `switchSession` only exists on command ctx. Detect at runtime.
	const cmdCtx = ctx as ExtensionCommandContext;
	if (typeof cmdCtx.switchSession !== "function") {
		ctx.ui.notify(
			`session released. To attach, run: pi --session ${sessionFile}`,
			"info",
		);
		return;
	}

	try {
		await cmdCtx.switchSession(sessionFile, {
			withSession: async (newCtx) => {
				newCtx.ui.notify(`attached to ${id}`, "info");
			},
		});
	} catch (e: any) {
		ctx.ui.notify(`switchSession failed: ${e?.message ?? e}`, "error");
	}
}

// ── Small helpers ──────────────────────────────────────────────

function consumeOpenRequest(piPid: number): string | undefined {
	const dir = join(supervisor.ROOT, "open-requests");
	const path = join(dir, `${piPid}.json`);
	if (!existsSync(path)) return undefined;
	try {
		mkdirSync(dir, { recursive: true });
		const request = JSON.parse(readFileSync(path, "utf8"));
		unlinkSync(path);
		return typeof request.selectedId === "string" ? request.selectedId : undefined;
	} catch {
		try { unlinkSync(path); } catch {}
		return undefined;
	}
}

function shorten(s: string, n: number): string {
	if (!s) return "";
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}
