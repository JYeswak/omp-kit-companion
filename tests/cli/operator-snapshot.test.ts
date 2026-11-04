import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareWatched, liveWriterPaths, operatorWatchedPaths, snapshotWatched } from "../../src/operator-snapshot.ts";
import { ccStateDir, KNOWN_JOBS, plistPath, serviceLabel, type OwnedStatePath } from "../../src/service.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
afterAll(cleanupAllOwnedTmp);

const roots: string[] = [];
const xdgStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
	if (xdgStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = xdgStateHome;
	for (const root of roots.splice(0)) { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

/** Installs a job's native definition the way `service install` leaves it: the plist on macOS, the unit on Linux. */
function installJob(home: string, name: string): void {
	const plist = plistPath(home, serviceLabel(name));
	mkdirSync(join(plist, ".."), { recursive: true });
	writeFileSync(plist, `<plist><string>${serviceLabel(name)}</string></plist>\n`);
	const unit = join(home, ".config", "systemd", "user", `omp-kit-${name}.service`);
	mkdirSync(join(unit, ".."), { recursive: true });
	writeFileSync(unit, "[Service]\n");
}

function operatorHome(installed: readonly string[] = []) {
	const scratch = join(import.meta.dir, "../../var/agent-tmp");
	const home = ownedTmp("operator-snapshot", { root: scratch }).path;
	roots.push(home);
	// The jobs derive their state from XDG_STATE_HOME exactly as their plists pin it.
	process.env.XDG_STATE_HOME = join(home, ".local", "state");
	mkdirSync(join(home, ".omp", "agent", "rules"), { recursive: true });
	mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "ttsr:\n  enabled: true\n");
	writeFileSync(join(home, ".omp", "profiles", "work", "agent", "config.yml"), "modelRoles: {}\n");
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), "---\ncondition: 'x'\n---\nrule\n");
	for (const name of installed) installJob(home, name);
	const stateRoot = join(home, ".local", "state", "omp-kit");
	const paths = operatorWatchedPaths(home, stateRoot);
	return { home, paths };
}

test("a busy, realistic HOME outside the watched set is complete and unchanged", () => {
	const { home, paths } = operatorHome();
	const library = join(home, "Library", "Caches");
	mkdirSync(library, { recursive: true });
	for (let dir = 0; dir < 20; dir++) {
		mkdirSync(join(library, `d${dir}`));
		for (let file = 0; file < 100; file++) writeFileSync(join(library, `d${dir}`, `f${file}`), "x");
	}
	writeFileSync(join(home, ".omp", "agent", "agent.db"), "session state");
	const before = snapshotWatched(paths);
	appendFileSync(join(library, "d0", "f0"), "concurrent agent write");
	appendFileSync(join(home, ".omp", "agent", "agent.db"), "more session state");
	writeFileSync(join(library, "new-file"), "created during the run");
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result, JSON.stringify(result)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
	expect(result.watched).toBeLessThan(100);
}, 120_000);

test("a write to a watched profile config, rule, rule ownership record, or new profile file is named", () => {
	const { home, paths } = operatorHome();
	const before = snapshotWatched(paths);
	appendFileSync(join(home, ".omp", "profiles", "work", "agent", "config.yml"), "task:\n  disabledAgents: [scout]\n");
	writeFileSync(join(home, ".agents", "rules", "new-rule.md"), "planted\n");
	writeFileSync(join(home, ".agents", "omp-kit-ownership.json"), "{\"version\":1,\"rules\":{}}\n");
	writeFileSync(join(home, ".omp", "agent", "settings.json"), "{}\n");
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result.unchanged).toBe(false);
	expect(result.changed_paths).toEqual([
		"~/.agents/omp-kit-ownership.json",
		"~/.agents/rules/new-rule.md",
		"~/.omp/agent/settings.json",
		"~/.omp/profiles/work/agent/config.yml",
	]);
});

test("large plugin caches stay excluded while OMP link and registry mutations remain watched", () => {
	const { home, paths } = operatorHome();
	const pluginDir = join(home, ".omp", "plugins");
	const cacheFile = join(pluginDir, "cache", "large.bin");
	mkdirSync(join(pluginDir, "cache"), { recursive: true });
	writeFileSync(cacheFile, "");
	truncateSync(cacheFile, 512 * 1024 * 1024 + 1);
	expect(statSync(cacheFile).size).toBe(512 * 1024 * 1024 + 1);

	const linkPath = join(pluginDir, "node_modules", "omp-kit-companion");
	const runtimeConfig = join(pluginDir, "installed_plugins.json");
	const lockPath = join(pluginDir, "omp-plugins.lock.json");
	mkdirSync(join(pluginDir, "node_modules"), { recursive: true });
	symlinkSync("/fixture/releases/old", linkPath, "dir");
	writeFileSync(runtimeConfig, "{\"plugins\":[]}\n");
	writeFileSync(lockPath, "{\"plugins\":[]}\n");

	const beforeCacheWrite = snapshotWatched(paths);
	writeFileSync(join(pluginDir, "cache", "small-entry"), "unrelated cache state");
	expect(compareWatched(beforeCacheWrite, snapshotWatched(paths), home)).toMatchObject({
		unchanged: true, complete: true, changed_paths: [], incomplete_paths: [],
	});

	const symlinkBefore = snapshotWatched(paths);
	rmSync(linkPath);
	symlinkSync("/fixture/releases/new", linkPath, "dir");
	expect(compareWatched(symlinkBefore, snapshotWatched(paths), home).changed_paths)
		.toEqual(["~/.omp/plugins/node_modules/omp-kit-companion"]);

	const runtimeBefore = snapshotWatched(paths);
	writeFileSync(runtimeConfig, "{\"plugins\":[\"omp-kit-companion\"]}\n");
	expect(compareWatched(runtimeBefore, snapshotWatched(paths), home).changed_paths)
		.toEqual(["~/.omp/plugins/installed_plugins.json"]);

	const lockBefore = snapshotWatched(paths);
	writeFileSync(lockPath, "{\"plugins\":[\"omp-kit-companion\"]}\n");
	expect(compareWatched(lockBefore, snapshotWatched(paths), home).changed_paths)
		.toEqual(["~/.omp/plugins/omp-plugins.lock.json"]);
}, 120_000);

test("an mtime-only touch is not a change; a mode change is", () => {
	const { home, paths } = operatorHome();
	const config = join(home, ".omp", "agent", "config.yml");
	const before = snapshotWatched(paths);
	utimesSync(config, new Date(2030, 0, 1), new Date(2030, 0, 1));
	expect(compareWatched(before, snapshotWatched(paths), home).unchanged).toBe(true);
	chmodSync(config, 0o600);
	expect(compareWatched(before, snapshotWatched(paths), home).changed_paths).toEqual(["~/.omp/agent/config.yml"]);
});

test("an unreadable watched file makes the snapshot incomplete and names it", () => {
	const { home, paths } = operatorHome();
	const rule = join(home, ".agents", "rules", "kit-test-skip.md");
	chmodSync(rule, 0o000);
	try {
		const snap = snapshotWatched(paths);
		const result = compareWatched(snap, snap, home);
		expect(result.complete).toBe(false);
		expect(result.incomplete_paths).toEqual(["~/.agents/rules/kit-test-skip.md"]);
	} finally { chmodSync(rule, 0o600); }
});

test("absent watched paths are a recorded state; creating one is a change", () => {
	const { home, paths } = operatorHome();
	const before = snapshotWatched(paths);
	const absent = compareWatched(before, before, home);
	expect(absent).toMatchObject({ unchanged: true, complete: true });
	mkdirSync(join(home, ".local", "state", "omp-kit"), { recursive: true });
	expect(compareWatched(before, snapshotWatched(paths), home).changed_paths).toEqual(["~/.local/state/omp-kit"]);
});

test("writes by installed service jobs under the state root are not changes; any other state write is", () => {
	const { home, paths } = operatorHome(["ci-poller", "load-watch", "fleet-watch", "fleet-flush", "claude-save", "scratch-reaper"]);
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "load"), { recursive: true });
	mkdirSync(join(state, "jobs"), { recursive: true });
	mkdirSync(join(state, "scratch-quarantine", "big"), { recursive: true });
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(join(state, "ci-runs.json"), "{}\n");
	writeFileSync(join(state, "receipts", "r1.json"), "{}\n");
	const before = snapshotWatched(paths);
	writeFileSync(join(state, "ci-runs.json"), "{\"polled\":1}\n");
	appendFileSync(join(state, "load", "census.jsonl"), "{}\n");
	writeFileSync(join(state, "jobs", "ci-poller.json"), "{}\n");
	writeFileSync(join(state, "jobs", "scratch-reaper.lock"), "1\n");
	mkdirSync(join(state, "service-tmp"));
	writeFileSync(join(state, "fleet-watch-state.json"), "{}\n");
	appendFileSync(join(state, "fleet-watch.jsonl"), "{}\n");
	appendFileSync(join(state, "fleet-flush.jsonl"), "{}\n");
	writeFileSync(join(state, "claude-save-abc123.json"), "{}\n");
	appendFileSync(join(state, "scratch-reap-log.jsonl"), "{}\n");
	for (let file = 0; file < 25_000; file++) writeFileSync(join(state, "scratch-quarantine", "big", `f${file}`), "");
	const quiet = compareWatched(before, snapshotWatched(paths), home);
	expect(quiet, JSON.stringify(quiet)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
	writeFileSync(join(state, "receipts", "r1.json"), "{\"tampered\":true}\n");
	writeFileSync(join(state, "new-top-level.json"), "{}\n");
	writeFileSync(join(state, "claude-save-abc123.json.bak"), "{}\n");
	// A job's records are its own: an uninstalled job's record and a foreign file in jobs/ still count.
	writeFileSync(join(state, "jobs", "cc.lock"), "1\n");
	writeFileSync(join(state, "jobs", "codex-switch.log"), "x\n");
	expect(compareWatched(before, snapshotWatched(paths), home).changed_paths).toEqual([
		"~/.local/state/omp-kit/claude-save-abc123.json.bak",
		"~/.local/state/omp-kit/jobs/cc.lock",
		"~/.local/state/omp-kit/jobs/codex-switch.log",
		"~/.local/state/omp-kit/new-top-level.json",
		"~/.local/state/omp-kit/receipts/r1.json",
	]);
}, 120_000);

/** A real concurrent process writing the cc store, cursors and spools the way the live cc service and kit CLIs do. */
function liveCcWriter(home: string): { stop: () => void; files: string[] } {
	const cc = ccStateDir(home);
	mkdirSync(join(cc, "spool", "cc"), { recursive: true });
	mkdirSync(join(cc, "spool", "kit"), { recursive: true });
	const files = [join(cc, "cc.db"), join(cc, "cc-self.pos"), join(cc, "spool", "cc", "2026-10-22.jsonl"), join(cc, "spool", "kit", "2026-10-22.jsonl")];
	for (const file of files) writeFileSync(file, "seed\n");
	const loop = files.map(file => `printf '%s\\n' "$n" >> '${file}'`).join("; ");
	const child = Bun.spawn(["/bin/sh", "-c", `n=0; while :; do n=$((n+1)); ${loop}; sleep 0.01; done`], { stdout: "ignore", stderr: "inherit" });
	return { stop: () => child.kill("SIGKILL"), files };
}

function writesDuringSnapshot(home: string, paths: string[] & { owned?: readonly OwnedStatePath[] }, plantedWrite?: () => void) {
	const writer = liveCcWriter(home);
	try {
		const before = snapshotWatched(paths);
		// Wait until every cc file has grown past its size after the first snapshot: the writer provably wrote inside the window.
		const sizes = writer.files.map(file => statSync(file).size);
		while (writer.files.some((file, index) => statSync(file).size <= sizes[index]!)) Bun.sleepSync(5);
		plantedWrite?.();
		return compareWatched(before, snapshotWatched(paths), home);
	} finally { writer.stop(); }
}

test("planted: a live writer appending to an installed cc service's state dir is not an operator change", () => {
	const { home, paths } = operatorHome(["cc"]);
	const result = writesDuringSnapshot(home, paths);
	expect(result, JSON.stringify(result)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
	expect(KNOWN_JOBS.cc?.ownedState?.(home)).toEqual([{ path: join(home, ".local", "state", "omp-kit", "cc") }]);
}, 60_000);

test("control: beside the live cc writer, a write to an operator path is still a change", () => {
	const { home, paths } = operatorHome(["cc"]);
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(join(state, "receipts", "r1.json"), "{}\n");
	const result = writesDuringSnapshot(home, paths, () => {
		writeFileSync(join(state, "receipts", "r1.json"), "{\"tampered\":true}\n");
		writeFileSync(join(home, ".agents", "rules", "planted.md"), "planted\n");
	});
	expect(result.changed_paths).toEqual(["~/.agents/rules/planted.md", "~/.local/state/omp-kit/receipts/r1.json"]);
}, 60_000);

test("a cc state dir is watched when the cc service is not installed in this HOME", () => {
	const { home, paths } = operatorHome(["ci-poller"]);
	const result = writesDuringSnapshot(home, paths);
	expect(result.changed_paths).toEqual(expect.arrayContaining(["~/.local/state/omp-kit/cc/cc.db", "~/.local/state/omp-kit/cc/spool/kit/2026-10-22.jsonl"]));
}, 60_000);

test("mutant: the former hand-listed exclusions fail the planted live cc writer", () => {
	// SERVICE_OWNED_STATE as it stood before ompkit-2pkp1, applied to the same planted writer.
	const formerHandList: Record<string, true> = {
		"ci-runs.json": true, load: true, jobs: true, "fleet-flush.jsonl": true, "fleet-watch.jsonl": true,
		"fleet-watch-state.json": true, "scratch-quarantine": true, "scratch-reap-log.jsonl": true, "service-tmp": true,
	};
	const { home, paths } = operatorHome(["cc"]);
	paths.owned = [{ path: join(home, ".local", "state", "omp-kit"), names: name => formerHandList[name] === true }];
	const result = writesDuringSnapshot(home, paths);
	expect(result.changed_paths).toEqual(expect.arrayContaining(["~/.local/state/omp-kit/cc/cc-self.pos", "~/.local/state/omp-kit/cc/cc.db",
		"~/.local/state/omp-kit/cc/spool/cc/2026-10-22.jsonl", "~/.local/state/omp-kit/cc/spool/kit/2026-10-22.jsonl"]));
}, 60_000);

// ompkit-v66l.22 FLEETUPG1: on 2026-10-27 a long-running Chrome the kit did not start (pid 12023,
// --user-data-dir under the kit state root) wrote HTTP cache entries during the isolated test and failed
// the postcheck. Volatile browser caches churn on their own clock and the kit never writes them under a
// watched root, so their subtrees are not operator state; everything beside them still counts.
test("planted: a foreign browser cache churning under the watched state root is not an operator change", () => {
	const { home, paths } = operatorHome();
	const profile = join(home, ".local", "state", "omp-kit", "chrome-jfp", "Default");
	const cache = join(profile, "Cache", "Cache_Data");
	mkdirSync(cache, { recursive: true });
	writeFileSync(join(cache, "seed_0"), "seed");
	const before = snapshotWatched(paths);
	// Tonight's exact shape: new entries land mid-run, plus a fresh volatile cache dir appears.
	writeFileSync(join(cache, "2f139af954fbeb4a_0"), "entry");
	mkdirSync(join(profile, "Code Cache", "js"), { recursive: true });
	writeFileSync(join(profile, "Code Cache", "js", "index"), "code");
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result, JSON.stringify(result)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
}, 60_000);

test("BROWSERSNAP1 control: beside a live browser profile, operator state still counts", () => {
	const { home, paths } = operatorHome();
	const profile = join(home, ".local", "state", "omp-kit", "chrome-jfp", "Default");
	const cache = join(profile, "Cache", "Cache_Data");
	mkdirSync(cache, { recursive: true });
	const before = snapshotWatched(paths);
	writeFileSync(join(cache, "2f139af954fbeb4a_0"), "entry");
	writeFileSync(join(profile, "Preferences"), "{\"theme\":1}\n");
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), "changed rule\n");
	writeFileSync(join(home, ".local", "state", "omp-kit", "kit-activation-planted.json"), "{}\n");
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result.changed_paths).toEqual([
		"~/.agents/rules/kit-test-skip.md",
		"~/.local/state/omp-kit/kit-activation-planted.json",
	]);
}, fixtureDeadlineS() * 1000);

for (const namespace of ["chrome-jfp", "browser-profiles"]) {
	test(`BROWSERSNAP1 planted: a process writes ${namespace} profile data inside the snapshot window`, async () => {
		const { home, paths } = operatorHome();
		const base = join(home, ".local", "state", "omp-kit", namespace);
		const profile = join(base, "Default");
		mkdirSync(profile, { recursive: true });
		const cookies = join(profile, "Cookies");
		writeFileSync(cookies, "seed");
		const before = snapshotWatched(paths);
		// One write, completed before the after-snapshot: no post-run writer probe can rescue this case.
		const child = await run(["/bin/sh", "-c", 'printf changed > "$1"; mkdir -p "$2"; printf leveldb > "$2/000001.log"', "writer",
			cookies, join(profile, "Local Storage", "leveldb")], { deadline_s: fixtureDeadlineS() });
		expect(child.rc).toBe(0);
		const result = compareWatched(before, snapshotWatched(paths), home);
		expect(result).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [],
			live_state_paths: [`~/.local/state/omp-kit/${namespace}`] });
		expect(before.entries.has(cookies)).toBe(false);
	}, fixtureDeadlineS() * 1000);
}

// POSTCHECKLIVE1 (ompkit-6gbej): 0.2.88 and 0.2.89 installs ended PARTIAL because live seats wrote composer records,
// a fleet full-suite verdict (pid 75314) wrote under `.running.75314.log.files.75314/`, and `omp-kit heavy` appended
// disk-stage rows during the isolated test. Each is written once, so the 1 s post-run probe never saw them. A change
// is skipped only when its declared writer is a process proven outside the isolated test; these fixtures are real
// processes and real ps lookups.

/** ps etime is whole seconds and the judge rounds the start up one more second: a pre-run writer needs this lead. */
const PRE_RUN_LEAD_MS = 2_500;
const COMPOSER_WRITE = `printf '{"schema":1,"session_file":"/fixture/session.jsonl","pid":%s,"at":0,"empty":true}' "$$" > "$1.tmp" && mv "$1.tmp" "$1"`;

/** A real process that prints `pid <n>` first and `written` after its write; stop() kills its group. */
function fixtureProcess(argv: string[]) {
	const controller = new AbortController();
	const pid = Promise.withResolvers<number>();
	const written = Promise.withResolvers<void>();
	pid.promise.catch(() => {});
	written.promise.catch(() => {});
	let text = "";
	const done = run(argv, { deadline_s: fixtureDeadlineS(90), signal: controller.signal, on_output: (stream, chunk) => {
		if (stream !== "stdout") return;
		text += new TextDecoder().decode(chunk);
		const match = /^pid (\d+)$/m.exec(text);
		if (match) pid.resolve(Number(match[1]));
		if (/^written$/m.test(text)) written.resolve();
	} }).catch(() => null).then(result => {
		const exited = new Error(`fixture exited before reporting: ${JSON.stringify(text)} rc=${result?.rc}`);
		pid.reject(exited);
		written.reject(exited);
		return result;
	});
	return { pid: pid.promise, written: written.promise, done, stop: () => controller.abort() };
}

function script(home: string, name: string, body: string): string {
	const path = join(home, `${name}.sh`);
	writeFileSync(path, `${body}\n`);
	return path;
}

function psPgid(pid: number): number | null {
	const result = runSync(["/bin/ps", "-o", "pgid=", "-p", String(pid)], { deadline_s: fixtureDeadlineS(), env: { PATH: "/bin:/usr/bin" } });
	return result.rc === 0 ? Number(new TextDecoder().decode(result.stdout).trim()) : null;
}

function liveHome() {
	const { home, paths } = operatorHome();
	const stateRoot = join(home, ".local", "state", "omp-kit");
	// The live state root already holds these directories; only the writes inside the window are judged.
	for (const dir of ["composer", join("full-suite-verdicts", "repo"), join("disk-stage", "outbox")]) mkdirSync(join(stateRoot, dir), { recursive: true });
	return { home, paths, stateRoot };
}

/** The real comparison with one source line mutated so that every declared writer counts as proven. */
async function writerCheckRemoved() {
	const src = join(import.meta.dir, "..", "..", "src");
	const source = readFileSync(join(src, "operator-snapshot.ts"), "utf8");
	const guard = "if (!Number.isSafeInteger(pid) || pid <= 1 || pid === this.runnerPid) return null;";
	expect(source).toContain(guard);
	const mutated = source.replace(guard, 'return { pid, rule: "started-before-run", started_by: new Date(0).toISOString(), pgid: 0 };')
		.replaceAll('from "./', `from "${src}/`);
	const dir = ownedTmp("operator-snapshot-mutant", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(dir);
	writeFileSync(join(dir, "operator-snapshot.mutant.ts"), mutated);
	// The mutant module exists only at test time, so no static import can name it.
	const mutant: { liveWriterPaths: typeof liveWriterPaths; compareWatched: typeof compareWatched } = await import(join(dir, "operator-snapshot.mutant.ts"));
	return mutant;
}

test("POSTCHECKLIVE1 planted: a composer record rewritten by a writer started before the run, outside its group, is skipped-live-writer", async () => {
	const { home, paths, stateRoot } = liveHome();
	const record = join(stateRoot, "composer", "0123456789abcdef.json");
	writeFileSync(record, "{\"schema\":1,\"pid\":1,\"at\":0,\"empty\":false}");
	const writer = fixtureProcess(["/bin/sh", script(home, "seat", `echo pid $$; sleep 5; ${COMPOSER_WRITE}; echo written; exec sleep 60`), record]);
	try {
		const pid = await writer.pid;
		expect(psPgid(pid)).toBe(pid);
		expect(psPgid(pid)).not.toBe(psPgid(process.pid));
		await Bun.sleep(PRE_RUN_LEAD_MS); // Real clock on purpose: the judge reads real process start times from ps.
		const runStartedMs = Date.now();
		const before = snapshotWatched(paths);
		await writer.written;
		const after = snapshotWatched(paths);
		const live = liveWriterPaths(before, after, { stateRoot, runStartedMs });
		const result = compareWatched(before, after, home, undefined, live);
		expect(result, JSON.stringify(result)).toMatchObject({ unchanged: false, complete: true, changed_paths: [], skipped_paths: [],
			skipped_live_writer_paths: [{ path: "~/.local/state/omp-kit/composer/0123456789abcdef.json", reason: "skipped-live-writer",
				evidence: { source: "composer-record", writers: [{ pid, rule: "started-before-run", pgid: pid }] } }] });
		// Paired control: without the writer evidence the same change is the failure 0.2.89 reported.
		expect(compareWatched(before, after, home).changed_paths).toEqual(["~/.local/state/omp-kit/composer/0123456789abcdef.json"]);
	} finally { writer.stop(); await writer.done; }
}, fixtureDeadlineS(30) * 1000);

test("POSTCHECKLIVE1 negative: a composer record still fails when its writer is in the runner's process group or exited after the run began", async () => {
	const { home, paths, stateRoot } = liveHome();
	const inside = join(stateRoot, "composer", "1111111111111111.json"), dead = join(stateRoot, "composer", "2222222222222222.json");
	const runStartedMs = Date.now();
	const before = snapshotWatched(paths);
	// The runner's background child shares its process group, exactly as an isolated-test process shares the test's.
	const child = script(home, "inside", `sleep 2.5; ${COMPOSER_WRITE}; echo written; exec sleep 60`);
	const runner = fixtureProcess(["/bin/sh", "-c", 'echo pid $$; /bin/sh "$1" "$2" & wait', "runner", child, inside]);
	const exited = fixtureProcess(["/bin/sh", script(home, "dead", `echo pid $$; ${COMPOSER_WRITE}; echo written`), dead]);
	try {
		const runnerPid = await runner.pid, deadPid = await exited.pid;
		await Promise.all([runner.written, exited.done]);
		const record: unknown = JSON.parse(readFileSync(inside, "utf8"));
		const insidePid = record && typeof record === "object" && "pid" in record && typeof record.pid === "number" ? record.pid : -1;
		expect(insidePid).toBeGreaterThan(1);
		expect(insidePid).not.toBe(runnerPid);
		expect(psPgid(insidePid)).toBe(runnerPid);
		expect(psPgid(deadPid)).toBeNull();
		const after = snapshotWatched(paths);
		const context = { stateRoot, runStartedMs, runnerPid };
		const live = liveWriterPaths(before, after, context);
		expect([...live.keys()]).toEqual([]);
		const result = compareWatched(before, after, home, undefined, live);
		expect(result.changed_paths).toEqual(["~/.local/state/omp-kit/composer/1111111111111111.json", "~/.local/state/omp-kit/composer/2222222222222222.json"]);
		expect(result.skipped_live_writer_paths).toEqual([]);
		// Mutant: with the writer check removed, both negatives wrongly pass.
		const mutant = await writerCheckRemoved();
		const mutantLive = mutant.liveWriterPaths(before, after, context);
		expect(mutant.compareWatched(before, after, home, undefined, mutantLive).changed_paths).toEqual([]);
	} finally { runner.stop(); await Promise.all([runner.done, exited.done]); }
}, fixtureDeadlineS(30) * 1000);

test("POSTCHECKLIVE1 planted: a .running.<pid> verdict file from a live outside process is skipped (darwin); an unattributed state file still fails", async () => {
	const { home, paths, stateRoot } = liveHome();
	const verdicts = join(stateRoot, "full-suite-verdicts", "repo");
	// A separate runner: the verdict writer descends from this test process, not from the runner.
	const runner = fixtureProcess(["/bin/sh", "-c", "echo pid $$; exec sleep 60"]);
	const runnerPid = await runner.pid;
	const runStartedMs = Date.now();
	const before = snapshotWatched(paths);
	const verdict = fixtureProcess(["/bin/sh", script(home, "verdict",
		'echo pid $$; sleep 2.5; out="$1/tree.base.abc.running.$$.log"; mkdir -p "$out.files.$$/case"; printf log > "$out"; printf c > "$out.files.$$/case/report.json"; echo written; exec sleep 60'), verdicts]);
	try {
		const pid = await verdict.pid;
		await verdict.written;
		writeFileSync(join(stateRoot, "unattributed.json"), "{}\n");
		writeFileSync(join(verdicts, "tree.base.abc.running.999999999.log"), "no such writer\n");
		const after = snapshotWatched(paths);
		const live = liveWriterPaths(before, after, { stateRoot, runStartedMs, runnerPid });
		const result = compareWatched(before, after, home, undefined, live);
		const verdictPaths = [`tree.base.abc.running.${pid}.log`, `tree.base.abc.running.${pid}.log.files.${pid}`,
			`tree.base.abc.running.${pid}.log.files.${pid}/case`, `tree.base.abc.running.${pid}.log.files.${pid}/case/report.json`]
			.map(name => `~/.local/state/omp-kit/full-suite-verdicts/repo/${name}`).sort();
		const unattributed = ["~/.local/state/omp-kit/full-suite-verdicts/repo/tree.base.abc.running.999999999.log", "~/.local/state/omp-kit/unattributed.json"];
		if (process.platform === "darwin") {
			expect(result.changed_paths, JSON.stringify(result)).toEqual(unattributed);
			expect(result.skipped_live_writer_paths?.map(entry => entry.path)).toEqual(verdictPaths);
			expect(result.skipped_live_writer_paths?.[0]?.evidence).toMatchObject({ source: "verdict-running-path",
				writers: [{ pid, rule: "alive-outside-runner", pgid: pid, ancestor: { pid: process.pid } }] });
		} else {
			// Linux subreapers can adopt isolated-test orphans, so only a pre-run writer counts there.
			expect(result.changed_paths).toEqual([...verdictPaths, ...unattributed].sort());
		}
	} finally { runner.stop(); verdict.stop(); await Promise.all([runner.done, verdict.done]); }
}, fixtureDeadlineS(30) * 1000);

test("POSTCHECKLIVE1 disk-stage: an appended admission row from a pre-run writer is skipped; a row without a writer or a rewritten prefix fails", async () => {
	const { home, paths, stateRoot } = liveHome();
	const receipts = join(stateRoot, "disk-stage", "receipts.jsonl");
	// A row from before rows named their writer: never judged, because only the appended suffix is.
	writeFileSync(receipts, `${JSON.stringify({ ts: "2026-11-04T00:00:00.000Z", action: "heavy-admit" })}\n`, { mode: 0o600 });
	const diskStage = join(import.meta.dir, "..", "..", "src", "disk-stage.ts");
	const writer = fixtureProcess([process.execPath, "-e", `console.log("pid " + process.pid); await Bun.sleep(5000);
const { admitDiskWork } = await import(${JSON.stringify(diskStage)});
admitDiskWork("heavy", "/", { stateDir: ${JSON.stringify(join(stateRoot, "disk-stage"))}, readFreePct: () => 50 });
console.log("written"); await Bun.sleep(60000);`]);
	try {
		const pid = await writer.pid;
		await Bun.sleep(PRE_RUN_LEAD_MS); // Real clock on purpose: the judge reads real process start times from ps.
		const runStartedMs = Date.now();
		const context = { stateRoot, runStartedMs };
		const before = snapshotWatched(paths);
		await writer.written;
		const appended = snapshotWatched(paths);
		const rows = readFileSync(receipts, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(rows[1]).toMatchObject({ action: "heavy-admit", pid, ppid: process.pid });
		const live = liveWriterPaths(before, appended, context);
		expect(compareWatched(before, appended, home, undefined, live)).toMatchObject({ changed_paths: [],
			skipped_live_writer_paths: [{ path: "~/.local/state/omp-kit/disk-stage/receipts.jsonl", reason: "skipped-live-writer",
				evidence: { source: "disk-stage-append", writers: [{ pid, rule: "started-before-run" }] } }] });

		// An older writer's row carries no pid: unattributed, still a failure.
		appendFileSync(receipts, `${JSON.stringify({ ts: new Date().toISOString(), action: "heavy-admit" })}\n`);
		const noWriter = snapshotWatched(paths);
		expect(compareWatched(appended, noWriter, home, undefined, liveWriterPaths(appended, noWriter, context)).changed_paths)
			.toEqual(["~/.local/state/omp-kit/disk-stage/receipts.jsonl"]);

		// Not an append: rows naming the same proven writer do not rescue a rewritten prefix.
		writeFileSync(receipts, `${JSON.stringify({ ts: new Date().toISOString(), action: "heavy-admit", pid, ppid: process.pid })}\n`);
		const rewritten = snapshotWatched(paths);
		expect(compareWatched(noWriter, rewritten, home, undefined, liveWriterPaths(noWriter, rewritten, context)).changed_paths)
			.toEqual(["~/.local/state/omp-kit/disk-stage/receipts.jsonl"]);
	} finally { writer.stop(); await writer.done; }
}, fixtureDeadlineS(30) * 1000);
