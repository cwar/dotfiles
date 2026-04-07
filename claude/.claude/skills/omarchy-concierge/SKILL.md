---
name: omarchy-concierge
description: >
  Personal theme concierge for Omarchy Linux desktops. Use when user wants to
  (1) browse/discover themes with aesthetic descriptions and mood matching,
  (2) get theme recommendations based on mood/activity/inspiration,
  (3) create custom themes from mood/aesthetic/movie/art descriptions,
  (4) find and install community themes from GitHub,
  (5) discover new/trending community themes,
  (6) manage wallpapers (find, download, filter to match theme),
  (7) view theme usage statistics and history,
  (8) learn what themes look/feel like before switching.
  Triggers: "theme concierge", "recommend a theme", "what theme feels like",
  "I want something cozy", "create a theme inspired by", "find new themes",
  "trending themes", "what themes are new", "theme stats", "how long have I used",
  "switch to something", "describe the themes", "theme mood", "find wallpapers",
  "change wallpaper", "theme usage", "what's my most used theme".
---

# Omarchy Concierge

Your personal theme concierge for [Omarchy](https://omarchy.org/) Linux desktops — a beautiful, modern, opinionated Arch Linux distribution with Hyprland.

## Important: Relationship to Omarchy Skill

This skill **extends** the base `omarchy` skill. For any config editing, keybindings, or system changes, defer to the omarchy skill's safety rules. This skill focuses exclusively on:

- Theme discovery, recommendation, and aesthetic matching
- Custom theme creation
- Community theme discovery and installation
- Wallpaper management
- Theme usage metrics and history

**NEVER modify files in `~/.local/share/omarchy/`** — always use Omarchy's built-in commands.

## Quick Reference: Omarchy Theme System

### Commands

| Command | Purpose |
|---------|---------|
| `omarchy-theme-list` | List all available themes |
| `omarchy-theme-current` | Show current theme |
| `omarchy-theme-set <name>` | Apply a theme (e.g., `omarchy-theme-set "Event Horizon"`) |
| `omarchy-theme-install <url>` | Install community theme from git repo |
| `omarchy-theme-update` | Update all git-based community themes |
| `omarchy-theme-remove` | Remove a community theme |
| `omarchy-theme-refresh` | Re-apply current theme from templates |
| `omarchy-theme-bg-next` | Cycle to next wallpaper in current theme |
| `omarchy-theme-bg-set <path>` | Set a specific wallpaper |
| `omarchy-theme-bg-install` | Install a wallpaper for current theme |

### Theme File Structure

Each theme is a directory (in `~/.local/share/omarchy/themes/` for stock, `~/.config/omarchy/themes/` for user/community):

```
theme-name/
├── colors.toml          # REQUIRED: Color definitions (accent, fg, bg, ANSI 0-15)
├── backgrounds/         # Wallpaper images for this theme
├── btop.theme           # btop color scheme
├── neovim.lua           # Neovim colorscheme plugin config
├── vscode.json          # VS Code theme extension reference
├── icons.theme          # GTK icon theme name
├── preview.png          # Theme preview screenshot
├── waybar.css           # Custom waybar overrides (optional)
├── hyprland.conf        # Custom hyprland overrides (optional)
├── light.mode           # Marker file: presence = light theme
└── README.md            # Theme description (community themes)
```

### colors.toml Format

```toml
accent = "#hex"
cursor = "#hex"
foreground = "#hex"
background = "#hex"
selection_foreground = "#hex"
selection_background = "#hex"

# ANSI colors 0-15
color0 = "#hex"   # Black
color1 = "#hex"   # Red
color2 = "#hex"   # Green
color3 = "#hex"   # Yellow
color4 = "#hex"   # Blue
color5 = "#hex"   # Magenta
color6 = "#hex"   # Cyan
color7 = "#hex"   # White
color8 = "#hex"   # Bright Black
color9 = "#hex"   # Bright Red
color10 = "#hex"  # Bright Green
color11 = "#hex"  # Bright Yellow
color12 = "#hex"  # Bright Blue
color13 = "#hex"  # Bright Magenta
color14 = "#hex"  # Bright Cyan
color15 = "#hex"  # Bright White

# Optional extended colors (used by some templates)
active_border_color = "#hex"
active_tab_background = "#hex"
```

### Template System

Omarchy generates app configs from templates in `~/.local/share/omarchy/default/themed/*.tpl` using placeholders:
- `{{ accent }}` → the full hex value (e.g., `#89b4fa`)
- `{{ accent_strip }}` → hex without `#` (e.g., `89b4fa`)
- `{{ accent_rgb }}` → decimal RGB (e.g., `137,180,250`)

User template overrides go in `~/.config/omarchy/themed/*.tpl`.

---

## Workflows

### Browse / Describe Themes

```
User: "Describe the available themes"
User: "What themes do I have?"
```

1. Run `omarchy-theme-list` to get all available themes
2. Read `references/themes.md` for aesthetic descriptions of stock themes
3. Check `~/.config/omarchy/themes/` for installed community themes
4. For community themes, read their `README.md` and `colors.toml` to characterize them
5. Note which is currently active via `omarchy-theme-current`
6. Present with mood/aesthetic descriptions and color highlights

### Recommend Theme by Mood

```
User: "I want something cozy"
User: "What theme feels like a rainy day?"
User: "Recommend something for late-night coding"
```

1. Read `references/themes.md` → get aesthetic descriptions and mood tags
2. Match user's description against theme moods/inspirations
3. Also search community themes catalog in `references/community-themes.md`
4. Recommend 1-3 themes with explanation of why they fit
5. Offer to apply: `omarchy-theme-set "<Name>"`
6. If recommending an uninstalled community theme, offer to install it

### Apply Theme

```
User: "Switch to Catppuccin"
User: "Try the Nord theme"
```

1. Check if theme is installed: `omarchy-theme-list`
2. If installed: `omarchy-theme-set "<Name>"`
3. If not installed but known community theme: offer to install first
4. Log the theme change to metrics: append to `~/.local/share/omarchy-concierge/theme-history.jsonl`

### Create Custom Theme

```
User: "Create a theme inspired by Blade Runner"
User: "Make me a theme with teal and coral accents"
```

1. Read `references/color-schema.md` for required color slots
2. Analyze the inspiration's visual language:
   - Dominant background color
   - 1-2 signature accent colors
   - Semantic mappings (what feels like error/success/warning in that world?)
3. Generate a complete `colors.toml`
4. Find or ask about appropriate wallpapers
5. Create the theme directory at `~/.config/omarchy/themes/<theme-name>/`
6. Create `colors.toml`, and optionally `neovim.lua`, `vscode.json`, `btop.theme`, `icons.theme`
7. Copy or download background images to `backgrounds/`
8. Apply with `omarchy-theme-set "<Theme Name>"`
9. Log to metrics

### Discover New Community Themes

```
User: "What new themes are available?"
User: "Show me trending Omarchy themes"
User: "Any new themes this week?"
```

**Interactive picker (recommended):** Launch the discovery TUI where users can browse, fuzzy-search, preview details, and install with Enter:

```bash
python3 ~/.claude/skills/omarchy-concierge/scripts/discover-themes.py           # Interactive fzf picker
python3 ~/.claude/skills/omarchy-concierge/scripts/discover-themes.py --multi   # Multi-select with Tab
python3 ~/.claude/skills/omarchy-concierge/scripts/discover-themes.py --sort updated  # Sort by recently updated
```

**Non-interactive / programmatic:**

```bash
python3 ~/.claude/skills/omarchy-concierge/scripts/discover-themes.py --print   # Plain text list
python3 ~/.claude/skills/omarchy-concierge/scripts/discover-themes.py --json    # JSON output
```

**Manual discovery workflow:**
1. Read `references/community-themes.md` for the known catalog
2. Search GitHub for new omarchy theme repos
3. Compare against already-installed themes (`~/.config/omarchy/themes/`)
4. Present new/trending themes with descriptions and star counts
5. Check the official extra themes page: https://manuals.omamix.org/2/the-omarchy-manual/90/extra-themes
6. Offer to install interesting ones

### Install Community Theme

```
User: "Install the Dracula theme"
User: "Try that Mars theme"
```

1. Look up the theme's git URL from `references/community-themes.md` or GitHub search
2. Run: `omarchy-theme-install <git-url>`
3. The command clones the repo and applies the theme automatically
4. Log to metrics

### View Theme Usage Stats

```
User: "What's my most used theme?"
User: "How long have I used each theme?"
User: "Show me my theme history"
```

1. Read `~/.local/share/omarchy-concierge/theme-history.jsonl`
2. Calculate:
   - Total time per theme (time between switches)
   - Most used theme (by duration)
   - Current streak (how long on current theme)
   - Switch frequency (changes per week/month)
   - Favorite time-of-day for switching
3. Present as a summary with visual indicators

### Wallpaper Management

```
User: "Find wallpapers for my theme"
User: "I need a new wallpaper"
User: "Download a cyberpunk wallpaper"
```

1. Get current theme colors from `~/.config/omarchy/current/theme/colors.toml`
2. Search Wallhaven with theme-appropriate keywords (see `references/wallpapers.md`)
3. Generate themed HTML preview page using `scripts/wallpaper-preview.py`
4. Open in browser for user to browse
5. Download selected wallpaper
6. Install to theme's backgrounds dir or `~/.config/omarchy/backgrounds/<theme>/`
7. Apply with `omarchy-theme-bg-set <path>` or `omarchy-theme-bg-next`

### Apply Wallpaper

```
User: "Use that wallpaper" / "Download wallpaper xyz"
```

1. Download from source (Wallhaven, Unsplash, etc.)
2. Optionally apply color grading to match theme: `python scripts/wallpaper-filter.py`
3. Save to `~/.config/omarchy/backgrounds/<current-theme>/`
4. Apply: `omarchy-theme-bg-set <path>`

---

## Theme Metrics System

### Storage

Theme usage data is stored in `~/.local/share/omarchy-concierge/theme-history.jsonl` (JSON Lines format):

```jsonl
{"timestamp":"2025-12-15T10:30:00-05:00","event":"theme_set","theme":"catppuccin","source":"manual"}
{"timestamp":"2025-12-15T14:00:00-05:00","event":"theme_set","theme":"tokyo-night","source":"manual"}
```

### Hook Integration

The theme-set hook at `~/.config/omarchy/hooks/theme-set` should include a line to log theme changes. When setting up metrics for the first time, APPEND to the existing hook (don't overwrite):

```bash
# Log theme change for omarchy-concierge metrics
~/.local/share/omarchy-concierge/bin/log-theme-change "$1"
```

### Metrics Script

The logging script at `~/.local/share/omarchy-concierge/bin/log-theme-change` records each theme switch with timestamp.

### Stats Available

| Metric | Description |
|--------|-------------|
| Time per theme | Duration between switches |
| Most used theme | Longest total usage time |
| Current streak | Time on current theme |
| Switch frequency | Changes per time period |
| Time-of-day patterns | When you tend to switch themes |
| Theme journey | Chronological list of all themes used |

---

## Creating Custom Themes (Detailed)

### Required Files

At minimum, a custom theme needs:

1. **`colors.toml`** — All color definitions (see format above)
2. **`backgrounds/`** — At least one wallpaper image

### Optional Files

| File | Purpose | How to create |
|------|---------|---------------|
| `neovim.lua` | Neovim colorscheme | Reference existing theme's file or use a known plugin |
| `vscode.json` | VS Code theme | `{"name": "Theme Name", "extension": "publisher.extension-id"}` |
| `btop.theme` | btop theme | Copy and modify from stock theme |
| `icons.theme` | GTK icon theme name | Single line, e.g., `Yaru-purple` |
| `waybar.css` | Waybar overrides | Custom CSS beyond what templates generate |
| `hyprland.conf` | Hyprland overrides | Custom border colors, etc. |
| `preview.png` | Screenshot | Take after applying with `grim` |
| `light.mode` | Light theme marker | Empty file, presence = light mode |

### Thought Process for Inspiration-Based Themes

When creating a theme from a movie, artwork, or mood:

1. **Extract the visual palette**: What are the 2-3 dominant colors? What's the background darkness level?
2. **Map emotions to semantics**: What color feels like "danger" in that world? "Success"? "Info"?
3. **Choose accent carefully**: The accent color is the most visible — it colors borders, links, selections
4. **Contrast is king**: Ensure foreground on background has sufficient contrast for readability
5. **Test ANSI colors**: The 16 terminal colors need to be distinguishable from each other

---

## References

- [Theme Library](references/themes.md) — Aesthetic descriptions for all stock themes
- [Color Schema](references/color-schema.md) — Semantic color definitions and format
- [Community Themes](references/community-themes.md) — Catalog of community themes with URLs
- [Wallpapers](references/wallpapers.md) — Wallpaper search, preview, and color grading
- [Theme Metrics](references/metrics.md) — Usage tracking setup and analysis
