/**
 * /btw — Side question command (inspired by Claude Code's /btw)
 *
 * Forks the current conversation context, sends a single-turn query to the
 * active model, and displays the response inline. The main conversation is
 * NOT affected — no messages are appended, no session state changes.
 *
 * After viewing a btw response, press `f` to fork into a new session
 * where the btw Q&A becomes the starting context and the agent has full
 * tool access to dig deeper.
 *
 * Usage:
 *   /btw what design pattern is this code using?
 *   /btw remind me what port the server runs on
 *   /btw what was the error message we saw earlier?
 */

import {
	complete,
	type AssistantMessage,
	type Message,
	type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	DynamicBorder,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a context-aware prompt for the side question.
 * Mirrors Claude Code's <system-reminder> approach — the question is wrapped
 * in a system-reminder block that constrains the model to a single, tool-free
 * response using only what it already knows from the conversation.
 */
function buildSideQuestionPrompt(question: string): string {
	return `<system-reminder>This is a side question from the user. Answer directly in a single response.

CRITICAL CONSTRAINTS:
- You have NO tools available — you cannot read files, run commands, search, or take any actions
- This is a one-off response — there will be no follow-up turns
- You can ONLY use information from the conversation context above
- NEVER say "Let me try…", "I'll now…", "Let me check…", or promise any action
- If you don't know the answer from context, say so — do not offer to investigate

Simply answer the question with what you know.</system-reminder>

${question}`;
}

/**
 * Extract conversation messages from the current session branch and convert
 * them to the LLM message format. This gives the side question full context
 * about what's been discussed without modifying the session.
 */
function getConversationContext(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter(
			(entry): entry is SessionEntry & { type: "message" } =>
				entry.type === "message",
		)
		.map((entry) => entry.message);

	return convertToLlm(agentMessages);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description: "Ask a quick side question without interrupting the main conversation",
		handler: async (args, ctx) => {
			const question = args?.trim();

			if (!question) {
				ctx.ui.notify("Usage: /btw <your question>", "warning");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Get conversation context (fork — doesn't touch the session)
			const branch = ctx.sessionManager.getBranch();
			const contextMessages = getConversationContext(branch);

			// Build the side question as the final user message
			const sideQuestionMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: buildSideQuestionPrompt(question) }],
				timestamp: Date.now(),
			};

			// All messages: conversation context + side question appended
			const allMessages: Message[] = [...contextMessages, sideQuestionMessage];

			// Make the API call with a loader spinner
			const result = await ctx.ui.custom<
				| { ok: true; text: string }
				| { ok: false; cancelled: true }
				| { ok: false; error: string }
			>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`Answering side question…`,
				);
				loader.onAbort = () => done({ ok: false, cancelled: true });

				const doQuery = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok) {
						throw new Error(auth.error);
					}

					const response = await complete(
						ctx.model!,
						{ messages: allMessages },
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: loader.signal,
						},
					);

					if (response.stopReason === "aborted") {
						return { ok: false as const, cancelled: true as const };
					}

					if (response.stopReason === "error") {
						throw new Error(response.errorMessage ?? "Model returned an error");
					}

					return {
						ok: true as const,
						text: response.content
							.filter(
								(c): c is { type: "text"; text: string } =>
									c.type === "text",
							)
							.map((c) => c.text)
							.join("\n"),
					};
				};

				doQuery()
					.then(done)
					.catch((err) => {
						console.error("btw query failed:", err);
						done({
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						});
					});

				return loader;
			});

			if (!result.ok) {
				if ("cancelled" in result) {
					ctx.ui.notify("Cancelled", "info");
				} else {
					ctx.ui.notify(`/btw failed: ${result.error}`, "error");
				}
				return;
			}

			const answer = result.text || "(No text response)";

			// Display the answer in a dismissable panel (with fork option)
			const action = await ctx.ui.custom<"dismiss" | "fork">(
				(_tui, theme, _kb, done) => {
					const container = new Container();
					const border = new DynamicBorder((s: string) =>
						theme.fg("warning", s),
					);
					const mdTheme = getMarkdownTheme();

					container.addChild(border);
					container.addChild(
						new Text(
							theme.fg("warning", theme.bold("/btw ")) +
								theme.fg("dim", question),
							1,
							0,
						),
					);
					container.addChild(new Markdown(answer, 1, 1, mdTheme));
					container.addChild(
						new Text(
							theme.fg("dim", "Space/Enter/Esc to dismiss") +
								"  " +
								theme.fg("accent", "f") +
								theme.fg("dim", " to fork into new session"),
							1,
							0,
						),
					);
					container.addChild(border);

					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							if (
								matchesKey(data, "return") ||
								matchesKey(data, "escape") ||
								data === " "
							) {
								done("dismiss");
							} else if (data === "f" || data === "F") {
								done("fork");
							}
						},
					};
				},
			);

			// Fork into a new session with the btw Q&A seeded as conversation history
			if (action === "fork") {
				const parentSessionFile = ctx.sessionManager.getSessionFile();
				const model = ctx.model!;

				const newSessionResult = await ctx.newSession({
					parentSession: parentSessionFile,
					setup: async (sm) => {
						// Seed the user's original btw question
						sm.appendMessage({
							role: "user",
							content: [{ type: "text", text: question }],
							timestamp: Date.now(),
						} satisfies UserMessage);

						// Seed the btw response as a proper assistant message
						sm.appendMessage({
							role: "assistant",
							content: [
								{
									type: "text",
									text:
										answer +
										"\n\n---\n*This was a quick /btw answer without tool access. " +
										"You can now ask follow-up questions — I have full tool access in this session.*",
								},
							],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						} satisfies AssistantMessage);
					},
				});

				if (newSessionResult.cancelled) {
					ctx.ui.notify("Fork cancelled", "info");
					return;
				}
			}
		},
	});
}
