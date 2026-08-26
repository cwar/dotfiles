/**
 * Auto-patch: Anthropic SDK control character handling
 * 
 * Checks if the Anthropic SDK's SSE parser has been patched to handle
 * control characters in JSON. If not, applies the patch automatically.
 * 
 * This prevents "Bad control character in string literal in JSON" errors
 * that occur when the LLM generates tool calls containing content from
 * files with ANSI escape codes or other control characters.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

export default function patchSdkControlChars(pi: ExtensionAPI): void {
	// Run once at extension load time (before any streaming happens)
	try {
		const piPath = execSync("command -v pi", { encoding: "utf-8" }).trim();
		const piPkgDir = join(dirname(piPath), "..", "lib", "node_modules", "@mariozechner", "pi-coding-agent");
		const streamingJs = join(piPkgDir, "node_modules", "@anthropic-ai", "sdk", "core", "streaming.js");

		if (!existsSync(streamingJs)) return;

		const content = readFileSync(streamingJs, "utf-8");

		// Already patched?
		if (content.includes("__sanitizeControlChars")) return;

		// Apply patch
		const sanitizer = `
// [pi-patch] Escape JSON-illegal control characters (U+0000-U+001F) in SSE data
// before JSON.parse. Prevents "Bad control character" errors when the LLM
// generates tool calls with content from files containing ANSI escapes.
function __sanitizeControlChars(data) {
    if (!/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]/.test(data)) return data;
    return data.replace(/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]/g, function(ch) {
        return '\\\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
    });
}
`;
		let patched = content.replace("class Stream {", sanitizer + "class Stream {");
		patched = patched.replace(/JSON\.parse\(sse\.data\)/g, "JSON.parse(__sanitizeControlChars(sse.data))");
		patched = patched.replace(/JSON\.parse\(line\)/g, "JSON.parse(__sanitizeControlChars(line))");

		copyFileSync(streamingJs, streamingJs + ".bak");
		writeFileSync(streamingJs, patched);

		// Note: The patch modifies the file on disk. The current process already loaded
		// the unpatched version into memory, so this session may still be vulnerable.
		// All subsequent pi sessions will use the patched version.
	} catch {
		// Silently ignore — patch is best-effort
	}
}
