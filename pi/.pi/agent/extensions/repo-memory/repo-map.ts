import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────

export interface Signature {
  kind: string;
  name: string;
  line: number;
  text: string;
}

export interface FileEntry {
  path: string;
  lang: string;
  sigs: Signature[];
}

export interface RepoMapData {
  gitSha: string | null;
  generatedAt: number;
  totalFiles: number;
  files: FileEntry[];
}

// ── Language detection ─────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",  ".tsx": "typescript",  ".mts": "typescript",  ".cts": "typescript",
  ".js": "javascript",  ".jsx": "javascript",  ".mjs": "javascript",  ".cjs": "javascript",
  ".py": "python",      ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",      ".kts": "kotlin",
  ".c": "c",            ".h": "c",
  ".cpp": "cpp",        ".hpp": "cpp",       ".cc": "cpp",  ".cxx": "cpp",
  ".rb": "ruby",        ".rake": "ruby",
  ".sh": "shell",       ".bash": "shell",    ".zsh": "shell",
  ".swift": "swift",
  ".scala": "scala",
  ".php": "php",
  ".cs": "csharp",
  ".ex": "elixir",      ".exs": "elixir",
  ".dart": "dart",
  ".lua": "lua",
};

function detectLang(filePath: string): string {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? "unknown";
}

// ── Skip logic ─────────────────────────────────────────────

const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".so", ".dylib", ".dll", ".o", ".a", ".exe", ".bin",
  ".wasm", ".pyc", ".class", ".map",
]);

const SKIP_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "Gemfile.lock", "poetry.lock", "composer.lock", "go.sum", ".DS_Store",
]);

function shouldSkip(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (SKIP_EXT.has(ext)) return true;
  if (SKIP_NAMES.has(name)) return true;
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return true;
  return false;
}

// ── Signature extraction ───────────────────────────────────

interface Pattern {
  minIndent?: number;
  maxIndent?: number;
  regex: RegExp;
  kind: string;
  nameGroup: number;
}

const NOISE = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "try",
  "finally", "throw", "return", "break", "continue", "new", "typeof",
  "delete", "void", "import", "require", "from", "with", "yield", "await",
  "super", "this", "constructor", "describe", "it", "test", "expect",
  "console", "log", "error", "warn",
]);

const TS_PATTERNS: Pattern[] = [
  // Exports (any indent)
  { regex: /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { regex: /^export\s+interface\s+(\w+)/, kind: "iface", nameGroup: 1 },
  { regex: /^export\s+type\s+(\w+)/, kind: "type", nameGroup: 1 },
  { regex: /^export\s+enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
  { regex: /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, kind: "fn", nameGroup: 1 },
  { regex: /^export\s+(?:const|let|var)\s+(\w+)/, kind: "const", nameGroup: 1 },
  // Top-level only
  { maxIndent: 0, regex: /^(?:async\s+)?function\s*\*?\s*(\w+)/, kind: "fn", nameGroup: 1 },
  { maxIndent: 0, regex: /^(?:abstract\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { maxIndent: 0, regex: /^interface\s+(\w+)/, kind: "iface", nameGroup: 1 },
  { maxIndent: 0, regex: /^type\s+(\w+)\s*[=<{]/, kind: "type", nameGroup: 1 },
  { maxIndent: 0, regex: /^enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
  // Methods (indented, with access modifiers)
  { minIndent: 2, maxIndent: 12, regex: /^(?:public|private|protected|static|abstract|override|readonly)\s+(?:(?:public|private|protected|static|abstract|async|override|readonly)\s+)*(?:get\s+|set\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/, kind: "method", nameGroup: 1 },
  { minIndent: 2, maxIndent: 12, regex: /^async\s+(\w+)\s*(?:<[^>]*>)?\s*\(/, kind: "method", nameGroup: 1 },
  { minIndent: 2, maxIndent: 12, regex: /^(?:get|set)\s+(\w+)\s*\(/, kind: "method", nameGroup: 1 },
  // Plain methods in class bodies (no modifier, name + parens + opening brace context)
  { minIndent: 2, maxIndent: 8, regex: /^(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*\S[^{]*)?{?\s*$/, kind: "method", nameGroup: 1 },
];

const PY_PATTERNS: Pattern[] = [
  { maxIndent: 0, regex: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { maxIndent: 0, regex: /^(?:async\s+)?def\s+(\w+)/, kind: "fn", nameGroup: 1 },
  { minIndent: 2, maxIndent: 16, regex: /^(?:async\s+)?def\s+(\w+)/, kind: "method", nameGroup: 1 },
];

const GO_PATTERNS: Pattern[] = [
  { maxIndent: 0, regex: /^func\s+\([^)]+\)\s*(\w+)/, kind: "method", nameGroup: 1 },
  { maxIndent: 0, regex: /^func\s+(\w+)/, kind: "fn", nameGroup: 1 },
  { maxIndent: 0, regex: /^type\s+(\w+)\s+struct\b/, kind: "struct", nameGroup: 1 },
  { maxIndent: 0, regex: /^type\s+(\w+)\s+interface\b/, kind: "iface", nameGroup: 1 },
  { maxIndent: 0, regex: /^type\s+(\w+)/, kind: "type", nameGroup: 1 },
];

const RS_PATTERNS: Pattern[] = [
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "fn", nameGroup: 1 },
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: "struct", nameGroup: 1 },
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: "trait", nameGroup: 1 },
  { regex: /^impl(?:<[^>]*>)?\s+(\w+)/, kind: "impl", nameGroup: 1 },
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, kind: "mod", nameGroup: 1 },
  { regex: /^(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/, kind: "type", nameGroup: 1 },
];

const JAVA_PATTERNS: Pattern[] = [
  { regex: /^(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { regex: /^(?:public|private|protected)?\s*(?:static\s+)?interface\s+(\w+)/, kind: "iface", nameGroup: 1 },
  { regex: /^(?:public|private|protected)?\s*(?:static\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
  { regex: /^(?:public|private|protected)?\s*(?:static\s+)?record\s+(\w+)/, kind: "record", nameGroup: 1 },
];

const SHELL_PATTERNS: Pattern[] = [
  { regex: /^function\s+(\w+)/, kind: "fn", nameGroup: 1 },
  { regex: /^(\w+)\s*\(\)\s*\{?/, kind: "fn", nameGroup: 1 },
];

const RB_PATTERNS: Pattern[] = [
  { regex: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { regex: /^module\s+(\w+)/, kind: "module", nameGroup: 1 },
  { regex: /^def\s+(?:self\.)?(\w+[?!=]?)/, kind: "fn", nameGroup: 1 },
];

const C_PATTERNS: Pattern[] = [
  { regex: /^(?:typedef\s+)?struct\s+(\w+)/, kind: "struct", nameGroup: 1 },
  { regex: /^(?:typedef\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
  { regex: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { regex: /^namespace\s+(\w+)/, kind: "ns", nameGroup: 1 },
  { regex: /^#define\s+(\w+)/, kind: "macro", nameGroup: 1 },
];

const LANG_PATTERNS: Record<string, Pattern[]> = {
  typescript: TS_PATTERNS,
  javascript: TS_PATTERNS,
  python: PY_PATTERNS,
  go: GO_PATTERNS,
  rust: RS_PATTERNS,
  java: JAVA_PATTERNS,
  kotlin: JAVA_PATTERNS,
  c: C_PATTERNS,
  cpp: C_PATTERNS,
  csharp: JAVA_PATTERNS,
  ruby: RB_PATTERNS,
  shell: SHELL_PATTERNS,
};

function isComment(line: string): boolean {
  return (
    line.startsWith("//") ||
    line.startsWith("/*") ||
    line.startsWith("* ") ||
    line.startsWith("# ") ||
    line.startsWith("-- ") ||
    line.startsWith('"""') ||
    line.startsWith("'''") ||
    line.startsWith("<!--")
  );
}

function cleanSig(line: string): string {
  let sig = line
    .replace(/\{[\s\S]*$/, "")
    .replace(/:\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (sig.length > 120) sig = sig.slice(0, 117) + "...";
  return sig;
}

function extractSignatures(content: string, lang: string): Signature[] {
  const patterns = LANG_PATTERNS[lang];
  if (!patterns) return [];

  const lines = content.split("\n");
  const sigs: Signature[] = [];
  const MAX_SIGS_PER_FILE = 40;

  for (let i = 0; i < lines.length && sigs.length < MAX_SIGS_PER_FILE; i++) {
    const raw = lines[i];
    const indent = raw.search(/\S/);
    if (indent < 0) continue;
    const trimmed = raw.trimStart();
    if (isComment(trimmed)) continue;

    for (const p of patterns) {
      if (p.minIndent !== undefined && indent < p.minIndent) continue;
      if (p.maxIndent !== undefined && indent > p.maxIndent) continue;

      const m = trimmed.match(p.regex);
      if (m) {
        const name = m[p.nameGroup];
        if (name && !NOISE.has(name)) {
          sigs.push({ kind: p.kind, name, line: i + 1, text: cleanSig(trimmed) });
        }
        break;
      }
    }
  }

  return sigs;
}

// ── Git helpers ────────────────────────────────────────────

async function gitCmd(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

// ── RepoMapper class ──────────────────────────────────────

export class RepoMapper {
  private cachePath: string;

  constructor(
    private cwd: string,
    storageDir: string
  ) {
    this.cachePath = path.join(storageDir, "map-cache.json");
  }

  async generate(opts?: {
    filterPath?: string;
    refresh?: boolean;
    signatures?: boolean;
  }): Promise<{ text: string; data: RepoMapData }> {
    const showSigs = opts?.signatures !== false;
    const currentSha = await gitCmd(this.cwd, "rev-parse", "--short", "HEAD");

    // Check cache
    if (!opts?.refresh) {
      const cached = this.loadCache();
      if (cached && cached.gitSha === currentSha) {
        return { text: this.format(cached, opts?.filterPath, showSigs), data: cached };
      }
    }

    // Get file list
    const rawFiles = await gitCmd(this.cwd, "ls-files", "--cached");
    let files: string[];
    if (rawFiles) {
      files = rawFiles.split("\n").filter(Boolean);
    } else {
      // Not a git repo — walk the filesystem (limited)
      files = this.walkDir(this.cwd, "", 500);
    }

    // Parse each file
    const entries: FileEntry[] = [];
    const MAX_FILES = 3000;
    const MAX_FILE_SIZE = 200 * 1024; // 200KB

    for (const file of files) {
      if (entries.length >= MAX_FILES) break;
      if (shouldSkip(file)) continue;

      const lang = detectLang(file);
      let sigs: Signature[] = [];

      if (LANG_PATTERNS[lang]) {
        try {
          const fullPath = path.join(this.cwd, file);
          const stat = fs.statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            const content = fs.readFileSync(fullPath, "utf-8");
            sigs = extractSignatures(content, lang);
          }
        } catch {
          // Unreadable file — skip signatures
        }
      }

      entries.push({ path: file, lang, sigs });
    }

    const data: RepoMapData = {
      gitSha: currentSha || null,
      generatedAt: Date.now(),
      totalFiles: files.length,
      files: entries,
    };

    this.saveCache(data);
    return { text: this.format(data, opts?.filterPath, showSigs), data };
  }

  /** Generate a language breakdown and architectural summary */
  summarize(data: RepoMapData): {
    languages: Record<string, { files: number; signatures: number }>;
    topPackages: Array<{ path: string; fileCount: number; sigCount: number }>;
    entryPoints: Array<{ name: string; file: string; line: number }>;
    totalSignatures: number;
  } {
    const languages: Record<string, { files: number; signatures: number }> = {};
    const dirStats: Record<string, { files: number; sigs: number }> = {};
    const entryPoints: Array<{ name: string; file: string; line: number }> = [];
    let totalSignatures = 0;

    for (const file of data.files) {
      const lang = file.lang || "unknown";
      if (!languages[lang]) languages[lang] = { files: 0, signatures: 0 };
      languages[lang].files++;
      languages[lang].signatures += file.sigs.length;
      totalSignatures += file.sigs.length;

      // Track top-level directories as "packages"
      const parts = file.path.split("/");
      const topDir = parts.length > 1 ? parts[0] : "(root)";
      if (!dirStats[topDir]) dirStats[topDir] = { files: 0, sigs: 0 };
      dirStats[topDir].files++;
      dirStats[topDir].sigs += file.sigs.length;

      // Detect entry points: main functions, index files, app/server files
      for (const sig of file.sigs) {
        if (
          sig.name === "main" ||
          sig.name === "app" ||
          sig.name === "server" ||
          sig.name === "default" ||
          (sig.kind === "fn" && /^(run|start|init|bootstrap|setup)$/i.test(sig.name))
        ) {
          entryPoints.push({ name: sig.name, file: file.path, line: sig.line });
        }
      }
    }

    const topPackages = Object.entries(dirStats)
      .map(([p, s]) => ({ path: p, fileCount: s.files, sigCount: s.sigs }))
      .sort((a, b) => b.sigCount - a.sigCount)
      .slice(0, 15);

    return { languages, topPackages, entryPoints: entryPoints.slice(0, 20), totalSignatures };
  }

  // ── Format output ───────────────────────────────────

  private format(data: RepoMapData, filterPath?: string, showSigs = true): string {
    const repoName = path.basename(this.cwd);
    const sha = data.gitSha ? ` [${data.gitSha}]` : "";
    const lines: string[] = [];

    lines.push(`Repository: ${repoName} (${data.totalFiles} files)${sha}`);
    lines.push("");

    // Add language breakdown when showing full repo (no filter)
    if (!filterPath) {
      const summary = this.summarize(data);
      const sortedLangs = Object.entries(summary.languages)
        .filter(([lang]) => lang !== "unknown")
        .sort((a, b) => b[1].files - a[1].files);

      if (sortedLangs.length > 0) {
        lines.push("Languages:");
        for (const [lang, stats] of sortedLangs) {
          const pct = ((stats.files / data.files.length) * 100).toFixed(0);
          lines.push(`  ${lang}: ${stats.files} files (${pct}%), ${stats.signatures} symbols`);
        }
        lines.push("");
      }
    }

    let files = data.files;
    if (filterPath) {
      const norm = filterPath.replace(/^[@./]+/, "").replace(/\/$/, "");
      files = files.filter(
        (f) => f.path.startsWith(norm + "/") || f.path === norm
      );
      if (files.length === 0) {
        lines.push(`No files found matching: ${filterPath}`);
        return lines.join("\n");
      }
      lines.push(`Filtered to: ${filterPath} (${files.length} files)`);
      lines.push("");
    }

    const MAX_OUTPUT_LINES = 1500;
    let truncated = false;

    for (const file of files) {
      if (lines.length >= MAX_OUTPUT_LINES) {
        truncated = true;
        break;
      }

      lines.push(file.path);

      if (showSigs && file.sigs.length > 0) {
        for (const sig of file.sigs) {
          if (lines.length >= MAX_OUTPUT_LINES) {
            truncated = true;
            break;
          }
          lines.push(`  ${sig.kind} ${sig.name}  (L${sig.line})`);
        }
      }
    }

    if (truncated) {
      lines.push("");
      lines.push(
        `[Truncated at ${MAX_OUTPUT_LINES} lines. Use path filter for specific areas: repo_map({ path: "src/..." })]`
      );
    }

    return lines.join("\n");
  }

  // ── Cache ───────────────────────────────────────────

  private loadCache(): RepoMapData | null {
    try {
      if (fs.existsSync(this.cachePath)) {
        return JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
      }
    } catch {}
    return null;
  }

  private saveCache(data: RepoMapData): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(data));
    } catch {}
  }

  // ── Fallback file walk (non-git repos) ──────────────

  private walkDir(base: string, rel: string, limit: number): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) break;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          if (["node_modules", "vendor", "dist", "build", ".git", "__pycache__", "target"].includes(entry.name)) continue;
          results.push(...this.walkDir(base, entryRel, limit - results.length));
        } else {
          results.push(entryRel);
        }
      }
    } catch {}
    return results;
  }
}
