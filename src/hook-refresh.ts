// hook-refresh.ts — HOOKREFRESH1 (ompkit-v66l.22.3): kit-update refreshes the
// kit hook members installed in every fleet project.
//
// Background: kit-update relinked the plugin and services but never re-ran
// scripts/install-commit-msg-bead.sh in projects, so cfsios, localbench, jev
// and zestroku kept running a stale 49-omp-kit-stale-worktree (454b1fc4)
// without the blame-skip fix shipped since v0.2.54.
//
// Contract:
// - After a successful install, runKitUpdateJob re-runs the hook installer
//   for every fleet-watch sessions[].repo with pullEnabled true, recording
//   each member's before/after sha256. A repo whose hooks path is tracked
//   (core.hooksPath=.githooks, e.g. clutterfreespaces.ios) is NOT committed
//   by kit-update: it records PENDING_COMMIT with the paths so the repo's
//   director commits them (owner route).
// - `doctor --scope hooks` (via diagnose()) lists per repo the members whose
//   digest differs from the active release (this checkout's scripts/).
//
// The member list mirrors scripts/install-commit-msg-bead.sh --check exactly;
// when that script gains a member, this list gains it in the same change.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { fleetWatchRepos } from "./scratch.ts";

/** [installed rel (under the hooks dir), source rel (under the kit root)]. */
export const HOOK_MEMBER_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["hooks.d/commit-msg/40-omp-kit-commit-msg-bead", "scripts/commit-msg-bead.sh"],
	["hooks.d/pre-push/30-omp-kit-on-main", "scripts/check-pushed-on-main.sh"],
	["hooks.d/pre-push/41-omp-kit-pushed-vlevel", "scripts/pre-push-verification-level.sh"],
	["hooks.d/pre-push/check-pushed-beads.sh", "scripts/check-pushed-beads.sh"],
	["hooks.d/pre-push/commit-msg-bead.sh", "scripts/commit-msg-bead.sh"],
	["hooks.d/reference-transaction/40-omp-kit-ref-txn-bead", "scripts/ref-txn-bead.sh"],
	["hooks.d/reference-transaction/commit-msg-bead.sh", "scripts/commit-msg-bead.sh"],
	["hooks.d/pre-commit/45-omp-kit-staged-imports", "scripts/check-staged-imports.sh"],
	["hooks.d/pre-commit/check-commit-imports.sh", "scripts/check-commit-imports.sh"],
	["hooks.d/commit-msg/46-omp-kit-commit-notes", "scripts/check-commit-notes.sh"],
	["hooks.d/commit-msg/release-notes.ts", "scripts/release-notes.ts"],
	["hooks.d/commit-msg/limit-process-tree.sh", "scripts/limit-process-tree.sh"],
	["hooks.d/pre-commit/47-omp-kit-staged-fragments", "scripts/check-staged-fragments.sh"],
	["hooks.d/commit-msg/49-omp-kit-stale-worktree", "scripts/check-stale-worktree.sh"],
	["hooks.d/pre-commit/48-omp-kit-staged-regexploit", "scripts/check-staged-regexploit.sh"],
	["hooks.d/pre-commit/49-omp-kit-staged-pysafe", "scripts/check-staged-pysafe.sh"],
	["hooks.d/pre-commit/pysafe.py", "scripts/pysafe.py"],
	["hooks.d/pre-commit/pysafe_check.py", "scripts/pysafe_check.py"],
	["hooks.d/pre-commit/50-omp-kit-staged-tempsafe", "scripts/check-staged-tempsafe.sh"],
	["hooks.d/pre-commit/tempsafe_check.py", "scripts/tempsafe_check.py"],
	["hooks.d/pre-commit/kitlib_ratchet_core.py", "scripts/kitlib_ratchet_core.py"],
	["hooks.d/pre-commit/51-omp-kit-staged-kitlib", "scripts/check-staged-kitlib.sh"],
	["hooks.d/pre-commit/kitlib_ratchet.py", "scripts/kitlib_ratchet.py"],
	["hooks.d/pre-commit/52-omp-kit-staged-sources", "scripts/check-staged-sources.sh"],
	["hooks.d/pre-commit/sources.py", "scripts/sources.py"],
	["hooks.d/pre-commit/kitlib_run.py", "scripts/kitlib_run.py"],
	["hooks.d/pre-commit/kitlib_io.py", "scripts/kitlib_io.py"],
	["hooks.d/commit-msg/gate-event.sh", "scripts/gate-event.sh"],
	["hooks.d/pre-commit/kitlib-findings.sh", "scripts/kitlib-findings.sh"],
	["hooks.d/commit-msg/kitlib-findings.sh", "scripts/kitlib-findings.sh"],
	["hooks.d/pre-push/kitlib-findings.sh", "scripts/kitlib-findings.sh"],
	["hooks.d/reference-transaction/kitlib-findings.sh", "scripts/kitlib-findings.sh"],
	["hooks.d/commit-msg/kitlib_jsonl.py", "scripts/kitlib_jsonl.py"],
	["hooks.d/commit-msg/kitlib_lock.py", "scripts/kitlib_lock.py"],
	["hooks.d/pre-commit/kitlib_tmp.py", "scripts/kitlib_tmp.py"],
	["hooks.d/pre-commit/kitlib-tmp.sh", "scripts/kitlib-tmp.sh"],
	["hooks.d/commit-msg/kitlib-tmp.sh", "scripts/kitlib-tmp.sh"],
	["hooks.d/pre-push/kitlib-tmp.sh", "scripts/kitlib-tmp.sh"],
	["hooks.d/reference-transaction/kitlib-tmp.sh", "scripts/kitlib-tmp.sh"],
	["hooks.d/pre-commit/46-omp-kit-staged-readme", "scripts/check-staged-readme.sh"],
	["hooks.d/pre-commit/readme-check.ts", "scripts/readme-check.ts"],

];
/**
 * The two pushed-beads members are conditional in the installer
 * (--no-pushed-beads skips them). A missing optional member is not a finding;
 * a present-but-differing one is.
 */
const OPTIONAL_MEMBERS: Record<string, true> = {
	"hooks.d/pre-push/check-pushed-beads.sh": true,
	"hooks.d/pre-push/commit-msg-bead.sh": true,
};
type HookMemberStatus = "FRESH" | "MISSING" | "STALE" | "SOURCE_MISSING";
export interface HookMemberRow {
	member: string;
	installed_sha256: string | null;
	source_sha256: string | null;
	status: HookMemberStatus;
}
export interface HookRepoRow {
	repo: string;
	source: string;
	hooks_dir: string | null;
	hooks_path_config: string | null;
	/** True when the hooks dir holds git-tracked files (owner-route commit). */
	tracked: boolean;
	members: HookMemberRow[];
	/** Installed rel paths that are STALE or (non-optional) MISSING. */
	stale: string[];
	state: "FRESH" | "STALE" | "UNREADABLE" | "SOURCE_MISSING";
}

export interface HookFreshnessIo {
	repos(): { repo: string; source: string }[];
	kitRoot(): string;
	digest(path: string): string | null;
	hooksDir(repo: string): { dir: string | null; config: string | null; tracked: boolean };
}

export function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** sessions[].repo with pullEnabled true only: the refresh write set. */
export function pullEnabledRepos(home: string): { repo: string; source: string }[] {
	let config: unknown;
	try {
		const path = process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	if (typeof config !== "object" || config === null) return [];
	const sessions = (config as Record<string, unknown>).sessions;
	if (!Array.isArray(sessions)) return [];
	const found: { repo: string; source: string }[] = [];
	for (const row of sessions) {
		if (typeof row !== "object" || row === null) continue;
		const record = row as Record<string, unknown>;
		if (record.pullEnabled !== true) continue;
		if (typeof record.repo !== "string" || !isAbsolute(record.repo)) continue;
		const session = typeof record.session === "string" ? record.session : "unnamed";
		found.push({ repo: record.repo, source: `fleet-watch:${session}` });
	}
	return found;
}

export function censusHookFreshness(io: HookFreshnessIo): HookRepoRow[] {
	const kitRoot = io.kitRoot();
	const seen = new Set<string>();
	const rows: HookRepoRow[] = [];
	for (const entry of io.repos()) {
		const repo = resolve(entry.repo);
		if (seen.has(repo)) continue;
		seen.add(repo);
		const located = io.hooksDir(repo);
		if (located.dir === null) {
			rows.push({ repo, source: entry.source, hooks_dir: null, hooks_path_config: located.config, tracked: false, members: [], stale: [], state: "UNREADABLE" });
			continue;
		}
		const members: HookMemberRow[] = [];
		const stale: string[] = [];
		let sourceMissing = false;
		for (const [installedRel, sourceRel] of HOOK_MEMBER_PAIRS) {
			const installedDigest = io.digest(join(located.dir, installedRel));
			const sourceDigest = io.digest(join(kitRoot, sourceRel));
			let status: HookMemberStatus;
			if (sourceDigest === null) {
				status = "SOURCE_MISSING";
				sourceMissing = true;
			} else if (installedDigest === null) {
				status = OPTIONAL_MEMBERS[installedRel] ? "FRESH" : "MISSING";
				if (status === "MISSING") stale.push(installedRel);
			} else if (installedDigest === sourceDigest) {
				status = "FRESH";
			} else {
				status = "STALE";
				stale.push(installedRel);
			}
			// An absent optional member is fresh by definition: report nulls, no finding.
			members.push({ member: installedRel, installed_sha256: installedDigest, source_sha256: sourceDigest, status });
		}
		rows.push({
			repo, source: entry.source, hooks_dir: located.dir, hooks_path_config: located.config,
			tracked: located.tracked, members, stale,
			state: sourceMissing && stale.length === 0 ? "SOURCE_MISSING" : stale.length > 0 ? "STALE" : "FRESH",
		});
	}
	return rows;
}

export function inspectHooks(io: HookFreshnessIo): Finding[] {
	const rows = censusHookFreshness(io);
	const staleRepos = rows.filter((row) => row.state === "STALE");
	const unreadable = rows.filter((row) => row.state === "UNREADABLE");
	const status = rows.length === 0 ? "UNVERIFIED" : staleRepos.length > 0 ? "DEGRADED" : unreadable.length > 0 ? "UNVERIFIED" : "OK";
	const reason = rows.length === 0
		? "No repo list: fleet-watch.json names none, so no hook member was checked"
		: `${rows.length} repo(s), ${rows.length - staleRepos.length - unreadable.length} with every hook member matching the active release`
			+ (staleRepos.length ? `; STALE: ${staleRepos.map((row) => `${basename(row.repo)} (${row.stale.join(", ")})`).join("; ")}` : "")
			+ (unreadable.length ? `; ${unreadable.length} repo path(s) unreadable` : "");
	const trackedPending = staleRepos.filter((row) => row.tracked).map((row) => row.repo);
	return [{
		component: "hooks",
		status,
		reason,
		recommended_action: staleRepos.length > 0
			? (trackedPending.length > 0
				? `Rerun the hook installer in each stale repo (sh <release>/scripts/install-commit-msg-bead.sh <repo>); ${trackedPending.map((repo) => basename(repo)).join(", ")} track(s) its hooks path, so its director commits the refreshed members with a Bead: trailer under a reservation — kit-update never commits them.`
				: "Rerun the hook installer in each stale repo: sh <release>/scripts/install-commit-msg-bead.sh <repo>.")
			: rows.length === 0 ? "Register the fleet repos in fleet-watch.json." : "No action required.",
		evidence: {
			source: "fleet-watch.json repos vs active release scripts/",
			repos: rows.length,
			stale_repos: staleRepos.map((row) => row.repo),
			tracked_pending_commit: trackedPending,
			unreadable: unreadable.map((row) => row.repo),
			stale_members: staleRepos.map((row) => ({ repo: row.repo, hooks_dir: row.hooks_dir, tracked: row.tracked, members: row.stale })),
		},
	}];
}

function gitOut(repo: string, args: string[]): string | null {
	try {
		const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
		if (run.status !== 0) return null;
		return String(run.stdout ?? "");
	} catch {
		return null;
	}
}

export function liveHookFreshnessIo(home: string, kitRoot: string): HookFreshnessIo {
	const base = home || process.env.HOME || homedir();
	return {
		repos: () => fleetWatchRepos(base).map((entry) => {
			try {
				return { repo: realpathSync(entry.repo), source: entry.source };
			} catch {
				return entry;
			}
		}),
		kitRoot: () => kitRoot,
		digest: (path) => {
			try {
				const stat = lstatSync(path);
				if (!stat.isFile()) return null;
				return digestBytes(readFileSync(path));
			} catch {
				return null;
			}
		},
		hooksDir: (repo) => {
			const config = gitOut(repo, ["config", "--get", "core.hooksPath"])?.trim() || null;
			const gitPath = gitOut(repo, ["rev-parse", "--git-path", "hooks"])?.trim() || null;
			if (!gitPath) return { dir: null, config, tracked: false };
			const dir = isAbsolute(gitPath) ? gitPath : resolve(repo, gitPath);
			let tracked = false;
			try {
				const rel = relative(repo, dir);
				if (rel !== "" && !rel.startsWith("..")) {
					const listed = gitOut(repo, ["ls-files", "--", rel]);
					tracked = listed !== null && listed.trim().length > 0;
				}
			} catch {
				tracked = false;
			}
			return { dir, config, tracked };
		},
	};
}

// ---- Refresh (write path, called by the kit-update job after a success) ----

export type HookRepoRefreshStatus = "REFRESHED" | "FRESH" | "PENDING_COMMIT" | "FAILED";
export interface HookMemberRefresh {
	member: string;
	before_sha256: string | null;
	after_sha256: string | null;
	refreshed: boolean;
}
export interface HookRepoRefresh {
	repo: string;
	source: string;
	status: HookRepoRefreshStatus;
	hooks_dir: string | null;
	tracked: boolean;
	/** Installed abs paths changed by the installer (commit set for PENDING_COMMIT). */
	paths: string[];
	members: HookMemberRefresh[];
	detail: string;
}
export interface HookRefreshReport {
	repos: number;
	refreshed: number;
	fresh: number;
	pending_commit: number;
	failed: number;
	results: HookRepoRefresh[];
}
export interface HookRefreshIo extends HookFreshnessIo {
	pullRepos(): { repo: string; source: string }[];
	runInstaller(repo: string): { ok: boolean; detail: string };
}

export async function refreshFleetHooks(io: HookRefreshIo): Promise<HookRefreshReport> {
	const report: HookRefreshReport = { repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 0, results: [] };
	for (const entry of io.pullRepos()) {
		const repo = resolve(entry.repo);
		const located = io.hooksDir(repo);
		if (located.dir === null) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: null, tracked: false, paths: [], members: [], detail: "hooks dir unreadable (not a git repo?)" });
			continue;
		}
		const before: Record<string, string | null> = {};
		for (const [installedRel] of HOOK_MEMBER_PAIRS) before[installedRel] = io.digest(join(located.dir, installedRel));
		const ran = io.runInstaller(repo);
		if (!ran.ok) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: located.dir, tracked: located.tracked, paths: [], members: [], detail: ran.detail });
			continue;
		}
		const members: HookMemberRefresh[] = [];
		const changed: string[] = [];
		const invalid: string[] = [];
		for (const [installedRel, sourceRel] of HOOK_MEMBER_PAIRS) {
			const after = io.digest(join(located.dir, installedRel));
			const was = before[installedRel] ?? null;
			const sourceDigest = io.digest(join(io.kitRoot(), sourceRel));
			const optionalMissing = OPTIONAL_MEMBERS[installedRel] === true && was === null && after === null;
			const matchesSource = optionalMissing || (sourceDigest !== null && after === sourceDigest);
			const refreshed = was !== after && after !== null && matchesSource;
			if (was !== after) changed.push(join(located.dir, installedRel));
			if (!matchesSource) invalid.push(installedRel);
			members.push({ member: installedRel, before_sha256: was, after_sha256: after, refreshed });
		}
		if (invalid.length > 0) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: located.dir, tracked: located.tracked, paths: changed, members, detail: `installer left ${invalid.length} member(s) missing or mismatched: ${invalid.join(", ")}` });
		} else if (changed.length === 0) {
			report.fresh += 1;
			report.results.push({ repo, source: entry.source, status: "FRESH", hooks_dir: located.dir, tracked: located.tracked, paths: [], members, detail: "every member already matched the active release" });
		} else if (located.tracked) {
			// Owner route: the hooks path is tracked, so the director commits.
			report.pending_commit += 1;
			report.results.push({ repo, source: entry.source, status: "PENDING_COMMIT", hooks_dir: located.dir, tracked: true, paths: changed, members, detail: `refreshed ${changed.length} member(s); tracked hooks path — director commits under a reservation` });
		} else {
			report.refreshed += 1;
			report.results.push({ repo, source: entry.source, status: "REFRESHED", hooks_dir: located.dir, tracked: false, paths: changed, members, detail: `refreshed ${changed.length} member(s) in the untracked hooks dir` });
		}
	}
	report.repos = report.results.length;
	return report;
}

export function liveHookRefreshIo(home: string, kitRoot: string): HookRefreshIo {
	const fresh = liveHookFreshnessIo(home, kitRoot);
	const base = home || process.env.HOME || homedir();
	return {
		...fresh,
		pullRepos: () => pullEnabledRepos(base).map((entry) => {
			try {
				return { repo: realpathSync(entry.repo), source: entry.source };
			} catch {
				return entry;
			}
		}),
		runInstaller: (repo) => {
			try {
				const run = spawnSync("sh", [join(kitRoot, "scripts/install-commit-msg-bead.sh"), repo], {
					encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
				});
				const out = ((run.stdout ?? "") + (run.stderr ?? "")).trim().slice(-500);
				return run.status === 0 ? { ok: true, detail: out || "verified active" } : { ok: false, detail: `exit ${run.status ?? "?"}: ${out}` };
			} catch (error) {
				return { ok: false, detail: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** Production default for the kit-update job: refresh pull-enabled fleet repos. Never throws. */
export async function refreshFleetHooksLive(store: string, home: string): Promise<HookRefreshReport> {
	try {
		return await refreshFleetHooks(liveHookRefreshIo(home, store));
	} catch (error) {
		return { repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 1, results: [] };
	}
}
