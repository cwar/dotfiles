/**
 * Edit Approval Extension
 *
 * Intercepts file edit/write tool calls and prompts the user for interactive
 * approval before they execute. For each edit, the user can:
 *
 *   ✅ Approve         — proceed with the edit
 *   ✅ Approve All [!] — auto-approve all remaining edits this session
 *   ❌ Reject          — block the edit entirely
 *   🔍 Explain         — ask the agent to break down / explain the change
 *   📝 Amend           — append custom instructions to any response
 *
 * Large edits (configurable threshold) automatically offer a "Break down"
 * option that asks the agent to split the change into smaller phases,
 * similar to the pr-review skill's phased approach.
 *
 * /edit-approval toggles between gated and approve-all.
 * Ctrl+Alt+E does the same.
 *
 * Approve-all is session-scoped — resets to gated on new sessions.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Lines of new content above which "Break down" is offered automatically. */
const LARGE_EDIT_THRESHOLD = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApprovalChoice =
	| { action: "approve"; extra?: string }
	| { action: "approve_all"; extra?: string }
	| { action: "reject"; extra?: string }
	| { action: "explain"; extra?: string }
	| { action: "breakdown"; extra?: string };

interface MenuItem {
	key: string;
	label: string;
	description: string;
	accent: string; // theme color name
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(text: string | undefined): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function summarizeEdit(toolName: string, input: Record<string, unknown>): { file: string; lines: number; summary: string } {
	if (toolName === "edit") {
		const path = (input.path as string) ?? "unknown";
		const oldText = (input.oldText as string) ?? "";
		const newText = (input.newText as string) ?? "";
		const removedLines = countLines(oldText);
		const addedLines = countLines(newText);
		return {
			file: path,
			lines: Math.max(removedLines, addedLines),
			summary: `Replace ${removedLines} line${removedLines !== 1 ? "s" : ""} → ${addedLines} line${addedLines !== 1 ? "s" : ""}`,
		};
	}

	// write tool
	const path = (input.path as string) ?? "unknown";
	const content = (input.content as string) ?? "";
	const lines = countLines(content);
	return {
		file: path,
		lines,
		summary: `Write ${lines} line${lines !== 1 ? "s" : ""}`,
	};
}

function buildDiffPreview(toolName: string, input: Record<string, unknown>, width: number, theme: any): string[] {
	const lines: string[] = [];

	if (toolName === "edit") {
		const oldText = ((input.oldText as string) ?? "").split("\n");
		const newText = ((input.newText as string) ?? "").split("\n");

		// Show removed lines (max 20)
		const oldSlice = oldText.slice(0, 20);
		for (const line of oldSlice) {
			lines.push(truncateToWidth(theme.fg("toolDiffRemoved", `- ${line}`), width));
		}
		if (oldText.length > 20) {
			lines.push(theme.fg("dim", `  ... ${oldText.length - 20} more removed lines`));
		}

		// Separator
		if (oldSlice.length > 0 && newText.length > 0) {
			lines.push(theme.fg("dim", "  ───"));
		}

		// Show added lines (max 20)
		const newSlice = newText.slice(0, 20);
		for (const line of newSlice) {
			lines.push(truncateToWidth(theme.fg("toolDiffAdded", `+ ${line}`), width));
		}
		if (newText.length > 20) {
			lines.push(theme.fg("dim", `  ... ${newText.length - 20} more added lines`));
		}
	} else {
		// write — show first 20 lines of content
		const content = ((input.content as string) ?? "").split("\n");
		const slice = content.slice(0, 20);
		for (const line of slice) {
			lines.push(truncateToWidth(theme.fg("toolDiffAdded", `+ ${line}`), width));
		}
		if (content.length > 20) {
			lines.push(theme.fg("dim", `  ... ${content.length - 20} more lines`));
		}
	}

	return lines;
}

// ---------------------------------------------------------------------------
// Approval dialog component
// ---------------------------------------------------------------------------

function showApprovalDialog(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	isLarge: boolean,
): Promise<ApprovalChoice | null> {
	const info = summarizeEdit(toolName, input);

	const menuItems: MenuItem[] = [
		{ key: "a", label: "Approve", description: "Proceed with this edit", accent: "success" },
		{ key: "!", label: "Approve All", description: "Auto-approve all edits this session", accent: "accent" },
		{ key: "r", label: "Reject", description: "Block this edit", accent: "error" },
		{ key: "e", label: "Explain", description: "Ask for a detailed explanation", accent: "warning" },
	];

	if (isLarge) {
		menuItems.push({
			key: "b",
			label: "Break down",
			description: "Split into smaller phased edits",
			accent: "accent",
		});
	}

	return ctx.ui.custom<ApprovalChoice | null>((tui, theme, _kb, done) => {
		let selectedIdx = 0;
		let amendMode = false;
		let amendText = "";
		let showPreview = true;

		// Cache
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function buildLines(width: number): string[] {
			const out: string[] = [];
			const innerWidth = width - 2; // padding

			// Top border
			out.push(theme.fg("borderAccent", "─".repeat(width)));

			// Title
			out.push(
				" " +
					theme.fg("accent", theme.bold("📋 Edit Approval")) +
					theme.fg("dim", ` — ${toolName}`),
			);
			out.push("");

			// File info
			out.push(" " + theme.fg("text", theme.bold("File: ")) + theme.fg("accent", info.file));
			out.push(" " + theme.fg("text", theme.bold("Change: ")) + theme.fg("muted", info.summary));

			if (isLarge) {
				out.push(
					" " +
						theme.fg("warning", `⚠ Large edit (${info.lines} lines) — consider breaking down`),
				);
			}

			out.push("");

			// Diff preview
			if (showPreview) {
				out.push(" " + theme.fg("dim", "Preview:"));
				const preview = buildDiffPreview(toolName, input, innerWidth, theme);
				for (const line of preview) {
					out.push(" " + line);
				}
				out.push("");
			}

			// Separator
			out.push(theme.fg("border", "─".repeat(width)));

			if (amendMode) {
				// Amend input mode
				out.push(
					" " +
						theme.fg("accent", theme.bold("Additional instructions")) +
						theme.fg("dim", " (Enter to confirm, Esc to cancel):"),
				);
				out.push(" " + theme.fg("text", `> ${amendText}█`));
				out.push("");
			} else {
				// Menu items
				for (let i = 0; i < menuItems.length; i++) {
					const item = menuItems[i];
					const prefix = i === selectedIdx ? "▸ " : "  ";
					const keyTag = theme.fg("dim", `[${item.key}]`);
					const label =
						i === selectedIdx
							? theme.fg(item.accent, theme.bold(item.label))
							: theme.fg("text", item.label);
					const desc = theme.fg("muted", ` — ${item.description}`);
					out.push(truncateToWidth(` ${prefix}${keyTag} ${label}${desc}`, width));
				}

				out.push("");
				out.push(
					" " +
						theme.fg("dim", "↑↓ navigate • enter/key select • ! approve all • tab amend • p preview • esc reject"),
				);
			}

			// Bottom border
			out.push(theme.fg("borderAccent", "─".repeat(width)));

			return out;
		}

		function invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function finishWithChoice(action: ApprovalChoice["action"]) {
			const extra = amendText.trim() || undefined;
			done({ action, extra } as ApprovalChoice);
		}

		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = buildLines(width);
				cachedWidth = width;
				return cachedLines;
			},

			invalidate() {
				cachedWidth = undefined;
				cachedLines = undefined;
			},

			handleInput(data: string) {
				if (amendMode) {
					if (matchesKey(data, Key.escape)) {
						amendMode = false;
						amendText = "";
						invalidate();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						amendMode = false;
						invalidate();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.backspace)) {
						amendText = amendText.slice(0, -1);
						invalidate();
						tui.requestRender();
						return;
					}
					// Printable characters
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						amendText += data;
						invalidate();
						tui.requestRender();
						return;
					}
					return;
				}

				// Navigation
				if (matchesKey(data, Key.up)) {
					selectedIdx = Math.max(0, selectedIdx - 1);
					invalidate();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIdx = Math.min(menuItems.length - 1, selectedIdx + 1);
					invalidate();
					tui.requestRender();
					return;
				}

				// Enter — select current item
				if (matchesKey(data, Key.enter)) {
					const selectedKey = menuItems[selectedIdx].key;
					const actionMap: Record<string, ApprovalChoice["action"]> = {
						"a": "approve",
						"!": "approve_all",
						"r": "reject",
						"e": "explain",
						"b": "breakdown",
					};
					finishWithChoice(actionMap[selectedKey] ?? "reject");
					return;
				}

				// Escape — reject
				if (matchesKey(data, Key.escape)) {
					done({ action: "reject" });
					return;
				}

				// Direct key shortcuts
				if (data === "a" || data === "A") { finishWithChoice("approve"); return; }
				if (data === "!") { finishWithChoice("approve_all"); return; }
				if (data === "r" || data === "R") { finishWithChoice("reject"); return; }
				if (data === "e" || data === "E") { finishWithChoice("explain"); return; }
				if ((data === "b" || data === "B") && isLarge) { finishWithChoice("breakdown"); return; }

				// Tab to enter amend mode
				if (matchesKey(data, Key.tab)) {
					amendMode = true;
					invalidate();
					tui.requestRender();
					return;
				}

				// p to toggle preview
				if (data === "p" || data === "P") {
					showPreview = !showPreview;
					invalidate();
					tui.requestRender();
					return;
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function editApprovalExtension(pi: ExtensionAPI): void {
	let approveAll = false; // Session-scoped: skip dialogs when true

	// Reset on each session start — always start gated
	pi.on("session_start", async (_event, ctx) => {
		approveAll = false;
		updateStatus(ctx);
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (approveAll) {
			ctx.ui.setStatus("edit-approval", ctx.ui.theme.fg("warning", "🛡 edits auto-approved"));
		} else {
			ctx.ui.setStatus("edit-approval", ctx.ui.theme.fg("success", "🛡 edits gated"));
		}
	}

	// Toggle command
	pi.registerCommand("edit-approval", {
		description: "Toggle between per-edit prompts and approve-all for this session",
		handler: async (_args, ctx) => {
			approveAll = !approveAll;
			updateStatus(ctx);
			ctx.ui.notify(
				approveAll
					? "🛡 Auto-approve — all edits proceed without prompts this session"
					: "🛡 Gated — you'll be prompted before each edit",
				"info",
			);
		},
	});

	// Keyboard shortcut: toggle gated ↔ approve-all
	pi.registerShortcut(Key.ctrlAlt("e"), {
		description: "Toggle edit approval: gated ↔ approve-all",
		handler: async (ctx) => {
			approveAll = !approveAll;
			updateStatus(ctx);
			ctx.ui.notify(
				approveAll ? "🛡 Edits auto-approved" : "🛡 Edits gated",
				"info",
			);
		},
	});

	// The main gate — intercept edit and write tool calls
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return undefined;

		// Only gate edit and write tools
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

		// Skip dialog when approve-all is active
		if (approveAll) return undefined;

		const input = event.input as Record<string, unknown>;
		const info = summarizeEdit(event.toolName, input);
		const isLarge = info.lines >= LARGE_EDIT_THRESHOLD;

		const choice = await showApprovalDialog(ctx, event.toolName, input, isLarge);

		if (!choice || choice.action === "reject") {
			const reason = choice?.extra
				? `Edit rejected by user. User feedback: ${choice.extra}`
				: "Edit rejected by user.";
			return { block: true, reason };
		}

		if (choice.action === "explain") {
			const reason = choice.extra
				? `User wants this edit explained before approving. User instructions: ${choice.extra}`
				: "User wants this edit explained in detail before approving. Break down what this change does, why each part is necessary, and what the before/after behavior will be. Then propose the edit again.";
			return { block: true, reason };
		}

		if (choice.action === "breakdown") {
			const reason = choice.extra
				? `User wants this large edit broken into smaller, incremental phases. User instructions: ${choice.extra}`
				: `User wants this large edit (${info.lines} lines) broken into smaller, incremental phases. Split the change into logical steps that can each be reviewed and approved independently. Apply them one at a time, explaining each phase before proposing it.`;
			return { block: true, reason };
		}

		if (choice.action === "approve_all") {
			approveAll = true;
			updateStatus(ctx);
			ctx.ui.notify("Auto-approve enabled for this session — all edits will proceed without prompts", "info");
			// Inject extra instructions if provided, then allow this edit through
			if (choice.extra) {
				pi.sendMessage(
					{
						customType: "edit-approval-note",
						content: `[Edit approved (approve-all) with note] ${choice.extra}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			return undefined;
		}

		// Approved — if the user appended extra instructions, inject them as a steering message
		if (choice.extra) {
			pi.sendMessage(
				{
					customType: "edit-approval-note",
					content: `[Edit approved with note] ${choice.extra}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		return undefined; // allow the edit to proceed
	});
}
