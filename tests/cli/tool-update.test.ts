import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { githubApiBase, githubApiHeaders } from "../../src/tool-update.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const AGENT_TMP = join(root, "var", "agent-tmp");

function stubScript(version: string): string {
	return `#!/bin/sh
cmd=""
for a in "$@"; do
  case "$a" in version|status|ls|restart|start) cmd="$a";; esac
done
F="\${OVNFS_FIXTURE_DIR:?missing fixture}"
case "$cmd" in
  version) echo "ovnfs v${version} test darwin/arm64";;
  status)
    if [ -f "$F/down" ]; then echo '{"error":"daemon down"}'; exit 1; fi
    c=$(cat "$F/count.txt")
    p=$(cat "$F/pid.txt")
    printf '{"version":5,"pid":%s,"uptime_s":1,"proto":"nfs","port":0,"mount":"x","state":"y","socket":"z","checkouts":%s,"snapshots":0,"bases":0,"layers":0}\\n' "$p" "$c";;
  ls) cat "$F/ls.json";;
  restart)
    if [ -f "$F/drift_ls" ]; then cp "$F/drift_ls" "$F/ls.json"; cp "$F/drift_count" "$F/count.txt"; fi
    if [ -f "$F/fail_restart" ]; then touch "$F/down"; exit 1; fi
    echo "restarted";;
  start) rm -f "$F/down"; echo "started";;
  *) echo "usage: stub ovnfs" >&2; exit 2;;
esac
`;
}

type Fixture = {
	work: string;
	home: string;
	bin: string;
	stateDir: string;
	releaseDir: string;
	skillDst: string;
	fixtureDir: string;
	installed: string;
	latest: string;
};

function setupFixture(opts: {
	installed: string;
	latest: string;
	failRestart: boolean;
	checksumOk: boolean;
	serveLines: string[];
	lsNames: string[];
	drift?: string[];
}): Fixture {
	const owned = ownedTmp("tool-update", { root: AGENT_TMP });
	const work = owned.path;
	// Caller cleans up via cleanup handle stored on the path; keep it simple: register cleanup through the owned object.
	// Bun test files in this repo clean ownedTmp explicitly; we return the cleanup through a side table.
	cleanups.push({ work, cleanup: () => owned.cleanup() });
	const home = join(work, "home");
	const binDir = join(work, "bin");
	const stateDir = join(work, "state");
	const releaseDir = join(work, "release");
	const skillDir = join(work, "skill");
	const fixtureDir = join(work, "fixture");
	for (const dir of [home, binDir, stateDir, releaseDir, skillDir, fixtureDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const bin = join(binDir, "ovnfs");
	writeFileSync(bin, stubScript(opts.installed), { mode: 0o755 });
	chmodSync(bin, 0o755);
	writeFileSync(join(fixtureDir, "count.txt"), String(opts.lsNames.length));
	writeFileSync(join(fixtureDir, "pid.txt"), "4242");
	const rows = opts.lsNames.map(name => ({ name, path: name, source: "fixture", dirty: false, created: "2026-01-01T00:00:00Z", touched: "2026-01-01T00:00:00Z" }));
	writeFileSync(join(fixtureDir, "ls.json"), JSON.stringify({ checkouts: rows }));
	if (opts.drift !== undefined) {
		const driftRows = opts.drift.map(name => ({ name, path: name, source: "fixture", dirty: false, created: "2026-01-01T00:00:00Z", touched: "2026-01-01T00:00:00Z" }));
		writeFileSync(join(fixtureDir, "drift_ls"), JSON.stringify({ checkouts: driftRows }));
		writeFileSync(join(fixtureDir, "drift_count"), String(opts.drift.length));
	}
	if (opts.failRestart) writeFileSync(join(fixtureDir, "fail_restart"), "1");
	writeFileSync(join(releaseDir, "latest.json"), JSON.stringify({ version: opts.latest }));
	const stage = join(work, "stage");
	mkdirSync(stage, { recursive: true, mode: 0o700 });
	const newBin = join(stage, "ovnfs");
	writeFileSync(newBin, stubScript(opts.latest), { mode: 0o755 });
	chmodSync(newBin, 0o755);
	const tarPath = join(releaseDir, `ovnfs_${opts.latest}_darwin_arm64.tar.gz`);
	const tar = runFixture(["python3", "-c", "import sys, tarfile; f = tarfile.open(sys.argv[1], 'w:gz', format=tarfile.USTAR_FORMAT); f.add(sys.argv[2], arcname='ovnfs'); f.close()", tarPath, newBin], { cwd: root, floor_s: fixtureDeadlineS(10) });
	if (tar.rc !== 0) throw new Error("fixture tar failed");
	const tarBytes = readFileSync(tarPath);
	const digest = createHash("sha256").update(tarBytes).digest("hex");
	writeFileSync(join(releaseDir, `ovnfs_${opts.latest}_checksums.txt`), `${digest}  ovnfs_${opts.latest}_darwin_arm64.tar.gz\n`);
	if (!opts.checksumOk && tarBytes.length > 10) {
		const mutated = Buffer.from(tarBytes);
		mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 1;
		writeFileSync(tarPath, mutated);
	}
	writeFileSync(join(releaseDir, "SKILL.md"), `# ovnfs skill\n\novnfs release ${opts.latest}\n`);
	const skillDst = join(skillDir, "SKILL.md");
	writeFileSync(skillDst, `# ovnfs skill\n\novnfs release ${opts.installed}\n`);
	writeFileSync(join(stateDir, "serve.log"), `${opts.serveLines.join("\n")}\n`);
	const orphanDir = join(stateDir, "uppers", "orphan1", "var");
	mkdirSync(orphanDir, { recursive: true, mode: 0o755 });
	const orphanFile = join(orphanDir, "edition.bin");
	writeFileSync(orphanFile, "orphan-bytes");
	chmodSync(orphanDir, 0o555);
	chmodSync(join(stateDir, "uppers", "orphan1"), 0o555);
	chmodSync(orphanFile, 0o444);
	const liveDir = join(stateDir, "uppers", "live1", "var");
	mkdirSync(liveDir, { recursive: true, mode: 0o755 });
	const liveFile = join(liveDir, "edition.bin");
	writeFileSync(liveFile, "live-bytes");
	chmodSync(liveFile, 0o444);
	return { work, home, bin, stateDir, releaseDir, skillDst, fixtureDir, installed: opts.installed, latest: opts.latest };
}

type FixtureCleanup = { work: string; cleanup: () => void };
const cleanups: FixtureCleanup[] = [];

/** fixture uppers intentionally ship r-x dirs (the orphan-upper shape); an
 * ovnfs checkout cannot remove those, so the owner write bit goes back on
 * before teardown, even when the test body failed. Symlinks are never
 * followed and nothing is removed here; ownedTmp owns removal. */
function restoreWritableDirs(root: string): void {
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) stack.push(join(dir, entry.name));
		}
		try {
			const mode = statSync(dir).mode & 0o7777;
			if ((mode & 0o200) === 0) chmodSync(dir, mode | 0o700);
		} catch { /* best effort; the teardown assertion below reports */ }
	}
}

function assertNoNonWritableDirs(root: string): void {
	const bad: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) stack.push(join(dir, entry.name));
		}
		try {
			if ((statSync(dir).mode & 0o200) === 0) bad.push(dir);
		} catch { /* unreadable paths are reported by removal, not here */ }
	}
	expect(bad).toEqual([]);
}

function cleanupAll(): void {
	let firstError: unknown = null;
	while (cleanups.length > 0) {
		const item = cleanups.pop()!;
		try {
			restoreWritableDirs(item.work);
			assertNoNonWritableDirs(item.work);
		} catch (error) { firstError ??= error; }
		try { item.cleanup(); } catch (error) { firstError ??= error; }
	}
	if (firstError !== null) throw firstError;
}

function cliEnv(fx: Fixture, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	const homeState = join(fx.home, ".local", "state");
	return {
		...process.env,
		HOME: fx.home,
		TMPDIR: fx.work,
		XDG_CONFIG_HOME: join(fx.home, "config"),
		XDG_STATE_HOME: homeState,
		XDG_CACHE_HOME: join(fx.home, "cache"),
		OMP_KIT_CC_SPOOL: undefined,
		OMP_KIT_FLEET_WATCH_CONFIG: join(fx.home, "absent.json"),
		OMP_KIT_OVNFS_BIN: fx.bin,
		OMP_KIT_OVNFS_STATE: fx.stateDir,
		OMP_KIT_OVNFS_SKILL_DST: fx.skillDst,
		OMP_KIT_OVNFS_FAKE_RELEASE_DIR: fx.releaseDir,
		OVNFS_FIXTURE_DIR: fx.fixtureDir,
		...extra,
	};
}

function runUpdate(fx: Fixture, args: string[], extraEnv: Record<string, string | undefined> = {}): { rc: number | null; data: Record<string, unknown> } {
	const result = runFixture([process.execPath, "src/cli.ts", "tools", "update", "ovnfs", ...args, "--json"], {
		cwd: root, floor_s: fixtureDeadlineS(30), env: cliEnv(fx, extraEnv),
	});
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	let envelope: { data: Record<string, unknown> };
	try {
		envelope = JSON.parse(stdout) as { data: Record<string, unknown> };
	} catch {
		throw new Error(`tools update printed no JSON (rc=${result.rc}): stdout=${stdout.slice(0, 1024)} stderr=${stderr.slice(0, 2048)}`);
	}
	return { rc: result.rc, data: envelope.data };
}

function modesOf(fx: Fixture): Record<string, number> {
	const paths = [
		join(fx.stateDir, "uppers", "orphan1"),
		join(fx.stateDir, "uppers", "orphan1", "var"),
		join(fx.stateDir, "uppers", "orphan1", "var", "edition.bin"),
		join(fx.stateDir, "uppers", "live1", "var", "edition.bin"),
	];
	const out: Record<string, number> = {};
	for (const path of paths) {
		try { out[path] = statSync(path).mode & 0o7777; } catch { out[path] = -1; }
	}
	return out;
}

function binVersion(fx: Fixture, binPath: string): string {
	const result = runFixture([binPath, "version"], { cwd: root, floor_s: fixtureDeadlineS(10), env: cliEnv(fx) });
	return new TextDecoder().decode(result.stdout);
}

test("OVNFSTRACK1: newer release installs and swaps, proven loaded", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["2026/11/11 mounted at x"], lsNames: ["live1", "live2"] });
	try {
		const beforeModes = modesOf(fx);
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(0);
		expect(out.data["overall"]).toBe("UPDATED");
		expect(out.data["swap"]).toBe("SWAPPED");
		expect(String(binVersion(fx, fx.bin))).toContain("v1.0.1");
		expect(existsSync(`${fx.bin}.prev`)).toBe(true);
		expect(String(binVersion(fx, `${fx.bin}.prev`))).toContain("v1.0.0");
		expect(readFileSync(fx.skillDst, "utf8")).toContain("1.0.1");
		expect(out.data["checkouts"]).toBe(2);
		expect(modesOf(fx)).toEqual(beforeModes);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: failing daemon rolls back and names the blocking upper", async () => {
	const stateLine = "checkouts: unlinkat STATE/uppers/orphan1/var/edition.bin: permission denied";
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: true, checksumOk: true, serveLines: ["2026/11/11 mounted at x", stateLine, `checkouts: unlinkat ${"X"}/uppers/live1/var/edition.bin: permission denied`], lsNames: ["live1", "live2"] });
	try {
		const beforeModes = modesOf(fx);
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(1);
		expect(out.data["overall"]).toBe("FAILED");
		expect(String(out.data["code"] ?? "")).toContain("TOOL_UPDATE_DAEMON_LOAD_FAILED");
		expect(String(binVersion(fx, fx.bin))).toContain("v1.0.0");
		const reason = String(out.data["reason"] ?? "");
		expect(reason.includes("orphan1")).toBe(true);
		expect(reason.includes("orphan upper orphan1")).toBe(true);
		expect(modesOf(fx)).toEqual(beforeModes);
		const status = runFixture([fx.bin, "--json", "status"], { cwd: root, floor_s: fixtureDeadlineS(10), env: cliEnv(fx) });
		expect(status.rc).toBe(0);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: planted negative without rollback leaves the daemon down", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: true, checksumOk: true, serveLines: ["checkouts: unlinkat S/uppers/orphan1/var/edition.bin: permission denied"], lsNames: ["live1"] });
	try {
		const out = runUpdate(fx, ["--apply"], { OMP_KIT_OVNFS_DISABLE_ROLLBACK: "1" });
		expect(out.rc).toBe(1);
		expect(out.data["overall"]).toBe("FAILED");
		expect(String(binVersion(fx, fx.bin))).toContain("v1.0.1");
		const down = runFixture([fx.bin, "--json", "status"], { cwd: root, floor_s: fixtureDeadlineS(10), env: cliEnv(fx) });
		expect(down.rc).not.toBe(0);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: checksum mismatch refuses before replacing anything", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: false, serveLines: ["ok"], lsNames: ["live1"] });
	try {
		const beforeBin = readFileSync(fx.bin);
		const beforeSkill = readFileSync(fx.skillDst, "utf8");
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(2);
		expect(out.data["overall"]).toBe("REFUSED");
		expect(String(out.data["code"] ?? "")).toContain("TOOL_UPDATE_CHECKSUM_MISMATCH");
		expect(readFileSync(fx.bin)).toEqual(beforeBin);
		expect(existsSync(`${fx.bin}.prev`)).toBe(false);
		expect(readFileSync(fx.skillDst, "utf8")).toBe(beforeSkill);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: same version is a no-op", async () => {
	const fx = setupFixture({ installed: "1.0.1", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["ok"], lsNames: ["live1"] });
	try {
		const beforeBin = readFileSync(fx.bin);
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(0);
		expect(out.data["overall"]).toBe("CURRENT");
		expect(readFileSync(fx.bin)).toEqual(beforeBin);
		expect(existsSync(`${fx.bin}.prev`)).toBe(false);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: skill destination falls back to the packaged config", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["2026/11/11 mounted at x"], lsNames: ["live1"] });
	try {
		const out = runUpdate(fx, ["--apply"], { OMP_KIT_OVNFS_SKILL_DST: undefined });
		expect(out.rc).toBe(0);
		expect(out.data["overall"]).toBe("UPDATED");
		const expected = join(fx.home, ".claude", "skills", "ovnfs", "SKILL.md");
		expect(out.data["skill"]).toBe(expected);
		expect(readFileSync(expected, "utf8")).toContain("1.0.1");
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: count drift is accepted when pre-swap checkouts persist", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["2026/11/11 mounted at x"], lsNames: ["live1", "live2"], drift: ["live1", "live2", "live3"] });
	try {
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(0);
		expect(out.data["overall"]).toBe("UPDATED");
		expect(out.data["checkouts"]).toBe(3);
		expect(out.data["drift"]).toEqual({ before: 2, after: 3 });
		expect(String(binVersion(fx, fx.bin))).toContain("v1.0.1");
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: vanished pre-swap checkouts roll back", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["2026/11/11 mounted at x"], lsNames: ["live1", "live2"], drift: ["live1"] });
	try {
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(1);
		expect(out.data["overall"]).toBe("FAILED");
		expect(String(out.data["reason"] ?? "")).toContain("live2");
		expect(String(binVersion(fx, fx.bin))).toContain("v1.0.0");
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: symlinked binary refuses without writing through", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["ok"], lsNames: ["live1"] });
	try {
		const realBin = join(fx.work, "real-ovnfs");
		writeFileSync(realBin, stubScript("1.0.0"), { mode: 0o755 });
		chmodSync(realBin, 0o755);
		const targetBefore = readFileSync(realBin);
		rmSync(fx.bin);
		symlinkSync(realBin, fx.bin);
		expect(lstatSync(fx.bin).isSymbolicLink()).toBe(true);
		const out = runUpdate(fx, ["--apply"]);
		expect(out.rc).toBe(2);
		expect(out.data["overall"]).toBe("REFUSED");
		expect(String(out.data["code"] ?? "")).toContain("TOOL_UPDATE_BIN_UNSAFE");
		expect(readlinkSync(fx.bin)).toBe(realBin);
		expect(readFileSync(realBin)).toEqual(targetBefore);
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);

test("OVNFSTRACK1: publisher fetch sends identity and never prints the token", () => {
	const savedGithub = process.env.GITHUB_TOKEN, savedGh = process.env.GH_TOKEN, savedApi = process.env.OMP_KIT_OVNFS_GITHUB_API;
	try {
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
		const bare = githubApiHeaders();
		expect(bare["User-Agent"]?.startsWith("omp-kit/")).toBe(true);
		expect("Authorization" in bare).toBe(false);
		process.env.GITHUB_TOKEN = "sentinel-token-xyz";
		const authed = githubApiHeaders();
		expect(authed.Authorization).toBe("Bearer sentinel-token-xyz");
		expect(githubApiBase()).toBe("https://api.github.com");
		process.env.OMP_KIT_OVNFS_GITHUB_API = "http://127.0.0.1:1/";
		expect(githubApiBase()).toBe("http://127.0.0.1:1");
	} finally {
		if (savedGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedGithub;
		if (savedGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedGh;
		if (savedApi === undefined) delete process.env.OMP_KIT_OVNFS_GITHUB_API; else process.env.OMP_KIT_OVNFS_GITHUB_API = savedApi;
	}
}, fixtureDeadlineS(30) * 1000);

test("OVNFSTRACK1: service tick treats offline lookup as a quiet no-op", async () => {
	const fx = setupFixture({ installed: "1.0.0", latest: "1.0.1", failRestart: false, checksumOk: true, serveLines: ["ok"], lsNames: ["live1"] });
	try {
		const env = cliEnv(fx, { OMP_KIT_OVNFS_GITHUB_API: "http://127.0.0.1:1/", GITHUB_TOKEN: "sentinel-token-xyz", OMP_KIT_OVNFS_FAKE_RELEASE_DIR: undefined });
		const result = runFixture([process.execPath, "src/cli.ts", "service", "run", "tool-update", "--json"], {
			cwd: root, floor_s: fixtureDeadlineS(60), env,
		});
		const stdout = new TextDecoder().decode(result.stdout);
		const stderr = new TextDecoder().decode(result.stderr);
		expect(stdout.includes("sentinel-token-xyz") || stderr.includes("sentinel-token-xyz")).toBe(false);
		const envelope = JSON.parse(stdout) as { data: Record<string, unknown> };
		expect(result.rc).toBe(0);
		expect(envelope.data["overall"]).toBe("OK");
		expect(envelope.data["status"]).toBe("LOOKUP_UNAVAILABLE");
	} finally { cleanupAll(); }
}, fixtureDeadlineS(120) * 1000);
