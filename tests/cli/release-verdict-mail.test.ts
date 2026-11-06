import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import kitGoalKeepalive, { type GoalKeepaliveContext } from "../../extensions/kit-goal-keepalive.ts";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);
const ROOT = resolve(import.meta.dir, "../..");
const base = ownedTmp("release-verdict-mail-test").path;
let index = 0;

type Mail = { name: string; arguments: { to: string[]; subject: string; body_md: string; ack_required: boolean } };

async function fixture() {
	const repo = join(base, `repo-${++index}`);
	mkdirSync(join(repo, "scripts"), { recursive: true });
	for (const name of ["release-verdict.sh", "kitlib-tmp.sh", "kitlib-shimpath.sh", "fixed-env.sh"]) { // FIXEDENV1: release-verdict sources its pinned policy
		copyFileSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
	}
	// The test runs the canonical notifier, not a mocked mail command or am CLI.
	symlinkSync(join(ROOT, "src"), join(repo, "src"));
	symlinkSync(join(ROOT, "scripts/release-verdict-mail.ts"), join(repo, "scripts/release-verdict-mail.ts"));
	writeFileSync(join(repo, "scripts/full-suite-verdict.sh"), '#!/bin/sh\nprintf "fixture verdict recorded\\n"\nexit "${RV_RC:-0}"\n');
	writeFileSync(join(repo, "scripts/full-suite-verdict-store.py"), '# "run-ci-only"\nimport os\nprint("fixture ci-only verdict recorded")\nraise SystemExit(int(os.environ.get("RV_CI_RC", "0")))\n');
	for (const args of [["init", "-q", "--template=", "-b", "main"], ["add", "--", "scripts/full-suite-verdict.sh", "scripts/full-suite-verdict-store.py"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
		const result = await run(["git", ...args], { cwd: repo, deadline_s: fixtureDeadlineS(15) });
		expect(result.rc).toBe(0);
	}
	const head = await run(["git", "rev-parse", "HEAD"], { cwd: repo, deadline_s: fixtureDeadlineS(15) });
	const sha = new TextDecoder().decode(head.stdout).trim();
	const calls: Mail[] = [];
	let failMail = false;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const rpc = await request.json() as { params: Mail };
		calls.push(rpc.params);
		return failMail ? new Response("unavailable", { status: 503 })
			: Response.json({ jsonrpc: "2.0", result: { structuredContent: { count: 1 } } });
	} });
	const subscribe = async (agent: string, heads: string[]) => {
		const handlers = new Map<string, (event: never, ctx: GoalKeepaliveContext) => unknown>();
		await kitGoalKeepalive({ on: (name, handler) => { handlers.set(name, handler); }, sendMessage() {}, appendEntry() {} }, {
			env: { AGENT_NAME: agent }, cwd: repo, preflightBlocked: false,
		});
		const ctx: GoalKeepaliveContext = { cwd: repo, setTimeout: () => 1, clearTimer() {}, sessionManager: { getBranch: () => [
			{ type: "custom", customType: "user_todo_edit", data: { phases: [{ tasks: heads.map(head => ({ status: "blocked", blocker: `release verdict ${head}` })) }] } },
		] } };
		handlers.get("goal_updated")?.({ goal: { status: "active" }, state: { enabled: true } } as never, ctx);
		handlers.get("agent_end")?.({ messages: [] } as never, ctx);
		return () => handlers.get("session_stop")?.(undefined as never, ctx);
	};
	const judge = (producer = 0, ciOnly = 0) => run(["sh", "scripts/release-verdict.sh", "--commit", sha, "--no-fetch"], {
		cwd: repo, deadline_s: fixtureDeadlineS(45),
		env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "BEADS_DIR" && entry[0] !== "BEADS_DB")),
			TMPDIR: base, AGENT_NAME: "FixtureWriter", AGENTMAIL_HTTP_BEARER_TOKEN: "fixture-only", AGENT_MAIL_SENDER_TOKEN: "fixture-only",
			AGENTMAIL_HTTP_URL: `http://127.0.0.1:${server.port}/api`, RV_RC: String(producer), RV_CI_RC: String(ciOnly) },
	});
	return { sha, calls, subscribe, judge, fail: () => { failMail = true; }, close: () => server.stop(true) };
}

test("recording both verdicts sends exactly one message per subscribed seat, not another head; repeat settle and rerun do not duplicate", async () => {
	const f = await fixture();
	try {
		await f.subscribe("FixtureOne", [f.sha, f.sha.slice(0, 10)]);
		await f.subscribe("FixtureOne", [f.sha]);
		await f.subscribe("FixtureTwo", [f.sha.slice(0, 12)]);
		await f.subscribe("FixtureOther", ["0".repeat(40)]); // planted negative paired with two matching seats
		const result = await f.judge();
		expect(result.rc).toBe(0);
		expect(f.calls.map(call => call.arguments.to).sort()).toEqual([["FixtureOne"], ["FixtureTwo"]]);
		for (const call of f.calls) {
			expect(call.name).toBe("send_message");
			expect(call.arguments.subject).toBe(`PROGRESS release verdict ${f.sha} PASS`);
			expect(call.arguments.body_md).toContain("producer_rc=0 ci_only_rc=0");
			expect(call.arguments.ack_required).toBe(false);
		}
		expect((await f.judge()).rc).toBe(0);
		expect(f.calls).toHaveLength(2);
	} finally { f.close(); }
});

test("no subscriber or an ended wait sends nothing", async () => {
	const f = await fixture();
	try {
		expect((await f.judge()).rc).toBe(0);
		expect(f.calls).toEqual([]);
		const stop = await f.subscribe("FixtureOne", [f.sha]);
		stop();
		expect((await f.judge()).rc).toBe(0);
		expect(f.calls).toEqual([]);
	} finally { f.close(); }
});

test("ci-only FAIL is mailed after both statuses; failed mail never changes PASS or FAIL", async () => {
	const f = await fixture();
	try {
		await f.subscribe("FixtureOne", [f.sha]);
		const failedVerdict = await f.judge(0, 7);
		expect(failedVerdict.rc).toBe(7);
		expect(f.calls[0]?.arguments.subject).toBe(`PROGRESS release verdict ${f.sha} FAIL`);
		expect(f.calls[0]?.arguments.body_md).toContain("producer_rc=0 ci_only_rc=7");
		f.fail();
		for (const rc of [0, 3]) {
			await f.subscribe("FixtureOne", [f.sha]);
			const result = await f.judge(rc);
			expect(result.rc).toBe(rc);
			expect(new TextDecoder().decode(result.stderr)).toContain("release-verdict: mail wake failed");
		}
	} finally { f.close(); }
});
