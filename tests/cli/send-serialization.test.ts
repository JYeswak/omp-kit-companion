import { expect, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paneLockPath, proveSend, sweepUnsentMarkers, type ProvenSend, type SendExec } from "../../src/send.ts";
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-serialization-" + process.pid + "."));
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

interface PaneEvent {
	t: number;
	ev: string;
}

interface PaneTaken {
	sends: string[];
	enters: number;
	capturesBeforeFirstSend: number;
	enterContexts: string[];
}

interface PaneFake {
	taken: PaneTaken;
	exec: SendExec;
}

/**
 * One shared composer for senders targeting the same pane. ntm appends the
 * message body (exactly what a real racy typer would do when admission is
 * bypassed); Enter submits everything at once. Busy re-arms for a bounded
 * window after every ntm so each sender's send-phase polls see a working
 * receiver regardless of poll-count jitter; the pane idles after that, so
 * the deferred completion always finds its marker and Enters exactly once.
 * A human draft occupies the composer until draftClearsAfter captures.
 */
interface SharedPane {
	bodies: string[];
	busyForNext: number;
	draft: string | null;
	draftClearsAfter: number;
	captures: number;
}

function sharedPane(draft: string | null, draftClearsAfter: number): SharedPane {
	return { bodies: [], busyForNext: 0, draft, draftClearsAfter, captures: 0 };
}

function renderPane(pane: SharedPane): string {
	const lines = ["history line one", "history line two", "╭──────────────────"];
	if (pane.draft !== null && pane.captures < pane.draftClearsAfter) {
		lines.push(`❯ ${pane.draft}`);
	} else if (pane.bodies.length === 0) {
		lines.push("❯");
	} else {
		pane.bodies.forEach((body, index) => lines.push(index === 0 ? `❯ ${body}` : body));
	}
	if (pane.busyForNext > 0) lines.push(`${SPIN} thinking`);
	return lines.join("\n");
}

function paneFake(events: PaneEvent[], me: string, pane: SharedPane): PaneFake {
	const taken: PaneTaken = { sends: [], enters: 0, capturesBeforeFirstSend: -1, enterContexts: [] };
	return {
		taken,
		exec: {
			run(argv: string[]) {
				if (argv[0] === "ntm") {
					const body = argv[argv.length - 1] ?? "";
					const word = ["alpha", "bravo", "charlie"].find((w) => body.startsWith(w)) ?? "?";
					const found = /\[kit-send-[0-9a-f]+\]/.exec(body);
					if (found) pane.bodies.push(`${word} ${found[0]}`);
					// Re-arm busy past every possible send-phase poll so the
					// send loop always exhausts into the deferred path: send
					// polls at most ceil(deadlineMs/pollMs) times (24 here).
					pane.busyForNext = 40;
					if (taken.capturesBeforeFirstSend < 0) taken.capturesBeforeFirstSend = pane.captures;
					taken.sends.push(word);
					events.push({ t: Date.now(), ev: `ntm-${word}` });
					return { code: 0, out: "sent" };
				}
				if (argv.includes("send-keys")) {
					taken.enters++;
					taken.enterContexts.push(renderPane(pane));
					pane.bodies = [];
					events.push({ t: Date.now(), ev: `enter-${me}` });
					return { code: 0, out: "" };
				}
				pane.captures++;
				if (pane.busyForNext > 0) pane.busyForNext--;
				const out = renderPane(pane);
				return { code: 0, out };
			},
		} as SendExec,
	};
}

/** Scripted single-pane fake for the solo admission/lock unit tests below. */
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

function send(word: string, fake: PaneFake, dir: string, bound: number, deadline: number): Promise<ProvenSend> {
	return proveSend({
		session: "lk", pane: "1", message: word, dropDir: dir,
		exec: fake.exec, env: testEnv, pollMs: 10, deadlineMs: deadline, wait: tick,
		untilDeliveredMs: bound,
	});
}

test("planted: per-destination lock orders two concurrent sends", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const events: PaneEvent[] = [];
		const pane = sharedPane(null, 0);
		const fa = paneFake(events, "alpha", pane);
		const fb = paneFake(events, "bravo", pane);
		const [a, b] = await Promise.all([send("alpha", fa, dir, 8000, 60), send("bravo", fb, dir, 8000, 60)]);
		expect(a.status).toBe("DELIVERED");
		expect(b.status).toBe("DELIVERED");
		expect(fa.taken.enters).toBe(1);
		expect(fb.taken.enters).toBe(1);
		// Mutual exclusion: bravo is typed only after alpha's submit Enter.
		const order = events.map((entry) => entry.ev);
		expect(order.filter((ev) => ev.startsWith("ntm"))).toEqual(["ntm-alpha", "ntm-bravo"]);
		expect(order.indexOf("ntm-bravo")).toBeGreaterThan(order.indexOf("enter-alpha"));
	} finally {
		vi.useRealTimers();
	}
});

test("planted: three concurrent sends plus a human draft keep the draft and queue in order", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const events: PaneEvent[] = [];
		const pane = sharedPane("human draft here", 5);
		const fa = paneFake(events, "alpha", pane);
		const fb = paneFake(events, "bravo", pane);
		const fc = paneFake(events, "charlie", pane);
		const [a, b, c] = await Promise.all([
			send("alpha", fa, dir, 8000, 60),
			send("bravo", fb, dir, 8000, 60),
			send("charlie", fc, dir, 8000, 60),
		]);
		expect(a.status).toBe("DELIVERED");
		expect(b.status).toBe("DELIVERED");
		expect(c.status).toBe("DELIVERED");
		expect(fa.taken.enters).toBe(1);
		expect(fb.taken.enters).toBe(1);
		expect(fc.taken.enters).toBe(1);
		const order = events.map((entry) => entry.ev);
		expect(order.filter((ev) => ev.startsWith("ntm"))).toEqual(["ntm-alpha", "ntm-bravo", "ntm-charlie"]);
		expect(order.indexOf("ntm-bravo")).toBeGreaterThan(order.indexOf("enter-alpha"));
		expect(order.indexOf("ntm-charlie")).toBeGreaterThan(order.indexOf("enter-bravo"));
		// No typing while the draft owned the composer.
		expect(fa.taken.capturesBeforeFirstSend).toBe(5);
		// Every Enter fired on a composer holding a real marker, never the draft.
		for (const fake of [fa, fb, fc]) {
			expect(fake.taken.enterContexts).toHaveLength(1);
			expect(fake.taken.enterContexts[0]).toMatch(/\[kit-send-[0-9a-f]+\]/);
			expect(fake.taken.enterContexts[0]).not.toContain("human draft here");
		}
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a composer that never empties reports UNDELIVERED with no keys typed", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		const events: PaneEvent[] = [];
		const pane = sharedPane("someone is drafting", Number.POSITIVE_INFINITY);
		const fake = paneFake(events, "alpha", pane);
		const result = await send("alpha", fake, dir, 100, 60);
		expect(result.status).toBe("UNDELIVERED");
		expect(fake.taken.sends).toEqual([]);
		expect(fake.taken.enters).toBe(0);
		expect(readdirSync(dir)).toHaveLength(1);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: a lock left by a dead pid is stolen", async () => {
	vi.useFakeTimers();
	try {
		const dir = dropDir();
		writeFileSync(paneLockPath(dir, "lk", "1"), "999999999\n");
		const events: PaneEvent[] = [];
		const pane = sharedPane(null, 0);
		const fake = paneFake(events, "alpha", pane);
		const result = await send("alpha", fake, dir, 5000, 30);
		expect(result.status).toBe("DELIVERED");
		expect(fake.taken.sends).toEqual(["alpha"]);
	} finally {
		vi.useRealTimers();
	}
});

test("planted: sweep reports composer markers, ignores scrollback, skips failed captures", async () => {
	const stuck = ["scroll line", "╭──", "❯ waiting on [kit-send-aaaaaaaaaaaa]"].join("\n");
	const historyOnly = ["old [kit-send-bbbbbbbbbbbb] done", "╭──", "❯"].join("\n");
	const calls: string[][] = [];
	const runTmux = (argv: string[]) => {
		calls.push(argv);
		const pane = argv[argv.length - 1] ?? "";
		if (pane === "%9") return { code: 1, out: "" };
		if (pane === "%2") return { code: 0, out: historyOnly };
		return { code: 0, out: stuck };
	};
	const result = await sweepUnsentMarkers({ runTmux, panes: ["%1", "%2", "%9"] });
	expect(result.panes).toBe(2);
	expect(result.unsent).toEqual([{ pane: "%1", markers: ["kit-send-aaaaaaaaaaaa"] }]);
	expect(calls.filter((argv) => argv[0] === "capture-pane")).toHaveLength(3);
});

test("planted: under real timers the second send types only after the first submit", async () => {
	// The fake-timer suites above prove ordering and per-sender delivery;
	// contender ticks fast-forward the shared fake clock, so the wall-order
	// half of mutual exclusion is proven here with a truthful clock.
	const dir = dropDir();
	const events: PaneEvent[] = [];
	const pane = sharedPane(null, 0);
	const fa = paneFake(events, "alpha", pane);
	const fb = paneFake(events, "bravo", pane);
	const opts = { session: "lk", pane: "1", dropDir: dir, env: testEnv, pollMs: 5, deadlineMs: 120, untilDeliveredMs: 2000 };
	const [a, b] = await Promise.all([
		proveSend({ ...opts, message: "alpha", exec: fa.exec }),
		proveSend({ ...opts, message: "bravo", exec: fb.exec }),
	]);
	expect(a.status).toBe("DELIVERED");
	expect(b.status).toBe("DELIVERED");
	expect(fa.taken.enters).toBe(1);
	expect(fb.taken.enters).toBe(1);
	const momentOf = (ev: string): number => {
		const found = events.find((entry) => entry.ev === ev);
		expect(found).toBeDefined();
		return found!.t;
	};
	expect(momentOf("ntm-alpha")).toBeLessThan(momentOf("ntm-bravo"));
	expect(momentOf("ntm-bravo")).toBeGreaterThan(momentOf("enter-alpha"));
}, 30000);
