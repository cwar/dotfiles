#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");

const mode = process.env.FAKE_PI_MODE || "settle";
if (mode === "hang-child") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(process.env.FAKE_PI_CHILD_PID_FILE, String(child.pid));
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "prompt") {
    emit({ type: "response", command: "prompt", success: true });
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    if (mode === "hang" || mode === "hang-child") return;
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    });
    emit({ type: "agent_end" });
    emit({ type: "agent_settled" });
  } else if (request.type === "abort") {
    emit({ type: "response", command: "abort", success: true });
  }
});
