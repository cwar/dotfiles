#!/usr/bin/env python3
"""
Generate an interactive HTML review page for a phased PR review.

Usage:
    python generate-review.py --diff <diff-file> --plan <plan-json> --output <output-html>

The plan JSON structure:
{
    "title": "PR title",
    "number": 874,
    "author": "username",
    "base": "master",
    "head": "feature-branch",
    "additions": 36,
    "deletions": 4,
    "changed_files": 7,
    "description": "What this PR does",
    "url": "https://...",
    "phases": [
        {
            "name": "Phase Name",
            "files": [
                "path/to/file1",
                {"path": "path/to/big_file.py", "start": 10, "end": 50, "label": "helper functions"}
            ],
            "description": "Why these files are grouped",
            "ai_notes": [
                {"severity": "issue", "text": "Something important"},
                {"severity": "suggestion", "text": "Consider this", "evidence": [
                    {"command": "grep -n 'pattern' path/to/file", "output": "42: matching line"}
                ]},
                {"severity": "nit", "text": "Minor thing"},
                {"severity": "good", "text": "This looks solid"},
                {"severity": "question", "text": "Why is this done?"}
            ]
        }
    ]
}

Evidence fields are optional. When present, each evidence item contains the shell
command that was run and its output. This ensures observations about code — especially
code outside the diff — are grounded in real extracted snippets, not AI recollection.

Artifacts are optional supplemental materials — diagrams, references, and contextual
notes — that help the reviewer understand the change without reading every line.
Supported artifact types:
  - "diagram": Mermaid diagram (rendered via mermaid.js)
  - "reference": Link to related resource (PR, doc, ADR, Slack thread)
  - "note": Contextual explanation (background, domain knowledge, gotchas)

Artifacts can appear at the top level (shown in a dedicated Context tab) or per-phase
(shown inline within the phase). Both are optional.

Example:
{
    "artifacts": [
        {
            "type": "diagram",
            "title": "Module dependency graph",
            "content": "graph LR\n  A --> B\n  B --> C"
        },
        {
            "type": "reference",
            "title": "Related ADR",
            "url": "https://...",
            "description": "ADR-003 explains the persistence choice"
        },
        {
            "type": "note",
            "title": "Background",
            "content": "This service was originally a monolith..."
        }
    ]
}
"""

import argparse
import base64
import json
import html
import re
import subprocess
import sys
import os
from pathlib import Path


def parse_diff(diff_text: str) -> dict[str, str]:
    """Parse a unified diff into a dict of filepath -> diff_content."""
    files = {}
    current_file = None
    current_lines = []

    for line in diff_text.splitlines():
        if line.startswith("diff --git"):
            if current_file:
                files[current_file] = "\n".join(current_lines)
            match = re.search(r"b/(.+)$", line)
            current_file = match.group(1) if match else None
            current_lines = [line]
        elif current_file is not None:
            current_lines.append(line)

    if current_file:
        files[current_file] = "\n".join(current_lines)

    return files


def normalize_file_entry(entry) -> tuple:
    """Normalize a file list entry to (path, start_line, end_line, label).

    Files in a phase can be specified as:
    - A string: "path/to/file.py" (full file)
    - A dict: {"path": "path/to/file.py", "start": 10, "end": 50, "label": "..."} (section)
    """
    if isinstance(entry, str):
        return (entry, None, None, None)
    return (entry["path"], entry.get("start"), entry.get("end"), entry.get("label"))


def fetch_file_content(file_path: str, repo_dir: str = None, head_sha: str = None) -> str | None:
    """Try to fetch content for a file missing from the diff.

    Uses git show with the PR head SHA first (most accurate), then falls back
    to reading from the working tree.  Returns None when the file cannot be
    retrieved by any method.
    """
    # Try git show <sha>:<path> — gets content from the exact PR commit
    if head_sha and repo_dir:
        try:
            result = subprocess.run(
                ['git', 'show', f'{head_sha}:{file_path}'],
                capture_output=True, text=True, cwd=repo_dir, timeout=10,
            )
            if result.returncode == 0:
                return result.stdout
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    # Fall back to reading the file from the working tree
    if repo_dir:
        full_path = os.path.join(repo_dir, file_path)
        try:
            with open(full_path, 'r') as f:
                return f.read()
        except (OSError, UnicodeDecodeError):
            pass

    return None


def generate_synthetic_diff(file_path: str, content: str) -> str:
    """Generate a synthetic unified diff showing a new file with all content as additions."""
    lines = content.splitlines()
    diff_lines = [
        f"diff --git a/{file_path} b/{file_path}",
        "new file mode 100644",
        "--- /dev/null",
        f"+++ b/{file_path}",
        f"@@ -0,0 +1,{len(lines)} @@",
    ]
    for line in lines:
        diff_lines.append(f"+{line}")
    return "\n".join(diff_lines)


def count_diff_stats(diff_text: str, filter_start: int = None, filter_end: int = None) -> tuple[int, int]:
    """Count additions and deletions, optionally filtered to a new-file line range."""
    if not diff_text:
        return (0, 0)
    if filter_start is None or filter_end is None:
        adds = sum(1 for l in diff_text.splitlines() if l.startswith("+") and not l.startswith("+++"))
        dels = sum(1 for l in diff_text.splitlines() if l.startswith("-") and not l.startswith("---"))
        return (adds, dels)

    adds = 0
    dels = 0
    new_line = 0
    for raw_line in diff_text.splitlines():
        if raw_line.startswith("@@"):
            match = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', raw_line)
            if match:
                new_line = int(match.group(2))
            continue
        if raw_line.startswith("+++") or raw_line.startswith("---") or \
           raw_line.startswith("diff --git") or raw_line.startswith("index ") or \
           raw_line.startswith("new file mode") or raw_line.startswith("deleted file mode") or \
           raw_line.startswith("old mode") or raw_line.startswith("new mode") or \
           raw_line.startswith("similarity index") or raw_line.startswith("rename from") or \
           raw_line.startswith("rename to"):
            continue
        effective_new = new_line
        if raw_line.startswith("+"):
            if filter_start <= effective_new <= filter_end:
                adds += 1
            new_line += 1
        elif raw_line.startswith("-"):
            if filter_start <= effective_new <= filter_end:
                dels += 1
        else:
            new_line += 1

    return (adds, dels)


# ── Syntax highlighting helpers ────────────────────────────────────────────

EXTENSION_TO_HLJS_LANG = {
    '.py': 'python',
    '.pyi': 'python',
    '.java': 'java',
    '.tf': 'terraform',
    '.tfvars': 'terraform',
    '.hcl': 'terraform',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.jsx': 'javascript',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.json': 'json',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.html': 'xml',
    '.xml': 'xml',
    '.sql': 'sql',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.swift': 'swift',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.r': 'r',
    '.R': 'r',
    '.md': 'markdown',
    '.lua': 'lua',
    '.php': 'php',
    '.pl': 'perl',
    '.pm': 'perl',
    '.scala': 'scala',
    '.toml': 'ini',
    '.ini': 'ini',
    '.cfg': 'ini',
    '.gradle': 'groovy',
    '.groovy': 'groovy',
    '.dart': 'dart',
    '.m': 'objectivec',
    '.mm': 'objectivec',
    '.makefile': 'makefile',
    '.mk': 'makefile',
    '.dockerfile': 'dockerfile',
    '.nginx': 'nginx',
    # Starlark / Bazel (Python-like)
    '.bzl': 'python',
    '.bazel': 'python',
    '.star': 'python',
    '.sky': 'python',
    # Additional languages
    '.proto': 'protobuf',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.cmake': 'cmake',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.hs': 'haskell',
    '.clj': 'clojure',
    '.cljs': 'clojure',
    '.cljc': 'clojure',
    '.el': 'lisp',
    '.lisp': 'lisp',
    '.vim': 'vim',
    '.nix': 'nix',
    '.ps1': 'powershell',
    '.psm1': 'powershell',
    '.bat': 'dos',
    '.cmd': 'dos',
    '.vhd': 'vhdl',
    '.vhdl': 'vhdl',
    '.tex': 'latex',
    '.sbt': 'scala',
    '.jl': 'julia',
    '.ml': 'ocaml',
    '.mli': 'ocaml',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',
    '.cr': 'crystal',
    '.nim': 'nim',
    '.elm': 'elm',
    '.vue': 'xml',
    '.svelte': 'xml',
    '.hbs': 'handlebars',
    '.mustache': 'handlebars',
    '.erb': 'erb',
    '.haml': 'haml',
    '.coffee': 'coffeescript',
    '.ada': 'ada',
    '.adb': 'ada',
    '.f90': 'fortran',
    '.f95': 'fortran',
    '.f03': 'fortran',
    '.tcl': 'tcl',
    '.v': 'verilog',
    '.sv': 'verilog',
}

# Special filename matches (no extension)
FILENAME_TO_HLJS_LANG = {
    'Makefile': 'makefile',
    'Dockerfile': 'dockerfile',
    'Jenkinsfile': 'groovy',
    'BUILD': 'python',
    'BUILD.bazel': 'python',
    'WORKSPACE': 'python',
    'WORKSPACE.bazel': 'python',
    'MODULE.bazel': 'python',
    'Vagrantfile': 'ruby',
    'Gemfile': 'ruby',
    'Rakefile': 'ruby',
    'CMakeLists.txt': 'cmake',
    '.bashrc': 'bash',
    '.bash_profile': 'bash',
    '.zshrc': 'bash',
    '.gitignore': 'plaintext',
    'Cargo.toml': 'ini',
    'go.mod': 'go',
    'go.sum': 'plaintext',
}


def get_hljs_language(filepath: str) -> str:
    """Map a file path to the highlight.js language name, or '' if unknown."""
    basename = os.path.basename(filepath)
    if basename in FILENAME_TO_HLJS_LANG:
        return FILENAME_TO_HLJS_LANG[basename]
    ext = os.path.splitext(filepath)[1]
    if not ext:
        return ''
    return EXTENSION_TO_HLJS_LANG.get(ext.lower(), '')


MARKDOWN_EXTENSIONS = {'.md', '.mdx', '.markdown', '.mdown', '.mkd'}


def is_markdown_file(filepath: str) -> bool:
    """Check if a file is a markdown file that supports rich preview."""
    ext = os.path.splitext(filepath)[1].lower()
    return ext in MARKDOWN_EXTENSIONS


def render_diff_html(diff_text: str, file_path: str, phase_num: int,
                     filter_start: int = None, filter_end: int = None) -> str:
    """Render a unified diff as syntax-highlighted HTML with interactive line gutters.

    Parses @@ hunk headers to track real old/new file line numbers and embeds
    them as data-old-line / data-new-line attributes on each diff line row.

    When filter_start/filter_end are provided (new-file line numbers), only
    diff lines whose effective new-file position falls within [filter_start,
    filter_end] are rendered. Deleted lines use the current new_line position
    (they're "at" the point where old content was removed). This enables
    function-by-function review of large files.
    """
    filtering = filter_start is not None and filter_end is not None
    lines = []
    line_idx = 0
    old_line = 0
    new_line = 0
    pending_hunk = None
    any_emitted = False
    gap_since_last = False

    for raw_line in diff_text.splitlines():
        escaped = html.escape(raw_line)
        if raw_line.startswith("diff --git") or raw_line.startswith("index "):
            continue
        elif raw_line.startswith("new file mode") or raw_line.startswith("deleted file mode") or \
             raw_line.startswith("old mode") or raw_line.startswith("new mode") or \
             raw_line.startswith("similarity index") or raw_line.startswith("rename from") or \
             raw_line.startswith("rename to"):
            if not filtering:
                lines.append(f'<div class="diff-meta">{escaped}</div>')
            continue
        elif raw_line.startswith("+++") or raw_line.startswith("---"):
            if not filtering:
                lines.append(f'<div class="diff-meta">{escaped}</div>')
            continue
        elif raw_line.startswith("@@"):
            match = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', raw_line)
            if match:
                old_line = int(match.group(1))
                new_line = int(match.group(2))
            if filtering:
                pending_hunk = f'<div class="diff-hunk">{escaped}</div>'
            else:
                lines.append(f'<div class="diff-hunk">{escaped}</div>')
            continue

        # For filtering: check if this line's effective new-file position
        # falls within the requested range. All line types use new_line
        # as the effective position — deleted lines are "at" the current
        # new_line since they don't advance it.
        if filtering:
            effective_new = new_line
            if not (filter_start <= effective_new <= filter_end):
                if raw_line.startswith("+"):
                    new_line += 1
                elif raw_line.startswith("-"):
                    old_line += 1
                else:
                    old_line += 1
                    new_line += 1
                if any_emitted:
                    gap_since_last = True
                continue

        # Emit fold indicator between non-contiguous visible sections
        if gap_since_last:
            lines.append('<div class="diff-fold">⋯ ⋯ ⋯</div>')
            gap_since_last = False

        # Emit buffered hunk header (only when the hunk has visible lines)
        if pending_hunk:
            lines.append(pending_hunk)
            pending_hunk = None

        if raw_line.startswith("+"):
            css_class = "diff-add"
            old_ln_display = ""
            new_ln_display = str(new_line)
            data_attrs = f'data-new-line="{new_line}"'
            new_line += 1
        elif raw_line.startswith("-"):
            css_class = "diff-del"
            old_ln_display = str(old_line)
            new_ln_display = ""
            data_attrs = f'data-old-line="{old_line}"'
            old_line += 1
        else:
            css_class = "diff-ctx"
            old_ln_display = str(old_line)
            new_ln_display = str(new_line)
            data_attrs = f'data-old-line="{old_line}" data-new-line="{new_line}"'
            old_line += 1
            new_line += 1
        # Wrap the diff prefix char (+/-/space) in a span for coloring
        if len(escaped) > 0:
            prefix_char = escaped[0]
            rest = escaped[1:]
            code_html = f'<span class="diff-prefix">{prefix_char}</span>{rest}'
        else:
            code_html = escaped
        lines.append(
            f'<div class="diff-line-row {css_class}" data-lidx="{line_idx}" {data_attrs}>'
            f'<div class="diff-ln diff-ln-old">{old_ln_display}</div>'
            f'<div class="diff-ln diff-ln-new">{new_ln_display}</div>'
            f'<div class="diff-gutter"></div>'
            f'<div class="diff-code">{code_html}</div>'
            f'</div>'
        )
        line_idx += 1
        any_emitted = True
    return "\n".join(lines)


SEVERITY_MAP = {
    "issue": ("❌", "Issue", "#ff6b6b"),
    "suggestion": ("⚠️", "Suggestion", "#ffa94d"),
    "nit": ("💡", "Nit", "#74c0fc"),
    "good": ("✅", "Looks good", "#69db7c"),
    "question": ("❓", "Question", "#da77f2"),
}


def format_inline_code(escaped_text: str) -> str:
    """Convert backtick-delimited spans to <code> tags in already-escaped HTML.

    Handles `single backtick` inline code. The input must already be
    html.escape()'d so the backtick content is safe to wrap in tags.
    """
    return re.sub(r'`([^`]+)`', r'<code>\1</code>', escaped_text)


def render_evidence(evidence_list: list[dict], note_id: str) -> str:
    """Render evidence blocks (command + output) for an AI observation."""
    if not evidence_list:
        return ""
    evidence_id = f"{note_id}-evidence"
    items = []
    for i, ev in enumerate(evidence_list):
        cmd = html.escape(ev.get("command", ""))
        output = html.escape(ev.get("output", ""))
        items.append(
            f'<div class="evidence-item">'
            f'<div class="evidence-cmd"><span class="evidence-prompt">$</span> {cmd}</div>'
            f'<div class="evidence-output">{output}</div>'
            f'</div>'
        )
    return (
        f'<div class="evidence-toggle">'
        f'<button class="evidence-btn" onclick="toggleEvidence(\'{evidence_id}\')">'
        f'📎 Evidence ({len(evidence_list)})</button>'
        f'</div>'
        f'<div class="evidence-block" id="{evidence_id}" style="display:none">'
        + "\n".join(items)
        + f'</div>'
    )


def render_ai_notes(notes: list[dict], phase_num: int) -> str:
    if not notes:
        return ""
    items = []
    for idx, note in enumerate(notes):
        sev = note.get("severity", "suggestion")
        icon, label, color = SEVERITY_MAP.get(sev, ("💬", "Note", "#adb5bd"))
        text_escaped = html.escape(note["text"])
        text_display = format_inline_code(text_escaped)
        note_id = f"ai-note-{phase_num}-{idx}"
        evidence_html = render_evidence(note.get("evidence", []), note_id)
        has_evidence_class = " has-evidence" if note.get("evidence") else ""
        items.append(
            f'<div class="ai-note{has_evidence_class}" id="{note_id}" style="border-left-color: {color}" data-phase="{phase_num}" data-severity="{sev}" data-text="{text_escaped}">'
            f'<div class="ai-note-content">'
            f'<span class="ai-note-label" style="color: {color}">{icon} {label}</span> '
            f'{text_display}'
            f'{evidence_html}'
            f'</div>'
            f'<button class="flag-btn" onclick="toggleFlag(\'{note_id}\')" title="Flag for discussion">🚩</button>'
            f'</div>'
        )
    return "\n".join(items)


def render_risk_badge(risk: str) -> str:
    """Render a colored risk badge."""
    risk_styles = {
        "critical": ("#ff6b6b", "#2d1216", "CRITICAL"),
        "high": ("#ffa94d", "#2d1f00", "HIGH"),
        "medium": ("#ffd43b", "#2d2500", "MEDIUM"),
        "low": ("#69db7c", "#12261e", "LOW"),
    }
    color, bg, label = risk_styles.get(risk, ("#8b949e", "#161b22", risk.upper()))
    return f'<span class="risk-badge" style="color:{color};background:{bg};border-color:{color}">{label}</span>'


def render_impact_panel(impact: dict) -> str:
    """Render the impact analysis panel shown below the PR header."""
    if not impact:
        return ""

    source = impact.get("source", "unknown")
    blast = impact.get("blast_radius", {})
    symbols = impact.get("changed_symbols", [])
    arch_ctx = impact.get("architecture_context", "")
    total = blast.get("total_affected", 0)

    # Blast radius bar segments
    bar_segments = []
    for level, color in [("critical", "#ff6b6b"), ("high", "#ffa94d"), ("medium", "#ffd43b"), ("low", "#69db7c")]:
        count = blast.get(level, 0)
        if count > 0 and total > 0:
            pct = (count / total) * 100
            bar_segments.append(
                f'<div class="blast-seg" style="width:{pct}%;background:{color}" '
                f'title="{level.upper()}: {count}"></div>'
            )

    bar_html = f'<div class="blast-bar">{"".join(bar_segments)}</div>' if bar_segments else ""

    # Blast radius legend
    legend_items = []
    for level, color, icon in [("critical", "#ff6b6b", "🔴"), ("high", "#ffa94d", "🟠"),
                                 ("medium", "#ffd43b", "🟡"), ("low", "#69db7c", "🟢")]:
        count = blast.get(level, 0)
        if count > 0:
            legend_items.append(f'<span class="blast-legend-item" style="color:{color}">{icon} {count} {level}</span>')

    legend_html = f'<div class="blast-legend">{"".join(legend_items)}</div>' if legend_items else ""

    # Changed symbols list
    symbols_html = ""
    if symbols:
        sym_items = []
        for sym in symbols[:15]:  # Cap at 15 for readability
            name = html.escape(sym.get("name", "?"))
            file_path = html.escape(sym.get("file", ""))
            risk = sym.get("risk", "")
            callers = sym.get("callers", 0)
            badge = render_risk_badge(risk) if risk else ""
            caller_info = f'<span class="sym-callers">{callers} caller{"s" if callers != 1 else ""}</span>' if callers else ""
            sym_items.append(
                f'<div class="sym-item">'
                f'{badge}<code class="sym-name">{name}</code>'
                f'<span class="sym-file">{file_path}</span>'
                f'{caller_info}'
                f'</div>'
            )
        if len(symbols) > 15:
            sym_items.append(f'<div class="sym-item sym-more">...and {len(symbols) - 15} more</div>')
        symbols_html = f'<div class="sym-list">{"".join(sym_items)}</div>'

    # Architecture context
    arch_html = ""
    if arch_ctx:
        arch_html = f'<div class="impact-arch"><strong>📐 Architecture context:</strong> {html.escape(arch_ctx)}</div>'

    source_label = "🔬 via codebase-memory-mcp" if source == "codebase-memory-mcp" else "📊 grep-estimated"

    return f'''
    <div class="impact-panel">
        <div class="impact-header" onclick="this.parentElement.classList.toggle('impact-collapsed')">
            <h3>🎯 Impact Analysis</h3>
            <span class="impact-source">{source_label}</span>
            <span class="impact-total">{total} affected symbol{"s" if total != 1 else ""}</span>
            <span class="toggle-hint">▼</span>
        </div>
        <div class="impact-body">
            {bar_html}
            {legend_html}
            {symbols_html}
            {arch_html}
        </div>
    </div>
    '''


def escape_mermaid(text: str) -> str:
    """Escape mermaid content for safe embedding in HTML.

    Mermaid syntax uses -->, |text|, ", and other characters that
    html.escape() would mangle. We only escape < and & to prevent
    tag injection while keeping mermaid operators intact.
    """
    return text.replace("&", "&amp;").replace("<", "&lt;")


def render_artifact(artifact: dict, artifact_id: str) -> str:
    """Render a single artifact (diagram, reference, or note)."""
    art_type = artifact.get("type", "note")
    title_escaped = html.escape(artifact.get("title", ""))
    title_display = format_inline_code(title_escaped)

    if art_type == "diagram":
        content = artifact.get("content", "")
        # Store mermaid source in a data attribute; rendered client-side via
        # mermaid.render() API which gives us full control over timing.
        # The source is base64-encoded to avoid HTML entity issues — mermaid
        # syntax uses <, >, ", | which conflict with HTML attributes.
        encoded = base64.b64encode(content.encode('utf-8')).decode('ascii')
        return (
            f'<div class="artifact artifact-diagram" id="{artifact_id}">'
            f'<div class="artifact-header">'
            f'<span class="artifact-icon">📊</span> '
            f'<span class="artifact-title">{title_display}</span>'
            f'</div>'
            f'<div class="mermaid-container" data-mermaid-src="{encoded}">'
            f'<span class="mermaid-loading">⏳ Loading diagram…</span>'
            f'</div>'
            f'</div>'
        )
    elif art_type == "reference":
        url = html.escape(artifact.get("url", ""))
        desc_escaped = html.escape(artifact.get("description", ""))
        desc_display = format_inline_code(desc_escaped)
        return (
            f'<div class="artifact artifact-reference" id="{artifact_id}">'
            f'<div class="artifact-header">'
            f'<span class="artifact-icon">🔗</span> '
            f'<a class="artifact-title artifact-link" href="{url}" target="_blank">{title_display} ↗</a>'
            f'</div>'
            f'{f"<div class=artifact-desc>{desc_display}</div>" if desc_escaped else ""}'
            f'</div>'
        )
    else:  # note
        content_escaped = html.escape(artifact.get("content", ""))
        content_display = format_inline_code(content_escaped)
        return (
            f'<div class="artifact artifact-note" id="{artifact_id}">'
            f'<div class="artifact-header">'
            f'<span class="artifact-icon">📝</span> '
            f'<span class="artifact-title">{title_display}</span>'
            f'</div>'
            f'<div class="artifact-content">{content_display}</div>'
            f'</div>'
        )


def render_artifacts_section(artifacts: list[dict], id_prefix: str, heading: str = "📚 Context & References") -> str:
    """Render a collapsible section of artifacts."""
    if not artifacts:
        return ""
    items = []
    for idx, artifact in enumerate(artifacts):
        artifact_id = f"{id_prefix}-{idx}"
        items.append(render_artifact(artifact, artifact_id))
    return (
        f'<div class="artifacts-section">'
        f'<h3>{heading} <span class="artifact-count">({len(artifacts)})</span></h3>'
        + "\n".join(items)
        + f'</div>'
    )


def generate_html(plan: dict, file_diffs: dict[str, str],
                  repo_dir: str = None, head_sha: str = None) -> str:
    pr = plan
    phases = pr["phases"]
    num_phases = len(phases)

    # Build impact panel
    impact_html = render_impact_panel(pr.get("impact_analysis"))

    # Build top-level artifacts (Context tab)
    top_artifacts = pr.get("artifacts", [])
    has_context_tab = len(top_artifacts) > 0

    # Build phase sections
    phase_sections = []
    for i, phase in enumerate(phases):
        phase_num = i + 1
        files_html = []

        phase_files = phase["files"]
        phase_additions = 0
        phase_deletions = 0
        phase_risk = phase.get("risk", "")

        for entry in phase_files:
            f, f_start, f_end, f_label = normalize_file_entry(entry)
            diff = file_diffs.get(f, "")
            # Auto-fetch content for new files missing from the diff
            if not diff:
                content = fetch_file_content(f, repo_dir, head_sha)
                if content is not None:
                    diff = generate_synthetic_diff(f, content)
            adds, dels = count_diff_stats(diff, f_start, f_end)
            phase_additions += adds
            phase_deletions += dels

            diff_rendered = render_diff_html(diff, f, phase_num, f_start, f_end) if diff else '<div class="diff-meta" style="padding: 12px 16px; font-style: italic;">⚠️ No diff content found — if this is a new file, its content was not captured in the diff output</div>'
            hljs_lang = get_hljs_language(f)
            lang_attr = f' data-lang="{hljs_lang}"' if hljs_lang else ''
            section_html = f' <span class="file-section">→ {html.escape(f_label)}</span>' if f_label else ''
            range_html = f' <span class="file-range">L{f_start}–L{f_end}</span>' if f_start and f_end else ''
            is_md = is_markdown_file(f)
            md_attr = ' data-markdown="true"' if is_md else ''
            preview_btn = '<button class="btn-preview" onclick="event.stopPropagation();toggleMarkdownPreview(this)" title="Toggle rendered markdown preview">👁️ Preview</button>' if is_md else ''
            preview_div = '<div class="file-preview" style="display:none"></div>' if is_md else ''
            files_html.append(f'''
                <div class="file-block" data-phase="{phase_num}" data-file="{html.escape(f)}"{md_attr}>
                    <div class="file-header" onclick="toggleFileCollapse(this)">
                        <span class="file-path">{html.escape(f)}</span>{section_html}{range_html}
                        {preview_btn}
                        <button class="btn-copy-code" onclick="event.stopPropagation();copyFileCode(this)" title="Copy new-file code (context + additions, no deletions)">📋</button>
                        <span class="file-stats">+{adds} −{dels}</span>
                        <span class="toggle-hint">▼</span>
                    </div>
                    <div class="file-diff"{lang_attr}>
                        {diff_rendered}
                    </div>
                    {preview_div}
                </div>
            ''')

        ai_notes_html = render_ai_notes(phase.get("ai_notes", []), phase_num)
        phase_artifacts_html = render_artifacts_section(
            phase.get("artifacts", []),
            f"phase-{phase_num}-artifact",
            heading="📚 Phase Context"
        )
        risk_badge_html = render_risk_badge(phase_risk) if phase_risk else ""

        phase_sections.append(f'''
        <div class="phase" id="phase-{phase_num}" {"" if i == 0 and not has_context_tab else 'style="display:none"'}>
            <div class="phase-header">
                <h2>Phase {phase_num}: {html.escape(phase["name"])}</h2>
                {risk_badge_html}
                <span class="phase-stats">{len(phase_files)} file{"s" if len(phase_files) != 1 else ""}, +{phase_additions} −{phase_deletions}</span>
                <button class="btn-breakdown" onclick="requestBreakdown({phase_num})" title="Copy a request to split this phase into smaller sub-phases">🔬 Break down</button>
            </div>
            <p class="phase-desc">{format_inline_code(html.escape(phase["description"]))}</p>

            {"".join(files_html)}

            {phase_artifacts_html}

            {"<div class='ai-notes-section'><h3>🤖 AI Observations <span class='flag-hint'>(click 🚩 to flag for discussion)</span></h3>" + ai_notes_html + "</div>" if ai_notes_html else ""}

            <div class="comment-section">
                <h3>Your Review Comments</h3>
                <textarea
                    class="comment-box"
                    id="comment-{phase_num}"
                    placeholder="Your observations for this phase... (auto-saved)"
                    oninput="autoSave()"
                ></textarea>
            </div>

            <div class="phase-nav">
                {"<button onclick='goPhase(" + str(phase_num - 1) + ")' class='btn btn-secondary'>← Phase " + str(phase_num - 1) + "</button>" if i > 0 else ("<button onclick='showContext()' class='btn btn-secondary'>← Context</button>" if has_context_tab else "<div></div>")}
                {"<button onclick='goPhase(" + str(phase_num + 1) + ")' class='btn btn-primary'>Phase " + str(phase_num + 1) + " →</button>" if i < num_phases - 1 else "<button onclick='showSummary()' class='btn btn-primary'>View Summary →</button>"}
            </div>
        </div>
        ''')

    # Build context tab HTML (top-level artifacts)
    context_tab_html = ""
    if has_context_tab:
        ctx_artifacts_html = render_artifacts_section(top_artifacts, "ctx-artifact", heading="")
        context_tab_html = f'''
    <div class="context-tab" id="context-tab">
        <h2>📚 Context & References</h2>
        <p class="phase-desc">Supplemental materials to help understand this change — diagrams, related resources, and background context.</p>
        {ctx_artifacts_html}
        <div class="phase-nav">
            <div></div>
            <button onclick="goPhase(1)" class="btn btn-primary">Phase 1 \u2192</button>
        </div>
    </div>
        '''

    # Build the phase nav tabs (with optional risk dot indicators)
    risk_dots = {
        "critical": "🔴",
        "high": "🟠",
        "medium": "🟡",
        "low": "🟢",
    }
    tabs = []
    if has_context_tab:
        tabs.append('<button class="tab active" id="tab-context" onclick="showContext()">📚 Context</button>')
    for i, phase in enumerate(phases):
        phase_num = i + 1
        active = "active" if i == 0 and not has_context_tab else ""
        risk = phase.get("risk", "")
        dot = f' {risk_dots[risk]}' if risk in risk_dots else ""
        tabs.append(
            f'<button class="tab {active}" id="tab-{phase_num}" onclick="goPhase({phase_num})">'
            f'Phase {phase_num}: {html.escape(phase["name"])}{dot}</button>'
        )
    tabs.append('<button class="tab" id="tab-summary" onclick="showSummary()">Summary</button>')

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Review: {html.escape(pr["title"])} (#{pr["number"]})</title>
<style>
    :root {{
        --bg: #0d1117;
        --surface: #161b22;
        --border: #30363d;
        --text: #e6edf3;
        --text-muted: #8b949e;
        --accent: #58a6ff;
        --add-bg: #12261e;
        --add-text: #56d364;
        --del-bg: #2d1216;
        --del-text: #f85149;
        --hunk-bg: #1c2433;
        --hunk-text: #79c0ff;
        --flag-bg: #3d1f00;
        --flag-border: #d29922;
    }}
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.5;
        padding: 0;
    }}
    .container {{ max-width: 1100px; margin: 0 auto; padding: 20px; padding-bottom: 80px; }}

    /* Header */
    .pr-header {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 24px;
        margin-bottom: 16px;
    }}
    .pr-title {{ font-size: 1.4em; font-weight: 600; margin-bottom: 8px; }}
    .pr-meta {{ color: var(--text-muted); font-size: 0.9em; }}
    .pr-meta span {{ margin-right: 16px; }}
    .pr-title a:hover {{ color: var(--accent) !important; text-decoration: underline !important; }}
    .pr-desc {{
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.95em;
    }}

    /* Tabs */
    .tabs {{
        display: flex;
        gap: 4px;
        margin-bottom: 16px;
        overflow-x: auto;
        padding-bottom: 4px;
    }}
    .tab {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-muted);
        padding: 8px 16px;
        cursor: pointer;
        font-size: 0.85em;
        white-space: nowrap;
        transition: all 0.15s;
    }}
    .tab:hover {{ color: var(--text); border-color: var(--text-muted); }}
    .tab.active {{
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
    }}

    /* Phase */
    .phase {{ animation: fadeIn 0.2s ease; }}
    @keyframes fadeIn {{ from {{ opacity: 0; }} to {{ opacity: 1; }} }}
    .phase-header {{
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 8px;
    }}
    .phase-header h2 {{ font-size: 1.2em; }}
    .phase-stats {{ color: var(--text-muted); font-size: 0.9em; }}
    .phase-desc {{
        color: var(--text-muted);
        font-style: italic;
        margin-bottom: 20px;
        font-size: 0.95em;
    }}

    /* Phase breakdown button */
    .btn-breakdown {{
        background: none;
        border: 1px solid var(--border);
        border-radius: 5px;
        color: var(--text-muted);
        padding: 4px 12px;
        cursor: pointer;
        font-size: 0.78em;
        white-space: nowrap;
        transition: all 0.15s;
        margin-left: auto;
    }}
    .btn-breakdown:hover {{
        color: var(--accent);
        border-color: var(--accent);
        background: rgba(88, 166, 255, 0.08);
    }}
    .btn-breakdown-copied {{
        color: var(--add-text) !important;
        border-color: var(--add-text) !important;
        background: rgba(86, 211, 100, 0.08) !important;
    }}

    /* File blocks */
    .file-block {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        margin-bottom: 12px;
        overflow: hidden;
    }}
    .file-header {{
        display: flex;
        align-items: center;
        padding: 10px 16px;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid var(--border);
        cursor: pointer;
        user-select: none;
    }}
    .file-header:hover {{ background: rgba(255,255,255,0.06); }}
    .file-path {{ font-family: monospace; font-size: 0.9em; flex: 1; color: var(--accent); }}
    .file-stats {{ color: var(--text-muted); font-size: 0.85em; margin-right: 8px; }}
    .btn-copy-code {{
        background: none;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--text-muted);
        padding: 2px 8px;
        cursor: pointer;
        font-size: 0.82em;
        white-space: nowrap;
        transition: all 0.15s;
        opacity: 0;
        flex-shrink: 0;
        margin-right: 4px;
    }}
    .file-header:hover .btn-copy-code {{ opacity: 0.6; }}
    .btn-copy-code:hover {{
        opacity: 1 !important;
        color: var(--accent);
        border-color: var(--accent);
        background: rgba(88, 166, 255, 0.08);
    }}
    .btn-copy-code.copied {{
        opacity: 1 !important;
        color: var(--add-text) !important;
        border-color: var(--add-text) !important;
        background: rgba(86, 211, 100, 0.08) !important;
    }}
    /* Preview toggle button (markdown files) */
    .btn-preview {{
        background: rgba(163, 113, 247, 0.08);
        border: 1px solid rgba(163, 113, 247, 0.3);
        border-radius: 4px;
        color: #a371f7;
        padding: 2px 10px;
        cursor: pointer;
        font-size: 0.82em;
        white-space: nowrap;
        transition: all 0.15s;
        flex-shrink: 0;
        margin-right: 4px;
    }}
    .btn-preview:hover {{
        background: rgba(163, 113, 247, 0.15);
        border-color: #a371f7;
    }}
    .btn-preview-active {{
        background: rgba(163, 113, 247, 0.15) !important;
        border-color: #a371f7 !important;
        color: #c9a0ff !important;
    }}
    .toggle-hint {{ color: var(--text-muted); font-size: 0.8em; transition: transform 0.15s; }}
    .file-diff {{
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.82em;
        line-height: 1.6;
        overflow-x: auto;
        max-height: 600px;
        overflow-y: auto;
    }}
    .file-diff.collapsed {{ display: none; }}

    /* Markdown rich preview pane */
    .file-preview {{
        padding: 20px 28px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 0.95em;
        line-height: 1.7;
        color: var(--text);
        max-height: 700px;
        overflow-y: auto;
        overflow-x: hidden;
    }}
    .file-preview h1 {{ font-size: 1.6em; margin: 0.8em 0 0.4em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }}
    .file-preview h2 {{ font-size: 1.3em; margin: 0.8em 0 0.4em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }}
    .file-preview h3 {{ font-size: 1.1em; margin: 0.7em 0 0.3em; }}
    .file-preview h4 {{ font-size: 1.0em; margin: 0.6em 0 0.3em; color: var(--text-muted); }}
    .file-preview p {{ margin: 0.5em 0; }}
    .file-preview ul, .file-preview ol {{ margin: 0.5em 0; padding-left: 2em; }}
    .file-preview li {{ margin: 0.2em 0; }}
    .file-preview li > ul, .file-preview li > ol {{ margin: 0.1em 0; }}
    .file-preview code {{
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.88em;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(110, 118, 129, 0.2);
        color: #e6edf3;
    }}
    .file-preview pre {{
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 12px 16px;
        overflow-x: auto;
        margin: 0.6em 0;
    }}
    .file-preview pre code {{
        background: none;
        padding: 0;
        font-size: 0.85em;
        line-height: 1.5;
    }}
    .file-preview blockquote {{
        margin: 0.5em 0;
        padding: 4px 16px;
        border-left: 4px solid var(--accent);
        color: var(--text-muted);
        background: rgba(88, 166, 255, 0.04);
        border-radius: 0 4px 4px 0;
    }}
    .file-preview blockquote p {{ margin: 0.3em 0; }}
    .file-preview table {{
        border-collapse: collapse;
        margin: 0.6em 0;
        width: auto;
    }}
    .file-preview th, .file-preview td {{
        border: 1px solid var(--border);
        padding: 6px 12px;
        text-align: left;
    }}
    .file-preview th {{ background: rgba(255,255,255,0.04); font-weight: 600; }}
    .file-preview a {{ color: var(--accent); text-decoration: none; }}
    .file-preview a:hover {{ text-decoration: underline; }}
    .file-preview hr {{ border: none; border-top: 1px solid var(--border); margin: 1em 0; }}
    .file-preview img {{ max-width: 100%; border-radius: 4px; }}
    .file-preview .preview-hunk-sep {{
        text-align: center;
        color: var(--text-muted);
        font-size: 0.8em;
        font-style: italic;
        margin: 1em 0;
        padding: 4px;
        border-top: 1px dashed var(--border);
        border-bottom: 1px dashed var(--border);
    }}
    .file-diff > div:not(.diff-line-row):not(.inline-comment-form):not(.inline-comment-saved):not(.diff-fold) {{ padding: 1px 16px; white-space: pre; }}
    .diff-add {{ background: var(--add-bg); color: var(--text); }}
    .diff-del {{ background: var(--del-bg); color: var(--text); }}
    .diff-add .diff-prefix {{ color: var(--add-text); }}
    .diff-del .diff-prefix {{ color: var(--del-text); }}
    .diff-hunk {{ background: var(--hunk-bg); color: var(--hunk-text); font-style: italic; padding-top: 8px !important; }}
    .diff-meta {{ color: var(--text-muted); font-weight: bold; }}
    .diff-ctx {{ color: var(--text-muted); }}

    /* Fold indicator (shown between non-contiguous sections in filtered diffs) */
    .diff-fold {{
        padding: 4px 16px 4px 128px;
        color: var(--text-muted);
        font-size: 0.78em;
        font-style: italic;
        background: rgba(255,255,255,0.02);
        border-top: 1px dashed var(--border);
        border-bottom: 1px dashed var(--border);
        user-select: none;
    }}

    /* Section label and line range (for function-level breakdowns) */
    .file-section {{
        color: var(--text);
        font-family: monospace;
        font-size: 0.85em;
        font-weight: 500;
        opacity: 0.8;
    }}
    .file-range {{
        color: var(--text-muted);
        font-family: monospace;
        font-size: 0.8em;
        opacity: 0.6;
    }}

    /* Line numbers & gutter */
    .diff-line-row {{
        display: flex;
        align-items: stretch;
    }}
    .diff-ln {{
        width: 48px;
        min-width: 48px;
        flex-shrink: 0;
        text-align: right;
        padding-right: 8px;
        color: var(--text-muted);
        opacity: 0.35;
        font-size: 0.8em;
        line-height: 1.6;
        user-select: none;
        cursor: default;
    }}
    .diff-line-row:hover .diff-ln {{ opacity: 0.6; }}
    .diff-gutter {{
        width: 32px;
        min-width: 32px;
        flex-shrink: 0;
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: center;
    }}
    .diff-gutter::before {{
        content: '+';
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        background: var(--accent);
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        opacity: 0;
        transition: opacity 0.1s;
    }}
    .diff-line-row:hover .diff-gutter::before {{ opacity: 0.4; }}
    .diff-line-row:hover .diff-gutter:hover::before {{ opacity: 1; }}
    .diff-code {{
        flex: 1;
        padding: 1px 16px;
        white-space: pre;
        min-width: 0;
    }}

    /* Line selection highlight */
    .diff-line-row.line-selected {{
        background: rgba(88, 166, 255, 0.15) !important;
    }}
    .diff-line-row.line-selected .diff-gutter::before {{
        content: '';
        opacity: 0;
    }}

    /* Has-comment indicator */
    .diff-line-row.has-comment .diff-gutter::before {{
        content: '💬';
        background: none;
        opacity: 0.5;
        font-size: 12px;
    }}
    .diff-line-row.has-comment:hover .diff-gutter::before {{
        content: '+';
        background: var(--accent);
        font-size: 13px;
    }}

    /* Inline comment form */
    .inline-comment-form {{
        margin: 4px 0 4px 128px;  /* 48 + 48 (line nums) + 32 (gutter) */
        padding: 10px 12px;
        background: rgba(88, 166, 255, 0.05);
        border: 1px solid var(--accent);
        border-left: 3px solid var(--accent);
        border-radius: 0 6px 6px 0;
    }}
    .inline-comment-form textarea {{
        width: 100%;
        min-height: 60px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text);
        padding: 8px 10px;
        font-family: inherit;
        font-size: 0.9em;
        resize: vertical;
        line-height: 1.5;
    }}
    .inline-comment-form textarea:focus {{ outline: none; border-color: var(--accent); }}
    .inline-comment-form textarea::placeholder {{ color: var(--text-muted); }}
    .inline-comment-btns {{
        display: flex;
        gap: 8px;
        margin-top: 8px;
        justify-content: flex-end;
        align-items: center;
    }}
    .inline-comment-btns .ic-hint {{
        color: var(--text-muted);
        font-size: 0.78em;
        margin-right: auto;
    }}
    .inline-comment-btns button {{
        padding: 5px 16px;
        border-radius: 5px;
        border: 1px solid var(--border);
        cursor: pointer;
        font-size: 0.85em;
        font-weight: 500;
        transition: all 0.15s;
    }}
    .btn-comment-save {{
        background: var(--accent) !important;
        color: #fff !important;
        border-color: var(--accent) !important;
    }}
    .btn-comment-save:hover {{ filter: brightness(1.1); }}
    .btn-comment-cancel {{
        background: var(--surface) !important;
        color: var(--text-muted) !important;
    }}
    .btn-comment-cancel:hover {{ color: var(--text) !important; }}

    /* Saved inline comment */
    .inline-comment-saved {{
        margin: 2px 0 2px 128px;  /* 48 + 48 (line nums) + 32 (gutter) */
        padding: 8px 12px;
        background: rgba(88, 166, 255, 0.05);
        border-left: 3px solid var(--accent);
        border-radius: 0 4px 4px 0;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 0.9em;
    }}
    .ic-icon {{ flex-shrink: 0; }}
    .ic-text {{
        flex: 1;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
    }}
    .ic-actions {{
        display: flex;
        gap: 2px;
        flex-shrink: 0;
        opacity: 0;
        transition: opacity 0.15s;
    }}
    .inline-comment-saved:hover .ic-actions {{ opacity: 1; }}
    .ic-actions button {{
        background: none;
        border: 1px solid transparent;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.85em;
        padding: 2px 6px;
        transition: all 0.15s;
    }}
    .ic-actions button:hover {{
        background: rgba(255,255,255,0.06);
        border-color: var(--border);
    }}

    /* Summary inline comments */
    .summary-inline {{
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
    }}
    .summary-inline-item {{
        padding: 6px 10px;
        margin-top: 4px;
        background: rgba(88, 166, 255, 0.05);
        border-left: 3px solid var(--accent);
        border-radius: 0 4px 4px 0;
        font-size: 0.9em;
    }}
    .summary-inline-file {{ color: var(--accent); font-family: monospace; font-size: 0.85em; }}
    .summary-inline-text {{ margin-top: 2px; }}
    .summary-inline-code {{
        margin: 4px 0;
        padding: 6px 10px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.82em;
        line-height: 1.5;
        overflow-x: auto;
        color: var(--text-muted);
        white-space: pre;
    }}
    .ic-line-ref {{
        color: var(--text-muted);
        font-family: monospace;
        font-size: 0.85em;
        font-weight: 500;
    }}

    /* AI notes */
    .ai-notes-section {{
        margin: 20px 0;
        padding: 16px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
    }}
    .ai-notes-section h3 {{ font-size: 1em; margin-bottom: 12px; }}
    .flag-hint {{ color: var(--text-muted); font-size: 0.8em; font-weight: normal; }}
    .ai-note {{
        padding: 8px 12px;
        margin-bottom: 6px;
        border-left: 3px solid;
        background: rgba(255,255,255,0.02);
        border-radius: 0 4px 4px 0;
        font-size: 0.93em;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        transition: all 0.2s;
    }}
    .ai-note.flagged {{
        background: var(--flag-bg);
        border-left-color: var(--flag-border) !important;
    }}
    .ai-note-content {{ flex: 1; }}
    .ai-note-label {{ font-weight: 600; font-size: 0.85em; }}

    /* Inline code in observations, artifact text, titles, and descriptions */
    .ai-note-content code,
    .artifact-content code,
    .artifact-desc code,
    .artifact-title code,
    .phase-desc code,
    .pr-desc code {{
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.88em;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(110, 118, 129, 0.2);
        color: #e6edf3;
        white-space: nowrap;
    }}
    .flag-btn {{
        background: none;
        border: 1px solid transparent;
        border-radius: 4px;
        cursor: pointer;
        font-size: 1em;
        padding: 2px 6px;
        opacity: 0.3;
        transition: all 0.15s;
        flex-shrink: 0;
    }}
    .flag-btn:hover {{ opacity: 0.7; border-color: var(--border); }}
    .ai-note.flagged .flag-btn {{ opacity: 1; background: rgba(210, 153, 34, 0.2); border-color: var(--flag-border); }}

    /* Evidence blocks */
    .evidence-toggle {{ margin-top: 6px; }}
    .evidence-btn {{
        background: none;
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text-muted);
        padding: 3px 10px;
        cursor: pointer;
        font-size: 0.8em;
        transition: all 0.15s;
    }}
    .evidence-btn:hover {{ color: var(--text); border-color: var(--text-muted); background: rgba(255,255,255,0.03); }}
    .evidence-block {{
        margin-top: 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        background: rgba(0,0,0,0.2);
    }}
    .evidence-item {{
        border-bottom: 1px solid var(--border);
    }}
    .evidence-item:last-child {{ border-bottom: none; }}
    .evidence-cmd {{
        padding: 6px 12px;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.82em;
        color: var(--accent);
        background: rgba(255,255,255,0.02);
        border-bottom: 1px solid var(--border);
    }}
    .evidence-prompt {{
        color: var(--text-muted);
        margin-right: 6px;
        user-select: none;
    }}
    .evidence-output {{
        padding: 8px 12px;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.82em;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
        max-height: 300px;
        overflow-y: auto;
    }}
    .ai-note.has-evidence {{
        padding-bottom: 10px;
    }}

    /* Risk badges */
    .risk-badge {{
        display: inline-block;
        font-size: 0.7em;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 4px;
        border: 1px solid;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        vertical-align: middle;
        line-height: 1.4;
    }}

    /* Impact analysis panel */
    .impact-panel {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        margin-bottom: 16px;
        overflow: hidden;
    }}
    .impact-header {{
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        cursor: pointer;
        user-select: none;
    }}
    .impact-header:hover {{ background: rgba(255,255,255,0.03); }}
    .impact-header h3 {{ font-size: 1em; margin: 0; flex-shrink: 0; }}
    .impact-source {{
        color: var(--text-muted);
        font-size: 0.8em;
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
    }}
    .impact-total {{
        color: var(--text-muted);
        font-size: 0.85em;
        margin-left: auto;
    }}
    .impact-collapsed .impact-body {{ display: none; }}
    .impact-collapsed .toggle-hint {{ transform: rotate(-90deg); }}
    .impact-body {{ padding: 0 16px 16px 16px; }}

    /* Blast radius bar */
    .blast-bar {{
        display: flex;
        height: 8px;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
        background: rgba(255,255,255,0.05);
    }}
    .blast-seg {{
        transition: width 0.3s ease;
        min-width: 4px;
    }}
    .blast-seg:first-child {{ border-radius: 4px 0 0 4px; }}
    .blast-seg:last-child {{ border-radius: 0 4px 4px 0; }}
    .blast-seg:only-child {{ border-radius: 4px; }}
    .blast-legend {{
        display: flex;
        gap: 16px;
        margin-bottom: 12px;
        font-size: 0.82em;
    }}
    .blast-legend-item {{ white-space: nowrap; }}

    /* Changed symbols list */
    .sym-list {{
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 12px;
    }}
    .sym-item {{
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.85em;
    }}
    .sym-item:hover {{ background: rgba(255,255,255,0.03); }}
    .sym-name {{
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        color: var(--text);
    }}
    .sym-file {{
        color: var(--text-muted);
        font-family: monospace;
        font-size: 0.9em;
        margin-left: auto;
    }}
    .sym-callers {{
        color: var(--text-muted);
        font-size: 0.85em;
        white-space: nowrap;
    }}
    .sym-more {{ color: var(--text-muted); font-style: italic; }}

    /* Architecture context */
    .impact-arch {{
        color: var(--text-muted);
        font-size: 0.9em;
        padding: 8px 10px;
        border-left: 3px solid var(--accent);
        border-radius: 0 4px 4px 0;
        background: rgba(88, 166, 255, 0.05);
    }}

    /* ── Artifacts (diagrams, references, notes) ───────────────────── */
    .artifacts-section {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 12px;
    }}
    .artifacts-section h3 {{
        font-size: 1em;
        margin-bottom: 12px;
    }}
    .artifact-count {{
        color: var(--text-muted);
        font-size: 0.85em;
        font-weight: normal;
    }}
    .artifact {{
        padding: 10px 12px;
        margin-bottom: 8px;
        border-radius: 6px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
    }}
    .artifact:last-child {{ margin-bottom: 0; }}
    .artifact-header {{
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
    }}
    .artifact-icon {{ font-size: 0.9em; flex-shrink: 0; }}
    .artifact-title {{
        font-weight: 600;
        font-size: 0.93em;
    }}
    .artifact-link {{
        color: var(--accent);
        text-decoration: none;
    }}
    .artifact-link:hover {{ text-decoration: underline; }}
    .artifact-desc {{
        color: var(--text-muted);
        font-size: 0.88em;
        margin-top: 2px;
        padding-left: 22px;
    }}
    .artifact-content {{
        color: var(--text);
        font-size: 0.9em;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
    }}

    /* Mermaid diagram container */
    .mermaid-container {{
        background: rgba(0,0,0,0.2);
        border-radius: 6px;
        padding: 16px;
        overflow-x: auto;
        text-align: center;
        margin-top: 4px;
    }}
    .mermaid-container svg {{
        max-width: 100%;
        height: auto;
    }}
    .mermaid-loading {{
        color: var(--text-muted);
        font-size: 0.88em;
    }}

    /* Mermaid error fallback */
    .mermaid-container.mermaid-error {{
        background: rgba(255, 107, 107, 0.05) !important;
        border: 1px dashed rgba(255, 107, 107, 0.3) !important;
        text-align: left !important;
    }}
    .mermaid-err-header {{
        color: #ffa94d;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 0.85em;
        margin-bottom: 8px;
    }}
    .mermaid-error code {{
        display: block;
        white-space: pre-wrap;
        color: var(--text-muted);
        font-size: 0.85em;
        line-height: 1.5;
    }}

    /* Context tab (top-level artifacts) */
    .context-tab {{
        animation: fadeIn 0.2s ease;
    }}
    .context-tab h2 {{ margin-bottom: 16px; }}

    /* Comments */
    .comment-section {{ margin: 20px 0; }}
    .comment-section h3 {{ font-size: 1em; margin-bottom: 8px; }}
    .comment-box {{
        width: 100%;
        min-height: 120px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        padding: 12px;
        font-family: inherit;
        font-size: 0.95em;
        resize: vertical;
        line-height: 1.5;
    }}
    .comment-box:focus {{ outline: none; border-color: var(--accent); }}
    .comment-box::placeholder {{ color: var(--text-muted); }}

    /* Navigation */
    .phase-nav {{
        display: flex;
        justify-content: space-between;
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
    }}
    .btn {{
        padding: 10px 20px;
        border-radius: 6px;
        border: 1px solid var(--border);
        cursor: pointer;
        font-size: 0.9em;
        font-weight: 500;
        transition: all 0.15s;
    }}
    .btn-primary {{ background: var(--accent); color: #fff; border-color: var(--accent); }}
    .btn-primary:hover {{ filter: brightness(1.1); }}
    .btn-secondary {{ background: var(--surface); color: var(--text); }}
    .btn-secondary:hover {{ background: rgba(255,255,255,0.08); }}
    .btn-export {{
        background: #238636;
        color: #fff;
        border-color: #238636;
        font-size: 1em;
        padding: 12px 24px;
    }}
    .btn-export:hover {{ filter: brightness(1.1); }}

    /* Stop / discuss bar */
    .stop-bar {{
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        background: var(--surface);
        border-top: 2px solid var(--flag-border);
        padding: 10px 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        z-index: 100;
        transform: translateY(100%);
        transition: transform 0.25s ease;
    }}
    .stop-bar.visible {{
        transform: translateY(0);
    }}
    .stop-bar .flag-count {{
        color: var(--flag-border);
        font-weight: 600;
        font-size: 0.95em;
    }}
    .stop-bar .btn-stop {{
        background: var(--flag-border);
        color: #000;
        border: none;
        padding: 10px 24px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.95em;
        cursor: pointer;
        transition: filter 0.15s;
    }}
    .stop-bar .btn-stop:hover {{ filter: brightness(1.15); }}
    .stop-bar .btn-dismiss {{
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.85em;
    }}
    .stop-bar .btn-dismiss:hover {{ color: var(--text); border-color: var(--text-muted); }}

    /* Summary */
    .summary {{ animation: fadeIn 0.2s ease; }}
    .summary h2 {{ margin-bottom: 16px; }}
    .summary-phase {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 12px;
    }}
    .summary-phase h3 {{ font-size: 1em; margin-bottom: 8px; color: var(--accent); }}
    .summary-comment {{ color: var(--text-muted); font-style: italic; white-space: pre-wrap; }}
    .summary-comment.has-content {{ color: var(--text); font-style: normal; }}
    .summary-flagged {{ margin-top: 8px; }}
    .summary-flagged-item {{
        padding: 6px 10px;
        margin-top: 4px;
        background: var(--flag-bg);
        border-left: 3px solid var(--flag-border);
        border-radius: 0 4px 4px 0;
        font-size: 0.9em;
    }}
    .export-section {{ margin-top: 20px; text-align: center; }}
    .save-status {{ color: var(--text-muted); font-size: 0.85em; margin-top: 8px; }}

    /* Keyboard hint */
    .kbd-hint {{
        position: fixed;
        bottom: 12px;
        right: 12px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 0.8em;
        color: var(--text-muted);
        transition: bottom 0.25s ease;
    }}
    .kbd-hint.raised {{ bottom: 60px; }}
    kbd {{
        background: rgba(255,255,255,0.1);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 1px 5px;
        font-family: monospace;
        font-size: 0.9em;
    }}

    /* ── Syntax highlighting tokens (GitHub Dark palette) ──────────── */
    .diff-code .hljs-keyword,
    .diff-code .hljs-selector-tag {{ color: #ff7b72; }}
    .diff-code .hljs-built_in {{ color: #ffa657; }}
    .diff-code .hljs-type,
    .diff-code .hljs-class .hljs-title,
    .diff-code .hljs-title.class_ {{ color: #ffa657; }}
    .diff-code .hljs-title.function_,
    .diff-code .hljs-title.function {{ color: #d2a8ff; }}
    .diff-code .hljs-attr,
    .diff-code .hljs-attribute {{ color: #79c0ff; }}
    .diff-code .hljs-string,
    .diff-code .hljs-regexp {{ color: #a5d6ff; }}
    .diff-code .hljs-number,
    .diff-code .hljs-literal {{ color: #79c0ff; }}
    .diff-code .hljs-comment,
    .diff-code .hljs-doctag {{ color: #8b949e; font-style: italic; }}
    .diff-code .hljs-meta,
    .diff-code .hljs-meta .hljs-keyword {{ color: #79c0ff; }}
    .diff-code .hljs-meta .hljs-string {{ color: #a5d6ff; }}
    .diff-code .hljs-params {{ color: #c9d1d9; }}
    .diff-code .hljs-symbol {{ color: #79c0ff; }}
    .diff-code .hljs-variable,
    .diff-code .hljs-template-variable {{ color: #ffa657; }}
    .diff-code .hljs-operator {{ color: #ff7b72; }}
    .diff-code .hljs-punctuation {{ color: #c9d1d9; }}
    .diff-code .hljs-property {{ color: #79c0ff; }}
    .diff-code .hljs-decorator,
    .diff-code .hljs-meta.prompt_ {{ color: #d2a8ff; }}
    .diff-code .hljs-section {{ color: #79c0ff; font-weight: bold; }}

    /* Add/del lines: syntax colors are inherited from base tokens above.
       The green/red background plus the colored +/- prefix is enough signal. */

    /* ── Language picker ───────────────────────────────────────────── */
    .lang-picker-btn {{
        background: rgba(255, 179, 64, 0.08);
        border: 1px solid rgba(255, 179, 64, 0.3);
        border-radius: 4px;
        color: #ffb340;
        padding: 2px 10px;
        cursor: pointer;
        font-size: 0.78em;
        white-space: nowrap;
        transition: all 0.15s;
        margin: 0 8px;
        flex-shrink: 0;
    }}
    .lang-picker-btn:hover {{
        background: rgba(255, 179, 64, 0.15);
        border-color: #ffb340;
    }}
    .lang-picker-btn.lang-applied {{
        background: rgba(86, 211, 100, 0.08);
        border-color: rgba(86, 211, 100, 0.3);
        color: #56d364;
    }}
    .lang-picker-btn.lang-applied:hover {{
        background: rgba(86, 211, 100, 0.15);
        border-color: #56d364;
    }}
    .lang-picker-btn.lang-loading {{
        color: var(--text-muted);
        border-color: var(--border);
        background: rgba(255, 255, 255, 0.03);
        cursor: wait;
    }}
    #lang-picker-overlay {{
        display: none;
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 200;
        align-items: center;
        justify-content: center;
    }}
    .lang-picker {{
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: 420px;
        max-height: 520px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 16px 48px rgba(0,0,0,0.4);
    }}
    .lang-picker-header {{
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 16px 12px;
        border-bottom: 1px solid var(--border);
    }}
    .lang-picker-header h3 {{ font-size: 0.95em; margin: 0; }}
    .lang-picker-close {{
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 1.2em;
        padding: 4px 8px;
        border-radius: 4px;
    }}
    .lang-picker-close:hover {{
        background: rgba(255,255,255,0.06);
        color: var(--text);
    }}
    .lang-picker-search {{
        margin: 12px 16px;
        padding: 8px 12px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        font-size: 0.9em;
        outline: none;
    }}
    .lang-picker-search:focus {{ border-color: var(--accent); }}
    .lang-picker-search::placeholder {{ color: var(--text-muted); }}
    .lang-picker-list {{
        flex: 1;
        overflow-y: auto;
        padding: 4px 8px 12px;
    }}
    .lang-picker-item {{
        display: flex;
        align-items: center;
        width: 100%;
        padding: 7px 12px;
        background: none;
        border: none;
        border-radius: 6px;
        color: var(--text);
        cursor: pointer;
        font-size: 0.88em;
        text-align: left;
        transition: background 0.1s;
    }}
    .lang-picker-item:hover {{ background: rgba(88, 166, 255, 0.1); }}
    .lang-picker-item.lang-active {{ background: rgba(86, 211, 100, 0.1); }}
    .lp-name {{ flex: 1; }}
    .lp-id {{
        color: var(--text-muted);
        font-family: monospace;
        font-size: 0.85em;
        margin-left: 8px;
    }}
    .lp-cdn {{
        color: var(--accent);
        font-size: 0.68em;
        padding: 1px 6px;
        border: 1px solid var(--accent);
        border-radius: 3px;
        margin-left: 8px;
        opacity: 0.5;
    }}
    .lp-section {{
        color: var(--text-muted);
        font-size: 0.75em;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 10px 12px 4px;
        font-weight: 600;
    }}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/highlightjs-terraform/terraform.js"></script>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({{
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {{
      primaryColor: '#1c2433',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#30363d',
      lineColor: '#58a6ff',
      secondaryColor: '#161b22',
      tertiaryColor: '#0d1117',
      fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif',
      fontSize: '14px',
    }}
  }});
  // Render mermaid diagrams using the render() API for full control.
  // Source is base64-encoded in data-mermaid-src to avoid HTML entity issues.
  // Only renders visible containers; hidden ones are rendered when their
  // tab/phase becomes visible via goPhase() or showContext().
  let mermaidCounter = 0;
  window.renderMermaid = async function() {{
    const containers = document.querySelectorAll('.mermaid-container:not([data-rendered])');
    for (const el of containers) {{
      if (el.offsetParent === null) continue;
      el.setAttribute('data-rendered', 'true');
      const encoded = el.getAttribute('data-mermaid-src');
      if (!encoded) continue;
      let src;
      try {{
        src = atob(encoded);
      }} catch(e) {{
        el.innerHTML = '<span style="color:#ffa94d">\u26a0\ufe0f Failed to decode diagram source</span>';
        continue;
      }}
      try {{
        const {{ svg }} = await mermaid.render('mermaid-id-' + (mermaidCounter++), src);
        el.innerHTML = svg;
      }} catch(e) {{
        console.warn('Mermaid render error:', e);
        el.classList.add('mermaid-error');
        el.innerHTML =
          '<div class="mermaid-err-header">\u26a0\ufe0f Diagram syntax error \u2014 showing raw source</div>' +
          '<code>' + src.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code>';
      }}
    }}
  }};
  // Initial render
  window.renderMermaid();
</script>
</head>
<body>
<div class="container">
    <div class="pr-header">
        <div class="pr-title">{html.escape(pr["title"])} {f'<a href="{html.escape(pr["url"])}" target="_blank" style="color:var(--text-muted);text-decoration:none" title="Open PR in GitHub">#{pr["number"]} ↗</a>' if pr.get("url") else f'<span style="color:var(--text-muted)">#{pr["number"]}</span>'}</div>
        <div class="pr-meta">
            <span>👤 @{html.escape(pr["author"])}</span>
            <span>🔀 {html.escape(pr["base"])} ← {html.escape(pr["head"])}</span>
            <span style="color:var(--add-text)">+{pr["additions"]}</span>
            <span style="color:var(--del-text)">−{pr["deletions"]}</span>
            <span>{pr["changed_files"]} files</span>
        </div>
        <div class="pr-desc">{format_inline_code(html.escape(pr["description"]))}</div>
    </div>

    {impact_html}

    <div class="tabs" id="tabs">
        {"".join(tabs)}
    </div>

    {context_tab_html}

    {"".join(phase_sections)}

    <div class="summary" id="summary" style="display:none">
        <h2>Review Summary</h2>
        <div id="summary-content"></div>
        <div class="export-section">
            <button class="btn btn-export" onclick="exportFeedback()">📋 Copy Feedback to Clipboard</button>
            <br>
            <button class="btn btn-secondary" onclick="downloadFeedback()" style="margin-top:8px">💾 Download feedback.json</button>
            <div class="save-status" id="save-status"></div>
        </div>
        <div class="phase-nav" style="margin-top: 24px;">
            <button onclick="goPhase({num_phases})" class="btn btn-secondary">← Back to Phase {num_phases}</button>
            <div></div>
        </div>
    </div>
</div>

<!-- Stop bar: slides up when items are flagged -->
<div class="stop-bar" id="stop-bar">
    <span class="flag-count" id="flag-count">🚩 0 flagged</span>
    <button class="btn-stop" onclick="stopAndDiscuss()">⚡ Stop — copy flagged items to discuss</button>
    <button class="btn-dismiss" onclick="clearFlags()">Clear flags</button>
</div>

<div class="kbd-hint" id="kbd-hint">
    <kbd>←</kbd> <kbd>→</kbd> navigate phases
</div>

<script>
const NUM_PHASES = {num_phases};
let currentPhase = 1;
const planData = {json.dumps(pr, indent=2)};
const flaggedNotes = new Set();

// ── Syntax Highlighting ───────────────────────────────────────────────────

function balanceHtmlLines(htmlStr) {{
    // Split highlighted HTML into per-line chunks with balanced <span> tags.
    // highlight.js may produce spans crossing newline boundaries (multi-line
    // strings, block comments). We close open spans at each line break and
    // reopen them on the next line so each line is self-contained HTML.
    const rawLines = htmlStr.split('\\n');
    const balanced = [];
    let openStack = []; // stack of opening <span ...> tags carried forward
    for (const raw of rawLines) {{
        // Reopen spans that were open from previous line
        const reopen = openStack.join('');
        // Parse this raw line's tags to update the stack
        const stack = [...openStack];
        const re = /<(\\/?)(span)([^>]*)>/g;
        let m;
        while ((m = re.exec(raw)) !== null) {{
            if (m[1] === '/') {{
                stack.pop();
            }} else {{
                stack.push('<span' + m[3] + '>');
            }}
        }}
        // Close all currently open spans at end of line
        const close = '</span>'.repeat(stack.length);
        balanced.push(reopen + raw + close);
        openStack = stack;
    }}
    return balanced;
}}

function highlightDiffs() {{
    if (typeof hljs === 'undefined') return;
    // Register Terraform if the plugin loaded
    if (typeof window.hljsDefineTerraform === 'function') {{
        hljs.registerLanguage('terraform', window.hljsDefineTerraform);
    }}
    document.querySelectorAll('.file-diff[data-lang]').forEach(fileDiff => {{
        const lang = fileDiff.dataset.lang;
        if (!lang || !hljs.getLanguage(lang)) return;
        const codeEls = fileDiff.querySelectorAll('.diff-code');
        if (!codeEls.length) return;
        // Collect code lines (strip diff prefix char)
        const codeLines = [];
        codeEls.forEach(el => {{
            const text = el.textContent;
            // First char is +, -, or space (diff prefix)
            codeLines.push(text.length > 0 ? text.substring(1) : '');
        }});
        // Highlight as one block for correct multi-line tokenization
        const block = codeLines.join('\\n');
        let highlighted;
        try {{
            highlighted = hljs.highlight(block, {{ language: lang, ignoreIllegals: true }}).value;
        }} catch(e) {{
            return; // skip if highlighting fails
        }}
        // Split into balanced per-line HTML
        const hLines = balanceHtmlLines(highlighted);
        codeEls.forEach((el, idx) => {{
            if (idx < hLines.length) {{
                const text = el.textContent;
                const prefix = text.length > 0 ? text[0] : '';
                // Re-inject: escaped prefix + highlighted code
                const escapedPrefix = prefix.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                el.innerHTML = '<span class="diff-prefix">' + escapedPrefix + '</span>' + hLines[idx];
            }}
        }});
        fileDiff.dataset.highlighted = 'true';
    }});
}}

// ── Language picker & dynamic highlighting ─────────────────────────────────

const HLJS_LANGUAGES = [
    // Core bundle (already loaded)
    ['apache', 'Apache'], ['bash', 'Bash / Shell'], ['c', 'C'], ['cpp', 'C++'],
    ['csharp', 'C#'], ['css', 'CSS'], ['diff', 'Diff'], ['go', 'Go'],
    ['graphql', 'GraphQL'], ['ini', 'INI / TOML'], ['java', 'Java'],
    ['javascript', 'JavaScript'], ['json', 'JSON'], ['kotlin', 'Kotlin'],
    ['less', 'Less'], ['lua', 'Lua'], ['makefile', 'Makefile'],
    ['markdown', 'Markdown'], ['objectivec', 'Objective-C'], ['perl', 'Perl'],
    ['php', 'PHP'], ['plaintext', 'Plain Text'], ['python', 'Python'],
    ['python-repl', 'Python REPL'], ['r', 'R'], ['ruby', 'Ruby'],
    ['rust', 'Rust'], ['scss', 'SCSS'], ['shell', 'Shell'], ['sql', 'SQL'],
    ['swift', 'Swift'], ['typescript', 'TypeScript'], ['vbnet', 'VB.NET'],
    ['wasm', 'WebAssembly'], ['xml', 'XML / HTML'], ['yaml', 'YAML'],
    // CDN-loadable
    ['ada', 'Ada'], ['arduino', 'Arduino'], ['clojure', 'Clojure'],
    ['cmake', 'CMake'], ['coffeescript', 'CoffeeScript'], ['crystal', 'Crystal'],
    ['d', 'D'], ['dart', 'Dart'], ['delphi', 'Delphi'], ['django', 'Django'],
    ['dockerfile', 'Dockerfile'], ['dos', 'DOS / Batch'], ['elixir', 'Elixir'],
    ['elm', 'Elm'], ['erb', 'ERB'], ['erlang', 'Erlang'], ['fortran', 'Fortran'],
    ['fsharp', 'F#'], ['glsl', 'GLSL'], ['groovy', 'Groovy'], ['haml', 'HAML'],
    ['handlebars', 'Handlebars'], ['haskell', 'Haskell'], ['http', 'HTTP'],
    ['julia', 'Julia'], ['latex', 'LaTeX'], ['lisp', 'Lisp'], ['matlab', 'MATLAB'],
    ['nginx', 'Nginx'], ['nim', 'Nim'], ['nix', 'Nix'], ['ocaml', 'OCaml'],
    ['pgsql', 'PL/pgSQL'], ['powershell', 'PowerShell'], ['processing', 'Processing'],
    ['prolog', 'Prolog'], ['protobuf', 'Protocol Buffers'], ['puppet', 'Puppet'],
    ['scala', 'Scala'], ['scheme', 'Scheme'], ['smalltalk', 'Smalltalk'],
    ['tcl', 'Tcl'], ['terraform', 'Terraform / HCL'], ['thrift', 'Thrift'],
    ['verilog', 'Verilog'], ['vhdl', 'VHDL'], ['vim', 'Vim Script'],
    ['x86asm', 'x86 Assembly'],
];

let langPickerTarget = null;

function getFileExtension(filepath) {{
    const base = filepath.split('/').pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return base; // extensionless — use basename
    return base.substring(dot).toLowerCase();
}}

function highlightSingleFile(fileDiff, lang) {{
    if (typeof hljs === 'undefined' || !hljs.getLanguage(lang)) return false;
    const codeEls = fileDiff.querySelectorAll('.diff-code');
    if (!codeEls.length) return false;
    const codeLines = [];
    codeEls.forEach(el => {{
        const text = el.textContent;
        codeLines.push(text.length > 0 ? text.substring(1) : '');
    }});
    const block = codeLines.join('\\n');
    let highlighted;
    try {{
        highlighted = hljs.highlight(block, {{ language: lang, ignoreIllegals: true }}).value;
    }} catch(e) {{
        return false;
    }}
    const hLines = balanceHtmlLines(highlighted);
    codeEls.forEach((el, idx) => {{
        if (idx < hLines.length) {{
            const text = el.textContent;
            const prefix = text.length > 0 ? text[0] : '';
            const escapedPrefix = prefix.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            el.innerHTML = '<span class="diff-prefix">' + escapedPrefix + '</span>' + hLines[idx];
        }}
    }});
    fileDiff.dataset.lang = lang;
    fileDiff.dataset.highlighted = 'true';
    return true;
}}

function loadHljsLanguage(lang) {{
    return new Promise((resolve, reject) => {{
        if (typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {{ resolve(); return; }}
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/' + lang + '.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Language "' + lang + '" not found'));
        document.head.appendChild(script);
    }});
}}

function markUnhighlightedFiles() {{
    if (typeof hljs === 'undefined') return;
    document.querySelectorAll('.file-block').forEach(block => {{
        const fileDiff = block.querySelector('.file-diff');
        if (!fileDiff || fileDiff.dataset.highlighted === 'true') return;
        const header = block.querySelector('.file-header');
        if (!header || header.querySelector('.lang-picker-btn')) return;

        const attemptedLang = fileDiff.dataset.lang;
        const btn = document.createElement('button');
        btn.className = 'lang-picker-btn';
        if (attemptedLang) {{
            btn.textContent = '\\u{{1f3a8}} ' + attemptedLang;
            btn.title = attemptedLang + ' grammar not in core bundle \\u2014 click to load from CDN or choose another';
        }} else {{
            btn.textContent = '\\u{{1f3a8}} no highlighting';
            btn.title = 'No syntax highlighting \\u2014 click to choose a language';
        }}
        btn.addEventListener('click', function(e) {{
            e.stopPropagation();
            // If a known lang is mapped but wasn't available, try loading it directly
            if (attemptedLang && (typeof hljs === 'undefined' || !hljs.getLanguage(attemptedLang))) {{
                btn.textContent = '\\u23f3 loading ' + attemptedLang + '...';
                btn.className = 'lang-picker-btn lang-loading';
                loadHljsLanguage(attemptedLang).then(() => {{
                    const success = highlightSingleFile(fileDiff, attemptedLang);
                    if (success) {{
                        btn.textContent = '\\u2713 ' + attemptedLang;
                        btn.className = 'lang-picker-btn lang-applied';
                        btn.title = 'Highlighted as ' + attemptedLang + ' \\u2014 click to change';
                        saveCustomMapping(block.dataset.file, attemptedLang);
                    }} else {{
                        openLangPicker(block);
                    }}
                }}).catch(() => {{
                    openLangPicker(block);
                }});
                return;
            }}
            openLangPicker(block);
        }});
        const stats = header.querySelector('.file-stats');
        if (stats) header.insertBefore(btn, stats);
    }});
}}

function openLangPicker(fileBlock) {{
    langPickerTarget = fileBlock;
    let overlay = document.getElementById('lang-picker-overlay');
    if (!overlay) {{
        overlay = document.createElement('div');
        overlay.id = 'lang-picker-overlay';
        const picker = document.createElement('div');
        picker.className = 'lang-picker';
        picker.innerHTML =
            '<div class="lang-picker-header">' +
            '<h3>Choose syntax highlighting</h3>' +
            '<button class="lang-picker-close" id="lp-close">\\u2715</button>' +
            '</div>' +
            '<input class="lang-picker-search" id="lp-search" type="text" placeholder="Search languages... (or type any hljs grammar name)">' +
            '<div class="lang-picker-list" id="lp-list"></div>';
        overlay.appendChild(picker);
        document.body.appendChild(overlay);

        document.getElementById('lp-close').addEventListener('click', closeLangPicker);
        overlay.addEventListener('click', function(e) {{
            if (e.target === overlay) closeLangPicker();
        }});

        const search = document.getElementById('lp-search');
        search.addEventListener('input', function() {{
            filterLangList(search.value);
        }});
        search.addEventListener('keydown', function(e) {{
            if (e.key === 'Escape') {{ closeLangPicker(); e.stopPropagation(); }}
            if (e.key === 'Enter') {{
                const visible = document.querySelector('.lang-picker-item:not([style*="display: none"])');
                if (visible) {{
                    visible.click();
                }} else {{
                    // Allow typing a custom language name
                    const custom = search.value.trim().toLowerCase();
                    if (custom) {{
                        closeLangPicker();
                        if (langPickerTarget) applyLanguageToFile(langPickerTarget, custom);
                    }}
                }}
            }}
        }});
    }}

    populateLangList();
    overlay.style.display = 'flex';
    const search = document.getElementById('lp-search');
    search.value = '';
    search.focus();
    filterLangList('');
}}

function closeLangPicker() {{
    const overlay = document.getElementById('lang-picker-overlay');
    if (overlay) overlay.style.display = 'none';
    langPickerTarget = null;
}}

function populateLangList() {{
    const list = document.getElementById('lp-list');
    if (!list) return;
    list.innerHTML = '';

    // Categorize: core (loaded) vs CDN
    const core = [];
    const cdn = [];
    for (const [id, name] of HLJS_LANGUAGES) {{
        if (typeof hljs !== 'undefined' && hljs.getLanguage(id)) {{
            core.push([id, name]);
        }} else {{
            cdn.push([id, name]);
        }}
    }}

    if (core.length > 0) {{
        const sec = document.createElement('div');
        sec.className = 'lp-section';
        sec.textContent = 'Available';
        list.appendChild(sec);
        for (const [id, name] of core) {{
            list.appendChild(createLangItem(id, name, false));
        }}
    }}
    if (cdn.length > 0) {{
        const sec = document.createElement('div');
        sec.className = 'lp-section';
        sec.textContent = 'Load from CDN';
        list.appendChild(sec);
        for (const [id, name] of cdn) {{
            list.appendChild(createLangItem(id, name, true));
        }}
    }}
}}

function createLangItem(id, name, isCdn) {{
    const btn = document.createElement('button');
    btn.className = 'lang-picker-item';
    btn.dataset.lang = id;
    btn.dataset.search = (id + ' ' + name).toLowerCase();
    btn.innerHTML =
        '<span class="lp-name">' + escLangHtml(name) + '</span>' +
        '<span class="lp-id">' + escLangHtml(id) + '</span>' +
        (isCdn ? '<span class="lp-cdn">CDN</span>' : '');
    btn.addEventListener('click', function() {{
        closeLangPicker();
        if (langPickerTarget) applyLanguageToFile(langPickerTarget, id);
    }});
    return btn;
}}

function escLangHtml(s) {{
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}}

function filterLangList(query) {{
    const q = query.toLowerCase().trim();
    document.querySelectorAll('.lang-picker-item').forEach(item => {{
        item.style.display = item.dataset.search.includes(q) ? '' : 'none';
    }});
    // Also hide section headers if all their items are hidden
    document.querySelectorAll('.lp-section').forEach(sec => {{
        let next = sec.nextElementSibling;
        let anyVisible = false;
        while (next && !next.classList.contains('lp-section')) {{
            if (next.style.display !== 'none') anyVisible = true;
            next = next.nextElementSibling;
        }}
        sec.style.display = anyVisible ? '' : 'none';
    }});
}}

async function applyLanguageToFile(fileBlock, lang) {{
    const fileDiff = fileBlock.querySelector('.file-diff');
    if (!fileDiff || typeof hljs === 'undefined') return;

    const btn = fileBlock.querySelector('.lang-picker-btn');

    // Try loading the grammar if not registered
    if (!hljs.getLanguage(lang)) {{
        if (btn) {{
            btn.textContent = '\\u23f3 loading ' + lang + '...';
            btn.className = 'lang-picker-btn lang-loading';
        }}
        try {{
            await loadHljsLanguage(lang);
        }} catch(e) {{
            if (btn) {{
                btn.textContent = '\\u274c ' + lang + ' not found';
                btn.className = 'lang-picker-btn';
                btn.title = 'Grammar "' + lang + '" could not be loaded \\u2014 click to try another';
                setTimeout(() => {{
                    btn.textContent = '\\u{{1f3a8}} no highlighting';
                    btn.className = 'lang-picker-btn';
                }}, 2500);
            }}
            return;
        }}
    }}

    const success = highlightSingleFile(fileDiff, lang);
    if (success && btn) {{
        btn.textContent = '\\u2713 ' + lang;
        btn.className = 'lang-picker-btn lang-applied';
        btn.title = 'Highlighted as ' + lang + ' \\u2014 click to change';
        // Re-bind click to open picker (for changing language)
        const newBtn = btn.cloneNode(true);
        newBtn.addEventListener('click', function(e) {{
            e.stopPropagation();
            openLangPicker(fileBlock);
        }});
        btn.replaceWith(newBtn);
    }}

    saveCustomMapping(fileBlock.dataset.file, lang);
}}

function saveCustomMapping(filepath, lang) {{
    try {{
        const key = getFileExtension(filepath);
        const mappings = JSON.parse(localStorage.getItem('pr-review-lang-mappings') || '{{}}');
        mappings[key] = lang;
        localStorage.setItem('pr-review-lang-mappings', JSON.stringify(mappings));
    }} catch(e) {{}}
}}

async function loadCustomMappings() {{
    if (typeof hljs === 'undefined') return;
    try {{
        const mappings = JSON.parse(localStorage.getItem('pr-review-lang-mappings') || '{{}}');
        if (Object.keys(mappings).length === 0) return;

        for (const block of document.querySelectorAll('.file-block')) {{
            const fileDiff = block.querySelector('.file-diff');
            if (!fileDiff || fileDiff.dataset.highlighted === 'true') continue;

            const file = block.dataset.file;
            const ext = getFileExtension(file);
            const lang = mappings[ext];
            if (!lang) continue;

            // Load grammar if needed, then highlight
            if (!hljs.getLanguage(lang)) {{
                try {{
                    await loadHljsLanguage(lang);
                }} catch(e) {{
                    continue;
                }}
            }}
            const success = highlightSingleFile(fileDiff, lang);
            if (success) {{
                // Update any existing indicator button
                const btn = block.querySelector('.lang-picker-btn');
                if (btn) {{
                    btn.textContent = '\\u2713 ' + lang;
                    btn.className = 'lang-picker-btn lang-applied';
                    btn.title = 'Highlighted as ' + lang + ' (saved) \\u2014 click to change';
                    const newBtn = btn.cloneNode(true);
                    newBtn.addEventListener('click', function(e) {{
                        e.stopPropagation();
                        openLangPicker(block);
                    }});
                    btn.replaceWith(newBtn);
                }}
            }}
        }}
    }} catch(e) {{}}
}}

// Run after DOM is ready
highlightDiffs();
markUnhighlightedFiles();
loadCustomMappings();

// ── Copy code ─────────────────────────────────────────────────────────────

function copyFileCode(btn) {{
    const fileBlock = btn.closest('.file-block');
    if (!fileBlock) return;
    const fileDiff = fileBlock.querySelector('.file-diff');
    if (!fileDiff) return;
    const lines = [];
    fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
        // Skip deleted lines — we want the new-file version
        if (row.classList.contains('diff-del')) return;
        const code = row.querySelector('.diff-code');
        if (!code) return;
        const text = code.textContent;
        // Strip the diff prefix character (+, space, or context)
        lines.push(text.length > 0 ? text.substring(1) : '');
    }});
    const text = lines.join('\\n');
    navigator.clipboard.writeText(text).then(() => {{
        btn.classList.add('copied');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => {{
            btn.textContent = orig;
            btn.classList.remove('copied');
        }}, 1500);
    }});
}}

// ── File collapse (generalized for preview support) ───────────────────────

function toggleFileCollapse(header) {{
    const block = header.closest('.file-block');
    const diff = block.querySelector('.file-diff');
    const preview = block.querySelector('.file-preview');
    // If preview is active (visible), toggle the preview container
    if (preview && preview.style.display !== 'none') {{
        preview.classList.toggle('collapsed');
    }} else {{
        diff.classList.toggle('collapsed');
    }}
}}

// ── Markdown Preview ──────────────────────────────────────────────────────

let markedLoaded = false;
function ensureMarkedLoaded() {{
    if (markedLoaded && typeof marked !== 'undefined') return Promise.resolve();
    return new Promise((resolve, reject) => {{
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
        script.onload = () => {{ markedLoaded = true; resolve(); }};
        script.onerror = () => reject(new Error('Failed to load marked.js'));
        document.head.appendChild(script);
    }});
}}

function extractNewFileContent(fileDiff) {{
    // Extracts the new-file content: context lines + additions, skip deletions.
    // Groups by hunk and inserts separators between non-contiguous hunks.
    const chunks = [];
    let currentChunk = [];
    let lastNewLine = null;
    let inContent = false;

    fileDiff.querySelectorAll('.diff-line-row, .diff-hunk').forEach(el => {{
        if (el.classList.contains('diff-hunk')) {{
            // Start a new chunk for each hunk
            if (currentChunk.length > 0) {{
                chunks.push(currentChunk.join('\\n'));
                currentChunk = [];
            }}
            inContent = true;
            return;
        }}
        if (!inContent) return;
        if (el.classList.contains('diff-del')) return; // skip deleted lines
        const code = el.querySelector('.diff-code');
        if (!code) return;
        const text = code.textContent;
        currentChunk.push(text.length > 0 ? text.substring(1) : '');
    }});
    if (currentChunk.length > 0) chunks.push(currentChunk.join('\\n'));
    return chunks;
}}

async function toggleMarkdownPreview(btn) {{
    const block = btn.closest('.file-block');
    const diff = block.querySelector('.file-diff');
    const preview = block.querySelector('.file-preview');
    if (!preview) return;

    if (preview.style.display !== 'none') {{
        // Switch back to diff view
        preview.style.display = 'none';
        diff.style.display = '';
        diff.classList.remove('collapsed');
        btn.textContent = '👁️ Preview';
        btn.classList.remove('btn-preview-active');
    }} else {{
        // Switch to preview
        try {{
            btn.textContent = '⏳ Loading...';
            await ensureMarkedLoaded();
            const chunks = extractNewFileContent(diff);
            let renderedHtml = '';
            for (let i = 0; i < chunks.length; i++) {{
                if (i > 0) {{
                    renderedHtml += '<div class="preview-hunk-sep">⋯ non-contiguous section ⋯</div>';
                }}
                renderedHtml += marked.parse(chunks[i]);
            }}
            preview.innerHTML = renderedHtml;
            diff.style.display = 'none';
            preview.style.display = '';
            btn.textContent = '📝 Diff';
            btn.classList.add('btn-preview-active');
        }} catch(e) {{
            console.warn('Markdown preview error:', e);
            btn.textContent = '👁️ Preview';
        }}
    }}
}}

// ── Flagging ──────────────────────────────────────────────────────────────

function toggleFlag(noteId) {{
    const el = document.getElementById(noteId);
    if (flaggedNotes.has(noteId)) {{
        flaggedNotes.delete(noteId);
        el.classList.remove('flagged');
    }} else {{
        flaggedNotes.add(noteId);
        el.classList.add('flagged');
    }}
    updateStopBar();
    autoSave();
}}

function toggleEvidence(id) {{
    const el = document.getElementById(id);
    if (!el) return;
    const btn = el.previousElementSibling.querySelector('.evidence-btn');
    if (el.style.display === 'none') {{
        el.style.display = '';
        if (btn) btn.textContent = btn.textContent.replace('📎', '📂');
    }} else {{
        el.style.display = 'none';
        if (btn) btn.textContent = btn.textContent.replace('📂', '📎');
    }}
}}

function updateStopBar() {{
    const bar = document.getElementById('stop-bar');
    const count = document.getElementById('flag-count');
    const hint = document.getElementById('kbd-hint');
    if (flaggedNotes.size > 0) {{
        bar.classList.add('visible');
        hint.classList.add('raised');
        count.textContent = '🚩 ' + flaggedNotes.size + ' flagged';
    }} else {{
        bar.classList.remove('visible');
        hint.classList.remove('raised');
    }}
}}

function clearFlags() {{
    for (const noteId of flaggedNotes) {{
        const el = document.getElementById(noteId);
        if (el) el.classList.remove('flagged');
    }}
    flaggedNotes.clear();
    updateStopBar();
    autoSave();
}}

function requestBreakdown(phaseNum) {{
    const phase = planData.phases[phaseNum - 1];
    const phaseEl = document.getElementById('phase-' + phaseNum);
    const lines = [];
    lines.push('🔬 **Break down Phase ' + phaseNum + ': "' + phase.name + '"**');
    lines.push('');
    lines.push('This phase currently contains ' + phase.files.length + ' file(s):');

    // Get per-file stats from the DOM
    const fileBlocks = phaseEl.querySelectorAll('.file-block');
    for (const block of fileBlocks) {{
        const path = block.dataset.file;
        const stats = block.querySelector('.file-stats')?.textContent || '';
        lines.push('- `' + path + '` (' + stats.trim() + ')');
    }}
    lines.push('');

    // Include any comments the reviewer has already written
    const comment = document.getElementById('comment-' + phaseNum).value.trim();
    if (comment) {{
        lines.push('My notes on this phase so far:');
        lines.push(comment);
        lines.push('');
    }}

    // Include any inline comments on this phase
    const phaseInline = getInlineCommentsByPhase(phaseNum);
    if (phaseInline.length > 0) {{
        lines.push('My inline comments on this phase:');
        for (const ic of phaseInline) {{
            lines.push(formatInlineCommentForExport(ic));
        }}
        lines.push('');
    }}

    lines.push('Please break this down function-by-function (or section-by-section), using line ranges so each sub-phase shows only its portion of the file. Use {{"path": "file.py", "start": N, "end": N, "label": "..."}} format in the files array.');

    navigator.clipboard.writeText(lines.join('\\n')).then(() => {{
        const btn = phaseEl.querySelector('.btn-breakdown');
        if (btn) {{
            const orig = btn.innerHTML;
            btn.textContent = '✓ Copied! Paste into terminal.';
            btn.classList.add('btn-breakdown-copied');
            setTimeout(() => {{
                btn.innerHTML = orig;
                btn.classList.remove('btn-breakdown-copied');
            }}, 2500);
        }}
    }});
}}

function stopAndDiscuss() {{
    // Build a message with: where I am, what's flagged, and any comments so far
    const lines = [];
    lines.push('⚡ **Stopping review to discuss flagged items**');
    lines.push('Currently on: Phase ' + currentPhase + ' of ' + NUM_PHASES);
    lines.push('');

    // Include impact context if available
    if (planData.impact_analysis) {{
        const blast = planData.impact_analysis.blast_radius || {{}};
        const levels = ['critical', 'high', 'medium', 'low'];
        const counts = levels.filter(l => blast[l] > 0).map(l => blast[l] + ' ' + l);
        if (counts.length > 0) {{
            lines.push('**🎯 Blast radius:** ' + counts.join(', ') + ' (' + (blast.total_affected || 0) + ' total affected)');
            lines.push('');
        }}
    }}

    // Flagged items grouped by phase
    lines.push('### Flagged AI observations:');
    const byPhase = {{}};
    for (const noteId of flaggedNotes) {{
        const el = document.getElementById(noteId);
        if (!el) continue;
        const phase = el.dataset.phase;
        const severity = el.dataset.severity;
        const text = el.dataset.text;
        if (!byPhase[phase]) byPhase[phase] = [];
        const hasEvidence = el.querySelector('.evidence-block') !== null;
        byPhase[phase].push({{ severity, text, hasEvidence }});
    }}
    for (const [phase, notes] of Object.entries(byPhase).sort()) {{
        const phaseName = planData.phases[phase - 1].name;
        lines.push('**Phase ' + phase + ' (' + phaseName + '):**');
        for (const note of notes) {{
            const icons = {{ issue: '❌', suggestion: '⚠️', nit: '💡', good: '✅', question: '❓' }};
            lines.push('- ' + (icons[note.severity] || '💬') + ' ' + note.text);
        }}
        lines.push('');
    }}

    // Include inline comments with code context
    let hasInline = false;
    for (let i = 1; i <= NUM_PHASES; i++) {{
        const phaseInline = getInlineCommentsByPhase(i);
        if (phaseInline.length > 0) {{
            if (!hasInline) {{
                lines.push('### Inline comments so far:');
                hasInline = true;
            }}
            const phaseName = planData.phases[i-1].name;
            lines.push('**Phase ' + i + ' (' + phaseName + '):**');
            for (const ic of phaseInline) {{
                lines.push(formatInlineCommentForExport(ic));
            }}
            lines.push('');
        }}
    }}

    // Include any comments written so far
    let hasComments = false;
    for (let i = 1; i <= NUM_PHASES; i++) {{
        const comment = document.getElementById('comment-' + i).value.trim();
        if (comment) {{
            if (!hasComments) {{
                lines.push('### My comments so far:');
                hasComments = true;
            }}
            const phaseName = planData.phases[i-1].name;
            lines.push('**Phase ' + i + ' (' + phaseName + '):**');
            lines.push(comment);
            lines.push('');
        }}
    }}

    const text = lines.join('\\n');
    navigator.clipboard.writeText(text).then(() => {{
        const bar = document.getElementById('stop-bar');
        const origHTML = document.querySelector('.btn-stop').textContent;
        document.querySelector('.btn-stop').textContent = '✓ Copied! Paste into terminal.';
        setTimeout(() => {{
            document.querySelector('.btn-stop').textContent = origHTML;
        }}, 2000);
    }});
}}

// ── Phase navigation ──────────────────────────────────────────────────────

const HAS_CONTEXT_TAB = !!document.getElementById('context-tab');

function hideAllViews() {{
    for (let i = 1; i <= NUM_PHASES; i++) {{
        document.getElementById('phase-' + i).style.display = 'none';
        document.getElementById('tab-' + i).classList.remove('active');
    }}
    document.getElementById('summary').style.display = 'none';
    document.getElementById('tab-summary').classList.remove('active');
    if (HAS_CONTEXT_TAB) {{
        document.getElementById('context-tab').style.display = 'none';
        document.getElementById('tab-context').classList.remove('active');
    }}
}}

function goPhase(n) {{
    if (n < 1 || n > NUM_PHASES) return;
    hideAllViews();
    document.getElementById('phase-' + n).style.display = '';
    document.getElementById('tab-' + n).classList.add('active');
    currentPhase = n;
    window.scrollTo(0, 0);
    // Render any mermaid diagrams in this phase (they need to be visible)
    if (window.renderMermaid) window.renderMermaid();
}}

function showContext() {{
    if (!HAS_CONTEXT_TAB) return;
    hideAllViews();
    document.getElementById('context-tab').style.display = '';
    document.getElementById('tab-context').classList.add('active');
    window.scrollTo(0, 0);
    // Re-render mermaid diagrams (may have been hidden when first rendered)
    if (window.renderMermaid) window.renderMermaid();
}}

function showSummary() {{
    hideAllViews();
    document.getElementById('summary').style.display = '';
    document.getElementById('tab-summary').classList.add('active');

    let summaryHTML = '';

    // Show impact analysis summary if available
    if (planData.impact_analysis) {{
        const impact = planData.impact_analysis;
        const blast = impact.blast_radius || {{}};
        const total = blast.total_affected || 0;
        summaryHTML += '<div class="summary-phase" style="border-color: var(--accent)">';
        summaryHTML += '<h3 style="color: var(--accent)">🎯 Impact Analysis</h3>';
        if (total > 0) {{
            const levels = [
                ['critical', '🔴', '#ff6b6b'],
                ['high', '🟠', '#ffa94d'],
                ['medium', '🟡', '#ffd43b'],
                ['low', '🟢', '#69db7c']
            ];
            summaryHTML += '<div style="display:flex;gap:16px;margin-bottom:8px;font-size:0.9em">';
            for (const [level, icon, color] of levels) {{
                const count = blast[level] || 0;
                if (count > 0) {{
                    summaryHTML += '<span style="color:' + color + '">' + icon + ' ' + count + ' ' + level + '</span>';
                }}
            }}
            summaryHTML += '<span style="color:var(--text-muted)">(' + total + ' total affected)</span>';
            summaryHTML += '</div>';
        }}
        if (impact.architecture_context) {{
            summaryHTML += '<div style="color:var(--text-muted);font-size:0.9em;margin-top:4px">📐 ' + escapeHtml(impact.architecture_context) + '</div>';
        }}
        summaryHTML += '</div>';
    }}

    // Show flagged items first if any
    if (flaggedNotes.size > 0) {{
        summaryHTML += '<div class="summary-phase" style="border-color: var(--flag-border)">';
        summaryHTML += '<h3 style="color: var(--flag-border)">🚩 Flagged for Discussion (' + flaggedNotes.size + ')</h3>';
        for (const noteId of flaggedNotes) {{
            const el = document.getElementById(noteId);
            if (!el) continue;
            const phase = el.dataset.phase;
            const text = el.dataset.text;
            const phaseName = planData.phases[phase - 1].name;
            summaryHTML += '<div class="summary-flagged-item">Phase ' + phase + ' (' + escapeHtml(phaseName) + '): ' + escapeHtml(text) + '</div>';
        }}
        summaryHTML += '</div>';
    }}

    for (let i = 1; i <= NUM_PHASES; i++) {{
        const comment = document.getElementById('comment-' + i).value.trim();
        const phaseName = planData.phases[i-1].name;
        const phaseInline = getInlineCommentsByPhase(i);
        summaryHTML += '<div class="summary-phase">';
        summaryHTML += '<h3>Phase ' + i + ': ' + escapeHtml(phaseName) + '</h3>';
        if (phaseInline.length > 0) {{
            summaryHTML += '<div class="summary-inline"><strong>💬 Inline comments:</strong>';
            for (const ic of phaseInline) {{
                const lineRef = formatLineRef(ic);
                summaryHTML += '<div class="summary-inline-item">';
                summaryHTML += '<span class="summary-inline-file">' + escapeHtml(ic.file) + ' ' + lineRef + '</span>';
                if (ic.diffContext && ic.diffContext.length > 0) {{
                    summaryHTML += '<pre class="summary-inline-code">';
                    for (const line of ic.diffContext) {{
                        summaryHTML += escapeHtml(line) + '\\n';
                    }}
                    summaryHTML += '</pre>';
                }}
                summaryHTML += '<div class="summary-inline-text">' + escapeHtml(ic.text) + '</div>';
                summaryHTML += '</div>';
            }}
            summaryHTML += '</div>';
        }}
        if (comment) {{
            summaryHTML += '<div class="summary-comment has-content">' + escapeHtml(comment) + '</div>';
        }} else if (phaseInline.length === 0) {{
            summaryHTML += '<div class="summary-comment">(no comments)</div>';
        }}
        summaryHTML += '</div>';
    }}
    document.getElementById('summary-content').innerHTML = summaryHTML;
    window.scrollTo(0, 0);
}}

// ── Feedback export ───────────────────────────────────────────────────────

function escapeHtml(text) {{
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}}

function getFeedbackData() {{
    const feedback = {{
        pr_number: planData.number,
        pr_title: planData.title,
        pr_url: planData.url || '',
        timestamp: new Date().toISOString(),
        impact_analysis: planData.impact_analysis || null,
        flagged: [],
        phases: []
    }};
    for (const noteId of flaggedNotes) {{
        const el = document.getElementById(noteId);
        if (!el) continue;
        const phaseIdx = parseInt(el.dataset.phase) - 1;
        const noteIdx = parseInt(noteId.split('-').pop());
        const evidenceData = (planData.phases[phaseIdx] &&
            planData.phases[phaseIdx].ai_notes &&
            planData.phases[phaseIdx].ai_notes[noteIdx] &&
            planData.phases[phaseIdx].ai_notes[noteIdx].evidence) || [];
        feedback.flagged.push({{
            phase: parseInt(el.dataset.phase),
            severity: el.dataset.severity,
            text: el.dataset.text,
            evidence: evidenceData
        }});
    }}
    for (let i = 1; i <= NUM_PHASES; i++) {{
        feedback.phases.push({{
            phase: i,
            name: planData.phases[i-1].name,
            files: planData.phases[i-1].files,
            comment: document.getElementById('comment-' + i).value.trim(),
            inlineComments: getInlineCommentsByPhase(i).map(ic => ({{
                file: ic.file,
                startIdx: ic.startIdx,
                endIdx: ic.endIdx,
                newLineStart: ic.newLineStart,
                newLineEnd: ic.newLineEnd,
                oldLineStart: ic.oldLineStart,
                oldLineEnd: ic.oldLineEnd,
                text: ic.text,
                diffContext: ic.diffContext || []
            }}))
        }});
    }}
    return feedback;
}}

function exportFeedback() {{
    const feedback = getFeedbackData();
    let text = '## PR Review Feedback: ' + feedback.pr_title + ' (#' + feedback.pr_number + ')\\n\\n';

    // Include impact analysis in export
    if (planData.impact_analysis) {{
        const impact = planData.impact_analysis;
        const blast = impact.blast_radius || {{}};
        text += '### 🎯 Impact Analysis\\n';
        const levels = ['critical', 'high', 'medium', 'low'];
        const counts = levels.filter(l => blast[l] > 0).map(l => blast[l] + ' ' + l);
        if (counts.length > 0) {{
            text += 'Blast radius: ' + counts.join(', ') + ' (' + (blast.total_affected || 0) + ' total affected)\\n';
        }}
        if (impact.architecture_context) {{
            text += 'Context: ' + impact.architecture_context + '\\n';
        }}
        text += '\\n';
    }}

    if (feedback.flagged.length > 0) {{
        text += '### 🚩 Flagged AI observations for discussion:\\n';
        for (const f of feedback.flagged) {{
            const icons = {{ issue: '❌', suggestion: '⚠️', nit: '💡', good: '✅', question: '❓' }};
            const phaseName = planData.phases[f.phase - 1].name;
            text += '- Phase ' + f.phase + ' (' + phaseName + '): ' + (icons[f.severity] || '💬') + ' ' + f.text + '\\n';
        }}
        text += '\\n';
    }}

    for (const phase of feedback.phases) {{
        text += '### Phase ' + phase.phase + ': ' + phase.name + '\\n';
        text += 'Files: ' + phase.files.join(', ') + '\\n';
        if (phase.inlineComments && phase.inlineComments.length > 0) {{
            text += '\\n**Inline comments:**\\n';
            for (const ic of phase.inlineComments) {{
                text += formatInlineCommentForExport(ic);
            }}
        }}
        if (phase.comment) {{
            text += '\\n' + phase.comment + '\\n';
        }} else if (!phase.inlineComments || phase.inlineComments.length === 0) {{
            text += '(no comments)\\n';
        }}
        text += '\\n';
    }}
    navigator.clipboard.writeText(text).then(() => {{
        document.getElementById('save-status').textContent = '✓ Copied to clipboard! Paste into your terminal.';
    }});
}}

function downloadFeedback() {{
    const feedback = getFeedbackData();
    const blob = new Blob([JSON.stringify(feedback, null, 2)], {{ type: 'application/json' }});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pr-' + feedback.pr_number + '-review.json';
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById('save-status').textContent = '✓ Downloaded as pr-' + feedback.pr_number + '-review.json';
}}

// ── Persistence ───────────────────────────────────────────────────────────

function autoSave() {{
    const data = {{
        comments: {{}},
        flags: [...flaggedNotes],
        inlineComments: inlineComments,
        _meta: {{
            numPhases: NUM_PHASES,
            phaseNames: planData.phases.map(p => p.name)
        }}
    }};
    for (let i = 1; i <= NUM_PHASES; i++) {{
        data.comments['phase-' + i] = document.getElementById('comment-' + i).value;
    }}
    localStorage.setItem('pr-review-' + planData.number, JSON.stringify(data));
}}

function loadSaved() {{
    try {{
        const saved = localStorage.getItem('pr-review-' + planData.number);
        if (!saved) return;
        const data = JSON.parse(saved);
        const meta = data._meta;
        const comments = data.comments || data; // backward compat

        // Detect phase structure change (e.g. after a phase breakdown)
        const structureChanged = meta && meta.numPhases !== NUM_PHASES;

        if (structureChanged) {{
            // Phase structure changed — restore comments by matching phase names
            const oldNames = meta.phaseNames || [];
            const newNames = planData.phases.map(p => p.name);
            const nameToNewIdx = {{}};
            newNames.forEach((name, idx) => {{ nameToNewIdx[name] = idx + 1; }});

            for (let oldIdx = 1; oldIdx <= oldNames.length; oldIdx++) {{
                const oldName = oldNames[oldIdx - 1];
                const newIdx = nameToNewIdx[oldName];
                if (newIdx && comments['phase-' + oldIdx]) {{
                    document.getElementById('comment-' + newIdx).value = comments['phase-' + oldIdx];
                }}
            }}

            // Flags and inline comments reference phase-specific DOM IDs that
            // shift when phases are renumbered, so we skip restoring them.
            // The reviewer is told about this in the regeneration message.
            console.log('[pr-review] Phase structure changed (' + (meta.numPhases || '?') +
                ' → ' + NUM_PHASES + '). Comments restored by name match; flags/inline comments cleared.');
        }} else {{
            // Normal restore — phase structure unchanged
            for (let i = 1; i <= NUM_PHASES; i++) {{
                if (comments['phase-' + i]) {{
                    document.getElementById('comment-' + i).value = comments['phase-' + i];
                }}
            }}
            // Load flags
            if (data.flags) {{
                for (const noteId of data.flags) {{
                    const el = document.getElementById(noteId);
                    if (el) {{
                        flaggedNotes.add(noteId);
                        el.classList.add('flagged');
                    }}
                }}
                updateStopBar();
            }}
            // Load inline comments
            if (data.inlineComments) {{
                loadInlineComments(data.inlineComments);
            }}
        }}
    }} catch(e) {{}}
}}

// ── Inline Comments ───────────────────────────────────────────────────────

let inlineComments = {{}};
let lastGutterClick = null;
let activeInlineForm = null;

function findFileBlock(phase, file) {{
    for (const block of document.querySelectorAll('.file-block')) {{
        if (block.dataset.phase === String(phase) && block.dataset.file === file) {{
            return block;
        }}
    }}
    return null;
}}

function icKey(phase, file, start, end) {{
    return phase + ':' + file + ':' + start + '-' + end;
}}

// Format a real line reference from inline comment data
function formatLineRef(ic) {{
    // Prefer new-file lines (most relevant for reviewing additions)
    if (ic.newLineStart != null) {{
        if (ic.newLineEnd != null && ic.newLineEnd !== ic.newLineStart) {{
            return 'L' + ic.newLineStart + '-L' + ic.newLineEnd;
        }}
        return 'L' + ic.newLineStart;
    }}
    // Deleted lines only have old-file references
    if (ic.oldLineStart != null) {{
        if (ic.oldLineEnd != null && ic.oldLineEnd !== ic.oldLineStart) {{
            return 'L' + ic.oldLineStart + '-L' + ic.oldLineEnd + ' (deleted)';
        }}
        return 'L' + ic.oldLineStart + ' (deleted)';
    }}
    // Fallback to diff index (shouldn't happen with well-formed diffs)
    return 'diff-idx:' + ic.startIdx;
}}

// Format an inline comment for text export — includes code context
function formatInlineCommentForExport(ic) {{
    const lineRef = formatLineRef(ic);
    let out = '- `' + ic.file + '` ' + lineRef + ':\\n';
    if (ic.diffContext && ic.diffContext.length > 0) {{
        out += '  ```\\n';
        for (const line of ic.diffContext) {{
            out += '  ' + line + '\\n';
        }}
        out += '  ```\\n';
    }}
    out += '  ' + ic.text + '\\n';
    return out;
}}

function clearLineSelection() {{
    document.querySelectorAll('.diff-line-row.line-selected').forEach(el => {{
        el.classList.remove('line-selected');
    }});
}}

function cancelActiveForm() {{
    if (activeInlineForm) {{
        activeInlineForm.remove();
        activeInlineForm = null;
    }}
    clearLineSelection();
}}

function showInlineCommentForm(phase, file, startIdx, endIdx, fileBlock) {{
    cancelActiveForm();
    clearLineSelection();

    const fileDiff = fileBlock.querySelector('.file-diff');
    if (!fileDiff) return;

    let lastSelectedRow = null;
    fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
        const lidx = parseInt(row.dataset.lidx);
        if (lidx >= startIdx && lidx <= endIdx) {{
            row.classList.add('line-selected');
            lastSelectedRow = row;
        }}
    }});

    if (!lastSelectedRow) return;

    const key = icKey(phase, file, startIdx, endIdx);
    const existing = inlineComments[key];

    const form = document.createElement('div');
    form.className = 'inline-comment-form';
    form.dataset.key = key;
    form.dataset.phase = phase;
    form.dataset.file = file;
    form.dataset.start = startIdx;
    form.dataset.end = endIdx;

    const rangeLabel = startIdx === endIdx ? 'this line' : 'these ' + (endIdx - startIdx + 1) + ' lines';
    form.innerHTML =
        '<textarea placeholder="Add a review comment on ' + rangeLabel + '...">' + (existing ? escapeHtml(existing.text) : '') + '</textarea>' +
        '<div class="inline-comment-btns">' +
        '<span class="ic-hint"><kbd>⌘</kbd>+<kbd>Enter</kbd> to save · <kbd>Esc</kbd> to cancel</span>' +
        '<button class="btn-comment-cancel">Cancel</button>' +
        '<button class="btn-comment-save">' + (existing ? 'Update' : 'Comment') + '</button>' +
        '</div>';

    const existingSaved = fileDiff.querySelector('.inline-comment-saved[data-key="' + CSS.escape(key) + '"]');
    if (existingSaved) {{
        existingSaved.replaceWith(form);
    }} else {{
        lastSelectedRow.after(form);
    }}

    activeInlineForm = form;

    const textarea = form.querySelector('textarea');
    textarea.focus();
    if (existing) {{
        textarea.selectionStart = textarea.value.length;
    }}

    textarea.addEventListener('keydown', function(e) {{
        if (e.key === 'Escape') {{
            const k = form.dataset.key;
            if (inlineComments[k]) {{
                restoreSavedComment(k, form);
            }} else {{
                cancelActiveForm();
            }}
            e.stopPropagation();
        }} else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {{
            saveInlineCommentFromForm(form);
            e.preventDefault();
        }}
    }});
}}

function saveInlineCommentFromForm(form) {{
    const textarea = form.querySelector('textarea');
    const text = textarea.value.trim();
    if (!text) {{ textarea.focus(); return; }}

    const key = form.dataset.key;
    const phase = parseInt(form.dataset.phase);
    const file = form.dataset.file;
    const startIdx = parseInt(form.dataset.start);
    const endIdx = parseInt(form.dataset.end);

    const fileDiff = form.parentElement;
    const diffContext = [];
    let newLineStart = null, newLineEnd = null;
    let oldLineStart = null, oldLineEnd = null;
    if (fileDiff) {{
        fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
            const lidx = parseInt(row.dataset.lidx);
            if (lidx >= startIdx && lidx <= endIdx) {{
                const code = row.querySelector('.diff-code');
                if (code) diffContext.push(code.textContent);
                // Capture real file line numbers from data attributes
                const nl = row.dataset.newLine ? parseInt(row.dataset.newLine) : null;
                const ol = row.dataset.oldLine ? parseInt(row.dataset.oldLine) : null;
                if (nl !== null) {{
                    if (newLineStart === null || nl < newLineStart) newLineStart = nl;
                    if (newLineEnd === null || nl > newLineEnd) newLineEnd = nl;
                }}
                if (ol !== null) {{
                    if (oldLineStart === null || ol < oldLineStart) oldLineStart = ol;
                    if (oldLineEnd === null || ol > oldLineEnd) oldLineEnd = ol;
                }}
            }}
        }});
    }}

    inlineComments[key] = {{
        phase, file, startIdx, endIdx, text, diffContext,
        newLineStart, newLineEnd, oldLineStart, oldLineEnd
    }};

    const savedEl = createSavedCommentEl(key);
    form.replaceWith(savedEl);
    activeInlineForm = null;
    clearLineSelection();

    if (fileDiff) {{
        fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
            const lidx = parseInt(row.dataset.lidx);
            if (lidx >= startIdx && lidx <= endIdx) {{
                row.classList.add('has-comment');
            }}
        }});
    }}

    autoSave();
}}

function createSavedCommentEl(key) {{
    const comment = inlineComments[key];
    if (!comment) return null;

    const lineRef = formatLineRef(comment);
    const div = document.createElement('div');
    div.className = 'inline-comment-saved';
    div.dataset.key = key;
    div.innerHTML =
        '<span class="ic-icon">💬</span>' +
        '<div class="ic-text">' +
        '<span class="ic-line-ref">' + lineRef + '</span> ' +
        escapeHtml(comment.text) + '</div>' +
        '<div class="ic-actions">' +
        '<button class="ic-edit-btn" title="Edit">✏️</button>' +
        '<button class="ic-delete-btn" title="Delete">🗑️</button>' +
        '</div>';
    return div;
}}

function restoreSavedComment(key, replaceElement) {{
    const el = createSavedCommentEl(key);
    if (el && replaceElement) {{
        replaceElement.replaceWith(el);
    }}
    activeInlineForm = null;
    clearLineSelection();
}}

function editInlineComment(key) {{
    const comment = inlineComments[key];
    if (!comment) return;
    const fileBlock = findFileBlock(comment.phase, comment.file);
    if (!fileBlock) return;
    showInlineCommentForm(comment.phase, comment.file, comment.startIdx, comment.endIdx, fileBlock);
}}

function deleteInlineComment(key) {{
    const comment = inlineComments[key];
    if (!comment) return;

    const savedEl = document.querySelector('.inline-comment-saved[data-key="' + CSS.escape(key) + '"]');
    if (savedEl) savedEl.remove();

    const fileBlock = findFileBlock(comment.phase, comment.file);
    if (fileBlock) {{
        const fileDiff = fileBlock.querySelector('.file-diff');
        if (fileDiff) {{
            fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
                const lidx = parseInt(row.dataset.lidx);
                if (lidx >= comment.startIdx && lidx <= comment.endIdx) {{
                    let otherComment = false;
                    for (const [k, c] of Object.entries(inlineComments)) {{
                        if (k !== key && c.phase === comment.phase && c.file === comment.file &&
                            lidx >= c.startIdx && lidx <= c.endIdx) {{
                            otherComment = true;
                            break;
                        }}
                    }}
                    if (!otherComment) row.classList.remove('has-comment');
                }}
            }});
        }}
    }}

    delete inlineComments[key];
    autoSave();
}}

function getInlineCommentsByPhase(phaseNum) {{
    const result = [];
    for (const [key, c] of Object.entries(inlineComments)) {{
        if (c.phase === phaseNum) result.push({{ key, ...c }});
    }}
    result.sort((a, b) => a.file.localeCompare(b.file) || a.startIdx - b.startIdx);
    return result;
}}

function loadInlineComments(saved) {{
    if (!saved) return;
    for (const [key, comment] of Object.entries(saved)) {{
        inlineComments[key] = comment;

        const fileBlock = findFileBlock(comment.phase, comment.file);
        if (!fileBlock) continue;

        const fileDiff = fileBlock.querySelector('.file-diff');
        if (!fileDiff) continue;

        let lastRow = null;
        fileDiff.querySelectorAll('.diff-line-row').forEach(row => {{
            const lidx = parseInt(row.dataset.lidx);
            if (lidx >= comment.startIdx && lidx <= comment.endIdx) {{
                row.classList.add('has-comment');
            }}
            if (lidx === comment.endIdx) lastRow = row;
        }});

        if (lastRow) {{
            const el = createSavedCommentEl(key);
            if (el) lastRow.after(el);
        }}
    }}
}}

// Delegated gutter click handler
document.addEventListener('mousedown', function(e) {{
    const gutter = e.target.closest('.diff-gutter');
    if (!gutter) return;

    const row = gutter.closest('.diff-line-row');
    if (!row) return;

    const fileBlock = row.closest('.file-block');
    if (!fileBlock) return;

    const phase = parseInt(fileBlock.dataset.phase);
    const file = fileBlock.dataset.file;
    const lidx = parseInt(row.dataset.lidx);

    if (e.shiftKey && lastGutterClick &&
        lastGutterClick.phase === phase && lastGutterClick.file === file) {{
        const start = Math.min(lastGutterClick.lidx, lidx);
        const end = Math.max(lastGutterClick.lidx, lidx);
        showInlineCommentForm(phase, file, start, end, fileBlock);
    }} else {{
        showInlineCommentForm(phase, file, lidx, lidx, fileBlock);
    }}

    lastGutterClick = {{ phase, file, lidx }};
    e.preventDefault();
}});

// Delegated click handler for inline comment buttons
document.addEventListener('click', function(e) {{
    const editBtn = e.target.closest('.ic-edit-btn');
    if (editBtn) {{
        const saved = editBtn.closest('.inline-comment-saved');
        if (saved) editInlineComment(saved.dataset.key);
        return;
    }}

    const deleteBtn = e.target.closest('.ic-delete-btn');
    if (deleteBtn) {{
        const saved = deleteBtn.closest('.inline-comment-saved');
        if (saved) deleteInlineComment(saved.dataset.key);
        return;
    }}

    const saveBtn = e.target.closest('.btn-comment-save');
    if (saveBtn) {{
        const form = saveBtn.closest('.inline-comment-form');
        if (form) saveInlineCommentFromForm(form);
        return;
    }}

    const cancelBtn = e.target.closest('.btn-comment-cancel');
    if (cancelBtn) {{
        const form = cancelBtn.closest('.inline-comment-form');
        if (form) {{
            const key = form.dataset.key;
            if (inlineComments[key]) {{
                restoreSavedComment(key, form);
            }} else {{
                cancelActiveForm();
            }}
        }}
        return;
    }}
}});

// ── Keyboard nav ──────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {{
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') {{
        const overlay = document.getElementById('lang-picker-overlay');
        if (overlay && overlay.style.display === 'flex') {{ closeLangPicker(); return; }}
    }}
    if (e.key === 'ArrowRight') {{
        if (HAS_CONTEXT_TAB && document.getElementById('context-tab').style.display !== 'none') goPhase(1);
        else if (currentPhase < NUM_PHASES) goPhase(currentPhase + 1);
        else showSummary();
    }}
    if (e.key === 'ArrowLeft') {{
        if (document.getElementById('summary').style.display !== 'none') goPhase(NUM_PHASES);
        else if (currentPhase > 1) goPhase(currentPhase - 1);
        else if (HAS_CONTEXT_TAB) showContext();
    }}
}});

loadSaved();
</script>
</body>
</html>'''


def main():
    parser = argparse.ArgumentParser(description="Generate PR review HTML page")
    parser.add_argument("--diff", required=True, help="Path to unified diff file")
    parser.add_argument("--plan", required=True, help="Path to review plan JSON")
    parser.add_argument("--output", required=True, help="Output HTML file path")
    parser.add_argument("--repo-dir", help="Git repo root — used to fetch content of new files missing from the diff")
    parser.add_argument("--head-sha", help="PR head commit SHA — combined with --repo-dir for exact file content")
    args = parser.parse_args()

    with open(args.diff) as f:
        diff_text = f.read()

    with open(args.plan) as f:
        plan = json.load(f)

    file_diffs = parse_diff(diff_text)
    html_content = generate_html(plan, file_diffs,
                                 repo_dir=args.repo_dir, head_sha=args.head_sha)

    with open(args.output, "w") as f:
        f.write(html_content)

    print(f"Review page written to {args.output}")


if __name__ == "__main__":
    main()
