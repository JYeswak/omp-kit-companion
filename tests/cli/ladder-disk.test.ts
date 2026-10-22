import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizedEnv } from "../../src/runtime.ts";

// SAVEFIRST1 (ompkit-774u.16), ReadmeGate instance: a heavy call nested inside the save
// path (gate -> test --full -> ladder -> heavy, where ladder cannot take a per-call flag
// from the gate) must admit on physical bytes, not wait on the host sbh policy floor.
// Chain: fresh-gate exports OMP_KIT_DISK_OBSERVER=statfs, heavy honors it as the ambient
// form of --disk-observer (flag wins, then env, then load.json), and sanitizedEnv carries
// it into the isolated fixture. Standalone runs leave it unset: admission unchanged.
const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/ladder-disk.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const gate = join(root, "scripts/fresh-gate.sh");
const NEED_BYTES = 10 * 1024 ** 3;
const AMPLE = Number(statfsSync(root).bavail) * Number(statfsSync(root).bsize) >= NEED_BYTES;

const identity = { launcher: "/bin/omp", packageRoot: "/pkg", source: "/src", nativeRoot: "/native" };

test("SAVEFIRST1: sanitizedEnv carries only valid disk observers into the isolated run", () => {
	expect(sanitizedEnv(identity, { OMP_KIT_DISK_OBSERVER: "statfs" }, "/private").OMP_KIT_DISK_OBSERVER).toBe("statfs");
	expect(sanitizedEnv(identity, { OMP_KIT_DISK_OBSERVER: "sbh" }, "/private").OMP_KIT_DISK_OBSERVER).toBe("sbh");
	expect(sanitizedEnv(identity, { OMP_KIT_DISK_OBSERVER: "auto" }, "/private").OMP_KIT_DISK_OBSERVER).toBe("auto");
	expect("OMP_KIT_DISK_OBSERVER" in sanitizedEnv(identity, {}, "/private")).toBe(false);
	expect("OMP_KIT_DISK_OBSERVER" in sanitizedEnv(identity, { OMP_KIT_DISK_OBSERVER: "bogus" }, "/private")).toBe(false);
	expect("OMP_KIT_DISK_OBSERVER" in sanitizedEnv(identity, { OMP_KIT_DISK_OBSERVER: "" }, "/private")).toBe(false);
});

test("SAVEFIRST1: the gate exports the statfs observer for everything under it", () => {
	const source = readFileSync(gate, "utf8");
	expect(source).toContain("export OMP_KIT_DISK_OBSERVER=statfs");
	const mutant = source.replace("export OMP_KIT_DISK_OBSERVER=statfs", "");
	expect(mutant).not.toBe(source);
	expect(mutant).not.toContain("OMP_KIT_DISK_OBSERVER");
});

type DiskFixture = { dir: string; env: Record<string, string> };
function diskFixture(sbhCode: number): DiskFixture {
	const dir = mkdtempSync(join(scratchRoot, "ladder-disk-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=ladder-disk-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nif [ "$1 $2 $3" = "check --need 10G" ]; then printf '{"command":"check","exit_code":${sbhCode},"free_pct":11.694169037987928}\\n'; exit ${sbhCode}; fi\nexit 0\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	mkdirSync(join(dir, "config", "omp-kit"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "config", "omp-kit", "load.json"), JSON.stringify({ slots: 8, max_wait_s: 1 }), { mode: 0o600 });
	const env = {
		PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"),
		TMUX_PANE: "", AGENT_NAME: "ladder-disk-test", OMP_KIT_HEAVY_FAKE_LOAD1: "0.5",
	};
	return { dir, env };
}

function heavy(fx: DiskFixture, extraEnv: Record<string, string>, args: string[]) {
	const preload = join(root, "tests/cli/fixtures/forge-healthy-statfs.ts");
	return Bun.spawnSync([process.execPath, "--preload", preload, "--no-env-file", "--config=/dev/null",
		resolve(root, "src/cli.ts"), "heavy", ...args, "--", "true"], {
		cwd: root, env: { ...process.env, ...fx.env, ...extraEnv }, stdout: "pipe", stderr: "pipe",
	});
}

test.skipIf(!AMPLE)("SAVEFIRST1 planted: the gate's ambient observer defeats an sbh veto with ample bytes (needs >= 10 GiB free)", () => {
	const fx = diskFixture(1);
	try {
		const veto = heavy(fx, {}, ["--no-wait"]);
		expect(veto.exitCode).toBe(75);
		expect(veto.stderr.toString()).toContain("disk low: sbh check --need 10G reports pressure");
		const saved = heavy(fx, { OMP_KIT_DISK_OBSERVER: "statfs" }, ["--no-wait"]);
		expect(saved.exitCode).toBe(0);
		const empty = heavy(fx, { OMP_KIT_DISK_OBSERVER: "" }, ["--no-wait"]);
		expect(empty.exitCode).toBe(75);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

test.skipIf(!AMPLE)("SAVEFIRST1 planted: the explicit flag wins over the ambient observer (needs >= 10 GiB free)", () => {
	const fx = diskFixture(1);
	try {
		const flagWins = heavy(fx, { OMP_KIT_DISK_OBSERVER: "sbh" }, ["--no-wait", "--disk-observer", "statfs"]);
		expect(flagWins.exitCode).toBe(0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

test("SAVEFIRST1 planted: an invalid ambient observer refuses loudly, never silently", () => {
	const fx = diskFixture(0);
	try {
		const refused = heavy(fx, { OMP_KIT_DISK_OBSERVER: "bogus" }, ["--no-wait"]);
		expect(refused.exitCode).toBe(2);
		expect(refused.stderr.toString()).toContain('OMP_KIT_DISK_OBSERVER must be "statfs", "sbh" or "auto", got "bogus"');
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

function gateFunction(source: string, name: string): string {
	const start = source.indexOf(`\n${name}() {`);
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n}\n", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start + 1, end + 3);
}

test("SAVEFIRST1 planted: the pressure flag names the largest scratch owners, biggest first", () => {
	const source = readFileSync(gate, "utf8");
	const fx = diskFixture(1);
	const fakeRoot = join(fx.dir, "root");
	try {
		mkdirSync(join(fakeRoot, "var", "agent-tmp", "big-probe.1"), { recursive: true });
		mkdirSync(join(fakeRoot, "var", "agent-tmp", "tiny-probe.2"), { recursive: true });
		writeFileSync(join(fakeRoot, "var", "agent-tmp", "big-probe.1", ".owner"), `pid=${process.pid}\nlabel=big-probe\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
		writeFileSync(join(fakeRoot, "var", "agent-tmp", "big-probe.1", "blob"), Buffer.alloc(2 * 1024 * 1024));
		writeFileSync(join(fakeRoot, "var", "agent-tmp", "tiny-probe.2", "note"), "hi\n");
		const probe = join(fx.dir, "owners-probe.sh");
		writeFileSync(probe, `set -eu\n${gateFunction(source, "disk_pressure_flag")}\nROOT='${fakeRoot}'\ndisk_pressure_flag\n`);
		const result = Bun.spawnSync(["sh", probe], { env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
		const out = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).toBe(0);
		expect(out).toContain("WARN disk-pressure: sbh reports 11.7% free (below its floor); saving continues on the 10 GiB physical floor;");
		expect(out).toMatch(/top_scratch=big-probe:[0-9.]+(KiB|MiB|GiB),tiny-probe\.2:[0-9.]+(KiB|MiB|GiB)/);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

test("SAVEFIRST1: without a repo root the flag prints with no owners suffix", () => {
	const source = readFileSync(gate, "utf8");
	const fx = diskFixture(1);
	try {
		const probe = join(fx.dir, "no-root-probe.sh");
		writeFileSync(probe, `set -eu\n${gateFunction(source, "disk_pressure_flag")}\ndisk_pressure_flag\n`);
		const result = Bun.spawnSync(["sh", probe], { env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe(
			"WARN disk-pressure: sbh reports 11.7% free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15)",
		);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
