import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { lifecycleGaps, loadLifecycleManifest, renderLifecycleDoc, validateLifecycleManifest, type LifecycleManifest } from "../../src/lifecycle.ts";
import { LIFECYCLE_FILE_CAP, runLoopClose, type LoopCloseBrResult } from "../../src/loop-close.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const ROOT = resolve(import.meta.dir, "../..");

function shippedManifest(): LifecycleManifest {
	const loaded = loadLifecycleManifest(join(ROOT, "docs", "lifecycle.json"));
	expect(loaded.reason).toBe("ok");
	return loaded.manifest as LifecycleManifest;
}

test("LIFECYCLEMANIFEST1: the shipped manifest validates", () => {
	const manifest = shippedManifest();
	expect(validateLifecycleManifest(manifest, ROOT)).toEqual([]);
	expect(lifecycleGaps(manifest).length).toBeGreaterThan(0);
});

test("LIFECYCLEMANIFEST1: the rendered doc matches the committed docs/lifecycle.md", () => {
	const manifest = shippedManifest();
	expect(renderLifecycleDoc(manifest)).toBe(readFileSync(join(ROOT, "docs", "lifecycle.md"), "utf8"));
});

test("DOCSHARMONY1: the generated lifecycle doc carries the front-matter status doc-status requires", () => {
	// doc-status-check.sh refuses any docs/*.md without `status:` front matter; the generator owns it.
	const rendered = renderLifecycleDoc(shippedManifest());
	expect(rendered.startsWith("---\nstatus: current\n---\n")).toBe(true);
});

test("LIFECYCLEMANIFEST1: a row naming a missing verb fails validation", () => {
	const manifest = shippedManifest();
	const planted = JSON.parse(JSON.stringify(manifest)) as LifecycleManifest;
	planted.rows[0]!.verbs = ["no-such-verb"];
	const findings = validateLifecycleManifest(planted, ROOT);
	expect(findings.some(finding => finding.startsWith("LIFECYCLE_MANIFEST_UNKNOWN_VERB"))).toBe(true);
});

interface FixtureBead { id: string; title: string; labels: string[]; status: string }

function fixtureManifest(): LifecycleManifest {
	const rows = ["discover", "validate", "plan", "build", "verify", "release", "launch", "operate", "measure-value", "revenue", "learn"].map(phase => ({
		phase,
		exit_criterion: `Fixture exit for ${phase}.`,
		verbs: ["land"],
		doc: "doc.md",
		test: "test.ts",
		metric: phase === "launch" ? "UNKNOWN" : "closes_7d",
	}));
	return { version: 1, rows };
}

test("LIFECYCLEGAPCHECK1: --gap exits 1 with LIFECYCLE_GAP_OPEN while the facet is missing and 0 once it is filled", () => {
	const root = ownedTmp("lifecycle-gap-check").path;
	try {
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "doc.md"), "fixture doc");
		writeFileSync(join(root, "test.ts"), "fixture test");
		const planted = fixtureManifest();
		planted.rows.find(row => row.phase === "verify")!.doc = null;
		writeFileSync(join(root, "docs", "lifecycle.json"), JSON.stringify(planted));
		const script = join(ROOT, "scripts", "lifecycle-check.ts");
		const gapCheck = (gap: string) => runFixture([process.execPath, script, "--root", root, "--gap", gap], { cwd: root });
		// Planted negative: verify's doc is missing, so its gap stays open and the close is rejected.
		const open = gapCheck("verify:doc");
		expect(open.rc).toBe(1);
		expect(Buffer.from(open.stderr).toString()).toContain("LIFECYCLE_GAP_OPEN: phase verify");
		// Control: a filled facet on the same manifest reads closed.
		const closed = gapCheck("plan:doc");
		expect(closed.rc).toBe(0);
		expect(Buffer.from(closed.stderr).toString()).toContain("LIFECYCLE_GAP_CLOSED: phase plan has its doc");
		// A facet name outside verbs/doc/test/metric is a usage error, never a silent pass.
		expect(gapCheck("verify:docs").rc).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, fixtureDeadlineS() * 1000);

test("LIFECYCLEMANIFEST1: a loop-close run files one lifecycle gap bead and a second run files none", async () => {
	const root = ownedTmp("lifecycle-test").path;
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(join(root, "docs", "lifecycle.json"), JSON.stringify(fixtureManifest()));
	writeFileSync(join(root, "doc.md"), "fixture doc");
	writeFileSync(join(root, "test.ts"), "fixture test");
	const calls: string[][] = [];
	const beads: FixtureBead[] = [];
	let seq = 0;
	const runBr = async (argv: string[]): Promise<LoopCloseBrResult> => {
		calls.push(argv);
		if (argv[0] === "create") {
			seq += 1;
			const id = `lifecycle-test.${seq}`;
			const flag = argv.indexOf("-l");
			const labels = flag >= 0 ? String(argv[flag + 1] ?? "").split(",") : [];
			beads.push({ id, title: String(argv[1] ?? ""), labels, status: "open" });
			return { rc: 0, stdout: JSON.stringify({ id }), stderr: "" };
		}
		if (argv[0] === "list") return { rc: 0, stdout: JSON.stringify({ issues: beads }), stderr: "" };
		return { rc: 0, stdout: "{}", stderr: "" };
	};
	const deps = {
		ledgerPath: join(root, "missing-ledger.jsonl"),
		statePath: join(root, "kit-state", "loop-close.json"),
		home: root, repo: root, actor: "lifecycle-test",
		nowMs: Date.parse("2026-11-12T00:00:00Z"),
		runBr,
		readServiceStatus: async () => [],
		listLiveReadbacks: async () => [],
		runLiveReadback: async () => ({ ok: true }),
	};

	const first = await runLoopClose(deps);
	expect(first.lifecycleFiled).toHaveLength(1);
	expect(first.lifecycleUpdated).toEqual([]);
	const creates = calls.filter(argv => argv[0] === "create");
	expect(creates).toHaveLength(1);
	const label = String(creates[0]![creates[0]!.indexOf("-l") + 1] ?? "");
	expect(label).toContain("lifecycle:launch:metric");

	const second = await runLoopClose(deps);
	expect(calls.filter(argv => argv[0] === "create")).toHaveLength(1);
	expect(second.lifecycleFiled).toEqual([]);
	expect(second.lifecycleUpdated).toEqual(first.lifecycleFiled);
});

test("LIFECYCLEMANIFEST1: the shipped manifest files at most 5 gap beads per run and completes across runs", async () => {
	const manifest = shippedManifest();
	const gaps = lifecycleGaps(manifest);
	// More gaps than one run may file, so the cap and the drain across runs are both exercised.
	expect(gaps.length).toBeGreaterThan(LIFECYCLE_FILE_CAP);
	const root = ownedTmp("lifecycle-burst-test").path;
	const calls: string[][] = [];
	const beads: FixtureBead[] = [];
	let seq = 0;
	const runBr = async (argv: string[]): Promise<LoopCloseBrResult> => {
		calls.push(argv);
		if (argv[0] === "create") {
			seq += 1;
			const id = `lifecycle-burst.${seq}`;
			const flag = argv.indexOf("-l");
			const labels = flag >= 0 ? String(argv[flag + 1] ?? "").split(",") : [];
			beads.push({ id, title: String(argv[1] ?? ""), labels, status: "open" });
			return { rc: 0, stdout: JSON.stringify({ id }), stderr: "" };
		}
		if (argv[0] === "list") return { rc: 0, stdout: JSON.stringify({ issues: beads }), stderr: "" };
		return { rc: 0, stdout: "{}", stderr: "" };
	};
	const deps = {
		ledgerPath: join(root, "missing-ledger.jsonl"),
		statePath: join(root, "kit-state", "loop-close.json"),
		home: root, repo: ROOT, actor: "lifecycle-burst-test",
		nowMs: Date.parse("2026-11-12T00:00:00Z"),
		runBr,
		readServiceStatus: async () => [],
		listLiveReadbacks: async () => [],
		runLiveReadback: async () => ({ ok: true }),
	};
	const titles: string[] = [];
	const seen = new Set<string>();
	let runs = 0;
	for (;;) {
		const result = await runLoopClose(deps);
		runs += 1;
		expect(result.lifecycleFiled.length).toBeLessThanOrEqual(LIFECYCLE_FILE_CAP);
		for (const id of result.lifecycleFiled) seen.add(id);
		if (runs === 1) {
			expect(result.lifecycleFiled).toHaveLength(LIFECYCLE_FILE_CAP);
			for (const id of result.lifecycleFiled) {
				const bead = beads.find(candidate => candidate.id === id);
				titles.push(bead?.title ?? "");
			}
		}
		if (result.lifecycleFiled.length === 0) break;
		if (runs > 10) throw new Error("burst cap never drains the shipped gaps");
	}
	expect(seen.size).toBe(gaps.length);
	// The first run files the first CAP gaps in manifest order.
	expect(titles).toEqual(gaps.slice(0, LIFECYCLE_FILE_CAP).map(gap => `LIFECYCLE: ${gap.phase} missing ${gap.facet}`));
});
