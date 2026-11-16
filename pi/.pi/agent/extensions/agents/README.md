# agents — Claude-Code-style Agent View for pi

A pi extension that adds **background pi sessions** with a full-screen
manager UI. Inspired by Claude Code's `claude agents` command
([docs](https://code.claude.com/docs/en/agent-view)). Built entirely on
top of pi's existing primitives — `--mode rpc`, JSONL session files, and
`ctx.ui.custom()`.

```
Agent View                3 sessions · 1 needs input · 1 working · 1 done

  Needs input
   ❓ refactor auth module     waiting on your input              2m

  Working
▶ ⠼ flaky test fix             running pytest -k auth_token     12s

  Completed
   ✓ generate changelog        result: 3 sections drafted        1h

────────────────────────────────────────────────────────────────────────
flaky test fix   bg_a1f2  ~/code/myapp   · anthropic/claude-sonnet-4-5
│ pytest is hanging after the database fixture teardown. tracing…
│ found a missing await on the connection close — patching now.
────────────────────────────────────────────────────────────────────────
Dispatch > write release notes for v3.2▎
↑↓ select · enter attach/send · tab dispatch/reply ·
ctrl+x stop/remove · esc exit
```

## Usage

```
/agents                                      # open the view
/dispatch <prompt>                           # dispatch with default limits
/dispatch --idle=30 --hard=180 <prompt>     # override limits in minutes; 0 disables
Alt+A                                        # shortcut for /agents
```

The footer always shows live sessions, for example
`Agents: 1 working · 1 idle — Alt+A`. Idle sessions auto-stop after 10 minutes;
every session has a 2-hour hard limit unless overridden at dispatch.

AI-callable tools (the LLM can delegate work):
- `agent_dispatch(prompt, name?, cwd?, model?, idleTimeoutMinutes?, hardTimeoutMinutes?)`
- `agent_list()`
- `agent_peek(id, bytes?)`
- `agent_reply(id, message)`
- `agent_stop(id)`

## How it works

Each background session is a detached `node runner.js` child that owns one
`pi --mode rpc --session <file>` subprocess. The runner translates pi's
RPC event stream into a `state.json` + `transcript.txt` on disk, and
exposes a Unix socket for control commands.

```
~/.cache/pi-agents/jobs/<id>/
  state.json         atomic JSON status (working/needs_input/idle/...)
  transcript.txt     trailing human-readable assistant output (peek panel)
  events.jsonl       raw RPC event log (debug)
  runner.log         runner's own trace log
  control.sock       Unix socket for prompt/stop/status commands
```

Session JSONL files live in pi's normal session tree at
`~/.pi/agent/sessions/--agents--/<id>.jsonl`, so `pi -r` (resume) surfaces
them alongside your other sessions.

### Why no central daemon?

Claude Code uses a single per-user supervisor process. We deliberately
chose **detached children with per-job sockets** instead because:

- **Simpler.** No daemon-restart, no version-pin tracking, no main socket.
- **Crash-isolated.** A bug in one runner can't take out others.
- **Process tree is the source of truth.** `ps faux | grep agents/runner`
  shows you exactly what's alive.

The tradeoff: no auto-respawn after system sleep (pi's `respawn --all`
equivalent would need to walk `state.json` files and re-launch dead
runners — easy to add but not in v1).

### Attach lifecycle

Pi session files are **single-owner** — exactly one process appends to the
JSONL at a time. So attaching can't be live-multiplexed; it's a handoff:

1. User selects "attach" in the view.
2. Foreground pi sends `stop` to the runner's control socket.
3. Runner closes pi RPC stdin → pi exits → session file released.
4. Foreground pi calls `ctx.switchSession(sessionFile)` and takes over.

The background session is fully gone after attach. To "re-background"
later, dispatch a new session with `--resume <file>` semantics (TODO —
v1 just shows you the path in a notification).

### Runtime lifecycle

The runner owns idle and hard-runtime timers because it survives foreground Pi
exits. The supervisor owns final cleanup: stop snapshots the complete descendant
tree, signals every distinct process group, and verifies both runner and child Pi
PIDs are gone. This prevents detached shell children from surviving a stop.

A stuck notification from a background agent writes a targeted open request for
the foreground Pi that dispatched it. After focus returns and the foreground is
idle, `/agents` opens with that agent selected.

## Files

- `index.ts` — extension entry: slash commands, shortcut, AI tools, attach.
- `supervisor.ts` — pure filesystem/socket helper: dispatch, list, peek,
  send, stop, remove, reconcile.
- `runner.js` — standalone Node script spawned per background session.
  Owns one pi RPC child, translates events to state + transcript files,
  serves a control socket.
- `view.ts` — `ctx.ui.custom()` component: grouped list, peek panel,
  dispatch input, keyboard handling.

## Limitations / future work

- **Linux process inspection.** Guaranteed descendant cleanup and targeted
  notification handoff currently use `/proc`/POSIX process groups.
- **No system-sleep recovery.** Runners die on suspend. Add `pi agents
  respawn-all` that walks state.json + re-launches dead runners with
  `--resume`.
- **No git worktree isolation.** Claude Code runs each background
  session in its own worktree under `.claude/worktrees/`. We just run
  in cwd, so two parallel sessions editing the same file can stomp on
  each other.
- **No Haiku-class summary refresh.** The "summary" line is whatever
  first line the agent emitted last turn, not a Haiku-distilled status.
- **No PR status badges.** Claude Code shows a colored dot for PR
  checks/review status next to each row.
- **`AGENTS_RUNNER=1` env disables recursion** but doesn't fully
  sandbox — a runner could still spawn child pis in other ways.

## Recursion safety

When the runner launches its pi child, it sets `AGENTS_RUNNER=1`. The
extension checks this env var at load time and refuses to spawn new
background sessions from inside an existing background session. This
prevents accidental exponential trees of detached pi processes.
