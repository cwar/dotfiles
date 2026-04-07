/**
 * Unstick Extension
 *
 * Registers Ctrl+Shift+K to interrupt a hanging tool call and nudge the AI
 * to try a different approach. Aborts the current operation and sends a
 * follow-up message explaining the interruption.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+k", {
		description: "Interrupt stuck tool and nudge AI",
		handler: async (ctx) => {
			if (ctx.isIdle()) {
				ctx.ui.notify("Agent is idle — nothing to unstick", "info");
				return;
			}

			// Abort the current operation (cancels hanging tool via AbortSignal)
			ctx.abort();

			// Queue a follow-up message so the AI knows what happened
			pi.sendUserMessage(
				"I interrupted you because the previous tool call appeared to be hanging or stuck. " +
				"Please try a different approach — maybe break the task into smaller steps, " +
				"use a different command, or skip what was blocking you.",
				{ deliverAs: "followUp" }
			);

			ctx.ui.notify("⚡ Interrupted — nudge queued", "warning");
		},
	});

	// Also register a /unstick command for non-shortcut use
	pi.registerCommand("unstick", {
		description: "Interrupt a stuck tool call and nudge the AI to try differently",
		handler: async (_args, ctx) => {
			if (ctx.isIdle()) {
				ctx.ui.notify("Agent is idle — nothing to unstick", "info");
				return;
			}

			ctx.abort();

			pi.sendUserMessage(
				"I interrupted you because the previous tool call appeared to be hanging or stuck. " +
				"Please try a different approach — maybe break the task into smaller steps, " +
				"use a different command, or skip what was blocking you.",
				{ deliverAs: "followUp" }
			);

			ctx.ui.notify("⚡ Interrupted — nudge queued", "warning");
		},
	});
}
