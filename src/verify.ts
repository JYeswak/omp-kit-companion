/**
 * `omp-kit verify <bead> --export <sha> [--lesson TEXT] [--actor NAME] [--project PATH] [--json] [--dry-run]`
 * (AUTOCOMPLETE1 ompkit-fp72.135.3.17 [b]; plan section 22 step 6, section 23.2 close row, section 26 W1).
 *
 * The one non-author close verb. It exports the exact commit into owned scratch, replays each distinct
 * command once, and judges every box by its own NAMED EXPECTED OUTCOME, never by exit 0 alone
 * (QuietBadger AM 68959 #1: our own examples include exit 0 with a null headline). A box with no replayable
 * command is refused ACCEPTANCE_NOT_REPLAYABLE and the bead goes back to intake. The author's own seat is
 * refused NON_AUTHOR_REQUIRED. A box whose command fails sets REWORK naming the box. Only when every box passes
 * does it tick the boxes, report the reviewer gate under the caller's identity (family disclosed), write the
 * transition comment from the command log and close. A lesson is required before replay. Tracker acts are
 * separate, not atomic: a refusal returns ACT_FAILED and reports any guarded acceptance restoration.
 * Before replay, verify the exact export SHA is reachable from a freshly fetched `origin/main`; unpublished or
 * unreadable exports are refused without replay or tracker acts.
 *
 * CLOSEPASS1 (ompkit-774u.52): when every box it ran passes, unticked [live] and [after] boxes (which no export
 * can run) move word for word into one open `LIVEREADBACK: <title>` bead labelled live-readback, created under the
 * closing bead's own active parent (else the constraint lane's parent, LANE_PARENT) with a `related` link back.
 * An unchecked [v][build] judgement is required evidence, not rollout debt: it stays on the parent and makes the
 * result PENDING. The closing bead keeps its original acceptance in its description and closes holding only ticked
 * boxes, so br's own close policy admits it with no --force. A bead with no executed box stays PENDING.
 *
 * Box grammar: `- [ ] [a] [phase] `command` -> <expected>` or `... ; expect: <expected>` or `...; planted: ...`.
 * The letter is optional and the phase is one of build/landed/live/after (VERIFYBOX1
 * ompkit-fp72.135.3.17.1: phase-only `[build]` boxes and the `after` phase parse; untagged
 * prose checkboxes are not boxes and keep their original meaning). A tag that is neither a
 * single letter nor a known phase makes the item unsupported: it is named and fails closed,
 * never silently dropped. Letter `v` marks a verification-note box that is never replayed.
 * This grammar is defined only here: scripts/box-lint.ts runs parseBoxes and unreplayableReason
 * for bead_lint's create and update admission (REPLAYABLE1 ompkit-fp72.135.3.71).
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run, type RunResult } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { checkPublishedCommits, preflightBead } from "./preflight.ts";
import { installReadonlyBr, resolveRealBr } from "./kitlib/readonly-br.ts";
import { resolveOmpIdentity } from "./paths.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const CMD = /`([^`]+)`/;
const TAG = /^\[([^\][\[]+)\]/;
const LETTER = /^[a-z]$/;
/** One `- [ ]` checklist line (trimmed); br numbers these for --check-acceptance, tagged or not. */
const CHECKLIST_ITEM = /^- \[([ xX])\] +(.+)$/;
/** CLOSEPASS1: the label on a LIVEREADBACK child, and the placeholder for its id in acts before br creates it. */
export const LIVE_READBACK_LABEL = "live-readback";
/** The constraint lane's active parent: home of a LIVEREADBACK child whose closing bead has no active parent. */
export const LANE_PARENT = "ompkit-kup44";
/** Active in the fleet DAG sense: an edge to it counts (two call sites plus the readback lookup keep it in lockstep). */
const activeStatus = (status: string) => status !== "" && status !== "closed" && status !== "tombstone";
const CHILD = "{child}";
/** A box's name in logs and close reasons: its scope letter, else its position. */
const tag = (b: { letter: string | null; index: number }) => `[${b.letter ?? b.index}]`;
/** Phases the verifier understands. Anything else in a tag is unsupported, not a box to skip. */
export const KNOWN_PHASES: Record<string, true> = { build: true, landed: true, live: true, after: true };

/**
 * One acceptance box; `line` is the trimmed source line, so a lint can name it and tell a new box from an unchanged one.
 * `item` is its 1-based position among all `- [ ]` checklist lines, tagged or not: the number br's --check-acceptance takes.
 */
export interface Box { index: number; item: number; letter: string | null; checked: boolean; phase: string | null; body: string; line: string }
export interface BoxReplay { index: number; letter: string | null; command: string | null; expected: string | null; rc: number | null; pass: boolean | null; detail: string; output?: { path: string; bytes: number; complete: boolean } }
export interface AcceptanceRollback {
	status: "NOT_NEEDED" | "RESTORED" | "ROLLBACK_REFUSED" | "STATE_UNPROVEN";
	detail: string;
}
export interface VerifyResult {
	ok: boolean;
	code: "CLOSED" | "REWORK" | "ACT_FAILED" | "LESSON_MISSING" | "ENVIRONMENT" | "NON_AUTHOR_REQUIRED" | "ACCEPTANCE_NOT_REPLAYABLE" | "NOT_IN_REVIEW" | "NOT_LIVE_READBACK" | "EXPORT_FAILED" | "DRY_RUN" | "PENDING" | "NOT_PUBLISHED" | "UNKNOWN";
	bead: string;
	export: string;
	replays: BoxReplay[];
	log: string;
	acts: string[][];
	/** CLOSEPASS1: the LIVEREADBACK child holding the boxes this close deferred ("{child}" in a dry run). */
	child?: string;
	/** A compensation observation, never proof of an atomic tracker transaction. */
	rollback?: AcceptanceRollback;
}

export function parseBoxes(acceptance: string): Box[] {
	const out: Box[] = [];
	let item = 0;
	for (const raw of acceptance.split("\n")) {
		const line = raw.trim();
		const head = CHECKLIST_ITEM.exec(line);
		if (!head) continue;
		item += 1;
		let rest = head[2]!.trim();
		const tags: string[] = [];
		let tm: RegExpExecArray | null;
		while ((tm = TAG.exec(rest)) !== null) { tags.push(tm[1]!); rest = rest.slice(tm[0].length).trimStart(); }
		if (tags.length === 0) continue;
		let letter: string | null = null;
		let phase: string | null = null;
		const [first, second, ...extra] = tags;
		if (first !== undefined && LETTER.test(first) && extra.length === 0) {
			letter = first;
			if (second !== undefined) phase = second;
		} else {
			phase = [first, second, ...extra].filter((tag): tag is string => tag !== undefined).join(" ");
		}
		out.push({ index: out.length + 1, item, letter, checked: head[1] !== " ", phase, body: rest, line });
	}
	return out;
}

/** The command a box names: its FIRST backticked span, or null when it names none. */
export function commandOf(body: string): string | null {
	return CMD.exec(body)?.[1] ?? null;
}

/** A path token: absolute, `~`, or `$HOME`/`${HOME}` rooted, starting a word or after `=`/`:`/`(`/a quote. */
const PATH_TOKEN = /(?<=^|[\s'"=:(])(?:(?:~|\$\{HOME\}|\$HOME)(?=[\s/'";|&<>()`]|$)|\/)[^\s'";|&<>()`]*/g;
/** A replacement the shell reads the same bare, single- or double-quoted. */
const SHELL_SAFE = /^[A-Za-z0-9_./+@%,-]+$/;

/** `path` with every existing ancestor's symlinks resolved; the missing tail is kept as written. */
function realOrLexical(path: string): string {
	const tail: string[] = [];
	let at = resolve(path);
	for (;;) {
		if (existsSync(at)) {
			try { return join(realpathSync(at), ...tail.reverse()); } catch { return resolve(path); }
		}
		const up = dirname(at);
		if (up === at) return resolve(path);
		tail.push(basename(at));
		at = up;
	}
}

/**
 * VERIFYABSPATH1 (ompkit-fp72.120.16.267): rewrite every absolute, `~` or `$HOME` path token in `command`
 * that resolves (symlinks followed) inside `repoRoot` to the same relative path under `exportDir`, so the
 * replay runs the exported commit's bytes, never the live tree. Paths outside the repo stay as they are, and
 * so does the repo's `.beads` tracker: it is live state read through the read-only br (REPLAYBR1), not code.
 * A token whose export path is not shell-safe is returned in `unmapped`; its box is not judged.
 */
export function mapRepoPaths(command: string, repoRoot: string, exportDir: string, home: string = homedir()): { command: string; mapped: { token: string; to: string }[]; unmapped: string[] } {
	const root = realOrLexical(repoRoot);
	const mapped: { token: string; to: string }[] = [];
	const unmapped: string[] = [];
	const out = command.replace(PATH_TOKEN, token => {
		const rel = relative(root, realOrLexical(token.replace(/^(?:~|\$\{HOME\}|\$HOME)/, home)));
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return token;
		if (rel === ".beads" || rel.startsWith(`.beads${sep}`)) return token;
		const to = rel === "" ? exportDir : join(exportDir, rel);
		if (!SHELL_SAFE.test(to)) { unmapped.push(token); return token; }
		mapped.push({ token, to });
		return to;
	});
	return { command: out, mapped, unmapped };
}

/** Why verify cannot replay a box (REPLAYABLE1); box-lint refuses and reports by the same names. */
export type UnreplayableReason = "unsupported-phase" | "no-command" | "arrow-before-command" | "command-not-followed-by-expected";
/**
 * Why this verb cannot replay one box, or null when it can (REPLAYABLE1 ompkit-fp72.135.3.71).
 * The one judgment verifyBead refuses ACCEPTANCE_NOT_REPLAYABLE by and scripts/box-lint.ts
 * (bead_lint's create and update admission) refuses new boxes by. `[v]` boxes are the caller's to skip.
 */
export function unreplayableReason(box: Box): UnreplayableReason | null {
	if (box.phase !== null && KNOWN_PHASES[box.phase] !== true) return "unsupported-phase";
	const span = CMD.exec(box.body);
	if (span === null) return "no-command";
	// An arrow in the obligation text before the command reads as the box's expected outcome to a person
	// and to every earlier copy of this grammar; refuse it so the only arrow is the one after the command.
	// The obligation may still name an arrow quoted as the exact token '->'.
	if (box.body.slice(0, span.index).split("'->'").join("").includes("->")) return "arrow-before-command";
	// The first backticked span is what runs, so it must be the command the box judges: `cmd` -> <expected> or
	// `cmd` expect: <expected>, with a non-empty expected outcome. Quoted obligation text
	// (`br update <id> --status in_review`) or a bare `cmd` -> would otherwise run unjudged.
	return expectedOf(box.body) !== null ? null : "command-not-followed-by-expected";
}

/**
 * The expected-outcome clause of a box: the text right after its first backticked span (the command
 * commandOf returns), introduced by `->` or `expect:`; null when that span is not followed by one.
 * An arrow anywhere else in the box is obligation prose, never the expected outcome.
 */
export function expectedOf(body: string): string | null {
	const span = CMD.exec(body);
	if (span === null) return null;
	const m = /^\s*(?:->|expect(?:ed)?:)\s*([^;.]+)/i.exec(body.slice(span.index + span[0].length));
	const expected = m?.[1]!.trim() ?? "";
	return expected === "" ? null : expected;
}

/** Judge output against the box's named expectation (unreplayableReason guarantees one). */
export function judge(expected: string, rc: number | null, out: string): { pass: boolean; detail: string } {
	const e = expected.trim();
	let m: RegExpExecArray | null;
	if ((m = /^rc\s+(\d+)$/i.exec(e)) || (m = /^exit\s+(\d+)$/i.exec(e))) return { pass: rc === Number(m[1]), detail: `rc ${rc}, expected ${m[1]}` };
	if ((m = /^(\d+)\s+pass(?:\s+(\d+)\s+fail)?$/i.exec(e))) {
		const pass = new RegExp(`\\b${m[1]}\\s+pass\\b`).test(out) && (m[2] === undefined || new RegExp(`\\b${m[2]}\\s+fail\\b`).test(out));
		return { pass, detail: `summary ${m[1]} pass${m[2] !== undefined ? ` ${m[2]} fail` : ""}: ${pass ? "found" : "not found"}` };
	}
	if ((m = /^(?:prints|contains)\s+(.+)$/i.exec(e))) { const needle = m[1]!.replace(/^["'`]|["'`]$/g, ""); return { pass: out.includes(needle), detail: `output ${out.includes(needle) ? "contains" : "lacks"} ${JSON.stringify(needle)}` }; }
	// Any other wording: the literal text must appear in the output; rc is not consulted (the box said what it expects).
	return { pass: out.includes(e), detail: `output ${out.includes(e) ? "contains" : "lacks"} ${JSON.stringify(e)}` };
}
/** Bounded child-output excerpt for a failed replay, so a future failure carries its own evidence. Passes keep the detail byte-identical. */
const CHILD_HEAD = 1000;
const CHILD_TAIL = 3000;
/** Preserve the existing 4 MiB/stream capture budget: at most 8 MiB of raw evidence per failed box.
 * Boundary proof: VERIFYENV1 product tests measure both streams at the cap and an over-cap refusal. */
const REPLAY_STREAM_BYTES = 4 * 1024 * 1024;
function childExcerpt(rc: number | null, timedOut: boolean, out: string): string {
	const total = out.length;
	if (total === 0) return `; child rc ${rc}${timedOut ? " TIMEOUT" : ""}: no stdout/stderr captured`;
	const head = out.slice(0, CHILD_HEAD);
	const tail = total > CHILD_HEAD + CHILD_TAIL ? out.slice(-CHILD_TAIL) : out.slice(CHILD_HEAD);
	const omitted = total - head.length - tail.length;
	return `; child rc ${rc}${timedOut ? " TIMEOUT" : ""} ${total} chars: ${head}${omitted > 0 ? `...[${omitted} chars omitted]...${tail}` : tail}`;
}

const OMP_IDENTITY_KEYS = ["OMP_PATH", "OMP_BIN", "OMP", "OMP_SRC"];

/** Require both the child's diagnostic and an independently invalid identity; arbitrary ENOENT is a product failure. */
function ompEnvironmentFailure(out: string, env: Record<string, string>): string | null {
	// Mixed failures are not environment-only: preserve an actual Node/Bun assertion as REWORK.
	if (out.includes("AssertionError") || out.includes("error: expect(")) return null;
	if (!out.includes("omp executable not found on PATH") && !OMP_IDENTITY_KEYS.some(key => env[key] && out.includes(`${key} `))) return null;
	try {
		resolveOmpIdentity(env);
	} catch (error) {
		if (!(error instanceof Error)) return null;
		const message = error.message;
		const identityDiagnostic = message === "omp executable not found on PATH"
			|| OMP_IDENTITY_KEYS.some(key => env[key] && message.startsWith(`${key} `));
		if (identityDiagnostic && out.includes(message)) return message;
	}
	return null;
}

/** `laneParent` overrides LANE_PARENT (a tracker without the omp-kit lane, such as a fixture). */
export interface VerifyInput { bead: string; exportSha: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; family?: string; laneParent?: string; lesson?: string }

function commentLesson(body: string): string | null {
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (line.slice(0, 7).toLowerCase() === "lesson:" && line.slice(7).trim()) return line;
	}
	return null;
}

/** Only explicit input or the bead author's own comments can supply a lesson. */
async function closeLesson(explicit: string | undefined, bead: BeadRow, repo: string, env: Record<string, string>): Promise<string | null> {
	if (explicit !== undefined) {
		const value = explicit.trim();
		if (!value) return null;
		return value.slice(0, 7).toLowerCase() === "lesson:" ? commentLesson(value) : `Lesson: ${value}`;
	}
	const author = bead.assignee ?? bead.createdBy;
	if (author === null) return null;
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	const result = await run(["br", "comments", "list", bead.id, "--json", ...db], { cwd: repo, deadline_s: 60, env });
	if (result.rc !== 0 || result.truncated || result.total_truncated) return null;
	let doc: unknown;
	try { doc = JSON.parse(text(result.stdout)); } catch { return null; }
	const comments = Array.isArray(doc) ? doc : doc !== null && typeof doc === "object" && "comments" in doc && Array.isArray(doc.comments) ? doc.comments : [];
	let selected: string | null = null;
	let selectedTime = -Infinity;
	let selectedId = -Infinity;
	for (const value of comments) {
		if (value === null || typeof value !== "object") continue;
		const row = value as Record<string, unknown>;
		if (typeof row.author !== "string" || row.author.toLowerCase() !== author.toLowerCase() || typeof row.text !== "string") continue;
		const lesson = commentLesson(row.text);
		if (lesson === null) continue;
		const parsedTime = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
		const time = Number.isFinite(parsedTime) ? parsedTime : 0;
		const id = typeof row.id === "number" ? row.id : 0;
		if (time > selectedTime || time === selectedTime && id > selectedId) {
			selected = lesson;
			selectedTime = time;
			selectedId = id;
		}
	}
	return selected;
}

export async function verifyBead(input: VerifyInput): Promise<VerifyResult> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const acts: string[][] = [];
	const log: string[] = [`verify ${input.bead} export ${input.exportSha} actor ${input.actor} ${new Date().toISOString()}`];
	const pre = await preflightBead("close", input.repo, input.bead, { actor: input.actor, env });
	const blocking = pre.findings.filter(f => f.blocking);
	if (blocking.some(f => f.code === "SELF_CLOSE")) return { ok: false, code: "NON_AUTHOR_REQUIRED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${input.actor} is the assignee`).join("\n"), acts };
	// VERIFYOPEN1 (ompkit-1ra0d.70): open and in_progress beads are admitted as well as in_review.
	// The non-author replay of every box on the exact export is the proof the in_review handoff
	// gate stands in for, so in_review stays a queue, never a precondition. Unticked boxes are not
	// a pre-replay refusal either (AC_UNTICKED is only ever logged here): verify ticks the boxes it
	// judged PASS. Closed, deferred and other states stay refused NOT_IN_REVIEW.
	if (blocking.some(f => f.code === "NOT_IN_REVIEW" && !/ is (open|in_progress|in_review)$/.test(f.detail)) || blocking.some(f => f.code === "UNJUDGED")) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(blocking.map(f => `${f.code}: ${f.detail}`)).join("\n"), acts };
	const publication = (await checkPublishedCommits(input.repo, [input.exportSha]))[0]!;
	if (publication.status !== "PUBLISHED") {
		const code = publication.status === "NOT_PUBLISHED" ? "NOT_PUBLISHED" : "UNKNOWN";
		log.push(`${code}: export ${publication.sha || input.exportSha} ${publication.detail}; publish with git_converge.py --push`);
		return { ok: false, code, bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts };
	}
	const row = await showBead(input.bead, input.repo, env);
	const acceptance = row?.acceptance ?? "";
	const title = row?.title || input.bead;
	const description = row?.description ?? "";
	const boxes = parseBoxes(acceptance);
	const replayable = boxes.filter(b => b.letter !== "v");
	const bad = replayable.filter(b => unreplayableReason(b) !== null);
	if (replayable.length === 0 || bad.length > 0) {
		log.push(`not replayable: ${bad.length ? bad.map(b => { const why = unreplayableReason(b); return why === "unsupported-phase" ? `${tag(b)} unsupported phase [${b.phase}]` : why === "no-command" ? `${tag(b)} names no command` : why === "arrow-before-command" ? `${tag(b)} has -> before its first backticked span ${JSON.stringify(commandOf(b.body))}` : `${tag(b)} first backticked span ${JSON.stringify(commandOf(b.body))} is not followed by -> <expected> or expect: <expected>`; }).join("; ") : "no boxes"}`);
		return { ok: false, code: "ACCEPTANCE_NOT_REPLAYABLE", bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts: [["br", "update", input.bead, "--status", "open", "--add-label", "needs-intake", "--actor", input.actor]] };
	}
	if (row === null) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat("UNJUDGED: bead became unreadable").join("\n"), acts };
	const lesson = await closeLesson(input.lesson, row, input.repo, env);
	if (lesson === null) return { ok: false, code: "LESSON_MISSING", bead: input.bead, export: input.exportSha, replays: [], log: log.concat("LESSON_MISSING: supply --lesson TEXT or an author Lesson: comment; no replay or tracker act ran").join("\n"), acts };
	// The owned replay fixture uses an explicit database path under its per-run
	// scratch; deleting BEADS_DB alone would still discover an ancestor tracker.
	// VERIFYTMP1 (ompkit-1ra0d.73): the export has no .git, so a box that reads git discovers whatever
	// repository encloses it. Under the caller's TMPDIR that was any repo (CFS on 2026-11-09, so the same
	// sha got opposite verdicts); under the project's own var/agent-tmp it is always the project, as in
	// the gates (fresh-gate.sh, full-suite-verdict.sh). A harness-designated root keeps precedence.
	const harnessRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
	const scratchRoot = harnessRoot ?? join(input.repo, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = ownedTmp("verify", { bead: input.bead, root: scratchRoot });
	const realBr = resolveRealBr(env.PATH);
	// HERMETIC1-B: tracker management keeps caller authority; acceptance never inherits it.
	const replayBase = { ...env };
	delete replayBase.BEADS_DIR;
	delete replayBase.BEADS_DB;
	delete replayBase.GIT_DIR;
	delete replayBase.GIT_WORK_TREE;
	replayBase.PATH = (env.PATH ?? "/usr/bin:/bin").split(delimiter)
		.filter(dir => basename(resolve(dir)) !== "agent-bin" && basename(realOrLexical(dir)) !== "agent-bin").join(delimiter);
	if (!realBr.ok) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`UNJUDGED: ${realBr.reason}`).join("\n"), acts };
	const replayBin = installReadonlyBr(scratch.path, realBr.path);
	const wantsOwned = replayable.some(b => b.body.includes("OWNED_TRACKER_DB"));
	let ownedDb = "";
	if (wantsOwned) {
		const fixtureDir = join(scratch.path, "fixture");
		mkdirSync(fixtureDir, { recursive: true });
		ownedDb = join(fixtureDir, ".beads", "beads.db");
		const fixtureInit = await run([realBr.path, "init", "--db", ownedDb], { cwd: fixtureDir, deadline_s: 60, env: replayBase });
		if (fixtureInit.rc !== 0) return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`owned fixture init failed rc ${fixtureInit.rc}: ${text(fixtureInit.stderr).slice(0, 200)}; unmet prerequisite: owned tracker binding`).join("\n"), acts };
	}
	// VERIFYSCRATCH1 (ompkit-fp72.135.3.81): selftests that build fixture trackers under GRADE_WAVE_SCRATCH
	// (grade_wave.py --selftest) then build them inside this run's root, where the read-only br admits them.
	const exportDir = join(scratch.path, "export");
	// VERIFYSCRATCH1 export root: var/agent-tmp is gitignored, so the export has none; kitlib scratch under the
	// repo root needs it, as the gates provide it (fresh-gate.sh, full-suite-verdict.sh).
	const exportTmp = join(exportDir, "var", "agent-tmp");
	const replayEnv = { ...replayBase, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, KITLIB_TMP_ROOT: exportTmp, ...(wantsOwned ? { OWNED_TRACKER_DB: ownedDb } : {}), PATH: `${replayBin}${delimiter}${replayBase.PATH}` };
	if (wantsOwned) log.push(`owned fixture ${ownedDb} (per-run read-only replay)`);
	mkdirSync(exportDir, { recursive: true });
	const archive = await run(["sh", "-c", `git -C ${JSON.stringify(input.repo)} archive ${JSON.stringify(input.exportSha)} | tar -x -C ${JSON.stringify(exportDir)}`], { deadline_s: 300, env });
	if (archive.rc !== 0 || !existsSync(join(exportDir, "scripts")) && !existsSync(join(exportDir, "src"))) {
		return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export failed rc ${archive.rc}: ${text(archive.stderr).slice(0, 200)}`).join("\n"), acts };
	}
	mkdirSync(exportTmp, { recursive: true });
	log.push(`exported ${input.exportSha} to ${exportDir}`);
	const replays: BoxReplay[] = [];
	const environmentFailures: string[] = [];
	type ReplayOutcome = Pick<RunResult, "rc" | "timed_out" | "killed" | "truncated" | "total_truncated" | "stdout" | "stderr"> & { out: string; elapsedMs: number };
	const commandResults = new Map<string, ReplayOutcome>();
	for (const box of replayable) {
		if (box.phase === "live" || box.phase === "after") {
			const command = commandOf(box.body)!;
			process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(command)} elapsed=0ms verdict=PENDING\n`);
			replays.push({ index: box.index, letter: box.letter, command: null, expected: null, rc: null, pass: null, detail: `pending: ${box.phase} phase prerequisite unmet in export replay; not executed` });
			log.push(`${tag(box)} PENDING ${box.phase} phase prerequisite unmet; not executed`);
			continue;
		}
		const named = commandOf(box.body)!;
		const expected = expectedOf(box.body)!; // non-null: unreplayableReason refused every box without one
		// VERIFYABSPATH1: a repo path named absolutely, by ~ or by $HOME replays the export, not the live tree.
		const paths = mapRepoPaths(named, input.repo, exportDir, replayEnv.HOME || homedir());
		if (paths.unmapped.length > 0) {
			const detail = `UNJUDGED REPO_PATH_UNMAPPED: ${paths.unmapped.map(t => JSON.stringify(t)).join(", ")} names the verified repo ${input.repo} but cannot be rewritten into export ${exportDir}; not executed`;
			environmentFailures.push(`${tag(box)} ${detail}`);
			replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: null, pass: null, detail });
			log.push(`${tag(box)} ${detail}`);
			continue;
		}
		for (const m of paths.mapped) log.push(`${tag(box)} REPO_PATH_MAPPED ${JSON.stringify(m.token)} -> ${m.to} (export, not live tree)`);
		const command = paths.command; // what runs; `named` is the box's own text, reported everywhere
		const cached = commandResults.get(named);
		const reused = cached !== undefined;
		let replay: ReplayOutcome;
		if (cached === undefined) {
			const started = Date.now();
			process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(named)} elapsed=0ms verdict=RUNNING`);
			const result = await run(["sh", "-c", command], { cwd: exportDir, deadline_s: 900, env: replayEnv, max_output_bytes: 4 * 1024 * 1024 });
			replay = {
				rc: result.rc,
				timed_out: result.timed_out,
				killed: result.killed,
				truncated: result.truncated,
				total_truncated: result.total_truncated,
				stdout: result.stdout,
				stderr: result.stderr,
				out: text(result.stdout) + text(result.stderr),
				elapsedMs: Date.now() - started,
			};
			commandResults.set(named, replay);
		} else {
			replay = cached;
		}
		const { out, elapsedMs } = replay;
		const v = replay.truncated || replay.total_truncated
			? { pass: false, detail: `OUTPUT_LIMIT: capture exceeded ${REPLAY_STREAM_BYTES} bytes per stream; full output unavailable` }
			: judge(expected, replay.rc, out);
		let output: BoxReplay["output"];
		let evidence = "";
		if (!v.pass) {
			// Evidence is outside the disposable export and survives CLI exit, owned by this bead.
			const root = join(input.repo, "var", "verify-evidence");
			mkdirSync(root, { recursive: true, mode: 0o700 });
			const retained = ownedTmp("verify-output", { root, bead: input.bead, autoCleanup: false });
			const path = join(retained.path, `box-${box.index}.log`);
			try {
				// Raw stdout followed by raw stderr, matching judge/display order without UTF-8 loss.
				writeFileSync(path, replay.stdout, { mode: 0o600, flag: "wx" });
				writeFileSync(path, replay.stderr, { flag: "a" });
			} catch (error) {
				retained.cleanup();
				throw error;
			}
			output = { path, bytes: replay.stdout.byteLength + replay.stderr.byteLength, complete: !replay.truncated && !replay.total_truncated };
			evidence = `; ${output.complete ? "complete" : "INCOMPLETE"} child output ${output.bytes} bytes: ${path}`;
		}
		const environment = !v.pass && replay.rc !== null && replay.rc !== 0 && !replay.timed_out && !replay.killed && !replay.truncated && !replay.total_truncated
			? ompEnvironmentFailure(out, replayEnv) : null;
		if (environment !== null) {
			if (reused) process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(named)} elapsed=${elapsedMs}ms verdict=ENVIRONMENT\n`);
			else process.stderr.write(`; completed_elapsed=${elapsedMs}ms final_verdict=ENVIRONMENT\n`);
			environmentFailures.push(`${tag(box)} ${environment}`);
			const detail = `environment prerequisite unmet: ${environment}${evidence}${childExcerpt(replay.rc, replay.timed_out, out)}`;
			replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: replay.rc, pass: null, detail, output });
			log.push(`${tag(box)} ENVIRONMENT ${named}: ${detail}; needs-director`);
			continue;
		}
		if (reused) process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(named)} elapsed=${elapsedMs}ms verdict=${v.pass ? "PASS" : "FAIL"}\n`);
		else process.stderr.write(`; completed_elapsed=${elapsedMs}ms final_verdict=${v.pass ? "PASS" : "FAIL"}\n`);
		const excerpt = v.pass ? "" : childExcerpt(replay.rc, replay.timed_out, out);
		replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: replay.rc, pass: v.pass, detail: v.detail + evidence + excerpt, ...(output === undefined ? {} : { output }) });
		log.push(`${tag(box)} ${v.pass ? "PASS" : "FAIL"} ${named} -> ${v.detail}${evidence}${excerpt} (${elapsedMs} ms)${replay.timed_out ? " TIMEOUT" : ""}`);
	}
	scratch.cleanup();
	const failed = replays.filter(r => r.pass === false);
	if (failed.length > 0) {
		const comment = `REWORK ${input.bead}: ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`;
		acts.push(["br", "update", input.bead, "--status", "rework", "--transition-comment", comment, "--actor", input.actor]);
		if (!input.dryRun) for (const a of acts) await run(a, { cwd: input.repo, deadline_s: 60, env });
		return { ok: false, code: input.dryRun ? "DRY_RUN" : "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
	}
	if (environmentFailures.length > 0) {
		const comment = `ENVIRONMENT ${input.bead}: ${environmentFailures.join("; ")}\n${log.join("\n")}`;
		acts.push(["br", "update", input.bead, "--add-label", "needs-director", "--actor", input.actor]);
		acts.push(["br", "comments", "add", input.bead, "--actor", input.actor, "-m", comment]);
		if (!input.dryRun) {
			const done = await executeActs(acts, input.repo, env);
			if (done.failure !== null) log.push(done.failure);
		}
		return { ok: false, code: "ENVIRONMENT", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
	}
	const ran = replays.filter(r => r.pass === true);
	if (ran.length === 0) {
		const pending = replays.filter(r => r.pass === null);
		return { ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending.map(p => `${tag(p)} ${p.detail}`).join("; ")}`).join("\n"), acts };
	}
	const buildJudgements = boxes.filter(b => !b.checked && b.letter === "v" && b.phase === "build");
	if (buildJudgements.length > 0) {
		const pending = buildJudgements.map(tag).join(" ");
		return { ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending} build judgement remains on the parent; it cannot be replayed or deferred as rollout debt`).join("\n"), acts };
	}
	// CLOSEPASS1 (ompkit-774u.52, J-2026-10-29-20): br closes a bead only when every box is ticked, so unticked
	// [live]/[after] boxes this export cannot run move word for word into one LIVEREADBACK child. An unchecked
	// [v][build] judgement is required evidence, not rollout debt; it remains on the parent as PENDING above.
	// The parent keeps its original acceptance in its description and closes holding only boxes verify ran and ticked.
	// The child lives under the closing bead's own active parent (else the constraint lane's parent) with a `related` link back,
	// so every active bead keeps an edge to another active bead and a REWORK reopen is never held by its readback child.
	const deferred = boxes.filter(b => !b.checked && (b.phase === "live" || b.phase === "after"));
	let home = "";
	let homeNote = "";
	if (deferred.length > 0) {
		const up = row?.parent ? await showBead(row.parent, input.repo, env) : null;
		if (up !== null && activeStatus(up.status)) home = up.id;
		else {
			const lane = input.laneParent ?? LANE_PARENT;
			const laneRow = await showBead(lane, input.repo, env);
			if (laneRow === null || !activeStatus(laneRow.status)) return { ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${input.bead} has no active parent and lane parent ${lane} is ${laneRow?.status || "unreadable"}; unmet prerequisite: an active parent for the LIVEREADBACK child`).join("\n"), acts };
			home = lane;
			homeNote = `lane parent ${lane}, because ${input.bead} has no active parent`;
		}
	}
	const ranIndexes = new Set(ran.map(r => r.index));
	const ticks = boxes.filter(b => ranIndexes.has(b.index)).map(b => b.item - deferred.filter(d => d.item < b.item).length);
	const family = input.family ?? "unknown (set --family)";
	const deferredTags = deferred.map(b => tag(b)).join(" ");
	const reason = `verified by ${input.actor} (family: ${family}) on export ${input.exportSha}: ${ran.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}${deferred.length ? `; deferred ${deferredTags} to ${CHILD} (LIVEREADBACK, child of ${homeNote || home}, related to ${input.bead})` : ""}`;
	if (deferred.length > 0) {
		const moved = new Set(deferred.map(b => b.item));
		let item = 0;
		const remaining = acceptance.split("\n").filter(raw => !CHECKLIST_ITEM.test(raw.trim()) || !moved.has(++item)).join("\n");
		const childDescription = `WHAT: read back, on the installed kit, the boxes omp-kit verify deferred when it closed ${input.bead} on export ${input.exportSha}: \`omp-kit verify <this bead> --live-readback\`. A pass ticks them and closes this bead; a failure reopens ${input.bead} with REWORK naming the box.\n\nWHY: ${input.bead}'s executed boxes passed, and br closes a bead only with every box ticked (CLOSEPASS1 ompkit-774u.52, J-2026-10-29-20), so these boxes stay open, visible debt until they are read back.\n\nVerified bead: ${input.bead} (related link)`;
		acts.push(["br", "create", `LIVEREADBACK: ${title}`, "-t", "task", "-l", LIVE_READBACK_LABEL, "--parent", home, "--deps", `related:${input.bead}`, "--description", childDescription, "--acceptance-criteria", deferred.map(b => b.line).join("\n"), "--json", "--actor", input.actor]);
		// br refuses, without --force, a rewrite that keeps less than half of a field's length; only acceptance shrinks.
		const shrinks = [...remaining].length * 2 < [...acceptance].length + 4;
		acts.push(["br", "update", input.bead, "--description", `${description}\n\n## Original acceptance (before omp-kit verify moved ${deferredTags} to ${CHILD})\n${acceptance}`, "--acceptance-criteria", remaining, ...(shrinks ? ["--force"] : []), "--actor", input.actor]);
	}
	acts.push(["br", "update", input.bead, "--check-acceptance", ticks.join(","), "--actor", input.actor]);
	acts.push(["br", "gate", "report", input.bead, "--gate", "min_reviewers", "--provider", `reviewer:${input.actor}`, "--status", "pass", "--to", "closed", "--actor", input.actor]);
	acts.push(["br", "close", input.bead, "--reason", reason, "--transition-comment", `CLOSED ${input.bead} by ${input.actor} (family: ${family})\n${lesson}\n${log.join("\n")}`, "--actor", input.actor]);
	if (homeNote) log.push(`LIVEREADBACK child placed under ${homeNote}`);
	const child = deferred.length > 0 ? CHILD : undefined;
	if (input.dryRun) return { ok: true, code: "DRY_RUN", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts, child };
	const done = await executeActs(acts, input.repo, env, { bead: row, actor: input.actor });
	if (done.failure !== null) return { ok: false, code: "ACT_FAILED", bead: input.bead, export: input.exportSha, replays, log: log.concat(done.failure).join("\n"), acts: done.acts, child: done.child, rollback: done.rollback };
	return { ok: true, code: "CLOSED", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts: done.acts, child: done.child };
}

/**
 * Run tracker acts in order. The id a `br create --json` act prints replaces CHILD in every later act, and the
 * returned acts carry that substitution. The first non-zero act stops the run and is named in `failure`.
 */
type ActCheckpoint = { bead: BeadRow; actor: string };

function acceptanceAfterAct(acceptance: string, argv: string[]): string {
	const replacement = argv.indexOf("--acceptance-criteria");
	let value = replacement < 0 ? acceptance : argv[replacement + 1] ?? acceptance;
	const tick = argv.indexOf("--check-acceptance");
	if (tick < 0) return value;
	const selected = new Set((argv[tick + 1] ?? "").split(",").map(Number));
	let item = 0;
	value = value.split("\n").map(raw => {
		if (!CHECKLIST_ITEM.test(raw.trim()) || !selected.has(++item)) return raw;
		const bracket = raw.indexOf("[");
		return raw.slice(0, bracket + 1) + "x" + raw.slice(bracket + 2);
	}).join("\n");
	return value;
}

/** Compensate only this attempt's acceptance edit; never overwrite a peer change. */
async function restoreAcceptance(checkpoint: ActCheckpoint, expected: string, cwd: string, env: Record<string, string>, acts: string[][]): Promise<AcceptanceRollback> {
	const before = checkpoint.bead;
	if (expected === before.acceptance) return { status: "NOT_NEEDED", detail: "this attempt did not change acceptance" };
	const current = await showBead(before.id, cwd, env);
	if (current?.acceptance === before.acceptance && current.status === before.status)
		return { status: "RESTORED", detail: "original acceptance and status are present" };
	if (current === null || current.status !== before.status || current.acceptance !== expected || current.updatedAt === null)
		return { status: "STATE_UNPROVEN", detail: "current tracker state differs from this attempt; no peer edit was overwritten" };
	const undo = ["br", "update", before.id, "--acceptance-criteria", before.acceptance, "--if-unchanged", current.updatedAt, "--actor", checkpoint.actor];
	acts.push(undo);
	const restored = await run(undo, { cwd, deadline_s: 60, env });
	if (restored.rc !== 0) return { status: "ROLLBACK_REFUSED", detail: `acceptance restore rc ${restored.rc}: ${text(restored.stderr)}` };
	const checked = await showBead(before.id, cwd, env);
	return checked?.acceptance === before.acceptance && checked.status === before.status
		? { status: "RESTORED", detail: "original acceptance and status verified after revision-guarded restore" }
		: { status: "STATE_UNPROVEN", detail: "acceptance restore readback did not verify original state" };
}

async function executeActs(acts: string[][], cwd: string, env: Record<string, string>, checkpoint?: ActCheckpoint): Promise<{ acts: string[][]; child?: string; failure: string | null; rollback?: AcceptanceRollback }> {
	let child: string | undefined;
	let expectedAcceptance = checkpoint?.bead.acceptance ?? "";
	let failure: string | null = null;
	const ranActs: string[][] = [];
	const bind = (a: string[]) => child === undefined ? a : a.map(arg => arg.replaceAll(CHILD, child!));
	for (const act of acts) {
		const argv = bind(act);
		ranActs.push(argv);
		// A nonzero exit can follow a committed write (for example, export failure).
		if (checkpoint !== undefined && argv[1] === "update" && argv[2] === checkpoint.bead.id)
			expectedAcceptance = acceptanceAfterAct(expectedAcceptance, argv);
		const r = await run(argv, { cwd, deadline_s: 60, env });
		if (r.rc !== 0) {
			failure = `act failed rc ${r.rc}: ${argv.slice(0, 4).join(" ")}: ${text(r.stderr)}`;
			break;
		}
		if (argv[1] === "create") {
			let doc: unknown;
			try { doc = JSON.parse(text(r.stdout)); } catch { doc = null; }
			const id = doc !== null && typeof doc === "object" && "id" in doc ? doc.id : undefined;
			if (typeof id !== "string" || id === "") {
				failure = `act failed: br create printed no child id: ${text(r.stdout)}`;
				break;
			}
			child = id;
		}
	}
	if (failure === null) return { acts: ranActs, child, failure: null };
	const rollback = checkpoint === undefined
		? { status: "NOT_NEEDED" as const, detail: "no acceptance checkpoint was changed" }
		: await restoreAcceptance(checkpoint, expectedAcceptance, cwd, env, ranActs);
	return { acts: ranActs, child, rollback, failure: `${failure}\nrollback: ${rollback.status}` };
}

/** The fields verify reads from one `br show --json` row, or null when br names no such bead. `related` lists the ids its `related` dependencies point at. */
interface BeadRow { id: string; title: string; description: string; acceptance: string; status: string; assignee: string | null; createdBy: string | null; updatedAt: string | null; labels: string[]; parent: string | null; related: string[] }

async function showBead(id: string, repo: string, env: Record<string, string>): Promise<BeadRow | null> {
	const show = await run(["br", "show", id, "--json"], { cwd: repo, deadline_s: 60, env, max_output_bytes: 4 * 1024 * 1024 });
	let doc: unknown;
	try { doc = JSON.parse(text(show.stdout)); } catch { return null; }
	const row: unknown = Array.isArray(doc) ? doc[0] : doc;
	if (row === null || typeof row !== "object") return null;
	// A parsed JSON object; every field below is narrowed with typeof before use.
	const record = row as Record<string, unknown>;
	const field = (key: string): string | null => { const value = record[key]; return typeof value === "string" ? value : null; };
	const labels = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === "string") : [];
	const related = (Array.isArray(record.dependencies) ? record.dependencies : [])
		.map((dep: unknown) => dep !== null && typeof dep === "object" && "dependency_type" in dep && dep.dependency_type === "related" && "id" in dep && typeof dep.id === "string" ? dep.id : "")
		.filter(dep => dep !== "");
	return { id: field("id") ?? id, title: field("title") ?? "", description: field("description") ?? "", acceptance: field("acceptance_criteria") ?? "", status: field("status") ?? "", assignee: field("assignee"), createdBy: field("created_by"), updatedAt: field("updated_at"), labels, parent: field("parent"), related };
}

export interface LiveReadbackInput { bead: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; family?: string; lesson?: string }

/**
 * `omp-kit verify <child> --live-readback` (CLOSEPASS1 ompkit-774u.52 [b]). Runs an open LIVEREADBACK child's
 * unticked boxes on the installed kit (cwd = the project, no export), under the same per-run read-only br as an
 * export replay. A pass ticks every unticked box and closes the child; a failure reopens the verified bead (the
 * child's one `related` link) with REWORK naming the box and leaves the child open. That bead's and the child's
 * assignees are refused NON_AUTHOR_REQUIRED.
 */
export async function liveReadback(input: LiveReadbackInput): Promise<VerifyResult> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const acts: string[][] = [];
	const log: string[] = [`live-readback ${input.bead} actor ${input.actor} ${new Date().toISOString()}`];
	const refuse = (code: VerifyResult["code"], why: string): VerifyResult => ({ ok: false, code, bead: input.bead, export: "installed", replays: [], log: log.concat(why).join("\n"), acts });
	const child = await showBead(input.bead, input.repo, env);
	if (child === null) return refuse("NOT_LIVE_READBACK", `br shows no bead ${input.bead}`);
	if (child.status !== "open" || !child.labels.includes(LIVE_READBACK_LABEL)) return refuse("NOT_LIVE_READBACK", `${input.bead} is ${child.status || "unknown"} with labels [${child.labels.join(", ")}]; only an open ${LIVE_READBACK_LABEL} child is read back`);
	// The verified bead is the child's one `related` link (its parent-child edge points at the active home bead).
	const parent = child.related.length === 1 ? await showBead(child.related[0]!, input.repo, env) : null;
	if (parent === null) return refuse("NOT_LIVE_READBACK", `${input.bead} needs exactly one readable related link to the bead it reads back; it has [${child.related.join(", ")}]`);
	if (input.actor === parent.assignee || input.actor === child.assignee) return refuse("NON_AUTHOR_REQUIRED", `refused: ${input.actor} is the assignee of ${input.actor === parent.assignee ? parent.id : child.id}`);
	const boxes = parseBoxes(child.acceptance);
	const toRun = boxes.filter(b => b.letter !== "v" && !b.checked);
	const bad = toRun.filter(b => unreplayableReason(b) !== null);
	if (bad.length > 0) return refuse("ACCEPTANCE_NOT_REPLAYABLE", `not replayable: ${bad.map(b => `${tag(b)} ${unreplayableReason(b)}`).join("; ")}`);
	const lesson = await closeLesson(input.lesson, child, input.repo, env);
	if (lesson === null) return refuse("LESSON_MISSING", "LESSON_MISSING: supply --lesson TEXT or an author Lesson: comment; no replay or tracker act ran");
	const harnessRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
	const scratch = ownedTmp("verify-live", { bead: input.bead, ...(harnessRoot === undefined ? {} : { root: harnessRoot }) });
	const realBr = resolveRealBr(env.PATH);
	if (!realBr.ok) return refuse("NOT_IN_REVIEW", `UNJUDGED: ${realBr.reason}`);
	const replayEnv = { ...env, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, PATH: `${installReadonlyBr(scratch.path, realBr.path)}:${env.PATH ?? "/usr/bin:/bin"}` };
	const replays: BoxReplay[] = [];
	for (const box of toRun) {
		const command = commandOf(box.body)!;
		const expected = expectedOf(box.body)!; // non-null: unreplayableReason refused every box without one
		const started = Date.now();
		const r = await run(["sh", "-c", command], { cwd: input.repo, deadline_s: 900, env: replayEnv, max_output_bytes: 4 * 1024 * 1024 });
		const out = text(r.stdout) + text(r.stderr);
		const v = judge(expected, r.rc, out);
		const excerpt = v.pass ? "" : childExcerpt(r.rc, r.timed_out, out);
		replays.push({ index: box.index, letter: box.letter, command, expected, rc: r.rc, pass: v.pass, detail: v.detail + excerpt });
		log.push(`${tag(box)} ${v.pass ? "PASS" : "FAIL"} ${command} -> ${v.detail}${excerpt} (${Date.now() - started} ms)${r.timed_out ? " TIMEOUT" : ""}`);
	}
	const failed = replays.filter(r => r.pass === false);
	const family = input.family ?? "unknown (set --family)";
	if (failed.length > 0) {
		acts.push(["br", "reopen", parent.id, "--reason", `REWORK ${parent.id}: live readback ${child.id} failed ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`, "--actor", input.actor]);
	} else {
		const ticks = boxes.filter(b => !b.checked).map(b => b.item);
		if (ticks.length > 0) acts.push(["br", "update", child.id, "--check-acceptance", ticks.join(","), "--actor", input.actor]);
		acts.push(["br", "gate", "report", child.id, "--gate", "min_reviewers", "--provider", `reviewer:${input.actor}`, "--status", "pass", "--to", "closed", "--actor", input.actor]);
		acts.push(["br", "close", child.id, "--reason", `live readback of ${parent.id} by ${input.actor} (family: ${family}) on the installed kit: ${replays.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}`, "--transition-comment", `CLOSED ${child.id} by ${input.actor} (family: ${family})\n${lesson}\n${log.join("\n")}`, "--actor", input.actor]);
	}
	const code: VerifyResult["code"] = input.dryRun ? "DRY_RUN" : failed.length > 0 ? "REWORK" : "CLOSED";
	if (input.dryRun) return { ok: failed.length === 0, code, bead: input.bead, export: "installed", replays, log: log.join("\n"), acts };
	const done = await executeActs(acts, input.repo, env, failed.length > 0 ? undefined : { bead: child, actor: input.actor });
	if (done.failure !== null) return { ok: false, code: "ACT_FAILED", bead: input.bead, export: "installed", replays, log: log.concat(done.failure).join("\n"), acts: done.acts, rollback: done.rollback };
	return { ok: failed.length === 0, code, bead: input.bead, export: "installed", replays, log: log.join("\n"), acts: done.acts };
}

/** `omp-kit verify --live-readback --all` (CLOSEPASS1 [c]): liveReadback over every open LIVEREADBACK child, in id order. */
export async function liveReadbackAll(input: Omit<LiveReadbackInput, "bead">): Promise<{ ok: boolean; visited: string[]; results: VerifyResult[]; log: string }> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const listed = await run(["br", "list", "--status", "open", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], { cwd: input.repo, deadline_s: 60, env, max_output_bytes: 16 * 1024 * 1024 });
	let doc: unknown = null;
	try { doc = JSON.parse(text(listed.stdout)); } catch { /* reported below */ }
	const rows: unknown = doc !== null && typeof doc === "object" && "issues" in doc ? doc.issues : doc;
	if (listed.rc !== 0 || !Array.isArray(rows)) return { ok: false, visited: [], results: [], log: `br list rc ${listed.rc}: ${text(listed.stderr).slice(0, 200)}; unmet prerequisite: readable tracker` };
	const visited = rows.map(row => row !== null && typeof row === "object" && "id" in row && typeof row.id === "string" ? row.id : "").filter(id => id !== "").sort();
	const results: VerifyResult[] = [];
	for (const bead of visited) results.push(await liveReadback({ ...input, bead }));
	return { ok: results.every(r => r.ok), visited, results, log: results.map(r => `${r.bead} ${r.code}`).join("\n") };
}

export function verifyProject(flag: unknown): string { return resolve(typeof flag === "string" && flag.trim() ? flag : process.cwd()); }
