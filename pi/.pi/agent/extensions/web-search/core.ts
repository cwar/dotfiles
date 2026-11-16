const MAX_SEARCH_USES = 5;

export type SearchCapableApi = string;

type JsonObject = Record<string, unknown>;

function asObject(payload: unknown): JsonObject {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Native web search requires an object provider payload");
  }
  return payload as JsonObject;
}

/**
 * Add the selected model provider's native web-search tool to a pi-ai request.
 * Unsupported APIs fail explicitly rather than silently switching models.
 */
export function addNativeWebSearchTool(payload: unknown, api: SearchCapableApi): unknown {
  const body = asObject(payload);
  const tools = Array.isArray(body.tools) ? body.tools : [];

  switch (api) {
    case "openai-codex-responses":
    case "openai-responses":
      return {
        ...body,
        tools: [...tools, { type: "web_search" }],
      };

    case "anthropic-messages":
      return {
        ...body,
        tools: [
          ...tools,
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: MAX_SEARCH_USES,
          },
        ],
      };

    default:
      throw new Error(`The selected model API (${api}) does not support native web search`);
  }
}

export function extractAssistantText(response: {
  content?: Array<{ type?: string; text?: unknown }>;
}): string {
  const text = (response.content ?? [])
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();

  if (!text) {
    throw new Error("The selected model returned no text content from web search");
  }

  return text;
}
