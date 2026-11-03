import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpus } from "node:os";
import { ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { gateFunctions } from "./fresh-gate.helpers";

const root = resolve(import.meta.dir, "../..");
const metrics = join(root, "scripts/suite-metrics.py");
const width = Math.max(2, Math.min(6, Math.floor(cpus().length / 4)));
const tree = "a".repeat(40);
type FocusFixture = { dir: string; invoke: (argv: string[], deadline?: number) => { rc: number | null; out: string } };

function fixture() {
	const scratch = ownedTmp("fresh-load-test", { root: join(root, "var/agent-tmp") });
	const dir = scratch.path;
	for (const path of ["tests/cli", "var/agent-tmp", ".github", "home/.config", "home/.cache", "home/.local/share", "home/.state", "audit", "active"]) mkdirSync(join(dir, path), { recursive: true });
	writeFileSync(join(dir, "bunfig.toml"), "[test]\ntimeout = 120000\n");
	writeFileSync(join(dir, "changed"), "tests/cli/control.test.ts\n");
	writeFileSync(join(dir, "queued.secs"), "0\n");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, { HOME: join(dir, "home"), TMPDIR: join(dir, "var/agent-tmp"),
		XDG_CONFIG_HOME: join(dir, "home/.config"), XDG_CACHE_HOME: join(dir, "home/.cache"),
		XDG_DATA_HOME: join(dir, "home/.local/share"), XDG_STATE_HOME: join(dir, "home/.state"),
		OMP_KIT_SUITE_HERMETIC_ENABLE: "0", OMP_KIT_CC: "0" });
	const invoke = (argv: string[], deadline = 30) => {
		const result = runSync(argv, { cwd: dir, env, deadline_s: deadline });
		return { ...result, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString() };
	};
	const load = (paths: string[], policyRoot = root, workers = width, deadline = 30) => invoke([
		"python3", metrics, "load", "--cwd", dir, "--tree", tree,
		"--records", join(dir, `records-${Math.random().toString(36).slice(2)}`), "--changed-files", join(dir, "changed"),
		"--policy-root", policyRoot, "--workers", String(workers), ...paths,
	], deadline);
	return { dir, scratch, invoke, load };
}

function control(dir: string, name: string) {
	writeFileSync(join(dir, "tests/cli", name), `
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
test("hermetic fixed-name control", async () => {
  const locations = [process.env.HOME, process.env.TMPDIR, process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME, process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME];
  for (const location of locations) {
    expect(location).toBeTruthy();
    writeFileSync(join(location!, ${JSON.stringify(`exclusive-${name}`)}), "owned", { flag: "wx" });
  }
  expect(existsSync(join(process.env.TMPDIR!, ".owner"))).toBe(true);
  writeFileSync(${JSON.stringify(join(dir, "audit"))} + "/${name}-" + process.pid,
    JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR,
      wave: dirname(process.env.TMPDIR!), parentOwned: existsSync(join(process.env.TMPDIR!, "..", ".owner")) }));
  // Real overlap is the behavior being tested; fake time cannot share OS processes.
  await Bun.sleep(100);
});
`);
}

function focused(fx: FocusFixture, paths: string[], changed: string[]) {
	for (const argv of [["git", "init", "-q"], ["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
		const result = fx.invoke(argv);
		expect(result.rc, result.out).toBe(0);
	}
	const probe = join(fx.dir, "focused.sh");
	writeFileSync(probe, `set -eu
ARCHIVE_DIR=${JSON.stringify(fx.dir)}
WORK=${JSON.stringify(fx.dir)}
ROOT=${JSON.stringify(fx.dir)}
SCRIPT_DIR=${JSON.stringify(join(root, "scripts"))}
COMMIT=HEAD
CHANGED=${JSON.stringify(changed.join("\n"))}
heavy_step() { shift; "$@"; }
record_run() { :; }
${gateFunctions(readFileSync(join(root, "scripts/fresh-gate.sh"), "utf8"), ["fail", "test_workers", "run_affected_tests"])}
run_affected_tests ${paths.map(path => JSON.stringify(path)).join(" ")}
`);
	return fx.invoke(["sh", probe]);
}

test("LOADGATE1: changed hermetic file passes K isolated copies; unchanged importer runs only once", () => {
	const fx = fixture();
	try {
		control(fx.dir, "control.test.ts");
		control(fx.dir, "unchanged.test.ts");
		const result = focused(fx, ["tests/cli/control.test.ts", "tests/cli/unchanged.test.ts"], ["tests/cli/control.test.ts"]);
		expect(result.rc, result.out).toBe(0);
		expect(result.out).toContain(`LOADGATE1 GREEN file=tests/cli/control.test.ts concurrency=${width}`);
		expect(result.out).not.toContain("LOADGATE1 GREEN file=tests/cli/unchanged.test.ts");
		const audits = readdirSync(join(fx.dir, "audit"));
		expect(audits.filter(name => name.startsWith("control.test.ts-"))).toHaveLength(width + 1);
		expect(audits.filter(name => name.startsWith("unchanged.test.ts-"))).toHaveLength(1);
		const copies = audits.filter(name => name.startsWith("control.test.ts-")).map(name => JSON.parse(readFileSync(join(fx.dir, "audit", name), "utf8")));
		expect(new Set(copies.map(copy => copy.home)).size).toBe(width + 1);
		expect(new Set(copies.map(copy => copy.tmp)).size).toBe(width + 1);
		const loadCopies = copies.filter(copy => copy.home !== join(fx.dir, "home"));
		expect(loadCopies).toHaveLength(width);
		expect(loadCopies.every(copy => copy.parentOwned)).toBe(true);
		expect(loadCopies.every(copy => !existsSync(copy.tmp) && !existsSync(copy.wave))).toBe(true);
		console.log(result.out.split("\n").find(line => line.startsWith("LOADGATE1 GREEN")));
	} finally { fx.scratch.cleanup(); }
}, 30_000);

test("LOADGATE1 planted deadline holds alone but the concurrent wave refuses, naming case, concurrency and load1", () => {
	const fx = fixture();
	try {
		writeFileSync(join(fx.dir, "tests/cli/control.test.ts"), `
import { test } from "bun:test";
import { readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
test("deadline-only-alone plant", async () => {
  const active = ${JSON.stringify(join(fx.dir, "active"))};
  const mine = join(active, String(process.pid));
  writeFileSync(mine, "ready");
  // Actual Bun deadlines across independent processes cannot use fake timers.
  try { await Bun.sleep(400); await Bun.sleep(700 * readdirSync(active).length); }
  finally { unlinkSync(mine); }
}, 1500);
`);
		const result = focused(fx, ["tests/cli/control.test.ts"], ["tests/cli/control.test.ts"]);
		expect(result.rc, result.out).toBe(1);
		expect(result.out).toContain(" 1 pass\n 0 fail\nRan 1 test across 1 file.");
		expect(result.out).toContain("(fail) deadline-only-alone plant");
		expect(result.out).toContain(`LOADGATE1 file=tests/cli/control.test.ts concurrency=${width} load1=`);
		expect(result.out).toContain("affected tests did not pass");
	} finally { fx.scratch.cleanup(); }
}, 30_000);

test("LOADGATE1: no changed selected files means no copies, including deleted paths", () => {
	const fx = fixture();
	try {
		const result = fx.load(["tests/cli/unchanged.test.ts", "tests/cli/deleted.test.ts"]);
		expect(result.rc, result.out).toBe(0);
		expect(result.out).toContain("no changed focused test files; no copies run");
		expect(result.out).not.toContain("SUITE-HERMETIC");
	} finally { fx.scratch.cleanup(); }
});

function policy(dir: string, ceiling: number) {
	writeFileSync(join(dir, ".github/test-budget.json"), JSON.stringify({ version: 1,
		changed_file_budget: { cap_s: ceiling > 90 ? 90 : ceiling / 2, grandfathered: {
			"tests/cli/grandfather.test.sh": { measured_s: ceiling, evidence: "load-wave regression fixture" },
		} },
	}));
	writeFileSync(join(dir, "changed"), "tests/cli/grandfather.test.sh\n");
}

test("LOADGATE1: canonical grandfather ceiling passes above default cap and bounds a hung copy", () => {
	const fx = fixture();
	try {
		policy(fx.dir, 0.6);
		writeFileSync(join(fx.dir, "tests/cli/grandfather.test.sh"), "sleep 0.4\nprintf 'grandfather control passed\\n'\n");
		const green = fx.load(["tests/cli/grandfather.test.sh"], fx.dir, 2);
		expect(green.rc, green.out).toBe(0);
		expect(green.out).toContain("ceiling_s=0.6 contention_allowance=2");
		writeFileSync(join(fx.dir, "tests/cli/grandfather.test.sh"), "printf 'grandfather timeout plant\\n'\nsleep 5\n");
		const red = fx.load(["tests/cli/grandfather.test.sh"], fx.dir, 2);
		expect(red.rc, red.out).toBe(1);
		expect(red.out).toContain("grandfather timeout plant");
		expect(red.out).toContain("LOADGATE1 RED file=tests/cli/grandfather.test.sh concurrency=2");
	} finally { fx.scratch.cleanup(); }
}, 20_000);

test.skipIf(process.env.OMP_KIT_LITERAL_LOAD_BUDGET !== "1")("LOADGATE1 literal grandfather: 91 seconds passes above 90 under its 100-second ceiling", () => {
	const fx = fixture();
	try {
		policy(fx.dir, 100);
		writeFileSync(join(fx.dir, "tests/cli/grandfather.test.sh"), "sleep 91\nprintf 'literal 91-second grandfather control passed\\n'\n");
		const result = fx.load(["tests/cli/grandfather.test.sh"], fx.dir, 2, 120);
		expect(result.rc, result.out).toBe(0);
		expect(result.out).toContain("literal 91-second grandfather control passed");
		expect(result.out).toContain("ceiling_s=100 contention_allowance=2");
		console.log(result.out);
	} finally { fx.scratch.cleanup(); }
}, 120_000);
