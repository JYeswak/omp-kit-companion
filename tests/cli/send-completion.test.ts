import { expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { composerHasText, markerInComposer, proveSend, type SendExec } from "../../src/send.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-completion-" + process.pid + "."));
const testEnv = { ...process.env, TMUX_TMPDIR: join(scratchRoot, "managed") };
delete testEnv.TMUX;
const SPIN = "⠋";

function composer(busy: boolean, body: string | null): string {
	const lines = ["history line one", "history line two", "╭──────────────────", body === null ? "❯" : `❯ ${body}`];
	if (busy) lines.push(`${SPIN} thinking`);
	return lines.join("\n");
}

function scripted(captures: string[]): { exec: SendExec; taken: { sends: number; enters: number } } {
	const taken = { sends: 0, enters: 0 };
	let marker = "[MARKER]";
	return {
		taken,
		exec: {
			run(argv: string[]) {
				if (argv[0] === "ntm") {
					taken.sends++;
					const found = /\[kit-send-[0-9a-f]+\]/.exec(argv[argv.length - 1] ?? "");
					if (found) marker = found[0];
					return { code: 0, out: "sent" };
				}
				if (argv.includes("send-keys")) { taken.enters++; return { code: 0, out: "" }; }
				const next = captures.length > 1 ? captures.shift()! : captures[0]!;
				return { code: 0, out: next.replaceAll("[MARKER]", marker) };
			},
		},
	};
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

const tick = async (ms: number) => { vi.advanceTimersByTime(ms); };
const prefixes = new Set(["t"]);

test("composer helpers: marker match, bare prompt empty, foreign text detected", () => {
	const withMarker = ["h", "╭──", "❯ hello [kit-send-m1]"].join("\n");
	const bare = ["h", "╭──", "❯"].join("\n");
	const foreign = ["h", "╭──", "❯ someone else typed"].join("\n");
	expect(markerInComposer(withMarker, "kit-send-m1")).toBe(true);
	expect(markerInComposer(bare, "kit-send-m1")).toBe(false);
	expect(composerHasText(withMarker)).toBe(true);
	expect(composerHasText(bare)).toBe(false);
	expect(composerHasText(foreign)).toBe(true);
	expect(composerHasText("no composer here")).toBe(false);
});

test("planted: busy then idle completes with one Enter and marker gone", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const pane = scripted([
			composer(false, null),
			...Array.from({ length: 20 }, () => composer(true, "hello [MARKER]")),
			composer(false, "hello [MARKER]"),
			composer(false, null),
		]);
		const result = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dir,
			exec: pane.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, untilDeliveredMs: 5000,
			knownPrefixes: new Set() });
		expect(pane.taken.enters).toBe(1);
		expect(result.status).toBe("DELIVERED");
		expect(readdirSync(dir)).toHaveLength(0);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: foreign text in an idle composer never gets Enter", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const pane = scripted([
			composer(false, null),
			...Array.from({ length: 20 }, () => composer(true, "hello [MARKER]")),
			["h", "╭──", "❯ foreign hands typing"].join("\n"),
		]);
		const result = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dir,
			exec: pane.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, untilDeliveredMs: 5000,
			knownPrefixes: new Set() });
		expect(pane.taken.enters).toBe(0);
		expect(result.status).toBe("UNDELIVERED");
		expect(readdirSync(dir)).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a pane that never idles reports UNDELIVERED with no keys sent", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const pane = scripted([composer(false, null), composer(true, "hello [MARKER]")]);
		const result = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dir,
			exec: pane.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, untilDeliveredMs: 60,
			knownPrefixes: new Set() });
		expect(pane.taken.enters).toBe(0);
		expect(result.status).toBe("UNDELIVERED");
	} finally {
		vi.useRealTimers();
	}
});

test("two queued deferred sends complete in order", async () => {
	vi.useFakeTimers();
	try {
		for (const n of [1, 2]) {
			const dir = dropDir();
			const pane = scripted([
				composer(false, null),
				...Array.from({ length: 20 }, () => composer(true, `message ${n} [MARKER]`)),
				composer(false, `message ${n} [MARKER]`),
				composer(false, null),
			]);
			const result = await proveSend({ session: "s", pane: "%1", message: `message ${n}`, dropDir: dir,
				exec: pane.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, untilDeliveredMs: 5000,
				knownPrefixes: new Set() });
			expect(result.status).toBe("DELIVERED");
			expect(pane.taken.enters).toBe(1);
		}
	} finally {
		vi.useRealTimers();
	}
});

test("dispatches complete by default; plain messages still refuse fast when disabled", async () => {
	vi.useFakeTimers();
	try {
		const busy = scripted([composer(true, "hello [MARKER]")]);
		const refused = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(),
			exec: busy.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, untilDeliveredMs: 0,
			knownPrefixes: new Set() });
		expect(refused.status).toBe("NOT_DELIVERED");
		expect(busy.taken.enters).toBe(0);
		const idle = scripted([
			...Array.from({ length: 20 }, () => composer(true, "D AM1 t-x9 go [MARKER]")),
			composer(false, "D AM1 t-x9 go [MARKER]"),
			composer(false, null),
			...Array.from({ length: 6 }, () => composer(true, "D AM1 t-x9 go [MARKER]")),
			composer(false, "D AM1 t-x9 go [MARKER]"),
			composer(false, null),
		]);
		const done = await proveSend({ session: "s", pane: "%1", message: "D AM1 t-x9 go", dropDir: dropDir(),
			exec: idle.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick, knownPrefixes: prefixes });
		expect(done.status).toBe("DELIVERED");
		expect(idle.taken.enters).toBe(1);
	} finally {
		vi.useRealTimers();
	}
});
