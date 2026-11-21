import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { join } from "node:path";
import { verifyBead } from "../../src/verify.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

// SELFREPLAY1 (ompkit-1elej): the assignee replays their own boxes on the exact published export before handover.
// This bounds fixture Git initialization/publication and verification subprocesses, not a product latency contract.
jest.setTimeout(fixtureDeadlineS(15) * 1_000);
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const markerRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-self-replay", markerRoot === undefined ? {} : { root: markerRoot }).path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const inProgress = (acceptance: string) => ({ ...inReview(acceptance), status: "in_progress" });
const PASSING = "- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail";
const TWO_BOXES = [PASSING, "- [ ] [b] [landed] `sh scripts/bad.sh` -> selftest: PASS"].join("\n");

interface VerifyData { overall: string; replays: { letter: string; pass: boolean | null }[] }

/** The `data` object of a verify --json result, narrowed at runtime; null when the output is not a verify result. */
function verifyData(output: string): VerifyData | null {
	try {
		const doc: unknown = JSON.parse(output);
		if (doc === null || typeof doc !== "object" || !("data" in doc)) return null;
		const data = doc.data;
		if (data === null || typeof data !== "object" || !("overall" in data) || !("replays" in data) || !Array.isArray(data.replays)) return null;
		return { overall: String(data.overall), replays: data.replays.map((r: { letter: string; pass: boolean | null }) => ({ letter: r.letter, pass: r.pass })) };
	} catch {
		return null;
	}
}

async function cli(args: string[], env: Record<string, string>, dir: string) {
	const r = await run(["bun", "run", "--silent", cliPath, "verify", ...args, "--project", dir, "--json"], { cwd: base, deadline_s: fixtureDeadlineS(15), env: { ...process.env, ...env } });
	const stdout = new TextDecoder().decode(r.stdout);
	return { rc: r.rc, stdout, data: verifyData(stdout) };
}

test("SELFREPLAY1: the assignee replays an in_progress bead with no Lesson, writes nothing, and gets the box verdicts", async () => {
	const { dir, sha } = await repo("selfreplay-pass");
	const br = fakeBr(inProgress(PASSING));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Author", env: br.env, selfReplay: true });
	expect(res.code).toBe("SELF_REPLAY");
	expect(res.ok).toBe(true);
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.acts).toEqual([]);
	expect(br.acts().filter(a => /\b(close|update|gate|comments)\b/.test(a))).toEqual([]);
	expect(res.verificationEvidence?.status).toBe("NOT_RECORDED");
	expect(res.log).toContain("self-replay");
});

test("SELFREPLAY1 planted: a failing box is reported and the CLI exits 1, with the bead untouched", async () => {
	const { dir, sha } = await repo("selfreplay-fail");
	const br = fakeBr(inProgress(TWO_BOXES));
	const r = await cli(["kit-1", "--export", sha, "--actor", "Author", "--self-replay"], br.env, dir);
	expect(r.rc).toBe(1);
	expect(r.data?.overall).toBe("SELF_REPLAY");
	expect(r.data?.replays.map(x => [x.letter, x.pass])).toEqual([["a", true], ["b", false]]);
	expect(br.acts().filter(a => /\b(close|update|gate|comments)\b/.test(a))).toEqual([]);
	expect(br.state().status).toBe("in_progress");
});

test("SELFREPLAY1: a passing replay exits 0 and still closes nothing", async () => {
	const { dir, sha } = await repo("selfreplay-cli-pass");
	const br = fakeBr(inProgress(PASSING));
	const r = await cli(["kit-1", "--export", sha, "--actor", "Author", "--self-replay"], br.env, dir);
	expect(r.rc).toBe(0);
	expect(r.data?.overall).toBe("SELF_REPLAY");
	expect(br.state().status).toBe("in_progress");
});

test("SELFREPLAY1 planted: someone who is not the assignee is refused AUTHOR_REQUIRED and nothing runs", async () => {
	const { dir, sha } = await repo("selfreplay-peer");
	const br = fakeBr(inProgress(PASSING));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, selfReplay: true });
	expect(res.code).toBe("AUTHOR_REQUIRED");
	expect(res.ok).toBe(false);
	expect(res.replays).toEqual([]);
	expect(res.log).toContain("Peer");
});

test("SELFREPLAY1: plain verify of the same in_progress bead by the author is still refused (self-replay is not a back door to close)", async () => {
	const { dir, sha } = await repo("selfreplay-no-close");
	const br = fakeBr(inProgress(PASSING));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Author", env: br.env });
	expect(res.code).toBe("NON_AUTHOR_REQUIRED");
	expect(br.acts().filter(a => /\bclose\b/.test(a))).toEqual([]);
});

test("SELFREPLAY1: --self-replay does not combine with --dry-run or --live-readback", async () => {
	const { dir, sha } = await repo("selfreplay-flags");
	const br = fakeBr(inProgress(PASSING));
	for (const extra of [["--dry-run"], ["--live-readback"]]) {
		const r = await cli(["kit-1", "--export", sha, "--actor", "Author", "--self-replay", ...extra], br.env, dir);
		expect(r.rc).not.toBe(0);
		expect(r.stdout).toContain("INVALID_FLAG");
	}
});
