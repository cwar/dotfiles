# User-Level Instructions

## Coding Workflow — Red-Green TDD by Default

When working on any coding task — unless the user explicitly specifies a different workflow — follow **Red-Green-Refactor TDD**:

1. **Red**: Write a failing test first that captures the expected behavior.
2. **Green**: Write the minimum code to make the test pass.
3. **Refactor**: Clean up the implementation while keeping tests green.

Apply this iteratively for each incremental piece of functionality. If the project already has a test framework configured, use it. If not, ask the user which framework to set up before proceeding.

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

### Workflow integration

- When creating an ADR, mention it in the commit message (e.g., `feat: add PostgreSQL persistence (ADR-003)`).
- If a decision **supersedes** a previous ADR, update the old one's status to `Superseded by [NNN]`.
- When reviewing a codebase and encountering undocumented architectural decisions, **proactively suggest** writing retroactive ADRs to capture tribal knowledge.
