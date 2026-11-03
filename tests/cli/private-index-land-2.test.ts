import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	command, fixture, git, landArgs, registerPushCheck, remoteHead, responseCode, scratch, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

test("publishes only the reserved path on shared main and preserves a peer staged deletion", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	git(work, ["rm", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect([...commit].every((character) => (character >= "0" && character <= "9") || (character >= "a" && character <= "f"))).toBe(true);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"]).trim()).toBe("");
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("base owned\nowner change\n");
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
});
test("excludes foreign partially staged and unstaged content from the published candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	writeFileSync(join(work, "untouched.txt"), "peer staged version\n");
	git(work, ["add", "untouched.txt"]);
	writeFileSync(join(work, "untouched.txt"), "peer staged version\npeer unstaged line\n");
	const peerContents = readFileSync(join(work, "untouched.txt"));
	const peerEntry = git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim()).toBe(peerEntry);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(peerContents);
});

const reservationRefusalCases = [
	["missing reservation", [], "DarkFern", "DarkFern"],
	["missing pane identity", [], "", "DarkFern"],
	["foreign owner", [{ agent: "OtherAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], "DarkFern", "DarkFern"],
	["nonexclusive hold", [{ agent: "DarkFern", path: "owned.txt", exclusive: false, remaining_seconds: 3600 }], "DarkFern", "DarkFern"],
	["expired hold", [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 0 }], "DarkFern", "DarkFern"],
	["identity mismatch", [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], "DarkFern", "OtherAgent"],
] as const;
for (const [reason, hold, agent, claimed] of reservationRefusalCases) {
	test(`refuses ${reason} without mutation`, () => {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), hold, { agent, claimed, amDir: fakeBin });
		expect(run.status).not.toBe(0);
		expect(["OWNER", "RESERVATION"].some((prefix) => responseCode(run.body)?.startsWith(prefix))).toBe(true);
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	});
}
test("refuses unreadable reservation sources and uncovered paths", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	for (const reservationMode of ["unavailable", "unreadable", "stale", "database-mismatch", "storage-mismatch"]) {
		const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, reservationMode });
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe(reservationMode === "unavailable" ? "RESERVATION_UNAVAILABLE" : "RESERVATION_UNREADABLE");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
	}
	const uncovered = command(work, landArgs("untouched.txt"), hold, { amDir: fakeBin });
	expect(uncovered.status).not.toBe(0);
	expect(responseCode(uncovered.body)).toBe("RESERVATION_REQUIRED");
}, 15_000);

test("refuses a partially staged reserved path instead of publishing staged and unstaged peer content", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "staged version\n");
	git(work, ["add", "owned.txt"]);
	writeFileSync(join(work, "owned.txt"), "staged version\nunstaged peer line\n");
	const index = readFileSync(join(work, ".git", "index"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("STAGED_OWNED_PATH_REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
});

test("converges an advanced origin while preserving the actual landed commit on shared main", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const writer = join(scratch, `baseline-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	git(writer, ["config", "user.name", "baseline writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "new baseline\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "advance baseline [test]"]);
	git(writer, ["push", "origin", "HEAD:refs/heads/main"]);
	const initialHead = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	expect(data.commit).not.toBe(initialHead);
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, remoteHead(work)])).toBe("");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("new baseline\n");
});

test("refuses an origin advance after candidate check without retry or force", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `checked-before-push-${fixtureNumber}.txt`);
	registerPushCheck(work, `#!/bin/bash\nprintf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_MARKER_FILE"\nexit 0\n`);
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	git(writer, ["config", "user.name", "competing writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const attempts = join(scratch, `push-attempts-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\ngit -C '${writer}' push origin HEAD:refs/heads/main\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUSH_REJECTED");
	const data = run.body.data as {
		overall: string;
		commit: string;
		candidate_sha: string;
		check: { status: string; checked_sha: string; pushed_sha: string | null };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(readFileSync(checkMarker, "utf8")).toBe(`${data.candidate_sha}\n`);
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(remoteHead(work)).toBe(git(writer, ["rev-parse", "HEAD"]).trim());
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, "refs/heads/main"])).toBe("");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(git(work, ["rev-parse", "refs/heads/main"]).trim());
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("owner change\n");
});
test("distinguishes a rejected push from an origin advance", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `check-before-reject-${fixtureNumber}.txt`);
	registerPushCheck(work, `#!/bin/bash\nprintf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_MARKER_FILE"\nexit 0\n`);
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const base = remoteHead(work);
	const attempts = join(scratch, `rejected-push-attempts-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	const data = run.body.data as {
		overall: string;
		candidate_sha: string;
		check: { status: string; checked_sha: string; pushed_sha: string | null };
		convergence: { reason: string };
		phases: { publication: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(data.convergence.reason).toBe("PUSH_FAILED");
	expect(data.phases.publication).toBe("NOT_APPLIED");
	expect(readFileSync(checkMarker, "utf8")).toBe(`${data.candidate_sha}\n`);
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(remoteHead(work)).toBe(base);
});

test("ignores inherited Git repository overrides", () => {
	const a = fixture();
	const b = fixture();
	writeFileSync(join(a.work, "owned.txt"), "owner change\n");
	writeFileSync(join(b.work, "owned.txt"), "poisoned repository B change\n");
	const aHead = git(a.work, ["rev-parse", "HEAD"]).trim();
	const aRemote = remoteHead(a.work);
	const bHead = git(b.work, ["rev-parse", "HEAD"]).trim();
	const bRemote = remoteHead(b.work);
	const bIndex = readFileSync(join(b.work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(a.work, landArgs("owned.txt"), hold, {
		amDir: a.fakeBin,
		gitEnv: { GIT_DIR: join(b.work, ".git"), GIT_WORK_TREE: b.work },
	});
	let commit = "";
	if (run.status === 0) {
		const data = run.body.data;
		commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	} else {
		expect(run.status).toBe(1);
		expect(remoteHead(a.work)).toBe(aRemote);
		expect(git(a.work, ["rev-parse", "HEAD"]).trim()).toBe(aHead);
	}
	expect(remoteHead(b.work)).toBe(bRemote);
	expect(git(b.work, ["rev-parse", "HEAD"]).trim()).toBe(bHead);
	expect(readFileSync(join(b.work, ".git", "index"))).toEqual(bIndex);
	if (run.status === 0) {
		expect(commit.length).toBe(40);
		expect(git(a.work, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
		expect(remoteHead(a.work)).toBe(commit);
		expect(git(a.work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
		expect(git(a.work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
		expect(git(a.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	}
});
