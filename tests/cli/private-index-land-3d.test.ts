// Affected-test source dependencies retained across the land-3 shards:
// src/kitlib/run.ts src/land.ts scripts/pysafe.py
// scripts/suite-hermetic-env.sh scripts/kitlib_tmp.py
// scripts/check-stale-worktree.sh scripts/kitlib-tmp.sh
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { qualifyPublicationCandidate } from "../../src/land.ts";
import {
	EXPECTED_SERVICE, SERVICE_BASE, actualParentSetup, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, verdictPath, writeServiceLines, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);
// GATESPEED1: land defers the complete suite to the release by default; these cases assert the
// inline suite's refusals, so this file opts in for every land command it runs.
process.env.PRE_PUSH_FULL_SUITE = "push";

test("refuses a patch naming a path outside the owner reservation", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "peer.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--patch", patch, "--message", "feat(land): uncovered selection [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	const errors = run.body.errors as { message: string }[];
	expect(errors[0]?.message ?? "").toContain("service.txt");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("refuses worktree paths combined with a patch file", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const run = command(work, ["--paths", "service.txt", "--patch", patch, "--message", "feat(land): mixed modes [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATCH_EXCLUSIVE");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("publishes only the approved owned delta parented on the actual parent", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	writeFileSync(join(work, "owned.txt"), "actual parent bytes plus approved delta\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string;
		paths: string[]; base: string; localMain: string;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string; construction: string; publication: string };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(parent);
	expect(data.owner).toBe("DarkFern");
	expect(data.candidate_sha).toBe(data.commit);
	expect(data.pushed_sha).toBe(data.commit);
	expect(data.localMain).toBe(data.commit);
	// The candidate is parented on exactly the actual publication parent.
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(parent);
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	// The candidate publishes ONLY the approved owned delta.
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	// Nonauthor native observer: real tree/ref/index/worktree postimages.
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("actual parent bytes plus approved delta\n");
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(data.commit);
	expect(git(work, ["rev-parse", ":owned.txt"]).trim()).toBe(git(work, ["rev-parse", `${data.commit}:owned.txt`]).trim());
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("actual parent bytes plus approved delta\n");
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer baseline\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("untouched baseline\n");
	expect(remoteHead(work)).toBe(data.commit);
});

test("refuses a caller patch restoring bytes the actual parent superseded", () => {
	const { work, fakeBin, seed, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const caller = join(scratch, `stale-caller-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, caller]);
	git(caller, ["config", "user.name", "stale caller"]);
	git(caller, ["config", "user.email", "stale-caller@example.invalid"]);
	// The caller selection restores the seed bytes onto the actual parent.
	writeFileSync(join(caller, "owned.txt"), "base owned\n");
	git(caller, ["add", "--", "owned.txt"]);
	git(caller, ["commit", "-m", "stale restore [test]"]);
	const patch = join(scratch, `stale-restore-${fixtureNumber}.patch`);
	writeFileSync(patch, git(caller, ["diff", parent, "HEAD"]));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const localBefore = git(work, ["rev-parse", "HEAD"]).trim();
	const run = command(work, ["--patch", patch, "--message", "feat(land): stale restore [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_STALE_RESTORE");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	expect(data.commit).toBe(data.candidate_sha);
	// The refused candidate really was parented on the actual parent with stale bytes.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("base owned\n");
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	// Zero publication: the seed bytes never reach origin. Like a refused
	// path-mode save, the candidate stays on local main for inspection.
	expect(remoteHead(work)).toBe(parent);
	expect(git(work, ["show", `${parent}:owned.txt`])).toBe("actual parent bytes\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
	expect(seed).not.toBe(parent);
});

test("refuses when the publication parent advances before publication", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const peerDir = join(scratch, `race-peer-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, peerDir]);
	git(peerDir, ["config", "user.name", "race peer"]);
	git(peerDir, ["config", "user.email", "race-peer@example.invalid"]);
	// B3 advances the same owned path, so no silent merge can absorb it.
	writeFileSync(join(peerDir, "owned.txt"), "peer raced publication\n");
	git(peerDir, ["add", "--", "owned.txt"]);
	git(peerDir, ["commit", "-m", "race advance [test]"]);
	const raced = git(peerDir, ["rev-parse", "HEAD"]).trim();
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${peerDir}' push origin main\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "approved delta raced by peer\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null; base: string;
		convergence: { reason: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.base).toBe(parent);
	expect(data.pushed_sha).toBeNull();
	// The saved candidate is preserved parented on B2, but origin holds B3: zero publication.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("approved delta raced by peer\n");
	expect(remoteHead(work)).toBe(raced);
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["show", `${raced}:owned.txt`])).toBe("peer raced publication\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
});

test("refuses when live custody lapses between save and publication", () => {
	const { work } = fixture();
	const base = remoteHead(work);
	const holdsFile = join(scratch, `custody-holds-${fixtureNumber++}.json`);
	const currentHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 });
	const attestation = `"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}`;
	writeFileSync(holdsFile, `{"my_reservations":[${currentHolds}],${attestation}}`);
	const expiredHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 0 });
	const statefulBin = join(scratch, `stateful-am-${fixtureNumber}`);
	mkdirSync(statefulBin);
	writeFileSync(join(statefulBin, "am"), String.raw`#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") printf '{"agent_name":"DarkFern"}\n' ;;
  "robot reservations") cat "$FAKE_HOLDS_FILE" ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(statefulBin, "am"), 0o755);
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nprintf '{"my_reservations":[%s],%s}' '${expiredHolds}' '${attestation}' > "$FAKE_HOLDS_FILE"\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "owned save with lapsing custody\n");
	const run = command(work, landArgs("owned.txt"), [], { amDir: statefulBin, gitEnv: { FAKE_HOLDS_FILE: holdsFile } });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CUSTODY_EXPIRED");
	expectLandSchema(run.body.data);
	const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: null };
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	// The save is real and kept, but nothing was published after custody lapsed.
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("owned save with lapsing custody\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
	expect(remoteHead(work)).toBe(base);
});

test("the actual-parent guard names its ref and reads real parents", () => {
	const { work } = fixture();
	const base = git(work, ["rev-parse", "HEAD"]).trim();
	const unnamed = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "", qualifiedBlobs: {},
	});
	expect("refusal" in unnamed && unnamed.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNNAMED");
	const foreign = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/feature", qualifiedBlobs: {},
	});
	expect("refusal" in foreign && foreign.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNSUPPORTED");
	const absent = qualifyPublicationCandidate(work, {
		candidate: "f".repeat(40), base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in absent && absent.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_UNREADABLE");
	// The root fixture commit has no parent at all, so it can never qualify against itself as base.
	const mismatch = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in mismatch && mismatch.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("doctor reports the land guard identities and decision", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--scope", "land"], hold, { amDir: fakeBin, subcommand: "doctor" });
	const data: unknown = run.body.data;
	const findings: unknown = data !== null && typeof data === "object" && "findings" in data ? data.findings : undefined;
	expect(Array.isArray(findings)).toBe(true);
	const land = (Array.isArray(findings) ? findings : []).find((entry): entry is { component: unknown; status: unknown; reason: unknown; evidence: unknown } =>
		typeof entry === "object" && entry !== null && "component" in entry && entry.component === "land");
	expect(land?.status).toBe("OK");
	const evidence: unknown = land !== undefined && typeof land.evidence === "object" && land.evidence !== null ? land.evidence : undefined;
	expect(evidence).toMatchObject({
		guard: "actual-parent-custody-v1",
		publication_ref: "refs/heads/main",
		owner: "DarkFern",
		owner_capability: "verified-current",
		actual_parent_capability: "native-git",
		decision: "READY",
	});
	expect(typeof land?.reason).toBe("string");
});
