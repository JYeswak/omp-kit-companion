import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitClaimCut } from "../../src/claim-cut.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

type FakeRow = { id: string; status: string; assignee?: string | null; labels?: string[]; blocks?: string[]; waits?: string[]; parents?: string[] };
const ACTIVE: Record<string, true> = { open: true, in_progress: true, blocked: true, rework: true, in_review: true };
const isActive = (status: string | undefined) => status !== undefined && ACTIVE[status] === true;

/**
 * Native br shapes, as measured on a scratch tracker 2026-11-02: `list` and `blocked` are paged envelopes; `blocked`
 * lists every blocker kind (blocks, waits-for) plus a child's blocked parent, untyped; `show` rows carry typed edges.
 */
function nativeAnswer(rows: Record<string, FakeRow>, args: string[]): unknown {
	const all = Object.values(rows);
	const direct = (row: FakeRow) => [...(row.blocks ?? []), ...(row.waits ?? [])].filter(dep => isActive(rows[dep]?.status));
	if (args[0] === "list") return { issues: all, has_more: false, total: all.length };
	if (args[0] === "blocked") {
		return { has_more: false, issues: all
			.filter(row => row.status !== "in_progress" && row.status !== "closed")
			.map(row => ({ id: row.id, blocked_by: [...direct(row), ...(row.parents ?? []).filter(p => rows[p] && direct(rows[p]!).length > 0)] }))
			.filter(row => row.blocked_by.length > 0) };
	}
	if (args[0] === "show") {
		return args.slice(1, -1).map(id => {
			const row = rows[id];
			if (!row) throw new Error(`no fixture row ${id}`);
			return { ...row, dependencies: [
				...(row.blocks ?? []).map(dep => ({ id: dep, dependency_type: "blocks", status: rows[dep]?.status ?? "closed" })),
				...(row.waits ?? []).map(dep => ({ id: dep, dependency_type: "waits-for", status: rows[dep]?.status ?? "closed" })),
				...(row.parents ?? []).map(dep => ({ id: dep, dependency_type: "parent-child", status: rows[dep]?.status ?? "open" })),
			] };
		});
	}
	throw new Error(`unexpected claim-cut read: ${JSON.stringify(args)}`);
}

async function admit(opts: {
	pinned: string[];
	id: string;
	rows: Record<string, FakeRow>;
	readDurationsMs?: number[];
	answer?: (args: string[]) => unknown;
}) {
	const scratch = ownedTmp("claim-cut-deadline");
	try {
		const configPath = join(scratch.path, "fleet-watch.json");
		writeFileSync(configPath, JSON.stringify({ sessions: [{ repo: scratch.path, milestone: { epic: "cut", pinned: opts.pinned } }] }));
		let now = 0;
		let reads = 0;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			const verdict = await admitClaimCut({
				repo: scratch.path,
				id: opts.id,
				db: join(scratch.path, ".beads", "beads.db"),
				bead: opts.rows[opts.id],
				env: { OMP_KIT_FLEET_WATCH_CONFIG: configPath },
				read: async args => {
					now += opts.readDurationsMs?.[reads] ?? 0;
					reads += 1;
					return (opts.answer ?? (a => nativeAnswer(opts.rows, a)))(args);
				},
			});
			return { verdict, reads, now };
		} finally {
			Date.now = originalNow;
		}
	} finally {
		scratch.cleanup();
	}
}

const simple = (): Record<string, FakeRow> => ({
	pin: { id: "pin", status: "open", labels: [], blocks: ["candidate"] },
	candidate: { id: "candidate", status: "open", labels: [] },
});

test("claim-cut deadline admits a valid loaded graph and still refuses past its bound", async () => {
	// Reads: `list`, `blocked`, then one typed `show` of the screened path.
	const within = await admit({ pinned: ["pin"], id: "candidate", rows: simple(), readDurationsMs: [6_000, 6_000, 6_000] });
	expect(within.reads).toBe(3);
	expect(within.verdict.code).toBe("CLAIM_CUT_ADMITTED");

	const beyond = await admit({ pinned: ["pin"], id: "candidate", rows: simple(), readDurationsMs: [7_000, 7_000, 7_000] });
	expect(beyond.reads).toBe(3);
	expect(beyond.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(beyond.verdict.detail).toContain("cut graph read deadline exceeded");
});

// CUTREADBULK1 (ompkit-774u.55.2): 150 pins in a blocks chain; the claimed bead is an unpinned open prerequisite of
// the chain's last pin. The per-bead walk needed one read per bead and hit the 128-node cap; bulk reads need three.
function chain(): { rows: Record<string, FakeRow>; pinned: string[] } {
	const rows: Record<string, FakeRow> = {};
	const pinned: string[] = [];
	for (let i = 0; i < 150; i++) {
		const id = `pin-${i}`;
		pinned.push(id);
		rows[id] = { id, status: i === 0 ? "open" : "blocked", labels: [], blocks: [i < 149 ? `pin-${i + 1}` : "fix"] };
	}
	rows.fix = { id: "fix", status: "open", labels: [] };
	rows.stray = { id: "stray", status: "open", labels: [] };
	return { rows, pinned };
}

test("CUTREADBULK1 a 150-pin chain admits an unpinned open blocks-prerequisite in at most 3 reads", async () => {
	const { rows, pinned } = chain();
	const result = await admit({ pinned, id: "fix", rows });
	expect(result.verdict.code).toBe("CLAIM_CUT_ADMITTED");
	expect(result.reads).toBeLessThanOrEqual(3);
});

test("CUTREADBULK1 planted negatives: no path stays out of cut, malformed or failed bulk reads stay UNKNOWN", async () => {
	const { rows, pinned } = chain();
	const stray = await admit({ pinned, id: "stray", rows });
	expect(stray.verdict.code).toBe("CLAIM_OUT_OF_CUT");
	expect(stray.verdict.alternative).toBe("pin-0");

	const partial = await admit({ pinned, id: "fix", rows,
		answer: args => args[0] === "list" ? { issues: [], has_more: true } : nativeAnswer(rows, args) });
	expect(partial.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(partial.verdict.detail).toContain("partial or malformed page");

	const badRow = await admit({ pinned, id: "fix", rows,
		answer: args => args[0] === "blocked" ? { issues: [{ id: "pin-149", blocked_by: "fix" }], has_more: false } : nativeAnswer(rows, args) });
	expect(badRow.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(badRow.verdict.detail).toContain("malformed blocked row");

	const failed = await admit({ pinned, id: "fix", rows, answer: () => { throw new Error("tracker unavailable"); } });
	expect(failed.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(failed.verdict.blocking).toBe(true);
});

test("CUTREADBULK1 an in_progress pin's prerequisite is admitted though br blocked omits in_progress beads", async () => {
	const rows: Record<string, FakeRow> = {
		pin: { id: "pin", status: "in_progress", assignee: "W1", labels: [], blocks: ["fix"] },
		fix: { id: "fix", status: "open", labels: [] },
	};
	const result = await admit({ pinned: ["pin"], id: "fix", rows });
	expect(result.verdict.code).toBe("CLAIM_CUT_ADMITTED");
	expect(result.reads).toBe(3);
});

test("CUTREADBULK1 a closed prerequisite is not followed, and a parent-child relative is not a blocks path", async () => {
	const rows: Record<string, FakeRow> = {
		pin: { id: "pin", status: "blocked", labels: [], blocks: ["done", "mid"], parents: ["child"] },
		done: { id: "done", status: "closed", labels: [], blocks: ["beyond"] },
		mid: { id: "mid", status: "open", labels: [] },
		beyond: { id: "beyond", status: "open", labels: [] },
		child: { id: "child", status: "open", labels: [] },
	};
	expect((await admit({ pinned: ["pin"], id: "beyond", rows })).verdict.code).toBe("CLAIM_OUT_OF_CUT");
	expect((await admit({ pinned: ["pin"], id: "child", rows })).verdict.code).toBe("CLAIM_OUT_OF_CUT");
	expect((await admit({ pinned: ["pin"], id: "mid", rows })).verdict.code).toBe("CLAIM_CUT_ADMITTED");
});

// CUTREADBULK1 [b] mutant, executed in this file so a replay proves it: a copy of the module whose catch admits on
// read failure admits the failed read; the real module refuses it as CLAIM_CUT_UNKNOWN.
test("CUTREADBULK1 mutant: admission that admits on read failure is caught by the failed-read case", async () => {
	const source = readFileSync(join(import.meta.dir, "../../src/claim-cut.ts"), "utf8");
	const marker = 'return verdict("CLAIM_CUT_UNKNOWN", `${input.id}: cut admission inconclusive:';
	expect(source.includes(marker)).toBe(true);
	const scratch = ownedTmp("claim-cut-mutant");
	try {
		const mutantPath = join(scratch.path, "claim-cut-mutant.ts");
		writeFileSync(mutantPath, source.replace(marker, 'return verdict("CLAIM_CUT_ADMITTED", `${input.id}: MUTANT admits on failure').replaceAll('from "./', `from "${join(import.meta.dir, "../../src")}/`));
		const mutant = (await import(mutantPath)) as { admitClaimCut: typeof admitClaimCut };
		const { rows, pinned } = chain();
		const configPath = join(scratch.path, "fleet-watch.json");
		writeFileSync(configPath, JSON.stringify({ sessions: [{ repo: scratch.path, milestone: { epic: "cut", pinned } }] }));
		const input = { repo: scratch.path, id: "fix", db: join(scratch.path, ".beads", "beads.db"), bead: rows.fix,
			env: { OMP_KIT_FLEET_WATCH_CONFIG: configPath }, read: async () => { throw new Error("tracker unavailable"); } };
		expect((await mutant.admitClaimCut(input)).code).toBe("CLAIM_CUT_ADMITTED");
		expect((await admitClaimCut(input)).code).toBe("CLAIM_CUT_UNKNOWN");
	} finally {
		scratch.cleanup();
	}
});

// CUTREADBULK1: `br blocked` is an untyped superset (waits-for, conditional-blocks and a blocked parent all appear), so
// admission must confirm `blocks` edges by type. Mocked here, and on a real native tracker below.
test("CUTREADBULK1 waits-for and inherited-parent blockers are not blocks prerequisites; a blocks edge still admits", async () => {
	const rows: Record<string, FakeRow> = {
		pin: { id: "pin", status: "blocked", labels: [], blocks: ["b"], waits: ["w"] },
		b: { id: "b", status: "open", labels: [] },
		w: { id: "w", status: "open", labels: [] },
		epic: { id: "epic", status: "blocked", labels: [], blocks: ["eb"] },
		eb: { id: "eb", status: "open", labels: [] },
		child: { id: "child", status: "open", labels: [], parents: ["epic"] },
	};
	expect((await admit({ pinned: ["pin"], id: "b", rows })).verdict.code).toBe("CLAIM_CUT_ADMITTED");
	expect((await admit({ pinned: ["pin"], id: "w", rows })).verdict.code).toBe("CLAIM_OUT_OF_CUT");
	// The child pin's untyped blocked_by names its blocked parent; neither the parent nor its blocker is in this cut.
	expect((await admit({ pinned: ["child"], id: "epic", rows })).verdict.code).toBe("CLAIM_OUT_OF_CUT");
	expect((await admit({ pinned: ["child"], id: "eb", rows })).verdict.code).toBe("CLAIM_OUT_OF_CUT");
});

test("CUTREADBULK1 native br: only typed blocks edges admit, measured against a real scratch tracker", async () => {
	if (!Bun.which("br")) throw new Error("native br is a precondition of this case");
	const scratch = ownedTmp("claim-cut-native");
	try {
		const db = join(scratch.path, ".beads", "beads.db");
		const decoder = new TextDecoder();
		const br = (...args: string[]) => {
			const out = runSync(["br", ...args, "--db", db], { deadline_s: 30, cwd: scratch.path, env: { ...process.env, AGENT_NAME: "fixture" } });
			if (out.rc !== 0) throw new Error(`br ${args.join(" ")} -> ${out.rc}: ${decoder.decode(out.stderr)}`);
			return decoder.decode(out.stdout);
		};
		br("init", "--prefix", "cc", "--json");
		const id = (title: string) => {
			const created = JSON.parse(br("create", title, "--type", "task", "--json")) as { id?: string } | { id: string }[];
			return Array.isArray(created) ? created[0]!.id : created.id!;
		};
		const [pin, waits, cond, blocks, epic, epicBlocker, child] = ["pin", "waits", "cond", "blocks", "epic", "epicblocker", "child"].map(id);
		br("dep", "add", pin!, waits!, "--type", "waits-for");
		br("dep", "add", pin!, cond!, "--type", "conditional-blocks");
		br("dep", "add", pin!, blocks!);
		br("dep", "add", child!, epic!, "--type", "parent-child");
		br("dep", "add", epic!, epicBlocker!);
		const configPath = join(scratch.path, "fleet-watch.json");
		const read = async (args: string[]) => JSON.parse(br(...args, "--no-auto-import", "--no-auto-flush"));
		const claim = async (pinned: string[], candidate: string) => {
			writeFileSync(configPath, JSON.stringify({ sessions: [{ repo: scratch.path, milestone: { epic: "cut", pinned } }] }));
			const verdict = await admitClaimCut({ repo: scratch.path, id: candidate, db, env: { OMP_KIT_FLEET_WATCH_CONFIG: configPath }, read });
			return verdict.code === "CLAIM_CUT_UNKNOWN" ? `${verdict.code}: ${verdict.detail}` : verdict.code;
		};
		expect(await claim([pin!], blocks!)).toBe("CLAIM_CUT_ADMITTED");
		expect(await claim([pin!], waits!)).toBe("CLAIM_OUT_OF_CUT");
		expect(await claim([pin!], cond!)).toBe("CLAIM_OUT_OF_CUT");
		expect(await claim([child!], epic!)).toBe("CLAIM_OUT_OF_CUT");
		expect(await claim([child!], epicBlocker!)).toBe("CLAIM_OUT_OF_CUT");
	} finally {
		scratch.cleanup();
	}
}, 120_000);
