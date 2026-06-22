# 003. Resolve mise-managed tools in non-interactive sysupdate scripts

Date: 2026-06-22

## Status

Accepted

## Context

The `custom/sysupdate` Waybar indicator (ADR-002) counts available updates per
package manager and offers a one-click "update all". It was silently never
reporting or updating **npm globals** — most visibly `pi` (the coding agent),
installed as a global under a mise-managed Node.

Root cause is the environment, not the update logic:

- `node`/`npm` exist on this box **only** via mise
  (`~/.local/share/mise/installs/node/<v>/bin`).
- mise is activated in **`~/.bashrc` only** (`eval "$(mise activate bash)"`),
  i.e. for *interactive* shells.
- Waybar runs as a **systemd user service** (`waybar.service`), which never
  sources `~/.bashrc`. Its inherited `PATH` contains `~/.local/bin` (so `mise`
  itself resolves) but **not** Node's bin dir — so `npm`/`node` are absent.
- `sysupdate-check`'s `count_npm()` guards with `command -v npm || return 0`, so
  with no `npm` on `PATH` the **entire npm manager is skipped** and never
  counted. `sysupdate-launch` re-execs via `ghostty -e …` (also not an
  interactive shell), so its `have npm` check fails too and `npm update -g` is
  skipped. Net effect: npm globals are invisible to both detect and update.

Empirically confirmed: in a Waybar-like bare environment `command -v npm` →
nothing; after the fix it resolves to `~/.local/share/mise/shims/npm` and the
summary reports `npm -g`.

Considered alternatives:

1. **Fix the systemd user environment** (e.g. `~/.config/environment.d/*.conf`
   or `systemctl --user import-environment PATH`). Fixes *all* user services but
   is a broad, global side effect that couples the bar to login-shell ordering
   and is easy to forget when the repo is re-stowed on a new machine.
2. **Hard-code the Node bin path** in the scripts. Brittle: breaks on every Node
   version bump managed by mise.
3. **Prepend mise's shims dir inside the scripts** (chosen). mise shims
   self-resolve the *currently active* tool version, so they survive version
   bumps, and the change is local to the two scripts that need it.

## Decision

Add an idempotent `prepend_mise_shims` helper to both `sysupdate-check` and
`sysupdate-launch` that prepends `~/.local/share/mise/shims` (overridable via
`$MISE_SHIMS` for testing) to `PATH` when present, then exports it. It runs in
`detect()` (check) and before the terminal re-exec (launch, so the child
inherits it). The helper is covered by two cases in `sysupdate-check
--self-test` (prepends when present; idempotent on a second call).

## Consequences

- **Positive:** npm globals (incl. `pi`) are now detected and updated by the
  indicator; the fix tracks mise's active Node version automatically; it is
  self-contained, tested, and shellcheck/shfmt clean.
- **Neutral:** the shims pick the *globally* active mise Node version — correct
  for a system-wide indicator, but it would not see globals under a
  directory-pinned Node version (not a concern for this use case).
- **Negative / follow-up:** other non-interactive contexts on this machine
  (future systemd user services needing Node) will hit the same missing-PATH
  issue; if that recurs, revisit alternative 1 (a single `environment.d` entry)
  as the broader fix.
