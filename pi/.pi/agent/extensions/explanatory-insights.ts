/**
 * Explanatory Insights Extension
 *
 * Inspired by Claude Code's "Explanatory Output Style" plugin.
 * Injects instructions that encourage the LLM to provide educational
 * insights about implementation choices and codebase patterns as it
 * works through tasks.
 *
 * Usage:
 *   - Automatically active on every prompt
 *   - Toggle on/off with /insights command
 *   - Insights appear as formatted blocks in the conversation
 *
 * The LLM will provide brief, codebase-specific educational points
 * before and after writing code, formatted as:
 *
 *   ★ Insight ─────────────────────────────────────
 *   [2-3 key educational points]
 *   ─────────────────────────────────────────────────
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INSIGHTS_INSTRUCTIONS = `You are in 'explanatory' output style mode, where you should provide educational insights about the codebase as you help with the user's task.

You should be clear and educational, providing helpful explanations while remaining focused on the task. Balance educational content with task completion. When providing insights, you may exceed typical length constraints, but remain focused and relevant.

## Insights
In order to encourage learning, before and after writing code, always provide brief educational explanations about implementation choices using (with backticks):
\`★ Insight ─────────────────────────────────────\`
[2-3 key educational points]
\`─────────────────────────────────────────────────\`

These insights should be included in the conversation, not in the codebase. You should generally focus on interesting insights that are specific to the codebase or the code you just wrote, rather than general programming concepts. Do not wait until the end to provide insights. Provide them as you write code.`;

export default function explanatoryInsights(pi: ExtensionAPI) {
  let enabled = true;

  // Restore state from session entries
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "explanatory-insights-state") {
        enabled = (entry as any).data?.enabled ?? true;
      }
    }
    if (enabled) {
      ctx.ui.setStatus("insights", "★ Insights ON");
    }
  });

  // Toggle command
  pi.registerCommand("insights", {
    description: "Toggle explanatory insights mode",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      pi.appendEntry("explanatory-insights-state", { enabled });

      if (enabled) {
        ctx.ui.setStatus("insights", "★ Insights ON");
        ctx.ui.notify("★ Explanatory insights enabled — educational points will appear as you code", "success");
      } else {
        ctx.ui.setStatus("insights", undefined);
        ctx.ui.notify("Explanatory insights disabled", "info");
      }
    },
  });

  // Inject instructions into the system prompt
  pi.on("before_agent_start", async (event) => {
    if (!enabled) return undefined;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + INSIGHTS_INSTRUCTIONS,
    };
  });
}
