---
name: pr-review
description: |
  Review a pull request by breaking it into logical phases/chunks for structured, thorough review.
  Use this skill whenever the user wants to review a PR, understand a PR's changes, prepare for a PR review,
  or asks things like: "review this pr", "review pr #123", "help me review this pull request",
  "walk me through this pr", "break down this pr", "what does this pr change", "prepare me to review this",
  "summarize this pr for review", "review the changes on this branch". Also use when the user pastes a
  GitHub PR URL or says "review" in the context of code changes. Even if the user just says "review" while
  on a branch with an open PR, this skill applies.
---

# PR Review — Phased Breakdown

Break a pull request into logical phases so a human reviewer can process it in digestible chunks instead of scrolling through a raw diff. Each phase groups related files that implement one coherent idea, reviewed in an order that builds understanding progressively.

**This is a collaborative review, not an automated one.** The AI organizes the phases, presents the diffs with context, and adds initial observations. The human reads the actual code, forms their own opinions, and drives the review. The AI's observations are tentative — the human may correct them, and when they do, the AI updates its understanding and regenerates.

## Step 1: Identify the PR

Figure out which PR to review:

- If the user gives a PR number or URL, use that
- If on a branch with an open PR, use the current branch's PR (`gh pr view`)
- If ambiguous, ask

Fetch each remote input once and save it for the whole review:

```bash
# Metadata includes the changed-file list; derive names locally from files[].path.
gh pr view <number-or-url> --json title,body,author,baseRefName,headRefName,headRefOid,files,additions,deletions,changedFiles,labels,comments,reviews,statusCheckRollup,url > /tmp/pr-<number>-metadata.json

# Fetch the full diff once; use this same file for analysis and HTML generation.
gh pr diff <number> --color=never > /tmp/pr-<number>.diff
```

### Quality-preserving bounded pipeline

Review depth is mandatory; serial orchestration is not. A normal review should use **five investigative batches after loading this skill**, with extra batches only when a command failure blocks progress or contradictory evidence must be resolved:

1. **Acquire once:** fetch metadata and diff concurrently, verify diff completeness, inspect repository rules, and orient with `repo_map`. For a GHE URL, pass the full URL verbatim to `gh`; do not retry first with an unqualified `--repo`. Include `statusCheckRollup` in the metadata fetch and establish whether the exact head SHA is already passing CI before considering local validation.
2. **Understand once:** read all changed production files and their paired tests in one parallel batch. Do not start broad local validation when exact-head CI is passing; reserve it for a specific uncovered risk, absent or failing CI, or a reviewer probe that CI does not exercise.
3. **Prove candidates once:** form candidate observations from those reads, then issue one parallel evidence batch containing the independent searches and focused context reads needed to prove them. Add targeted tests or lint only when they answer a specific unresolved review question.
4. **Probe blockers once:** when executable probes would materially raise confidence, add all temporary probes together, run the minimum affected test targets in one invocation, capture results, and restore every file. Permit at most one follow-up evidence batch for a genuinely new high-risk finding.
5. **Publish once:** build a concise plan, validate it, generate and verify the HTML, remove temporary worktrees, and stop—all in one final tool batch.

Apply these rules throughout:

- **Do not read `scripts/generate-review.py` unless its documented invocation fails or the task is to modify the generator.** The plan schema in this skill is its complete public contract.
- **Reuse fetched and computed inputs.** Do not call `gh pr diff --name-only`; use `files[].path` from saved metadata. Do not refetch metadata, comments, checks, or the diff unless the head SHA changes.
- **Treat passing exact-head CI as the default validation result.** Do not rerun repository tests, broad Bazel targets, formatters, or `lint:all` locally merely to reconfirm green CI. Local execution is justified only by a concrete suspected defect, a check CI does not cover, missing or failing CI, or an uncommitted reviewer probe.
- **Never run the same validation twice for convenience.** When local execution is justified, group independent Bazel/test targets in one invocation. A broad suite may supplement targeted tests only when it covers a distinct unresolved risk; it must not cause targeted checks to be rerun.
- **Do not routinely reproduce an environment-only failure on a base worktree.** Prefer exact-head CI status, a known baseline result, or a focused diagnostic. If a sparse worktree lacks dependencies and CI is green, record the local result as inconclusive and stop. Build and test a base worktree only when the comparison could change the review verdict and no cheaper evidence exists.
- **Materialize source only when repository execution needs it.** Use the exact PR head SHA. In a large monorepo, prefer a sparse worktree containing changed components and required root tooling; do not apply the PR diff onto a moving local base.
- **Stop when the claim is proved.** Once a finding has exact code evidence and, when useful, one focused failing probe, do not launch adjacent speculative investigations unless they can change its severity or remedy.
- **Use risk-triggered enrichment.** Keep deep external validation for data governance, IAM, persistence, networking, concurrency, and other risky contracts; skip unrelated optional systems. Research third-party libraries only when the diff contains a credible custom implementation of a commodity concern. For GCP IAM roles, the permission inventory required in Step 2d is not optional.
- **Keep the artifact dense, not verbose.** Use one positive note per phase unless distinct contracts require more, trim evidence output to the lines that prove the claim, and do not repeat the same explanation in the phase description, coverage basis, artifact note, and observation.
- **Render once after the plan validates.** The deterministic HTML generator is not part of the reasoning loop.

**Important: Always use `bash` (heredocs/cat) to write temp files under `/tmp/pr-*`.** Do NOT use the `Write` or `Edit` tools for these files — those tools trigger permission prompts that cannot be auto-approved for `/tmp` paths.

**Newly added files may be missing from the diff.** After saving, verify that every `files[].path` from the metadata has a corresponding `diff --git` entry in the diff file. Files that are empty, have only mode changes, or aren't captured by the diff algorithm can silently disappear. For each missing file:

1. Fetch its content from the PR head: `git show "$(gh pr view <number> --json headRefOid -q .headRefOid):<path>"`
2. Append a synthetic unified diff to `/tmp/pr-<number>.diff`:
   ```
   diff --git a/<path> b/<path>
   new file mode 100644
   --- /dev/null
   +++ b/<path>
   @@ -0,0 +1,<line_count> @@
   +<each line prefixed with +>
   ```
   If `git show` returns nothing (truly empty file), still append the `diff --git` header and `new file mode` line so the file appears in the review page with a `+0 −0` indicator.

Read the PR description carefully — it tells you what the author intended. Present a brief summary of what the PR is trying to do so the reviewer starts with shared context.

## Step 2: Plan the review phases

Analyze the full diff before reviewing any code, and group changes into phases.

### How to group

Pick the strategy that best fits the PR (or combine them):

- **By concern/feature**: Files that implement the same logical change go together. A Terraform module and its corresponding variables file are one phase, not two.
- **By layer**: Infrastructure → configuration → application logic → tests. Review foundational changes before things that depend on them.
- **By dependency order**: If change B only makes sense after understanding change A, put A first.
- **By risk level**: High-risk changes (security, data, destructive operations) first while attention is fresh. Low-risk (docs, formatting) last.
- **By behavioral contract, especially for tests**: Group tests by the production behavior they prove (polling deadlines, retry orchestration, lookup edge cases), not automatically into one generic “Tests” phase.

### Phase sizing

Each phase should be **one mental pass** — something the reviewer can hold in their head at once:
- ~1–5 files or ~50–200 lines of diff per phase
- Small PRs: 2–3 phases
- Large PRs: 5–8 phases
- If a single file is very large, it can be its own phase
- A test phase should usually cover one behavioral contract, even when that creates more phases than the normal small-PR guideline

### Assess PR scope and reviewability

Before finalizing the phases, decide whether the PR itself is a coherent, reviewable unit. Do not judge size from additions/deletions alone: generated files, lockfiles, snapshots, mechanical migrations, and comprehensive tests may be large but easy to review. Conversely, a small diff can be too broad when it mixes unrelated behavior.

A split suggestion is warranted when one or more of these are true:

- The PR has multiple independently shippable outcomes or unrelated reasons to change
- Understanding one phase does not help with the others, or the phases require unrelated reviewer expertise
- Behavioral changes are mixed with optional cleanup, renaming, reformatting, or refactoring
- The plan needs more than roughly eight substantial phases and no atomic migration constraint explains why
- A reviewer cannot validate the change incrementally because several contracts move at once

When the PR is too broad, add one ⚠️ **Suggestion** to the first relevant phase. Name the concrete split boundaries and ordering, for example: “Land the parser rename first, then add retry behavior, then migrate callers.” Do not merely say “this PR is too large.” Do not recommend splitting an atomic schema/API migration when intermediate commits or PRs would leave the system inconsistent; acknowledge that constraint and instead improve the phase breakdown.

### Pair tests with the code they prove — don't quarantine them

**Default to reviewing a test next to the production code it covers, not in a separate "Tests" phase at the end.** Reviewing all the production code and then all the tests forces the reviewer to reload context they already paid for: by the time they reach `test_poll_times_out()`, they have to remember what `poll_until_done()` did. That is a needless second pass.

There are two mechanisms, and they compose:

**1. Co-locate in the phase (always do this).** A phase's `files` array already accepts line ranges, so put the production section and the test section that proves it in the same phase, production first:

```json
{
  "name": "Polling deadline enforcement",
  "files": [
    {"path": "src/transfer.py", "start": 43, "end": 50, "label": "poll_until_done()"},
    {"path": "tests/test_transfer.py", "start": 121, "end": 129, "label": "tests proving deadline + done-path"}
  ],
  "description": "New polling helper and the two tests that pin its contract."
}
```

**2. Link at line level via `coverage` (do this when the mapping is non-obvious).** See [Step 2b](#step-2b-link-tests-to-the-code-they-cover-optional-high-value) — this renders the covering test *inline beneath the exact lines it proves*, expandable in place.

When a test genuinely proves behavior that spans several phases (an integration or smoke test), keep it in its own phase and note which phases it spans.

### Prefer behavior-level breakdowns for test-heavy changes

Tests are often harder to review manually than production code: repeated fixture and mock setup can hide the actual scenario boundaries. **Do not default to one whole-file “Regression tests” phase** when a changed test file covers multiple independent behaviors.

Proactively split a test file into behavior-level phases during the initial plan when either is true:

- The test diff is roughly 80+ lines, or
- It covers three or more distinct scenarios/contracts

Use new-file line ranges so each phase shows only the relevant test functions:

```json
{
  "name": "Polling windows and maximum deadline tests",
  "files": [
    {
      "path": "tests/test_transfer.py",
      "start": 1,
      "end": 185,
      "label": "imports + polling/deadline tests"
    }
  ],
  "description": "Verify repeated polling timeouts and the aggregate deadline."
}
```

Recommended test-phase boundaries:

- **Happy path vs. failure/timeout behavior**
- **High-level orchestration vs. helper mechanics**
- **State/edge-case matrices** (queued, completed, missing)
- **Serialization/request shape vs. response handling**
- **Unit behavior vs. integration/smoke validation**

When imports or shared helpers changed, include them with the first relevant test phase by starting its range at line 1. The diff renderer only displays changed hunks in that range, so large unchanged gaps do not add noise.

For three or more closely related cases, add a concise per-phase `note` artifact titled something like **“Scenario matrix”** that lists each trigger and expected outcome. This should orient the reviewer, not duplicate every assertion.

The goal is that a reviewer can answer one question per test phase: **“Does this small group of tests convincingly prove this one behavior?”**

### Execute immediately — don't wait for confirmation

Once you've planned the phases, proceed directly to evidence gathering, observations, and HTML generation. You are the expert at breaking down PRs — use your best judgment and launch the review. Don't present the plan and ask "ready to start?" or "want to adjust?" — just do it. The reviewer can always ask to adjust phases after seeing the review page.

## Step 2b: Link tests to the code they cover (optional, high value)

A phase may declare a `coverage` array mapping changed production line ranges to the tests that prove them. The generator then renders, **inline beneath the covered lines**, a collapsible strip naming each covering test, what it proves, and its source — so the reviewer never has to jump to a test file or hold a function in their head across phases.

It also renders:
- a green stripe on covered lines, an **amber stripe on gaps**
- a reciprocal `⬅️ Proves` strip on the test side, so a test read on its own still says what contract it pins
- a top-level **Test Coverage** tab: a matrix of every mapped range, its status, and what proves it

### Schema

```json
"coverage": [
  {
    "code": {"path": "src/transfer.py", "start": 43, "end": 50},
    "tests": [
      {
        "path": "tests/test_transfer.py",
        "start": 121, "end": 125,
        "name": "test_poll_times_out_at_deadline",
        "proves": "Raises `TimeoutError` once the deadline passes",
        "confidence": "high",
        "basis": "calls `poll_until_done()` directly with a past deadline; asserts the raise"
      }
    ]
  },
  {
    "code": {"path": "src/transfer.py", "start": 47, "end": 48},
    "tests": [],
    "gap": "The sleep/backoff path is never exercised — no test asserts the 1s interval."
  }
]
```

Field notes:

- `code.start` / `code.end` and `tests[].start` / `end` are **new-file line numbers** (the right gutter of the diff), same convention as `files` ranges.
- `proves` — one sentence, phrased as the **behavioral claim**, not a restatement of the test name. "Raises `TimeoutError` once the deadline passes" ✅, "tests the timeout" ❌.
- `basis` — *why you believe this test covers this code*. Required for anything below `high` confidence, and good practice always.
- `confidence` — `high` | `medium` | `low`. See the honesty rules below.
- `source` — set to `"measured"` only when the mapping came from a real coverage tool. Renders a `measured` badge instead of a confidence dot.
- `gap` — use an entry with `"tests": []` plus a `gap` string to flag **changed code with no test**. Gaps deliberately win over coverage on overlapping ranges, so an untested branch inside an otherwise-covered function still shows amber.

### Be honest: inferred is not measured

Unless you actually ran a coverage tool, you are **inferring** coverage from names, call sites, and mocks. Presenting inference as ground truth is exactly the kind of confident-but-wrong claim that destroys trust in the whole review. Calibrate:

| Confidence | Use when |
|---|---|
| `high` | The test calls the changed function/method directly and asserts on its result or raised error. |
| `medium` | The test exercises the code path indirectly (through a caller, a route, a fixture) and would plausibly fail if the change broke. |
| `low` | Only circumstantial evidence — naming similarity, same module, a mock that happens to target the path. Say so in `basis`. |

**If you cannot state a `basis` from actual file content, do not assert the link.** Emit no coverage entry, or emit a `gap`. A missing link costs the reviewer one lookup; a wrong link sends them to a test that proves nothing.

### Getting to `measured` (preferred when cheap)

If the repo makes it easy and fast, real line-level coverage beats inference outright:

```bash
# Python
pytest --cov=<pkg> --cov-report=json:/tmp/cov.json -q tests/test_transfer.py

# Go
go test ./... -coverprofile=/tmp/cov.out && go tool cover -func=/tmp/cov.out

# Java (JaCoCo XML), JS (istanbul/nyc JSON)
```

Use measured coverage only when exact-head CI does not already provide enough confidence for the review question and the coverage result would materially improve the mapping. Run a **targeted** subset (only the test files in the PR) rather than the full suite, and group affected targets in one invocation. Do not launch a broader component suite solely to support coverage linking. If the targeted run is slow, needs credentials, or fails for unrelated reasons, **do not fight it** — fall back to inference and label it as such.

### Gathering evidence for inferred links

The same evidence discipline as AI observations applies. Real commands, real output:

```bash
# Which tests reference the changed symbol?
grep -rn 'poll_until_done' tests/ | head -20

# Get the test's exact line range for the coverage entry
grep -n 'def test_poll_times_out_at_deadline' tests/test_transfer.py
sed -n '121,129p' tests/test_transfer.py

# Indirect coverage: does anything mock or patch the changed module?
grep -rn "patch(.*transfer\." tests/ | head
```

### When to skip coverage linking

- The PR has no tests, or no production code (docs, config, pure test refactor)
- The mapping is already obvious because the phase co-locates one function with one test
- You cannot establish a basis — emit `gap` entries instead of guesses
- Tiny PRs where the whole diff fits on one screen

### Call out the gaps in observations too

A `gap` entry marks the diff, but the reviewer may also want it as a reviewable finding. When changed logic has no test, add a matching observation (usually ⚠️ **Suggestion** with a concrete proposal, or ❓ **Question** if there may be a reason). Don't duplicate every gap — promote the ones that carry real risk.

## Step 2c: Impact Analysis (optional, enriches review)

Before gathering evidence, check if **codebase-memory-mcp** tools are available (it may be registered as an MCP server). This step is entirely optional — the review works fine without it — but when available, it dramatically enriches the review with structural understanding of what the changes actually affect.

### If codebase-memory-mcp is available

Check by attempting to call `list_projects`. If it returns results, proceed:

1. **Ensure the repo is indexed:**
   ```
   list_projects()
   # If the project isn't listed:
   index_repository(repo_path="/path/to/repo")
   ```

2. **Run blast radius analysis** on the PR's changes:
   ```
   detect_changes(scope="branch", base_branch="<base_branch>")
   ```
   This returns:
   - **Changed symbols**: Functions/classes that were directly modified in the diff
   - **Blast radius**: Callers of changed functions, classified as CRITICAL (hop 1), HIGH (hop 2), MEDIUM (hop 3), LOW (hop 4+)
   - **Risk summary**: Counts by risk level

3. **Trace high-risk changed functions** to understand their callers:
   ```
   trace_call_path(function_name="<changed_function>", direction="inbound", depth=3, risk_labels=true)
   ```
   Run this for functions flagged as high fan-in (many callers) or entry points.

4. **Get architecture context** if reviewing an unfamiliar codebase:
   ```
   get_architecture(aspects=["packages", "hotspots", "layers"])
   ```
   This tells you where the changed files sit in the project's architecture — are they core hotspots or leaf utilities?

5. **Feed results into the plan JSON** as an `impact_analysis` field:
   ```json
   {
     "impact_analysis": {
       "source": "codebase-memory-mcp",
       "changed_symbols": [
         {"name": "ProcessOrder", "file": "services/orders.py", "risk": "critical", "callers": 5},
         {"name": "ValidateInput", "file": "services/validation.py", "risk": "high", "callers": 12}
       ],
       "blast_radius": {
         "critical": 2,
         "high": 5,
         "medium": 12,
         "low": 3,
         "total_affected": 22
       },
       "architecture_context": "Changes touch the order processing pipeline (core hotspot, 47 inbound calls) and validation layer."
     }
   }
   ```

6. **Add risk levels to phases** based on the impact data:
   ```json
   {
     "name": "Order Processing Logic",
     "risk": "critical",
     "files": ["services/orders.py"],
     ...
   }
   ```
   Risk levels: `"critical"`, `"high"`, `"medium"`, `"low"`. Derived from the highest risk symbol in that phase. Phases with critical/high risk should come first in review order.

### If codebase-memory-mcp is NOT available

Fall back to grep-based impact estimation. This is less precise but still valuable:

```bash
# For each changed function, find callers in the codebase
grep -rn 'ProcessOrder' --include='*.py' . | grep -v 'def ProcessOrder' | head -20

# Count how many files reference a changed function
grep -rl 'ValidateInput' --include='*.py' . | wc -l

# Check if changed functions are imported elsewhere
grep -rn 'from.*orders.*import\|import.*orders' --include='*.py' . | head -20
```

Use the results to estimate blast radius and assign risk levels to phases. You won't get the precise graph data, but you can still identify which changes have the widest impact.

## Step 2d: Supplemental Artifacts (optional, enriches review)

After planning phases and gathering impact data, consider whether supplemental artifacts would help the reviewer understand the change faster. Artifacts are rendered in the HTML review page — either in a dedicated **📚 Context** tab (top-level) or inline within a phase.

This step is optional except for the GCP IAM role inventory below. Most small PRs don't need other artifacts. Use them when the PR involves:
- **Complex file relationships** — a dependency diagram saves the reviewer from mentally tracing imports
- **Architectural changes** — before/after flow diagrams make refactors obvious
- **Domain-specific context** — background that isn't an AI observation but helps understanding
- **Related resources** — links to ADRs, Slack threads, related PRs, or docs mentioned in the description

### Mandatory: inventory GCP IAM role permissions

When a PR adds, removes, changes, or binds a GCP IAM role, include a top-level `note` artifact titled **“GCP IAM role permissions”**. List every affected role and its complete effective permission set so the reviewer can assess capabilities without treating the role name as an opaque identifier.

Resolve permissions from the strongest available source:

1. For a custom role defined or changed in the PR, use the effective new-file `permissions`, `included_permissions`, or `includedPermissions` from the reviewed code. For a deleted role, use its old-file definition and label it as removed.
2. For a predefined role, load the `gcloud-safety` skill and use a read-only, explicitly scoped role description (for example, `gcloud iam roles describe roles/<role> --format=json`).
3. For an existing project- or organization-level custom role, load `gcloud-safety` and describe it with the explicit `--project` or `--organization` scope found in the code. Do not guess the scope.

The artifact must include:

- Full role identifier and whether it is predefined, project custom, or organization custom
- Complete permission list, one permission per line
- Source used and, for a remote lookup, the lookup scope
- A short note for permissions added or removed when the PR changes a custom role

If authoritative resolution is blocked by missing scope, credentials, VPN, or tooling, still add the artifact with the unresolved role identifier and exact blocker, and add a `question` observation. Never silently omit the inventory or substitute a remembered/typical permission list. Keep security conclusions separate from the inventory: the list is evidence, not by itself a least-privilege verdict.

Example:

```json
{
  "type": "note",
  "title": "GCP IAM role permissions",
  "content": "`roles/pubsub.publisher` (predefined)\nSource: `gcloud iam roles describe roles/pubsub.publisher`\n\nPermissions:\n- pubsub.topics.get\n- pubsub.topics.publish"
}
```

For multiple roles, use one clearly separated section per role in the same artifact unless the permission sets are too large to scan; then use one artifact per role.

### Artifact types

Three types are supported in the plan JSON:

**`diagram`** — Mermaid diagram (rendered client-side via mermaid.js). Use for:
- Module/file dependency graphs
- Before/after request flows
- State machine changes
- Data flow through a pipeline

```json
{
    "type": "diagram",
    "title": "Module dependency graph",
    "content": "graph LR\n  handler.py --> auth.py\n  handler.py --> db.py\n  auth.py --> tokens.py"
}
```

**`reference`** — Link to a related resource. Use for:
- Related PRs (previous/follow-up)
- ADRs that explain the design choice
- Documentation pages
- Slack threads with design discussions
- External specs or RFCs

```json
{
    "type": "reference",
    "title": "ADR-015: Structured Logging",
    "url": "https://ghe.spotify.net/team/repo/blob/master/docs/adr/015-structured-logging.md",
    "description": "Decision to use stdlib logging over third-party alternatives"
}
```

**`note`** — Contextual explanation. Use for:
- Background on why this change is being made
- Domain concepts the reviewer might not know
- Known gotchas or non-obvious constraints
- Migration context ("this is step 2 of 4")

```json
{
    "type": "note",
    "title": "Background: Observability initiative",
    "content": "This change is part of the Q2 observability initiative. All service entry points are getting structured logging. The auth service was done in PR #998."
}
```

### Where to place artifacts

- **Top-level** (`"artifacts"` at the root of the plan JSON): Shown in a dedicated **📚 Context** tab. Use for cross-cutting context that applies to the whole PR — dependency graphs, related resources, background notes.
- **Per-phase** (`"artifacts"` inside a phase object): Shown inline within that phase, between the diffs and AI observations. Use for phase-specific context — a before/after diagram for a refactored function, a link to the spec that defines the API being implemented.

### When NOT to create artifacts

- Small PRs (< 50 lines) — the diff is the context, unless it affects a GCP IAM role
- Pure formatting/style changes — nothing structural to diagram
- When the PR description already explains everything clearly
- When it would duplicate what the AI observations already say

The goal is to **reduce cognitive load**, not add more to read. If an artifact doesn't save the reviewer time, skip it.

### Generating diagrams

Use [Mermaid syntax](https://mermaid.js.org/syntax/flowchart.html). Common patterns:

```
# File dependency graph
graph LR
  A[handler.py] --> B[auth.py]
  A --> C[db.py]
  B --> D[tokens.py]

# Before/after flow (see subgraph ordering note below)
graph LR
  subgraph After
    R2[Request] --> M2[Middleware] --> H2[Handler] --> D2[DB]
  end
  subgraph Before
    R1[Request] --> H1[Handler] --> D1[DB]
  end

# State machine
stateDiagram-v2
  [*] --> Pending
  Pending --> Processing: start()
  Processing --> Complete: finish()
  Processing --> Failed: error()
```

Keep diagrams small and focused — 5–15 nodes max. If it needs more, split into multiple diagrams.

**Subgraph ordering in Mermaid:** Mermaid renders subgraphs in **reverse definition order** — the *last* defined subgraph appears on the *left* (in `graph LR`) or *top* (in `graph TD`). For before/after diagrams, always define **"After" first, then "Before"** so that "Before" renders on the left and "After" on the right, matching natural left-to-right reading order and any "before → after" title.

**Quoting special characters in Mermaid:** Edge labels containing `/`, `*`, `?`, or other special characters must be double-quoted: `-->|"gh-readonly-queue/..."|` not `-->|gh-readonly-queue/*|`. Node labels with special characters also need quoting: `CT["PRE_MERGE / POST_MERGE"]`.

## Step 3: Gather evidence, then generate the review page

Before writing any observations, do due diligence on the codebase — especially for IaC, check files **outside the diff** that reference changed resources. Understand module nesting, provider references, depends_on chains. This context prevents false positives in your observations.

### Gather evidence before writing observations

**Every non-trivial observation must be backed by evidence.** Evidence is the output of a real shell command — `grep`, `sed`, `cat`, etc. — that proves the observation is grounded in actual code, not AI recollection. This is especially critical for:

- Claims about code **outside the diff** (e.g., "callers of this module don't pass the new variable")
- Claims about **what a line does** (e.g., "this removes the auth check")
- Claims about **missing things** (e.g., "there's no error handling for X")
- Claims about **interactions** between files (e.g., "this variable is referenced in the provider block")

**How to gather evidence:**

```bash
# Check what references a changed resource outside the diff
grep -rn 'module\.dns' --include='*.tf' . 2>/dev/null | head -20

# Verify what a specific line range actually says
sed -n '40,55p' modules/dns/main.tf

# Check if something is missing that should be there
grep -rn 'error\|catch\|except' src/handler.py | head -20

# See the full context around a changed line
sed -n '30,50p' envs/prod/main.tf
```

Run the commands and **capture both the command and its output**. These become the `evidence` array in each observation. The HTML review page renders them as collapsible "📎 Evidence" blocks so the reviewer can verify the AI's reasoning.

**When evidence is NOT required:**
- ✅ "Looks good" observations (positive, no claim to verify)
- 💡 Nits about style/formatting (visible directly in the diff)
- Simple observations where the diff line itself is the evidence

### Perform a mandatory readability and maintainability pass

Correctness is only one axis of review. For **every phase containing hand-written code**, explicitly assess how easy the changed code is to understand, modify, and safely extend. Read enough surrounding code to judge names and abstractions in their actual context, and consult the relevant sections of [references/review-checklist.md](references/review-checklist.md).

Check these dimensions:

1. **Naming and intent** — Do names communicate domain role, units, side effects, ownership, and lifecycle where those distinctions matter? Flag ambiguous placeholders such as `data`, `item`, `handler`, `manager`, `process`, or `result` only when the local context does not disambiguate them. Prefer names that distinguish the symbol from its neighbors without encoding the whole implementation. Boolean names should read as predicates.
2. **Local readability** — Can the control flow and state transitions be followed without repeatedly jumping between files or mentally negating conditions? Look for deep nesting, dense compound conditions, surprising mutation, hidden temporal coupling, long parameter lists, and comments compensating for unclear code.
3. **Responsibility load and cohesion** — Can each changed function, class, module, or configuration block be summarized with one responsibility at one abstraction level? Look for objects that both coordinate and implement several stages, functions that validate/transform/persist/notify in one flow, mode flags selecting unrelated behaviors, unrelated dependencies or invariants, and public APIs that expose several concepts. A construct is not “too long” merely because of line count; flag it when it has multiple reasons to change and identify a concrete extraction boundary.
4. **DRY and sources of truth** — Does the change duplicate business rules, validation, mappings, constants, state transitions, request construction, or other knowledge that must remain synchronized? Search for the other copies before claiming a DRY violation. Similar syntax is not necessarily duplicated knowledge: keep repetition when cases can evolve independently or when an abstraction would hide meaningful differences.
5. **Maintainability and coupling** — Does the change leak implementation details, add special cases to the wrong layer, widen dependencies, or make the next likely change require edits in many places? Check whether abstractions match current use rather than speculative future reuse.
6. **Reinvention and dependency fit** — Is custom code rebuilding a well-understood commodity capability such as retry/backoff, parsing, validation, serialization, caching, CLI handling, protocol clients, date/time logic, or cryptography? Check in order whether the standard library/platform or an existing repository dependency already provides the needed semantics, then whether a well-supported library is a better fit.
7. **Consistency and conventions** — Does the change follow nearby project patterns for vocabulary, error handling, APIs, file structure, tests, and formatting? Verify conventions from repository evidence before claiming a violation; do not enforce generic preferences over an intentional local pattern.
8. **Reviewability** — Is the phase internally coherent, and is the whole PR scoped so reviewers can validate one contract at a time? Apply the PR-scope guidance above.

Perform the pass even when it yields no criticism. Emit at least one concise quality assessment per substantive phase: a ✅ when the code is notably clear/cohesive, or the highest-value concrete improvement. Avoid manufacturing a nit just to satisfy this rule. Generated/vendor output and purely mechanical changes may be covered by a single assessment explaining that maintainability belongs at the source/template rather than in generated lines.

#### Make style feedback actionable and calibrated

- Name the symbol or changed lines, the reading/maintenance cost, and the smallest concrete improvement.
- For naming feedback, propose one or two better names and state what ambiguity they remove.
- For size/cohesion feedback, identify the mixed responsibilities, their separate reasons to change, and a plausible extraction boundary; never write only “this class/function is too long.”
- Before a DRY suggestion, prove that at least two locations encode the same knowledge and would need synchronized changes. Name the proposed source of truth; do not abstract incidental resemblance.
- Use ⚠️ **Suggestion** for structural readability or maintainability improvements with a concrete alternative. Use 💡 **Nit** only for truly local, non-blocking wording or formatting preferences.
- Do not request a helper, class, abstraction, or split unless it reduces current complexity. One-use code is often clearer inline.
- When suggesting a library, name it and compare its exact API/semantics with the custom code. Prefer, in order: standard library/platform support, a dependency already used by the repo, then a new dependency.
- Before recommending a new dependency, verify current maintenance, compatible releases, security posture, license/policy fit, transitive or bundle cost, and project adoption from authoritative sources. Stars or download counts alone do not establish support.
- Do not recommend a library when the custom implementation is small, domain-specific, easier to audit, or requires semantics the library cannot provide. State the tradeoff rather than treating dependency use as automatically superior.
- Do not confuse unfamiliar code with unreadable code. Trace it first; if the design becomes clear from normal project context, do not penalize it.
- Do not repeat formatter/linter output as AI insight unless it exposes a broader readability problem.
- Keep style feedback subordinate to correctness and risk, but do not omit it merely because the code works.

Examples:

- Weak: “`process()` is vague.”
- Strong: “💡 Rename `process()` to `normalize_headers()`; this class also validates and persists requests, so `process` does not reveal which stage callers invoke.”
- Weak: “This class is too long.”
- Strong: “⚠️ `ImportJob` now owns parsing, retry scheduling, and persistence—three independently changing responsibilities. Keep orchestration in `ImportJob`, move retry state into `RetryPolicy`, and leave persistence behind the existing repository interface.”
- Weak: “This isn't DRY.”
- Strong: “⚠️ The accepted-status mapping is now duplicated in `parse_response()` and `validate_transition()`. Extract it as the transition table's single source of truth so adding a status cannot update one path but not the other.”
- Weak: “This PR is huge.”
- Strong: “⚠️ The cache-key rename is independently shippable and obscures the eviction behavior change. Land the rename first, then review eviction semantics and tests as a separate PR.”
- Weak: “Use a library instead.”
- Strong: “⚠️ Replace the custom exponential-backoff loop with the repo's existing `tenacity` dependency. Its stop/wait policies cover the same deadline and jitter behavior, while removing cancellation and overflow cases this PR would otherwise own; retain the domain-specific retryability predicate locally.”

For each phase, write initial AI observations. These are **tentative** — be honest about uncertainty. Use severity levels:

- ❌ **Issue** — Likely needs fixing before merge (bug, security flaw, broken behavior)
- ⚠️ **Suggestion** — Worth considering a *specific alternative*. Must propose a concrete change the author could make. If you're not recommending a different approach, it's not a suggestion — it's either a ✅ or a ❓.
- 💡 **Nit** — Non-blocking, style/preference
- ❓ **Question** — Needs clarification from the author before the reviewer can assess
- ✅ **Looks good** — Positive observations, confirmations, and informational context. Use this for: approach validation ("this follows the same pattern as X"), background context ("the backend monorepo builds this differently, but the approach here is sound"), and anything that confirms the code is correct without proposing a change.

### Build the plan JSON

Create a plan JSON file using `bash` with a heredoc. The schema below is the generator's supported public contract; do not inspect the generator source to rediscover it. Always use `cat > /tmp/pr-<number>-plan.json << 'PLAN_EOF' ... PLAN_EOF` — never the `Write` tool:

```json
{
    "title": "PR title",
    "number": 123,
    "author": "username",
    "base": "master",
    "head": "feature-branch",
    "additions": 36,
    "deletions": 4,
    "changed_files": 7,
    "url": "https://...",
    "description": "What this PR does",
    "artifacts": [
        {"type": "diagram", "title": "Module dependencies", "content": "graph LR\n  A --> B"},
        {"type": "reference", "title": "Related ADR", "url": "https://...", "description": "Why we chose this approach"},
        {"type": "note", "title": "Background", "content": "This is part of the Q2 migration..."}
    ],
    "phases": [
        {
            "name": "Phase Name",
            "files": ["path/to/file1"],
            "description": "Why these files are grouped",
            "coverage": [
                {
                    "code": {"path": "path/to/file1", "start": 40, "end": 58},
                    "tests": [
                        {
                            "path": "tests/test_file1.py", "start": 90, "end": 104,
                            "name": "test_deadline_is_enforced",
                            "proves": "Raises `TimeoutError` after the deadline",
                            "confidence": "high",
                            "basis": "calls the changed function directly and asserts the error"
                        }
                    ]
                }
            ],
            "artifacts": [
                {"type": "diagram", "title": "Before/After flow", "content": "graph TD\n  A --> B"}
            ],
            "ai_notes": [
                {"severity": "good", "text": "Observation"},
                {"severity": "suggestion", "text": "Consider this", "evidence": [
                    {"command": "grep -rn 'module\\.dns' --include='*.tf' .", "output": "envs/prod/main.tf:42:  source = module.dns.zone_id\nenvs/staging/main.tf:38:  source = module.dns.zone_id"}
                ]},
                {"severity": "issue", "text": "Callers reference module.dns.output directly but count was added, so they need module.dns[0].output", "evidence": [
                    {"command": "grep -n 'module\\.dns\\.' envs/prod/main.tf", "output": "42:  zone_id = module.dns.zone_id\n67:  name    = module.dns.domain"},
                    {"command": "sed -n '10,12p' modules/dns/main.tf", "output": "resource \"aws_route53_zone\" \"this\" {\n  count = var.create_zone ? 1 : 0\n  name  = var.zone_name"}
                ]}
            ]
        }
    ]
}
```

**File entries** in `"files"` can be strings (full file) or objects with line ranges for section-level review:
```json
"files": [
    "full_file.py",
    {"path": "big_file.py", "start": 10, "end": 50, "label": "parse function"}
]
```
The `start`/`end` are new-file line numbers. The `label` appears in the file header. The generator filters the diff to only show lines within that range. This is primarily used after a phase breakdown (Path C) to show specific functions/sections instead of repeating the entire file.

The `evidence` field is an array of `{"command": "...", "output": "..."}` objects. Each is a shell command that was actually run and its real output. Multiple evidence items per observation are fine when the claim requires cross-referencing multiple sources. Trim stored output to the exact lines needed to verify the claim; full test logs remain in their `/tmp/pr-*` files and should not be copied into the plan.

### Generate and open the HTML review page

```bash
python3 <skill-dir>/scripts/generate-review.py \
  --diff /tmp/pr-<number>.diff \
  --plan /tmp/pr-<number>-plan.json \
  --output /tmp/pr-<number>-review.html \
  --repo-dir "$(git rev-parse --show-toplevel)" \
  --head-sha "$(gh pr view <number> --json headRefOid -q .headRefOid)"

if [ ! -f /tmp/pr-<number>-review.html.pi-cockpit ]; then xdg-open /tmp/pr-<number>-review.html; fi
```

When the `.pi-cockpit` marker exists, the review extension is monitoring the artifact and will open its authenticated version automatically; do not open the raw `file://` page as well.

Tell the reviewer what they'll see:
- **Phase tabs** across the top — click or ← → arrow keys to navigate
- **Diffs** per file with syntax highlighting (click file headers to collapse/expand). Files without highlighting show a `🎨 no highlighting` button — click it to open a language picker and apply highlighting on the fly. The chosen mapping is saved to localStorage and auto-applied on reload.
- **Tests beside the code they prove** — green-striped ranges have an inline `Covered by` strip; click a test name to expand its source without leaving the phase. Amber-striped ranges are explicit test gaps. The **Test Coverage** tab summarizes all mappings and gaps.
- **Inline comments** — click the `+` button in the gutter next to any diff line to add a comment on that line. Shift+click to select a range of lines. Comments are saved with the line context and appear in the summary/export.
- **🤖 AI Observations** with 🚩 flag buttons — flag anything that looks wrong or needs discussion
- **Comment box** per phase for their own notes (auto-saved)
- **⚡ Stop bar** appears when items are flagged — click to copy flagged items + comments to clipboard for immediate paste back into the terminal
- **🔬 Break down button** on each phase header — if a phase feels too large or mixes unrelated concerns, click to copy a breakdown request to the clipboard, then paste it into the terminal. The AI will propose sub-phases and regenerate the page.
- **Summary tab** compiles everything — flagged items, inline comments, phase comments, with copy/download buttons

## After the artifact exists

Do not load post-generation instructions during initial review generation. When the reviewer returns with flags, comments, a phase-breakdown request, completed feedback, or a request to publish, read and follow [references/review-conversation.md](references/review-conversation.md). Posting always requires explicit user approval immediately beforehand.
