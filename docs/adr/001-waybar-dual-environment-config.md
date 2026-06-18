# 001. Dual-environment Waybar configuration (Omarchy/Hyprland + Ubuntu/KDE)

Date: 2026-06-18

## Status

Accepted

## Context

The workstation is migrating from Arch + Omarchy + Hyprland to a Spotify-managed
Ubuntu LTS + KDE Plasma (Wayland / KWin) setup. We want to keep using Waybar on
both environments and maintain a single dotfiles repo that supports each.

Constraints and forces:

- Waybar reads exactly **one** config path at launch (`~/.config/waybar/config.jsonc`
  by default). Maintaining two environments means storing both and *selecting*
  the right one at launch.
- The bulk of the bar (clock, battery, disk, network, wireplumber, tray) is
  **identical** across environments. Only the **workspaces module**, the module
  **layout**, and the **workspace CSS** differ.
- On Hyprland, the native `hyprland/workspaces` module gives per-button,
  clickable workspaces. KWin exposes **no** equivalent Waybar module, and
  Ubuntu's Waybar build (`0.15.0`) has `wlr/workspaces` compiled out
  (`Unknown module: wlr/workspaces`).
- Waybar supports an `include` key (shallow merge; the *outer* file wins on key
  conflicts — verified empirically). GTK CSS supports `@import`.
- The repo is deployed with GNU `stow` (e.g. `ghostty`, `nvim` are stowed).

## Decision

Use **one `waybar` stow package** with a shared base plus per-environment files:

```
waybar/.config/waybar/
  common.jsonc / common.css        # shared base + shared module definitions
  config-kde.jsonc / style-kde.css # KWin layout + workspace modules ("include" common)
  config-hypr.jsonc / style-hypr.css # Hyprland layout ("include" common)
  config.jsonc  -> config-hypr.jsonc # default symlink (Omarchy launches no-arg)
  style.css     -> style-hypr.css
  scripts/kwin-workspaces, scripts/kwin-occupancy.js  # KDE-only, inert on Hypr
```

- Shared modules live once in `common.jsonc`; each env file `include`s it and
  adds only its layout + workspace modules. CSS shares via `@import "common.css"`.
- **Selection is per-launch, not per-file-swap:**
  - KDE: `waybar.service` (systemd --user) runs
    `waybar -c …/config-kde.jsonc -s …/style-kde.css`.
  - Omarchy/Hyprland: launches `waybar` with no args → reads the default
    `config.jsonc` symlink → `config-hypr.jsonc` (zero-touch on Omarchy).
- **KWin workspaces** are implemented with a persistent KWin script
  (`kwin-occupancy.js`) that pushes desktop state over D-Bus to a Python daemon
  (`kwin-workspaces daemon`, service `org.waybar.Kwin`). The daemon writes a
  state file in `$XDG_RUNTIME_DIR` and signals Waybar (`SIGRTMIN+1`). Eleven
  `custom/ws<N>` modules each read that file (occupied-only display) and switch
  desktops on click — recreating per-button clickability.
- On KDE the **Plasma panel is removed** and Waybar autostarts via the
  `systemd --user` unit bound to `graphical-session.target`.

## Consequences

Positive:

- Shared modules are DRY — fix once, both environments inherit.
- Single source of truth via stow (`~/.config/waybar` → repo); no live/repo drift.
- Both environments remain first-class; Omarchy needs no launch changes.
- systemd cgroup ownership tears down Waybar + its daemon child atomically on
  restart (no orphaned helper processes).

Negative / risks:

- Paths in `config-kde.jsonc` and the unit hardcode `/home/cwar` (acceptable:
  same user on both machines; could be templated later).
- KWin workspace modules are fixed at 11 (`ws0`–`ws10`), matching the current
  virtual-desktop count; adding a desktop needs another module block.
- The `waybar.service` unit must be enabled **per machine** — enabling it on
  Omarchy (which already autostarts Waybar via Hyprland) would create two bars.
  Therefore the `systemd` package is intentionally NOT stowed wholesale.
- The KWin-script + D-Bus approach is specific to KDE Plasma 6 / KWin scripting.

Follow-up:

- Port remaining status signals (calendar next-meeting, action-needed,
  Pi stuck detector, `healthcheck`, Ubuntu update indicator) to KDE-appropriate
  mechanisms (tray, notifications, or KRunner).
