#!/bin/bash
#
# Setup theme usage metrics for omarchy-concierge
#
# Creates the data directory, installs the logging script,
# and hooks into omarchy's theme-set hook.
#

set -euo pipefail

DATA_DIR="$HOME/.local/share/omarchy-concierge"
BIN_DIR="$DATA_DIR/bin"
HISTORY_FILE="$DATA_DIR/theme-history.jsonl"
HOOK_FILE="$HOME/.config/omarchy/hooks/theme-set"
LOGGER_SCRIPT="$BIN_DIR/log-theme-change"
HOOK_MARKER="# omarchy-concierge metrics"

echo "Setting up omarchy-concierge theme metrics..."

# 1. Create directories
mkdir -p "$BIN_DIR"
echo "  ✓ Created $DATA_DIR"

# 2. Install the logger script
cat > "$LOGGER_SCRIPT" << 'SCRIPT'
#!/bin/bash
#
# Log a theme change event to the omarchy-concierge history file.
# Usage: log-theme-change <theme-name> [source]
#

THEME_NAME="${1:-unknown}"
SOURCE="${2:-hook}"
DATA_DIR="$HOME/.local/share/omarchy-concierge"
HISTORY_FILE="$DATA_DIR/theme-history.jsonl"

mkdir -p "$DATA_DIR"

TIMESTAMP=$(date -Iseconds)

printf '{"timestamp":"%s","event":"theme_set","theme":"%s","source":"%s"}\n' \
  "$TIMESTAMP" "$THEME_NAME" "$SOURCE" >> "$HISTORY_FILE"
SCRIPT

chmod +x "$LOGGER_SCRIPT"
echo "  ✓ Installed logger at $LOGGER_SCRIPT"

# 3. Hook into theme-set (append if not already present)
mkdir -p "$(dirname "$HOOK_FILE")"

if [[ -f "$HOOK_FILE" ]]; then
  if grep -q "$HOOK_MARKER" "$HOOK_FILE"; then
    echo "  ✓ Hook already installed in $HOOK_FILE"
  else
    echo "" >> "$HOOK_FILE"
    echo "$HOOK_MARKER" >> "$HOOK_FILE"
    echo "$LOGGER_SCRIPT \"\$1\"" >> "$HOOK_FILE"
    echo "  ✓ Appended metrics logging to existing hook"
  fi
else
  cat > "$HOOK_FILE" << EOF
#!/bin/bash

$HOOK_MARKER
$LOGGER_SCRIPT "\$1"
EOF
  chmod +x "$HOOK_FILE"
  echo "  ✓ Created hook at $HOOK_FILE"
fi

# 4. Seed with current theme if history is empty
if [[ ! -f "$HISTORY_FILE" ]] || [[ ! -s "$HISTORY_FILE" ]]; then
  CURRENT_THEME=$(cat "$HOME/.config/omarchy/current/theme.name" 2>/dev/null || echo "unknown")
  "$LOGGER_SCRIPT" "$CURRENT_THEME" "seed"
  echo "  ✓ Seeded history with current theme: $CURRENT_THEME"
fi

echo ""
echo "Done! Theme changes will now be logged to:"
echo "  $HISTORY_FILE"
echo ""
echo "View stats with:"
echo "  python3 ~/.claude/skills/omarchy-concierge/scripts/theme-stats.py"
