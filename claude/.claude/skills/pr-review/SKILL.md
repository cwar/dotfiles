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

Fetch everything needed to understand the PR:

```bash
# Metadata: title, description, author, file list, stats
gh pr view <number> --json title,body,author,baseRefName,headRefName,files,additions,deletions,changedFiles,labels,comments,reviews

# Changed file list (quick overview)
gh pr diff <number> --name-only

# Full diff (needed to plan phases)
gh pr diff <number>
```

Save the diff to a temp file for the HTML generator:

```bash
gh pr diff <number> > /tmp/pr-<number>.diff
```

**Important: Always use `bash` (heredocs/cat) to write temp files under `/tmp/pr-*`.** Do NOT use the `Write` or `Edit` tools for these files — those tools trigger permission prompts that cannot be auto-approved for `/tmp` paths.

Read the PR description carefully — it tells you what the author intended. Present a brief summary of what the PR is trying to do so the reviewer starts with shared context.

## Step 2: Plan the review phases

Analyze the full diff before reviewing any code, and group changes into phases.

### How to group

Pick the strategy that best fits the PR (or combine them):

- **By concern/feature**: Files that implement the same logical change go together. A Terraform module and its corresponding variables file are one phase, not two.
- **By layer**: Infrastructure → configuration → application logic → tests. Review foundational changes before things that depend on them.
- **By dependency order**: If change B only makes sense after understanding change A, put A first.
- **By risk level**: High-risk changes (security, data, destructive operations) first while attention is fresh. Low-risk (docs, formatting) last.

### Phase sizing

Each phase should be **one mental pass** — something the reviewer can hold in their head at once:
- ~1–5 files or ~50–200 lines of diff per phase
- Small PRs: 2–3 phases
- Large PRs: 5–8 phases
- If a single file is very large, it can be its own phase

### Execute immediately — don't wait for confirmation

Once you've planned the phases, proceed directly to evidence gathering, observations, and HTML generation. You are the expert at breaking down PRs — use your best judgment and launch the review. Don't present the plan and ask "ready to start?" or "want to adjust?" — just do it. The reviewer can always ask to adjust phases after seeing the review page.

## Step 2b: Impact Analysis (optional, enriches review)

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

For each phase, write initial AI observations. These are **tentative** — be honest about uncertainty. Use severity levels:

- ❌ **Issue** — Likely needs fixing before merge (bug, security flaw, broken behavior)
- ⚠️ **Suggestion** — Worth considering a *specific alternative*. Must propose a concrete change the author could make. If you're not recommending a different approach, it's not a suggestion — it's either a ✅ or a ❓.
- 💡 **Nit** — Non-blocking, style/preference
- ❓ **Question** — Needs clarification from the author before the reviewer can assess
- ✅ **Looks good** — Positive observations, confirmations, and informational context. Use this for: approach validation ("this follows the same pattern as X"), background context ("the backend monorepo builds this differently, but the approach here is sound"), and anything that confirms the code is correct without proposing a change.

### Build the plan JSON

Create a plan JSON file using `bash` with a heredoc (see [scripts/generate-review.py](scripts/generate-review.py) for the full schema). Always use `cat > /tmp/pr-<number>-plan.json << 'PLAN_EOF' ... PLAN_EOF` — never the `Write` tool:

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
    "phases": [
        {
            "name": "Phase Name",
            "files": ["path/to/file1"],
            "description": "Why these files are grouped",
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

The `evidence` field is an array of `{"command": "...", "output": "..."}` objects. Each is a shell command that was actually run and its real output. Multiple evidence items per observation are fine when the claim requires cross-referencing multiple sources.

### Generate and open the HTML review page

```bash
python3 <skill-dir>/scripts/generate-review.py \
  --diff /tmp/pr-<number>.diff \
  --plan /tmp/pr-<number>-plan.json \
  --output /tmp/pr-<number>-review.html

xdg-open /tmp/pr-<number>-review.html
```

Tell the reviewer what they'll see:
- **Phase tabs** across the top — click or ← → arrow keys to navigate
- **Diffs** per file with syntax highlighting (click file headers to collapse/expand). Files without highlighting show a `🎨 no highlighting` button — click it to open a language picker and apply highlighting on the fly. The chosen mapping is saved to localStorage and auto-applied on reload.
- **Inline comments** — click the `+` button in the gutter next to any diff line to add a comment on that line. Shift+click to select a range of lines. Comments are saved with the line context and appear in the summary/export.
- **🤖 AI Observations** with 🚩 flag buttons — flag anything that looks wrong or needs discussion
- **Comment box** per phase for their own notes (auto-saved)
- **⚡ Stop bar** appears when items are flagged — click to copy flagged items + comments to clipboard for immediate paste back into the terminal
- **🔬 Break down button** on each phase header — if a phase feels too large or mixes unrelated concerns, click to copy a breakdown request to the clipboard, then paste it into the terminal. The AI will propose sub-phases and regenerate the page.
- **Summary tab** compiles everything — flagged items, inline comments, phase comments, with copy/download buttons

## Step 4: Handle the review conversation

The reviewer works through the HTML at their own pace. They'll come back in one of three ways:

### Path A: Stop and discuss (flagged items)

The reviewer pastes flagged items mid-review. This means they think the AI got something wrong, or need clarification before continuing.

1. **Read the flagged items carefully** — the reviewer is correcting you or asking you to dig deeper.
2. **Investigate with evidence** — run real commands to verify. The reviewer may be right (and often is — they know the codebase better). Gather new evidence to support the corrected understanding.
3. **Acknowledge corrections honestly** — if you were wrong, say so and explain what you misunderstood.
4. **Update the plan JSON** with corrected observations and fresh evidence. Turn wrong observations into correct ones backed by shell command output.
5. **Regenerate the HTML** — the reviewer's comments and unflagged items persist in localStorage, so they won't lose work. The updated evidence blocks will reflect the corrected understanding.
6. Tell the reviewer the page is updated and they can continue.

This loop can happen multiple times. Each time, the AI's understanding improves and the observations get more accurate.

### Path B: Full feedback (review complete)

The reviewer pastes the full review feedback or downloads the JSON. Proceed to the summary step.

### Path C: Break down a phase

The reviewer clicks the 🔬 **Break down** button on a phase header, which copies a structured breakdown request to the clipboard. They paste it into the terminal, optionally adding guidance about how they'd like it split.

1. **Read the pasted message** — it lists the phase number, name, files (with stats), and any comments or inline comments the reviewer has already written on that phase.
2. **Break the files down at the function/section level.** Don't just repeat the same file in multiple sub-phases with different descriptions — use line ranges so each sub-phase shows only its relevant portion of the file. Read the diff and identify natural section boundaries:
   - Individual functions/methods and their line ranges in the new file
   - Logical sections (imports & types, configuration, business logic, error handling)
   - Blocks of related changes (e.g., all validation additions vs. all logging additions)
   - If the reviewer provided guidance, follow their suggested split

   For each sub-phase, specify file sections using the object format in `"files"`:
   ```json
   "files": [{"path": "src/handler.py", "start": 15, "end": 67, "label": "parse_request()"}]
   ```
   The `start`/`end` are **new-file line numbers** — the line numbers shown in the right gutter of the diff. The `label` appears in the file header so the reviewer knows which section they're looking at. The generator filters the diff to only show lines within that range, with fold indicators (`⋯`) between non-contiguous sections.

   If a phase has multiple files, you can mix full files and sections:
   ```json
   "files": [
       "config/settings.yaml",
       {"path": "src/handler.py", "start": 1, "end": 30, "label": "imports & types"},
       {"path": "src/handler.py", "start": 31, "end": 95, "label": "request handling"}
   ]
   ```
   Note: avoid putting two sections of the same file in the **same** sub-phase — put them in separate sub-phases so each is a focused mental pass.

3. **Execute the breakdown immediately** — don't propose sub-phases and wait for confirmation. You are the expert at breaking down PRs; use your best judgment and go straight to updating the plan:
   - Replace the target phase with the new sub-phases at the same position
   - Renumber all subsequent phases sequentially
   - Gather evidence and write AI observations for each new sub-phase
   - Preserve the `impact_analysis` and other top-level plan fields unchanged
4. **Regenerate the HTML** using the same generate-review.py command.
5. **Tell the reviewer** the page is updated:
   - List which phases are new and what they contain
   - Note that comments on **unchanged phases** (those that kept their name) are automatically restored
   - Note that flags and inline comments on the **broken-down phase** are cleared (since the DOM structure changed) — the reviewer's original text was included in the breakdown request for reference

**Edge cases:**
- **Single-file phase**: This is the primary use case for breakdown — split the file into functions/sections using line ranges. Read the diff to identify function boundaries and create sub-phases for each.
- **Tiny phase** (1–2 files, <50 lines): Suggest it's already manageable. Ask if they'd rather merge it into an adjacent phase instead.
- **Reviewer asks verbally** (without the button): They might just type "break down phase 3" in the terminal. Handle it the same way — look up the phase in the current plan and proceed from step 2.

## Step 5: Overall summary

After all phases are reviewed, compile a summary incorporating **both** the AI's and the human's findings:

```
## Review Summary: "<PR title>" (#<number>)

### Overall Assessment
One paragraph: what this PR does well, what needs work, and overall readiness.

### Findings
| Severity | Count | Key Items |
|----------|-------|-----------|
| ❌ Issues | N | Brief list |
| ⚠️ Suggestions | N | Brief list |
| 💡 Nits | N | Brief list |
| ❓ Questions | N | Brief list |

### Recommendation
One of:
- ✅ **Approve** — Ready to merge
- ✅ **Approve with nits** — Minor items, safe to merge
- 🔄 **Request changes** — Issues need addressing
- ❓ **Needs discussion** — Questions need answers first
```

Ask the reviewer if the summary matches their assessment before posting anything.

## Step 6: Post comments (optional)

If the reviewer wants to post feedback to the PR:

```bash
# General review comment
gh pr review <number> --comment --body "Review summary text"

# Inline comment on a specific line
gh api repos/{owner}/{repo}/pulls/<number>/comments \
  -f body="Comment text" \
  -f path="file/path" \
  -F line=42 \
  -f side="RIGHT" \
  -f commit_id="$(gh pr view <number> --json headRefOid -q .headRefOid)"
```

Draft the comments based on the combined findings and let the reviewer approve them before posting. The reviewer's voice should come through — these are their review comments, not the AI's.

## Tips

- **Show your work** — every non-trivial observation should have evidence (command + output). This prevents hallucination and lets the reviewer verify your reasoning without leaving the review page. If you can't produce evidence for a claim, downgrade it to a question.
- **Do your homework before writing observations** — check module nesting, provider references, depends_on chains, and files outside the diff. False positives erode trust faster than false negatives.
- **Read the PR description first** — understand intent before judging implementation.
- **Check beyond the diff** — especially for IaC, look at files that reference changed resources but aren't in the PR. See [references/review-checklist.md](references/review-checklist.md).
- **When the reviewer corrects you, learn from it** — update observations, don't just delete them. Turn wrong observations into correct ones (e.g., "providers.tf is fine because the wrapper module handles both paths").
- **Consider the PR holistically** — individual file changes may only make sense together across phases.
- **For large PRs** — if the phases reveal unrelated concerns bundled together, suggest splitting.
- **Respect the reviewer's pace** — some phases take 30 seconds, some take 10 minutes of discussion. Don't rush.
- **Classify on merits, not on novelty** — when the reviewer asks for extra context (e.g., "compare to the backend monorepo"), the findings still need the right severity. If the comparison confirms the approach is sound, that's ✅ Looks good. If it reveals a divergence the author should reconsider, that's ⚠️ Suggestion. Don't default to ⚠️ just because you did research — the severity should reflect whether you're recommending a change.
