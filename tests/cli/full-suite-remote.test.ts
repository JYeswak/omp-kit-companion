// SUITEREMOTE1 (ompkit-qsktr): the full suite's Linux share runs on remote workers and composes ONE
// verdict with the local-required (macOS-only) remainder judged here. The workers are fixture hosts
// behind a fixture ssh transport (no network): each runs the shipped judge in a private HOME, exactly
// the worker-side commands full-suite-remote.py sends, so the shard, transfer and validation paths are
// the real ones.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const verdict = join(repoRoot, "scripts", "full-suite-verdict.sh");
const store = join(repoRoot, "scripts", "full-suite-verdict-store.py");
const remote = join(repoRoot, "scripts", "full-suite-remote.py");
const scratch = ownedTmp("suite-remote", { root: process.env.TMPDIR, bead: "ompkit-qsktr" });
afterAll(() => cleanupAllOwnedTmp());
const CASE_MS = fixtureDeadlineS(240) * 1_000;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// The fixture transport: ssh [-o OPT]... TARGET COMMAND. A probe gets the worker's canned answers (its
// READY.json, disk, memory, cores); every other command runs for real in that host's private HOME.
// A target containing "bogus" is unreachable; FIXTURE_DROP names a host whose shard connection drops.
const SSH = String.raw`#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; *) break ;; esac; done
target=$1; command=$2
case "$target" in *bogus*) echo "ssh: Could not resolve hostname $target" >&2; exit 255 ;; esac
host="$FIXTURE_HOSTS/$target"
mkdir -p "$host/work"
case "$command" in
	*@@disk*) cat "$FIXTURE_HOSTS/READY.json"; echo; echo "@@disk 99999999"; echo "@@mem 9999999"; echo "@@cpu 2"; exit 0 ;;
	*--shard-files*) if [ "$target" = "$FIXTURE_DROP" ]; then echo "Connection reset by peer" >&2; exit 255; fi ;;
esac
HOME="$host" PATH="$FIXTURE_BIN:$PATH" exec /bin/sh -c "$command"
`;
// Workers carry util-linux flock; the fixture host has none of its own.
const FLOCK = `#!/bin/sh
[ "$1" = -w ] && shift 2
shift
exec "$@"
`;

async function sh(argv: string[], cwd: string, env: Record<string, string>, floor = 30) {
	return runFixtureAsync(argv, { cwd, env, floor_s: floor, label: argv.slice(0, 3).join(" ") });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const r = await sh(["git", ...args], cwd, cleanEnv());
	if (r.rc !== 0) throw new Error(`git ${args.join(" ")}: ${text(r.stderr)}`);
	return text(r.stdout).trim();
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("FULL_SUITE_REMOTE") && !key.startsWith("FIXTURE_")) env[key] = value;
	}
	env.OMP_KIT_OMP_SRC_FETCH = "0";
	return env;
}

interface Fixture { dir: string; repo: string; cache: string; commit: string; tree: string; env: Record<string, string> }

// A candidate with Bun, shell and Python suites, and tests/cli/service.test.ts, the local-required file.
async function fixture(name: string, failing = false): Promise<Fixture> {
	const dir = join(scratch.path, name);
	const repo = join(dir, "repo");
	const hosts = join(dir, "hosts");
	const bin = join(dir, "bin");
	for (const path of [join(repo, "tests", "cli"), join(repo, "tests", "scripts"), join(repo, "scripts"), hosts, bin]) mkdirSync(path, { recursive: true });
	// The runner sources the candidate's own kitlib-tmp.sh for every suite's private scratch.
	cpSync(join(repoRoot, "scripts", "kitlib-tmp.sh"), join(repo, "scripts", "kitlib-tmp.sh"));
	const pass = (label: string) => `import { expect, test } from "bun:test";\ntest("${label}", () => expect(1).toBe(1));\n`;
	writeFileSync(join(repo, "tests/cli/alpha.test.ts"), pass("alpha"));
	writeFileSync(join(repo, "tests/cli/beta.test.ts"), failing
		? `import { expect, test } from "bun:test";\ntest("beta planted failure", () => expect(1).toBe(2));\n`
		: pass("beta"));
	writeFileSync(join(repo, "tests/cli/service.test.ts"), pass("service on this host"));
	writeFileSync(join(repo, "tests/cli/gamma.test.sh"), "#!/bin/sh\necho gamma ok\n");
	writeFileSync(join(repo, "tests/scripts/delta_test.py"), "print('delta ok')\n");
	await git(repo, "init", "-q");
	await git(repo, "config", "user.name", "SUITEREMOTE1 test");
	await git(repo, "config", "user.email", "suiteremote1@example.invalid");
	await git(repo, "add", "tests", "scripts");
	await git(repo, "commit", "-q", "-m", "[test] SUITEREMOTE1 fixture");
	writeFileSync(join(hosts, "..", "ssh"), SSH);
	chmodSync(join(hosts, "..", "ssh"), 0o755);
	writeFileSync(join(bin, "flock"), FLOCK);
	chmodSync(join(bin, "flock"), 0o755);
	// A fixture host stands in for a real suite worker, which carries bun at
	// ~/.bun/bin (suite-worker-setup.sh parity). The worker shell rebuilds PATH
	// from its own HOME (fixed-env.sh), so a coordinator PATH entry cannot reach
	// it: on this Mac /opt/homebrew/bin survives, but on a stock runner bun lives
	for (const worker of ["omp-suite@worker-1", "omp-suite@worker-2"]) {
		const workerBunDir = join(hosts, worker, ".bun", "bin");
		mkdirSync(workerBunDir, { recursive: true });
		symlinkSync(process.execPath, join(workerBunDir, "bun"));
	}
	const marker = await sh(["python3", remote, "pins", "--marker"], repoRoot, cleanEnv());
	writeFileSync(join(hosts, "READY.json"), JSON.stringify({ pins: text(marker.stdout).trim() }));
	const env = cleanEnv();
	Object.assign(env, {
		FULL_SUITE_REMOTE: "1", FULL_SUITE_REMOTE_WORKERS: "omp-suite@worker-1 omp-suite@worker-2",
		FULL_SUITE_REMOTE_SSH: join(dir, "ssh"), FIXTURE_HOSTS: hosts, FIXTURE_BIN: bin,
	});
	return { dir, repo, cache: join(dir, "cache"), commit: await git(repo, "rev-parse", "HEAD"),
		tree: await git(repo, "rev-parse", "HEAD^{tree}"), env };
}

async function judge(f: Fixture, extra: Record<string, string | undefined> = {}) {
	const env = { ...f.env };
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key]; else env[key] = value;
	}
	const r = await sh(["sh", verdict, "--repo", f.repo, "--commit", f.commit, "--judge-role", "main", "--cache-dir", f.cache],
		f.repo, env, 200);
	return { rc: r.rc, out: `${text(r.stdout)}\n${text(r.stderr)}` };
}

// The record path the store resolves for this judge and runtime (the same environment the run saw).
async function recordPath(f: Fixture): Promise<string> {
	const r = await sh(["python3", store, "path", "--repo", f.repo, "--tree", f.tree, "--role", "main",
		"--judge-root", repoRoot, "--cache-dir", f.cache], f.repo, f.env);
	if (r.rc !== 0) throw new Error(`store path: ${text(r.stderr)}`);
	return text(r.stdout).trim();
}

// release-local's reader: require-pass for the main role on the exact source tree.
async function requirePass(f: Fixture, cache = f.cache) {
	const r = await sh(["python3", store, "require-pass", "--repo", f.repo, "--tree", f.tree, "--role", "main",
		"--judge-root", repoRoot, "--suite-root", f.repo, "--cache-dir", cache], f.repo, f.env);
	return { rc: r.rc, out: text(r.stdout).trim() };
}

let passing: Fixture | undefined;

test("remote shards and the local-required remainder compose one main-role PASS release-local accepts", async () => {
	const f = await fixture("pass");
	const run = await judge(f);
	expect(run.rc, run.out).toBe(0);
	expect(run.out).toContain("FULL-SUITE: REMOTE: 4 files on Linux workers; this host runs bun=1 shell=0 python=0 (local-required)");
	expect(run.out).toContain("FULL-SUITE: VERDICT PASS");
	const record = JSON.parse(readFileSync(await recordPath(f), "utf8"));
	const shards = record.evidence.remote.shards as { worker: string; files: string[] }[];
	expect(shards.map(shard => shard.worker).sort()).toEqual(["omp-suite@worker-1", "omp-suite@worker-2"]);
	expect(shards.flatMap(shard => shard.files).sort()).toEqual(
		["tests/cli/alpha.test.ts", "tests/cli/beta.test.ts", "tests/cli/gamma.test.sh", "tests/scripts/delta_test.py"]);
	expect(record.evidence.remote.local_required).toEqual(["tests/cli/service.test.ts"]);
	const local = record.evidence.files.filter((row: { origin?: string }) => row.origin !== "remote");
	expect(local.map((row: { path: string }) => row.path)).toEqual(["tests/cli/service.test.ts"]);
	expect(await requirePass(f)).toEqual({ rc: 0, out: "PASS" });
	passing = f;
}, CASE_MS);

test("a planted failing test in a remote shard makes the composed verdict FAIL", async () => {
	const f = await fixture("planted-fail", true);
	const run = await judge(f);
	expect(run.rc, run.out).not.toBe(0);
	expect(run.out).toContain("FULL-SUITE: VERDICT FAIL");
	expect(run.out).toContain("beta planted failure");
	const record = JSON.parse(readFileSync(await recordPath(f), "utf8"));
	expect(record.verdict).toBe("FAIL");
	expect(record.evidence.bun_fail).toBe(1);
	const reader = await requirePass(f);
	expect(reader).toEqual({ rc: 1, out: "FAIL" });
}, CASE_MS);

test("a shard whose connection drops leaves no verdict, never PASS", async () => {
	const f = await fixture("dropped-shard");
	const run = await judge(f, { FIXTURE_DROP: "omp-suite@worker-2" });
	expect(run.rc, run.out).not.toBe(0);
	expect(run.out).toContain("INCOMPLETE shard omp-suite@worker-2");
	expect(run.out).toContain("remote shards ended without complete evidence");
	expect(existsSync(await recordPath(f))).toBe(false);
	expect((await requirePass(f)).out).toBe("MISS");
	// The shard that finished still records its files' times for the next split; the dropped one adds none.
	const tables = readdirSync(f.cache, { recursive: true }).map(String).filter(path => path.endsWith(join("timings", "remote-linux.json")));
	expect(tables.length).toBe(1);
	const timed = Object.keys(JSON.parse(readFileSync(join(f.cache, tables[0]!), "utf8")).files);
	const remoteFiles = ["tests/cli/alpha.test.ts", "tests/cli/beta.test.ts", "tests/cli/gamma.test.sh", "tests/scripts/delta_test.py"];
	expect(timed.length).toBeGreaterThan(0);
	expect(timed.length).toBeLessThan(remoteFiles.length);
	for (const path of timed) expect(remoteFiles).toContain(path);
}, CASE_MS);

// Planted negatives on the reader: each edits one copy of the passing record; the log and filename stay.
interface Row { path: string; origin?: string; worker?: string; judge: Record<string, unknown> }
interface Composed { evidence: { files: Row[]; remote: { shards: { worker: string; files: string[] }[]; local_required: string[] } } }
async function mutated(name: string, edit: (record: Composed) => void) {
	const f = passing;
	if (f === undefined) throw new Error("the passing case did not run");
	const cache = join(f.dir, `cache-${name}`);
	cpSync(f.cache, cache, { recursive: true });
	const path = (await recordPath(f)).replace(f.cache, cache);
	const record: Composed = JSON.parse(readFileSync(path, "utf8"));
	edit(record);
	writeFileSync(path, JSON.stringify(record, null, 2));
	return requirePass(f, cache);
}

test("reader control: an unedited copy of the composed record is PASS", async () => {
	expect(await mutated("control", () => {})).toEqual({ rc: 0, out: "PASS" });
}, CASE_MS);

test("reader refuses a record judged wholly on workers (no local-required subset)", async () => {
	const result = await mutated("linux-only", record => {
		const shard = record.evidence.remote.shards[0];
		for (const row of record.evidence.files) {
			if (row.origin === "remote") continue;
			Object.assign(row, { origin: "remote", worker: shard.worker });
			shard.files.push(row.path);
		}
	});
	expect(result).toEqual({ rc: 1, out: "MISS" });
}, CASE_MS);

test("reader refuses a shard whose rows mix producers", async () => {
	const result = await mutated("mixed-producer", record => {
		const row = record.evidence.files.find(item => item.origin === "remote");
		if (row === undefined) throw new Error("the composed record has no worker row");
		row.judge = { ...row.judge, python: "0.0.0" };
	});
	expect(result).toEqual({ rc: 1, out: "MISS" });
}, CASE_MS);

test("reader refuses a record whose local-required set was dropped", async () => {
	expect(await mutated("no-local-required", record => { record.evidence.remote.local_required = []; }))
		.toEqual({ rc: 1, out: "MISS" });
}, CASE_MS);

test("fallback: an unreachable worker runs the complete suite on this host and says so", async () => {
	const f = await fixture("fallback-bogus");
	const run = await judge(f, { FULL_SUITE_REMOTE_WORKERS: "omp-suite@bogus.invalid" });
	expect(run.rc, run.out).toBe(0);
	expect(run.out).toContain("FULL-SUITE: REMOTE: worker omp-suite@bogus.invalid: not used: unreachable");
	expect(run.out).toContain("running the complete suite on this host");
	expect(run.out).toContain("FULL-SUITE: VERDICT PASS");
	const record = JSON.parse(readFileSync(await recordPath(f), "utf8"));
	expect(record.evidence.remote).toBeUndefined();
	expect(record.evidence.files).toHaveLength(5);
	expect(await requirePass(f)).toEqual({ rc: 0, out: "PASS" });
}, CASE_MS);

test("fallback: with no adapter configured (no rch, no worker list) the run is today's local run", async () => {
	const f = await fixture("fallback-absent");
	const home = join(f.dir, "home");
	mkdirSync(home);
	// A stock Linux runner has bun only under the real HOME; carry it the way a host does
	// (CI run 42570554579: "bun is not on PATH" here). Nothing else, so still no rch.
	mkdirSync(join(home, ".bun", "bin"), { recursive: true });
	symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
	// The pinned PATH holds no rch under this HOME; nothing names a worker.
	const run = await judge(f, { FULL_SUITE_REMOTE_WORKERS: undefined, HOME: home });
	expect(run.rc, run.out).toBe(0);
	// A suite worker carries the rch client on its pinned PATH but no worker config of its own.
	expect(run.out).toMatch(/FULL-SUITE: REMOTE: off \((no rch on PATH and FULL_SUITE_REMOTE_WORKERS is unset|rch lists no enabled Linux worker|rch workers list failed[^)]*\))/);
	expect(run.out).not.toContain("shards started");
	expect(run.out).toContain("FULL-SUITE: VERDICT PASS");
}, CASE_MS);

test("fallback: the adapter is opt-in; FULL_SUITE_REMOTE unset or 0 runs locally even with workers named", async () => {
	for (const value of [undefined, "0"]) {
		const f = await fixture(`fallback-off-${value ?? "unset"}`); // a fresh cache: a second run would reuse the first PASS
		const run = await judge(f, { FULL_SUITE_REMOTE: value });
		expect(run.rc, run.out).toBe(0);
		expect(run.out).toContain(`FULL-SUITE: REMOTE: off (FULL_SUITE_REMOTE=${value ?? "unset"}; set 1 to use workers)`);
		expect(run.out).not.toContain("shards started");
		expect(run.out).toContain("FULL-SUITE: VERDICT PASS");
	}
}, CASE_MS);

test("SUITELOAD1: the default remote pool width leaves one core free and FULL_SUITE_REMOTE_JOBS still overrides", async () => {
	// No worker is contacted: the probe's transport is stubbed to a canned READY answer.
	const driver = [
		"import importlib.util, json, os, sys",
		"spec = importlib.util.spec_from_file_location('full_suite_remote', sys.argv[1])",
		"mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
		"for cpus, want in [(1, 1), (2, 1), (4, 3), (8, 4)]:",
		"    got = mod.default_pool_width(cpus)",
		"    assert got == want, (cpus, got, want)",
		"marker = 'SUITELOAD1-marker'",
		"class Canned:",
		"    timed_out = False; rc = 0; stderr = b''",
		"    def __init__(self, out): self.stdout = out",
		"def canned(cpus):",
		"    out = (json.dumps({'pins': marker}) + '\\n@@disk 99999999\\n@@mem 9999999\\n@@cpu %d\\n' % cpus).encode()",
		"    return lambda *a, **k: Canned(out)",
		"os.environ.pop('FULL_SUITE_REMOTE_JOBS', None)",
		"mod.remote = canned(4)",
		"assert mod.probe('omp-suite@worker-1', marker)[1] == 3",
		"os.environ['FULL_SUITE_REMOTE_JOBS'] = '6'",
		"mod.remote = canned(4)",
		"assert mod.probe('omp-suite@worker-1', marker)[1] == 6",
		"print('ok')",
	].join("\n");
	const r = await sh(["python3", "-c", driver, remote], repoRoot, cleanEnv());
	expect(r.rc, `${text(r.stdout)}\n${text(r.stderr)}`).toBe(0);
	expect(text(r.stdout).trim().split("\n").at(-1)).toBe("ok");
}, CASE_MS);
