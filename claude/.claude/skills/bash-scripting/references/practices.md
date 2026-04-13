# Bash Best Practices — Wooledge Reference

Source: https://mywiki.wooledge.org/BashGuide/Practices

## Choose the Right Tool

Before writing bash, consider whether bash is the right choice:

- **Complex text processing:** Use `awk`, `perl`, or `python`
- **HTML/XML parsing:** Use XPath/XSLT or a proper library
- **JSON processing:** Use `jq` (never parse JSON with sed/grep/awk)
- **Heavy computation:** Use a real programming language
- **Complex data structures:** Bash has arrays and associative arrays, but if you need
  nested structures, use Python/Go/etc.

If bash IS the right tool, decide on the dialect:

- **POSIX sh** — Maximum portability. Use when the script may run on systems without bash
  (containers, embedded, Alpine, busybox). Shebang: `#!/bin/sh`
- **Bash** — Use when you need arrays, `[[ ]]`, process substitution, etc.
  Shebang: `#!/usr/bin/env bash`
- **Never use `#!/bin/bash`** — Not portable. Use `#!/usr/bin/env bash` instead.

**macOS warning:** macOS ships bash 3.2 permanently (GPL licensing). Bash 4+ features
(associative arrays, `mapfile`, `${var,,}`, etc.) will fail on macOS unless users install
a newer bash via Homebrew.

## Quoting Deep-Dive

### The Fundamental Rule

> Double-quote every expansion to prevent word splitting and globbing.

Word splitting applies to: parameter expansion, arithmetic expansion, command substitution.
It does NOT apply to: assignment RHS (`var=$(cmd)` is safe without quotes, but quoting
is still good practice), `[[ ]]` internals.

### When NOT to Quote

1. Inside `(( ))` arithmetic
2. RHS of `[[ =~ ]]` for regex matching
3. RHS of `[[ = ]]` when you WANT glob matching
4. When you intentionally want word splitting (rare — document why)
5. Array index in `${array[index]}`

### Arrays Are the Answer

The only safe way to represent a list of strings in bash is an array:

```bash
# Building a command safely
cmd=(rsync -avz --exclude='*.tmp')
if [[ $verbose = true ]]; then
  cmd+=(--verbose)
fi
cmd+=("$source" "$dest")
"${cmd[@]}"

# Collecting filenames
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find . -name '*.log' -print0)
printf 'Found %d files\n' "${#files[@]}"
```

## Readability Standards

### Indentation
Use 2-space indentation consistently. `shfmt -i 2 -ci` enforces this.

### Naming
- **Variables:** `lower_snake_case` for locals, `UPPER_SNAKE_CASE` for exported/environment
- **Functions:** `lower_snake_case`
- **Constants:** `readonly UPPER_SNAKE_CASE="value"`

### Structure
```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Constants ---
readonly PROGRAM_NAME="${0##*/}"
readonly VERSION="1.0.0"

# --- Functions ---
usage() {
  cat <<EOF
Usage: ${PROGRAM_NAME} [options] <args>

Options:
  -h, --help    Show this help
  -v, --verbose Enable verbose output
EOF
}

die() {
  printf '%s: error: %s\n' "$PROGRAM_NAME" "$1" >&2
  exit "${2:-1}"
}

main() {
  local verbose=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h | --help) usage; exit 0 ;;
      -v | --verbose) verbose=true; shift ;;
      --) shift; break ;;
      -*) die "Unknown option: $1" ;;
      *) break ;;
    esac
  done

  # ... main logic ...
}

main "$@"
```

### Comments
- Comment the *why*, not the *what*
- Add a header comment explaining purpose, usage, and dependencies
- Use `# ---` section dividers for long scripts

## Testing with [[ ]] vs [ ]

### Use [[ ]] in bash scripts

| Feature | `[ ]` (test) | `[[ ]]` (bash) |
|---|---|---|
| Word splitting on vars | Yes (quote!) | No |
| Glob expansion on vars | Yes (quote!) | No |
| `&&` / `\|\|` inside | No (use `-a`/`-o`) | Yes |
| Pattern matching | No | Yes (`=`, `!=`) |
| Regex matching | No | Yes (`=~`) |
| `<` / `>` | Redirection! | String comparison |

### Use (( )) for arithmetic
```bash
if (( count > 10 )); then …
(( total += count ))
for (( i = 0; i < n; i++ )); do …
```

### Use [ ] only in POSIX sh scripts
```bash
# POSIX-safe testing
if [ "$var" = "value" ]; then …
if [ "$num" -gt 10 ]; then …
if [ -f "$file" ] && [ -r "$file" ]; then …
```

## Debugging Techniques

### bash -x (xtrace)
```bash
# Enable for entire script
bash -x script.sh

# Enable for a section
set -x
problematic_code_here
set +x
```

### PS4 for better trace output
```bash
export PS4='+ ${BASH_SOURCE[0]}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -x
```

### Trap DEBUG for step-through
```bash
trap 'read -p "[$BASH_SOURCE:$LINENO] $BASH_COMMAND"' DEBUG
```

### Common debugging patterns
```bash
# Print variable with context
declare -p myvar           # Shows type and value
printf 'var=<%s>\n' "$var" # Shows exact value including whitespace

# Trace function calls
foo() {
  printf >&2 'DEBUG: foo() called with %d args: %s\n' "$#" "$*"
  …
}
```

## Don't Ever Do These

From the Wooledge "Don't Ever Do These" list:

1. **Never parse `ls` output** — Use globs or `find`
2. **Never use `eval` with user input** — Command injection
3. **Never store commands in strings** — Use arrays
4. **Never use backticks** — Use `$(…)` which nests properly
5. **Never use `cat file | cmd`** when `cmd file` or `cmd < file` works (Useless Use of Cat)
6. **Never use `echo` for data** — Use `printf` (echo behavior varies across systems)
7. **Never use `-a`/`-o` with `[`** — Use `&&`/`||` between separate `[` commands
8. **Never use `$[…]`** — Deprecated. Use `$((…))`
9. **Never rely on `IFS` hacks for word splitting** — Use arrays

## Error Handling Patterns

### Trap for cleanup
```bash
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Works even if script exits due to set -e
```

### Strict mode with known workarounds
```bash
set -euo pipefail

# grep returns 1 when no match — handle it
count=$(grep -c pattern file || true)

# Empty array with set -u (bash < 4.4)
"${array[@]+${array[@]}}"    # Safe expansion of potentially empty array

# Pipe with set -o pipefail
if ! output=$(cmd 2>&1); then
  printf 'Command failed: %s\n' "$output" >&2
  exit 1
fi
```

### Function return values
```bash
# Return data via stdout, status via return code
get_config() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  cat "$file"
}

if config=$(get_config /etc/myapp.conf); then
  process "$config"
else
  die "Config not found"
fi
```
