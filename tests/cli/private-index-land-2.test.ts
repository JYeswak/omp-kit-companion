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
test("saves and publishes consecutive owned commits directly on shared main", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	writeFileSync(join(work, "owned.txt"), "base owned\nfirst change\n");
	const first = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(first.status).toBe(0);
	const firstData = first.body.data;
	expect(firstData !== null && typeof firstData === "object" && "overall" in firstData && firstData.overall).toBe("PUSHED");
	const firstSha = firstData !== null && typeof firstData === "object" && "commit" in firstData && typeof firstData.commit === "string" ? firstData.commit : "";
	expect(firstSha.length).toBe(40);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(firstSha);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(firstSha);
	expect(remoteHead(work)).toBe(firstSha);
	const firstBlob = git(work, ["ls-tree", firstSha, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(firstBlob);
	const writer = join(scratch, `consecutive-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	writeFileSync(join(writer, "untouched.txt"), "remote between owned lands\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "advance between owned lands [test]"]);
	git(writer, ["push", "origin", "main"]);
	writeFileSync(join(work, "peer.txt"), "peer staged between lands\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "peer.txt"), "peer dirty between lands\n");
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	writeFileSync(join(work, "owned.txt"), "base owned\nfirst change\nsecond change\n");
	const second = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(second.status).toBe(0);
	const secondData = second.body.data;
	expect(secondData !== null && typeof secondData === "object" && "overall" in secondData && secondData.overall).toBe("PUSHED");
	const secondSha = secondData !== null && typeof secondData === "object" && "commit" in secondData && typeof secondData.commit === "string" ? secondData.commit : "";
	expect(secondSha.length).toBe(40);
	expect(secondSha).not.toBe(firstSha);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(remoteHead(work));
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
	expect(git(work, ["merge-base", "--is-ancestor", secondSha, remoteHead(work)])).toBe("");
	expect(git(work, ["merge-base", "--is-ancestor", firstSha, secondSha])).toBe("");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer dirty between lands\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("remote between owned lands\n");
	const secondBlob = git(work, ["ls-tree", secondSha, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(secondBlob);
});
test("refuses detached HEAD without creating or publishing an off-main candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	git(work, ["checkout", "--detach", "HEAD"]);
	const detached = git(work, ["rev-parse", "HEAD"]).trim();
	const elsewhere = git(work, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "stale main [test]"]).trim();
	git(work, ["update-ref", "refs/heads/main", elsewhere]);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_MAIN_REQUIRED");
	expect(remoteHead(work)).toBe(detached);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(elsewhere);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(detached);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});
test("preserves worktree edits made during publication without off-main catch-up", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'post-build edit\n' >> '${work}/owned.txt'\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(remoteHead(work)).toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(git(work, ["show", ":owned.txt"])).toBe("owner change\n");
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\npost-build edit\n");
});
test("shared-main landing preserves peer staged and worktree bytes", () => {
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
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(peerContents);
	expect(git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim()).toBe(peerEntry);
	const commitBlob = git(work, ["ls-tree", commit, "--", "owned.txt"]).trim().split("\t")[0].split(" ")[2];
	expect(git(work, ["ls-files", "-s", "--", "owned.txt"]).trim().split("\t")[0].split(" ")[1]).toBe(commitBlob);
});
test("refuses an unregistered pane identity without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, reservationMode: "unregistered" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("lands for a registered Tern caller through the tern key", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "tern owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "TernAgent" });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect(head).not.toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
});
test("refuses an unregistered Tern pane without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "9999999999999", ternAgent: "TernAgent", claimed: "TernAgent", reservationMode: "unregistered" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("refuses a Tern caller whose claim does not match without mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "OtherAgent" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});
test("refuses an absent or malformed Tern pane key without mutation", () => {
	const hold = [{ agent: "TernAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	for (const ternPane of [undefined, "", "12ab", "tern:1756641624115"]) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane, ternAgent: "TernAgent", claimed: "TernAgent" });
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(git(work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
	}
});
test("keeps tmux precedence when both pane keys are present", () => {
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const first = fixture();
	writeFileSync(join(first.work, "owned.txt"), "tmux owner change\n");
	const tmuxRun = command(first.work, landArgs("owned.txt"), hold, { amDir: first.fakeBin, ternPane: "1756641624115", ternAgent: "OtherAgent", claimed: "DarkFern" });
	expect(tmuxRun.status).toBe(0);
	const tmuxData = tmuxRun.body.data;
	expect(tmuxData !== null && typeof tmuxData === "object" && "overall" in tmuxData && tmuxData.overall).toBe("PUSHED");
	const second = fixture();
	writeFileSync(join(second.work, "owned.txt"), "unpublished change\n");
	const head = git(second.work, ["rev-parse", "HEAD"]).trim();
	const mismatch = command(second.work, landArgs("owned.txt"), hold, { amDir: second.fakeBin, ternPane: "1756641624115", ternAgent: "OtherAgent", claimed: "OtherAgent" });
	expect(mismatch.status).not.toBe(0);
	expect(responseCode(mismatch.body)).toBe("OWNER_MISMATCH");
	expect(git(second.work, ["rev-parse", "HEAD"]).trim()).toBe(head);
});
test("lands through the registered Herdr pane key and canonical project identity", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "Herdr owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin, agent: "TmuxFallback", claimed: "HerdrAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	expect(data !== null && typeof data === "object" && "owner" in data && data.owner).toBe("HerdrAgent");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(head).not.toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
});

test("Herdr identity can land only its exact current reservation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "HerdrAgent", path: "peer.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, {
		amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses incomplete or spoofed Herdr identity without borrowing tmux", () => {
	const attempts: Array<{ herdrEnv?: string; herdrPaneId?: string }> = [
		{ herdrEnv: "1" },
		{ herdrPaneId: "w2:p3" },
	];
	for (const attempt of attempts) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = remoteHead(work);
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
			amDir: fakeBin, agent: "DarkFern", claimed: "DarkFern", tmuxPane: "%60", ...attempt,
		});
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNAVAILABLE");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(remoteHead(work)).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
	}
});

test("refuses ambiguous Herdr and outer-pane identity markers before mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, agent: "TmuxFallback", claimed: "HerdrAgent", tmuxPane: "%60",
		ternPane: "1756641624115", ternAgent: "TernFallback",
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_AMBIGUOUS");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses stale and cross-project Herdr bindings before mutation", () => {
	for (const binding of [
		{ registeredHerdrPane: "w1:p1", expectedAmProject: undefined },
		{ registeredHerdrPane: "w2:p3", expectedAmProject: "/other/project" },
	]) {
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const remote = remoteHead(work);
		const index = readFileSync(join(work, ".git", "index"));
		const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
			amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null,
			herdrEnv: "1", herdrPaneId: "w2:p3", herdrAgent: "HerdrAgent", ...binding,
		});
		expect(run.status).not.toBe(0);
		expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
		expect(remoteHead(work)).toBe(remote);
		expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
		expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
	}
});

test("refuses ambiguous Herdr resolver output before mutation", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, claimed: "HerdrAgent", tmuxPane: null, reservationMode: "ambiguous",
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_UNKNOWN");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});

test("refuses a Herdr pane whose claimed agent name differs", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished Herdr change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), [{ agent: "HerdrAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }], {
		amDir: fakeBin, claimed: "DifferentAgent", tmuxPane: null,
		herdrEnv: "1", herdrPaneId: "w2:p3", registeredHerdrPane: "w2:p3", herdrAgent: "HerdrAgent",
	});
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("OWNER_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished Herdr change\n");
});
test("refuses a Tern caller without a covering lease", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "unpublished change\n");
	const hold = [{ agent: "OtherAgent", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "TernAgent" });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("unpublished change\n");
});

test("keeps the saved commit and peer state when both sides changed the owned path", () => {
	const { work, fakeBin } = fixture();
	const writer = join(scratch, `conflicting-writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	writeFileSync(join(writer, "owned.txt"), "remote owner edit\n");
	git(writer, ["add", "owned.txt"]);
	git(writer, ["commit", "-m", "remote conflicting edit [test]"]);
	git(writer, ["push", "origin", "main"]);
	const remote = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "local owner edit\n");
	writeFileSync(join(work, "peer.txt"), "peer staged\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "peer.txt"), "peer dirty\n");
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("local owner edit\n");
	expect(remoteHead(work)).toBe(remote);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer dirty\n");
});

test("refuses directory reservations rather than committing unreserved descendants", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, "owned-dir"));
	writeFileSync(join(work, "owned-dir", "unreserved.txt"), "not owned\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned-dir", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned-dir"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATH_INVALID");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
});

test("publishes a new owned file without committing peer staging", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "new-owned.txt"), "new file\n");
	writeFileSync(join(work, "peer.txt"), "peer staged\n");
	git(work, ["add", "peer.txt"]);
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "new-owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("new-owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expect(git(work, ["show", "HEAD:new-owned.txt"])).toBe("new file\n");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(git(work, ["show", "HEAD:peer.txt"])).toBe("peer baseline\n");
});

test("commits an owned tracked deletion on shared main while leaving peer entries alone", () => {
	const { work, fakeBin } = fixture();
	unlinkSync(join(work, "owned.txt"));
	writeFileSync(join(work, "peer.txt"), "peer staging\n");
	git(work, ["add", "peer.txt"]);
	const peerEntry = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expect(git(work, ["ls-tree", "HEAD", "--", "owned.txt"])).toBe("");
	expect(existsSync(join(work, "owned.txt"))).toBe(false);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(peerEntry);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(remoteHead(work));
});

test("a failed ordinary commit is not reported as saved or published", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hook = join(work, ".git", "hooks", "pre-commit");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("COMMIT_CREATION_REFUSED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

test("refuses a deleted directory that expands to unreserved tracked deletions", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, "owned-dir"));
	for (const name of ["a.txt", "b.txt"]) writeFileSync(join(work, "owned-dir", name), "baseline\n");
	git(work, ["add", "owned-dir/a.txt", "owned-dir/b.txt"]);
	git(work, ["commit", "-m", "directory deletion baseline [test]"]);
	git(work, ["push", "origin", "main"]);
	for (const name of ["a.txt", "b.txt"]) unlinkSync(join(work, "owned-dir", name));
	rmdirSync(join(work, "owned-dir"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned-dir", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned-dir"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATH_INVALID");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(git(work, ["diff", "--name-only"]).trim().split("\n")).toEqual(["owned-dir/a.txt", "owned-dir/b.txt"]);
});
