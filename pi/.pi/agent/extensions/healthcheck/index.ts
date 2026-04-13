/**
 * Healthcheck — Verify all custom-built systems are working.
 *
 * Runs checks across waybar modules, calendar integration, the unified
 * update system, pi extensions, and extension data files. Shows results
 * in a grouped overlay with pass/fail/warn indicators.
 *
 * Shells out to ~/.local/bin/healthcheck --json for the actual checks,
 * then presents results in a rich TUI overlay.
 *
 * Commands:
 *   /healthcheck          — Run all checks and show results
 *   /healthcheck <group>  — Run only one group (waybar, calendar, updates, extensions, data)
 *   /healthcheck quiet    — Show only failures and warnings
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList, truncateToWidth } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

interface CheckResult {
	status: "pass" | "fail" | "warn" | "skip";
	group: string;
	name: string;
	detail: string;
}

// ── Config ─────────────────────────────────────────────────────────

const HEALTHCHECK_BIN = join(homedir(), ".local", "bin", "healthcheck");

const GROUP_LABELS: Record<string, string> = {
	waybar: "Waybar Infrastructure",
	calendar: "Google Calendar Modules",
	updates: "Unified Update System",
	extensions: "Pi Extensions",
	data: "Extension Data Files",
};

const GROUP_ICONS: Record<string, string> = {
	waybar: "🖥",
	calendar: "📅",
	updates: "🔄",
	extensions: "🧩",
	data: "💾",
};

const STATUS_ICONS: Record<string, string> = {
	pass: "✓",
	fail: "✗",
	warn: "⚠",
	skip: "○",
};

const STATUS_COLORS: Record<string, string> = {
	pass: "green",
	fail: "red",
	warn: "yellow",
	skip: "gray",
};

// ── Run healthcheck script ─────────────────────────────────────────

function runHealthcheck(filter?: string): Promise<CheckResult[]> {
	return new Promise((resolve) => {
		const args = ["--json"];
		if (filter && filter !== "quiet") args.push(filter);

		execFile(HEALTHCHECK_BIN, args, { timeout: 60_000 }, (err, stdout, stderr) => {
			if (stderr) {
				// Script may write to stderr on some checks
			}
			try {
				const raw = stdout.trim();
				const results: CheckResult[] = JSON.parse(raw);
				resolve(results);
			} catch {
				// If JSON parse fails, return a single error result
				resolve([
					{
						status: "fail",
						group: "healthcheck",
						name: "script execution",
						detail: err ? err.message : "failed to parse output",
					},
				]);
			}
		});
	});
}

// ── Build SelectList items ─────────────────────────────────────────

function buildItems(results: CheckResult[], quietMode: boolean): SelectItem[] {
	const items: SelectItem[] = [];
	let currentGroup = "";

	for (const r of results) {
		// Skip passes in quiet mode
		if (quietMode && (r.status === "pass" || r.status === "skip")) continue;

		// Group separator
		if (r.group !== currentGroup) {
			currentGroup = r.group;
			if (items.length > 0) {
				items.push({
					label: "",
					value: `sep-${r.group}`,
					disabled: true,
				});
			}
			const icon = GROUP_ICONS[r.group] || "▪";
			items.push({
				label: `${icon} ${GROUP_LABELS[r.group] || r.group}`,
				value: `header-${r.group}`,
				disabled: true,
			});
		}

		// Result item
		const icon = STATUS_ICONS[r.status];
		const detail = r.detail ? `  ${r.detail}` : "";
		items.push({
			label: `  ${icon} ${r.name}${detail}`,
			value: `${r.group}:${r.name}`,
			color: STATUS_COLORS[r.status] as any,
		});
	}

	return items;
}

function buildSummary(results: CheckResult[]): string {
	const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
	for (const r of results) counts[r.status]++;

	const parts: string[] = [];
	if (counts.pass > 0) parts.push(`✓ ${counts.pass} passed`);
	if (counts.fail > 0) parts.push(`✗ ${counts.fail} failed`);
	if (counts.warn > 0) parts.push(`⚠ ${counts.warn} warnings`);
	if (counts.skip > 0) parts.push(`○ ${counts.skip} skipped`);

	const allGood = counts.fail === 0 && counts.warn === 0;
	return allGood ? `${parts.join("  ")}  ✨ all systems healthy` : parts.join("  ");
}

// ── Extension ──────────────────────────────────────────────────────

export default function healthcheck(ctx: ExtensionAPI) {
	ctx.registerCommand("healthcheck", {
		description: "Check that all custom-built systems are working",
		handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
			args = args?.trim() || "";
			const quietMode = args === "quiet";
			const filter = args && !quietMode ? args : undefined;

			// Show loading state
			const loadingItems: SelectItem[] = [
				{ label: "  Running healthchecks...", value: "loading", disabled: true },
			];

			let overlay: any;
			const show = (items: SelectItem[], title: string) => {
				if (overlay) overlay.unmount();
				overlay = new SelectList(cmdCtx.terminal, {
					items,
					title,
					onSelect: () => {
						overlay?.unmount();
					},
					onCancel: () => {
						overlay?.unmount();
					},
				});
				overlay.mount();
			};

			show(loadingItems, "🏥 Healthcheck");

			// Run checks
			const results = await runHealthcheck(filter);
			const items = buildItems(results, quietMode);
			const summary = buildSummary(results);

			// Add summary at the bottom
			items.push({ label: "", value: "sep-summary", disabled: true });
			items.push({
				label: `  ${summary}`,
				value: "summary",
				disabled: true,
			});

			const title = filter
				? `🏥 Healthcheck: ${GROUP_LABELS[filter] || filter}`
				: "🏥 Healthcheck";

			show(items, title);
		},
	});
}
