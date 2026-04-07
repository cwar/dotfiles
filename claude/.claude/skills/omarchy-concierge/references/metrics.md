# Theme Usage Metrics

Track which themes you use, how long you use each one, and your switching patterns.

## Setup

The metrics system has two components:

1. **Logger script** — Appends an entry to the history file on every theme change
2. **Hook integration** — Calls the logger automatically when `omarchy-theme-set` runs

### Installation

Run the setup script to install both:

```bash
bash ~/.claude/skills/omarchy-concierge/scripts/setup-metrics.sh
```

This:
1. Creates `~/.local/share/omarchy-concierge/` directory
2. Installs `bin/log-theme-change` logger script
3. Appends the logging call to `~/.config/omarchy/hooks/theme-set`
4. Seeds the history with the current theme

### Manual Logging

If you need to manually log a theme change:

```bash
~/.local/share/omarchy-concierge/bin/log-theme-change "theme-name"
```

## Data Format

History is stored as JSONL (one JSON object per line) at:

```
~/.local/share/omarchy-concierge/theme-history.jsonl
```

Each line:
```json
{"timestamp":"2025-12-15T10:30:00-05:00","event":"theme_set","theme":"catppuccin","source":"hook"}
```

Fields:
- `timestamp` — ISO 8601 with timezone
- `event` — Always `theme_set` for now (extensible for future events)
- `theme` — Theme directory name (lowercase, hyphenated)
- `source` — How the change was triggered: `hook` (automatic), `manual` (explicit log), `seed` (initial)

## Querying Stats

### Quick Stats (bash)

```bash
# Most recent theme changes
tail -5 ~/.local/share/omarchy-concierge/theme-history.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    print(f\"{d['timestamp'][:16]}  →  {d['theme']}\")
"

# Count by theme
cat ~/.local/share/omarchy-concierge/theme-history.jsonl | python3 -c "
import sys, json
from collections import Counter
themes = Counter()
for line in sys.stdin:
    d = json.loads(line)
    themes[d['theme']] += 1
for theme, count in themes.most_common():
    print(f'{count:3d} switches  {theme}')
"
```

### Full Stats (Python script)

```bash
python3 ~/.claude/skills/omarchy-concierge/scripts/theme-stats.py
```

This shows:
- Time spent per theme (sorted by duration)
- Current theme and streak
- Switch frequency (per week/month)
- Most active switching hours
- Theme journey timeline

### Stats with date range

```bash
python3 ~/.claude/skills/omarchy-concierge/scripts/theme-stats.py --since 2025-01-01
python3 ~/.claude/skills/omarchy-concierge/scripts/theme-stats.py --last 30d
```

## Metrics Available

| Metric | Description |
|--------|-------------|
| **Total time per theme** | Sum of all durations spent on each theme |
| **Most used theme** | Theme with longest total duration |
| **Current streak** | How long you've been on the current theme |
| **Switch count** | Total number of theme changes |
| **Average session** | Average time between theme switches |
| **Peak hours** | Time-of-day when you most often switch |
| **Theme journey** | Chronological list of all changes |
| **Favorites ratio** | Percentage of total time per theme |

## Extending Metrics

The JSONL format is designed to be extensible. Future event types could include:
- `wallpaper_set` — Track wallpaper changes
- `theme_install` — Track new theme installations
- `theme_remove` — Track theme removals
