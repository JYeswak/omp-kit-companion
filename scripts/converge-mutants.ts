import { plugin } from "bun";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// .138 qualification: variants exist only in Bun's loader, never in a source copy.
// BUN_OPTIONS --require propagates the loader into isolated race subprocesses.
const root = resolve(import.meta.dir, "..");
const sourcePath = realpathSync(join(root, "src", "converge.ts"));
const self = realpathSync(import.meta.path);
const marker = "CONVERGE_MUTANT_LOADED ";
type Edit = readonly [before: string, after: string];
type Mutation = { id: string; selector: string; edits: readonly Edit[] };
type RunEvidence = {
	exit_code: number | null; signal: string | null;
	passed: number; failed: number; assertions: number;
	loaded: boolean; assertion_failure: boolean;
	output_sha256: string; log_prefix: string;
};
const mutations: readonly Mutation[] = [
	{ id: "staged-overlap-ignored", selector: "^T4 ", edits: [[
		'const indexAction = equal(idx, c.old, plan.filemode) ? "update" : equal(idx, c.new, plan.filemode) ? "keep" : null;',
		'const indexAction = equal(idx, c.old, plan.filemode) ? "update" : equal(idx, c.new, plan.filemode) ? "keep" : "update";',
	]] },
	{ id: "dirty-overwrite", selector: "^T3 ", edits: [
		['else conflicts.push({ path, kind: "DIRTY_OVERLAP" });', 'else plan.changes.push({ ...c, seen, index: indexAction, worktree: "write" });'],
		['if (!equal(worktreeSides(repo, [c.path], plan.filemode).get(c.path) ?? null, c.old, plan.filemode)) { races.push(c.path); continue; }', 'if (false) { races.push(c.path); continue; }'],
	] },
	{ id: "ref-without-cas", selector: "^T10 ", edits: [[
		'["update-ref", "-m", "git_converge", "refs/heads/main", next, plan.old]',
		'["update-ref", "-m", "git_converge", "refs/heads/main", next]',
	]] },
	{ id: "force-push", selector: "^T9 ", edits: [[
		'["push", "--porcelain", plan.remote, `${head}:refs/heads/main`]',
		'["push", "--force", "--porcelain", plan.remote, `${head}:refs/heads/main`]',
	]] },
	{ id: "no-index-update", selector: "^T7 ", edits: [[
		'setIndex(repo, updates);', 'void updates;',
	]] },
	{ id: "always-ours", selector: "^T15 owner theirs ", edits: [[
		'resolution === "ours" ? old : up', 'true ? old : up',
	]] },
	{ id: "hint-auto-applied", selector: "^T13 strict prefix ", edits: [[
		'unresolved.push(conflict);',
		'if (conflict.hint) { const selected = conflict.hint === "theirs_behind" ? "ours" : "theirs"; chosen.push({ path, side: sideAt(repo, selected === "ours" ? old : up, path) }); labels[path] = selected; } else unresolved.push(conflict);',
	]] },
	{ id: "index-preimage-check-removed", selector: "^T17 peer stages same ", edits: [[
		'if (raced.length) throw new Refused("INDEX_RACE", raced.map(r => ({ path: r.path, kind: "INDEX_RACE" })));',
		'if (false) throw new Refused("INDEX_RACE", raced.map(r => ({ path: r.path, kind: "INDEX_RACE" })));',
	]] },
	{ id: "restore-skipped", selector: "^T21 every lost CAS ", edits: [[
		'const skipped = restoreIndex(repo, plan, updates);', 'const skipped: string[] = [];',
	]] },
	{ id: "unconditional-restore", selector: "^T21b ", edits: [[
		'if (change && entriesEqual(now.get(r.path) ?? [], wrote) && equal(sideAt(repo, main, r.path), change.old)) {',
		'if (change) {',
	]] },
];
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function mutate(source: string, edits: readonly Edit[]): string {
	let result = source;
	for (const [before, after] of edits) {
		const at = result.indexOf(before);
		if (at < 0 || result.indexOf(before, at + before.length) >= 0) throw new Error("Mutation selector is absent or ambiguous");
		result = result.slice(0, at) + after + result.slice(at + before.length);
	}
	return result;
}

if (process.env.OMP_KIT_CONVERGE_MUTANT_LOADER === "1") {
	const id = process.env.OMP_KIT_CONVERGE_MUTANT;
	const mutation = mutations.find(item => item.id === id);
	if (id !== "baseline" && !mutation) throw new Error("Unknown convergence mutation");
	await plugin({
		name: "converge-in-memory-mutation",
		setup(builder) {
			builder.onLoad({ filter: /converge\.ts$/, namespace: "file" }, args => {
				if (realpathSync(args.path) !== sourcePath) return;
				const source = readFileSync(sourcePath, "utf8"), originalSha = sha256(source);
				if (originalSha !== process.env.OMP_KIT_CONVERGE_SOURCE_SHA256) throw new Error("Convergence source changed during mutation qualification");
				const contents = mutation ? mutate(source, mutation.edits) : source;
				console.error(marker + JSON.stringify({ id, source_sha256: originalSha, loaded_sha256: sha256(contents), edits: mutation?.edits.length ?? 0, pid: process.pid }));
				return { contents, loader: "ts" };
			});
		},
	});
} else if (import.meta.main) {
	const sourceSha = sha256(readFileSync(sourcePath));
	// The run keeps its logs as evidence (log_prefix below), so they live in the caller's owned scratch, never
	// system temp: TMPDIR is required, as scripts/release-local.sh requires it.
	const scratchRoot = process.env.TMPDIR ?? "";
	if (scratchRoot === "" || !statSync(scratchRoot, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error("converge-mutants: export TMPDIR to an owned scratch directory first");
	}
	const scratch = mkdtempSync(join(scratchRoot, `converge-mutants.${process.pid}.`)); // tempsafe: evidence kept in the caller-owned scratch by contract; the caller releases it with --bin evidence
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=converge-mutants\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const run = (mutation: Mutation, id: string): RunEvidence => {
		const env = { ...process.env, TMPDIR: scratch, NO_COLOR: "1", FORCE_COLOR: "0",
			BUN_OPTIONS: `--require=${self}`,
			OMP_KIT_CONVERGE_MUTANT_LOADER: "1", OMP_KIT_CONVERGE_MUTANT: id, OMP_KIT_CONVERGE_SOURCE_SHA256: sourceSha };
		const result = spawnSync(process.execPath, ["test", "tests/cli/converge.test.ts", "-t", mutation.selector],
			{ cwd: root, env, encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
		const stdout = result.stdout ?? "", stderr = result.stderr ?? "", output = stdout + "\n" + stderr;
		const label = `${mutation.id}.${id === "baseline" ? "baseline" : "mutant"}`;
		writeFileSync(join(scratch, `${label}.stdout`), stdout);
		writeFileSync(join(scratch, `${label}.stderr`), stderr);
		const passed = Number(output.match(/^[ \t]*(\d+) pass[ \t]*$/m)?.[1] ?? 0);
		const failed = Number(output.match(/^[ \t]*(\d+) fail[ \t]*$/m)?.[1] ?? 0);
		const assertions = Number(output.match(/^[ \t]*(\d+) expect\(\) calls[ \t]*$/m)?.[1] ?? 0);
		const loads = output.split("\n").filter(line => line.startsWith(marker)).map(line => {
			const value: unknown = JSON.parse(line.slice(marker.length));
			return value !== null && typeof value === "object" && "id" in value && value.id === id
				&& "source_sha256" in value && value.source_sha256 === sourceSha;
		});
		return { exit_code: result.status, signal: result.signal, passed, failed, assertions,
			loaded: loads.some(Boolean), assertion_failure: output.includes("error: expect(") || output.includes("AssertionError"),
			output_sha256: sha256(output), log_prefix: join(scratch, label) };
	};
	const results: Array<{ id: string; selector: string; status: "BASELINE_UNRUN_OR_FAILED" | "KILLED" | "SURVIVED" | "UNRUN";
		baseline: RunEvidence; mutant?: RunEvidence }> = [];
	for (const mutation of mutations) {
		if (sha256(readFileSync(sourcePath)) !== sourceSha) throw new Error("Source changed before mutation pair");
		const baseline = run(mutation, "baseline");
		if (baseline.exit_code !== 0 || !baseline.loaded || baseline.passed === 0 || baseline.failed !== 0 || baseline.assertions === 0) {
			results.push({ id: mutation.id, selector: mutation.selector, status: "BASELINE_UNRUN_OR_FAILED", baseline });
			continue;
		}
		const mutant = run(mutation, mutation.id);
		const status = !mutant.loaded || mutant.signal !== null || mutant.passed + mutant.failed === 0 || mutant.assertions === 0
			? "UNRUN" : mutant.exit_code !== 0 && mutant.failed > 0 && mutant.assertion_failure ? "KILLED" : mutant.exit_code === 0 ? "SURVIVED" : "UNRUN";
		results.push({ id: mutation.id, selector: mutation.selector, status, baseline, mutant });
	}
	const unchanged = sha256(readFileSync(sourcePath)) === sourceSha;
	const killed = results.filter(item => item.status === "KILLED").length;
	console.log(JSON.stringify({ schema_version: 1, source_sha256: sourceSha, source_unchanged: unchanged,
		requested: mutations.length, killed, results, scratch }, null, 2));
	process.exitCode = unchanged && killed === mutations.length ? 0 : 1;
}
