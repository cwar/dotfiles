#!/usr/bin/env node
/**
 * Background Agent Runner
 *
 * Spawned (detached) per background pi session. Owns one `pi --mode rpc`
 * child process and translates its event stream into:
 *   - state.json    : machine-readable status (working/needs-input/idle/...).
 *   - transcript.txt: human-readable trailing transcript for the peek panel.
 *   - events.jsonl  : raw RPC event log (append-only, mostly for debugging).
 *
 * Exposes a per-job Unix socket at <jobDir>/control.sock so the foreground
 * pi (or any `pi-agents` CLI shim) can:
 *   - `prompt <text>`  send a follow-up / answer a needs-input prompt
 *   - `stop`           gracefully shut down (releases the session file)
 *   - `status`         get the current state.json contents
 *
 * Inputs (env vars):
 *   AGENTS_JOB_DIR      directory containing state.json + sockets + logs
 *   AGENTS_SESSION_FILE pi session JSONL file (single owner)
 *   AGENTS_CWD          working dir for the pi child
 *   AGENTS_PROMPT       initial prompt to send once pi is ready
 *   AGENTS_NAME         human-readable session name
 *   AGENTS_MODEL        optional model pattern
 *
 * Design notes:
 *   - We do NOT depend on any npm packages. Plain Node builtins only so the
 *     script is portable and spawn-time has no TS / jiti / npm install cost.
 *   - Pi RPC speaks strict JSONL (LF only). We do our own framing rather than
 *     using `readline`, which would (incorrectly) split on U+2028/U+2029.
 *   - The runner survives the parent pi exiting. It only exits when the pi
 *     RPC child exits or a `stop` control message arrives.
 */

"use strict";

const { execFileSync, spawn } = require("node:child_process");
const { createServer } = require("node:net");
const {
	mkdirSync,
	createWriteStream,
	existsSync,
	writeFileSync,
	readFileSync,
	statSync,
	openSync,
	writeSync,
	closeSync,
	appendFileSync,
	unlinkSync,
} = require("node:fs");
const { join } = require("node:path");

// ── Config from environment ────────────────────────────────────────

const JOB_DIR = process.env.AGENTS_JOB_DIR;
const SESSION_FILE = process.env.AGENTS_SESSION_FILE;
const CWD = process.env.AGENTS_CWD || process.cwd();
const INITIAL_PROMPT = process.env.AGENTS_PROMPT || "";
const NAME = process.env.AGENTS_NAME || "untitled";
const MODEL = process.env.AGENTS_MODEL || "";
const PI_BIN = process.env.AGENTS_PI_BIN || "pi";
const IDLE_TIMEOUT_MS = parseTimeout(process.env.AGENTS_IDLE_TIMEOUT_MS, 10 * 60_000);
const HARD_TIMEOUT_MS = parseTimeout(process.env.AGENTS_HARD_TIMEOUT_MS, 2 * 60 * 60_000);

function parseTimeout(raw, fallback) {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

if (!JOB_DIR || !SESSION_FILE) {
	console.error("runner: AGENTS_JOB_DIR and AGENTS_SESSION_FILE are required");
	process.exit(2);
}

mkdirSync(JOB_DIR, { recursive: true });

const STATE_PATH = join(JOB_DIR, "state.json");
const TRANSCRIPT_PATH = join(JOB_DIR, "transcript.txt");
const EVENTS_PATH = join(JOB_DIR, "events.jsonl");
const SOCK_PATH = join(JOB_DIR, "control.sock");
const RUNNER_LOG = join(JOB_DIR, "runner.log");

// ── Trace logging ───────────────────────────────────────────────────

// Plain text log mainly to debug runner crashes. Bounded by truncation at
// startup so it doesn't grow unbounded across runner respawns.
try {
	writeFileSync(RUNNER_LOG, "");
} catch {}

function log(...args) {
	try {
		const line = `[${new Date().toISOString()}] ${args.map(stringifyArg).join(" ")}\n`;
		appendFileSync(RUNNER_LOG, line);
	} catch {}
}

function stringifyArg(a) {
	if (typeof a === "string") return a;
	try {
		return JSON.stringify(a);
	} catch {
		return String(a);
	}
}

// ── State management ────────────────────────────────────────────────

/**
 * State machine:
 *   working       agent is actively running tools / generating
 *   needs_input   agent emitted an extension_ui_request (select/confirm/input)
 *   idle          agent finished its turn, awaiting next user message
 *   completed     agent ended and runner has decided no further work needed
 *   failed        unrecoverable error or non-zero exit from pi
 *   stopped       received `stop` over control socket; pi was killed
 *
 * `completed` and `failed` and `stopped` are terminal. The runner exits.
 */
const startedAt = new Date();
const state = {
	id: JOB_DIR.split("/").pop(),
	name: NAME,
	state: "starting",
	summary: INITIAL_PROMPT.slice(0, 160),
	prompt: INITIAL_PROMPT,
	cwd: CWD,
	sessionFile: SESSION_FILE,
	model: MODEL,
	pid: process.pid,
	runnerPid: process.pid,
	piPid: null,
	startedAt: startedAt.toISOString(),
	lastUpdate: startedAt.toISOString(),
	lastActivityAt: startedAt.toISOString(),
	settledAt: null,
	idleTimeoutMs: IDLE_TIMEOUT_MS,
	hardTimeoutMs: HARD_TIMEOUT_MS,
	hardDeadlineAt: HARD_TIMEOUT_MS > 0 ? new Date(startedAt.getTime() + HARD_TIMEOUT_MS).toISOString() : null,
	stopReason: null,
	turns: 0,
	tools: 0,
	lastAssistantPreview: "",
	// Pending extension UI request (select/confirm/input). The foreground
	// uses this to know what to ask the user.
	needsInput: null,
};

function persist() {
	state.lastUpdate = new Date().toISOString();
	// Atomic write: write to a tmp file then rename. Avoids torn reads when
	// the agent view reads state.json mid-write.
	const tmp = `${STATE_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	require("node:fs").renameSync(tmp, STATE_PATH);
}

function setState(next, reason) {
	if (state.state === next) return;
	log("state", state.state, "->", next, reason || "");
	state.state = next;
	persist();
}

function markActivity() {
	state.lastActivityAt = new Date().toISOString();
	state.settledAt = null;
}

let idleTimer = null;
let hardTimer = null;

function clearIdleTimer() {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = null;
}

function scheduleIdleStop() {
	clearIdleTimer();
	state.settledAt = new Date().toISOString();
	state.lastActivityAt = state.settledAt;
	persist();
	if (IDLE_TIMEOUT_MS === 0) return;
	idleTimer = setTimeout(() => gracefulStop(`idle timeout after ${IDLE_TIMEOUT_MS}ms`), IDLE_TIMEOUT_MS);
}

if (HARD_TIMEOUT_MS > 0) {
	hardTimer = setTimeout(() => gracefulStop(`hard runtime limit after ${HARD_TIMEOUT_MS}ms`), HARD_TIMEOUT_MS);
}

// ── Transcript ──────────────────────────────────────────────────────

// Bounded transcript: keep ~64KB tail by truncating on overflow. The peek
// panel only needs to show a tail anyway.
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
try {
	writeFileSync(TRANSCRIPT_PATH, "");
} catch {}

function appendTranscript(text) {
	if (!text) return;
	try {
		appendFileSync(TRANSCRIPT_PATH, text);
		// Truncate from the head if we've grown past the cap.
		const size = statSync(TRANSCRIPT_PATH).size;
		if (size > MAX_TRANSCRIPT_BYTES * 2) {
			// Read tail and rewrite. Cheap because we cap at 128KB.
			const buf = readFileSync(TRANSCRIPT_PATH);
			const tail = buf.slice(buf.length - MAX_TRANSCRIPT_BYTES);
			writeFileSync(TRANSCRIPT_PATH, `...[truncated]...\n${tail.toString("utf8")}`);
		}
	} catch (e) {
		log("transcript write failed", e.message);
	}
}

// ── Event log ───────────────────────────────────────────────────────

let eventsStream = null;
try {
	eventsStream = createWriteStream(EVENTS_PATH, { flags: "a" });
} catch (e) {
	log("events log open failed", e.message);
}

function logEvent(obj) {
	if (eventsStream) {
		try {
			eventsStream.write(`${JSON.stringify(obj)}\n`);
		} catch {}
	}
}

// ── Pi RPC child ────────────────────────────────────────────────────

persist();

const piArgs = ["--mode", "rpc", "--session", SESSION_FILE];
if (MODEL) piArgs.push("--model", MODEL);

log("spawning pi", PI_BIN, piArgs.join(" "), "cwd=", CWD);

const pi = spawn(PI_BIN, piArgs, {
	cwd: CWD,
	detached: true,
	env: {
		...process.env,
		// Mark this pi process so the agents extension running INSIDE it
		// can self-disable and not recursively offer agent view / dispatch.
		AGENTS_RUNNER: "1",
		AGENTS_JOB_ID: state.id,
	},
	stdio: ["pipe", "pipe", "pipe"],
});

state.piPid = pi.pid;
persist();

pi.on("error", (err) => {
	log("pi spawn error", err.message);
	state.summary = `failed to spawn pi: ${err.message}`;
	setState("failed", "spawn error");
	cleanup(1);
});

pi.stderr.on("data", (chunk) => {
	const s = chunk.toString("utf8");
	log("pi stderr", s.trim());
	appendTranscript(`[stderr] ${s}`);
});

// ── RPC framing: line-delimited JSON over stdout ──────────────────

let buf = "";
pi.stdout.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	// Strictly split on \n only (RPC spec).
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			log("bad json from pi", line.slice(0, 200));
			continue;
		}
		handleEvent(event);
	}
});

function sendRpc(obj) {
	try {
		pi.stdin.write(`${JSON.stringify(obj)}\n`);
	} catch (e) {
		log("rpc send failed", e.message);
	}
}

// ── Event handling: pi RPC → state machine ────────────────────────

let nextReqId = 1;
function newReqId() {
	return `runner-${nextReqId++}`;
}

let initialPromptSent = false;
let isStreaming = false;

function handleEvent(ev) {
	logEvent(ev);
	if (shuttingDown && ev.type !== "response") return;

	// Responses to our commands.
	if (ev.type === "response") {
		// Most responses we don't care about. Just log.
		if (!ev.success) log("rpc command failed", ev.command, ev.error || "");
		return;
	}

	// Extension UI requests (select/confirm/input) — these are the
	// "needs_input" signal.
	if (ev.type === "extension_ui_request") {
		// Auto-handle fire-and-forget kinds so pi doesn't get stuck.
		const kind = ev.method || ev.kind;
		if (kind === "notify" || kind === "setStatus" || kind === "setWidget" || kind === "setTitle" || kind === "setEditorText") {
			return;
		}
		// Dialog kinds: forward to state as a pending need.
		state.needsInput = {
			id: ev.id,
			method: kind || "input",
			title: ev.title || "",
			message: ev.message || "",
			options: ev.options || ev.items || null,
			defaultValue: ev.defaultValue || ev.placeholder || "",
		};
		setState("needs_input", `extension_ui_request ${kind}`);
		appendTranscript(`\n[needs input · ${kind}] ${ev.title || ""}: ${ev.message || ""}\n`);
		return;
	}

	switch (ev.type) {
		case "agent_start":
			isStreaming = true;
			clearIdleTimer();
			markActivity();
			state.needsInput = null;
			setState("working", "agent_start");
			break;
		case "agent_end":
			isStreaming = false;
			if (state.needsInput) {
				setState("needs_input", "agent_end with pending input");
			} else {
				setState("idle", "agent_end");
			}
			break;
		case "agent_settled":
			if (!state.needsInput) {
				setState("idle", "agent_settled");
				scheduleIdleStop();
			}
			break;
		case "turn_start":
			markActivity();
			state.turns += 1;
			persist();
			break;
		case "turn_end":
			// Capture the assistant's text into the transcript for peeking.
			try {
				const msg = ev.message;
				if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
					const texts = msg.content.filter((c) => c && c.type === "text").map((c) => c.text || "");
					const text = texts.join("");
					if (text) {
						state.lastAssistantPreview = text.slice(0, 280);
						appendTranscript(`\n--- turn ${state.turns} ---\n${text}\n`);
						// First non-empty line becomes the summary.
						const firstLine = text.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
						if (firstLine) state.summary = firstLine.slice(0, 160);
					}
				}
			} catch (e) {
				log("turn_end parse failed", e.message);
			}
			persist();
			break;
		case "tool_execution_start":
			markActivity();
			state.tools += 1;
			state.summary = `${ev.toolName || "tool"}…`;
			persist();
			break;
		case "tool_execution_update":
			markActivity();
			persist();
			break;
		case "tool_execution_end":
			markActivity();
			persist();
			break;
		case "compaction_start":
			state.summary = "compacting context…";
			persist();
			break;
		case "compaction_end":
			break;
		case "auto_retry_start":
			state.summary = `retrying (attempt ${ev.attempt}/${ev.maxAttempts})…`;
			persist();
			break;
		default:
			// ignore others (message_update is too chatty; we use turn_end)
			break;
	}
}

// ── Initial prompt: send once we believe pi is ready ──────────────

// Pi may emit a session_start event or just be silent until we send. We
// don't have an explicit "ready" event in the RPC protocol, but the first
// thing pi does after argv parsing is wait for stdin. So we can send
// immediately. The `prompt` command response will tell us if anything is
// wrong (e.g., model auth).
setTimeout(() => {
	if (shuttingDown || initialPromptSent || !INITIAL_PROMPT) return;
	initialPromptSent = true;
	sendRpc({ id: newReqId(), type: "prompt", message: INITIAL_PROMPT });
	log("sent initial prompt");
}, 250);

// ── Control socket ──────────────────────────────────────────────────

// Clean up a stale socket from a previous crashed runner so listen() works.
try {
	if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
} catch {}

const server = createServer((conn) => {
	let cbuf = "";
	conn.on("data", (chunk) => {
		cbuf += chunk.toString("utf8");
		let nl;
		while ((nl = cbuf.indexOf("\n")) >= 0) {
			const line = cbuf.slice(0, nl);
			cbuf = cbuf.slice(nl + 1);
			handleControl(line, conn);
		}
	});
	conn.on("error", () => {});
});

server.on("error", (err) => log("socket server error", err.message));

server.listen(SOCK_PATH, () => {
	log("control socket listening at", SOCK_PATH);
});

function handleControl(line, conn) {
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		conn.write(`${JSON.stringify({ ok: false, error: "bad json" })}\n`);
		return;
	}
	log("control", req.type || req.cmd);

	switch (req.type || req.cmd) {
		case "status": {
			conn.write(`${JSON.stringify({ ok: true, state })}\n`);
			break;
		}
		case "prompt": {
			const opts = { id: newReqId(), type: "prompt", message: req.message };
			if (isStreaming) opts.streamingBehavior = req.streamingBehavior || "steer";
			sendRpc(opts);
			clearIdleTimer();
			markActivity();
			state.needsInput = null;
			setState("working", "user prompt");
			conn.write(`${JSON.stringify({ ok: true })}\n`);
			break;
		}
		case "ui_response": {
			// Respond to an in-flight extension_ui_request.
			if (!state.needsInput) {
				conn.write(`${JSON.stringify({ ok: false, error: "no pending ui request" })}\n`);
				break;
			}
			pi.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: state.needsInput.id, value: req.value })}\n`);
			clearIdleTimer();
			markActivity();
			state.needsInput = null;
			setState("working", "ui_response");
			conn.write(`${JSON.stringify({ ok: true })}\n`);
			break;
		}
		case "stop": {
			conn.write(`${JSON.stringify({ ok: true })}\n`);
			gracefulStop("control stop");
			break;
		}
		case "rename": {
			state.name = String(req.name || state.name).slice(0, 100);
			persist();
			conn.write(`${JSON.stringify({ ok: true })}\n`);
			break;
		}
		default:
			conn.write(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
	}
}

// ── Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;
let shutdownRows = [];
let shutdownPids = [];

function capturePiTree() {
	if (!pi.pid) return { rows: [], pids: [] };
	let rows = [];
	try {
		rows = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter((parts) => parts.length === 3 && parts.every(Number.isFinite))
			.map(([pid, ppid, pgrp]) => ({ pid, ppid, pgrp }));
	} catch {}
	const children = new Map();
	for (const row of rows) {
		const list = children.get(row.ppid) || [];
		list.push(row.pid);
		children.set(row.ppid, list);
	}
	const pids = [];
	const visit = (pid) => {
		for (const child of children.get(pid) || []) visit(child);
		pids.push(pid);
	};
	visit(pi.pid);
	return { rows, pids };
}

function signalPiTree(signal) {
	const current = capturePiTree();
	const rows = [...shutdownRows, ...current.rows];
	const pids = [...new Set([...shutdownPids, ...current.pids])];
	const byPid = new Map(rows.map((row) => [row.pid, row]));
	const groups = [...new Set(pids.map((pid) => byPid.get(pid)?.pgrp).filter((pgid) => pgid && pgid > 1))];
	for (const pgid of groups.reverse()) {
		try { process.kill(-pgid, signal); } catch {}
	}
	for (const pid of pids) {
		try { process.kill(pid, signal); } catch {}
	}
}

function gracefulStop(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	const captured = capturePiTree();
	shutdownRows = captured.rows;
	shutdownPids = captured.pids;
	clearIdleTimer();
	if (hardTimer) clearTimeout(hardTimer);
	state.stopReason = reason;
	state.summary = `stopped: ${reason}`;
	log("graceful stop:", reason);
	setState("stopped", reason);
	if (isStreaming) sendRpc({ id: newReqId(), type: "abort" });
	setTimeout(() => {
		try { pi.stdin.end(); } catch {}
	}, 50);
	setTimeout(() => {
		if (pi.exitCode === null) {
			log("pi did not exit, SIGTERM process tree");
			signalPiTree("SIGTERM");
		}
	}, 1000);
	setTimeout(() => {
		if (pi.exitCode === null) {
			log("pi still alive, SIGKILL process tree");
			signalPiTree("SIGKILL");
		}
	}, 2000);
}

pi.on("exit", (code, signal) => {
	log("pi exited", code, signal);
	state.piPid = null;
	if (state.state !== "stopped" && state.state !== "failed") {
		if (state.state === "working" || state.state === "starting") {
			setState("failed", `pi exited with code=${code} signal=${signal}`);
		} else {
			setState("completed", `pi exited code=${code}`);
		}
	}
	persist();
	cleanup(0);
});

function cleanup(exitCode) {
	clearIdleTimer();
	if (hardTimer) clearTimeout(hardTimer);
	try { server.close(); } catch {}
	try { if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH); } catch {}
	try { eventsStream && eventsStream.end(); } catch {}
	if (shuttingDown) {
		signalPiTree("SIGTERM");
		setTimeout(() => {
			signalPiTree("SIGKILL");
			process.exit(exitCode);
		}, 500);
		return;
	}
	setTimeout(() => process.exit(exitCode), 50);
}

process.on("SIGTERM", () => gracefulStop("SIGTERM"));
process.on("SIGINT", () => gracefulStop("SIGINT"));
process.on("SIGHUP", () => {
	// Detached process — should not be SIGHUP'd. Just log.
	log("received SIGHUP, ignoring");
});
process.on("uncaughtException", (err) => {
	log("uncaughtException", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
	log("unhandledRejection", reason && reason.stack ? reason.stack : reason);
});
