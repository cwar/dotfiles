# Bash Pitfalls — Wooledge Reference

Source: https://mywiki.wooledge.org/BashPitfalls

This is a condensed reference of the 65+ most common bash mistakes. Each entry shows
the wrong pattern and the correct alternative.

## File Iteration

### Don't: `for f in $(ls *.mp3)`
Breaks on whitespace, glob characters, and filenames with newlines. `ls` output is for
humans, not scripts.

**Do:**
```bash
# Non-recursive
for f in ./*.mp3; do
  [[ -e "$f" ]] || continue
  some_command "$f"
done

# Recursive (POSIX)
find . -type f -name '*.mp3' -exec some_command {} +

# Recursive (bash, with NUL delimiter)
while IFS= read -r -d '' file; do
  some_command "$file"
done < <(find . -type f -name '*.mp3' -print0)

# Recursive (bash 4+)
shopt -s globstar nullglob
for f in ./**/*.mp3; do
  some_command "$f"
done
```

## Quoting

### Don't: `cp $file $target`
Breaks on whitespace and glob characters in filenames.

**Do:** `cp -- "$file" "$target"`

The `--` prevents filenames starting with `-` from being interpreted as options.

### Don't: `echo $foo`
Subject to word splitting AND globbing. A variable containing `*.txt` will expand to
matching filenames.

**Do:** `printf '%s\n' "$foo"`

### Don't: `[ $foo = "bar" ]`
If `$foo` is empty, becomes `[ = "bar" ]` which is a syntax error.

**Do:**
```bash
[ "$foo" = bar ]       # POSIX
[[ $foo = bar ]]       # Bash (preferred)
```

### Don't: `[ "$foo" = bar && "$bar" = foo ]`
`&&` breaks the `[` command into two commands.

**Do:**
```bash
[ "$foo" = bar ] && [ "$bar" = foo ]    # POSIX
[[ $foo = bar && $bar = foo ]]          # Bash
```

### Don't: `for arg in $*`
Breaks multi-word arguments.

**Do:** `for arg in "$@"` or simply `for arg`

## Variable Assignment

### Don't: `$foo=bar`
The `$` is not used for assignment. This tries to run the value of `$foo` as a command.

**Do:** `foo=bar`

### Don't: `foo = bar`
Spaces around `=` make bash interpret `foo` as a command with `=` and `bar` as arguments.

**Do:** `foo=bar` (no spaces)

### Don't: `read $foo`
The `$` expands the variable. `read` expects a variable *name*.

**Do:** `read -r foo` (always use `-r` to prevent backslash interpretation)

### Don't: `local var=$(cmd)`
Masks the exit status of `cmd` — `local` always returns 0.

**Do:**
```bash
local var
var=$(cmd)
rc=$?
```

### Don't: `export foo=~/bar`
Tilde expansion is not guaranteed after `=` in `export`.

**Do:**
```bash
foo=~/bar      # Tilde expands here
export foo     # Then export separately
```

## Conditionals

### Don't: `[[ $foo > 7 ]]`
`>` is string comparison in `[[ ]]`, not numeric.

**Do:** `(( foo > 7 ))` for arithmetic.

### Don't: `if [grep foo myfile]`
`[` is not syntax — it's a command. You don't wrap other commands in it.

**Do:** `if grep -q foo myfile; then`

### Don't: `cmd1 && cmd2 || cmd3` as if/then/else
If `cmd2` fails, `cmd3` also runs. This is NOT equivalent to if/then/else.

**Do:**
```bash
if cmd1; then
  cmd2
else
  cmd3
fi
```

## Redirection

### Don't: `somecmd 2>&1 >>logfile`
Redirections are left-to-right. This sends stderr to the current stdout (terminal),
then redirects stdout to logfile. Stderr does NOT go to logfile.

**Do:** `somecmd >>logfile 2>&1`

### Don't: `cat file | sed 's/foo/bar/' > file`
The `> file` truncates the file before `cat` reads it. Data loss!

**Do:**
```bash
sed -i 's/foo/bar/g' file        # GNU sed
sed 's/foo/bar/g' file > tmp && mv tmp file   # Portable
```

### Don't: `echo <<EOF`
`echo` doesn't read stdin. Here-documents redirect to stdin.

**Do:** `cat <<EOF` or use multi-line quoted strings with `printf`.

## Functions

### Don't: `function foo()`
Mixing `function` keyword with `()` is not portable.

**Do:** `foo() { … }` (POSIX compatible)

## Arithmetic

### Don't: `for i in {1..$n}`
Brace expansion happens before variable expansion. This doesn't work.

**Do:**
```bash
for ((i = 1; i <= n; i++)); do    # Bash
  …
done
```

### Don't: Unsanitized input in arithmetic contexts
`(( user_input > 0 ))` is an arbitrary command injection vulnerability!
`a[$(reboot)]` is valid arithmetic syntax.

**Do:** Validate input or use `[ "$var" -gt 0 ]` which only accepts decimal integers.

## Process / Pipeline Issues

### Don't: `grep foo bar | while read -r; do ((count++)); done`
Each pipeline segment runs in a subshell. Changes to `count` don't survive.

**Do:**
```bash
count=0
while IFS= read -r line; do
  ((count++))
done < <(grep foo bar)
# count is now accessible
```

Or use `grep -c foo bar` for counting.

## cd Safety

### Don't: `cd /foo; bar`
If `cd` fails, `bar` runs in the wrong directory (potentially catastrophic with `rm`).

**Do:**
```bash
cd /foo && bar
# Or for multiple commands:
cd /foo || exit 1
bar
baz
```

## set -euo pipefail Caveats

While commonly recommended, each flag has gotchas:

- **`set -e` (errexit):** Does NOT trigger in command lists (`cmd1 && cmd2`), `if` conditions,
  negated commands (`! cmd`), or functions called in these contexts. Behavior varies between
  bash versions. Can cause scripts to silently fail in unexpected places.
- **`set -o pipefail`:** Makes a pipeline return the status of the last failing command.
  Can interact badly with `errexit` — a `grep` that finds nothing (exit 1) in a pipe
  will kill the script.
- **`set -u` (nounset):** `${array[@]}` on an empty array is an error in bash < 4.4.
  `${var:-default}` is the safe alternative.

**Recommendation:** Use `set -euo pipefail` as a starting point, but understand the
edge cases. For critical scripts, prefer explicit error handling over errexit.

## Quick Reference: Quoting Rules

| Context | Quote? | Example |
|---|---|---|
| Variable expansion | **Always** | `"$var"` |
| Command substitution | **Always** | `"$(cmd)"` |
| Array expansion | **Always** | `"${arr[@]}"` |
| `[[ ]]` LHS | Optional (but harmless) | `[[ $var = … ]]` |
| `[[ ]]` RHS for literal match | **Yes** | `[[ $var = "$pattern" ]]` |
| `[[ ]]` RHS for glob match | **No** | `[[ $var = *.txt ]]` |
| Arithmetic `(( ))` | **No** | `(( x + 1 ))` |
| Here-string | **Yes** | `cmd <<< "$var"` |
| `case` patterns | **No** (for globbing) | `case $x in *.txt)` |
