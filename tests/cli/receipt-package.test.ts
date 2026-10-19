import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const scratch = join(repo, "var/agent-tmp");
mkdirSync(scratch, { recursive: true });
const output = mkdtempSync(join(scratch, `receipt-package.${process.pid}.`));
writeFileSync(join(output, ".owner"), `pid=${process.pid}\nlabel=receipt-package\nrepo=omp-kit-companion\ncreated=${new Date().toISOString()}\n`);
const archiveRoot = join(output, "extracted");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(() => {
	const built = Bun.spawnSync(["sh", join(repo, "scripts/package-release.sh"), "--version", "0.0.0", "--platform", "native", "--out", output], {
		cwd: repo, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
	const asset = JSON.parse(built.stdout.toString()) as { filename: string; sha256: string };
	const archive = readFileSync(join(output, asset.filename));
	expect(hash(archive)).toBe(asset.sha256);
	mkdirSync(archiveRoot);
	const extracted = Bun.spawnSync(["tar", "-xf", join(output, asset.filename), "-C", archiveRoot], {
		cwd: output, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(extracted.exitCode, extracted.stdout.toString() + extracted.stderr.toString()).toBe(0);
}, 900_000);


test("receipt CLI is integrity-covered, executable, and usable from the extracted release archive", () => {
	const shipped = join(archiveRoot, "scripts/receipt.py");
	expect(existsSync(shipped)).toBe(true);
	const canonicalSource = readFileSync(join(repo, "scripts/receipt.py"));
	const archivedSource = readFileSync(shipped);
	expect(hash(archivedSource)).toBe(hash(canonicalSource));
	expect(statSync(shipped).mode & 0o111).toBeGreaterThan(0);

	const selftest = Bun.spawnSync([shipped, "selftest"], { cwd: archiveRoot, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe" });
	expect(selftest.exitCode, selftest.stderr.toString()).toBe(0);

	const receipt = join(output, "valid.receipt.json");
	const signed = Bun.spawnSync([shipped, "sign", "--producer", "archive-test", "--operation", "receipt.verify",
		"--result-sha256", hash(Buffer.from("receipt payload")), "--result-bytes", "15", "--authority", "test", "--out", receipt], {
		cwd: archiveRoot, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe",
	});
	expect(signed.exitCode, signed.stderr.toString()).toBe(0);
	const verified = Bun.spawnSync([shipped, "verify", receipt], { cwd: archiveRoot, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe" });
	expect(verified.exitCode, verified.stdout.toString() + verified.stderr.toString()).toBe(0);
	expect(verified.stdout.toString()).toContain("verify OK ev_");

	const tampered = JSON.parse(readFileSync(receipt, "utf8"));
	tampered.evidence_id = "ev_" + "0".repeat(64);
	const tamperedPath = join(output, "tampered.receipt.json");
	writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 1)}\n`);
	const rejected = Bun.spawnSync([shipped, "verify", tamperedPath], { cwd: archiveRoot, env: { ...process.env, TMPDIR: output }, stdout: "pipe", stderr: "pipe" });
	expect(rejected.exitCode).toBe(1);
	expect(rejected.stderr.toString()).toContain("$.evidence_id");
});

test("pysafe runner, checker and pre-commit member ship byte-identical and run from the extracted release archive", () => {
	for (const name of ["scripts/pysafe.py", "scripts/pysafe_check.py", "scripts/check-staged-pysafe.sh"]) {
		const shipped = join(archiveRoot, name);
		expect(existsSync(shipped), name).toBe(true);
		expect(hash(readFileSync(shipped)), name).toBe(hash(readFileSync(join(repo, name))));
	}
	expect(statSync(join(archiveRoot, "scripts/check-staged-pysafe.sh")).mode & 0o111).toBeGreaterThan(0);
	// Consumers outside the companion import the released module (scripts/pysafe.py docstring).
	const imported = Bun.spawnSync(["python3", "-B", "-c",
		"import sys; sys.path.insert(0, sys.argv[1]); import pysafe; r = pysafe.run_bounded(['sh', '-c', 'echo ok'], 10); print(r.outcome, r.stdout.decode().strip())",
		join(archiveRoot, "scripts")], { cwd: output, env: { ...process.env, TMPDIR: output }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	expect(imported.exitCode, imported.stderr.toString()).toBe(0);
	expect(imported.stdout.toString().trim()).toBe("OK ok");
	const planted = join(output, "planted.py");
	writeFileSync(planted, "import subprocess\nsubprocess.run(['x'], stdin=subprocess.DEVNULL)\n");
	const judged = Bun.spawnSync(["python3", "-B", join(archiveRoot, "scripts/pysafe_check.py"), planted], {
		cwd: output, env: { ...process.env, TMPDIR: output }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000,
	});
	expect(judged.exitCode, judged.stderr.toString()).toBe(1);
	expect(judged.stdout.toString()).toContain("planted.py:2:1: subprocess-no-timeout");
});
