import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addNativeWebSearchTool,
  extractAssistantText,
  type SearchCapableApi,
} from "./core.ts";

describe("addNativeWebSearchTool", () => {
  test("adds OpenAI native search while preserving existing tools", () => {
    const existingTool = { type: "function", name: "existing" };

    const payload = addNativeWebSearchTool(
      { model: "gpt-5.6-sol", tools: [existingTool] },
      "openai-codex-responses",
    ) as { tools: unknown[] };

    assert.deepEqual(payload.tools, [existingTool, { type: "web_search" }]);
  });

  test("uses the same OpenAI search tool for the Responses API", () => {
    const payload = addNativeWebSearchTool({}, "openai-responses") as { tools: unknown[] };

    assert.deepEqual(payload.tools, [{ type: "web_search" }]);
  });

  test("adds Anthropic native search with a bounded search count", () => {
    const payload = addNativeWebSearchTool({}, "anthropic-messages") as { tools: unknown[] };

    assert.deepEqual(payload.tools, [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      },
    ]);
  });

  test("rejects APIs without an explicit native-search adapter", () => {
    assert.throws(
      () => addNativeWebSearchTool({}, "openai-completions" as SearchCapableApi),
      /does not support native web search/,
    );
  });
});

describe("extractAssistantText", () => {
  test("returns only text blocks from a nested model response", () => {
    const text = extractAssistantText({
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "Result with https://example.com" },
      ],
    });

    assert.equal(text, "Result with https://example.com");
  });

  test("rejects an empty text response", () => {
    assert.throws(
      () => extractAssistantText({ content: [{ type: "thinking", thinking: "only thinking" }] }),
      /returned no text content/,
    );
  });
});
