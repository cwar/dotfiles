# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is a **Claude Code skill** that teaches Claude the Babka team's git workflow, PR conventions, and Jira integration patterns. The skill is invoked when users need help with git operations in the babka-osd-infra repository.

## Skill Structure

- `SKILL.md` - The skill definition file containing:
  - Frontmatter with `name` and `description` for skill discovery
  - Instructions Claude follows when the skill is active

## Editing the Skill

When modifying SKILL.md:

1. **Frontmatter** - Keep the description concise but comprehensive enough for Claude to match user intent
2. **Instructions** - Write as if instructing another Claude instance; be explicit about conventions
3. **Examples** - Include copy-paste-ready command examples with HEREDOC patterns for multi-line content
4. **Tables** - Use for structured reference data (like PR template sections)

## Key Conventions This Skill Enforces

- GitHub Flow branching (feature branches from master)
- Kebab-case branch names
- Lowercase commit messages with bullet-point bodies
- BAB-XXXX Jira ticket references in commits and PRs
- Co-Authored-By attribution for Claude contributions
- PR template usage with specific required sections
