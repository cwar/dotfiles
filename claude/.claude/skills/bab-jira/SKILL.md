---
name: bab-jira
description: Create and manage Jira tickets in the BAB (Babka) or DATAREPO (Data Monorepo Taskforce) projects. Use when the user asks to create Jira tickets, issues, tasks, stories, bugs, or epics for Babka team work or Data Monorepo taskforce work. Uses Atlassian Document Format (ADF) for rich text formatting.
---

# Jira Ticket Creation

Create tickets in BAB or DATAREPO Jira projects using the `mcp__atlassian__create_ticket_advanced` tool with ADF formatting.

## Supported Projects

### BAB (Babka) — Scrum
- Project key: BAB
- Board type: Scrum (sprint-based)
- Issue types: Task, Epic, Bug, Story, Spike, Sub-task
- Use for: Babka team work

### DATAREPO (Data Monorepo Taskforce) — Kanban
- Project key: DATAREPO
- Board type: Kanban (no sprints, continuous flow)
- Issue types: Task, Epic, Bug, Story, Spike, Sub-task, Test
- Statuses: Backlog → To Do → In Progress → In Review → Closed | Cancelled
- Transitions: Any status can move to any other status (Kanban-style)
- Use for: Data monorepo taskforce work
- **Do not set the `sprint` field** on DATAREPO tickets

## Project Selection

Determine which project to use based on context:
- If the user mentions "data monorepo", "datarepo", "data repo", or "taskforce" → use **DATAREPO**
- If the user mentions "babka", "bab", or no specific project → use **BAB** (default)
- When ambiguous, ask the user which project the ticket belongs to

## Creating Tickets

Use `mcp__atlassian__create_ticket_advanced` with:
- `project_key`: "BAB" or "DATAREPO" (see Project Selection above)
- `issue_type`: "Task", "Epic", "Bug", "Story", "Spike", or "Test" (DATAREPO only)
- `summary`: Brief title
- `description`: Short fallback text
- `raw_fields`: JSON object containing ADF description (see below)

## ADF (Atlassian Document Format)

The description must be passed in `raw_fields` as ADF JSON. Structure:

```json
{
  "description": {
    "type": "doc",
    "version": 1,
    "content": [...]
  }
}
```

### ADF Node Types

**Heading** (levels 1-6):
```json
{
  "type": "heading",
  "attrs": {"level": 2},
  "content": [{"type": "text", "text": "Section Title"}]
}
```

**Paragraph**:
```json
{
  "type": "paragraph",
  "content": [{"type": "text", "text": "Regular paragraph text."}]
}
```

**Bold/Italic** (use marks array):
```json
{
  "type": "paragraph",
  "content": [
    {"type": "text", "text": "Bold text", "marks": [{"type": "strong"}]},
    {"type": "text", "text": " and "},
    {"type": "text", "text": "italic text", "marks": [{"type": "em"}]}
  ]
}
```

**Bullet List**:
```json
{
  "type": "bulletList",
  "content": [
    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "First item"}]}]},
    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Second item"}]}]}
  ]
}
```

**Numbered List**:
```json
{
  "type": "orderedList",
  "content": [
    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Step one"}]}]},
    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Step two"}]}]}
  ]
}
```

**Code Block**:
```json
{
  "type": "codeBlock",
  "attrs": {"language": "python"},
  "content": [{"type": "text", "text": "def hello():\n    print('world')"}]
}
```

**Inline Code**:
```json
{"type": "text", "text": "variable_name", "marks": [{"type": "code"}]}
```

**Link**:
```json
{
  "type": "text",
  "text": "Link Text",
  "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}]
}
```

## Complete Example

```json
{
  "description": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Summary"}]
      },
      {
        "type": "paragraph",
        "content": [{"type": "text", "text": "Brief description of the work to be done."}]
      },
      {
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Details"}]
      },
      {
        "type": "bulletList",
        "content": [
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "First requirement"}]}]},
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Second requirement"}]}]}
        ]
      },
      {
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Acceptance Criteria"}]
      },
      {
        "type": "bulletList",
        "content": [
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Criteria one"}]}]},
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Criteria two"}]}]}
        ]
      }
    ]
  }
}
```

## Linking Tickets

The `edit_ticket` tool does not support adding issue links directly. Reference dependencies in descriptions:

```json
{
  "type": "heading",
  "attrs": {"level": 2},
  "content": [{"type": "text", "text": "Dependencies"}]
},
{
  "type": "bulletList",
  "content": [
    {"type": "listItem", "content": [{"type": "paragraph", "content": [
      {"type": "text", "text": "Blocked by "},
      {"type": "text", "text": "BAB-1234", "marks": [{"type": "strong"}]},
      {"type": "text", "text": " or "},
      {"type": "text", "text": "DATAREPO-56", "marks": [{"type": "strong"}]},
      {"type": "text", "text": ": Description of blocker"}
    ]}]}
  ]
}
```

## Adding to Epics

To link a ticket to an epic, include the parent in raw_fields:

```json
{
  "description": { ... },
  "parent": {"key": "BAB-1234"}
}
```

Or for DATAREPO:
```json
{
  "description": { ... },
  "parent": {"key": "DATAREPO-56"}
}
```

## Transitioning Tickets

Use `mcp__atlassian__edit_ticket` to update ticket status and other fields.

### Board-Specific Behavior

- **BAB (Scrum)**: Transitions may be constrained by the board workflow. Always check available transitions first.
- **DATAREPO (Kanban)**: Any status can transition to any other status. Valid statuses: Backlog, To Do, In Progress, In Review, Closed, Cancelled.

### Assignment Rules

**When transitioning a ticket, check if it's unassigned and assign appropriately:**

- **To "In Progress"**: Assign to the person starting the work (usually the current user)
- **To "In Review"**: Keep assigned to the implementer, or assign to reviewer if known
- **To "Done"/"Closed"**: Keep assigned to whoever completed the work

Use `mcp__atlassian__edit_ticket` with:
- `issue_key`: The ticket key (e.g., "BAB-1234")
- `transition_to`: Target status (e.g., "In Progress", "Done")
- `assignee`: User's Atlassian account ID or email

### Examples: Start Working on a Ticket

```
mcp__atlassian__edit_ticket(
  issue_key="BAB-1234",
  transition_to="In Progress",
  assignee="user@spotify.com"
)
```

```
mcp__atlassian__edit_ticket(
  issue_key="DATAREPO-56",
  transition_to="In Progress",
  assignee="user@spotify.com"
)
```

### Getting Available Transitions

Use `mcp__atlassian__get_available_transitions` to see valid status transitions for a ticket before attempting to transition it.
