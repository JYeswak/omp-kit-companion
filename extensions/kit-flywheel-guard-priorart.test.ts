import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFlywheelHost, toolCall, type ExecCall } from "../tests/fleet-guard/kit-flywheel-host.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "../tests/cli/fixture-process.ts";
import { configuredDecisionsDir, parseBrCreates, priorArtForTitle, priorArtKeywords } from "./prior-art";

// PRIORART2: admitted claims and creates carry prior art (decisions, tracker,
// deleted work) that reads like the decision at hand. Never blocks.

const base = ownedTmp("kit-flywheel-guard-priorart").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

let seq = 0;
function project(): string {
	const dir = join(base, `proj-${process.pid}-${++seq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const CLAIM_TITLE = "rerun only the failing suite files once and record flake culprit";

function writeIssues(dir: string): void {
	mkdirSync(join(dir, ".beads"), { recursive: true });
	const rows = [
		{ id: "RELFAST1", title: "Rerun failing suite files to catch the flake culprit", status: "open", assignee: null },
		{ id: "RELEASEDIET1", title: "Record failing files for the release diet", status: "closed", assignee: "RobinLeopard" },
		{ id: "OTHER-1", title: "Water the office plants weekly", status: "open", assignee: null },
	];
	writeFileSync(join(dir, ".beads", "issues.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

function writeDecisions(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "chat.jsonl"), JSON.stringify({
		id: "J-2026-11-07-08",
		text: "no kit machinery for reruns: record failing files instead of whole-suite reruns; the culprit pattern needs a second look",
	}) + "\n");
}

/** `br show <id>` answers from issues.jsonl; `br list` reports no held beads. */
const brResponder = (root: string) => async (call: ExecCall) => {
	if (call.command === "git") {
		const ran = await runFixtureAsync([call.command, ...call.args], { cwd: call.options?.cwd ?? root, env: process.env as Record<string, string>, floor_s: fixtureDeadlineS() });
		const decoder = new TextDecoder();
		return { stdout: decoder.decode(ran.stdout), stderr: decoder.decode(ran.stderr), code: ran.rc ?? 1 };
	}
	if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
	if (call.args[0] === "show") {
		const text = readFileSync(join(root, ".beads", "issues.jsonl"), "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const row = JSON.parse(line) as { id?: unknown; title?: unknown };
			if (row.id === call.args[1]) return { stdout: JSON.stringify([row]), stderr: "", code: 0 };
		}
		return { stdout: JSON.stringify({ error: { message: "Issue not found" } }), stderr: "", code: 3 };
	}
	if (call.args[0] === "list") return { stdout: JSON.stringify({ issues: [] }), stderr: "", code: 0 };
	throw new Error(`unexpected command: ${call.command} ${call.args.join(" ")}`);
};

async function gitFixture(dir: string, message: string, file: string): Promise<void> {
	const env = { ...process.env as Record<string, string>, GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const run = (args: string[]) => runFixtureAsync(["git", ...args], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect((await run(["init", "-q"])).rc).toBe(0);
	expect((await run(["config", "user.email", "test@example.com"])).rc).toBe(0);
	expect((await run(["config", "user.name", "Test"])).rc).toBe(0);
	writeFileSync(join(dir, file), "fixture\n");
	expect((await run(["add", "."])).rc).toBe(0);
	const committed = await run(["commit", "-qm", message]);
	expect(committed.rc, committed.stderr).toBe(0);
}

test("PRIORART2 planted: claiming the flake-rerun bead names RELFAST1, J-2026-11-07-08 and the delete commit", async () => {
	const dir = project();
	writeIssues(dir);
	const decisions = join(dir, "decisions");
	writeDecisions(decisions);
	await gitFixture(dir, "refactor(release): delete failure culprit bisection", "close.ts");
	const h = await createFlywheelHost(base, { env: { OMP_KIT_DECISIONS_DIR: decisions } as Record<string, string>, respond: brResponder(dir) });
	const result = await toolCall(h, dir, `br update RELFAST1 --claim --actor PeachLeopard`);
	expect(result?.block).not.toBe(true);
	const context = result?.additionalContext ?? "";
	expect(context).toContain("PRIOR ART for");
	expect(context).toContain("RELFAST1");
	expect(context).toContain("J-2026-11-07-08");
	expect(context).toContain("delete failure culprit bisection");
	expect(context).toContain("RELEASEDIET1");
	expect(context).not.toContain("OTHER-1");
}, fixtureDeadlineS(60) * 1000);

test("PRIORART2 planted: creating the flake-rerun bead names the same prior art", async () => {
	const dir = project();
	writeIssues(dir);
	const decisions = join(dir, "decisions");
	writeDecisions(decisions);
	await gitFixture(dir, "refactor(release): delete failure culprit bisection", "close.ts");
	const h = await createFlywheelHost(base, { env: { OMP_KIT_DECISIONS_DIR: decisions } as Record<string, string>, respond: brResponder(dir) });
	const result = await toolCall(h, dir, `br create --title '${CLAIM_TITLE}' -t task`);
	expect(result?.block).not.toBe(true);
	const context = result?.additionalContext ?? "";
	expect(context).toContain("PRIOR ART for");
	expect(context).toContain("RELFAST1");
	expect(context).toContain("J-2026-11-07-08");
	expect(context).toContain("delete failure culprit bisection");
}, fixtureDeadlineS(60) * 1000);

test("PRIORART2 planted: an unrelated title gets no matches listed, and admits", async () => {
	const dir = project();
	writeIssues(dir);
	const decisions = join(dir, "decisions");
	writeDecisions(decisions);
	await gitFixture(dir, "refactor(release): delete failure culprit bisection", "close.ts");
	const h = await createFlywheelHost(base, { env: { OMP_KIT_DECISIONS_DIR: decisions } as Record<string, string>, respond: brResponder(dir) });
	const result = await toolCall(h, dir, `br update OTHER-1 --claim --actor PeachLeopard`);
	expect(result?.block).not.toBe(true);
	const context = result?.additionalContext ?? "";
	expect(context).toContain("PRIOR ART for Water the office plants weekly");
	expect(context).not.toContain("RELFAST1");
	expect(context).not.toContain("J-2026-11-07-08");
	expect(context).not.toContain("delete failure culprit");
}, fixtureDeadlineS(60) * 1000);

test("PRIORART2 planted: a missing decisions dir still admits with prior art unavailable", async () => {
	const dir = project();
	writeIssues(dir);
	await gitFixture(dir, "refactor(release): delete failure culprit bisection", "close.ts");
	const h = await createFlywheelHost(base, { env: { OMP_KIT_DECISIONS_DIR: join(dir, "no-such-decisions") } as Record<string, string>, respond: brResponder(dir) });
	const result = await toolCall(h, dir, `br update RELFAST1 --claim --actor PeachLeopard`);
	expect(result?.block).not.toBe(true);
	const context = result?.additionalContext ?? "";
	expect(context).toContain("prior art unavailable");
	expect(context).toContain("RELFAST1");
}, fixtureDeadlineS(60) * 1000);

test("PRIORART2 unit: keywords drop stopwords and short words but keep codenames; br create titles parse quoted", () => {
	const keywords = { words: ["rerun", "failing", "suite", "files", "record", "flake", "culprit"], codes: [] as string[] };
	expect(priorArtKeywords(CLAIM_TITLE)).toEqual(keywords);
	expect(priorArtKeywords("RELFAST1 follow-up")).toEqual({ words: ["follow"], codes: ["RELFAST1"] });
	expect(parseBrCreates(`br create --title '${CLAIM_TITLE}' -t task`)).toEqual([CLAIM_TITLE]);
	expect(parseBrCreates(`br --db /x/beads.db create --title="${CLAIM_TITLE}" --json`)).toEqual([CLAIM_TITLE]);
	expect(parseBrCreates("br list --status open")).toEqual([]);
	expect(parseBrCreates("not-a-br-command")).toEqual([]);
});

test("PRIORART2 planted: the newest decision at the end of a register larger than the read cap is found; non-decision logs are not decisions", async () => {
	const dir = project();
	const decisions = join(dir, "decisions");
	mkdirSync(decisions, { recursive: true });
	// 400 KB of older, unrelated decisions ahead of the matching one: a head read would never reach it.
	const filler = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ id: `J-2026-10-01-${i + 1}`, rule: `water the office plants on rota ${i} ${"x".repeat(160)}` }));
	const newest = JSON.stringify({ id: "J-2026-11-10-04", rule: "a release rerun of the failing suite files records a flake culprit instead of blocking" });
	writeFileSync(join(decisions, "joshua.jsonl"), [...filler, newest].join("\n") + "\n");
	writeFileSync(join(decisions, "prompt-reviews.jsonl"), JSON.stringify({ id: "review-9", text: "rerun failing suite files flake culprit" }) + "\n");
	const art = await priorArtForTitle(CLAIM_TITLE, dir, { exec: async () => ({ stdout: "", stderr: "", code: 1 }), env: { OMP_KIT_DECISIONS_DIR: decisions }, home: dir }, { deadlineMs: 5000 });
	expect(art).toContain("J-2026-11-10-04");
	expect(art).not.toContain("review-9");
});

test("PRIORART2 planted: with no env and no prior-art.json the decisions source says not configured; the config file names the register", async () => {
	const dir = project();
	const config = join(dir, "config");
	const exec = async () => ({ stdout: "", stderr: "", code: 1 });
	const unset = await priorArtForTitle(CLAIM_TITLE, dir, { exec, env: { XDG_CONFIG_HOME: config }, home: dir }, { deadlineMs: 5000 });
	expect(unset).toContain("decisions not configured");
	const decisions = join(dir, "register");
	mkdirSync(decisions, { recursive: true });
	writeFileSync(join(decisions, "joshua.jsonl"), JSON.stringify({ id: "J-2026-11-10-04", rule: "rerun the failing suite files once and record the flake culprit" }) + "\n");
	mkdirSync(join(config, "omp-kit"), { recursive: true });
	writeFileSync(join(config, "omp-kit", "prior-art.json"), JSON.stringify({ decisionsDir: decisions }));
	expect(configuredDecisionsDir({ XDG_CONFIG_HOME: config }, dir)).toBe(decisions);
	const configured = await priorArtForTitle(CLAIM_TITLE, dir, { exec, env: { XDG_CONFIG_HOME: config }, home: dir }, { deadlineMs: 5000 });
	expect(configured).toContain("J-2026-11-10-04");
});
