import { afterAll, beforeAll, expect, test } from "bun:test";
import { CASE_HEADER } from "../../src/case-corpus.ts";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { nativeCacheEnv, writeBundledHarness } from "./release-manifest-fixture.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

const source = resolve(import.meta.dir, "../..");
let base = "";
let release = "";
let binary = "";
let home = "";
let project = "";
let incumbent = "";
let candidate = "";
let environment: Record<string, string>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const header = CASE_HEADER + "\n";
const fire = "transition\tfire\ttext\t-\t-\tPUBLIC DANGER\tpublic-fire-control\t\n";
const quiet = "transition\tquiet\ttext\t-\t-\t𝄞 PUBLIC SAFE\tincumbent-quiet-witness\t\n";

function snapshot(root: string): string[] {
	return readdirSync(root).sort().flatMap(name => {
		const file = join(root, name);
		const stat = lstatSync(file);
		const mode = stat.mode & 0o777;
		if (stat.isSymbolicLink()) return [file + ":link:" + readlinkSync(file)];
		if (stat.isDirectory()) return [file + ":directory:" + mode, ...snapshot(file)];
		return [file + ":file:" + mode + ":" + hash(readFileSync(file))];
	});
}

beforeAll(async () => {
	const omp = resolveOmpIdentity(process.env);
	base = realpathSync(ownedTmp("omp-kit-review-cli").path);
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "operator-home");
	project = join(base, "unrelated-project");
	incumbent = join(base, "incumbent");
	candidate = join(base, "candidate");
	for (const dir of [join(release, "bin"), join(release, "scripts"), home, project,
		join(incumbent, "rules"), join(candidate, "rules"), ...["tmp", "config", "cache", "data", "state"].map(name => join(home, name))]) {
		mkdirSync(dir, { recursive: true });
	}
	for (const dir of ["rules", "retired", "cases", "policy", "extensions"]) cpSync(join(source, dir), join(release, dir), { recursive: true });
	writeFileSync(join(release, "scripts/rule-class.ts"), readFileSync(join(source, "scripts/rule-class.ts")));
	// MANIFEST.tsv is git-ignored, so an exported tree has none: build it from the selected rules, as docs.test.ts does.
	const manifest = await run(["sh", join(source, "scripts/build-manifest.sh"), "--stdout"], { cwd: source, deadline_s: fixtureDeadlineS(30) });
	if (manifest.rc !== 0) throw new Error("review fixture manifest failed (" + manifest.rc + "): " + new TextDecoder().decode(manifest.stderr));
	writeFileSync(join(release, "MANIFEST.tsv"), manifest.stdout);
	writeBundledHarness(release);
	writeFileSync(join(home, "canary"), "operator state must not change\n");
	writeFileSync(join(project, "canary"), "project contents are data, not executable configuration\n");
	for (const [directory, pattern] of [[incumbent, "PUBLIC DANGER"], [candidate, "PUBLIC"]]) {
		writeFileSync(join(directory!, "rules", "transition.md"), "---\ncondition:\n  - '" + pattern + "'\nscope:\n  - text\ninterruptMode: never\n---\nSynthetic authored matcher fixture.\n");
	}
	writeFileSync(join(incumbent, "cases.tsv"), header + fire + quiet);
	writeFileSync(join(candidate, "cases.tsv"), header + fire + "transition\tquiet\ttext\t-\t-\tMUNDANE SAFE\tcandidate-substitute-quiet\t\n");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", join(source, "src/cli.ts"), "--outfile", binary], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(build.stdout.toString() + build.stderr.toString());
	environment = { ...nativeCacheEnv, HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		OMP_KIT_CASE_CWD: process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || source,
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin", OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source };
}, 60_000);

afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

async function invoke(candidateRoot = candidate, env = environment) {
	const child = Bun.spawn([binary, "review", "rules", "--incumbent-rules", join(incumbent, "rules"), "--incumbent-cases", join(incumbent, "cases.tsv"),
		"--candidate-rules", join(candidateRoot, "rules"), "--candidate-cases", join(candidateRoot, "cases.tsv"), "--json"], {
		cwd: project, env, stdout: "pipe", stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (!stdout.trim()) throw new Error(JSON.stringify({ code, stdout, stderr }));
	return { code, stdout, stderr, envelope: JSON.parse(stdout) };
}

test("ERASED_QUIET: relocated review retains the incumbent witness and native UTF-16 prefix", async () => {
	const before = [snapshot(release), snapshot(home), snapshot(project), snapshot(incumbent), snapshot(candidate)];
	const result = await invoke();
	expect(result.stderr).toBe("");
	expect(result.code).toBe(1);
	expect(result.envelope.meta.verification).toBe("PERFORMED");
	const review = result.envelope.data.review;
	expect(review.denominator).toEqual({ exercised: 3, total: 3 });
	const transition = review.transitions.find((entry: any) => entry.expectationProvenance.incumbent?.sourceLine === 3);
	expect(transition.expectationProvenance.incumbent.expectation).toBe("quiet");
	expect(transition.expectationProvenance.incumbent.sourceSha256).toBe(hash(readFileSync(join(incumbent, "cases.tsv"))));
	expect(transition.incumbent.rule).toBe("transition");
	expect(transition.incumbent.whole).toBe("quiet");
	expect(transition.candidate.rule).toBe("transition");
	expect(transition.candidate.whole).toBe("fire");
	expect(transition.candidate.prefix).toEqual({ phase: "stream", position: 9, wire_length: 14 });
	expect(transition.incumbent.bindings.cases_sha256).toBe(transition.candidate.bindings.cases_sha256);
	expect(transition.incumbent.bindings.rule_sha256).not.toBe(transition.candidate.bindings.rule_sha256);
	expect([snapshot(release), snapshot(home), snapshot(project), snapshot(incumbent), snapshot(candidate)]).toEqual(before);
}, 60_000);

test("identical selected inputs report only no delta in the two exercised witnesses", async () => {
	const result = await invoke(incumbent);
	expect(result.code).toBe(0);
	expect(result.envelope.data.review.status).toBe("NO_DELTA_IN_EXERCISED_WITNESSES");
	expect(result.envelope.data.review.denominator).toEqual({ exercised: 2, total: 2 });
	expect(result.envelope.data.scope).toBe("MATCHER_PREFIX_ONLY");
}, 60_000);

test("missing native OMP cannot become a quiet no-delta comparison", async () => {
	const result = await invoke(candidate, { ...environment, PATH: "/usr/bin:/bin", OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" });
	expect(result.code).toBe(3);
	expect(result.envelope.ok).toBe(false);
	expect(result.envelope.meta.verification).toBe("UNVERIFIED");
	expect(result.envelope.data.status).toBe("UNAVAILABLE");
}, 60_000);

// TTSRFRICTION1 (ompkit-fp72.120.16.169): the labeled October sample in omp-kit
// docs/evidence/mine-october-2026-11-04/ttsr-friction.json rated all 10 kit-no-force-push fires false.
// The review replays that sample through the native matcher. A rule whose fires on the labeled sample
// are mostly labeled-false refusals is flagged for narrowing. Planted: the pre-narrowing rule text
// (sha256 103d683e…, the fixture). Control: the tree's rules-fleet/kit-no-force-push.md.
const forcePushSample: ["fire" | "quiet", string, string][] = [
	["quiet", `br close cfs-kqcfq --actor GradeI --force --reason "node --test scripts/twenty-a"`, "labeled false oct1"],
	["quiet", "br comment ompkit-6nv6 --actor GradeGrowth --body 'GROWTH1 claims no deletion. Needs director ruling: --force close or re-parent .7-.11.'", "labeled false oct2"],
	["quiet", "br --db /x/probe/.beads/beads.db update br-ugc --status closed --actor ProbeTest --force 2>&1 | head -n 5", "labeled false oct3"],
	["quiet", "am mail send --to RusticPine --subject 'QUESTION 6nv6: force-close or re-parent .7-.11' --body 'Options: (a) --force close 6nv6, children live on; (b) re-parent'", "labeled false oct4"],
	["quiet", "am mail send --to RainyTurtle --subject 'j2wma.9 is in_review; close with --force (j2wma.6 is follow-up)'", "labeled false oct5"],
	["quiet", "br update cfs-j2wma.4 --claim --force --actor Wave6Port 2>&1 | cat", "labeled false oct6"],
	["quiet", `br close ompkit-fp72.19.1.29 --force --actor Close29 --reason "NON-AUTHOR c"`, "labeled false oct7"],
	["quiet", `br close ompkit-fp72.19.1.26 --force --actor Close26 --reason "nice -n 10 p"`, "labeled false oct8"],
	["quiet", `br update cfs-gbp-tracking-number-j6c4t --claim --force --actor CollectiveViper; echo "exit=$?"`, "labeled false oct9"],
	["quiet", `set -o pipefail; br comments add --actor Nordark ompkit-fp72.12 --message "1/1 open children. No --force without director ruling."`, "labeled false oct10"],
	["fire", "git push --force origin main", "true control: bare force push"],
	["fire", "git -C repo push origin HEAD:main --force", "true control: global option before push"],
	["fire", String.raw`pwd\\n\\tgit push --force origin main`, "true control: escaped newline+tab before git (RX2 red 7521fdc723)"],
	["fire", String.raw`pwd\\n\\tgit push -f origin main`, "true control: escaped boundary, short flag"],
];

type ReviewSide = "incumbent" | "candidate";
interface ReviewedWitness {
	expectationProvenance: Partial<Record<ReviewSide, { expectation: "fire" | "quiet" }>>;
	incumbent: { status: string; whole?: string };
	candidate: { status: string; whole?: string };
}

function flaggedForNarrowing(transitions: ReviewedWitness[], side: ReviewSide): { fires: number; falseFires: number; flagged: boolean } {
	const fired = transitions.filter(entry => entry[side].status === "OK" && entry[side].whole === "fire");
	const falseFires = fired.filter(entry => entry.expectationProvenance[side]?.expectation === "quiet").length;
	return { fires: fired.length, falseFires, flagged: falseFires * 2 > fired.length };
}

async function reviewPacks(incumbentRoot: string, candidateRoot: string) {
	const result = await run([binary, "review", "rules", "--incumbent-rules", join(incumbentRoot, "rules"), "--incumbent-cases", join(incumbentRoot, "cases.tsv"),
		"--candidate-rules", join(candidateRoot, "rules"), "--candidate-cases", join(candidateRoot, "cases.tsv"), "--json"], { cwd: project, env: environment, deadline_s: fixtureDeadlineS(150) });
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	if (!stdout.trim()) throw new Error(JSON.stringify({ rc: result.rc, timed_out: result.timed_out, stdout, stderr }));
	return { stderr, envelope: JSON.parse(stdout) };
}

test("TTSRFRICTION1: a rule whose labeled-sample fires are mostly false refusals is flagged for narrowing; the narrowed rule is not", async () => {
	const planted = join(source, "tests/cli/fixtures/ttsrfriction1-kit-no-force-push.incumbent.md");
	expect(hash(readFileSync(planted))).toBe("103d683ec251f0493e0e0bd90258729eb5b4b161137ba39d1e4f1540c0adf102");
	const root = join(base, "ttsrfriction1");
	const cases = header + forcePushSample.map(([want, snippet, note]) => ["kit-no-force-push", want, "tool", "bash", "-", snippet, note, ""].join("\t")).join("\n") + "\n";
	for (const [side, rule] of [["incumbent", planted], ["candidate", join(source, "rules-fleet/kit-no-force-push.md")]] as const) {
		mkdirSync(join(root, side, "rules"), { recursive: true });
		writeFileSync(join(root, side, "rules", "kit-no-force-push.md"), readFileSync(rule));
		writeFileSync(join(root, side, "cases.tsv"), cases);
	}
	const result = await reviewPacks(join(root, "incumbent"), join(root, "candidate"));
	expect(result.stderr).toBe("");
	const review = result.envelope.data.review as { status: string; conflicts: unknown[]; denominator: unknown; rules: { changed: string[] }; transitions: ReviewedWitness[] };
	expect(review.conflicts).toEqual([]);
	expect(review.denominator).toEqual({ exercised: forcePushSample.length, total: forcePushSample.length });
	expect(review.status).toBe("DELTA");
	expect(review.rules.changed).toEqual(["kit-no-force-push"]);
	const plantedReview = flaggedForNarrowing(review.transitions, "incumbent");
	expect(plantedReview.falseFires).toBe(10);
	expect(plantedReview.flagged).toBe(true);
	const control = flaggedForNarrowing(review.transitions, "candidate");
	expect(control).toEqual({ fires: 4, falseFires: 0, flagged: false });
	for (const entry of review.transitions) expect(entry.candidate.whole).toBe(entry.expectationProvenance.candidate?.expectation);
}, fixtureDeadlineS(180) * 1000);
