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
 * transition comment from the command log and close. Lessons are optional and recorded when supplied. Tracker acts are
 * separate, not atomic: a refusal returns ACT_FAILED and reports any guarded acceptance restoration.
 * Before replay, verify the exact export SHA is reachable from a freshly fetched `origin/main`; unpublished or
 * unreadable exports are refused without replay or tracker acts.
 *
 * CLOSEPASS1 (ompkit-774u.52): when every box it ran passes, unticked [live] and [after] boxes (which no export
 * can run) move word for word into one open `LIVEREADBACK: <obligation key>` bead labelled live-readback, created under the
 * closing bead's own active parent or the available constraint lane, otherwise parentless, with a `related` link back.
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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run, type RunResult } from "./kitlib/run.ts";
import { appendLocalLesson, readLessonsLog } from "./lessons.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { checkPublishedCommits, preflightBead } from "./preflight.ts";
import { installReadonlyBr, resolveRealBr } from "./kitlib/readonly-br.ts";
import { observeAuthorClaim, observeWorkingModel } from "./model-ledger.ts";
import { beginVerifyAttempt, finalizeVerifyAttempt, resolveVerifyStateRoot } from "./verify-ledger.ts";
import { SELF_REPLAY_RECEIPT_SCHEMA, acceptanceDigest, sha256Hex, writeReceipt } from "./self-replay-receipt.ts";
import type { VerifyAttemptFinish, VerifyAttemptOutcome, VerifyAttemptRef, VerifyFinalEvidence } from "./verify-ledger.ts";
import { resolveOmpIdentity } from "./paths.ts";
import { executedShellCommands } from "./fleet-guard/git.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const CMD = /`([^`]+)`/;
const TAG = /^\[([^\][\[]+)\]/;
const LETTER = /^[a-z]$/;
/** One `- [ ]` checklist line (trimmed); br numbers these for --check-acceptance, tagged or not. */
const CHECKLIST_ITEM = /^- \[([ xX])\] +(.+)$/;
/** CLOSEPASS1: the label on a LIVEREADBACK child, and the placeholder for its id in acts before br creates it. */
export const LIVE_READBACK_LABEL = "live-readback";
/** PRIORART1 (ompkit-dpbsq): the readback child verify files is a bead like any other, and the guard refuses a create without the five lines. */
const LIVE_READBACK_PRIOR_ART = [
	"GOAL: prove on the installed kit the live boxes verify could not run at close, so the verified bead's behavior is read back after install (CLOSEPASS1 ompkit-774u.52); measured by this bead closing through `omp-kit verify --live-readback`.",
	"NATIVE: none applies: this bead is filed by `omp-kit verify` from the verified bead's unticked live boxes; the box commands are the checks.",
	"EXISTING: `omp-kit verify <this bead> --live-readback` already replays and closes it; no other tool does.",
	"DECISION: EXTEND that verb; no new tool.",
	"BEST: run live boxes at close on a disposable installed copy instead of deferring them; not chosen: a close would then need a second install per bead, and the deferral keeps the debt visible.",
].join("\n");
/** Optional legacy kit lane: used only when it is active in the selected tracker. */
export const LANE_PARENT = "ompkit-kup44";
/** Active in the fleet DAG sense: an edge to it counts (two call sites plus the readback lookup keep it in lockstep). */
const activeStatus = (status: string) => status !== "" && status !== "closed" && status !== "tombstone";
const CHILD = "{child}";
/** A box's name in logs and close reasons: its scope letter, else its position. */
const tag = (b: { letter: string | null; index: number }) => `[${b.letter ?? b.index}]`;
/** Phases the verifier understands. Anything else in a tag is unsupported, not a box to skip. */
export const KNOWN_PHASES: Record<string, true> = { build: true, landed: true, live: true, after: true };
/** VERIFYGATE1 (ompkit-1ra0d.137): the reviewer gate verify reports before closing. */
const MIN_REVIEWERS_GATE = "min_reviewers";
/**
 * The exact validation text br prints when the tracker's workflow requires no such gate for the
 * transition. Only this text is ever treated as "gate not required", never any other error.
 */
const GATE_NOT_REQUIRED = `workflow does not require gate '${MIN_REVIEWERS_GATE}' for transition`;

/**
 * Whether the target tracker's workflow requires the min_reviewers gate for closing `bead` from
 * `from`: true when `br gate list` names it on the `from -> closed` edge, false when the list parses
 * and names no such gate, null when the tracker cannot say (an older br, an unreadable answer).
 * A null answer keeps the gate-report act: the exact validation error below still lands the close.
 */
async function minReviewersRequired(repo: string, bead: string, from: string, env: Record<string, string>): Promise<boolean | null> {
	let out: string;
	try {
		const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
		const listed = await run(["br", "gate", "list", bead, "--json", ...db], { cwd: repo, deadline_s: 60, env });
		if (listed.rc !== 0) return null;
		out = text(listed.stdout);
	} catch {
		return null;
	}
	try {
		const doc: unknown = JSON.parse(out);
		const transitions = doc !== null && typeof doc === "object" && "gated_transitions" in doc ? doc.gated_transitions : undefined;
		if (!Array.isArray(transitions)) return null;
		for (const edge of transitions) {
			if (edge === null || typeof edge !== "object" || !("from" in edge) || !("to" in edge) || !("gates" in edge)) continue;
			if (edge.from !== from || edge.to !== "closed" || !Array.isArray(edge.gates)) continue;
			if (edge.gates.some(gate => gate !== null && typeof gate === "object" && "gate" in gate && gate.gate === MIN_REVIEWERS_GATE)) return true;
		}
		return false;
	} catch {
		return null;
	}
}

/** The transition a gate-not-required validation names, or null when the text names none. */
function notRequiredTransition(stderr: string): string | null {
	const marker = `${GATE_NOT_REQUIRED} '`;
	const start = stderr.indexOf(marker);
	if (start < 0) return null;
	const end = stderr.indexOf("'", start + marker.length);
	if (end < 0) return null;
	return stderr.slice(start + marker.length, end);
}

/** Whether this act failure is exactly the gate-not-required validation, never any other error. */
function isGateNotRequiredFailure(argv: string[], stderr: string): boolean {
	const gate = argv.indexOf("--gate");
	return argv.length > 4 && argv[0] === "br" && argv[1] === "gate" && argv[2] === "report"
		&& gate >= 0 && argv[gate + 1] === MIN_REVIEWERS_GATE && stderr.includes(GATE_NOT_REQUIRED);
}

/**
 * VERIFYGATE1-identity (ompkit-1ra0d.137 [b]): whether the acting verifier is known to the target
 * project's Agent Mail. Only a shim-mediated br enforces the tracker guard (a native br has none),
 * so a natively-resolved br is known by construction. An unavailable `am`, or a refusal that is not
 * an unknown agent (a path that is no mail project at all), is inconclusive: the acts keep their own
 * errors. Only a positive AGENT_NOT_FOUND refuses up front, before any replay, with the remedy.
 * VERIFYMAILPROBE1 (ompkit-1ra0d.174): one probe per repo and actor per process, bounded at 10 s. A
 * timeout is already inconclusive (known), so waiting 60 s per verify only multiplied an exhausted
 * Agent Mail pool's latency across concurrent verifies (bead-replayable parity hung 120 s, 2026-11-11).
 */
const MAIL_PROBE_DEADLINE_S = 10;
const mailProbeCache = new Map<string, Promise<{ known: boolean; detail: string }>>();
async function verifierKnownToTargetMail(repo: string, actor: string, env: Record<string, string>): Promise<{ known: boolean; detail: string }> {
	if (resolveRealBr(env.PATH ?? process.env.PATH ?? "").skipped.length === 0) return { known: true, detail: "native br: no tracker guard" };
	const key = `${repo}\u0000${actor}`;
	const cached = mailProbeCache.get(key);
	if (cached !== undefined) return cached;
	const probe = (async () => {
		let result: RunResult;
		try {
			result = await run(["am", "agents", "show", "--project", repo, "--json", actor], { cwd: repo, deadline_s: MAIL_PROBE_DEADLINE_S, env });
		} catch {
			return { known: true, detail: "Agent Mail unreadable: the acts report their own errors" };
		}
		const err = text(result.stderr).slice(0, 200);
		if (result.rc === 0) return { known: true, detail: "verifier is registered" };
		if (err.includes("AGENT_NOT_FOUND")) return { known: false, detail: err };
		return { known: true, detail: "no mail project or agent verdict: the acts report their own errors" };
	})();
	mailProbeCache.set(key, probe);
	return probe;
}
/**
 * VERIFYBG1 (ompkit-1ra0d.258): validate a background verifier identity before any tracker act.
 * Shape first (needs no tracker read): a present identity names all three of label, parent seat
 * and session id, and the label differs from the parent. Author comparison needs the bead row and
 * runs in verifyBead. Every refusal records nothing: no replay and no tracker act ran.
 */
export function validateBackgroundVerifierShape(v: { label: string; parent: string; session: string } | undefined): { ok: true } | { ok: false; code: string; detail: string } {
	if (v === undefined) return { ok: true };
	const label = v.label.trim(), parent = v.parent.trim(), session = v.session.trim();
	const anyPresent = label !== "" || parent !== "" || session !== "";
	if (!anyPresent) return { ok: true };
	if (label === "") return { ok: false, code: "LABEL_REQUIRED", detail: "a background verifier needs its own label; an inherited parent identity with no label is refused" };
	if (parent === "") return { ok: false, code: "PARENT_REQUIRED", detail: "a background verifier needs its parent seat; the recorder must be a registered seat" };
	if (session === "") return { ok: false, code: "SESSION_REQUIRED", detail: "a background verifier needs its session id; rerun with all three of label, parent seat and session id" };
	if (label === parent) return { ok: false, code: "LABEL_IS_PARENT", detail: `background label ${JSON.stringify(label)} must differ from its parent seat` };
	return { ok: true };
}

/** Author half of the background identity check (needs the bead row): label and parent both differ from the author. */
export function validateBackgroundVerifierAuthor(v: { label: string; parent: string; session: string }, author: string | null): { ok: true } | { ok: false; code: string; detail: string } {
	if (author !== null && v.label.trim() !== "" && v.label.trim() === author) return { ok: false, code: "LABEL_IS_AUTHOR", detail: `background label ${JSON.stringify(v.label.trim())} must differ from the author ${JSON.stringify(author)}` };
	if (author !== null && v.parent.trim() !== "" && v.parent.trim() === author) return { ok: false, code: "PARENT_IS_AUTHOR", detail: `parent seat ${JSON.stringify(v.parent.trim())} must differ from the author ${JSON.stringify(author)}` };
	return { ok: true };
}

/**
 * One acceptance box; `line` is the trimmed source line, so a lint can name it and tell a new box from an unchanged one.
 * `item` is its 1-based position among all `- [ ]` checklist lines, tagged or not: the number br's --check-acceptance takes.
 */
export interface Box { index: number; item: number; letter: string | null; checked: boolean; phase: string | null; body: string; line: string }
export interface BoxReplay {
	index: number; letter: string | null; command: string | null; expected: string | null;
	rc: number | null; pass: boolean | null; detail: string;
	output?: { path: string; bytes: number; complete: boolean };
	/** SELFREPLAYGATE1: sha256 of the box's raw stdout followed by stderr; absent when the box did not run. */
	outputSha256?: string;
	execution?: {
		eligible: boolean; attempted: boolean; reused: boolean; resultObserved: boolean; completed: boolean;
		timedOut: boolean; killed: boolean; signal: number | null; truncated: boolean; totalTruncated: boolean;
	};
}
export interface AcceptanceRollback {
	status: "NOT_NEEDED" | "RESTORED" | "ROLLBACK_REFUSED" | "STATE_UNPROVEN";
	detail: string;
}
export interface VerifyResult {
	ok: boolean;
	code: "CLOSED" | "REWORK" | "ACT_FAILED" | "ENVIRONMENT" | "DEPENDENCIES_NOT_LOCKED" | "NON_AUTHOR_REQUIRED" | "AUTHOR_REQUIRED" | "ACCEPTANCE_NOT_REPLAYABLE" | "NOT_IN_REVIEW" | "NOT_LIVE_READBACK" | "EXPORT_FAILED" | "DRY_RUN" | "SELF_REPLAY" | "PENDING" | "NOT_PUBLISHED" | "UNKNOWN";
	bead: string;
	export: string;
	replays: BoxReplay[];
	log: string;
	acts: string[][];
	/** SELFREPLAYGATE1: where the --self-replay receipt landed; path null (with the reason) when it could not be written. */
	receipt?: { path: string | null; reason?: string };
	/** FIRSTVERIFY1: attempt-ledger status; native verify result codes remain authoritative. */
	verificationEvidence?: {
		status: "FINALIZED" | "ALREADY_FINALIZED" | "UNAVAILABLE" | "CONFLICT" | "NOT_RECORDED";
		attemptId?: string;
		outcome?: VerifyAttemptOutcome;
		reason?: string;
	};
	/** CLOSEPASS1: the LIVEREADBACK child holding the boxes this close deferred ("{child}" in a dry run). */
	child?: string;
	/** A compensation observation, never proof of an atomic tracker transaction. */
	rollback?: AcceptanceRollback;
}

type ReplayExecution = NonNullable<BoxReplay["execution"]>;
const skippedExecution = (eligible: boolean): ReplayExecution => ({
	eligible, attempted: false, reused: false, resultObserved: false, completed: false,
	timedOut: false, killed: false, signal: null, truncated: false, totalTruncated: false,
});

function replayUncertainty(replay: BoxReplay): string {
	const execution = replay.execution;
	if (execution === undefined) return "EXECUTION_METADATA_UNAVAILABLE";
	const facts: string[] = [];
	if (!execution.attempted && !execution.reused) facts.push("NOT_EXECUTED");
	if (!execution.resultObserved) facts.push("RESULT_UNOBSERVED");
	if (execution.timedOut) facts.push("TIMED_OUT");
	if (execution.killed) facts.push("PROCESS_GROUP_KILLED");
	if (execution.signal !== null) facts.push(`SIGNAL_${execution.signal}`);
	if (execution.truncated) facts.push("OUTPUT_TRUNCATED");
	if (execution.totalTruncated) facts.push("TOTAL_OUTPUT_TRUNCATED");
	if (!execution.completed && !execution.timedOut && !execution.killed && execution.signal === null) facts.push("PROCESS_INCOMPLETE");
	if (replay.pass === null) facts.push("NO_NAMED_VERDICT");
	return facts.length === 0 ? "INCOMPLETE" : facts.join(",");
}

function classifyAttempt(replays: readonly BoxReplay[]): { outcome: VerifyAttemptOutcome; replayed: boolean; reason: string } {
	const required = replays.filter(replay => replay.execution?.eligible);
	const completeFailure = required.find(replay => {
		const execution = replay.execution;
		return replay.pass === false && execution !== undefined && (execution.attempted || execution.reused)
			&& execution.resultObserved && execution.completed && !execution.truncated && !execution.totalTruncated;
	});
	if (completeFailure) return {
		outcome: "FAIL",
		replayed: true,
		reason: `complete named-outcome replay failed ${tag({ letter: completeFailure.letter, index: completeFailure.index })}`,
	};
	const complete = required.length > 0 && required.every(replay => {
		const execution = replay.execution;
		return replay.pass === true && execution !== undefined && (execution.attempted || execution.reused)
			&& execution.resultObserved && execution.completed && !execution.timedOut && !execution.killed
			&& execution.signal === null && !execution.truncated && !execution.totalTruncated;
	});
	if (complete) return { outcome: "PASS", replayed: true, reason: `all ${required.length} eligible named outcomes were replayed completely` };
	const incomplete = required.filter(replay => {
		const execution = replay.execution;
		return replay.pass !== true || execution === undefined || !(execution.attempted || execution.reused)
			|| !execution.resultObserved || !execution.completed || execution.timedOut || execution.killed
			|| execution.signal !== null || execution.truncated || execution.totalTruncated;
	});
	const reason = required.length === 0
		? "no eligible named-outcome replay was executed"
		: `named-outcome replay was incomplete for ${incomplete.map(replay => `${tag({ letter: replay.letter, index: replay.index })} (${replayUncertainty(replay)})`).join("; ")}`;
	return { outcome: "UNJUDGED", replayed: required.some(replay => replay.execution?.attempted === true || replay.execution?.reused === true), reason };
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
	// VERIFYEXPECTHEAD1 (ompkit-1ra0d.164): a structured head followed by `:` and prose
	// (`0 fail: what it proves`) judges the head only; the prose is the box's
	// description, never literal output. `prints`/`contains` keeps its literal
	// behavior (a needle like `prints "status: ok"` must keep working), so the
	// head strip runs after the prints branch below matches the full clause.
	// Zero-failure summaries require rc 0, including combined pass/fail expectations.
	// VERIFYFAILURESHEAD1 (ompkit-1ra0d.219): turnline selftests summarize as
	// `N failures` / `N failure`, never `N fail`; judge those heads the same way.
	// Node reports `pass N` / `fail N`; Bun reports `N pass` / `N fail`.
	const hm = /^(?:rc\s+[0-9]+|exit\s+[0-9]+|[0-9]+\s+pass(?:\s+[0-9]+\s+fail(?:ures?)?)?|[0-9]+\s+fail(?:ures?)?)\s*:(?=\s*\S)/i.exec(e);
	const exp = hm !== null ? e.slice(0, hm[0].length - 1).trim() : e;
	if ((m = /^rc\s+(\d+)$/i.exec(exp)) || (m = /^exit\s+(\d+)$/i.exec(exp))) return { pass: rc === Number(m[1]), detail: `rc ${rc}, expected ${m[1]}` };
	if ((m = /^(\d+)\s+pass(?:\s+(\d+)\s+fail(?:ures?)?)?$/i.exec(exp))) {
		const pass = new RegExp(`\\b(?:${m[1]}\\s+pass|pass\\s+${m[1]})\\b`).test(out)
			&& (m[2] === undefined || (new RegExp(`\\b(?:${m[2]}\\s+fail(?:ures?)?|fail(?:ures?)?\\s+${m[2]})\\b`).test(out)
				&& (Number(m[2]) !== 0 || rc === 0)));
		return { pass, detail: `summary ${m[1]} pass${m[2] !== undefined ? ` ${m[2]} fail` : ""}: ${pass ? "found" : "not found"}` };
	}
	if ((m = /^(\d+)\s+fail(?:ures?)?$/i.exec(exp))) {
		const n = Number(m[1]);
		const found = new RegExp(`\\b(?:${m[1]}\\s+fail(?:ures?)?|fail(?:ures?)?\\s+${m[1]})\\b`).test(out);
		const pass = found && (n !== 0 || rc === 0);
		return { pass, detail: `summary ${m[1]} fail: ${pass ? "found" : "not found"}` };
	}
	// VERIFYNUMERIC1 (ompkit-1ra0d.242): a closed set of numeric shapes judges the output's first
	// integer instead of searching for the prose literally ('prints a count' never appears in '346').
	// Any other wording keeps the literal behavior below.
	const numeric = /^(?:prints\s+(?:a\s+)?(?:count|number)(?:\s+(above|below|over|under)\s+(\d+))?|(<=|>=|<|>|=)\s*(\d+))$/i.exec(exp);
	if (numeric !== null) {
		const first = /(?:^|[^0-9.])(\d+)(?![0-9.])/.exec(out);
		if (first === null) return { pass: false, detail: "output has no integer" };
		const value = Number(first[1]);
		const word = numeric[1]?.toLowerCase();
		const op = word === "above" || word === "over" ? ">" : word === "below" || word === "under" ? "<" : numeric[3];
		const bound = Number(numeric[2] ?? numeric[4]);
		const pass = op === undefined ? true
			: op === "<=" ? value <= bound : op === ">=" ? value >= bound : op === "<" ? value < bound : op === ">" ? value > bound : value === bound;
		return { pass, detail: op === undefined ? `output prints integer ${value}` : `integer ${value} ${pass ? "meets" : "fails"} ${op} ${bound}` };
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
/**
 * VERIFYDEPS1 (ompkit-1ra0d.154): the export has no node_modules, so every JS box fails with
 * Cannot find package. Provision dependencies from the export's own lockfiles before replaying:
 * for each directory holding a lockfile that a box's cwd is in or under, install frozen from
 * that lockfile (never resolve outside it). A missing or out-of-date lockfile is the named
 * refusal DEPENDENCIES_NOT_LOCKED, never a silent pass. The working repo's node_modules is
 * never copied: that would replay against unverified bytes.
 *
 * Scripts run as the package manager does by default (no --ignore-scripts): the replay already
 * executes the project's own code from the same commit, so install scripts are the same trust
 * domain, and native deps (esbuild, sentry-cli) need their postinstall builds. Because install
 * scripts run, the install step gets a scrubbed env: any *TOKEN*, any *_AUTH*, and npm registry
 * auth config never reach it (HOME and the package-manager cache dirs stay, so offline
 * --prefer-offline installs still hit the user's cache). Installs are offline-first from the
 * user's package cache where the tool supports it (--prefer-offline for npm/pnpm/yarn; bun
 * consults its cache automatically), falling back to the registry. pnpm gets --store-dir pointed
 * at the user's own store (`pnpm store path` from $HOME), so it never invents a project-local
 * `.pnpm-store` in the tree under test. After a successful install
 * the dir's node_modules/.bin fronts the replay PATH, so bare runner binaries (`vitest run`)
 * resolve the lockfile-pinned binary, never a caller-global one. NODE_PATH and NODE_OPTIONS
 * are stripped from the replay env so the working repo's closure cannot leak in either.
 */
const JS_RUNTIME = /\b(bun|node|npm|pnpm|yarn|npx|bunx|corepack|deno|tsc|tsx|ts-node|vitest|jest|mocha)\b/;
interface LockKind { file: string; argv: string[] }
function lockKind(dir: string): LockKind | null {
	if (existsSync(join(dir, "bun.lockb"))) return { file: "bun.lockb", argv: ["bun", "install", "--frozen-lockfile"] };
	if (existsSync(join(dir, "bun.lock"))) return { file: "bun.lock", argv: ["bun", "install", "--frozen-lockfile"] };
	if (existsSync(join(dir, "package-lock.json"))) return { file: "package-lock.json", argv: ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"] };
	if (existsSync(join(dir, "pnpm-lock.yaml"))) return { file: "pnpm-lock.yaml", argv: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"] };
	if (existsSync(join(dir, "yarn.lock"))) {
		let managed = false;
		let modern = existsSync(join(dir, ".yarnrc.yml"));
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown };
			const declared = manifest.packageManager;
			if (typeof declared === "string" && declared.startsWith("yarn@")) {
				managed = true;
				modern ||= Number.parseInt(declared.slice(5), 10) >= 2;
			}
		} catch { /* The package manager reports a missing or invalid manifest. */ }
		const argv = managed ? ["corepack", "yarn", "install"] : ["yarn", "install"];
		if (modern) argv.push("--immutable");
		else argv.push("--frozen-lockfile", "--prefer-offline");
		return { file: "yarn.lock", argv };
	}
	if (existsSync(join(dir, "deno.lock"))) return { file: "deno.lock", argv: ["deno", "install", "--frozen"] };
	return null;
}
/** A box that invokes the deno toolchain (as opposed to a node box that merely runs near deno files). */
const DENO = /\bdeno\b/;
/** Resolve leading shell cwd changes and npm's literal package-directory option. */
function boxCwd(command: string, exportDir: string): string | null {
	let cwd = exportDir;
	let rest = command;
	for (let i = 0; i < 50 && rest !== ""; i++) {
		const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(rest);
		if (m === null) break;
		let target = m[1]!;
		if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) target = target.slice(1, -1);
		if (target !== "") cwd = isAbsolute(target) ? target : resolve(cwd, target);
		rest = rest.slice(m[0].length);
	}
	if (!rest.includes("--prefix") && !rest.includes("-C")) return cwd;
	const inspection = executedShellCommands(rest);
	if ("refusal" in inspection) return null;
	const argv = inspection.commands[0]?.argv;
	if (!argv || argv[0]?.expanded || basename(argv[0]?.text ?? "") !== "npm") return cwd;
	let target = cwd;
	for (let i = 1; i < argv.length; i++) {
		const option = argv[i]!;
		if (option.text === "--") break;
		let value: string;
		if (option.text === "--prefix" || option.text === "-C") {
			const operand = argv[++i];
			if (!operand || operand.expanded) return null;
			value = operand.text;
		} else if (option.text.startsWith("--prefix=")) {
			if (option.expanded) return null;
			value = option.text.slice(9);
		} else continue;
		target = resolve(cwd, value);
	}
	return target;
}
type ProvisionOutcome = { ok: true } | { ok: false; detail: string };
/** Env keys that must never reach a dependency install. Installs run install scripts, so caller
 * credentials (any *TOKEN*, any *_AUTH*, npm registry auth config) would be visible to the
 * project's own postinstall code. Kept: HOME and the package-manager cache dirs, so offline
 * (--prefer-offline) installs still hit the user's package cache. Scrubbed for installs only;
 * the replay itself keeps the caller's env (minus the tracker/git bindings replayBase strips). */
function isInstallSecret(key: string): boolean {
	if (key.includes("TOKEN")) return true;
	if (/(?:^|_)AUTH(?:$|_)/.test(key)) return true;
	return /^npm_config_/i.test(key) && /auth/i.test(key);
}
/**
 * The user's own pnpm store, resolved the way pnpm itself resolves it for the user, never the
 * project: `pnpm store path` run from $HOME. pnpm invents a project-local `.pnpm-store` when the
 * export sits on a different filesystem than its default store, dropping a large untracked
 * store into the tree under test; pinning --store-dir to the user's store prevents that.
 * Null on any failure (missing pnpm included): the install then runs without --store-dir,
 * fail-closed downstream as before.
 */
async function pnpmStoreDir(env: Record<string, string>): Promise<string | null> {
	let result: RunResult;
	try {
		result = await run(["pnpm", "store", "path"], { cwd: env.HOME ?? homedir(), deadline_s: 60, env, max_output_bytes: 64 * 1024 });
	} catch {
		return null;
	}
	if (result.rc !== 0 || result.truncated || result.total_truncated) return null;
	const dir = text(result.stdout).trim();
	if (dir === "" || dir.includes("\n") || !isAbsolute(dir)) return null;
	return dir;
}
async function installLockedDeps(lockDir: string, lock: LockKind, env: Record<string, string>, log: string[]): Promise<ProvisionOutcome> {
	// Load-scaled deadline: room for a cold cache on a busy machine, bounded so a hung
	// registry cannot stall the close past the box budget.
	let cpus = 4;
	try { cpus = Math.max(1, availableParallelism()); } catch { /* keep default */ }
	const deadline = Math.min(900, 180 + 60 * cpus);
	const started = Date.now();
	const installEnv: Record<string, string> = {};
	let scrubbed = 0;
	for (const [key, value] of Object.entries(env)) {
		if (isInstallSecret(key)) { scrubbed += 1; continue; }
		installEnv[key] = value;
	}
	let argv = lock.argv;
	if (lock.file === "pnpm-lock.yaml") {
		const store = await pnpmStoreDir(installEnv);
		if (store !== null) {
			argv = [...argv, "--store-dir", store];
			log.push(`deps pinned pnpm --store-dir ${store}`);
		}
	}
	let result: RunResult;
	try {
		result = await run(argv, { cwd: lockDir, deadline_s: deadline, env: installEnv, max_output_bytes: 4 * 1024 * 1024 });
	} catch (error) {
		const detail = `environment prerequisite unmet: dependency install cannot run ${argv.join(" ")} in ${lockDir}: ${(error as Error).message.slice(0, 200)}`;
		log.push(`deps ${detail}`);
		return { ok: false, detail };
	}
	const out = text(result.stdout) + text(result.stderr);
	const elapsed = Date.now() - started;
	log.push(`deps ${argv.join(" ")} in ${lockDir} rc ${result.rc} (${elapsed} ms, ${scrubbed} secret env vars scrubbed): ${out.replace(/\n/g, " | ").slice(-1500)}`);
	if (result.rc === 0) return { ok: true };
	// Frozen installs fail closed on a stale lock (npm "ci can only", pnpm ERR_PNPM_OUTDATED_LOCKFILE,
	// bun/yarn frozen mismatches, deno "lockfile is out of date"): the project must commit an
	// up-to-date lockfile, not resolve past it.
	if (
		/lockfile|frozen|outdated|out-of-date|up-to-date|needs update|npm ci can only/i.test(out) ||
		out.includes("can only install packages when your package.json")
	) {
		return { ok: false, detail: `DEPENDENCIES_NOT_LOCKED: ${lock.file} in ${lockDir} is missing or out of date (install rc ${result.rc}); commit an up-to-date lockfile, never resolve outside it` };
	}
	return { ok: false, detail: `environment prerequisite unmet: dependency install failed in ${lockDir} (rc ${result.rc}): ${out.slice(-500).replace(/\n/g, " | ")}` };
}
/**
 * After a successful install, resolve bare runner binaries (`vitest run`) to the lockfile-pinned
 * one, never a caller-global one: accumulate the provisioned dir's node_modules/.bin at the front
 * of the replay PATH (deduped, so the per-dir cache keeps it fronted once; deno installs have no
 * .bin, so the missing dir is a no-op).
 */
function prependProvisionedBin(lockDir: string, env: Record<string, string>, log: string[]): void {
	const bin = join(lockDir, "node_modules", ".bin");
	if (!existsSync(bin)) return;
	const paths = (env.PATH ?? "").split(delimiter);
	if (paths.includes(bin)) return;
	env.PATH = [bin, ...paths].join(delimiter);
	log.push(`deps prepended ${bin} to the replay PATH`);
}
/**
 * VERIFYNODEPS1 (ompkit-1ra0d.172): only a package.json that declares dependencies needs a lockfile.
 * A manifest with no dependency map (the kit's own repo) has nothing to resolve, so its boxes run as before.
 * An unreadable or unparsable manifest counts as declaring them: it cannot be proven dependency-free.
 */
export function declaresDependencies(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((key) => {
			const map = manifest[key];
			return map !== null && typeof map === "object" && Object.keys(map).length > 0;
		});
	} catch {
		return true;
	}
}

/**
 * Ensure one box command's JS dependencies are provisioned. Null: no JS runtime involved, so
 * nothing to do. Otherwise every lockfile dir from the box cwd up to the export root, installed
 * root first and once per directory (cache), so the nearest dir's .bin ends up first on PATH
 * (VERIFYDEPSWALK1 ompkit-1ra0d.188: a workspace package with its own lockfile still needs the
 * root install for its file:/workspace dependencies). A package.json with no covering lockfile
 * is the named refusal, as is a deno box in a deno project (deno.json/deno.jsonc) with no
 * deno.lock: without the lockfile deno would resolve against the global cache and registry, unpinned.
 */
export async function ensureBoxDeps(command: string, exportDir: string, env: Record<string, string>, log: string[], cache: Map<string, ProvisionOutcome>): Promise<ProvisionOutcome | null> {
	if (!JS_RUNTIME.test(command)) return null;
	const cwd = boxCwd(command, exportDir);
	if (cwd === null) return { ok: false, detail: "environment prerequisite unmet: the dependency command directory is not literal and inspectable" };
	const rel = relative(exportDir, cwd);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		return { ok: false, detail: `environment prerequisite unmet: dependency directory ${cwd} is outside the exact export` };
	let dir = cwd;
	let hasPackageJson = false;
	let hasDenoConfig = false;
	const lockDirs: { dir: string; lock: LockKind }[] = [];
	for (;;) {
		if (declaresDependencies(join(dir, "package.json"))) hasPackageJson = true;
		if (existsSync(join(dir, "deno.json")) || existsSync(join(dir, "deno.jsonc"))) hasDenoConfig = true;
		const lock = lockKind(dir);
		if (lock !== null) lockDirs.push({ dir, lock });
		if (dir === exportDir) break;
		const up = dirname(dir);
		if (up === dir || up.length < exportDir.length) break;
		dir = up;
	}
	if (lockDirs.length > 0) {
		for (const { dir: lockDir, lock } of lockDirs.reverse()) {
			const hit = cache.get(lockDir);
			if (hit !== undefined && !hit.ok) return hit;
			if (hit === undefined) {
				const outcome = await installLockedDeps(lockDir, lock, env, log);
				cache.set(lockDir, outcome);
				if (!outcome.ok) return outcome;
			}
			prependProvisionedBin(lockDir, env, log);
		}
		return null;
	}
	if (DENO.test(command) && hasDenoConfig) return { ok: false, detail: `DEPENDENCIES_NOT_LOCKED: no deno.lock covers ${cwd}; commit one, never resolve outside it` };
	if (!hasPackageJson) return null;
	return { ok: false, detail: `DEPENDENCIES_NOT_LOCKED: no lockfile (bun.lock/bun.lockb, package-lock.json, pnpm-lock.yaml, yarn.lock, deno.lock) covers ${cwd}; commit one, never resolve outside it` };
}

/** `laneParent` overrides LANE_PARENT (a tracker without the omp-kit lane, such as a fixture).
 * VERIFYXREPO1 (ompkit-haadl): `trackerRepo` decouples bead resolution from the export repo.
 * A chief bead lives in one tracker's repo while its fix lands as an export commit in another
 * (e.g. the omp-kit tracker names a ~/.claude export). Every `br` read/act and the attempt-ledger
 * tracker path use the tracker repo; every git/export operation (publication check, rev-parse,
 * archive, path mapping, scratch default, failure evidence) uses `repo`, the export repo.
 * Absent, the tracker resolves from `repo` exactly as before (byte-identical default). */
/** VERIFYBG1 (ompkit-1ra0d.258): a background task that authored neither the change nor its fixture verifies under its own label. `verifier` carries the background identity (label + parent seat + session id); the recorder stays `actor` (a registered seat, never the author). Absent means an ordinary seat verification. */
export interface BackgroundVerifier { label: string; parent: string; session: string }
export interface VerifyInput { bead: string; exportSha: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; /** SELFREPLAY1: the assignee replays their own boxes on the exact published export before handover; never closes, ticks or records an attempt. */ selfReplay?: boolean; family?: string; laneParent?: string; lesson?: string; trackerRepo?: string; verifier?: BackgroundVerifier }

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

/**
 * LESSONAUTO1 (ompkit-1ra0d.213) + LESSONDIRT1 (ompkit-1ra0d.222): on a CLOSED verdict,
 * feed the learn loop by appending the close lesson to the verified repo's untracked
 * `.omp/lessons.local.jsonl` through the local lessons writer. The tracked
 * `.omp/lessons.jsonl` stays untouched so a peer's verify leaves the shared main clean;
 * readers merge both stores. Dedupes by bead across both stores: a second close of the
 * same bead appends nothing. Best effort: a lesson-write failure is logged, never a
 * close failure.
 */
function recordCloseLesson(repo: string, bead: string, lesson: string, sha: string, log: string[]): void {
	try {
		const existing = readLessonsLog(repo);
		if (existing.status !== "INVALID" && existing.entries.some(entry => entry.bead === bead)) {
			log.push(`lesson: ${bead} already recorded in .omp/lessons.local.jsonl; skipping`);
			return;
		}
		appendLocalLesson(repo, { kind: "LESSON", class: "OTHER:verify_close", what: lesson, evidence: `verify ${bead} export ${sha}`, bead });
		log.push(`lesson: recorded ${bead} in .omp/lessons.local.jsonl`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.push(`lesson: lesson append skipped (${message})`);
	}
}

export async function verifyBead(input: VerifyInput): Promise<VerifyResult> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const verifierAtInvocation = observeWorkingModel(env);
	const acts: string[][] = [];
	// SELFREPLAY1 (ompkit-1elej): an author's pre-handover replay. It runs the same export, publication check and box judgement as
	// verify, but is a dry run in effect (no tracker act, no attempt record, no lesson, no close preflight) and reports SELF_REPLAY.
	const selfReplay = input.selfReplay === true;
	const dry = input.dryRun === true || selfReplay;
	// VERIFYBG1 (ompkit-1ra0d.258): normalize the background identity first, before any tracker act.
	const raw = input.verifier;
	const norm = raw === undefined ? undefined : { label: raw.label.trim(), parent: raw.parent.trim(), session: raw.session.trim() };
	const bg = norm !== undefined && (norm.label !== "" || norm.parent !== "" || norm.session !== "") ? norm : undefined;
	const shape = validateBackgroundVerifierShape(bg === undefined ? undefined : { label: bg.label, parent: bg.parent, session: bg.session });
	const log: string[] = [`verify ${input.bead} export ${input.exportSha} actor ${input.actor}${bg === undefined ? "" : ` verifier ${bg.label} parent ${bg.parent} session ${bg.session}`} ${new Date().toISOString()}`];
	if (!shape.ok) return { ok: false, code: shape.code, bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${shape.detail}; no replay or tracker act ran`).join("\n"), acts };
	// The recorder is the registered seat that owns the tracker writes; the prover is the
	// background label that ran the replay. Without a background identity they are the same seat.
	const prover = bg === undefined ? input.actor : bg.label;
	// VERIFYXREPO1: the tracker cwd names where the bead resolves; the export repo (input.repo)
	// names where the fix commit resolves. Absent, both are the export repo, exactly as before.
	const trackerCwd = input.trackerRepo ?? input.repo;
	const blocking = selfReplay ? [] : (await preflightBead("close", trackerCwd, input.bead, { actor: input.actor, env })).findings.filter(f => f.blocking);
	if (blocking.some(f => f.code === "SELF_CLOSE")) return { ok: false, code: "NON_AUTHOR_REQUIRED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${input.actor} is the assignee`).join("\n"), acts };
	// VERIFYOPEN1 keeps open beads eligible for a non-author replay. Active work must
	// complete its author's in_review handoff first; replay cannot bypass that transition.
	// Unticked boxes are judged and ticked below, not refused before replay.
	if (blocking.some(f => f.code === "NOT_IN_REVIEW" && !f.detail.endsWith(" is open")) || blocking.some(f => f.code === "UNJUDGED")) {
		const findings = blocking.map(f => `${f.code}: ${f.detail}${f.code === "NOT_IN_REVIEW" ? "; complete the author's supported in_review handoff before verify" : ""}`);
		return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(findings).join("\n"), acts };
	}
	const publication = (await checkPublishedCommits(input.repo, [input.exportSha]))[0]!;
	if (publication.status !== "PUBLISHED") {
		const code = publication.status === "NOT_PUBLISHED" ? "NOT_PUBLISHED" : "UNKNOWN";
		log.push(`${code}: export ${publication.sha || input.exportSha} ${publication.detail}; publish with git_converge.py --push`);
		return { ok: false, code, bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts };
	}
	const row = await showBead(input.bead, trackerCwd, env);
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
	if (selfReplay && row.assignee !== input.actor) return { ok: false, code: "AUTHOR_REQUIRED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: --self-replay is the assignee's own pre-handover replay; ${row.assignee ?? "nobody"} is the assignee and ${input.actor} is not (a non-author runs verify --dry-run); no replay ran`).join("\n"), acts };
	if (selfReplay) log.push("self-replay: the author's own replay; it closes nothing, ticks nothing and records no verification attempt");
	if (bg !== undefined) {
		const authorCheck = validateBackgroundVerifierAuthor(bg, row.assignee);
		if (!authorCheck.ok) return { ok: false, code: authorCheck.code, bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${authorCheck.detail}; no replay or tracker act ran`).join("\n"), acts };
		log.push(`background verifier ${bg.label} of parent seat ${bg.parent} session ${bg.session} records under its label; tracker writes stay with ${input.actor}`);
	}
	const lesson = selfReplay ? "Lesson: self-replay closes nothing" : await closeLesson(input.lesson, row, trackerCwd, env);
	if (lesson === null) log.push("WARNING: no author Lesson: comment or --lesson supplied; continuing without a lesson");
	// VERIFYGATE1-identity: the tracker guard refuses a verifier the target project's Agent Mail does not
	// know at the first act, after a full replay. Prove the verifier up front, before replaying anything.
	const identity = selfReplay ? { known: true, detail: "self-replay writes nothing to the tracker" } : await verifierKnownToTargetMail(trackerCwd, input.actor, env);
	if (!identity.known) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`UNJUDGED: Agent Mail cannot verify ${input.actor} in ${trackerCwd} (${identity.detail}); register the verifier in the target project (am agents create --project ${trackerCwd} --program <program> --model <model>) then retry; no replay or tracker act ran`).join("\n"), acts };
	const isFullCommit = (value: string) => {
		if (value.length !== 40 && value.length !== 64) return false;
		for (const character of value.toLowerCase()) {
			const code = character.charCodeAt(0);
			if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
		}
		return true;
	};
	const resolvedExport = await run(["git", "rev-parse", "--verify", `${publication.sha}^{commit}`], { cwd: input.repo, deadline_s: 60, env });
	const candidate = text(resolvedExport.stdout).trim().toLowerCase();
	const exportCommit = resolvedExport.rc === 0 && !resolvedExport.timed_out && !resolvedExport.killed
		&& !resolvedExport.truncated && !resolvedExport.total_truncated && isFullCommit(candidate) ? candidate : null;
	const tracker = resolve(trackerCwd, env.BEADS_DB || join(".beads", "beads.db"));
	const stateRoot = resolveVerifyStateRoot(env);
	let attempt: VerifyAttemptRef | null = null;
	let replays: BoxReplay[] = [];
	let replayAttempted = false;
	let requiredJudgementPending: string | null = null;
	let scratchCleanup: (() => void) | null = null;
	if (!dry) {
		const context = {
			tracker,
			bead: input.bead,
			export_requested: input.exportSha,
			export_commit: exportCommit,
			bead_created_at: row.createdAt,
			author: observeAuthorClaim(stateRoot, tracker, input.bead),
			verifier: { actor: prover, attribution: verifierAtInvocation },
		};
		const begun = await beginVerifyAttempt(stateRoot, context);
		if (begun.status === "UNAVAILABLE") {
			const reason = `verify attempt evidence unavailable: ${begun.reason}; no replay or tracker act ran`;
			log.push(`ENVIRONMENT: ${reason}`);
			return { ok: false, code: "ENVIRONMENT", bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts,
				verificationEvidence: { status: "UNAVAILABLE", reason: begun.reason } };
		}
		attempt = begun.attempt;
		log.push(`verify attempt ${attempt.id} recorded for tracker ${tracker}, export ${exportCommit ?? "UNKNOWN"}`);
	}
	const cleanupScratch = () => {
		const cleanup = scratchCleanup;
		scratchCleanup = null;
		cleanup?.();
	};
	const finishAttempt = async (result: VerifyResult): Promise<VerifyResult> => {
		cleanupScratch();
		if (selfReplay && result.replays.length > 0) {
			// SELFREPLAYGATE1: the receipt the flywheel guard reads at `br update --status in_review`; written pass or fail.
			let path: string | null = null;
			let failure = "";
			try {
				path = writeReceipt(env, {
					schema: SELF_REPLAY_RECEIPT_SCHEMA, bead: input.bead, export: exportCommit ?? input.exportSha, acceptance_sha256: acceptanceDigest(boxes),
					actor: input.actor, time: new Date().toISOString(),
					boxes: result.replays.map(r => ({ index: r.index, phase: boxes.find(b => b.index === r.index)?.phase ?? null, command: r.command, verdict: r.pass === true ? "PASS" as const : r.pass === false ? "FAIL" as const : "PENDING" as const, output_sha256: r.outputSha256 ?? null })),
				});
			} catch (error) {
				failure = ` (${error instanceof Error ? error.message : String(error)})`;
			}
			const reason = path === null ? `NOT WRITTEN${failure || " (no usable kit state dir)"}` : null;
			result = { ...result, receipt: { path, ...(reason === null ? {} : { reason }) }, log: `${result.log}\nself-replay receipt: ${path ?? `${reason}; the guard will refuse in_review without it`}` };
		}
		if (attempt === null) {
			if (!dry) return result;
			const reason = "dry run did not allocate an actual verification attempt";
			return { ...result, verificationEvidence: { status: "NOT_RECORDED", reason },
				log: `${result.log}\nverify evidence: NOT_RECORDED (${reason})` };
		}
		const replayClassification = classifyAttempt(result.replays);
		const classified = requiredJudgementPending !== null && replayClassification.outcome === "PASS"
			? { ...replayClassification, outcome: "UNJUDGED" as const, reason: requiredJudgementPending }
			: replayClassification;
		const evidence: VerifyFinalEvidence = {
			result_code: result.code,
			outcome: classified.outcome,
			reason: classified.reason,
			replayed: replayAttempted || classified.replayed,
			export_commit: exportCommit,
		};
		let finalized: VerifyAttemptFinish;
		try {
			finalized = await finalizeVerifyAttempt(attempt, evidence);
		} catch (error) {
			finalized = { status: "UNAVAILABLE" as const, reason: `finalization threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		const persisted = finalized.status === "FINALIZED" || finalized.status === "ALREADY_FINALIZED";
		const visibleReason = "reason" in finalized ? finalized.reason : evidence.reason;
		const verificationEvidence: NonNullable<VerifyResult["verificationEvidence"]> = {
			status: finalized.status,
			attemptId: attempt.id,
			reason: visibleReason,
			...(persisted ? { outcome: evidence.outcome } : {}),
		};
		const visibleOutcome = persisted ? evidence.outcome : "UNRECORDED";
		const visibility = `verify evidence: ${finalized.status} outcome=${visibleOutcome} replayed=${evidence.replayed} native_result=${result.code}; ${visibleReason}`;
		return { ...result, verificationEvidence, log: `${result.log}\n${visibility}` };
	};
	const finishInterrupted = async (error: unknown): Promise<void> => {
		if (attempt === null) return;
		const reason = `verification interrupted by exception: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
		const evidence: VerifyFinalEvidence = {
			result_code: "EXCEPTION", outcome: "INCOMPLETE", reason,
			replayed: replayAttempted, export_commit: exportCommit,
		};
		try {
			const finalized = await finalizeVerifyAttempt(attempt, evidence);
			process.stderr.write(`verify evidence: ${finalized.status} outcome=INCOMPLETE replayed=${replayAttempted}; ${reason}${"reason" in finalized ? `; ${finalized.reason}` : ""}\n`);
		} catch (finalizeError) {
			process.stderr.write(`verify evidence: UNAVAILABLE outcome=INCOMPLETE replayed=${replayAttempted}; ${reason}; finalization failed: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}\n`);
		}
	};
	if (attempt !== null && exportCommit === null) {
		log.push("UNJUDGED: the full export commit identity could not be resolved; no replay ran");
		return await finishAttempt({ ok: false, code: "UNKNOWN", bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts });
	}
	try {
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
	scratchCleanup = () => scratch.cleanup();
	const realBr = resolveRealBr(env.PATH);
	// HERMETIC1-B: tracker management keeps caller authority; acceptance never inherits it.
	const replayBase = { ...env };
	delete replayBase.BEADS_DIR;
	delete replayBase.BEADS_DB;
	delete replayBase.GIT_DIR;
	delete replayBase.GIT_WORK_TREE;
	// VERIFYDEPS1: NODE_PATH would resolve unpinned packages from the working repo's closure
	// and NODE_OPTIONS can --require arbitrary code into every node box; neither reaches replay.
	delete replayBase.NODE_PATH;
	delete replayBase.NODE_OPTIONS;
	replayBase.PATH = (env.PATH ?? "/usr/bin:/bin").split(delimiter)
		.filter(dir => basename(resolve(dir)) !== "agent-bin" && basename(realOrLexical(dir)) !== "agent-bin").join(delimiter);
	if (!realBr.ok) return await finishAttempt({ ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`UNJUDGED: ${realBr.reason}`).join("\n"), acts });
	const replayBin = installReadonlyBr(scratch.path, realBr.path);
	const wantsOwned = replayable.some(b => b.body.includes("OWNED_TRACKER_DB"));
	let ownedDb = "";
	if (wantsOwned) {
		const fixtureDir = join(scratch.path, "fixture");
		mkdirSync(fixtureDir, { recursive: true });
		ownedDb = join(fixtureDir, ".beads", "beads.db");
		const fixtureInit = await run([realBr.path, "init", "--db", ownedDb], { cwd: fixtureDir, deadline_s: 60, env: replayBase });
		if (fixtureInit.rc !== 0) return await finishAttempt({ ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`owned fixture init failed rc ${fixtureInit.rc}: ${text(fixtureInit.stderr).slice(0, 200)}; unmet prerequisite: owned tracker binding`).join("\n"), acts });
	}
	// VERIFYSCRATCH1 (ompkit-fp72.135.3.81): selftests that build fixture trackers under GRADE_WAVE_SCRATCH
	// (grade_wave.py --selftest) then build them inside this run's root, where the read-only br admits them.
	const exportDir = join(scratch.path, "export");
	// VERIFYSCRATCH1 export root: var/agent-tmp is gitignored, so the export has none; kitlib scratch under the
	// repo root needs it, as the gates provide it (fresh-gate.sh, full-suite-verdict.sh).
	const exportTmp = join(exportDir, "var", "agent-tmp");
	const replayEnv = { ...replayBase, AGENT_NAME: prover, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, KITLIB_TMP_ROOT: exportTmp, ...(wantsOwned ? { OWNED_TRACKER_DB: ownedDb } : {}), PATH: `${replayBin}${delimiter}${replayBase.PATH}` };
	if (wantsOwned) log.push(`owned fixture ${ownedDb} (per-run read-only replay)`);
	mkdirSync(exportDir, { recursive: true });
	const archivePath = join(scratch.path, "export.tar");
	const archive = await run(["git", "-C", input.repo, "archive", "--format=tar", `--output=${archivePath}`, input.exportSha], { deadline_s: 300, env });
	const archiveReason = text(archive.stderr).trim() || text(archive.stdout).trim();
	if (archive.rc !== 0 || archive.timed_out || archive.killed) {
		const why = archive.timed_out ? "git archive timed out" : archive.killed ? "git archive was killed" : archiveReason || "git archive produced no error text";
		return await finishAttempt({ ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export failed rc ${archive.rc ?? "null"}: ${why.slice(0, 200)}`).join("\n"), acts });
	}
	const extract = await run(["tar", "-x", "-f", archivePath, "-C", exportDir], { deadline_s: 300, env });
	if (extract.rc !== 0 || extract.timed_out || extract.killed) {
		const why = text(extract.stderr).trim() || text(extract.stdout).trim() || (extract.timed_out ? "tar timed out" : extract.killed ? "tar was killed" : "tar produced no error text");
		return await finishAttempt({ ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export extract failed rc ${extract.rc ?? "null"}: ${why.slice(0, 200)}`).join("\n"), acts });
	}
	let extracted: string[] = [];
	try { extracted = readdirSync(exportDir); } catch { extracted = []; }
	if (extracted.length === 0) {
		return await finishAttempt({ ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat("export extracted nothing: the archive has no files").join("\n"), acts });
	}
	mkdirSync(exportTmp, { recursive: true });
	log.push(`exported ${input.exportSha} to ${exportDir}`);
	replays = [];
	const environmentFailures: string[] = [];
	type ReplayOutcome = Pick<RunResult, "rc" | "timed_out" | "killed" | "truncated" | "total_truncated" | "stdout" | "stderr"> & { out: string; elapsedMs: number };
	const commandResults = new Map<string, ReplayOutcome>();
	const provisioned = new Map<string, ProvisionOutcome>();
	for (const box of replayable) {
		if (box.phase === "live" || box.phase === "after") {
			const command = commandOf(box.body)!;
			process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(command)} elapsed=0ms verdict=PENDING\n`);
			replays.push({ index: box.index, letter: box.letter, command: null, expected: null, rc: null, pass: null, detail: `pending: ${box.phase} phase prerequisite unmet in export replay; not executed`, execution: skippedExecution(false) });
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
			replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: null, pass: null, detail, execution: skippedExecution(true) });
			log.push(`${tag(box)} ${detail}`);
			continue;
		}
		for (const m of paths.mapped) log.push(`${tag(box)} REPO_PATH_MAPPED ${JSON.stringify(m.token)} -> ${m.to} (export, not live tree)`);
		const command = paths.command; // what runs; `named` is the box's own text, reported everywhere
		const deps = await ensureBoxDeps(command, exportDir, replayEnv, log, provisioned);
		if (deps !== null && !deps.ok) {
			environmentFailures.push(`${tag(box)} ${deps.detail}`);
			replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: null, pass: null, detail: `${deps.detail}; not executed`, execution: skippedExecution(true) });
			log.push(`${tag(box)} ${deps.detail}; not executed`);
			continue;
		}
		const cached = commandResults.get(named);
		const reused = cached !== undefined;
		let replay: ReplayOutcome;
		if (cached === undefined) {
			const started = Date.now();
			process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(named)} elapsed=0ms verdict=RUNNING`);
			replayAttempted = true;
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
		const execution: ReplayExecution = {
			eligible: true,
			attempted: !reused,
			reused,
			resultObserved: replay.rc !== null || replay.timed_out || replay.killed,
			completed: replay.rc !== null && replay.rc >= 0 && !replay.timed_out && !replay.killed,
			timedOut: replay.timed_out,
			killed: replay.killed,
			signal: replay.rc !== null && replay.rc < 0 ? -replay.rc : null,
			truncated: replay.truncated,
			totalTruncated: replay.total_truncated,
		};
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
			replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: replay.rc, pass: null, detail, output, execution });
			log.push(`${tag(box)} ENVIRONMENT ${named}: ${detail}; needs-director`);
			continue;
		}
		if (reused) process.stderr.write(`verify progress ${tag(box)} command=${JSON.stringify(named)} elapsed=${elapsedMs}ms verdict=${v.pass ? "PASS" : "FAIL"}\n`);
		else process.stderr.write(`; completed_elapsed=${elapsedMs}ms final_verdict=${v.pass ? "PASS" : "FAIL"}\n`);
		const excerpt = v.pass ? "" : childExcerpt(replay.rc, replay.timed_out, out);
		replays.push({ index: box.index, letter: box.letter, command: named, expected, rc: replay.rc, pass: v.pass, detail: v.detail + evidence + excerpt, execution, outputSha256: sha256Hex(Buffer.concat([replay.stdout, replay.stderr])), ...(output === undefined ? {} : { output }) });
		log.push(`${tag(box)} ${v.pass ? "PASS" : "FAIL"} ${named} -> ${v.detail}${evidence}${excerpt} (${elapsedMs} ms)${replay.timed_out ? " TIMEOUT" : ""}`);
	}
	cleanupScratch();
	const failed = replays.filter(r => r.pass === false);
	if (failed.length > 0) {
		const comment = `REWORK ${input.bead}: ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`;
		acts.push(["br", "update", input.bead, "--status", "rework", "--transition-comment", comment, "--actor", input.actor]);
		if (!dry) for (const a of acts) await run(a, { cwd: trackerCwd, deadline_s: 60, env });
		return await finishAttempt({ ok: false, code: selfReplay ? "SELF_REPLAY" : input.dryRun ? "DRY_RUN" : "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts: selfReplay ? [] : acts });
	}
	if (environmentFailures.length > 0) {
		// A missing or out-of-date lockfile is its own named refusal, never a silent pass or a
		// generic environment failure: the project must commit an up-to-date lockfile.
		const code = environmentFailures.some(f => f.includes("DEPENDENCIES_NOT_LOCKED")) ? "DEPENDENCIES_NOT_LOCKED" : "ENVIRONMENT";
		// A verifier prerequisite is not a project defect; leave its tracker untouched.
		return await finishAttempt({ ok: false, code, bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts });
	}
	const ran = replays.filter(r => r.pass === true);
	if (ran.length === 0) {
		const pending = replays.filter(r => r.pass === null);
		return await finishAttempt({ ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending.map(p => `${tag(p)} ${p.detail}`).join("; ")}`).join("\n"), acts });
	}
	const buildJudgements = boxes.filter(b => !b.checked && b.letter === "v" && b.phase === "build");
	if (buildJudgements.length > 0) {
		const pending = buildJudgements.map(tag).join(" ");
		requiredJudgementPending = `required build judgement remains pending: ${pending}`;
		return await finishAttempt({ ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending} build judgement remains on the parent; it cannot be replayed or deferred as rollout debt`).join("\n"), acts });
	}
	// CLOSEPASS1 (ompkit-774u.52, J-2026-10-29-20): br closes a bead only when every box is ticked, so unticked
	// [live]/[after] boxes this export cannot run move word for word into one LIVEREADBACK child. An unchecked
	// [v][build] judgement is required evidence, not rollout debt; it remains on the parent as PENDING above.
	// The parent keeps its original acceptance in its description and closes holding only boxes verify ran and ticked.
	// Prefer the closing bead's active parent or an available lane; otherwise keep the readback
	// parentless with a `related` link, so reopening is never blocked by its readback debt.
	const deferred = boxes.filter(b => !b.checked && (b.phase === "live" || b.phase === "after"));
	let home = "";
	let homeNote = "";
	if (deferred.length > 0) {
		const up = row?.parent ? await showBead(row.parent, trackerCwd, env) : null;
		if (up !== null && activeStatus(up.status)) home = up.id;
		else {
			const lane = input.laneParent ?? LANE_PARENT;
			const laneRow = await showBead(lane, trackerCwd, env);
			if (laneRow !== null && activeStatus(laneRow.status)) {
				home = lane;
				homeNote = `lane parent ${lane}, because ${input.bead} has no active parent`;
			} else if (input.laneParent !== undefined) {
				return await finishAttempt({ ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${input.bead} has no active parent and lane parent ${lane} is ${laneRow?.status || "unreadable"}; unmet prerequisite: an active parent for the LIVEREADBACK child`).join("\n"), acts });
			}
		}
	}
	const ranIndexes = new Set(ran.map(r => r.index));
	const ticks = boxes.filter(b => ranIndexes.has(b.index)).map(b => b.item - deferred.filter(d => d.item < b.item).length);
	const family = input.family ?? "unknown (set --family)";
	const deferredTags = deferred.map(b => tag(b)).join(" ");
	const deferredAcceptance = deferred.map(box => box.line).join("\n");
	let reuse: string | undefined;
	let resume: ReadbackResume | null = null;
	let readbackKey = "";
	let readbackRef = "";
	if (deferred.length > 0) {
		if (exportCommit === null || row.readbacks.length > 1) return await finishAttempt({
			ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays,
			log: log.concat("pending: readback export identity or unique linked obligation is unproven; no tracker act ran").join("\n"), acts,
		});
		// External refs are unique within the selected tracker, even if it moves.
		readbackKey = createHash("sha256").update(JSON.stringify([row.id, exportCommit, deferredAcceptance])).digest("hex");
		readbackRef = `urn:omp-kit:live-readback:sha256:${readbackKey}`;
		reuse = row.readbacks[0];
		if (reuse !== undefined) {
			const child = await showBead(reuse, trackerCwd, env);
			const legacy = child?.externalRef === null && child.title === `LIVEREADBACK: ${title}`
				&& child.description.includes(`when it closed ${row.id} on export ${exportCommit}:`);
			if (child === null || child.acceptance !== deferredAcceptance || !child.labels.includes(LIVE_READBACK_LABEL)
				|| child.related.length !== 1 || child.related[0] !== row.id || (child.externalRef !== readbackRef && !legacy)) {
				return await finishAttempt({ ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays,
					log: log.concat(`pending: linked readback ${reuse} is unreadable or does not match this exact export and obligation; no tracker act ran`).join("\n"), acts });
			}
			if (child.status === "deferred") resume = await readbackResume(row.id, child, deferredAcceptance, trackerCwd, env);
			if (resume !== null && "reason" in resume) return await finishAttempt({ ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${resume.reason}; no tracker act ran`).join("\n"), acts });
		}
	}
	const childRef = reuse ?? CHILD;
	const reason = `verified by ${prover} (family: ${family}) on export ${input.exportSha}: ${ran.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}${deferred.length ? `; deferred ${deferredTags} to ${childRef} (LIVEREADBACK, ${home ? `child of ${homeNote || home}` : "parentless"}, related to ${input.bead})` : ""}`;
	if (deferred.length > 0) {
		const moved = new Set(deferred.map(b => b.item));
		let item = 0;
		const remaining = acceptance.split("\n").filter(raw => !CHECKLIST_ITEM.test(raw.trim()) || !moved.has(++item)).join("\n");
		const childDescription = `WHAT: read back, on the installed kit, the boxes omp-kit verify deferred when it closed ${row.id} on export ${exportCommit}: \`omp-kit verify <this bead> --live-readback\`. A pass ticks them and closes this bead; a failure reopens ${row.id} with REWORK naming the box.\n\nWHY: ${row.id}'s executed boxes passed, and br closes a bead only with every box ticked (CLOSEPASS1 ompkit-774u.52, J-2026-10-29-20), so these boxes stay open, visible debt until they are read back.\n\nVerified bead: ${row.id} (related link)\nVerified title: ${title}\n\n${LIVE_READBACK_PRIOR_ART}`;
		if (reuse === undefined) acts.push(["br", "create", `LIVEREADBACK: ${readbackKey}`, "-t", "task", "-l", LIVE_READBACK_LABEL,
			...(home ? ["--parent", home] : []), "--deps", `related:${row.id}`, "--external-ref", readbackRef,
			"--description", childDescription, "--acceptance-criteria", deferredAcceptance, "--json", "--actor", input.actor]);
		else if (resume !== null && "revision" in resume) acts.push(["br", "update", reuse, "--status", "open", "--transition-comment", `verify resumed its unchanged withdrawn readback for ${row.id}`, "--if-unchanged", resume.revision, "--json", "--actor", input.actor]);
		// br refuses, without --force, a rewrite that keeps less than half of a field's length; only acceptance shrinks.
		const shrinks = [...remaining].length * 2 < [...acceptance].length + 4;
		acts.push(["br", "update", input.bead, "--description", `${description}\n\n## Original acceptance (before omp-kit verify moved ${deferredTags} to ${childRef})\n${acceptance}`, "--acceptance-criteria", remaining, ...(shrinks ? ["--force"] : []), "--actor", input.actor]);
	}
	acts.push(["br", "update", input.bead, "--check-acceptance", ticks.join(","), "--actor", input.actor]);
	// VERIFYGATE1: when the target workflow requires no min_reviewers gate for this closing transition,
	// the report is refused rc 4 after the ticks are written. Ask first and skip the report, saying so;
	// an unreadable answer keeps the act and the fallback below still lands the close.
	const gateRequired = await minReviewersRequired(trackerCwd, input.bead, row.status, env);
	if (gateRequired === false) log.push(`gate ${MIN_REVIEWERS_GATE} not required for transition '${row.status} -> closed'; skipping gate report`);
	else acts.push(["br", "gate", "report", input.bead, "--gate", MIN_REVIEWERS_GATE, "--provider", `reviewer:${prover}`, "--status", "pass", "--to", "closed", "--actor", input.actor]);
	acts.push(["br", "close", input.bead, "--reason", reason, "--transition-comment", `CLOSED ${input.bead} by ${prover} (family: ${family})${bg === undefined ? "" : ` background verifier ${bg.label} of ${bg.parent} session ${bg.session}`}${lesson === null ? "" : `\n${lesson}`}\n${log.join("\n")}`, "--actor", input.actor]);
	if (homeNote) log.push(`LIVEREADBACK child placed under ${homeNote}`);
	const child = deferred.length > 0 ? childRef : undefined;
	if (dry) return await finishAttempt({ ok: true, code: selfReplay ? "SELF_REPLAY" : "DRY_RUN", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts: selfReplay ? [] : acts, child: selfReplay ? undefined : child });
	const done = await executeActs(acts, trackerCwd, env, { bead: row, actor: input.actor, ...(resume !== null && "revision" in resume ? { resumedChild: resume.child } : {}) });
	if (done.failure !== null) return await finishAttempt({ ok: false, code: "ACT_FAILED", bead: input.bead, export: input.exportSha, replays, log: log.concat(done.failure).join("\n"), acts: done.acts, child: done.child ?? reuse, rollback: done.rollback });
	if (done.skippedGate !== null) log.push(`gate ${MIN_REVIEWERS_GATE} not required for transition '${done.skippedGate}'; skipping gate report`);
	if (lesson !== null) recordCloseLesson(trackerCwd, input.bead, lesson, input.exportSha, log);
	return await finishAttempt({ ok: true, code: "CLOSED", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts: done.acts, child: done.child ?? reuse });
	} catch (error) {
		try { cleanupScratch(); }
		catch (cleanupError) {
			try { process.stderr.write(`verify scratch cleanup failed while preserving original exception: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`); } catch { /* preserve the verifier exception */ }
		}
		try { await finishInterrupted(error); }
		catch (finalizeError) {
			try { process.stderr.write(`verify evidence finalization failed while preserving original exception: ${finalizeError instanceof Error ? finalizeError.message : String(finalizeError)}\n`); } catch { /* preserve the verifier exception */ }
		}
		throw error;
	}
}

/**
 * Run tracker acts in order. The id a `br create --json` act prints replaces CHILD in every later act, and the
 * returned acts carry that substitution. The first non-zero act stops the run and is named in `failure`.
 */
type ActCheckpoint = { bead: BeadRow; actor: string; resumedChild?: string };

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
	const current = await showBead(before.id, cwd, env);
	if (current?.acceptance === before.acceptance && current.status === before.status)
		return { status: expected === before.acceptance ? "NOT_NEEDED" : "RESTORED", detail: "original acceptance and status are present" };
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
/** Outcome of withdrawing this attempt's live child after a failed act. No peer child is ever touched. */
export interface ChildWithdrawal { status: "NOT_NEEDED" | "WITHDRAWN" | "STATE_UNPROVEN" | "WITHDRAW_REFUSED"; detail: string }

const READBACK_ROLLBACK_PREFIX = "verify-rollback:";

type ReadbackResume = { child: string; revision: string } | { reason: string };

/** A receipt's exact child revision prevents a later peer edit or operator pause being resumed. */
async function readbackResume(parent: string, child: BeadRow, acceptance: string, cwd: string, env: Record<string, string>): Promise<ReadbackResume> {
	if (child.updatedAt === null || child.assignee !== null || child.acceptance !== acceptance
		|| !child.labels.includes(LIVE_READBACK_LABEL) || child.related.length !== 1 || child.related[0] !== parent)
		return { reason: `STATE_UNPROVEN: deferred readback ${child.id} does not match the current parent obligations` };
	const db = env.BEADS_DB ? ["--db", env.BEADS_DB] : [];
	const listed = await run(["br", "comments", "list", parent, "--json", ...db], { cwd, env, deadline_s: 60, max_output_bytes: 4 * 1024 * 1024 });
	if (listed.rc !== 0 || listed.truncated || listed.total_truncated) return { reason: `STATE_UNPROVEN: withdrawal receipts for ${parent} are unreadable` };
	let comments: unknown;
	try { comments = JSON.parse(text(listed.stdout)); } catch { return { reason: `STATE_UNPROVEN: withdrawal receipts for ${parent} are invalid` }; }
	if (!Array.isArray(comments)) return { reason: `STATE_UNPROVEN: withdrawal receipts for ${parent} are incomplete` };
	for (const comment of comments) {
		if (comment === null || typeof comment !== "object" || !("text" in comment) || typeof comment.text !== "string"
			|| !("author" in comment) || typeof comment.author !== "string" || !comment.text.startsWith(READBACK_ROLLBACK_PREFIX)) continue;
		let receipt: unknown;
		try { receipt = JSON.parse(comment.text.slice(READBACK_ROLLBACK_PREFIX.length)); } catch { continue; }
		if (receipt === null || typeof receipt !== "object") continue;
		const record = receipt as Record<string, unknown>;
		if (record.version === 1 && record.parent === parent && record.child === child.id
			&& record.actor === comment.author && record.updated_at === child.updatedAt) return { child: child.id, revision: child.updatedAt };
	}
	return { reason: `STATE_UNPROVEN: deferred readback ${child.id} has no unchanged machine-withdrawal receipt; operator state is retained` };
}

/** The native child transition and its marker commit together. A parent comment records the
 * returned exact child revision without advancing it again, so retry remains revision-bound.
 * Unhandled process crashes are not claimed atomic or automatically swept. */
export async function withdrawChild(child: string, baseline: { status: string | null; updatedAt: string | null }, parent: string, actor: string, cwd: string, env: Record<string, string>, ranActs: string[][]): Promise<ChildWithdrawal> {
	const current = await showBead(child, cwd, env);
	if (current === null || baseline.status !== "open" || baseline.updatedAt === null || current.assignee !== null
		|| current.status !== baseline.status || current.updatedAt !== baseline.updatedAt)
		return { status: "STATE_UNPROVEN", detail: "live child is unreadable or differs from this attempt's atomic baseline; no peer edit overwritten" };
	const marker = { version: 1, parent, child, actor };
	const defer = ["br", "update", child, "--status", "deferred", "--transition-comment", READBACK_ROLLBACK_PREFIX + JSON.stringify(marker), "--if-unchanged", baseline.updatedAt, "--json", "--actor", actor];
	ranActs.push(defer);
	const deferred = await run(defer, { cwd, deadline_s: 60, env });
	if (deferred.rc !== 0) return { status: "WITHDRAW_REFUSED", detail: `defer rc ${deferred.rc}: ${text(deferred.stderr)}` };
	let mutation: unknown;
	try { mutation = JSON.parse(text(deferred.stdout)); } catch { return { status: "STATE_UNPROVEN", detail: "child withdrawal returned no exact revision; retry remains unproven" }; }
	const row: unknown = Array.isArray(mutation) ? mutation[0] : mutation;
	if (row === null || typeof row !== "object" || !("id" in row) || row.id !== child
		|| !("status" in row) || row.status !== "deferred" || !("updated_at" in row) || typeof row.updated_at !== "string")
		return { status: "STATE_UNPROVEN", detail: "child withdrawal returned an incomplete revision; retry remains unproven" };
	const receipt = ["br", "comments", "add", parent, "-m", READBACK_ROLLBACK_PREFIX + JSON.stringify({ ...marker, updated_at: row.updated_at }), "--actor", actor];
	ranActs.push(receipt);
	const recorded = await run(receipt, { cwd, deadline_s: 60, env });
	if (recorded.rc !== 0) return { status: "WITHDRAW_REFUSED", detail: "child deferred with its marker, but the exact retry receipt could not be recorded on the parent" };
	return { status: "WITHDRAWN", detail: `live child ${child} deferred with its exact revision recorded for ${parent}` };
}

interface ReadbackCheckpoint { id: string; status: string | null; updatedAt: string | null }

/** Capture the mutation's own receipt, never a later read that could adopt a peer edit. */
function readbackCheckpoint(stdout: Uint8Array): ReadbackCheckpoint | null {
	let mutation: unknown;
	try { mutation = JSON.parse(text(stdout)); } catch { return null; }
	const row: unknown = Array.isArray(mutation) ? mutation[0] : mutation;
	if (row === null || typeof row !== "object") return null;
	const record = row as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id === "") return null;
	return {
		id: record.id,
		status: typeof record.status === "string" ? record.status : null,
		updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
	};
}

async function compensateAttempt(checkpoint: ActCheckpoint | undefined, expected: string, child: ReadbackCheckpoint | undefined, creationUnproven: boolean, execution: { cwd: string; env: Record<string, string>; acts: string[][] }): Promise<{ rollback: AcceptanceRollback; withdrawal: ChildWithdrawal }> {
	const { cwd, env, acts } = execution;
	let rollback: AcceptanceRollback = checkpoint === undefined
		? { status: "NOT_NEEDED", detail: "no acceptance checkpoint was changed" }
		: await restoreAcceptance(checkpoint, expected, cwd, env, acts);
	const parentRestored = rollback.status === "NOT_NEEDED" || rollback.status === "RESTORED";
	const withdrawal: ChildWithdrawal = child !== undefined && checkpoint !== undefined
		? parentRestored
			? await withdrawChild(child.id, child, checkpoint.bead.id, checkpoint.actor, cwd, env, acts)
			: { status: "STATE_UNPROVEN", detail: "parent restoration is unproven; the live child remains active" }
		: creationUnproven
			? { status: "STATE_UNPROVEN", detail: "child creation returned no identity; no child state was changed" }
			: { status: "NOT_NEEDED", detail: "no live child was created or resumed" };
	if (withdrawal.status !== "NOT_NEEDED") {
		const status = !parentRestored ? rollback.status
			: withdrawal.status === "STATE_UNPROVEN" ? "STATE_UNPROVEN"
				: withdrawal.status === "WITHDRAW_REFUSED" ? "ROLLBACK_REFUSED" : "RESTORED";
		rollback = { status, detail: `${rollback.detail}; withdrawal ${withdrawal.status}: ${withdrawal.detail}` };
	}
	return { rollback, withdrawal };
}

async function executeActs(acts: string[][], cwd: string, env: Record<string, string>, checkpoint?: ActCheckpoint): Promise<{ acts: string[][]; child?: string; failure: string | null; skippedGate: string | null; rollback?: AcceptanceRollback }> {
	let child: string | undefined;
	let managedChild: ReadbackCheckpoint | undefined;
	let creationUnproven = false;
	let skippedGate: string | null = null;
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
		const creating = argv[1] === "create";
		const resuming = argv[1] === "update" && argv[2] === checkpoint?.resumedChild;
		if (creating || resuming) {
			const receipt = readbackCheckpoint(r.stdout);
			const id = resuming ? checkpoint?.resumedChild : receipt?.id;
			if (id !== undefined) {
				if (creating) child = id;
				managedChild = receipt?.id === id ? receipt : { id, status: null, updatedAt: null };
			} else if (creating) creationUnproven = true;
		}
		if (r.rc !== 0) {
			// VERIFYGATE1 fallback: the pre-act gate query could not say whether the workflow requires
			// this gate (an older br, an unreadable answer). Skip exactly this validation and run on to
			// the close, never any other error.
			if (isGateNotRequiredFailure(argv, text(r.stderr))) {
				skippedGate = notRequiredTransition(text(r.stderr)) ?? "unknown transition";
				continue;
			}
			failure = `act failed rc ${r.rc}: ${argv.slice(0, 4).join(" ")}: ${text(r.stderr)}`;
			break;
		}
		if (creating && child === undefined) {
			failure = `act failed: br create printed no child id: ${text(r.stdout)}`;
			break;
		}
	}
	if (failure === null) return { acts: ranActs, child, failure: null, skippedGate };
	const { rollback, withdrawal } = await compensateAttempt(checkpoint, expectedAcceptance, managedChild, creationUnproven, { cwd, env, acts: ranActs });
	return { acts: ranActs, child, rollback, skippedGate, failure: `${failure}\nrollback: ${rollback.status}\nwithdrawal: ${withdrawal.status}` };
}

/** The fields verify reads from one bead. Deferred readback candidates require an exact native withdrawal receipt before reactivation. */
interface BeadRow { id: string; title: string; description: string; acceptance: string; status: string; assignee: string | null; createdBy: string | null; createdAt: string | null; updatedAt: string | null; labels: string[]; parent: string | null; related: string[]; readbacks: string[]; externalRef: string | null }

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
	const title = field("title") ?? "";
	// Related edges identify candidates, not authority to reuse one.
	const readbacks = (Array.isArray(record.dependents) ? record.dependents : [])
		.map((dep: unknown) => dep !== null && typeof dep === "object" && "dependency_type" in dep && dep.dependency_type === "related"
			&& "title" in dep && typeof dep.title === "string" && dep.title.startsWith("LIVEREADBACK: ")
			&& "status" in dep && (dep.status === "open" || dep.status === "in_progress" || dep.status === "deferred")
			&& "id" in dep && typeof dep.id === "string" ? dep.id : "")
		.filter(dep => dep !== "");
	return { id: field("id") ?? id, title, description: field("description") ?? "", acceptance: field("acceptance_criteria") ?? "", status: field("status") ?? "", assignee: field("assignee"), createdBy: field("created_by"), createdAt: field("created_at"), updatedAt: field("updated_at"), labels, parent: field("parent"), related, readbacks, externalRef: field("external_ref") };
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
	const boxes = parseBoxes(child.acceptance);
	const toRun = boxes.filter(b => b.letter !== "v" && !b.checked);
	// ALLLIVE1: a bead whose every open box is [live]/[after] has nothing an export can replay, so verify can never
	// close it (PENDING) and it never gets a child. It is read back directly, as its own readback child would be.
	const direct = !child.labels.includes(LIVE_READBACK_LABEL) && toRun.length > 0 && toRun.every(b => b.phase === "live" || b.phase === "after");
	// VERIFYGATE1-readback: after a DONE handoff the bead is in_review, and the live boxes are still open
	// work. Accept an in_review bead whose every remaining box is [live], as well as the open cases.
	const inReviewLive = child.status === "in_review" && toRun.length > 0 && toRun.every(b => b.phase === "live");
	if (child.status === "open" ? !(direct || child.labels.includes(LIVE_READBACK_LABEL)) : !inReviewLive) return refuse("NOT_LIVE_READBACK", `${input.bead} is ${child.status || "unknown"} with labels [${child.labels.join(", ")}]; only an open ${LIVE_READBACK_LABEL} child, an open bead whose every open box is [live]/[after], or an in_review bead whose every remaining box is [live], is read back`);
	// The verified bead is the child's one `related` link (its parent-child edge points at the active home bead).
	const parent = direct ? child : child.related.length === 1 ? await showBead(child.related[0]!, input.repo, env) : null;
	if (parent === null) return refuse("NOT_LIVE_READBACK", `${input.bead} needs exactly one readable related link to the bead it reads back; it has [${child.related.join(", ")}]`);
	if (input.actor === parent.assignee || input.actor === child.assignee) return refuse("NON_AUTHOR_REQUIRED", `refused: ${input.actor} is the assignee of ${input.actor === parent.assignee ? parent.id : child.id}`);
	const bad = toRun.filter(b => unreplayableReason(b) !== null);
	if (bad.length > 0) return refuse("ACCEPTANCE_NOT_REPLAYABLE", `not replayable: ${bad.map(b => `${tag(b)} ${unreplayableReason(b)}`).join("; ")}`);
	// An unchecked [v][build] judgement is required evidence, never replayable debt: refuse PENDING
	// exactly as the export path does, before anything is replayed or ticked.
	const buildJudgements = boxes.filter(b => !b.checked && b.letter === "v" && b.phase === "build");
	if (buildJudgements.length > 0) return refuse("PENDING", `pending: ${buildJudgements.map(tag).join(" ")} build judgement remains on the bead; it cannot be replayed or deferred as rollout debt`);
	// A generated readback can inherit the source author's optional lesson.
	const lesson = await closeLesson(input.lesson, child, input.repo, env)
		?? (parent.id === child.id ? null : await closeLesson(undefined, parent, input.repo, env));
	if (lesson === null) log.push("WARNING: no author Lesson: comment or --lesson supplied; continuing without a lesson");
	const harnessRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
	const scratch = ownedTmp("verify-live", { bead: input.bead, ...(harnessRoot === undefined ? {} : { root: harnessRoot }) });
	const realBr = resolveRealBr(env.PATH);
	if (!realBr.ok) return refuse("NOT_IN_REVIEW", `UNJUDGED: ${realBr.reason}`);
	const replayEnv = { ...env, AGENT_NAME: input.actor, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, PATH: `${installReadonlyBr(scratch.path, realBr.path)}:${env.PATH ?? "/usr/bin:/bin"}` };
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
		acts.push(direct
			? ["br", "comments", "add", parent.id, `REWORK ${parent.id}: live readback failed ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`, "--actor", input.actor]
			: ["br", "reopen", parent.id, "--reason", `REWORK ${parent.id}: live readback ${child.id} failed ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`, "--actor", input.actor]);
	} else {
		const ticks = toRun.map(b => b.item);
		if (ticks.length > 0) acts.push(["br", "update", child.id, "--check-acceptance", ticks.join(","), "--actor", input.actor]);
		// VERIFYGATE1-readback: same skip as the export path; the open -> closed edge of a gateless
		// workflow refuses the report the same way. An unreadable answer keeps the act.
		const gateRequired = await minReviewersRequired(input.repo, child.id, child.status, env);
		if (gateRequired === false) log.push(`gate ${MIN_REVIEWERS_GATE} not required for transition '${child.status} -> closed'; skipping gate report`);
		else acts.push(["br", "gate", "report", child.id, "--gate", MIN_REVIEWERS_GATE, "--provider", `reviewer:${input.actor}`, "--status", "pass", "--to", "closed", "--actor", input.actor]);
		acts.push(["br", "close", child.id, "--reason", `live readback of ${parent.id} by ${input.actor} (family: ${family}) on the installed kit: ${replays.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}`, "--transition-comment", `CLOSED ${child.id} by ${input.actor} (family: ${family})${lesson === null ? "" : `\n${lesson}`}\n${log.join("\n")}`, "--actor", input.actor]);
	}
	const code: VerifyResult["code"] = input.dryRun ? "DRY_RUN" : failed.length > 0 ? "REWORK" : "CLOSED";
	if (input.dryRun) return { ok: failed.length === 0, code, bead: input.bead, export: "installed", replays, log: log.join("\n"), acts };
	const done = await executeActs(acts, input.repo, env, failed.length > 0 ? undefined : { bead: child, actor: input.actor });
	if (done.failure !== null) return { ok: false, code: "ACT_FAILED", bead: input.bead, export: "installed", replays, log: log.concat(done.failure).join("\n"), acts: done.acts, rollback: done.rollback };
	if (done.skippedGate !== null) log.push(`gate ${MIN_REVIEWERS_GATE} not required for transition '${done.skippedGate}'; skipping gate report`);
	if (failed.length === 0 && lesson !== null) recordCloseLesson(input.repo, child.id, lesson, "installed", log);
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
