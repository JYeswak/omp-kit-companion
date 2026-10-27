/**
 * `omp-kit slice-verify --overlay PATH... [--test FILE...] [--changed-file F...] [--base SHA] [--project PATH] [--json]`
 * (SLICEVERIFY1 ompkit-t7cn7.7).
 *
 * Tests a proposed change against a clean export of HEAD (or --base), so other
 * agents' uncommitted files in the shared checkout cannot blur the verdict. It
 * builds an exact `git archive` export in owned scratch, links node_modules,
 * overlays only the named worktree paths, and runs the named test files twice:
 * on the export alone (base) and on the export with the overlay. Per file it
 * reports pass/fail counts for base and overlay and classifies each failure as
 * pre-existing (fails in both) or introduced (fails only with the overlay).
 *
 * Exit 0 (CLEAN): nothing introduced. Exit 1 (INTRODUCED): the overlay breaks
 * a passing test, breaks shellcheck on an overlaid .sh, or newly times out.
 * Exit 2 (ERROR): the setup, selection or judgment itself failed -- the export,
 * the bookkeeping commit, the test selection, or a missing runner -- and no
 * test verdict was reached. A dirty foreign file that is not named in the
 * overlay never reaches either run: both trees are built from `git archive`
 * alone, never from the shared worktree.
 *
 * Lead method defects this verb must not repeat (PeachLeopard, 2026-10-27):
 * the export's bookkeeping commit uses a message the installed hooks accept
 * and runs hookless (`-c core.hooksPath=/dev/null`), a failed export setup is
 * an ERROR on which no test runs, and the deadline comes from measured
 * per-file wall time on this host: on timeout the verb reports
 * `TIMEOUT after Ns`, never `hang`. Test selection is the push gate's own
 * selector (scripts/affected-tests.ts, same flags) plus every test that reads
 * a changed file's test titles (docs/flywheel-invariants.tsv, cases/*.tsv),
 * the escaped-defect class that cost one 29-minute push attempt.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run, type RunResult } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Static wall budget for one base file run; the overlay deadline is measured from it. */
export const BASE_BUDGET_S = 900;
/** Floor for one overlay file run; the measured multiple usually exceeds it. */
export const OVERLAY_MIN_S = 120;
/**
 * Overlay deadline multiple of the same file's measured base wall time. Factor 8
 * covers the measured 6.3x legitimate slowdown (kit-update N+2 journey: 48.5 s
 * failing fast on base vs 307 s passing on overlay, 2026-10-27) with margin; a
 * hang still burns at most OVERLAY_MAX_S.
 */
export const OVERLAY_FACTOR = 8;
/** Absolute ceiling for one overlay file run: a hang is bounded, never endless. */
export const OVERLAY_MAX_S = 1800;
/** Per-test timeout passed to bun; run()'s deadline_s is the wall bound. */
const BUN_TEST_TIMEOUT_MS = 120000;

export interface SliceCounts { pass: number | null; fail: number | null; found: boolean }
export interface SliceRun {
	file: string;
	rc: number | null;
	timedOut: boolean;
	elapsedS: number;
	counts: SliceCounts;
	failures: string[];
	truncated: boolean;
}
export interface SliceFileResult {
	file: string;
	base: SliceRun;
	overlay: SliceRun;
	preexisting: string[];
	introduced: string[];
}
export interface SliceSelection {
	seeds: string[];
	linked: { registry: string; forChanged: string }[];
	tests: string[];
}
export interface SliceVerifyResult {
	ok: boolean;
	code: "CLEAN" | "INTRODUCED" | "ERROR";
	error?: string;
	base: string;
	selection: SliceSelection;
	files: SliceFileResult[];
	shellcheck: { file: string; clean: boolean; detail: string }[];
	log: string[];
	exitCode: 0 | 1 | 2;
}

export interface SliceVerifyInput {
	repo: string;
	base?: string;
	overlay: string[];
	tests?: string[];
	changedFiles?: string[];
	env?: Record<string, string>;
}

/** ` N pass` / ` N fail` from bun's summary; found=false when the shape is absent. */
export function parseBunSummary(out: string): SliceCounts {
	const p = /^ *(\d+) pass *$/m.exec(out);
	const f = /^ *(\d+) fail *$/m.exec(out);
	if (!p || !f) return { pass: null, fail: null, found: false };
	return { pass: Number(p[1]), fail: Number(f[1]), found: true };
}

/** Failing test names from bun's `(fail) name [12.34ms]` lines, in first-seen order. */
export function parseBunFailures(out: string): string[] {
	const seen = new Set<string>();
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("(fail)")) continue;
		const name = t.slice("(fail)".length).trim().replace(/\s+\[[0-9.]+m?s\]$/, "");
		if (name) seen.add(name);
	}
	return [...seen];
}

export function classifyFailures(base: readonly string[], overlay: readonly string[]): { preexisting: string[]; introduced: string[] } {
	const before = new Set(base);
	const preexisting = overlay.filter(n => before.has(n));
	const introduced = overlay.filter(n => !before.has(n));
	return { preexisting, introduced };
}

/** Overlay wall bound from the same file's measured base run. */
export function overlayDeadline(baseSecs: number): number {
	return Math.min(OVERLAY_MAX_S, Math.max(OVERLAY_MIN_S, Math.ceil(OVERLAY_FACTOR * Math.max(0, baseSecs))));
}

/** A repo-relative path that stays inside the repo: no absolute, no `..`. */
export function cleanRel(path: string): string | null {
	if (!path || path.startsWith("/") || path === "." ) return null;
	const parts = path.split("/");
	if (parts.some(p => p === "" || p === "." || p === "..")) return null;
	return parts.join("/");
}

const INVARIANTS_TSV = "docs/flywheel-invariants.tsv";

/** Registries that map changed files to test titles: the invariants TSV plus every cases TSV. */
export function registryPaths(root: string): string[] {
	const out = [INVARIANTS_TSV];
	let entries: string[] = [];
	try { entries = readdirSync(join(root, "cases")); } catch { return out; }
	for (const e of entries) if (e.endsWith(".tsv")) out.push(`cases/${e}`);
	return out;
}

/**
 * Registries that name a changed file: a `path::title` cell (invariants) or an
 * exact path cell (cases). Readers of a linked registry are title-linked tests.
 */
export function linkedRegistries(root: string, changed: readonly string[]): { registry: string; forChanged: string }[] {
	const out: { registry: string; forChanged: string }[] = [];
	for (const registry of registryPaths(root)) {
		let body: string;
		try { body = readFileSync(join(root, registry), "utf8"); } catch { continue; }
		for (const line of body.split("\n")) {
			if (!line.trim() || line.startsWith("#")) continue;
			for (const cell of line.split("\t")) {
				const c = cell.trim();
				if (!c) continue;
				for (const f of changed) {
					if (c === f || c.startsWith(`${f}::`)) {
						if (!out.some(r => r.registry === registry && r.forChanged === f)) out.push({ registry, forChanged: f });
					}
				}
			}
		}
	}
	return out;
}

/** The push gate's own selector script, located from this module: same script, same flags. */
export function selectorScript(): string {
	return join(import.meta.dir, "..", "scripts", "affected-tests.ts");
}

/** The push gate's own selector on the judged tree: same script, same flags. */
export async function selectOnTree(root: string, seeds: readonly string[], env: Record<string, string>): Promise<string[]> {
	const r = await run(["bun", "run", "--no-env-file", "--config=/dev/null",
		selectorScript(), "--root", root,
		...seeds.flatMap(s => ["--changed-file", s])], { deadline_s: 300, env, max_output_bytes: 1024 * 1024 });
	if (r.rc !== 0) throw new Error(`SELECTION_FAILED: affected-tests.ts exited ${r.rc}: ${text(r.stderr).slice(0, 300)}`);
	return text(r.stdout).split("\n").map(l => l.trim()).filter(Boolean);
}

async function runFile(exportDir: string, file: string, deadlineS: number, env: Record<string, string>, scratchPath: string): Promise<SliceRun> {
	// No --config flag: bun loads ./bunfig.toml from the cwd on its own, while an
	// absolute --config path silently runs zero tests (measured 2026-10-27).
	const argv = ["bun", "test", `--timeout=${BUN_TEST_TIMEOUT_MS}`, "--path-ignore-patterns", "var/agent-tmp/**", file];
	const r = await run(argv, { cwd: exportDir, deadline_s: deadlineS, env: { ...env, TMPDIR: scratchPath }, max_output_bytes: 8 * 1024 * 1024 });
	const out = text(r.stdout) + text(r.stderr);
	return {
		file, rc: r.rc, timedOut: r.timed_out, elapsedS: r.elapsed_s,
		counts: parseBunSummary(out), failures: r.timed_out ? [] : parseBunFailures(out),
		truncated: r.truncated || r.total_truncated,
	};
}

async function setupExport(repo: string, baseSha: string, dir: string, tarPath: string, env: Record<string, string>, log: string[]): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const archive = await run(["git", "-C", repo, "archive", "--output", tarPath, baseSha], { deadline_s: 300, env });
	if (archive.rc !== 0) throw new Error(`EXPORT_FAILED: git archive exited ${archive.rc}: ${text(archive.stderr).slice(0, 300)}`);
	const extract = await run(["tar", "-x", "-f", tarPath, "-C", dir], { deadline_s: 300, env });
	if (extract.rc !== 0) throw new Error(`EXPORT_FAILED: tar exited ${extract.rc}: ${text(extract.stderr).slice(0, 300)}`);
	const nodeModules = join(repo, "node_modules");
	if (!existsSync(nodeModules)) throw new Error("EXPORT_FAILED: repo node_modules is absent; install before verifying");
	try { symlinkSync(nodeModules, join(dir, "node_modules")); } catch (e) {
		throw new Error(`EXPORT_FAILED: cannot link node_modules: ${(e as Error).message.slice(0, 200)}`);
	}
	const setupSteps: [string, string[]][] = [["init", ["git", "init", "-q", "-b", "main"]], ["add", ["git", "add", "-A"]]];
	for (const [step, argv] of setupSteps) {
		const r = await run([...argv], { cwd: dir, deadline_s: 120, env });
		if (r.rc !== 0) throw new Error(`EXPORT_SETUP_FAILED: git ${step} exited ${r.rc}: ${text(r.stderr).slice(0, 200)}`);
	}
	const commit = await run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=slice-verify", "-c", "user.email=slice-verify@invalid",
		"commit", "-qm", `[test] slice-verify export of ${baseSha}`], { cwd: dir, deadline_s: 120, env });
	if (commit.rc !== 0) throw new Error(`EXPORT_SETUP_FAILED: bookkeeping commit exited ${commit.rc}: ${text(commit.stderr).slice(0, 200)}`);
	log.push(`exported ${baseSha} with a hookless [test] bookkeeping commit`);
}

async function runShellcheck(exportDir: string, files: readonly string[], env: Record<string, string>): Promise<{ file: string; clean: boolean; detail: string }[]> {
	const out: { file: string; clean: boolean; detail: string }[] = [];
	const dockerBin = env.DOCKER_BIN ?? "docker";
	for (const f of files) {
		if (!f.endsWith(".sh")) continue;
	let result: RunResult;
	try {
		result = await run([dockerBin, "run", "--rm", "-v", `${exportDir}:/archive:ro`,
			"koalaman/shellcheck:v0.9.0", "-x", "-P", "/archive", `/archive/${f}`], { deadline_s: 300, env, max_output_bytes: 1024 * 1024 });
	} catch (e) {
		throw new Error(`SHELLCHECK_UNAVAILABLE: cannot run ${dockerBin}: ${(e as Error).message.slice(0, 200)}`);
	}
	const detail = (text(result.stdout) + text(result.stderr)).trim().slice(0, 1000);
	out.push({ file: f, clean: result.rc === 0, detail: result.rc === 0 ? "shellcheck clean" : detail || `shellcheck exited ${result.rc}` });
	}
	return out;
}

export async function sliceVerify(input: SliceVerifyInput): Promise<SliceVerifyResult> {
	const repo = resolve(input.repo);
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const log: string[] = [`slice-verify overlay=${input.overlay.join(",")} base=${input.base ?? "HEAD"} ${new Date().toISOString()}`];
	const fail = (error: string): SliceVerifyResult => ({
		ok: false, code: "ERROR", error, base: input.base ?? "HEAD",
		selection: { seeds: [], linked: [], tests: [] }, files: [], shellcheck: [], log, exitCode: 2,
	});
	const overlay: string[] = [];
	for (const p of input.overlay) {
		const rel = cleanRel(p);
		if (!rel) return fail(`INVALID_OVERLAY: ${JSON.stringify(p)} is not a repo-relative path`);
		if (!existsSync(join(repo, rel))) return fail(`OVERLAY_MISSING: ${rel} is not in the worktree`);
		overlay.push(rel);
	}
	if (overlay.length === 0) return fail("INVALID_OVERLAY: name at least one --overlay path");
	let baseSha = "";
	try {
		const r = await run(["git", "-C", repo, "rev-parse", "--verify", `${input.base ?? "HEAD"}^{commit}`], { deadline_s: 60, env });
		if (r.rc !== 0) return fail(`INVALID_BASE: cannot resolve ${input.base ?? "HEAD"}: ${text(r.stderr).slice(0, 200)}`);
		baseSha = text(r.stdout).trim();
	} catch (e) { return fail(`INVALID_BASE: ${(e as Error).message.slice(0, 200)}`); }
	const scratch = ownedTmp("slice-verify");
	try {
		const baseDir = join(scratch.path, "base");
		const overDir = join(scratch.path, "over");
	try {
		await setupExport(repo, baseSha, baseDir, join(scratch.path, "base.tar"), env, log);
		await setupExport(repo, baseSha, overDir, join(scratch.path, "over.tar"), env, log);
	} catch (e) { return { ...fail((e as Error).message), base: baseSha }; }
		for (const rel of overlay) {
			const src = join(repo, rel);
			const dst = join(overDir, rel);
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(src, dst);
		}
		log.push(`overlaid ${overlay.length} worktree path(s); foreign dirt never copied`);
		let overSC: { file: string; clean: boolean; detail: string }[] = [];
		let baseSC: { file: string; clean: boolean; detail: string }[] = [];
		try {
			overSC = await runShellcheck(overDir, overlay, env);
			baseSC = await runShellcheck(baseDir, overlay.filter(f => existsSync(join(baseDir, f))), env);
		} catch (e) { return { ...fail((e as Error).message), base: baseSha }; }
		const baseClean = new Map(baseSC.map(s => [s.file, s.clean]));
		const shellcheck = overSC;
		for (const s of overSC) {
			if (!s.clean && baseClean.get(s.file) === false) log.push(`[shellcheck] ${s.file} pre-existing: ${s.detail.slice(0, 200)}`);
		}
		const seeds = (input.changedFiles?.length ? input.changedFiles : overlay).map(s => cleanRel(s)).filter((s): s is string => s !== null);
		const linked = linkedRegistries(overDir, seeds);
		if (linked.length) log.push(`title-linked registries: ${linked.map(l => `${l.registry} via ${l.forChanged}`).join("; ")}`);
		const allSeeds = [...new Set([...seeds, ...linked.map(l => l.registry)])];
	 let tests = (input.tests ?? []).map(t => cleanRel(t)).filter((t): t is string => t !== null);
		let selection: SliceSelection = { seeds: allSeeds, linked, tests };
		if (tests.length === 0) {
			try {
				tests = await selectOnTree(overDir, allSeeds, env);
			} catch (e) { return { ...fail((e as Error).message), base: baseSha }; }
			selection = { seeds: allSeeds, linked, tests };
			log.push(`selected ${tests.length} test file(s) with the push-gate selector`);
		}
		if (tests.length === 0) return { ...fail("NO_TESTS_SELECTED: the selector named no test file"), base: baseSha, selection };
		const files: SliceFileResult[] = [];
		for (const file of tests) {
			const base = await runFile(baseDir, file, BASE_BUDGET_S, env, scratch.path);
			const baseLine = base.timedOut ? `TIMEOUT after ${BASE_BUDGET_S}s` :
				`rc ${base.rc} ${base.counts.found ? `${base.counts.pass} pass ${base.counts.fail} fail` : "counts unparsed"}`;
			log.push(`[base] ${file} -> ${baseLine} (${base.elapsedS.toFixed(1)}s)`);
		if (!base.timedOut && base.failures.length === 0 && !base.counts.found)
			return { ...fail(`BASE_NO_VERDICT: ${file} produced no parseable summary (rc ${base.rc}); a run that proves nothing is an error, never clean`), base: baseSha, selection };
		const deadline = base.timedOut ? BASE_BUDGET_S : overlayDeadline(base.elapsedS);
		const over = await runFile(overDir, file, deadline, env, scratch.path);
		const overLine = over.timedOut ? `TIMEOUT after ${deadline}s` :
			`rc ${over.rc} ${over.counts.found ? `${over.counts.pass} pass ${over.counts.fail} fail` : "counts unparsed"}`;
		if (!over.timedOut && over.rc === 0 && over.failures.length === 0 && !over.counts.found)
			return { ...fail(`OVERLAY_NO_VERDICT: ${file} produced no parseable summary (rc ${over.rc}); a run that proves nothing is an error, never clean`), base: baseSha, selection };
		log.push(`[over] ${file} -> ${overLine} (${over.elapsedS.toFixed(1)}s, deadline ${deadline}s)`);
		const { preexisting, introduced } = classifyFailures(base.failures, over.failures);
		const extra: string[] = [];
		if (over.timedOut && !base.timedOut) extra.push(`TIMEOUT after ${deadline}s`);
		if (!over.timedOut && over.rc !== 0 && over.failures.length === 0 && !over.counts.found) extra.push("UNPARSEABLE failing output");
		files.push({ file, base, overlay: over, preexisting, introduced: [...introduced, ...extra] });
	}
	const scHits = shellcheck.filter(s => !s.clean && baseClean.get(s.file) !== false);
		for (const h of scHits) log.push(`[shellcheck] ${h.file} INTRODUCED: ${h.detail.slice(0, 200)}`);
		const introducedFiles = files.filter(f => f.introduced.length > 0);
		if (introducedFiles.length === 0 && scHits.length === 0) {
			const pre = files.flatMap(f => f.preexisting);
			log.push(pre.length ? `CLEAN with ${pre.length} pre-existing failure(s): ${pre.join("; ")}` : "CLEAN: no failures in either run");
			return { ok: true, code: "CLEAN", base: baseSha, selection, files, shellcheck, log, exitCode: 0 };
		}
		for (const f of introducedFiles) log.push(`INTRODUCED ${f.file}: ${f.introduced.join("; ")}`);
		return { ok: false, code: "INTRODUCED", base: baseSha, selection, files, shellcheck, log, exitCode: 1 };
	} finally { /* ownedTmp autoCleanup removes the tree at process exit; failures keep it for forensics until then */ }
}
