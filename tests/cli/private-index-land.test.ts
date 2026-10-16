import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `private-index-land.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=private-index-land repo=${repoRoot} created=${new Date().toISOString()}\n`);
let fixtureNumber = 0;

type Fixture = { work: string; fakeBin: string };


function command(cwd: string, args: string[], holds: unknown, options: { agent?: string; claimed?: string; amDir: string; reservationMode?: string; gitEnv?: NodeJS.ProcessEnv; tmuxPane?: string | null; ternPane?: string; ternAgent?: string; herdrPaneId?: string }) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_INDEX_FILE;
	Object.assign(env, options.gitEnv);
	env.PATH = `${options.amDir}:${env.PATH ?? "/usr/bin:/bin"}`;

	if (options.tmuxPane === null) delete env.TMUX_PANE;
	else env.TMUX_PANE = options.tmuxPane ?? "%60";
	env.AGENT_NAME = options.claimed ?? "DarkFern";
	env.FAKE_AGENT = options.agent ?? "DarkFern";
	delete env.TERN_PANE;
	delete env.HERDR_PANE_ID;
	if (options.ternPane !== undefined) env.TERN_PANE = options.ternPane;
	if (options.herdrPaneId !== undefined) env.HERDR_PANE_ID = options.herdrPaneId;
	if (options.ternAgent !== undefined) env.FAKE_TERN_AGENT = options.ternAgent;
	env.FAKE_HOLDS_JSON = JSON.stringify(holds);
	env.FAKE_AM_MODE = options.reservationMode ?? "ok";
	const run = spawnSync("bun", [cliPath, "land", ...args, "--json"], { cwd, env, encoding: "utf8", timeout: 30_000 });
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(run.stdout);
	} catch {
		throw new Error(`land command emitted invalid JSON (status ${run.status}): ${run.stdout}\n${run.stderr}`);
	}
	return { status: run.status ?? 1, body };
}

function git(cwd: string, args: string[]): string {
	const run = spawnSync("git", ["-c", "user.name=LAND1 test", "-c", "user.email=land1@example.invalid", ...args], {
		cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 10_000,
	});
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed (${run.status}): ${String(run.stderr)}`);
	return String(run.stdout);
}
function remoteHead(cwd: string): string {
	const output = git(cwd, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const [sha, ref] = output.split("\t");
	if (!sha || ref !== "refs/heads/main") throw new Error(`unexpected origin/main response: ${output}`);
	return sha;
}

function fixture(): Fixture {
	const id = fixtureNumber++;
	const bare = join(scratch, `origin-${id}.git`);
	const work = join(scratch, `work-${id}`);
	git(scratch, ["init", "--bare", "--initial-branch=main", bare]);
	git(scratch, ["clone", bare, work]);
	git(work, ["config", "user.name", "LAND1 test"]);
	git(work, ["config", "user.email", "land1@example.invalid"]);
	writeFileSync(join(work, "owned.txt"), "base owned\n");
	writeFileSync(join(work, "peer.txt"), "peer baseline\n");
	writeFileSync(join(work, "untouched.txt"), "untouched baseline\n");
	git(work, ["add", "-A"]);
	git(work, ["commit", "-m", "base [test]"]);
	git(work, ["push", "-u", "origin", "HEAD:refs/heads/main"]);
	const fakeBin = join(scratch, `fake-am-${id}`);
	mkdirSync(fakeBin);
	const fakeAm = join(fakeBin, "am");
	writeFileSync(fakeAm, String.raw`#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") if [ "$FAKE_AM_MODE" = "unregistered" ]; then exit 1; fi; case "$6" in tern:*) agent="$FAKE_TERN_AGENT" ;; *) agent="$FAKE_AGENT" ;; esac; if [ -z "$agent" ]; then agent="$FAKE_AGENT"; fi; printf '{"agent_name":"%s"}\n' "$agent" ;;
  "robot reservations")
    case "$FAKE_AM_MODE" in
      unavailable) exit 7 ;;
      unreadable) printf 'not-json\n' ;;
      stale) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"stale","database_matches_server":true,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
      database-mismatch) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":false,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
      storage-mismatch) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":false}}\n' "$FAKE_HOLDS_JSON" ;;
      *) printf '{"my_reservations":%s,"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}}\n' "$FAKE_HOLDS_JSON" ;;
    esac ;;
  *) exit 2 ;;
esac
`);
	chmodSync(fakeAm, 0o755);
	return { work, fakeBin };
}

function landArgs(...paths: string[]): string[] {
	return [...paths.flatMap((path) => ["--paths", path]), "--message", "feat(land): publish reserved fixture [test]", "--apply", "--yes"];
}

function responseCode(body: Record<string, unknown>): string | undefined {
	const errors = body.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const first = errors[0];
	return first !== null && typeof first === "object" && "code" in first && typeof first.code === "string" ? first.code : undefined;
}
test("requires explicit --yes before publishing", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): require explicit confirmation [test]", "--apply"], hold, { amDir: fakeBin });
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("CONSENT_REQUIRED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

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

test("reports the saved shared-main commit when a concurrent writer rejects publication", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", git(work, ["remote", "get-url", "origin"]).trim(), writer]);
	git(writer, ["config", "user.name", "competing writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\ngit -C '${writer}' push origin HEAD:refs/heads/main\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("SAVED_NOT_PUBLISHED");
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, "refs/heads/main"])).toBe("");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(git(work, ["rev-parse", "refs/heads/main"]).trim());
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("owner change\n");
	const remote = remoteHead(work);
	expect(remote).toBe(git(writer, ["rev-parse", "HEAD"]).trim());
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
		expect(run.status).toBe(2);
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
	expect(run.status).toBe(2);
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
test("refuses a Herdr caller without borrowing outer keys", () => {
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const withTmux = fixture();
	writeFileSync(join(withTmux.work, "owned.txt"), "unpublished change\n");
	const withTmuxHead = git(withTmux.work, ["rev-parse", "HEAD"]).trim();
	const withTmuxRemote = git(withTmux.work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim();
	const withTmuxIndex = readFileSync(join(withTmux.work, ".git", "index"));
	const herdrWithTmux = command(withTmux.work, landArgs("owned.txt"), hold, { amDir: withTmux.fakeBin, herdrPaneId: "herdr-1", ternPane: "1756641624115", ternAgent: "DarkFern", claimed: "DarkFern" });
	expect(herdrWithTmux.status).not.toBe(0);
	expect(responseCode(herdrWithTmux.body)).toBe("OWNER_UNAVAILABLE");
	expect(git(withTmux.work, ["rev-parse", "HEAD"]).trim()).toBe(withTmuxHead);
	expect(git(withTmux.work, ["ls-remote", "--refs", "origin", "refs/heads/main"]).trim()).toBe(withTmuxRemote);
	expect(readFileSync(join(withTmux.work, ".git", "index"))).toEqual(withTmuxIndex);
	const alone = fixture();
	writeFileSync(join(alone.work, "owned.txt"), "unpublished change\n");
	const aloneHead = git(alone.work, ["rev-parse", "HEAD"]).trim();
	const herdrAlone = command(alone.work, landArgs("owned.txt"), hold, { amDir: alone.fakeBin, tmuxPane: null, herdrPaneId: "herdr-1", claimed: "DarkFern" });
	expect(herdrAlone.status).not.toBe(0);
	expect(responseCode(herdrAlone.body)).toBe("OWNER_UNAVAILABLE");
	expect(git(alone.work, ["rev-parse", "HEAD"]).trim()).toBe(aloneHead);
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
	expect(run.status).toBe(2);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("SAVED_NOT_PUBLISHED");
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
	expect(run.status).toBe(2);
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
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("COMMIT_CREATION_FAILED");
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
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("LAND_PATH_INVALID");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(git(work, ["diff", "--name-only"]).trim().split("\n")).toEqual(["owned-dir/a.txt", "owned-dir/b.txt"]);
});

test("reports a saved commit after a post-commit hook interrupts its Git parent", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "saved before hook interruption\n");
	const before = remoteHead(work);
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_INTERRUPTED");
	const data = run.body.data as { overall: string; commit: string; base: string };
	expect(data.overall).toBe("SAVED_NOT_PUBLISHED");
	expect(data.base).toBe(before);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("saved before hook interruption\n");
	expect(git(work, ["show", ":owned.txt"])).toBe("saved before hook interruption\n");
	expect(remoteHead(work)).toBe(before);
});

test("attributes the actual owned commit when a peer advances HEAD before Git returns", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "peer later save\n");
	const hook = join(work, ".git", "hooks", "post-commit");
	// The independent peer has its own Git environment, not this call's nonce.
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  unset GIT_REFLOG_ACTION\n  PEER_LANDED=1 git commit --only -m "peer later save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(data.commit).not.toBe(tip);
	expect(git(work, ["rev-parse", "HEAD^"]).trim()).toBe(data.commit);
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	expect(git(work, ["show", `${data.commit}:peer.txt`])).toBe("peer baseline\n");
	expect(git(work, ["show", "HEAD:peer.txt"])).toBe("peer later save\n");
	expect(remoteHead(work)).toBe(tip);
});

test("refuses publication when inherited hook attribution is ambiguous", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "nested hook save\n");
	const before = remoteHead(work);
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  PEER_LANDED=1 git commit --only -m "nested hook save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(2);
	const data = run.body.data as { overall: string; commit: null; base: string };
	expect(data.overall).toBe("SAVE_UNCERTAIN");
	expect(data.commit).toBeNull();
	expect(data.base).toBe(before);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_UNVERIFIED");
	expect(git(work, ["show", "HEAD:owned.txt"])).toBe("owned save\n");
	expect(remoteHead(work)).toBe(before);
});
