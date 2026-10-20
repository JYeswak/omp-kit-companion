// README currency gate (scripts/readme-check.ts). Failure mode: README.md drifts from the shipped
// CLI (a command or doctor scope missing from its reference) or pins a release version, and nothing
// goes RED -- the 87-commit staleness behind ompkit-readme-changelog-currency-vrrn.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COUNT_CLAIM, VERSION_LITERAL } from "../../scripts/readme-check.ts";

const repo = resolve(import.meta.dir, "../..");
const script = join(repo, "scripts/readme-check.ts");
const workspace = join(repo, "var", "agent-tmp", `readme-check.${process.pid}`);
const readme = readFileSync(join(repo, "README.md"), "utf8");

beforeAll(() => {
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, ".owner"), `pid=${process.pid}\nlabel=readme-check\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	// A registry copy with one planted command and one planted doctor scope; it re-exports the real
	// registry so the planted copy can never fall behind src/commands.ts.
	writeFileSync(join(workspace, "planted-registry.ts"), `import { COMMANDS as REAL } from ${JSON.stringify(join(repo, "src/commands.ts"))};
export const COMMANDS = [
	...REAL.map(command => command.name !== "doctor" ? command : { ...command, flags: command.flags.map(flag => flag.name !== "--scope" ? flag : { ...flag, value: flag.value + "|planted-scope" }) }),
	{ name: "planted-fake", description: "planted", usage: "planted-fake", flags: [] },
];
`);
});

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function check(args: string[], gate = script): { code: number | null; out: string } {
	const child = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", gate, "--root", repo, "--no-readme-gate", ...args], {
		cwd: repo, stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

function plantedReadme(name: string, text: string): string {
	const path = join(workspace, name);
	writeFileSync(path, text);
	return path;
}

test("the shipped README covers every registry command and doctor scope and pins no version", () => {
	const result = check([]);
	expect(result.out).toContain("README-CHECK: GREEN");
	expect(result.code).toBe(0);
});

test("a command added to the registry without README coverage is RED and named", () => {
	const result = check(["--registry", join(workspace, "planted-registry.ts")]);
	expect(result.code).toBe(1);
	expect(result.out).toContain("missing `omp-kit planted-fake`");
	expect(result.out).toContain("missing `doctor --scope planted-scope`");
	expect(result.out).not.toContain("missing `omp-kit doctor`");
});

test("a pinned KIT_VERSION in the README is RED with its line", () => {
	const planted = readme.replace("\n## ", "\n```sh\nKIT_VERSION=0.2.15\n```\n\n## ");
	const line = planted.split("\n").indexOf("KIT_VERSION=0.2.15") + 1;
	const result = check(["--readme", plantedReadme("README.version.md", planted)]);
	expect(result.code).toBe(1);
	expect(result.out).toContain(`README.md:${line} pins a release version literal \`0.2.15\``);
});

test("a README without the command reference or with a changelog heading is RED", () => {
	const noReference = readme.replace("\n## Command reference\n", "\n## Commands\n");
	expect(check(["--readme", plantedReadme("README.noref.md", noReference)]).out).toContain("no `## Command reference` section");
	const worklog = readme.replace("\n## Limitations\n", "\n## What's new\n\n- Added things.\n\n## Limitations\n");
	expect(check(["--readme", plantedReadme("README.worklog.md", worklog)]).out).toContain("worklog/changelog heading");
});

test("a stale inventory count (the old \"18 stream-triggered rules\") is RED with the real count", () => {
	const planted = readme.replace("\n## TL;DR\n", "\nShips 18 stream-triggered rules and nine skills.\n\n## TL;DR\n");
	const result = check(["--readme", plantedReadme("README.counts.md", planted)]);
	expect(result.code).toBe(1);
	expect(result.out).toMatch(/claims "18 stream-triggered rules" but the tree ships \d+ rules/);
	expect(result.out).toMatch(/claims "nine skills" but the tree ships \d+ skills/);
	const claims = (text: string) => [...text.matchAll(COUNT_CLAIM)].map(match => match[0]);
	expect(claims("has 30 rules, five guard extensions and 30 diagnostic scopes")).toEqual(["30 rules", "five guard extensions", "30 diagnostic scopes"]);
	expect(claims("rule 30 v1.30 rules-engine someone skills 3.5 rules")).toEqual([]);
	const nearMiss = `1 ${"a-".repeat(50_000)}x`;
	const started = performance.now();
	expect(claims(nearMiss)).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});

test("version-literal regex: positives, negatives and a bounded long near-miss", () => {
	const hits = (text: string) => [...text.matchAll(VERSION_LITERAL)].map(match => match[0]);
	expect(hits("KIT_VERSION=0.2.15")).toEqual(["0.2.15"]);
	expect(hits("github:o/r#v0.2.20 and v10.0.1.")).toEqual(["v0.2.20", "v10.0.1"]);
	expect(hits("/download/v1.2.3/release-index.json")).toEqual(["v1.2.3"]);
	expect(hits("127.0.0.1 X.Y.Z 2026-10-11 v0.2 1.2.3.4 ver1.2.3 01.2.3")).toEqual([]);
	const nearMiss = "1.".repeat(50_000);
	const started = performance.now();
	expect(hits(nearMiss)).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});

test("removing either check makes its planted negative pass (the checks are load-bearing)", () => {
	const source = readFileSync(script, "utf8");
	const noCommands = source.replace("findings.push(`README.md command reference is missing \\`omp-kit ${name}\\`", "void (`");
	const noVersions = source.replace("findings.push(`README.md:${index + 1} pins a release version literal", "void (`");
	expect(noCommands).not.toBe(source);
	expect(noVersions).not.toBe(source);
	const commandMutant = join(workspace, "readme-check.no-commands.ts");
	const versionMutant = join(workspace, "readme-check.no-versions.ts");
	writeFileSync(commandMutant, noCommands);
	writeFileSync(versionMutant, noVersions);
	expect(check(["--registry", join(workspace, "planted-registry.ts")], commandMutant).out).not.toContain("missing `omp-kit planted-fake`");
	const planted = plantedReadme("README.mutant.md", readme.replace("\n## ", "\n```sh\nKIT_VERSION=0.2.15\n```\n\n## "));
	const mutantRun = check(["--readme", planted], versionMutant);
	expect(mutantRun.out).not.toContain("pins a release version literal");
	expect(mutantRun.code).toBe(0);
});

const pkgManifest: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
if (!pkgManifest || typeof pkgManifest !== "object" || !("version" in pkgManifest) || typeof pkgManifest.version !== "string") {
	throw new Error("package.json must carry a string version for the release-line tests");
}
const pkgVersion = pkgManifest.version;
/** Fixture README with a correct generated release line however the live tree looks. */
function baseReadme(): string {
	if (readme.includes("<!-- kit-release:start -->")) return readme;
	return readme.replace("</div>\n", `</div>\n\n<!-- kit-release:start -->\nCurrent release: v${pkgVersion}\n<!-- kit-release:end -->\n`);
}
test("a stale generated release line is RED naming both versions, without a literal finding", () => {
	const base = baseReadme();
	expect(base).toContain(`Current release: v${pkgVersion}`);
	const planted = base.replace(`Current release: v${pkgVersion}`, "Current release: v0.0.0");
	expect(planted).not.toBe(base);
	const result = check(["--readme", plantedReadme("README.stale-release.md", planted)]);
	expect(result.code).toBe(1);
	expect(result.out).toContain("release line says `Current release: v0.0.0`");
	expect(result.out).toContain(`package.json is ${pkgVersion}`);
	expect(result.out).not.toContain("pins a release version literal");
});

test("a release line equal to package.json draws no release-line finding (control)", () => {
	const base = plantedReadme("README.release-control.md", baseReadme());
	const result = check(["--readme", base]);
	expect(result.out).not.toContain("release line");
	expect(result.out).not.toContain("generated release line");
});

test("a README without the generated release line is RED", () => {
	const base = baseReadme();
	const start = base.indexOf("<!-- kit-release:start -->");
	const end = base.indexOf("<!-- kit-release:end -->");
	expect(start).toBeGreaterThan(-1);
	const stripped = base.slice(0, start) + base.slice(end + "<!-- kit-release:end -->".length);
	const result = check(["--readme", plantedReadme("README.no-release.md", stripped)]);
	expect(result.code).toBe(1);
	expect(result.out).toContain("has no generated release line");
});

test("removing the release-line check makes a stale line pass (the check is load-bearing)", () => {
	const source = readFileSync(script, "utf8");
	const mutant = source.replace("findings.push(`README.md release line says", "void (`");
	expect(mutant).not.toBe(source);
	const mutantPath = join(workspace, "readme-check.no-release-line.ts");
	writeFileSync(mutantPath, mutant);
	const planted = plantedReadme("README.mutant-release.md", baseReadme().replace(`Current release: v${pkgVersion}`, "Current release: v0.0.0"));
	// Contrast on the same planted input: the real gate names the stale line, the mutant is
	// silent about it. (Exit codes stay RED here from unrelated in-flight tree drift.)
	expect(check(["--readme", planted]).out).toContain("release line says `Current release: v0.0.0`");
	expect(check(["--readme", planted], mutantPath).out).not.toContain("release line says");
});

test("stamp-release-line.sh restamps a stale block and fails closed without markers", () => {
	const stamp = join(repo, "scripts/stamp-release-line.sh");
	const stale = plantedReadme("README.stamp.md", baseReadme().replace(`Current release: v${pkgVersion}`, "Current release: v0.0.0"));
	const run = (args: string[]) => {
		const child = Bun.spawnSync(["sh", stamp, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
	};
	const first = run(["--version", pkgVersion, "--readme", stale]);
	expect(first.code).toBe(0);
	expect(first.out).toContain(`stamped Current release: v${pkgVersion}`);
	expect(readFileSync(stale, "utf8")).toContain(`Current release: v${pkgVersion}`);
	const second = run(["--version", pkgVersion, "--readme", stale]);
	expect(second.code).toBe(0);
	expect(second.out).toContain("already");
	const noMarkers = plantedReadme("README.nomarkers.md", "# Fixture\n");
	const missing = run(["--version", pkgVersion, "--readme", noMarkers]);
	expect(missing.code).toBe(1);
	expect(missing.out).toContain("marker missing");
	expect(run(["--version", "not-a-version", "--readme", stale]).code).toBe(2);
});
