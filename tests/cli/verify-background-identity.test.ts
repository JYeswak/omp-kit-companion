import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fakeBr, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
jest.setTimeout(fixtureDeadlineS(60) * 1_000);

// The fixtures own their identity and attempt ledger instead of inheriting the
// caller's: without this, concurrent gate copies share $HOME/.local/state/omp-kit
// and the ledger's 1 s global lock contends, flaking CLOSED into ENVIRONMENT.
beforeAll(() => { installFixtureIdentity(); });
afterAll(() => { restoreFixtureIdentity(); });
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

const ACCEPTANCE = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail";
const AUTHOR = "AuthorA";
const PARENT = "ParentP";
const LABEL = "TaskL";
const SESSION = "sess-1";

function bead() {
	return { id: "kit-1", status: "in_review", assignee: AUTHOR, updated_at: "2026-11-20T00:00:00Z", labels: [], acceptance_criteria: ACCEPTANCE };
}

test("VERIFYBG1: a background verifier under its own label records PASS and closes; the verdict names the label, the recorder closes", async () => {
	const { dir, sha } = await repo("verifybg-pass");
	const br = fakeBr(bead());
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env: br.env, verifier: { label: LABEL, parent: PARENT, session: SESSION } });
	expect(res.code).toBe("CLOSED");
	expect(br.state("kit-1").status).toBe("closed");
	const acts = br.acts();
	expect(acts.some(a => a === `gate report kit-1 --gate min_reviewers --provider reviewer:${LABEL} --status pass --to closed --actor ${PARENT}`)).toBe(true);
	expect(acts.some(a => a.startsWith("close kit-1 ") && a.includes(`--actor ${PARENT}`))).toBe(true);
	expect(acts.some(a => a.includes(`verified by ${LABEL} `))).toBe(true);
});

test("VERIFYBG1 negative: label == author is refused and records nothing", async () => {
	const { dir, sha } = await repo("verifybg-author");
	const br = fakeBr(bead());
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env: br.env, verifier: { label: AUTHOR, parent: PARENT, session: SESSION } });
	expect(res.code).toBe("LABEL_IS_AUTHOR");
	expect(br.acts()).toEqual([]);
	expect(br.state("kit-1").status).toBe("in_review");
});

test("VERIFYBG1 negative: label == parent is refused and records nothing", async () => {
	const { dir, sha } = await repo("verifybg-parent");
	const br = fakeBr(bead());
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env: br.env, verifier: { label: PARENT, parent: PARENT, session: SESSION } });
	expect(res.code).toBe("LABEL_IS_PARENT");
	expect(br.acts()).toEqual([]);
	expect(br.state("kit-1").status).toBe("in_review");
});

test("VERIFYBG1 negative: missing session id is refused and records nothing", async () => {
	const { dir, sha } = await repo("verifybg-session");
	const br = fakeBr(bead());
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env: br.env, verifier: { label: LABEL, parent: PARENT, session: "  " } });
	expect(res.code).toBe("SESSION_REQUIRED");
	expect(br.acts()).toEqual([]);
	expect(br.state("kit-1").status).toBe("in_review");
});

test("VERIFYBG1 negative: inherited parent identity with no label is refused and records nothing", async () => {
	const { dir, sha } = await repo("verifybg-inherited");
	const br = fakeBr(bead());
	const env = { ...br.env, AGENT_NAME: PARENT };
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env, verifier: { label: "", parent: PARENT, session: SESSION } });
	expect(res.code).toBe("LABEL_REQUIRED");
	expect(br.acts()).toEqual([]);
	expect(br.state("kit-1").status).toBe("in_review");
});

test("VERIFYBG1-early-refusal: with no AGENT_NAME and a valid background label the verb reaches the tracker read", async () => {
	const { dir, sha } = await repo("verifybg-noseat");
	const br = fakeBr(bead());
	// The merged env inherits process.env, so dropping the key from the input
	// copy alone would not simulate a seatless caller: remove it from the
	// process env for the call and restore it after.
	const callerAgent = process.env.AGENT_NAME;
	delete process.env.AGENT_NAME;
	let res;
	try {
		res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: PARENT, env: br.env, verifier: { label: LABEL, parent: PARENT, session: SESSION } });
	} finally {
		if (callerAgent === undefined) delete process.env.AGENT_NAME; else process.env.AGENT_NAME = callerAgent;
	}
	expect(res.code).toBe("CLOSED");
	expect(br.state("kit-1").status).toBe("closed");
});

const LIVE = process.env.OMP_KIT_VERIFY_LIVE === "1";

test("VERIFYBG1-live: a real background-task-shaped CLI invocation verifies and closes under its label", async () => {
	if (!LIVE) return;
	const { dir, sha } = await repo("verifybg-live");
	const br = fakeBr(bead());
	const clean: Record<string, string> = { ...br.env };
	for (const key of ["BEADS_DIR", "BEADS_DB", "BEADS_JSONL", "BEADS_CACHE_DIR", "BD_DB", "BD_DATABASE", "BR_REAL", "BR_BIN", "BR_ACTOR", "BR_AGENT_NAME", "BR_OUTPUT_FORMAT"]) delete clean[key];
	// Truly seatless: spreading process.env would restore AGENT_NAME, so omit it.
	const { AGENT_NAME: _droppedSeat, ...unseated } = { ...process.env, ...clean };
	void _droppedSeat;
	const r = await run(["bun", cliPath, "verify", "kit-1", "--export", sha, "--verifier-label", LABEL, "--verifier-parent", PARENT, "--verifier-session", SESSION], { cwd: dir, deadline_s: fixtureDeadlineS(120), env: unseated as Record<string, string> });
	const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
	expect(r.rc).toBe(0);
	expect(out).toContain("CLOSED");
	expect(br.state("kit-1").status).toBe("closed");
});
