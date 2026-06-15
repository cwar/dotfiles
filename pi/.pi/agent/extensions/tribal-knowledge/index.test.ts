/**
 * Unit tests for tribal-knowledge extension helpers.
 * Uses Node's built-in test runner so the extension has no npm dependency.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractConversation,
  knowledgeMatchesQuery,
  formatKnowledgeReport,
  formatKnowledgeStats,
  formatBackfillPlan,
  parseBackfillAction,
  normalizeKnowledgeNote,
  type KnowledgeNote,
} from "./index.ts";

function msg(role: string, content: unknown) {
  return { type: "message", message: { role, content } };
}

describe("extractConversation", () => {
  test("extracts user/assistant messages and useful tool annotations", () => {
    const entries = [
      msg("user", "Why does deploy fail?"),
      msg("assistant", [{ type: "text", text: "I'll inspect the deploy scripts." }]),
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          isError: false,
          details: { path: "scripts/deploy.sh" },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          details: { command: "grep -R DEPLOY_ENV scripts" },
        },
      },
    ];

    const conversation = extractConversation(entries, 10_000);

    assert.match(conversation, /User: Why does deploy fail/);
    assert.match(conversation, /Assistant: I'll inspect/);
    assert.match(conversation, /\[Tool: read scripts\/deploy\.sh\]/);
    assert.match(conversation, /\[Tool: bash "grep -R DEPLOY_ENV scripts"\]/);
  });

  test("keeps head and tail context when truncating long sessions", () => {
    const entries = Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `Turn ${i} ${"x".repeat(80)}`));

    const conversation = extractConversation(entries, 1200);

    assert.match(conversation, /Turn 0/);
    assert.match(conversation, /Turn 39/);
    assert.match(conversation, /conversation truncated/);
    assert.ok(conversation.length <= 1300);
  });
});

describe("normalizeKnowledgeNote", () => {
  test("normalizes topic, tags, confidence, and related files", () => {
    const note = normalizeKnowledgeNote({
      title: " Deploy gotcha ",
      topic: " Deploy ",
      summary: "Use prod overlay.",
      details: "The prod overlay injects required labels.",
      confidence: "certain",
      tags: [" Deploy ", "deploy", "Kubernetes"],
      relatedFiles: ["@k8s/prod.yaml", " k8s/prod.yaml "],
      evidence: ["read k8s/prod.yaml"],
    });

    assert.equal(note.topic, "deploy");
    assert.equal(note.confidence, "medium");
    assert.deepEqual(note.tags, ["deploy", "kubernetes"]);
    assert.deepEqual(note.relatedFiles, ["k8s/prod.yaml"]);
  });
});

describe("knowledgeMatchesQuery", () => {
  const note: KnowledgeNote = {
    id: "k1",
    source_type: "ai-session",
    source_id: "session-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    project: "payments",
    cwd: "/repo/payments",
    sessionId: "session-1",
    title: "Deploys require prod overlay",
    topic: "deploy",
    summary: "Production deploys require the prod Kustomize overlay.",
    details: "The overlay adds labels consumed by the rollout controller.",
    evidence: ["scripts/deploy.sh references overlays/prod"],
    relatedFiles: ["scripts/deploy.sh", "overlays/prod/kustomization.yaml"],
    tags: ["kubernetes", "rollout"],
    confidence: "high",
  };

  test("matches title/topic/details/tags/files with AND semantics", () => {
    assert.equal(knowledgeMatchesQuery(note, "deploy rollout"), true);
    assert.equal(knowledgeMatchesQuery(note, "overlays/prod kubernetes"), true);
    assert.equal(knowledgeMatchesQuery(note, "terraform"), false);
  });
});

describe("formatKnowledgeReport", () => {
  test("groups notes by topic and includes footer metadata", () => {
    const notes: KnowledgeNote[] = [
      {
        id: "a",
        source_type: "ai-session",
        source_id: "s1",
        timestamp: "2026-05-08T00:00:00.000Z",
        project: "payments",
        cwd: "/repo/payments",
        sessionId: "s1",
        title: "Deploy gotcha",
        topic: "deploy",
        summary: "Use the prod overlay for production deploys.",
        details: "Labels are injected by the overlay.",
        evidence: [],
        relatedFiles: ["overlays/prod/kustomization.yaml"],
        tags: ["kubernetes"],
        confidence: "high",
      },
      {
        id: "b",
        source_type: "ai-session",
        source_id: "s2",
        timestamp: "2026-05-07T00:00:00.000Z",
        project: "payments",
        cwd: "/repo/payments",
        sessionId: "s2",
        title: "ADR location",
        topic: "docs",
        summary: "ADRs live under docs/adr.",
        details: "Use sequential numbers.",
        evidence: [],
        relatedFiles: ["docs/adr"],
        tags: ["adr"],
        confidence: "medium",
      },
    ];

    const report = formatKnowledgeReport(notes, "Knowledge Report");

    assert.match(report, /# Knowledge Report/);
    assert.match(report, /## deploy/);
    assert.match(report, /## docs/);
    assert.match(report, /overlays\/prod\/kustomization.yaml/);
    assert.match(report, /2 knowledge notes/);
  });
});

describe("backfill command helpers", () => {
  test("parses backfill subcommands without requiring a modal confirm", () => {
    assert.equal(parseBackfillAction("backfill"), "scan");
    assert.equal(parseBackfillAction("backfill start"), "start");
    assert.equal(parseBackfillAction("backfill yes"), "start");
    assert.equal(parseBackfillAction("backfill status"), "status");
    assert.equal(parseBackfillAction("backfill stop"), "stop");
    assert.equal(parseBackfillAction("report"), undefined);
  });

  test("formats a non-blocking backfill plan with an explicit start command", () => {
    const plan = formatBackfillPlan(500, 403);

    assert.match(plan, /Found 403 unanalyzed substantial sessions/);
    assert.match(plan, /\/knowledge backfill start/);
    assert.match(plan, /will run in the background/);
  });
});

describe("formatKnowledgeStats", () => {
  test("summarizes extension state and storage location", () => {
    const notes: KnowledgeNote[] = [
      {
        id: "a",
        source_type: "ai-session",
        source_id: "s1",
        timestamp: "2026-05-08T00:00:00.000Z",
        project: "payments",
        cwd: "/repo/payments",
        sessionId: "s1",
        title: "Deploy gotcha",
        topic: "deploy",
        summary: "Use the prod overlay for production deploys.",
        details: "Labels are injected by the overlay.",
        evidence: [],
        relatedFiles: [],
        tags: [],
        confidence: "high",
      },
    ];

    const stats = formatKnowledgeStats(notes, 3);

    assert.match(stats, /Tribal knowledge is loaded/);
    assert.match(stats, /Notes: 1/);
    assert.match(stats, /Analyzed sessions: 3/);
    assert.match(stats, /Storage: .*knowledge\.jsonl/);
  });
});
