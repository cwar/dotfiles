# KDE config snapshot (Ubuntu + Plasma 6 migration)

Captured keymap / tiling / window-rule config from the Arch→Ubuntu migration, so it
survives a re-image. **Snapshots, not stowed** — KWin rewrites `kwinrc` constantly, so a
live symlink would spam the repo. To re-snapshot: copy the three files from `~/.config/`
back here and commit.

## Files
- `kglobalshortcutsrc` — all global shortcuts: app launchers (`Meta+Return` etc.),
  window/workspace bindings, and the Krohnkite (`[kwin]`) tiling shortcuts.
- `kwinrc` — `[Plugins]` krohnkiteEnabled, `[Script-krohnkite]` gaps (8px),
  `[Windows]` FocusPolicy=FocusFollowsMouse, `[Desktops]` 11 desktops (incl. Scratch).
- `kwinrulesrc` — window rule forcing Chrome to open un-maximized (so Krohnkite tiles it).

## Restore (after a re-image)
1. Install Plasma 6 + the launcher `.desktop` files (`stow scripts`).
2. Install & enable **Krohnkite** (codeberg.org/anametologin/Krohnkite).
3. Run `./restore.sh`, then **log out and back in**.

## Keymap cheat-sheet
- `Meta+Return` tmux · `Meta+Alt+Return` plain terminal · `Meta+W` close · `Meta+F` fullscreen
- `Meta+1‑9,0` switch workspace · `Meta+Alt+1‑9,0` move window to workspace · `Meta+S`/`Meta+Alt+S` scratch
- Krohnkite: `Meta+arrows` focus · `Meta+Shift+arrows` move · `Meta+Ctrl+arrows` resize · `Meta+T` float · `Meta+\` layout
- Launchers: `Meta+Shift+` B chrome / C calendar / E gmail / F dolphin / G lazygit / O obsidian / M spotify; `Meta+Alt+V` vpn

## Gotcha
`Meta+Shift+<digit>` shortcuts are dead on KDE Wayland (Shift→symbol; GUI can't capture
them). That's why move-to-workspace uses `Meta+Alt+<digit>`, not `Meta+Shift+<digit>`.
