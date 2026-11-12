// README currency gate (scripts/readme-check.ts). Failure mode: README.md drifts from the shipped
// CLI (a command or doctor scope missing from its reference) or pins a release version, and nothing
// goes RED -- the 87-commit staleness behind ompkit-readme-changelog-currency-vrrn.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COUNT_CLAIM, VERSION_LITERAL, checkDocCounts, checkPaths, codeSpans, globMatch, installClaims, scenarioClaims } from "../../scripts/readme-check.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

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

function check(args: string[], gate = script, env: Record<string, string | undefined> = process.env): { code: number | null; out: string } {
	const child = Bun.spawnSync(["bun", "run", "--no-env-file", "--config=/dev/null", gate, "--root", repo, "--no-readme-gate", ...args], {
		cwd: repo, stdout: "pipe", stderr: "pipe", env,
	});
	return { code: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` };
}

function plantedReadme(name: string, text: string): string {
	const path = join(workspace, name);
	writeFileSync(path, text);
	return path;
}

test("the shipped README covers every registry command and doctor scope and pins no version", () => {
	// Tags are environment, not tree: between releases (NEXTVERSION1) the line names the published release, so a
	// fixture repo carries that tag; this test then runs the same in a git-less export and in a checkout.
	const stated = /^Current release: v(\d+\.\d+\.\d+)$/m.exec(readme)?.[1];
	if (stated === undefined) throw new Error("README.md has no generated release line");
	const result = check(["--repo", taggedRepo("shipped-tags", [stated])], script, ceilingEnv);
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
	const registry = join(workspace, "planted-registry.ts");
	expect(check(["--registry", registry]).out).toContain("missing `omp-kit planted-fake`");
	expect(check(["--registry", registry], commandMutant).out).not.toContain("missing `omp-kit planted-fake`");
	// READMECAP1 (ompkit-fp72.120.16.239): plant into baseReadme(), whose release line equals package.json, so the
	// verdict needs no release tag. The live README names the published release (NEXTVERSION1), and the full suite's
	// archive (`git init`, no tags) judged that line RED as an absent tag, failing this case for a rule it never mutated.
	const planted = plantedReadme("README.mutant.md", baseReadme().replace("\n## ", "\n```sh\nKIT_VERSION=0.2.15\n```\n\n## "));
	const realRun = check(["--readme", planted]);
	expect(realRun.out).toContain("pins a release version literal `0.2.15`");
	expect(realRun.out).toContain("README-CHECK: RED (1 findings)");
	expect(realRun.code).toBe(1);
	const mutantRun = check(["--readme", planted], versionMutant);
	expect(mutantRun.out).not.toContain("pins a release version literal");
	expect(mutantRun.out).toContain("README-CHECK: GREEN");
	expect(mutantRun.code).toBe(0);
});

const pkgManifest: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
if (!pkgManifest || typeof pkgManifest !== "object" || !("version" in pkgManifest) || typeof pkgManifest.version !== "string") {
	throw new Error("package.json must carry a string version for the release-line tests");
}
const pkgVersion = pkgManifest.version;
/** Fixture README whose generated release line equals package.json however the live tree looks (NEXTVERSION1:
 *  between releases the shipped line names the published release, one patch behind package.json). */
function baseReadme(): string {
	if (readme.includes("<!-- kit-release:start -->"))
		return readme.replace(/^Current release: v\d+\.\d+\.\d+$/m, `Current release: v${pkgVersion}`);
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

// NEXTVERSION1 (ompkit-d8qic): main states the version it will ship as, so package.json may be the next patch of
// README's release line, which must still name a published (tagged) release. Repos below sit under `workspace`,
// a git ceiling, so tag discovery never climbs into the enclosing checkout.
const [major, minor, patch] = pkgVersion.split(".").map(Number);
if (patch! < 2) throw new Error("next-patch release-line tests need a package.json patch of at least 2");
const published = `${major}.${minor}.${patch! - 1}`;
const ceilingEnv = { ...process.env, GIT_CEILING_DIRECTORIES: workspace };
function taggedRepo(name: string, tags: string[]): string {
	const dir = join(workspace, name);
	mkdirSync(dir);
	const env = { ...ceilingEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
	for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "fixture"], ...tags.map(tag => ["tag", `v${tag}`])]) {
		const result = runFixture(["git", ...args], { cwd: dir, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
	}
	return dir;
}
const releaseLine = (version: string) => baseReadme().replace(`Current release: v${pkgVersion}`, `Current release: v${version}`);

test("next patch: README names a tagged release and package.json its next patch passes; untagged is RED", () => {
	const readmePath = plantedReadme("README.next-patch.md", releaseLine(published));
	const tagged = check(["--readme", readmePath, "--repo", taggedRepo("tags-published", [published])], script, ceilingEnv);
	expect(tagged.out).not.toContain("release line");
	const untagged = check(["--readme", readmePath, "--repo", taggedRepo("tags-none", [])], script, ceilingEnv);
	expect(untagged.code).toBe(1);
	expect(untagged.out).toContain(`tag v${published} does not exist; the line must state a published release`);
});

test("next patch fails closed when tags cannot be read", () => {
	const notRepo = join(workspace, "not-a-repo");
	mkdirSync(notRepo);
	const result = check(["--readme", plantedReadme("README.next-unreadable.md", releaseLine(published)), "--repo", notRepo], script, ceilingEnv);
	expect(result.code).toBe(1);
	expect(result.out).toContain(`tags cannot be read to prove v${published} is published (pass --repo DIR); failing closed`);
});

test("a two-patch gap is RED even with the older tag present; an equal line needs no tag (control)", () => {
	const twoBack = `${major}.${minor}.${patch! - 2}`;
	const repoWithTag = taggedRepo("tags-two-back", [twoBack, published]);
	const gap = check(["--readme", plantedReadme("README.gap.md", releaseLine(twoBack)), "--repo", repoWithTag], script, ceilingEnv);
	expect(gap.code).toBe(1);
	expect(gap.out).toContain(`release line says \`Current release: v${twoBack}\` but package.json is ${pkgVersion}`);
	const equal = check(["--readme", plantedReadme("README.equal.md", baseReadme()), "--repo", taggedRepo("tags-equal", [])], script, ceilingEnv);
	expect(equal.out).not.toContain("release line");
});

test("fresh-gate's readme gate checks the archive tree and resolves tags from FRESH_GATE_REPO, defaulting to ROOT", () => {
	const freshGate = readFileSync(join(repo, "scripts/fresh-gate.sh"), "utf8");
	const start = freshGate.indexOf("gate_readme() {");
	const gateReadme = freshGate.slice(start, freshGate.indexOf("\n}\n", start) + 3);
	expect(gateReadme).toContain('--repo "${FRESH_GATE_REPO:-$ROOT}"');
	// The archive is a git-less copy of the inputs readme-check reads, as fresh-gate's `git archive` export is.
	// The lint reads README.md, docs/*.md, AGENTS.md, scenarios.json and MANIFEST.tsv, so the archive carries
	// the workdir minus .git, var scratch and the two audit dumps (unreferenced by any backticked path); a partial copy would fake path-lint misses.
	const archive = join(workspace, "gate-archive");
	mkdirSync(archive, { recursive: true });
	for (const entry of readdirSync(repo)) {
		if (entry === ".git" || entry === "var" || entry === "agent_ergonomics_audit" || entry === "beads_compliance_audit") continue;
		cpSync(join(repo, entry), join(archive, entry), { recursive: true });
	}
	writeFileSync(join(archive, "README.md"), releaseLine(published));
	const gate = (root: string, body: string) => {
		const result = runFixture(["bash", "-c", `${body}\ngate_readme`], { cwd: workspace, floor_s: 60,
			env: { ...ceilingEnv, ARCHIVE_DIR: archive, ROOT: root, README_GATE: join(workspace, "no-readme-gate") } });
		return { code: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
	};
	// The tag repo is seeded from the archive, so --repo lists the same files
	// the archive lints (fresh-gate's real FRESH_GATE_REPO is that checkout).
	const taggedArchive = (name: string, tags: string[]): string => {
		const dir = join(workspace, name);
		mkdirSync(dir, { recursive: true });
		for (const entry of readdirSync(archive)) cpSync(join(archive, entry), join(dir, entry), { recursive: true });
		const env = { ...ceilingEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
		for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "fixture"], ...tags.map(tag => ["tag", `v${tag}`])]) {
			const result = runFixture(["git", ...args], { cwd: dir, env, floor_s: 30 });
			if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
		}
		return dir;
	};
	const tagged = gate(taggedArchive("root-tagged", [published]), gateReadme);
	expect(tagged.out).toContain("README-CHECK: GREEN");
	expect(tagged.code).toBe(0);
	const untagged = gate(taggedArchive("root-untagged", []), gateReadme);
	expect(untagged.code).toBe(1);
	expect(untagged.out).toContain(`tag v${published} does not exist`);
	// Planted: without --repo the check looks for tags in the git-less archive and fails closed.
	const mutant = gateReadme.replace(' --repo "${FRESH_GATE_REPO:-$ROOT}"', "");
	expect(mutant).not.toBe(gateReadme);
	const blind = gate(taggedRepo("root-blind", [published]), mutant);
	expect(blind.code).toBe(1);
	expect(blind.out).toContain("failing closed");
}, fixtureDeadlineS(120) * 1_000);

// README APPLY1 (ompkit-v66l.22.3): the staged-readme hook runs this checker in every repo with a README obligation.
// A CFS-shaped tree (README plus package.json; no src/commands.ts, rules/, skills/ or checker of its own) gets each
// undeclared rule as one NOT_APPLICABLE line; the old unconditional registry import crashed on it.
function cfsTree(name: string, readmeText: string, extra: Record<string, string> = {}): string {
	const root = join(workspace, name);
	mkdirSync(root);
	writeFileSync(join(root, "README.md"), readmeText);
	writeFileSync(join(root, "package.json"), "{\"name\":\"clutterfree-spaces-api\",\"version\":\"1.0.0\"}\n");
	for (const [path, text] of Object.entries(extra)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}
const CFS_README = "# ClutterFreeSpaces\n\nRuns 7 commands and 12 rules for the business, on Node 16.0.0.\n\n## 🛠️ **Command Reference**\n\n| `/checkin` | `./checkin.sh` |\n\n## 📜 **License**\n\nPrivate.\n";
function checkRoot(root: string, gate = script): { code: number | null; out: string } {
	const result = runFixture(["bun", "run", "--no-env-file", "--config=/dev/null", gate, "--root", root, "--repo", root, "--no-readme-gate"],
		{ cwd: root, env: ceilingEnv, floor_s: 30 });
	return { code: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
}
const UNCONDITIONAL_IMPORT = "registryDeclared ? await loadRegistry(registryPath) : null";
test("README APPLY1 planted: a CFS-shaped tree is GREEN with each undeclared rule named NOT_APPLICABLE", () => {
	const result = checkRoot(cfsTree("cfs-green", CFS_README));
	expect(result.out).toContain("README-CHECK: GREEN");
	expect(result.code).toBe(0);
	for (const rule of ["command-reference: no COMMANDS registry at src/commands.ts", "release-line:", "rules-count:", "extensions-count:", "skills-count:", "kit-sections:"])
		expect(result.out.split("\n").filter(line => line.startsWith(`NOT_APPLICABLE ${rule}`))).toHaveLength(1);
});

test("README APPLY1 negatives: rules with declared inputs still refuse in a CFS-shaped tree; the kit policy still requires its registry", () => {
	const worklog = checkRoot(cfsTree("cfs-worklog", CFS_README.replace("## 📜", "## Recent updates\n\n- [x] shipped\n\n## 📜")));
	expect(worklog.code).toBe(1);
	expect(worklog.out).toContain("worklog/changelog heading");
	expect(worklog.out).toContain("task checkbox (readme-update W7)");
	// Declaring an input turns its rule on: a registry, a rules/ directory, release markers.
	const declared = checkRoot(cfsTree("cfs-declared", `<!-- kit-release:start -->\nCurrent release: v0.9.0\n<!-- kit-release:end -->\n\n${CFS_README}`, {
		"src/commands.ts": "export const COMMANDS = [{ name: \"alpha\" }, { name: \"doctor\", flags: [{ name: \"--scope\", value: \"red\" }] }];\n",
		"rules/a.md": "# a\n",
	}));
	expect(declared.code).toBe(1);
	expect(declared.out).toContain("README.md has no `## Command reference` section");
	expect(declared.out).toContain("claims \"7 commands\" but the tree ships 2 commands");
	expect(declared.out).toContain("claims \"12 rules\" but the tree ships 1 rules");
	expect(declared.out).toContain("release line says `Current release: v0.9.0` but package.json is 1.0.0");
	expect(declared.out).toContain("pins a release version literal `16.0.0`");
	expect(declared.out).not.toContain("NOT_APPLICABLE command-reference");
	// A tree that ships its own checker declares the whole kit policy: a missing registry still fails, as before.
	const kit = checkRoot(cfsTree("cfs-kit-policy", CFS_README, { "scripts/readme-check.ts": readFileSync(script, "utf8") }));
	expect(kit.code).not.toBe(0);
	expect(kit.out).toContain("Cannot find module");
	expect(kit.out).not.toContain("README-CHECK: GREEN");
});

test("README APPLY1 mutant: restoring the unconditional registry import crashes on the CFS-shaped tree", () => {
	const source = readFileSync(script, "utf8");
	expect(source).toContain(UNCONDITIONAL_IMPORT);
	const mutantPath = join(workspace, "readme-check.unconditional-import.ts");
	writeFileSync(mutantPath, source.replace(UNCONDITIONAL_IMPORT, "await loadRegistry(registryPath)"));
	const root = cfsTree("cfs-mutant", CFS_README);
	expect(checkRoot(root).code).toBe(0);
	const mutant = checkRoot(root, mutantPath);
	expect(mutant.code).not.toBe(0);
	expect(mutant.out).toContain("Cannot find module");
	expect(mutant.out).not.toContain("README-CHECK: GREEN");
});

// DOCSHARMONY1 (ompkit-1ra0d.215): generated counts and the backticked-path lint.
test("doc counts: stale AGENTS scenario and usage install claims are RED naming both numbers", () => {
	// Export trees carry no generated MANIFEST.tsv; the CLI kit-tree tests below
	// cover the mechanism there, and CI generates the manifest before testing.
	let manifestText: string;
	try { manifestText = readFileSync(join(repo, "MANIFEST.tsv"), "utf8"); }
	catch {
		console.log("SKIP live doc-counts: no MANIFEST.tsv in this tree");
		return;
	}
	const liveAgents = readFileSync(join(repo, "AGENTS.md"), "utf8");
	const liveUsage = readFileSync(join(repo, "docs/usage.md"), "utf8");
	const scenarios: number = JSON.parse(readFileSync(join(repo, "tests/live/scenarios.json"), "utf8")).length;
	const manifestRows = manifestText.split("\n").filter(line => line.length > 0);
	const ruleRows = manifestRows.length - 1;
	expect(checkDocCounts(liveAgents, liveUsage, scenarios, ruleRows)).toEqual([]);
	const staleScenarios = checkDocCounts(liveAgents.replace(`${scenarios} scenarios`, "70 scenarios"), liveUsage, scenarios, ruleRows);
	expect(staleScenarios).toHaveLength(1);
	expect(staleScenarios[0]).toContain('"70 scenarios"');
	expect(staleScenarios[0]).toContain(`ships ${scenarios}`);
	const staleInstall = checkDocCounts(liveAgents, liveUsage.replace(`${ruleRows}-rule install`, "18-rule install"), scenarios, ruleRows);
	expect(staleInstall).toHaveLength(1);
	expect(staleInstall[0]).toContain('"18-rule install"');
	expect(staleInstall[0]).toContain(`ships ${ruleRows} rules`);
	expect(scenarioClaims("no counts here")).toEqual([]);
	expect(scenarioClaims("70 scenarios and 151 scenarios")).toEqual([70, 151]);
	expect(scenarioClaims("version v70 scenarios")).toEqual([]);
	expect(installClaims("no counts here")).toEqual([]);
	expect(installClaims("previews the 18-rule install")).toEqual([18]);
});

test("code spans never cross a newline and the glob matcher covers *, ? and classes", () => {
	expect(codeSpans("see `docs/usage.md` here")).toEqual(["docs/usage.md"]);
	expect(codeSpans("```mermaid\nflowchart TD\n```")).toEqual([]);
	expect(codeSpans("``code`` and `other`")).toEqual(["code", "other"]);
	expect(codeSpans("unbalanced ` span\nnext `ok` line")).toEqual(["ok"]);
	expect(globMatch("scripts/check-*.sh", "scripts/check-staged-imports.sh")).toBe(true);
	expect(globMatch("scripts/check-*.sh", "scripts/other.ts")).toBe(false);
	expect(globMatch("tests/cli/*.test.?s", "tests/cli/readme-check.test.ts")).toBe(true);
	expect(globMatch("rules/[a-z]*.md", "rules/a.md")).toBe(true);
	expect(globMatch("rules/[a-z]*.md", "rules/0.md")).toBe(false);
});

test("path lint: a missing backticked repo path is RED; dirs, globs, placeholders and allowlist entries pass", () => {
	const tracked = new Set(["scripts/check-staged-imports.sh", "skills/fleet-round/scripts/fleet-round.ts", "docs/usage.md", "src/commands.ts"]);
	const clean = "see `skills/fleet-round/scripts/fleet-round.ts`, `docs/` and `scripts/check-*.sh`.";
	expect(checkPaths([{ name: "README.md", text: clean }], tracked)).toEqual([]);
	const placeholder = "one paragraph at `docs/releases/v<version>.md`";
	expect(checkPaths([{ name: "docs/release-rubric.md", text: placeholder }], tracked)).toEqual([]);
	const allowed = "like upstream `scripts/release.ts`";
	expect(checkPaths([{ name: "docs/release-procedure.md", text: allowed }], tracked)).toEqual([]);
	const missing = checkPaths([{ name: "README.md", text: "run `sh scripts/old-tool.sh --json`" }], tracked);
	expect(missing).toEqual(["README.md names `scripts/old-tool.sh` but git ls-files has no such file or directory; fix the path or allowlist it in PATHLINT_ALLOW"]);
	const twoFiles = checkPaths([
		{ name: "README.md", text: clean },
		{ name: "docs/setup.md", text: "needs `src/missing-thing.ts`" },
	], tracked);
	expect(twoFiles).toEqual(["docs/setup.md names `src/missing-thing.ts` but git ls-files has no such file or directory; fix the path or allowlist it in PATHLINT_ALLOW"]);
});

// DOCSHARMONY1 CLI: a kit-policy fixture tree wires AGENTS.md, docs/usage.md,
// tests/live/scenarios.json, MANIFEST.tsv and `git ls-files` end to end.
const KIT_README = "<!-- kit-release:start -->\nCurrent release: v9.9.9\n<!-- kit-release:end -->\n\n# Fixture\n\n## Command reference\n\n`omp-kit doctor` covers `doctor --scope red`.\n\n## Limitations\n\nNone.\n\n## About Contributions\n\nNone.\n\n## License\n\nPrivate.\n";
const KIT_COMMANDS = "export const COMMANDS = [{ name: \"doctor\", flags: [{ name: \"--scope\", value: \"red\" }] }];\n";
function kitTree(name: string, agentsScenarios: number, installRules: number, extraReadme = "", checker = readFileSync(script, "utf8")): string {
	const root = join(workspace, name);
	for (const dir of ["scripts", "docs", "rules", "src", "tests/live"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "scripts/readme-check.ts"), checker);
	writeFileSync(join(root, "README.md"), KIT_README + extraReadme);
	writeFileSync(join(root, "AGENTS.md"), `# Agents\n\nlive suite (G4, ${agentsScenarios} scenarios including a planted negative).\n`);
	writeFileSync(join(root, "docs/usage.md"), `# Usage\n\npreviews the ${installRules}-rule install.\n`);
	writeFileSync(join(root, "tests/live/scenarios.json"), JSON.stringify(["s0", "s1", "s2"]));
	writeFileSync(join(root, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\na\t0\treminder\tpack\nb\t1\ttripwire\tpack\n");
	writeFileSync(join(root, "package.json"), "{\"name\":\"fixture\",\"version\":\"9.9.9\"}\n");
	writeFileSync(join(root, "src/commands.ts"), KIT_COMMANDS);
	const env = { ...ceilingEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
	for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "fixture"]]) {
		const result = runFixture(["git", ...args], { cwd: root, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
	}
	return root;
}

test("doc counts CLI: a kit tree matching its generated files is GREEN; stale counts are RED", () => {
	const green = checkRoot(kitTree("kit-green", 3, 2));
	expect(green.out).toContain("README-CHECK: GREEN");
	expect(green.code).toBe(0);
	const staleScenarios = checkRoot(kitTree("kit-stale-scenarios", 4, 2));
	expect(staleScenarios.code).toBe(1);
	expect(staleScenarios.out).toContain('AGENTS.md claims "4 scenarios" but tests/live/scenarios.json ships 3');
	const staleInstall = checkRoot(kitTree("kit-stale-install", 3, 5));
	expect(staleInstall.code).toBe(1);
	expect(staleInstall.out).toContain('docs/usage.md claims "5-rule install" but MANIFEST.tsv ships 2 rules');
});

test("path lint CLI: a backticked missing repo path is RED and names the file", () => {
	const root = kitTree("kit-stale-path", 3, 2, "\n`scripts/no-such-file-xyz.sh` does not exist.\n");
	const result = checkRoot(root);
	expect(result.code).toBe(1);
	expect(result.out).toContain("README.md names `scripts/no-such-file-xyz.sh` but git ls-files has no such file or directory");
});

test("removing the doc-count/path-lint checks makes planted negatives pass (the checks are load-bearing)", () => {
	const source = readFileSync(script, "utf8");
	const cases = [
		{ anchor: "findings.push(...checkDocCounts(docTexts[\"AGENTS.md\"]!, docTexts[\"docs/usage.md\"]!, scenarios, ruleRows, ruleSource));", scenarios: 4, install: 2, extraReadme: "" },
		{ anchor: "findings.push(...checkPaths(lintFiles, tracked, lintSource));", scenarios: 3, install: 2, extraReadme: "\n`scripts/no-such-file-xyz.sh` does not exist.\n" },
	];
	cases.forEach(({ anchor, scenarios, install, extraReadme }, index) => {
		expect(source).toContain(anchor);
		const mutant = source.replace(anchor, anchor.replace("findings.push(...", "void ").slice(0, -2) + ";");
		expect(mutant).not.toBe(source);
		const dir = kitTree(`kit-mutant-${index}`, scenarios, install, extraReadme, mutant);
		const result = checkRoot(dir, join(dir, "scripts/readme-check.ts"));
		expect(result.out).toContain("README-CHECK: GREEN");
		expect(result.code).toBe(0);
	});
});

// DOCSHARMONY1 export applicability (ompkit-1ra0d.215 rework): a git-archive
// export carries no .git and no generated MANIFEST.tsv, and both checks still
// apply there -- counts derive from rules/*.md, paths resolve via the
// filesystem. Today's code printed NOT_APPLICABLE for both.
function exportTree(name: string, agentsScenarios: number, installRules: number, extraReadme = "", checker = readFileSync(script, "utf8")): string {
	const root = join(workspace, name);
	for (const dir of ["scripts", "docs", "rules", "src", "tests/live"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "scripts/readme-check.ts"), checker);
	writeFileSync(join(root, "README.md"), KIT_README + extraReadme);
	writeFileSync(join(root, "AGENTS.md"), `# Agents\n\nlive suite (G4, ${agentsScenarios} scenarios including a planted negative).\n`);
	writeFileSync(join(root, "docs/usage.md"), `# Usage\n\npreviews the ${installRules}-rule install.\n`);
	writeFileSync(join(root, "tests/live/scenarios.json"), JSON.stringify(["s0", "s1", "s2"]));
	writeFileSync(join(root, "rules/a.md"), "# a\n");
	writeFileSync(join(root, "rules/b.md"), "# b\n");
	writeFileSync(join(root, "package.json"), "{\"name\":\"fixture\",\"version\":\"9.9.9\"}\n");
	writeFileSync(join(root, "src/commands.ts"), KIT_COMMANDS);
	return root;
}

test("export tree without .git or MANIFEST.tsv is GREEN with both checks applied", () => {
	const result = checkRoot(exportTree("export-green", 3, 2));
	expect(result.out).toContain("README-CHECK: GREEN");
	expect(result.code).toBe(0);
	expect(result.out).not.toContain("NOT_APPLICABLE doc-counts");
	expect(result.out).not.toContain("NOT_APPLICABLE path-lint");
});

test("export tree planted negatives: a stale count and a missing path are RED", () => {
	const staleScenarios = checkRoot(exportTree("export-stale-scenarios", 4, 2));
	expect(staleScenarios.code).toBe(1);
	expect(staleScenarios.out).toContain('AGENTS.md claims "4 scenarios" but tests/live/scenarios.json ships 3');
	const staleInstall = checkRoot(exportTree("export-stale-install", 3, 5));
	expect(staleInstall.code).toBe(1);
	expect(staleInstall.out).toContain('docs/usage.md claims "5-rule install" but rules/*.md ships 2 rules');
	const stalePath = checkRoot(exportTree("export-stale-path", 3, 2, "\n`scripts/no-such-file-xyz.sh` does not exist.\n"));
	expect(stalePath.code).toBe(1);
	expect(stalePath.out).toContain("README.md names `scripts/no-such-file-xyz.sh`");
});

test("export tree: a README path present only in the canonical --repo checkout is still RED for the candidate root", () => {
	// The candidate export lacks scripts/canonical-only.sh; a canonical checkout tracks it.
	const root = exportTree("export-divergent-root", 3, 2, "\n`scripts/canonical-only.sh` runs here.\n");
	const repo = join(workspace, "export-divergent-repo");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	writeFileSync(join(repo, "scripts/canonical-only.sh"), "#!/bin/sh\n");
	const git = (...args: string[]) => runFixture(["git", "-C", repo, ...args], { cwd: repo, env: ceilingEnv, floor_s: 30 });
	expect(git("init", "-q").rc).toBe(0);
	expect(git("add", "scripts/canonical-only.sh").rc).toBe(0);
	const result = runFixture(["bun", "run", "--no-env-file", "--config=/dev/null", script, "--root", root, "--repo", repo, "--no-readme-gate"],
		{ cwd: root, env: ceilingEnv, floor_s: 30 });
	const out = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
	expect(result.rc).toBe(1);
	expect(out).toContain("README.md names `scripts/canonical-only.sh`");
});
