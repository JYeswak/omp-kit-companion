import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkShippedInstallerReferences, closeOverInstallerReferences, installerReferences, packageInstaller, RELOCATED_SOURCES } from "../../scripts/package-release.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// ompkit-fp72.120.16.151: 0.2.86/0.2.87 shipped an installer whose manifest named
// scripts/check-deploy-step.sh, which the hand-kept package list omitted.
const repo = resolve(import.meta.dir, "../..");
const caseCwd = realpathSync(process.env.OMP_KIT_CASE_CWD || repo);
const scratchRoot = join(caseCwd, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
const scratch = ownedTmp("installer-closure", { root: scratchRoot });
afterAll(() => scratch.cleanup());
const manifest = (rows: string) => `#!/bin/sh\ninstallation_manifest() {\n\tcat <<'INSTALLATION_MANIFEST'\n${rows}\nINSTALLATION_MANIFEST\n}\n`;
function stage(name: string, files: Record<string, string>): string {
	const root = join(scratch.path, name);
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), body);
	}
	return root;
}

test("installer references cover manifest sources and kit-root paths, never comments", () => {
	const text = `${manifest("deploy_step commit-msg 48-omp-kit-deploy-step scripts/check-deploy-step.sh +x")}`
		+ `# "$KITROOT/scripts/comment-only.sh"\nsh "$KITROOT/scripts/run-me.sh"\ncp -R "$ROOT/rules/" x\n`;
	expect(installerReferences(text)).toEqual(["rules", "scripts/check-deploy-step.sh", "scripts/run-me.sh"]);
	expect(() => installerReferences(manifest("too few fields"))).toThrow("INSTALLER_MANIFEST_ROW_MALFORMED");
	expect(() => installerReferences("cat <<'INSTALLATION_MANIFEST'\na b c d e")).toThrow("INSTALLER_MANIFEST_UNTERMINATED");
	const nearMiss = `sh "$KITROOT/${"a".repeat(200_000)}!`;
	const started = performance.now();
	expect(installerReferences(nearMiss)).toHaveLength(1);
	// wallclock: p99=0.66ms headroom=750 (100 runs, 200k-char near-miss, M-series 2026-11-04); bound catches backtracking, not speed.
	expect(performance.now() - started).toBeLessThan(500);
});

test("pack check refuses an installer reference to an unshipped file (planted) and passes the shipped control", () => {
	const installer = manifest("deploy_step commit-msg 48-omp-kit-deploy-step scripts/check-deploy-step.sh +x");
	const planted = stage("planted", { "scripts/install-x.sh": installer });
	expect(checkShippedInstallerReferences(planted, ["scripts/install-x.sh"]))
		.toEqual([{ file: "scripts/install-x.sh", error: "INSTALLER_REFERENCE_UNSHIPPED scripts/check-deploy-step.sh" }]);
	const control = stage("control", { "scripts/install-x.sh": installer, "scripts/check-deploy-step.sh": "#!/bin/sh\n" });
	expect(checkShippedInstallerReferences(control, ["scripts/install-x.sh"])).toEqual([]);
});

test("packaged installer rows point at relocated data and refuse any other src/ source", () => {
	const [from, to] = Object.entries(RELOCATED_SOURCES)[0]!;
	const packaged = packageInstaller("scripts/install-x.sh", Buffer.from(manifest(`gate_event commit-msg data.json ${from} -x`))).toString();
	expect(installerReferences(packaged)).toEqual([to]);
	expect(() => packageInstaller("scripts/install-x.sh", Buffer.from(manifest("g commit-msg d.json src/unshipped.json -x"))))
		.toThrow("INSTALLER_REFERENCE_UNSHIPPED: scripts/install-x.sh -> src/unshipped.json");
});

test("the package list is derived from the real installers' references", () => {
	const names = ["scripts/install-commit-msg-bead.sh", "scripts/install-pre-push-gate.sh"];
	closeOverInstallerReferences(names, name => readFileSync(join(repo, name), "utf8"));
	for (const expected of ["scripts/check-deploy-step.sh", "scripts/check-red-main.py", "scripts/check-staged-wallclock.sh",
		"scripts/install-pre-commit-storage-root-gate.sh", "scripts/pre-commit-storage-root-gate.sh", ...Object.values(RELOCATED_SOURCES)])
		expect(names).toContain(expected);
	expect(names.some(name => name.startsWith("src/"))).toBe(false);
});

// Fixture install control: the PACKED installer installs every member it advertises.
const gitEnv: Record<string, string> = Object.fromEntries(Object.entries(process.env)
	.filter((entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined));
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: scratch.path, TMPDIR: scratch.path });
let extracted = "";
beforeAll(async () => {
	const out = join(scratch.path, "pack");
	mkdirSync(out);
	// As in package-release-fixture.ts, bind the kitlib marker to the caller workspace.
	writeFileSync(join(scratch.path, ".owner"),
		`pid=${process.pid}\nlabel=installer-closure\nrepo=${caseCwd}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const packed = await run(["sh", join(repo, "scripts", "package-release.sh"), "--version", "9.9.9", "--platform", "native", "--out", out],
		{ cwd: repo, env: { ...process.env, TMPDIR: out, OMP_KIT_TEST_WORK_ROOT: scratch.path, OMP_KIT_CASE_CWD: caseCwd }, deadline_s: fixtureDeadlineS(240) });
	const decoder = new TextDecoder();
	expect(packed.rc, decoder.decode(packed.stdout) + decoder.decode(packed.stderr)).toBe(0);
	const archive = readdirSync(out).find(name => name.endsWith(".tar.gz"))!;
	extracted = join(scratch.path, "release");
	mkdirSync(extracted);
	expect(runSync(["tar", "-xf", join(out, archive), "-C", extracted], { cwd: scratch.path, deadline_s: fixtureDeadlineS(60) }).rc).toBe(0);
}, fixtureDeadlineS(300) * 1000);

test("the packed installer installs every advertised member into a fixture repo", async () => {
	const target = join(scratch.path, "fixture-repo");
	mkdirSync(target);
	for (const args of [["init", "-q"], ["config", "user.email", "t@invalid.example"], ["config", "user.name", "T"],
		["-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "root"]])
		expect(runSync(["git", "-C", target, ...args], { cwd: target, env: gitEnv, deadline_s: fixtureDeadlineS(30) }).rc).toBe(0);
	const installer = join(extracted, "scripts", "install-commit-msg-bead.sh");
	const installed = await run(["sh", installer, target], { cwd: target, env: gitEnv, deadline_s: fixtureDeadlineS(240) });
	const decoder = new TextDecoder();
	expect(installed.rc, decoder.decode(installed.stdout) + decoder.decode(installed.stderr)).toBe(0);
	const text = readFileSync(installer, "utf8");
	const body = text.slice(text.indexOf("<<'INSTALLATION_MANIFEST'\n") + 26, text.indexOf("\nINSTALLATION_MANIFEST\n"));
	const rows = body.split("\n").map(row => row.split(" ")).filter(row => row[0] !== "native_preservation");
	expect(rows.length).toBeGreaterThan(40);
	const missing = rows.filter(([, chain, dest]) => !existsSync(join(target, ".git", "hooks", "hooks.d", chain!, dest!)));
	expect(missing).toEqual([]);
	for (const [chain, dest] of [["commit-msg", "48-omp-kit-deploy-step"], ["pre-commit", "55-omp-kit-staged-wallclock"]])
		expect(existsSync(join(target, ".git", "hooks", "hooks.d", chain!, dest!))).toBe(true);
}, fixtureDeadlineS(300) * 1000);
