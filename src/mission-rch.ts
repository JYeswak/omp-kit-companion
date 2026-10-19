// doctor --scope mission (ompkit-5vph): for every repo the fleet works in, does it build through rch, and does its
// gate use the kit lease (`omp-kit rch lease`) or a repo-local copy of the old uds lease script?
// The Mission Protocol registry (MP6, ompkit-rc-epic-land-fix-release-dogfood-rz5.98) is not built yet, so the repo set
// is the one every other fleet scope uses: the repos fleet-watch.json names. `MissionRchIo.repos` is the seam for MP6.
// Read-only: every observation goes through MissionRchIo, which only lists and reads files.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { fleetWatchRepos } from "./scratch.ts";

export interface MissionRchIo {
	/** Absolute repo paths, with where each came from. */
	repos(): { repo: string; source: string }[];
	/** Entry names of a directory; null when absent or unreadable. */
	listDir(path: string): string[] | null;
	/** Regular-file text up to the size cap; null for anything else. */
	readText(path: string): string | null;
	isDir(path: string): boolean;
}

/** Where a repo keeps the commands its gate runs. Bounded: these directories, two levels deep, plus the root build files. */
const GATE_DIRS: readonly string[] = ["scripts", ".omp", ".githooks", ".husky", ".github/workflows"];
const GATE_FILES: readonly string[] = ["Makefile", "justfile", "Justfile"];
const MAX_DEPTH = 2;
const MAX_FILES = 400;
const KIT_LEASE = /\bomp-kit[ \t]+rch[ \t]+lease\b/;
// A command that submits a build to rch directly, or the old uds lease script by name.
const RCH_BUILD = /\brch[ \t]+(?:exec|cargo)\b|\brch-lease\b/;
// The uds script's own refusal token: a local re-implementation of the lease says it.
const LOCAL_LEASE_TOKEN = /\brch_capacity_unavailable\b/;
const LOCAL_LEASE_NAME = /^rch-lease[A-Za-z0-9_.-]*$/;
/** A doc mentioning the refusal token is not a lease script: only script-like files count. */
const SCRIPT_EXTENSIONS: readonly string[] = ["", ".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts", ".mts"];

export interface MissionRchRow {
	repo: string;
	source: string;
	state: MissionRchState;
	/** Repo-relative files that call the kit lease. */
	kit_lease_in: string[];
	/** Repo-relative files that submit to rch directly. */
	rch_in: string[];
	/** Repo-relative files that are a repo-local lease script (the old uds one or a copy). */
	local_lease: string[];
	files_scanned: number;
}

function gateFiles(io: MissionRchIo, repo: string): string[] {
	const found: string[] = [];
	for (const name of GATE_FILES) if (io.listDir(join(repo, name)) === null && io.readText(join(repo, name)) !== null) found.push(name);
	const walk = (relative: string, depth: number): void => {
		const entries = io.listDir(join(repo, relative));
		if (entries === null) return;
		for (const name of [...entries].sort()) {
			if (found.length >= MAX_FILES) return;
			const child = join(relative, name);
			if (io.isDir(join(repo, child))) {
				if (depth < MAX_DEPTH) walk(child, depth + 1);
			} else {
				found.push(child);
			}
		}
	};
	for (const dir of GATE_DIRS) walk(dir, 0);
	return found;
}

export function censusMissionRch(io: MissionRchIo): MissionRchRow[] {
	const seen: Record<string, true> = {};
	const rows: MissionRchRow[] = [];
	for (const { repo, source } of io.repos()) {
		if (seen[repo] === true) continue;
		seen[repo] = true;
		const row: MissionRchRow = { repo, source, state: "NOT_RCH", kit_lease_in: [], rch_in: [], local_lease: [], files_scanned: 0 };
		if (!io.isDir(repo)) {
			rows.push({ ...row, state: "UNREADABLE" });
			continue;
		}
		for (const file of gateFiles(io, repo)) {
			const text = io.readText(join(repo, file));
			if (text === null) continue;
			row.files_scanned += 1;
			const callsKit = KIT_LEASE.test(text);
			if (callsKit) row.kit_lease_in.push(file);
			// The kit's own lease mentions rch exec and the refusal token in prose; only a file that does not call the kit is a candidate.
			// A doc mentioning the refusal token is not a lease script: only script-like files count.
			const scriptLike = SCRIPT_EXTENSIONS.some((ext) => ext === "" ? !basename(file).includes(".") : basename(file).endsWith(ext));
			if (!callsKit && scriptLike && (LOCAL_LEASE_NAME.test(basename(file)) || LOCAL_LEASE_TOKEN.test(text))) row.local_lease.push(file);
			if (RCH_BUILD.test(text) || LOCAL_LEASE_NAME.test(basename(file))) row.rch_in.push(file);
		}
		const buildsThroughRch = row.rch_in.length > 0 || row.kit_lease_in.length > 0 || io.isDir(join(repo, ".rch"));
		row.state = row.local_lease.length > 0 ? "LOCAL_LEASE_SCRIPT" : !buildsThroughRch ? "NOT_RCH" : row.kit_lease_in.length > 0 ? "KIT_LEASE" : "NO_KIT_LEASE";
		rows.push(row);
	}
	return rows;
}

export function inspectMissionRch(io: MissionRchIo): Finding[] {
	const rows = censusMissionRch(io);
	const rch = rows.filter((row) => row.state !== "NOT_RCH" && row.state !== "UNREADABLE");
	const bad = rch.filter((row) => row.state === "LOCAL_LEASE_SCRIPT" || row.state === "NO_KIT_LEASE");
	const unreadable = rows.filter((row) => row.state === "UNREADABLE");
	const summary: Finding = {
		component: "mission_rch",
		status: rows.length === 0 ? "UNVERIFIED" : bad.length > 0 ? "DEGRADED" : unreadable.length > 0 ? "UNVERIFIED" : "OK",
		reason: rows.length === 0
			? "No repo list: fleet-watch.json names none, so no repo was checked"
			: `${rows.length} repo(s), ${rch.length} build through rch, ${rch.length - bad.length} of those gate on omp-kit rch lease`
				+ (bad.length ? `; ${bad.length} do not: ${bad.map((row) => `${basename(row.repo)} (${row.state === "LOCAL_LEASE_SCRIPT" ? `local lease script ${row.local_lease.join(", ")}` : "no omp-kit rch lease in its gate"})`).join("; ")}` : "")
				+ (unreadable.length ? `; ${unreadable.length} repo path(s) unreadable` : ""),
		recommended_action: bad.length > 0
			? "Replace each repo-local lease script and each direct rch call in a gate with `omp-kit rch lease --slots N -- COMMAND`, then delete the local script in its repo."
			: rows.length === 0 ? "Register the fleet repos in fleet-watch.json (the Mission Protocol registry, MP6, is not built yet)." : "No action required.",
		evidence: { source: "fleet-watch.json (MP6 registry not built)", repos: rows.length, rch_repos: rch.length, not_rch: rows.filter((row) => row.state === "NOT_RCH").length,
			unreadable: unreadable.map((row) => row.repo), without_kit_lease: bad.map((row) => row.repo) },
	};
	const perRepo = rch.map((row): Finding => ({
		component: `mission_rch:${basename(row.repo)}`,
		status: row.state === "KIT_LEASE" ? "OK" : "DEGRADED",
		reason: row.state === "KIT_LEASE" ? `gate calls omp-kit rch lease (${row.kit_lease_in.join(", ")})`
			: row.state === "LOCAL_LEASE_SCRIPT" ? `repo-local lease script ${row.local_lease.join(", ")} instead of omp-kit rch lease`
				: `builds through rch (${row.rch_in.join(", ")}) with no omp-kit rch lease in its gate`,
		recommended_action: row.state === "KIT_LEASE" ? "No action required." : "Gate the build with `omp-kit rch lease --slots N -- COMMAND` and remove the local lease script.",
		evidence: { ...row },
	}));
	return [summary, ...perRepo];
}

const MAX_FILE_BYTES = 256 * 1024;

export function liveMissionRchIo(env: NodeJS.ProcessEnv = process.env): MissionRchIo {
	const home = env.HOME ?? homedir();
	return {
		repos: () => fleetWatchRepos(home).map((entry) => {
			try { return { repo: realpathSync(entry.repo), source: entry.source }; } catch { return entry; }
		}),
		listDir: (path) => { try { return readdirSync(path); } catch { return null; } },
		readText: (path) => {
			try {
				const stat = lstatSync(path);
				return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync(path, "utf8") : null;
			} catch { return null; }
		},
		isDir: (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } },
	};
}
