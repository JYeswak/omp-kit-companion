import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	command, fixture, git, landArgs, registerPushCheck, remoteHead, responseCode, scratch, LAND_DEFAULT_TIMEOUT_MS, type CommandOptions,
} from "./private-index-land.helpers.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

// land resolves the pane owner with `am agents resolve-pane` under a fixed 10 s product timeout
// (src/land.ts spawnSync timeout: 10_000) and refuses OWNER_UNKNOWN, before any mutation, when it
// expires. The 2026-11-04 b9e77980c8 verdict at load1 17-22 on 32 cores failed five cases here at
// 10079-10107 ms with exactly that code. These cases re-run land only on that pre-mutation refusal,
// inside a load-scaled budget; every other answer is asserted as before, and the unregistered-pane
// cases still assert OWNER_UNKNOWN from a single run.
function ownerResolved(work: string, args: string[], holds: unknown, options: CommandOptions) {
	const until = Date.now() + fixtureDeadlineS(30) * 1000;
	let run = command(work, args, holds, options);
	while (responseCode(run.body) === "OWNER_UNKNOWN" && Date.now() < until) run = command(work, args, holds, options);
	return run;
}
const OWNER_CASE_TIMEOUT_MS = fixtureDeadlineS(150) * 1000;

test("saves and publishes consecutive owned commits directly on shared main", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	writeFileSync(join(work, "owned.txt"), "base owned\nfirst change\n");
	const first = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
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
	const second = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
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
}, OWNER_CASE_TIMEOUT_MS);
test("refuses detached HEAD without creating or publishing an off-main candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	git(work, ["checkout", "--detach", "HEAD"]);
	const detached = git(work, ["rev-parse", "HEAD"]).trim();
	const elsewhere = git(work, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "stale main [test]"]).trim();
	git(work, ["update-ref", "refs/heads/main", elsewhere]);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_MAIN_REQUIRED");
	expect(remoteHead(work)).toBe(detached);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(elsewhere);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(detached);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
}, OWNER_CASE_TIMEOUT_MS);
test("preserves worktree edits made during publication without off-main catch-up", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf 'post-build edit\n' >> '${work}/owned.txt'\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(remoteHead(work)).toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(git(work, ["show", ":owned.txt"])).toBe("owner change\n");
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\npost-build edit\n");
}, OWNER_CASE_TIMEOUT_MS);
test("shared-main landing preserves peer staged and worktree bytes", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	writeFileSync(join(work, "untouched.txt"), "peer staged version\n");
	git(work, ["add", "untouched.txt"]);
	writeFileSync(join(work, "untouched.txt"), "peer staged version\npeer unstaged line\n");
	const peerContents = readFileSync(join(work, "untouched.txt"));
	const peerEntry = git(work, ["ls-files", "-s", "--", "untouched.txt"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
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
}, OWNER_CASE_TIMEOUT_MS);
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
	const run = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin, tmuxPane: null, ternPane: "1756641624115", ternAgent: "TernAgent", claimed: "TernAgent" });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect(head).not.toBe(commit);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(commit);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(commit);
	expect(remoteHead(work)).toBe(commit);
}, OWNER_CASE_TIMEOUT_MS);
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

