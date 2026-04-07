#!/usr/bin/env python3
"""
Generate a themed HTML preview page for wallpapers from Wallhaven.

Usage:
    python3 wallpaper-preview.py --ids "id1,id2,id3" --title "My Theme" --open
    python3 wallpaper-preview.py --ids "l3qo2r,8586my" --theme catppuccin --output /tmp/preview.html
"""

import argparse
import subprocess
import sys
from pathlib import Path

# Theme color presets (bg, fg, accent, accent_alt, card_bg)
THEME_COLORS = {
    "catppuccin":      ("#1e1e2e", "#cdd6f4", "#89b4fa", "#cba6f7", "#313244"),
    "tokyo-night":     ("#1a1b26", "#c0caf5", "#7aa2f7", "#bb9af7", "#24283b"),
    "nord":            ("#2e3440", "#eceff4", "#88c0d0", "#81a1c1", "#3b4252"),
    "gruvbox":         ("#282828", "#ebdbb2", "#83a598", "#d3869b", "#3c3836"),
    "hackerman":       ("#0B0C16", "#ddf7ff", "#82FB9C", "#829dd4", "#161a2a"),
    "everforest":      ("#2d353b", "#d3c6aa", "#7fbbb3", "#d699b6", "#374145"),
    "kanagawa":        ("#1f1f28", "#dcd7ba", "#7e9cd8", "#957fb8", "#2a2a37"),
    "matte-black":     ("#121212", "#bebebe", "#e68e0d", "#D35F5F", "#1e1e1e"),
    "ethereal":        ("#060B1E", "#ffcead", "#7d82d9", "#c89dc1", "#101530"),
    "rose-pine":       ("#faf4ed", "#575279", "#56949f", "#907aa9", "#f2e9e1"),
    "ristretto":       ("#2c2525", "#e6d9db", "#f38d70", "#a8a9eb", "#3a3232"),
    "vantablack":      ("#0d0d0d", "#ffffff", "#8d8d8d", "#6e6e6e", "#1a1a1a"),
    "event-horizon":   ("#1c1e26", "#fadad1", "#26bbd9", "#ee64ac", "#2a2d38"),
    "osaka-jade":      ("#111c18", "#C1C497", "#509475", "#D2689C", "#1e2d25"),
    "miasma":          ("#222222", "#c2c2b0", "#78824b", "#bb7744", "#2e2e2e"),
}

DEFAULT_COLORS = ("#1a1b26", "#c0caf5", "#7aa2f7", "#bb9af7", "#24283b")


def generate_html(wallpaper_ids: list[str], title: str, colors: tuple) -> str:
    bg, fg, accent, accent_alt, card_bg = colors

    thumbnails = ""
    for wid in wallpaper_ids:
        prefix = wid[:2]
        thumb_url = f"https://th.wallhaven.cc/lg/{prefix}/{wid}.jpg"
        page_url = f"https://wallhaven.cc/w/{wid}"
        full_url = f"https://w.wallhaven.cc/full/{prefix}/wallhaven-{wid}.jpg"
        thumbnails += f"""
        <div class="card" onclick="window.open('{page_url}', '_blank')">
            <img src="{thumb_url}" alt="{wid}" loading="lazy">
            <div class="card-info">
                <span class="card-id">{wid}</span>
                <a href="{full_url}" target="_blank" class="download-btn" onclick="event.stopPropagation()">⬇ Download</a>
            </div>
        </div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Wallpapers — {title}</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    background: {bg};
    color: {fg};
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    padding: 2rem;
  }}
  h1 {{
    text-align: center;
    margin-bottom: 2rem;
    color: {accent};
    font-size: 1.5rem;
  }}
  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }}
  .card {{
    background: {card_bg};
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
    border: 1px solid {accent}33;
  }}
  .card:hover {{
    transform: translateY(-4px);
    box-shadow: 0 8px 32px {accent}22;
    border-color: {accent}88;
  }}
  .card img {{
    width: 100%;
    height: 200px;
    object-fit: cover;
    display: block;
  }}
  .card-info {{
    padding: 0.75rem 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }}
  .card-id {{
    font-size: 0.85rem;
    color: {fg}aa;
  }}
  .download-btn {{
    color: {accent};
    text-decoration: none;
    font-size: 0.85rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid {accent}66;
    border-radius: 6px;
    transition: all 0.2s;
  }}
  .download-btn:hover {{
    background: {accent}22;
    border-color: {accent};
  }}
  .instructions {{
    text-align: center;
    margin-top: 2rem;
    color: {fg}88;
    font-size: 0.85rem;
  }}
  .instructions code {{
    background: {card_bg};
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    color: {accent_alt};
  }}
</style>
</head>
<body>
<h1>🎨 {title} — Wallpaper Preview</h1>
<div class="grid">
{thumbnails}
</div>
<p class="instructions">
  Click a card to view on Wallhaven · Click ⬇ to download full resolution<br>
  Install with: <code>omarchy-theme-bg-install</code> or save to <code>~/.config/omarchy/backgrounds/&lt;theme&gt;/</code>
</p>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate wallpaper preview page")
    parser.add_argument("--ids", required=True, help="Comma-separated Wallhaven IDs")
    parser.add_argument("--title", default="Theme Wallpapers", help="Page title")
    parser.add_argument("--theme", default=None, help="Color theme for the page")
    parser.add_argument("--output", default="/tmp/omarchy-wallpapers.html", help="Output path")
    parser.add_argument("--open", action="store_true", help="Open in browser after generating")
    args = parser.parse_args()

    ids = [id.strip() for id in args.ids.split(",") if id.strip()]
    colors = THEME_COLORS.get(args.theme, DEFAULT_COLORS) if args.theme else DEFAULT_COLORS

    html = generate_html(ids, args.title, colors)

    output_path = Path(args.output)
    output_path.write_text(html)
    print(f"Preview saved to: {output_path}")

    if args.open:
        subprocess.run(["xdg-open", str(output_path)])


if __name__ == "__main__":
    main()
