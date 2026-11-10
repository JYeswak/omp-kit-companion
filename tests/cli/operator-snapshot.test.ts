import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareWatched, liveWriterPaths, operatorWatchedPaths, operatorWriteFence, snapshotWatched } from "../../src/operator-snapshot.ts";
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

// POSTCHECKSTATE1: release installs kept failing the postcheck as unreadable because the state root holds
// ~10 GB outside job-owned dirs while snapshotWatched capped every root at 512 MB. The state root alone now
// records files past its per-file hash line by stable metadata, so bulk is complete while any isolated-run
// write under it still counts.
test("POSTCHECKSTATE1: a state root over the byte budget is complete and unchanged", () => {
	const { home, paths } = operatorHome();
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(join(state, "receipts", "r1.json"), "{}\n");
	const big = join(state, "poll-0.2.99", "release.tar.gz");
	mkdirSync(join(big, ".."), { recursive: true });
	writeFileSync(big, "");
	truncateSync(big, 512 * 1024 * 1024 + 1);
	expect(statSync(big).size).toBe(512 * 1024 * 1024 + 1);
	const before = snapshotWatched(paths);
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result, JSON.stringify(result)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
}, fixtureDeadlineS() * 1000);

test("POSTCHECKSTATE1 planted: an append under an over-budget state root is still reported", () => {
	const { home, paths } = operatorHome();
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(join(state, "receipts", "r1.json"), "{}\n");
	const big = join(state, "poll-0.2.99", "release.tar.gz");
	mkdirSync(join(big, ".."), { recursive: true });
	writeFileSync(big, "");
	truncateSync(big, 512 * 1024 * 1024 + 1);
	const before = snapshotWatched(paths);
	appendFileSync(join(state, "receipts", "r1.json"), "{\"tampered\":true}\n");
	appendFileSync(big, "x");
	writeFileSync(join(state, "new-top-level.json"), "{}\n");
	const result = compareWatched(before, snapshotWatched(paths), home);
	expect(result.complete).toBe(true);
	expect(result.changed_paths).toEqual([
		"~/.local/state/omp-kit/new-top-level.json",
		"~/.local/state/omp-kit/poll-0.2.99/release.tar.gz",
		"~/.local/state/omp-kit/receipts/r1.json",
	]);
}, fixtureDeadlineS() * 1000);

// POSTCHECKSTATE1 (0.2.108 follow-up): the live fleet appends wake ledgers, scratch accounting and kit-update
// job records under the real state root minutes apart, so the post-run writer probe cannot catch them. These
// declared namespaces are live state the snapshot does not judge; everything else stays watched.
test("POSTCHECKSTATE1: live-fleet writes under the state root are live state, other state still counts", () => {
	const { home, paths } = operatorHome();
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "receipts"), { recursive: true });
	mkdirSync(join(state, "inbox-wake"), { recursive: true });
	mkdirSync(join(state, "scratch-users"), { recursive: true });
	mkdirSync(join(state, "send-drop"), { recursive: true });
	mkdirSync(join(state, "write-ledger"), { recursive: true });
	writeFileSync(join(state, "gate-events.jsonl"), "{\"open\":1}\n");
	writeFileSync(join(state, "mail-wake.jsonl"), "{\"open\":1}\n");
	writeFileSync(join(state, "scratch-budgets.json"), "{}\n");
	writeFileSync(join(state, "inbox-wake", "Agent.abc123.json"), "{}\n");
	writeFileSync(join(state, "scratch-users", "def456.lock"), "1\n");
	writeFileSync(join(state, "git-lock-rate.0.json.lock"), "1\n");
	writeFileSync(join(state, "kit-update-job-11111111-2222-3333-4444-555555555555.json"), "{}\n");
	const before = snapshotWatched(paths);
	// The fleet's own clock during the isolated run: appends, a new wake file, a new job record, a rate tmp.
	appendFileSync(join(state, "gate-events.jsonl"), "{\"tick\":2}\n");
	writeFileSync(join(state, "inbox-wake", "Agent.789xyz.json"), "{}\n");
	appendFileSync(join(state, "scratch-users", "def456.lock"), "2\n");
	writeFileSync(join(state, "kit-update-job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json"), "{}\n");
	writeFileSync(join(state, "git-lock-rate.1.json.tmp.12345"), "{}\n");
	// 0.2.109 install: seats' send drops, write-ledger appends and upgrade notices landed mid-postcheck.
	writeFileSync(join(state, "send-drop", "cfsios-1-kit-send-ce1bd6d1a31e.md"), "drop\n");
	writeFileSync(join(state, "write-ledger", "2026-11-10.jsonl"), "{}\n");
	writeFileSync(join(state, "upgrade-notice-4cfb58040454d8b4.json"), "[]\n");
	const quiet = compareWatched(before, snapshotWatched(paths), home);
	expect(quiet, JSON.stringify(quiet)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
	expect(quiet.live_state_paths).toEqual([
		"~/.local/state/omp-kit/gate-events.jsonl",
		"~/.local/state/omp-kit/git-lock-rate.0.json.lock",
		"~/.local/state/omp-kit/git-lock-rate.1.json.tmp.12345",
		"~/.local/state/omp-kit/inbox-wake",
		"~/.local/state/omp-kit/kit-update-job-11111111-2222-3333-4444-555555555555.json",
		"~/.local/state/omp-kit/kit-update-job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json",
		"~/.local/state/omp-kit/mail-wake.jsonl",
		"~/.local/state/omp-kit/scratch-budgets.json",
		"~/.local/state/omp-kit/scratch-users",
		"~/.local/state/omp-kit/send-drop",
		"~/.local/state/omp-kit/upgrade-notice-4cfb58040454d8b4.json",
		"~/.local/state/omp-kit/write-ledger",
	]);
	// Planted: a kit receipt the fleet never writes is still reported beside the live state.
	writeFileSync(join(state, "receipts", "x.json"), "{}\n");
	expect(compareWatched(before, snapshotWatched(paths), home).changed_paths).toEqual([
		"~/.local/state/omp-kit/receipts/x.json",
	]);
}, fixtureDeadlineS() * 1000);

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

// POSTCHECKLIVE1 / POSTFENCE (ompkit-6gbej): 0.2.88 and 0.2.89 installs ended PARTIAL because live seats wrote composer
// records, a fleet full-suite verdict wrote under `.running.<pid>.log.files.<pid>/`, and `omp-kit heavy` appended
// disk-stage rows during the isolated test. A file's content never proves who wrote it (the forged case below), so a
// change under those namespaces is skipped only when every isolated-test process ran under the operator write fence;
// without a fence it fails. The fenced writes here are real sandbox-exec runs of the exact profile the runner uses.

/** ps etime is whole seconds and 1ed34c74e6's judge rounded the start up one more second: its pre-run rule needed this lead. */
const PRE_RUN_LEAD_MS = 2_500;
const COMPOSER_WRITE = `printf '{"schema":1,"session_file":"/fixture/session.jsonl","pid":%s,"at":0,"empty":true}' "$$" > "$1.tmp" && mv "$1.tmp" "$1"`;
const darwinTest = process.platform === "darwin" ? test : test.skip;

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

/** The live fleet's writes during a run: a seat's composer record, a verdict log subtree, a disk-stage row, a deleted record. */
async function fleetWrites(home: string, stateRoot: string) {
	const composer = join(stateRoot, "composer");
	writeFileSync(join(composer, "4444444444444444.json"), '{"schema":1,"pid":1,"at":0,"empty":true}');
	const receipts = join(stateRoot, "disk-stage", "receipts.jsonl");
	writeFileSync(receipts, `${JSON.stringify({ ts: "2026-11-04T00:00:00.000Z", action: "heavy-admit" })}\n`, { mode: 0o600 });
	return {
		write: async () => {
			const seat = await run(["/bin/sh", script(home, "fleet-seat", COMPOSER_WRITE), join(composer, "0123456789abcdef.json")], { deadline_s: fixtureDeadlineS() });
			expect(seat.rc).toBe(0);
			const verdict = join(stateRoot, "full-suite-verdicts", "repo", "tree.base.abc.running.75314.log");
			mkdirSync(`${verdict}.files.75314/case`, { recursive: true });
			writeFileSync(verdict, "log\n");
			writeFileSync(`${verdict}.files.75314/case/report.json`, "{}\n");
			appendFileSync(receipts, `${JSON.stringify({ ts: new Date().toISOString(), action: "heavy-admit" })}\n`);
			rmSync(join(composer, "4444444444444444.json"));
		},
		fleetPaths: ["composer/0123456789abcdef.json", "composer/4444444444444444.json", "disk-stage/receipts.jsonl",
			"full-suite-verdicts/repo/tree.base.abc.running.75314.log", "full-suite-verdicts/repo/tree.base.abc.running.75314.log.files.75314",
			"full-suite-verdicts/repo/tree.base.abc.running.75314.log.files.75314/case",
			"full-suite-verdicts/repo/tree.base.abc.running.75314.log.files.75314/case/report.json"].map(rel => `~/.local/state/omp-kit/${rel}`).sort(),
	};
}

/** The real comparison with the fence guard removed: every namespace change counts as fenced. */
async function fenceCheckRemoved() {
	const src = join(import.meta.dir, "..", "..", "src");
	const source = readFileSync(join(src, "operator-snapshot.ts"), "utf8");
	const guard = "if (!stateRoot || !fence || fence.stateRoot !== stateRoot) return attributed;";
	const evidence = "profile_sha256: fence.profile_sha256 }";
	expect(source).toContain(guard);
	expect(source).toContain(evidence);
	const mutated = source.replace(guard, "if (!stateRoot) return attributed;").replace(evidence, 'profile_sha256: fence?.profile_sha256 ?? "" }')
		.replaceAll('from "./', `from "${src}/`);
	const dir = ownedTmp("operator-snapshot-mutant", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(dir);
	writeFileSync(join(dir, "operator-snapshot.mutant.ts"), mutated);
	// The mutant module exists only at test time, so no static import can name it.
	const mutant: { liveWriterPaths: typeof liveWriterPaths; compareWatched: typeof compareWatched } = await import(join(dir, "operator-snapshot.mutant.ts"));
	return mutant;
}

darwinTest("POSTFENCE planted: under the run's write fence, live-fleet writes to composer, verdicts and disk-stage are skipped-live-writer; other state still fails", async () => {
	const { home, paths, stateRoot } = liveHome();
	const fence = operatorWriteFence(stateRoot);
	expect(fence).not.toBeNull();
	const fleet = await fleetWrites(home, stateRoot);
	const before = snapshotWatched(paths);
	await fleet.write();
	writeFileSync(join(stateRoot, "unattributed.json"), "{}\n");
	writeFileSync(join(stateRoot, "composer.bak"), "{}\n");
	const after = snapshotWatched(paths);
	const result = compareWatched(before, after, home, undefined, liveWriterPaths(before, after, { stateRoot, fence }));
	expect(result.changed_paths, JSON.stringify(result)).toEqual(["~/.local/state/omp-kit/composer.bak", "~/.local/state/omp-kit/unattributed.json"]);
	expect(result.skipped_live_writer_paths?.map(entry => entry.path)).toEqual(fleet.fleetPaths);
	expect(result.skipped_live_writer_paths?.find(entry => entry.path.endsWith("receipts.jsonl"))?.evidence)
		.toEqual({ source: "write-fence", namespace: join(stateRoot, "disk-stage", "receipts.jsonl"), profile_sha256: fence!.profile_sha256 });
	expect(createHash("sha256").update(fence!.profile).digest("hex")).toBe(fence!.profile_sha256);
}, fixtureDeadlineS(30) * 1000);

test("POSTFENCE negative: with no fence (Linux, no sandbox-exec) or a fence for another state root, every live-fleet write fails", async () => {
	const { home, paths, stateRoot } = liveHome();
	const fleet = await fleetWrites(home, stateRoot);
	const before = snapshotWatched(paths);
	await fleet.write();
	const after = snapshotWatched(paths);
	expect(operatorWriteFence(stateRoot, "linux")).toBeNull();
	expect(operatorWriteFence(stateRoot, "darwin", join(home, "no-such-sandbox-exec"))).toBeNull();
	const unfenced = liveWriterPaths(before, after, { stateRoot, fence: null });
	expect([...unfenced.keys()]).toEqual([]);
	expect(compareWatched(before, after, home, undefined, unfenced).changed_paths).toEqual(fleet.fleetPaths);
	const other = operatorWriteFence(join(home, "other-state"), "darwin", process.execPath);
	expect([...liveWriterPaths(before, after, { stateRoot, fence: other }).keys()]).toEqual([]);
	// Mutant: with the fence guard removed, the unfenced writes wrongly pass.
	const mutant = await fenceCheckRemoved();
	expect(mutant.compareWatched(before, after, home, undefined, mutant.liveWriterPaths(before, after, { stateRoot, fence: null })).changed_paths).toEqual([]);
}, fixtureDeadlineS(30) * 1000);

test("POSTCHECKLIVE1 forged: a runner-group process rewriting a composer record with a live pre-run seat's pid still fails", async () => {
	const { home, paths, stateRoot } = liveHome();
	const record = join(stateRoot, "composer", "3333333333333333.json");
	// A real seat, alive and started before the run, owns the record (its pid in its own group).
	const seat = fixtureProcess(["/bin/sh", script(home, "forged-seat", `echo pid $$; ${COMPOSER_WRITE}; echo written; exec sleep 60`), record]);
	try {
		const seatPid = await seat.pid;
		await seat.written;
		// Real clock on purpose: 1ed34c74e6 skipped this leak as started-before-run once ps showed the seat predating the run.
		await Bun.sleep(PRE_RUN_LEAD_MS);
		const before = snapshotWatched(paths);
		// The leak: a process in this runner's process group reads the record and rewrites it, keeping the seat's pid.
		const leak = (argv: string[]) => run([...argv, process.execPath, "-e", `const fs = require("fs"); const p = process.argv[1];
const record = JSON.parse(fs.readFileSync(p, "utf8")); fs.writeFileSync(p, JSON.stringify({ ...record, empty: false, forged: true }));`, record],
			{ deadline_s: fixtureDeadlineS() });
		const fence = operatorWriteFence(stateRoot);
		if (fence) {
			// Under the fence the isolated test cannot make the write at all: EPERM, its own failure, nothing to judge.
			const fenced = await leak([fence.executable, "-p", fence.profile]);
			expect(fenced.rc).not.toBe(0);
			expect(new TextDecoder().decode(fenced.stderr)).toContain("EPERM");
			const untouched = snapshotWatched(paths);
			expect(compareWatched(before, untouched, home, undefined, liveWriterPaths(before, untouched, { stateRoot, fence })).unchanged).toBe(true);
		}
		const leaked = await leak([]);
		expect(leaked.rc, new TextDecoder().decode(leaked.stderr)).toBe(0);
		const forged: unknown = JSON.parse(readFileSync(record, "utf8"));
		expect(forged).toMatchObject({ pid: seatPid, forged: true });
		expect(psPgid(seatPid)).toBe(seatPid);
		const after = snapshotWatched(paths);
		// The unfenced leak names a live, pre-run seat: content is not provenance, so it fails.
		const result = compareWatched(before, after, home, undefined, liveWriterPaths(before, after, { stateRoot, fence: null }));
		expect(result.changed_paths, JSON.stringify(result)).toEqual(["~/.local/state/omp-kit/composer/3333333333333333.json"]);
		expect(result.skipped_live_writer_paths).toEqual([]);
	} finally { seat.stop(); await seat.done; }
}, fixtureDeadlineS(30) * 1000);
