/** Shared verify fixture helpers (LESSONAUTO1 split): the repo/tracker fakes also defined in
 * verify.test.ts, exported here so verify-lessons.test.ts does not duplicate the big blocks.
 * verify.test.ts keeps its own copies and stays byte-identical to main.
 */
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

/** Test bases live where the ambient br authority permits writes: a grading
 * harness designates GRADE_WAVE_SCRATCH, otherwise the default TMPDIR root. */
function testBase(label: string): string {
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	return ownedTmp(label, g === undefined ? {} : { root: g }).path;
}

const base = testBase("verify-lessons-test");

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
export function installFixtureIdentity(): void {
	for (const key of INHERITED_SELECTORS) delete process.env[key];
	Object.assign(process.env, fixtureIdentityEnv());
}
export function restoreFixtureIdentity(): void {
	process.env.PATH = callerPath;
	if (callerAgent === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = callerAgent;
	for (const [key, value] of callerSelectors) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

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
export function repo(name: string, extraScripts: Record<string, string> = {}, own = false): Promise<{ dir: string; sha: string }> {
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
export function fakeBr(bead: Record<string, unknown>, opts?: { failOn?: string | string[]; failMessage?: string; commitBeforeRefusal?: boolean; refusalAcceptance?: string; comments?: FixtureComment[]; extraBeads?: Record<string, unknown>[]; gateList?: unknown }): { env: Record<string, string>; acts: () => string[]; state: (id?: string) => Record<string, unknown> } {
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

export const inReview = (ac: string) => ({ id: "kit-1", status: "in_review", assignee: "Author", updated_at: "2026-10-26T00:00:00Z", labels: [], acceptance_criteria: ac });
