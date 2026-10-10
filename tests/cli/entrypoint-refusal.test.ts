import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ompkit-bj08.5 round 2: pause and missing-source refusals through the real
// CLI entrypoints. Each case runs `omp-kit service run` in a child process
// against a fixture HOME; no tmux server, no fleet pane and no model is ever
// touched (the refused paths return before any capture, send or body runs).
//
// NOTE: these suites spawn src/cli.ts, so they need a consistent checkout;
// they run green on clean trees (pre-push FRESH-GATE runs them on the
// candidate archive) and fail in checkouts with unrelated breakage.

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function namespace(): string {
	return `com.omp-kit.test.entryref${Math.random().toString(36).slice(2, 10)}`;
}

function fixtureHome(): string {
	const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "entrypoint-refusal-"));
	roots.push(home);
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(join(bin, "omp-kit"), 0o755);
	return home;
}

function cli(args: string[], home: string, ns: string, extraEnv: Record<string, string> = {}) {
	const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
		cwd: home,
		env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_TEST_LABEL_NAMESPACE: ns, ...extraEnv },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

function stateRoot(home: string): string {
	return join(home, ".local", "state", "omp-kit");
}

test("[b] planted via CLI: declared pause refuses the run with zero effects", () => {
	const home = fixtureHome();
	mkdirSync(stateRoot(home), { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot(home), "load-watch.off"), "paused for the incident\n");
	const result = cli(["service", "run", "load-watch"], home, namespace());
	expect(result.code).toBe(0);
	expect(result.envelope.data.status).toBe("OFF");
	expect("receipt" in result.envelope.data).toBe(false);
	expect(existsSync(join(stateRoot(home), "load"))).toBe(false);
});

test("[b] planted via CLI: unreadable lock source refuses overlap with no work", () => {
	const home = fixtureHome();
	const jobsDir = join(stateRoot(home), "jobs");
	mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(jobsDir, "load-watch.lock"), "not a directory");
	const result = cli(["service", "run", "load-watch"], home, namespace());
	expect(result.code).toBe(4);
	expect(result.envelope.data.status).toBe("SKIPPED-OVERLAP");
	expect(existsSync(join(stateRoot(home), "load"))).toBe(false);
});

test("[b] planted via CLI: disabled fleet-watch runs zero sends", () => {
	const home = fixtureHome();
	const configPath = join(home, "fleet-watch.json");
	writeFileSync(configPath, JSON.stringify({
		enabled: false, intervalSeconds: 60, noDecisionChecks: 5,
		sessions: [{ session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"] }],
	}));
	const result = cli(["service", "run", "fleet-watch"], home, namespace(), {
		OMP_KIT_FLEET_WATCH_CONFIG: configPath,
		OMP_KIT_LOAD_OVERRIDE: "0.5/8",
	});
	expect(result.code).toBe(0);
	expect(result.envelope.data.actions).toEqual([]);
	expect(existsSync(join(stateRoot(home), "fleet-watch.jsonl"))).toBe(false);
});

test("[b] planted via CLI: missing fleet-watch config refuses before any run", () => {
	const home = fixtureHome();
	const result = cli(["service", "run", "fleet-watch"], home, namespace(), {
		OMP_KIT_FLEET_WATCH_CONFIG: join(home, "absent.json"),
		OMP_KIT_LOAD_OVERRIDE: "0.5/8",
	});
	expect(result.envelope.errors?.[0]?.code).toBe("FLEET_WATCH_CONFIG_MISSING");
	expect(existsSync(join(stateRoot(home), "fleet-watch.jsonl"))).toBe(false);
});
