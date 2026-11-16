import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectProcessTree, dispatch, get, normalizeTimeoutMinutes, remove, ROOT, stop } from "../supervisor.ts";
import { formatActivity, formatFooterStatus, parseDispatchInput } from "../presentation.ts";

test("collectProcessTree includes descendants in separate process groups", () => {
  const snapshot = [
    { pid: 100, ppid: 1, pgrp: 100 },
    { pid: 101, ppid: 100, pgrp: 100 },
    { pid: 102, ppid: 101, pgrp: 102 },
    { pid: 200, ppid: 1, pgrp: 200 },
  ];

  assert.deepEqual(collectProcessTree(snapshot, [100]), [102, 101, 100]);
});

test("timeout overrides convert minutes and allow zero to disable", () => {
  assert.equal(normalizeTimeoutMinutes(undefined, 10), 10 * 60_000);
  assert.equal(normalizeTimeoutMinutes(2.5, 10), 150_000);
  assert.equal(normalizeTimeoutMinutes(0, 10), 0);
  assert.throws(() => normalizeTimeoutMinutes(-1, 10), /non-negative/);
});

test("stop reaps a runner descendant that created its own process group", async () => {
  const id = `test-${process.pid}-${Date.now()}`;
  const jobDir = join(ROOT, "jobs", id);
  const childPidPath = join(jobDir, "child.pid");
  mkdirSync(jobDir, { recursive: true });
  const runner = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); writeFileSync(${JSON.stringify(childPidPath)},String(child.pid)); setInterval(()=>{},1000);`,
    ],
    { detached: true, stdio: "ignore" },
  );
  runner.unref();

  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(childPidPath, "utf8").trim()) break;
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    const now = new Date().toISOString();
    writeFileSync(
      join(jobDir, "state.json"),
      JSON.stringify({
        id,
        name: "process-tree-test",
        state: "working",
        summary: "test",
        prompt: "test",
        cwd: jobDir,
        sessionFile: join(jobDir, "session.jsonl"),
        model: "",
        pid: runner.pid,
        runnerPid: runner.pid,
        piPid: null,
        startedAt: now,
        lastUpdate: now,
        turns: 0,
        tools: 0,
        lastAssistantPreview: "",
        needsInput: null,
      }),
    );

    assert.equal(await stop(id, 0), true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    try { process.kill(-(runner.pid ?? 0), "SIGKILL"); } catch {}
    rmSync(jobDir, { recursive: true, force: true });
  }
});

test("dispatch command accepts leading timeout overrides without rewriting the prompt", () => {
  assert.deepEqual(parseDispatchInput("--idle=30 --hard=180 investigate flaky tests"), {
    prompt: "investigate flaky tests",
    idleTimeoutMinutes: 30,
    hardTimeoutMinutes: 180,
  });
  assert.deepEqual(parseDispatchInput("plain prompt"), { prompt: "plain prompt" });
});

test("dispatch passes timeout overrides to the detached runner", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-dispatch-test-"));
  const here = dirname(fileURLToPath(import.meta.url));
  const record = dispatch({
    prompt: "settle immediately",
    name: "dispatch-timeout-test",
    cwd: sessionDir,
    sessionDir,
    piBin: join(here, "fake-pi.js"),
    idleTimeoutMinutes: 0.002,
    hardTimeoutMinutes: 1,
  });

  try {
    const deadline = Date.now() + 5_000;
    let current = get(record.id);
    while (Date.now() < deadline && (current?.alive || current?.state !== "stopped")) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      current = get(record.id);
    }
    assert.equal(current?.state, "stopped");
    assert.equal(current?.alive, false);
    assert.equal(current?.idleTimeoutMs, 120);
    assert.match(current?.stopReason || "", /idle timeout/);
  } finally {
    await remove(record.id);
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("footer keeps live and idle agents visible", () => {
  const jobs = [
    { state: "working" },
    { state: "starting" },
    { state: "needs_input" },
    { state: "idle" },
    { state: "completed" },
    { state: "stopped" },
  ] as any[];

  assert.equal(formatFooterStatus(jobs), "Agents: 2 working · 1 needs input · 1 idle — Alt+A");
});

test("activity text shows both total runtime and inactivity", () => {
  const now = Date.parse("2026-08-11T14:00:00.000Z");
  assert.equal(
    formatActivity(
      {
        startedAt: "2026-08-11T12:00:00.000Z",
        lastActivityAt: "2026-08-11T13:54:30.000Z",
        lastUpdate: "2026-08-11T13:59:00.000Z",
      } as any,
      now,
    ),
    "run 2h · idle 5m30s",
  );
});
