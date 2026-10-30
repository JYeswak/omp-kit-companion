// intake-verb tests: INTAKE1 AC1-AC3 for `omp-kit intake` (bead ompkit-fp72.19.1.19).
// AC4 (prompt citations) is out of scope and has no tests here.
import { strict as assert } from "node:assert";
import { afterAll, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import { runIntakeVerb, type IntakeVerbOptions } from "./intake-verb.ts";
import { markerFor } from "./intake-deliver.ts";
import { intakeDigestLine } from "./report-inject-job.ts";

const repoRoot = resolve(import.meta.dir, "..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");

const ROSTER = {
	roster: { chief: "lead-chief", director: "director", w1: "worker" },
};

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function repo(label: string): string {
	mkdirSync(scratchRoot, { recursive: true });
	const t = ownedTmp(`intakeverb-${label}`, { root: scratchRoot });
	owned.push(t);
	return t.path;
}

function rowsOf(root: string): Record<string, unknown>[] {
	const path = join(root, "intake.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function base(text: string, root: string, extra: Partial<IntakeVerbOptions> = {}): IntakeVerbOptions {
	return {
		from: "joshua", text, seat: "w1", kind: "work", repo: root, config: ROSTER,
		now: () => "2026-10-20T14:00:00.000Z", nowMs: () => Date.parse("2026-10-20T14:00:00.000Z"),
		...extra,
	};
}

/** Stub br: search hits one open bead; create mints bead ids; update ok. */
function stubBr(seen: string[][], opts: { searchBead?: string; createId?: string | null } = {}) {
	return (argv: string[], runOpts: { cwd: string; timeoutMs: number }) => {
		seen.push(argv);
		if (argv.includes("search")) {
			const issues = typeof opts.searchBead === "string" ? [{ id: opts.searchBead }] : [];
			return { argv, code: 0, out: JSON.stringify({ issues }) };
		}
		if (argv.includes("create")) {
			if (opts.createId === null) return { argv, code: 1, out: "boom" };
			return { argv, code: 0, out: JSON.stringify({ id: opts.createId ?? "br-new-1" }) };
		}
		return { argv, code: 0, out: "{}" };
	};
}

test("rule records an intake row and prints DO plus reply", async () => {
	const root = repo("rule");
	const result = await runIntakeVerb(base("fleet allows a second reviewer", root, { kind: "rule", runBr: stubBr([]) }));
	assert.equal(result.action, "DO");
	assert.equal(result.exit, 0);
	const lines = result.stdout.split("\n");
	assert.equal(lines[0], "DO");
	assert.ok((lines[1] ?? "").includes("w1"));
	const rows = rowsOf(root);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.kind, "rule");
	assert.equal(rows[0]?.route, "DO");
	assert.equal(existsSync(join(root, "decisions", "joshua.jsonl")), false);
	assert.ok(result.countsLine.includes("received=1"));
});

test("planted: chief receiving 'fix this test' gets ROUTE to the project director", async () => {
	const root = repo("chief-route");
	const seen: string[][] = [];
	const result = await runIntakeVerb(base("fix this test", root, { seat: "chief", runBr: stubBr(seen, { searchBead: "b1" }) }));
	assert.equal(result.action, "ROUTE");
	assert.equal(result.bead, "b1");
	assert.equal(result.exit, 0);
	const lines = result.stdout.split("\n");
	assert.equal(lines[0], "ROUTE b1 -> director");
	assert.ok((lines[1] ?? "").length > 0);
	assert.ok(seen.some((argv) => argv.includes("search")));
	const rows = rowsOf(root);
	assert.equal(rows[0]?.route, "ROUTE b1 -> director");
	assert.ok(result.countsLine.includes("routed=1"));
});

test("planted: worker receiving 'fix this test' gets DO", async () => {
	const root = repo("worker-do");
	const result = await runIntakeVerb(base("fix this test", root, { runBr: stubBr([], { searchBead: "b1" }) }));
	assert.equal(result.action, "DO");
	assert.equal(result.exit, 0);
	assert.equal(result.stdout.split("\n")[0], "DO b1");
	const rows = rowsOf(root);
	assert.equal(rows[0]?.route, "DO b1");
	assert.ok(result.countsLine.includes("done_in_role=1"));
});

test("work with no open match creates a bead with acceptance, parent and blocks edge", async () => {
	const root = repo("create");
	const seen: string[][] = [];
	const result = await runIntakeVerb(base("build the new thing", root, {
		runBr: stubBr(seen, { createId: "br-new-9" }), parent: "epic-1", blocks: "br-old-2",
	}));
	assert.equal(result.action, "DO");
	assert.equal(result.bead, "br-new-9");
	const create = seen.find((argv) => argv.includes("create"));
	assert.ok(create);
	assert.ok(create.includes("--acceptance-criteria"));
	assert.ok(create.includes("--parent") && create.includes("epic-1"));
	assert.ok(create.includes("--deps") && create.includes("blocks:br-old-2"));
});

test("bead creation failure records PENDING and prints bead args", async () => {
	const root = repo("create-fail");
	const result = await runIntakeVerb(base("build the new thing", root, { runBr: stubBr([], { createId: null }) }));
	assert.equal(result.action, "PENDING");
	assert.equal(result.exit, 1);
	assert.equal(result.stdout.split("\n")[0], "PENDING");
	assert.ok(result.json.beadArgs);
	assert.equal(rowsOf(root)[0]?.route, "PENDING");
});

test("non-joshua source and empty text refuse without recording", async () => {
	const root = repo("refuse");
	const wrong = await runIntakeVerb(base("fix this test", root, { from: "chief", runBr: stubBr([]) }));
	assert.equal(wrong.action, "REFUSE");
	assert.equal(wrong.exit, 2);
	const empty = await runIntakeVerb(base("   ", root, { runBr: stubBr([]) }));
	assert.equal(empty.action, "REFUSE");
	assert.equal(rowsOf(root).length, 0);
});

test("unknown seat role refuses without routing", async () => {
	const root = repo("unknown-role");
	const result = await runIntakeVerb(base("fix this test", root, { seat: "ghost", runBr: stubBr([], { searchBead: "b1" }) }));
	assert.equal(result.action, "REFUSE");
	assert.equal(result.exit, 2);
	assert.ok(result.stdout.startsWith("REFUSE UNKNOWN_ROLE"));
	assert.equal(rowsOf(root)[0]?.route, "REFUSE UNKNOWN_ROLE");
});

test("self-do without Joshua's words refuses; his quote lets the seat do it and counts overridden", async () => {
	const root = repo("override");
	const plain = await runIntakeVerb(base("fix this test", root, { seat: "chief", runBr: stubBr([], { searchBead: "b7" }) }));
	assert.equal(plain.action, "ROUTE");
	const selfDo = await runIntakeVerb(base("fix this test", root, {
		seat: "chief", selfDo: true, runBr: stubBr([], { searchBead: "b7" }),
	}));
	assert.equal(selfDo.action, "REFUSE");
	assert.ok(selfDo.stdout.startsWith("REFUSE SELF_DO_WITHOUT_WORDS"));
	const allowed = await runIntakeVerb(base("fix this test", root, {
		seat: "chief", selfDo: true, roleOverride: "Joshua said: you fix it", runBr: stubBr([], { searchBead: "b7" }),
	}));
	assert.equal(allowed.action, "DO");
	assert.ok(allowed.stdout.split("\n")[1]?.includes("you fix it"));
	assert.ok(allowed.countsLine.includes("overridden=1"));
});
test("ROUTE with --deliver proves delivery from the session file", async () => {
	const root = repo("deliver");
	const seenBr: string[][] = [];
	const seenMail: string[][] = [];
	const sessionFile = join(root, "session.log");
	const text = "fix this test";
	const marker = markerFor("b1", "director", text);
	writeFileSync(sessionFile, `boot\n${marker}\n`);
	const result = await runIntakeVerb(base(text, root, {
		seat: "chief",
		runBr: stubBr(seenBr, { searchBead: "b1" }),
		deliver: true, session: "s", pane: "p", windowKey: "w", dropDir: join(root, "drop"), project: "proj",
	}), {
		runBr: stubBr(seenBr, { searchBead: "b1" }),
		deliverDeps: {
			runBr: stubBr(seenBr, { searchBead: "b1" }),
			runMail: (argv: string[]) => { seenMail.push(argv); return { argv, code: 0, out: "sent" }; },
			deliver: async () => ({ status: "DELIVERED", marker, sends: 1, sessionFile, offset: 5, drop_path: null, detail: "tern ok", code: "ok" }),
			readSessionFile: (path: string) => (path === sessionFile ? readFileSync(path, "utf8") : null),
			wait: async () => {},
			now: () => Date.parse("2026-10-20T14:00:00.000Z"),
		},
	});
	assert.equal(result.action, "ROUTE");
	assert.equal(result.exit, 0);
	assert.equal(result.deliver?.status, "DELIVERED");
	assert.equal(result.deliver?.sessionFile, sessionFile);
	assert.ok(seenBr.some((argv) => argv.includes("update") && argv.includes("director")));
	assert.ok(seenMail.some((argv) => argv.includes("send")));
	assert.ok(result.stdout.includes("delivery: DELIVERED"));
	assert.ok(result.stdout.includes(marker));
});

test("ROUTE with --deliver but missing binding refuses delivery inputs", async () => {
	const root = repo("deliver-missing");
	const result = await runIntakeVerb(base("fix this test", root, {
		seat: "chief", runBr: stubBr([], { searchBead: "b1" }), deliver: true,
	}));
	assert.equal(result.action, "ROUTE");
	assert.equal(result.exit, 2);
	assert.equal(result.deliver, undefined);
});

test("intakeDigestLine reports hourly received/routed/done/overridden for fleet_report", () => {
	const root = repo("digest");
	const hour = "2026-10-20T14:00:00.000Z";
	writeFileSync(join(root, "intake.jsonl"), [
		JSON.stringify({ at: hour, from: "joshua", text: "fix this test", kind: "work", route: "ROUTE b1 -> director", bead: "b1", seat: "chief", role: "lead-chief" }),
		JSON.stringify({ at: hour, from: "joshua", text: "fix this test", kind: "work", route: "DO b1", bead: "b1", seat: "w1", role: "worker" }),
		JSON.stringify({ at: hour, from: "joshua", text: "plan the rollout", kind: "work", route: "DO b2", bead: "b2", seat: "w1", role: "worker" }),
		JSON.stringify({ at: hour, from: "joshua", text: "fleet allows a second reviewer", kind: "rule", route: "DO", bead: null, seat: "w1", role: "worker" }),
	].join("\n") + "\n");
	assert.equal(
		intakeDigestLine(root, Date.parse("2026-10-20T14:37:00.000Z")),
		"intake: hour=2026-10-20T14:00:00.000Z received=4 routed=1 done_in_role=1 overridden=1",
	);
	assert.equal(intakeDigestLine(undefined, Date.now()), null);
	assert.equal(intakeDigestLine(join(root, "missing"), Date.now()), "intake: hour=" + new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString() + " received=0 routed=0 done_in_role=0 overridden=0");
});
