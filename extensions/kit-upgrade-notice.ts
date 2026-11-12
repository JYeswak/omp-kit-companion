/**
 * kit-upgrade-notice (AUTOUPGRADE1 ompkit-v66l.22.1, J-2026-10-18-39 step 1): the seat's own kit extension
 * detects the gap between the installed omp-kit release and the release its process loaded, and injects
 * exactly one notice per release per seat with pi.sendMessage (deliverAs nextTurn when idle, aside when
 * busy): 'omp-kit <installed> is installed; this seat runs <loaded>; upgrade now', plus how to restart.
 * Every seat upgrades now, paused goal or stopped project included (J-2026-11-09-03; PAUSEDRESTART1 retired):
 * the restart keeps an owner-paused goal paused, so upgrading never resumes paused work.
 * Fleet mode (SELFRESTART1 ompkit-v66l.33, J-2026-10-20-08/09; SELFRESTARTBUSY1 ompkit-1ra0d.221): the seat
 * restarts ITSELF from the notice: save work, run the self-restart helper (one command, which records the
 * request and returns at once), then end the turn with no further tool call. A detached watcher waits for
 * the pane's idle prompt and an empty composer, then types omp's own /restart (which replaces the process)
 * and resumes an active goal once (NATIVERESTART1 ompkit-2un74); no sentinel or chief loop is involved
 * (retired by ompkit-1ra0d.37). Parking the tool call instead would hold the turn, so the pane would never
 * idle and the watcher could never send /restart.
 * Fleet mode means the helper is installed (the configured restart command, SELF_RESTART_SCRIPT under home).
 * Stock mode (no helper) names no fleet command: it says how to restart omp.
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
import { mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
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
/**
 * UPGRADENOTES1 (ompkit-1ra0d.209): anchored section/bullet patterns (same weakest-sufficient
 * discipline: no `g` flag, exclusive classes, one line at a time). A section opens on a line that
 * is exactly `## [X.Y.Z]` plus trailing text; a bullet is a line starting with `- ` and a
 * non-blank first character.
 */
const CHANGELOG_SECTION = /^## \[(\d+\.\d+\.\d+)\][^\n]*$/;
const CHANGELOG_BULLET = /^- [^ \t\n][^\n]*$/;
/** About 40 lines / 6 KB of bullets; the rest folds into the 'and N more' line. */
const MAX_CHANGELOG_LINES = 40;
const MAX_CHANGELOG_BYTES = 6144;

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

/** The configured restart command: the fleet's self-restart helper, relative to home. Its presence is fleet mode. */
export const SELF_RESTART_SCRIPT = join(".claude", "skills", "omp-kit-orchestration", "scripts", "self_restart.py");
export const SELF_RESTART_COMMAND = "python3 ~/.claude/skills/omp-kit-orchestration/scripts/self_restart.py";

/**
 * UPGRADENOTES1 (ompkit-1ra0d.209): the installed release's changelog, read through the caller's
 * injectable readFile dep. Undefined (or missing) text means today's exact notice, unchanged.
 */
export interface ChangelogNotes {
	path: string;
	text: string | undefined;
}

/**
 * The `- ` bullets of every `## [X.Y.Z]` section with loaded < X.Y.Z <= installed, newest
 * section first, capped at MAX_CHANGELOG_LINES / MAX_CHANGELOG_BYTES. Returns the taken bullets
 * plus how many were omitted by the cap.
 */
export function selectChangelogBullets(loaded: string, installed: string, text: string): { bullets: string[]; omitted: number } {
	const sections: { version: string; bullets: string[] }[] = [];
	for (const line of text.split("\n")) {
		const heading = CHANGELOG_SECTION.exec(line);
		if (heading?.[1] !== undefined) {
			sections.push({ version: heading[1], bullets: [] });
			continue;
		}
		if (sections.length > 0 && CHANGELOG_BULLET.exec(line) !== null) sections[sections.length - 1]!.bullets.push(line);
	}
	const wanted = sections
		.filter(section => compareSemver(loaded, section.version) < 0 && compareSemver(section.version, installed) <= 0)
		.sort((a, b) => compareSemver(b.version, a.version));
	const all = wanted.flatMap(section => section.bullets);
	const taken: string[] = [];
	let bytes = 0;
	for (const bullet of all) {
		if (taken.length >= MAX_CHANGELOG_LINES || bytes + bullet.length + 1 > MAX_CHANGELOG_BYTES) break;
		taken.push(bullet);
		bytes += bullet.length + 1;
	}
	return { bullets: taken, omitted: all.length - taken.length };
}

/**
 * The notice body: the gap plus the restart steps. Fleet mode: (1) save work, (2) run the self-restart helper,
 * (3) end the turn with no further tool call. Stock mode: only how to restart omp to load the release.
 * With the installed release's changelog, both modes append the bullets newer than the seat's release.
 */
export function upgradeNoticeMessage(installed: string, loaded: string, fleet = false, notes?: ChangelogNotes): string {
	const head = `kit-upgrade-notice ${UPGRADE_NOTICE}: omp-kit ${installed} is installed; this seat runs ${loaded}; upgrade now.\n`;
	let body: string;
	if (!fleet) {
		body =
			head +
			`To load the new release, restart omp: save your work, exit omp, then start it again ` +
			`with \`omp --resume\` to continue this session on ${installed}.`;
	} else {
		body =
			head +
			`At your next turn boundary, without starting new work, restart this seat yourself:\n` +
			`1. On omp 18.18.1 or later, running background task agents keep working across the restart. On an older ` +
			`omp, first collect each running agent's result (or message it to wrap up and wait for its report): the ` +
			`helper refuses while one still runs there (REFUSED_LIVE_AGENTS). Then save your work: ` +
			`\`git commit --only -m "<msg>" -- <your reserved paths>\` and publish, or a \`[pending]\` commit.\n` +
		`2. Run the self-restart helper: \`${SELF_RESTART_COMMAND}\` — it records the request and returns at once.\n` +
		`3. End your turn with no further tool call: a detached watcher sends omp's own \`/restart\` once this ` +
		`pane is idle with an empty composer (same session and launch flags) on omp-kit ${installed}, and your ` +
		`goal resumes once if it was active. If no restart happens, read the watcher's log path the helper ` +
		`printed and report it.\n` +
			`A background task subagent is not the seat: ignore this notice and finish your task. Only the seat ` +
			`restarts the seat, and the helper refuses a subagent (REFUSED_SUBAGENT).`;
	}
	if (notes?.text === undefined) return body;
	const { bullets, omitted } = selectChangelogBullets(loaded, installed, notes.text);
	if (bullets.length === 0 && omitted === 0) return body;
	let tail = `\nWhat changed since ${loaded}:\n${bullets.join("\n")}`;
	if (omitted > 0) tail += `\nand ${omitted} more; full notes: ${notes.path}`;
	return body + tail;
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
	cwd?: string;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	sessionManager?: { getSessionId?: () => string | undefined; getEntries?: () => readonly unknown[] };
	isIdle?: () => boolean;
}

export interface UpgradeNoticeDeps {
	/** Override import.meta.url (tests; production reads its own installed path). */
	selfPath?: string;
	/** Override homedir (tests). */
	home?: string;
	/** Override the session id (tests). */
	session?: string;
	/** Override TTY detection (tests). Production reads process.stdout.isTTY: a headless
	print-mode run has piped stdio and must never receive the notice (v66l.22.2 rework:
	it has no idle semantics, so the save-and-end-idle instruction only kills work). */
	isTTY?: boolean;
	/** Seams for the two filesystem reads and the marker write (tests inject fakes). */
	readlink?: (path: string) => string;
	readFile?: (path: string) => string | undefined;
	writeFile?: (path: string, content: string) => void;
	/** Seam for fleet-mode detection: true when the path is a regular file (tests inject fakes). */
	isFile?: (path: string) => boolean;
}

function defaultIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
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
			const tty = deps.isTTY ?? process.stdout?.isTTY === true;
			if (!tty) return; // headless print-mode run: no idle semantics, never notice, never consume the one-notice marker
			const session = deps.session ?? ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
			if (session === "unknown-session") return; // no session identity: not a fleet seat, never notice
			const file = join(home, ".local", "state", "omp-kit", `upgrade-notice-${sessionKey(session)}.json`);
			const sent = readSentReleases(file, deps);
			if (sent.includes(gap.installed)) {
				sentMemory.add(gap.installed);
				return; // an earlier session already noticed this release: never repeated
			}
			// UPGRADENOTES1 (ompkit-1ra0d.209): the installed release's changelog, read through the
			// injectable readFile dep. A missing or unreadable file reads undefined and keeps
			// today's exact notice.
			const changelogPath = join(home, ".local", "opt", "omp-kit", "releases", gap.installed, "CHANGELOG.md");
			const notes: ChangelogNotes = { path: changelogPath, text: (deps.readFile ?? defaultReadFile)(changelogPath) };
			pi.sendMessage(
				{
					customType: "kit-upgrade-notice",
					content: upgradeNoticeMessage(gap.installed, gap.loaded, (deps.isFile ?? defaultIsFile)(join(home, SELF_RESTART_SCRIPT)), notes),
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
