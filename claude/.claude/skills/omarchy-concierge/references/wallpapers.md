# Wallpaper Management

## How Omarchy Manages Wallpapers

Wallpapers are per-theme, stored in two locations:

1. **Theme backgrounds:** `~/.config/omarchy/current/theme/backgrounds/` (from theme package)
2. **User backgrounds:** `~/.config/omarchy/backgrounds/<theme-name>/` (your additions)

`omarchy-theme-bg-next` cycles through both directories combined, sorted alphabetically.

### Commands

| Command | Purpose |
|---------|---------|
| `omarchy-theme-bg-next` | Cycle to next wallpaper |
| `omarchy-theme-bg-set <path>` | Set specific wallpaper |
| `omarchy-theme-bg-install` | Install wallpaper for current theme (interactive) |

### Adding Custom Wallpapers

```bash
# Get current theme name
THEME=$(cat ~/.config/omarchy/current/theme.name)

# Create user backgrounds directory for current theme
mkdir -p ~/.config/omarchy/backgrounds/$THEME

# Download and save wallpaper there
curl -L "URL" -o ~/.config/omarchy/backgrounds/$THEME/my-wallpaper.jpg

# Cycle to it
omarchy-theme-bg-next
```

## Wallpaper Sources

### Wallhaven (Primary)

| Item | URL Pattern |
|------|-------------|
| Search | `https://wallhaven.cc/search?q={query}&sorting=favorites` |
| Thumbnail | `https://th.wallhaven.cc/lg/{first2chars}/{id}.jpg` |
| Full page | `https://wallhaven.cc/w/{id}` |
| Full image | `https://w.wallhaven.cc/full/{first2chars}/wallhaven-{id}.jpg` |

Example: For wallpaper ID `l3qo2r`:
- Thumbnail: `https://th.wallhaven.cc/lg/l3/l3qo2r.jpg`
- Page: `https://wallhaven.cc/w/l3qo2r`
- Full: `https://w.wallhaven.cc/full/l3/wallhaven-l3qo2r.jpg`

### Other Sources

- **Unsplash:** https://unsplash.com — High-quality photography
- **Alpha Coders:** https://wall.alphacoders.com — Huge collection
- **Reddit:** r/wallpapers, r/unixporn — Community curated
- **Gruvbox Wallpapers:** https://gruvbox-wallpapers.pages.dev
- **Catppuccin Wallpapers:** Search "catppuccin wallpaper" on GitHub

## Search Keywords by Theme

| Theme | Search Keywords |
|-------|-----------------|
| Catppuccin | `pastel aesthetic`, `cozy room dark`, `soft colors`, `coffee shop` |
| Catppuccin Latte | `pastel light`, `soft morning`, `cream aesthetic` |
| Ethereal | `deep space nebula`, `aurora dark`, `cosmic glow` |
| Everforest | `forest canopy`, `moss trees`, `nature dark green` |
| Flexoki Light | `minimal paper`, `typography`, `warm white` |
| Gruvbox | `autumn forest`, `vintage warm`, `retro orange brown` |
| Hackerman | `matrix code`, `hacker terminal green`, `cyberpunk neon green` |
| Kanagawa | `japanese wave art`, `ukiyo-e`, `zen garden night` |
| Matte Black | `dark minimal`, `luxury car matte`, `dark abstract` |
| Miasma | `swamp dark`, `moss lichen`, `dark forest green` |
| Nord | `arctic landscape`, `scandinavian minimal`, `winter blue` |
| Osaka Jade | `japan night green`, `jade stone`, `bamboo dark` |
| Ristretto | `coffee dark`, `espresso`, `warm brown dark` |
| Rose Pine | `rose garden dawn`, `soft pink morning`, `pastel flowers` |
| Tokyo Night | `tokyo night city`, `neon blue purple`, `japan neon` |
| Vantablack | `pure black`, `dark void`, `OLED dark` |
| White | `white minimal`, `clean bright`, `gallery wall` |

## Wallpaper Color Grading

Use `scripts/wallpaper-filter.py` to adjust any wallpaper's colors to match your current theme:

```bash
python ~/.claude/skills/omarchy-concierge/scripts/wallpaper-filter.py \
  input.jpg output.jpg --theme <theme-name>
```

See the script's `--help` for all options including `--intensity`, `--tint`, and `--warmth`.
