# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Claude Code skill for creating Jira tickets in the **BAB** (Babka) and **DATAREPO** (Data Monorepo Taskforce) projects. The skill is invoked when users ask to create Jira tickets, issues, tasks, stories, bugs, or epics for Babka team work or Data Monorepo taskforce work.

## Key Constraints

- **Use ADF formatting**: Jira Cloud requires Atlassian Document Format (ADF) for rich text. Plain text and wiki markup do not render properly.
- **Project key**: Use "BAB" for Babka work, "DATAREPO" for Data Monorepo Taskforce work. Default to "BAB" when unspecified.
- **DATAREPO is Kanban**: No sprints — never set the `sprint` field on DATAREPO tickets. Transitions are free-form (any status → any status). Statuses: Backlog, To Do, In Progress, In Review, Closed, Cancelled.
- **Use advanced API**: Must use `mcp__atlassian__create_ticket_advanced` with `raw_fields` to pass ADF.
- **Issue linking**: The `edit_ticket` tool does not support adding issue links directly - dependencies must be noted in ticket descriptions.
- **Assign on transition**: When transitioning tickets to "In Progress", "In Review", "Done", etc., assign the ticket if it's unassigned. Assign to the person doing the work.

## Required MCP Tool

This skill uses `mcp__atlassian__create_ticket_advanced` with these parameters:
- `project_key`: "BAB" or "DATAREPO"
- `issue_type`: "Task" | "Epic" | "Bug" | "Story" | "Spike" (+ "Test" for DATAREPO only)
- `summary`: Brief title
- `description`: Short fallback text
- `raw_fields`: JSON string containing ADF description structure

## ADF Structure

```json
{
  "description": {
    "type": "doc",
    "version": 1,
    "content": [
      {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Section"}]},
      {"type": "paragraph", "content": [{"type": "text", "text": "Content here."}]},
      {"type": "bulletList", "content": [
        {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Item"}]}]}
      ]}
    ]
  }
}
```

Key node types: `heading`, `paragraph`, `bulletList`, `orderedList`, `codeBlock`, `listItem`
Text marks: `strong` (bold), `em` (italic), `code` (inline code), `link`
