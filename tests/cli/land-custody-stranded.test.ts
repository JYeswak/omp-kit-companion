 // Affected-test source dependencies: src/land.ts, src/converge.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { LAND_DEFAULT_TIMEOUT_MS, command, expectLandSchema, fixture, git, registerPushCheck, remoteHead, responseCode, scratch } from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

// LANDSTRANDED1 (ompkit-1ra0d.220): a custody lapse after the local commit used
// to refuse LAND_CUSTODY_EXPIRED with "nothing was published" and no mention of
// the saved commit, and the retry refused LAND_NO_CHANGES because the worktree
// already matched HEAD. The commit sat stranded on shared local main.

const STRANDED_MESSAGE = "feat(land): publish reserved fixture [test]\n\nBead: ompkit-1ra0d.220";

function strandedArgs(): string[] {
	return ["--paths", "owned.txt", "--message", STRANDED_MESSAGE, "--apply", "--yes"];
}

const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];

/** The seat's Board hold is listed for the first two reads only: custody lapses between land's pre-commit
 * checks and its post-commit qualification, stranding the local commit. */
const lapsing = [{ ...hold[0], reads: 2 }];

test("LANDSTRANDED1 custody lapse after commit reports the stranded commit and the retry publishes it", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "base owned\nstranded change\n");
	const first = command(work, strandedArgs(), lapsing, { amDir: fakeBin });
	expect(first.status, JSON.stringify(first.body)).toBe(1);
	expect(responseCode(first.body)).toBe("LAND_CUSTODY_EXPIRED");
	const firstData = first.body.data as Record<string, unknown>;
	expectLandSchema(firstData);
	const stranded = firstData.stranded_commit;
	expect(typeof stranded).toBe("string");
	expect(String(stranded)).toMatch(/^[0-9a-f]{40}$/);
	expect(firstData.commit).toBe(stranded);
	expect(firstData.candidate_sha).toBe(stranded);
	expect(firstData.pushed_sha).toBeNull();
	const [error] = first.body.errors as { message: string; remediation: string }[];
	expect(error.message).toContain(`saved on local main`);
	expect(error.message).toContain(String(stranded));
	expect(error.remediation).toContain(`omp-kit land --paths owned.txt`);
	expect(error.remediation).toContain("Reacquire the exact exclusive reservations");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(stranded);
	expect(remoteHead(work)).toBe(base);
	// The retry re-reserves the same paths and publishes the saved commit itself.
	const second = command(work, strandedArgs(), hold, { amDir: fakeBin });
	expect(second.status, JSON.stringify(second.body)).toBe(0);
	const secondData = second.body.data as Record<string, unknown>;
	expectLandSchema(secondData);
	expect(secondData.overall).toBe("PUSHED");
	expect(secondData.commit).toBe(stranded);
	expect(secondData.candidate_sha).toBe(stranded);
	expect(secondData.pushed_sha).toBe(stranded);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(stranded);
	expect(remoteHead(work)).toBe(stranded);
}, Math.round(fixtureDeadlineS(150) * 1000));

test("LANDSTRANDED1 planted: a lapse before commit leaves no commit and reports none", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "base owned\nunlandable change\n");
	const run = command(work, strandedArgs(), [], { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	const data = run.body.data as Record<string, unknown>;
	expect((data.stranded_commit ?? null)).toBeNull();
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(remoteHead(work)).toBe(base);
});

test("LANDSTRANDED1 a tip touching unreserved paths is never adopted", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "stranded owned\n");
	writeFileSync(join(work, "peer.txt"), "stranded peer\n");
	git(work, ["add", "owned.txt", "peer.txt"]);
	git(work, ["commit", "-m", "foreign tip [test]\n\nBead: ompkit-1ra0d.220"]);
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(tip).not.toBe(base);
	const run = command(work, strandedArgs(), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_NO_CHANGES");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(tip);
	expect(remoteHead(work)).toBe(base);
});

test("LANDSTRANDED1 a multi-commit range ahead of origin is never adopted", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "stranded one\n");
	git(work, ["add", "owned.txt"]);
	git(work, ["commit", "-m", "stranded one [test]\n\nBead: ompkit-1ra0d.220"]);
	writeFileSync(join(work, "owned.txt"), "stranded two\n");
	git(work, ["add", "owned.txt"]);
	git(work, ["commit", "-m", "stranded two [test]\n\nBead: ompkit-1ra0d.220"]);
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(tip).not.toBe(base);
	const run = command(work, strandedArgs(), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_NO_CHANGES");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(tip);
	expect(remoteHead(work)).toBe(base);
});
 
 // LANDSAVED1 (ompkit-1ra0d.170): an already-saved owned tip C ahead of origin
 // resumes through the stranded-tip retry path instead of committing again. A
 // failing registered check refuses publication and preserves C plus every
 // peer staged and worktree byte; a passing check publishes exactly C
 // (candidate_sha = checked_sha = pushed_sha, no extra commit). Movement
 // between check and push — local main advancing, or origin advancing — either
 // refuses one-shot or judges the newly resolved candidate; the stale
 // candidate never publishes and the check never reruns unchecked.
 
 const SAVED_MESSAGE = "feat(land): publish saved fixture [test]\n\nBead: ompkit-1ra0d.170";
 
 function savedArgs(): string[] {
 	return ["--paths", "owned.txt", "--message", SAVED_MESSAGE, "--apply", "--yes"];
 }
 
 /** Commit exactly owned.txt on top of the fixture base with the stranded-tip trailer. */
 function savedTip(work: string, content: string): string {
 	writeFileSync(join(work, "owned.txt"), content);
 	git(work, ["add", "--", "owned.txt"]);
 	git(work, ["commit", "-m", SAVED_MESSAGE]);
 	return git(work, ["rev-parse", "HEAD"]).trim();
 }
 
 /** Stage one peer change and leave a further peer change dirty in the worktree. */
 function peerStagedAndDirty(work: string): { staged: string; dirty: string } {
 	const staged = "peer staged change\n";
 	const dirty = "peer dirty change\n";
 	writeFileSync(join(work, "peer.txt"), `peer baseline\n${staged}`);
 	git(work, ["add", "--", "peer.txt"]);
 	writeFileSync(join(work, "peer.txt"), `peer baseline\n${staged}${dirty}`);
 	return { staged, dirty };
 }
 
 function peerBytesIntact(work: string, parts: { staged: string; dirty: string }): void {
 	expect(git(work, ["diff", "--cached", "--name-only"]).split("\n")).toContain("peer.txt");
 	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe(`peer baseline\n${parts.staged}${parts.dirty}`);
 }
 
 test("LANDSAVED1 saved tip with failing check refuses and preserves C and peer bytes", () => {
 	const { work, fakeBin } = fixture();
 	registerPushCheck(work, "#!/bin/sh\nset -eu\nexit 1\n");
 	const base = remoteHead(work);
 	const tip = savedTip(work, "base owned\nsaved change\n");
 	expect(tip).not.toBe(base);
 	const peer = peerStagedAndDirty(work);
 	const run = command(work, savedArgs(), hold, { amDir: fakeBin });
 	expect(run.status, JSON.stringify(run.body)).toBe(1);
 	expect(responseCode(run.body)).toBe("LAND_CHECK_FAILED");
 	const data = run.body.data as Record<string, unknown>;
 	expectLandSchema(data);
 	expect(data.commit).toBe(tip);
 	expect(data.candidate_sha).toBe(tip);
 	expect(data.pushed_sha).toBeNull();
 	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(tip);
 	expect(remoteHead(work)).toBe(base);
 	expect(git(work, ["rev-list", "--count", `${base}..HEAD`]).trim()).toBe("1");
 	peerBytesIntact(work, peer);
 }, Math.round(fixtureDeadlineS(90) * 1000));
 
 test("LANDSAVED1 saved tip with passing check publishes exactly the checked tip", () => {
 	const { work, fakeBin } = fixture();
 	registerPushCheck(work, "#!/bin/sh\nset -eu\nexit 0\n");
 	const base = remoteHead(work);
 	const tip = savedTip(work, "base owned\nsaved change\n");
 	const peer = peerStagedAndDirty(work);
 	const run = command(work, savedArgs(), hold, { amDir: fakeBin });
 	expect(run.status, JSON.stringify(run.body)).toBe(0);
 	const data = run.body.data as Record<string, unknown>;
 	expectLandSchema(data);
 	expect(data.overall).toBe("PUSHED");
 	expect(data.commit).toBe(tip);
 	expect(data.candidate_sha).toBe(tip);
 	expect(data.pushed_sha).toBe(tip);
 	expect((data.check as Record<string, unknown>).checked_sha).toBe(tip);
 	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(tip);
 	expect(remoteHead(work)).toBe(tip);
 	expect(git(work, ["rev-list", "--count", `${base}..HEAD`]).trim()).toBe("1");
 	peerBytesIntact(work, peer);
 }, Math.round(fixtureDeadlineS(90) * 1000));
 
 test("LANDSAVED1 local advance during the check refuses without publishing the stale tip", () => {
 	const { work, fakeBin } = fixture();
 	const marker = join(scratch, `saved-marker-${globalThis.fixtureNumber++}.txt`);
 	registerPushCheck(work, `#!/bin/sh
 set -eu
 R="\${OMP_LAND_REPOSITORY:?}"
 printf 'check\n' >> "\${LAND_TEST_MARKER:?}"
 printf 'owned advance during check\n' >> "$R/owned.txt"
 git -C "$R" -c user.name=LAND1test -c user.email=land1@example.invalid add -- owned.txt
 git -C "$R" -c user.name=LAND1test -c user.email=land1@example.invalid commit -q --only -m "local advance during check [test]" -- owned.txt
 exit 0
 `);
 	const base = remoteHead(work);
 	const tip = savedTip(work, "base owned\nsaved change\n");
 	const peer = peerStagedAndDirty(work);
 	const run = command(work, savedArgs(), hold, { amDir: fakeBin, gitEnv: { LAND_TEST_MARKER: marker } });
 	expect(run.status, JSON.stringify(run.body)).toBe(1);
 	expect(responseCode(run.body)).toBe("LAND_LOCAL_REF_MOVED");
 	const data = run.body.data as Record<string, unknown>;
 	expectLandSchema(data);
 	expect(data.candidate_sha).toBe(tip);
 	expect(data.pushed_sha).toBeNull();
 	expect(remoteHead(work)).toBe(base);
 	const head = git(work, ["rev-parse", "HEAD"]).trim();
 	expect(head).not.toBe(tip);
 	expect(git(work, ["rev-list", "--count", `${base}..HEAD`]).trim()).toBe("2");
 	expect(git(work, ["merge-base", "--is-ancestor", tip, "HEAD"]).trim()).toBe("");
 	expect(readFileSync(marker, "utf8").split("\n").filter((line) => line === "check")).toHaveLength(1);
 	peerBytesIntact(work, peer);
 }, Math.round(fixtureDeadlineS(120) * 1000));
 
 test("LANDSAVED1 origin advance during the check refuses one-shot without an unchecked retry", () => {
 	const { work, fakeBin } = fixture();
 	const marker = join(scratch, `saved-marker-${globalThis.fixtureNumber++}.txt`);
 	registerPushCheck(work, `#!/bin/sh
 set -eu
 R="\${OMP_LAND_REPOSITORY:?}"
 printf 'check\n' >> "\${LAND_TEST_MARKER:?}"
 BASE_REMOTE=$(git -C "$R" rev-parse refs/remotes/origin/main)
 BLOB=$(printf 'peer remote advance\n' | git -C "$R" hash-object -w --stdin)
 TREE=$(git -C "$R" ls-tree "$BASE_REMOTE" | awk -v b="$BLOB" '{ if ($4 == "peer.txt") $3 = b; printf "%s %s %s\\t%s\\n", $1, $2, $3, $4 }' | git -C "$R" mktree)
 NEW_COMMIT=$(git -C "$R" -c user.name=LAND1test -c user.email=land1@example.invalid commit-tree "$TREE" -p "$BASE_REMOTE" -m "peer advance [test]")
 git -C "$R" push -q origin "$NEW_COMMIT:refs/heads/main"
 exit 0
 `);
 	const base = remoteHead(work);
 	const tip = savedTip(work, "base owned\nsaved change\n");
 	const peer = peerStagedAndDirty(work);
 	const run = command(work, savedArgs(), hold, { amDir: fakeBin, gitEnv: { LAND_TEST_MARKER: marker } });
 	expect(run.status, JSON.stringify(run.body)).toBe(1);
 	expect(responseCode(run.body)).toBe("LAND_PUSH_REJECTED");
 	const data = run.body.data as Record<string, unknown>;
 	expectLandSchema(data);
 	expect(data.candidate_sha).toBe(tip);
 	expect(data.pushed_sha).toBeNull();
 	const remote = remoteHead(work);
 	expect(remote).not.toBe(base);
 	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(tip);
 	expect(readFileSync(marker, "utf8").split("\n").filter((line) => line === "check")).toHaveLength(1);
 	peerBytesIntact(work, peer);
 }, Math.round(fixtureDeadlineS(120) * 1000));
