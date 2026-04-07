---
name: linear-walkthrough
description: Create a linear walkthrough document of a codebase using showboat. Use this skill whenever the user asks to walk through, explain, document, or create a guided tour of a codebase, project, or specific feature/subsystem. Also use when users say things like "help me understand this code", "how does this project work", "create a code walkthrough", "give me a tour of this repo", "explain the auth flow", or "I need to get up to speed on this codebase". This is especially valuable for onboarding onto unfamiliar code, revisiting code you wrote but have forgotten, or understanding vibe-coded projects.
---

# Linear Walkthrough

Create a narrative document that walks a reader through a codebase (or part of one) step by step, interleaving explanatory commentary with real code extracted directly from the source files. The document is built using **showboat**, which ensures every code snippet shown is the actual code — extracted by shell commands, never copied by hand or hallucinated.

## Why this matters

Reading a codebase file-by-file is disorienting. A linear walkthrough imposes a narrative order — it tells the reader what to look at first, what builds on what, and why each piece exists. The reader comes away understanding the architecture, not just the syntax.

## Prerequisites

showboat is available via `uvx showboat`. No installation needed.

## Workflow

### 1. Explore the codebase

Before writing anything, understand what you're working with. Read key files, check the directory structure, look at entry points and configuration. You need a mental model of the project before you can guide someone else through it.

For a **full-project walkthrough**, map out:
- What the project does (README, package.json, setup.py, etc.)
- Entry points (main files, CLI handlers, route definitions)
- Core abstractions (key classes, modules, data models)
- How data flows through the system
- Configuration and dependencies

For a **focused walkthrough** (e.g., "walk me through the auth flow"):
- Where the feature's code path begins
- Which files are involved, in execution order
- How this feature connects to the rest of the system

### 2. Plan the narrative order

This is the most important step. Don't just go alphabetically by filename — think about what a reader needs to understand first to make sense of what comes next.

Good narrative orders often follow one of these patterns:

- **Entry-point first**: Start where execution begins, follow the call chain outward
- **Top-down**: Start with high-level architecture, then drill into each component
- **Data flow**: Follow a request/event from input to output
- **Dependency order**: Start with the pieces that have no dependencies, build up

Pick whichever pattern fits the codebase best. For focused walkthroughs, usually "follow the execution path" works well.

### 3. Build the walkthrough with showboat

Initialize the document, then alternate between commentary and code extraction. Use absolute paths for both the walkthrough file and `--workdir` to avoid ambiguity.

**Initialize:**
```bash
uvx showboat init /path/to/project/walkthrough.md "Title of Your Walkthrough"
```

Save the walkthrough in the project root. For focused walkthroughs, use a descriptive filename like `walkthrough-auth-flow.md`.

**Add commentary** to set context, explain what the reader is about to see, or connect sections:
```bash
uvx showboat note /path/to/project/walkthrough.md "## Section Title

Explanation of what this code does and why it matters."
```

For longer notes, pipe from stdin:
```bash
cat <<'NOTES' | uvx showboat note /path/to/project/walkthrough.md
## The Request Pipeline

When a request hits the server, it passes through three middleware layers
before reaching a route handler. Understanding this pipeline is key to
understanding how authentication, logging, and error handling work.
NOTES
```

**Extract and show code** using `showboat exec` with bash commands. The `--workdir` flag sets the working directory for the executed command, so file paths in your sed/cat commands are relative to it:
```bash
# Show specific lines from a file
uvx showboat exec /path/to/project/walkthrough.md bash "sed -n '10,35p' src/server.py" --workdir /path/to/project

# Show an entire short file
uvx showboat exec /path/to/project/walkthrough.md bash "cat config/settings.py" --workdir /path/to/project

# Show the project structure
uvx showboat exec /path/to/project/walkthrough.md bash "tree src -I '__pycache__|node_modules|.git' --noreport" --workdir /path/to/project

# Show first N lines (useful for imports and module-level setup)
uvx showboat exec /path/to/project/walkthrough.md bash "head -n 25 src/models.py" --workdir /path/to/project
```

**If a command fails or you show the wrong snippet**, undo and retry:
```bash
uvx showboat pop /path/to/project/walkthrough.md
```

### 4. Code extraction patterns

**Line-number ranges are the most reliable approach** — read the file first to find the right lines, then extract:

```bash
# Lines 10-35 (most common pattern — precise and predictable)
sed -n '10,35p' file.py
```

Pattern-based extraction is useful when you know the structure but not the exact line numbers:

```bash
# A Python function
sed -n '/^def authenticate/,/^[^ ]/p' file.py | head -n -1

# A TypeScript/Go/Rust function or block
sed -n '/^function handleAuth/,/^}/p' handler.ts

# A class definition
sed -n '/^class UserModel/,/^class \|^def \|^[^ ]/p' models.py | head -n -1
```

Use `cat` for short files (under ~60 lines). Use `head -n` when you only need the top of a file (imports, configuration). Use `tree` to show project structure.

### 5. Commentary style

Good walkthrough commentary:

- **Introduces before showing**: Tell the reader what they're about to see and why it matters before the code block
- **Highlights key lines**: After a code block, call out the important parts ("Line 14 is where the token gets validated — notice it checks both expiry and signature")
- **Connects the dots**: Explain how this piece relates to what came before ("This `UserService` class is what the route handler from the previous section calls")
- **Keeps moving**: Don't explain every line. Focus on what's architecturally significant or non-obvious
- **Uses section headings**: Break the walkthrough into logical sections with `##` headings

### 6. Structural template

A typical full-project walkthrough follows this shape:

1. **Overview note** — What the project does, its main technologies, and how it's organized
2. **Project structure** — `tree` or `find` showing the file layout
3. **Entry point** — The main file where execution begins
4. **Core abstractions** — Key classes, types, or modules the project is built around
5. **Feature walkthrough** — Walk through 1-2 key features end-to-end
6. **Configuration & dependencies** — How the project is configured
7. **Wrapup** — Summary of the key architectural patterns and any notable design decisions

For focused walkthroughs, skip straight to the relevant code path and only include enough context to make the flow understandable.

### 7. After building the walkthrough

Optionally verify the document still works:
```bash
uvx showboat verify /path/to/project/walkthrough.md --workdir /path/to/project
```

This re-runs all the code blocks and checks that their outputs still match. Useful if the codebase has changed since the walkthrough was created.

Tell the user where the walkthrough file is and suggest they open it — it's a standard markdown file that renders nicely in any viewer.

## Tips

- **Be selective about what to show.** A walkthrough of a 50-file project doesn't need to show all 50 files. Show the architecturally significant ones and mention the rest in commentary.
- **Use line ranges generously.** Showing 15 focused lines is almost always better than showing 100 lines of a file. The reader can always open the file if they want more context.
- **Follow execution order for features.** When walking through a specific flow (like "what happens when a user logs in"), follow the actual execution path rather than organizing by file.
- **Name the walkthrough file descriptively.** `walkthrough.md` for a full project tour, `walkthrough-auth.md` for the auth system, etc.
