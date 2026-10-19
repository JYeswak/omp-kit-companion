// doctor --scope plugin_release (FLEETUPG1, ompkit-v66l.22): the kit plugin
// each OMP profile LINKS against the latest PUBLISHED release, and the version
// each running seat LOADED. A seat loads its profile's plugin once, at start, so
// a seat started before the link last changed still runs the previous release.
// Read-only. No reachable release list gives UNKNOWN, never CURRENT.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Finding } from "./diagnostics.ts";

export type ReleaseVerdict = "CURRENT" | "STALE" | "UNKNOWN";
export type PluginLink = { profile: string; path: string; target: string | null; version: string | null; linkedAtMs: number | null };
export type OmpSeat = { pid: number; startedAtMs: number; profile: string };
export interface PluginReleaseIo {
	/** Latest published release version without the leading v; null when it cannot be read. */
	latestPublished(): string | null;
	links(): PluginLink[];
	/** Running omp processes; null when the process table cannot be read. */
	seats(): OmpSeat[] | null;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
export const DEFAULT_RELEASE_REPO = "JYeswak/omp-kit-companion";

/** Numeric x.y.z order; null when either side is not a plain release version. */
export function compareVersions(left: string, right: string): number | null {
	const a = VERSION.exec(left), b = VERSION.exec(right);
	if (!a || !b) return null;
	for (let index = 1; index <= 3; index++) {
		const delta = Number(a[index]) - Number(b[index]);
		if (delta !== 0) return Math.sign(delta);
	}
	return 0;
}

function linkVerdict(version: string | null, latest: string | null): ReleaseVerdict {
	if (version === null || latest === null) return "UNKNOWN";
	const order = compareVersions(version, latest);
	return order === null ? "UNKNOWN" : order < 0 ? "STALE" : "CURRENT";
}

export function inspectPluginRelease(io: PluginReleaseIo): Finding {
	const latest = io.latestPublished();
	const links = io.links();
	const profiles = links.map((link) => ({
		profile: link.profile, path: link.path, linked: link.version, latest_published: latest,
		verdict: link.target === null ? "STALE" as ReleaseVerdict : linkVerdict(link.version, latest),
		...(link.target === null ? { reason: "plugin link is missing or broken" } : {}),
	}));
	const byProfile = new Map(links.map((link) => [link.profile, link]));
	const seatList = io.seats();
	const seats = (seatList ?? []).map((seat) => {
		const link = byProfile.get(seat.profile);
		const base = { pid: seat.pid, profile: seat.profile, started_at: new Date(seat.startedAtMs).toISOString() };
		if (!link || link.target === null || link.version === null || link.linkedAtMs === null)
			return { ...base, loaded: null, verdict: "UNKNOWN" as ReleaseVerdict, reason: "profile has no readable plugin link" };
		if (seat.startedAtMs < link.linkedAtMs)
			return { ...base, loaded: null, loaded_before: link.version, linked_at: new Date(link.linkedAtMs).toISOString(), verdict: "STALE" as ReleaseVerdict, reason: `started before the link moved to ${link.version}` };
		return { ...base, loaded: link.version, verdict: linkVerdict(link.version, latest) };
	});
	const staleProfiles = profiles.filter((row) => row.verdict === "STALE").map((row) => row.profile);
	const staleSeats = seats.filter((row) => row.verdict === "STALE").map((row) => row.pid);
	const unknown = latest === null || seatList === null || !links.length || profiles.some((row) => row.verdict === "UNKNOWN") || seats.some((row) => row.verdict === "UNKNOWN");
	const status = staleProfiles.length || staleSeats.length ? "DEGRADED" : unknown ? "UNVERIFIED" : "OK";
	const reason = [
		latest === null ? "Latest published release is UNKNOWN (gh unavailable or offline)" : `Latest published release ${latest}`,
		`${profiles.length - staleProfiles.length} of ${profiles.length} profile link(s) not behind it${staleProfiles.length ? `; STALE: ${staleProfiles.join(", ")}` : ""}`,
		seatList === null ? "running seats UNKNOWN (process table unreadable)" : `${staleSeats.length} of ${seats.length} running seat(s) STALE on loaded version${staleSeats.length ? ` (pids ${staleSeats.join(", ")})` : ""}`,
	].join("; ");
	const action = staleProfiles.length
		? "Run omp-kit apply plugin --apply --yes --profiles all --include-default, then restart seats at an idle boundary."
		: staleSeats.length ? "Restart the STALE seats at an idle boundary so they load the linked release."
			: unknown ? "Rerun with gh authenticated and online; a release that cannot be read is never CURRENT." : "No action required.";
	return { component: "plugin_release", status, reason, recommended_action: action,
		evidence: { latest_published: latest, profiles, seats, stale_profiles: staleProfiles, stale_seats: staleSeats } };
}

function readLink(profile: string, path: string): PluginLink {
	try {
		const linkedAtMs = lstatSync(path).mtimeMs;
		const target = realpathSync(path);
		let version: string | null = VERSION.test(basename(target)) ? basename(target) : null;
		if (version === null) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
				const value = parsed && typeof parsed === "object" && "version" in parsed ? parsed.version : null;
				version = typeof value === "string" && VERSION.test(value) ? value : null;
			} catch {}
		}
		return { profile, path, target, version, linkedAtMs };
	} catch { return { profile, path, target: null, version: null, linkedAtMs: null }; }
}

const PROFILE_FLAG = /(?:^|\s)--profile(?:=|\s+)(\S+)/;
const PROFILE_PATH = /\/\.omp\/profiles\/([^/\s]+)\//;

/** Profile of an omp argv: --profile wins, else a profile session path, else default. */
export function seatProfile(args: string): string {
	return PROFILE_FLAG.exec(args)?.[1] ?? PROFILE_PATH.exec(args)?.[1] ?? "default";
}

export function livePluginReleaseIo(home: string, env: NodeJS.ProcessEnv = process.env): PluginReleaseIo {
	return {
		latestPublished: () => {
			const repo = env.OMP_KIT_UPDATE_REPO || DEFAULT_RELEASE_REPO;
			const result = spawnSync("gh", ["release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"], { encoding: "utf8", timeout: 15_000 });
			const tag = result.status === 0 ? (result.stdout ?? "").trim().replace(/^v/, "") : "";
			return VERSION.test(tag) ? tag : null;
		},
		links: () => {
			const rows = [readLink("default", join(home, ".omp", "plugins", "node_modules", "omp-kit-companion"))];
			let names: string[] = [];
			try { names = readdirSync(join(home, ".omp", "profiles")).sort(); } catch {}
			for (const name of names) {
				const path = join(home, ".omp", "profiles", name, "plugins", "node_modules", "omp-kit-companion");
				try { lstatSync(path); } catch { continue; } // A profile without the kit plugin is not a kit profile.
				rows.push(readLink(name, path));
			}
			return rows;
		},
		seats: () => {
			const result = spawnSync("ps", ["-axo", "pid=,lstart=,args="], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...env, LC_ALL: "C" } });
			if (result.status !== 0) return null;
			const seats: OmpSeat[] = [];
			for (const line of (result.stdout ?? "").split("\n")) {
				const match = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\S+)(.*)$/.exec(line);
				if (!match || basename(match[3]!) !== "omp") continue;
				const startedAtMs = new Date(match[2]!).getTime();
				if (Number.isFinite(startedAtMs)) seats.push({ pid: Number(match[1]), startedAtMs, profile: seatProfile(match[4]!) });
			}
			return seats;
		},
	};
}

// Own entry point until doctor --scope plugin_release is wired: bun src/plugin-release.ts [HOME]; exit 1 unless OK.
if (import.meta.main) {
	const result = inspectPluginRelease(livePluginReleaseIo(process.argv[2] ?? process.env.HOME ?? ""));
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = result.status === "OK" ? 0 : 1;
}
