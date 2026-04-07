# Omarchy Theme Color Schema

## Required Colors (colors.toml)

Every Omarchy theme must define these in `colors.toml`:

### UI Colors

| Key | Purpose | Notes |
|-----|---------|-------|
| `accent` | Primary accent (borders, selections, active elements) | Most visible color — defines the theme's personality |
| `cursor` | Terminal cursor color | Usually foreground or a warm highlight |
| `foreground` | Primary text color | Must contrast well against `background` |
| `background` | Primary background color | The dominant surface color |
| `selection_foreground` | Text color when selected | Often background color (inverted) |
| `selection_background` | Highlight color when selected | Often cursor or accent color |

### ANSI Terminal Colors (0-15)

Standard 16-color terminal palette:

| Key | ANSI | Color Name | Typical Use |
|-----|------|------------|-------------|
| `color0` | 0 | Black | Dark background variant |
| `color1` | 1 | Red | Errors, deletions, urgent |
| `color2` | 2 | Green | Success, additions, paths |
| `color3` | 3 | Yellow | Warnings, strings |
| `color4` | 4 | Blue | Info, keywords, accent |
| `color5` | 5 | Magenta | Special, decorators |
| `color6` | 6 | Cyan | Secondary accent, comments |
| `color7` | 7 | White | Light foreground variant |
| `color8` | 8 | Bright Black | Comments, muted text |
| `color9` | 9 | Bright Red | Bright errors |
| `color10` | 10 | Bright Green | Bright success |
| `color11` | 11 | Bright Yellow | Bright warnings |
| `color12` | 12 | Bright Blue | Bright info/accent |
| `color13` | 13 | Bright Magenta | Bright special |
| `color14` | 14 | Bright Cyan | Bright secondary |
| `color15` | 15 | Bright White | Brightest text |

### Optional Extended Colors

Some themes and templates use additional keys:

| Key | Purpose |
|-----|---------|
| `active_border_color` | Hyprland active window border (defaults to accent) |
| `active_tab_background` | Active tab color in terminals |

## Color Format

All values are 7-character hex strings with `#` prefix:

```toml
accent = "#89b4fa"
```

The template system provides automatic conversions:
- `{{ accent }}` → `#89b4fa` (full hex)
- `{{ accent_strip }}` → `89b4fa` (without `#`)
- `{{ accent_rgb }}` → `137,180,250` (decimal RGB)

## Design Guidelines for Custom Themes

### Contrast

- Foreground on background: minimum 4.5:1 contrast ratio (WCAG AA)
- Accent on background: minimum 3:1 for UI elements
- Test readability: `echo -e "\e[38;2;R;G;Bm Sample text \e[0m"` on your background

### Color Harmony

1. **Monochrome**: One hue, varied lightness (e.g., Vantablack)
2. **Analogous**: Adjacent hues (e.g., Catppuccin's blue-lavender-pink)
3. **Complementary**: Opposite hues for accent pop (e.g., Matte Black's amber on black)
4. **Triadic**: Three equidistant hues (e.g., Event Horizon's teal-pink-peach)

### ANSI Color Tips

- Colors 0-7 and 8-15 often mirror each other (bright variants)
- `color0` should be slightly lighter than `background` for visible dark elements
- `color7` should be slightly darker than `foreground` for subtle text
- Red (1/9) should ALWAYS be distinguishable — it signals errors
- Green (2/10) should feel like "positive" — success states, additions

### Light vs Dark Themes

For light themes, create a `light.mode` marker file (empty) in the theme directory. This signals Omarchy to:
- Use light GTK theme variants
- Adjust icon themes
- Switch Chromium to light mode
