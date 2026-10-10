import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export type TmuxSocketProbe = (socket: string, env: NodeJS.ProcessEnv) => boolean;

export type TmuxSocketResolution =
	| { status: "RESOLVED"; socket: string; candidates: string[]; tmuxArgs: string[]; tmuxTmpdir?: string }
	| { status: "AMBIGUOUS"; sockets: string[]; candidates: string[] }
	| { status: "UNAVAILABLE"; candidates: string[] };


function socketInDirectory(directory: string, userId: number): string {
	return join(directory, `tmux-${userId}`, "default");
}

export function tmuxSocketCandidates(env: NodeJS.ProcessEnv = process.env, userId = process.getuid?.() ?? 0): string[] {
	const home = env.HOME ?? homedir();
	const candidates = [
		...(env.TMUX_TMPDIR ? [socketInDirectory(env.TMUX_TMPDIR, userId)] : []),
		join(home, ".tmux-sockets", `tmux-${userId}`, "default"),
		socketInDirectory(env.TMPDIR || "/tmp", userId),
	];
	return [...new Set(candidates)];
}

/** Resolve explicit session settings as-is; absent settings require exactly one live candidate. */
export function resolveTmuxSocket(
	env: NodeJS.ProcessEnv = process.env,
	probe: TmuxSocketProbe = (socket, probeEnv) => {
		const result = spawnSync("tmux", ["-S", socket, "list-sessions"], { encoding: "utf8", timeout: 10_000, env: probeEnv });
		return result.status === 0;
	},
): TmuxSocketResolution {
	const uidValue = process.getuid?.() ?? 0;
	if (env.TMUX) {
		const socket = env.TMUX.split(",", 1)[0];
		if (socket) return { status: "RESOLVED", socket, candidates: [socket], tmuxArgs: [] };
	}
	if (env.TMUX_TMPDIR) {
		const socket = socketInDirectory(env.TMUX_TMPDIR, uidValue);
		return { status: "RESOLVED", socket, candidates: [socket], tmuxArgs: [], tmuxTmpdir: env.TMUX_TMPDIR };
	}
	const candidates = tmuxSocketCandidates(env, uidValue);
	const live = candidates.filter((socket) => probe(socket, env));
	if (live.length > 1) return { status: "AMBIGUOUS", sockets: live, candidates };
	if (live.length === 0) return { status: "UNAVAILABLE", candidates };
	const socket = live[0]!;
	return { status: "RESOLVED", socket, candidates, tmuxArgs: ["-S", socket], tmuxTmpdir: dirname(dirname(socket)) };
}

/** Preserve the fleet doctor’s prior preference: explicit TMUX_TMPDIR, then the live managed socket. */
export function tmuxSocketArgs(
	env: NodeJS.ProcessEnv = process.env,
	probe: (args: readonly string[]) => boolean = (args) => {
		const result = spawnSync("tmux", [...args, "list-sessions"], { encoding: "utf8", timeout: 10_000, env });
		return result.status === 0;
	},
): string[] {
	if (env.TMUX_TMPDIR) return [];
	const socket = tmuxSocketCandidates(env)[0]!;
	return existsSync(socket) && probe(["-S", socket]) ? ["-S", socket] : [];
}
