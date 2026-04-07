/**
 * /init Extension - Generate CLAUDE.md for any project
 *
 * Similar to Claude Code's /init command, this analyzes the current project
 * and generates a CLAUDE.md file with project structure, conventions, and guidelines.
 *
 * On first run: generates a fresh CLAUDE.md and saves a project fingerprint.
 * On subsequent runs: compares fingerprints. If nothing changed, says so.
 * If the project changed, offers to enhance the existing CLAUDE.md via the LLM
 * rather than replacing it.
 *
 * Usage: Type /init in the pi chat
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProjectInfo {
	name: string;
	languages: string[];
	frameworks: string[];
	packageManager: string | null;
	buildTools: string[];
	testFrameworks: string[];
	configFiles: string[];
	hasGit: boolean;
	hasCi: boolean;
	ciSystem: string | null;
	hasDocker: boolean;
	hasReadme: boolean;
	readmeContent: string | null;
	directories: string[];
	entryPoints: string[];
	linters: string[];
	existingClaudeMd: string | null;
	fileTree: string;
	scripts: Record<string, string>;
	importantFiles: string[];
}

interface InitFingerprint {
	hash: string;
	timestamp: number;
	snapshot: {
		languages: string[];
		frameworks: string[];
		packageManager: string | null;
		buildTools: string[];
		testFrameworks: string[];
		linters: string[];
		ciSystem: string | null;
		directories: string[];
		scripts: Record<string, string>;
		importantFiles: string[];
		entryPoints: string[];
	};
}

// ─── Detection Maps ─────────────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript (React)",
	".js": "JavaScript",
	".jsx": "JavaScript (React)",
	".py": "Python",
	".rs": "Rust",
	".go": "Go",
	".java": "Java",
	".kt": "Kotlin",
	".rb": "Ruby",
	".php": "PHP",
	".cs": "C#",
	".cpp": "C++",
	".c": "C",
	".swift": "Swift",
	".svelte": "Svelte",
	".vue": "Vue",
	".lua": "Lua",
	".zig": "Zig",
	".ex": "Elixir",
	".exs": "Elixir",
	".hs": "Haskell",
	".ml": "OCaml",
	".sh": "Shell",
	".bash": "Bash",
};

const FRAMEWORK_INDICATORS: Record<string, { dep?: string; name: string }[]> = {
	"package.json": [
		{ dep: "react", name: "React" },
		{ dep: "next", name: "Next.js" },
		{ dep: "vue", name: "Vue" },
		{ dep: "nuxt", name: "Nuxt" },
		{ dep: "svelte", name: "Svelte" },
		{ dep: "@sveltejs/kit", name: "SvelteKit" },
		{ dep: "express", name: "Express" },
		{ dep: "fastify", name: "Fastify" },
		{ dep: "nestjs", name: "NestJS" },
		{ dep: "@angular/core", name: "Angular" },
		{ dep: "astro", name: "Astro" },
		{ dep: "remix", name: "Remix" },
		{ dep: "electron", name: "Electron" },
		{ dep: "tailwindcss", name: "Tailwind CSS" },
		{ dep: "@capacitor/core", name: "Capacitor" },
		{ dep: "ionic", name: "Ionic" },
	],
	"requirements.txt": [
		{ dep: "django", name: "Django" },
		{ dep: "flask", name: "Flask" },
		{ dep: "fastapi", name: "FastAPI" },
		{ dep: "pytorch", name: "PyTorch" },
		{ dep: "tensorflow", name: "TensorFlow" },
	],
	"Cargo.toml": [
		{ dep: "actix-web", name: "Actix Web" },
		{ dep: "axum", name: "Axum" },
		{ dep: "tokio", name: "Tokio" },
		{ dep: "rocket", name: "Rocket" },
	],
	"go.mod": [
		{ dep: "gin-gonic/gin", name: "Gin" },
		{ dep: "gofiber/fiber", name: "Fiber" },
		{ dep: "gorilla/mux", name: "Gorilla Mux" },
	],
};

const TEST_INDICATORS: Record<string, string> = {
	jest: "Jest",
	vitest: "Vitest",
	mocha: "Mocha",
	"@testing-library": "Testing Library",
	cypress: "Cypress",
	playwright: "Playwright",
	pytest: "pytest",
	unittest: "unittest",
	"go test": "Go Test",
	"cargo test": "Cargo Test",
};

const LINTER_INDICATORS: Record<string, string> = {
	eslint: "ESLint",
	prettier: "Prettier",
	biome: "Biome",
	"@biomejs/biome": "Biome",
	ruff: "Ruff",
	black: "Black",
	flake8: "Flake8",
	clippy: "Clippy",
	golangci: "golangci-lint",
};

// ─── Utility Functions ──────────────────────────────────────────────────────

function safeReadFile(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function safeReadJson(filePath: string): any | null {
	const content = safeReadFile(filePath);
	if (!content) return null;
	try {
		return JSON.parse(content);
	} catch {
		return null;
	}
}

// ─── Fingerprint Functions ──────────────────────────────────────────────────

function getFingerprintPath(cwd: string): string {
	return path.join(cwd, ".pi", "init-fingerprint.json");
}

function loadFingerprint(cwd: string): InitFingerprint | null {
	return safeReadJson(getFingerprintPath(cwd));
}

function saveFingerprint(cwd: string, info: ProjectInfo): void {
	const snapshot: InitFingerprint["snapshot"] = {
		languages: [...info.languages].sort(),
		frameworks: [...info.frameworks].sort(),
		packageManager: info.packageManager,
		buildTools: [...info.buildTools].sort(),
		testFrameworks: [...info.testFrameworks].sort(),
		linters: [...info.linters].sort(),
		ciSystem: info.ciSystem,
		directories: [...info.directories].sort(),
		scripts: info.scripts,
		importantFiles: [...info.importantFiles].sort(),
		entryPoints: [...info.entryPoints].sort(),
	};

	const hash = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);

	const fingerprint: InitFingerprint = {
		hash,
		timestamp: Date.now(),
		snapshot,
	};

	const fpPath = getFingerprintPath(cwd);
	fs.mkdirSync(path.dirname(fpPath), { recursive: true });
	fs.writeFileSync(fpPath, JSON.stringify(fingerprint, null, 2));
}

function diffSnapshots(
	old: InitFingerprint["snapshot"],
	current: InitFingerprint["snapshot"],
): string[] {
	const changes: string[] = [];

	// Languages
	const addedLangs = current.languages.filter((l) => !old.languages.includes(l));
	const removedLangs = old.languages.filter((l) => !current.languages.includes(l));
	if (addedLangs.length) changes.push(`New languages: ${addedLangs.join(", ")}`);
	if (removedLangs.length) changes.push(`Removed languages: ${removedLangs.join(", ")}`);

	// Frameworks
	const addedFw = current.frameworks.filter((f) => !old.frameworks.includes(f));
	const removedFw = old.frameworks.filter((f) => !current.frameworks.includes(f));
	if (addedFw.length) changes.push(`New frameworks: ${addedFw.join(", ")}`);
	if (removedFw.length) changes.push(`Removed frameworks: ${removedFw.join(", ")}`);

	// Package manager
	if (old.packageManager !== current.packageManager) {
		changes.push(`Package manager: ${old.packageManager || "none"} → ${current.packageManager || "none"}`);
	}

	// Build tools
	const addedBt = current.buildTools.filter((b) => !old.buildTools.includes(b));
	const removedBt = old.buildTools.filter((b) => !current.buildTools.includes(b));
	if (addedBt.length) changes.push(`New build tools: ${addedBt.join(", ")}`);
	if (removedBt.length) changes.push(`Removed build tools: ${removedBt.join(", ")}`);

	// Test frameworks
	const addedTest = current.testFrameworks.filter((t) => !old.testFrameworks.includes(t));
	const removedTest = old.testFrameworks.filter((t) => !current.testFrameworks.includes(t));
	if (addedTest.length) changes.push(`New test frameworks: ${addedTest.join(", ")}`);
	if (removedTest.length) changes.push(`Removed test frameworks: ${removedTest.join(", ")}`);

	// Linters
	const addedLint = current.linters.filter((l) => !old.linters.includes(l));
	const removedLint = old.linters.filter((l) => !current.linters.includes(l));
	if (addedLint.length) changes.push(`New linters: ${addedLint.join(", ")}`);
	if (removedLint.length) changes.push(`Removed linters: ${removedLint.join(", ")}`);

	// CI
	if (old.ciSystem !== current.ciSystem) {
		changes.push(`CI/CD: ${old.ciSystem || "none"} → ${current.ciSystem || "none"}`);
	}

	// Directories
	const addedDirs = current.directories.filter((d) => !old.directories.includes(d));
	const removedDirs = old.directories.filter((d) => !current.directories.includes(d));
	if (addedDirs.length) changes.push(`New directories: ${addedDirs.join(", ")}`);
	if (removedDirs.length) changes.push(`Removed directories: ${removedDirs.join(", ")}`);

	// Scripts
	const oldScriptKeys = Object.keys(old.scripts).sort();
	const newScriptKeys = Object.keys(current.scripts).sort();
	const addedScripts = newScriptKeys.filter((s) => !oldScriptKeys.includes(s));
	const removedScripts = oldScriptKeys.filter((s) => !newScriptKeys.includes(s));
	const changedScripts = newScriptKeys.filter(
		(s) => oldScriptKeys.includes(s) && old.scripts[s] !== current.scripts[s],
	);
	if (addedScripts.length) changes.push(`New scripts: ${addedScripts.join(", ")}`);
	if (removedScripts.length) changes.push(`Removed scripts: ${removedScripts.join(", ")}`);
	if (changedScripts.length) changes.push(`Changed scripts: ${changedScripts.join(", ")}`);

	// Entry points
	const addedEp = current.entryPoints.filter((e) => !old.entryPoints.includes(e));
	const removedEp = old.entryPoints.filter((e) => !current.entryPoints.includes(e));
	if (addedEp.length) changes.push(`New entry points: ${addedEp.join(", ")}`);
	if (removedEp.length) changes.push(`Removed entry points: ${removedEp.join(", ")}`);

	// Important files
	const addedFiles = current.importantFiles.filter((f) => !old.importantFiles.includes(f));
	const removedFiles = old.importantFiles.filter((f) => !current.importantFiles.includes(f));
	if (addedFiles.length) changes.push(`New config files: ${addedFiles.join(", ")}`);
	if (removedFiles.length) changes.push(`Removed config files: ${removedFiles.join(", ")}`);

	return changes;
}

// ─── Project Analysis ───────────────────────────────────────────────────────

async function getFileTree(cwd: string, pi: ExtensionAPI): Promise<string> {
	try {
		const result = await pi.exec(
			"find",
			[
				".",
				"-maxdepth", "3",
				"-not", "-path", "*/node_modules/*",
				"-not", "-path", "*/.git/*",
				"-not", "-path", "*/dist/*",
				"-not", "-path", "*/build/*",
				"-not", "-path", "*/.next/*",
				"-not", "-path", "*/__pycache__/*",
				"-not", "-path", "*/target/*",
				"-not", "-path", "*/.svelte-kit/*",
				"-not", "-path", "*/venv/*",
				"-not", "-path", "*/.venv/*",
				"-not", "-path", "*/.pi/*",
			],
			{ cwd, timeout: 5000 },
		);
		if (result.code === 0) {
			const lines = result.stdout.split("\n").filter((l) => l.trim()).sort();
			return lines.slice(0, 100).join("\n") + (lines.length > 100 ? "\n... and more" : "");
		}
	} catch {}
	return "";
}

async function detectLanguages(cwd: string, pi: ExtensionAPI): Promise<string[]> {
	const languages = new Set<string>();
	try {
		const result = await pi.exec(
			"find",
			[
				".",
				"-maxdepth", "4",
				"-type", "f",
				"-not", "-path", "*/node_modules/*",
				"-not", "-path", "*/.git/*",
				"-not", "-path", "*/dist/*",
				"-not", "-path", "*/build/*",
				"-not", "-path", "*/target/*",
				"-not", "-path", "*/venv/*",
			],
			{ cwd, timeout: 5000 },
		);
		if (result.code === 0) {
			for (const file of result.stdout.split("\n")) {
				const ext = path.extname(file);
				if (LANGUAGE_MAP[ext]) {
					languages.add(LANGUAGE_MAP[ext]);
				}
			}
		}
	} catch {}
	return Array.from(languages);
}

function detectFrameworks(cwd: string): string[] {
	const frameworks: string[] = [];
	for (const [configFile, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
		const filePath = path.join(cwd, configFile);
		if (configFile === "package.json") {
			const pkg = safeReadJson(filePath);
			if (!pkg) continue;
			const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
			for (const ind of indicators) {
				if (ind.dep && allDeps[ind.dep]) frameworks.push(ind.name);
			}
		} else {
			const content = safeReadFile(filePath);
			if (!content) continue;
			for (const ind of indicators) {
				if (ind.dep && content.includes(ind.dep)) frameworks.push(ind.name);
			}
		}
	}
	return [...new Set(frameworks)];
}

function detectPackageManager(cwd: string): string | null {
	if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
	if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
	if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";
	if (fs.existsSync(path.join(cwd, "Pipfile.lock"))) return "pipenv";
	if (fs.existsSync(path.join(cwd, "poetry.lock"))) return "poetry";
	if (fs.existsSync(path.join(cwd, "uv.lock"))) return "uv";
	if (fs.existsSync(path.join(cwd, "requirements.txt"))) return "pip";
	if (fs.existsSync(path.join(cwd, "Cargo.lock"))) return "cargo";
	if (fs.existsSync(path.join(cwd, "go.sum"))) return "go modules";
	if (fs.existsSync(path.join(cwd, "Gemfile.lock"))) return "bundler";
	return null;
}

function detectBuildTools(cwd: string): string[] {
	const tools: string[] = [];
	if (fs.existsSync(path.join(cwd, "vite.config.ts")) || fs.existsSync(path.join(cwd, "vite.config.js"))) tools.push("Vite");
	if (fs.existsSync(path.join(cwd, "webpack.config.js")) || fs.existsSync(path.join(cwd, "webpack.config.ts"))) tools.push("Webpack");
	if (fs.existsSync(path.join(cwd, "rollup.config.js"))) tools.push("Rollup");
	if (fs.existsSync(path.join(cwd, "esbuild.config.js"))) tools.push("esbuild");
	if (fs.existsSync(path.join(cwd, "tsconfig.json"))) tools.push("TypeScript Compiler");
	if (fs.existsSync(path.join(cwd, "Makefile"))) tools.push("Make");
	if (fs.existsSync(path.join(cwd, "CMakeLists.txt"))) tools.push("CMake");
	if (fs.existsSync(path.join(cwd, "Dockerfile"))) tools.push("Docker");
	if (fs.existsSync(path.join(cwd, "docker-compose.yml")) || fs.existsSync(path.join(cwd, "docker-compose.yaml"))) tools.push("Docker Compose");
	return tools;
}

function detectTestFrameworks(cwd: string): string[] {
	const tests: string[] = [];
	const pkg = safeReadJson(path.join(cwd, "package.json"));
	if (pkg) {
		const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		for (const [dep, name] of Object.entries(TEST_INDICATORS)) {
			if (allDeps[dep]) tests.push(name);
		}
		if (pkg.scripts?.test) {
			if (pkg.scripts.test.includes("vitest")) tests.push("Vitest");
			if (pkg.scripts.test.includes("jest")) tests.push("Jest");
		}
	}
	if (fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "pyproject.toml"))) {
		const pyproject = safeReadFile(path.join(cwd, "pyproject.toml"));
		if (pyproject?.includes("[tool.pytest")) tests.push("pytest");
	}
	return [...new Set(tests)];
}

function detectLinters(cwd: string): string[] {
	const linters: string[] = [];
	const pkg = safeReadJson(path.join(cwd, "package.json"));
	if (pkg) {
		const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		for (const [dep, name] of Object.entries(LINTER_INDICATORS)) {
			if (allDeps[dep]) linters.push(name);
		}
	}
	if (fs.existsSync(path.join(cwd, ".eslintrc.js")) || fs.existsSync(path.join(cwd, ".eslintrc.json")) || fs.existsSync(path.join(cwd, "eslint.config.js")) || fs.existsSync(path.join(cwd, "eslint.config.mjs"))) linters.push("ESLint");
	if (fs.existsSync(path.join(cwd, ".prettierrc")) || fs.existsSync(path.join(cwd, ".prettierrc.json"))) linters.push("Prettier");
	if (fs.existsSync(path.join(cwd, "biome.json")) || fs.existsSync(path.join(cwd, "biome.jsonc"))) linters.push("Biome");
	if (fs.existsSync(path.join(cwd, "ruff.toml")) || fs.existsSync(path.join(cwd, ".ruff.toml"))) linters.push("Ruff");
	return [...new Set(linters)];
}

function detectCI(cwd: string): { hasCi: boolean; ciSystem: string | null } {
	if (fs.existsSync(path.join(cwd, ".github", "workflows"))) return { hasCi: true, ciSystem: "GitHub Actions" };
	if (fs.existsSync(path.join(cwd, ".gitlab-ci.yml"))) return { hasCi: true, ciSystem: "GitLab CI" };
	if (fs.existsSync(path.join(cwd, "Jenkinsfile"))) return { hasCi: true, ciSystem: "Jenkins" };
	if (fs.existsSync(path.join(cwd, ".circleci"))) return { hasCi: true, ciSystem: "CircleCI" };
	if (fs.existsSync(path.join(cwd, ".travis.yml"))) return { hasCi: true, ciSystem: "Travis CI" };
	return { hasCi: false, ciSystem: null };
}

function getTopDirectories(cwd: string): string[] {
	try {
		return fs.readdirSync(cwd, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "dist", "build", "target", "__pycache__", "venv", ".venv"].includes(d.name))
			.map((d) => d.name);
	} catch {
		return [];
	}
}

function getScripts(cwd: string): Record<string, string> {
	const pkg = safeReadJson(path.join(cwd, "package.json"));
	return pkg?.scripts || {};
}

function getImportantFiles(cwd: string): string[] {
	const candidates = [
		"package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml",
		"Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
		".env.example", "README.md", "CONTRIBUTING.md", "LICENSE",
		"svelte.config.js", "vite.config.ts", "vite.config.js",
		"next.config.js", "next.config.mjs",
		"capacitor.config.ts", "capacitor.config.json", "nginx.conf", "biome.json",
	];
	return candidates.filter((f) => fs.existsSync(path.join(cwd, f)));
}

function findEntryPoints(cwd: string): string[] {
	const candidates = [
		"src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
		"src/app.ts", "src/app.js", "src/lib/index.ts", "src/lib/index.js",
		"index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js",
		"src/routes/+layout.svelte", "src/routes/+page.svelte",
		"src/App.svelte", "src/App.tsx", "src/App.vue",
		"pages/index.tsx", "app/page.tsx",
		"main.py", "app.py", "manage.py", "src/main.rs", "main.go", "cmd/main.go",
	];
	return candidates.filter((f) => fs.existsSync(path.join(cwd, f)));
}

async function analyzeProject(cwd: string, pi: ExtensionAPI): Promise<ProjectInfo> {
	const pkg = safeReadJson(path.join(cwd, "package.json"));
	const ci = detectCI(cwd);
	const readme = safeReadFile(path.join(cwd, "README.md"));
	const existingClaudeMd = safeReadFile(path.join(cwd, "CLAUDE.md"));
	const [languages, fileTree] = await Promise.all([detectLanguages(cwd, pi), getFileTree(cwd, pi)]);

	return {
		name: pkg?.name || path.basename(cwd),
		languages,
		frameworks: detectFrameworks(cwd),
		packageManager: detectPackageManager(cwd),
		buildTools: detectBuildTools(cwd),
		testFrameworks: detectTestFrameworks(cwd),
		configFiles: getImportantFiles(cwd),
		hasGit: fs.existsSync(path.join(cwd, ".git")),
		hasCi: ci.hasCi,
		ciSystem: ci.ciSystem,
		hasDocker: fs.existsSync(path.join(cwd, "Dockerfile")),
		hasReadme: !!readme,
		readmeContent: readme ? readme.slice(0, 2000) : null,
		directories: getTopDirectories(cwd),
		entryPoints: findEntryPoints(cwd),
		linters: detectLinters(cwd),
		existingClaudeMd,
		fileTree,
		scripts: getScripts(cwd),
		importantFiles: getImportantFiles(cwd),
	};
}

// ─── CLAUDE.md Generation ───────────────────────────────────────────────────

function generateClaudeMd(info: ProjectInfo): string {
	const sections: string[] = [];

	sections.push(`# ${info.name}\n`);

	// Tech stack
	const overviewParts: string[] = [];
	if (info.languages.length > 0) overviewParts.push(`**Languages:** ${info.languages.join(", ")}`);
	if (info.frameworks.length > 0) overviewParts.push(`**Frameworks:** ${info.frameworks.join(", ")}`);
	if (info.packageManager) overviewParts.push(`**Package Manager:** ${info.packageManager}`);
	if (info.buildTools.length > 0) overviewParts.push(`**Build Tools:** ${info.buildTools.join(", ")}`);
	if (info.testFrameworks.length > 0) overviewParts.push(`**Testing:** ${info.testFrameworks.join(", ")}`);
	if (info.linters.length > 0) overviewParts.push(`**Linting/Formatting:** ${info.linters.join(", ")}`);
	if (info.ciSystem) overviewParts.push(`**CI/CD:** ${info.ciSystem}`);
	if (overviewParts.length > 0) sections.push(`## Tech Stack\n\n${overviewParts.join("\n")}\n`);

	// Project structure
	if (info.directories.length > 0) {
		sections.push(`## Project Structure\n\n${info.directories.map((d) => `- \`${d}/\``).join("\n")}\n`);
	}

	// Key files
	if (info.importantFiles.length > 0) {
		sections.push(`## Key Files\n\n${info.importantFiles.map((f) => `- \`${f}\``).join("\n")}\n`);
	}

	// Common commands
	const commands: string[] = [];
	if (info.scripts) {
		const scriptMap: Record<string, string> = {
			dev: "Start development server",
			build: "Build for production",
			start: "Start the application",
			test: "Run tests",
			lint: "Run linter",
			format: "Format code",
			preview: "Preview production build",
			check: "Type check",
			"type-check": "Type check",
		};
		for (const [script, desc] of Object.entries(scriptMap)) {
			if (info.scripts[script]) {
				const pm = info.packageManager || "npm";
				const runCmd = pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
				commands.push(`- **${desc}:** \`${runCmd}\` → \`${info.scripts[script]}\``);
			}
		}
	}
	if (commands.length > 0) sections.push(`## Common Commands\n\n${commands.join("\n")}\n`);

	// Development guidelines
	const guidelines: string[] = [];
	if (info.languages.some((l) => l.includes("TypeScript"))) guidelines.push("- Use TypeScript with strict mode for type safety");
	if (info.frameworks.includes("Svelte") || info.frameworks.includes("SvelteKit")) guidelines.push("- Follow Svelte component conventions (single-file components)");
	if (info.frameworks.includes("React")) guidelines.push("- Use functional components with hooks");
	if (info.frameworks.includes("Tailwind CSS")) guidelines.push("- Use Tailwind utility classes for styling");
	if (info.linters.includes("ESLint")) guidelines.push("- Follow ESLint configuration for code style");
	if (info.linters.includes("Prettier") || info.linters.includes("Biome")) guidelines.push("- Code is auto-formatted — don't worry about manual formatting");
	if (info.hasDocker) guidelines.push("- Docker is available for containerized builds/deploys");
	if (guidelines.length > 0) sections.push(`## Development Guidelines\n\n${guidelines.join("\n")}\n`);

	// Placeholder sections
	sections.push(`## Conventions\n
- <!-- Add your coding conventions here -->
- <!-- e.g., naming patterns, file organization rules, import ordering -->
- <!-- e.g., error handling patterns, logging conventions -->
`);

	sections.push(`## Notes\n
- <!-- Add project-specific notes, gotchas, or context for the AI -->
- <!-- e.g., "Don't modify the legacy auth module — it's being replaced" -->
- <!-- e.g., "Always run tests before committing" -->
`);

	return sections.join("\n");
}

function formatChangesSummary(changes: string[], lastRun: number): string {
	const ago = formatTimeAgo(lastRun);
	let summary = `Project has changed since last /init (${ago}):\n\n`;
	for (const change of changes) {
		summary += `  • ${change}\n`;
	}
	return summary;
}

function formatTimeAgo(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function initClaudeMdExtension(pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Generate or enhance CLAUDE.md for this project",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const claudeMdPath = path.join(cwd, "CLAUDE.md");
			const hasExisting = fs.existsSync(claudeMdPath);

			ctx.ui.notify("Analyzing project...", "info");
			const info = await analyzeProject(cwd, pi);

			// ── No existing CLAUDE.md → fresh generation ──
			if (!hasExisting) {
				const generated = generateClaudeMd(info);
				const edited = await ctx.ui.editor("Review and edit CLAUDE.md before saving:", generated);

				if (edited !== undefined && edited !== null) {
					fs.writeFileSync(claudeMdPath, edited);
					saveFingerprint(cwd, info);
					ctx.ui.notify("✓ CLAUDE.md created and fingerprint saved!", "success");
				} else {
					ctx.ui.notify("Cancelled — CLAUDE.md was not created.", "info");
				}
				return;
			}

			// ── Existing CLAUDE.md → check fingerprint ──
			const savedFp = loadFingerprint(cwd);

			// No fingerprint saved yet (CLAUDE.md was created outside /init)
			if (!savedFp) {
				const action = await ctx.ui.select(
					"CLAUDE.md exists but has no /init fingerprint. What would you like to do?",
					["Save fingerprint for future change detection", "Regenerate from scratch", "Edit existing", "Cancel"],
				);

				if (!action || action === "Cancel") {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}

				if (action === "Save fingerprint for future change detection") {
					saveFingerprint(cwd, info);
					ctx.ui.notify("✓ Fingerprint saved! Next /init will detect changes.", "success");
					return;
				}

				if (action === "Edit existing") {
					const existing = safeReadFile(claudeMdPath) || "";
					const edited = await ctx.ui.editor("Edit CLAUDE.md:", existing);
					if (edited !== undefined && edited !== null) {
						fs.writeFileSync(claudeMdPath, edited);
						saveFingerprint(cwd, info);
						ctx.ui.notify("✓ CLAUDE.md updated and fingerprint saved!", "success");
					} else {
						ctx.ui.notify("Cancelled.", "info");
					}
					return;
				}

				if (action === "Regenerate from scratch") {
					const generated = generateClaudeMd(info);
					const edited = await ctx.ui.editor("Review and edit CLAUDE.md before saving:", generated);
					if (edited !== undefined && edited !== null) {
						fs.writeFileSync(claudeMdPath, edited);
						saveFingerprint(cwd, info);
						ctx.ui.notify("✓ CLAUDE.md regenerated and fingerprint saved!", "success");
					} else {
						ctx.ui.notify("Cancelled.", "info");
					}
					return;
				}
				return;
			}

			// ── Has fingerprint → compare ──
			const currentSnapshot: InitFingerprint["snapshot"] = {
				languages: [...info.languages].sort(),
				frameworks: [...info.frameworks].sort(),
				packageManager: info.packageManager,
				buildTools: [...info.buildTools].sort(),
				testFrameworks: [...info.testFrameworks].sort(),
				linters: [...info.linters].sort(),
				ciSystem: info.ciSystem,
				directories: [...info.directories].sort(),
				scripts: info.scripts,
				importantFiles: [...info.importantFiles].sort(),
				entryPoints: [...info.entryPoints].sort(),
			};

			const currentHash = crypto
				.createHash("sha256")
				.update(JSON.stringify(currentSnapshot))
				.digest("hex")
				.slice(0, 16);

			if (currentHash === savedFp.hash) {
				// Nothing changed
				const ago = formatTimeAgo(savedFp.timestamp);
				const action = await ctx.ui.select(
					`Nothing has changed since last /init (${ago}). CLAUDE.md is up to date.`,
					["Edit existing CLAUDE.md anyway", "Force regenerate", "OK, done"],
				);

				if (!action || action === "OK, done") {
					return;
				}

				if (action === "Edit existing CLAUDE.md anyway") {
					const existing = safeReadFile(claudeMdPath) || "";
					const edited = await ctx.ui.editor("Edit CLAUDE.md:", existing);
					if (edited !== undefined && edited !== null) {
						fs.writeFileSync(claudeMdPath, edited);
						ctx.ui.notify("✓ CLAUDE.md updated!", "success");
					} else {
						ctx.ui.notify("Cancelled.", "info");
					}
					return;
				}

				if (action === "Force regenerate") {
					const generated = generateClaudeMd(info);
					const edited = await ctx.ui.editor("Review and edit CLAUDE.md before saving:", generated);
					if (edited !== undefined && edited !== null) {
						fs.writeFileSync(claudeMdPath, edited);
						saveFingerprint(cwd, info);
						ctx.ui.notify("✓ CLAUDE.md regenerated and fingerprint saved!", "success");
					} else {
						ctx.ui.notify("Cancelled.", "info");
					}
					return;
				}
				return;
			}

			// ── Project changed → offer to enhance ──
			const changes = diffSnapshots(savedFp.snapshot, currentSnapshot);
			const changeSummary = formatChangesSummary(changes, savedFp.timestamp);

			ctx.ui.notify(changeSummary, "warning");

			const action = await ctx.ui.select(
				"Project has changed. How would you like to update CLAUDE.md?",
				[
					"Enhance — let the LLM update CLAUDE.md with the changes",
					"Regenerate from scratch",
					"Edit existing manually",
					"Just update the fingerprint (no changes to CLAUDE.md)",
					"Cancel",
				],
			);

			if (!action || action === "Cancel") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			if (action === "Just update the fingerprint (no changes to CLAUDE.md)") {
				saveFingerprint(cwd, info);
				ctx.ui.notify("✓ Fingerprint updated!", "success");
				return;
			}

			if (action === "Edit existing manually") {
				const existing = safeReadFile(claudeMdPath) || "";
				const edited = await ctx.ui.editor("Edit CLAUDE.md:", existing);
				if (edited !== undefined && edited !== null) {
					fs.writeFileSync(claudeMdPath, edited);
					saveFingerprint(cwd, info);
					ctx.ui.notify("✓ CLAUDE.md updated and fingerprint saved!", "success");
				} else {
					ctx.ui.notify("Cancelled.", "info");
				}
				return;
			}

			if (action === "Regenerate from scratch") {
				const generated = generateClaudeMd(info);
				const edited = await ctx.ui.editor("Review and edit CLAUDE.md before saving:", generated);
				if (edited !== undefined && edited !== null) {
					fs.writeFileSync(claudeMdPath, edited);
					saveFingerprint(cwd, info);
					ctx.ui.notify("✓ CLAUDE.md regenerated and fingerprint saved!", "success");
				} else {
					ctx.ui.notify("Cancelled.", "info");
				}
				return;
			}

			// ── Enhance via LLM ──
			if (action.startsWith("Enhance")) {
				const existingContent = safeReadFile(claudeMdPath) || "";
				const freshAnalysis = generateClaudeMd(info);

				// Update fingerprint now, the LLM will handle the file update
				saveFingerprint(cwd, info);

				const changeList = changes.map((c) => `- ${c}`).join("\n");

				// Send to the LLM as a user message so it can read/edit the file intelligently
				pi.sendUserMessage(
					`The /init command detected project changes. Please enhance the existing CLAUDE.md file.

**Detected changes since last /init:**
${changeList}

**Current CLAUDE.md contents:**
\`\`\`markdown
${existingContent}
\`\`\`

**Fresh project analysis (for reference — don't replace, merge):**
\`\`\`markdown
${freshAnalysis}
\`\`\`

Please update the CLAUDE.md file at \`${claudeMdPath}\` by:
1. Preserving all existing custom content, notes, and conventions the user added
2. Updating the auto-generated sections (Tech Stack, Project Structure, Key Files, Common Commands) to reflect the detected changes
3. Adding any new relevant development guidelines based on new frameworks/tools
4. Do NOT remove any user-written content — only add or update factual project info

Use the edit or write tool to update the file.`,
					{ deliverAs: "followUp" },
				);

				ctx.ui.notify("Fingerprint updated. The LLM will now enhance your CLAUDE.md...", "info");
				return;
			}
		},
	});
}
