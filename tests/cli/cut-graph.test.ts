import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { admitClaimCut } from "../../src/claim-cut.ts";

const root = ownedTmp("cut-graph-cli").path;
const cli = resolve(import.meta.dir, "../../src/cli.ts");

function tracker(repo: string, rows: Record<string, unknown>[]): string {
	mkdirSync(join(repo, ".beads"), { recursive: true });
	const path = join(repo, ".beads", "issues.jsonl");
	writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
	return path;
}

async function command(args: string[], repo: string, config: string): Promise<{ rc: number; data: Record<string, unknown>; errors: { code: string }[] }> {
	const result = await run(["bun", cli, ...args, "--project", repo, "--db", join(repo, ".beads", "issues.jsonl"), "--json"], {
		cwd: repo,
		deadline_s: 60,
		env: { ...process.env, HOME: repo, OMP_KIT_FLEET_WATCH_CONFIG: config },
	});
	const stdout = new TextDecoder().decode(result.stdout);
	const envelope = JSON.parse(stdout) as { data: Record<string, unknown>; errors?: { code: string }[] };
	return { rc: result.rc, data: envelope.data, errors: envelope.errors ?? [] };
}

function bead(id: string, title: string, dependencies: { depends_on_id: string; type: string }[] = [], labels: string[] = []) {
	return { id, title, description: title, status: "open", labels, dependencies };
}

test("[PINPATH] pinned beads without an open goal path are refused regardless of creation date", async () => {
	const repo = join(root, "pinpath-repo");
	mkdirSync(join(repo, ".beads"), { recursive: true });
	const config = join(root, "pinpath-fleet-watch.json");
	writeFileSync(config, JSON.stringify({ sessions: [{ repo, milestone: { epic: "release", declaredAt: "2026-10-30T00:00:00Z", pinned: ["task"] } }] }));
	const rows = {
		release: { id: "release", status: "open", labels: ["kind:goal"] },
		task: { id: "task", status: "open", labels: [], created_at: "2026-10-30T00:00:00Z" },
	};
	const graph: Record<string, unknown[]> = { release: [], task: [{ issue_id: "task", depends_on_id: "release", type: "blocks", status: "open" }] };
	const read = async (args: string[]): Promise<unknown> => {
		if (args[0] === "show") {
			const id = args[1];
			if (id !== "release" && id !== "task") throw new Error(`unexpected bead ${id}`);
			return [rows[id]];
		}
		if (args[0] === "dep" && args[1] === "list") return graph[args[2] ?? ""] ?? [];
		throw new Error(`unexpected cut read ${args.join(" ")}`);
	};
	const input = { repo, id: "task", env: { HOME: repo, OMP_KIT_FLEET_WATCH_CONFIG: config },
		db: join(repo, ".beads", "beads.db"), bead: rows.task, read };
	const unlinked = await admitClaimCut(input);
	if (unlinked.code !== "CLAIM_OUT_OF_CUT") throw new Error(`unlinked pin result: ${JSON.stringify(unlinked)}`);
	graph.release = [{ issue_id: "release", depends_on_id: "task", type: "blocks", status: "open" }];
	expect((await admitClaimCut(input)).code).toBe("CLAIM_CUT_ADMITTED");
	graph.release = [];
	expect((await admitClaimCut(input)).code).toBe("CLAIM_OUT_OF_CUT");
});
test("[GOALRANK] cut rank excludes high-fan-in work outside the reachable open goal subgraph and preserves each path", async () => {
	const repo = join(root, "rank-repo");
	mkdirSync(repo, { recursive: true });
	const config = join(root, "rank-fleet-watch.json");
	writeFileSync(config, JSON.stringify({ sessions: [{ repo, milestone: { epic: "release", declaredAt: "2026-10-30T00:00:00Z", pinned: ["deep", "work"] } }] }));
	tracker(repo, [
		bead("release", "Release train", [{ depends_on_id: "work", type: "blocks" }], ["kind:goal"]),
		bead("work", "Cut graph constraint", [{ depends_on_id: "deep", type: "blocks" }]),
		bead("deep", "Deep verification"),
		bead("outsider", "High fan-in outside the release graph"),
		...Array.from({ length: 8 }, (_, index) => bead(`fan-${index}`, `Fan-in ${index}`, [{ depends_on_id: "outsider", type: "blocks" }])),
	]);
	const result = await command(["cut", "rank"], repo, config);
	expect(result.rc).toBe(0);
	expect(result.data.verdict).toBe("RANKED");
	const ranking = result.data.ranking as { id: string; path: string[] }[];
	expect(ranking.map(row => row.id).sort()).toEqual(["deep", "release", "work"].sort());
	expect(ranking.filter(row => row.id !== "release")[0]?.id).toBe("work");
	expect(ranking.find(row => row.id === "deep")?.path).toEqual(["deep", "work", "release"]);
});

test("[PLACE] beads place selects the matching open goal and emits the blocks edge in the correct direction", async () => {
	const repo = join(root, "place-repo");
	mkdirSync(repo, { recursive: true });
	const config = join(root, "place-fleet-watch.json");
	writeFileSync(config, JSON.stringify({ sessions: [] }));
	tracker(repo, [
		bead("release", "Release verification goal", [{ depends_on_id: "release-test", type: "blocks" }], ["kind:goal"]),
		bead("release-test", "Release verification test and acceptance evidence"),
		bead("docs", "Documentation cleanup goal", [{ depends_on_id: "docs-test", type: "blocks" }], ["kind:goal"]),
		bead("docs-test", "Documentation writing and links"),
	]);
	const result = await command(["beads", "place", "--title", "Release verification acceptance"], repo, config);
	expect(result.rc).toBe(0);
	expect(result.data.verdict).toBe("PLACED");
	const goal = result.data.goal;
	expect(goal).toBeTruthy();
	if (!goal || typeof goal !== "object" || !("id" in goal)) throw new Error("placement result has no goal id");
	expect(goal.id).toBe("release");
	const commands = result.data.commands as string[];
	expect(commands[1]).toBe("br dep add release-test <NEW_ID>");
	expect(commands.join(" ")).not.toContain("--deps blocks:");
});

test("cut rank refuses when the project has no declared fleet-watch goal", async () => {
	const repo = join(root, "unconfigured-repo");
	mkdirSync(repo, { recursive: true });
	const config = join(root, "unconfigured-fleet-watch.json");
	writeFileSync(config, JSON.stringify({ sessions: [] }));
	tracker(repo, [bead("release", "Release train")]);
	const result = await command(["cut", "rank"], repo, config);
	expect(result.rc).not.toBe(0);
	expect(result.errors.map(error => error.code)).toContain("NO_DECLARED_GOAL");
});
