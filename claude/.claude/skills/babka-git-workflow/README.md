# Babka Git Workflow Skill

A [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) that teaches Claude the Babka team's git workflow, PR conventions, and Jira integration patterns.

## What This Skill Does

When invoked, this skill instructs Claude on:

- **GitHub Flow** branching strategy (feature branches from master)
- **Branch naming** conventions (kebab-case descriptive names)
- **Commit message** format (lowercase, bullet points, Jira references)
- **Pull request** creation using the team's PR template
- **Jira integration** via Atlassian MCP tools
- **Pre-commit hooks** for Terraform validation

## Installation

This skill is installed in `~/.claude/skills/babka-git-workflow/`. Claude Code automatically discovers skills in this directory.

## Usage

The skill activates automatically when you ask Claude for help with:
- Creating branches or commits in babka-osd-infra
- Opening pull requests
- Updating Jira tickets

You can also invoke it directly:
```
/babka-git-workflow
```

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill definition with instructions for Claude |
| `CLAUDE.md` | Guidance for maintaining this skill |
| `README.md` | This file |

## Related

- [babka-osd-infra](https://ghe.spotify.net/holocron/babka-osd-infra) - The main infrastructure repo this skill supports
- [Terraform Best Practices](https://docs.google.com/document/d/18d4EM462-EnS0GIRWNzxPswshQdF1CSoceCT5bSVGiY/edit) - Babka style guide
