# 006. Niri as primary session; desktop helpers scoped per session

Date: 2026-11-16

## Status

Accepted. Supersedes [001] and [004].

## Context

On the Ubuntu/KDE laptop, Waybar replaced the Plasma panel, and mako/dunst ran
alongside Plasma's notification server. Those services were wanted by
`graphical-session.target`, which every Wayland session starts, so helpers for
one desktop leaked into the other. Two daemons racing for
`org.freedesktop.Notifications` and a waybar config that had to detect its host
compositor (ADR-001/004) were recurring sources of breakage.

## Decision

- Niri becomes the daily session on the Ubuntu laptop. Plasma stays installed as
  a stock Breeze Dark fallback with its own panel and notifications.
- Session helpers (bar, notifications, wallpaper, idle) start only in the
  session that owns them. Ubuntu enables the packaged waybar/mako units
  globally, so per-user drop-ins (`ConditionEnvironment=!XDG_CURRENT_DESKTOP=KDE`)
  gate them off Plasma; KDE-only units carry the inverse condition. niri-only
  helpers (wallpaper, idle, polkit agent) use `spawn-at-startup`.
- Stow the systemd package with `--no-folding`: systemd ignores drop-in
  directories that are themselves symlinks.
- Waybar configs are per compositor. The KDE waybar variant and the
  `~/.local/bin/waybar` wrapper are removed.
- Distro-specific scripts sit behind a shared entry point (`sysupdate-check`
  dispatches to `-apt` or `-arch`) so the two machines can share one waybar
  config.

## Consequences

- Plasma has no Waybar and needs no compositor detection.
- Each new session needs its own helper wiring; nothing comes for free from
  `graphical-session.target`.
- History of the KDE waybar setup lives in git (commit 242634e).
