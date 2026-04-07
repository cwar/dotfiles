import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Voice input extension for pi.
 *
 * Records audio from the default microphone via ffmpeg, transcribes via
 * Groq or OpenAI Whisper API, and pastes the result into the editor.
 *
 * Shortcut: Alt+V  (toggle recording)
 * Command:  /voice [start|stop|status]
 *
 * Requires: ffmpeg, GROQ_API_KEY or OPENAI_API_KEY
 */

const MAX_RECORDING_SECONDS = 120;
const SAMPLE_RATE = 16000; // 16kHz mono — optimal for Whisper

type TranscriptionBackend = "groq" | "openai" | "none";

interface RecordingState {
	process: ChildProcess;
	file: string;
	startTime: number;
	timer: ReturnType<typeof setInterval>;
}

export default function (pi: ExtensionAPI) {
	let state: RecordingState | null = null;

	// ── helpers ──────────────────────────────────────────────

	function getBackend(): TranscriptionBackend {
		if (process.env.GROQ_API_KEY) return "groq";
		if (process.env.OPENAI_API_KEY) return "openai";
		return "none";
	}

	function backendLabel(b: TranscriptionBackend): string {
		return b === "groq" ? "Groq" : b === "openai" ? "OpenAI" : "not configured";
	}

	function elapsed(): number {
		return state ? Math.round((Date.now() - state.startTime) / 1000) : 0;
	}

	// ── recording ───────────────────────────────────────────

	async function startRecording(ctx: ExtensionContext) {
		if (state) return; // already recording

		const backend = getBackend();
		if (backend === "none") {
			ctx.ui.notify("Set GROQ_API_KEY or OPENAI_API_KEY for voice input", "error");
			return;
		}

		const file = join(tmpdir(), `pi-voice-${Date.now()}.wav`);

		// ffmpeg: record from PulseAudio default source, 16kHz mono WAV
		const proc = spawn(
			"ffmpeg",
			["-y", "-f", "pulse", "-i", "default", "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", "-t", String(MAX_RECORDING_SECONDS), file],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		// Surface ffmpeg errors
		let ffmpegErr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			ffmpegErr += d.toString();
		});

		proc.on("error", (err) => {
			ctx.ui.notify(`ffmpeg error: ${err.message}`, "error");
			cleanup(ctx);
		});

		// Auto-stop on max duration
		proc.on("close", () => {
			if (state?.process === proc) {
				// ffmpeg hit -t max duration; transcribe what we have
				stopAndTranscribe(ctx);
			}
		});

		const timer = setInterval(() => {
			const s = elapsed();
			const bar = "█".repeat(Math.min(s, 20));
			ctx.ui.setStatus("voice", `\x1b[31m● REC ${s}s\x1b[0m ${bar}  (Alt+V stop)`);
		}, 500);

		state = { process: proc, file, startTime: Date.now(), timer };
		ctx.ui.setStatus("voice", `\x1b[31m● REC 0s\x1b[0m  (Alt+V stop)`);
	}

	async function stopAndTranscribe(ctx: ExtensionContext) {
		if (!state) return;

		const { file, timer, process: proc } = state;
		const duration = elapsed();
		clearInterval(timer);

		// Stop ffmpeg gracefully — send "q" to stdin (flushes file correctly)
		if (!proc.killed) {
			proc.stdin?.write("q");
			// Give it a moment to flush, then force-kill
			await new Promise<void>((resolve) => {
				const killTimeout = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
					resolve();
				}, 2000);
				proc.on("close", () => {
					clearTimeout(killTimeout);
					resolve();
				});
			});
		}

		state = null;

		if (duration < 1) {
			ctx.ui.setStatus("voice", undefined);
			ctx.ui.notify("Recording too short (< 1s)", "warning");
			try {
				await unlink(file);
			} catch {}
			return;
		}

		ctx.ui.setStatus("voice", "🔄 Transcribing...");

		try {
			const text = await transcribe(file);
			if (text?.trim()) {
				const current = ctx.ui.getEditorText() ?? "";
				const insert = current.length > 0 ? `${current}${text.trim()}` : text.trim();
				ctx.ui.setEditorText(insert);
				const preview = text.trim().length > 60 ? text.trim().slice(0, 60) + "…" : text.trim();
				ctx.ui.notify(`🎤 ${preview}`, "info");
			} else {
				ctx.ui.notify("No speech detected", "warning");
			}
		} catch (err: any) {
			ctx.ui.notify(`Transcription failed: ${err.message}`, "error");
		}

		ctx.ui.setStatus("voice", undefined);

		// Cleanup temp file
		try {
			await unlink(file);
		} catch {}
	}

	function cleanup(ctx: ExtensionContext) {
		if (!state) return;
		clearInterval(state.timer);
		if (!state.process.killed) state.process.kill("SIGKILL");
		try {
			unlink(state.file);
		} catch {}
		state = null;
		ctx.ui.setStatus("voice", undefined);
	}

	// ── transcription ───────────────────────────────────────

	async function transcribe(filePath: string): Promise<string> {
		const audioData = await readFile(filePath);

		// Sanity check — empty or tiny file means no real audio
		if (audioData.length < 1000) {
			return "";
		}

		const backend = getBackend();
		if (backend === "groq") return transcribeGroq(audioData);
		if (backend === "openai") return transcribeOpenAI(audioData);
		throw new Error("No transcription backend configured");
	}

	async function transcribeGroq(audioData: Buffer): Promise<string> {
		const form = new FormData();
		form.append("file", new Blob([audioData], { type: "audio/wav" }), "audio.wav");
		form.append("model", "whisper-large-v3-turbo");
		form.append("language", "en");
		form.append("response_format", "json");

		const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
			method: "POST",
			headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
			body: form,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
		}

		const json = (await res.json()) as { text?: string };
		return json.text ?? "";
	}

	async function transcribeOpenAI(audioData: Buffer): Promise<string> {
		const form = new FormData();
		form.append("file", new Blob([audioData], { type: "audio/wav" }), "audio.wav");
		form.append("model", "whisper-1");
		form.append("language", "en");
		form.append("response_format", "json");

		const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
			body: form,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
		}

		const json = (await res.json()) as { text?: string };
		return json.text ?? "";
	}

	// ── shortcut ────────────────────────────────────────────

	pi.registerShortcut("alt+v", {
		description: "Toggle voice recording",
		handler: async (ctx) => {
			if (state) {
				await stopAndTranscribe(ctx);
			} else {
				await startRecording(ctx);
			}
		},
	});

	// ── command ─────────────────────────────────────────────

	pi.registerCommand("voice", {
		description: "Voice input — /voice [start|stop|status]",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "start") {
				if (!state) await startRecording(ctx);
				else ctx.ui.notify("Already recording", "warning");
			} else if (sub === "stop") {
				if (state) await stopAndTranscribe(ctx);
				else ctx.ui.notify("Not recording", "warning");
			} else {
				// status (default)
				const backend = getBackend();
				const lines = [`🎤 Voice Input`, `  Backend: ${backendLabel(backend)}`, `  Recording: ${state ? `yes (${elapsed()}s)` : "no"}`, `  Shortcut: Alt+V (toggle)`, `  Max duration: ${MAX_RECORDING_SECONDS}s`];
				if (backend === "none") {
					lines.push("", "  ⚠️  Set GROQ_API_KEY (recommended) or OPENAI_API_KEY");
					lines.push("  Get a free key: https://console.groq.com");
				}
				ctx.ui.notify(lines.join("\n"), backend === "none" ? "warning" : "info");
			}
		},
	});

	// ── cleanup ─────────────────────────────────────────────

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanup(ctx);
	});
}
