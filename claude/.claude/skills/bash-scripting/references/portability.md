# Cross-Platform Portability Guide

For scripts that must run on both Linux (GNU) and macOS (BSD).

## The Big Picture

| Feature | GNU (Linux) | BSD (macOS) | Safe Alternative |
|---|---|---|---|
| `sed -i` | `sed -i 's/…'` | `sed -i '' 's/…'` | `sed 's/…' f > tmp && mv tmp f` |
| `grep -P` | Perl regex | Not available | `grep -E` (extended regex) |
| `find -printf` | Available | Not available | `find -exec stat` or `awk` |
| `find -regex` type | emacs default | basic default | Avoid `-regex`, use `-name` |
| `sort -V` | Version sort | Not available | Custom sort with `awk`/`python` |
| `xargs -r` | No-run-if-empty | BSD already skips | Omit `-r` or guard with `if` |
| `date -d` | Parse date string | Not available | `date -j -f` on BSD, or `python` |
| `realpath` | Available | Not always | `cd "$(dirname "$f")" && pwd` |
| `readarray` | bash 4+ | bash 3.2 (no) | `while IFS= read -r` loop |
| `mktemp` | `mktemp -d` | Same | Both work, but avoid `-t` template differences |
| `stat` format | `stat -c '%s'` | `stat -f '%z'` | Use `wc -c < file` for size |
| `cp -T` | No-target-dir | Not available | Restructure command |
| `tar` auto-detect | `tar xf` works | May need `tar xzf` | Always specify compression flag |
| `echo -e` | Interprets escapes | May not | `printf '%b\n' "…"` |

## sed Portability

The biggest cross-platform headache. Strategies:

```bash
# In-place edit (AVOID if possible)
# GNU: sed -i 's/old/new/' file
# BSD: sed -i '' 's/old/new/' file

# Portable in-place edit
sed 's/old/new/' "$file" > "$file.tmp" && mv "$file.tmp" "$file"

# If you must detect:
if sed --version 2>/dev/null | grep -q GNU; then
  sed -i 's/old/new/' "$file"
else
  sed -i '' 's/old/new/' "$file"
fi
```

## date Portability

```bash
# Get epoch timestamp
# GNU: date +%s              (works)
# BSD: date +%s              (works)
# Both work for current time!

# Parse a date string — THIS is where it diverges
# GNU: date -d '2024-01-15' +%s
# BSD: date -j -f '%Y-%m-%d' '2024-01-15' +%s

# Portable: use python
epoch=$(python3 -c "import datetime; print(int(datetime.datetime(2024,1,15).timestamp()))")

# Date arithmetic
# GNU: date -d '+7 days' +%Y-%m-%d
# BSD: date -v+7d +%Y-%m-%d
# Portable: use python or calculate with epoch math
```

## Bash Version Features

### Safe everywhere (bash 3.2+, i.e., macOS default)
- Indexed arrays: `arr=(a b c)`, `${arr[@]}`, `${#arr[@]}`
- `[[ ]]` conditionals
- `$(( ))` arithmetic
- `$(command)` substitution
- Process substitution: `<(cmd)`, `>(cmd)`
- Here-strings: `<<< "string"`
- Extended globbing with `shopt -s extglob`
- `printf` builtin
- `read -r`, `read -p`, `read -a` (into array)
- `${var%pattern}`, `${var#pattern}`, `${var/old/new}`

### Requires bash 4.0+
- Associative arrays: `declare -A`
- `**` globstar: `shopt -s globstar`
- `mapfile` / `readarray`
- `coproc`

### Requires bash 4.2+
- `declare -g` (global from function)
- Negative array indexing: `${arr[-1]}`
- `lastpipe` option (last pipe element in current shell)

### Requires bash 4.3+
- Namerefs: `declare -n ref=var`
- `[[ -v var ]]` (test if variable is set)

### Requires bash 4.4+
- `${var@Q}` (quoted), `${var@a}` (attributes)
- `mapfile -d` (delimiter)
- Empty array is safe with `set -u`

### Requires bash 5.0+
- `EPOCHSECONDS`, `EPOCHREALTIME`
- `BASH_ARGV0`
- `wait -p` (store PID)

## POSIX sh Compatibility

When writing `#!/bin/sh` scripts, avoid ALL of the above. Also:

- No `[[ ]]` — use `[ ]` with quotes
- No `(( ))` — use `[ "$x" -gt 0 ]`
- No arrays — use positional parameters or `set --`
- No `local` — it's common but technically not POSIX
- No `source` — use `.` (dot)
- No `function` keyword — use `name() { … }`
- No `<<<` here-strings — use `echo "$var" | cmd`
- No `<()` process substitution — use temp files or pipes
- No `${var,,}` case conversion — use `tr '[:upper:]' '[:lower:]'`
- No `read -p` prompt — use `printf` then `read`

## Filesystem Case Sensitivity

**Critical cross-platform pitfall:**

- Linux: case-**sensitive** (default)
- macOS: case-**insensitive** (APFS/HFS+ default)

Consequences:
- `Config.js` and `config.js` can coexist on Linux but collide on macOS
- Case-only renames don't register in git on macOS: use `git mv -f`
- Import paths with wrong casing work on macOS but break on Linux CI

**Rule:** Always treat filenames as case-sensitive. Never rely on case to distinguish files.

## Docker Considerations

When scripts run in Docker containers:

- **Volume mounts** are dramatically slower on macOS
- **File watching** (`inotify` vs `fsevents`) — watchers inside containers may not detect
  host file changes on macOS. Use polling mode.
- **Networking** — `host.docker.internal` works on macOS Docker Desktop but not always on
  Linux. Use environment variables, not hardcoded hostnames.
