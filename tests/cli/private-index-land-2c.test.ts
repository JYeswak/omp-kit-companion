import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	command, fixture, git, landArgs, registerPushCheck, remoteHead, responseCode, scratch, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

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
