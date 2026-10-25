import { describe, expect, test } from "bun:test";
import { changeSetAdapter, command, formatNext, next, NEXT_DATA_SCHEMA, type Adapters, type Observation, type Station } from "../../src/next.ts";
import type { RunResult } from "../../src/kitlib/run.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

const known = (value: unknown): Observation => ({ status: "KNOWN", source: "fixture snapshot", value });
function fixtures(values: Partial<Record<keyof Adapters, unknown>> = {}): Adapters {
	const defaults = { issues: [], cycles: [], blocked: [], ready: [{ id: "ready" }], triage: { triage: { quick_wins: [], recommendations: [] } }, git: { ahead: 0 }, changes: { paths: [], diffText: "" }, acks: [], scratch: { data: { sessions: [] } }, pulse: {}, sitrep: {} };
	const adapter = (name: keyof Adapters) => async () => known(name in values ? values[name] : defaults[name]);
	return { issues: adapter("issues"), cycles: adapter("cycles"), blocked: adapter("blocked"), ready: adapter("ready"), triage: adapter("triage"),
		git: adapter("git"), changes: adapter("changes"), acks: adapter("acks"), scratch: adapter("scratch"), pulse: adapter("pulse"), sitrep: adapter("sitrep") };
}
const rungs: Station[] = ["dag-repair", "finish", "grade", "rework", "claim", "research"];
function ladder(start: number) {
	const issues = [
		...(start <= 1 ? [{ id: "held", status: "in_progress", assignee: "Me" }] : []),
		...(start <= 2 ? [{ id: "review", status: "in_review", assignee: "Other" }] : []),
		...(start <= 3 ? [{ id: "rework", status: "open", assignee: "Me", labels: ["rework"] }] : []),
		...(start <= 4 ? [{ id: "ready", status: "open", assignee: null }] : []),
		{ id: "blocked", status: "blocked", priority: 0 },
	];
	return fixtures({ issues, cycles: start === 0 ? [{ path: ["a", "b", "a"] }] : [], blocked: [{ id: "blocked", dependencies: [{ id: "fix", dependency_type: "blocks", status: "open" }] }], triage: { triage: { quick_wins: [], recommendations: [{ id: "ready", action: "claim" }] } } });
}
function assertOrder(actions: { station: Station }[], expected: Station) {
	expect(actions[0]?.station).toBe(expected);
}

describe("worker pull order", () => {
	for (const [index, rung] of rungs.entries()) test(`${rung} wins over every lower rung`, async () => {
		const result = await next({ role: "worker", agent: "Me" }, ladder(index));
		if (result.code !== 0) throw Error("no actions");
		assertOrder(result.data.actions, rung);
		expect(result.commands).toEqual(result.data.next_action.commands);
	});
	test("planted wrong ordering is rejected in memory, original restored", async () => {
		const result = await next({ role: "worker", agent: "Me" }, ladder(0));
		if (result.code !== 0) throw Error("no actions");
		const original = result.data.actions;
		const wrong = [...original].reverse();
		expect(() => assertOrder(wrong, "dag-repair")).toThrow();
		assertOrder(original, "dag-repair");
	});
	test("explicit blocked without open dependency wins", async () => {
		const result = await next({ role: "worker", agent: "Me" }, fixtures({ issues: [{ id: "b", status: "blocked" }, { id: "h", status: "in_progress", assignee: "Me" }], blocked: [{ id: "b", dependencies: [{ dependency_type: "parent-child", status: "open" }, { dependency_type: "blocks", status: "closed" }] }] }));
		expect(result.data.next_action?.station).toBe("dag-repair");
	});
	test("never grades own review or unknown author", async () => {
		const result = await next({ role: "worker", agent: "Me" }, fixtures({ issues: [{ id: "mine", status: "in_review", assignee: "Me" }, { id: "authored", status: "in_review", assignee: "Other", owner: "Me" }, { id: "unknown", status: "in_review" }] }));
		expect(result.data.actions?.some(action => action.station === "grade")).toBe(false);
	});
	test("human gates and already assigned picks are not recommended for claim", async () => {
		const result = await next({ role: "worker", agent: "Me" }, fixtures({ issues: [{ id: "ready", status: "open", labels: ["human-gate"] }], triage: { triage: { quick_wins: [], recommendations: [{ id: "ready", action: "claim" }] } } }));
		expect(result.data.actions?.some(action => action.station === "claim")).toBe(false);
	});
});

test("all adapters absent: answered with UNKNOWN, git inspection only", async () => {
	const adapters = fixtures();
	for (const name of Object.keys(adapters) as (keyof Adapters)[]) adapters[name] = async () => ({ status: "UNKNOWN", value: null, source: name, reason: "absent" });
	const result = await next({ role: "worker", agent: "Me", repo: "/stock" }, adapters);
	expect(result.code).toBe(0);
	expect(Object.values(result.data.facts!).every(f => f.status === "UNKNOWN" && f.value === null)).toBe(true);
	expect(result.commands).toEqual(["git -C '/stock' status --short --branch"]);
});

test("stock git ahead recommends publishing", async () => {
	const result = await next({ role: "worker", repo: "/stock" }, fixtures({ git: { ahead: 3 } }));
	expect(result.data.next_action?.why).toContain("3 local commits");
	expect(result.commands).toEqual(["git -C '/stock' push origin main"]);
});

test("pending acks and owed scratch are ranked after pull work", async () => {
	const adapters = ladder(1);
	adapters.acks = async () => known([{ id: 1 }]);
	adapters.scratch = async () => known({ data: { sessions: [{ dir: "/owned" }] } });
	const result = await next({ role: "worker", agent: "Me" }, adapters);
	expect(result.data.actions?.map(a => a.station)).toEqual(["finish", "grade", "rework", "claim", "research", "inbox", "dispose"]);
});

for (const failure of ["absent", "timeout", "malformed"] as const) test(`bounded adapter ${failure} becomes UNKNOWN`, async () => {
	const adapter = command("fixture", () => [], JSON.parse, { which: () => failure === "absent" ? null : "/fixture", run: async (_argv, options) => {
		expect(options.deadline_s).toBe(10);
		return { rc: 0, timed_out: failure === "timeout", truncated: false, stdout: new TextEncoder().encode("not JSON"), stderr: new Uint8Array() } as RunResult;
	} });
	const result = await adapter({ repo: "/stock", agent: "Me" });
	expect(result.status).toBe("UNKNOWN");
	expect(result.value).toBe(null);
	if (result.status === "UNKNOWN") expect(result.reason).toContain(failure === "malformed" ? "malformed JSON" : failure);
});

test("malformed successful fixture is not interpreted as an empty healthy queue", async () => {
	const result = await next({ role: "worker" }, fixtures({ issues: { broken: true }, cycles: null }));
	expect(result.data.facts?.issues.status).toBe("UNKNOWN");
	expect(result.data.facts?.cycles.status).toBe("UNKNOWN");
});

test("director uses pulse findings without re-deriving holder or review age", async () => {
	const result = await next({ role: "director", agent: "Me" }, fixtures({ pulse: { blocked_no_fix: 2, stale_in_progress: 3, panes_idle: 1, ready: 4, review_queue_count: 2, review_queue_oldest_age_s: 90000 } }));
	expect(result.data.actions?.map(a => a.station)).toEqual(["dag-repair", "finish", "claim", "grade", "inbox"]);
	expect(result.data.actions?.find(a => a.station === "grade")?.why).toContain("90000");
});

test("invalid role exits usage before adapters execute", async () => {
	const adapters = fixtures();
	for (const name of Object.keys(adapters) as (keyof Adapters)[]) adapters[name] = async () => { throw Error("must not run"); };
	const result = await next({ role: "invalid" }, adapters);
	expect(result.code).toBe(2);
	expect(result.errors?.[0]?.code).toBe("INVALID_ROLE");
});

test("data keys are pinned and human output is one line per action", async () => {
	const result = await next({ role: "worker", agent: "Me" }, ladder(0));
	expect(Object.keys(result.data).sort()).toEqual(["actions", "adapters", "applicable_skills", "facts", "next_action", "role"]);
	expect([...NEXT_DATA_SCHEMA.required].sort()).toEqual(Object.keys(result.data).sort());
	if (result.code !== 0) throw Error("no actions");
	expect(formatNext(result.data).split("\n").length).toBe(result.data.actions.length);
	expect(formatNext(result.data).startsWith("NEXT dag-repair:")).toBe(true);
});

test("director without fleet tools returns stock git guidance", async () => {
	const adapters = fixtures();
	for (const name of Object.keys(adapters) as (keyof Adapters)[]) adapters[name] = async () => ({ status: "UNKNOWN", value: null, source: name, reason: "absent" });
	adapters.git = async () => known({ ahead: 2 });
	const result = await next({ role: "director", repo: "/stock" }, adapters);
	expect(result.code).toBe(0);
	expect(result.data.actions?.map(action => action.station)).toEqual(["publish"]);
	expect(result.commands).toEqual(["git -C '/stock' push origin main"]);
});

test("a ranked but native-blocked candidate cannot be recommended for claim", async () => {
	const result = await next({ role: "worker", agent: "Me" }, fixtures({
		issues: [{ id: "ready", status: "open" }], ready: [],
		triage: { triage: { quick_wins: [], recommendations: [{ id: "ready", action: "claim" }] } },
	}));
	expect(result.data.actions?.some(action => action.station === "claim")).toBe(false);
});

test("actual bounded git change set in --repo includes unpushed regex and staged bin, renders applicable_skills", async () => {
	const tmp = ownedTmp("next-skills-git");
	try {
		const git = async (...args: string[]) => {
			const result = await run(["git", "-c", "user.name=Skill Station Test", "-c", "user.email=skill-station@example.invalid", ...args],
				{ cwd: tmp.path, deadline_s: 10, grace_s: 0.2, max_output_bytes: 1024 * 1024 });
			if (result.rc !== 0 || result.timed_out || result.truncated) throw Error(new TextDecoder().decode(result.stderr));
		};
		await git("init", "--initial-branch=main");
		writeFileSync(join(tmp.path, "package.json"), '{"name":"test"}\n');
		await git("add", "package.json");
		await git("commit", "-m", "[pending] fixture baseline");
		await git("update-ref", "refs/remotes/origin/main", "HEAD");
		writeFileSync(join(tmp.path, "check.ts"), "const pattern = /^[a-z]+$/u;\n");
		await git("add", "check.ts");
		await git("commit", "-m", "[pending] fixture unpushed regex");
		writeFileSync(join(tmp.path, "package.json"), '{"name":"test","bin":{"test":"cli.js"}}\n');
		await git("add", "package.json");
		const adapters = fixtures();
		adapters.changes = changeSetAdapter();
		const result = await next({ role: "worker", repo: tmp.path }, adapters);
		if (result.code !== 0) throw Error("no guidance");
		expect(result.data.facts.changes.status).toBe("KNOWN");
		expect(result.data.applicable_skills.filter(row => row.mandatory).map(row => row.skill)).toEqual([
			"regex-engineering", "agent-ergonomics-and-intuitiveness-maximization-for-cli-tools",
		]);
		expect(formatNext(result.data)).toContain("skill regex-engineering [Execute, mandatory]");
		expect(result.warnings.some(warning => warning.startsWith("UNKNOWN Execute/performance-work-order-active:"))).toBe(true);
		// A dirty tracked file (not yet staged) is included by diff HEAD as well.
		writeFileSync(join(tmp.path, "package.json"), '{"name":"test","bin":"other-cli.js"}\n');
		const dirty = await changeSetAdapter()({ repo: tmp.path, agent: null });
		expect(dirty.status).toBe("KNOWN");
		if (dirty.status === "KNOWN") expect(JSON.stringify(dirty.value)).toContain("other-cli.js");
	} finally { tmp.cleanup(); }
});

test("missing git baseline leaves skill applicability UNKNOWN, not healthy empty", async () => {
	const adapters = fixtures();
	adapters.changes = async () => ({ status: "UNKNOWN", value: null, source: "git diff", reason: "change set incomplete: missing origin/main" });
	const result = await next({ role: "worker" }, adapters);
	expect(result.data.applicable_skills).toEqual([]);
	expect(result.warnings).toContain("changes: change set incomplete: missing origin/main");
});
