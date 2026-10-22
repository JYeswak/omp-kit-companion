import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareWatched, operatorWatchedPaths, snapshotWatched } from "../../src/operator-snapshot.ts";
import { ccStateDir, KNOWN_JOBS, plistPath, serviceLabel, type OwnedStatePath } from "../../src/service.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
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
