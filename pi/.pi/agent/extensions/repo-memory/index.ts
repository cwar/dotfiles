import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Memory, ADRStore, ADR_SECTIONS, type ADRSection } from "./memory";
import { RepoMapper } from "./repo-map";
import { Analytics } from "./analytics";
import { detectChanges } from "./detect-changes";

// ── Storage path ──────────────────────────────────────────

function getStorageDir(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const slug = path.basename(cwd);
  return path.join(os.homedir(), ".pi", "agent", "repo-memory", `${slug}-${hash}`);
}

// ── Extension ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let memory: Memory | null = null;
  let adr: ADRStore | null = null;
  let mapper: RepoMapper | null = null;
  let analytics: Analytics | null = null;
  let currentCwd = "";
  let firstPrompt = true;
  let recallUsedThisAgent = false;

  function ensureInit(cwd: string) {
    if (memory && currentCwd === cwd) return;
    currentCwd = cwd;
    const dir = getStorageDir(cwd);
    memory = new Memory(dir);
    adr = new ADRStore(dir);
    mapper = new RepoMapper(cwd, dir);
    analytics = new Analytics(dir);
  }

  // ── Lifecycle hooks ─────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ensureInit(ctx.cwd);
    firstPrompt = true;
    analytics?.startSession(
      ctx.sessionManager.getSessionFile() ?? "ephemeral",
      memory?.count() ?? 0
    );
  });

  pi.on("session_switch", async (_event, ctx) => {
    analytics?.endSession(); // end previous
    ensureInit(ctx.cwd);
    firstPrompt = true;
    analytics?.startSession(
      ctx.sessionManager.getSessionFile() ?? "ephemeral",
      memory?.count() ?? 0
    );
  });

  pi.on("session_shutdown", async () => {
    analytics?.endSession();
  });

  // Track every tool call for analytics + nudge recall before heavy exploration
  pi.on("tool_call", async (event) => {
    analytics?.trackToolCall(event.toolName, event.input as Record<string, any>);

    if (event.toolName === "recall") {
      recallUsedThisAgent = true;
    }
  });

  pi.on("turn_start", async () => {
    analytics?.trackTurn();
  });

  pi.on("agent_start", async () => {
    analytics?.trackAgentStart();
  });

  pi.on("agent_end", async () => {
    analytics?.trackAgentEnd();
  });

  // Build a richer search query from contextual signals beyond just the prompt
  async function buildContextualQuery(prompt: string, cwd: string): Promise<string> {
    const parts: string[] = [prompt];

    try {
      // Add git branch name — often contains ticket IDs or feature names
      const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 3000,
      });
      if (branchResult.code === 0 && branchResult.stdout.trim()) {
        const branch = branchResult.stdout.trim();
        // Split branch name into searchable terms (e.g., "DATAREPO-29-monitoring-info" → ["DATAREPO-29", "monitoring", "info"])
        const branchTerms = branch.split(/[-_/]/).filter((t) => t.length > 2);
        parts.push(...branchTerms);
      }

      // Add recently modified file paths — surfaces memories about areas being worked on
      const statusResult = await pi.exec("git", ["diff", "--name-only", "HEAD"], {
        timeout: 3000,
      });
      if (statusResult.code === 0 && statusResult.stdout.trim()) {
        const files = statusResult.stdout.trim().split("\n").slice(0, 10);
        // Extract directory names and filenames as search terms
        for (const f of files) {
          parts.push(...f.split("/").filter((t) => t.length > 2));
        }
      }
    } catch {
      // Git not available — just use prompt
    }

    return parts.join(" ");
  }

  // Auto-inject relevant memories + ADR context on each prompt via system prompt
  pi.on("before_agent_start", async (event, ctx) => {
    ensureInit(ctx.cwd);
    recallUsedThisAgent = false;
    const hasMemories = memory && memory.count() > 0;
    const hasADR = adr && adr.exists();

    if (!hasMemories && !hasADR) return;

    // Only inject detailed context on first prompt; light hint after
    if (!firstPrompt) return;
    firstPrompt = false;

    let extra = `\n\n## Repository Memory\n`;

    // Inject ADR summary if it exists — gives architectural context up front
    if (hasADR && adr) {
      const adrData = adr.get(["PURPOSE", "STACK", "PATTERNS"]);
      if (adrData) {
        extra += "### Architecture Decision Record\n";
        extra += "Before making implementation decisions, validate against this ADR:\n";
        if (adrData.sections.PURPOSE) {
          extra += `- **Purpose**: ${adrData.sections.PURPOSE.split("\n")[0]}\n`;
        }
        if (adrData.sections.STACK) {
          extra += `- **Stack**: ${adrData.sections.STACK.split("\n").slice(0, 3).join("; ")}\n`;
        }
        if (adrData.sections.PATTERNS) {
          extra += `- **Patterns**: ${adrData.sections.PATTERNS.split("\n").slice(0, 3).join("; ")}\n`;
        }
        extra += "Use `manage_adr` to view/update the full ADR.\n\n";
      }
    }

    // Inject relevant memories using enriched contextual search
    if (hasMemories && memory) {
      const total = memory.count();
      const contextualQuery = await buildContextualQuery(event.prompt, ctx.cwd);
      const relevant = memory.search(contextualQuery).slice(0, 5);

      extra += `This repo has ${total} stored insight(s) from previous sessions.\n`;

      if (relevant.length > 0) {
        extra += "Relevant to this task:\n";
        for (const m of relevant) {
          extra += `- **[${m.topic}]** ${m.content.slice(0, 300)}${m.content.length > 300 ? "..." : ""}`;
          if (m.relatedFiles.length > 0) {
            extra += ` _(${m.relatedFiles.join(", ")})_`;
          }
          extra += "\n";
        }
      }

      analytics?.trackMemoryInjection(relevant.length);

      if (relevant.length < total) {
        extra += `\n${total - relevant.length} additional memories not shown. Call \`recall\` before reading files if the task involves areas not covered above.\n`;
      }
    }

    extra += "\nUse `recall` for more, `repo_map` for structural overview, `detect_changes` for change impact analysis.\n";

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // ── Tool: repo_map ──────────────────────────────────

  pi.registerTool({
    name: "repo_map",
    label: "Repo Map",
    description:
      "Generate a structural map of the repository showing files and code signatures (functions, classes, interfaces, types). Cached per git SHA — fast on repeat calls. Use `path` to focus on a subdirectory.",
    promptGuidelines: [
      "Use repo_map BEFORE running multiple grep/find commands to orient in an unfamiliar codebase.",
      "The repo map shows file tree + function/class/type signatures — use it to understand project structure quickly.",
      "Use repo_map with a path filter to drill into specific areas: repo_map({ path: 'src/auth' }).",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Focus on a specific directory or file path" })
      ),
      refresh: Type.Optional(
        Type.Boolean({ description: "Force regeneration even if cached (default: false)" })
      ),
      signatures: Type.Optional(
        Type.Boolean({ description: "Include code signatures (default: true)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!mapper) {
        return { content: [{ type: "text", text: "Error: could not initialize repo mapper" }] };
      }

      try {
        const filterPath = params.path?.replace(/^@/, "");
        const { text, data } = await mapper.generate({
          filterPath,
          refresh: params.refresh,
          signatures: params.signatures,
        });

        return {
          content: [{ type: "text", text }],
          details: {
            totalFiles: data.totalFiles,
            indexedFiles: data.files.length,
            gitSha: data.gitSha,
            cached: !params.refresh,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error generating repo map: ${err.message}` }],
          isError: true,
        };
      }
    },
  });

  // ── Tool: remember ──────────────────────────────────

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store an insight or learning about this codebase. Memories persist across sessions and are automatically surfaced when relevant.",
    promptGuidelines: [
      "Use remember after discovering important patterns, gotchas, or architectural decisions in the codebase.",
      "Memories are shared knowledge about this repository — store things that would help in future sessions.",
      "Include relatedFiles and tags to improve recall accuracy.",
    ],
    parameters: Type.Object({
      topic: Type.String({
        description: "Category/topic (e.g. 'auth', 'deployment', 'data-model')",
      }),
      content: Type.String({
        description: "The insight or learning to remember",
      }),
      relatedFiles: Type.Optional(
        Type.Array(Type.String(), {
          description: "File paths related to this insight",
        })
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Additional tags for searchability",
        })
      ),
      id: Type.Optional(
        Type.String({
          description: "If provided, updates an existing memory instead of creating a new one",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!memory) {
        return { content: [{ type: "text", text: "Error: memory not initialized" }] };
      }

      // Update existing
      if (params.id) {
        const updated = memory.update(params.id, {
          topic: params.topic,
          content: params.content,
          relatedFiles: params.relatedFiles,
          tags: params.tags,
        });
        if (!updated) {
          return {
            content: [{ type: "text", text: `No memory found with id: ${params.id}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Updated memory [${updated.id}] under topic "${updated.topic}"`,
            },
          ],
          details: { insight: updated },
        };
      }

      // Create new
      const insight = memory.add(
        params.topic,
        params.content,
        params.relatedFiles ?? [],
        params.tags ?? []
      );

      return {
        content: [
          {
            type: "text",
            text: `Stored memory [${insight.id}] under topic "${insight.topic}" (${memory.count()} total)`,
          },
        ],
        details: { insight },
      };
    },
  });

  // ── Tool: recall ────────────────────────────────────

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search stored memories/insights about this codebase. Returns relevant context from previous sessions.",
    promptGuidelines: [
      "BEFORE reading files or making edits on a non-trivial task, call recall() to check for existing context — this prevents redundant exploration of files that have already been documented in previous sessions.",
      "recall with no query returns all stored memories — use a query to filter by relevance.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Search query — matches against topics, content, tags, and file paths",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!memory) {
        return { content: [{ type: "text", text: "Error: memory not initialized" }] };
      }

      const results = params.query
        ? memory.search(params.query)
        : memory.getAll();

      if (results.length === 0) {
        const msg = params.query
          ? `No memories found matching: "${params.query}" (${memory.count()} total stored)`
          : "No memories stored for this repository yet.";
        return { content: [{ type: "text", text: msg }] };
      }

      const lines: string[] = [];
      lines.push(
        params.query
          ? `Found ${results.length} matching memories (${memory.count()} total):`
          : `All stored memories (${results.length}):`
      );
      lines.push("");

      for (const m of results) {
        const age = formatAge(m.updatedAt);
        lines.push(`[${m.id}] **${m.topic}** (${age})`);
        lines.push(`  ${m.content}`);
        if (m.relatedFiles.length > 0) {
          lines.push(`  Files: ${m.relatedFiles.join(", ")}`);
        }
        if (m.tags.length > 0) {
          lines.push(`  Tags: ${m.tags.join(", ")}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: results.length, insights: results },
      };
    },
  });

  // ── Tool: forget ────────────────────────────────────

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "Remove a stored memory by its ID.",
    parameters: Type.Object({
      id: Type.String({ description: "The memory ID to remove (shown in recall output)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!memory) {
        return { content: [{ type: "text", text: "Error: memory not initialized" }] };
      }

      const removed = memory.remove(params.id);
      if (!removed) {
        return {
          content: [{ type: "text", text: `No memory found with id: ${params.id}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Removed memory [${params.id}] (${memory.count()} remaining)`,
          },
        ],
      };
    },
  });

  // ── Tool: manage_adr ─────────────────────────────────

  pi.registerTool({
    name: "manage_adr",
    label: "Architecture Decision Record",
    description:
      "Manage the Architecture Decision Record (ADR) for this project. CRUD operations for a persistent, section-based architectural summary that persists across sessions. Before finalizing implementation plans, validate against the ADR.",
    promptGuidelines: [
      "Use manage_adr to store architectural decisions that should guide all future sessions.",
      "Before making significant implementation changes, fetch the ADR (mode='get') and validate alignment.",
      "ADR sections: PURPOSE (what this project does), STACK (technologies and why), ARCHITECTURE (structural decisions), PATTERNS (coding conventions), TRADEOFFS (conscious compromises), PHILOSOPHY (guiding principles).",
      "Use mode='get' with include filter to fetch only needed sections and save tokens.",
    ],
    parameters: Type.Object({
      mode: Type.Union(
        [
          Type.Literal("get"),
          Type.Literal("store"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ],
        {
          description:
            "Operation: 'get' retrieves ADR, 'store' creates/replaces (all 6 sections required), 'update' patches sections, 'delete' removes.",
        }
      ),
      content: Type.Optional(
        Type.String({
          description:
            "Full ADR markdown (required for mode='store'). Must contain all 6 ## SECTION headers: PURPOSE, STACK, ARCHITECTURE, PATTERNS, TRADEOFFS, PHILOSOPHY.",
        })
      ),
      sections: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Section updates (for mode='update'). Keys must be canonical section names. Unmentioned sections preserved.",
        })
      ),
      include: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Section filter for mode='get'. Returns only listed sections. Example: ['STACK', 'PATTERNS'].",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!adr) {
        return { content: [{ type: "text", text: "Error: ADR store not initialized" }] };
      }

      switch (params.mode) {
        case "get": {
          const includeFilter = params.include as ADRSection[] | undefined;
          const data = adr.get(includeFilter);
          if (!data) {
            return {
              content: [
                {
                  type: "text",
                  text: "No ADR stored for this project. Use mode='store' to create one.\n\nTo create an ADR, explore the codebase first, then draft one with all 6 sections:\n## PURPOSE\n## STACK\n## ARCHITECTURE\n## PATTERNS\n## TRADEOFFS\n## PHILOSOPHY",
                },
              ],
            };
          }
          const formatted = adr.formatMarkdown(data);
          const age = formatAge(data.updatedAt);
          return {
            content: [
              {
                type: "text",
                text: `# Architecture Decision Record (updated ${age})\n\n${formatted}`,
              },
            ],
            details: {
              sections: Object.keys(data.sections),
              updatedAt: data.updatedAt,
              createdAt: data.createdAt,
            },
          };
        }

        case "store": {
          if (!params.content) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'content' is required for mode='store'. Provide full ADR markdown with all 6 ## SECTION headers.",
                },
              ],
              isError: true,
            };
          }
          const result = adr.store(params.content);
          if (!result.success) {
            return {
              content: [{ type: "text", text: `Error: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `ADR stored successfully (${params.content.length} chars, 6 sections).`,
              },
            ],
          };
        }

        case "update": {
          if (!params.sections || Object.keys(params.sections).length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'sections' is required for mode='update'. Provide a map of section names to new content.",
                },
              ],
              isError: true,
            };
          }
          const result = adr.update(params.sections);
          if (!result.success) {
            return {
              content: [{ type: "text", text: `Error: ${result.error}` }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `ADR updated: ${Object.keys(params.sections).join(", ")} section(s) patched.`,
              },
            ],
          };
        }

        case "delete": {
          const removed = adr.delete();
          return {
            content: [
              {
                type: "text",
                text: removed ? "ADR deleted." : "No ADR to delete.",
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: "Error: mode must be 'get', 'store', 'update', or 'delete'",
              },
            ],
            isError: true,
          };
      }
    },
  });

  // ── Tool: detect_changes ────────────────────────────

  pi.registerTool({
    name: "detect_changes",
    label: "Detect Changes",
    description:
      "Analyze uncommitted git changes and map them to relevant stored memories and ADR sections. Returns changed files with insertions/deletions, matching memories, affected ADR sections, and a risk classification (LOW/MEDIUM/HIGH/CRITICAL). Use before committing to understand the blast radius of your changes.",
    promptGuidelines: [
      "Use detect_changes before committing to understand what areas of institutional knowledge are affected.",
      "The risk classification considers file count, churn volume, overlap with stored memories, and ADR impact.",
      "Use scope='branch' with base_branch to analyze all changes on a feature branch.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [
            Type.Literal("unstaged"),
            Type.Literal("staged"),
            Type.Literal("all"),
            Type.Literal("branch"),
          ],
          {
            description:
              "What changes to analyze. 'unstaged' (default): working tree changes. 'staged': index changes. 'all': both. 'branch': changes since diverging from base_branch.",
          }
        )
      ),
      base_branch: Type.Optional(
        Type.String({
          description: "Base branch for scope='branch' (default: 'main')",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureInit(ctx.cwd);
      if (!memory || !adr) {
        return { content: [{ type: "text", text: "Error: not initialized" }] };
      }

      try {
        const impact = await detectChanges(
          ctx.cwd,
          params.scope || "unstaged",
          params.base_branch,
          memory,
          adr
        );

        if (impact.changedFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No changes detected (scope: ${params.scope || "unstaged"}).`,
              },
            ],
          };
        }

        const lines: string[] = [];

        // Risk banner
        const riskEmoji: Record<string, string> = {
          LOW: "🟢",
          MEDIUM: "🟡",
          HIGH: "🟠",
          CRITICAL: "🔴",
        };
        lines.push(
          `## Change Impact: ${riskEmoji[impact.riskSummary.level]} ${impact.riskSummary.level}`
        );
        for (const reason of impact.riskSummary.reasons) {
          lines.push(`- ${reason}`);
        }
        lines.push("");

        // Changed files
        lines.push(
          `### Changed Files (${impact.changedFiles.length}) — +${impact.totalInsertions} / -${impact.totalDeletions}`
        );
        for (const f of impact.changedFiles.slice(0, 30)) {
          const status =
            f.status === "added"
              ? "A"
              : f.status === "deleted"
                ? "D"
                : f.status === "renamed"
                  ? "R"
                  : "M";
          lines.push(`  ${status} ${f.path} (+${f.insertions}/-${f.deletions})`);
        }
        if (impact.changedFiles.length > 30) {
          lines.push(`  ... and ${impact.changedFiles.length - 30} more files`);
        }
        lines.push("");

        // Relevant memories
        if (impact.relevantMemories.length > 0) {
          lines.push(`### Relevant Memories (${impact.relevantMemories.length})`);
          for (const rm of impact.relevantMemories) {
            lines.push(`- **[${rm.insight.topic}]** ${rm.insight.content}`);
            if (rm.matchedFiles.length > 0) {
              lines.push(`  Matched files: ${rm.matchedFiles.join(", ")}`);
            }
            if (rm.matchedTags.length > 0) {
              lines.push(`  Matched via: ${rm.matchedTags.join(", ")}`);
            }
          }
          lines.push("");
        }

        // Relevant ADR sections
        if (impact.relevantADRSections.length > 0) {
          lines.push(
            `### ADR Sections to Review: ${impact.relevantADRSections.join(", ")}`
          );
          lines.push(
            "Consider reviewing these ADR sections to ensure changes align with architectural decisions."
          );
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            risk: impact.riskSummary.level,
            changedFileCount: impact.changedFiles.length,
            relevantMemoryCount: impact.relevantMemories.length,
            relevantADRSections: impact.relevantADRSections,
          },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error detecting changes: ${err.message}. Is this a git repository?`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ── Command: /memory-stats ──────────────────────────

  pi.registerCommand("memory-stats", {
    description: "Show repo memory analytics — tool call patterns, re-read ratios, orientation cost",
    handler: async (_args, ctx) => {
      ensureInit(ctx.cwd);
      if (!analytics) {
        ctx.ui.notify("Analytics not initialized", "error");
        return;
      }
      const report = analytics.generateReport();
      // Send as a user message so the LLM can discuss the results
      pi.sendUserMessage(
        `Here are my repo-memory analytics. Analyze them and suggest what I should \`remember\` to reduce re-tracing:\n\n${report}`,
        { deliverAs: "followUp" }
      );
    },
  });
}

// ── Helpers ───────────────────────────────────────────────

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
