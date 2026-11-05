import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedCommand } from "../../src/cli.ts";
import { MILESTONE_COMMAND, runMilestone } from "../../src/milestone.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { privateLock } from "../../src/kitlib/lock.ts";
import { run } from "../../src/kitlib/run.ts";

const allocations: OwnedTmp[] = [];
afterEach(() => { for (const owned of allocations.splice(0)) owned.cleanup(); });

function fixture() {
	const owned = ownedTmp("milestone-test");
	allocations.push(owned);
	const root = owned.path, repo = join(root, "repo"), bin = join(root, "bin"), config = join(root, "fleet-watch.json");
	mkdirSync(repo); mkdirSync(bin);
	writeFileSync(join(bin, "br"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("init")) throw Error("no tracker writes permitted");
if (process.env.BEADS_DB === "/foreign/tracker.db" || process.env.BEADS_DIR) throw Error("foreign tracker environment leaked");
const ids = args.slice(args.indexOf("show") + 1).filter(x => !x.startsWith("--"));
if (ids.some(id => !["fixture-epic", "fixture-a", "fixture-b", "fixture-clear"].includes(id))) process.exit(1);
console.log(JSON.stringify(ids.map(id => ({id, status: "open", dependencies: [], dependents: []}))));
`, { mode: 0o700 });
	writeFileSync(config, JSON.stringify({ untouched: { operator: true }, sessions: [{ session: "demo", repo, milestone: { epic: "fixture-epic", due: "2026-11-05", declaredAt: "2026-11-03", pinned: [], decision: "keep" } }] }) + "\n", { mode: 0o640 });
	const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), OMP_KIT_FLEET_WATCH_CONFIG: config,
		PATH: `${bin}:${process.env.PATH}`, AGENT_NAME: "CutWrite", BEADS_DB: "/foreign/tracker.db", BEADS_DIR: "/foreign/.beads" };
	return { root, repo, config, env, read: () => JSON.parse(readFileSync(config, "utf8")) };
}
function request(action: string, args = "demo fixture-a", flags: [string, string | true][] = [["--reason", "requested cut"]]): ParsedCommand {
	const command = MILESTONE_COMMAND.subcommands?.find(child => child.name === action);
	if (!command) throw Error("unknown test action");
	return { command, parent: MILESTONE_COMMAND, argument: args, flags: new Map(flags), json: true, robot: false };
}

test("planted unknown id refuses the whole batch and leaves original config bytes unchanged", async () => {
	const f = fixture(), before = readFileSync(f.config);
	const result = await runMilestone(request("pin", "demo fixture-a unknown-planted"), f.env);
	expect(result.code).not.toBe(0);
	expect(result.errors?.[0]?.code).toBe("MILESTONE_BEAD_UNKNOWN");
	expect(readFileSync(f.config)).toEqual(before);
});

test("pin and unpin retain unrelated config and append actor/time/reason deltas, including no-op calls", async () => {
	const f = fixture();
	expect((await runMilestone(request("pin", "demo fixture-a fixture-a"), f.env)).code).toBe(0);
	expect(f.read().sessions[0].milestone.pinned).toEqual(["fixture-a"]);
	expect((await runMilestone(request("pin"), f.env)).code).toBe(0);
	expect((await runMilestone(request("unpin", "demo fixture-a", [["--reason", "replanned"], ["--by", "Director"]]), f.env)).code).toBe(0);
	const doc = f.read(), ms = doc.sessions[0].milestone;
	expect(doc.untouched).toEqual({ operator: true });
	expect(ms.decision).toBe("keep"); expect(ms.pinned).toEqual([]);
	expect(ms.pinLog).toHaveLength(3);
	expect(ms.pinLog[0]).toMatchObject({ by: "CutWrite", why: "requested cut", added: ["fixture-a"] });
	expect(Number.isFinite(Date.parse(ms.pinLog[0].at))).toBe(true);
	expect(ms.pinLog[1].added).toEqual([]);
	expect(ms.pinLog[2]).toMatchObject({ by: "Director", why: "replanned", removed: ["fixture-a"] });
});

test("unknown session, missing reason and option-like bead refuse without config mutation", async () => {
	const f = fixture(), before = readFileSync(f.config);
	for (const r of [request("pin", "absent fixture-a"), request("pin", "demo fixture-a", []), request("pin", "demo --all")]) {
		expect((await runMilestone(r, f.env)).code).not.toBe(0);
		expect(readFileSync(f.config)).toEqual(before);
	}
});

test("two independent concurrent processes retain both pins and both history rows", async () => {
	const f = fixture();
	mkdirSync(f.env.XDG_STATE_HOME, { mode: 0o700 });
	const held = await privateLock({ namespace: "fleet-watch-config", path: f.config }, { deadline_s: 10, state_dir: join(f.env.XDG_STATE_HOME, "omp-kit") });
	const modulePath = resolve(import.meta.dir, "../../src/milestone.ts");
	const child = (id: string) => {
		const ready = Promise.withResolvers<void>();
		const result = run([process.execPath, "-e", `import {runMilestone, MILESTONE_COMMAND} from ${JSON.stringify(modulePath)};
console.log('ready');
const r = await runMilestone({ command: MILESTONE_COMMAND.subcommands.find(c=>c.name==='pin'), parent: MILESTONE_COMMAND, argument: 'demo '+process.argv[1], flags: new Map([['--reason','concurrent']]), json:true, robot:false });
console.log(JSON.stringify(r)); process.exit(r.code);`, id], { env: f.env, deadline_s: 30, on_output: () => ready.resolve() });
		void result.then(() => ready.resolve(), () => ready.resolve());
		return { result, ready: ready.promise };
	};
	const first = child("fixture-a"), second = child("fixture-b");
	try { await Promise.all([first.ready, second.ready]); } finally { held.release(); }
	const results = await Promise.all([first.result, second.result]);
	expect(results.map(r => r.rc), JSON.stringify(results)).toEqual([0, 0]);
	expect(f.read().sessions[0].milestone.pinned.sort()).toEqual(["fixture-a", "fixture-b"]);
	expect(f.read().sessions[0].milestone.pinLog).toHaveLength(2);
});

test("show reads the written declared milestone, validates pins, and never mutates config", async () => {
	const f = fixture();
	expect((await runMilestone(request("pin"), f.env)).code).toBe(0);
	const before = readFileSync(f.config), declared = f.read().sessions[0].milestone;
	const result = await runMilestone(request("show", "demo", []), f.env);
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data).toMatchObject({ epic: declared.epic, due: declared.due, declaredAt: declared.declaredAt, pinned: declared.pinned, pinLog: declared.pinLog });
	expect(readFileSync(f.config)).toEqual(before);
	const broken = f.read(); broken.sessions[0].milestone.pinned = ["unknown-planted"];
	writeFileSync(f.config, JSON.stringify(broken));
	const brokenBefore = readFileSync(f.config);
	expect((await runMilestone(request("show", "demo", []), f.env)).code).not.toBe(0);
	expect(readFileSync(f.config)).toEqual(brokenBefore);
});

test("show limits returned history without truncating persisted pinLog", async () => {
	const f = fixture(), doc = f.read();
	doc.sessions[0].milestone.pinLog = Array.from({ length: 15 }, (_, i) => ({ at: "2026-11-03T00:00:00Z", by: "Director", added: [], why: `replan ${i}` }));
	writeFileSync(f.config, JSON.stringify(doc));
	const result = await runMilestone(request("show", "demo", []), f.env);
	expect(result.code).toBe(0);
	expect(result.data.pinLog).toEqual(doc.sessions[0].milestone.pinLog.slice(-10));
	expect(f.read().sessions[0].milestone.pinLog).toHaveLength(15);
});

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
test("MSDATE1 planted: a past-due milestone takes a future date with one audit row through the atomic writer", async () => {
	const f = fixture();
	const planted = f.read();
	planted.sessions[0].milestone.due = "2026-11-05T00:00Z";
	writeFileSync(f.config, JSON.stringify(planted) + "\n");
	const before = f.read().sessions[0].milestone;
	expect(before.due < new Date().toISOString()).toBe(true);
	const due = `${future(7)}T12:00Z`;
	const result = await runMilestone(request("date", `demo ${due}`, [["--reason", "director replan"], ["--by", "RusticPine"]]), f.env);
	expect(result.code).toBe(0);
	const after = f.read();
	expect(after.untouched).toEqual({ operator: true });
	expect(after.sessions[0].milestone.due).toBe(due);
	expect(after.sessions[0].milestone.pinLog).toHaveLength(1);
	expect(after.sessions[0].milestone.pinLog[0]).toMatchObject({ by: "RusticPine", due: { from: before.due, to: due }, why: "director replan" });
	const shown = await runMilestone(request("show", "demo", []), f.env);
	expect((shown.data as { due: string }).due).toBe(due);
});

test("MSDATE1 control: a past date refuses PAST_DUE and a malformed date refuses usage, without mutation", async () => {
	const f = fixture(), before = readFileSync(f.config);
	const past = await runMilestone(request("date", `demo ${future(-1)}`), f.env);
	expect(past.code).not.toBe(0);
	expect(past.errors?.[0]?.code).toBe("PAST_DUE");
	const bogus = await runMilestone(request("date", "demo 2026-02-30"), f.env);
	expect(bogus.errors?.[0]?.code).toBe("MILESTONE_USAGE");
	const unreasoned = await runMilestone(request("date", `demo ${future(3)}`, []), f.env);
	expect(unreasoned.errors?.[0]?.code).toBe("MILESTONE_REASON_REQUIRED");
	expect(readFileSync(f.config)).toEqual(before);
});

test("MSDATE1 mutant: an unknown subcommand leaves due unchanged", async () => {
	const f = fixture(), before = readFileSync(f.config);
	const date = request("date", `demo ${future(7)}`);
	const result = await runMilestone({ ...date, command: { ...date.command, name: "redate" } }, f.env);
	expect(result.errors?.[0]?.code).toBe("MILESTONE_USAGE");
	expect(readFileSync(f.config)).toEqual(before);
	expect(f.read().sessions[0].milestone.due).toBe("2026-11-05");
});

// Mirrors omp-kit scripts/launch_check.py constraint_checks for a one-bead lane: GO only when no pin precedes the clearing bead.
const subordinate = (pins: string[], lane: string) => pins[0] === lane ? "GO" : "RED";
async function clearingLast() {
	const f = fixture();
	expect((await runMilestone(request("pin", "demo fixture-a fixture-b fixture-clear"), f.env)).code).toBe(0);
	expect(subordinate(f.read().sessions[0].milestone.pinned, "fixture-clear")).toBe("RED");
	return f;
}
test("PINORDER1 planted: one pin --first moves only the clearing bead to the front with one audit row; SUBORDINATE reads GO", async () => {
	const f = await clearingLast();
	const result = await runMilestone(request("pin", "demo fixture-clear", [["--reason", "constraint changed"], ["--first", true]]), f.env);
	expect(result.code).toBe(0);
	const ms = f.read().sessions[0].milestone;
	expect(ms.pinned).toEqual(["fixture-clear", "fixture-a", "fixture-b"]);
	expect(subordinate(ms.pinned, "fixture-clear")).toBe("GO");
	expect(ms.pinLog).toHaveLength(2);
	expect(ms.pinLog[1]).toMatchObject({ by: "CutWrite", why: "constraint changed", added: [], first: ["fixture-clear"] });
});
test("PINORDER1 control: plain pin still appends; negative: unknown bead with --first refuses without mutation", async () => {
	const f = fixture();
	expect((await runMilestone(request("pin", "demo fixture-a"), f.env)).code).toBe(0);
	expect((await runMilestone(request("pin", "demo fixture-b"), f.env)).code).toBe(0);
	expect(f.read().sessions[0].milestone.pinned).toEqual(["fixture-a", "fixture-b"]);
	const before = readFileSync(f.config);
	const refused = await runMilestone(request("pin", "demo unknown-planted", [["--reason", "x"], ["--first", true]]), f.env);
	expect(refused.errors?.[0]?.code).toBe("MILESTONE_BEAD_UNKNOWN");
	expect(readFileSync(f.config)).toEqual(before);
	const fresh = await runMilestone(request("pin", "demo fixture-clear", [["--reason", "new lane"], ["--first", true]]), f.env);
	expect(fresh.code).toBe(0);
	expect(f.read().sessions[0].milestone.pinned).toEqual(["fixture-clear", "fixture-a", "fixture-b"]);
});
test("PINORDER1 mutant: re-pinning without --first leaves the order unchanged and SUBORDINATE RED", async () => {
	const f = await clearingLast();
	expect((await runMilestone(request("pin", "demo fixture-clear"), f.env)).code).toBe(0);
	const pins = f.read().sessions[0].milestone.pinned;
	expect(pins).toEqual(["fixture-a", "fixture-b", "fixture-clear"]);
	expect(subordinate(pins, "fixture-clear")).toBe("RED");
});
