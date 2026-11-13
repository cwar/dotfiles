# dotfiles

My Arch Linux + Hyprland desktop config, managed with [GNU Stow](https://www.gnu.org/software/stow/).
Each top-level directory is a **stow package**. Its contents mirror `$HOME`, so stowing one
symlinks those files into place.

```sh
git clone --recurse-submodules <repo> ~/dotfiles
cd ~/dotfiles
stow hypr waybar zsh   # or whichever packages you want
```

To add a new config: put it at `~/dotfiles/<app>/.config/<app>/...`, then `stow <app>`.

## Packages

| Package | What it is |
|---|---|
| `hypr` | Hyprland compositor (`hyprland.lua` is the live config, `hyprland.conf` is the legacy fallback), plus hypridle and hyprlock |
| `waybar` | Status bar: ext-workspace workspaces, sysupdate indicator, disks, battery, DualSense battery |
| `rofi` | Launcher and menu theme (Tokyo Night) |
| `quickshell` | QML shell experiments (bar, notifications, K8s sidebar) |
| `ghostty` | Terminal |
| `tmux` | tmux config; theme colors live in `.config/tmux/theme.conf` |
| `zsh` | `.zshrc` (oh-my-zsh) |
| `starship` | Prompt |
| `nvim` | Neovim (LazyVim-based) |
| `lazygit` | Lazygit config |
| `yazi` | File manager, keymap, and plugins (`mediainfo.yazi` is a git submodule) |
| `cheat` | Personal [cheat](https://github.com/cheat/cheat) sheets (hyprland, pebble, yazi, ...) |
| `xdg-desktop-portal` | Portal backend selection for Hyprland |
| `xdg-desktop-portal-termfilechooser` | Use yazi in a terminal as the system file picker |
| `systemd` | User units: `hyprland-session.target`, hypr-undo-close, claude-insights digest timer |
| `scripts` | `~/.local/bin` helpers (see below) |
| `claude` | Claude Code skills (`~/.claude/skills`) |
| `pi` | Pi agent settings (machine-local auth/sessions are gitignored) |

### Not stowed

| Directory | Why |
|---|---|
| `system-configs/` | Root-owned configs (autofs, plymouth, sddm). Install with `sudo ./install.sh`; see its README |
| `kde-config/` | Plasma 6 snapshots. KWin rewrites `kwinrc` constantly, so these are copied in, not symlinked; see its README |

## Notable scripts (`scripts/.local/bin`)

- `keybinds-menu`: rofi menu of every Hyprland keybinding (Super+K). **Add new binds here too.**
- `hypr-undo-close`: recoverable window close (Super+W) and undo (Super+Z)
- `launch-or-focus`, `launch-lazygit`: focus an existing window or launch a new one
- `sysupdate`, `sysupdate-check`, `sysupdate-launch`: pacman/AUR updates with a waybar indicator
- `theme-switch`: swap desktop themes
- `screenshot-smart`, `screencast-smart`, `universal-copy`, `universal-paste`, `cliphist-rofi`: capture and clipboard tools
- `tmux-url-picker`, `tmux-cmd-picker`, `tmux-clean-copy`, `fzf-tmux`: tmux pickers
- `remember` / `recall`: a personal `history` for notes and captured terminal output
- `pebble-shot`: build, install, and screenshot in the Pebble emulator, then tear it down
- `vpn`: GlobalProtect/Tailscale VPN TUI

## Gotchas

- **Hyprland >= 0.56 dispatch is Lua.** `hyprctl dispatch focuswindow ...` fails silently.
  Use `hyprctl dispatch "hl.dsp.focus({ window = '...' })"`. The `cheat hyprland` sheet has the full mapping.
- **`~/.local/bin` is not on Hyprland's PATH.** Use absolute `~/.local/bin/...` paths in binds and exec calls.
- Some scripts that configs reference (e.g. `dualsense-battery` for waybar) live only in
  `~/.local/bin` on the machine and are not tracked here yet.
