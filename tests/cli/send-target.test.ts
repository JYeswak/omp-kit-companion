import { afterAll, expect, test, vi } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveSend, type SendExec } from "../../src/send.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratchTmp = ownedTmp("send-target", { root: scratchRoot });
const scratch = scratchTmp.path;
afterAll(() => scratchTmp.cleanup());
const testEnv = { ...process.env, TMUX_TMPDIR: join(scratchRoot, "managed") };
delete testEnv.TMUX;
const SPIN = "⠋";

function composer(busy: boolean, body: string | null): string {
	const lines = ["history line one", "history line two", "╭──────────────────", body === null ? "❯" : `❯ ${body}`];
	if (busy) lines.push(`${SPIN} thinking`);
	return lines.join("\n");
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

const tick = async (ms: number) => { vi.advanceTimersByTime(ms); };

interface TargetTaken {
	ntm: number;
	enters: number;
	targets: string[];
	probes: string[][];
}

/**
 * Cross-session fake: display-message for "other:1" resolves to %20; every
 * capture/send-keys -t argument is recorded so the test proves which pane
 * was actually verified. Captures come from the scripted target screen.
 */
function crossSession(captures: string[], probeTo: string | null): { exec: SendExec; taken: TargetTaken } {
	const taken: TargetTaken = { ntm: 0, enters: 0, targets: [], probes: [] };
	let marker = "[MARKER]";
	return {
		taken,
		exec: {
			run(argv: string[]) {
				if (argv[0] === "ntm") {
					taken.ntm++;
					const found = /\[kit-send-[0-9a-f]+\]/.exec(argv[argv.length - 1] ?? "");
					if (found) marker = found[0];
					return { code: 0, out: "sent" };
				}
				if (argv.includes("display-message")) {
					taken.probes.push(argv);
					if (probeTo === null) return { code: 1, out: "" };
					return { code: 0, out: probeTo };
				}
				if (argv.includes("send-keys")) { taken.enters++; return { code: 0, out: "" }; }
				const target = argv[argv.indexOf("-t") + 1] ?? "";
				taken.targets.push(target);
				const next = captures.length > 1 ? captures.shift()! : captures[0]!;
				return { code: 0, out: next.replaceAll("[MARKER]", marker) };
			},
		} as SendExec,
	};
}

function sendTo(session: string, pane: string, fake: SendExec, dir: string, bound: number, message = "hello") {
	return proveSend({
		session, pane, message, dropDir: dir,
		exec: fake, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick,
		untilDeliveredMs: bound, knownPrefixes: new Set(),
	});
}

test("planted: SESSION=other with an index pane verifies against the resolved pane id", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const fake = crossSession([
			composer(false, null),
			...Array.from({ length: 6 }, () => composer(true, "hello [MARKER]")),
			composer(false, "hello [MARKER]"),
			composer(false, null),
		], "%20");
		const result = await sendTo("other", "1", fake.exec, dir, 5000);
		expect(result.status).toBe("DELIVERED");
		expect(fake.taken.enters).toBe(1);
		// The probe qualified other:1; every verification target is the id.
		expect(fake.taken.targets.length).toBeGreaterThan(0);
		expect(fake.taken.targets.every((target) => target === "%20")).toBe(true);
		expect(readdirSync(dir)).toHaveLength(0);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a marker in the resolved composer completes instead of NOT_DELIVERED with a drop", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const fake = crossSession([
			composer(false, null),
			...Array.from({ length: 6 }, () => composer(true, "hello [MARKER]")),
			composer(false, "hello [MARKER]"),
			composer(false, null),
		], "%20");
		const result = await sendTo("other", "1", fake.exec, dir, 5000);
		expect(result.status).toBe("DELIVERED");
		expect(result.drop_path).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a marker sitting in a different pane never reports OK", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const foreign = composer(false, "someone else [kit-send-ffffffffffff]");
		const fake = crossSession([foreign], "%20");
		const result = await sendTo("other", "1", fake.exec, dir, 100);
		// Admission never passes on foreign text: UNDELIVERED, nothing typed.
		expect(result.status).toBe("UNDELIVERED");
		expect(fake.taken.ntm).toBe(0);
		expect(fake.taken.enters).toBe(0);
		expect(result.drop_path).not.toBeNull();
		// Still looked at the resolved pane, not the caller's window.
		expect(fake.taken.targets.every((target) => target === "%20")).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a %id pane needs no probe and is used verbatim", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const fake = crossSession([
			composer(false, null),
			...Array.from({ length: 6 }, () => composer(true, "hello [MARKER]")),
			composer(false, "hello [MARKER]"),
			composer(false, null),
		], "%20");
		const result = await proveSend({
			session: "other", pane: "%5", message: "hello", dropDir: dir,
			exec: fake.exec, env: testEnv, pollMs: 10, deadlineMs: 60, wait: tick,
			untilDeliveredMs: 5000, knownPrefixes: new Set(),
		});
		expect(result.status).toBe("DELIVERED");
		expect(fake.taken.probes).toHaveLength(0);
		expect(fake.taken.targets.every((target) => target === "%5")).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a failed probe falls back to the qualified session:pane target", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const fake = crossSession([
			composer(false, null),
			...Array.from({ length: 6 }, () => composer(true, "hello [MARKER]")),
			composer(false, "hello [MARKER]"),
			composer(false, null),
		], null);
		const result = await sendTo("other", "1", fake.exec, dir, 5000);
		expect(result.status).toBe("DELIVERED");
		expect(fake.taken.probes).toHaveLength(1);
		expect(fake.taken.targets.every((target) => target === "other:1")).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
