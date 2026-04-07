# BAB Jira Skill for Claude Code

A Claude Code skill for creating Jira tickets in the BAB (Babka) project with proper rich text formatting.

## Installation

Add this skill to your Claude Code configuration:

```bash
# Clone to your skills directory
git clone git@ghe.spotify.net:holocron/babka-jira-skill.git ~/.claude/skills/bab-jira
```

Or add it as a managed skill in your Claude Code settings.

## Usage

Once installed, you can ask Claude Code to create Jira tickets naturally:

- "Create a BAB ticket for updating the Terraform module"
- "Make a bug ticket in BAB for the failing pipeline"
- "Create an epic for the Q1 infrastructure work"

The skill automatically:
- Uses the correct BAB project key
- Formats descriptions using Atlassian Document Format (ADF) for proper rendering
- Supports Task, Epic, Bug, Story, and Spike issue types
- Renders headings, bullet lists, code blocks, bold/italic text, and links

## Examples

```
Create a BAB task to update the GKE node pool configuration.
It should cover:
- Updating machine types
- Adjusting autoscaling limits
- Testing in staging first
```

```
Create a BAB bug: Pipeline fails on terraform plan when VPC module has no subnets defined
```

## Requirements

- Claude Code with the Atlassian MCP server configured
- Access to the BAB Jira project

## Technical Details

This skill uses `mcp__atlassian__create_ticket_advanced` with the `raw_fields` parameter to pass Atlassian Document Format (ADF) JSON. This is required because:

- Jira Cloud API v3 uses ADF for rich text content
- The basic `create_ticket` tool only sends plain text strings
- Wiki markup and Markdown are not rendered by Jira Cloud

See `SKILL.md` for the full ADF specification and examples.

## Contributing

1. Clone the repo
2. Make changes to `SKILL.md`
3. Test locally by placing in `~/.claude/skills/bab-jira/`
4. Submit a PR
