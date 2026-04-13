#!/usr/bin/env bash
set -euo pipefail

# validate-bash.sh — Run shellcheck and shfmt on a bash script
# Usage: validate-bash.sh <file> [--fix]
#
# Options:
#   --fix    Apply shfmt formatting in-place (shellcheck issues must be fixed manually)
#
# Exit codes:
#   0 — All checks passed
#   1 — Issues found (details printed to stderr)
#   2 — Missing dependencies or invalid arguments

readonly SCRIPT_NAME="${0##*/}"

usage() {
  printf '%s\n' "Usage: ${SCRIPT_NAME} <file> [--fix]"
  printf '%s\n' "  Validates a bash/sh script with shellcheck and shfmt."
  printf '%s\n' "  --fix  Apply shfmt formatting in-place"
}

die() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$1" >&2
  exit "${2:-2}"
}

# --- Argument parsing ---
file=""
fix_mode=false
for arg in "$@"; do
  case "$arg" in
    --fix) fix_mode=true ;;
    --help | -h)
      usage
      exit 0
      ;;
    -*) die "Unknown option: $arg" ;;
    *) file="$arg" ;;
  esac
done

[[ -n "$file" ]] || {
  usage >&2
  die "No file specified"
}
[[ -f "$file" ]] || die "File not found: $file"

# --- Dependency checks ---
missing=()
command -v shellcheck >/dev/null 2>&1 || missing+=("shellcheck")
command -v shfmt >/dev/null 2>&1 || missing+=("shfmt")

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'Missing dependencies: %s\n' "${missing[*]}" >&2
  printf 'Install with: brew install %s\n' "${missing[*]}" >&2
  exit 2
fi

# --- Detect shell dialect ---
shell_flag=()
shfmt_ln=""
if head -1 "$file" | grep -qE '^#!.*\bbash\b'; then
  shell_flag=(-s bash)
  shfmt_ln="bash"
elif head -1 "$file" | grep -qE '^#!.*/sh\b'; then
  shell_flag=(-s sh)
  shfmt_ln="sh/POSIX"
else
  # Default to bash
  shell_flag=(-s bash)
  shfmt_ln="bash (assumed)"
fi

# --- Run checks ---
issues=0
divider="────────────────────────────────────────"

printf '\n%s\n' "$divider"
printf '  Validating: %s (%s)\n' "$file" "$shfmt_ln"
printf '%s\n\n' "$divider"

# ShellCheck
printf '▸ shellcheck\n'
if shellcheck -x -S warning "${shell_flag[@]}" "$file" 2>&1; then
  printf '  ✅ No issues\n\n'
else
  printf '\n  ❌ Issues found (see above)\n\n'
  issues=$((issues + 1))
fi

# shfmt
printf '▸ shfmt (indent=2, case-indent)\n'
if "$fix_mode"; then
  if shfmt -d -i 2 -ci -ln "${shell_flag[1]}" "$file" >/dev/null 2>&1; then
    printf '  ✅ Already formatted\n\n'
  else
    shfmt -w -i 2 -ci -ln "${shell_flag[1]}" "$file"
    printf '  🔧 Formatted in-place\n\n'
  fi
else
  if diff_output=$(shfmt -d -i 2 -ci -ln "${shell_flag[1]}" "$file" 2>&1); then
    printf '  ✅ Properly formatted\n\n'
  else
    printf '%s\n' "$diff_output"
    printf '\n  ❌ Formatting issues (run with --fix to auto-format)\n\n'
    issues=$((issues + 1))
  fi
fi

# --- Summary ---
printf '%s\n' "$divider"
if [[ $issues -eq 0 ]]; then
  printf '  ✅ All checks passed\n'
else
  printf '  ❌ %d check(s) failed\n' "$issues"
fi
printf '%s\n\n' "$divider"

exit "$([[ $issues -eq 0 ]] && echo 0 || echo 1)"
