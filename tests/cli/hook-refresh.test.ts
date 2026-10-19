// hook-refresh.test.ts — HOOKREFRESH1 (ompkit-v66l.22.3): after an install,
// kit-update re-runs the hook installer for every pull-enabled fleet repo and
// records each member's before/after digest; doctor --scope hooks lists the
// members whose digest differs from the active release.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
	HOOK_MEMBER_PAIRS,
	censusHookFreshness,
	inspectHooks,
	pullEnabledRepos,
	refreshFleetHooks,
	type HookFreshnessIo,
} from "../../src/hook-refresh.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fixture kit root with all 16 source members plus one stale-target source. */
function fixtureKit(): string {
	const kit = mkdtempSync(join(tmpdir(), "hookrefresh-kit-"));
	for (const [, sourceRel] of HOOK_MEMBER_PAIRS) {
		const path = join(kit, sourceRel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `# source ${sourceRel}\n`);
	}
	return kit;
}
function memIo(kit: string, repos: { repo: string; hooksDir: string; tracked: boolean }[]): HookFreshnessIo {
	// No digest cache: refresh reads before AND after the installer, so each
	// read must hit the filesystem live (the production io has no cache).
	const digest = (path: string): string | null => {
		try {
			return sha(readFileSync(path, "utf8"));
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
			return found ? { dir: found.hooksDir, config: found.tracked ? ".githooks" : null, tracked: found.tracked } : { dir: null, config: null, tracked: false };
		},
	};
}

function fixtureHooksDir(kit: string, staleMember: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "hookrefresh-hooks-"));
	for (const [installedRel, sourceRel] of HOOK_MEMBER_PAIRS) {
		const path = join(dir, installedRel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, installedRel === staleMember ? "# OLD member from v0.2.37\n" : readFileSync(join(kit, sourceRel), "utf8"));
	}
	return dir;
}

test("an old member is reported stale; a fresh repo has nothing to report", () => {
	const kit = fixtureKit();
	const staleDir = fixtureHooksDir(kit, "hooks.d/commit-msg/49-omp-kit-stale-worktree");
	const freshDir = fixtureHooksDir(kit, null);
	const io = memIo(kit, [
		{ repo: "/stale", hooksDir: staleDir, tracked: false },
		{ repo: "/fresh", hooksDir: freshDir, tracked: false },
	]);
	const rows = censusHookFreshness(io);
	const stale = rows.find((row) => row.repo === resolve("/stale"))!;
	const fresh = rows.find((row) => row.repo === resolve("/fresh"))!;
	expect(stale.state).toBe("STALE");
	expect(stale.stale).toEqual(["hooks.d/commit-msg/49-omp-kit-stale-worktree"]);
	expect(fresh.state).toBe("FRESH");
	expect(fresh.stale).toEqual([]);
	const findings = inspectHooks(io);
	expect(findings[0]!.status).toBe("DEGRADED");
	expect(findings[0]!.reason).toContain("49-omp-kit-stale-worktree");
	rmSync(kit, { recursive: true, force: true });
	rmSync(staleDir, { recursive: true, force: true });
	rmSync(freshDir, { recursive: true, force: true });
});

test("planted: refresh copies the source over the old member; the fresh member keeps its digest", async () => {
	const kit = fixtureKit();
	const staleDir = fixtureHooksDir(kit, "hooks.d/commit-msg/49-omp-kit-stale-worktree");
	const freshDir = fixtureHooksDir(kit, null);
	const freshBefore = sha(readFileSync(join(freshDir, "hooks.d/commit-msg/40-omp-kit-commit-msg-bead"), "utf8"));
	const base = memIo(kit, [
		{ repo: "/stale", hooksDir: staleDir, tracked: false },
		{ repo: "/fresh", hooksDir: freshDir, tracked: false },
	]);
	// The installer seam: copy every source byte over the installed member.
	const runInstaller = (repo: string) => {
		const dir = repo === resolve("/stale") ? staleDir : freshDir;
		for (const [installedRel, sourceRel] of HOOK_MEMBER_PAIRS) {
			writeFileSync(join(dir, installedRel), readFileSync(join(kit, sourceRel)));
		}
		return { ok: true, detail: "seam copied sources" };
	};
	const report = await refreshFleetHooks({ ...base, pullRepos: () => [{ repo: "/stale", source: "t:s" }, { repo: "/fresh", source: "t:f" }], runInstaller });
	expect(report.refreshed).toBe(1);
	expect(report.fresh).toBe(1);
	const staleResult = report.results.find((row) => row.repo === resolve("/stale"))!;
	const staleMember = staleResult.members.find((row) => row.member === "hooks.d/commit-msg/49-omp-kit-stale-worktree")!;
	expect(staleMember.before_sha256).not.toBe(staleMember.after_sha256);
	expect(staleMember.after_sha256).toBe(sha(readFileSync(join(kit, "scripts/check-stale-worktree.sh"), "utf8")));
	const freshMember = report.results.find((row) => row.repo === resolve("/fresh"))!
		.members.find((row) => row.member === "hooks.d/commit-msg/40-omp-kit-commit-msg-bead")!;
	expect(freshMember.before_sha256).toBe(freshBefore);
	expect(freshMember.after_sha256).toBe(freshBefore);
	expect(freshMember.refreshed).toBe(false);
	rmSync(kit, { recursive: true, force: true });
	rmSync(staleDir, { recursive: true, force: true });
	rmSync(freshDir, { recursive: true, force: true });
});

test("a tracked hooks path records PENDING_COMMIT and leaves the commit to the director", async () => {
	const kit = fixtureKit();
	const dir = fixtureHooksDir(kit, "hooks.d/commit-msg/49-omp-kit-stale-worktree");
	const repo = mkdtempSync(join(tmpdir(), "hookrefresh-tracked-"));
	const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	run(["init", "-q"]);
	run(["config", "user.email", "test@example.com"]);
	run(["config", "user.name", "test"]);
	run(["config", "core.hooksPath", ".githooks"]);
	const githooks = join(repo, ".githooks", "hooks.d", "commit-msg");
	mkdirSync(githooks, { recursive: true });
	writeFileSync(join(githooks, "49-omp-kit-stale-worktree"), "# OLD member\n");
	run(["add", "."]);
	run(["commit", "-qm", "track hooks"]);
	const headBefore = run(["rev-parse", "HEAD"]).stdout.toString().trim();
	const base = memIo(kit, [{ repo, hooksDir: join(repo, ".githooks"), tracked: true }]);
	const report = await refreshFleetHooks({
		...base,
		pullRepos: () => [{ repo, source: "t:cfs" }],
		runInstaller: (target) => {
			writeFileSync(join(target, ".githooks", "hooks.d", "commit-msg", "49-omp-kit-stale-worktree"), readFileSync(join(kit, "scripts/check-stale-worktree.sh")));
			return { ok: true, detail: "seam refreshed tracked member" };
		},
	});
	expect(report.pending_commit).toBe(1);
	expect(report.results[0]!.status).toBe("PENDING_COMMIT");
	expect(report.results[0]!.paths.length).toBeGreaterThan(0);
	// Owner route: the working tree is dirty but HEAD did not move.
	expect(run(["rev-parse", "HEAD"]).stdout.toString().trim()).toBe(headBefore);
	expect(run(["status", "--porcelain"]).stdout.toString()).toContain("49-omp-kit-stale-worktree");
	rmSync(kit, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

test("only pullEnabled sessions refresh; doctor still sees every fleet repo", () => {
	const home = mkdtempSync(join(tmpdir(), "hookrefresh-home-"));
	const config = {
		sessions: [
			{ session: "cfsios", repo: "/Users/josh/Developer/clutterfreespaces.ios", pullEnabled: true },
			{ session: "jev", repo: "/Users/josh/Developer/jev", pullEnabled: false },
			{ session: "unflagged", repo: "/Users/josh/Developer/zestroku" },
		],
	};
	writeFileSync(join(home, "fleet-watch.json"), JSON.stringify(config));
	const previous = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = join(home, "fleet-watch.json");
	try {
		expect(pullEnabledRepos(home).map((row) => row.repo)).toEqual(["/Users/josh/Developer/clutterfreespaces.ios"]);
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		else process.env.OMP_KIT_FLEET_WATCH_CONFIG = previous;
		rmSync(home, { recursive: true, force: true });
	}
});
