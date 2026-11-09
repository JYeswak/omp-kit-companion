import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRules, OMP_SRC } from "../../scripts/rule-class.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { runEffectiveRuleProbe } from "../../src/diagnostics.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
// The installed OMP source directory is selected at runtime, not a bundled module.
const { TtsrManager } = await import(join(OMP_SRC, "export/ttsr.ts"));
const retired = ["kit-standing-law", "kit-fleet-standing-law", "kit-gate-must-name-the-plant", "kit-relative-path-not-cwd", "kit-weasel-retry", "zz-canary-scope-probe"];
const pack = () => [...loadRules(join(root, "rules")), ...loadRules(join(root, "rules-fleet"))];
function matched(text: string, source = "text", toolName?: string, filePaths?: string[]): string[] {
	const manager = new TtsrManager({ enabled: true, disabledRules: [] });
	for (const loaded of pack()) manager.addRule(loaded.rule);
	return manager.checkSnapshot(text, { source, toolName, filePaths }).map((rule: { name: string }) => rule.name);
}
function noRetiredHits(text: string, source?: string, tool?: string, paths?: string[]) {
	expect(matched(text, source, tool, paths).filter(name => retired.includes(name))).toEqual([]);
}

test("merged-honesty-contract: no duplicated always-context; measured completion stays quiet, unverified completion is caught", () => {
	// Loading the actual shipped directories catches restoration of either context-only rule.
	expect(pack().filter(loaded => retired.includes(loaded.name) && loaded.rule.alwaysApply).map(loaded => loaded.name)).toEqual([]);
	expect(matched("UNVERIFIED: cargo test -p parser has not been run.")).not.toContain("kit-unverified-done");
	expect(matched("Done. All tests pass.")).toContain("kit-unverified-done");
});

// Dropped after replay validation (J-2026-11-09-03): native guards own these (dcg core.git:push-force-*,
// fleet-guard system-temp), so a TTSR copy only double-fires. A restored file fails here.
test("dropped fleet rules stay out of the pack: kit-no-force-push, kit-scratch-tmp", () => {
	const names = pack().map(loaded => loaded.name);
	expect(names.filter(name => name === "kit-no-force-push" || name === "kit-scratch-tmp")).toEqual([]);
	expect(names).toContain("kit-no-pattern-kill");
});

test("starter-checker-negative: checker execution needs no reminder; a missed defect fails its selftest", async () => {
	noRetiredHits(JSON.stringify({ command: "sh starter-kit/scripts/check-claim-discipline.sh claims.tsv" }), "tool", "bash");
	const scratch = ownedTmp("retire-checker");
	try {
		const checker = join(root, "checkers/check-claim-discipline.sh");
		const env = { ...process.env, TMPDIR: scratch.path, KIT_SH: "/bin/sh" };
		const good = await run(["/bin/sh", checker, "--selftest"], { env, cwd: root, deadline_s: fixtureDeadlineS(30) });
		expect(good.rc, Buffer.from(good.stdout).toString() + Buffer.from(good.stderr).toString()).toBe(0);
		// Ignore a failing checker result: the existing unmatched-pattern plant must catch this.
		const source = readFileSync(checker, "utf8");
		expect(source).toContain('return "$report_child_rc"');
		const mutant = source.replace('return "$report_child_rc"', "return 0");
		const mutantPath = join(scratch.path, "mutant.sh");
		writeFileSync(mutantPath, mutant);
		const bad = await run(["/bin/sh", mutantPath, "--selftest"], { env, cwd: root, deadline_s: fixtureDeadlineS(30) });
		expect(bad.rc).toBe(1);
		expect(Buffer.from(bad.stdout).toString()).toContain("SELFTEST_FAIL: planted unmatched enforce=yes row was accepted");
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(60) * 1_000);

test("native-path-resolution: no cwd reminder; explicit root wins and wrong-cwd decoy is refused", async () => {
	noRetiredHits(JSON.stringify({ command: "sh starter-kit/scripts/check-readiness.sh notes/packet.md" }), "tool", "bash");
	const scratch = ownedTmp("retire-path");
	try {
		const result = await run(["/bin/sh", join(root, "checkers/check-readiness.sh"), "--selftest"], {
			cwd: root, env: { ...process.env, TMPDIR: scratch.path, KIT_SH: "/bin/sh" }, deadline_s: fixtureDeadlineS(30),
		});
		const output = Buffer.from(result.stdout).toString();
		expect(result.rc, output + Buffer.from(result.stderr).toString()).toBe(0);
		expect(output).toContain("ARM relative-path-uses-root: READY:");
		expect(output).toContain("ARM cwd-decoy-ignored: NOT READY:");
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(40) * 1_000);

test("scope-and-proof: honest no-result needs no ledger prose; unsupported success still triggers", () => {
	noRetiredHits("No material increment found. Retry predicate: later", "tool", "write", ["docs/evidence/NEGATIVE_EVIDENCE.md"]);
	expect(matched("UNVERIFIED: no material increment found; tests have not been run.")).not.toContain("kit-unverified-done");
	expect(matched("Done. All tests pass.")).toContain("kit-unverified-done");
});

test("explicit-discovery-diagnostic: enabled known rule matches; disabled and wrong-scope rules do not", () => {
	noRetiredHits(JSON.stringify({ command: "echo zzzz_systemwide_canary_9c42" }), "tool", "bash");
	const rule = pack().find(loaded => loaded.name === "kit-unverified-done")!.rule;
	const enabled = new TtsrManager({ enabled: true, disabledRules: [] });
	enabled.addRule(rule);
	expect(enabled.checkSnapshot("Done. All tests pass.", { source: "text" }).map((entry: { name: string }) => entry.name)).toContain(rule.name);
	const scratch = ownedTmp("retire-discovery");
	try {
		const rulesDir = join(scratch.path, ".omp/agent/rules");
		mkdirSync(rulesDir, { recursive: true });
		const file = join(rulesDir, `${rule.name}.md`);
		const bytes = readFileSync(rule.path, "utf8");
		writeFileSync(file, bytes);
		// Probe the resolved distribution, not a machine-local HOME-dependent wrapper.
		const identity = resolveOmpIdentity(process.env);
		const manifest = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
		const launcher = join(identity.packageRoot, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.omp);
		const names = () => {
			const result = runEffectiveRuleProbe(launcher, scratch.path, "default", "ttsr") as { rules?: Array<{ name: string }> } | Array<{ name: string }>;
			return (Array.isArray(result) ? result : result.rules ?? []).map(entry => entry.name);
		};
		expect(names()).toContain(rule.name);
		writeFileSync(file, bytes.replace("---\n", "---\nenabled: false\n"));
		expect(names()).not.toContain(rule.name);
	} finally { scratch.cleanup(); }
	expect(enabled.checkSnapshot("Done. All tests pass.", { source: "tool", toolName: "bash" })).toEqual([]);
});
