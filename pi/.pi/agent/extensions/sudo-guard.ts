/**
 * Sudo Guard Extension
 *
 * Monitors Write operations to /tmp/ for scripts intended to be run with sudo.
 * When detected, appends a security review to the tool result so the agent
 * sees the concerns before telling the user to run the script.
 *
 * Checks for:
 *   - Destructive filesystem operations (rm -rf, format, dd, mkfs)
 *   - Permission/ownership changes (chmod 777, chown root)
 *   - Sensitive file modifications (/etc/passwd, /etc/shadow, sudoers, ssh keys)
 *   - Network exfiltration (curl POST, wget piped to shell, nc listeners)
 *   - Credential exposure (hardcoded passwords, tokens, keys in scripts)
 *   - Package manager abuse (adding untrusted repos, piping to bash)
 *   - Systemd/service manipulation
 *   - Kernel module loading
 *   - Cron/at job injection
 *   - Unbounded recursive operations
 *
 * Usage: pi -e ./sudo-guard.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface SecurityConcern {
	severity: "critical" | "high" | "medium" | "low";
	category: string;
	description: string;
	line?: number;
	match?: string;
}

interface SecurityRule {
	pattern: RegExp;
	severity: SecurityConcern["severity"];
	category: string;
	description: string;
}

const SECURITY_RULES: SecurityRule[] = [
	// === CRITICAL: Data destruction ===
	{
		pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/|\$HOME)\b/,
		severity: "critical",
		category: "Destructive Operation",
		description: "Recursive deletion targeting root or home directory",
	},
	{
		pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?!tmp\b)/,
		severity: "critical",
		category: "Destructive Operation",
		description: "Force-recursive deletion outside /tmp",
	},
	{
		pattern: /\bdd\b.*\bof=\/dev\/[sh]d[a-z]/,
		severity: "critical",
		category: "Destructive Operation",
		description: "Direct disk write with dd — can destroy partition tables",
	},
	{
		pattern: /\bmkfs\b/,
		severity: "critical",
		category: "Destructive Operation",
		description: "Filesystem creation — will destroy existing data on target device",
	},
	{
		pattern: /\bformat\b.*\/dev\//,
		severity: "critical",
		category: "Destructive Operation",
		description: "Device formatting detected",
	},

	// === CRITICAL: Credential/auth tampering ===
	{
		pattern: /\/etc\/shadow/,
		severity: "critical",
		category: "Credential Tampering",
		description: "Modifying /etc/shadow — contains password hashes",
	},
	{
		pattern: /\/etc\/passwd/,
		severity: "high",
		category: "Auth Modification",
		description: "Modifying /etc/passwd — user account database",
	},
	{
		pattern: /\/etc\/sudoers/,
		severity: "critical",
		category: "Privilege Escalation",
		description: "Modifying sudoers — controls sudo access rights",
	},
	{
		pattern: /visudo|NOPASSWD/,
		severity: "critical",
		category: "Privilege Escalation",
		description: "Sudoers modification or NOPASSWD grant",
	},
	{
		pattern: /usermod\s.*-[aG].*(?:sudo|wheel|root)/,
		severity: "critical",
		category: "Privilege Escalation",
		description: "Adding user to privileged group (sudo/wheel/root)",
	},

	// === HIGH: Sensitive file access ===
	{
		pattern: /\.ssh\/(authorized_keys|id_rsa|id_ed25519)/,
		severity: "high",
		category: "SSH Key Manipulation",
		description: "Touching SSH keys or authorized_keys — could grant/revoke remote access",
	},
	{
		pattern: /\/etc\/ssh\/sshd_config/,
		severity: "high",
		category: "SSH Configuration",
		description: "Modifying SSH daemon config — could weaken remote access security",
	},

	// === HIGH: Network exfiltration ===
	{
		pattern: /\bcurl\b.*(-X\s*POST|--data|--upload|-d\s)/,
		severity: "high",
		category: "Data Exfiltration Risk",
		description: "curl POST/upload — could send data to external server",
	},
	{
		pattern: /\bwget\b.*-O\s*-\s*\|.*\b(bash|sh|zsh)\b/,
		severity: "critical",
		category: "Remote Code Execution",
		description: "Piping remote URL to shell — classic supply-chain attack vector",
	},
	{
		pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)\b/,
		severity: "critical",
		category: "Remote Code Execution",
		description: "Piping curl output to shell — untrusted code execution",
	},
	{
		pattern: /\bnc\b.*-l.*-p/,
		severity: "high",
		category: "Network Listener",
		description: "Netcat listener — opens a port, potential backdoor",
	},
	{
		pattern: /\bsocat\b.*TCP-LISTEN/i,
		severity: "high",
		category: "Network Listener",
		description: "Socat TCP listener — opens a network service",
	},

	// === HIGH: Permission abuse ===
	{
		pattern: /\bchmod\s+[0-7]*7[0-7]{2}\b/,
		severity: "high",
		category: "Excessive Permissions",
		description: "Setting world-writable permissions",
	},
	{
		pattern: /\bchmod\s+[0-7]*[46]755\b.*\/(?!tmp)/,
		severity: "medium",
		category: "SUID/SGID Bit",
		description: "Setting SUID/SGID bit — could allow privilege escalation",
	},
	{
		pattern: /\bchmod\s+[47][0-7]{3}\b/,
		severity: "high",
		category: "SUID/SGID Bit",
		description: "Setting SUID/SGID bit — allows execution as file owner",
	},
	{
		pattern: /\bchown\s+root\b/,
		severity: "medium",
		category: "Ownership Change",
		description: "Changing file ownership to root",
	},

	// === HIGH: System service manipulation ===
	{
		pattern: /\bsystemctl\s+(enable|start|restart|mask)\b/,
		severity: "medium",
		category: "Service Management",
		description: "Enabling/starting/masking system services",
	},
	{
		pattern: /\/etc\/systemd\/system\//,
		severity: "high",
		category: "Service Installation",
		description: "Installing system-level systemd units — persistent service",
	},

	// === HIGH: Kernel / boot ===
	{
		pattern: /\bmodprobe\b|\binsmod\b|\brmmod\b/,
		severity: "high",
		category: "Kernel Module",
		description: "Loading/unloading kernel modules — deep system modification",
	},
	{
		pattern: /\/boot\//,
		severity: "high",
		category: "Boot Modification",
		description: "Modifying boot directory — could render system unbootable",
	},
	{
		pattern: /\bgrub\b.*install|update-grub/,
		severity: "high",
		category: "Bootloader",
		description: "Bootloader modification",
	},

	// === MEDIUM: Package management risks ===
	{
		pattern: /\b(apt|dnf|yum|pacman)\b.*add.*repo/i,
		severity: "medium",
		category: "Repository Addition",
		description: "Adding package repository — introduces new trust source",
	},
	{
		pattern: /\bpacman\s+-S\s/,
		severity: "low",
		category: "Package Installation",
		description: "Installing packages via pacman",
	},
	{
		pattern: /\bapt\s+(install|remove|purge)\b/,
		severity: "low",
		category: "Package Management",
		description: "Installing/removing packages via apt",
	},

	// === MEDIUM: Cron / scheduled tasks ===
	{
		pattern: /\bcrontab\b/,
		severity: "medium",
		category: "Scheduled Task",
		description: "Modifying crontab — persistent scheduled execution",
	},
	{
		pattern: /\/etc\/cron\./,
		severity: "medium",
		category: "Scheduled Task",
		description: "Modifying system cron directories",
	},

	// === MEDIUM: Firewall / network config ===
	{
		pattern: /\b(iptables|nftables|ufw|firewalld)\b/,
		severity: "medium",
		category: "Firewall Modification",
		description: "Modifying firewall rules — could expose or block network services",
	},
	{
		pattern: /\/etc\/resolv\.conf/,
		severity: "medium",
		category: "DNS Configuration",
		description: "Modifying DNS resolver — could redirect traffic",
	},
	{
		pattern: /\/etc\/hosts/,
		severity: "medium",
		category: "Host Resolution",
		description: "Modifying /etc/hosts — could redirect traffic",
	},

	// === MEDIUM: Credential exposure ===
	{
		pattern: /\b(password|passwd|secret|token|api_key)\s*=\s*["'][^"']+["']/i,
		severity: "medium",
		category: "Hardcoded Credential",
		description: "Possible hardcoded credential in script",
	},

	// === LOW: General awareness ===
	{
		pattern: /\beval\b/,
		severity: "low",
		category: "Dynamic Execution",
		description: "eval usage — executes dynamic code, harder to audit",
	},
	{
		pattern: /\bsource\b.*<\(.*curl/,
		severity: "critical",
		category: "Remote Code Execution",
		description: "Sourcing remote content via process substitution",
	},
];

function analyzeScript(content: string): SecurityConcern[] {
	const concerns: SecurityConcern[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comments
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;

		for (const rule of SECURITY_RULES) {
			const match = line.match(rule.pattern);
			if (match) {
				// Avoid duplicate concerns for same category on same line
				const isDupe = concerns.some(
					(c) => c.category === rule.category && c.line === i + 1,
				);
				if (!isDupe) {
					concerns.push({
						severity: rule.severity,
						category: rule.category,
						description: rule.description,
						line: i + 1,
						match: match[0].trim().slice(0, 60),
					});
				}
			}
		}
	}

	// Sort by severity
	const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
	concerns.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

	return concerns;
}

function formatConcerns(concerns: SecurityConcern[], filePath: string): string {
	const severityIcon: Record<string, string> = {
		critical: "🔴",
		high: "🟠",
		medium: "🟡",
		low: "🔵",
	};

	const critCount = concerns.filter((c) => c.severity === "critical").length;
	const highCount = concerns.filter((c) => c.severity === "high").length;
	const medCount = concerns.filter((c) => c.severity === "medium").length;
	const lowCount = concerns.filter((c) => c.severity === "low").length;

	let header = `\n\n⚠️  SUDO GUARD — Security Review for ${filePath}\n`;
	header += `${"─".repeat(60)}\n`;

	const counts: string[] = [];
	if (critCount) counts.push(`${critCount} critical`);
	if (highCount) counts.push(`${highCount} high`);
	if (medCount) counts.push(`${medCount} medium`);
	if (lowCount) counts.push(`${lowCount} low`);
	header += `Found ${concerns.length} concern${concerns.length !== 1 ? "s" : ""}: ${counts.join(", ")}\n\n`;

	let body = "";
	for (const c of concerns) {
		body += `${severityIcon[c.severity]} [${c.severity.toUpperCase()}] ${c.category}`;
		if (c.line) body += ` (line ${c.line})`;
		body += `\n   ${c.description}`;
		if (c.match) body += `\n   Match: \`${c.match}\``;
		body += "\n\n";
	}

	let footer = `${"─".repeat(60)}\n`;
	if (critCount > 0) {
		footer += "🚨 CRITICAL issues found. You MUST warn the user about these risks\n";
		footer += "   before suggesting they run this script with sudo.\n";
	} else if (highCount > 0) {
		footer += "⚠️  HIGH severity issues found. Explain these risks to the user\n";
		footer += "   when presenting the script.\n";
	} else {
		footer += "ℹ️  Minor concerns only. Mention them briefly when presenting the script.\n";
	}

	return header + body + footer;
}

function isScript(filePath: string): boolean {
	const scriptExtensions = [".sh", ".bash", ".zsh", ".fish", ".py", ".pl", ".rb"];
	return scriptExtensions.some((ext) => filePath.endsWith(ext)) || filePath.includes("/tmp/");
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, _ctx) => {
		// Only intercept write operations
		if (event.toolName !== "write") return undefined;

		const input = event.input as { path?: string; content?: string };
		const filePath = input.path ?? "";
		const content = input.content ?? "";

		// Only check scripts written to /tmp/
		if (!filePath.startsWith("/tmp/") && !filePath.startsWith("/tmp")) return undefined;
		if (!isScript(filePath)) return undefined;

		// Skip trivially small files (< 10 chars probably not a real script)
		if (content.length < 10) return undefined;

		const concerns = analyzeScript(content);
		if (concerns.length === 0) return undefined;

		// Append the security review to the tool result content
		const review = formatConcerns(concerns, filePath);
		const existingContent = Array.isArray(event.content) ? event.content : [];

		// Find existing text content and append, or add new text block
		const newContent = [...existingContent];
		const textBlock = newContent.find(
			(c: any) => c.type === "text",
		) as { type: string; text: string } | undefined;

		if (textBlock) {
			textBlock.text += review;
		} else {
			newContent.push({ type: "text", text: review });
		}

		return { content: newContent };
	});
}
