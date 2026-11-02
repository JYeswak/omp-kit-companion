import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitClaimCut } from "../../src/claim-cut.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

type FakeRow = { id: string; status: string; assignee?: string | null; labels?: string[]; blocks?: string[]; parents?: string[] };
const ACTIVE: Record<string, true> = { open: true, in_progress: true, blocked: true, rework: true, in_review: true };
const isActive = (status: string | undefined) => status !== undefined && ACTIVE[status] === true;

/** Native br shapes: `list` and `blocked` are paged envelopes; `blocked` omits in_progress beads; `show` rows carry edges. */
function nativeAnswer(rows: Record<string, FakeRow>, args: string[]): unknown {
	const all = Object.values(rows);
	if (args[0] === "list") return { issues: all.filter(row => isActive(row.status)), has_more: false, total: all.length };
	if (args[0] === "blocked") {
		return { has_more: false, issues: all
			.filter(row => row.status !== "in_progress" && row.status !== "closed")
			.map(row => ({ id: row.id, blocked_by: (row.blocks ?? []).filter(dep => isActive(rows[dep]?.status)) }))
			.filter(row => row.blocked_by.length > 0) };
	}
	if (args[0] === "show") {
		return args.slice(1, -1).map(id => {
			const row = rows[id];
			if (!row) throw new Error(`no fixture row ${id}`);
			return { ...row, dependencies: [
				...(row.blocks ?? []).map(dep => ({ id: dep, dependency_type: "blocks", status: rows[dep]?.status ?? "closed" })),
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
	const within = await admit({ pinned: ["pin"], id: "candidate", rows: simple(), readDurationsMs: [9_000, 9_000] });
	expect(within.reads).toBe(2);
	expect(within.verdict.code).toBe("CLAIM_CUT_ADMITTED");

	const beyond = await admit({ pinned: ["pin"], id: "candidate", rows: simple(), readDurationsMs: [10_001, 10_001] });
	expect(beyond.reads).toBe(2);
	expect(beyond.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(beyond.verdict.detail).toContain("cut graph read deadline exceeded");
});

// CUTREADBULK1 (ompkit-774u.55.2): 150 pins in a blocks chain; the claimed bead is an unpinned open prerequisite of
// the chain's last pin. The per-bead walk needed one read per bead and hit the 128-node cap; bulk reads need two.
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
