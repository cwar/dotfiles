# 002. Cross-manager system-update indicator for Waybar

Date: 2026-06-18

## Status

Accepted

## Context

ADR-001 left "Ubuntu update indicator" as an explicit follow-up: the Arch +
Omarchy bar had an `updates-available` / `update-all` pair (the `\uf021`
"cycle" glyph) that showed pending updates and ran a one-click updater. That
implementation was Arch-specific (`pacman`, `yay`, `omarchy-update`).

The new workstation is Ubuntu 26.04 LTS and carries a heterogeneous fleet of
package managers: **apt, flatpak, snap, Homebrew, npm (global), mise**. We want
to port the *behaviour* (an at-a-glance indicator + one-click update) without
copying the Arch commands, and have it work on **both** Waybar environments
(KDE/KWin now, Hyprland later).

Constraints and forces:

- The Waybar `exec` runs unattended (hourly + on `SIGRTMIN+8`). It must never
  call `sudo`, never run `apt update` (root + network), and never block the bar
  for long.
- Detection cost is dominated by network-touching managers (`npm outdated -g`,
  `flatpak`/`snap`/`mise`), so checks run in **parallel** with per-manager
  `timeout`s. Local/cheap checks (`apt list --upgradable`, `brew outdated`) read
  already-fetched data.
- The on-click updater *does* need root for apt/snap. Two prompts is annoying,
  so sudo is primed once with a keep-alive loop.
- Per ADR-001, shared modules live once in `common.jsonc`; only layout differs
  per environment.

## Decision

Two stow-tracked scripts in the `scripts` package
(`~/dotfiles/scripts/.local/bin`, symlinked into `~/.local/bin`):

- **`sysupdate-check`** — Waybar `exec`. Counts updates per manager in parallel,
  emits one JSON object `{text, tooltip, class}`. The module is **hidden when
  there is nothing actionable** (emits `{"text":""}`); when updates exist it
  shows the yellow `\uf021` cycle glyph + a count, with a per-manager tooltip.
  Has a `--summary` mode (used by the launcher) and a `--self-test` mode.
  - **apt is counted by the real plan, not the candidates.** We simulate
    `apt-get -s full-upgrade` and count `Inst` lines rather than parsing
    `apt list --upgradable`. Ubuntu's **phased-update rollout** deliberately
    holds some upgradable packages back; counting candidates kept the indicator
    permanently lit even after a successful update. Counting the plan excludes
    phased packages automatically. Phased updates are deliberately **not
    reported anywhere** — they aren't actionable and roll out on their own, so
    surfacing them is just noise.
- **`sysupdate-launch`** — Waybar `on-click`. Re-execs itself inside Ghostty
  (guarded by `SYSUPDATE_IN_TERM`), shows the pending summary, `gum confirm`s,
  primes sudo once, then upgrades each present manager in isolation (one failure
  does not abort the rest), and finally signals Waybar (`pkill -RTMIN+8`) so the
  indicator re-checks immediately.

Waybar wiring follows ADR-001: the `custom/sysupdate` module is defined **once
in `common.jsonc`** (with its CSS in `common.css`) and referenced from each
environment's `modules-center` (`config-kde.jsonc` and `config-hypr.jsonc`).

## Consequences

Positive:

- Single source of truth: one module def + CSS, inherited by both bars.
- The indicator and updater are environment-agnostic — Hyprland gets the same
  bar entry for free when that session is used.
- `--self-test` keeps the counting/JSON logic verifiable without a framework;
  scripts are shellcheck- and shfmt-clean.

Negative / risks:

- First paint can lag up to ~20s when the network managers are slow
  (`npm outdated -g` is the usual cost). Acceptable for an hourly module; a
  stale-while-revalidate cache could be added later if it annoys.
- The apt count reflects what `apt-get -s full-upgrade` would do against the
  currently-fetched lists (refreshed unattended by the `apt-daily` timer, or by
  the launcher's own `apt update`). It is sudo-free and network-free. Phased
  packages are excluded from the count and not reported; the trade-off is there
  is no in-tool way to force a phased update (acceptable — they self-resolve).
- `npm update -g` honors semver and will not cross a major version, while
  `npm outdated -g` flags any newer version — so an npm global with a pending
  major bump keeps the indicator lit until a manual `npm i -g <pkg>@latest`.
  This is correct (a newer version genuinely exists), just not auto-clearable.
- Detection commands assume these specific managers; adding/removing a manager
  means editing the `ORDER`/`count_*` set in `sysupdate-check`.

## Follow-up

- Optional: cache the last JSON and refresh in the background to remove first-
  paint latency.
- Optional: a `healthcheck` group asserting both scripts exist, are on `PATH`,
  and that `sysupdate-check` emits valid JSON.
