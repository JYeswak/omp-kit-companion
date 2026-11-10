import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { retainFleetCaches } from "../../src/cache-retain.ts";
import { observeServiceLaunchers } from "../../src/service-run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { privateLock } from "../../src/kitlib/lock.ts";

afterAll(cleanupAllOwnedTmp);
const DAY = 86_400_000;
const ROOT = resolve(import.meta.dir, "../..");

function fixture() {
	const root = ownedTmp("cache-retain-test").path;
	const home = join(root, "home");
	mkdirSync(home);
	const now = Date.now();
	const file = (relative: string, ageDays: number, text = relative) => {
		const path = join(home, relative);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, text);
		const at = new Date(now - ageDays * DAY);
		utimesSync(path, at, at);
		return path;
	};
	return { root, home, now, file, journal: join(root, "removed.jsonl") };
}

test("CACHERETAIN1 registered artifact families remove expired entries and retain fresh controls", async () => {
	const f = fixture();
	const families = [".omp/cache", ".omp/logs", ".omp/agent/cache", ".omp/profiles/inactive/agent/cache", ".local/state/omp-kit/receipts", ".local/state/omp-kit/chrome-jfp/Default/Cache"];
	const old = families.map(path => f.file(`${path}/old.log`, 120, "expired"));
	const fresh = families.map(path => f.file(`${path}/fresh.log`, 0, "fresh"));
	const cookies = f.file(".local/state/omp-kit/chrome-jfp/Default/Cookies", 120, "persistent login data");
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(result.overall).toBe("OK");
	expect(result.removed).toBe(6);
	for (const path of old) expect(existsSync(path)).toBe(false);
	for (const path of fresh) expect(readFileSync(path, "utf8")).toBe("fresh");
	expect(readFileSync(cookies, "utf8")).toBe("persistent login data");
	const events = readFileSync(f.journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(events.filter(row => row.event === "planned").length).toBe(6);
	expect(events.filter(row => row.event === "removed").length).toBe(6);
});

test("CACHERETAIN1 unknown open-file evidence preserves the old data instead of claiming cleanup", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/old.bin", 120, "keep without evidence");
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: null });
	expect(result.overall).toBe("UNVERIFIED");
	expect(result.removed).toBe(0);
	expect(readFileSync(old, "utf8")).toBe("keep without evidence");
	expect(existsSync(f.journal)).toBe(false);
});

test("CACHERETAIN1 a live profile and open log are held while an unrelated expired log is retired", async () => {
	const f = fixture();
	const cache = f.file(".omp/profiles/active/agent/cache/old.bin", 120, "live environment");
	const lease = f.file(".omp/profiles/active/agent/sessions/live.lock", 0);
	const openLog = f.file(".omp/logs/open.log", 120, "open");
	const idleLog = f.file(".omp/logs/idle.log", 120, "idle");
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set([lease, openLog]) });
	expect(readFileSync(cache, "utf8")).toBe("live environment");
	expect(readFileSync(openLog, "utf8")).toBe("open");
	expect(existsSync(idleLog)).toBe(false);
	expect(result.held).toBeGreaterThan(0);
});

test("CACHERETAIN1 a cache symlink never grants deletion of its outside target", async () => {
	const f = fixture();
	const outside = join(f.root, "outside");
	mkdirSync(outside);
	const sentinel = join(outside, "old.bin");
	writeFileSync(sentinel, "outside");
	const old = new Date(f.now - 120 * DAY);
	utimesSync(sentinel, old, old);
	mkdirSync(join(f.home, ".omp"));
	symlinkSync(outside, join(f.home, ".omp/cache"));
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(result.overall).toBe("FINDINGS");
	expect(result.removed).toBe(0);
	expect(readFileSync(sentinel, "utf8")).toBe("outside");
});

test("CACHERETAIN1 an immutable cache bundle is kept whole when any descendant is fresh", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/bundle/dependency.bin", 120, "old dependency");
	const current = f.file(".omp/cache/bundle/current.bin", 0, "current");
	const at = new Date(f.now - 120 * DAY);
	utimesSync(join(f.home, ".omp/cache/bundle"), at, at);
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(result.removed).toBe(0);
	expect(readFileSync(old, "utf8")).toBe("old dependency");
	expect(readFileSync(current, "utf8")).toBe("current");
});

test("CACHERETAIN1 rollback-linked receipts and SQLite sidecars are not ordinary expirable cache files", async () => {
	const f = fixture();
	const receipt = f.file(".local/state/omp-kit/receipts/recover.json", 120, "undo receipt");
	f.file(".local/state/omp-kit/backups/recover/original", 120);
	const database = f.file(".omp/cache/judgment-cache.db", 120, "database");
	const wal = f.file(".omp/cache/judgment-cache.db-wal", 120, "pending WAL");
	const old = f.file(".omp/cache/ordinary.bin", 120);
	await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(readFileSync(receipt, "utf8")).toBe("undo receipt");
	expect(readFileSync(database, "utf8")).toBe("database");
	expect(readFileSync(wal, "utf8")).toBe("pending WAL");
	expect(existsSync(old)).toBe(false);
});

test("CACHERETAIN1 the actual scheduled service body removes an expired fixture and keeps its fresh control", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/expired.bin", 120, "expired");
	const fresh = f.file(".omp/cache/fresh.bin", 0, "fresh");
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "service", "run", "cache-retain", "--json"], {
		cwd: ROOT, env: { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.home, ".local/state"), OMP_KIT_LOAD_OVERRIDE: "0/32" },
		deadline_s: 150, max_output_bytes: 1 << 20,
	});
	expect(result.rc, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)).toBe(0);
	const output = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(output.data.job).toBe("cache-retain");
	expect(existsSync(old)).toBe(false);
	expect(readFileSync(fresh, "utf8")).toBe("fresh");
}, 180_000);

// SVCLAUNCHHOME1: launcher scoping runs through the same `run` seam as ps, so the
// whole rule is unit-testable: a candidate whose lsof footprint touches nothing of
// ours is dropped; anything of unknown ownership is kept (fail closed).
test("CACHERETAIN1 scoped observation drops only a provably foreign launcher", () => {
 const f = fixture();
 const homeReal = realpathSync(f.home);
 const stateReal = realpathSync(f.root);
 const scope = { home: f.home, stateRoot: f.root };
 const psLine = (pid: number) => `  ${pid} /opt/bin/omp-kit service run cache-retain --json`;
 const lsofOut = (pid: number, rows: string[]) => [`p${pid}`, ...rows].join("\n") + "\n";
 const lsofByPid: Record<number, { code: number; stdout: string }> = {
  111: { code: 0, stdout: lsofOut(111, ["fcwd", "n/foreign/home", "ftxt", "n/foreign/home/bin/omp-kit"]) },
  222: { code: 0, stdout: lsofOut(222, ["fcwd", `n${homeReal}/jobs`, "ftxt", "n/usr/bin/omp-kit"]) },
  333: { code: 0, stdout: lsofOut(333, ["fcwd", "n/foreign/work", "f12", `n${stateReal}/jobs/cache-retain.lock/pid`]) },
  444: { code: 1, stdout: "" },
  555: { code: 0, stdout: lsofOut(555, ["ftxt", "n/usr/bin/omp-kit"]) },
  // A parallel fixture run: same repository cwd as this process, its own HOME elsewhere.
  666: { code: 0, stdout: lsofOut(666, ["fcwd", `n${realpathSync(process.cwd())}`, "f9", "n/sibling/home/.local/state/omp-kit/jobs/cache-retain.lock/pid"]) },
  // A launcher that exited between ps and lsof (a 1 ms run cap): lsof fails and ps no longer lists it.
  777: { code: 1, stdout: "" },
 };
 const seen: string[] = [];
 const fakeRun = (args: readonly string[]) => {
  if (args[0] === "ps" && args[1] === "-p") return args[2] === "777" ? { code: 1, stdout: "" } : { code: 0, stdout: `${args[2]}\n` };
  if (args[0] === "ps") return { code: 0, stdout: [psLine(111), psLine(222), psLine(333), psLine(444), psLine(555), psLine(666), psLine(777)].join("\n") + "\n" };
  if (args[0] === "lsof") {
   const pid = Number(args[2]);
   seen.push(args[2]!);
   const out = lsofByPid[pid];
   if (!out) throw new Error(`unexpected lsof pid ${args[2]}`);
   return out;
  }
  throw new Error(`unexpected command ${args[0]}`);
 };
 // Planted: the foreign-HOME launcher, the shared-cwd sibling and the exited launcher are dropped; every other launcher is kept.
 const observed = observeServiceLaunchers(fakeRun, "cache-retain", scope);
 if (!("launchers" in observed)) throw new Error("expected launchers, got " + JSON.stringify(observed));
 expect(observed.launchers.map(member => member.pid).sort((a, b) => a - b)).toEqual([222, 333, 444, 555]);
 expect(observed.launchers).toEqual(observed.launchers.map(member => ({ pid: member.pid, command: "service run cache-retain" })));
 // Controls: no scope keeps everything; the admitting process itself is never probed.
 const unscoped = observeServiceLaunchers(fakeRun, "cache-retain");
 if (!("launchers" in unscoped)) throw new Error("expected launchers, got " + JSON.stringify(unscoped));
 expect(unscoped.launchers.map(member => member.pid).sort((a, b) => a - b)).toEqual([111, 222, 333, 444, 555, 666, 777]);
 const ownLine = `  ${process.pid} /opt/bin/omp-kit service run cache-retain --json`;
 const withOwn = observeServiceLaunchers(args => args[0] === "ps"
  ? { code: 0, stdout: ownLine + "\n" }
  : (() => { throw new Error("own pid must never be probed"); })(), "cache-retain", scope);
 if (!("launchers" in withOwn)) throw new Error("expected launchers, got " + JSON.stringify(withOwn));
 expect(withOwn.launchers).toEqual([{ pid: process.pid, command: "service run cache-retain" }]);
 expect(seen.sort()).toEqual(["111", "222", "333", "444", "555", "666", "777"]);
});

test("CACHERETAIN1 selected state root expires only its receipts, not the default state's receipts", async () => {
	const f = fixture();
	const defaultReceipt = f.file(".local/state/omp-kit/receipts/default.json", 120, "not selected");
	const selectedState = join(f.root, "selected-state");
	const selectedReceipt = join(selectedState, "receipts/old.json");
	mkdirSync(join(selectedState, "receipts"), { recursive: true });
	writeFileSync(selectedReceipt, "selected");
	const at = new Date(f.now - 120 * DAY);
	utimesSync(selectedReceipt, at, at);
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set(), stateRoot: selectedState });
	expect(result.overall).toBe("OK");
	expect(existsSync(selectedReceipt)).toBe(false);
	expect(readFileSync(defaultReceipt, "utf8")).toBe("not selected");
});

test("CACHERETAIN1 a deletion journal symlink cannot authorize unrecorded removal", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/old.bin", 120, "preserve on journal refusal");
	const outside = join(f.root, "outside-journal");
	writeFileSync(outside, "outside");
	symlinkSync(outside, f.journal);
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(result.overall).toBe("FINDINGS");
	expect(result.removed).toBe(0);
	expect(readFileSync(old, "utf8")).toBe("preserve on journal refusal");
	expect(readFileSync(outside, "utf8")).toBe("outside");
});

test("CACHERETAIN1 deletion evidence redacts credential-shaped entry names before writing", async () => {
	const f = fixture();
	const token = ["ghp_", "SyntheticLettersAndDigits123456789"].join("");
	const old = f.file(`.omp/cache/${token}`, 120);
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(existsSync(old)).toBe(false);
	expect(result.removed).toBe(1);
	const journal = readFileSync(f.journal, "utf8");
	expect(journal).not.toContain(token);
	expect(journal).not.toContain(token.slice(0, 8));
});

test("CACHERETAIN1 the real open-file snapshot keeps a held log and retires an unrelated closed entry", async () => {
	const f = fixture();
	const held = f.file(".omp/logs/held.log", 120, "held by this process");
	const old = f.file(".omp/cache/old.bin", 120, "closed");
	const fresh = f.file(".omp/cache/fresh.bin", 0, "fresh");
	const fd = openSync(held, "r");
	try {
		const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now });
		expect(result.overall).toBe("OK");
		expect(readFileSync(held, "utf8")).toBe("held by this process");
		expect(existsSync(old)).toBe(false);
		expect(readFileSync(fresh, "utf8")).toBe("fresh");
	} finally { closeSync(fd); }
}, 30_000);

test("CACHERETAIN1 journal delay cannot delete a newly refreshed descendant", async () => {
	const f = fixture();
	const dependency = f.file(".omp/cache/bundle/dependency.bin", 120, "dependency");
	const current = f.file(".omp/cache/bundle/current.bin", 120, "old content");
	const at = new Date(f.now - 120 * DAY);
	utimesSync(join(f.home, ".omp/cache/bundle"), at, at);
	const gate = await privateLock({ namespace: "kitlib-jsonl", path: f.journal }, {
		state_dir: join(f.root, "cache-retain.locks"), deadline_s: 1,
	});
	const pending = retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	try { f.file(".omp/cache/bundle/current.bin", 0, "newly refreshed"); }
	finally { gate.release(); }
	const result = await pending;
	expect(result.removed).toBe(0);
	expect(readFileSync(current, "utf8")).toBe("newly refreshed");
	expect(readFileSync(dependency, "utf8")).toBe("dependency");
});

test("CACHERETAIN1 named browser namespaces and native daemon profiles expire cache leaves, not login data", async () => {
	const f = fixture();
	const paths = [
		".local/state/omp-kit/browser-profiles/named/Default",
		".omp/profiles/codex/run/daemons/fixture/omp.browser.headless.profile/Default",
	];
	const entries = paths.map(path => ({
		old: f.file(`${path}/Cache/expired.bin`, 120, "expired cache"),
		fresh: f.file(`${path}/Cache/fresh.bin`, 0, "fresh cache"),
		cookies: f.file(`${path}/Cookies`, 120, "login data"),
	}));
	await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	for (const entry of entries) {
		expect(existsSync(entry.old)).toBe(false);
		expect(readFileSync(entry.fresh, "utf8")).toBe("fresh cache");
		expect(readFileSync(entry.cookies, "utf8")).toBe("login data");
	}
});

test("CACHERETAIN1 named browser activity protects its owner without holding an unrelated cold profile", async () => {
	const f = fixture();
	const active = f.file(".local/state/omp-kit/browser-profiles/active/Default/Cache/old.bin", 120);
	const cookies = f.file(".local/state/omp-kit/browser-profiles/active/Default/Cookies", 120, "live login");
	const cold = f.file(".local/state/omp-kit/browser-profiles/cold/Default/Cache/old.bin", 120);
	await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set([cookies]) });
	expect(existsSync(active)).toBe(true);
	expect(readFileSync(cookies, "utf8")).toBe("live login");
	expect(existsSync(cold)).toBe(false);
});

test("CACHERETAIN1 a full retention journal refuses new removals without losing existing evidence", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/expired.bin", 120, "preserved without journal capacity");
	const evidence = `{"previous":"${"x".repeat(8 << 20)}"}\n`;
	writeFileSync(f.journal, evidence, { mode: 0o600 });
	const result = await retainFleetCaches(f.home, f.journal, { nowMs: f.now, openFiles: new Set() });
	expect(result.overall).toBe("FINDINGS");
	expect(result.removed).toBe(0);
	expect(readFileSync(old, "utf8")).toBe("preserved without journal capacity");
	expect(readFileSync(f.journal, "utf8")).toBe(evidence);
});

test("CACHERETAIN1 a forged delegated worker cannot remove an expired cache entry", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/expired.bin", 120, "not authorized");
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "service", "run", "cache-retain", "--json"], {
		cwd: ROOT, env: { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.home, ".local/state"),
			OMP_KIT_CACHE_RETAIN_CLAIM: "forged", OMP_KIT_LOAD_OVERRIDE: "0/32" },
		deadline_s: 20, max_output_bytes: 1 << 20,
	});
	expect(result.rc).toBe(2);
	expect(JSON.parse(new TextDecoder().decode(result.stdout)).errors[0].code).toBe("CACHE_RETAIN_KEEPER_CHANGED");
	expect(readFileSync(old, "utf8")).toBe("not authorized");
}, 30_000);

test("CACHERETAIN1 the real service deadline stops its worker before an expired entry is removed", async () => {
	const f = fixture();
	const old = f.file(".omp/cache/expired.bin", 120, "not removed after timeout");
	const result = await run([process.execPath, join(ROOT, "src/cli.ts"), "service", "run", "cache-retain", "--json"], {
		cwd: ROOT, env: { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.home, ".local/state"),
			OMP_KIT_LOAD_OVERRIDE: "0/32", OMP_KIT_RUN_CAP_MS: "1" },
		deadline_s: 20, max_output_bytes: 1 << 20,
	});
	expect(result.rc).toBe(1);
	expect(JSON.parse(new TextDecoder().decode(result.stdout)).data.receipt.status).toBe("TIMEOUT");
	expect(readFileSync(old, "utf8")).toBe("not removed after timeout");
}, 30_000);
