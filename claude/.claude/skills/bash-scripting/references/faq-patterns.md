# Bash FAQ Patterns — Wooledge Reference

Common "How do I…?" solutions from https://mywiki.wooledge.org/BashFAQ

## Reading Files

### Read a file line by line
```bash
while IFS= read -r line; do
  printf '%s\n' "$line"
done < "$file"
```
- `IFS=` prevents stripping leading/trailing whitespace
- `-r` prevents backslash interpretation
- Never use `for line in $(cat file)` — breaks on whitespace and globs

### Read a file into an array
```bash
# Bash 4+
mapfile -t lines < "$file"

# Bash 3.2+
lines=()
while IFS= read -r line; do
  lines+=("$line")
done < "$file"
```

### Read NUL-delimited data (safe for filenames)
```bash
while IFS= read -r -d '' item; do
  printf 'File: %s\n' "$item"
done < <(find . -type f -print0)
```

## String Operations

### Check if string contains substring
```bash
# Bash
[[ $string = *"$substring"* ]]

# POSIX
case "$string" in
  *"$substring"*) echo "found" ;;
esac
```

### Check if string matches regex
```bash
if [[ $string =~ ^[0-9]+$ ]]; then
  echo "All digits"
fi
```
Note: Do NOT quote the regex pattern on the RHS of `=~`.

### Trim whitespace
```bash
# Leading
trimmed="${var#"${var%%[![:space:]]*}"}"
# Trailing
trimmed="${var%"${var##*[![:space:]]}"}"

# Or just use parameter expansion for known patterns
var="  hello  "
var="${var#"${var%%[![:space:]]*}"}"   # Remove leading
var="${var%"${var##*[![:space:]]}"}"   # Remove trailing
```

### Split string into array
```bash
IFS=',' read -ra parts <<< "$csv_line"
# Note: this strips trailing empty fields. For proper CSV, use a real parser.
```

### Extract filename / extension / directory
```bash
path="/home/user/documents/report.final.txt"

filename="${path##*/}"          # report.final.txt
directory="${path%/*}"          # /home/user/documents
extension="${filename##*.}"     # txt
basename="${filename%.*}"       # report.final
all_extensions="${filename#*.}" # final.txt
stem="${filename%%.*}"          # report
```

## Process Management

### Run commands in parallel with limit
```bash
max_jobs=4
for item in "${items[@]}"; do
  process "$item" &
  # Wait if we've hit the job limit
  while (( $(jobs -r | wc -l) >= max_jobs )); do
    sleep 0.1
  done
done
wait  # Wait for all remaining jobs
```

### Capture both stdout and stderr
```bash
# Capture stdout, let stderr through
output=$(cmd)

# Capture both
output=$(cmd 2>&1)

# Capture separately
{ output=$(cmd 2>&1 1>&3-); } 3>&1
# $output has stderr, stdout went to terminal

# Simplest: use temp files
stdout_file=$(mktemp)
stderr_file=$(mktemp)
cmd >"$stdout_file" 2>"$stderr_file"
status=$?
```

### Get exit status of a pipe stage
```bash
set -o pipefail
cmd1 | cmd2 | cmd3
status=$?  # Status of first failing command

# Or check individual stages
cmd1 | cmd2 | cmd3
printf 'Statuses: %s\n' "${PIPESTATUS[*]}"
```

## Input Handling

### Parse command-line arguments
```bash
verbose=false
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v | --verbose)
      verbose=true
      shift
      ;;
    -o | --output)
      output="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done
# Remaining args in "$@"
```

### Read user input with default
```bash
read -rp "Enter name [default]: " name
name="${name:-default}"
```

### Read password (no echo)
```bash
read -rsp "Password: " password
printf '\n'
```

## File Operations

### Create a temp file safely
```bash
tmpfile=$(mktemp) || exit 1
trap 'rm -f "$tmpfile"' EXIT
```

### Check if file descriptor is a terminal
```bash
if [[ -t 1 ]]; then
  echo "stdout is a terminal"
else
  echo "stdout is piped/redirected"
fi
```

### Atomic file write (safe update)
```bash
# Write to temp in same directory, then atomic rename
tmpfile="${target}.tmp.$$"
generate_content > "$tmpfile" && mv "$tmpfile" "$target"
```

### Lock file for mutual exclusion
```bash
lockfile="/tmp/myscript.lock"
exec 9>"$lockfile"
if ! flock -n 9; then
  die "Another instance is running"
fi
# Lock is released when fd 9 is closed (script exit)
```

## Data Processing

### Calculate with floating point
```bash
# Bash has no native floating point. Use bc or awk:
result=$(echo "scale=2; 22/7" | bc)
result=$(awk 'BEGIN { printf "%.2f", 22/7 }')
```

### Process CSV
```bash
# Simple (no quoted fields with commas)
while IFS=',' read -ra fields; do
  printf 'Name: %s, Age: %s\n' "${fields[0]}" "${fields[1]}"
done < data.csv

# For real CSV with quoted fields, use a proper tool:
# python3, csvtool, mlr (miller), etc.
```

### Generate a sequence
```bash
# Bash
for i in {1..10}; do …; done
for ((i = 1; i <= 10; i++)); do …; done

# POSIX
i=1
while [ "$i" -le 10 ]; do
  …
  i=$((i + 1))
done
```

## Networking

### Simple HTTP request (without curl)
```bash
# Using /dev/tcp (bash-specific, not always compiled in)
exec 3<>/dev/tcp/example.com/80
printf 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n' >&3
cat <&3
exec 3>&-

# In practice, just use curl or wget
```

### Check if port is open
```bash
if timeout 2 bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null; then
  echo "Port $port is open"
fi

# Or more portable:
if nc -z -w2 "$host" "$port" 2>/dev/null; then
  echo "Port $port is open"
fi
```

## Associative Arrays (bash 4+)

```bash
declare -A config
config[host]="localhost"
config[port]="8080"

# Check if key exists
if [[ -v config[host] ]]; then
  echo "Host: ${config[host]}"
fi

# Iterate
for key in "${!config[@]}"; do
  printf '%s = %s\n' "$key" "${config[$key]}"
done
```

## Signal Handling

```bash
# Graceful shutdown
shutdown=false
trap 'shutdown=true' SIGTERM SIGINT

while ! "$shutdown"; do
  do_work
  sleep 1
done

cleanup
```

## Logging

```bash
log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

log "Starting process"
log "Processed ${count} items"
```
