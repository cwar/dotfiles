/**
 * Split Output Mode Extension
 *
 * Separates dialog from tool execution and thinking output into dedicated panes.
 * Uses tmux splits for true spatial separation when available, falls back to
 * a widget below the editor.
 *
 * When enabled:
 *   - Tool components are completely hidden from the main conversation view
 *   - Thinking output streams to a dedicated tmux pane (right side, top)
 *   - Tool execution output streams to a dedicated tmux pane (right side, bottom)
 *   - Without tmux: shows a combined widget below the editor
 *
 * Toggle: Ctrl+Shift+O
 * Command: /split [on|off|tools|thinking|all] - toggle split panes
 *
 * Usage: pi -e ./split-output.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
} from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────

const LOG_DIR = path.join(os.tmpdir(), "pi-split-output");
const TOOL_LOG = path.join(LOG_DIR, "tools.log");
const THINKING_LOG = path.join(LOG_DIR, "thinking.log");
const MAX_WIDGET_LINES = 14;
const TMUX_PANE_PERCENT = 38; // right panes take 38% of terminal width

// ── Types ───────────────────────────────────────────────────

interface SplitState {
	enabled: boolean;
	toolsPane: boolean;
	thinkingPane: boolean;
	tmuxToolPaneId: string | null;
	tmuxThinkingPaneId: string | null;
	toolsWereExpanded: boolean;
}

// Cache tool args from start events so we can use them in end events
const toolArgsCache = new Map<string, Record<string, unknown>>();

// ── ANSI helpers for the log panes ──────────────────────────

const ansi = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	italic: "\x1b[3m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	blue: "\x1b[34m",
	gray: "\x1b[90m",
	white: "\x1b[97m",
	bgDark: "\x1b[48;5;235m",
	clearScreen: "\x1b[2J\x1b[H",
};

// ── Built-in tool names we override for hiding ──────────────

const BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export default function splitOutputExtension(pi: ExtensionAPI) {
	const state: SplitState = {
		enabled: false,
		toolsPane: false,
		thinkingPane: false,
		tmuxToolPaneId: null,
		tmuxThinkingPaneId: null,
		toolsWereExpanded: true,
	};

	let currentCtx: ExtensionContext | null = null;
	let thinkingBuffer = "";
	let inTmux = false;

	// ── Init ────────────────────────────────────────────────

	function init() {
		inTmux = !!process.env.TMUX;
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}

	init();

	// ── Helpers ─────────────────────────────────────────────

	function timestamp(): string {
		const d = new Date();
		return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
	}

	function truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen - 1) + "…";
	}

	// ── Log file writers ────────────────────────────────────

	function writeToolLog(icon: string, toolName: string, summary: string, output?: string) {
		const ts = `${ansi.gray}${timestamp()}${ansi.reset}`;
		const name = `${ansi.cyan}${ansi.bold}${toolName}${ansi.reset}`;
		let line = `${ts} ${icon} ${name} ${ansi.dim}${summary}${ansi.reset}\n`;

		if (output) {
			const lines = output.split("\n").slice(0, 30);
			const formatted = lines.map((l) => `  ${ansi.gray}│${ansi.reset} ${l}`).join("\n");
			line += formatted + "\n";
			if (output.split("\n").length > 30) {
				line += `  ${ansi.gray}│ ... ${output.split("\n").length - 30} more lines${ansi.reset}\n`;
			}
		}
		line += "\n";
		fs.appendFileSync(TOOL_LOG, line);
	}

	function writeThinkingLog(content: string, isDelta: boolean) {
		if (isDelta) {
			fs.appendFileSync(THINKING_LOG, content);
		} else {
			const ts = `${ansi.gray}${timestamp()}${ansi.reset}`;
			const header = `\n${ansi.magenta}${ansi.bold}── thinking ──${ansi.reset} ${ts}\n`;
			fs.appendFileSync(THINKING_LOG, header + content + "\n");
		}
	}

	// ── Tmux pane management ────────────────────────────────

	function tmuxExec(cmd: string): string {
		try {
			return execSync(cmd, { encoding: "utf-8" }).trim();
		} catch {
			return "";
		}
	}

	function openTmuxPane(logFile: string, title: string, splitFrom?: string): string | null {
		if (!inTmux) return null;

		try {
			let splitCmd: string;
			if (splitFrom) {
				splitCmd = `tmux split-window -t ${splitFrom} -v -d -l 50% -P -F '#{pane_id}'`;
			} else {
				splitCmd = `tmux split-window -h -d -l ${TMUX_PANE_PERCENT}% -P -F '#{pane_id}'`;
			}

			const paneId = tmuxExec(splitCmd);
			if (!paneId) return null;

			const headerCmd = `printf '${ansi.clearScreen}${ansi.bold}${ansi.cyan}═══ ${title} ═══${ansi.reset}\\n\\n'`;
			tmuxExec(`tmux send-keys -t ${paneId} "${headerCmd} && tail -f ${logFile}" Enter`);

			return paneId;
		} catch {
			return null;
		}
	}

	function closeTmuxPane(paneId: string | null) {
		if (!paneId || !inTmux) return;
		try {
			tmuxExec(`tmux kill-pane -t ${paneId}`);
		} catch {
			// pane may already be closed
		}
	}

	// ── Tool override management (hide tools from main view) ─

	/**
	 * Register tool overrides that hide tool components from the main conversation.
	 * Each override delegates execution to the real built-in implementation but
	 * provides renderCall/renderResult that return undefined, causing the
	 * ToolExecutionComponent to set hideComponent=true and render nothing.
	 */
	function registerHiddenToolOverrides() {
		const cwd = currentCtx?.cwd ?? process.cwd();

		// Create the real tool implementations to delegate to
		const toolImpls: Record<string, any> = {
			read: createReadTool(cwd),
			bash: createBashTool(cwd),
			edit: createEditTool(cwd),
			write: createWriteTool(cwd),
			grep: createGrepTool(cwd),
			find: createFindTool(cwd),
			ls: createLsTool(cwd),
		};

		for (const toolName of BUILT_IN_TOOLS) {
			const impl = toolImpls[toolName];
			if (!impl) continue;

			pi.registerTool({
				name: impl.name,
				label: impl.label,
				description: impl.description,
				parameters: impl.parameters,

				// Delegate execution to the real implementation
				execute: impl.execute,

				// Return undefined to hide the component entirely
				renderCall: () => undefined,
				renderResult: () => undefined,
			});
		}
	}

	/**
	 * Re-register tool overrides WITHOUT custom renderers.
	 * Since the tool name matches a built-in, shouldUseBuiltInRenderer()
	 * returns true and normal rendering is restored.
	 */
	function registerVisibleToolOverrides() {
		const cwd = currentCtx?.cwd ?? process.cwd();

		const toolImpls: Record<string, any> = {
			read: createReadTool(cwd),
			bash: createBashTool(cwd),
			edit: createEditTool(cwd),
			write: createWriteTool(cwd),
			grep: createGrepTool(cwd),
			find: createFindTool(cwd),
			ls: createLsTool(cwd),
		};

		for (const toolName of BUILT_IN_TOOLS) {
			const impl = toolImpls[toolName];
			if (!impl) continue;

			pi.registerTool({
				name: impl.name,
				label: impl.label,
				description: impl.description,
				parameters: impl.parameters,
				execute: impl.execute,
				// No renderCall/renderResult → built-in renderer kicks in
			});
		}
	}

	// ── Enable / Disable ────────────────────────────────────

	function enableSplit(ctx: ExtensionContext, which: "all" | "tools" | "thinking" = "all") {
		currentCtx = ctx;

		if (!state.enabled) {
			state.toolsWereExpanded = ctx.ui.getToolsExpanded();
		}

		state.enabled = true;

		// Initialize log files
		if ((which === "all" || which === "tools") && !state.toolsPane) {
			fs.writeFileSync(TOOL_LOG, "");
			state.toolsPane = true;
		}
		if ((which === "all" || which === "thinking") && !state.thinkingPane) {
			fs.writeFileSync(THINKING_LOG, "");
			state.thinkingPane = true;
		}

		// Hide tool components from main view when tools pane is active
		if (state.toolsPane) {
			registerHiddenToolOverrides();
		}

		if (inTmux) {
			openTmuxPanes();
		} else {
			updateWidget();
		}

		updateStatus();

		const panes = [];
		if (state.toolsPane) panes.push("tools");
		if (state.thinkingPane) panes.push("thinking");
		ctx.ui.notify(`Split output ON [${panes.join(" + ")}]`, "info");
	}

	function openTmuxPanes() {
		// Open thinking pane first (it'll be on top)
		if (state.thinkingPane && !state.tmuxThinkingPaneId) {
			state.tmuxThinkingPaneId = openTmuxPane(THINKING_LOG, "Thinking");
		}

		// Open tools pane below thinking (or as first right pane)
		if (state.toolsPane && !state.tmuxToolPaneId) {
			if (state.tmuxThinkingPaneId) {
				state.tmuxToolPaneId = openTmuxPane(TOOL_LOG, "Tool Output", state.tmuxThinkingPaneId);
			} else {
				state.tmuxToolPaneId = openTmuxPane(TOOL_LOG, "Tool Output");
			}
		}
	}

	function disableSplit(ctx: ExtensionContext, which: "all" | "tools" | "thinking" = "all") {
		currentCtx = ctx;

		if (which === "all" || which === "tools") {
			state.toolsPane = false;
			closeTmuxPane(state.tmuxToolPaneId);
			state.tmuxToolPaneId = null;
		}

		if (which === "all" || which === "thinking") {
			state.thinkingPane = false;
			closeTmuxPane(state.tmuxThinkingPaneId);
			state.tmuxThinkingPaneId = null;
		}

		if (!state.toolsPane && !state.thinkingPane) {
			state.enabled = false;
			// Restore normal tool rendering
			registerVisibleToolOverrides();
			ctx.ui.setToolsExpanded(state.toolsWereExpanded);
			ctx.ui.setWidget("split-output", undefined);
		} else if (!state.toolsPane) {
			// Only tools pane was closed, restore tool rendering
			registerVisibleToolOverrides();
			ctx.ui.setToolsExpanded(state.toolsWereExpanded);
		}

		updateStatus();
		if (state.enabled && !inTmux) updateWidget();

		ctx.ui.notify(state.enabled ? `Split: closed ${which} pane` : "Split output OFF", "info");
	}

	function toggleSplit(ctx: ExtensionContext, which: "all" | "tools" | "thinking" = "all") {
		currentCtx = ctx;

		if (which === "all") {
			if (state.enabled) {
				disableSplit(ctx, "all");
			} else {
				enableSplit(ctx, "all");
			}
		} else {
			const isActive = which === "tools" ? state.toolsPane : state.thinkingPane;
			if (isActive) {
				disableSplit(ctx, which);
			} else {
				enableSplit(ctx, which);
			}
		}
	}

	// ── Widget (non-tmux fallback) ──────────────────────────

	function updateWidget() {
		if (!state.enabled || !currentCtx?.hasUI || inTmux) return;

		currentCtx.ui.setWidget(
			"split-output",
			(_tui, theme) => {
				const lines: string[] = [];

				const panes = [];
				if (state.toolsPane) panes.push("tools");
				if (state.thinkingPane) panes.push("thinking");
				lines.push(
					theme.fg("borderAccent", "─── ") +
					theme.fg("accent", theme.bold("Split Output")) +
					theme.fg("borderAccent", " ─── ") +
					theme.fg("dim", panes.join(" + "))
				);

				if (state.thinkingPane && thinkingBuffer) {
					lines.push(theme.fg("magenta", theme.bold("thinking:")));
					const thinkLines = thinkingBuffer.split("\n").slice(-4);
					for (const l of thinkLines) {
						lines.push(theme.fg("dim", `  ${truncate(l, 76)}`));
					}
				}

				if (state.toolsPane) {
					try {
						const content = fs.readFileSync(TOOL_LOG, "utf-8");
						const stripped = content.replace(/\x1b\[[0-9;]*m/g, "");
						const logLines = stripped.split("\n").filter((l) => l.trim());
						const recent = logLines.slice(-(MAX_WIDGET_LINES - lines.length));

						if (recent.length > 0) {
							lines.push(theme.fg("cyan", theme.bold("tools:")));
							for (const l of recent) {
								lines.push(theme.fg("muted", `  ${truncate(l, 76)}`));
							}
						} else {
							lines.push(theme.fg("dim", "  No tool output yet"));
						}
					} catch {
						lines.push(theme.fg("dim", "  No tool output yet"));
					}
				}

				return {
					render: () => lines,
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" }
		);
	}

	// ── Status ──────────────────────────────────────────────

	function updateStatus() {
		if (!currentCtx?.hasUI) return;
		const theme = currentCtx.ui.theme;

		if (state.enabled) {
			const panes = [];
			if (state.thinkingPane) panes.push("💭");
			if (state.toolsPane) panes.push("🔧");
			currentCtx.ui.setStatus(
				"split-output",
				theme.fg("accent", "◫") + theme.fg("dim", ` ${panes.join("")}`)
			);
		} else {
			currentCtx.ui.setStatus("split-output", undefined);
		}
	}

	// ── Tool event formatting ───────────────────────────────

	function formatToolSummary(toolName: string, args: Record<string, unknown>): string {
		if (!args || typeof args !== "object") return "";
		try {
			switch (toolName) {
				case "bash":
					return truncate(String(args.command ?? ""), 70);
				case "read":
					return String(args.path ?? "");
				case "write":
					return String(args.path ?? "");
				case "edit":
					return String(args.path ?? "");
				case "web_search":
					return truncate(String(args.query ?? args.queries ?? ""), 70);
				case "fetch_content":
					return truncate(String(args.url ?? args.urls ?? ""), 70);
				case "subagent":
					return truncate(String(args.task ?? args.agent ?? ""), 70);
				default: {
					const firstStr = Object.values(args).find((v) => typeof v === "string");
					return firstStr ? truncate(String(firstStr), 70) : "";
				}
			}
		} catch {
			return "";
		}
	}

	function extractResultText(result: unknown): string | null {
		try {
			if (!result || typeof result !== "object") return null;
			const r = result as Record<string, unknown>;
			if (Array.isArray(r.content)) {
				const texts = r.content
					.filter((c: unknown) => typeof c === "object" && c && (c as Record<string, unknown>).type === "text")
					.map((c: unknown) => String((c as Record<string, unknown>).text ?? ""));
				return texts.join("\n") || null;
			}
			return null;
		} catch {
			return null;
		}
	}

	// ── Keyboard shortcut ───────────────────────────────────

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle split output mode (dialog / tools / thinking)",
		handler: async (ctx) => {
			toggleSplit(ctx);
		},
	});

	// ── Command ─────────────────────────────────────────────

	pi.registerCommand("split", {
		description: "Toggle split output: /split [on|off|tools|thinking|all]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			switch (arg) {
				case "on":
				case "all":
					enableSplit(ctx, "all");
					break;
				case "off":
					disableSplit(ctx, "all");
					break;
				case "tools":
					toggleSplit(ctx, "tools");
					break;
				case "thinking":
					toggleSplit(ctx, "thinking");
					break;
				default:
					toggleSplit(ctx, "all");
					break;
			}
		},
	});

	// ── Session events ──────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		thinkingBuffer = "";
		updateStatus();
	});

	pi.on("session_switch", async (_event, ctx) => {
		currentCtx = ctx;
		thinkingBuffer = "";
		if (state.enabled) {
			if (state.toolsPane) fs.writeFileSync(TOOL_LOG, "");
			if (state.thinkingPane) fs.writeFileSync(THINKING_LOG, "");
			updateWidget();
		}
	});

	pi.on("session_shutdown", async () => {
		closeTmuxPane(state.tmuxToolPaneId);
		closeTmuxPane(state.tmuxThinkingPaneId);
		state.tmuxToolPaneId = null;
		state.tmuxThinkingPaneId = null;
	});

	// ── Tool execution events ───────────────────────────────

	pi.on("tool_execution_start", async (event, ctx) => {
		currentCtx = ctx;

		// Cache args for the end event (which doesn't include args)
		toolArgsCache.set(event.toolCallId, event.args ?? {});

		if (!state.enabled || !state.toolsPane) return;

		const summary = formatToolSummary(event.toolName, event.args ?? {});
		writeToolLog(`${ansi.yellow}⏳${ansi.reset}`, event.toolName, summary);
		if (!inTmux) updateWidget();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		currentCtx = ctx;
		if (!state.enabled || !state.toolsPane) return;

		const isError = event.isError ?? false;
		const cachedArgs = toolArgsCache.get(event.toolCallId) ?? {};
		toolArgsCache.delete(event.toolCallId);
		const summary = formatToolSummary(event.toolName, cachedArgs);
		const output = extractResultText(event.result);
		const icon = isError ? `${ansi.red}✗${ansi.reset}` : `${ansi.green}✓${ansi.reset}`;

		writeToolLog(icon, event.toolName, summary, output ?? undefined);
		if (!inTmux) updateWidget();
	});

	// ── Thinking events (via message_update) ────────────────

	pi.on("message_update", async (event, ctx) => {
		currentCtx = ctx;
		if (!state.enabled || !state.thinkingPane) return;

		try {
			const streamEvent = event.assistantMessageEvent;
			if (!streamEvent) return;

			if (streamEvent.type === "thinking_start") {
				thinkingBuffer = "";
				writeThinkingLog("", false);
			} else if (streamEvent.type === "thinking_delta") {
				thinkingBuffer += streamEvent.delta;
				writeThinkingLog(streamEvent.delta, true);
				if (!inTmux) updateWidget();
			} else if (streamEvent.type === "thinking_end") {
				thinkingBuffer = "";
				fs.appendFileSync(THINKING_LOG, `\n${ansi.gray}── end ──${ansi.reset}\n\n`);
				if (!inTmux) updateWidget();
			}
		} catch {
			// Ignore errors in thinking handler
		}
	});
}
