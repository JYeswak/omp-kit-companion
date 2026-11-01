import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { admitClaimCut } from "../../src/claim-cut.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

async function runWalk(readDurationsMs: number[]) {
	const scratch = ownedTmp("claim-cut-deadline");
	try {
		const configPath = join(scratch.path, "fleet-watch.json");
		writeFileSync(configPath, JSON.stringify({ sessions: [{
			repo: scratch.path,
			milestone: { epic: "cut", pinned: ["pin"] },
		}] }));
		let now = 0;
		let reads = 0;
		const originalNow = Date.now;
		Date.now = () => now;
		try {
			const verdict = await admitClaimCut({
				repo: scratch.path,
				id: "candidate",
				db: join(scratch.path, ".beads", "beads.db"),
				bead: { id: "candidate", status: "open" },
				env: { OMP_KIT_FLEET_WATCH_CONFIG: configPath },
				read: async args => {
					now += readDurationsMs[reads++] ?? 0;
					if (args[0] === "show" && args[1] === "pin") {
						return { id: "pin", status: "in_progress", assignee: null, labels: [] };
					}
					if (args[0] === "dep" && args[1] === "list" && args[2] === "pin") {
						return [{ issue_id: "pin", depends_on_id: "candidate", type: "blocks", status: "open" }];
					}
					if (args[0] === "dep" && args[1] === "list" && args[2] === "candidate") return [];
					throw new Error(`unexpected claim-cut read: ${JSON.stringify(args)}`);
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

test("claim-cut deadline admits a valid loaded graph and still refuses past its bound", async () => {
	const slowButWithinBound = await runWalk([6_700, 6_700]);
	expect(slowButWithinBound.reads).toBe(3);
	expect(slowButWithinBound.now).toBe(13_400);
	expect(slowButWithinBound.verdict.code).toBe("CLAIM_CUT_ADMITTED");

	const beyondBound = await runWalk([10_001, 10_001]);
	expect(beyondBound.reads).toBe(2);
	expect(beyondBound.now).toBe(20_002);
	expect(beyondBound.verdict.code).toBe("CLAIM_CUT_UNKNOWN");
	expect(beyondBound.verdict.detail).toContain("cut graph read deadline exceeded");
});
