# PR Review Conversation and Publication

Load this reference only after the initial review artifact exists and the reviewer returns with feedback, requests a phase breakdown, completes the review, or asks to publish comments.

## Handle the review conversation

The reviewer works through the HTML at their own pace. They'll come back in one of three ways:

### Path A: Stop and discuss (flagged items)

The reviewer pastes flagged items mid-review. This means they think the AI got something wrong, or need clarification before continuing.

1. **Read the flagged items carefully** — the reviewer is correcting you or asking you to dig deeper.
2. **Investigate with evidence** — run real commands to verify. The reviewer may be right (and often is — they know the codebase better). Gather new evidence to support the corrected understanding.
3. **Acknowledge corrections honestly** — if you were wrong, say so and explain what you misunderstood.
4. **Update the plan JSON** with corrected observations and fresh evidence. Turn wrong observations into correct ones backed by shell command output.
5. **Add a top-level `note` artifact titled `Prior inline feedback answers`** whenever the reviewer pasted inline comments or prior flagged observations. Explicitly answer every pasted comment, including whether it was resolved by a code change, resolved by explanation, left unresolved for follow-up, or intentionally not changed. Treat answered items as resolved in the refreshed review; do not keep presenting them as open unless they still require action. If the UI supports hiding or resolving prior comments, mark answered comments resolved; otherwise this note is the source of truth.
6. **Regenerate the HTML** — comments and unflagged items persist in localStorage. Updated evidence and prior-feedback answers will reflect the corrected understanding.
7. Tell the reviewer the page is updated and call out any unresolved comments.

### Path B: Full feedback (review complete)

Proceed to the overall summary below.

### Path C: Break down a phase

1. Read the pasted phase number, name, files, and existing comments.
2. Break files down by function or logical section using new-file line ranges:

   ```json
   "files": [{"path": "src/handler.py", "start": 15, "end": 67, "label": "parse_request()"}]
   ```

   Use individual functions, logical sections, or related changed blocks. Follow reviewer guidance. Avoid putting two sections of the same file in the same sub-phase.
3. Execute immediately:
   - Replace the target phase with focused sub-phases at the same position.
   - Renumber later phases.
   - Gather evidence and write observations for each new sub-phase.
   - Preserve top-level fields such as `impact_analysis`.
4. Regenerate with the documented generator command.
5. Tell the reviewer which phases are new. Comments on unchanged phase names are restored; flags and inline comments on the broken-down phase are cleared because its DOM changed.

Edge cases:
- Split a large single-file phase by functions or sections.
- If the phase is already 1–2 files and under 50 lines, suggest merging it with an adjacent phase instead.
- Handle verbal requests such as “break down phase 3” the same way.

## Overall summary

After all phases are reviewed, compile both AI and human findings:

```markdown
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
- ✅ **Approve** — Ready to merge
- ✅ **Approve with nits** — Minor items, safe to merge
- 🔄 **Request changes** — Issues need addressing
- ❓ **Needs discussion** — Questions need answers first
```

Ask whether the summary matches the reviewer's assessment before posting anything.

## Post comments only after approval

Draft comments in the reviewer's voice and obtain explicit approval immediately before posting.

```bash
gh pr review <number> --comment --body "Review summary text"

gh api repos/{owner}/{repo}/pulls/<number>/comments \
  -f body="Comment text" \
  -f path="file/path" \
  -F line=42 \
  -f side="RIGHT" \
  -f commit_id="$(gh pr view <number> --json headRefOid -q .headRefOid)"
```

## Ongoing review rules

- Use backticks around code identifiers and paths.
- Back every non-trivial observation with evidence; downgrade unsupported claims to questions.
- Check beyond the diff where references, module boundaries, or resource consumers matter.
- Update wrong observations when corrected; do not merely delete them.
- Consider the PR holistically and suggest splitting unrelated concerns in large PRs.
- Classify findings on merits, not on the amount of research performed.
- Respect the reviewer's pace.
