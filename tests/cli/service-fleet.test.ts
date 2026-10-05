import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KNOWN_JOBS } from "../../src/service.ts";

// SVC1 box 2: the fleet view. `service status --all` and `service list` must
// report loaded state, last exit, last run age and run count per job.
// RED until the parser --all exemption + row enrichment land in src/cli.ts.
//
// Launchd-domain safety: every CLI spawn below gets its own
// OMP_KIT_TEST_LABEL_NAMESPACE via extraEnv (never process.env, so this file
// cannot clobber service.test.ts's namespace when bun shares one process).

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function namespace(): string {
	return `com.omp-kit.test.fleet${Math.random().toString(36).slice(2, 10)}`;
}

function fixtureHome(): string {
	const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-fleet-"));
	roots.push(home);
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(join(bin, "omp-kit"), 0o755);
	return home;
}

function cli(args: string[], home: string, ns: string) {
	const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
		cwd: home,
		env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_TEST_LABEL_NAMESPACE: ns },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

const JOB_NAMES = Object.keys(KNOWN_JOBS);

test("service status --all reports one row per known job", () => {
	const home = fixtureHome();
	const result = cli(["service", "status", "--all"], home, namespace());
	expect(result.envelope.errors ?? []).toEqual([]);
	const rows = result.envelope.data.status;
	expect(rows.map((row: { name: string }) => row.name).sort()).toEqual([...JOB_NAMES].sort());
});

test("service status --all rows carry loaded, last exit and run count", () => {
	const home = fixtureHome();
	const result = cli(["service", "status", "--all"], home, namespace());
	for (const row of result.envelope.data.status) {
		expect(typeof row.loaded, row.name).toBe("boolean");
		expect("lastExit" in row, row.name).toBe(true);
		expect("runs" in row, row.name).toBe(true);
	}
});

test("planted: a loaded job is reported loaded, never shadowed", () => {
	if (process.platform !== "darwin") {
		console.info("skip: launchd labels exist only on macOS");
		return;
	}
	const home = fixtureHome();
	const ns = namespace();
	const label = `${ns}.omp-watch`;
	try {
		const installed = cli(["service", "install", "omp-watch", "--apply", "--yes"], home, ns);
		expect(installed.code).toBe(0);
		const result = cli(["service", "status", "--all"], home, ns);
		const row = result.envelope.data.status.find((entry: { name: string }) => entry.name === "omp-watch");
		expect(row.loaded).toBe(true);
		expect(row.label).toBe(label);
	} finally {
		Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${label}`], { stdout: "pipe", stderr: "pipe" });
	}
});

test("service status --all rows carry last run age from the job receipt", () => {
	const home = fixtureHome();
	const finished = "2026-10-04T12:00:00.000Z";
	const dir = join(home, ".local", "state", "omp-kit", "jobs");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "omp-watch.json"),
		`${JSON.stringify({ started_at: finished, finished_at: finished, exit: 0, omp_version: null })}\n`, { mode: 0o600 });
	const result = cli(["service", "status", "--all"], home, namespace());
	const row = result.envelope.data.status.find((entry: { name: string }) => entry.name === "omp-watch");
	expect(row.last_run_at).toBe(finished);
});

test("service list rows carry loaded, last exit, runs and last run age", () => {
	const home = fixtureHome();
	const result = cli(["service", "list"], home, namespace());
	expect(result.code).toBe(0);
	for (const row of result.envelope.data.jobs) {
		expect(typeof row.loaded, row.name).toBe("boolean");
		expect("lastExit" in row, row.name).toBe(true);
		expect("runs" in row, row.name).toBe(true);
		expect("last_run_at" in row, row.name).toBe(true);
	}
});

test("service doctor --all reaches the handler", () => {
	const home = fixtureHome();
	const result = cli(["service", "doctor", "--all"], home, namespace());
	expect(result.envelope.errors ?? []).toEqual([]);
	expect(result.envelope.data.checks.length).toBeGreaterThan(0);
});
