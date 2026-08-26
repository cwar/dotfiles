# User-Level Instructions

## MCP Server Discovery

When listing MCP servers from MCP-Explorer, exclude servers whose name ends in `-legacy`. These are deprecated duplicates with active replacements. Present only the non-legacy version.

## GitHub Enterprise (GHE) Access

GHE URLs (ghe.spotify.net) require authentication and cannot be fetched directly via HTTP. When the user shares a GHE link or asks about a PR, PR comment, issue, or review, **always use the `gh` CLI directly** — never attempt to fetch the URL first. Use commands like `gh pr view`, `gh pr view --comments`, `gh api`, etc. to retrieve the relevant content.

## Shell Scripts in Shared Repos — POSIX Compatibility

When writing shell scripts that will be committed to a repository used by others, **always use POSIX-compatible syntax and commands**. Most coworkers are on macOS, and GNU/Linux-specific flags or utilities will break for them.

Common pitfalls to avoid:

- **`sed -i`** — GNU `sed` uses `sed -i ''` differently than BSD. Prefer `sed -i '' 's/...'` or use a temp file.
- **`grep -P`** (Perl regex) — not available on macOS BSD grep. Use `grep -E` (extended regex) instead.
- **`readarray` / `mapfile`** — bash 4+ only; macOS ships bash 3.2. Use `while read` loops.
- **`date` flags** — GNU `date -d` doesn't exist on BSD. Use `date -j -f` on macOS or avoid platform-specific date parsing.
- **`realpath`, `mktemp -d` flags, `stat` format strings** — all differ between GNU and BSD.
- **Shebang** — use `#!/usr/bin/env bash` (or `#!/bin/sh` for true POSIX scripts), never `#!/bin/bash`.
- **Bash 4+ features** — associative arrays (`declare -A`), `${var,,}` lowercasing, `|&` pipe stderr — unavailable on macOS default bash.
- **`[[` vs `[`** — `[[` is bash-specific; use `[` in `/bin/sh` scripts.

Additional command-specific pitfalls:

- **`find -printf`** — GNU-only. Use `find ... -exec stat` or pipe to `awk` instead.
- **`find -regex`** — default regex type differs (GNU: emacs, BSD: basic). Explicitly pass `-regextype` on GNU or avoid `-regex` entirely.
- **`xargs -r`** (no-run-if-empty) — GNU-only flag. BSD `xargs` already skips on empty input. Omit `-r` or guard with `if` for portability.
- **`sort -V`** (version sort) — GNU-only. No BSD equivalent; use custom `awk`/`python` sorting if needed.
- **`tar`** — GNU tar auto-detects compression (`tar xf`), BSD often requires explicit flags (`tar xzf`). Always specify the compression flag.
- **`cp -T`** (no-target-directory) — GNU-only. Restructure the command to avoid needing it.

### Filesystem Case Sensitivity

**This is the #1 non-script pitfall.** Linux filesystems are case-sensitive; macOS (APFS/HFS+) is case-**insensitive** by default. Consequences:

- Creating `Config.js` and `config.js` as separate files works on Linux but causes silent collisions on macOS.
- Renaming a file's case (`myFile.ts` → `myfile.ts`) may not register as a change in git on macOS. Use `git mv -f` to force it.
- Import paths with wrong casing (`import x from './MyModule'` when the file is `mymodule.ts`) work on macOS but break on Linux CI.

**Rule:** Always treat file and directory names as case-sensitive. Never rely on case differences to distinguish files. If renaming case, always use `git mv`.

### Docker Behavior Differences

Docker on macOS runs inside a Linux VM (Docker Desktop / Colima), which causes subtle differences:

- **Volume mount performance** — dramatically slower on macOS. Don't assume local-dev volume mounts are fast.
- **File watching** — Linux uses `inotify`, macOS uses `fsevents`. File watchers (webpack, nodemon, etc.) inside Docker containers may not detect macOS host file changes. Use polling mode or native file watching configs.
- **Networking** — `host.docker.internal` works on macOS Docker Desktop but may not resolve on Linux Docker. Don't hardcode either; use environment variables.

### Makefile Portability

If the repo uses Makefiles, be aware that macOS ships BSD `make` while Linux uses GNU `make`. Stick to POSIX make features and avoid GNU-specific extensions like `$(shell ...)` in complex ways, `ifdef`/`ifndef` nesting, or `.ONESHELL`.

When in doubt, test compatibility by checking if the command/flag exists on both GNU coreutils and BSD (macOS). Scripts and build tooling intended **only** for the local machine (e.g., `~/.local/bin/`) are exempt from these rules.

## Coding Workflow — Red-Green TDD by Default

When working on any coding task — unless the user explicitly specifies a different workflow — follow **Red-Green-Refactor TDD**:

1. **Red**: Write a failing test first that captures the expected behavior.
2. **Green**: Write the minimum code to make the test pass.
3. **Refactor**: Clean up the implementation while keeping tests green.

Apply this iteratively for each incremental piece of functionality. If the project already has a test framework configured, use it. If not, ask the user which framework to set up before proceeding.

## Architectural Decision Records (ADRs)

When making a **significant architectural decision** during a coding task, write an ADR and commit it alongside the code change. This ensures future engineers and agents understand *why* decisions were made, not just *what* the code does.

### What counts as significant

- Choosing a framework, library, database, or protocol
- Defining a data model, API contract, or schema
- Establishing a project structure or module boundary
- Adopting a pattern (event sourcing, CQRS, pub/sub, etc.)
- Making a meaningful tradeoff (performance vs. readability, consistency vs. availability, etc.)
- Deprecating or replacing an existing approach

Do **not** write an ADR for routine implementation details, bug fixes, or small refactors.

### Where to put them

1. **If the repo already has ADRs** — look for `adrs/`, `docs/adr/`, `doc/adr/`, or `docs/decisions/` — follow that existing convention.
2. **If no ADR directory exists** — create `docs/adr/` and add the first record there.
3. **For non-git or ephemeral projects** — skip the ADR; use pi's `manage_adr` tool instead to store the decision in session memory.

### File naming

`NNN-kebab-case-title.md` — sequential numbering, starting from `001` (or the next number in the existing sequence).

### Template

```markdown
# NNN. Title of Decision

Date: YYYY-MM-DD

## Status

Proposed | Accepted | Deprecated | Superseded by [NNN]

## Context

What is the problem or situation that motivates this decision? Include relevant constraints, requirements, and forces at play.

## Decision

What is the change being proposed or adopted? Be specific and direct.

## Consequences

What are the positive, negative, and neutral outcomes of this decision? Include any risks, tradeoffs, or follow-up work needed.
```

### Workflow integration

- When creating an ADR, mention it in the commit message (e.g., `feat: add PostgreSQL persistence (ADR-003)`).
- If a decision **supersedes** a previous ADR, update the old one's status to `Superseded by [NNN]`.
- When reviewing a codebase and encountering undocumented architectural decisions, **proactively suggest** writing retroactive ADRs to capture tribal knowledge.
