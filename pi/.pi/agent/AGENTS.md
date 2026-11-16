# User-Level Instructions

## Explicit Approval for External Changes

Do **not** send, publish, post, or modify anything in an external or shared system without the user's explicit approval immediately beforehand. This includes, but is not limited to:

- Sending or editing Slack messages, emails, or other communications
- Creating, editing, commenting on, approving, merging, or closing GitHub/GHE pull requests and issues
- Creating, editing, commenting on, transitioning, or closing Jira tickets
- Creating or updating Google Docs, Drive files, calendar events, or other shared documents
- Triggering deployments, incidents, alerts, workflows, or any other externally visible action

Reading and investigating external systems is allowed when needed to answer a question. Local and reversible work—such as reading files, editing files in the working tree, running tests, or preparing drafts—is also allowed without separate approval.

An explicit user request to perform an external action (for example, “send this message,” “update the PR description,” or “create the Jira ticket”) counts as approval for that specific action. A request to inspect, review, explain, draft, or answer a question does **not** imply approval to make external changes. When intent is ambiguous, prepare the proposed change locally or as a draft, show it to the user, and ask for confirmation before applying it.

If the user has explicitly started a workflow where a particular external mutation is an expected and stated step, that approval remains scoped to the workflow and stated actions only; do not infer permission for unrelated changes.

## Written Artifacts for Humans — Hard Word Limits

PR descriptions, Jira tickets, and commit bodies are read by busy colleagues, not archived for posterity. They are **not** the place to transfer an investigation.

**Hard defaults — count the words before submitting, and cut rather than rationalise:**

- **PR description: ≤ 200 words.** Structure: what changed (one sentence) → why (one or two sentences) → anything a reviewer must verify or must not do. Plus whatever the repo's template mandates.
- **Jira ticket: ≤ 200 words.** Structure: why (with the key numbers) → Do → Don't → Done when.
- **Commit body: ≤ 5 bullets.**

**Cut all of this from the artifact:** mechanism explanations, supporting doc links and precedent, "not applicable" asides, measurement methodology, tooling caveats, alternatives considered, history, and open questions outside the artifact's own scope. One pointer line replaces the lot: *"Full investigation notes are with me, ask if you need them."*

**Always keep negative constraints** — "don't do X, it breaks Y" is the one thing a reader cannot reconstruct themselves, and it prevents wasted work. Never cut those to hit the limit; cut explanation instead.

**Deep context goes in the vault work note. Reasoning about code goes in the code**, and there in one line — let the code speak for itself. A comment restating volumes, row counts, or dates is worse than none, because those decay and then read as current.

This applies to every repo and every project. If a description feels too short, it is probably right.

## MCP Server Discovery

When listing MCP servers from MCP-Explorer, exclude servers whose name ends in `-legacy`. These are deprecated duplicates with active replacements. Present only the non-legacy version.

## Obsidian Mind Vault — Reachable From Every Session

A personal knowledge vault lives at `~/my-vault` (git repo). It holds current goals (`brain/North Star.md`), active work and its status, incident write-ups, people and org context, decisions, gotchas, and patterns. **It is reachable from any working directory** — you do not need to be inside it, and most sessions are not.

Consult it when a task touches Spotify work context: who someone is, what a project's status is, whether a problem has been hit before, or what was decided and why.

- **Direct read (fastest):** resolve the root with `VAULT=$(~/my-vault/.claude/scripts/vault-root.sh) || exit 1`, then read under `$VAULT`. Prefer this when you know roughly where to look — `brain/`, `work/active/`, `work/incidents/`, `org/people/`.
- **Semantic search:** `qmd --index obsidian-mind query "<question>"`. Works from any directory; the index is global at `~/.cache/qmd/obsidian-mind.sqlite`. It can take 30–90s, so use it deliberately rather than speculatively.
- **Slash commands:** the `/om-*` commands are registered globally (`settings.json` → `prompts[]`) and work from any cwd. `/om-dump` files freeform notes into the right place; `/om-wrap-up` reviews a session.

Two things do **not** cross session boundaries — do not assume them:

- **The SessionStart vault injection** (North Star, active work, recent changes, hygiene flags) comes from a project-local extension and only fires when pi runs inside `~/my-vault`. Everywhere else you start with no vault context at all. Fetch it explicitly if the task needs it, and never conclude that no work happened just because you cannot see it.
- **`remember` / `recall` are siloed per working directory** (`~/.pi/agent/repo-memory/<slug>-<sha256(cwd)[:12]>`). A memory stored in one directory is invisible from every other one. For knowledge that should outlive a single project — org structure, people, conventions, cross-cutting decisions — write it to the vault instead of, or as well as, calling `remember`.

Read freely. **Do not write to the vault unless the user asks** — it is their notebook, not a scratchpad.

## GitHub Enterprise (GHE) Access

GHE URLs (ghe.spotify.net) require authentication and cannot be fetched directly via HTTP. When the user shares a GHE link or asks about a PR, PR comment, issue, or review, **always use the `gh` CLI directly** — never attempt to fetch the URL first. Use commands like `gh pr view`, `gh pr view --comments`, `gh api`, etc. to retrieve the relevant content.

## Repository Hooks in Large Monorepos — Verify, Scope, Don't Assume

Before the first commit or push from any checkout, inspect `git config --show-origin --get core.hooksPath`, the resolved hook scripts, and the repository's hook configuration. A fresh clone, sparse checkout, or detached PR checkout does **not** necessarily inherit hooks installed in the canonical clone. If commit output omits the expected repository checks, assume they did not run; do not treat a successful `git commit` or `git push` as evidence otherwise.

Large monorepos must not require a full checkout or continuous synchronization merely to obtain hook coverage:

- Prefer a worktree backed by the existing canonical clone so Git objects and repository-local configuration are reused. When materializing the full tree would be expensive, use a per-worktree sparse checkout containing the changed subtree, root hook configuration, and only the tool paths referenced by those hooks.
- In an independent sparse clone, add only the hook config/tool paths needed for the changed files, or invoke the repository's formatter, linter, and hook commands explicitly against the staged/changed file set.
- Run formatter validation and lint validation separately; a clean linter result does not imply formatting is correct. In `services-pilot`, `ruff check` is not equivalent to the Savvy formatting gate.
- Do not run repository-wide formatting or tests when changed-file/component-scoped commands provide the CI-equivalent signal. Avoid touching unrelated files in a large working tree.
- If the exact changed-file hook equivalent cannot run because required toolchain paths are absent, report that gap and do not push until the missing scoped check has run or the user explicitly accepts the risk.

Before pushing, run both applicable hook stages (`pre-commit` and `pre-push`) or their explicit scoped equivalents, then inspect `git status` and the staged diff because hooks may rewrite or stage files. Never use `--no-verify` unless the user explicitly requests it.

## Crane Review Preflight

Before pushing changes to a Crane-managed repository, resolve the changed paths to component metadata and verify the expected owner, lifecycle, and auto-approval eligibility. For a newly created or moved component, do not assume Crane can already resolve it: explicitly report that its warmed repository index may lag catalog ingestion and that fallback review policy may apply.

Crane's exact policy outcome cannot be known before a PR event; local linting and component metadata are only preflight signals. After the initial push creates or updates a PR, inspect the current commit's **Approvers & Reviewers** check output before enabling merge or promising auto-approval. Read the recorded policy, ownership scope, and diagnostics—not just the requested reviewers. If the check uses stale ownership, wait for the documented metadata TTL and retrigger once with `spt crane:retrigger <PR>`; waiting without a new event does not reevaluate the PR. Do not repeatedly retrigger inside Crane's cooldown window.

## Apache Druid Research Sources

When researching Apache Druid behavior, incidents, configuration, version-specific semantics, or operational guidance, include the Apache Druid users mailing list as a standard source alongside official documentation, source code, GitHub issues, and pull requests:

- Mailing list: `druid-user@googlegroups.com`
- Searchable archive: https://groups.google.com/g/druid-user

Search the archive for relevant configuration names, exception messages, class names, and version numbers. Treat mailing-list posts as community evidence rather than authoritative documentation: verify important claims against the applicable Druid version's source code or tests whenever possible.

## Diagnostics — Verify the Measurement Before Reporting the Finding

When investigating a system, most false findings come from measurements that don't mean what they appear to mean — not from faulty reasoning about correct data. Before reporting any metric as a current or steady state, check three things:

**1. Does the probe perturb what it measures?**
Some tools change the state they report. `nvidia-smi` opens `/dev/nvidiactl`, which triggers a runtime-PM resume — so it reports a discrete GPU as awake and drawing power *because the act of querying woke it*. Prefer non-invasive reads: `/sys/bus/pci/devices/<addr>/power/runtime_status` and `runtime_usage` touch nothing. Similar traps: `smartctl`/`hdparm` can wake a spun-down disk, and anything that opens a device node to query it may reset idle timers.

**2. Is the number cumulative or windowed?**
Never divide a cumulative counter by elapsed time and present the result as a current rate — events are rarely uniformly distributed. "134 log entries over 66 minutes of uptime" is **not** "2/min" when all 134 landed in a single 17-minute burst that has since stopped. Use an explicitly windowed query (`journalctl --since "10 min ago"`) to answer *"is this happening now?"* A cumulative counter can only answer *"did this ever happen?"*

**3. Does the sample window include state you've since changed, or a previous boot?**
`journalctl` without `-b 0` spans reboots. `journalctl -b 0` still spans the entire current boot, including time before a fix was applied — anchor the window to *after* the change. Note also that `-k` filters on `_TRANSPORT=kernel` and therefore **excludes audit records** (`_TRANSPORT=audit`) even though journald labels them `kernel:` in output, so `journalctl -k | grep audit` silently returns nothing.

Additional practices:

- **Sample repeatedly before concluding "always" or "never."** A single snapshot cannot distinguish steady state from a transient. Poll 5–10 times across 20–30 seconds.
- **Normalize before ranking.** Raw error logs look like undifferentiated noise because every line differs by timestamp, PID, or UUID. Collapse those first — `sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27}/<UUID>/g; s/\b[0-9]{4,}\b/<N>/g; s/\[[0-9]+\]/[PID]/g'` — then `sort | uniq -c | sort -rn` to expose the real frequency distribution of *distinct* failure modes.
- **Read the error's own qualifiers.** `oom-kill:constraint=CONSTRAINT_MEMCG` means a cgroup hit its own limit; `CONSTRAINT_NONE` means the host is genuinely out of memory. Identical keyword, opposite root cause and fix.
- **Grep matches are not occurrences.** A count can be inflated by unrelated lines that merely contain the string — a profile-load line that enumerates every AppArmor profile, a `systemd Started …` line, or your own command echoed back into the log.
- **Verify a mechanism before recommending it.** Check `systemctl show <unit> -p ExecReload` before claiming `reload` re-reads configuration: journald's `ExecReload` sends `SIGUSR1`, which flushes `/run`→`/var` and does **not** re-read `journald.conf`.
- **Distinguish "the fix is installed" from "the fix is in effect."** Upgrading a shared library replaces it on disk while running processes keep the old mapping; `usermod -aG` does not change the groups of already-running processes. Package state and runtime state diverge silently.

When a measurement cannot be made non-invasively or windowed, say so explicitly and downgrade the claim to a hypothesis rather than presenting it as a finding. A retracted false positive costs more trust than an unreported uncertainty.

## Standards and Conventions — Never Trade Conformance for Internal Consistency

When the defect is that something violates an **external standard** — unit conventions, naming schemes, protocol contracts, schema rules, API semantics — the fix must be the option that *satisfies the standard*. Do not "resolve" the conflict by changing the other side so the two agree. A self-consistently non-conformant thing is still non-conformant, and the internal tidiness is worth far less than the interoperability the standard buys.

Worked example of getting this wrong: a Prometheus metric was exported in seconds but carried a legacy `...TimeNs` name inherited from upstream. Making it emit raw nanoseconds so the name became truthful *looked* like a fix. It wasn't — the convention is **use base units**, not *make the name match whatever unit you picked*. The conformant option was to keep the conversion and correct the human-readable description; the misleading name was cosmetic and unfixable at source.

Warning signs that a recommendation is a workaround being rationalised:

- **Bundled unrelated benefits.** The bad recommendation above was supported with a true but *separate* advantage (much lower cardinality). If a recommendation needs a second, unrelated justification to feel strong, the first one is probably weak. Attribute each benefit to the problem it actually solves, and let the recommendation fall when its core argument falls.
- **"Just as useful", "strictly better", "wins on every axis."** These phrases nearly always mean the comparison covered only the axes the preferred option wins. Re-check against the axes the *standard* cares about — those are the ones that were skipped.
- **Optimising for the label not lying rather than for the value being right.** Consistency between a name and a value is not the goal; correctness of the value is.
- **A valid criticism smuggling in an invalid remedy.** "These histogram buckets carry no information" was a sound observation. "So change the metric type and lose the unit conversion" did not follow from it. State the observation, then find the remedy that does not sacrifice conformance — in that case, dropping the bucket series at scrape time.

Rules:

- Ask **"which option conforms?"** before **"which option is tidiest?"**
- Prefer **documenting** a cosmetic or immovable defect over **changing semantics** to eliminate it. A wrong-but-frozen name costs one sentence of documentation; wrong units cost every downstream consumer, forever, silently.
- When someone challenges a recommendation with *"isn't this a workaround for X?"*, treat X as probably correct. Re-derive from the standard rather than defending the conclusion — and if the challenge lands, retract explicitly and say which part of the earlier reasoning was wrong, rather than quietly revising.
- Check whether the thing being optimised is even fixable at the layer being changed. If a legacy identifier is frozen by an upstream contract, no amount of local restructuring makes it right; that is a documentation problem, not a design problem.

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

## Commands the User Will Paste — Never Use Multi-Line Heredocs

When handing the user shell commands to copy-paste into a terminal, do **not** use multi-line heredocs (`<<'EOF' … EOF`). The terminating delimiter must sit at column 0 with zero leading whitespace. Editors, chat clients, markdown renderers, and terminal bracketed-paste all routinely add indentation — and an indented delimiter means the heredoc **never terminates**. The receiving command blocks on stdin forever, and when the user interrupts it, **nothing is written**.

This failure is silent and actively misleading: any `mkdir -p` earlier in the same chain still succeeds, so the state looks partially applied. The user reasonably concludes the file *contents* got mangled by their paste, when in fact the command never completed at all.

Use a single-line `printf` piped to the destination instead:

```bash
# Fragile when pasted — indentation on the closing EOF silently swallows the command:
sudo tee /etc/foo.conf >/dev/null <<'EOF'
[Section]
Key=value
EOF

# Paste-safe:
printf '[Section]\nKey=value\n' | sudo tee /etc/foo.conf
```

Why this form is better beyond just being safe:

- **Built-in confirmation** — omit `>/dev/null` and `tee` echoes exactly what it wrote, so the user sees success immediately instead of needing a follow-up `cat`.
- **One line = one paste** — no partial-paste states, and it survives being wrapped in markdown, Slack, a Google Doc, or a ticket.
- **Indentation-immune** — leading whitespace on a single line is harmless to the shell.

Related points worth remembering:

- Leading whitespace *inside* systemd `.conf` and unit files is **stripped by systemd's parser** (verified: space- and tab-indented directives parse correctly). So when a pasted config write fails, suspect the heredoc delimiter, not the body.
- Multi-line heredocs are perfectly fine **inside a script file** authored with the `write`/`edit` tools. The hazard is specific to text a human pastes into an interactive shell.
- The same rule applies to any command needing multi-line input: prefer `printf`, or a short series of `>>` appends, over a heredoc.
- After giving a paste-and-run instruction, **verify the resulting state** (`ls`, `cat -A`, or a targeted `grep`) rather than assuming the paste landed. `cat -A` is the fastest way to see whether whitespace or a missing newline is involved.

### Prefer a sequence of commands over a one-shot script

For a one-time, human-supervised remediation task, give a **short sequence of verifiable commands** rather than bundling everything into a script. Scripts add machinery — dry-run flags, `run()` wrappers, `set -e` interactions, idempotency probes, backup helpers — and that machinery is itself a bug surface. A human watching each step *is* the safety mechanism, and repeatability has little value for something run once.

Reach for a script only when the work is genuinely repeatable (runs on many machines, re-run after every upgrade, wired into CI). When you do write one, remember that `set -e` makes any bare failing command fatal, so best-effort cleanup steps need explicit `|| true`.

## Code Comments — Explain Only Invisible Constraints

Do not add comments that narrate obvious code. If names, types, configuration keys, roles, or structure already show what the code does, put **no comment**. Comments are reserved for non-obvious invariants, surprising constraints, compatibility traps, or reasons a tempting alternative must not be used. Prefer clearer code over explanatory prose, and delete redundant comments during review.

### Hard length limit — 1 line, 2 at the absolute most

A comment is **one line**. Two only when one genuinely cannot carry the constraint. **Never four or more** — no block comments, no ASCII-art banners, no multi-paragraph preambles above a function.

If a comment is growing past two lines, that is a signal the *code* is wrong, not that the comment is too short. Extract a named function, rename a variable, or split the logic until the constraint is expressible in one line. Length limits are not a formatting preference: long comments drift out of date faster than short ones, and a stale paragraph asserting something false is worse than no comment at all.

The rare exception — and it must be genuinely rare — is a constraint that is both non-obvious and irreducible: a protocol quirk, a legal or compliance requirement, an upstream bug with an issue link, a security invariant whose violation is silent. If you invoke the exception, say why in the comment itself so a future reader knows not to delete it.

Explanation that does not fit belongs somewhere with a longer shelf life: an ADR, the PR description, or the vault work note. Link to it in one line.

```python
# BAD — four lines of narration, all reconstructible from the code
# This function takes the user ID and looks up the user in the
# database. If the user is not found it returns None. Callers
# should handle the None case. We use a cache to avoid hitting
# the database on every call.
def get_user(user_id): ...

# GOOD — one line, states the invisible constraint
# Cache is per-process: a second worker will see stale reads for up to 60s.
def get_user(user_id): ...
```

## Coding Workflow — Tests Without Mandatory TDD

Do **not** default to test-driven development or require tests to be written before implementation. Choose the workflow that best fits the task and the repository. Add or update focused tests when they provide useful regression confidence, and run the relevant existing checks before considering the work complete. Use a test-first workflow only when the user explicitly requests it.

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

### Global ADR discovery

A local `adr` catalog indexes ADRs across working directories while keeping repository Markdown as the source of truth.

- Before proposing or implementing a significant architectural decision, run `adr scan`, then consult both `adr related "$PWD"` and `adr search "<decision topic and alternatives>"`.
- Before writing a new ADR, search the catalog for duplicate decisions, prior tradeoffs, superseded approaches, and relevant negative consequences.
- Treat global results as precedent, not policy. Inspect the source path, status, date, Context, and Consequences before applying a decision to a different repository.
- After creating, editing, moving, or superseding an ADR, run `adr scan "$PWD"` to refresh the catalog.
- If the `adr` command is unavailable, continue with normal local ADR discovery rather than blocking the task.

### Workflow integration

- When creating an ADR, mention it in the commit message (e.g., `feat: add PostgreSQL persistence (ADR-003)`).
- If a decision **supersedes** a previous ADR, update the old one's status to `Superseded by [NNN]`.
- When reviewing a codebase and encountering undocumented architectural decisions, **proactively suggest** writing retroactive ADRs to capture tribal knowledge.
