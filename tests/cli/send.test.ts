import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BEAD_ID, dispatchBeads, fleetBeadPrefixes, proveSend, trackerPrefix, type SendExec } from "../../src/send.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");
const testEnv = { ...process.env, TMUX_TMPDIR: join(scratchRoot, "managed") };
delete testEnv.TMUX;

const socketFixtureRoot = join("var", "agent-tmp", "tw9q" + process.pid);
mkdirSync(socketFixtureRoot, { recursive: true });
writeFileSync(join(socketFixtureRoot, ".owner"), `pid=${process.pid} label=tw9q repo=${repoRoot} created=${new Date().toISOString()}\n`);

const noWait = async (_ms: number) => {};

/** Fake pane: echoes the last sent text into captures once enough polls have passed. */
function echoPane(capturesBeforeEcho: number, sendRc: number[] = []): { exec: SendExec; taken: { sends: number; captures: number; captureArgv: string[][] } } {
	const taken = { sends: 0, captures: 0, captureArgv: [] as string[][] };
	let lastText = "";
	return {
		taken,
		exec: {
			run(argv: string[], _childEnv?: NodeJS.ProcessEnv) {
				if (argv[0] === "ntm") {
					taken.sends++;
					const code = sendRc.length ? sendRc.shift()! : 0;
					if (code === 0) lastText = argv[argv.length - 1] ?? "";
					return { code, out: code === 0 ? "sent" : "ntm failed" };
				}
				taken.captures++;
				taken.captureArgv.push(argv);
				return { code: 0, out: taken.captures >= capturesBeforeEcho ? lastText : "nothing yet" };
			},
		},
	};
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("SEND1: delivered marker returns OK with the marker seen", async () => {
	const { exec, taken } = echoPane(1);
	const seen = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.sends).toBe(1);
	expect(seen.status).toBe("OK");
	expect(seen.drop_path).toBeNull();
	expect(seen.marker.length).toBeGreaterThan(0);
});

test("SEND1 planted: missing pane returns NOT_DELIVERED and writes the drop file", async () => {
	const { exec, taken } = echoPane(Number.MAX_SAFE_INTEGER, [1, 1]);
	const dir = dropDir();
	const missed = await proveSend({ session: "gone", pane: "%9", message: "hello", dropDir: dir, exec, env: testEnv, pollMs: 1, deadlineMs: 20, wait: noWait });
	expect(taken.sends).toBe(2);
	expect(missed.status).toBe("NOT_DELIVERED");
	expect(missed.drop_path ?? "").toContain(dir);
	expect(existsSync(missed.drop_path!)).toBe(true);
	expect(readFileSync(missed.drop_path!, "utf8")).toContain("hello");
	expect(readFileSync(missed.drop_path!, "utf8")).toContain(missed.marker);
});

test("SEND1: late marker within the deadline still returns OK without resending", async () => {
	const { exec, taken } = echoPane(3);
	const late = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 5000, wait: noWait });
	expect(late.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(taken.captures).toBe(3);
});

test("SEND1 capture uses the bare pane id with scrollback history", async () => {
	const { exec, taken } = echoPane(1);
	await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.captureArgv.length).toBeGreaterThan(0);
	for (const argv of taken.captureArgv) {
		expect(argv).toEqual(["tmux", "capture-pane", "-p", "-S", "-200", "-t", "%1"]);
	}
});

// Explicit empty prefix set: the id-shape fallback, independent of this machine's trackers.
const send = (message: string, noBeadReason?: string, knownPrefixes: ReadonlySet<string> = new Set()) => {
	const pane = echoPane(1);
	return proveSend({ session: "s", pane: "%1", message, noBeadReason, knownPrefixes, dropDir: dropDir(), exec: pane.exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait })
		.then((result) => ({ result, taken: pane.taken }));
};

test("BEAD1: a D dispatch citing no bead is refused with zero tmux submission", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: mail project /Users/josh/Developer/localbench, thread 48536; prompt w.md@abc1234; ack first");
	expect(result.status).toBe("BEAD_REQUIRED");
	expect(taken.sends).toBe(0);
	expect(taken.captures).toBe(0);
});

test("BEAD1 planted: the same dispatch citing a bead proceeds and records it", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: bead ompkit-xa5s; mail thread 48536; ack first");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.bead_ids).toEqual(["ompkit-xa5s"]);
	expect(result.no_bead_reason).toBeNull();
});

test("BEAD2: a queue: message without a bead is refused; with one it proceeds", async () => {
	const bare = await send("next up\nqueue: send-guard, doctor-rows");
	expect(bare.result.status).toBe("BEAD_REQUIRED");
	expect(bare.taken.sends).toBe(0);
	const cited = await send("next up for (core8-h9l.31).\nqueue: send-guard, doctor-rows");
	expect(cited.result.status).toBe("OK");
	expect(cited.result.bead_ids).toEqual(["core8-h9l.31"]);
});

test("BEAD3: DONE/BLOCKED returns, R: replies and notes are not dispatches", async () => {
	for (const message of [
		"DONE AM48600 flywheel-guard abc1234 R:AM48601; NEXT doctor-rows — omp-test:0.1",
		"BLOCKED AM48600 flywheel-guard reservation-held R:AM48602",
		"R: AM48600 looks good, ship it",
		"Did you mean D or E? the queue is empty",
	]) {
		const { result, taken } = await send(message);
		expect(result.status).toBe("OK");
		expect(taken.sends).toBe(1);
		expect(result.no_bead_reason).toBeNull();
	}
});

test("BEAD4: --no-bead-reason passes a bead-less dispatch and records the reason", async () => {
	const { result, taken } = await send("D AM48600 machine-reboot: restart the fleet", "  ops recovery, no tracker item  ");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.no_bead_reason).toBe("ops recovery, no tracker item");
	const blank = await send("D AM48600 machine-reboot: restart the fleet", "   ");
	expect(blank.result.status).toBe("BEAD_REQUIRED");
	expect(blank.taken.sends).toBe(0);
});

test("BEAD5: URLs, paths and the D-line slug are not bead ids", () => {
	const urls = dispatchBeads("D AM1 send-guard: see https://github.com/x/omp-kit-companion/pull/12 and src/kit-flywheel-guard.ts and ~/Developer/omp-kit/docs/core8-plan.md");
	expect(urls).toEqual({ dispatch: true, bead_ids: [] });
	expect(dispatchBeads("D AM1 cfs-9yrif: go").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: bead=ompkit-xa5s").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: cfs-9yrif, ompkit-rc-epic-land-fix-release-dogfood-rz5.125;").bead_ids).toEqual(["cfs-9yrif", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]);
});

test("BEAD5 regex: real fleet ids match, near-misses do not, long near-miss is linear", () => {
	for (const id of ["ompkit-xa5s", "cfs-9yrif", "core8-h9l.31", "beads_rust-abc", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]) expect(BEAD_ID.test(id)).toBe(true);
	for (const bad of ["ompkit", "-xa5s", "Ompkit-xa5s", "ompkit-", "ompkit-xa5s.", "ompkit-xa5s.a", "a/b-c", "https://a-b", "ompkit--x"]) expect(BEAD_ID.test(bad)).toBe(false);
	const nearMiss = "a" + "-b".repeat(50_000) + ".1".repeat(50_000) + "!";
	const started = performance.now();
	expect(BEAD_ID.test(nearMiss)).toBe(false);
	expect(performance.now() - started).toBeLessThan(200);
});

test("BEAD6: with fleet tracker prefixes, hyphenated words are not bead ids; real ids still are", async () => {
	const fleet = new Set(["ompkit", "cfs", "jev", "kit"]);
	// Field case 2026-10-10: this passed the gate on 0.2.16 with bead_ids [follow-up, one-line, diff-check0].
	const words = await send("D omp-test:0.1 %999 fix the follow-up in the one-line diff-check0 helper", undefined, fleet);
	expect(words.result.status).toBe("BEAD_REQUIRED");
	expect(words.taken.sends).toBe(0);
	expect(words.result.detail).toContain("cfs, jev, kit, ompkit");
	for (const [message, id] of [
		["D omp-test:0.1 %999 ompkit-xa5s fix", "ompkit-xa5s"],
		["D jev:0.1 %18 jev-dadu fix", "jev-dadu"],
		["D cfsios:0.1 %47 cfs-twenty-app-portfolio-hgub5.87 read-only first", "cfs-twenty-app-portfolio-hgub5.87"],
	] as const) {
		const cited = await send(message, undefined, fleet);
		expect(cited.result.status).toBe("OK");
		expect(cited.result.bead_ids).toEqual([id]);
	}
});

test("BEAD6 discovery: prefixes come from the env list, fleet-watch repos and the nearest tracker", () => {
	const root = join(scratch, "prefixes-" + Math.random().toString(36).slice(2));
	const configured = join(root, "configured", ".beads");
	const derived = join(root, "derived", ".beads");
	const nested = join(root, "nested", ".beads");
	for (const dir of [configured, derived, nested, join(root, "nested", "src", "deep"), join(root, "home", ".config", "omp-kit")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(configured, "config.yaml"), "issue_prefix: uds\n");
	writeFileSync(join(derived, "config.yaml"), "# issue_prefix: ignored\n");
	writeFileSync(join(derived, "issues.jsonl"), '{"id":"kit-p5wn.1","title":"x"}\n');
	writeFileSync(join(nested, "issues.jsonl"), '{"id":"cfs-9yrif","title":"x"}\n');
	writeFileSync(join(root, "home", ".config", "omp-kit", "fleet-watch.json"),
		JSON.stringify({ sessions: [{ repo: join(root, "configured") }, { repo: join(root, "derived") }, { repo: join(root, "missing") }] }));
	const env = { HOME: join(root, "home"), OMP_KIT_BEAD_PREFIXES: "core8, Bad-Name ,beads_rust" };
	expect([...fleetBeadPrefixes(env, [join(root, "nested", "src", "deep")])].sort()).toEqual(["beads_rust", "cfs", "core8", "kit", "uds"]);
	expect(trackerPrefix(derived)).toBe("kit");
	expect(trackerPrefix(join(root, "missing", ".beads"))).toBeNull();
	expect(fleetBeadPrefixes({ HOME: join(root, "nowhere") }, []).size).toBe(0);
});

const tmuxUid = typeof process.getuid === "function" ? process.getuid() : 0;
function livePrivateServer(socket: string, home: string, tmp: string, name: string) {
	mkdirSync(dirname(socket), { recursive: true });
	const env = { ...process.env, HOME: home, TMPDIR: tmp };
	delete env.TMUX;
	delete env.TMUX_TMPDIR;
	const start = spawnSync("tmux", ["-S", socket, "new-session", "-d", "-s", name, "/bin/sh", "-i"], { encoding: "utf8", env });
	if (start.status !== 0) throw new Error(`private tmux server failed to start: ${start.stderr}`);
	const paneResult = spawnSync("tmux", ["-S", socket, "display-message", "-p", "-t", name, "#{pane_id}"], { encoding: "utf8", env });
	if (paneResult.status !== 0) throw new Error(`private tmux pane lookup failed: ${paneResult.stderr}`);
	return { socket, pane: paneResult.stdout.trim(), env };
}

function privateServerExec(pane: string): SendExec & { ntmEnvs: NodeJS.ProcessEnv[]; calls: string[][] } {
	const ntmEnvs: NodeJS.ProcessEnv[] = [];
	const calls: string[][] = [];
	return {
		ntmEnvs,
		calls,
		run(argv, childEnv) {
			const env = childEnv ?? process.env;
			calls.push(argv);
			if (argv[0] === "ntm") {
				ntmEnvs.push(env);
				const text = argv.at(-1) ?? "";
				const marker = /\[(kit-send-[a-f0-9]+)\]$/.exec(text)?.[1];
				if (!marker) return { code: 2, out: "marker missing" };
				const socketArgs = env.TMUX_TMPDIR ? ["-S", join(env.TMUX_TMPDIR, `tmux-${tmuxUid}`, "default")] : [];
				const sent = spawnSync("tmux", [...socketArgs, "send-keys", "-t", pane, `echo ${marker}`, "Enter"], { encoding: "utf8", env });
				return { code: sent.status ?? 1, out: String(sent.stdout ?? sent.stderr ?? "") };
			}
			const args = argv[0] === "tmux" && env.TMUX_TMPDIR && argv[1] !== "-S"
				? ["-S", join(env.TMUX_TMPDIR, `tmux-${tmuxUid}`, "default"), ...argv.slice(1)]
				: argv.slice(1);
			const result = spawnSync(argv[0]!, args, { encoding: "utf8", env });
			return { code: result.status ?? 1, out: String(result.stdout ?? "") };
		},
	};
}

function capturePrivate(socket: string, pane: string): string {
	const result = spawnSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", pane], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`private tmux capture failed: ${result.stderr}`);
	return result.stdout;
}

test("TMUX1: without socket environment, send selects the sole live private server and reports its socket", async () => {
	const home = socketFixtureRoot;
	const tmp = join(socketFixtureRoot, "tmp");
	const socket = join(home, ".tmux-sockets", `tmux-${tmuxUid}`, "default");
	const server = livePrivateServer(socket, home, tmp, "one");
	try {
		const exec = privateServerExec(server.pane);
		const result = await proveSend({ session: "one", pane: server.pane, message: "hello", dropDir: dropDir(), exec, env: server.env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("OK");
		expect(result.tmux_socket).toBe(socket);
		expect(exec.ntmEnvs).toHaveLength(1);
		expect(exec.ntmEnvs[0]!.TMUX_TMPDIR).toBe(join(home, ".tmux-sockets"));
		expect(exec.calls.some(argv => argv[0] === "tmux" && argv[1] === "-S" && argv[2] === socket)).toBe(true);
	} finally {
		spawnSync("tmux", ["-S", socket, "kill-server"], { encoding: "utf8" });
	}
});

test("TMUX1 planted: two live private servers refuse with both sockets and do not change either pane", async () => {
	const home = socketFixtureRoot;
	const tmp = join(socketFixtureRoot, "tmp");
	const homeSocket = join(home, ".tmux-sockets", `tmux-${tmuxUid}`, "default");
	const tmpSocket = join(tmp, `tmux-${tmuxUid}`, "default");
	const first = livePrivateServer(homeSocket, home, tmp, "first");
	const second = livePrivateServer(tmpSocket, home, tmp, "second");
	try {
		const before = capturePrivate(homeSocket, first.pane);
		const exec = privateServerExec(first.pane);
		const result = await proveSend({ session: "first", pane: first.pane, message: "hello", dropDir: dropDir(), exec, env: first.env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("TMUX_AMBIGUOUS");
		expect(result.detail).toContain(homeSocket);
		expect(result.detail).toContain(tmpSocket);
		expect(exec.ntmEnvs).toHaveLength(0);
		expect(capturePrivate(homeSocket, first.pane)).toBe(before);
	} finally {
		spawnSync("tmux", ["-S", homeSocket, "kill-server"], { encoding: "utf8" });
		spawnSync("tmux", ["-S", tmpSocket, "kill-server"], { encoding: "utf8" });
	}
});

test("TMUX1 unchanged: explicit TMUX_TMPDIR is honored and its socket is reported", async () => {
	const home = socketFixtureRoot;
	const socketRoot = join(socketFixtureRoot, "custom");
	const socket = join(socketRoot, `tmux-${tmuxUid}`, "default");
	const server = livePrivateServer(socket, home, socketRoot, "set");
	try {
		const env = { ...server.env, TMUX_TMPDIR: socketRoot };
		const exec = privateServerExec(server.pane);
		const result = await proveSend({ session: "set", pane: server.pane, message: "hello", dropDir: dropDir(), exec, env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("OK");
		expect(result.tmux_socket).toBe(socket);
		expect(exec.ntmEnvs[0]!.TMUX_TMPDIR).toBe(socketRoot);
		expect(exec.calls.some(argv => argv[0] === "tmux" && argv[1] === "-S")).toBe(false);
	} finally {
		spawnSync("tmux", ["-S", socket, "kill-server"], { encoding: "utf8" });
	}
});
