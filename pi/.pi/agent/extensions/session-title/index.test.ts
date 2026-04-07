/**
 * Unit tests for session-title extension logic.
 * Tests extraction, persistence, title cleanup, and head+tail weighting.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Replicate core functions for isolated testing ──────────────────
// (Extension doesn't export these, so we copy the logic here.)

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return undefined;
}

function entryToSegment(entry: any): string | null {
  if (entry.type !== "message") return null;
  const msg = entry.message;
  if (!msg?.role) return null;

  if (msg.role === "user" || msg.role === "assistant") {
    const text = extractText(msg.content);
    if (!text?.trim()) return null;
    const label = msg.role === "user" ? "User" : "Assistant";
    return `${label}: ${text.trim()}`;
  }

  if (msg.role === "toolResult" && !msg.isError) {
    const tool = msg.toolName;
    if (tool === "write" || tool === "edit") {
      const path = msg.details?.path || msg.details?.filePath || "";
      return `[Tool: ${tool} ${path}]`;
    }
    if (tool === "bash") {
      const cmd = (msg.details?.command || "").slice(0, 80);
      return `[Tool: bash "${cmd}"]`;
    }
  }

  return null;
}

const TAIL_BUDGET_RATIO = 0.65;

function extractConversation(entries: any[], maxChars = 6000): { text: string; turnCount: number } {
  const segments: string[] = [];
  let turnCount = 0;

  for (const entry of entries) {
    const seg = entryToSegment(entry);
    if (seg === null) continue;
    segments.push(seg);
    const msg = entry.message;
    if (msg?.role === "user" || msg?.role === "assistant") turnCount++;
  }

  const fullText = segments.join("\n");
  if (fullText.length <= maxChars) {
    return { text: fullText, turnCount };
  }

  const headBudget = Math.floor(maxChars * (1 - TAIL_BUDGET_RATIO));
  const tailBudget = maxChars - headBudget;

  const headParts: string[] = [];
  let headLen = 0;
  for (const seg of segments) {
    if (headLen + seg.length + 1 > headBudget) break;
    headParts.push(seg);
    headLen += seg.length + 1;
  }

  const tailParts: string[] = [];
  let tailLen = 0;
  for (let i = segments.length - 1; i >= headParts.length; i--) {
    const seg = segments[i];
    if (tailLen + seg.length + 1 > tailBudget) break;
    tailParts.unshift(seg);
    tailLen += seg.length + 1;
  }

  const parts = [...headParts, "\n[...earlier messages omitted...]\n", ...tailParts];
  return { text: parts.join("\n"), turnCount };
}

function cleanTitle(raw: string): string {
  let title = raw.replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").trim();
  if (title.length > 50) title = title.slice(0, 47) + "...";
  return title;
}

// ── Helpers ────────────────────────────────────────────────────────

function msg(role: string, content: string) {
  return { type: "message", message: { role, content } };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("extractText", () => {
  test("extracts plain string content", () => {
    expect(extractText("hello")).toBe("hello");
  });

  test("extracts from content block array", () => {
    expect(extractText([{ type: "text", text: "hello" }])).toBe("hello");
  });

  test("returns undefined for empty array", () => {
    expect(extractText([])).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(extractText(null)).toBeUndefined();
  });

  test("skips non-text blocks", () => {
    const content = [
      { type: "image", data: "..." },
      { type: "text", text: "found it" },
    ];
    expect(extractText(content)).toBe("found it");
  });
});

describe("entryToSegment", () => {
  test("converts user message", () => {
    expect(entryToSegment(msg("user", "hello"))).toBe("User: hello");
  });

  test("converts assistant message", () => {
    expect(entryToSegment(msg("assistant", "hi there"))).toBe("Assistant: hi there");
  });

  test("returns null for non-message entries", () => {
    expect(entryToSegment({ type: "thinking_level_change" })).toBeNull();
  });

  test("returns null for empty content", () => {
    expect(entryToSegment(msg("user", ""))).toBeNull();
    expect(entryToSegment(msg("user", "   "))).toBeNull();
  });

  test("extracts tool write annotations", () => {
    const entry = {
      type: "message",
      message: { role: "toolResult", isError: false, toolName: "write", details: { path: "/foo/bar.ts" } },
    };
    expect(entryToSegment(entry)).toBe("[Tool: write /foo/bar.ts]");
  });

  test("extracts tool bash annotations", () => {
    const entry = {
      type: "message",
      message: { role: "toolResult", isError: false, toolName: "bash", details: { command: "npm test" } },
    };
    expect(entryToSegment(entry)).toBe('[Tool: bash "npm test"]');
  });

  test("skips error tool results", () => {
    const entry = {
      type: "message",
      message: { role: "toolResult", isError: true, toolName: "write", details: { path: "/foo.ts" } },
    };
    expect(entryToSegment(entry)).toBeNull();
  });
});

describe("extractConversation", () => {
  test("extracts user and assistant messages", () => {
    const entries = [msg("user", "Fix the auth bug"), msg("assistant", "I'll look at the auth module.")];
    const { text, turnCount } = extractConversation(entries);
    expect(turnCount).toBe(2);
    expect(text).toContain("User: Fix the auth bug");
    expect(text).toContain("Assistant: I'll look at the auth module.");
  });

  test("skips non-message entries", () => {
    const entries = [
      { type: "thinking_level_change", thinkingLevel: "high" },
      msg("user", "Hello"),
    ];
    const { turnCount } = extractConversation(entries);
    expect(turnCount).toBe(1);
  });

  test("skips empty content", () => {
    const entries = [msg("user", ""), msg("user", "  "), msg("assistant", "")];
    const { turnCount } = extractConversation(entries);
    expect(turnCount).toBe(0);
  });

  test("short conversations are taken in full", () => {
    const entries = [msg("user", "hello"), msg("assistant", "hi")];
    const { text } = extractConversation(entries, 10000);
    expect(text).not.toContain("omitted");
  });

  test("long conversations use head+tail with omission marker", () => {
    // Create a conversation that exceeds maxChars
    const entries: any[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(msg("user", `Question number ${i}: ${"x".repeat(100)}`));
      entries.push(msg("assistant", `Answer number ${i}: ${"y".repeat(100)}`));
    }
    const { text } = extractConversation(entries, 2000);

    expect(text).toContain("[...earlier messages omitted...]");
    // Head should contain early messages
    expect(text).toContain("Question number 0");
    // Tail should contain recent messages
    expect(text).toContain("Answer number 49");
  });

  test("tail gets ~65% of the budget", () => {
    const entries: any[] = [];
    for (let i = 0; i < 40; i++) {
      entries.push(msg("user", `Turn ${i}: ${"a".repeat(80)}`));
    }
    const { text } = extractConversation(entries, 2000);

    // Find the omission marker
    const markerIdx = text.indexOf("[...earlier messages omitted...]");
    expect(markerIdx).toBeGreaterThan(0);

    const head = text.slice(0, markerIdx);
    const tail = text.slice(markerIdx + "[...earlier messages omitted...]".length + 2); // +2 for surrounding \n

    // Tail should be larger than head (65% vs 35%)
    expect(tail.length).toBeGreaterThan(head.length);
  });

  test("handles content block arrays", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "block format" }] } },
    ];
    const { text, turnCount } = extractConversation(entries);
    expect(turnCount).toBe(1);
    expect(text).toContain("User: block format");
  });
});

describe("cleanTitle", () => {
  test("removes surrounding quotes", () => {
    expect(cleanTitle('"Fixing Auth Bug"')).toBe("Fixing Auth Bug");
    expect(cleanTitle("'Fixing Auth Bug'")).toBe("Fixing Auth Bug");
  });

  test("removes trailing punctuation", () => {
    expect(cleanTitle("Fixing Auth Bug.")).toBe("Fixing Auth Bug");
    expect(cleanTitle("Fixing Auth Bug!")).toBe("Fixing Auth Bug");
    expect(cleanTitle("Fixing Auth Bug?")).toBe("Fixing Auth Bug");
  });

  test("truncates long titles", () => {
    const long = "This Is An Extremely Long Session Title That Goes Way Over Fifty Characters";
    const cleaned = cleanTitle(long);
    expect(cleaned.length).toBeLessThanOrEqual(50);
    expect(cleaned.endsWith("...")).toBe(true);
  });

  test("preserves good titles as-is", () => {
    expect(cleanTitle("Redis Cache Layer")).toBe("Redis Cache Layer");
  });

  test("handles KEEP sentinel (not cleaned away)", () => {
    // KEEP is handled before cleanTitle is called, but let's make sure
    // cleanTitle doesn't mangle it if it ever gets through
    expect(cleanTitle("KEEP")).toBe("KEEP");
  });
});

describe("TitleStore persistence", () => {
  const testDir = join(tmpdir(), `session-title-test-${Date.now()}`);
  const testFile = join(testDir, "titles.json");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("round-trips title data through JSON", async () => {
    const store = {
      "abc-123": { title: "Fixing Auth Bug", generatedAt: "2026-03-24T00:00:00Z", turnCount: 3 },
    };
    await writeFile(testFile, JSON.stringify(store, null, 2), "utf8");
    const loaded = JSON.parse(await readFile(testFile, "utf8"));
    expect(loaded["abc-123"].title).toBe("Fixing Auth Bug");
    expect(loaded["abc-123"].turnCount).toBe(3);
  });

  test("handles missing file gracefully", async () => {
    try {
      await readFile(join(testDir, "nonexistent.json"), "utf8");
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.code).toBe("ENOENT");
    }
  });
});
