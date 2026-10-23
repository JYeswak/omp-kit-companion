// Conformance tests for src/kitlib/proc.ts (ompkit-5m6ej, KL09). Every case comes from
// tests/fixtures/kitlib-proc/corpus.json, the same corpus tests/scripts/kitlib_proc_test.py runs against
// scripts/kitlib_proc.py. Subjects are real processes this test creates and tears down.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { incarnation, isDead, probeIncarnation, type Probe, type ProbeSeam } from "../../src/kitlib/proc";
import { run } from "../../src/kitlib/run";

type Case = { id: string; subject: "live" | "dead" | "zombie" | "unreadable"; recorded: "observed" | "wrong" | "any"; expect: { state: string; is_dead: boolean } };
type Negative = { id: string; disable: "zombie" | "reuse"; flips: string; control: string };
const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-proc/corpus.json"), "utf8")) as {
	schema: string; wrong_start: string; cases: Case[]; negatives: Negative[]; malformed: unknown[]; malformed_pids: unknown[];
};
const byId = new Map(corpus.cases.map(item => [item.id, item]));
const ROOT = join(import.meta.dir, "../..");

/** A subject process plus the start read while it ran, and its teardown. */
type Subject = { pid: number; start: string; teardown: () => Promise<void> };

async function startOf(pid: number): Promise<string> {
	const seen = await incarnation(pid);
	if (seen === null) throw new Error(`no incarnation for running pid ${pid}`);
	return seen.start;
}

async function liveSubject(): Promise<Subject> {
	const child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const start = await startOf(child.pid);
	return { pid: child.pid, start, teardown: async () => { child.kill("SIGKILL"); await child.exited; } };
}

async function deadSubject(): Promise<Subject> {
	const live = await liveSubject();
	await live.teardown(); // Bun reaps the child: exited and reaped
	return { ...live, teardown: async () => {} };
}

/** A grandchild whose parent exec's into sleep and never waits: killed, it stays a zombie until the parent dies. */
async function zombieSubject(): Promise<Subject> {
	const parent = Bun.spawn(["/bin/sh", "-c", "sleep 30 & echo $!; exec sleep 30"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const reader = parent.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { done, value } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const pid = Number(text.trim());
	const start = await startOf(pid);
	process.kill(pid, "SIGKILL");
	// Real-clock poll: the OS marks the killed grandchild Z on its own schedule, which no fake timer drives.
	for (let tries = 0; tries < 60; tries++) {
		if ((await probeIncarnation({ pid, start })).evidence.stat?.startsWith("Z")) break;
		await Bun.sleep(50);
	}
	// Teardown reaps: the parent dies, init inherits and reaps the zombie.
	return { pid, start, teardown: async () => { parent.kill("SIGKILL"); await parent.exited; } };
}

const unreadable: ProbeSeam["ps"] = async () => ({ rc: null, timed_out: true, stdout: "" });

async function probeCase(item: Case, seam: ProbeSeam): Promise<Probe> {
	if (item.subject === "unreadable") return probeIncarnation({ pid: process.pid, start: corpus.wrong_start }, { ...seam, ps: unreadable });
	const subject = await (item.subject === "live" ? liveSubject() : item.subject === "dead" ? deadSubject() : zombieSubject());
	try {
		return await probeIncarnation({ pid: subject.pid, start: item.recorded === "observed" ? subject.start : corpus.wrong_start }, seam);
	} finally {
		await subject.teardown();
	}
}

const passes = (item: Case, probe: Probe) => probe.state === item.expect.state && isDead(probe) === item.expect.is_dead;

describe("kitlib proc conformance corpus", () => {
	test("corpus is a kitlib-proc-corpus.v1 corpus", () => {
		expect(corpus.schema).toBe("kitlib-proc-corpus.v1");
		expect(corpus.cases.length).toBe(5);
	});
	for (const item of corpus.cases) {
		test(item.id, async () => {
			const probe = await probeCase(item, {});
			expect(probe.state, JSON.stringify(probe)).toBe(item.expect.state as Probe["state"]);
			expect(isDead(probe)).toBe(item.expect.is_dead);
		}, 30_000);
	}
	for (const negative of corpus.negatives) {
		test(`planted negative ${negative.id}: the case flips, the control holds`, async () => {
			const seam: ProbeSeam = negative.disable === "zombie" ? { detectZombie: false } : { detectReuse: false };
			const flipped = await probeCase(byId.get(negative.flips)!, seam);
			expect(passes(byId.get(negative.flips)!, flipped), JSON.stringify(flipped)).toBe(false);
			expect(isDead(flipped)).toBe(false);
			const control = await probeCase(byId.get(negative.control)!, seam);
			expect(passes(byId.get(negative.control)!, control), JSON.stringify(control)).toBe(true);
		}, 30_000);
	}
	test("malformed probe input is refused", async () => {
		for (const input of corpus.malformed) {
			await expect(probeIncarnation(input as never), JSON.stringify(input)).rejects.toThrow(TypeError);
		}
		await expect(probeIncarnation(null as never)).rejects.toThrow(TypeError);
	});
	test("malformed incarnation pid is refused", async () => {
		for (const pid of corpus.malformed_pids) await expect(incarnation(pid as never), JSON.stringify(pid)).rejects.toThrow(TypeError);
	});
	test("TypeScript and Python read the same incarnation", async () => {
		const subject = await liveSubject();
		try {
			const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, "scripts"))}); import kitlib_proc; print(json.dumps(kitlib_proc.incarnation(${subject.pid})))`;
			const result = await run(["python3", "-c", code], { deadline_s: 30 });
			expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
			expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual(await incarnation(subject.pid));
		} finally {
			await subject.teardown();
		}
	}, 30_000);
	test("whitespace in a recorded start is normalized", async () => {
		const subject = await liveSubject();
		try {
			const padded = subject.start.replace(" ", "   ");
			expect((await probeIncarnation({ pid: subject.pid, start: padded })).state).toBe("live");
		} finally {
			await subject.teardown();
		}
	}, 30_000);
});
