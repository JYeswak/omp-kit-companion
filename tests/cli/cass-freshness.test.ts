import { expect, test } from "bun:test";
import { assessCassFreshness, type SessionFreshness } from "../../src/cass-freshness.ts";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const now = new Date("2026-10-17T12:00:00Z");
const sessions: SessionFreshness = {
	roots: ["/owned/.omp/agent/sessions"], files: 2,
	newest_path: "/owned/.omp/agent/sessions/current.jsonl",
	newest_mtime: "2026-10-17T11:30:00.000Z", complete: true,
};

function status(indexed: string) {
	return { index: { exists: true, fresh: true, stale: false, last_indexed_at: indexed,
		fingerprint: { matches_current_db_fingerprint: true } },
		rebuild: { active: false, pid: null, started_at: null }, budget: { timed_out: false } };
}

test("an old checkpoint cannot certify newer sessions even when cass says fresh", () => {
	const result = assessCassFreshness(status("2026-10-10T19:06:41.220Z"), sessions, now, 0);
	expect(result.status).toBe("STALE");
	expect(result.last_indexed_at).toBe("2026-10-10T19:06:41.220Z");
	expect(result.warning).toContain("FRESHNESS cass=STALE");
	expect(result.warning).toContain("index=2026-10-10T19:06:41.220Z");
	expect(result.warning).toContain("newest_session=2026-10-17T11:30:00.000Z");
});

test("a current checkpoint is fresh, but a fingerprint mismatch still makes it stale", () => {
	const input = status("2026-10-17T11:30:00Z");
	expect(assessCassFreshness(input, sessions, now, 0).status).toBe("FRESH");
	input.index.fingerprint.matches_current_db_fingerprint = false;
	expect(assessCassFreshness(input, sessions, now, 0).status).toBe("STALE");
});

test("semantic backfill is not a lexical rebuild owner", () => {
	const input = { ...status("2026-10-17T11:40:00Z"), semantic: { status: "building", checkpoint: { active: true } } };
	const result = assessCassFreshness(input, sessions, now, 0);
	expect(result.status).toBe("FRESH");
	expect(result.rebuild).toEqual({ active: false, reported_pid: null, started_at: null, held_seconds: null });
	expect(result.warning).toBeNull();
});

test("a busy result reports the declared owner and elapsed hold without certifying freshness", () => {
	const input = { ...status("2026-10-17T11:40:00Z"), rebuild: { active: true, pid: 4321, started_at: "2026-10-17T10:15:00Z" } };
	const result = assessCassFreshness(input, sessions, now, 7);
	expect(result.status).toBe("UNAVAILABLE");
	expect(result.rebuild).toEqual({ active: true, reported_pid: 4321, started_at: "2026-10-17T10:15:00.000Z", held_seconds: 6300 });
	expect(result.warning).toContain("rebuild_pid=4321 held_seconds=6300");
});

test("an active lexical rebuild remains stale even at a current checkpoint", () => {
	const input = { ...status("2026-10-17T11:40:00Z"), rebuild: { active: true, pid: 4321, started_at: "2026-10-17T11:00:00Z" } };
	expect(assessCassFreshness(input, sessions, now, 0).status).toBe("STALE");
});

test("missing index, malformed checkpoint and partial source scan never become fresh", () => {
	expect(assessCassFreshness({ index: { exists: false, fresh: true } }, sessions, now, 0).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("not-a-time"), sessions, now, 0).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("2026-10-17T11:40:00Z"), { ...sessions, complete: false }, now, 0).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("2026-10-17T12:01:00Z"), sessions, now, 0).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("2026-10-17T11:40:00Z"), { ...sessions, newest_mtime: null, files: 0, newest_path: null }, now, 0).status).toBe("UNAVAILABLE");
});

test("budget exhaustion or a failed status command cannot reuse a healthy-looking payload", () => {
	const input = status("2026-10-17T11:40:00Z");
	input.budget.timed_out = true;
	expect(assessCassFreshness(input, sessions, now, 0).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("2026-10-17T11:40:00Z"), sessions, now, null).status).toBe("UNAVAILABLE");
	expect(assessCassFreshness(status("2026-10-17T11:40:00Z"), sessions, now, 2).status).toBe("UNAVAILABLE");
});

test("a checkpoint without its database fingerprint binding is unavailable", () => {
	const input = status("2026-10-17T11:40:00Z");
	const { fingerprint: _binding, ...index } = input.index;
	expect(assessCassFreshness({ ...input, index }, sessions, now, 0).status).toBe("UNAVAILABLE");
});

test("a session arriving during status cannot be hidden by the earlier source scan", () => {
	const root = resolve(import.meta.dir, "../..");
	const scratch = join(root, "var", "agent-tmp");
	mkdirSync(scratch, { recursive: true });
	const home = mkdtempSync(join(scratch, `cass-race.${process.pid}.`));
	writeFileSync(join(home, ".owner"), `pid=${process.pid}\nlabel=cass-race\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const bin = join(home, "bin"), source = join(home, ".omp", "agent", "sessions");
	mkdirSync(bin, { recursive: true });
	mkdirSync(source, { recursive: true });
	const indexedAt = new Date(Date.now() - 60_000);
	const old = join(source, "old.jsonl"), arrived = join(source, "arrived.jsonl");
	writeFileSync(old, "{}\n");
	utimesSync(old, new Date(indexedAt.getTime() - 1000), new Date(indexedAt.getTime() - 1000));
	const response = status(indexedAt.toISOString());
	const body = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(arrived)},${JSON.stringify('{"text":"LESSON FIXTURE_TEXT_MUST_NOT_ESCAPE"}\n')});console.log(${JSON.stringify(JSON.stringify(response))});`;
	writeFileSync(join(bin, "cass"), "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " -e " + JSON.stringify(body) + "\n", { mode: 0o755 });
	const probe = `import {readCassFreshness} from ${JSON.stringify(join(root, "src", "cass-freshness.ts"))};console.log(JSON.stringify(readCassFreshness(process.env.HOME)));`;
	const child = Bun.spawnSync([process.execPath, "-e", probe], {
		cwd: root, env: { ...process.env, HOME: home, TMPDIR: home, PATH: bin + ":" + (process.env.PATH ?? "") },
		stdout: "pipe", stderr: "pipe", timeout: 25_000,
	});
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	const result = JSON.parse(child.stdout.toString());
	expect(result.status).toBe("STALE");
	expect(result.sessions.newest_path).toBe(arrived);
	expect(child.stdout.toString()).not.toContain("FIXTURE_TEXT_MUST_NOT_ESCAPE");
}, 30_000);

test("partial, hollow or engine-incompatible indexes cannot certify a current checkpoint", () => {
	const input = status("2026-10-17T11:40:00Z");
	for (const flag of ["partial", "hollow", "engine_incompatible"]) {
		expect(assessCassFreshness({ ...input, index: { ...input.index, [flag]: true } }, sessions, now, 0).status).toBe("UNAVAILABLE");
	}
});
