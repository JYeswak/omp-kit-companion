import { fstatSync, openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlywheelExec } from "./kit-flywheel-guard";

export interface PriorArtDeps {
	exec: FlywheelExec;
	env: Record<string, string | undefined>;
	home: string;
}

const STOPWORDS: Record<string, true> = {
	a: true, an: true, the: true, and: true, or: true, but: true, if: true, then: true, else: true,
	when: true, at: true, by: true, for: true, with: true, about: true, into: true, through: true,
	during: true, before: true, after: true, above: true, below: true, to: true, from: true,
	up: true, down: true, in: true, out: true, on: true, off: true, over: true, under: true,
	again: true, further: true, once: true, here: true, there: true, where: true, why: true,
	how: true, all: true, any: true, both: true, each: true, few: true, more: true, most: true,
	other: true, some: true, such: true, no: true, nor: true, not: true, only: true, own: true,
	same: true, so: true, than: true, too: true, very: true, can: true, will: true, just: true,
	should: true, now: true, is: true, are: true, was: true, were: true, be: true, been: true,
	being: true, has: true, have: true, had: true, having: true, do: true, does: true,
	did: true, doing: true, would: true, could: true, ought: true, am: true, as: true,
	it: true, its: true, of: true, on: true, that: true, their: true, them: true, they: true,
	this: true, those: true, to: true, us: true, we: true, you: true, your: true, yours: true,
	within: true, without: true, between: true, among: true, per: true, via: true,
};

/** Lowercase words (>= 4 letters) that carry meaning, plus UPPERCASE+digit codenames. */
export function priorArtKeywords(title: string): { words: string[]; codes: string[] } {
	const codes = new Set<string>();
	for (const match of title.matchAll(/\b[A-Z]{2,}[0-9]+\b/g)) codes.add(match[0]);
	const deidentified = title.replace(/\b[A-Z]{2,}[0-9]+\b/g, " ");
	const words = new Set<string>();
	for (const match of deidentified.toLowerCase().matchAll(/[a-z]{4,}/g)) {
		if (!STOPWORDS[match[0]]) words.add(match[0]);
	}
	return { words: [...words], codes: [...codes] };
}

/** Verbatim verbs that mark a commit as deleted/retired work. */
const RETIRE_WORDS = ["delete", "retire", "remove", "revert", "supersede"];

function isRetiredSubject(subject: string): boolean {
	const lower = subject.toLowerCase();
	return RETIRE_WORDS.some(word => lower.includes(word));
}

/** A text matches when it shares a codename or at least `need` keywords. Never throws. */
function textMatches(text: string, keywords: { words: string[]; codes: string[] }, need: number): boolean {
	if (keywords.codes.some(code => text.includes(code))) return true;
	if (need <= 0) return false;
	const tokens = new Set<string>();
	for (const match of text.toLowerCase().matchAll(/[a-z]{4,}/g)) tokens.add(match[0]);
	let shared = 0;
	for (const word of keywords.words) if (tokens.has(word) && ++shared >= need) return true;
	return false;
}

/** Read at most maxBytes of a file from its start; null when unreadable. */
function readHead(path: string, maxBytes: number): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const chunks: Buffer[] = [];
		let total = 0;
		const scratch = Buffer.allocUnsafe(Math.min(65536, maxBytes));
		while (total < maxBytes) {
			const got = readSync(fd, scratch, 0, Math.min(scratch.length, maxBytes - total), null);
			if (got <= 0) break;
			chunks.push(Buffer.from(scratch.subarray(0, got)));
			total += got;
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
	}
}

/** decisionsDir from $XDG_CONFIG_HOME/omp-kit/prior-art.json (~/.config when unset); null when absent or malformed. */
export function configuredDecisionsDir(env: Record<string, string | undefined>, home: string): string | null {
	const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	const text = readTail(join(base, "omp-kit", "prior-art.json"), 65536);
	if (text === null) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return null; }
	if (parsed === null || typeof parsed !== "object" || !("decisionsDir" in parsed)) return null;
	const value = parsed.decisionsDir;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Read at most maxBytes from a file's end, dropping a leading partial line; null when unreadable. */
function readTail(path: string, maxBytes: number): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.allocUnsafe(size - start);
		let total = 0;
		while (total < buffer.length) {
			const got = readSync(fd, buffer, total, buffer.length - total, start + total);
			if (got <= 0) break;
			total += got;
		}
		const text = buffer.subarray(0, total).toString("utf8");
		return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
	} catch {
		return null;
	} finally {
		if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
	}
}

export interface PriorArtSection {
	decisions: string[];
	beads: string[];
	deleted: string[];
	unavailable: string[];
}

/** The block attached to an admitted claim or create. Sections with no matches list "none". */
export function formatPriorArt(title: string, section: PriorArtSection): string {
	const list = (items: string[]): string => items.length > 0 ? items.join("; ") : "none";
	const parts = [
		`decisions: ${list(section.decisions)}`,
		`beads: ${list(section.beads)}`,
		`deleted/retired: ${list(section.deleted)}`,
	];
	for (const reason of section.unavailable) parts.push(`prior art unavailable: ${reason}`);
	return `PRIOR ART for ${title}: ${parts.join("; ")}. Read these before proposing a fix.`;
}

interface DecisionRow {
	id: string;
	text: string;
}

function decisionRows(dir: string, capFiles: number, capBytes: number): { rows: DecisionRow[]; error: string | null } {
	let names: string[];
	try {
		names = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
	} catch (error) {
		return { rows: [], error: `decisions unreadable (${error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "unknown"})` };
	}
	const withTime = names.map(name => {
		let mtime = 0;
		try {
			mtime = statSync(join(dir, name)).mtimeMs;
		} catch { /* treat as oldest */ }
		return { name, mtime };
	}).sort((a, b) => b.mtime - a.mtime).slice(0, capFiles);
	const rows: DecisionRow[] = [];
	for (const { name } of withTime) {
		// Registers are append-only: the newest decisions are at the end, so read the tail.
		const text = readTail(join(dir, name), capBytes);
		if (text === null) continue;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as Record<string, unknown>;
				const strings: string[] = [];
				for (const value of Object.values(row)) if (typeof value === "string") strings.push(value);
				// Only Joshua decisions (J-YYYY-...) count; sibling logs such as prompt reviews are not decisions.
				const id = typeof row.id === "string" ? row.id : "";
				if (/^J-\d{4}-\d{2}-\d{2}-\d+$/.test(id) && strings.length > 0) rows.push({ id, text: strings.join(" ").slice(0, 2000) });
			} catch { /* skip malformed lines */ }
		}
	}
	return { rows, error: null };
}

interface BeadRow {
	id: string;
	title: string;
	status: string;
	assignee: string | null;
}

function trackerRows(issuesPath: string, capBytes: number): { rows: BeadRow[]; error: string | null } {
	const text = readHead(issuesPath, 262144);
	if (text === null) return { rows: [], error: `tracker unreadable (${issuesPath})` };
	const rows: BeadRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (typeof row.id !== "string" || typeof row.title !== "string") continue;
			rows.push({ id: row.id, title: row.title, status: typeof row.status === "string" ? row.status : "",
				assignee: typeof row.assignee === "string" && row.assignee ? row.assignee : null });
		} catch { /* skip malformed lines */ }
	}
	return { rows, error: null };
}

function rankBead(status: string, assignee: string | null): number {
	const lower = status.toLowerCase();
	if (lower === "closed" || lower === "deferred" || lower === "superseded") return 0;
	if (lower === "open" && assignee === null) return 1;
	return 2;
}

/** Split a command into argv words, honoring single/double quotes and backslash escapes. */
function splitShellWords(text: string): string[] {
	const words: string[] = [];
	let current = "", quote: string | null = null, escaped = false;
	const flush = () => { words.push(current); current = ""; };
	let hasCurrent = false;
	for (const ch of text) {
		if (escaped) { current += ch; hasCurrent = true; escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote !== null) {
			if (ch === quote) quote = null;
			else { current += ch; hasCurrent = true; }
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; hasCurrent = true; continue; }
		if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			if (hasCurrent || current !== "") { flush(); hasCurrent = false; }
			continue;
		}
		current += ch;
		hasCurrent = true;
	}
	if (hasCurrent || current !== "") flush();
	return words;
}

/** `--title` values of `br create` invocations in a command. Never throws. */
export function parseBrCreates(command: string): string[] {
	const titles: string[] = [];
	try {
		const words = splitShellWords(command);
		for (let i = 0; i < words.length; i++) {
			const base = words[i]!.toLowerCase().split("/").pop() ?? "";
			if (base !== "br") continue;
			// Skip global flags between `br` and the subcommand (notably `--db PATH`).
			let j = i + 1;
			while (j < words.length && words[j]!.startsWith("-") && words[j] !== "--") {
				const flag = words[j]!.split("=")[0]!;
				j += flag === "--db" && !words[j]!.includes("=") ? 2 : 1;
			}
			if (words[j] !== "create") continue;
		for (let k = j + 1; k < words.length; k++) {
			const word = words[k]!;
			if (word.toLowerCase() === "br") break;
			if (word === "--title" && k + 1 < words.length) { titles.push(words[k + 1]!); break; }
			if (word.startsWith("--title=")) { titles.push(word.slice("--title=".length)); break; }
		}
		}
	} catch { /* unparseable command contributes no titles */ }
	return titles.filter(title => title.trim() !== "");
}



/**
 * Attach prior art for an admitted claim (`br update <id> --claim`) or create
 * (`br create --title ...`). Never throws and never blocks: every lookup
 * failure contributes a `prior art unavailable` line instead. Null when there
 * is nothing to report (no matches, no failures), so admitted no-op calls
 * stay silent.
 */
export async function priorArtForTitle(title: string, repoDir: string, deps: PriorArtDeps, opts: { deadlineMs?: number } = {}): Promise<string | null> {
	const startedAt = Date.now();
	const deadline = startedAt + (opts.deadlineMs ?? 250);
	const timeLeft = (): number => deadline - Date.now();
	const section = { decisions: [] as string[], beads: [] as string[], deleted: [] as string[], unavailable: [] as string[] };
	const keywords = priorArtKeywords(title);
	const timedOut = (): boolean => Date.now() >= deadline;

	// 1. Decisions log.
	if (!timedOut()) {
		// The operator names their decision register: OMP_KIT_DECISIONS_DIR, else decisionsDir in
		// $XDG_CONFIG_HOME/omp-kit/prior-art.json (~/.config when unset). Unset means not configured, never a guess.
		const decisionsDir = deps.env.OMP_KIT_DECISIONS_DIR?.trim() || configuredDecisionsDir(deps.env, deps.home);
		if (decisionsDir === null) {
			section.unavailable.push("decisions not configured (set decisionsDir in $XDG_CONFIG_HOME/omp-kit/prior-art.json or OMP_KIT_DECISIONS_DIR)");
		} else try {
			const { rows, error } = decisionRows(decisionsDir, 10, 262144);
			if (error !== null) {
				section.unavailable.push(error);
			} else {
				const matched = rows.filter(row => textMatches(`${row.id} ${row.text}`, keywords, 2)).slice(0, 3);
				for (const row of matched) section.decisions.push(`${row.id}: ${row.text.slice(0, 140)}`);
			}
		} catch {
			section.unavailable.push("decisions lookup failed");
		}
	} else {
		section.unavailable.push("decisions skipped (budget exhausted)");
	}

	// 2. Same-repo tracker.
	if (!timedOut()) {
		try {
			const issuesPath = join(repoDir, ".beads", "issues.jsonl");
			const { rows, error } = trackerRows(issuesPath);
			if (error !== null) {
				section.unavailable.push(error);
			} else {
				const matched = rows
					.filter(row => row.title.trim() !== "" && (keywords.codes.some(code => row.title.includes(code) || row.id.includes(code))
						|| textMatches(row.title, keywords, 2)))
					.sort((a, b) => rankBead(a.status, a.assignee) - rankBead(b.status, b.assignee));
				for (const row of matched.slice(0, 5)) {
					section.beads.push(`${row.id} ${row.status || "unknown"} ${row.title.slice(0, 100)}`);
				}
			}
		} catch {
			section.unavailable.push("tracker lookup failed");
		}
	} else {
		section.unavailable.push("tracker skipped (budget exhausted)");
	}

	// 3. Deleted work: recent retires/removals naming the same ground.
	if (!timedOut()) {
		try {
			const budgetMs = Math.max(25, Math.min(5000, timeLeft()));
			const logged = await deps.exec("git", ["log", "--format=%h%x09%ad%x09%s", "--date=short", "-n", "3000"], { cwd: repoDir, timeout: budgetMs });
			if (logged.code !== 0) {
				section.unavailable.push(`git log exited ${logged.code}`);
			} else {
				let added = 0;
				for (const line of logged.stdout.split("\n")) {
					if (added >= 3) break;
					const [sha, date, ...subjectParts] = line.split("\t");
					const subject = subjectParts.join("\t").trim();
					if (!sha || !subject || !isRetiredSubject(subject)) continue;
					if (keywords.codes.some(code => subject.includes(code)) || textMatches(subject, keywords, 1)) {
						section.deleted.push(`${sha} ${date} ${subject.slice(0, 120)}`);
						added++;
					}
				}
			}
		} catch (error) {
			section.unavailable.push(`git log unavailable (${error instanceof Error ? error.message.slice(0, 80) : "threw"})`);
		}
	} else {
		section.unavailable.push("git log skipped (budget exhausted)");
	}
	if (section.decisions.length === 0 && section.beads.length === 0 && section.deleted.length === 0 && section.unavailable.length === 0) return null;
	return formatPriorArt(title, section);
}

/** The claimed bead's title from the repo tracker (or beside an explicit --db). Null when absent. */
export function claimTitle(repoDir: string, db: string | undefined, beadId: string): string | null {
	const paths = db !== undefined && typeof db === "string" && db !== ""
		? [join(dirname(db), "issues.jsonl")]
		: [join(repoDir, ".beads", "issues.jsonl")];
	for (const path of paths) {
		const text = readHead(path, 262144);
		if (text === null) continue;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as { id?: unknown; title?: unknown };
				if (row.id === beadId && typeof row.title === "string" && row.title.trim() !== "") return row.title;
			} catch { /* skip malformed lines */ }
		}
		return null;
	}
	return null;
}

export async function priorArtForClaim(repoDir: string, beadId: string, title: string | null, deps: PriorArtDeps, opts: { deadlineMs?: number } = {}): Promise<string | null> {
	if (title === null || title.trim() === "") return null;
	return priorArtForTitle(title, repoDir, deps, opts);
}
