/**
 * Image Paste Enhancement Extension
 *
 * Improves pi's Ctrl+V image paste flow:
 * 1. Detects pi-clipboard image paths in user input
 * 2. Shows a preview of the image in a widget above the editor
 * 3. Attaches the image directly to the message (no extra read tool call needed)
 * 4. Cleans up the preview when the agent starts responding
 *
 * Works with Ghostty, Kitty, WezTerm, iTerm2 (any terminal with graphics protocol).
 * Falls back to [Image: image/png 800x600] text on unsupported terminals.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Image as TuiImage } from "@mariozechner/pi-tui";
import { readFileSync, existsSync } from "fs";

const WIDGET_ID = "image-paste-preview";

// Match pi-clipboard temp files AND any absolute image paths
const CLIPBOARD_PATTERN = /\/tmp\/pi-clipboard-[0-9a-f-]+\.(png|jpg|jpeg|webp|gif)/g;

function mimeFromExt(ext: string): string {
	switch (ext.toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

export default function (pi: ExtensionAPI) {
	let previewCtx: any = null;

	function clearPreview() {
		if (previewCtx) {
			previewCtx.ui.setWidget(WIDGET_ID, undefined);
		}
	}

	// Intercept input: detect clipboard image paths, attach as real images
	pi.on("input", async (event, ctx) => {
		previewCtx = ctx;
		const text = event.text;

		// Find all pi-clipboard image paths in the input
		const matches = [...text.matchAll(CLIPBOARD_PATTERN)];
		if (matches.length === 0) {
			return { action: "continue" };
		}

		// Load images from matched paths
		const images: { base64: string; mimeType: string }[] = [];
		for (const match of matches) {
			const filePath = match[0];
			const ext = match[1];
			if (existsSync(filePath)) {
				const buffer = readFileSync(filePath);
				images.push({
					base64: buffer.toString("base64"),
					mimeType: mimeFromExt(ext),
				});
			}
		}

		if (images.length === 0) {
			return { action: "continue" };
		}

		// Show the image preview in a widget above the editor
		const img = images[0];
		ctx.ui.setWidget(WIDGET_ID, (tui: any, theme: any) => {
			const imageTheme = { fallbackColor: (s: string) => theme.fg("muted", s) };
			return new TuiImage(img.base64, img.mimeType, imageTheme, {
				maxWidthCells: Math.min(40, tui.width - 4),
			});
		});

		// Strip file paths from text, clean up whitespace
		let cleanedText = text;
		for (const match of matches) {
			cleanedText = cleanedText.replace(match[0], "");
		}
		cleanedText = cleanedText.replace(/\s+/g, " ").trim();

		// If user only pasted an image with no accompanying text, add a default
		if (!cleanedText) {
			cleanedText = "Describe this image.";
		}

		// Return transformed input with proper image attachments
		return {
			action: "transform",
			text: cleanedText,
			images: images.map((img) => ({
				type: "image" as const,
				data: img.base64,
				mimeType: img.mimeType,
			})),
		};
	});

	// Clear the preview when the assistant's first response chunk arrives.
	// before_agent_start fires too early (same render batch as setWidget — user never sees it).
	// message_start for assistant fires after the API round-trip, giving ~1-3s of visible preview.
	pi.on("message_start", async (event, ctx) => {
		previewCtx = ctx;
		if (event.message.role === "assistant") {
			clearPreview();
		}
	});
}
