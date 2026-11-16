# 004. Adaptive KDE Waybar output selection

Date: 2026-06-26

## Status

Superseded by [006](006-niri-primary-session-scoped-helpers.md)

## Context

The KDE Plasma Waybar config originally used `"output": "!eDP-1"` so the bar
would draw only on external monitors and never on the laptop panel. That worked
well while docked and avoided phantom bars during output-state flapping, but it
failed when the laptop was unplugged from the external monitor: Waybar removed
its bar from `DP-1`, the laptop panel was the only active output, and the config
forbade Waybar from drawing there.

The same undock event can also trigger Intel i915/KWin display pipeline stalls on
this laptop, but the status-bar disappearance itself is a separate static-config
problem.

## Decision

Launch KDE Waybar through `scripts/waybar-kde-launch` instead of invoking
`/usr/bin/waybar` directly from `waybar.service`.

The launcher:

- Reads the live KScreen topology with `kscreen-doctor -j`.
- Generates a runtime config at `$XDG_RUNTIME_DIR/waybar/config-kde-active.jsonc`
  from `config-kde.jsonc` with only the `output` selector changed.
- Uses `!eDP-1` when any enabled and connected non-laptop output exists.
- Uses `eDP-1` when the laptop panel is the only active output.
- Supervises the Waybar child process and restarts it when the topology flips
  between those two states.
- Terminates unmanaged duplicate Waybar processes so multiple top-edge
  layer-shell exclusive zones cannot push the managed bar down.

A small interactive wrapper is also installed at `~/.local/bin/waybar` via the
`scripts` stow package. In KDE, plain `waybar` restarts `waybar.service` instead
of launching a second bar. The raw binary remains available as `/usr/bin/waybar`
or via `WAYBAR_RAW=1 waybar`.

The checked-in `config-kde.jsonc` keeps `"output": "!eDP-1"` as a direct-launch
fallback, but the systemd-managed path uses the generated runtime config.

## Consequences

Positive:

- Waybar appears on the laptop panel after undocking without manually editing the
  config or restarting the session.
- Docked behavior remains external-only.
- `systemctl --user restart waybar.service` remains the single recovery command.
- The human-edited Waybar config stays mostly declarative; hardware topology
  logic lives in a small testable launcher.

Negative / risks:

- `waybar.service` now runs a lightweight Python supervisor as its main process,
  with Waybar as a child process.
- Output changes are detected by polling KScreen every two seconds instead of by
  subscribing to KScreen DBus signals.
- Duplicate Waybar processes are treated as accidental in the KDE session and
  are cleaned up automatically by the supervisor.
- The launcher is KDE-specific and depends on `kscreen-doctor`.

Follow-up:

- If the polling ever becomes noisy or unreliable, replace it with a KScreen DBus
  signal subscription.
- The separate i915 display-stall issue still requires the kernel/GRUB PSR fix
  and a reboot.
