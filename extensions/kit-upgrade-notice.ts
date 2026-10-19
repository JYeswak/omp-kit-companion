/**
 * kit-upgrade-notice (AUTOUPGRADE1 ompkit-v66l.22.1, J-2026-10-18-39 step 1): the seat's own kit extension
 * detects the gap between the installed omp-kit release and the release its process loaded, and injects
 * exactly one notice per release per seat with pi.sendMessage (deliverAs nextTurn when idle, aside when
 * busy): 'omp-kit <installed> is installed; this seat runs <loaded>; upgrade now', plus the three seat-duty
 * steps (save, handoff, end the turn idle). The chief's loop_sentinel restarts the idle seat from there.
 *
 * Loaded release: this file ships inside releases/<v>/extensions/, so the module's own path names the
 * loaded release. A checkout path (no /releases/<X.Y.Z>/) reads null and never notices. Installed release:
 * the ~/.local/opt/omp-kit/bin/omp-kit symlink target (../releases/<v>/bin/omp-kit), the same link the
 * kit-update job relinks on every install. Sent markers persist per seat under ~/.local/state/omp-kit/
 * so a restarted seat never repeats a release; memory dedupes within the session. Any failure is fail-open
 * (a notice that cannot be proven is skipped, warned once): blocking the seat on version I/O would be worse
 * than a missed notice, and the sentinel's own start-time comparison still queues the seat.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UPGRADE_NOTICE = "UPGRADE_NOTICE";

/**
 * Regex note (regex-engineering): weakest sufficient engine (one JS RegExp, no `g` flag so no lastIndex
 * state). Both patterns are anchored literals around exclusive classes: digits versus literal dots and
 * slashes, so no span is owned twice and matching is input-linear. Inputs are capped at MAX_PATH_LEN
 * before matching; the 1 MiB adversarial case in the test completes without hanging.
 */
const MAX_PATH_LEN = 4096;
const RELEASES_SEGMENT = /\/releases\/(\d+\.\d+\.\d+)\//;
const INSTALLED_TARGET = /^\.\.\/releases\/(\d+\.\d+\.\d+)\/bin\/omp-kit$/;

/** The release this process loaded, from the extension's own installed path, or null outside releases/. */
export function loadedRelease(selfPath: string | undefined): string | null {
	if (typeof selfPath !== "string" || selfPath === "") return null;
	const match = RELEASES_SEGMENT.exec(selfPath.slice(0, MAX_PATH_LEN));
	return match?.[1] ?? null;
}

/** The installed release, from the kit bin symlink target, or null for anything else. */
export function installedRelease(linkTarget: string): string | null {
	if (typeof linkTarget !== "string") return null;
	const match = INSTALLED_TARGET.exec(linkTarget.slice(0, MAX_PATH_LEN));
	return match?.[1] ?? null;
}

function parts(version: string): [number, number, number] {
	const [major, minor, patch] = version.split(".").map(Number);
	return [major ?? 0, minor ?? 0, patch ?? 0];
}

/** Numeric X.Y.Z comparison (0.2.7 < 0.2.55: lexicographic string order would lie). Callers pass parsed versions. */
export function compareSemver(a: string, b: string): number {
	const [am, an, ap] = parts(a);
	const [bm, bn, bp] = parts(b);
	return am - bm || an - bn || ap - bp;
}

/** The gap to notice, or null when current, ahead, or either side unknown. */
export function upgradeGap(loaded: string | null, installed: string | null): { installed: string; loaded: string } | null {
	if (loaded === null || installed === null) return null;
	if (compareSemver(installed, loaded) <= 0) return null;
	return { installed, loaded };
}

/** The notice body: the gap plus the three seat-duty steps (save, handoff, end idle). */
export function upgradeNoticeMessage(installed: string, loaded: string): string {
	return (
		`kit-upgrade-notice ${UPGRADE_NOTICE}: omp-kit ${installed} is installed; ` +
		`this seat runs ${loaded}; upgrade now.\n` +
		`At your next turn boundary, without starting new work:\n` +
		`1. Save your work (git commit --only and publish, or a [pending] commit).\n` +
		`2. Write your handoff (respawn_seat handoff ledger).\n` +
		`3. End your turn idle; the chief's loop_sentinel will restart this seat ` +
		`with respawn_seat --reload --resume-goal.`
	);
}

/** Filesystem-safe per-seat marker key: session ids carry slashes, so they hash. */
export function sessionKey(session: string): string {
	return createHash("sha256").update(session, "utf8").digest("hex").slice(0, 16);
}

export interface UpgradeNoticeApi {
	on(event: "session_start", handler: (event: unknown, ctx: UpgradeNoticeContext) => unknown): void;
	on(event: "tool_execution_end", handler: (event: unknown, ctx: UpgradeNoticeContext) => unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: { behavior: string } },
		options?: { deliverAs?: "nextTurn" | "aside" },
	): void;
}

export interface UpgradeNoticeContext {
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	sessionManager?: { getSessionId?: () => string | undefined };
	isIdle?: () => boolean;
}

export interface UpgradeNoticeDeps {
	/** Override import.meta.url (tests; production reads its own installed path). */
	selfPath?: string;
	/** Override homedir (tests). */
	home?: string;
	/** Override the session id (tests). */
	session?: string;
	/** Seams for the two filesystem reads and the marker write (tests inject fakes). */
	readlink?: (path: string) => string;
	readFile?: (path: string) => string | undefined;
	writeFile?: (path: string, content: string) => void;
}

function defaultReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function defaultWriteFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { mode: 0o600 });
}

function readSentReleases(path: string, deps: UpgradeNoticeDeps): string[] {
	const raw = (deps.readFile ?? defaultReadFile)(path);
	if (raw === undefined) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

export default async function kitUpgradeNotice(pi: UpgradeNoticeApi, deps: UpgradeNoticeDeps = {}): Promise<void> {
	const sentMemory = new Set<string>();
	let warned = false;
	const check = (_event: unknown, ctx: UpgradeNoticeContext) => {
		try {
			const loaded = loadedRelease(deps.selfPath ?? import.meta.url);
			if (loaded === null) return;
			const home = deps.home ?? homedir();
			let target: string;
			try {
				target = (deps.readlink ?? readlinkSync)(join(home, ".local", "opt", "omp-kit", "bin", "omp-kit"));
			} catch {
				return; // no kit symlink: nothing installed to compare, never notice
			}
			const gap = upgradeGap(loaded, installedRelease(target));
			if (gap === null || sentMemory.has(gap.installed)) return;
			const session = deps.session ?? ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
			const file = join(home, ".local", "state", "omp-kit", `upgrade-notice-${sessionKey(session)}.json`);
			const sent = readSentReleases(file, deps);
			if (sent.includes(gap.installed)) {
				sentMemory.add(gap.installed);
				return; // an earlier session already noticed this release: never repeated
			}
			pi.sendMessage(
				{
					customType: "kit-upgrade-notice",
					content: upgradeNoticeMessage(gap.installed, gap.loaded),
					display: true,
					details: { behavior: UPGRADE_NOTICE },
				},
				// Idle: append to context now. Busy (mid-turn): inject at the next step boundary.
				{ deliverAs: ctx.isIdle?.() === false ? "aside" : "nextTurn" },
			);
			sentMemory.add(gap.installed);
			(deps.writeFile ?? defaultWriteFile)(file, JSON.stringify([...sent, gap.installed]));
		} catch (error) {
			if (!warned) {
				warned = true;
				ctx.ui?.notify(
					`kit-upgrade-notice: check failed (${error instanceof Error ? error.message : String(error)}); notice skipped.`,
					"warning",
				);
			}
		}
	};
	// session_start covers fresh seats; tool_execution_end covers seats already running when a release
	// installs (the next tool result re-checks, but a sent release never re-sends).
	pi.on("session_start", check);
	pi.on("tool_execution_end", check);
}
