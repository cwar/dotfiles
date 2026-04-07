import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Memory, Insight, ADRStore, ADRSection, ADRData } from "./memory";

const execAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
}

export interface ChangeImpact {
  changedFiles: ChangedFile[];
  totalInsertions: number;
  totalDeletions: number;
  relevantMemories: Array<{
    insight: Insight;
    matchedFiles: string[];
    matchedTags: string[];
  }>;
  relevantADRSections: ADRSection[];
  riskSummary: {
    level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    reasons: string[];
  };
}

// ── Git helpers ───────────────────────────────────────────

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

/** Parse git diff --numstat output into ChangedFile entries */
function parseNumstat(numstat: string, nameStatus: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const statusMap: Record<string, "added" | "modified" | "deleted" | "renamed"> = {};

  // Parse --name-status for status info
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const statusChar = parts[0][0];
    const filePath = parts[parts.length - 1]; // last part handles renames (old → new)
    switch (statusChar) {
      case "A": statusMap[filePath] = "added"; break;
      case "D": statusMap[filePath] = "deleted"; break;
      case "R": statusMap[filePath] = "renamed"; break;
      default: statusMap[filePath] = "modified"; break;
    }
  }

  // Parse --numstat for insertion/deletion counts
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const insertions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    const filePath = parts[2];
    files.push({
      path: filePath,
      status: statusMap[filePath] || "modified",
      insertions,
      deletions,
    });
  }

  return files;
}

// ── Change detection ──────────────────────────────────────

export async function detectChanges(
  cwd: string,
  scope: "unstaged" | "staged" | "all" | "branch",
  baseBranch: string | undefined,
  memory: Memory,
  adr: ADRStore
): Promise<ChangeImpact> {
  let numstat = "";
  let nameStatus = "";

  switch (scope) {
    case "unstaged":
      numstat = await gitCmd(cwd, "diff", "--numstat");
      nameStatus = await gitCmd(cwd, "diff", "--name-status");
      break;
    case "staged":
      numstat = await gitCmd(cwd, "diff", "--cached", "--numstat");
      nameStatus = await gitCmd(cwd, "diff", "--cached", "--name-status");
      break;
    case "all":
      numstat = await gitCmd(cwd, "diff", "HEAD", "--numstat");
      nameStatus = await gitCmd(cwd, "diff", "HEAD", "--name-status");
      break;
    case "branch": {
      const base = baseBranch || "main";
      // Find merge base for accurate branch diff
      const mergeBase = await gitCmd(cwd, "merge-base", base, "HEAD");
      if (mergeBase) {
        numstat = await gitCmd(cwd, "diff", mergeBase, "--numstat");
        nameStatus = await gitCmd(cwd, "diff", mergeBase, "--name-status");
      } else {
        numstat = await gitCmd(cwd, "diff", base, "--numstat");
        nameStatus = await gitCmd(cwd, "diff", base, "--name-status");
      }
      break;
    }
  }

  const changedFiles = parseNumstat(numstat, nameStatus);
  const totalInsertions = changedFiles.reduce((sum, f) => sum + f.insertions, 0);
  const totalDeletions = changedFiles.reduce((sum, f) => sum + f.deletions, 0);

  // Find memories related to changed files
  const allInsights = memory.getAll();
  const changedPaths = changedFiles.map((f) => f.path.toLowerCase());
  const changedDirs = new Set(
    changedPaths.map((p) => {
      const parts = p.split("/");
      return parts.slice(0, -1).join("/");
    }).filter(Boolean)
  );

  const relevantMemories = allInsights
    .map((insight) => {
      const matchedFiles: string[] = [];
      const matchedTags: string[] = [];

      // Check if any related files overlap with changed files
      for (const relFile of insight.relatedFiles) {
        const relLower = relFile.toLowerCase();
        // Exact match or directory overlap
        if (changedPaths.some((cp) => cp === relLower || cp.startsWith(relLower + "/") || relLower.startsWith(cp.split("/").slice(0, -1).join("/") + "/"))) {
          matchedFiles.push(relFile);
        }
        // Check if related file is in a changed directory
        for (const dir of changedDirs) {
          if (relLower.startsWith(dir + "/") || relLower === dir) {
            if (!matchedFiles.includes(relFile)) matchedFiles.push(relFile);
          }
        }
      }

      // Check if tags match changed directory names or file stems
      for (const tag of insight.tags) {
        const tagLower = tag.toLowerCase();
        if (changedPaths.some((cp) => cp.includes(tagLower))) {
          matchedTags.push(tag);
        }
        for (const dir of changedDirs) {
          if (dir.includes(tagLower)) {
            if (!matchedTags.includes(tag)) matchedTags.push(tag);
          }
        }
      }

      // Check content for mentions of changed file paths
      const contentLower = insight.content.toLowerCase();
      for (const cp of changedPaths) {
        const fileName = cp.split("/").pop() || "";
        const stem = fileName.replace(/\.\w+$/, "");
        if (stem.length > 3 && contentLower.includes(stem)) {
          if (!matchedTags.includes("content-match")) matchedTags.push("content-match");
        }
      }

      if (matchedFiles.length > 0 || matchedTags.length > 0) {
        return { insight, matchedFiles, matchedTags };
      }
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Find relevant ADR sections based on change patterns
  const relevantADRSections: ADRSection[] = [];
  if (adr.exists()) {
    const adrData = adr.get();
    if (adrData) {
      // Check if changes touch architectural areas referenced in ADR
      const changedPathStr = changedPaths.join(" ");

      // STACK: if new dependencies or config files changed
      if (changedPaths.some((p) =>
        p.match(/package\.json|go\.mod|Cargo\.toml|requirements\.txt|Gemfile|build\.gradle|pom\.xml|\.env|docker|compose/)
      )) {
        relevantADRSections.push("STACK");
      }

      // ARCHITECTURE: if directory structure changes (new dirs, moved files)
      if (changedFiles.some((f) => f.status === "added" || f.status === "renamed")) {
        relevantADRSections.push("ARCHITECTURE");
      }

      // PATTERNS: if core source files changed significantly
      if (changedFiles.some((f) => f.insertions + f.deletions > 50)) {
        relevantADRSections.push("PATTERNS");
      }

      // Cross-reference ADR content with changed paths
      for (const [section, content] of Object.entries(adrData.sections)) {
        const contentLower = content.toLowerCase();
        for (const cp of changedPaths) {
          const parts = cp.split("/");
          // Check if ADR mentions directory names or significant path components
          for (const part of parts) {
            if (part.length > 3 && contentLower.includes(part.toLowerCase())) {
              const s = section as ADRSection;
              if (!relevantADRSections.includes(s)) relevantADRSections.push(s);
            }
          }
        }
      }
    }
  }

  // Calculate risk level
  const riskSummary = calculateRisk(changedFiles, relevantMemories.length, relevantADRSections);

  return {
    changedFiles,
    totalInsertions,
    totalDeletions,
    relevantMemories,
    relevantADRSections,
    riskSummary,
  };
}

function calculateRisk(
  files: ChangedFile[],
  relevantMemoryCount: number,
  adrSections: ADRSection[]
): { level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const totalChurn = files.reduce((s, f) => s + f.insertions + f.deletions, 0);
  const fileCount = files.length;

  // File count risk
  if (fileCount > 20) {
    score += 3;
    reasons.push(`${fileCount} files changed (wide blast radius)`);
  } else if (fileCount > 10) {
    score += 2;
    reasons.push(`${fileCount} files changed`);
  } else if (fileCount > 5) {
    score += 1;
  }

  // Churn risk
  if (totalChurn > 500) {
    score += 2;
    reasons.push(`${totalChurn} lines churned (high volume)`);
  } else if (totalChurn > 200) {
    score += 1;
  }

  // Deletions risk
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  if (totalDeletions > totalChurn * 0.5 && totalDeletions > 50) {
    score += 1;
    reasons.push(`${totalDeletions} deletions (significant removal)`);
  }

  // Memory overlap risk — changes touching areas with institutional knowledge
  if (relevantMemoryCount > 3) {
    score += 2;
    reasons.push(`${relevantMemoryCount} relevant memories — changes touch well-documented areas`);
  } else if (relevantMemoryCount > 0) {
    score += 1;
    reasons.push(`${relevantMemoryCount} relevant memories`);
  }

  // ADR risk — changes that may affect architectural decisions
  if (adrSections.includes("ARCHITECTURE") || adrSections.includes("STACK")) {
    score += 2;
    reasons.push(`Touches ADR areas: ${adrSections.join(", ")}`);
  } else if (adrSections.length > 0) {
    score += 1;
  }

  // Config/infra file risk
  if (files.some((f) => f.path.match(/\.env|docker|compose|\.ya?ml$|\.toml$|Makefile|\.conf$/i))) {
    score += 1;
    reasons.push("Infrastructure/config files modified");
  }

  let level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  if (score >= 7) level = "CRITICAL";
  else if (score >= 5) level = "HIGH";
  else if (score >= 3) level = "MEDIUM";
  else level = "LOW";

  if (reasons.length === 0) reasons.push("Minimal changes");

  return { level, reasons };
}
