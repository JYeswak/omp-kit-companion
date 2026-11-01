import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retainAgentMailRotations } from "../../src/am-retain.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { KNOWN_JOBS, renderLaunchdPlist } from "../../src/service.ts";

afterAll(cleanupAllOwnedTmp);
const OLD = "rotation-20261020T000000Z";
const NEW = "rotation-20261027T030917Z";

function fixture() {
	const root = ownedTmp("am-retain-test").path;
	const store = join(root, "mail-store");
	const home = join(root, "home");
	const reclaimable = join(store, "doctor", "reclaimable");
	mkdirSync(store, { recursive: true });
	mkdirSync(home, { recursive: true });
	const rotation = (name: string, contents = "backup") => {
		const path = join(reclaimable, name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "storage.sqlite3.bak"), contents);
		return path;
	};
	return { root, store, home, reclaimable, rotation, record: join(root, "removed.jsonl") };
}

test("two rotations keep only the newest timestamp and durably record removed logical bytes", () => {
	const f = fixture();
	const old = f.rotation(OLD, "old");
	const newest = f.rotation(NEW, "keep");
	mkdirSync(join(old, "nested"));
	writeFileSync(join(old, "nested", "forensic.bin"), "nested");
	writeFileSync(join(f.store, "storage.sqlite3"), "canonical database");
	symlinkSync(join(f.store, "storage.sqlite3"), join(old, "database-pointer"));
	mkdirSync(join(f.reclaimable, "operator-files"));
	writeFileSync(join(f.reclaimable, "operator-files", "keep.txt"), "not a rotation");
	utimesSync(old, new Date("2026-10-30T00:00:00Z"), new Date("2026-10-30T00:00:00Z"));
	utimesSync(newest, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
	const result = retainAgentMailRotations(f.store, f.record);
	expect(result).toMatchObject({ kept: NEW, removed: [{ name: OLD, bytes: 9 }], bytesRemoved: 9 });
	expect(readdirSync(f.reclaimable).sort()).toEqual(["operator-files", NEW].sort());
	expect(readFileSync(join(newest, "storage.sqlite3.bak"), "utf8")).toBe("keep");
	expect(readFileSync(join(f.store, "storage.sqlite3"), "utf8")).toBe("canonical database");
	const events = readFileSync(f.record, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(events.map(({ event, name, bytes, kept }) => ({ event, name, bytes, kept }))).toEqual([
		{ event: "planned", name: OLD, bytes: 9, kept: NEW },
		{ event: "removed", name: OLD, bytes: 9, kept: NEW },
	]);
});

test("a repeated retention leaves the surviving rotation and deletion journal unchanged", () => {
	const f = fixture();
	f.rotation(OLD, "old");
	const newest = f.rotation(NEW, "new");
	retainAgentMailRotations(f.store, f.record);
	const before = readFileSync(f.record, "utf8");
	const result = retainAgentMailRotations(f.store, f.record);
	expect(result).toMatchObject({ kept: NEW, removed: [], bytesRemoved: 0, recordPath: null });
	expect(readFileSync(f.record, "utf8")).toBe(before);
	expect(readFileSync(join(newest, "storage.sqlite3.bak"), "utf8")).toBe("new");
});

test("a linked doctor directory never authorizes deletion outside the selected store", () => {
	const f = fixture();
	const outside = join(f.root, "outside");
	mkdirSync(join(outside, "reclaimable", OLD), { recursive: true });
	writeFileSync(join(outside, "reclaimable", OLD, "keep"), "outside");
	symlinkSync(outside, join(f.store, "doctor"));
	expect(() => retainAgentMailRotations(f.store, f.record)).toThrow("AM_RETAIN_UNSAFE_DIRECTORY");
	expect(readFileSync(join(outside, "reclaimable", OLD, "keep"), "utf8")).toBe("outside");
	expect(existsSync(f.record)).toBe(false);
});

test("a linked rotation cannot replace the newest retained backup", () => {
	const f = fixture();
	const old = f.rotation(OLD, "old");
	const outside = join(f.root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "keep"), "outside");
	symlinkSync(outside, join(f.reclaimable, NEW));
	expect(() => retainAgentMailRotations(f.store, f.record)).toThrow("AM_RETAIN_UNSAFE_DIRECTORY");
	expect(readFileSync(join(old, "storage.sqlite3.bak"), "utf8")).toBe("old");
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
});

test("a trailing-newline rotation name is refused before any deletion", () => {
	const f = fixture();
	const old = f.rotation(OLD, "old");
	const malformed = f.rotation(NEW + "\n", "unrecognized");
	expect(() => retainAgentMailRotations(f.store, f.record)).toThrow("AM_RETAIN_UNKNOWN_ROTATION");
	expect(readFileSync(join(old, "storage.sqlite3.bak"), "utf8")).toBe("old");
	expect(readFileSync(join(malformed, "storage.sqlite3.bak"), "utf8")).toBe("unrecognized");
});

test("an unwritable deletion record refuses before removing an older backup", () => {
	const f = fixture();
	const old = f.rotation(OLD, "old");
	const newest = f.rotation(NEW, "new");
	const blocked = join(f.root, "record-is-directory");
	mkdirSync(blocked);
	expect(() => retainAgentMailRotations(f.store, blocked)).toThrow();
	expect(readFileSync(join(old, "storage.sqlite3.bak"), "utf8")).toBe("old");
	expect(readFileSync(join(newest, "storage.sqlite3.bak"), "utf8")).toBe("new");
});

test.serial("the native scheduled argv and persisted root execute the real retention consumer", async () => {
	const f = fixture();
	f.rotation(OLD, "old");
	const newest = f.rotation(NEW, "new");
	const bun = Bun.which("bun");
	if (!bun) throw new Error("Bun is required for the source CLI fixture");
	const quote = (value: string) => "'" + value.split("'").join("'\\''") + "'";
	const launcher = join(f.root, "omp-kit");
	writeFileSync(launcher, `#!/bin/sh\nexec ${quote(bun)} run --no-env-file --config=/dev/null ${quote(join(import.meta.dir, "../../src/cli.ts"))} "$@"\n`);
	chmodSync(launcher, 0o755);
	const rootBefore = process.env.AGENT_MAIL_STORAGE_ROOT;
	const xdgBefore = process.env.XDG_STATE_HOME;
	const plist = join(f.root, "am-retain.plist");
	try {
		process.env.AGENT_MAIL_STORAGE_ROOT = f.store;
		process.env.XDG_STATE_HOME = join(f.home, ".local", "state");
		writeFileSync(plist, renderLaunchdPlist(f.home, KNOWN_JOBS["am-retain"]!, launcher, null).text);
	} finally {
		if (rootBefore === undefined) delete process.env.AGENT_MAIL_STORAGE_ROOT; else process.env.AGENT_MAIL_STORAGE_ROOT = rootBefore;
		if (xdgBefore === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = xdgBefore;
	}
	const parse = await run(["python3", "-c", `
import json, plistlib, sys
with open(sys.argv[1], "rb") as handle:
    data = plistlib.load(handle)
print(json.dumps({"argv": data["ProgramArguments"], "env": data["EnvironmentVariables"]}))
`, plist], { deadline_s: 60 });
	if (parse.rc !== 0) throw new Error(new TextDecoder().decode(parse.stderr));
	const program = JSON.parse(new TextDecoder().decode(parse.stdout));
	for (const key of ["HOME", "XDG_STATE_HOME", "TMPDIR"]) {
		if (!program.env[key].startsWith(f.root + "/")) throw new Error(`Fixture ${key} escaped its owned root`);
	}
	mkdirSync(program.env.TMPDIR, { recursive: true, mode: 0o700 });
	const env = { ...process.env } as Record<string, string>;
	delete env.AGENT_MAIL_STORAGE_ROOT;
	delete env.STORAGE_ROOT;
	Object.assign(env, program.env, { OMP_KIT_LOAD_OVERRIDE: "0/32" });
	const result = await run(program.argv, { cwd: f.home, env, deadline_s: 60 });
	if (result.rc !== 0) throw new Error(`scheduled consumer -> ${result.rc}: ${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`);
	expect(readdirSync(f.reclaimable)).toEqual([NEW]);
	expect(readFileSync(join(newest, "storage.sqlite3.bak"), "utf8")).toBe("new");
	const receipt = JSON.parse(readFileSync(join(f.home, ".local", "state", "omp-kit", "jobs", "am-retain.json"), "utf8"));
	expect(receipt.retention).toMatchObject({ kept: NEW, removed: [{ name: OLD, bytes: 3 }], bytesRemoved: 3 });
	const journal = readFileSync(receipt.retention.recordPath, "utf8");
	f.rotation(OLD, "old again");
	delete env.AGENT_MAIL_STORAGE_ROOT;
	const refused = await run(program.argv, { cwd: f.home, env, deadline_s: 60 });
	expect(refused.rc).not.toBe(0);
	expect(new TextDecoder().decode(refused.stdout) + new TextDecoder().decode(refused.stderr)).toContain("AM_RETAIN_ROOT_REQUIRED");
	expect(readdirSync(f.reclaimable).sort()).toEqual([OLD, NEW].sort());
	expect(readFileSync(receipt.retention.recordPath, "utf8")).toBe(journal);
}, 90_000);
