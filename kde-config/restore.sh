#!/usr/bin/env bash
set -euo pipefail

# Restore the KDE Plasma 6 keymap / tiling / window-rule config captured during the
# Arch->Ubuntu migration. Copies these snapshots into ~/.config and backs up any
# existing files first. You MUST log out and back in afterward — KWin and kglobalaccel
# only read these at session start.
#
# Prereqs for everything to function:
#   - KDE Plasma 6 (Wayland)
#   - Krohnkite tiling script installed + enabled (codeberg.org/anametologin/Krohnkite)
#     -> kpackagetool6 -t KWin/Script -i <built pkg dir>
#   - The kde-* / chrome-* / webapp-* launcher .desktop files (scripts stow package)
#
# These are SNAPSHOTS, not live symlinks (KWin rewrites kwinrc constantly). Re-run
# backup by copying ~/.config/{kglobalshortcutsrc,kwinrc,kwinrulesrc} back here.

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
stamp=$(date +%Y%m%d-%H%M%S)

for f in kglobalshortcutsrc kwinrc kwinrulesrc; do
  if [[ -f "$HOME/.config/$f" ]]; then
    cp -v -- "$HOME/.config/$f" "$HOME/.config/$f.bak.$stamp"
  fi
  cp -v -- "$src/$f" "$HOME/.config/$f"
done

echo
echo "Restored. Now LOG OUT and back in to a Plasma (Wayland) session."
