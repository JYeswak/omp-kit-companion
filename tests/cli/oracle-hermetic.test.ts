import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// fp72.58 ORACLEHERM1: the oracle must not depend on the checkout's location.
// Rules and cases resolve against a synthetic root unless OMP_KIT_CASE_CWD
// overrides it, so a git-archive extract under var/agent-tmp produces
// byte-identical oracle JSON to any other extract, with no absolute paths.

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");

function scratchDir(label: string): string {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, label + "."));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=${label}\nrepo=${root}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return dir;
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "OMP_KIT_CASE_CWD") env[key] = value;
	}
	return env;
}
function gitAvailable(): boolean {
	// fresh-gate archives get a fresh `git init` with no commits so
	// contributor paths work; extract tests need a real source tree.
	const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	if (top.exitCode !== 0 || top.stdout.toString().trim() !== root) return false;
	const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	return head.exitCode === 0;
}


function extractRef(dir: string): void {
	// HERMETIC_REF overrides the extracted tree (default HEAD): point it at a
	// candidate tree sha to validate unpushed bytes with this same test.
	const ref = process.env.HERMETIC_REF ?? "HEAD";
	const archive = Bun.spawnSync(["git", "archive", ref], { cwd: root, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	expect(archive.exitCode).toBe(0);
	mkdirSync(dir, { recursive: true });
	const untar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	expect(untar.exitCode).toBe(0);
}

function extractHead(dir: string): void {
	extractRef(dir);
}

function runOracle(cwd: string): { rc: number; out: string } {
	const proc = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", "scripts/differential-oracle.ts"], { cwd, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	return { rc: proc.exitCode ?? 1, out: proc.stdout.toString() };
}
test("oracle JSON identical across extract cwds with no absolute paths", () => {
	if (!gitAvailable()) {
		console.log("skip: no git source for extracts");
		return;
	}
	const parent = scratchDir("oracle-hermetic");
	const dirA = join(parent, "a");
	const dirB = join(parent, "b");
	try {
		extractHead(dirA);
		extractHead(dirB);
		const ra = runOracle(dirA);
		const rb = runOracle(dirB);
		expect(ra.rc).toBe(0);
		expect(ra.out).toBe(rb.out);
		expect(ra.out).not.toContain(dirA);
		expect(ra.out).not.toContain(dirB);
		expect(JSON.parse(ra.out).status).toBe("PASS");
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}, 300000);

test("a corpus row really under var/agent-tmp still fires", () => {
	const dir = scratchDir("oracle-hermetic-mini");
	try {
		const cases = [
			"rule\texpected\tsource\ttool\tpath\tsnippet",
			"scratch-is-not-a-home\tfire\ttool\twrite\tvar/agent-tmp/oracle-hermetic-mini/probe.sh\t#!/usr/bin/env bash",
			"scratch-is-not-a-home\tquiet\ttool\twrite\tscripts/ok.sh\techo hi",
		].join("\n") + "\n";
		const casesFile = join(dir, "mini.tsv");
		writeFileSync(casesFile, cases);
		const proc = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", "scripts/ttsr-harness.ts", "--gate-json", "--rules", join(root, "rules"), "--cases", casesFile], { cwd: root, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
		// Coverage fails on a 2-row file by design; the per-row verdicts below are the assertion.
		const report = JSON.parse(proc.stdout.toString()) as { cases?: Array<{ rule: string; line: number; expect: string; g2: string }> };
		const rows = report.cases ?? [];
		expect(rows.find(row => row.line === 2)?.g2).toBe("fire");
		expect(rows.find(row => row.line === 3)?.g2).toBe("quiet");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120000);

test("G2 harness from an extract stays green", () => {
	if (!gitAvailable()) {
		console.log("skip: no git source for extracts");
		return;
	}
	const parent = scratchDir("oracle-hermetic-gate");
	const dir = join(parent, "tree");
	try {
		extractHead(dir);
		const proc = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", "scripts/ttsr-harness.ts", "--gate"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
		expect(proc.exitCode).toBe(0);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}, 300000);
