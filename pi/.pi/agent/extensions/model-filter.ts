/**
 * Model Filter Extension
 * 
 * Credit: https://github.com/bsmithgall/pi-pi-pi/blob/main/extensions/model-filter.ts
 *
 * Adds Alt+Shift+. / Alt+Shift+, shortcuts that cycle through only the latest
 * generation of each Anthropic model family (Haiku → Sonnet → Opus). "Latest"
 * is determined dynamically at startup by inspecting available models, so no
 * hardcoded IDs need updating when pi adds newer versions.
 *
 * The built-in cycleModelForward / cycleModelBackward actions can be disabled in
 * keybindings.json (bound to []) if you want Ctrl+P / Ctrl+N free for emacs-style
 * cursor movement. This extension independently owns Alt+Shift+. / Alt+Shift+,.
 *
 * Note: the full /model picker is unaffected — this only adds cycle shortcuts.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

// Families to include, in cycle order.
const FAMILIES = ["haiku", "sonnet", "opus"] as const;

/**
 * Extract a comparable version string from a model ID so we can pick the
 * highest version within a family.
 *
 * Examples:
 *   claude-haiku-4-5   -> "0004.0005"
 *   claude-sonnet-4-6  -> "0004.0006"
 *   claude-opus-4-1    -> "0004.0001"
 */
function versionKey(id: string): string {
  const tail = id.replace(/^claude-(?:haiku|sonnet|opus)-/, "");
  // Accept only short numeric segments (≤4 digits) — this skips date stamps
  // like "20251001" which are 8 digits.
  const parts = tail.split("-").filter((p) => /^\d+$/.test(p) && p.length <= 4);
  return parts.map((p) => p.padStart(4, "0")).join(".");
}

function isDateStampVariant(id: string, family: string): boolean {
  const tail = id.replace(`claude-${family}-`, "");
  return tail.split("-").some((p) => p.length === 8 && /^\d+$/.test(p));
}

export default function modelFilterExtension(pi: ExtensionAPI): void {
  pi.registerShortcut(Key.shiftAlt("."), {
    description: "Cycle to next model (filtered: Haiku → Sonnet → Opus)",
    handler: (ctx) => cycleModel(ctx, +1),
  });

  pi.registerShortcut(Key.shiftAlt(","), {
    description: "Cycle to previous model (filtered: Opus → Sonnet → Haiku)",
    handler: (ctx) => cycleModel(ctx, -1),
  });

  function cycleModel(ctx: ExtensionContext, direction: 1 | -1): void {
    const cycleList = buildCycleList(ctx.modelRegistry.getAvailable());

    if (cycleList.length === 0) {
      ctx.ui.notify("No Anthropic models available to cycle", "warning");
      return;
    }

    const currentId = ctx.model?.id;
    const currentIndex = cycleList.findIndex((m) => m.id === currentId);

    // If current model isn't in our list, start from the first/last
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : cycleList.length - 1
        : (currentIndex + direction + cycleList.length) % cycleList.length;

    const next = cycleList[nextIndex];
    pi.setModel(next).then((success) => {
      if (!success) {
        ctx.ui.notify(`No API key available for ${next.id}`, "error");
      } else {
        ctx.ui.setStatus("model-filter", undefined);
      }
    });
  }
}

function buildCycleList(models: Model<Api>[]): Model<Api>[] {
  const result: Model<Api>[] = [];

  for (const family of FAMILIES) {
    const candidates = models.filter(
      (m) =>
        m.provider === "anthropic" &&
        m.id.startsWith(`claude-${family}-`) &&
        !isDateStampVariant(m.id, family),
    );

    if (candidates.length === 0) continue;

    // Sort descending by version, pick the highest
    candidates.sort((a, b) => versionKey(b.id).localeCompare(versionKey(a.id)));
    result.push(candidates[0]);
  }

  return result;
}
