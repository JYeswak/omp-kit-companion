import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
// This bounds fixture Git initialization/publication and verification subprocesses,
// not a product latency contract; retain the 15-second floor and account for load.
jest.setTimeout(fixtureDeadlineS(15) * 1_000);

/* Split from verify.test.ts: the push gate budgets test time per file, and the
   VERIFYDEPS1 suite pushed verify.test.ts over it. This file owns the export
   dependency-provisioning tests and the minimum fixture helpers they need,
   copied from verify.test.ts (which stays at its main-branch content). */

/** Test bases live where the ambient br authority permits writes: a grading
 * harness designates GRADE_WAVE_SCRATCH, otherwise the default TMPDIR root. */
function testBase(label: string): string {
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	return ownedTmp(label, g === undefined ? {} : { root: g }).path;
}

const base = testBase("verify-deps-test");

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

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<string> {
	// Always the live process.env: a spawn without env keeps selectors the file dropped in beforeAll.
	const r = await run(cmd, { cwd, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...(env ?? {}) } as Record<string, string> });
	if (r.rc !== 0) throw new Error(`${cmd.join(" ")} -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return new TextDecoder().decode(r.stdout);
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
function fakeBr(bead: Record<string, unknown>, opts?: { failOn?: string | string[]; failMessage?: string; commitBeforeRefusal?: boolean; refusalAcceptance?: string; comments?: FixtureComment[]; extraBeads?: Record<string, unknown>[]; gateList?: unknown }): { env: Record<string, string>; acts: () => string[]; state: (id?: string) => Record<string, unknown> } {
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
	// VERIFYGATE1: the gate-list read is a tracker read like show, served unlogged from views. The default
	// fixture workflow requires min_reviewers on both closing edges, so the gate-report act stays; a test
	// with a gateless workflow passes gateList with no gated transitions instead.
	const gateList = opts?.gateList ?? { issue_id: String(bead.id), current_status: "in_review", history: [], legacy_results: [], gated_transitions: [{ from: "in_review", to: "closed", gates: [{ gate: "min_reviewers", satisfied: false }], satisfied: false }, { from: "open", to: "closed", gates: [{ gate: "min_reviewers", satisfied: false }], satisfied: false }] };
	writeFileSync(join(views, "gate-list.json"), JSON.stringify(gateList));
	const writer = join(home, "br.js");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(bin, "br"), [
		"#!/bin/sh",
		"case \"$1 $2\" in",
		"\"show \"*/*|\"show \") ;;",
		`"show "*) f=${quote(views)}/show-"$2".json; [ -f "$f" ] || exit 3; exec cat "$f" ;;`,
		`"comments list") exec cat ${quote(join(views, "comments.json"))} ;;`,
		`"gate list"*) f=${quote(join(views, "gate-list.json"))}; [ -f "$f" ] || exit 3; exec cat "$f" ;;`,
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

/* VERIFYDEPS1 (ompkit-1ra0d.154): the export carries no node_modules, so a JS box can only pass
   when verify provisions the export's own lockfile closure first. The fixture dependency is a
   local file: target, so the frozen install never touches the registry and the test needs no network. */
async function jsDepRepo(name: string, lock: "ok" | "stale" | "none"): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "vendor", "greet"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { "greet-local": "file:./vendor/greet" } }));
	writeFileSync(join(dir, "vendor/greet/package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(dir, "vendor/greet/index.js"), 'module.exports.hello = () => "hi";\n');
	writeFileSync(join(dir, "check.js"), 'const greet = require("greet-local");\nconsole.log("GREET:" + greet.hello());\n');
	// verify's export sanity requires a scripts/ or src/ tree in the archived commit.
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	// The lockfile is generated from the fixture's own bytes; file: targets never reach the registry.
	await sh(["bun", "install"], dir);
	if (lock === "stale") writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true }));
	if (lock === "none") rmSync(join(dir, "bun.lock"));
	rmSync(join(dir, "node_modules"), { recursive: true, force: true });
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

test("VERIFYDEPS1 product: a box importing a lockfile-pinned dependency passes on the export after frozen provisioning", async () => {
	const { dir, sha } = await jsDepRepo("verifydeps-ok", "ok");
	// node, not bun: bun resolves file: targets at runtime without node_modules, so only node
	// proves the provisioned closure. The install still runs through the export's own bun.lock.
	const br = fakeBr(inReview("- [ ] [a] [build] `node check.js` -> GREET:hi"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("bun install --frozen-lockfile");
});

test("VERIFYDEPS1 planted: the same box without provisioning fails Cannot find module", async () => {
	const { dir } = await jsDepRepo("verifydeps-neg", "ok");
	const r = await run(["node", "check.js"], { cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(r.rc).not.toBe(0);
	expect(new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr)).toContain("Cannot find module");
});

test("VERIFYDEPS1 missing lockfile refuses DEPENDENCIES_NOT_LOCKED and runs nothing", async () => {
	const { dir, sha } = await jsDepRepo("verifydeps-nolock", "none");
	const br = fakeBr(inReview("- [ ] [a] [build] `node check.js` -> GREET:hi"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DEPENDENCIES_NOT_LOCKED");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
	expect(res.log).toContain("DEPENDENCIES_NOT_LOCKED");
});

test("VERIFYDEPS1 stale lockfile refuses DEPENDENCIES_NOT_LOCKED, never resolving outside the lock", async () => {
	const { dir, sha } = await jsDepRepo("verifydeps-stale", "stale");
	const br = fakeBr(inReview("- [ ] [a] [build] `node check.js` -> GREET:hi"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DEPENDENCIES_NOT_LOCKED");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
	expect(res.log).toContain("frozen");
});

/* VERIFYDEPS1 review fixes: pinned .bin resolution, NODE_PATH/NODE_OPTIONS strip, npx/deno
   triggers, install secret scrub. Every fixture dependency is a local file: target, so the
   frozen installs never touch the registry and the tests need no network. */
/** A file: dependency that ships a binary: the box names the bare binary, not a JS runner. */
async function jsBinRepo(name: string): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "vendor", "greet"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { "greet-local": "file:./vendor/greet" } }));
	writeFileSync(join(dir, "vendor/greet/package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", bin: { "greet-bin": "cli.js" } }));
	writeFileSync(join(dir, "vendor/greet/cli.js"), '#!/usr/bin/env node\nconsole.log("REAL-BIN");\n');
	chmodSync(join(dir, "vendor/greet/cli.js"), 0o755);
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	await sh(["bun", "install"], dir);
	rmSync(join(dir, "node_modules"), { recursive: true, force: true });
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** A package with a file: dependency but no lockfile: the box runs the dep through sh. */
async function jsNoLockRepo(name: string): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "vendor", "greet"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { "greet-local": "file:./vendor/greet" } }));
	writeFileSync(join(dir, "vendor/greet/package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(dir, "vendor/greet/index.js"), 'module.exports.hello = () => "hi";\n');
	writeFileSync(join(dir, "check.js"), 'const greet = require("greet-local");\nconsole.log("GREET:" + greet.hello());\n');
	writeFileSync(join(dir, "run.sh"), "#!/bin/sh\nnode check.js\n");
	chmodSync(join(dir, "run.sh"), 0o755);
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** A deno project with std-only code: frozen install and replay need no network. */
async function denoRepo(name: string, lock: "ok" | "none"): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "deno.json"), "{}\n");
	writeFileSync(join(dir, "main.ts"), 'console.log("DENOHI");\n');
	if (lock === "ok") writeFileSync(join(dir, "deno.lock"), '{"version":"5","remote":{}}\n');
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** A package whose postinstall exfiltrates a caller token into the export when it can see one. */
async function jsScrubRepo(name: string): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "vendor", "greet"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "node_modules\nleak.txt\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { "greet-local": "file:./vendor/greet" }, scripts: { postinstall: "node -e \"require('fs').writeFileSync('leak.txt', process.env.VD_TOKEN_PROBE ?? 'SCRUBBED')\"" } }));
	writeFileSync(join(dir, "vendor/greet/package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(dir, "vendor/greet/index.js"), 'module.exports.hello = () => "hi";\n');
	writeFileSync(join(dir, "check-leak.js"), 'console.log(require("fs").readFileSync("leak.txt", "utf8"));\n');
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	// The planted token is set only for the verify run below, never for this setup install.
	await sh(["bun", "install"], dir);
	rmSync(join(dir, "node_modules"), { recursive: true, force: true });
	rmSync(join(dir, "leak.txt"), { force: true });
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

test("VERIFYDEPS1 pinned bin: a bare binary box runs the lockfile-pinned .bin, not an earlier caller-PATH decoy", async () => {
	const { dir, sha } = await jsBinRepo("verifydeps-bin");
	const decoy = join(base, "verifydeps-decoy");
	mkdirSync(decoy, { recursive: true });
	writeFileSync(join(decoy, "greet-bin"), "#!/bin/sh\necho DECOY\n");
	chmodSync(join(decoy, "greet-bin"), 0o755);
	const br = fakeBr(inReview("- [ ] [a] [build] `node -e \"process.exit(0)\" && greet-bin` -> REAL-BIN"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, PATH: `${decoy}${delimiter}${br.env.PATH}` }, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("prepended");
});

test("VERIFYDEPS1 env strip: caller NODE_PATH and NODE_OPTIONS do not reach the replay", async () => {
	const { dir, sha } = await jsNoLockRepo("verifydeps-nodepath");
	const np = join(base, "verifydeps-np", "node_modules", "greet-local");
	mkdirSync(np, { recursive: true });
	writeFileSync(join(np, "package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(np, "index.js"), 'module.exports.hello = () => "hi";\n');
	const br = fakeBr(inReview("- [ ] [a] [build] `sh run.sh` -> GREET:hi"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, NODE_PATH: join(base, "verifydeps-np", "node_modules"), NODE_OPTIONS: "--require /nonexistent/vd-evil.js" }, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", false]]);
	expect(res.replays[0]!.detail).toContain("Cannot find module 'greet-local'");
});

test("VERIFYDEPS1 npx trigger: an npx box with no lockfile refuses DEPENDENCIES_NOT_LOCKED without running", async () => {
	const { dir, sha } = await jsNoLockRepo("verifydeps-npx");
	const br = fakeBr(inReview("- [ ] [a] [build] `npx greet-local` -> GREET:hi"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DEPENDENCIES_NOT_LOCKED");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
});

test("VERIFYDEPS1 deno refusal: a deno box in a deno project without deno.lock refuses without running", async () => {
	const { dir, sha } = await denoRepo("verifydeps-denonolock", "none");
	const br = fakeBr(inReview("- [ ] [a] [build] `deno run main.ts` -> DENOHI"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DEPENDENCIES_NOT_LOCKED");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
});

test("VERIFYDEPS1 deno frozen: a deno box with deno.lock provisions frozen and passes offline", async () => {
	const { dir, sha } = await denoRepo("verifydeps-denook", "ok");
	const br = fakeBr(inReview("- [ ] [a] [build] `deno run main.ts` -> DENOHI"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, DENO_NO_UPDATE_CHECK: "1" }, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("deno install --frozen");
});

test("VERIFYDEPS1 install scrub: a postinstall script cannot read caller tokens", async () => {
	const { dir, sha } = await jsScrubRepo("verifydeps-scrub");
	const br = fakeBr(inReview("- [ ] [a] [build] `node check-leak.js` -> SCRUBBED"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, VD_TOKEN_PROBE: "planted-secret", NODE_AUTH_TOKEN: "planted-auth" }, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("secret env vars scrubbed");
});

/** A pnpm project: only pnpm-lock.yaml, never generated by another manager. */
async function jsPnpmRepo(name: string): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "vendor", "greet"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { "greet-local": "file:./vendor/greet" } }));
	writeFileSync(join(dir, "vendor/greet/package.json"), JSON.stringify({ name: "greet-local", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(dir, "vendor/greet/index.js"), 'module.exports.hello = () => "hi";\n');
	writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      greet-local:\n        specifier: file:./vendor/greet\n        version: file:./vendor/greet\n");
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	await publishHead(dir, name);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** Null when no `.pnpm-store` dir exists under root; the offending path otherwise. */
function findDotPnpmStore(root: string): string | null {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === ".pnpm-store") return join(root, entry.name);
		// Real directories only: never follow symlinks (fixture bins link out of the tree).
		if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
		const hit = findDotPnpmStore(join(root, entry.name));
		if (hit !== null) return hit;
	}
	return null;
}

test("VERIFYDEPS1 pnpm store: provisioning pins --store-dir to the user store, never a project-local .pnpm-store", async () => {
	const { dir, sha } = await jsPnpmRepo("verifydeps-pnpm");
	// A fake pnpm: `store path` answers the user store, `install` records its argv and
	// succeeds without touching the network, so the test stays hermetic either way.
	const fakeBin = join(base, "verifydeps-fakebin");
	mkdirSync(fakeBin, { recursive: true });
	const argvLog = join(base, "verifydeps-pnpm-argv.log");
	const fakeStore = join(base, "verifydeps-user-store");
	writeFileSync(join(fakeBin, "pnpm"), '#!/bin/sh\nif [ "$1" = "store" ] && [ "$2" = "path" ]; then printf "%s" "$VD_FAKE_STORE"; exit 0; fi\ncase " $* " in *" --store-dir "*) ;; *) mkdir -p .pnpm-store ;; esac\nprintf "%s" "$*" >> "$VD_ARGV_LOG"\nprintf "\\n" >> "$VD_ARGV_LOG"\nexit 0\n');
	chmodSync(join(fakeBin, "pnpm"), 0o755);
	const br = fakeBr(inReview("- [ ] [a] [build] `node -e \"process.exit(0)\"` -> rc 0"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, PATH: `${fakeBin}${delimiter}${br.env.PATH}`, VD_FAKE_STORE: fakeStore, VD_ARGV_LOG: argvLog }, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(readFileSync(argvLog, "utf8")).toContain(`--store-dir ${fakeStore}`);
	expect(findDotPnpmStore(base)).toBeNull();
});
