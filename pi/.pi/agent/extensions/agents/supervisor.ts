/**
 * Supervisor: job-registry and control-channel helper for the agents extension.
 *
 * There is no long-lived daemon process. The supervisor is just a set of pure
 * functions that operate on disk-backed job directories at
 * `~/.cache/pi-agents/jobs/<id>/`:
 *
 *   state.json     persistent status of one background pi session
 *   transcript.txt human-readable trailing transcript (peek panel)
 *   events.jsonl   raw RPC event log (debug)
 *   control.sock   per-job Unix socket exposed by the runner
 *   runner.log     trace log from the runner process
 *
 * Each background session is owned by a detached `node runner.js` child.
 * `dispatch()` spawns one; `list()` reads roster from disk; `send()` talks
 * to a runner over its control socket; `stop()` and `remove()` clean up.
 *
 * Cross-cutting design note: this module is intentionally pure side-effects
 * on the filesystem + sockets. It must not depend on `ExtensionAPI` or any
 * runtime pi state so it remains usable both from the in-process extension
 * (`index.ts`) and from any future CLI shim that wants to manage jobs.
 */

import { execFileSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = join(homedir(), ".cache", "pi-agents");
export const JOBS_DIR = join(ROOT, "jobs");

const RUNNER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "runner.js");

// ── Types ──────────────────────────────────────────────────────────

export type JobState =
	| "starting"
	| "working"
	| "needs_input"
	| "idle"
	| "completed"
	| "failed"
	| "stopped";

export interface NeedsInput {
	id: string;
	method: string; // select | confirm | input | editor
	title: string;
	message: string;
	options: any;
	defaultValue: string;
}

export interface JobRecord {
	id: string;
	name: string;
	state: JobState;
	summary: string;
	prompt: string;
	cwd: string;
	sessionFile: string;
	model: string;
	pid: number;
	runnerPid: number;
	piPid: number | null;
	startedAt: string;
	lastUpdate: string;
	lastActivityAt: string;
	settledAt: string | null;
	idleTimeoutMs: number;
	hardTimeoutMs: number;
	hardDeadlineAt: string | null;
	stopReason: string | null;
	turns: number;
	tools: number;
	lastAssistantPreview: string;
	needsInput: NeedsInput | null;
	alive?: boolean;
}

export interface DispatchOptions {
	prompt: string;
	cwd?: string;
	name?: string;
	model?: string;
	idleTimeoutMinutes?: number;
	hardTimeoutMinutes?: number;
	sessionDir?: string;
	piBin?: string;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	pgrp: number;
}

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
export const DEFAULT_HARD_TIMEOUT_MINUTES = 120;

// ── Helpers ────────────────────────────────────────────────────────

function ensureDirs() {
	mkdirSync(JOBS_DIR, { recursive: true });
}

function newId(): string {
	// Short, sortable-ish id. 4 bytes = 32 bits = enough collision resistance
	// for "jobs on my laptop".
	return randomBytes(4).toString("hex");
}

function isAlive(pid: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function jobDirOf(id: string): string {
	return join(JOBS_DIR, id);
}

function statePathOf(id: string): string {
	return join(jobDirOf(id), "state.json");
}

function sockPathOf(id: string): string {
	return join(jobDirOf(id), "control.sock");
}

function readState(id: string): JobRecord | null {
	const p = statePathOf(id);
	if (!existsSync(p)) return null;
	try {
		const raw = readFileSync(p, "utf8");
		const obj = JSON.parse(raw) as JobRecord;
		obj.lastActivityAt ||= obj.lastUpdate;
		obj.settledAt ??= obj.state === "idle" ? obj.lastUpdate : null;
		obj.idleTimeoutMs ??= DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000;
		obj.hardTimeoutMs ??= DEFAULT_HARD_TIMEOUT_MINUTES * 60_000;
		obj.hardDeadlineAt ??= obj.hardTimeoutMs > 0
			? new Date(Date.parse(obj.startedAt) + obj.hardTimeoutMs).toISOString()
			: null;
		obj.stopReason ??= null;
		obj.alive = isAlive(obj.runnerPid ?? obj.pid) || (obj.piPid ? isAlive(obj.piPid) : false);
		return obj;
	} catch {
		return null;
	}
}

export function normalizeTimeoutMinutes(value: number | undefined, fallback: number): number {
	const minutes = value ?? fallback;
	if (!Number.isFinite(minutes) || minutes < 0) throw new Error("timeout must be a non-negative number of minutes");
	return Math.round(minutes * 60_000);
}

function processSnapshot(): ProcessRow[] {
	try {
		const output = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], { encoding: "utf8" });
		return output
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
			.map(([pid, ppid, pgrp]) => ({ pid, ppid, pgrp }));
	} catch {
		return [];
	}
}

export function collectProcessTree(snapshot: ProcessRow[], rootPids: number[]): number[] {
	const roots = new Set(rootPids.filter((pid) => pid > 1));
	const children = new Map<number, number[]>();
	for (const row of snapshot) {
		const list = children.get(row.ppid) ?? [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const ordered: number[] = [];
	const visited = new Set<number>();
	function visit(pid: number) {
		if (visited.has(pid)) return;
		visited.add(pid);
		for (const child of children.get(pid) ?? []) visit(child);
		ordered.push(pid);
	}
	for (const root of roots) visit(root);
	return ordered;
}

function signalJobTree(rec: JobRecord, signal: NodeJS.Signals): void {
	const snapshot = processSnapshot();
	const roots = [rec.runnerPid ?? rec.pid, rec.piPid ?? 0].filter((pid) => pid > 1);
	const pids = collectProcessTree(snapshot, roots);
	const rows = new Map(snapshot.map((row) => [row.pid, row]));
	const ownGroup = rows.get(process.pid)?.pgrp;
	const groups = [...new Set(pids.map((pid) => rows.get(pid)?.pgrp).filter((pgid): pgid is number => Boolean(pgid && pgid > 1 && pgid !== ownGroup)))];
	for (const pgid of groups.reverse()) {
		try { process.kill(-pgid, signal); } catch {}
	}
	for (const pid of pids) {
		try { process.kill(pid, signal); } catch {}
	}
}

function jobProcessesAlive(rec: JobRecord): boolean {
	return isAlive(rec.runnerPid ?? rec.pid) || Boolean(rec.piPid && isAlive(rec.piPid));
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Dispatch a new background pi session.
 *
 * Returns the newly-created job record. The runner is launched detached, so
 * this call returns as soon as the child has its own pid; it does NOT wait
 * for the pi RPC inside to be ready.
 */
export function dispatch(opts: DispatchOptions): JobRecord {
	ensureDirs();
	const id = newId();
	const jobDir = jobDirOf(id);
	mkdirSync(jobDir, { recursive: true });

	// Session file: live under pi's normal session tree so /resume picks it up
	// naturally if the user wants. We use the "agents" project tag.
	const sessionRoot =
		opts.sessionDir || join(homedir(), ".pi", "agent", "sessions", "--agents--");
	mkdirSync(sessionRoot, { recursive: true });
	const sessionFile = join(sessionRoot, `${id}.jsonl`);

	const name = opts.name?.trim() || derivedName(opts.prompt);
	const cwd = opts.cwd || process.cwd();
	const idleTimeoutMs = normalizeTimeoutMinutes(opts.idleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES);
	const hardTimeoutMs = normalizeTimeoutMinutes(opts.hardTimeoutMinutes, DEFAULT_HARD_TIMEOUT_MINUTES);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		AGENTS_JOB_DIR: jobDir,
		AGENTS_SESSION_FILE: sessionFile,
		AGENTS_CWD: cwd,
		AGENTS_PROMPT: opts.prompt,
		AGENTS_NAME: name,
		AGENTS_MODEL: opts.model || "",
		AGENTS_PI_BIN: opts.piBin || "pi",
		AGENTS_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
		AGENTS_HARD_TIMEOUT_MS: String(hardTimeoutMs),
		// Make sure the runner's stdio doesn't inherit pi's TUI state.
		FORCE_COLOR: "0",
	};

	// Logfile for the runner's own stdio (separate from runner.log written by
	// the runner itself — this catches early startup output before runner.log
	// is opened).
	const stdoutLog = join(jobDir, "runner.stdout.log");
	writeFileSync(stdoutLog, "");
	const outFd = openSync(stdoutLog, "a");

	const child = spawn(process.execPath, [RUNNER_PATH], {
		cwd,
		env,
		detached: true,
		stdio: ["ignore", outFd, outFd],
	});

	if (!child.pid) {
		throw new Error("supervisor: failed to spawn runner (no pid)");
	}

	// Detach so this pi exiting doesn't take the runner down.
	child.unref();

	// Seed an initial state.json so list() returns this job immediately —
	// before the runner has had a chance to do its own first persist().
	const initial: JobRecord = {
		id,
		name,
		state: "starting",
		summary: opts.prompt.slice(0, 160),
		prompt: opts.prompt,
		cwd,
		sessionFile,
		model: opts.model || "",
		pid: child.pid,
		runnerPid: child.pid,
		piPid: null,
		startedAt: new Date().toISOString(),
		lastUpdate: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
		settledAt: null,
		idleTimeoutMs,
		hardTimeoutMs,
		hardDeadlineAt: hardTimeoutMs > 0 ? new Date(Date.now() + hardTimeoutMs).toISOString() : null,
		stopReason: null,
		turns: 0,
		tools: 0,
		lastAssistantPreview: "",
		needsInput: null,
	};
	writeFileSync(statePathOf(id), JSON.stringify(initial, null, 2));

	return initial;
}

/**
 * Derive a sensible default name from the prompt — first few words, no punctuation.
 */
function derivedName(prompt: string): string {
	const cleaned = prompt
		.replace(/[`*_#>\n\r]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const words = cleaned.split(" ").slice(0, 5).join(" ");
	return words.slice(0, 48) || "agent";
}

/** List all known jobs (running + recently exited). Newest first. */
export function list(): JobRecord[] {
	ensureDirs();
	const rows: JobRecord[] = [];
	for (const name of readdirSync(JOBS_DIR)) {
		const rec = readState(name);
		if (rec) rows.push(rec);
	}
	rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return rows;
}

/** Get a single job record. Returns null if no such job. */
export function get(id: string): JobRecord | null {
	return readState(id);
}

/**
 * Read the last `bytes` of a job's transcript file (peek panel content).
 * Returns "" if not readable.
 */
export function peek(id: string, bytes = 8 * 1024): string {
	const p = join(jobDirOf(id), "transcript.txt");
	if (!existsSync(p)) return "";
	try {
		const size = statSync(p).size;
		const start = Math.max(0, size - bytes);
		const fd = openSync(p, "r");
		try {
			const buf = Buffer.alloc(Math.min(size, bytes));
			readSync(fd, buf, 0, buf.length, start);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * Send a control command over the per-job Unix socket.
 *
 * Returns the runner's JSON reply. Fails if the runner is dead — call
 * `respawnIfNeeded(id)` first (future) or just consider the job stopped.
 */
export function send(id: string, req: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
	const sock = sockPathOf(id);
	return new Promise((resolveReq, reject) => {
		if (!existsSync(sock)) {
			reject(new Error(`runner not reachable: ${sock} missing`));
			return;
		}
		const conn = createConnection(sock);
		let buf = "";
		const timer = setTimeout(() => {
			try {
				conn.destroy();
			} catch {}
			reject(new Error("runner timeout"));
		}, timeoutMs);
		conn.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			clearTimeout(timer);
			try {
				const parsed = JSON.parse(line);
				resolveReq(parsed);
			} catch (e) {
				reject(e);
			}
			conn.end();
		});
		conn.write(`${JSON.stringify(req)}\n`);
	});
}

/** Send a follow-up prompt / answer to a running job. */
export async function reply(id: string, message: string): Promise<any> {
	return send(id, { type: "prompt", message });
}

/**
 * Stop a job gracefully (releases the session file) and wait briefly for the
 * runner to actually exit. Returns true if the runner pid is gone.
 */
export async function stop(id: string, waitMs = 1500): Promise<boolean> {
	const rec = get(id);
	if (!rec) return true;
	if (existsSync(sockPathOf(id))) {
		try {
			await send(id, { type: "stop" });
		} catch {}
	}
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (!jobProcessesAlive(rec)) {
			persistStoppedState(id, "supervisor stop");
			return true;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	signalJobTree(rec, "SIGTERM");
	await new Promise((resolveWait) => setTimeout(resolveWait, 750));
	if (jobProcessesAlive(rec)) {
		signalJobTree(rec, "SIGKILL");
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	const stopped = !jobProcessesAlive(rec);
	if (stopped) persistStoppedState(id, "supervisor stop");
	return stopped;
}

function persistStoppedState(id: string, reason: string): void {
	const current = readState(id);
	if (!current) return;
	const updated = {
		...current,
		state: "stopped" as JobState,
		stopReason: current.stopReason || reason,
		summary: current.state === "stopped" ? current.summary : `stopped: ${reason}`,
		lastUpdate: new Date().toISOString(),
		piPid: null,
	};
	delete updated.alive;
	try { writeFileSync(statePathOf(id), JSON.stringify(updated, null, 2)); } catch {}
}

/** Permanently remove a job directory. Stops the job first if alive. */
export async function remove(id: string): Promise<void> {
	await stop(id);
	const dir = jobDirOf(id);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

/**
 * Reconcile state files at startup: detect runners that died without writing
 * a terminal state (e.g. machine sleep, kernel kill) and mark them failed.
 */
export async function reconcile(): Promise<{ rescued: number; reaped: number; total: number }> {
	const rows = list();
	let rescued = 0;
	let reaped = 0;
	for (const row of rows) {
		const terminal = row.state === "completed" || row.state === "failed" || row.state === "stopped";
		if (terminal && row.alive) {
			if (await stop(row.id, 0)) reaped++;
			continue;
		}
		if (row.alive || terminal) continue;
		const path = statePathOf(row.id);
		try {
			const updated = { ...row, state: "failed" as JobState, summary: `${row.summary} (runner exited unexpectedly)`, lastUpdate: new Date().toISOString() };
			delete (updated as any).alive;
			writeFileSync(path, JSON.stringify(updated, null, 2));
			rescued++;
		} catch {}
	}
	return { rescued, reaped, total: rows.length };
}

/** Convenience: classify a job state into the agent-view group. */
export function groupOf(j: JobRecord): "needs_input" | "working" | "idle" | "done" {
	if (j.state === "needs_input") return "needs_input";
	if (j.state === "working" || j.state === "starting") return "working";
	if (j.state === "idle" && j.alive) return "idle";
	return "done";
}
