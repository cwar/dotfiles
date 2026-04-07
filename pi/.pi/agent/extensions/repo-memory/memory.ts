import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Insight {
  id: string;
  topic: string;
  content: string;
  relatedFiles: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

// ── Architecture Decision Record ──────────────────────────

export const ADR_SECTIONS = [
  "PURPOSE",
  "STACK",
  "ARCHITECTURE",
  "PATTERNS",
  "TRADEOFFS",
  "PHILOSOPHY",
] as const;

export type ADRSection = (typeof ADR_SECTIONS)[number];

export interface ADRData {
  sections: Record<ADRSection, string>;
  createdAt: number;
  updatedAt: number;
}

export class ADRStore {
  private filePath: string;
  private data: ADRData | null = null;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "adr.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.data = raw.adr ?? null;
      }
    } catch {
      this.data = null;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, adr: this.data }, null, 2)
    );
  }

  /** Parse markdown content with ## SECTION headers into structured sections */
  static parseSections(content: string): Partial<Record<ADRSection, string>> {
    const result: Partial<Record<ADRSection, string>> = {};
    let currentSection: ADRSection | null = null;
    let currentLines: string[] = [];

    for (const line of content.split("\n")) {
      const headerMatch = line.match(/^##\s+(\w+)\s*$/);
      if (headerMatch) {
        // Save previous section
        if (currentSection) {
          result[currentSection] = currentLines.join("\n").trim();
        }
        const sectionName = headerMatch[1].toUpperCase() as ADRSection;
        if (ADR_SECTIONS.includes(sectionName)) {
          currentSection = sectionName;
          currentLines = [];
        } else {
          currentSection = null;
          currentLines = [];
        }
      } else if (currentSection) {
        currentLines.push(line);
      }
    }
    // Save last section
    if (currentSection) {
      result[currentSection] = currentLines.join("\n").trim();
    }
    return result;
  }

  /** Store (create or fully replace) an ADR. All 6 sections required. */
  store(content: string): { success: boolean; error?: string } {
    if (content.length > 8000) {
      return { success: false, error: "ADR exceeds 8000 character limit" };
    }

    const sections = ADRStore.parseSections(content);
    const missing = ADR_SECTIONS.filter((s) => !sections[s]);
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required sections: ${missing.join(", ")}. All 6 sections (## PURPOSE, ## STACK, ## ARCHITECTURE, ## PATTERNS, ## TRADEOFFS, ## PHILOSOPHY) are required.`,
      };
    }

    const now = Date.now();
    this.data = {
      sections: sections as Record<ADRSection, string>,
      createdAt: this.data?.createdAt ?? now,
      updatedAt: now,
    };
    this.save();
    return { success: true };
  }

  /** Update specific sections. Non-canonical keys rejected. Unmentioned sections preserved. */
  update(sectionUpdates: Record<string, string>): { success: boolean; error?: string } {
    if (!this.data) {
      return { success: false, error: "No ADR exists. Use mode='store' to create one first." };
    }

    const invalidKeys = Object.keys(sectionUpdates).filter(
      (k) => !ADR_SECTIONS.includes(k.toUpperCase() as ADRSection)
    );
    if (invalidKeys.length > 0) {
      return {
        success: false,
        error: `Invalid section names: ${invalidKeys.join(", ")}. Valid: ${ADR_SECTIONS.join(", ")}`,
      };
    }

    for (const [key, value] of Object.entries(sectionUpdates)) {
      this.data.sections[key.toUpperCase() as ADRSection] = value;
    }
    this.data.updatedAt = Date.now();

    // Check total size
    const total = Object.values(this.data.sections).join("").length;
    if (total > 8000) {
      return { success: false, error: "Updated ADR would exceed 8000 character limit" };
    }

    this.save();
    return { success: true };
  }

  /** Get the ADR, optionally filtered to specific sections. */
  get(include?: ADRSection[]): ADRData | null {
    if (!this.data) return null;
    if (!include || include.length === 0) return this.data;

    // Return filtered copy
    const filtered: Record<ADRSection, string> = {} as any;
    for (const section of include) {
      if (this.data.sections[section] !== undefined) {
        filtered[section] = this.data.sections[section];
      }
    }
    return { ...this.data, sections: filtered };
  }

  /** Delete the ADR. */
  delete(): boolean {
    if (!this.data) return false;
    this.data = null;
    this.save();
    return true;
  }

  exists(): boolean {
    return this.data !== null;
  }

  /** Format ADR as readable markdown */
  formatMarkdown(data: ADRData): string {
    const lines: string[] = [];
    for (const section of ADR_SECTIONS) {
      if (data.sections[section] !== undefined) {
        lines.push(`## ${section}`);
        lines.push(data.sections[section]);
        lines.push("");
      }
    }
    return lines.join("\n").trim();
  }
}

export class Memory {
  private insights: Insight[] = [];
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "insights.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.insights = data.insights ?? [];
      }
    } catch {
      this.insights = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, insights: this.insights }, null, 2)
    );
  }

  add(
    topic: string,
    content: string,
    relatedFiles: string[] = [],
    tags: string[] = []
  ): Insight {
    const now = Date.now();
    const entry: Insight = {
      id: randomUUID().slice(0, 8),
      topic,
      content,
      relatedFiles,
      tags,
      createdAt: now,
      updatedAt: now,
    };
    this.insights.push(entry);
    this.save();
    return entry;
  }

  update(
    id: string,
    updates: Partial<Pick<Insight, "topic" | "content" | "relatedFiles" | "tags">>
  ): Insight | null {
    const insight = this.insights.find((i) => i.id === id);
    if (!insight) return null;
    Object.assign(insight, updates, { updatedAt: Date.now() });
    this.save();
    return insight;
  }

  remove(id: string): boolean {
    const before = this.insights.length;
    this.insights = this.insights.filter((i) => i.id !== id);
    if (this.insights.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  search(query: string): Insight[] {
    if (!query.trim()) return [...this.insights];
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return [...this.insights];

    return this.insights
      .map((insight) => {
        let score = 0;
        for (const term of terms) {
          if (insight.topic.toLowerCase().includes(term)) score += 3;
          if (insight.tags.some((t) => t.toLowerCase().includes(term))) score += 2;
          if (insight.content.toLowerCase().includes(term)) score += 1;
          if (insight.relatedFiles.some((f) => f.toLowerCase().includes(term))) score += 1;
        }
        return { insight, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.insight);
  }

  getAll(): Insight[] {
    return [...this.insights];
  }

  count(): number {
    return this.insights.length;
  }
}
