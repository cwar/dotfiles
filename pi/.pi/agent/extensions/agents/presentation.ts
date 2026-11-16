import type { JobRecord } from "./supervisor.js";

export interface AgentCounts {
	working: number;
	needsInput: number;
	idle: number;
}

export interface ParsedDispatchInput {
	prompt: string;
	idleTimeoutMinutes?: number;
	hardTimeoutMinutes?: number;
}

export function parseDispatchInput(input: string): ParsedDispatchInput {
	let rest = input.trim();
	const result: ParsedDispatchInput = { prompt: "" };
	while (rest.startsWith("--")) {
		const match = rest.match(/^--(idle|hard)=([0-9]+(?:[.][0-9]+)?)(?:\s+|$)/);
		if (!match) break;
		const value = Number(match[2]);
		if (match[1] === "idle") result.idleTimeoutMinutes = value;
		else result.hardTimeoutMinutes = value;
		rest = rest.slice(match[0].length).trimStart();
	}
	result.prompt = rest;
	return result;
}

export function countVisibleAgents(jobs: Array<Pick<JobRecord, "state" | "alive">>): AgentCounts {
	const counts: AgentCounts = { working: 0, needsInput: 0, idle: 0 };
	for (const job of jobs) {
		if (job.alive === false) continue;
		if (job.state === "working" || job.state === "starting") counts.working++;
		else if (job.state === "needs_input") counts.needsInput++;
		else if (job.state === "idle") counts.idle++;
	}
	return counts;
}

export function formatFooterStatus(jobs: Array<Pick<JobRecord, "state" | "alive">>): string | undefined {
	const counts = countVisibleAgents(jobs);
	if (counts.working + counts.needsInput + counts.idle === 0) return undefined;
	const parts: string[] = [];
	if (counts.working) parts.push(`${counts.working} working`);
	if (counts.needsInput) parts.push(`${counts.needsInput} needs input`);
	if (counts.idle) parts.push(`${counts.idle} idle`);
	return `Agents: ${parts.join(" · ")} — Alt+A`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes ? `${hours}h${remainingMinutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours ? `${days}d${remainingHours}h` : `${days}d`;
}

export function formatActivity(
	job: Pick<JobRecord, "startedAt" | "lastActivityAt" | "lastUpdate">,
	now = Date.now(),
): string {
	const startedAt = Date.parse(job.startedAt);
	const activityAt = Date.parse(job.lastActivityAt || job.lastUpdate);
	return `run ${formatDuration(now - startedAt)} · idle ${formatDuration(now - activityAt)}`;
}

export function formatTimeout(ms: number): string {
	return ms === 0 ? "off" : formatDuration(ms);
}
