import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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


function command(cwd: string, args: string[], holds: unknown, options: { agent?: string; claimed?: string; amDir: string; reservationMode?: string; gitEnv?: NodeJS.ProcessEnv }) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_INDEX_FILE;
	Object.assign(env, options.gitEnv);
	env.PATH = `${options.amDir}:${env.PATH ?? "/usr/bin:/bin"}`;

	env.TMUX_PANE = "%60";
	env.AGENT_NAME = options.claimed ?? "DarkFern";
	env.FAKE_AGENT = options.agent ?? "DarkFern";
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
  "agents resolve-pane") printf '{"agent_name":"%s"}\n' "$FAKE_AGENT" ;;
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

test("publishes only the reserved path and preserves the shared staged deletion and index bytes", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	git(work, ["rm", "peer.txt"]);
	const sharedIndex = readFileSync(join(work, ".git", "index"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data && data.overall).toBe("PUSHED");
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(commit.length).toBe(40);
	expect([...commit].every((character) => (character >= "0" && character <= "9") || (character >= "a" && character <= "f"))).toBe(true);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(sharedIndex);
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("base owned\nowner change\n");
	const remote = remoteHead(work);
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
});
test("excludes foreign partially staged and unstaged content from the published candidate", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	writeFileSync(join(work, "untouched.txt"), "peer staged version\n");
	git(work, ["add", "untouched.txt"]);
	writeFileSync(join(work, "untouched.txt"), "peer staged version\npeer unstaged line\n");
	const peerContents = readFileSync(join(work, "untouched.txt"));
	const sharedIndex = readFileSync(join(work, ".git", "index"));
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data;
	const commit = data !== null && typeof data === "object" && "commit" in data && typeof data.commit === "string" ? data.commit : "";
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(sharedIndex);
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

test("refuses a checkout whose fetched origin/main baseline has advanced", () => {
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
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).not.toBe(0);
	expect(responseCode(run.body)).toBe("BASELINE_DIVERGED");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(initialHead);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
	expect(remoteHead(work)).toBe(git(writer, ["rev-parse", "HEAD"]).trim());
});

test("refuses a concurrent writer that advances origin/main before the candidate push", () => {
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
	writeFileSync(hook, `#!/bin/sh\ngit -C '${writer}' push origin HEAD:refs/heads/main\n`);
	chmodSync(hook, 0o755);
	const initialHead = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).not.toBe(0);
	expect(["BASELINE", "PUSH", "CONFLICT"].some((prefix) => responseCode(run.body)?.startsWith(prefix))).toBe(true);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(initialHead);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
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
		expect(git(a.work, ["rev-parse", "HEAD"]).trim()).toBe(aHead);
		expect(git(a.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).trim().split("\n")).toEqual(["owned.txt"]);
	}
});
