/**
 * Permissions Extension
 *
 * A simple, unified permissions system for pi. Replaces edit-approval with
 * a rules-based approach: allow rules auto-approve, deny rules auto-block,
 * and gated tools prompt when no rule matches.
 *
 * Config: ~/.pi/agent/permissions.json
 *
 * Rule format: Tool(pattern)
 *   - Write(/tmp/**)    — auto-approve writes to /tmp
 *   - Edit(.env)        — match edits to .env
 *   - Bash(git *)       — match bash commands starting with "git "
 *   - Bash(rm -rf /*)   — match dangerous rm commands
 *
 * Pattern matching:
 *   - *   matches any characters within a path segment
 *   - **  matches any characters including path separators
 *   - ?   matches a single character
 *
 * Commands:
 *   /permissions           — show current rules
 *   /permit <rule>         — add an allow rule  (e.g., /permit Write(/tmp/**))
 *   /deny <rule>           — add a deny rule
 *   /permit-remove <rule>  — remove a rule from allow or deny
 *   /permit-toggle         — toggle gated ↔ approve-all for this session
 *
 * Shortcut: Ctrl+Alt+A toggles gated ↔ approve-all.
 * In the approval dialog, press ! to approve all remaining edits this session.
 * Deny rules are always enforced, even in approve-all mode.
 * Approve-all resets to gated on new sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(
	process.env.HOME ?? "~",
	".pi",
	"agent",
	"permissions.json",
);

/** Lines of new content above which "Break down" is offered automatically. */
const LARGE_EDIT_THRESHOLD = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PermissionsConfig {
	allow: string[];
	deny: string[];
	/** Which tools require approval when no allow/deny rule matches */
	gate: string[];
}

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
	accent: string;
}

interface ParsedRule {
	tool: string; // lowercase: "write", "edit", "bash", "read", "*"
	pattern: string;
	regex: RegExp;
	original: string;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function loadConfig(): PermissionsConfig {
	try {
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			allow: Array.isArray(parsed.allow) ? parsed.allow : [],
			deny: Array.isArray(parsed.deny) ? parsed.deny : [],
			gate: Array.isArray(parsed.gate)
				? parsed.gate.map((g: string) => g.toLowerCase())
				: ["write", "edit"],
		};
	} catch {
		return { allow: [], deny: [], gate: ["write", "edit"] };
	}
}

function saveConfig(config: PermissionsConfig): void {
	const dir = path.dirname(CONFIG_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(
		CONFIG_PATH,
		JSON.stringify(config, null, 2) + "\n",
		"utf-8",
	);
}

// ---------------------------------------------------------------------------
// Rule parsing & matching
// ---------------------------------------------------------------------------

/**
 * Parse a rule string like "Write(/tmp/**)" into components.
 */
function parseRule(rule: string): ParsedRule | null {
	const match = rule.match(/^(\w+|\*)\((.+)\)$/);
	if (!match) return null;

	const tool = match[1].toLowerCase();
	const pattern = match[2];
	const regex = globToRegex(pattern);

	return { tool, pattern, regex, original: rule };
}

/**
 * Convert a glob pattern to a RegExp.
 *
 *   **  → match anything (including /)
 *   *   → match anything except /
 *   ?   → match a single char
 *
 * Everything else is escaped.
 */
function globToRegex(glob: string): RegExp {
	let regex = "";
	let i = 0;

	while (i < glob.length) {
		const ch = glob[i];

		if (ch === "*" && glob[i + 1] === "*") {
			regex += ".*";
			i += 2;
			// Skip trailing / after **
			if (glob[i] === "/") i++;
		} else if (ch === "*") {
			regex += "[^/]*";
			i++;
		} else if (ch === "?") {
			regex += ".";
			i++;
		} else if (".+^${}()|[]\\".includes(ch)) {
			regex += "\\" + ch;
			i++;
		} else {
			regex += ch;
			i++;
		}
	}

	return new RegExp("^" + regex + "$");
}

/**
 * Check if a tool call matches a parsed rule.
 */
function matchesRule(
	rule: ParsedRule,
	toolName: string,
	matchValue: string,
): boolean {
	// Tool must match (or rule is wildcard)
	if (rule.tool !== "*" && rule.tool !== toolName.toLowerCase()) {
		return false;
	}

	return rule.regex.test(matchValue);
}

/**
 * Get the value to match against for a given tool call.
 * For bash: the command string
 * For write/edit/read: the file path
 */
function getMatchValue(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string {
	if (toolName === "bash") {
		return (input.command as string) ?? "";
	}

	// For file tools, resolve relative paths against cwd
	const rawPath = (input.path as string) ?? "";
	if (path.isAbsolute(rawPath)) {
		return rawPath;
	}
	return path.resolve(cwd, rawPath);
}

// ---------------------------------------------------------------------------
// Approval dialog (from edit-approval, kept for gated prompts)
// ---------------------------------------------------------------------------

function countLines(text: string | undefined): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Extract the list of {oldText, newText} pairs from an edit tool input. */
function extractEdits(
	input: Record<string, unknown>,
): { oldText: string; newText: string }[] {
	// pi's edit tool: { path, edits: [{oldText, newText}, ...] }
	if (Array.isArray(input.edits)) {
		return (input.edits as { oldText?: string; newText?: string }[]).map(
			(e) => ({
				oldText: e.oldText ?? "",
				newText: e.newText ?? "",
			}),
		);
	}
	// Fallback: top-level oldText/newText (shouldn't happen, but safe)
	return [
		{
			oldText: (input.oldText as string) ?? "",
			newText: (input.newText as string) ?? "",
		},
	];
}

function summarizeEdit(
	toolName: string,
	input: Record<string, unknown>,
): { file: string; lines: number; summary: string } {
	if (toolName === "edit") {
		const p = (input.path as string) ?? "unknown";
		const edits = extractEdits(input);
		let totalRemoved = 0;
		let totalAdded = 0;
		for (const e of edits) {
			totalRemoved += countLines(e.oldText);
			totalAdded += countLines(e.newText);
		}
		const editCount = edits.length;
		const editLabel = editCount > 1 ? ` across ${editCount} edits` : "";
		return {
			file: p,
			lines: Math.max(totalRemoved, totalAdded),
			summary: `Replace ${totalRemoved} line${totalRemoved !== 1 ? "s" : ""} → ${totalAdded} line${totalAdded !== 1 ? "s" : ""}${editLabel}`,
		};
	}

	const p = (input.path as string) ?? "unknown";
	const content = (input.content as string) ?? "";
	const lines = countLines(content);
	return {
		file: p,
		lines,
		summary: `Write ${lines} line${lines !== 1 ? "s" : ""}`,
	};
}

/** Max lines of diff output per edit hunk before truncating. */
const DIFF_LINES_PER_HUNK = 12;
/** Context lines to show around each edit from the original file. */
const CONTEXT_LINES = 3;
/** Minimum unchanged context required before we try inline highlighting. */
const MIN_INLINE_CONTEXT = 4;
/** Avoid noisy inline diffs when lines are wildly different in length. */
const MAX_INLINE_LENGTH_DELTA = 80;

/**
 * Try to locate `needle` in `haystack` (the file lines) and return its
 * 0-based start index. Returns -1 if not found.
 */
function findTextInFile(fileLines: string[], needle: string): number {
	if (!needle) return -1;
	const needleLines = needle.split("\n");
	if (needleLines.length === 0) return -1;

	outer: for (let i = 0; i <= fileLines.length - needleLines.length; i++) {
		for (let j = 0; j < needleLines.length; j++) {
			if (fileLines[i + j] !== needleLines[j]) continue outer;
		}
		return i;
	}
	return -1;
}

/**
 * Read the target file's lines for providing diff context.
 * Returns empty array if unreadable (new file, etc.).
 */
function readFileLines(filePath: string, cwd?: string): string[] {
	try {
		const resolved = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd ?? process.cwd(), filePath);
		return fs.readFileSync(resolved, "utf-8").split("\n");
	} catch {
		return [];
	}
}

/**
 * Build a contextual diff preview for a single edit hunk.
 * Shows context lines from the original file around the change,
 * with removed lines (red) and added lines (green).
 */
function sharedPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	return i;
}

function sharedSuffixLength(a: string, b: string, prefixLen: number): number {
	const max = Math.min(a.length, b.length) - prefixLen;
	let i = 0;
	while (
		i < max &&
		a[a.length - 1 - i] === b[b.length - 1 - i]
	) {
		i++;
	}
	return i;
}

function shouldInlineDiff(oldLine: string, newLine: string): boolean {
	if (!oldLine || !newLine || oldLine === newLine) return false;
	if (Math.abs(oldLine.length - newLine.length) > MAX_INLINE_LENGTH_DELTA) {
		return false;
	}

	const prefixLen = sharedPrefixLength(oldLine, newLine);
	const suffixLen = sharedSuffixLength(oldLine, newLine, prefixLen);
	const shared = prefixLen + suffixLen;
	return shared >= MIN_INLINE_CONTEXT;
}

function renderInlineChangedLine(
	lineNumber: string,
	prefix: "-" | "+",
	line: string,
	otherLine: string,
	width: number,
	theme: any,
): string {
	const gutterColor = prefix === "-" ? "toolDiffRemoved" : "toolDiffAdded";
	const changedColor = prefix === "-" ? "error" : "success";
	const prefixLen = sharedPrefixLength(line, otherLine);
	const suffixLen = sharedSuffixLength(line, otherLine, prefixLen);
	const middleEnd = line.length - suffixLen;

	const unchangedStart = line.slice(0, prefixLen);
	const changed = line.slice(prefixLen, middleEnd);
	const unchangedEnd = line.slice(middleEnd);
	const markedChanged = `[[${changed || "∅"}]]`;
	const highlightedChanged = theme.underline(
		theme.bold(theme.fg(changedColor, markedChanged)),
	);

	return truncateToWidth(
		theme.fg(gutterColor, `  ${lineNumber} │${prefix}`) +
			theme.fg(gutterColor, ` ${unchangedStart}`) +
			highlightedChanged +
			theme.fg(gutterColor, unchangedEnd),
		width,
	);
}

function buildHunkPreview(
	fileLines: string[],
	oldText: string,
	newText: string,
	width: number,
	theme: any,
): string[] {
	const lines: string[] = [];
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	const matchIdx = findTextInFile(fileLines, oldText);

	if (matchIdx >= 0) {
		// We know where this edit lands in the file — show a contextual diff
		const ctxStart = Math.max(0, matchIdx - CONTEXT_LINES);
		const ctxEnd = Math.min(
			fileLines.length,
			matchIdx + oldLines.length + CONTEXT_LINES,
		);

		// Line number gutter width
		const gutterW = String(ctxEnd + 1).length;

		// Header: file position indicator
		lines.push(
			theme.fg(
				"dim",
				`  @@ line ${matchIdx + 1}${oldLines.length > 1 ? `-${matchIdx + oldLines.length}` : ""} @@`,
			),
		);

		let emitted = 0;
		const limit = DIFF_LINES_PER_HUNK + CONTEXT_LINES * 2;

		// Pre-context
		for (let i = ctxStart; i < matchIdx && emitted < limit; i++) {
			const ln = String(i + 1).padStart(gutterW);
			lines.push(
				truncateToWidth(
					theme.fg("dim", `  ${ln} │ `) +
						theme.fg("text", fileLines[i]),
					width,
				),
			);
			emitted++;
		}

		// Removed/added lines, with inline highlighting for similar pairs
		const oldSlice = oldLines.slice(0, DIFF_LINES_PER_HUNK);
		const newSlice = newLines.slice(0, DIFF_LINES_PER_HUNK);
		const pairCount = Math.min(oldSlice.length, newSlice.length);

		for (let i = 0; i < pairCount && emitted < limit; i++) {
			const ln = String(matchIdx + i + 1).padStart(gutterW);
			const pad = " ".repeat(gutterW);
			if (shouldInlineDiff(oldSlice[i], newSlice[i])) {
				lines.push(
					renderInlineChangedLine(
						ln,
						"-",
						oldSlice[i],
						newSlice[i],
						width,
						theme,
					),
				);
				emitted++;
				if (emitted >= limit) break;
				lines.push(
					renderInlineChangedLine(
						pad,
						"+",
						newSlice[i],
						oldSlice[i],
						width,
						theme,
					),
				);
				emitted++;
			} else {
				lines.push(
					truncateToWidth(
						theme.fg("toolDiffRemoved", `  ${ln} │-`) +
							theme.fg("toolDiffRemoved", ` ${oldSlice[i]}`),
						width,
					),
				);
				emitted++;
				if (emitted >= limit) break;
				lines.push(
					truncateToWidth(
						theme.fg("toolDiffAdded", `  ${pad} │+`) +
							theme.fg("toolDiffAdded", ` ${newSlice[i]}`),
						width,
					),
				);
				emitted++;
			}
		}

		for (let i = pairCount; i < oldSlice.length && emitted < limit; i++) {
			const ln = String(matchIdx + i + 1).padStart(gutterW);
			lines.push(
				truncateToWidth(
					theme.fg("toolDiffRemoved", `  ${ln} │-`) +
						theme.fg("toolDiffRemoved", ` ${oldSlice[i]}`),
					width,
				),
			);
			emitted++;
		}
		if (oldLines.length > DIFF_LINES_PER_HUNK) {
			lines.push(
				theme.fg(
					"dim",
					`  ${" ".repeat(gutterW)} │  ... ${oldLines.length - DIFF_LINES_PER_HUNK} more removed`,
				),
			);
		}

		for (let i = pairCount; i < newSlice.length && emitted < limit; i++) {
			const pad = " ".repeat(gutterW);
			lines.push(
				truncateToWidth(
					theme.fg("toolDiffAdded", `  ${pad} │+`) +
						theme.fg("toolDiffAdded", ` ${newSlice[i]}`),
					width,
				),
			);
			emitted++;
		}
		if (newLines.length > DIFF_LINES_PER_HUNK) {
			lines.push(
				theme.fg(
					"dim",
					`  ${" ".repeat(gutterW)} │  ... ${newLines.length - DIFF_LINES_PER_HUNK} more added`,
				),
			);
		}

		// Post-context
		const postStart = matchIdx + oldLines.length;
		for (let i = postStart; i < ctxEnd && emitted < limit; i++) {
			const ln = String(i + 1).padStart(gutterW);
			lines.push(
				truncateToWidth(
					theme.fg("dim", `  ${ln} │ `) +
						theme.fg("text", fileLines[i]),
					width,
				),
			);
			emitted++;
		}
	} else {
		// Can't locate in file — still try inline highlighting for similar pairs
		const oldSlice = oldLines.slice(0, DIFF_LINES_PER_HUNK);
		const newSlice = newLines.slice(0, DIFF_LINES_PER_HUNK);
		const pairCount = Math.min(oldSlice.length, newSlice.length);

		for (let i = 0; i < pairCount; i++) {
			if (shouldInlineDiff(oldSlice[i], newSlice[i])) {
				lines.push(
					renderInlineChangedLine(" ", "-", oldSlice[i], newSlice[i], width, theme),
				);
				lines.push(
					renderInlineChangedLine(" ", "+", newSlice[i], oldSlice[i], width, theme),
				);
			} else {
				lines.push(
					truncateToWidth(theme.fg("toolDiffRemoved", `  - ${oldSlice[i]}`), width),
				);
				lines.push(
					truncateToWidth(theme.fg("toolDiffAdded", `  + ${newSlice[i]}`), width),
				);
			}
		}

		for (let i = pairCount; i < oldSlice.length; i++) {
			lines.push(
				truncateToWidth(theme.fg("toolDiffRemoved", `  - ${oldSlice[i]}`), width),
			);
		}
		if (oldLines.length > DIFF_LINES_PER_HUNK) {
			lines.push(
				theme.fg(
					"dim",
					`    ... ${oldLines.length - DIFF_LINES_PER_HUNK} more removed`,
				),
			);
		}

		if (oldSlice.length > 0 && newLines.length > 0) {
			lines.push(theme.fg("dim", "    ───"));
		}

		for (let i = pairCount; i < newSlice.length; i++) {
			lines.push(
				truncateToWidth(theme.fg("toolDiffAdded", `  + ${newSlice[i]}`), width),
			);
		}
		if (newLines.length > DIFF_LINES_PER_HUNK) {
			lines.push(
				theme.fg(
					"dim",
					`    ... ${newLines.length - DIFF_LINES_PER_HUNK} more added`,
				),
			);
		}
	}

	return lines;
}

function buildDiffPreview(
	toolName: string,
	input: Record<string, unknown>,
	width: number,
	theme: any,
	cwd?: string,
): string[] {
	const lines: string[] = [];

	if (toolName === "edit") {
		const filePath = (input.path as string) ?? "";
		const fileLines = readFileLines(filePath, cwd);
		const edits = extractEdits(input);

		for (let i = 0; i < edits.length; i++) {
			const e = edits[i];

			// Multi-edit separator
			if (edits.length > 1) {
				if (i > 0) lines.push("");
				lines.push(
					theme.fg("dim", `  Edit ${i + 1}/${edits.length}:`),
				);
			}

			const hunk = buildHunkPreview(
				fileLines,
				e.oldText,
				e.newText,
				width,
				theme,
			);
			lines.push(...hunk);
		}
	} else {
		// Write tool — show content being written
		const filePath = (input.path as string) ?? "";
		let fileExists = false;
		try {
			const resolved = path.isAbsolute(filePath)
				? filePath
				: path.resolve(cwd ?? process.cwd(), filePath);
			fileExists = fs.existsSync(resolved);
		} catch {}

		if (fileExists) {
			lines.push(
				theme.fg("warning", "  ⚠ File exists — will be overwritten"),
			);
		} else {
			lines.push(theme.fg("dim", "  New file"));
		}

		const content = ((input.content as string) ?? "").split("\n");
		const slice = content.slice(0, DIFF_LINES_PER_HUNK);
		for (const line of slice) {
			lines.push(
				truncateToWidth(theme.fg("toolDiffAdded", `  + ${line}`), width),
			);
		}
		if (content.length > DIFF_LINES_PER_HUNK) {
			lines.push(
				theme.fg(
					"dim",
					`    ... ${content.length - DIFF_LINES_PER_HUNK} more lines`,
				),
			);
		}
	}

	return lines;
}

function showApprovalDialog(
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	isLarge: boolean,
	matchValue: string,
	cwd: string,
): Promise<ApprovalChoice | null> {
	const info = summarizeEdit(toolName, input);
	const previewCwd = cwd;

	const menuItems: MenuItem[] = [
		{
			key: "a",
			label: "Approve",
			description: "Proceed with this edit",
			accent: "success",
		},
		{
			key: "y",
			label: "Approve + Allow",
			description: "Approve & add allow rule for this path",
			accent: "success",
		},
		{
			key: "!",
			label: "Approve All",
			description: "Auto-approve all gated edits this session",
			accent: "accent",
		},
		{
			key: "r",
			label: "Reject",
			description: "Block this edit",
			accent: "error",
		},
		{
			key: "e",
			label: "Explain",
			description: "Ask for a detailed explanation",
			accent: "warning",
		},
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

		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function buildLines(width: number): string[] {
			const out: string[] = [];
			const innerWidth = width - 2;

			out.push(theme.fg("borderAccent", "─".repeat(width)));

			out.push(
				truncateToWidth(
					" " +
						theme.fg("accent", theme.bold("🔐 Permission Required")) +
						theme.fg("dim", ` — ${toolName}`),
					width,
				),
			);
			out.push("");

			out.push(
				truncateToWidth(
					" " +
						theme.fg("text", theme.bold("File: ")) +
						theme.fg("accent", info.file),
					width,
				),
			);
			out.push(
				truncateToWidth(
					" " +
						theme.fg("text", theme.bold("Change: ")) +
						theme.fg("muted", info.summary),
					width,
				),
			);

			if (isLarge) {
				out.push(
					truncateToWidth(
						" " +
							theme.fg(
								"warning",
								`⚠ Large edit (${info.lines} lines) — consider breaking down`,
							),
						width,
					),
				);
			}

			out.push("");

			if (showPreview) {
				out.push(" " + theme.fg("dim", "Preview:"));
				const preview = buildDiffPreview(
					toolName,
					input,
					innerWidth,
					theme,
					previewCwd,
				);
				for (const line of preview) {
					out.push(" " + line);
				}
				out.push("");
			}

			out.push(theme.fg("border", "─".repeat(width)));

			if (amendMode) {
				out.push(
					truncateToWidth(
						" " +
							theme.fg("accent", theme.bold("Additional instructions")) +
							theme.fg("dim", " (Enter to confirm, Esc to cancel):"),
						width,
					),
				);
				out.push(truncateToWidth(" " + theme.fg("text", `> ${amendText}█`), width));
				out.push("");
			} else {
				for (let i = 0; i < menuItems.length; i++) {
					const item = menuItems[i];
					const prefix = i === selectedIdx ? "▸ " : "  ";
					const keyTag = theme.fg("dim", `[${item.key}]`);
					const label =
						i === selectedIdx
							? theme.fg(item.accent, theme.bold(item.label))
							: theme.fg("text", item.label);
					const desc = theme.fg("muted", ` — ${item.description}`);
					out.push(
						truncateToWidth(
							` ${prefix}${keyTag} ${label}${desc}`,
							width,
						),
					);
				}

				out.push("");
				out.push(
					truncateToWidth(
						" " +
							theme.fg(
								"dim",
								"↑↓ navigate • enter/key select • ! approve all • tab amend • p preview • esc reject",
							),
						width,
					),
				);
			}

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
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						amendText += data;
						invalidate();
						tui.requestRender();
						return;
					}
					return;
				}

				if (matchesKey(data, Key.up)) {
					selectedIdx = Math.max(0, selectedIdx - 1);
					invalidate();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIdx = Math.min(
						menuItems.length - 1,
						selectedIdx + 1,
					);
					invalidate();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const item = menuItems[selectedIdx];
					const actionMap: Record<string, ApprovalChoice["action"]> = {
						"a": "approve",
						"y": "approve",
						"!": "approve_all",
						"r": "reject",
						"e": "explain",
						"b": "breakdown",
					};
					finishWithChoice(actionMap[item.key] ?? "reject");
					// If "y" was selected, tag extra so caller adds a rule
					if (item.key === "y") {
						(done as any).__addRule = true;
					}
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done({ action: "reject" });
					return;
				}

				if (data === "a" || data === "A") {
					finishWithChoice("approve");
					return;
				}
				if (data === "y" || data === "Y") {
					done({
						action: "approve",
						extra: `__ADD_RULE__`,
					} as ApprovalChoice);
					return;
				}
				if (data === "!") {
					finishWithChoice("approve_all");
					return;
				}
				if (data === "r" || data === "R") {
					finishWithChoice("reject");
					return;
				}
				if (data === "e" || data === "E") {
					finishWithChoice("explain");
					return;
				}
				if ((data === "b" || data === "B") && isLarge) {
					finishWithChoice("breakdown");
					return;
				}

				if (matchesKey(data, Key.tab)) {
					amendMode = true;
					invalidate();
					tui.requestRender();
					return;
				}

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
// Rule suggestion helpers
// ---------------------------------------------------------------------------

/**
 * Suggest an allow rule for a given tool call.
 * For file tools, uses the directory + glob.
 * For bash, uses the first word of the command.
 */
function suggestAllowRule(
	toolName: string,
	matchValue: string,
): string {
	const toolTitle =
		toolName.charAt(0).toUpperCase() + toolName.slice(1);

	if (toolName === "bash") {
		// Use the first word/command as prefix
		const firstWord = matchValue.split(/\s+/)[0];
		return `${toolTitle}(${firstWord} *)`;
	}

	// For file tools, use the directory pattern
	const dir = path.dirname(matchValue);
	const ext = path.extname(matchValue);
	if (dir === "/tmp" || dir.startsWith("/tmp/")) {
		return `${toolTitle}(/tmp/**)`;
	}
	if (ext) {
		return `${toolTitle}(${dir}/*${ext})`;
	}
	return `${toolTitle}(${dir}/*)`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function permissionsExtension(pi: ExtensionAPI): void {
	let config: PermissionsConfig = loadConfig();
	let allowRules: ParsedRule[] = [];
	let denyRules: ParsedRule[] = [];
	let approveAll = false; // Session-scoped: skip gated prompts when true

	function reloadRules() {
		config = loadConfig();
		allowRules = config.allow
			.map(parseRule)
			.filter((r): r is ParsedRule => r !== null);
		denyRules = config.deny
			.map(parseRule)
			.filter((r): r is ParsedRule => r !== null);
	}

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		approveAll = false;
		reloadRules();
		updateStatus(ctx);
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (approveAll) {
			ctx.ui.setStatus(
				"permissions",
				ctx.ui.theme.fg(
					"warning",
					`🔐 auto-approved · ${denyRules.length} deny still enforced`,
				),
			);
		} else {
			const gated = config.gate.join(", ");
			ctx.ui.setStatus(
				"permissions",
				ctx.ui.theme.fg(
					"success",
					`🔐 ${allowRules.length} allow, ${denyRules.length} deny · gating: ${gated}`,
				),
			);
		}
	}

	// --- Commands ---

	pi.registerCommand("permissions", {
		description: "Show current permission rules",
		handler: async (_args, ctx) => {
			reloadRules();

			const lines: string[] = [];
			lines.push(`Permissions (${approveAll ? "AUTO-APPROVED" : "GATED"})`);
			lines.push(`Config: ${CONFIG_PATH}`);
			lines.push("");
			lines.push(`Gate: ${config.gate.join(", ") || "(none)"}`);
			lines.push("");
			lines.push(`Allow rules (${config.allow.length}):`);
			for (const rule of config.allow) {
				lines.push(`  ✅ ${rule}`);
			}
			lines.push("");
			lines.push(`Deny rules (${config.deny.length}):`);
			for (const rule of config.deny) {
				lines.push(`  ❌ ${rule}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("permit", {
		description:
			"Add an allow rule (e.g., /permit Write(/tmp/**))",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage: /permit Tool(pattern)\nExample: /permit Write(/tmp/**)",
					"warning",
				);
				return;
			}

			const rule = args.trim();
			const parsed = parseRule(rule);
			if (!parsed) {
				ctx.ui.notify(
					`Invalid rule format: ${rule}\nExpected: Tool(pattern)`,
					"error",
				);
				return;
			}

			if (!config.allow.includes(rule)) {
				config.allow.push(rule);
				saveConfig(config);
				reloadRules();
			}

			updateStatus(ctx);
			ctx.ui.notify(`✅ Added allow rule: ${rule}`, "success");
		},
	});

	pi.registerCommand("deny", {
		description: "Add a deny rule (e.g., /deny Write(.env))",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage: /deny Tool(pattern)\nExample: /deny Write(.env)",
					"warning",
				);
				return;
			}

			const rule = args.trim();
			const parsed = parseRule(rule);
			if (!parsed) {
				ctx.ui.notify(
					`Invalid rule format: ${rule}\nExpected: Tool(pattern)`,
					"error",
				);
				return;
			}

			if (!config.deny.includes(rule)) {
				config.deny.push(rule);
				saveConfig(config);
				reloadRules();
			}

			updateStatus(ctx);
			ctx.ui.notify(`❌ Added deny rule: ${rule}`, "info");
		},
	});

	pi.registerCommand("permit-remove", {
		description: "Remove a rule from allow or deny list",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					"Usage: /permit-remove Tool(pattern)",
					"warning",
				);
				return;
			}

			const rule = args.trim();
			const inAllow = config.allow.indexOf(rule);
			const inDeny = config.deny.indexOf(rule);

			if (inAllow >= 0) {
				config.allow.splice(inAllow, 1);
				saveConfig(config);
				reloadRules();
				ctx.ui.notify(`Removed from allow: ${rule}`, "info");
			} else if (inDeny >= 0) {
				config.deny.splice(inDeny, 1);
				saveConfig(config);
				reloadRules();
				ctx.ui.notify(`Removed from deny: ${rule}`, "info");
			} else {
				ctx.ui.notify(`Rule not found: ${rule}`, "warning");
			}

			updateStatus(ctx);
		},
	});

	pi.registerCommand("permit-toggle", {
		description: "Toggle between per-edit prompts and approve-all for this session",
		handler: async (_args, ctx) => {
			approveAll = !approveAll;
			updateStatus(ctx);
			ctx.ui.notify(
				approveAll
					? "🔐 Auto-approve — gated edits proceed without prompts (deny rules still enforced)"
					: "🔐 Gated — you'll be prompted for each edit",
				"info",
			);
		},
	});

	// Keyboard shortcut
	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Toggle permissions: gated ↔ approve-all",
		handler: async (ctx) => {
			approveAll = !approveAll;
			updateStatus(ctx);
			ctx.ui.notify(
				approveAll ? "🔐 Auto-approved" : "🔐 Gated",
				"info",
			);
		},
	});

	// --- The main gate ---

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const input = event.input as Record<string, unknown>;
		const matchValue = getMatchValue(toolName, input, ctx.cwd);

		// 1. Deny rules are ALWAYS enforced, even in approve-all mode
		for (const rule of denyRules) {
			if (matchesRule(rule, toolName, matchValue)) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`🚫 Blocked by deny rule: ${rule.original}`,
						"warning",
					);
				}
				return {
					block: true,
					reason: `Blocked by deny rule: ${rule.original}`,
				};
			}
		}

		// 2. Check allow rules (auto-approve)
		for (const rule of allowRules) {
			if (matchesRule(rule, toolName, matchValue)) {
				return undefined;
			}
		}

		// 3. If tool is not in the gate list, allow by default
		if (!config.gate.includes(toolName.toLowerCase())) {
			return undefined;
		}

		// 4. Approve-all mode — skip dialog for gated tools
		if (approveAll) return undefined;

		// 5. Tool is gated and no rule matched — prompt user
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "No permission rule matched and no UI for approval",
			};
		}

		const info = summarizeEdit(toolName, input);
		const isLarge = info.lines >= LARGE_EDIT_THRESHOLD;

		const choice = await showApprovalDialog(
			ctx,
			toolName,
			input,
			isLarge,
			matchValue,
			ctx.cwd,
		);

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
			ctx.ui.notify("Auto-approve enabled — gated edits proceed without prompts (deny rules still enforced)", "info");
			if (choice.extra) {
				pi.sendMessage(
					{
						customType: "permissions-note",
						content: `[Approved-all with note] ${choice.extra}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
			return undefined;
		}

		// Approved — check if user wants to add an allow rule
		if (choice.extra === "__ADD_RULE__") {
			const suggested = suggestAllowRule(toolName, matchValue);
			if (!config.allow.includes(suggested)) {
				config.allow.push(suggested);
				saveConfig(config);
				reloadRules();
				if (ctx.hasUI) {
					ctx.ui.notify(
						`✅ Added allow rule: ${suggested}`,
						"success",
					);
					updateStatus(ctx);
				}
			}
		} else if (choice.extra) {
			pi.sendMessage(
				{
					customType: "permissions-note",
					content: `[Edit approved with note] ${choice.extra}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		return undefined; // Allow
	});
}
