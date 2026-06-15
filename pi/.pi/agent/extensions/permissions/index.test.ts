/**
 * Unit tests for the permissions extension preview renderer.
 * These focus on the invariant pi-tui enforces: every rendered line must fit
 * the width it was asked to render within.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { buildDiffPreview } from "./index.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	underline: (text: string) => text,
};

describe("buildDiffPreview", () => {
	test("keeps tabbed contextual edit preview lines within the requested width", () => {
		const oldLine = "\treturn `${date}  🧠 ${summary}  [${note.topic}] (${note.project})`;";
		const newLine = "\treturn `${date}  🧠 ${summary} [${note.topic}] (${note.project})`;";
		const fileLines = [
			"function formatBrowseLine(note: KnowledgeNote): string {",
			oldLine,
			"}",
		];

		const width = 104;
		const lines = buildDiffPreview(
			"edit",
			{
				path: "index.ts",
				edits: [{ oldText: oldLine, newText: newLine }],
			},
			width,
			plainTheme,
			process.cwd(),
			fileLines,
		);

		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`expected ${visibleWidth(line)} <= ${width}: ${JSON.stringify(line)}`,
			);
		}
	});
});
