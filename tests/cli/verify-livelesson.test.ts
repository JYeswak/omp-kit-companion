import { afterAll, beforeAll, expect, test } from "bun:test";
import { LIVE_READBACK_LABEL, liveReadback } from "../../src/verify.ts";
import { fakeBr, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

// The readback child is created by verify, so its author is the verifier; the verified bead is its one related link.
const sourceBead = { id: "kit-source", status: "closed", assignee: "Author", labels: [], acceptance_criteria: "" };
const liveBead = (acceptance: string) => ({ id: "kit-live", status: "open", assignee: "ReadbackAuthor", updated_at: "2026-01-01T00:00:00Z",
	labels: [LIVE_READBACK_LABEL], acceptance_criteria: acceptance, dependencies: [{ id: "kit-source", dependency_type: "related" }] });

test("LIVELESSON1 a readback child with no lesson of its own closes with the verified bead's author lesson", async () => {
	const { dir } = await repo("livelesson-parent");
	const acceptance = "- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail";
	// Only the verified bead's author (Author) wrote a Lesson:; the child's author (ReadbackAuthor) wrote none.
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead],
		comments: [{ id: 7, author: "Author", text: "Lesson: the source author's lesson", created_at: "2026-01-02T00:00:00Z" }] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(br.state().closed_transition).toContain("Lesson: the source author's lesson");
}, fixtureDeadlineS(30) * 1000);

test("LIVELESSON1 planted: with no lesson on either bead the readback still refuses LESSON_MISSING before replay", async () => {
	const { dir } = await repo("livelesson-none");
	const br = fakeBr(liveBead("- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail"), { extraBeads: [sourceBead], comments: [] });
	const before = br.state();
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("LESSON_MISSING");
	expect(res.replays).toEqual([]);
	expect(br.state()).toEqual(before);
}, fixtureDeadlineS(30) * 1000);
