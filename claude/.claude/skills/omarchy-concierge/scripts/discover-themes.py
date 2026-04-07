#!/usr/bin/env python3
"""
Discover and install Omarchy community themes from GitHub.

Interactive mode (default): browse themes with fzf, hit Enter to install.
Non-interactive mode: print results to stdout.

Usage:
    python3 discover-themes.py                 # Interactive picker
    python3 discover-themes.py --sort updated  # Sort by recently updated
    python3 discover-themes.py --print         # Non-interactive list
    python3 discover-themes.py --json          # Machine-readable output
    python3 discover-themes.py --multi         # Select multiple themes to install
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.parse
from pathlib import Path
import argparse


STOCK_THEMES_DIR = Path.home() / ".local/share/omarchy/themes"
USER_THEMES_DIR = Path.home() / ".config/omarchy/themes"
GITHUB_API = "https://api.github.com/search/repositories"


def get_installed_themes() -> set[str]:
    """Get names of all installed themes (stock + user)."""
    themes = set()
    for themes_dir in [STOCK_THEMES_DIR, USER_THEMES_DIR]:
        if themes_dir.exists():
            for d in themes_dir.iterdir():
                if d.is_dir() or d.is_symlink():
                    themes.add(d.name.lower())
    return themes


def search_github(query: str = "omarchy theme", sort: str = "stars",
                  per_page: int = 50) -> list[dict]:
    """Search GitHub for omarchy theme repos."""
    encoded_query = urllib.parse.quote(query)
    url = f"{GITHUB_API}?q={encoded_query}&sort={sort}&per_page={per_page}"

    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github.v3+json")
    req.add_header("User-Agent", "omarchy-concierge")

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"token {token}")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            return data.get("items", [])
    except Exception as e:
        print(f"Error searching GitHub: {e}", file=sys.stderr)
        return []


def extract_theme_name(repo: dict) -> str:
    """Extract the likely theme name from a repo."""
    name = repo["name"]
    for prefix in ["omarchy-", "omarchy_"]:
        if name.startswith(prefix):
            name = name[len(prefix):]
    for suffix in ["-theme", "_theme"]:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return name.lower()


def is_likely_theme(repo: dict) -> bool:
    """Filter out non-theme repos from search results."""
    name = repo["full_name"].lower()
    desc = (repo.get("description") or "").lower()

    theme_indicators = ["theme", "rice", "dotfile", "colorscheme"]
    omarchy_indicators = ["omarchy"]

    has_theme = any(kw in name or kw in desc for kw in theme_indicators)
    has_omarchy = any(kw in name or kw in desc for kw in omarchy_indicators)

    exclude = ["awesome-omarchy", "aether", "tema", "peachy", "theme-builder",
               "waybar-themes", "theme-hook", "tmux", "powerkit", "omazed"]
    is_excluded = any(ex in repo["name"].lower() for ex in exclude)

    return has_theme and has_omarchy and not is_excluded


def discover(sort: str = "stars") -> dict:
    """Find themes that aren't installed yet."""
    installed = get_installed_themes()
    repos = search_github(sort=sort)

    new_themes = []
    installed_themes = []

    for repo in repos:
        if not is_likely_theme(repo):
            continue

        theme_name = extract_theme_name(repo)
        is_installed = theme_name in installed

        info = {
            "name": theme_name,
            "repo": repo["full_name"],
            "url": repo["clone_url"],
            "html_url": repo["html_url"],
            "stars": repo["stargazers_count"],
            "description": repo.get("description") or "",
            "updated": repo["updated_at"][:10],
            "created": repo["created_at"][:10],
            "installed": is_installed,
        }

        if is_installed:
            installed_themes.append(info)
        else:
            new_themes.append(info)

    return {
        "new_themes": new_themes,
        "installed_themes": installed_themes,
        "total_found": len(new_themes) + len(installed_themes),
        "installed_count": len(installed_themes),
        "new_count": len(new_themes),
    }


# ── Interactive mode ──────────────────────────────────────────────────────────

def write_preview_script(themes: list[dict], path: Path):
    """Write a bash script that fzf --preview will call to show theme details."""
    # Build a lookup from the display line prefix (theme name) → detail block
    lookup = {}
    for t in themes:
        detail = (
            f"\033[1;36m{t['name']}\033[0m\n"
            f"\n"
            f"  \033[33m★ {t['stars']}\033[0m stars\n"
            f"  \033[90mupdated {t['updated']}\033[0m\n"
            f"\n"
            f"  {t['description']}\n"
            f"\n"
            f"  \033[90mrepo:\033[0m {t['repo']}\n"
            f"  \033[90murl:\033[0m  {t['url']}\n"
        )
        if t["installed"]:
            detail += f"\n  \033[32m✓ Already installed\033[0m\n"
        lookup[t["name"]] = detail

    # Write as a bash case statement for speed
    script = "#!/bin/bash\n"
    script += "# Auto-generated preview script for fzf\n"
    script += 'KEY=$(echo "$1" | sed "s/^[✓ ]* //" | awk \'{print $1}\')\n'
    script += 'case "$KEY" in\n'
    for name, detail in lookup.items():
        # Escape single quotes in detail for bash
        escaped = detail.replace("'", "'\\''")
        script += f"  '{name}') echo -e '{escaped}' ;;\n"
    script += "  *) echo \"No details available\" ;;\n"
    script += "esac\n"

    path.write_text(script)
    path.chmod(0o755)


def format_fzf_line(theme: dict) -> str:
    """Format a single theme as an fzf line: padded columns for alignment."""
    prefix = "  ✓" if theme["installed"] else "   "
    name = theme["name"]
    stars = f"★{theme['stars']}"
    desc = theme["description"][:60]
    return f"{prefix} {name:<25} {stars:>6}  {desc}"


def parse_theme_name(fzf_line: str) -> str:
    """Extract the theme name from an fzf output line.

    Lines look like:  '   retro-fallout              ★66  Retro Fallout...'
    or:               '  ✓ miasma                     ★54  A Miasma Color...'

    The name is always the first real word after optional whitespace/checkmark.
    """
    stripped = fzf_line.strip().lstrip("✓").strip()
    return stripped.split()[0] if stripped else ""


def run_interactive(results: dict, multi: bool = False):
    """Launch fzf with theme list, install on selection."""
    all_themes = results["new_themes"] + results["installed_themes"]
    if not all_themes:
        print("No themes found.")
        return

    # Name-based lookup (robust against fzf whitespace changes)
    name_to_theme = {t["name"]: t for t in all_themes}
    lines = [format_fzf_line(t) for t in all_themes]

    # Write preview script to temp file
    tmpdir = Path(tempfile.mkdtemp(prefix="omarchy-discover-"))
    preview_script = tmpdir / "preview.sh"
    write_preview_script(all_themes, preview_script)

    # Header text
    new_count = results["new_count"]
    installed_count = results["installed_count"]
    header = f"  🔍 {new_count} new · {installed_count} installed · Enter to install · Esc to quit"
    if multi:
        header += " · Tab to multi-select"

    fzf_args = [
        "fzf",
        "--ansi",
        "--header", header,
        "--header-first",
        "--preview", f"{preview_script} {{}}",
        "--preview-window", "right:45%:wrap",
        "--prompt", "  theme ❯ ",
        "--pointer", "▶",
        "--marker", "●",
        "--color", "bg+:#313244,fg+:#cdd6f4,hl:#f38ba8,hl+:#f38ba8,"
                   "info:#89b4fa,prompt:#89b4fa,pointer:#f5c2e7,"
                   "marker:#a6e3a1,header:#89b4fa,border:#585b70",
        "--border", "rounded",
        "--border-label", " 🎨 Omarchy Theme Discovery ",
        "--margin", "1,2",
        "--padding", "1,0",
        "--no-scrollbar",
        "--reverse",
    ]
    if multi:
        fzf_args.append("--multi")

    try:
        proc = subprocess.run(
            fzf_args,
            input="\n".join(lines),
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        print("fzf not found — falling back to non-interactive mode", file=sys.stderr)
        print_results(results)
        return
    finally:
        # Clean up temp files
        shutil.rmtree(tmpdir, ignore_errors=True)

    if proc.returncode != 0:
        # User pressed Esc / Ctrl-C
        return

    # Parse theme names from selected lines (robust against whitespace drift)
    selected_themes = []
    for line in proc.stdout.strip().split("\n"):
        if not line.strip():
            continue
        name = parse_theme_name(line)
        if name in name_to_theme:
            selected_themes.append(name_to_theme[name])

    if not selected_themes:
        return

    install_selected(selected_themes)


def install_selected(themes: list[dict]):
    """Prompt and install selected themes."""
    # Separate new vs already installed
    to_install = [t for t in themes if not t["installed"]]
    already = [t for t in themes if t["installed"]]

    if already:
        names = ", ".join(t["name"] for t in already)
        print(f"\n  ✓ Already installed: {names}")

    if not to_install:
        print("  Nothing new to install.")
        return

    # Confirm with gum if available, otherwise plain prompt
    names = ", ".join(t["name"] for t in to_install)
    print(f"\n  📦 Install {len(to_install)} theme(s): {names}")

    if shutil.which("gum"):
        result = subprocess.run(
            ["gum", "confirm", f"Install {len(to_install)} theme(s)?"],
            capture_output=False,
        )
        confirmed = result.returncode == 0
    else:
        answer = input("\n  Proceed? [Y/n] ").strip().lower()
        confirmed = answer in ("", "y", "yes")

    if not confirmed:
        print("  Cancelled.")
        return

    for t in to_install:
        print(f"\n  ⏳ Installing {t['name']}...")
        result = subprocess.run(
            ["omarchy-theme-install", t["url"]],
            capture_output=False,
        )
        if result.returncode == 0:
            print(f"  ✅ {t['name']} installed and applied!")
        else:
            print(f"  ❌ Failed to install {t['name']}")


# ── Non-interactive mode ──────────────────────────────────────────────────────

def print_results(results: dict):
    """Print discovery results in a human-friendly format."""
    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║     🔍  Omarchy Theme Discovery              ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()

    print(f"  Found {results['total_found']} themes total "
          f"({results['installed_count']} installed, {results['new_count']} new)")
    print()

    if results["new_themes"]:
        print("  ─── New Themes (Not Installed) ───────────────")
        print()
        for t in results["new_themes"]:
            stars = f"★{t['stars']}"
            print(f"  {t['name']:<25} {stars:>6}  {t['description'][:55]}")
            print(f"  {'':25} {'':>6}  install: omarchy-theme-install {t['url']}")
            print()

    if results["installed_themes"]:
        print("  ─── Already Installed ────────────────────────")
        print()
        for t in results["installed_themes"]:
            stars = f"★{t['stars']}"
            updated = t['updated']
            print(f"  ✓ {t['name']:<23} {stars:>6}  updated: {updated}")
        print()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Discover and install Omarchy themes")
    parser.add_argument("--sort", choices=["stars", "updated"], default="stars",
                        help="Sort by popularity or recency (default: stars)")
    parser.add_argument("--print", action="store_true", dest="print_mode",
                        help="Non-interactive: just print the list")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON (non-interactive)")
    parser.add_argument("--multi", action="store_true",
                        help="Allow selecting multiple themes at once (Tab to toggle)")
    args = parser.parse_args()

    # Show a spinner while fetching
    is_interactive = not args.print_mode and not args.json and sys.stdout.isatty()

    if is_interactive and shutil.which("gum"):
        # Use gum spin for a nice loading indicator
        print()
        proc = subprocess.Popen(
            ["gum", "spin", "--spinner", "dot", "--title",
             "  Searching GitHub for Omarchy themes...", "--",
             "sleep", "0"],
            stdout=subprocess.DEVNULL,
        )
        results = discover(sort=args.sort)
        proc.terminate()
        proc.wait()
    else:
        if is_interactive:
            print("  Searching GitHub for Omarchy themes...", end="\r")
        results = discover(sort=args.sort)
        if is_interactive:
            print(" " * 50, end="\r")  # Clear the line

    if args.json:
        print(json.dumps(results, indent=2))
    elif args.print_mode or not sys.stdout.isatty():
        print_results(results)
    else:
        run_interactive(results, multi=args.multi)


if __name__ == "__main__":
    main()
