import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCaseCorpus } from "../../src/case-corpus.ts";
import { check as durabilityCheck } from "../../src/fleet-guard/durability.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import {
	assertDeterministicAdmission, mechanicalVerdicts, NONDETERMINISM_ERROR, PARTITION_ERROR,
	reassemble, type AdmissionEvaluator, type MechanicalCase,
} from "../../src/mechanical-admission.ts";

const KIT = fileURLToPath(new URL("../..", import.meta.url));
const corpus = parseCaseCorpus(readFileSync(join(KIT, "cases", "cases.tsv"), "utf8"));
const admissionCases = corpus.cases.filter(c => c.rule === "scratch-is-not-a-home" && c.source === "tool");
const fireCase: MechanicalCase = admissionCases.find(c => c.expect === "fire")!;
const quietCase: MechanicalCase = admissionCases.find(c => c.expect === "quiet")!;
const WIDTHS = [undefined, 1, 7, 4096] as const;

function counted(evaluate: AdmissionEvaluator): { evaluate: AdmissionEvaluator; calls: () => number } {
	let calls = 0;
	return { evaluate: async (event, context) => { calls++; return evaluate(event, context); }, calls: () => calls };
}

describe("mechanical admission dispatch", () => {
	test("the shipped corpus supplies a fire and a quiet tool case for the admission guard", () => {
		expect(corpus.errors).toEqual([]);
		expect(fireCase).toBeDefined();
		expect(quietCase).toBeDefined();
	});
	test("owned .owner metadata stays quiet while an unsafe scratch artifact still fires", async () => {
		const owner = admissionCases.find(c => c.path === "var/agent-tmp/dogfood-d0.62533/.owner" && c.expect === "quiet");
		const unsafe = admissionCases.find(c => c.expect === "fire" && c.path.includes("var/agent-tmp") && c.path.endsWith(".md"));
		expect(owner).toBeDefined();
		expect(unsafe).toBeDefined();
		expect(await assertDeterministicAdmission(owner!, { kit: KIT })).toBe(false);
		expect(await assertDeterministicAdmission(unsafe!, { kit: KIT })).toBe(true);
	});

	test("the real guard returns one verdict per case, dispatched twice for the determinism check and shared by every exact partition", async () => {
		for (const [c, expected] of [[fireCase, true], [quietCase, false]] as const) {
			const guard = counted(durabilityCheck);
			expect(await mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: guard.evaluate })).toEqual(WIDTHS.map(() => expected));
			expect(guard.calls()).toBe(2);
		}
	});

	test("a partition whose reassembly differs from the wire is refused before any dispatch", async () => {
		const guard = counted(durabilityCheck);
		const losesLastCharacterAtWidthOne = (wire: string, width: number) => width === 1 ? reassemble(wire, width).slice(0, -1) : reassemble(wire, width);
		await expect(mechanicalVerdicts(fireCase, WIDTHS, { kit: KIT, evaluate: guard.evaluate, join: losesLastCharacterAtWidthOne }))
			.rejects.toThrow(PARTITION_ERROR);
		expect(guard.calls()).toBe(0);
	});

	test("the real guard is deterministic on every corpus admission case: two dispatches agree with the corpus expectation", async () => {
		expect(admissionCases.length).toBeGreaterThan(2);
		for (const c of admissionCases)
			expect(await assertDeterministicAdmission(c, { kit: KIT }), `line ${c.line}: ${c.note}`).toBe(c.expect === "fire");
	});

	test("the gate dispatch path checks every corpus admission case with exactly one extra dispatch", async () => {
		for (const c of admissionCases) {
			const guard = counted(durabilityCheck);
			expect(await mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: guard.evaluate }), `line ${c.line}`).toEqual(WIDTHS.map(() => c.expect === "fire"));
			expect(guard.calls()).toBe(2);
		}
	});

	test("a planted evaluator that flips its verdict on the second call fails the check on every corpus admission case", async () => {
		for (const c of admissionCases) {
			const calls = new Map<string, number>();
			const flipping: AdmissionEvaluator = async (event, context) => {
				const call = (calls.get(context.cwd) ?? 0) + 1;
				calls.set(context.cwd, call);
				const verdict = (await durabilityCheck(event, context))?.block === true;
				return (call === 2 ? !verdict : verdict) ? { block: true, reason: "planted flip" } : undefined;
			};
			await expect(assertDeterministicAdmission(c, { kit: KIT, evaluate: flipping }), `line ${c.line}`).rejects.toThrow(NONDETERMINISM_ERROR);
			await expect(mechanicalVerdicts(c, WIDTHS, { kit: KIT, evaluate: flipping }), `line ${c.line}`).rejects.toThrow(NONDETERMINISM_ERROR);
		}
	});
});

// FLEETOPTIN1 (ompkit-26xhq) live probe 2026-10-22: fleet-guard set a seat's TMPDIR to its own
// var/agent-tmp/omp.<pid> dir, then refused every write-tool write into it ("scratch ownership metadata is
// invalid"): the admission parser accepted only the four legacy keys, never the seat owner fleet-guard
// writes (agent/session/bin) or the JSON owner `omp-kit scratch new` writes.
describe("scratch admission reads every owner form the kit writes", () => {
	function repoWithOwner(owner: (repo: string) => string): { repo: string; target: string } {
		const repo = realpathSync(ownedTmp("owner-forms").path);
		Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-C", repo, "init", "--quiet"]);
		mkdirSync(join(repo, ".omp"));
		writeFileSync(join(repo, ".omp/fleet.json"), '{"enabled":true}\n');
		const scratch = join(repo, "var/agent-tmp/probe.4242");
		mkdirSync(scratch, { recursive: true });
		writeFileSync(join(scratch, ".owner"), owner(repo));
		return { repo, target: join(scratch, "notes.txt") };
	}
	async function blocked(owner: (repo: string) => string): Promise<string | undefined> {
		const { repo, target } = repoWithOwner(owner);
		try {
			const verdict = await durabilityCheck({ toolName: "write", input: { path: target, content: "raw capture\n" }, cwd: repo }, { cwd: repo });
			return verdict?.block === true ? verdict.reason : undefined;
		} finally { rmSync(repo, { recursive: true, force: true }); }
	}
	const created = "2026-10-22T04:40:41.583Z";
	test("the seat owner fleet-guard writes (agent, session, bin) admits a write", async () => {
		expect(await blocked(repo => `pid=4242\nlabel=omp\nrepo=${repo}\ncreated=${created}\nagent=FleetOptinProbe\nsession=01a161e9-4b73-761b-b7e9-2af2c2f494ce\nbin=throwaway\n`)).toBeUndefined();
	});
	test("the JSON owner `omp-kit scratch new` writes admits a write", async () => {
		expect(await blocked(repo => JSON.stringify({ pid: 4242, process_start: "Wed Oct 21 22:40:00 2026", label: "probe", repo, created_at: created, argv0: "/omp-kit", agent: "PeachLeopard", session: "01a14ff8-63a4-7533-9e1f-54ac1fa2eff9", bead: "ompkit-26xhq" }))).toBeUndefined();
	});
	test("planted: an owner naming another repository is still refused", async () => {
		expect(await blocked(() => `pid=4242\nlabel=omp\nrepo=/nonexistent/elsewhere\ncreated=${created}\n`)).toContain("does not identify this repository");
	});
	test("planted: malformed owner metadata is still refused", async () => {
		expect(await blocked(() => "pid=4242\npid=4243\nlabel=omp\n")).toContain("scratch ownership metadata is invalid");
	});
});

// SCRATCHOWNERFORM1 AC3 (ompkit-ma3sn) live probe 2026-10-22 on 0.2.65: a write-tool write of new content into a
// seat's owned scratch was refused "materialized source facts exceed admission limit" in every repository with more
// than 1024 tracked files (omp-kit 2613, companion 1173). The working-copy comparison is bounded by its work now.
describe("owned-scratch admission in a repository with more than 1024 tracked files", () => {
	const TRACKED = 1_500;
	const repo = realpathSync(ownedTmp("large-index").path);
	const git = (...args: string[]) => {
		const run = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-C", repo, ...args]);
		if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	};
	git("init", "--quiet");
	mkdirSync(join(repo, ".omp"));
	writeFileSync(join(repo, ".omp/fleet.json"), '{"enabled":true}\n');
	mkdirSync(join(repo, "src"));
	for (let index = 0; index < TRACKED; index++) writeFileSync(join(repo, "src", `f${index}.txt`), `tracked source ${index}\n`);
	git("add", "--", ".omp/fleet.json", "src");
	git("commit", "--quiet", "-m", "fixture");
	// A modified working copy: its bytes are in no index blob, only on disk.
	const modified = "edited canonical working copy, not yet committed\n";
	writeFileSync(join(repo, "src", "f1234.txt"), modified);
	const scratch = join(repo, "var/agent-tmp/own.4242");
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, ".owner"), `pid=4242\nlabel=own\nrepo=${repo}\ncreated=2026-10-22T06:20:00.000Z\n`);
	const write = (content: string) =>
		durabilityCheck({ toolName: "write", input: { path: join(scratch, "probe-owned.txt"), content }, cwd: repo }, { cwd: repo });
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("the fixture really tracks more than 1024 files", () => {
		const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean);
		expect(listed.length).toBe(TRACKED + 1);
	});
	test("new content written into owned scratch is admitted", async () => {
		expect(await write("raw capture from a probe run\n")).toBeUndefined();
	});
	test("planted: content byte-equal to a modified tracked working copy is refused", async () => {
		expect((await write(modified))?.reason).toContain("tracked-source-copy content matches materialized canonical source");
	});
	test("planted: content equal to an indexed blob is refused before the working-copy walk", async () => {
		expect((await write("tracked source 7\n"))?.reason).toContain("tracked-source-copy content matches the canonical Git index");
	});
});

afterAll(() => cleanupAllOwnedTmp());
