// hook-refresh.ts — HOOKREFRESHALL1 (ompkit-1ra0d.77): kit-update refreshes the
// kit hook members installed in every fleet project.
//
// Background: kit-update relinked the plugin and services but never re-ran
// scripts/install-commit-msg-bead.sh in projects, so cfsios, localbench, jev
// and zestroku kept running a stale 49-omp-kit-stale-worktree (454b1fc4)
// without the blame-skip fix shipped since v0.2.54.
//
// Contract:
// - After a successful install, runKitUpdateJob re-runs the hook installer
//   for every fleet-watch sessions[].repo that already has kit hook members
//   installed, whatever its pullEnabled. pullEnabled is a work-supply pause
//   (it gates sends and pulls), not a hook-membership signal. A repo with no
//   kit member installed is never written. Each member's before/after sha256
//   is recorded. Installed members are deployment artifacts: in a hooks dir
//   inside the work tree (core.hooksPath=.githooks, e.g.
//   clutterfreespaces.ios) the installer lists them in the repo's
//   info/exclude, so a refresh leaves nothing to commit. Only a refreshed
//   member the repo still tracks records PENDING_COMMIT with its paths, for the
//   repo's director to commit or untrack (owner route); kit-update never commits.
// - `doctor --scope hooks` (via diagnose()) lists per repo the members the
//   active release's scripts/install-commit-msg-bead.sh --check names as
//   MISSING or STALE. The installer is the one member list; nothing here
//   mirrors it by hand.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { fleetWatchRepos } from "./scratch.ts";
import { run } from "./kitlib/run.ts";

/**
 * One member the installer's --check names. The installer is the one member
 * list (HOOKREFRESHALL1): the census and the refresh parse its
 * `MISSING installed member: <dest>` and
 * `STALE installed member: <dest> differs from <src>` lines, so a member the
 * installer gains (e.g. KITGATE1's 42-omp-kit-affected-gate) is seen with no
 * change here. Parsed with prefix/suffix string ops, not patterns.
 */
export interface CheckMember { dest: string; src: string | null; kind: "MISSING" | "STALE"; }
const MISSING_PREFIX = "install-commit-msg-bead: MISSING installed member: ";
const STALE_PREFIX = "install-commit-msg-bead: STALE installed member: ";
const STALE_MID = " differs from ";
const RERUN_SUFFIX = "; rerun ";
export function parseCheckMembers(output: string): CheckMember[] {
	const found: CheckMember[] = [];
	const seen = new Set<string>();
	for (const line of output.split("\n")) {
		if (line.startsWith(MISSING_PREFIX)) {
			const dest = line.slice(MISSING_PREFIX.length).trim();
			if (dest.length === 0 || seen.has(`M:${dest}`)) continue;
			seen.add(`M:${dest}`);
			found.push({ dest, src: null, kind: "MISSING" });
		} else if (line.startsWith(STALE_PREFIX)) {
			const rest = line.slice(STALE_PREFIX.length);
			const rerunAt = rest.lastIndexOf(RERUN_SUFFIX);
			const core = rerunAt >= 0 ? rest.slice(0, rerunAt) : rest;
			const midAt = core.indexOf(STALE_MID);
			if (midAt < 0) continue;
			const dest = core.slice(0, midAt).trim();
			const src = core.slice(midAt + STALE_MID.length).trim();
			if (dest.length === 0 || src.length === 0 || seen.has(`S:${dest}`)) continue;
			seen.add(`S:${dest}`);
			found.push({ dest, src, kind: "STALE" });
		}
	}
	return found;
}
/** Installer --check outcome for one repo: rc 0 is fresh, rc 3 names drift. */
export interface HookCheckResult { rc: number | null; output: string; }
/** A --check result the census can judge: it ran and either passed or named drift. */
export function checkUsable(check: HookCheckResult): boolean {
	return check.rc === 0 || check.rc === 3;
}
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
	/** Installed rel paths (under the hooks dir) that are STALE or MISSING. */
	stale: string[];
	state: "FRESH" | "STALE" | "UNREADABLE" | "SOURCE_MISSING";
}

export interface HookFreshnessIo {
	repos(): { repo: string; source: string }[];
	kitRoot(): string;
	digest(path: string): string | null;
	hooksDir(repo: string): { dir: string | null; config: string | null; tracked: boolean };
	/** Active release's install-commit-msg-bead.sh --check <repo> (bounded). */
	check(repo: string): Promise<HookCheckResult>;
	/** True when the hooks dir holds at least one installed kit member. */
	hasKitMembers(dir: string): boolean;
}

export function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The hooks dir git would use for repo (same command the installer uses). */
function resolveHooksDir(repo: string): string | null {
	const gitPath = gitOut(repo, ["rev-parse", "--git-path", "hooks"])?.trim() || null;
	if (!gitPath) return null;
	return isAbsolute(gitPath) ? gitPath : resolve(repo, gitPath);
}
/** True when dir holds a 40-/41-omp-kit-* member: proof the installer ran here. */
export function dirHasKitMembers(dir: string): boolean {
	const stack: string[] = [dir];
	let seen = 0;
	while (stack.length > 0) {
		const cur = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(cur, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > 2000) return false;
			if (entry.name === ".git") continue;
			if (entry.isSymbolicLink()) continue;
			if (entry.isFile() && (entry.name.startsWith("40-omp-kit-") || entry.name.startsWith("41-omp-kit-"))) return true;
			if (entry.isDirectory() && stack.length < 64) stack.push(join(cur, entry.name));
		}
	}
	return false;
}
/**
 * sessions[].repo (absolute, existing) that already has kit hook members
 * installed, whatever its pullEnabled: the refresh write set. A repo with no
 * kit member installed is never written.
 */
export function installedHookRepos(home: string): { repo: string; source: string }[] {
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
		if (typeof record.repo !== "string" || !isAbsolute(record.repo)) continue;
		try {
			if (!statSync(record.repo).isDirectory()) continue;
		} catch {
			continue;
		}
		const dir = resolveHooksDir(record.repo);
		if (dir === null) continue;
		let present = false;
		try {
			present = dirHasKitMembers(dir);
		} catch {
			continue;
		}
		if (!present) continue;
		const session = typeof record.session === "string" ? record.session : "unnamed";
		found.push({ repo: record.repo, source: `fleet-watch:${session}` });
	}
	return found;
}

/** Installed rel under the hooks dir when dest sits inside it, else the dest. */
function memberName(hooksDir: string, dest: string): string {
	const rel = relative(hooksDir, dest);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : dest;
}
/**
 * Per-repo freshness from the active release's
 * scripts/install-commit-msg-bead.sh --check <repo>: each MISSING/STALE line
 * becomes a member row. A repo whose check cannot run (or answers outside
 * rc 0/3 with nothing parsed) is UNREADABLE, never FRESH.
 */
export async function censusHookFreshness(io: HookFreshnessIo): Promise<HookRepoRow[]> {
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
		let checked: HookCheckResult;
		try {
			checked = await io.check(repo);
		} catch {
			checked = { rc: null, output: "" };
		}
		const problems = parseCheckMembers(checked.output);
		if (!checkUsable(checked) && problems.length === 0) {
			rows.push({ repo, source: entry.source, hooks_dir: located.dir, hooks_path_config: located.config, tracked: false, members: [], stale: [], state: "UNREADABLE" });
			continue;
		}
		const members: HookMemberRow[] = [];
		const stale: string[] = [];
		let sourceMissing = false;
		for (const problem of problems) {
			const member = memberName(located.dir, problem.dest);
			const installedDigest = io.digest(problem.dest);
			const sourceDigest = problem.src === null ? null : io.digest(problem.src);
			let status: HookMemberStatus;
			if (installedDigest === null) {
				status = "MISSING";
			} else if (sourceDigest === null) {
				status = "SOURCE_MISSING";
				sourceMissing = true;
			} else {
				status = "STALE";
			}
			if (status === "MISSING" || status === "STALE") stale.push(member);
			members.push({ member, installed_sha256: installedDigest, source_sha256: sourceDigest, status });
		}
		rows.push({
			repo, source: entry.source, hooks_dir: located.dir, hooks_path_config: located.config,
			tracked: located.tracked, members, stale,
			state: stale.length > 0 ? "STALE" : sourceMissing ? "SOURCE_MISSING" : "FRESH",
		});
	}
	return rows;
}

export async function inspectHooks(io: HookFreshnessIo): Promise<Finding[]> {
	const rows = await censusHookFreshness(io);
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
				? `Rerun the hook installer in each stale repo (sh <release>/scripts/install-commit-msg-bead.sh <repo>); ${trackedPending.map((repo) => basename(repo)).join(", ")} track(s) files in its hooks path: the installer git-ignores the members it writes, and its director commits or untracks any refreshed member it still tracks, with a Bead: trailer under a reservation — kit-update never commits them.`
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

/** Use the installers' complete manifests, not the fleet census's mirrored subset. */
export async function inspectHookInstallers(repo: string, kitRoot: string): Promise<Finding[]> {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const findings: Finding[] = [];
	for (const installer of ["install-pre-push-gate.sh", "install-commit-msg-bead.sh"]) {
		const script = join(kitRoot, "scripts", installer);
		// The fresh-gate installer installs its own checkout; the bead installer
		// explicitly accepts a target repo. Never suggest passing it to the former.
		const repair = installer === "install-pre-push-gate.sh"
			? `cd ${quote(repo)} && sh scripts/install-pre-push-gate.sh`
			: `sh ${quote(script)} ${quote(repo)}`;
		try {
			const result = await run(["sh", script, "--check", repo], { deadline_s: 30, max_output_bytes: 64 * 1024 });
			const complete = !result.timed_out && !result.killed && !result.truncated;
			const status = complete && result.rc === 0 ? "OK" : complete && result.rc === 3 ? "DRIFT" : "UNVERIFIED";
			const output = `${Buffer.from(result.stdout).toString("utf8")}\n${Buffer.from(result.stderr).toString("utf8")}`.trim();
			findings.push({
				component: "hooks", status,
				reason: `${repo}: ${installer} --check: ${status}\n${output}`,
				recommended_action: status === "OK" ? "No action required." : `Reinstall: ${repair}; then rerun omp-kit doctor --scope hooks --project ${quote(repo)}.`,
				evidence: { repo, installer: script, rc: result.rc, timed_out: result.timed_out, truncated: result.truncated, output, reinstall_command: repair },
			});
		} catch (error) {
			findings.push({
				component: "hooks", status: "UNVERIFIED",
				reason: `${repo}: ${installer} --check could not run: ${error instanceof Error ? error.message : String(error)}`,
				recommended_action: `Reinstall: ${repair}; then rerun the hooks doctor.`,
				evidence: { repo, installer: script, reinstall_command: repair },
			});
		}
	}
	return findings;
}

/** The subset of absolute paths git tracks in repo (ls-files); a path git cannot answer for counts as tracked. */
function trackedPaths(repo: string, paths: string[]): string[] {
	const listed = gitOut(repo, ["ls-files", "-z", "--", ...paths.map((path) => relative(repo, path))]);
	if (listed === null) return paths;
	const tracked = new Set(listed.split("\0").filter((rel) => rel.length > 0).map((rel) => resolve(repo, rel)));
	return paths.filter((path) => tracked.has(resolve(path)));
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

/**
 * Check one repo with the active release's installer through the bounded
 * run() primitive (never spawnSync: the installer forks).
 */
async function liveCheck(kitRoot: string, repo: string): Promise<HookCheckResult> {
	try {
		const result = await run(["sh", join(kitRoot, "scripts/install-commit-msg-bead.sh"), "--check", repo], { deadline_s: 30, max_output_bytes: 64 * 1024 });
		const output = `${Buffer.from(result.stdout).toString("utf8")}\n${Buffer.from(result.stderr).toString("utf8")}`;
		return { rc: result.rc, output };
	} catch {
		return { rc: null, output: "" };
	}
}
function liveFreshnessExtras(kitRoot: string): Pick<HookFreshnessIo, "check" | "hasKitMembers"> {
	return {
		check: (repo) => liveCheck(kitRoot, repo),
		hasKitMembers: (dir) => {
			try {
				return dirHasKitMembers(dir);
			} catch {
				return false;
			}
		},
	};
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
			const dir = resolveHooksDir(repo);
			if (dir === null) return { dir: null, config, tracked: false };
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
		...liveFreshnessExtras(kitRoot),
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
	/** Installed abs paths changed by the installer; for PENDING_COMMIT, only the tracked ones (the owner's commit set). */
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

async function safeCheck(io: HookFreshnessIo, repo: string): Promise<HookCheckResult> {
	try {
		return await io.check(repo);
	} catch {
		return { rc: null, output: "" };
	}
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
		let present = false;
		try {
			present = io.hasKitMembers(located.dir);
		} catch {
			present = false;
		}
		if (!present) {
			report.fresh += 1;
			report.results.push({ repo, source: entry.source, status: "FRESH", hooks_dir: located.dir, tracked: located.tracked, paths: [], members: [], detail: "no kit hook members installed; refresh never writes such a repo" });
			continue;
		}
		const beforeCheck = await safeCheck(io, repo);
		if (!checkUsable(beforeCheck)) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: located.dir, tracked: located.tracked, paths: [], members: [], detail: "pre-install --check unreadable; refusing to write what cannot be verified" });
			continue;
		}
		const before = new Map<string, string | null>();
		for (const problem of parseCheckMembers(beforeCheck.output)) before.set(problem.dest, io.digest(problem.dest));
		const ran = io.runInstaller(repo);
		if (!ran.ok) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: located.dir, tracked: located.tracked, paths: [], members: [], detail: ran.detail });
			continue;
		}
		const afterCheck = await safeCheck(io, repo);
		const members: HookMemberRefresh[] = [];
		const changed: string[] = [];
		const invalid: string[] = [];
		if (!checkUsable(afterCheck)) {
			invalid.push("--check unreadable after install");
		} else {
			const afterSet = new Set(parseCheckMembers(afterCheck.output).map((problem) => problem.dest));
			const dests = new Set<string>([...before.keys(), ...afterSet]);
			for (const dest of dests) {
				const was = before.has(dest) ? (before.get(dest) ?? null) : io.digest(dest);
				const after = io.digest(dest);
				const clean = !afterSet.has(dest) && after !== null;
				if (was !== after && after !== null) changed.push(dest);
				if (!clean) invalid.push(memberName(located.dir, dest));
				members.push({ member: memberName(located.dir, dest), before_sha256: was, after_sha256: after, refreshed: was !== after && clean });
			}
		}
		if (invalid.length > 0) {
			report.failed += 1;
			report.results.push({ repo, source: entry.source, status: "FAILED", hooks_dir: located.dir, tracked: located.tracked, paths: changed, members, detail: `installer left ${invalid.length} member(s) missing or mismatched: ${invalid.join(", ")}` });
		} else if (changed.length === 0) {
			report.fresh += 1;
			report.results.push({ repo, source: entry.source, status: "FRESH", hooks_dir: located.dir, tracked: located.tracked, paths: [], members, detail: "every member already matched the active release" });
		} else {
			// Owner route only for refreshed members the repo still tracks; the rest are git-ignored deployment artifacts.
			const trackedChanged = located.tracked ? trackedPaths(repo, changed) : [];
			if (trackedChanged.length > 0) {
				report.pending_commit += 1;
				report.results.push({ repo, source: entry.source, status: "PENDING_COMMIT", hooks_dir: located.dir, tracked: true, paths: trackedChanged, members, detail: `refreshed ${changed.length} member(s); ${trackedChanged.length} still tracked — the director commits or untracks them under a reservation` });
			} else {
				report.refreshed += 1;
				report.results.push({ repo, source: entry.source, status: "REFRESHED", hooks_dir: located.dir, tracked: located.tracked, paths: changed, members, detail: `refreshed ${changed.length} untracked member(s)` });
			}
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
		pullRepos: () => installedHookRepos(base).map((entry) => {
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

/** Production default for install paths: refresh repos with kit hooks installed. Never throws. */
export async function refreshFleetHooksLive(store: string, home: string): Promise<HookRefreshReport> {
	try {
		return await refreshFleetHooks(liveHookRefreshIo(home, store));
	} catch (error) {
		return { repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 1, results: [] };
	}
}
