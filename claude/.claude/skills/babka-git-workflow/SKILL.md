---
name: babka-git-workflow
description: |
  Git workflow and pull request creation for the Babka team.
  Triggers on: create a pr, create a pull request, open a pr, commit this change, push and create pr
  Use when creating branches, committing changes, opening PRs, or updating Jira tickets in babka-osd-infra or archdruid repositories.
---

# Babka Git Workflow

Git and PR workflow for the babka-osd-infra repository.

**IMPORTANT:** This skill should be automatically invoked when the user asks to create a PR, open a pull request, commit changes, or push changes for review.

## Draft PR Policy

**ALWAYS create PRs as drafts** using `gh pr create --draft`. The user reviews all PRs personally before requesting team review. Never create a non-draft PR unless the user explicitly asks for it.

When the user is ready for team review, they will mark it ready themselves or ask you to run `gh pr ready <number>`.

## Branching Strategy

Babka uses **GitHub Flow**:

1. Create a new branch from master
2. Make commits with clear messages
3. Push and create a pull request
4. Get review and approval
5. Merge to master
6. Delete the branch

### Branch Naming

Use descriptive kebab-case names:
- `fix-k8s-bundle-alias`
- `add-historical-alerts`
- `update-broker-thresholds`

## Creating a Branch

If you've already committed to master by mistake:

```bash
# Create branch at current commit
git branch my-feature-branch

# Reset master back
git reset --hard HEAD~1

# Switch to your branch
git checkout my-feature-branch
```

If starting fresh:

```bash
git checkout -b my-feature-branch
```

## Commit Messages

Follow the existing style (lowercase, descriptive):

```
fix k8s bundle panel legends to default to cluster

- Add legend_field variable to allow bundles to override the default
- Historical bundle uses legend_field: container (exception case)

BAB-1234

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

Key points:
- First line: lowercase summary (what changed)
- Body: bullet points explaining the change
- Include Jira ticket number (BAB-XXXX)
- Include Co-Authored-By for Claude contributions

## Pull Request Template

The repo has a PR template at `.github/PULL_REQUEST_TEMPLATE.md`. Use it:

```bash
gh pr create --draft --title "short description" --body "$(cat <<'EOF'
## What changed
<!-- One sentence summary -->

## Description
<!-- Detailed description of changes -->

## Motivation and Context
https://spotify.atlassian.net/browse/BAB-XXXX

## How Has This Been Tested?
- [ ] I have applied this on a dev/staging environment
- [ ] I have executed `pre-commit run -a` on my pull request

@babka while reviewing this PR please ensure that:

- [ ] Best practices and style have been followed as established in our [Terraform Best Practices and Style Guide](https://docs.google.com/document/d/18d4EM462-EnS0GIRWNzxPswshQdF1CSoceCT5bSVGiY/edit?usp=sharing)
EOF
)"
```

### Required Sections

| Section | Purpose |
|---------|---------|
| What changed | One-sentence summary |
| Description | Detailed explanation of changes |
| Motivation and Context | Link to Jira ticket (BAB-XXXX) |
| How Has This Been Tested | Checkboxes for testing steps |

## PR Size Guidelines

**Keep PRs small and focused.** Large PRs are harder to review, riskier to merge, and more likely to introduce bugs.

### When to Split a PR

Suggest breaking up the PR if:
- More than ~200-300 lines of changes
- Changes span multiple unrelated files or concerns
- Multiple logical changes bundled together
- **AI-generated code** - always prefer smaller, incremental PRs

### How to Split

1. **By feature/concern**: Each logical change gets its own PR
2. **By layer**: Infrastructure changes separate from application changes
3. **By risk**: High-risk changes isolated from routine updates

### Benefits of Smaller PRs

- Faster, more thorough reviews
- Easier rollback if issues arise
- Clearer git history
- Reduced merge conflicts
- Quicker feedback cycles

### AI-Generated Code Warning

**IMPORTANT:** When Claude generates significant code changes, always recommend splitting into smaller PRs:

```
⚠️ This PR contains substantial AI-generated changes across multiple files.
Consider splitting into smaller, focused PRs for easier review:
- PR 1: [specific concern]
- PR 2: [specific concern]
```

This makes it easier for reviewers to verify AI-generated code and catch potential issues.

## Jira Integration

### Linking Tickets

Always include the Jira ticket URL in:
1. Commit message body
2. PR description under "Motivation and Context"

Format: `https://spotify.atlassian.net/browse/BAB-XXXX`

### Updating Ticket Status

Use the Atlassian MCP tools to update tickets:

```
# Check available transitions
mcp__atlassian__get_available_transitions(issue_key="BAB-1234")

# Transition to a new status
mcp__atlassian__edit_ticket(issue_key="BAB-1234", transition_to="In Review")
```

Common transitions:
- `In Progress` - When starting work
- `In Review` - When draft PR is marked ready for team review (NOT when first opened as draft)
- `Ready to Deploy` - When PR is approved
- `Closed` - When deployed/complete

**Note:** Since PRs are always created as drafts first, do NOT transition to "In Review" at PR creation time. The user will review the PR personally first, then ask to mark it ready and transition the Jira ticket.

## Pre-commit Hooks

The repo uses pre-commit hooks. They run automatically on commit, but you can run manually:

```bash
pre-commit run -a
```

Hooks include:
- Terraform fmt
- Terraform docs
- Terraform validate with tflint
- Autoupdate Terraform/Helm versions

## Complete Workflow Example

```bash
# 1. Create branch
git checkout -b fix-something

# 2. Make changes and commit
git add specific-files.yaml
git commit -m "$(cat <<'EOF'
fix something important

- Detail about change 1
- Detail about change 2

BAB-1234

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# 3. Push branch
git push -u origin fix-something

# 4. Create draft PR (always draft first — user reviews before requesting team review)
gh pr create --draft --title "fix something important" --body "..."

# 5. Update Jira to In Review
# (use mcp__atlassian__edit_ticket)
```

## MMA-Specific Testing

For monitoring/dashboard changes, run a dry-run preview:

```bash
docker run -v $(pwd):/build -w /build gcr.io/action-containers/mma:latest upload --yaml ./monitoring-info.yaml --dry-run
```

This validates the YAML and shows what would be deployed without actually deploying.
