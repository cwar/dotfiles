#!/usr/bin/env bash
# Focus the pi terminal window for the stuck session.
# Called by mako on notification click.
# Finds the stuck session from state files, then matches it to a hyprland window.

STATE_DIR="$HOME/.cache/pi-stuck"

# Find the stuck session's PID
stuck_pid=""
stuck_project=""
for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  if python3 -c "
import json, sys
d = json.load(open('$f'))
if d.get('stuck'):
    print(d['pid'])
    sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
    stuck_pid=$(python3 -c "import json; print(json.load(open('$f'))['pid'])")
    stuck_project=$(python3 -c "import json; print(json.load(open('$f'))['project'])")
    break
  fi
done

# Fallback: if no stuck state found, try to match by project from notification
# mako passes the notification body as arguments sometimes, but we also
# try to find any pi window
if [ -z "$stuck_pid" ]; then
  # Just focus any window with pi in the title
  hyprctl dispatch focuswindow "title:π -"
  exit 0
fi

# Strategy 1: Find the terminal whose process tree contains the stuck pi PID
# The pi process (stuck_pid) is a child of the terminal (ghostty)
terminal_pid=""
ppid="$stuck_pid"
while [ -n "$ppid" ] && [ "$ppid" != "1" ]; do
  comm=$(cat "/proc/$ppid/comm" 2>/dev/null)
  if [ "$comm" = "ghostty" ] || [ "$comm" = "alacritty" ] || [ "$comm" = "kitty" ] || [ "$comm" = "foot" ]; then
    terminal_pid="$ppid"
    break
  fi
  ppid=$(awk '{print $4}' "/proc/$ppid/stat" 2>/dev/null)
done

if [ -n "$terminal_pid" ]; then
  hyprctl dispatch focuswindow "pid:$terminal_pid"
  exit 0
fi

# Strategy 2: Match by project name in window title
if [ -n "$stuck_project" ]; then
  hyprctl dispatch focuswindow "title:$stuck_project"
  exit 0
fi

# Strategy 3: Just focus any pi window
hyprctl dispatch focuswindow "title:π -"
