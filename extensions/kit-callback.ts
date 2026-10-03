import { readFileSync } from "node:fs";
import { join } from "node:path";

const CALLBACK_TIMEOUT_MS = 1_500;
const EXCERPT_LIMIT = 200;

interface AgentEndMessage {
	role?: unknown;
	content?: unknown;
}

export interface AgentEndEvent {
	messages: readonly AgentEndMessage[];
	willContinue?: boolean;
}

interface FleetSession {
	session?: unknown;
	coordinatorPane?: unknown;
	coordinatorSession?: unknown;
	workerPanes?: unknown;
}

interface FleetConfig {
	sessions?: unknown;
}

export interface CallbackDeps {
	home?: string;
	pane?: string;
	agent?: string;
	tmuxTmpDir?: string;
	readConfig?: (path: string) => unknown;
	send?: (session: string, pane: string, text: string, tmuxTmpDir: string) => Promise<void> | void;
}

const lastSent = new Map<string, string>();

function messageText(message: AgentEndMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string")).map((part) => part.text).join("");
}

function callbackLine(text: string): string | null {
	for (const line of text.split("\n").reverse()) {
		const trimmed = line.trim();
		if (/^(?:DONE|BLOCKED)\b/.test(trimmed)) return trimmed;
	}
	return null;
}

function idleLine(pane: string, agent: string, text: string): string {
	const excerpt = text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_LIMIT);
	return `IDLE ${pane} ${agent}: ${excerpt}`;
}

function configSessions(config: unknown): FleetSession[] {
	if (!config || typeof config !== "object") return [];
	const sessions = (config as FleetConfig).sessions;
	return Array.isArray(sessions) ? sessions.filter((session): session is FleetSession => Boolean(session && typeof session === "object")) : [];
}

function defaultConfigReader(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function defaultSender(session: string, pane: string, text: string, tmuxTmpDir: string): Promise<void> {
	return new Promise((resolve) => {
		let finished = false;
		try {
			const child = Bun.spawn(["ntm", "send", session, `--panes=${pane}`, text], {
				env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
				stdout: "ignore",
				stderr: "ignore",
			});
			const timer = setTimeout(() => {
				if (!finished) child.kill();
			}, CALLBACK_TIMEOUT_MS);
			void child.exited.then(() => {
				finished = true;
				clearTimeout(timer);
				resolve();
			});
		} catch {
			resolve();
		}
	});
}

export function resetCallbackDedupe(): void {
	lastSent.clear();
}

export async function dispatchAgentCallback(event: AgentEndEvent, deps: CallbackDeps = {}): Promise<boolean> {
	if (event.willContinue) return false;
	try {
		const home = deps.home ?? process.env.HOME ?? "";
		const pane = deps.pane ?? process.env.TMUX_PANE ?? "";
		if (!home || !pane) return false;
		const configPath = join(home, ".config", "omp-kit", "fleet-watch.json");
		const config = (deps.readConfig ?? defaultConfigReader)(configPath);
		const session = configSessions(config).find((candidate) => Array.isArray(candidate.workerPanes) && candidate.workerPanes.includes(pane));
		if (!session || typeof session.coordinatorPane !== "string" || typeof session.coordinatorSession !== "string" || session.coordinatorPane === pane) return false;
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		const assistantText = assistant ? messageText(assistant) : "";
		const lastText = messageText(event.messages[event.messages.length - 1] ?? {});
		const text = callbackLine(assistantText) ?? idleLine(pane, deps.agent ?? process.env.AGENT_NAME ?? process.env.OMP_AGENT_NAME ?? "unknown", lastText);
		const key = `${pane}->${session.coordinatorSession}:${session.coordinatorPane}`;
		if (lastSent.get(key) === text) return false;
		lastSent.set(key, text);
		const tmuxTmpDir = deps.tmuxTmpDir ?? process.env.TMUX_TMPDIR ?? join(home, ".tmux-sockets");
		await (deps.send ?? defaultSender)(session.coordinatorSession, session.coordinatorPane, text, tmuxTmpDir);
		return true;
	} catch {
		return false;
	}
}

interface ExtensionApi {
	on(event: "agent_end", handler: (event: AgentEndEvent) => void | Promise<void>): void;
	setLabel?(label: string): void;
}

export default function kitCallback(pi: ExtensionApi): void {
	try {
		pi.setLabel?.("kit-callback");
		pi.on("agent_end", (event) => { void dispatchAgentCallback(event); });
	} catch {
		// Callback reporting must never affect the agent session.
	}
}
