import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareWatched, operatorWatchedPaths, snapshotWatched } from "../../src/operator-snapshot.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); } }, 60_000);

function operatorHome() {
	const scratch = join(import.meta.dir, "../../var/agent-tmp");
	const home = mkdtempSync(join(scratch, "operator-snapshot-"));
	roots.push(home);
	mkdirSync(join(home, ".omp", "agent", "rules"), { recursive: true });
	mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "ttsr:\n  enabled: true\n");
	writeFileSync(join(home, ".omp", "profiles", "work", "agent", "config.yml"), "modelRoles: {}\n");
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), "---\ncondition: 'x'\n---\nrule\n");
	const paths = operatorWatchedPaths(home, join(home, ".local", "state", "omp-kit"));
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

test("writes by the kit's own service jobs under the state root are not changes; any other state write is", () => {
	const { home, paths } = operatorHome();
	const state = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(state, "load"), { recursive: true });
	mkdirSync(join(state, "scratch-quarantine", "big"), { recursive: true });
	mkdirSync(join(state, "receipts"), { recursive: true });
	writeFileSync(join(state, "ci-runs.json"), "{}\n");
	writeFileSync(join(state, "receipts", "r1.json"), "{}\n");
	const before = snapshotWatched(paths);
	writeFileSync(join(state, "ci-runs.json"), "{\"polled\":1}\n");
	appendFileSync(join(state, "load", "census.jsonl"), "{}\n");
	writeFileSync(join(state, "fleet-watch-state.json"), "{}\n");
	writeFileSync(join(state, "claude-save-abc123.json"), "{}\n");
	for (let file = 0; file < 25_000; file++) writeFileSync(join(state, "scratch-quarantine", "big", `f${file}`), "");
	const quiet = compareWatched(before, snapshotWatched(paths), home);
	expect(quiet, JSON.stringify(quiet)).toMatchObject({ unchanged: true, complete: true, changed_paths: [], incomplete_paths: [] });
	writeFileSync(join(state, "receipts", "r1.json"), "{\"tampered\":true}\n");
	writeFileSync(join(state, "new-top-level.json"), "{}\n");
	writeFileSync(join(state, "claude-save-abc123.json.bak"), "{}\n");
	expect(compareWatched(before, snapshotWatched(paths), home).changed_paths).toEqual([
		"~/.local/state/omp-kit/claude-save-abc123.json.bak",
		"~/.local/state/omp-kit/new-top-level.json",
		"~/.local/state/omp-kit/receipts/r1.json",
	]);
}, 120_000);
