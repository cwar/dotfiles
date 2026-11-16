/**
 * Agent View component.
 *
 * Full-screen TUI that lists every background pi session, lets you peek at
 * the latest output of the selected one, dispatch new sessions from the
 * input line at the bottom, and attach / reply / stop with keyboard
 * shortcuts. The component itself is purely view layer; all spawning,
 * killing and IPC goes through `supervisor.ts`.
 *
 * Return contract (the value `done()` resolves with):
 *
 *   { action: "exit" }                    user pressed Esc, nothing else to do
 *   { action: "attach", id }              attach to bg session `id`. Caller
 *                                         must stop the runner, then switch
 *                                         the foreground session to its file.
 *   { action: "dispatch", prompt }        dispatch a new bg session with this
 *                                         prompt.
 *   { action: "reply", id, message }      send a follow-up to bg session `id`
 *                                         without attaching.
 *
 * The view polls state.json files at a low frequency (500ms) instead of
 * watching them with `fs.watch`. Polling is simpler, robust to atomic
 * rename writes, and 500ms is well under the perception threshold for an
 * "is something happening?" status display.
 */

import type { Theme, Component } from "@mariozechner/pi-tui";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatActivity, formatTimeout } from "./presentation.js";
import { list as listJobs, peek as peekJob, groupOf, type JobRecord, type JobState } from "./supervisor.js";

// ── Visuals ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATE_ICONS: Record<JobState, string> = {
	starting: "✻",
	working: "✽",
	needs_input: "❓",
	idle: "·",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

function stateColor(theme: Theme, s: JobState): (t: string) => string {
	switch (s) {
		case "working":
		case "starting":
			return (t) => theme.fg("accent", t);
		case "needs_input":
			return (t) => theme.fg("warning", t);
		case "idle":
			return (t) => theme.fg("muted", t);
		case "completed":
			return (t) => theme.fg("success", t);
		case "failed":
			return (t) => theme.fg("error", t);
		case "stopped":
			return (t) => theme.fg("dim", t);
		default:
			return (t) => t;
	}
}

// ── View result ────────────────────────────────────────────────────

export type ViewResult =
	| { action: "exit" }
	| { action: "attach"; id: string; sessionFile: string }
	| { action: "dispatch"; prompt: string }
	| { action: "reply"; id: string; message: string }
	| { action: "stop"; id: string }
	| { action: "remove"; id: string };

// ── Component ──────────────────────────────────────────────────────

type Group = "needs_input" | "working" | "idle" | "done";

const GROUP_TITLES: Record<Group, string> = {
	needs_input: "Needs input",
	working: "Working",
	idle: "Idle (auto-stop pending)",
	done: "Finished",
};

const GROUP_ORDER: Group[] = ["needs_input", "working", "idle", "done"];

export class AgentView implements Component {
	private theme: Theme;
	private done: (r: ViewResult) => void;
	private requestRender: () => void;

	private jobs: JobRecord[] = [];
	private selectedId: string | null = null;
	private inputBuffer: string = "";
	private inputMode: "dispatch" | "reply" = "dispatch";
	private replyTargetId: string | null = null;
	private spinnerTick = 0;
	private peekCache: { id: string; text: string; ts: number } | null = null;

	private cachedWidth?: number;
	private cachedLines?: string[];

	private pollTimer: ReturnType<typeof setInterval>;
	private spinnerTimer: ReturnType<typeof setInterval>;

	constructor(
		theme: Theme,
		done: (r: ViewResult) => void,
		requestRender: () => void,
		initialSelectedId?: string,
	) {
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
		this.selectedId = initialSelectedId ?? null;

		this.refresh();
		// 500ms poll keeps "Working" rows feeling live without burning CPU.
		this.pollTimer = setInterval(() => {
			this.refresh();
		}, 500);
		// 100ms spinner so animated rows feel snappy. We only redraw if any
		// working session exists; otherwise we skip the request to save work.
		this.spinnerTimer = setInterval(() => {
			this.spinnerTick = (this.spinnerTick + 1) % SPINNER_FRAMES.length;
			if (this.hasAnimated()) {
				this.invalidate();
				this.requestRender();
			}
		}, 120);
	}

	dispose() {
		clearInterval(this.pollTimer);
		clearInterval(this.spinnerTimer);
	}

	private hasAnimated(): boolean {
		return this.jobs.some((j) => j.state === "working" || j.state === "starting");
	}

	private refresh() {
		const prev = JSON.stringify(this.jobs.map((j) => `${j.id}:${j.state}:${j.lastUpdate}:${j.summary}`));
		this.jobs = listJobs();
		const next = JSON.stringify(this.jobs.map((j) => `${j.id}:${j.state}:${j.lastUpdate}:${j.summary}`));

		// Reselect: if our selection vanished, pick the first row.
		if (this.selectedId && !this.jobs.find((j) => j.id === this.selectedId)) {
			this.selectedId = null;
		}
		if (!this.selectedId && this.jobs.length > 0) {
			// Prefer a needs_input session, else the first one.
			const ni = this.jobs.find((j) => j.state === "needs_input");
			this.selectedId = (ni ?? this.jobs[0]).id;
		}

		if (prev !== next) {
			this.invalidate();
			this.requestRender();
		}
	}

	private orderedRows(): { group: Group; jobs: JobRecord[] }[] {
		const buckets: Record<Group, JobRecord[]> = { needs_input: [], working: [], idle: [], done: [] };
		for (const job of this.jobs) buckets[groupOf(job)].push(job);
		return GROUP_ORDER.map((group) => ({ group, jobs: buckets[group] })).filter((bucket) => bucket.jobs.length > 0);
	}

	/** Flat selectable list in display order. */
	private flatRows(): JobRecord[] {
		return this.orderedRows().flatMap((b) => b.jobs);
	}

	private selectedIndex(): number {
		const flat = this.flatRows();
		return flat.findIndex((j) => j.id === this.selectedId);
	}

	private moveSelection(delta: number) {
		const flat = this.flatRows();
		if (flat.length === 0) return;
		let i = this.selectedIndex();
		if (i < 0) i = 0;
		i = Math.max(0, Math.min(flat.length - 1, i + delta));
		this.selectedId = flat[i].id;
		this.invalidate();
		this.requestRender();
	}

	private getPeekText(id: string): string {
		const now = Date.now();
		if (this.peekCache && this.peekCache.id === id && now - this.peekCache.ts < 500) {
			return this.peekCache.text;
		}
		const text = peekJob(id, 6 * 1024);
		this.peekCache = { id, text, ts: now };
		return text;
	}

	// ── Input handling ────────────────────────────────────────────

	handleInput(data: string): void {
		// Navigation keys take priority. We treat the input field as a
		// secondary concern: only printable characters and Enter target it.
		if (matchesKey(data, Key.escape)) {
			this.done({ action: "exit" });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			// Attach
			this.attemptAttach();
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			// Stop (if alive) or delete (if already terminal)
			const sel = this.selected();
			if (!sel) return;
			if (sel.alive && sel.state !== "completed" && sel.state !== "failed" && sel.state !== "stopped") {
				this.done({ action: "stop", id: sel.id });
			} else {
				this.done({ action: "remove", id: sel.id });
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			// Refresh now
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			// Toggle dispatch vs. reply target. If a session is selected,
			// "reply" sends to that session; otherwise dispatch a new one.
			if (this.inputMode === "dispatch" && this.selected()) {
				this.inputMode = "reply";
				this.replyTargetId = this.selected()!.id;
			} else {
				this.inputMode = "dispatch";
				this.replyTargetId = null;
			}
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			// If input is empty: attach to selected.
			if (this.inputBuffer.trim() === "") {
				this.attemptAttach();
				return;
			}
			// Otherwise: dispatch new (or reply if in reply mode).
			const text = this.inputBuffer.trim();
			this.inputBuffer = "";
			if (this.inputMode === "reply" && this.replyTargetId) {
				this.done({ action: "reply", id: this.replyTargetId, message: text });
			} else {
				this.done({ action: "dispatch", prompt: text });
			}
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.inputBuffer.length > 0) {
				this.inputBuffer = this.inputBuffer.slice(0, -1);
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		// Printable characters fall through into the input buffer.
		if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
			this.inputBuffer += data;
			this.invalidate();
			this.requestRender();
			return;
		}
		// Multi-byte UTF-8 input (pasted unicode etc.) — accept if no control bytes.
		if (data.length > 1 && !/[\x00-\x1f]/.test(data)) {
			this.inputBuffer += data;
			this.invalidate();
			this.requestRender();
			return;
		}
	}

	private selected(): JobRecord | undefined {
		return this.jobs.find((j) => j.id === this.selectedId);
	}

	private attemptAttach() {
		const sel = this.selected();
		if (!sel) return;
		this.done({ action: "attach", id: sel.id, sessionFile: sel.sessionFile });
	}

	// ── Rendering ─────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;

		const theme = this.theme;
		const lines: string[] = [];

		// ── Header ────────────────────────────────────────────────
		const working = this.jobs.filter((j) => j.state === "working" || j.state === "starting").length;
		const needs = this.jobs.filter((j) => j.state === "needs_input").length;
		const done = this.jobs.filter((j) => j.state === "completed" || j.state === "failed" || j.state === "stopped").length;
		const idle = this.jobs.filter((j) => j.state === "idle").length;

		const headerLeft = theme.bold(theme.fg("accent", "Agent View"));
		const headerRight =
			theme.fg("muted", `${this.jobs.length} sessions · `) +
			theme.fg("warning", `${needs} needs input`) +
			theme.fg("muted", " · ") +
			theme.fg("accent", `${working} working`) +
			theme.fg("muted", " · ") +
			theme.fg("muted", `${idle} idle`) +
			theme.fg("muted", " · ") +
			theme.fg("dim", `${done} finished`);
		lines.push(padBetween(headerLeft, headerRight, width));
		lines.push(theme.fg("dim", "─".repeat(width)));

		// ── Body: groups & rows ───────────────────────────────────
		const groups = this.orderedRows();
		if (groups.length === 0) {
			lines.push("");
			lines.push(centerLine(theme.fg("muted", "No background sessions. Type a prompt below and press Enter to dispatch."), width));
			lines.push("");
		}

		for (const { group, jobs } of groups) {
			lines.push("");
			lines.push(theme.fg("muted", `  ${GROUP_TITLES[group]}`));
			for (const j of jobs) {
				lines.push(this.renderRow(j, width));
			}
		}

		// ── Peek panel ────────────────────────────────────────────
		const sel = this.selected();
		lines.push("");
		lines.push(theme.fg("dim", "─".repeat(width)));
		if (sel) {
			const peekHeader =
				theme.bold(theme.fg("text", sel.name)) +
				theme.fg("muted", `  ${sel.id}`) +
				theme.fg("muted", `  ${sel.cwd.replace(process.env.HOME ?? "~~", "~")}`) +
				(sel.model ? theme.fg("muted", `  · ${sel.model}`) : "");
			lines.push(truncateToWidth(peekHeader, width));
			lines.push(
				truncateToWidth(
					theme.fg("dim", `${formatActivity(sel)} · idle limit ${formatTimeout(sel.idleTimeoutMs)} · hard limit ${formatTimeout(sel.hardTimeoutMs)}`),
					width,
				),
			);

			// Show needs_input details if applicable.
			if (sel.needsInput) {
				lines.push(theme.fg("warning", `  ⚑ ${sel.needsInput.method}: ${sel.needsInput.message || sel.needsInput.title}`));
				if (sel.needsInput.options && Array.isArray(sel.needsInput.options)) {
					for (const [i, opt] of (sel.needsInput.options as any[]).entries()) {
						const label = typeof opt === "string" ? opt : opt.label || opt.value || JSON.stringify(opt);
						lines.push(theme.fg("muted", `    ${i + 1}. `) + label);
					}
				}
			}

			// Tail of transcript
			const text = this.getPeekText(sel.id);
			const tailLines = text
				.split("\n")
				.slice(-Math.max(4, this.peekHeightFor(lines.length, width)))
				.map((l) => truncateToWidth(theme.fg("dim", "│ ") + l, width));
			if (tailLines.length === 0) {
				lines.push(theme.fg("dim", "│ (no output yet)"));
			} else {
				lines.push(...tailLines);
			}
		} else {
			lines.push(theme.fg("muted", "(no session selected)"));
		}

		// ── Dispatch / reply input ────────────────────────────────
		lines.push(theme.fg("dim", "─".repeat(width)));
		const prefix =
			this.inputMode === "reply"
				? theme.fg("warning", `Reply ${this.replyTargetId} > `)
				: theme.fg("accent", "Dispatch > ");
		const cursor = "▎";
		const inputLine = truncateToWidth(prefix + this.inputBuffer + theme.fg("muted", cursor), width);
		lines.push(inputLine);

		// ── Footer ────────────────────────────────────────────────
		const footer = [
			"↑↓ select",
			"enter attach/send",
			"tab dispatch/reply",
			"ctrl+x stop/remove",
			"esc exit",
		].map((s) => theme.fg("dim", s)).join(theme.fg("dim", " · "));
		lines.push(truncateToWidth(footer, width));

		this.cachedLines = lines;
		return lines;
	}

	private peekHeightFor(currentLines: number, _width: number): number {
		// Leave at least a few lines for the input + footer. We don't know the
		// terminal height here directly (TUI clips for us) so we just pick a
		// reasonable number. The TUI renderer handles overflow gracefully.
		return 8;
	}

	private renderRow(j: JobRecord, width: number): string {
		const theme = this.theme;
		const isSelected = j.id === this.selectedId;
		const gutter = isSelected ? theme.fg("accent", "▶ ") : "  ";
		const icon =
			j.state === "working" || j.state === "starting"
				? stateColor(theme, j.state)(SPINNER_FRAMES[this.spinnerTick])
				: stateColor(theme, j.state)(STATE_ICONS[j.state] || "·");
		const nameWidth = Math.min(28, Math.floor(width * 0.28));
		const name = padRight(truncateToWidth(j.name, nameWidth, "…"), nameWidth);
		const summary = j.summary || "";
		const age = formatActivity(j);
		const dead = j.alive ? "" : theme.fg("dim", " · ∙");

		const middle =
			theme.fg(isSelected ? "text" : "muted", summary);

		const right = theme.fg("dim", age) + dead;

		// Build the row left-aligning name + summary, right-aligning the age.
		const leftPart = `${gutter}${icon} ${name}  ${middle}`;
		const leftVisible = visibleWidth(leftPart);
		const rightVisible = visibleWidth(right);
		const space = Math.max(1, width - leftVisible - rightVisible);
		const row = leftPart + " ".repeat(space) + right;
		// Truncate just in case styling miscounts.
		return truncateToWidth(row, width);
	}
}

// ── Layout helpers ────────────────────────────────────────────────

function padRight(s: string, n: number): string {
	const w = visibleWidth(s);
	if (w >= n) return s;
	return s + " ".repeat(n - w);
}

function padBetween(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	const space = Math.max(1, width - lw - rw);
	return truncateToWidth(left + " ".repeat(space) + right, width);
}

function centerLine(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return truncateToWidth(s, width);
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + s;
}
