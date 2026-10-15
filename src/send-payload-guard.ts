// send-payload-guard.ts — SENDGATE1 (ompkit-send-payload-gate-6hk3).
//
// A destructive command delivered as send text to a shell pane bypasses every
// command gate, because the gate only sees the send. On 2026-10-09
// `tmux kill-server` pasted into a human shell pane via `ntm send` killed
// every tmux session on the machine. This module refuses such payloads at
// send time when the target pane runs a shell; the same text addressed to an
// agent pane (where it is prose) still passes.
//
// Patterns stay linear: anchored command words, exclusive character classes,
// no nested quantifiers; the payload is capped before matching (JS has no
// regex timeout).

/** Shells whose input box executes text. Compared against pane_current_command. */
const SHELL_COMMANDS: Record<string, true> = { sh: true, bash: true, dash: true, zsh: true, fish: true, ksh: true, tcsh: true };

/** Upper bound on scanned payload bytes; sends are short, this bounds work. */
export const MAX_PAYLOAD_SCAN = 65536;

export function paneRunsShell(paneCurrentCommand: string): boolean {
	const base = paneCurrentCommand.trim().split("/").pop() ?? "";
	const name = base.startsWith("-") ? base.slice(1) : base;
	return SHELL_COMMANDS[name.toLowerCase()] === true;
}
// Command-word anchor: wire start, a shell separator, or sudo. Leading text
// that is not a separator keeps prose quiet ('never pkill ...' passes).
const LEAD = String.raw`(?:^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*|[;&|()\n]\s*|\bsudo\s+)`;

// Global flags with values (-S socket, -L name, -f file, ...) are skipped as
// pairs; bare flags singly. Documented limit: a socket literally named
// kill-server (`tmux -S kill-server`) reads as flag value, not the command.
const TMUX_KILL_SERVER = new RegExp(LEAD + String.raw`tmux(?![\w-])(?:\s+-[SLTFCf]\s+\S+|\s+--[A-Za-z][\w-]*=\S+|\s+-[A-Za-z]+)*\s+kill-server(?![\w-])`);
const PATTERN_KILL = new RegExp(LEAD + String.raw`(?:pkill|killall)(?![\w-])`);
const RM_WORD = new RegExp(LEAD + String.raw`rm(?![\w-])`);

export type PayloadRuleId =
	| "send-payload-tmux-kill-server"
	| "send-payload-pattern-kill"
	| "send-payload-rmrf-critical";

function rmRfCritical(segment: string): boolean {
	// segment starts just after the anchored `rm` word: flags then targets,
	// cut at the next shell separator by the caller.
	const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
	const flagLetters: string[] = [];
	let i = 0;
	for (; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (/^-[A-Za-z]+$/.test(t) && !t.startsWith("--")) {
			flagLetters.push(t.slice(1));
			continue;
		}
		break;
	}
	const flags = flagLetters.join("");
	return hasRAndF(flags) && tokens.slice(i).some(isCriticalTarget);
}

function hasRAndF(flags: string): boolean {
	const lower = flags.toLowerCase();
	return lower.includes("r") && lower.includes("f");
}

function isCriticalTarget(token: string): boolean {
	const t = token.endsWith("/") && token.length > 1 ? token.slice(0, -1) : token;
	return t === "~" || t === "~/*" || t === "/" || t === "/*" || t === "$HOME" || t === "$HOME/*";
}

function firstMatchEnd(source: string, pattern: RegExp): number | null {
	pattern.lastIndex = 0;
	const m = pattern.exec(source);
	return m ? m.index + m[0].length : null;
}

/**
 * Refuse a payload that would be refused if run directly in a shell.
 * Returns the naming rule id, or null when the payload passes.
 */
export function refuseShellPayload(message: string): { rule: PayloadRuleId } | null {
	const text = message.length > MAX_PAYLOAD_SCAN ? message.slice(0, MAX_PAYLOAD_SCAN) : message;
	if (TMUX_KILL_SERVER.test(text)) return { rule: "send-payload-tmux-kill-server" };
	if (PATTERN_KILL.test(text)) return { rule: "send-payload-pattern-kill" };
	const rmAt = firstMatchEnd(text, RM_WORD);
	if (rmAt !== null) {
		const segment = text.slice(rmAt).split(/[;&|()\n]/)[0] ?? "";
		if (rmRfCritical(segment)) return { rule: "send-payload-rmrf-critical" };
	}
	return null;
}
