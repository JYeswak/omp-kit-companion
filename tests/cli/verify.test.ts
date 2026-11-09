import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { LIVE_READBACK_LABEL, expectedOf, liveReadback, liveReadbackAll, mapRepoPaths, parseBoxes, verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { createParentTracker, runUnpinnedInitControl } from "./tracker-init-parent.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
// This bounds fixture Git initialization/publication and verification subprocesses,
// not a product latency contract; retain the 15-second floor and account for load.
jest.setTimeout(fixtureDeadlineS(15) * 1_000);

/** Test bases live where the ambient br authority permits writes: a grading
 * harness designates GRADE_WAVE_SCRATCH, otherwise the default TMPDIR root. */
function testBase(label: string): string {
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	return ownedTmp(label, g === undefined ? {} : { root: g }).path;
}

const base = testBase("verify-test");
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** VERIFYTESTENV1 (ompkit-fp72.120.16.277): the fixtures own their identity instead of inheriting the caller's.
 * A seat's PATH carries the pane br shim, which judges every real-br fixture write against the caller's
 * AGENT_NAME (BR_SHIM_ACTOR_MISMATCH / _IDENTITY_REQUIRED) and its Agent Mail reservations
 * (BR_SHIM_RESERVATION_UNKNOWN). Like mine.test.ts, drop every PATH entry whose br is a policy script, put a
 * fixture bin whose br is the official native br first, and bind AGENT_NAME to a fixture identity; each case
 * still names its own --actor. The caller's tracker selectors are dropped too: `omp-kit verify` replays with
 * BEADS_DIR bound to the caller's tracker, and native br then resolves every fixture `br init` to it
 * ("Already initialized at <caller>/.beads/beads.db"). Restored after the file so a shared-process suite
 * sees the caller's env. */
const FIXTURE_AGENT = "VerifyFixture";
/** Tracker selectors and identity aliases read by native br (BEADS_*, BD_*, BR_AGENT_NAME, BR_OUTPUT_FORMAT),
 * scripts/br-shim.sh (BR_REAL) and src/ (BR_ACTOR, BR_BIN); each case passes its own explicitly. */
const INHERITED_SELECTORS = ["BEADS_DIR", "BEADS_DB", "BEADS_JSONL", "BEADS_CACHE_DIR", "BD_DB", "BD_DATABASE", "BR_REAL", "BR_BIN", "BR_ACTOR", "BR_AGENT_NAME", "BR_OUTPUT_FORMAT"] as const;
const callerPath = process.env.PATH ?? "";
const callerAgent = process.env.AGENT_NAME;
const callerSelectors = new Map(INHERITED_SELECTORS.map(key => [key, process.env[key]]));
const shimDirs = new Set(resolveRealBr(callerPath).skipped.map(p => dirname(p)));
const shimFreePath = callerPath.split(delimiter).filter(dir => dir !== "" && !shimDirs.has(dir)).join(delimiter);
function fixtureIdentityEnv(): { PATH: string; AGENT_NAME: string } {
	const real = resolveRealBr(callerPath);
	if (!real.ok) throw new Error(real.reason);
	const bin = join(base, "fixture-identity-bin");
	mkdirSync(bin, { recursive: true });
	if (!existsSync(join(bin, "br"))) symlinkSync(real.path, join(bin, "br"));
	return { PATH: `${bin}${delimiter}${shimFreePath}`, AGENT_NAME: FIXTURE_AGENT };
}
beforeAll(() => {
	for (const key of INHERITED_SELECTORS) delete process.env[key];
	Object.assign(process.env, fixtureIdentityEnv());
});
afterAll(() => {
	process.env.PATH = callerPath;
	if (callerAgent === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = callerAgent;
	for (const [key, value] of callerSelectors) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test("VERIFYTESTENV1 mutant: a fixture that inherits the caller's identity through the pane shim reproduces BR_SHIM_ACTOR_MISMATCH; the owned identity does not", async () => {
	const shim = join(import.meta.dir, "..", "..", "scripts", "br-shim.sh");
	const dir = join(base, "identity-mutant");
	mkdirSync(dir, { recursive: true });
	// Mutant: the caller's planted seat identity reaches the shim while the case acts as Peer.
	const inherited = await run(["sh", shim, "list", "--actor", "Peer", "--json"], { cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, AGENT_NAME: "PeachLeopard" } as Record<string, string> });
	expect(new TextDecoder().decode(inherited.stderr)).toContain("BR_SHIM_ACTOR_MISMATCH refusing --actor Peer for pane identity PeachLeopard");
	expect(inherited.rc).not.toBe(0);
	// Owned: the fixture br resolved for this file is the native binary, never a policy script.
	expect(resolveRealBr(process.env.PATH).skipped).toEqual([]);
	expect(process.env.AGENT_NAME).toBe(FIXTURE_AGENT);
	for (const key of INHERITED_SELECTORS) expect(process.env[key]).toBeUndefined();
});

test("VERIFYTESTENV1 mutant: a fixture that inherits the caller's BEADS_DIR has its tracker init resolved to the caller's tracker; the owned env inits its own", async () => {
	// A stand-in caller tracker in scratch, never a real one.
	const caller = join(base, "beads-dir-caller");
	mkdirSync(caller, { recursive: true });
	await sh(["br", "init", "--db", join(caller, ".beads", "beads.db")], caller);
	const fixture = join(base, "beads-dir-fixture");
	mkdirSync(fixture, { recursive: true });
	const init = (env: Record<string, string>) => run(["br", "init", "--db", join(fixture, ".beads", "beads.db")], { cwd: fixture, deadline_s: fixtureDeadlineS(60), env });
	// Mutant: the caller's BEADS_DIR reaches the fixture's br init.
	const inherited = await init({ ...process.env, BEADS_DIR: join(caller, ".beads") } as Record<string, string>);
	// macOS may print the TMPDIR path through /private, so match the caller-owned suffix.
	expect(new TextDecoder().decode(inherited.stdout) + new TextDecoder().decode(inherited.stderr)).toMatch(/Already initialized at '[^']*\/beads-dir-caller\/\.beads\/beads\.db'/);
	expect(inherited.rc).not.toBe(0);
	expect(existsSync(join(fixture, ".beads", "beads.db"))).toBe(false);
	// Owned: with the selectors dropped the same init creates the fixture's own tracker.
	const owned = await init({ ...process.env } as Record<string, string>);
	expect(new TextDecoder().decode(owned.stderr)).not.toContain("Already initialized");
	expect(owned.rc).toBe(0);
	expect(existsSync(join(fixture, ".beads", "beads.db"))).toBe(true);
});

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<string> {
	// Always the live process.env: a spawn without env keeps selectors the file dropped in beforeAll.
	const r = await run(cmd, { cwd, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...(env ?? {}) } as Record<string, string> });
	if (r.rc !== 0) throw new Error(`${cmd.join(" ")} -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return new TextDecoder().decode(r.stdout);
}

/** A repo whose HEAD carries scripts/t.sh (prints `16 pass 0 fail`, exit 0) and scripts/bad.sh (exit 1).
 * verify only reads a code repo (fetch, archive, replay of read-only scripts), so one published repo per
 * script set is shared; `own` gives a caller that writes into the repo (a tracker inside it) its own. */
const sharedRepos = new Map<string, Promise<{ dir: string; sha: string }>>();
function repo(name: string, extraScripts: Record<string, string> = {}, own = false): Promise<{ dir: string; sha: string }> {
	if (own) return createRepo(name, extraScripts);
	const key = JSON.stringify(Object.entries(extraScripts).sort());
	let created = sharedRepos.get(key);
	if (created === undefined) {
		created = createRepo(`shared-${sharedRepos.size}`, extraScripts);
		sharedRepos.set(key, created);
	}
	return created;
}
async function createRepo(name: string, extraScripts: Record<string, string>): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	writeFileSync(join(dir, "scripts", "bad.sh"), "#!/bin/sh\necho 'selftest: FAIL'\nexit 1\n");
	writeFileSync(join(dir, "scripts", "probe.sh"), "#!/bin/sh\ns=0\ni=1\nwhile [ $i -le 100 ]; do s=$((s + i)); i=$((i + 1)); done\nif [ $s -ne 5050 ]; then echo 'probe WRONG'; exit 1; fi\necho 'probe 5050 ok'\necho ' 0 fail'\n");
	for (const [file, contents] of Object.entries(extraScripts)) writeFileSync(join(dir, "scripts", file), contents);
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}
async function publishHead(dir: string, name: string): Promise<void> {
	const origin = join(base, `${name}.origin.git`);
	await sh(["git", "init", "--bare", "-q", origin], base);
	await sh(["git", "remote", "add", "origin", origin], dir);
	await sh(["git", "push", "-q", "origin", "HEAD:main"], dir);
}

type FixtureComment = { id: number; author: string; text: string; created_at: string };

/** A stateful toy tracker in its own directory; close-policy assertions use the real guard below. */
let fakeBrCount = 0;
function fakeBr(bead: Record<string, unknown>, opts?: { failOn?: string | string[]; failMessage?: string; commitBeforeRefusal?: boolean; refusalAcceptance?: string; comments?: FixtureComment[]; extraBeads?: Record<string, unknown>[] }): { env: Record<string, string>; acts: () => string[]; state: (id?: string) => Record<string, unknown> } {
	const home = join(base, `fake-br-${++fakeBrCount}`);
	const bin = join(home, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(home, "br-acts.log");
	const statePath = join(home, "tracker.json");
	const views = join(home, "views");
	mkdirSync(views);
	const comments = opts?.comments ?? [{ id: 1, author: String(bead.assignee ?? "Author"), text: "Lesson: fixture review", created_at: "2026-01-01T00:00:00Z" }];
	const initial = { beads: Object.fromEntries([bead, ...(opts?.extraBeads ?? [])].map(row => [String(row.id), row])), comments };
	writeFileSync(statePath, JSON.stringify(initial));
	// Reads (show, comments list) are most of verify's br calls: a sh fast path serves them from
	// views the writer refreshes on every save, byte-identical to the writer's own read output.
	for (const [id, row] of Object.entries(initial.beads)) writeFileSync(join(views, `show-${id}.json`), JSON.stringify([row]));
	writeFileSync(join(views, "comments.json"), JSON.stringify(comments));
	const writer = join(home, "br.js");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(bin, "br"), [
		"#!/bin/sh",
		"case \"$1 $2\" in",
		"\"show \"*/*|\"show \") ;;",
		`"show "*) f=${quote(views)}/show-"$2".json; [ -f "$f" ] || exit 3; exec cat "$f" ;;`,
		`"comments list") exec cat ${quote(join(views, "comments.json"))} ;;`,
		"esac",
		`exec bun ${quote(writer)} "$@"`,
		"",
	].join("\n"));
	writeFileSync(writer, String.raw`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(statePath)};
const views = ${JSON.stringify(views)};
const log = ${JSON.stringify(log)};
const failOn = ${JSON.stringify(opts?.failOn === undefined ? [] : typeof opts.failOn === "string" ? [opts.failOn] : opts.failOn)};
const failMessage = ${JSON.stringify(opts?.failMessage ?? "fixture act refused")};
const refusalAcceptance = ${JSON.stringify(opts?.refusalAcceptance ?? null)};
const commitBeforeRefusal = ${JSON.stringify(opts?.commitBeforeRefusal ?? false)};
const a = process.argv.slice(2);
const store = JSON.parse(readFileSync(file, "utf8"));
const save = () => {
	writeFileSync(file, JSON.stringify(store));
	for (const [id, bead] of Object.entries(store.beads)) writeFileSync(views + "/show-" + id + ".json", JSON.stringify([bead]));
	writeFileSync(views + "/comments.json", JSON.stringify(store.comments));
};
const row = store.beads[a[1]];
const value = flag => { const i = a.indexOf(flag); return i < 0 ? undefined : a[i + 1]; };
if (a[0] === "show") {
	if (!row) process.exit(3);
	process.stdout.write(JSON.stringify([row]));
	process.exit(0);
}
if (a[0] === "comments" && a[1] === "list") {
	process.stdout.write(JSON.stringify(store.comments));
	process.exit(0);
}
if (a[0] === "list") {
	const issues = Object.values(store.beads).filter(row =>
		(value("--status") === undefined || value("--status") === "all" || row.status === value("--status")) &&
		(value("--label") === undefined || row.labels?.includes(value("--label"))));
	process.stdout.write(JSON.stringify({ issues }));
	process.exit(0);
}
const refused = failOn.some(pattern => (" " + a.join(" ") + " ").includes(" " + pattern + " "));
if (refused && !commitBeforeRefusal) {
	if (a[0] === "close" && row && refusalAcceptance !== null) {
		row.acceptance_criteria = refusalAcceptance;
		row.updated_at = "peer-edit";
		save();
	}
	process.stderr.write(failMessage + "\n");
	process.exit(4);
}
appendFileSync(log, a.join(" ") + "\x1e");
if (a[0] === "update" && row) {
	if (value("--if-unchanged") !== undefined && value("--if-unchanged") !== row.updated_at) process.exit(6);
	for (const [flag, field] of [["--status", "status"], ["--description", "description"], ["--acceptance-criteria", "acceptance_criteria"], ["--acceptance", "acceptance_criteria"]])
		if (value(flag) !== undefined) row[field] = value(flag);
	for (const [flag, checked] of [["--check-acceptance", true], ["--uncheck-acceptance", false]]) {
		if (value(flag) === undefined) continue;
		const selected = new Set(value(flag).split(",").map(Number));
		let item = 0;
		row.acceptance_criteria = row.acceptance_criteria.split("\n").map(line => {
			if (!line.startsWith("- [ ] ") && !line.startsWith("- [x] ") && !line.startsWith("- [X] ")) return line;
			if (!selected.has(++item)) return line;
			return line.slice(0, 3) + (checked ? "x" : " ") + line.slice(4);
		}).join("\n");
	}
	row.updated_at = String(Number(row.revision ?? 0) + 1);
	row.revision = Number(row.revision ?? 0) + 1;
}
if (a[0] === "close" && row) {
	row.status = "closed";
	row.closed_transition = value("--transition-comment");
}
if (a[0] === "reopen" && row) row.status = "open";
if (a[0] === "create") {
	const dependency = value("--deps")?.split(":");
	store.beads["kit-1.1"] = {
		id: "kit-1.1", title: a[1], status: "open", assignee: null,
		created_by: value("--actor"), parent: value("--parent"),
		acceptance_criteria: value("--acceptance-criteria"), description: value("--description"),
		labels: value("-l") === undefined ? [] : [value("-l")],
		dependencies: dependency ? [{ dependency_type: dependency[0], id: dependency[1] }] : [],
	};
}
save();
if (refused) {
	process.stderr.write(failMessage + "\n");
	process.exit(4);
}
if (a[0] === "create") process.stdout.write('{"id":"kit-1.1"}');
`);
	chmodSync(join(bin, "br"), 0o755);
	return {
		env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
		acts: () => { try { return readFileSync(log, "utf8").split("\x1e").filter(Boolean); } catch { return []; } },
		state: (id = String(bead.id)) => {
			const value: unknown = JSON.parse(readFileSync(statePath, "utf8"));
			if (value === null || typeof value !== "object" || !("beads" in value) || value.beads === null || typeof value.beads !== "object" || !(id in value.beads)) throw new Error("fixture bead missing");
			const row: unknown = value.beads[id as keyof typeof value.beads];
			if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("fixture bead malformed");
			return row as Record<string, unknown>;
		},
	};
}

const inReview = (ac: string) => ({ id: "kit-1", status: "in_review", assignee: "Author", updated_at: "2026-10-26T00:00:00Z", labels: [], acceptance_criteria: ac });
const sourceBead = { id: "kit-source", status: "closed", assignee: "Author", labels: [], acceptance_criteria: "" };
const liveBead = (acceptance: string) => ({ id: "kit-live", status: "open", assignee: "ReadbackAuthor", updated_at: "2026-01-01T00:00:00Z", labels: [LIVE_READBACK_LABEL], acceptance_criteria: acceptance, dependencies: [{ id: "kit-source", dependency_type: "related" }] });
const fixtureEpic = { id: "kit-epic", status: "open", assignee: null, labels: [], acceptance_criteria: "" };

test("LESSONPAYLOAD1 missing lesson refuses before replay and preserves the bead", async () => {
	const marker = join(base, "lesson-missing-replay");
	const { dir, sha } = await repo("lesson-missing", { "entered.sh": "#!/bin/sh\nprintf entered > \"$LESSON_REPLAY_MARKER\"\nprintf '0 fail\\n'\n" });
	const acceptance = "- [ ] [a] [build] `sh scripts/entered.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { comments: [] });
	const before = br.state();
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, LESSON_REPLAY_MARKER: marker } });
	expect(res.code).toBe("LESSON_MISSING");
	expect(res.replays).toEqual([]);
	expect(existsSync(marker)).toBe(false);
	expect(br.state()).toEqual(before);
});

test("LESSONPAYLOAD1 newest author lesson reaches the real close-policy consumer", async () => {
	const { dir, sha } = await repo("lesson-author");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"), { comments: [
		{ id: 3, author: "AnotherReviewer", text: "Lesson: not the author's lesson", created_at: "2026-03-01T00:00:00Z" },
		{ id: 2, author: "Author", text: "Review notes\nLesson: preserve the committed frontier", created_at: "2026-02-01T00:00:00Z" },
		{ id: 1, author: "Author", text: "Lesson: old lesson", created_at: "2026-01-01T00:00:00Z" },
	] });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	const closed = br.state();
	expect(closed.status).toBe("closed");
	expect(closed.closed_transition).toContain("Lesson: preserve the committed frontier");
	expect(closed.closed_transition).not.toContain("not the author's lesson");
	const guarded = await run(["sh", join(import.meta.dir, "..", "..", "scripts", "close-guard.sh"), "kit-1", "--sub", "close", "--reason", String(closed.closed_transition)], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env, AGENT_NAME: "Peer" },
	});
	expect(new TextDecoder().decode(guarded.stderr)).toBe("");
	expect(guarded.rc).toBe(0);
// DEADLINETESTS1: 3x its observed load-normalized p95 (8.3 s, n=28 full-suite runs at load1 >= 18).
}, fixtureDeadlineS(25) * 1_000);

test("LESSONPAYLOAD1 CLI explicit lesson takes precedence over author comments", async () => {
	const { dir, sha } = await repo("lesson-cli");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--lesson", "explicit reviewer finding", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	expect(new TextDecoder().decode(r.stderr)).not.toContain("Unknown flag");
	expect(r.rc).toBe(0);
	expect(br.state().status).toBe("closed");
	expect(br.state().closed_transition).toContain("Lesson: explicit reviewer finding");
	expect(br.state().closed_transition).not.toContain("fixture review");
});

test("LESSONPAYLOAD1 refused final act reports ACT_FAILED and restores original boxes", async () => {
	const { dir, sha } = await repo("lesson-act-failed");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "close kit-1", failMessage: `policy denies final close ${"detail ".repeat(80)}ACTION_STDERR_END` });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.replays.map(r => r.pass)).toEqual([true]);
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("policy denies final close");
	expect(res.log).toContain("ACTION_STDERR_END");
	expect(res.rollback).toMatchObject({ status: "RESTORED" });
	expect(br.state().status).toBe("in_review");
	expect(br.state().acceptance_criteria).toBe(acceptance);
});

test("LESSONPAYLOAD1 genuine failed replay remains REWORK with its named box", async () => {
	const { dir, sha } = await repo("lesson-real-rework");
	const br = fakeBr(inReview("- [ ] [b] [build] `sh scripts/bad.sh` -> prints PASS"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["b", false]]);
	expect(res.log).toContain("[b]");
	expect(br.state().status).toBe("rework");
});

test("VERIFYENV1 product: caller tracker selectors and agent-bin entries never reach replay; clean control is unchanged", async () => {
	const { dir, sha } = await repo("verifyenv-scrub", { "env.sh": [
		"#!/bin/sh",
		"[ \"${BEADS_DIR+x}\" != x ] && [ \"${BEADS_DB+x}\" != x ] || exit 21",
		"case \":$PATH:\" in *\"/agent-bin:\"*) exit 22;; esac",
		"[ \"$VERIFY_CONTROL\" = preserved ] || exit 23",
		"printf 'SCRUB_OK\\n'",
	].join("\n") + "\n" });
	for (const planted of [false, true]) {
		const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/env.sh` -> prints SCRUB_OK"));
		const cleanPath = br.env.PATH!.split(delimiter).filter(dir => dir.split("/").filter(Boolean).at(-1) !== "agent-bin").join(delimiter);
		const res = await verifyBead({
			bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer",
			env: { ...br.env, PATH: cleanPath, VERIFY_CONTROL: "preserved", ...(planted ? {
				BEADS_DIR: join(base, "caller", ".beads"), BEADS_DB: join(base, "caller", ".beads", "beads.db"),
				PATH: `${join(base, "agent-bin")}:${cleanPath}:${join(base, "other", "agent-bin")}`,
			} : {}) },
		});
		expect(res.code).toBe("CLOSED");
		expect(res.replays.map(r => r.pass)).toEqual([true]);
	}
});

test("VERIFYENV1 product: failed CLI box retains complete raw output after export cleanup, with per-box evidence references", async () => {
	// More than 24 KiB, including invalid UTF-8: the middle is absent from the 4,000-char display.
	const stdout = Buffer.concat([Buffer.from("HEAD\n"), Buffer.alloc(12_000, 120), Buffer.from("\nMIDDLE_WITNESS\n"), Buffer.alloc(12_000, 121), Buffer.from([0xff]), Buffer.from("\nTAIL\n")]);
	const stderr = Buffer.from("stderr witness\n");
	const script = `import { writeSync } from "node:fs"; writeSync(1, Buffer.from("${stdout.toString("base64")}", "base64")); writeSync(2, Buffer.from("${stderr.toString("base64")}", "base64")); process.exit(1);\n`;
	const { dir, sha } = await repo("verifyenv-evidence", { "large.ts": script });
	const br = fakeBr(inReview("- [ ] [a] [build] `bun scripts/large.ts` -> exit 0\n- [ ] [b] [build] `bun scripts/large.ts` -> prints NEVER"));
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	expect(r.rc).toBe(1);
	const result = JSON.parse(new TextDecoder().decode(r.stdout)).data;
	expect(result.overall).toBe("REWORK");
	const exportLine = result.log.split("\n").find((line: string) => line.startsWith("exported "));
	expect(existsSync(exportLine.slice(exportLine.indexOf(" to ") + 4))).toBe(false);
	for (const box of result.replays) {
		expect(box.detail).toContain("chars omitted");
		expect(box.detail).not.toContain("MIDDLE_WITNESS");
		expect(box.output).toMatchObject({ bytes: stdout.length + stderr.length, complete: true });
		expect(readFileSync(box.output.path)).toEqual(Buffer.concat([stdout, stderr]));
		expect(readFileSync(join(dirname(box.output.path), ".owner"), "utf8")).toContain("bead=kit-1");
		expect(result.acts[0].join(" ")).toContain(box.output.path);
	}
	expect(result.replays[0].output.path).not.toBe(result.replays[1].output.path);
});

test("VERIFYENV1 product: evidence measures the 8 MiB capture ceiling and labels over-limit output incomplete", async () => {
	const cap = 4 * 1024 * 1024;
	const { dir, sha } = await repo("verifyenv-bound", {
		"bound.ts": 'import { writeFileSync } from "node:fs"; const n = Number(process.argv[2]); writeFileSync(1, Buffer.alloc(n, 120)); writeFileSync(2, Buffer.alloc(n, 121)); process.exit(1);\n',
	});
	for (const n of [cap, cap + 1]) {
		const br = fakeBr(inReview(`- [ ] [a] [build] \`bun scripts/bound.ts ${n}\` -> exit 0`));
		const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
		expect(res.code).toBe("REWORK");
		const output = res.replays[0]!.output!;
		expect(output.bytes).toBe(2 * cap);
		expect(output.complete).toBe(n === cap);
		const bytes = readFileSync(output.path);
		expect(bytes).toEqual(Buffer.concat([Buffer.alloc(cap, 120), Buffer.alloc(cap, 121)]));
		if (n > cap) {
			expect(res.replays[0]!.detail).toContain("OUTPUT_LIMIT");
			expect(res.replays[0]!.detail).toContain("INCOMPLETE");
		}
		console.error(`VERIFYENV1 evidence emitted=${2 * n} retained=${bytes.length} complete=${output.complete}`);
	}
}, fixtureDeadlineS(60) * 1_000);

test("LESSONPAYLOAD1 rollback refusal reports the unmet atomic boundary honestly", async () => {
	const { dir, sha } = await repo("lesson-rollback-refused");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: ["close kit-1", "--acceptance-criteria"], failMessage: "tracker refuses close and restoration" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.rollback).toMatchObject({ status: "ROLLBACK_REFUSED" });
	expect(res.log).toContain("tracker refuses close and restoration");
	expect(br.state().status).toBe("in_review");
	// This is an observed counterexample to the original [b], not atomicity qualification.
	console.error(`LESSONPAYLOAD1[b] counterexample: original boxes unchanged=${br.state().acceptance_criteria === acceptance}; no [b] PASS claimed`);
});

test("LESSONPAYLOAD1 an update committed before its nonzero exit is not reported as untouched", async () => {
	const { dir, sha } = await repo("lesson-update-committed");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "--check-acceptance", commitBeforeRefusal: true, failMessage: "post-commit export refused" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("post-commit export refused");
	expect(res.rollback).toMatchObject({ status: "RESTORED" });
	expect(br.state().acceptance_criteria).toBe(acceptance);
	expect(br.state().status).toBe("in_review");
});

test("LESSONPAYLOAD1 concurrent acceptance is preserved and reported STATE_UNPROVEN", async () => {
	const { dir, sha } = await repo("lesson-peer-acceptance");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const peerAcceptance = "- [ ] [c] [build] peer's revised obligation `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "close kit-1", refusalAcceptance: peerAcceptance });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.rollback).toMatchObject({ status: "STATE_UNPROVEN" });
	expect(br.state().acceptance_criteria).toBe(peerAcceptance);
	expect(br.state().status).toBe("in_review");
});

test("LESSONPAYLOAD1 live readback closes with its author's lesson and preserves the verified source", async () => {
	const { dir } = await repo("lesson-live");
	const acceptance = "- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(br.state().acceptance_criteria).toBe("- [x] [c] [live] `sh scripts/t.sh` -> 0 fail");
	expect(br.state().closed_transition).toContain("Lesson: fixture review");
	expect(br.state("kit-source").status).toBe("closed");
});

test("LESSONPAYLOAD1 live missing lesson refuses before replay", async () => {
	const marker = join(base, "live-missing-lesson");
	const { dir } = await repo("lesson-live-missing", { "entered.sh": "#!/bin/sh\nprintf entered > \"$LESSON_REPLAY_MARKER\"\nprintf '0 fail\\n'\n" });
	const acceptance = "- [ ] [c] [live] `sh scripts/entered.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead], comments: [] });
	const before = br.state();
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: { ...br.env, LESSON_REPLAY_MARKER: marker } });
	expect(res.code).toBe("LESSON_MISSING");
	expect(res.replays).toEqual([]);
	expect(existsSync(marker)).toBe(false);
	expect(br.state()).toEqual(before);
});

test("LESSONPAYLOAD1 CLI live-all refused act is nonzero ACT_FAILED with boxes unchanged", async () => {
	const { dir } = await repo("lesson-live-act");
	const acceptance = "- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead], failOn: "close kit-live", failMessage: "readback close refused" });
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "--live-readback", "--all", "--project", dir, "--actor", "Peer", "--lesson", "readback evidence", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	const result = JSON.parse(new TextDecoder().decode(r.stdout));
	expect(r.rc).toBe(2);
	expect(result.data.results.map((row: { code: string }) => row.code)).toEqual(["ACT_FAILED"]);
	expect(result.data.results[0].log).toContain("readback close refused");
	expect(br.state().status).toBe("open");
	expect(br.state().acceptance_criteria).toBe(acceptance);
	expect(br.state("kit-source").status).toBe("closed");
});

test("LESSONPAYLOAD1 empty CLI lesson is rejected without replay", async () => {
	const { dir, sha } = await repo("lesson-empty");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const before = br.state();
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--lesson", "", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	const result = JSON.parse(new TextDecoder().decode(r.stdout));
	expect(r.rc).toBe(2);
	expect(result.errors[0].code).toBe("MISSING_VALUE");
	expect(br.state()).toEqual(before);
});

test("verify closes a bead whose boxes name commands with expected outcomes: replays on the export, ticks, gate, close with the command log; family disclosed", async () => {
	const { dir, sha } = await repo("good");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/t.sh` expect: prints 0 fail\n- [ ] [v] [live] Verification: a non-author replays."), { extraBeads: [{ ...fixtureEpic, id: "ompkit-kup44" }] });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, family: "same (claude)" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true]]);
	const acts = br.acts();
	// CLOSEPASS1: the unticked [v] box moves into a LIVEREADBACK child so br's close policy admits the close.
	expect(acts[0]).toStartWith("create LIVEREADBACK: kit-1 -t task -l live-readback --parent ompkit-kup44 --deps related:kit-1 --description WHAT: read back");
	expect(acts[0]).toContain("--acceptance-criteria - [ ] [v] [live] Verification: a non-author replays. --json --actor Peer");
	expect(acts[1]).toStartWith("update kit-1 --description \n\n## Original acceptance (before omp-kit verify moved [v] to kit-1.1)");
	expect(acts[1]).toEndWith("--acceptance-criteria - [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/t.sh` expect: prints 0 fail --actor Peer");
	expect(acts[2]).toBe("update kit-1 --check-acceptance 1,2 --actor Peer");
	expect(acts[3]).toBe("gate report kit-1 --gate min_reviewers --provider reviewer:Peer --status pass --to closed --actor Peer");
	expect(acts[4]).toStartWith("close kit-1 --reason verified by Peer (family: same (claude)) on export " + sha);
	expect(acts[4]).toContain("--actor Peer");
	expect(acts[4]).toContain("[a] sh scripts/t.sh -> summary 16 pass 0 fail: found");
	expect(acts[4]).toContain("deferred [v] to kit-1.1 (LIVEREADBACK, child of lane parent ompkit-kup44, because kit-1 has no active parent, related to kit-1)");
	expect(acts[4]).toContain("Lesson: fixture review");
	expect(acts).toHaveLength(5);
	expect(res.child).toBe("kit-1.1");
});
test("VERIFYDEDUP1: runs each distinct replay command once and judges every box with visible progress", async () => {
	const sharedCount = join(base, "shared-runs");
	const distinctCount = join(base, "distinct-runs");
	const release = join(base, "release");
	const { dir, sha } = await repo("dedup", {
		"shared.sh": "#!/bin/sh\nwhile [ ! -e \"$VERIFY_RELEASE\" ]; do :; done\nprintf x >> \"$VERIFY_SHARED_COUNT\"\nprintf 'alpha beta gamma\\n'\n",
		"distinct.sh": "#!/bin/sh\nprintf x >> \"$VERIFY_DISTINCT_COUNT\"\nprintf 'delta\\n'\n",
	});
	const acceptance = [
		"- [ ] [a] [landed] `sh scripts/shared.sh` -> alpha",
		"- [ ] [b] [landed] `sh scripts/shared.sh` -> not present",
		"- [ ] [c] [landed] `sh scripts/shared.sh` -> gamma",
		"- [ ] [d] [landed] `sh scripts/distinct.sh` -> delta",
	].join("\n");
	const br = fakeBr(inReview(acceptance));
	let released = false;
	let seenProgress = "";
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--dry-run", "--json"], {
		cwd: base,
		deadline_s: fixtureDeadlineS(10),
		env: { ...process.env, ...br.env, VERIFY_SHARED_COUNT: sharedCount, VERIFY_DISTINCT_COUNT: distinctCount, VERIFY_RELEASE: release },
		on_output: (stream, chunk) => {
			if (stream !== "stderr" || released) return;
			seenProgress += new TextDecoder().decode(chunk);
			if (seenProgress.includes("verify progress [a]")) {
				released = true;
				writeFileSync(release, "continue");
			}
		},
	});
	expect(released).toBe(true);
	expect(r.rc).toBe(0);
	expect(readFileSync(sharedCount, "utf8")).toBe("x");
	expect(readFileSync(distinctCount, "utf8")).toBe("x");
	const output = JSON.parse(new TextDecoder().decode(r.stdout)) as { data: { replays: { letter: string; expected: string; pass: boolean }[] } };
	expect(output.data.replays.map(({ letter, expected, pass }) => [letter, expected, pass])).toEqual([
		["a", "alpha", true], ["b", "not present", false], ["c", "gamma", true], ["d", "delta", true],
	]);
	expect(new TextDecoder().decode(r.stdout)).not.toContain("verify progress");
	const progress = new TextDecoder().decode(r.stderr).trim().split("\n");
	expect(progress).toHaveLength(4);
	for (const [index, letter] of ["a", "b", "c", "d"].entries()) {
		expect(progress[index]).toContain(`[${letter}]`);
		expect(progress[index]).toContain("elapsed=");
		expect(progress[index]).toContain("verdict=");
	}
	expect(progress[0]).toContain("final_verdict=PASS");
	expect(progress[1]).toContain("verdict=FAIL");
	expect(progress[2]).toContain("verdict=PASS");
	expect(progress[3]).toContain("final_verdict=PASS");
});


test("planted: a dotted bead id proceeds past scratch allocation with the exact bead identity preserved (constant label, unchanged metadata)", async () => {
	const { dir, sha } = await repo("dotted");
	const br = fakeBr({ ...inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"), id: "kit-1.2" });
	const res = await verifyBead({ bead: "kit-1.2", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("exported " + sha);
});

test("planted: an unresolvable bead names the unmet tracker prerequisite and writes nothing", async () => {
	const { dir, sha } = await repo("missing");
	const bin = join(base, "bin-noshow");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "br"), "#!/bin/sh\nprintf 'ISSUE_NOT_FOUND' >&2\nexit 3\n");
	chmodSync(join(bin, "br"), 0o755);
	const res = await verifyBead({ bead: "kit-9.9", exportSha: sha, repo: dir, actor: "Peer", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
	expect(res.code).toBe("NOT_IN_REVIEW");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(res.log).toContain("kit-9.9");
	expect(res.log).toContain("unmet prerequisite");
});

test("planted: the author's own seat is refused NON_AUTHOR_REQUIRED and nothing is run", async () => {
	const { dir, sha } = await repo("self");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Author", env: br.env });
	expect(res.code).toBe("NON_AUTHOR_REQUIRED");
	expect(res.replays).toEqual([]);
	expect(br.acts()).toEqual([]);
});

test("planted: a box naming no command is ACCEPTANCE_NOT_REPLAYABLE and the bead is sent back to intake, not closed", async () => {
	const { dir, sha } = await repo("noreplay");
	const br = fakeBr(inReview("- [ ] [a] [landed] the feature works and the UI looks right\n- [ ] [b] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[a] names no command");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
	expect(br.acts()).toEqual([]);
});

test("planted: a box whose command fails sets REWORK naming the box; exit 0 with the wrong output also fails (named outcome beats exit code)", async () => {
	const { dir, sha } = await repo("rework");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/bad.sh` -> prints PASS\n- [ ] [c] [landed] `sh scripts/t.sh` -> 99 pass"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", false], ["c", false]]);
	const acts = br.acts();
	expect(acts).toHaveLength(1);
});

test("planted: a box whose first backticked span is not followed by -> or expect: is ACCEPTANCE_NOT_REPLAYABLE and never runs (quoted obligation text)", async () => {
	const { dir, sha } = await repo("exitonly");
	const br = fakeBr(inReview("- [ ] [a] [landed] the seat runs `br update <id> --status in_review` after `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.replays).toEqual([]);
	expect(res.log).toContain("[a] first backticked span \"br update <id> --status in_review\" is not followed by -> <expected> or expect: <expected>");
	expect(br.acts()).toEqual([]);
});

test("planted: a box with -> in its obligation text before the command is ACCEPTANCE_NOT_REPLAYABLE and never runs (arrow-before-command)", async () => {
	const { dir, sha } = await repo("arrowfirst");
	const br = fakeBr(inReview("- [ ] [a] [landed] status open -> in_review is recorded `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.replays).toEqual([]);
	expect(res.log).toContain("[a] has -> before its first backticked span \"sh scripts/t.sh\"");
	expect(br.acts()).toEqual([]);
});

test("expectedOf reads only the outcome right after the first backticked span, never an earlier or later arrow", () => {
	expect(expectedOf("status open -> in_review `sh scripts/t.sh` -> 16 pass 0 fail")).toBe("16 pass 0 fail");
	expect(expectedOf("Replay `sh scripts/t.sh` expect: prints ok; then open -> closed")).toBe("prints ok");
	expect(expectedOf("`sh scripts/t.sh` runs; open -> closed")).toBeNull();
	expect(expectedOf("`sh scripts/t.sh` ->; planted")).toBeNull();
	expect(expectedOf("open -> closed, no command")).toBeNull();
});

test("the verify handler is registered at module load (planted: a registration left inside another function is HANDLER_UNAVAILABLE)", async () => {
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--json"], { cwd: base, deadline_s: fixtureDeadlineS(120) });
	const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
	expect(text).not.toContain("HANDLER_UNAVAILABLE");
	expect(text).toContain("--export");
});

test("phase-only GATESET1 boxes parse with retained order, checked state and build phase", () => {
	const boxes = parseBoxes("- [x] [build] Planted: a prompt whose lint run exits non-zero yields a FAIL receipt naming 'lint did not run: <err>' and exit 1, never a traceback (test in prompt_gate.py --selftest).\n- [x] [build] Every gate's detail is JSON-serializable: the selftest dumps every receipt it builds with json.dumps.");
	expect(boxes.map(b => [b.index, b.letter, b.checked, b.phase])).toEqual([[1, null, true, "build"], [2, null, true, "build"]]);
});

test("planted: a mandatory-letter-only parser finds no phase-only boxes (would drop them)", () => {
	const text = "- [x] [build] Planted: a prompt whose lint run exits non-zero yields a FAIL receipt naming 'lint did not run: <err>' and exit 1, never a traceback (test in prompt_gate.py --selftest).\n- [x] [build] Every gate's detail is JSON-serializable: the selftest dumps every receipt it builds with json.dumps.";
	expect(text.split("\n").filter(l => /^- \[[ xX]\] \[[a-z]\]/.test(l.trim()))).toEqual([]);
	expect(parseBoxes(text).map(b => [b.index, b.phase])).toEqual([[1, "build"], [2, "build"]]);
});

test("legacy lettered boxes keep their meaning and untagged prose stays out", () => {
	const boxes = parseBoxes("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] prose without tags is not a box\n- [x] [b] body without phase");
	expect(boxes.map(b => [b.index, b.letter, b.phase])).toEqual([[1, "a", "landed"], [2, "b", null]]);
});

test("planted: an unsupported tag is named and fails closed, never silently dropped", async () => {
	const { dir, sha } = await repo("badphase");
	const br = fakeBr(inReview("- [ ] [zzz] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [build] [a] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] unsupported phase [zzz]");
	expect(res.log).toContain("[2] unsupported phase [build a]");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
	expect(br.acts()).toEqual([]);
});

test("planted: a commandless phase-only box is named and fails closed", async () => {
	const { dir, sha } = await repo("nocommand");
	const br = fakeBr(inReview("- [ ] [build] prose names no command"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] names no command");
});

test("planted: a refusal names the indexed box and leaves the tracker's bead and acceptance text untouched", async () => {
	const ac = "- [ ] [build] prose names no command";
	const bead = inReview(ac);
	const { dir, sha } = await repo("untouched");
	const br = fakeBr(bead);
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] names no command");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
	expect(br.acts()).toEqual([]);
	expect(bead.acceptance_criteria).toBe(ac);
});

test("phase-only boxes replay their literal command and are judged by the named outcome", async () => {
	const { dir, sha } = await repo("phaseonly");
	const br = fakeBr(inReview("- [ ] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [x] [build] `sh scripts/t.sh` expect: prints 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, null, true], [2, null, true]]);
	const acts = br.acts();
	expect(acts[0]).toBe("update kit-1 --check-acceptance 1,2 --actor Peer");
	expect(br.state().status).toBe("closed");
	expect(br.state().acceptance_criteria).toBe("- [x] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [x] [build] `sh scripts/t.sh` expect: prints 0 fail");
});

test("live and after items are not executed and never passed; with an executed box passing they defer to the LIVEREADBACK child (CLOSEPASS1)", async () => {
	const { dir, sha } = await repo("pending");
	const br = fakeBr({ ...inReview("- [ ] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail"), parent: fixtureEpic.id }, { extraBeads: [fixtureEpic] });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, null, true], [2, "a", null], [3, null, null]]);
	expect(res.log).toContain("[a] PENDING live phase prerequisite unmet; not executed");
	expect(res.log).toContain("[3] PENDING after phase prerequisite unmet; not executed");
	expect(br.acts()[0]).toContain("--acceptance-criteria - [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail --json");
	expect(br.acts()[2]).toBe("update kit-1 --check-acceptance 1 --actor Peer");
	expect(br.state().status).toBe("closed");
	expect(br.state(res.child)).toMatchObject({ status: "open", parent: fixtureEpic.id, acceptance_criteria: "- [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail" });
});

test("a failed phase-only expectation stays REWORK even when the command exits 0", async () => {
	const { dir, sha } = await repo("phaseonlyrework");
	const br = fakeBr(inReview("- [ ] [build] `sh scripts/t.sh` -> 99 pass"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.index, r.pass])).toEqual([[1, false]]);
});

test("[v] verification notes stay skipped even when they carry a phase", async () => {
	const { dir, sha } = await repo("vskip");
	const br = fakeBr({ ...inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [v] [live] Verification: a non-author replays the original command."), parent: fixtureEpic.id }, { extraBeads: [fixtureEpic] });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, "a", true]]);
});

test("planted: an unknown export sha fails closed as UNKNOWN with no replays and no acts", async () => {
	const { dir } = await repo("badexport");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: "deadbeef".repeat(5).slice(0, 40), repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("UNKNOWN");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(br.acts()).toEqual([]);
});
test("planted: a failing reviewer-gate report fails the close as ACT_FAILED naming the act, never a silent pass", async () => {
	const { dir, sha } = await repo("gaterefail");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"), { failOn: "gate" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("act failed");
	expect(res.log).toContain("gate report");
});


/* REPLAYBR1 (ompkit-t7cn7.21): real-tracker fixtures for the per-run read-only
   replay barrier. These use the production br binary and real trackers in
   owned scratch, never the fake br above and never the shared K tracker. */

async function brun(args: string[], cwd: string, env?: Record<string, string>): Promise<{ rc: number | null; out: string }> {
	const merged = { ...process.env, ...(env ?? {}) } as Record<string, string>;
	const r = await run(["br", ...args], { cwd, deadline_s: fixtureDeadlineS(60), env: merged });
	return { rc: r.rc, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

/** A real tracker in owned scratch, initialized with no inherited binding. */
async function tracker(name: string): Promise<{ dir: string; db: string }> {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	const env = { ...process.env } as Record<string, string>;
	delete env.BEADS_DB;
	const r = await run(["br", "init", "--db", join(dir, ".beads", "beads.db")], { cwd: dir, deadline_s: fixtureDeadlineS(60), env });
	if (r.rc !== 0) throw new Error(`br init -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return { dir, db: join(dir, ".beads", "beads.db") };
}

/** One tracker per named group of tests that each create their own beads and only compare state they
 * captured after their own setup; a test that counts or lists the whole tracker keeps its own. */
const sharedTrackers = new Map<string, Promise<{ dir: string; db: string }>>();
function sharedTracker(name: string, setup?: (t: { dir: string; db: string }) => Promise<void>): Promise<{ dir: string; db: string }> {
	let created = sharedTrackers.get(name);
	if (created === undefined) {
		created = tracker(name).then(async t => { await setup?.(t); return t; });
		sharedTrackers.set(name, created);
	}
	return created;
}

function trackerEnv(t: { dir: string; db: string }): Record<string, string> {
	return { ...process.env, BEADS_DB: t.db } as Record<string, string>;
}

/** `fields` are br create flags (description, acceptance, assignee, parent) set in the create act itself. */
async function createBead(t: { dir: string; db: string }, title: string, fields: string[] = []): Promise<string> {
	const env = { ...process.env, BEADS_DB: t.db } as Record<string, string>;
	const created = await brun(["create", title, ...fields, "--json"], t.dir, env);
	if (created.rc !== 0) throw new Error(`create -> ${created.rc}: ${created.out}`);
	const parsed: unknown = JSON.parse(created.out);
	const id = typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string" ? parsed.id : null;
	if (id === null) throw new Error(`create returned no id: ${created.out.slice(0, 200)}`);
	return id;
}

/** A second tracker bound inside the code repo itself (the same-repo control). */
async function trackerInRepo(cdir: string): Promise<{ dir: string; db: string }> {
	const env = { ...process.env } as Record<string, string>;
	delete env.BEADS_DB;
	const r = await brun(["init", "--db", join(cdir, ".beads", "beads.db")], cdir, env);
	if (r.rc !== 0) throw new Error(`in-repo init -> ${r.rc}: ${r.out}`);
	return { dir: cdir, db: join(cdir, ".beads", "beads.db") };
}

test("BRINITPIN1 verify tracker init leaves ancestor tracker unchanged; unpinned native control changes it", async () => {
	const parent = await createParentTracker(base, "br-init-parent");
	const before = parent.snapshot();
	await tracker(join("br-init-parent", "nested", "child"));
	expect(parent.snapshot()).toEqual(before);
	const negative = await runUnpinnedInitControl(base, "verify-negative");
	expect(negative.rc).toBe(0);
	expect(negative.parentChanged).toBe(true);
	expect(negative.newLocks.length).toBeGreaterThan(0);
});

const REPLAY_DESC = "WHAT: owned replay-barrier fixture.\n\nWHY: proves the per-run read-only dispatch admits intended reads and refuses production writes.\n\n## Pitfalls\n- a production tracker write must stay refused";

/** Description, acceptance, label, per-box ticks and the in_review transition. */
async function shapeBead(t: { dir: string; db: string }, id: string, ac: string): Promise<void> {
	const shaped = await brun(["update", id, "--description", REPLAY_DESC, "--acceptance", ac, "--add-label", "kind:fix"], t.dir, trackerEnv(t));
	if (shaped.rc !== 0) throw new Error(`shape -> ${shaped.rc}: ${shaped.out}`);
	await readyBead(t, id, ac);
}

/** shapeBead for acceptance that does not name its own bead: the fields go in the create act. */
async function shapedBead(t: { dir: string; db: string }, title: string, ac: string): Promise<string> {
	const id = await createBead(t, title, ["--description", REPLAY_DESC, "--acceptance-criteria", ac, "--labels", "kind:fix"]);
	await readyBead(t, id, ac);
	return id;
}

async function readyBead(t: { dir: string; db: string }, id: string, ac: string): Promise<void> {
	const env = trackerEnv(t);
	const n = ac.split("\n").filter(l => l.trim().startsWith("- [")).length;
	// One tick act for every box: the same end state as per-box ticks, one br write instead of n.
	const ticked = await brun(["update", id, "--check-acceptance", Array.from({ length: n }, (_, i) => i + 1).join(",")], t.dir, env);
	if (ticked.rc !== 0) throw new Error(`tick 1-${n} -> ${ticked.rc}: ${ticked.out}`);
	const ready = await brun(["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"], t.dir, env);
	if (ready.rc !== 0) throw new Error(`in_review -> ${ready.rc}: ${ready.out}`);
}

function snap(t: { dir: string }): string {
	return readFileSync(join(t.dir, ".beads", "issues.jsonl"), "utf8");
}

/** Read-only journal mode of a tracker db; a hot-journal recovery would itself be a mutation, so clean fixtures only. */
function journalMode(dbPath: string): string {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("PRAGMA journal_mode;").get() as Record<string, unknown> | null;
		const value = row === null ? null : Object.values(row)[0];
		if (typeof value !== "string" || value.length === 0) throw new Error(`no journal_mode for ${dbPath}`);
		return value;
	} finally {
		db.close();
	}
}

/** Whole-tracker state: journal plus the authoritative sqlite bytes plus live WAL content and journal mode, read synchronously. A mutation visible only in WAL is observed; br startup auto-import/recovery would show here too. SHM holds volatile lock state, so only its presence and size are witnessed, never its bytes. */
function stateHash(t: { dir: string }): string {
	const beadsDir = join(t.dir, ".beads");
	const h = createHash("sha256");
	h.update(readFileSync(join(beadsDir, "issues.jsonl")));
	h.update(readFileSync(join(beadsDir, "beads.db")));
	const wal = join(beadsDir, "beads.db-wal");
	h.update(existsSync(wal) ? readFileSync(wal) : "ABSENT:beads.db-wal");
	const shm = join(beadsDir, "beads.db-shm");
	h.update(existsSync(shm) ? `PRESENT:${readFileSync(shm).length}` : "ABSENT:beads.db-shm");
	h.update(`journal_mode:${journalMode(join(beadsDir, "beads.db"))}`);
	return h.digest("hex");
}

test("REPLAYBR1 AC1: intended tracker reads admitted while exact code export replays its probe; explicitly bound and same-repo reads admitted", async () => {
	const { dir: cdir, sha } = await repo("barrier-pos", {}, true);
	const t = await sharedTracker("replay-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier positive probe");
	const tin = await trackerInRepo(cdir);
	const idin = await createBead(tin, "same-repo probe");
	const ac = `- [ ] [a] [build] computed behavior probe: \`sh scripts/probe.sh\` -> probe 5050 ok\n- [ ] [b] [build] admitted explicit read: \`br --db "${t.db}" show ${id} --json\` -> ${id}\n- [ ] [c] [build] admitted explicitly bound read: \`BEADS_DB="${t.db}" br show ${id} --json\` -> ${id}\n- [ ] [d] [build] admitted same-repo read: \`br --db "${tin.db}" show ${idin} --json\` -> ${idin}`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const beforeHash = stateHash(t);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)", lesson: "replay-barrier fixture" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true], ["d", true]]);
	expect(res.log).toContain("exported " + sha);
	expect(snap(t)).toBe(before);
	expect(stateHash(t)).toBe(beforeHash);
});

test("REPLAYBR1 AC2: ordinary, env-stripped and inherited writes refused with the marker; T unchanged; owned write admitted; neutralization makes it fail", async () => {
	const { dir: cdir, sha } = await repo("barrier-neg");
	const t = await sharedTracker("replay-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier negative probe");
	const ac = `- [ ] [a] [build] ordinary explicit write refused: \`br --db "${t.db}" update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [b] [build] env-stripped write refused: \`env -u BEADS_DB br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [c] [build] implicit inherited write refused: \`br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [d] [build] admitted owned write: \`br --db "$OWNED_TRACKER_DB" create "owned probe"\` -> Created\n- [ ] [e] [build] owned readback: \`br --db "$OWNED_TRACKER_DB" list --json\` -> owned probe\n- [ ] [f] [build] export executes the computed behavior probe: \`sh scripts/probe.sh\` -> probe 5050 ok`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const beforeHash = stateHash(t);
	const beforeShow = (await brun(["show", id, "--json"], t.dir, envT)).out;
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)", lesson: "replay-barrier fixture" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true], ["d", true], ["e", true], ["f", true]]);
	expect(res.log).toContain("READONLY_TRACKER");
	expect(snap(t)).toBe(before);
	expect(stateHash(t)).toBe(beforeHash);
	expect((await brun(["show", id, "--json"], t.dir, envT)).out).toBe(beforeShow);
	const causalEnv = { ...process.env, BEADS_DB: t.db } as Record<string, string>;
	const causal = await brun(["update", id, "--add-label", "causal-proof"], t.dir, causalEnv);
	expect(causal.rc).toBe(0);
	expect(causal.out).toContain("Updated");
	expect((await brun(["show", id, "--json"], t.dir, causalEnv)).out).toContain("causal-proof");
});

test("REPLAYBR1 owned tracker init leaves its nearest ancestor tracker unchanged", async () => {
	const { dir: cdir, sha } = await repo("owned-init-project");
	const t = await sharedTracker("replay-t");
	const ac = `- [ ] [a] [build] admitted owned write: \`br --db "$OWNED_TRACKER_DB" create "owned probe"\` -> Created`;
	const id = await shapedBead(t, "owned replay init", ac);
	const parent = await createParentTracker(base, "owned-init-parent");
	const before = parent.snapshot();
	const previous = process.env.GRADE_WAVE_SCRATCH;
	process.env.GRADE_WAVE_SCRATCH = parent.dir;
	try {
		const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: trackerEnv(t), dryRun: true, family: "same (bun)", lesson: "owned-init fixture" });
		expect(res.code).toBe("DRY_RUN");
		expect(res.replays.map(replay => [replay.letter, replay.pass])).toEqual([["a", true]]);
		expect(parent.snapshot()).toEqual(before);
	} finally {
		if (previous === undefined) delete process.env.GRADE_WAVE_SCRATCH;
		else process.env.GRADE_WAVE_SCRATCH = previous;
	}
});

/* VERIFYACTOR1 (ompkit-t7cn7.24): native verify binds the explicit reviewer
   identity on every durable br mutation. The fixture tracker's default actor
   is forced away from the reviewer via USER, so the audit log distinguishes
   ambient acts from reviewer acts. These assert durable audit state, never
   argv echoes. Platform limit (probe-proven, JadeThrush 71537/71542): br
   records no audit event for --check-acceptance ticks (real or re-tick) or
   gate reports, so tick binding is evidenced by acts argv plus resulting
   state; close/status/comment/REWORK/intake/gate-provider carry durable
   reviewer proof. Fixtures pre-tick because shim lint AC_UNTICKED_BUILD_LANDED
   refuses unticked in_review entry. */

const REVIEWER = "Peer";
const AMBIENT = "AmbientDefault";

/** Env whose br default actor is ambient, never the reviewer. */
function ambientEnv(db: string): Record<string, string> {
	return { ...process.env, USER: AMBIENT, BEADS_DB: db } as Record<string, string>;
}

/** Minimal strict workflow so the close path runs: open->in_progress->in_review->closed with min_reviewers on the final edge. */
async function actorPolicy(t: { dir: string }): Promise<void> {
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed]
    in_progress: [in_review, open]
    in_review: [closed, rework, open]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
  gates:
    "in_review -> closed":
      require_all:
        - min_reviewers: 1
`);
}

/** Create a fixture bead with its fields, then move it through the gated path as ambient/tester setup acts. */
async function actorBead(t: { dir: string; db: string }, title: string, ac: string): Promise<string> {
	const env = ambientEnv(t.db);
	const desc = "WHAT: verifyactor1 fixture.\n\nWHY: proves native verify binds the reviewer identity on durable mutations.\n\n## Pitfalls\n- the reviewer identity must come from native verify";
	const id = await createBead(t, title, ["--description", desc, "--acceptance-criteria", ac, "--labels", "kind:fix", "--assignee", "Author"]);
	const moves: string[][] = [
		["update", id, "--status", "in_progress", "--transition-comment", "fixture start"],
		["update", id, "--check-acceptance", "1"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"],
	];
	for (const m of moves) {
		const r = await brun(m, t.dir, env);
		if (r.rc !== 0) throw new Error(`${m.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out.slice(0, 300)}`);
	}
	return id;
}

async function auditActors(t: { dir: string; db: string }, id: string): Promise<{ event_type: string; actor: string }[]> {
	const r = await brun(["audit", "log", id, "--json"], t.dir, ambientEnv(t.db));
	if (r.rc !== 0) throw new Error(`audit log -> ${r.rc}: ${r.out.slice(0, 300)}`);
	const doc = JSON.parse(r.out) as { events: { event_type: string; actor: string }[] };
	return doc.events.map(e => ({ event_type: e.event_type, actor: e.actor }));
}

test("VERIFYACTOR1 [a]: passing verify binds the reviewer on ticks, gate report and close; a same-tracker control bead is untouched", async () => {
	const { dir: cdir, sha } = await repo("actorpass");
	const t = await sharedTracker("actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const ac = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass";
	const id = await actorBead(t, "actor close probe", ac);
	const control = await actorBead(t, "actor control probe", ac);
	const beforeEvents = await auditActors(t, id);
	const controlBefore = (await brun(["show", control, "--json"], t.dir, envT)).out;
	const controlEventsBefore = await auditActors(t, control);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)", lesson: "reviewer identity fixture" });
	expect(res.code).toBe("CLOSED");
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	const fresh = afterEvents.slice(0, afterEvents.length - beforeEvents.length);
	for (const e of fresh) expect(e.actor).toBe(REVIEWER);
	const kinds = fresh.map(e => e.event_type);
	expect(kinds).toContain("closed");
	// Durable reviewer-report proof: the gate result itself names the reviewer provider (audit log carries no gate-report event; probe-proven).
	const gates = JSON.parse((await brun(["gate", "list", id, "--json"], t.dir, envT)).out) as unknown;
	const gateText = JSON.stringify(gates);
	expect(gateText).toContain(`reviewer:${REVIEWER}`);
	expect(gateText).toContain("pass");
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; notes: string }[];
	expect(shown[0]!.status).toBe("closed");
	expect((await brun(["show", control, "--json"], t.dir, envT)).out).toBe(controlBefore);
	expect(await auditActors(t, control)).toEqual(controlEventsBefore);
});

test("VERIFYACTOR1 [a]: failing probe REWORK carries the reviewer identity, never the ambient default", async () => {
	const { dir: cdir, sha } = await repo("actorrework");
	const t = await sharedTracker("actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor rework probe", "- [ ] [a] [build] `sh scripts/bad.sh` -> prints PASS");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)", lesson: "replay-failure identity fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.acts[0]).toEqual(["br", "update", id, "--status", "rework", "--transition-comment", expect.stringContaining(`REWORK ${id}:`), "--actor", REVIEWER]);
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
});

test("VERIFYENV1: missing linked OMP identity preserves review state and acceptance; an assertion failure still becomes REWORK", async () => {
	const { dir: cdir, sha } = await repo("verifyenv-runtime");
	const runtimeTest = join(import.meta.dir, "kit-flywheel-guard-runtime.test.ts").replaceAll("'", "'\\''");
	const t = await sharedTracker("replay-t");
	const ac = "- [ ] [a] [build] `bun test '" + runtimeTest + "' -t 'linked OMP plugin'` -> 1 pass 0 fail";
	const id = await shapedBead(t, "linked runtime environment", ac);
	const before = await row(t, id);
	const res = await verifyBead({
		bead: id, exportSha: sha, repo: cdir, actor: "Peer", lesson: "environment classification fixture",
		env: { ...trackerEnv(t), OMP_BIN: join(base, "missing-omp-launcher") },
	});
	expect(res.code).toBe("ENVIRONMENT");
	expect(res.ok).toBe(false);
	expect(res.log).toContain("OMP_BIN launcher cannot be resolved");
	const after = await row(t, id);
	expect(after.status).toBe(before.status);
	expect(after.acceptance_criteria).toBe(before.acceptance_criteria);
	expect(after.labels).toContain("needs-director");
	// A broken ambient override alone cannot turn an unrelated product failure into an environment refusal.
	const broken = await shapedBead(t, "actual assertion failure", "- [ ] [a] [build] `bun -e 'import { strict as assert } from \"node:assert\"; assert.equal(2 + 2, 5)'` -> prints PASS");
	const failed = await verifyBead({
		bead: broken, exportSha: sha, repo: cdir, actor: "Peer", lesson: "assertion classification fixture",
		env: { ...trackerEnv(t), OMP_BIN: join(base, "missing-omp-launcher") },
	});
	expect(failed.code).toBe("REWORK");
	expect((await row(t, broken)).status).toBe("rework");
	expect(failed.log).toContain("AssertionError");
	// A command can report both a missing environment prerequisite and a real assertion defect.
	const mixed = await shapedBead(t, "environment and assertion failure", "- [ ] [a] [build] `bun test '" + runtimeTest + "' -t 'linked OMP plugin'; bun -e 'import { strict as assert } from \"node:assert\"; assert.equal(2 + 2, 5)'` -> prints PASS");
	const mixedFailure = await verifyBead({
		bead: mixed, exportSha: sha, repo: cdir, actor: "Peer", lesson: "mixed failure fixture",
		env: { ...trackerEnv(t), OMP_BIN: join(base, "missing-omp-launcher") },
	});
	expect(mixedFailure.code).toBe("REWORK");
	expect((await row(t, mixed)).status).toBe("rework");
	expect(mixedFailure.log).toContain("AssertionError");
}, fixtureDeadlineS(120) * 1_000);

test("VERIFYACTOR1 [a]: explicit-author refusal and dry-run leave fixture state and audit untouched", async () => {
	const { dir: cdir, sha } = await repo("actoruntouched");
	const t = await sharedTracker("actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor untouched probe", "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass");
	const beforeHash = stateHash(t);
	const beforeEvents = await auditActors(t, id);
	const refused = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Author", env: envT, lesson: "self-author refusal fixture" });
	expect(refused.code).toBe("NON_AUTHOR_REQUIRED");
	expect(refused.acts).toEqual([]);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
	const dry = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, dryRun: true, family: "same (bun)", lesson: "dry-run identity fixture" });
	expect(dry.code).toBe("DRY_RUN");
	expect(dry.acts.length).toBeGreaterThan(0);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
});

test("VERIFYACTOR1 [a]: intake refusal binds the reviewer on the open/needs-intake mutation (durable)", async () => {
	const { dir: cdir, sha } = await repo("actorintake");
	const t = await sharedTracker("actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor intake probe", "- [ ] [a] [build] prose names no command");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)" });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.acts).toEqual([["br", "update", id, "--status", "open", "--add-label", "needs-intake", "--actor", REVIEWER]]);
	// verifyBead returns intake acts for the operator; execute them as the operator would, then prove durable reviewer binding.
	for (const a of res.acts) {
		const r = await run(a, { cwd: cdir, deadline_s: fixtureDeadlineS(60), env: envT });
		if (r.rc !== 0) throw new Error(`intake act -> ${r.rc}`);
	}
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; labels: string[] }[];
	expect(shown[0]!.status).toBe("open");
	expect(shown[0]!.labels).toContain("needs-intake");
});

test("VERIFYSCRATCH1: a replay's fixture tracker under $GRADE_WAVE_SCRATCH is admitted by the read-only br; outside the verify root it is still refused; planted: without the variable the same fixture is refused", async () => {
	const outside = testBase("verifyscratch-outside");
	const cdir = join(base, "verifyscratch");
	mkdirSync(join(cdir, "scripts"), { recursive: true });
	// grade_wave.py --selftest's shape: fixtures under GRADE_WAVE_SCRATCH when set, else a sibling dir of its own.
	writeFileSync(join(cdir, "scripts", "fx.sh"), [
		"#!/bin/sh",
		"set -eu",
		"root=\"${GRADE_WAVE_SCRATCH:-$1}\"",
		"d=\"$root/grade_wave_selftest.fx.$$\"",
		"mkdir -p \"$d\"",
		"cd \"$d\"",
		"br init",
		"created=$(br create \"verify scratch fixture\" --acceptance-criteria \"- [ ] fixture\" --silent --no-auto-import --no-auto-flush --actor selftest)",
		"listed=$(br show \"$created\" --json)",
		"case \"$listed\" in *\"verify scratch fixture\"*) ;; *) printf '%s\\n' \"$listed\"; exit 10;; esac",
		"printf '%s\\n' FIXTURE_OK",
	].join("\n") + "\n");
	await sh(["git", "init", "-q"], cdir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], cdir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], cdir);
	await publishHead(cdir, "verify-scratch");
	const sha = (await sh(["git", "rev-parse", "HEAD"], cdir)).trim();
	const t = await sharedTracker("replay-t");
	const ac = [
		`- [ ] [a] [build] selftest fixture under the verify scratch is admitted: \`sh scripts/fx.sh ${outside}\` -> prints FIXTURE_OK`,
		`- [ ] [b] [build] the same fixture outside the verify root is refused: \`mkdir -p ${outside}/direct && cd ${outside}/direct && br init --db ${outside}/direct/.beads/beads.db\` -> prints READONLY_TRACKER`,
		`- [ ] [c] [build] planted: with GRADE_WAVE_SCRATCH removed the first fixture is refused: \`env -u GRADE_WAVE_SCRATCH sh scripts/fx.sh ${outside}\` -> prints READONLY_TRACKER`,
	].join("\n");
	const id = await shapedBead(t, "verify scratch probe", ac);
	const beforeHash = stateHash(t);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: trackerEnv(t), dryRun: true, family: "same (bun)", lesson: "scratch boundary fixture" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass, r.detail.split(";")[0]])).toEqual([
		["a", true, "output contains \"FIXTURE_OK\""],
		["b", true, "output contains \"READONLY_TRACKER\""],
		["c", true, "output contains \"READONLY_TRACKER\""],
	]);
	expect(existsSync(join(outside, "direct", ".beads", "beads.db"))).toBe(false);
	expect(stateHash(t)).toBe(beforeHash);
}, fixtureDeadlineS(30) * 1_000);

/** br's own close policy, as the omp-kit tracker runs it: a close needs every acceptance box ticked and one reviewer. */
const CLOSE_POLICY = [
	"workflow:", "  strict: true", "  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]", "  transitions:",
	"    initial: [open]", "    open: [in_progress, blocked, deferred, closed]", "    in_progress: [in_review, open, blocked, deferred]",
	"    in_review: [closed, rework]", "    rework: [in_progress, in_review, open]", "    blocked: [open, in_progress]", "    deferred: [open]", "    closed: [open]",
	"  required_fields:", "    \"open -> in_progress\": [acceptance_criteria_present]", "    in_review: [acceptance_criteria_present, transition_comment]",
	"    closed: [acceptance_criteria, transition_comment]", "  gates:", "    \"in_review -> closed\":", "      require_all:", "        - min_reviewers: 1",
	"    \"open -> closed\":", "      require_all:", "        - min_reviewers: 1", "",
].join("\n");

async function policyTracker(name: string): Promise<{ dir: string; db: string }> {
	const t = await tracker(name);
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), CLOSE_POLICY);
	return t;
}

/** A bead Author built and moved to in_review under the policy, its boxes unticked, optionally under `parent`. */
async function reviewBead(t: { dir: string; db: string }, title: string, ac: string, parent?: string): Promise<string> {
	const env = trackerEnv(t);
	const id = await createBead(t, title, ["--description", "WHAT: closepass fixture.\n\nWHY: proves verify closes done work under the real close policy.", "--acceptance-criteria", ac, "--assignee", "Author", ...(parent ? ["--parent", parent] : [])]);
	for (const args of [
		["update", id, "--status", "in_progress", "--actor", "Author"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "Author"],
	]) {
		const r = await brun(args, t.dir, env);
		if (r.rc !== 0) throw new Error(`${args.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out}`);
	}
	return id;
}

async function row(t: { dir: string; db: string }, id: string): Promise<Record<string, unknown>> {
	const shown = await brun(["show", id, "--json"], t.dir, trackerEnv(t));
	return (JSON.parse(shown.out) as Record<string, unknown>[])[0]!;
}

const BUILD_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

/** A closed bead under `epic` and its open LIVEREADBACK child, through a real non-dry verify. */
async function closedWithChild(t: { dir: string; db: string }, repoDir: { dir: string; sha: string }, title: string, live: string, epic: string): Promise<{ id: string; child: string }> {
	const id = await reviewBead(t, title, `${BUILD_BOXES}\n${live}`, epic);
	const res = await verifyBead({ bead: id, exportSha: repoDir.sha, repo: repoDir.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "deferred readback fixture" });
	if (res.code !== "CLOSED" || res.child === undefined) throw new Error(`verify ${id} -> ${res.code}: ${res.log}`);
	return { id, child: res.child };
}

test("CLOSEPASS1: two passing [build] boxes and an unticked [live] box close under br's real policy with no --force; box 3 moves word for word into one open live-readback child of the bead's active parent, related to it and named in the close reason; an all-[live] bead stays PENDING with no child", async () => {
	const code = await repo("closepass");
	const t = await policyTracker("closepass-t");
	const env = trackerEnv(t);
	const live = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const ac = `${BUILD_BOXES}\n${live}`;
	// Planted negative: closing the old way (tick the run boxes, leave box 3 in the parent) is refused by br itself.
	const planted = await reviewBead(t, "closepass planted", ac);
	expect((await brun(["update", planted, "--check-acceptance", "1,2", "--actor", "Peer"], t.dir, env)).rc).toBe(0);
	expect((await brun(["gate", "report", planted, "--gate", "min_reviewers", "--provider", "reviewer:Peer", "--status", "pass", "--to", "closed", "--actor", "Peer"], t.dir, env)).rc).toBe(0);
	const refused = await brun(["close", planted, "--reason", "r", "--transition-comment", "c", "--actor", "Peer"], t.dir, env);
	expect(refused.rc).toBe(4);
	expect(refused.out).toContain("unchecked item(s) remain");
	const epic = await createBead(t, "closepass epic");
	const id = await reviewBead(t, "closepass parent", ac, epic);
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "close-policy fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.acts.flat()).not.toContain("--force");
	const parent = await row(t, id);
	const child = await row(t, res.child!);
	expect(parent.status).toBe("closed");
	expect(parent.acceptance_criteria).toBe(BUILD_BOXES.replaceAll("- [ ]", "- [x]"));
	expect(parent.description).toContain(`## Original acceptance (before omp-kit verify moved [c] to ${res.child})\n${ac}`);
	expect(JSON.stringify(parent)).toContain(`deferred [c] to ${res.child} (LIVEREADBACK, child of ${epic}, related to ${id})`);
	expect(child).toMatchObject({ status: "open", title: "LIVEREADBACK: closepass parent", acceptance_criteria: live, parent: epic, labels: [LIVE_READBACK_LABEL] });
	expect(child.dependencies).toContainEqual(expect.objectContaining({ id, dependency_type: "related" }));
	expect((await row(t, epic)).status).toBe("open");
	const allLive = await reviewBead(t, "closepass all live", live);
	const pending = await verifyBead({ bead: allLive, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "pending-phase fixture" });
	expect(pending.code).toBe("PENDING");
	expect(pending.child).toBeUndefined();
	expect(pending.acts).toEqual([]);
	expect((await row(t, allLive)).status).toBe("in_review");
	const children = JSON.parse((await brun(["list", "--status", "all", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], t.dir, env)).out) as { issues?: unknown[] } | unknown[];
	expect((Array.isArray(children) ? children : children.issues ?? []).length).toBe(1);
}, fixtureDeadlineS(120) * 1_000);
test("CLOSEPASS1: a commandless [v][build] judgement stays on the parent when executable build boxes pass", async () => {
	const code = await repo("closepass-v-build");
	const t = await policyTracker("closepass-v-build-t");
	const env = trackerEnv(t);
	const judgement = "- [ ] [v] [build] Judge whether the causal analysis is complete";
	const acceptance = `${BUILD_BOXES}\n${judgement}`;
	const epic = await createBead(t, "closepass v build epic");
	const id = await reviewBead(t, "closepass v build judgement", acceptance, epic);
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "build judgement fixture" });
	expect(res.code).toBe("PENDING");
	expect(res.log).toContain("[v] build judgement remains on the parent");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true]]);
	expect(res.child).toBeUndefined();
	expect(res.acts).toEqual([]);
	const parent = await row(t, id);
	expect(parent.status).toBe("in_review");
	expect(parent.acceptance_criteria).toBe(acceptance);
	const children = JSON.parse((await brun(["list", "--status", "all", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], t.dir, env)).out) as { issues?: unknown[] } | unknown[];
	expect(Array.isArray(children) ? children : children.issues ?? []).toHaveLength(0);
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1 no active parent: the child goes under the constraint lane's parent and the close reason says so; with no readable lane parent the bead stays PENDING and nothing is written", async () => {
	const code = await repo("closepass-lane");
	const t = await policyTracker("closepass-lane-t");
	const env = trackerEnv(t);
	const live = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const lane = await createBead(t, "constraint lane parent");
	const id = await reviewBead(t, "closepass orphan", `${BUILD_BOXES}\n${live}`);
	const missing = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: "cp-nosuch", lesson: "missing readback home fixture" });
	expect(missing.code).toBe("PENDING");
	expect(missing.acts).toEqual([]);
	expect(missing.log).toContain(`${id} has no active parent and lane parent cp-nosuch is unreadable`);
	expect((await row(t, id)).status).toBe("in_review");
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: lane, lesson: "readback home fixture" });
	expect(res.code).toBe("CLOSED");
	expect(await row(t, res.child!)).toMatchObject({ status: "open", parent: lane, labels: [LIVE_READBACK_LABEL] });
	expect(JSON.stringify(await row(t, id))).toContain(`(LIVEREADBACK, child of lane parent ${lane}, because ${id} has no active parent, related to ${id})`);
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.live: --live-readback runs only the child's boxes on the installed tree; a pass ticks them and closes the child", async () => {
	const code = await repo("closepass-live");
	const t = await policyTracker("closepass-live-t");
	const { id, child } = await closedWithChild(t, code, "closepass live pass", "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass", await createBead(t, "closepass live epic"));
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Author", env: trackerEnv(t) })).code).toBe("NON_AUTHOR_REQUIRED");
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "installed readback fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", true]]);
	expect(await row(t, child)).toMatchObject({ status: "closed", acceptance_criteria: "- [x] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass" });
	expect((await row(t, id)).status).toBe("closed");
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t) })).code).toBe("NOT_LIVE_READBACK");
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.live planted: a failing live box reopens the parent with REWORK naming the box, and the child stays open", async () => {
	const code = await repo("closepass-livefail");
	const t = await policyTracker("closepass-livefail-t");
	const epic = await createBead(t, "closepass livefail epic");
	const { id, child } = await closedWithChild(t, code, "closepass live fail", "- [ ] [c] [live] on the installed kit `sh scripts/bad.sh` -> prints PASS", epic);
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "failed readback fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", false]]);
	expect((await row(t, id)).status).toBe("open");
	const comments = await brun(["comments", "list", id], t.dir, trackerEnv(t));
	expect(comments.out).toContain(`REWORK ${id}: live readback ${child} failed [c] output lacks "PASS"`);
	// The child hangs off the active epic, not the reopened bead, so the readback never holds the bead's next close.
	expect(await row(t, child)).toMatchObject({ status: "open", parent: epic });
	expect(JSON.stringify((await row(t, id)).dependents ?? [])).not.toContain("parent-child");
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.all: --live-readback --all visits exactly the open live-readback children, and no others", async () => {
	const code = await repo("closepass-all");
	const t = await policyTracker("closepass-all-t");
	const env = trackerEnv(t);
	const box = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const epic = await createBead(t, "closepass all epic");
	const open = await closedWithChild(t, code, "closepass all open", box, epic);
	const done = await closedWithChild(t, code, "closepass all done", box, epic);
	expect((await liveReadback({ bead: done.child, repo: code.dir, actor: "Peer", env, lesson: "completed readback fixture" })).code).toBe("CLOSED");
	const other = await createBead(t, "closepass unlabelled open bead");
	const labelled = await createBead(t, "closepass labelled but in progress");
	for (const args of [["update", labelled, "--add-label", LIVE_READBACK_LABEL, "--acceptance", box], ["update", labelled, "--status", "in_progress"]]) expect((await brun(args, t.dir, env)).rc).toBe(0);
	const res = await liveReadbackAll({ repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "aggregate readback fixture" });
	expect(res.visited).toEqual([open.child]);
	expect(res.visited).not.toContain(other);
	expect(res.results.map(r => [r.bead, r.code])).toEqual([[open.child, "CLOSED"]]);
	expect(res.ok).toBe(true);
}, fixtureDeadlineS(180) * 1_000);

test("VERIFYSCRATCH1.exportroot: the export carries var/agent-tmp (gitignored, so absent from git archive) and KITLIB_TMP_ROOT names it; planted: without the dir kitlib scratch under the repo root fails NotADirectoryError", async () => {
	const dir = join(base, "exportroot");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "kitlib_tmp.py"), readFileSync(join(import.meta.dir, "..", "..", "scripts", "kitlib_tmp.py")));
	writeFileSync(join(dir, ".gitignore"), "var/\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, "exportroot");
	const sha = (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
	const scratch = "python3 -c 'import sys; sys.path.insert(0, \"scripts\"); import kitlib_tmp; print(\"scratch\", kitlib_tmp.owned_tmp(\"replay\", root=\"var/agent-tmp\").path)'";
	const br = fakeBr(inReview([
		`- [ ] [a] [build] kitlib scratch under the export root: \`${scratch}\` -> prints var/agent-tmp/replay`,
		"- [ ] [b] [build] KITLIB_TMP_ROOT names that dir: `python3 -c 'import os; print(os.path.isdir(os.environ[\"KITLIB_TMP_ROOT\"]), os.environ[\"KITLIB_TMP_ROOT\"].endswith(\"/export/var/agent-tmp\"))'` -> prints True True",
		`- [ ] [c] [build] planted: without the dir the same call fails: \`rmdir var/agent-tmp && ${scratch}\` -> prints NotADirectoryError`,
	].join("\n")));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true]]);
	expect(br.acts()).toEqual([]);
});

// VERIFYABSPATH1 (ompkit-fp72.120.16.267): a repo path named absolutely, by ~ or by $HOME replays the export.
const LIVE_PASS = "#!/bin/sh\necho ' 0 fail'\n";
const EXPORT_FAIL = "#!/bin/sh\necho 'selftest: FAIL'\nexit 1\n";
async function livePassExportFail(name: string): Promise<{ dir: string; sha: string }> {
	const made = await repo(name, { "live.sh": EXPORT_FAIL }, true);
	writeFileSync(join(made.dir, "scripts", "live.sh"), LIVE_PASS); // dirty live tree; the commit still fails
	return made;
}

test("VERIFYABSPATH1 planted: a live-pass/export-fail absolute-path box is not PASS and names the token", async () => {
	const { dir, sha } = await livePassExportFail("abspath-planted");
	const token = join(dir, "scripts", "live.sh");
	const br = fakeBr(inReview(`- [ ] [a] [build] \`sh ${token}\` -> 0 fail`));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", false]]);
	expect(res.log).toContain(`REPO_PATH_MAPPED ${JSON.stringify(token)}`);
	expect(res.replays[0]!.detail).toContain("selftest: FAIL");
	expect(br.state().status).toBe("rework");
});

test("VERIFYABSPATH1 control: the relative-path box on the same commit reports the export's result", async () => {
	const { dir, sha } = await livePassExportFail("abspath-control");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/live.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", false]]);
	expect(res.log).not.toContain("REPO_PATH_MAPPED");
	// Control for the control: a committed passing script, named absolutely, still closes.
	const ok = await repo("abspath-control-pass", {}, true);
	const okBr = fakeBr(inReview(`- [ ] [a] [build] \`sh ${join(ok.dir, "scripts", "t.sh")}\` -> 0 fail`));
	const closed = await verifyBead({ bead: "kit-1", exportSha: ok.sha, repo: ok.dir, actor: "Peer", env: okBr.env });
	expect(closed.code).toBe("CLOSED");
});

test("VERIFYABSPATH1 mutant: without the mapping the planted absolute-path command reports PASS", async () => {
	const { dir, sha } = await livePassExportFail("abspath-mutant");
	const token = join(dir, "scripts", "live.sh");
	const exportDir = join(base, "abspath-mutant-export");
	mkdirSync(exportDir, { recursive: true });
	await sh(["sh", "-c", `git -C ${JSON.stringify(dir)} archive ${sha} | tar -x -C ${JSON.stringify(exportDir)}`], base);
	// The pre-fix replay: the unmapped command, in the export cwd, runs the live tree and passes.
	const unmapped = await run(["sh", token], { cwd: exportDir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(unmapped.rc).toBe(0);
	expect(new TextDecoder().decode(unmapped.stdout)).toContain("0 fail");
	// The mapped command runs the export's bytes and fails.
	const mapped = mapRepoPaths(`sh ${token}`, dir, exportDir);
	expect(mapped.command).toBe(`sh ${join(exportDir, "scripts", "live.sh")}`);
	const fixed = await run(["sh", join(exportDir, "scripts", "live.sh")], { cwd: exportDir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(fixed.rc).toBe(1);
});

test("VERIFYABSPATH1 mapping: ~, $HOME, ${HOME} and symlinked aliases map; outside, sibling-prefix and .beads tracker paths stay; unsafe export is unmapped", () => {
	const home = join(base, "abspath-home");
	const root = join(home, "proj");
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "x.py"), "");
	const alias = join(home, "alias");
	if (!existsSync(alias)) symlinkSync(root, alias);
	const exp = join(base, "abspath-export");
	const m = mapRepoPaths(`python3 ~/proj/scripts/x.py --a=$HOME/proj/scripts/x.py "\${HOME}/proj" '${alias}/scripts/x.py' ${root}/new/file`, root, exp, home);
	expect(m.command).toBe(`python3 ${exp}/scripts/x.py --a=${exp}/scripts/x.py "${exp}" '${exp}/scripts/x.py' ${exp}/new/file`);
	expect(m.unmapped).toEqual([]);
	const keep = `br --db ${root}/.beads/beads.db show x && /usr/bin/env sh ${root}-other/x ~/other/y scripts/x.py ~user/proj $HOMER/proj https://h/proj ${home}`;
	expect(mapRepoPaths(keep, root, exp, home)).toEqual({ command: keep, mapped: [], unmapped: [] });
	const unsafe = mapRepoPaths(`sh ${root}/scripts/x.py`, root, join(base, "export dir"), home);
	expect(unsafe.unmapped).toEqual([`${root}/scripts/x.py`]);
	expect(unsafe.command).toBe(`sh ${root}/scripts/x.py`);
	// Linear scan: a 200 KB near-miss (no boundary before any /) finishes fast.
	const t0 = performance.now();
	mapRepoPaths("a/".repeat(100_000), root, exp, home);
	expect(performance.now() - t0).toBeLessThan(1_000);
});

test("VERIFYABSPATH1 unmappable: a repo path that cannot be rewritten is UNJUDGED naming the token, never PASS", async () => {
	const { dir, sha } = await livePassExportFail("abspath-unmapped");
	const token = join(dir, "scripts", "live.sh");
	const br = fakeBr(inReview(`- [ ] [a] [build] \`sh ${token}\` -> 0 fail`));
	// A scratch root with a space makes the export path shell-unsafe, so the token cannot be rewritten.
	const unsafeRoot = join(base, "unsafe root");
	mkdirSync(unsafeRoot, { recursive: true });
	const prior = process.env.GRADE_WAVE_SCRATCH;
	process.env.GRADE_WAVE_SCRATCH = unsafeRoot;
	let res: Awaited<ReturnType<typeof verifyBead>>;
	try {
		res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	} finally {
		if (prior === undefined) delete process.env.GRADE_WAVE_SCRATCH; else process.env.GRADE_WAVE_SCRATCH = prior;
	}
	expect(res.code).toBe("ENVIRONMENT");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
	expect(res.replays[0]!.detail).toContain(`UNJUDGED REPO_PATH_UNMAPPED: ${JSON.stringify(token)}`);
});

/* VERIFYOPEN1 (ompkit-1ra0d.70): verify admits open beads, not just in_review; the non-author
   replay of every box on the exact export is the proof. Unticked boxes are ticked on PASS. */
const OPEN_PASS_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

/** Policy under which an open bead can close (gated, like in_review) or go back for rework. */
async function openPolicy(t: { dir: string; db: string }): Promise<void> {
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed, rework]
    in_progress: [in_review, open]
    in_review: [closed, rework, open]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
  gates:
    "open -> closed":
      require_all:
        - min_reviewers: 1
    "in_review -> closed":
      require_all:
        - min_reviewers: 1
`);
}

/** An open bead with unticked boxes, assigned to Author so Peer verifies as non-author. */
async function openBead(t: { dir: string; db: string }, title: string, ac: string): Promise<string> {
	const desc = "WHAT: verifyopen1 fixture.\n\nWHY: proves non-author verify closes an open bead on a full replay in this same turn.";
	return createBead(t, title, ["--description", desc, "--acceptance-criteria", ac, "--assignee", "Author"]);
}

test("VERIFYOPEN1 [a]: non-author verify of an open bead with unticked boxes replays, ticks, closes; planted: the author is refused and nothing is ticked", async () => {
	const { dir, sha } = await repo("verifyopen");
	const t = await tracker("verifyopen-pass-t").then(async v => { await openPolicy(v); return v; });
	const env = trackerEnv(t);
	const id = await openBead(t, "verifyopen pass", OPEN_PASS_BOXES);
	// Planted negative first: the author running the same verify is refused before replay and ticks nothing.
	const refused = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Author", env, family: "same (bun)", lesson: "author attempt fixture" });
	expect(refused.code).toBe("NON_AUTHOR_REQUIRED");
	expect(refused.replays).toEqual([]);
	expect(refused.acts).toEqual([]);
	expect((await row(t, id)).status).toBe("open");
	expect((await row(t, id)).acceptance_criteria).toBe(OPEN_PASS_BOXES);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Peer", env, family: "same (bun)", lesson: "open-bead close fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true]]);
	const after = await row(t, id);
	expect(after.status).toBe("closed");
	expect(after.acceptance_criteria).toBe(OPEN_PASS_BOXES.replaceAll("- [ ]", "- [x]"));
}, fixtureDeadlineS(120) * 1_000);

test("VERIFYOPEN1 [b]: a failing box on an open bead leaves it unclosed with the REWORK comment and no tick", async () => {
	const { dir, sha } = await repo("verifyopen");
	const t = await tracker("verifyopen-rework-t");
	const env = trackerEnv(t);
	const ac = "- [ ] [a] [build] `sh scripts/bad.sh` -> prints PASS";
	const id = await openBead(t, "verifyopen rework", ac);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Peer", env, family: "same (bun)", lesson: "open-bead rework fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.acts[0]).toEqual(["br", "update", id, "--status", "rework", "--transition-comment", expect.stringContaining(`REWORK ${id}:`), "--actor", "Peer"]);
	const after = await row(t, id);
	expect(after.status).not.toBe("closed");
	expect(after.acceptance_criteria).toBe(ac);
	const comments = JSON.parse((await brun(["comments", "list", "--json", id], t.dir, env)).out) as { text: string }[];
	expect(comments.some(c => typeof c.text === "string" && c.text.includes(`REWORK ${id}:`))).toBe(true);
}, fixtureDeadlineS(120) * 1_000);
