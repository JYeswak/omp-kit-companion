import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CASE_HEADER, parseCaseCorpus } from "../../src/case-corpus.ts";
import { referenceAdmission } from "../../scripts/admission-reference.ts";
import { check as productionAdmission } from "../../src/fleet-guard/durability.ts";
import { fleetPolicyState } from "../../extensions/fleet-policy.ts";

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

function runOracle(cwd: string, cases?: string): { rc: number; out: string } {
	const args = ["bun", "run", "--no-env-file", "--config=/dev/null", "scripts/differential-oracle.ts"];
	if (cases !== undefined) args.push(cases);
	const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
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
			CASE_HEADER,
			"scratch-is-not-a-home\tfire\ttool\twrite\tvar/agent-tmp/oracle-hermetic-mini/probe.sh\t#!/usr/bin/env bash\t\t",
			"scratch-is-not-a-home\tquiet\ttool\twrite\tscripts/ok.sh\techo hi\t\t",
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

test("admission reference derives source identity from inputs, not an expected verdict", () => {
	const input = { source: "tool", tool: "write", path: "var/agent-tmp/reference.1/renamed.ts", snippet: "export const value = 42;" };
	expect(referenceAdmission(input)).toBe(false);
	const indexed = { ...input, reference: { tracked: { "src/value.ts": input.snippet } } };
	expect(referenceAdmission(indexed)).toBe(true);
	expect(referenceAdmission({ ...indexed, snippet: "export const synthetic = 7;" })).toBe(false);
	expect(referenceAdmission({ ...indexed, path: "var/agent-tmp/reference.1/src/value.ts", snippet: "modified source" })).toBe(true);
	expect(referenceAdmission({ ...input, path: "var/agent-tmp/reference.1/packet.md", snippet: "Instructions" })).toBe(true);
	expect(referenceAdmission({ ...input, path: "var/agent-tmp/reference.1/report.md", snippet: "packet: dispatch.md" })).toBe(false);
	expect(referenceAdmission({ ...input, path: "var/agent-tmp/reference.1/run.sh", snippet: "#!/bin/sh" })).toBe(true);
	expect(referenceAdmission({ ...input, path: "scripts/run.sh", snippet: "#!/bin/sh" })).toBe(false);
	expect(() => referenceAdmission({ ...input, path: "local://unexamined/target" })).toThrow("ADMISSION_REFERENCE_UNSUPPORTED_PATH");
});

test("independent admission grammar preserves fixed directory and basename outcomes", async () => {
	const base = scratchDir("oracle-reference-grammar");
	const repo = join(base, "repo");
	const session = `prompts.${process.pid}`;
	const owned = join(repo, "var", "agent-tmp", session);
	try {
		mkdirSync(owned, { recursive: true, mode: 0o700 });
		const env = cleanEnv();
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_CONFIG_GLOBAL = "/dev/null";
		const initialized = Bun.spawnSync(["git", "-C", repo, "init", "--quiet"], { env, stdout: "pipe", stderr: "pipe" });
		if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
		writeFileSync(join(owned, ".owner"), `pid=${process.pid}\nlabel=reference-grammar\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
		mkdirSync(join(repo, ".omp"));
		writeFileSync(join(repo, ".omp/fleet.json"), '{"enabled":true}\n');
		expect((await fleetPolicyState(repo)).kind).toBe("on");
		const specimens: Array<{ path: string; fire: boolean; reason?: string }> = [
			{ path: "packet/job.json", fire: true, reason: "instruction or packet" },
			{ path: "prompts/job.md", fire: true, reason: "instruction or packet" },
			{ path: "rules/input.json", fire: false },
			{ path: "rules/input.md", fire: true, reason: "instruction or packet" },
			{ path: "rules/input.MD", fire: false },
			{ path: "rules/nested/input.md", fire: false },
			{ path: "data/job-prompted.json", fire: true, reason: "instruction or packet" },
			{ path: "Packet-log/job.json", fire: true, reason: "instruction or packet" },
			{ path: "skills/input.json", fire: true, reason: "instruction or packet" },
			{ path: "data/job.bash", fire: false },
			{ path: "data/job.SH", fire: true, reason: "rerunnable script" },
			{ path: "data/input.json", fire: false },
		];
		for (const specimen of specimens) {
			const target = join(owned, specimen.path);
			mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
			const input = { source: "tool", tool: "write", path: `var/agent-tmp/${session}/${specimen.path}`, snippet: "{}" };
			const actual = await productionAdmission({ toolName: "write", input: { path: target, content: input.snippet } }, { cwd: repo });
			if (specimen.fire) {
				expect(actual?.block).toBe(true);
				expect(actual?.reason).toContain(specimen.reason!);
			} else {
				expect(actual).toBeUndefined();
			}
			expect(referenceAdmission(input)).toBe(specimen.fire);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("full differential oracle rejects falsified native-admission truth without dropping its rows", () => {
	const dir = scratchDir("oracle-admission-negative");
	try {
		const original = readFileSync(join(root, "cases/cases.tsv"), "utf8");
		const parsed = parseCaseCorpus(original);
		expect(parsed.errors).toEqual([]);
		const target = parsed.cases.find(row => row.rule === "scratch-is-not-a-home" && row.expect === "quiet");
		if (!target) throw new Error("missing native quiet control");
		const lines = original.split("\n");
		const fields = lines[target.line - 1].split("\t");
		fields[1] = "fire";
		lines[target.line - 1] = fields.join("\t");
		const cases = join(dir, "wrong-truth.tsv");
		writeFileSync(cases, lines.join("\n"));
		const result = runOracle(root, cases);
		expect(result.rc).toBe(1);
		const report = JSON.parse(result.out);
		expect(report.status).toBe("FAIL");
		expect(report.rows).toBe(parsed.cases.length);
		expect(report.checked).toBe(parsed.cases.length);
		expect(report.native_checked + report.admission_reference_checked).toBe(parsed.cases.length);
		// Both tool admissions (scratch-is-not-a-home; fleet-guard-bypass-env, BYPASSENV1) take the independent reference lane.
		expect(report.admission_reference_checked).toBe(parsed.cases.filter(row => row.rule === "scratch-is-not-a-home" || row.rule === "fleet-guard-bypass-env").length);
		expect(report.worker_errors).toBe(0);
		expect(report.reference_errors).toBe(0);
		expect(report.unexpected_mismatches).toContainEqual(expect.objectContaining({
			line: target.line, oracle: "ADMISSION_CONTRACT", expected: "fire", reference: "quiet", kit: "quiet",
		}));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120000);

test("differential oracle refuses shifted and malformed reference fields before evaluation", () => {
	const dir = scratchDir("oracle-schema-negative");
	try {
		const cases = join(dir, "invalid.tsv");
		for (const [row, diagnostic] of [
			["scratch-is-not-a-home\tquiet\ttool\twrite\tvar/agent-tmp/data.json\t{}\tnote\t\textra", "9 columns, need exactly 8"],
			["scratch-is-not-a-home\tquiet\ttool\twrite\tvar/agent-tmp/data.json\t{}\tnote\t{\"tracked\":[]}", "invalid reference facts"],
		]) {
			writeFileSync(cases, `${CASE_HEADER}\n${row}\n`);
			const result = runOracle(root, cases);
			expect(result.rc).toBe(1);
			const report = JSON.parse(result.out);
			expect(report.status).toBe("FAIL");
			expect(report.case_errors.join("\n")).toContain(diagnostic);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
