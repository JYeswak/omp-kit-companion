import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_READBACK_LABEL, verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { brun, createBead, installFixtureIdentity, repo, restoreFixtureIdentity, row, tracker, trackerEnv } from "./verify-fixture.ts";

beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const gradingRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-lane-portability", gradingRoot === undefined ? {} : { root: gradingRoot }).path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const BUILD_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

// The same native close policy as verify.test.ts: no forced close or synthetic tracker.
const CLOSE_POLICY = [
	"workflow:", "  strict: true", "  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]", "  transitions:",
	"    initial: [open]", "    open: [in_progress, blocked, deferred, closed]", "    in_progress: [in_review, open, blocked, deferred]",
	"    in_review: [closed, rework]", "    rework: [in_progress, in_review, open]", "    blocked: [open, in_progress]", "    deferred: [open]", "    closed: [open]",
	"  required_fields:", "    \"open -> in_progress\": [acceptance_criteria_present]", "    in_review: [acceptance_criteria_present, transition_comment]",
	"    closed: [acceptance_criteria, transition_comment]", "  gates:", "    \"in_review -> closed\":", "      require_all:", "        - min_reviewers: 1",
	"    \"open -> closed\":", "      require_all:", "        - min_reviewers: 1", "",
].join("\n");

test("VERIFYLANEPORT1: a foreign parentless bead retains related readback debt and executes its live phase", async () => {
	const marker = join(base, "parentless-live-observation");
	const code = await repo("parentless-readback", {
		"live.sh": "#!/bin/sh\nprintf observed > \"$VERIFYLANE_MARKER\"\nprintf 'readback observed\\n'\n",
	});
	const t = await tracker(base, "parentless-readback-t");
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), CLOSE_POLICY);
	const env = { ...trackerEnv(t), VERIFYLANE_MARKER: marker };
	const live = "- [ ] [c] [live] `sh scripts/live.sh` -> prints readback observed";
	const id = await createBead(t, "foreign parentless readback", [
		"--description", "WHAT: closepass fixture.\n\nWHY: proves verify closes done work under the real close policy.",
		"--acceptance-criteria", `${BUILD_BOXES}\n${live}`, "--assignee", "Author",
	]);
	for (const args of [
		["update", id, "--status", "in_progress", "--actor", "Author"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "Author"],
	]) {
		const result = await brun(args, t.dir, env);
		if (result.rc !== 0) throw new Error(`${args.slice(0, 3).join(" ")} -> ${result.rc}: ${result.out}`);
	}
	expect(id.startsWith("ompkit-")).toBe(false);
	const verified = await verifyBead({
		bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env,
		lesson: "parentless trackers retain live readback debt",
	});
	expect(verified.code, verified.log).toBe("CLOSED");
	expect(existsSync(marker)).toBe(false);
	const child = await row(t, verified.child!);
	expect(child.parent ?? null).toBeNull();
	expect(child).toMatchObject({ status: "open", acceptance_criteria: live, labels: [LIVE_READBACK_LABEL] });
	expect(child.dependencies).toContainEqual(expect.objectContaining({ id, dependency_type: "related" }));
	const readback = await run([
		"bun", "run", "--silent", cliPath, "verify", verified.child!, "--live-readback",
		"--project", code.dir, "--actor", "Peer", "--lesson", "parentless live readback", "--json",
	], { cwd: code.dir, deadline_s: fixtureDeadlineS(30), env });
	const result = JSON.parse(new TextDecoder().decode(readback.stdout));
	expect(readback.rc, new TextDecoder().decode(readback.stderr)).toBe(0);
	expect(result.data.overall).toBe("CLOSED");
	expect(readFileSync(marker, "utf8")).toBe("observed");
	expect(await row(t, verified.child!)).toMatchObject({
		status: "closed", acceptance_criteria: live.replace("- [ ]", "- [x]"),
	});
	expect((await row(t, id)).status).toBe("closed");
}, fixtureDeadlineS(120) * 1_000);
