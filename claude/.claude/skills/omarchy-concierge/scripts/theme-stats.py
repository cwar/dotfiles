#!/usr/bin/env python3
"""
Omarchy Concierge — Theme Usage Statistics

Analyzes theme-history.jsonl to show usage patterns, time per theme,
switching frequency, and more.

Usage:
    python3 theme-stats.py                    # All-time stats
    python3 theme-stats.py --since 2025-01-01 # Since a date
    python3 theme-stats.py --last 30d         # Last 30 days
    python3 theme-stats.py --json             # Machine-readable output
"""

import json
import sys
import os
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from pathlib import Path
import argparse


HISTORY_FILE = Path.home() / ".local/share/omarchy-concierge/theme-history.jsonl"
CURRENT_THEME_FILE = Path.home() / ".config/omarchy/current/theme.name"


def parse_timestamp(ts: str) -> datetime:
    """Parse ISO 8601 timestamp, handling various formats."""
    # Try parsing with timezone
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
    ]:
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            continue
    # Handle +HH:MM format (Python 3.6 compat)
    if "+" in ts or ts.count("-") > 2:
        ts_clean = ts.rsplit("+", 1)[0].rsplit("-", 1)[0]
        try:
            return datetime.strptime(ts_clean, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            pass
    raise ValueError(f"Cannot parse timestamp: {ts}")


def load_history(since: datetime = None) -> list[dict]:
    """Load theme history entries, optionally filtered by date."""
    if not HISTORY_FILE.exists():
        return []

    entries = []
    with open(HISTORY_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entry["_ts"] = parse_timestamp(entry["timestamp"])
                if since and entry["_ts"].replace(tzinfo=None) < since.replace(tzinfo=None):
                    continue
                entries.append(entry)
            except (json.JSONDecodeError, ValueError, KeyError):
                continue

    return sorted(entries, key=lambda e: e["_ts"])


def format_duration(td: timedelta) -> str:
    """Format a timedelta as a human-readable string."""
    total_seconds = int(td.total_seconds())
    if total_seconds < 0:
        return "0s"

    days = total_seconds // 86400
    hours = (total_seconds % 86400) // 3600
    minutes = (total_seconds % 3600) // 60

    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0:
        parts.append(f"{minutes}m")

    return " ".join(parts) if parts else "<1m"


def calculate_stats(entries: list[dict]) -> dict:
    """Calculate all theme usage statistics."""
    if not entries:
        return {"error": "No theme history data found."}

    now = datetime.now().astimezone()

    # Calculate time per theme
    time_per_theme = defaultdict(timedelta)
    switch_count = 0
    switch_hours = defaultdict(int)
    theme_journey = []

    for i, entry in enumerate(entries):
        theme = entry["theme"]
        ts = entry["_ts"]

        # Duration = time until next switch (or until now for last entry)
        if i + 1 < len(entries):
            duration = entries[i + 1]["_ts"] - ts
        else:
            duration = now - ts

        # Only count positive durations
        if duration.total_seconds() > 0:
            time_per_theme[theme] += duration

        if i > 0:
            switch_count += 1
            switch_hours[ts.hour] += 1

        theme_journey.append({
            "theme": theme,
            "timestamp": entry["timestamp"],
            "duration": format_duration(duration),
        })

    # Sort themes by usage
    sorted_themes = sorted(time_per_theme.items(), key=lambda x: x[1], reverse=True)
    total_time = sum(time_per_theme.values(), timedelta())

    # Current theme
    current_theme = entries[-1]["theme"] if entries else "unknown"
    try:
        current_theme = CURRENT_THEME_FILE.read_text().strip()
    except FileNotFoundError:
        pass

    current_streak = now - entries[-1]["_ts"] if entries else timedelta()

    # Time range
    first_entry = entries[0]["_ts"]
    tracking_duration = now - first_entry

    # Switch frequency
    tracking_days = max(tracking_duration.days, 1)
    switches_per_week = (switch_count / tracking_days) * 7
    switches_per_month = (switch_count / tracking_days) * 30

    # Peak hours
    peak_hours_sorted = sorted(switch_hours.items(), key=lambda x: x[1], reverse=True)

    return {
        "current_theme": current_theme,
        "current_streak": format_duration(current_streak),
        "tracking_since": first_entry.strftime("%Y-%m-%d"),
        "tracking_duration": format_duration(tracking_duration),
        "total_switches": switch_count,
        "unique_themes": len(time_per_theme),
        "switches_per_week": round(switches_per_week, 1),
        "switches_per_month": round(switches_per_month, 1),
        "time_per_theme": [
            {
                "theme": theme,
                "duration": format_duration(duration),
                "percentage": round(duration / total_time * 100, 1) if total_time else 0,
            }
            for theme, duration in sorted_themes
        ],
        "peak_switching_hours": [
            {"hour": f"{h:02d}:00", "count": c}
            for h, c in peak_hours_sorted[:5]
        ],
        "recent_journey": theme_journey[-10:],
    }


def print_stats(stats: dict):
    """Print stats in a human-friendly format."""
    if "error" in stats:
        print(f"\n  {stats['error']}")
        print(f"  Run: bash ~/.claude/skills/omarchy-concierge/scripts/setup-metrics.sh")
        return

    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║        🎨  Omarchy Theme Statistics          ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()

    # Current theme
    print(f"  Current theme:   {stats['current_theme']}")
    print(f"  Current streak:  {stats['current_streak']}")
    print(f"  Tracking since:  {stats['tracking_since']} ({stats['tracking_duration']})")
    print()

    # Usage overview
    print(f"  Total switches:     {stats['total_switches']}")
    print(f"  Unique themes used: {stats['unique_themes']}")
    print(f"  Switches/week:      {stats['switches_per_week']}")
    print(f"  Switches/month:     {stats['switches_per_month']}")
    print()

    # Time per theme
    print("  ─── Time Per Theme ───────────────────────────")
    print()
    max_name_len = max(len(t["theme"]) for t in stats["time_per_theme"])
    for entry in stats["time_per_theme"]:
        name = entry["theme"].ljust(max_name_len)
        dur = entry["duration"].rjust(12)
        pct = entry["percentage"]
        bar_len = int(pct / 100 * 30)
        bar = "█" * bar_len + "░" * (30 - bar_len)
        indicator = " ◀ current" if entry["theme"] == stats["current_theme"] else ""
        print(f"  {name}  {dur}  {pct:5.1f}%  {bar}{indicator}")
    print()

    # Peak hours
    if stats["peak_switching_hours"]:
        print("  ─── Peak Switching Hours ─────────────────────")
        print()
        for entry in stats["peak_switching_hours"]:
            print(f"    {entry['hour']}  {'▓' * entry['count']} ({entry['count']})")
        print()

    # Recent journey
    print("  ─── Recent Theme Journey ─────────────────────")
    print()
    for entry in stats["recent_journey"]:
        ts = entry["timestamp"][:16].replace("T", " ")
        print(f"    {ts}  →  {entry['theme']}  ({entry['duration']})")
    print()


def main():
    parser = argparse.ArgumentParser(description="Omarchy theme usage statistics")
    parser.add_argument("--since", help="Show stats since date (YYYY-MM-DD)")
    parser.add_argument("--last", help="Show stats for last N days (e.g., 30d, 7d)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    since = None
    if args.since:
        since = datetime.strptime(args.since, "%Y-%m-%d")
    elif args.last:
        days = int(args.last.rstrip("d"))
        since = datetime.now() - timedelta(days=days)

    entries = load_history(since=since)
    stats = calculate_stats(entries)

    if args.json:
        print(json.dumps(stats, indent=2))
    else:
        print_stats(stats)


if __name__ == "__main__":
    main()
