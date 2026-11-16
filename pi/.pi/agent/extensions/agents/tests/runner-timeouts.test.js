"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const extensionDir = resolve(__dirname, "..");
const runnerPath = join(extensionDir, "runner.js");
const fakePiPath = join(__dirname, "fake-pi.js");

function runRunner(mode, idleTimeoutMs, hardTimeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-runner-test-"));
  const childPidFile = join(dir, "child.pid");
  const child = spawn(process.execPath, [runnerPath], {
    cwd: dir,
    env: {
      ...process.env,
      AGENTS_JOB_DIR: dir,
      AGENTS_SESSION_FILE: join(dir, "session.jsonl"),
      AGENTS_CWD: dir,
      AGENTS_PROMPT: "test prompt",
      AGENTS_NAME: "timeout-test",
      AGENTS_PI_BIN: fakePiPath,
      AGENTS_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      AGENTS_HARD_TIMEOUT_MS: String(hardTimeoutMs),
      FAKE_PI_MODE: mode,
      FAKE_PI_CHILD_PID_FILE: childPidFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("runner did not exit"));
    }, 5_000);
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        let childPid = null;
        try { childPid = Number(readFileSync(childPidFile, "utf8")); } catch {}
        resolveRun({ state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), childPid });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test("runner stops after the settled session stays idle", async () => {
  const { state } = await runRunner("settle", 100, 5_000);
  assert.equal(state.state, "stopped");
  assert.match(state.stopReason, /idle timeout/);
});

test("runner stops a still-working session at the hard deadline", async () => {
  const { state } = await runRunner("hang", 0, 150);
  assert.equal(state.state, "stopped");
  assert.match(state.stopReason, /hard runtime limit/);
});

test("hard deadline reaps a tool descendant in its own process group", async () => {
  const { state, childPid } = await runRunner("hang-child", 0, 250);
  assert.equal(state.state, "stopped");
  assert.ok(childPid);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.throws(() => process.kill(childPid, 0));
});
