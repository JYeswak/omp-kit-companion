import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

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
const header = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n";
const fire = "transition\tfire\ttext\t-\t-\tPUBLIC DANGER\tpublic-fire-control\n";
const quiet = "transition\tquiet\ttext\t-\t-\t𝄞 PUBLIC SAFE\tincumbent-quiet-witness\n";

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

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-review-cli-")));
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
	for (const file of ["MANIFEST.tsv", "scripts/ttsr-harness.ts", "scripts/rule-class.ts"]) writeFileSync(join(release, file), readFileSync(join(source, file)));
	writeFileSync(join(home, "canary"), "operator state must not change\n");
	writeFileSync(join(project, "canary"), "project contents are data, not executable configuration\n");
	for (const [directory, pattern] of [[incumbent, "PUBLIC DANGER"], [candidate, "PUBLIC"]]) {
		writeFileSync(join(directory!, "rules", "transition.md"), "---\ncondition:\n  - '" + pattern + "'\nscope:\n  - text\ninterruptMode: never\n---\nSynthetic authored matcher fixture.\n");
	}
	writeFileSync(join(incumbent, "cases.tsv"), header + fire + quiet);
	writeFileSync(join(candidate, "cases.tsv"), header + fire + "transition\tquiet\ttext\t-\t-\tMUNDANE SAFE\tcandidate-substitute-quiet\n");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", join(source, "src/cli.ts"), "--outfile", binary], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(build.stdout.toString() + build.stderr.toString());
	environment = { HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
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
