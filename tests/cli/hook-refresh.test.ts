// hook-refresh.test.ts — HOOKREFRESHALL1 (ompkit-1ra0d.77): the refresh write
// set is every fleet-watch session repo that already has kit hook members
// installed, whatever its pullEnabled; the census reads the active release's
// install-commit-msg-bead.sh --check output, so no hand-kept member list
// exists in src/hook-refresh.ts.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
	censusHookFreshness,
	dirHasKitMembers,
	inspectHooks,
	installedHookRepos,
	liveHookFreshnessIo,
	liveHookRefreshIo,
	parseCheckMembers,
	refreshFleetHooks,
} from "../../src/hook-refresh.ts";
import type { HookCheckResult, HookFreshnessIo, HookRefreshIo } from "../../src/hook-refresh.ts";
import { applyActivationManifest } from "../../src/activation.ts";
import { diagnose } from "../../src/diagnostics.ts";
import { run } from "../../src/kitlib/run.ts";
import { runFixture, fixtureDeadlineS } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

const MEMBER_A = "hooks.d/pre-commit/40-omp-kit-probe-a";
const MEMBER_B = "hooks.d/commit-msg/41-omp-kit-probe-b";

const FRESH_OUT = (repo: string) => `install-commit-msg-bead: hooks fresh in ${repo}\n`;
const staleOut = (dest: string, src: string) =>
	`install-commit-msg-bead: STALE installed member: ${dest} differs from ${src}; rerun install-commit-msg-bead.sh\n`;

const gitEnv = (base: string) => ({ ...process.env, GIT_CEILING_DIRECTORIES: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

function fixtureSources(kit: string): { srcA: string; srcB: string } {
	const srcA = join(kit, "scripts", "probe-a.sh");
	const srcB = join(kit, "scripts", "probe-b.sh");
	mkdirSync(join(kit, "scripts"), { recursive: true });
	writeFileSync(srcA, "# probe-a source\n");
	writeFileSync(srcB, "# probe-b source\n");
	return { srcA, srcB };
}

function installMember(hooksDir: string, rel: string, bytes: string): string {
	const dest = join(hooksDir, rel);
	mkdirSync(join(dest, ".."), { recursive: true });
	writeFileSync(dest, bytes);
	return dest;
}

function memIo(kit: string, repos: { repo: string; hooksDir: string; tracked: boolean }[], opts?: {
	checks?: Record<string, HookCheckResult | HookCheckResult[]>;
	present?: (dir: string) => boolean;
}): HookFreshnessIo {
	// No digest cache: refresh reads before AND after the installer, so each
	// read must hit the filesystem live (the production io has no cache).
	const digest = (path: string): string | null => {
		try {
			return sha(readFileSync(path));
		} catch {
			return null;
		}
	};
	return {
		repos: () => repos.map((row) => ({ repo: row.repo, source: "t" })),
		kitRoot: () => kit,
		digest,
		hooksDir: (repo) => {
			const found = repos.find((row) => resolve(row.repo) === resolve(repo));
			return found ? { dir: found.hooksDir, config: null, tracked: found.tracked } : { dir: null, config: null, tracked: false };
		},
		check: async (repo) => {
			const canned = opts?.checks?.[resolve(repo)];
			if (Array.isArray(canned)) return canned.length > 0 ? canned.shift() as HookCheckResult : { rc: 0, output: FRESH_OUT(repo) };
			return canned ?? { rc: 0, output: FRESH_OUT(repo) };
		},
		hasKitMembers: opts?.present ?? (() => true),
	};
}

test("installer --check output drives the census: a stale member is STALE, a clean repo is FRESH", async () => {
	const scratch = ownedTmp("hookrefresh-census", { bead: "ompkit-1ra0d.77" });
	try {
		const kit = join(scratch.path, "kit");
		const { srcA, srcB } = fixtureSources(kit);
		const staleDir = join(scratch.path, "stale-hooks");
		const freshDir = join(scratch.path, "fresh-hooks");
		const destA = installMember(staleDir, MEMBER_A, "# OLD probe-a\n");
		installMember(staleDir, MEMBER_B, readFileSync(srcB, "utf8"));
		installMember(freshDir, MEMBER_A, readFileSync(srcA, "utf8"));
		installMember(freshDir, MEMBER_B, readFileSync(srcB, "utf8"));
		const io = memIo(kit, [
			{ repo: "/stale", hooksDir: staleDir, tracked: false },
			{ repo: "/fresh", hooksDir: freshDir, tracked: false },
		], {
			checks: {
				[resolve("/stale")]: { rc: 3, output: staleOut(destA, srcA) },
				[resolve("/fresh")]: { rc: 0, output: FRESH_OUT("/fresh") },
			},
		});
		const rows = await censusHookFreshness(io);
		const stale = rows.find((row) => row.repo === resolve("/stale"))!;
		const fresh = rows.find((row) => row.repo === resolve("/fresh"))!;
		expect(stale.state).toBe("STALE");
		expect(stale.stale).toEqual([MEMBER_A]);
		expect(fresh.state).toBe("FRESH");
		expect(fresh.members).toEqual([]);
		const findings = await inspectHooks(io);
		expect(findings[0]!.status).toBe("DEGRADED");
		expect(findings[0]!.reason).toContain(MEMBER_A);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("planted: refresh copies the source over the old member; the fresh member keeps its digest", async () => {
	const scratch = ownedTmp("hookrefresh-refresh", { bead: "ompkit-1ra0d.77" });
	try {
		const kit = join(scratch.path, "kit");
		const { srcA, srcB } = fixtureSources(kit);
		const staleDir = join(scratch.path, "stale-hooks");
		const freshDir = join(scratch.path, "fresh-hooks");
		const destA = installMember(staleDir, MEMBER_A, "# OLD probe-a\n");
		installMember(staleDir, MEMBER_B, readFileSync(srcB, "utf8"));
		const freshDestA = installMember(freshDir, MEMBER_A, readFileSync(srcA, "utf8"));
		installMember(freshDir, MEMBER_B, readFileSync(srcB, "utf8"));
		const beforeA = sha(readFileSync(destA, "utf8"));
		const freshBefore = sha(readFileSync(freshDestA, "utf8"));
		const base = memIo(kit, [
			{ repo: "/stale", hooksDir: staleDir, tracked: false },
			{ repo: "/fresh", hooksDir: freshDir, tracked: false },
		], {
			checks: {
				[resolve("/stale")]: [{ rc: 3, output: staleOut(destA, srcA) }, { rc: 0, output: FRESH_OUT("/stale") }],
				[resolve("/fresh")]: [{ rc: 0, output: FRESH_OUT("/fresh") }, { rc: 0, output: FRESH_OUT("/fresh") }],
			},
		});
		// The installer seam: copy every source byte over the installed member.
		const runInstaller = (repo: string) => {
			const dir = resolve(repo) === resolve("/stale") ? staleDir : freshDir;
			writeFileSync(join(dir, MEMBER_A), readFileSync(srcA));
			writeFileSync(join(dir, MEMBER_B), readFileSync(srcB));
			return { ok: true, detail: "seam copied sources" };
		};
		const report = await refreshFleetHooks({ ...base, pullRepos: () => [{ repo: "/stale", source: "t:s" }, { repo: "/fresh", source: "t:f" }], runInstaller });
		expect(report.refreshed).toBe(1);
		expect(report.fresh).toBe(1);
		const staleResult = report.results.find((row) => row.repo === resolve("/stale"))!;
		const staleMember = staleResult.members.find((row) => row.member === MEMBER_A)!;
		expect(staleMember.before_sha256).toBe(beforeA);
		expect(staleMember.after_sha256).toBe(sha(readFileSync(srcA, "utf8")));
		expect(staleMember.refreshed).toBe(true);
		const freshMember = report.results.find((row) => row.repo === resolve("/fresh"))!
			.members.find((row) => row.member === MEMBER_A)!;
		expect(freshMember).toBeUndefined();
		expect(freshBefore).toBe(sha(readFileSync(freshDestA, "utf8")));
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("a tracked hooks path records PENDING_COMMIT and leaves the commit to the director", async () => {
	const scratch = ownedTmp("hookrefresh-tracked", { bead: "ompkit-1ra0d.77" });
	try {
		const kit = join(scratch.path, "kit");
		const { srcA } = fixtureSources(kit);
		const repo = join(scratch.path, "repo");
		const env = gitEnv(scratch.path);
		expect(runFixture(["git", "init", "-q", repo], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "user.email", "test@example.com"], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "user.name", "test"], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "core.hooksPath", ".githooks"], { cwd: scratch.path, env }).rc).toBe(0);
		const githooks = join(repo, ".githooks");
		const destA = installMember(githooks, MEMBER_A, "# OLD probe-a\n");
		expect(runFixture(["git", "-C", repo, "add", "."], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "commit", "-qm", "track probe member"], { cwd: scratch.path, env }).rc).toBe(0);
		const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
		const headBefore = text(runFixture(["git", "-C", repo, "rev-parse", "HEAD"], { cwd: scratch.path, env }).stdout).trim();
		expect(headBefore).toMatch(/^[0-9a-f]{40}$/);
		const base = memIo(kit, [{ repo, hooksDir: githooks, tracked: true }], {
			checks: { [resolve(repo)]: [{ rc: 3, output: staleOut(destA, srcA) }, { rc: 0, output: FRESH_OUT(repo) }] },
		});
		const report = await refreshFleetHooks({
			...base,
			pullRepos: () => [{ repo, source: "t:tracked" }],
			runInstaller: () => { writeFileSync(destA, readFileSync(srcA)); return { ok: true, detail: "seam refreshed the member" }; },
		});
		expect(report.pending_commit).toBe(1);
		expect(report.results[0]!.status).toBe("PENDING_COMMIT");
		expect(report.results[0]!.paths).toEqual([destA]);
		// The refresh never commits: HEAD is unchanged and the refreshed tracked member is left for its owner.
		expect(text(runFixture(["git", "-C", repo, "rev-parse", "HEAD"], { cwd: scratch.path, env }).stdout).trim()).toBe(headBefore);
		expect(text(runFixture(["git", "-C", repo, "status", "--porcelain"], { cwd: scratch.path, env }).stdout)).toContain(".githooks/");
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("a tracked hooks dir whose refreshed members are untracked is REFRESHED, not PENDING_COMMIT", async () => {
	const scratch = ownedTmp("hookrefresh-ignored", { bead: "ompkit-1ra0d.77" });
	try {
		const kit = join(scratch.path, "kit");
		const { srcA, srcB } = fixtureSources(kit);
		const repo = join(scratch.path, "repo");
		const env = gitEnv(scratch.path);
		expect(runFixture(["git", "init", "-q", repo], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "user.email", "test@example.com"], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "user.name", "test"], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "config", "core.hooksPath", ".githooks"], { cwd: scratch.path, env }).rc).toBe(0);
		const githooks = join(repo, ".githooks");
		// Only a repo-owned member is tracked; the kit members are installer-owned deployment artifacts.
		mkdirSync(join(githooks, "hooks.d/pre-commit"), { recursive: true });
		writeFileSync(join(githooks, "hooks.d/pre-commit/10-repo-owned"), "#!/bin/sh\nexit 0\n");
		expect(runFixture(["git", "-C", repo, "add", "."], { cwd: scratch.path, env }).rc).toBe(0);
		expect(runFixture(["git", "-C", repo, "commit", "-qm", "track repo-owned member"], { cwd: scratch.path, env }).rc).toBe(0);
		const destA = installMember(githooks, MEMBER_A, "# OLD probe-a\n");
		installMember(githooks, MEMBER_B, readFileSync(srcB, "utf8"));
		const base = memIo(kit, [{ repo, hooksDir: githooks, tracked: true }], {
			checks: { [resolve(repo)]: [{ rc: 3, output: staleOut(destA, srcA) }, { rc: 0, output: FRESH_OUT(repo) }] },
		});
		const report = await refreshFleetHooks({
			...base,
			pullRepos: () => [{ repo, source: "t:ignored" }],
			runInstaller: () => {
				writeFileSync(destA, readFileSync(srcA));
				return { ok: true, detail: "seam refreshed all members" };
			},
		});
		expect(report.pending_commit).toBe(0);
		expect(report.refreshed).toBe(1);
		expect(report.results[0]!.status).toBe("REFRESHED");
		expect(report.results[0]!.paths).toEqual([destA]);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("planted negative: an installer that leaves stale bytes is FAILED, never reported refreshed", async () => {
	const scratch = ownedTmp("hookrefresh-failed", { bead: "ompkit-1ra0d.77" });
	try {
		const kit = join(scratch.path, "kit");
		const { srcA, srcB } = fixtureSources(kit);
		const staleDir = join(scratch.path, "stale-hooks");
		const destA = installMember(staleDir, MEMBER_A, "# OLD probe-a\n");
		installMember(staleDir, MEMBER_B, readFileSync(srcB, "utf8"));
		const before = sha(readFileSync(destA, "utf8"));
		const base = memIo(kit, [{ repo: "/stale", hooksDir: staleDir, tracked: false }], {
			checks: { [resolve("/stale")]: [{ rc: 3, output: staleOut(destA, srcA) }, { rc: 3, output: staleOut(destA, srcA) }] },
		});
		const report = await refreshFleetHooks({
			...base,
			pullRepos: () => [{ repo: "/stale", source: "t:stale" }],
			runInstaller: () => ({ ok: true, detail: "planted no-op installer" }),
		});
		expect(report.failed).toBe(1);
		expect(report.refreshed).toBe(0);
		expect(report.results[0]!.status).toBe("FAILED");
		expect(report.results[0]!.detail).toContain(MEMBER_A);
		const stale = report.results[0]!.members.find((row) => row.member === MEMBER_A)!;
		expect(stale.before_sha256).toBe(before);
		expect(stale.after_sha256).toBe(before);
		expect(stale.refreshed).toBe(false);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("parseCheckMembers reads only the member lines the installer names", () => {
	const dest = "/r/.git/hooks/hooks.d/pre-push/42-omp-kit-affected-gate";
	const src = "/kit/scripts/pre-push-affected-gate.sh";
	const output = [
		"install-commit-msg-bead: STALE chain runner: /r/.git/hooks/pre-commit lacks gen9; rerun x",
		`install-commit-msg-bead: MISSING installed member: ${dest}`,
		`install-commit-msg-bead: STALE installed member: ${dest} differs from ${src}; rerun x`,
		"install-commit-msg-bead: MISSING or STALE pushed-beads member: /r/.git/hooks/hooks.d/pre-push/40-omp-kit-pushed-beads; rerun x",
		"install-commit-msg-bead: hooks fresh in /r",
	].join("\n");
	expect(parseCheckMembers(output)).toEqual([
		{ dest, src: null, kind: "MISSING" },
		{ dest, src, kind: "STALE" },
	]);
});
test("HOOKREFRESHALL1: a pullEnabled:false session repo with installed members is refreshed; a session repo with no kit members is left untouched", async () => {
	const scratch = ownedTmp("hookrefresh-all1", { bead: "ompkit-1ra0d.77" });
	const home = join(scratch.path, "home");
	mkdirSync(home, { recursive: true });
	const withHooks = join(scratch.path, "with-hooks");
	const noHooks = join(scratch.path, "no-hooks");
	const env = gitEnv(scratch.path);
	try {
		for (const repo of [withHooks, noHooks]) {
			expect(runFixture(["git", "init", "-q", repo], { cwd: scratch.path, env }).rc).toBe(0);
		}
		const hooksDir = join(withHooks, ".git", "hooks");
		const memberDest = installMember(hooksDir, "hooks.d/pre-commit/40-omp-kit-probe", "# stale probe\n");
		const srcFile = join(scratch.path, "probe.sh");
		writeFileSync(srcFile, "# fresh probe\n");
		writeFileSync(join(home, "fleet-watch.json"), JSON.stringify({
			sessions: [
				{ session: "with", repo: withHooks, pullEnabled: false },
				{ session: "without", repo: noHooks, pullEnabled: false },
			],
		}));
		const previous = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		process.env.OMP_KIT_FLEET_WATCH_CONFIG = join(home, "fleet-watch.json");
		try {
			// The old pullEnabled filter drops both repos: neither opts into supply.
			const sessions = [
				{ session: "with", repo: withHooks, pullEnabled: false },
				{ session: "without", repo: noHooks, pullEnabled: false },
			];
			expect(sessions.filter((row) => row.pullEnabled === true)).toEqual([]);
			const selected = installedHookRepos(home);
			expect(selected.map((row) => row.repo)).toEqual([withHooks]);
			expect(dirHasKitMembers(join(noHooks, ".git", "hooks"))).toBe(false);
			const digest = (path: string): string | null => {
				try {
					return sha(readFileSync(path));
				} catch {
					return null;
				}
			};
			const written: string[] = [];
			let checks = 0;
			const io: HookRefreshIo = {
				repos: () => selected,
				kitRoot: () => scratch.path,
				digest,
				hooksDir: (repo) => resolve(repo) === resolve(withHooks)
					? { dir: hooksDir, config: null, tracked: false }
					: { dir: null, config: null, tracked: false },
				check: async (repo) => {
					if (resolve(repo) !== resolve(withHooks)) return { rc: 0, output: FRESH_OUT(repo) };
					checks += 1;
					return checks === 1
						? { rc: 3, output: staleOut(memberDest, srcFile) }
						: { rc: 0, output: FRESH_OUT(repo) };
				},
				hasKitMembers: (dir) => dirHasKitMembers(dir),
				pullRepos: () => installedHookRepos(home),
				runInstaller: (target) => {
					written.push(resolve(target));
					writeFileSync(memberDest, readFileSync(srcFile));
					return { ok: true, detail: "seam refreshed the probe" };
				},
			};
			const report = await refreshFleetHooks(io);
			expect(written).toEqual([resolve(withHooks)]);
			expect(report.refreshed).toBe(1);
			expect(report.results[0]!.status).toBe("REFRESHED");
			expect(readFileSync(memberDest, "utf8")).toBe("# fresh probe\n");
			expect(existsSync(join(noHooks, ".git", "hooks", "hooks.d"))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
			else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previous;
		}
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("HOOKREFRESHALL1 install path: update --apply manifest invokes the same fleet refresh once", async () => {
	const scratch = ownedTmp("hookrefresh-install-path", { bead: "ompkit-1ra0d.77" });
	try {
		const root = join(scratch.path, "root");
		const home = join(scratch.path, "home");
		mkdirSync(join(root, "rules"), { recursive: true });
		mkdirSync(join(root, "rules-fleet"), { recursive: true });
		mkdirSync(join(root, "policy"), { recursive: true });
		mkdirSync(join(root, "retired"), { recursive: true });
		mkdirSync(join(root, "extensions"), { recursive: true });
		mkdirSync(home, { recursive: true });
		const rule = "# Foo rule\n";
		const fleetRule = "# Bar fleet rule\n";
		writeFileSync(join(root, "policy", "extensions.json"), JSON.stringify({ extensions: [], skipProfiles: [] }));
		writeFileSync(join(root, "rules", "foo.md"), rule);
		writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nfoo\t${sha(rule)}\treminder\t1234567\n`);
		writeFileSync(join(root, "rules-fleet", "bar.md"), fleetRule);
		writeFileSync(join(root, "MANIFEST.fleet.tsv"), `name\tsha256\tclass\tpack\nbar\t${sha(fleetRule)}\treminder\t1234567\n`);
		writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9", omp: { extensions: [], notLoadedExtensions: {} } }));
		const stateRoot = join(home, ".local", "state", "omp-kit");
		const repo = join(scratch.path, "fleet-repo");
		const hooksDir = join(scratch.path, "hooks");
		const written: string[] = [];
		const hookIo: HookRefreshIo = {
			repos: () => [{ repo, source: "t:install-path" }],
			kitRoot: () => root,
			digest: () => "k",
			hooksDir: () => ({ dir: hooksDir, config: null, tracked: false }),
			check: async () => ({ rc: 0, output: FRESH_OUT(repo) }),
			hasKitMembers: () => true,
			pullRepos: () => [{ repo, source: "t:install-path" }],
			runInstaller: (target) => { written.push(target); return { ok: true, detail: "stub installer" }; },
		};
		const exec = async (_argv: readonly string[]) => ({ exit: 0, stdout: JSON.stringify({ code: 0, data: {} }), stderr: "" });
		const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec, hookIo });
		expect(written).toEqual([repo]);
		expect(result.hooksRepos).toBe(1);
		expect(result.hooksFailed).toBe(0);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS() * 1000);

test("HOOKCENSUS1: the census reports a missing 42-omp-kit-affected-gate member from the installer's own --check", async () => {
	const root = resolve(import.meta.dir, "../..");
	const scratch = ownedTmp("hookrefresh-census1", { bead: "ompkit-1ra0d.77" });
	try {
		const repo = join(scratch.path, "repo");
		const env = gitEnv(scratch.path);
		expect(runFixture(["git", "init", "-q", repo], { cwd: scratch.path, env }).rc).toBe(0);
		const installed = await run(["sh", join(root, "scripts/install-commit-msg-bead.sh"), repo], { deadline_s: fixtureDeadlineS(120) });
		expect(installed.rc).toBe(0);
		const rev = runFixture(["git", "-C", repo, "rev-parse", "--git-path", "hooks"], { cwd: scratch.path, env });
		expect(rev.rc).toBe(0);
		const hooksDir = resolve(repo, Buffer.from(rev.stdout).toString("utf8").trim());
		const gate = join(hooksDir, "hooks.d/pre-push/42-omp-kit-affected-gate");
		expect(existsSync(gate)).toBe(true);
		rmSync(gate);
		// The installer prints resolved paths; a repo reached through a symlink (macOS /tmp ->
		// /private/tmp, as a verify export under /tmp is) must name the same relative member.
		const linked = join(scratch.path, "linked");
		symlinkSync(repo, linked);
		const live = liveHookFreshnessIo(scratch.path, root);
		const io: HookFreshnessIo = { ...live, repos: () => [{ repo, source: "t:census1" }, { repo: linked, source: "t:census1-link" }] };
		const rows = await censusHookFreshness(io);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.state).toBe("STALE");
			expect(row.stale).toContain("hooks.d/pre-push/42-omp-kit-affected-gate");
			expect(row.members.find((member) => member.member === "hooks.d/pre-push/42-omp-kit-affected-gate")?.status).toBe("MISSING");
		}
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(120) * 1000);

test("hooks doctor runs both installer checks: fresh, stale, missing and restored", async () => {
	const root = resolve(import.meta.dir, "../..");
	const repo = ownedTmp("hook-installer-doctor").path;
	try {
		const init = await run(["git", "init", "-q", repo], { deadline_s: 15 });
		expect(init.rc).toBe(0);
		const installed = await run(["sh", join(root, "scripts/install-commit-msg-bead.sh"), repo], { deadline_s: 60 });
		expect({ rc: installed.rc, stderr: Buffer.from(installed.stderr).toString() }).toEqual({ rc: 0, stderr: expect.any(String) });
		const push = join(repo, ".git/hooks/hooks.d/pre-push/40-omp-kit-fresh-gate");
		// Same member-copy operation as install-pre-push-gate.sh; do not ask
		// native am to register a disposable project in the real mail archive.
		copyFileSync(join(root, "scripts/pre-push-gate.sh"), push);
		const inspect = () => diagnose({ root, home: repo, project: repo, scope: "hooks" });
		const fresh = await inspect();
		expect(fresh.filter(row => row.evidence?.installer).map(row => row.status)).toEqual(["OK", "OK"]);
		writeFileSync(push, "# stale installed fresh-gate member\n");
		const stale = (await inspect()).find(row => row.evidence?.installer === join(root, "scripts/install-pre-push-gate.sh"))!;
		expect(stale.status).toBe("DRIFT");
		expect(stale.reason).toContain(`STALE installed member: ${push}`);
		expect(stale.recommended_action).toContain("sh scripts/install-pre-push-gate.sh");
		copyFileSync(join(root, "scripts/pre-push-gate.sh"), push);
		const commit = join(repo, ".git/hooks/hooks.d/commit-msg/55-omp-kit-commit-gate");
		const original = readFileSync(commit);
		writeFileSync(commit, "# stale installed commit-gate member\n");
		const commitStale = (await inspect()).find(row => row.evidence?.installer === join(root, "scripts/install-commit-msg-bead.sh"))!;
		expect(commitStale.status).toBe("DRIFT");
		expect(commitStale.reason).toContain(`STALE installed member: ${commit}`);
		expect(commitStale.recommended_action).toContain(`install-commit-msg-bead.sh' '${repo}'`);
		writeFileSync(commit, original);
		rmSync(push);
		const missing = (await inspect()).find(row => row.evidence?.installer === join(root, "scripts/install-pre-push-gate.sh"))!;
		expect(missing.status).toBe("DRIFT");
		expect(missing.reason).toContain(`MISSING installed member: ${push}`);
		expect(missing.recommended_action).toContain("sh scripts/install-pre-push-gate.sh");
		copyFileSync(join(root, "scripts/pre-push-gate.sh"), push);
		expect((await inspect()).filter(row => row.evidence?.installer).map(row => row.status)).toEqual(["OK", "OK"]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}, fixtureDeadlineS(120) * 1000);

test("PUSHGATEREFRESH1: a stale installed pre-push gate is rewritten by the same refresh pass; a current one is left byte-identical", async () => {
	const root = resolve(import.meta.dir, "../..");
	const scratch = ownedTmp("hookrefresh-pushgate", { bead: "ompkit-1ra0d.120" });
	try {
		const gated = join(scratch.path, "gated");
		const ungated = join(scratch.path, "ungated");
		const env = gitEnv(scratch.path);
		for (const repo of [gated, ungated]) {
			expect(runFixture(["git", "init", "-q", repo], { cwd: scratch.path, env }).rc).toBe(0);
			const installed = await run(["sh", join(root, "scripts/install-commit-msg-bead.sh"), repo], { deadline_s: fixtureDeadlineS(120) });
			expect(installed.rc).toBe(0);
		}
		const hooksOf = (repo: string): string => {
			const rev = runFixture(["git", "-C", repo, "rev-parse", "--git-path", "hooks"], { cwd: scratch.path, env });
			expect(rev.rc).toBe(0);
			return resolve(repo, Buffer.from(rev.stdout).toString("utf8").trim());
		};
		const src = join(root, "scripts/pre-push-gate.sh");
		const gateDest = join(hooksOf(gated), "hooks.d/pre-push/40-omp-kit-fresh-gate");
		mkdirSync(join(gateDest, ".."), { recursive: true });
		writeFileSync(gateDest, "# stale installed gate\n");
		expect((await run(["sh", join(root, "scripts/install-pre-push-gate.sh"), "--check", gated], { deadline_s: fixtureDeadlineS() })).rc).toBe(3);
		// Planted negative: the old refresh (bead installer only) leaves the stale gate in place.
		const oldRefresh = await run(["sh", join(root, "scripts/install-commit-msg-bead.sh"), gated], { deadline_s: fixtureDeadlineS(120) });
		expect(oldRefresh.rc).toBe(0);
		expect(readFileSync(gateDest, "utf8")).toBe("# stale installed gate\n");
		const live = liveHookRefreshIo(scratch.path, root);
		const both = [{ repo: gated, source: "t:pushgate" }, { repo: ungated, source: "t:pushgate" }];
		const io: HookRefreshIo = { ...live, repos: () => both, pullRepos: () => both };
		const gatedRel = "hooks.d/pre-push/40-omp-kit-fresh-gate";
		const rows = await censusHookFreshness(io);
		const gatedRow = rows.find((row) => row.repo === resolve(gated))!;
		expect(gatedRow.state).toBe("STALE");
		expect(gatedRow.stale).toContain(gatedRel);
		const ungatedRow = rows.find((row) => row.repo === resolve(ungated))!;
		expect(ungatedRow.state).toBe("FRESH");
		expect(ungatedRow.stale).toEqual([]);
		const report = await refreshFleetHooks(io);
		expect(report.failed).toBe(0);
		expect(report.refreshed).toBe(1);
		expect(report.fresh).toBe(1);
		const result = report.results.find((row) => row.repo === resolve(gated))!;
		expect(result.status).toBe("REFRESHED");
		const member = result.members.find((row) => row.member === gatedRel)!;
		expect(member.before_sha256).toBe(sha("# stale installed gate\n"));
		expect(member.after_sha256).toBe(sha(readFileSync(src)));
		expect(member.refreshed).toBe(true);
		expect(readFileSync(gateDest)).toEqual(readFileSync(src));
		expect(existsSync(join(hooksOf(ungated), "hooks.d/pre-push/40-omp-kit-fresh-gate"))).toBe(false);
		// A current gate is left byte-identical: the next pass is FRESH and changes nothing.
		const before = sha(readFileSync(gateDest));
		const gatedOnly: HookRefreshIo = { ...io, pullRepos: () => [{ repo: gated, source: "t:pushgate" }] };
		const again = await refreshFleetHooks(gatedOnly);
		expect(again.failed).toBe(0);
		expect(again.refreshed).toBe(0);
		expect(again.fresh).toBe(1);
		expect(sha(readFileSync(gateDest))).toBe(before);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(120) * 1000);
