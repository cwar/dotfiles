---
name: bash-scripting
description: >
  This skill should be used when the user asks to "write a bash script", "create a shell script",
  "fix a bash script", "debug a shell script", "write a function in bash", "automate with bash",
  or when creating, editing, or reviewing any .sh file or shell script. Also triggers on mentions of
  "shellcheck", "shfmt", "POSIX sh", "bash best practices", "safe scripting", "quoting in bash",
  or "bash pitfalls". Provides Wooledge-grade bash scripting guidance with automatic shellcheck
  and shfmt validation.
version: 1.0.0
---

# Bash Scripting — Wooledge-Grade Best Practices

## Purpose

Produce safe, correct, portable bash scripts by applying best practices from the Wooledge BashGuide,
BashFAQ, and BashPitfalls. Every script written or edited is validated with `shellcheck` and
formatted with `shfmt`.

## Core Workflow

When writing or editing any bash script:

1. **Write the script** following the rules below
2. **Run shellcheck** on the file: `shellcheck -x -S warning "$file"`
3. **Run shfmt** to check formatting: `shfmt -d -i 2 -ci "$file"`
4. **Fix all issues** before considering the script complete
5. For shared repos, also verify **POSIX compatibility** (see Portability section)

If shellcheck or shfmt are not installed, install them:
- Homebrew: `brew install shellcheck shfmt`
- Arch: `pacman -S shellcheck shfmt`

## The Cardinal Rules

### 1. Quote Everything

Double-quote every parameter expansion, command substitution, and array expansion unless
there is a specific, documented reason not to.

```bash
# WRONG
cp $file $target
echo $foo
for f in $(ls *.mp3); do

# RIGHT
cp -- "$file" "$target"
echo "$foo"
for f in ./*.mp3; do
```

The only safe way to print a variable is `printf '%s\n' "$foo"` — `echo "$foo"` fails
if the value is `-n`, `-e`, etc.

### 2. Use Arrays for Lists

Never store lists in strings. Use arrays.

```bash
# WRONG
files=$(ls)
files="file1 file2 file3"

# RIGHT
files=(./*.txt)
args=("--verbose" "--output" "$dir/file")
cmd=("rsync" "-avz" "${args[@]}" "$src" "$dst")
"${cmd[@]}"
```

Always expand arrays with `"${array[@]}"` (double-quoted, @ index).

### 3. Never Parse ls

Use globs for non-recursive listing, `find` with `-print0` / `read -r -d ''` for recursive.

```bash
# Non-recursive
for f in ./*.mp3; do
  [[ -e "$f" ]] || continue
  process "$f"
done

# Recursive (bash 4+)
shopt -s globstar nullglob
for f in ./**/*.mp3; do
  process "$f"
done

# Recursive (POSIX)
find . -type f -name '*.mp3' -exec process {} +
```

### 4. Use [[ ]] Over [ ]

In bash scripts, prefer `[[ ]]` for conditionals — it prevents word splitting,
supports globs and regex, and avoids redirection pitfalls with `<` and `>`.

```bash
# WRONG (in bash)
[ $var = "foo" ]       # word splitting if var is empty
[ "$a" = bar -a "$b" = foo ]  # -a is obsolescent

# RIGHT
[[ $var = "foo" ]]
[[ $a = bar && $b = foo ]]
```

Use `[ ]` only in POSIX sh scripts. Use `(( ))` for arithmetic comparisons.

### 5. Use Modern Syntax

```bash
# Use $(…) not backticks
dir=$(dirname -- "$path")   # RIGHT
dir=`dirname "$path"`       # WRONG

# Use $(( )) not expr
x=$((x + 1))               # RIGHT
x=$(expr "$x" + 1)         # WRONG

# Use ${var%.*} not sed for simple string ops
base=${filename%.*}         # RIGHT
base=$(echo "$filename" | sed 's/\.[^.]*$//')  # WRONG
```

### 6. Handle Errors

```bash
#!/usr/bin/env bash
set -euo pipefail

# Check cd success
cd "$dir" || exit 1

# Don't mask exit status with local
local var
var=$(some_command)

# Trap for cleanup
cleanup() { rm -f "$tmpfile"; }
trap cleanup EXIT
tmpfile=$(mktemp)
```

**Caution with `set -e`:** It has many subtle edge cases. Consult
`references/practices.md` for details. When in doubt, use explicit error handling
(`|| exit 1`, `|| return 1`) rather than relying on errexit.

### 7. Script Header Template

```bash
#!/usr/bin/env bash
set -euo pipefail

# Description of what this script does
# Usage: script.sh [options] <args>
```

Use `#!/usr/bin/env bash` for bash scripts. Use `#!/bin/sh` only for true POSIX scripts.

## Portability Rules (Shared Repos)

When scripts will run on macOS (which ships bash 3.2), avoid:

- Associative arrays (`declare -A`) — bash 4+ only
- `${var,,}` / `${var^^}` — bash 4+ only
- `readarray` / `mapfile` — bash 4+ only
- `|&` pipe stderr — bash 4+ only
- `grep -P` — GNU only, use `grep -E`
- `sed -i` without `''` arg — differs between GNU and BSD
- `find -printf` — GNU only
- `sort -V` — GNU only
- `xargs -r` — GNU only
- `date -d` — GNU only (BSD uses `date -j -f`)
- `realpath` — not available on all systems

Consult `references/portability.md` for safe alternatives.

## Common Anti-Patterns to Catch

When reviewing bash code, flag these immediately:

| Anti-Pattern | Fix |
|---|---|
| `for f in $(ls)` | `for f in ./*` |
| `cat file \| grep` | `grep pattern file` |
| Unquoted `$var` | `"$var"` |
| `[ $x = y ]` | `[[ $x = y ]]` |
| `echo $var` | `printf '%s\n' "$var"` |
| `cmd1 && cmd2 \|\| cmd3` | `if/then/else/fi` |
| `function foo()` | `foo()` |
| `$foo=bar` or `foo = bar` | `foo=bar` |
| `read $var` | `read var` (no $) |
| `cd /foo; bar` | `cd /foo && bar` |

## Validation Script

After writing any bash script, run validation:

```bash
bash "${SKILL_DIR}/scripts/validate-bash.sh" "$filepath"
```

This runs shellcheck and shfmt, reporting all issues. Fix everything before completion.

## Additional Resources

### Reference Files

For detailed patterns and deep knowledge, consult:

- **`references/pitfalls.md`** — 65+ common bash mistakes from Wooledge BashPitfalls with correct alternatives
- **`references/practices.md`** — Wooledge BashGuide best practices: quoting, readability, testing, debugging
- **`references/portability.md`** — Cross-platform compatibility guide for macOS/Linux scripts
- **`references/faq-patterns.md`** — Solutions to common "How do I…?" bash questions from Wooledge BashFAQ

### Validation Script

- **`scripts/validate-bash.sh`** — Runs shellcheck + shfmt on a script file, reports all issues

### External References

- [Wooledge BashGuide](https://mywiki.wooledge.org/BashGuide)
- [Wooledge BashPitfalls](https://mywiki.wooledge.org/BashPitfalls)
- [Wooledge BashFAQ](https://mywiki.wooledge.org/BashFAQ)
- [ShellCheck Wiki](https://www.shellcheck.net/wiki/)
- `man bash` — always the canonical reference for the installed version
