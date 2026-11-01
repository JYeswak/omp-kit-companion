import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { KNOWN_JOBS, renderLaunchdPlist } from "../../src/service.ts";
import { retainOmpSessions } from "../../src/session-retain.ts";

afterAll(cleanupAllOwnedTmp);
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function fixture(exactCutoff = false) {
	const now = Date.now();
	const oldMs = now - 15 * 24 * 60 * 60 * 1000;
	const boundaryMs = now - RETENTION_MS + (exactCutoff ? 0 : 5 * 60 * 1000);
	const root = ownedTmp("session-retain-test").path;
	const home = join(root, "home");
	const sessions = join(home, ".omp", "profiles", "fixture", "agent", "sessions");
	const state = join(home, ".local", "state", "omp-kit", "cc");
	mkdirSync(sessions, { recursive: true });
	mkdirSync(join(state, "producers"), { recursive: true });
	chmodSync(join(state, ".."), 0o700);
	const ingested = join(sessions, "ingested.jsonl");
	const untracked = join(sessions, "untracked.jsonl");
	const boundary = join(sessions, "boundary.jsonl");
	writeFileSync(ingested, '{"type":"message/user"}\n');
	writeFileSync(untracked, '{"type":"message/user"}\n');
	writeFileSync(boundary, '{"type":"message/user"}\n');
	utimesSync(ingested, new Date(oldMs), new Date(oldMs));
	utimesSync(untracked, new Date(oldMs), new Date(oldMs));
	utimesSync(boundary, new Date(boundaryMs), new Date(boundaryMs));
	const info = statSync(ingested);
	const sessionState = {
		schema_version: "omp-kit.cc.session-tail.v1",
		files: { [resolve(ingested)]: { path: resolve(ingested), dev: info.dev, inode: info.ino, generation: 0,
			offset: info.size, slot_len: 0, prefix_end: 0, tail_start: info.size, through_ms: oldMs,
			title_valid: false, slot_sha: "0".repeat(64), prefix_sha: "0".repeat(64), tail_sha: "0".repeat(64) } },
		position: info.size,
		pending: null,
		next_path: resolve(ingested),
	};
	writeFileSync(join(state, "producers", "session.state.json"), `${JSON.stringify(sessionState)}\n`);
	const db = new Database(join(state, "cc.db"));
	db.exec("CREATE TABLE events (cursor INTEGER PRIMARY KEY, type TEXT, producer TEXT, data TEXT)");
	db.exec("CREATE TABLE source_ticks (cursor INTEGER PRIMARY KEY, producer TEXT, time_ms INTEGER, position INTEGER, error_code TEXT)");
	db.query("INSERT INTO events VALUES (1, 'source.tick', 'session', ?)").run(JSON.stringify({
		instance: "fixture", records_seen: 0, records_emitted: 0, records_ignored: 0, records_quarantined: 0,
		position: info.size, error_code: null, complete_through_ms: oldMs, coverage: [],
	}));
	db.query("INSERT INTO source_ticks VALUES (1, 'session', ?, ?, NULL)").run(now, info.size);
	db.close();
	return { root, home, sessions, ingested, untracked, boundary, now };
}

test.serial("session-retain deletes only old transcripts at the committed CC session frontier", async () => {
	expect(KNOWN_JOBS["session-retain"]).toBeDefined();
	const f = fixture();
	const bun = Bun.which("bun");
	if (!bun) throw new Error("Bun is required for the source CLI fixture");
	const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
	const launcher = join(f.root, "omp-kit");
	writeFileSync(launcher, `#!/bin/sh\nexec ${quote(bun)} run --no-env-file --config=/dev/null ${quote(join(import.meta.dir, "../../src/cli.ts"))} "$@"\n`);
	chmodSync(launcher, 0o755);
	const plist = join(f.root, "session-retain.plist");
	writeFileSync(plist, renderLaunchdPlist(f.home, KNOWN_JOBS["session-retain"]!, launcher, null).text);
	const parsed = await run(["python3", "-c", `
import json, plistlib, sys
with open(sys.argv[1], "rb") as handle:
    data = plistlib.load(handle)
print(json.dumps({"argv": data["ProgramArguments"], "env": data["EnvironmentVariables"]}))
`, plist], { deadline_s: 60 });
	if (parsed.rc !== 0) throw new Error(new TextDecoder().decode(parsed.stderr));
	const program = JSON.parse(new TextDecoder().decode(parsed.stdout));
	for (const key of ["HOME", "XDG_STATE_HOME", "TMPDIR"]) {
		if (!program.env[key].startsWith(f.root + "/")) throw new Error(`Fixture ${key} escaped its owned root`);
	}
	mkdirSync(program.env.TMPDIR, { recursive: true, mode: 0o700 });
	const env = { ...process.env, ...program.env, OMP_KIT_LOAD_OVERRIDE: "0/32" } as Record<string, string>;
	const result = await run(program.argv, { cwd: f.home, env, deadline_s: 60 });
	const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
	if (result.rc !== 0) throw new Error(`scheduled consumer -> ${result.rc}: ${output}`);
	const receipt = JSON.parse(readFileSync(join(f.home, ".local", "state", "omp-kit", "jobs", "session-retain.json"), "utf8"));
	expect(receipt.retention).toMatchObject({ examined: 2, kept: 1, removed: [{ path: f.ingested, bytes: statSync(f.untracked).size }], ccVerified: false });
	expect(() => statSync(f.ingested)).toThrow();
	expect(statSync(f.untracked).isFile()).toBe(true);
	expect(statSync(f.boundary).isFile()).toBe(true);
	const journal = readFileSync(join(f.home, ".local", "state", "omp-kit", "jobs", "session-retain.log.jsonl"), "utf8")
		.trim().split("\n").map(line => JSON.parse(line));
	expect(journal.map(row => row.event)).toEqual(["planned", "removed"]);
}, 90_000);
test("session-retain reports old transcripts kept when CC state is missing", () => {
	const f = fixture(true);
	rmSync(join(f.root, "home", ".local", "state", "omp-kit", "cc"), { recursive: true });
	const result = retainOmpSessions(f.home, join(f.root, "missing-cc"), join(f.root, "jobs", "retention.log.jsonl"), f.now);
	expect(result).toMatchObject({ examined: 2, kept: 2, removed: [], ccVerified: false });
	expect(statSync(f.boundary).isFile()).toBe(true);
});
test("session-retain chooses the newest committed source tick, not wall-clock order", () => {
	const f = fixture();
	const info = statSync(f.ingested);
	const ccRoot = join(f.home, ".local", "state", "omp-kit", "cc");
	const db = new Database(join(ccRoot, "cc.db"));
	db.query("INSERT INTO events VALUES (2, 'source.tick', 'session', ?)").run(JSON.stringify({
		instance: "fixture", records_seen: 0, records_emitted: 0, records_ignored: 0, records_quarantined: 0,
		position: info.size + 1, error_code: null, complete_through_ms: f.now, coverage: [],
	}));
	db.query("INSERT INTO source_ticks VALUES (2, 'session', ?, ?, NULL)").run(f.now, info.size + 1);
	db.query("UPDATE source_ticks SET time_ms = ? WHERE cursor = 1").run(f.now + 60_000);
	db.close();
	const result = retainOmpSessions(f.home, ccRoot, join(f.root, "jobs", "retention.log.jsonl"), f.now);
	expect(result).toMatchObject({ examined: 2, kept: 2, removed: [], ccVerified: false });
	expect(statSync(f.ingested).isFile()).toBe(true);
});
