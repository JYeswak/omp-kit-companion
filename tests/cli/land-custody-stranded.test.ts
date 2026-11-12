// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import {
	LAND_DEFAULT_TIMEOUT_MS, command, expectLandSchema, fixture, git, remoteHead, responseCode, scratch,
} from "./private-index-land.helpers.ts";

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

/** An `am` whose first two `robot reservations` reads report the held paths and
 * whose later reads report none: custody lapses between land's pre-commit
 * checks and its post-commit qualification, stranding the local commit. */
function lapsingAm(): { amDir: string; env: NodeJS.ProcessEnv } {
	const dir = join(scratch, `lapsing-am-${globalThis.fixtureNumber++}`);
	mkdirSync(dir);
	const countFile = join(dir, "count");
	const holdsBody = JSON.stringify({ my_reservations: hold, reservation_read_attestation: { state: "current", database_matches_server: true, storage_root_matches_server: true } });
	writeFileSync(join(dir, "am"), `#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") printf '{"agent_name":"DarkFern"}\\n' ;;
  "robot reservations")
    n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > "$COUNT_FILE"
    if [ "$n" -le 2 ]; then printf '%s\\n' "$HOLDS_BODY"; else printf '{"my_reservations":[],"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}}\\n'; fi ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(dir, "am"), 0o755);
	return { amDir: dir, env: { COUNT_FILE: countFile, HOLDS_BODY: holdsBody } };
}

test("LANDSTRANDED1 custody lapse after commit reports the stranded commit and the retry publishes it", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "base owned\nstranded change\n");
	const lapsing = lapsingAm();
	const first = command(work, strandedArgs(), [], { amDir: lapsing.amDir, gitEnv: lapsing.env });
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
