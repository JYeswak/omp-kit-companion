import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedCommand } from "../../src/cli.ts";
import { MILESTONE_COMMAND, runMilestone } from "../../src/milestone.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const allocations: OwnedTmp[] = [];
afterEach(() => { for (const owned of allocations.splice(0)) owned.cleanup(); });

function fixture() {
	const owned = ownedTmp("milestone-launch-test");
	allocations.push(owned);
	const root = owned.path, repo = join(root, "repo"), bin = join(root, "bin"), config = join(root, "fleet-watch.json");
	mkdirSync(repo); mkdirSync(bin); mkdirSync(join(repo, "docs"));
	writeFileSync(join(repo, "docs", "runbook.md"), "# runbook\n");
	writeFileSync(join(bin, "br"), `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.BEADS_DB === "/foreign/tracker.db" || process.env.BEADS_DIR) throw Error("foreign tracker environment leaked");
const ids = args.slice(args.indexOf("show") + 1).filter(x => !x.startsWith("--"));
if (ids.some(id => !["frozen-closed", "frozen-open"].includes(id))) process.exit(1);
console.log(JSON.stringify(ids.map(id => ({ id, status: id === "frozen-closed" ? "closed" : "open", dependencies: [], dependents: [] }))));
`, { mode: 0o700 });
	writeFileSync(join(bin, "rb"), `#!/bin/sh\nexit 0\n`, { mode: 0o700 });
	writeFileSync(join(bin, "turnline"), `#!/bin/sh\necho '{"velocity":"42"}'\n`, { mode: 0o700 });
	writeFileSync(config, JSON.stringify({ sessions: [{ session: "demo", repo, milestone: { epic: "fixture-epic", due: "2026-11-05", declaredAt: "2026-11-03", pinned: [] } }] }) + "\n", { mode: 0o640 });
	const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), OMP_KIT_FLEET_WATCH_CONFIG: config,
		OMP_KIT_MILESTONE_VALUE_READER: join(bin, "turnline"), PATH: `${bin}:${process.env.PATH}`,
		AGENT_NAME: "CutWrite", BEADS_DB: "/foreign/tracker.db", BEADS_DIR: "/foreign/.beads" };
	return { root, repo, bin, config, env, read: () => JSON.parse(readFileSync(config, "utf8")) };
}
function launch(args: string, sets: string[]): ParsedCommand {
	const command = MILESTONE_COMMAND.subcommands?.find(child => child.name === "launch");
	if (!command) throw Error("unknown test action");
	return { command, parent: MILESTONE_COMMAND, argument: args, flags: new Map([["--set", sets.join("\n")]]), json: true, robot: false };
}
const pins = ["asset_freeze=frozen-closed", "runbook=docs/runbook.md", "value_metric=velocity", "rollback=rb"];

test("LAUNCHVERB1 all four pins resolvable reports READY and stores the pins on the milestone record", async () => {
	const f = fixture();
	const result = await runMilestone(launch("demo", pins), f.env);
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data).toMatchObject({ overall: "READY", session: "demo", issues: [] });
	expect(result.data.resolved).toEqual({ asset_freeze: true, runbook: true, value_metric: true, rollback: true });
	const stored = f.read().sessions[0].milestone.launch;
	expect(stored).toEqual({ asset_freeze: "frozen-closed", runbook: "docs/runbook.md", value_metric: "velocity", rollback: "rb" });
});

test("LAUNCHVERB1 an open asset-freeze bead reports NOT_READY naming it and its fix", async () => {
	const f = fixture();
	const result = await runMilestone(launch("demo", ["asset_freeze=frozen-open", "runbook=docs/runbook.md", "value_metric=velocity", "rollback=rb"]), f.env);
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data.overall).toBe("NOT_READY");
	const issues = result.data.issues as { pin: string; fix: string }[];
	expect(issues.map(issue => issue.pin)).toContain("asset_freeze");
	expect(issues.find(issue => issue.pin === "asset_freeze")?.fix).toContain("frozen-open");
	expect(result.data.resolved).toMatchObject({ asset_freeze: false, runbook: true, value_metric: true, rollback: true });
});

test("LAUNCHVERB1 planted: a missing runbook path is reported and never READY", async () => {
	const f = fixture();
	const result = await runMilestone(launch("demo", ["asset_freeze=frozen-closed", "runbook=docs/missing-planted.md", "value_metric=velocity", "rollback=rb"]), f.env);
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data.overall).toBe("NOT_READY");
	const issues = result.data.issues as { pin: string; fix: string }[];
	expect(issues.map(issue => issue.pin)).toContain("runbook");
	expect(issues.find(issue => issue.pin === "runbook")?.fix).toContain("docs/missing-planted.md");
	expect(result.data.overall).not.toBe("READY");
});
