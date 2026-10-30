/**
 * `omp-kit verify <bead> --export <sha> [--actor NAME] [--project PATH] [--json] [--dry-run]`
 * (AUTOCOMPLETE1 ompkit-fp72.135.3.17 [b]; plan section 22 step 6, section 23.2 close row, section 26 W1).
 *
 * The one non-author close verb. It exports the exact commit into owned scratch, replays the command each
 * acceptance box names, and judges each box by its NAMED EXPECTED OUTCOME, never by exit 0 alone
 * (QuietBadger AM 68959 #1: our own examples include exit 0 with a null headline). A box with no replayable
 * command is refused ACCEPTANCE_NOT_REPLAYABLE and the bead goes back to intake. The author's own seat is
 * refused NON_AUTHOR_REQUIRED. A box whose command fails sets REWORK naming the box. Only when every box passes
 * does it tick the boxes, report the reviewer gate under the caller's identity (family disclosed), write the
 * transition comment from the command log and close. Transaction metadata is completed; the verdict is earned.
 *
 * CLOSEPASS1 (ompkit-774u.52): when every box it ran passes, unticked [live], [after] and [v] boxes (which no
 * export can run) move word for word into one open `LIVEREADBACK: <title>` bead labelled live-readback, created
 * under the closing bead's own active parent (else the constraint lane's parent, LANE_PARENT) with a `related` link
 * back. The closing bead keeps its original acceptance in its description and closes holding only ticked boxes, so
 * br's own close policy admits it with no --force. A bead with no executed box stays PENDING. `--live-readback`
 * (liveReadback, liveReadbackAll) reads such children back on the installed kit.
 *
 * Box grammar: `- [ ] [a] [phase] `command` -> <expected>` or `... ; expect: <expected>` or `...; planted: ...`.
 * The letter is optional and the phase is one of build/landed/live/after (VERIFYBOX1
 * ompkit-fp72.135.3.17.1: phase-only `[build]` boxes and the `after` phase parse; untagged
 * prose checkboxes are not boxes and keep their original meaning). A tag that is neither a
 * single letter nor a known phase makes the item unsupported: it is named and fails closed,
 * never silently dropped. Letter `v` marks a verification-note box that is never replayed.
 * This grammar is defined only here: scripts/box-lint.ts runs parseBoxes, commandOf, expectedOf and
 * unreplayableReason for bead_lint's create and update admission (REPLAYABLE1 ompkit-fp72.135.3.71).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { preflightBead } from "./preflight.ts";
import { installReadonlyBr, resolveRealBr } from "./kitlib/readonly-br.ts";

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
export interface BoxReplay { index: number; letter: string | null; command: string | null; expected: string | null; outcome: "exit-only" | "named"; rc: number | null; pass: boolean | null; detail: string }
export interface VerifyResult {
	ok: boolean;
	code: "CLOSED" | "REWORK" | "NON_AUTHOR_REQUIRED" | "ACCEPTANCE_NOT_REPLAYABLE" | "NOT_IN_REVIEW" | "NOT_LIVE_READBACK" | "EXPORT_FAILED" | "DRY_RUN" | "PENDING";
	bead: string;
	export: string;
	replays: BoxReplay[];
	log: string;
	acts: string[][];
	/** CLOSEPASS1: the LIVEREADBACK child holding the boxes this close deferred ("{child}" in a dry run). */
	child?: string;
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

/**
 * Why this verb cannot replay one box, or null when it can (REPLAYABLE1 ompkit-fp72.135.3.71).
 * The one judgment verifyBead refuses ACCEPTANCE_NOT_REPLAYABLE by and scripts/box-lint.ts
 * (bead_lint's create and update admission) refuses new boxes by. `[v]` boxes are the caller's to skip.
 */
export function unreplayableReason(box: Box): "unsupported-phase" | "no-command" | "command-not-followed-by-expected" | null {
	if (box.phase !== null && KNOWN_PHASES[box.phase] !== true) return "unsupported-phase";
	const span = CMD.exec(box.body);
	if (span === null) return "no-command";
	// The first backticked span is what runs, so it must be the command the box judges: `cmd` -> <expected> or
	// `cmd` expect: <expected>. Quoted obligation text (`br update <id> --status in_review`) would otherwise run.
	const after = box.body.slice(span.index + span[0].length).trimStart();
	return after.startsWith("->") || /^expect(?:ed)?:/i.test(after) ? null : "command-not-followed-by-expected";
}

/** The expected-outcome clause of a box: text after `->` or after `expect:`; null when the box names none. */
export function expectedOf(body: string): string | null {
	const arrow = /->\s*([^;.]+)/.exec(body);
	if (arrow) return arrow[1]!.trim();
	const exp = /\bexpect(?:ed)?:\s*([^;.]+)/i.exec(body);
	return exp ? exp[1]!.trim() : null;
}

/** Judge output against a named expectation; null expectation = exit-only. */
export function judge(expected: string | null, rc: number | null, out: string): { pass: boolean; outcome: "exit-only" | "named"; detail: string } {
	if (expected === null) return { pass: rc === 0, outcome: "exit-only", detail: `rc ${rc} (exit-only: the box names no expected outcome)` };
	const e = expected.trim();
	let m: RegExpExecArray | null;
	if ((m = /^rc\s+(\d+)$/i.exec(e)) || (m = /^exit\s+(\d+)$/i.exec(e))) return { pass: rc === Number(m[1]), outcome: "named", detail: `rc ${rc}, expected ${m[1]}` };
	if ((m = /^(\d+)\s+pass(?:\s+(\d+)\s+fail)?$/i.exec(e))) {
		const pass = new RegExp(`\\b${m[1]}\\s+pass\\b`).test(out) && (m[2] === undefined || new RegExp(`\\b${m[2]}\\s+fail\\b`).test(out));
		return { pass, outcome: "named", detail: `summary ${m[1]} pass${m[2] !== undefined ? ` ${m[2]} fail` : ""}: ${pass ? "found" : "not found"}` };
	}
	if ((m = /^(?:prints|contains)\s+(.+)$/i.exec(e))) { const needle = m[1]!.replace(/^["'`]|["'`]$/g, ""); return { pass: out.includes(needle), outcome: "named", detail: `output ${out.includes(needle) ? "contains" : "lacks"} ${JSON.stringify(needle)}` }; }
	// Any other wording: the literal text must appear in the output; rc is not consulted (the box said what it expects).
	return { pass: out.includes(e), outcome: "named", detail: `output ${out.includes(e) ? "contains" : "lacks"} ${JSON.stringify(e)}` };
}
/** Bounded child-output excerpt for a failed replay, so a future failure carries its own evidence. Passes keep the detail byte-identical. */
const CHILD_HEAD = 1000;
const CHILD_TAIL = 3000;
function childExcerpt(rc: number | null, timedOut: boolean, out: string): string {
	const total = out.length;
	if (total === 0) return `; child rc ${rc}${timedOut ? " TIMEOUT" : ""}: no stdout/stderr captured`;
	const head = out.slice(0, CHILD_HEAD);
	const tail = total > CHILD_HEAD + CHILD_TAIL ? out.slice(-CHILD_TAIL) : out.slice(CHILD_HEAD);
	const omitted = total - head.length - tail.length;
	return `; child rc ${rc}${timedOut ? " TIMEOUT" : ""} ${total} chars: ${head}${omitted > 0 ? `...[${omitted} chars omitted]...${tail}` : tail}`;
}

/** `laneParent` overrides LANE_PARENT (a tracker without the omp-kit lane, such as a fixture). */
export interface VerifyInput { bead: string; exportSha: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; family?: string; laneParent?: string }

export async function verifyBead(input: VerifyInput): Promise<VerifyResult> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const acts: string[][] = [];
	const log: string[] = [`verify ${input.bead} export ${input.exportSha} actor ${input.actor} ${new Date().toISOString()}`];
	const pre = await preflightBead("close", input.repo, input.bead, { actor: input.actor, env });
	const blocking = pre.findings.filter(f => f.blocking);
	if (blocking.some(f => f.code === "SELF_CLOSE")) return { ok: false, code: "NON_AUTHOR_REQUIRED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${input.actor} is the assignee`).join("\n"), acts };
	if (blocking.some(f => f.code === "NOT_IN_REVIEW" || f.code === "UNJUDGED")) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(blocking.map(f => `${f.code}: ${f.detail}`)).join("\n"), acts };
	const row = await showBead(input.bead, input.repo, env);
	const acceptance = row?.acceptance ?? "";
	const title = row?.title || input.bead;
	const description = row?.description ?? "";
	const boxes = parseBoxes(acceptance);
	const replayable = boxes.filter(b => b.letter !== "v");
	const bad = replayable.filter(b => unreplayableReason(b) !== null);
	if (replayable.length === 0 || bad.length > 0) {
		log.push(`not replayable: ${bad.length ? bad.map(b => { const why = unreplayableReason(b); return why === "unsupported-phase" ? `${tag(b)} unsupported phase [${b.phase}]` : why === "no-command" ? `${tag(b)} names no command` : `${tag(b)} first backticked span ${JSON.stringify(commandOf(b.body))} is not followed by -> or expect:`; }).join("; ") : "no boxes"}`);
		return { ok: false, code: "ACCEPTANCE_NOT_REPLAYABLE", bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts: [["br", "update", input.bead, "--status", "open", "--add-label", "needs-intake", "--actor", input.actor]] };
	}
	// The owned replay fixture uses an explicit database path under its per-run
	// scratch; deleting BEADS_DB alone would still discover an ancestor tracker.
	const harnessRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
	const scratch = ownedTmp("verify", { bead: input.bead, ...(harnessRoot === undefined ? {} : { root: harnessRoot }) });
	const realBr = resolveRealBr(env.PATH);
	if (realBr === null) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat("UNJUDGED: no resolvable br on PATH; unmet prerequisite: real br binary").join("\n"), acts };
	const replayBin = installReadonlyBr(scratch.path, realBr);
	const wantsOwned = replayable.some(b => b.body.includes("OWNED_TRACKER_DB"));
	let ownedDb = "";
	if (wantsOwned) {
		const fixtureDir = join(scratch.path, "fixture");
		mkdirSync(fixtureDir, { recursive: true });
		const unboundEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(env)) if (k !== "BEADS_DB") unboundEnv[k] = v;
		ownedDb = join(fixtureDir, ".beads", "beads.db");
		const fixtureInit = await run(["br", "init", "--db", ownedDb], { cwd: fixtureDir, deadline_s: 60, env: unboundEnv });
		if (fixtureInit.rc !== 0) return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`owned fixture init failed rc ${fixtureInit.rc}: ${text(fixtureInit.stderr).slice(0, 200)}; unmet prerequisite: owned tracker binding`).join("\n"), acts };
	}
	// VERIFYSCRATCH1 (ompkit-fp72.135.3.81): selftests that build fixture trackers under GRADE_WAVE_SCRATCH
	// (grade_wave.py --selftest) then build them inside this run's root, where the read-only br admits them.
	const exportDir = join(scratch.path, "export");
	// VERIFYSCRATCH1 export root: var/agent-tmp is gitignored, so the export has none; kitlib scratch under the
	// repo root needs it, as the gates provide it (fresh-gate.sh, full-suite-verdict.sh).
	const exportTmp = join(exportDir, "var", "agent-tmp");
	const replayEnv = { ...env, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, KITLIB_TMP_ROOT: exportTmp, ...(wantsOwned ? { OWNED_TRACKER_DB: ownedDb } : {}), PATH: `${replayBin}:${env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}` };
	if (wantsOwned) log.push(`owned fixture ${ownedDb} (per-run read-only replay)`);
	mkdirSync(exportDir, { recursive: true });
	const archive = await run(["sh", "-c", `git -C ${JSON.stringify(input.repo)} archive ${JSON.stringify(input.exportSha)} | tar -x -C ${JSON.stringify(exportDir)}`], { deadline_s: 300, env });
	if (archive.rc !== 0 || !existsSync(join(exportDir, "scripts")) && !existsSync(join(exportDir, "src"))) {
		return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export failed rc ${archive.rc}: ${text(archive.stderr).slice(0, 200)}`).join("\n"), acts };
	}
	mkdirSync(exportTmp, { recursive: true });
	log.push(`exported ${input.exportSha} to ${exportDir}`);
	const replays: BoxReplay[] = [];
	for (const box of replayable) {
		if (box.phase === "live" || box.phase === "after") {
			replays.push({ index: box.index, letter: box.letter, command: null, expected: null, outcome: "named", rc: null, pass: null, detail: `pending: ${box.phase} phase prerequisite unmet in export replay; not executed` });
			log.push(`${tag(box)} PENDING ${box.phase} phase prerequisite unmet; not executed`);
			continue;
		}
		const command = commandOf(box.body)!;
		const expected = expectedOf(box.body);
		const started = Date.now();
		const r = await run(["sh", "-c", command], { cwd: exportDir, deadline_s: 900, env: replayEnv, max_output_bytes: 4 * 1024 * 1024 });
		const out = text(r.stdout) + text(r.stderr);
		const v = judge(expected, r.rc, out);
		const excerpt = v.pass ? "" : childExcerpt(r.rc, r.timed_out, out);
		replays.push({ index: box.index, letter: box.letter, command, expected, outcome: v.outcome, rc: r.rc, pass: v.pass, detail: v.detail + excerpt });
		log.push(`${tag(box)} ${v.pass ? "PASS" : "FAIL"} ${command} -> ${v.detail}${excerpt} (${Date.now() - started} ms)${r.timed_out ? " TIMEOUT" : ""}`);
	}
	const failed = replays.filter(r => r.pass === false);
	if (failed.length > 0) {
		const comment = `REWORK ${input.bead}: ${failed.map(f => `${tag(f)} ${f.detail}`).join("; ")}\n${log.join("\n")}`;
		acts.push(["br", "update", input.bead, "--status", "rework", "--transition-comment", comment, "--actor", input.actor]);
		if (!input.dryRun) for (const a of acts) await run(a, { cwd: input.repo, deadline_s: 60, env });
		return { ok: false, code: input.dryRun ? "DRY_RUN" : "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
	}
	const ran = replays.filter(r => r.pass === true);
	if (ran.length === 0) {
		const pending = replays.filter(r => r.pass === null);
		return { ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending.map(p => `${tag(p)} ${p.detail}`).join("; ")}`).join("\n"), acts };
	}
	// CLOSEPASS1 (ompkit-774u.52, J-2026-10-29-20): br closes a bead only when every box is ticked, so the unticked
	// boxes this export cannot run (live, after, [v]) move word for word into one LIVEREADBACK child. The parent keeps
	// its original acceptance in its description and closes holding only boxes verify ran and ticked. The child lives
	// under the closing bead's own active parent (else the constraint lane's parent) with a `related` link back, so
	// every active bead keeps an edge to another active bead and a REWORK reopen is never held by its readback child.
	const deferred = boxes.filter(b => !b.checked && (b.letter === "v" || b.phase === "live" || b.phase === "after"));
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
	const exitOnly = ran.filter(r => r.outcome === "exit-only").map(r => tag(r));
	const family = input.family ?? "unknown (set --family)";
	const deferredTags = deferred.map(b => tag(b)).join(" ");
	const reason = `verified by ${input.actor} (family: ${family}) on export ${input.exportSha}: ${ran.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}${exitOnly.length ? `; exit-only boxes: ${exitOnly.join(" ")}` : ""}${deferred.length ? `; deferred ${deferredTags} to ${CHILD} (LIVEREADBACK, child of ${homeNote || home}, related to ${input.bead})` : ""}`;
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
	acts.push(["br", "close", input.bead, "--reason", reason, "--transition-comment", `CLOSED ${input.bead} by ${input.actor} (family: ${family})\n${log.join("\n")}`, "--actor", input.actor]);
	if (homeNote) log.push(`LIVEREADBACK child placed under ${homeNote}`);
	const child = deferred.length > 0 ? CHILD : undefined;
	if (input.dryRun) return { ok: true, code: "DRY_RUN", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts, child };
	const done = await executeActs(acts, input.repo, env);
	if (done.failure !== null) return { ok: false, code: "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.concat(done.failure).join("\n"), acts: done.acts, child: done.child ?? child };
	return { ok: true, code: "CLOSED", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts: done.acts, child: done.child };
}

/**
 * Run tracker acts in order. The id a `br create --json` act prints replaces CHILD in every later act, and the
 * returned acts carry that substitution. The first non-zero act stops the run and is named in `failure`.
 */
async function executeActs(acts: string[][], cwd: string, env: Record<string, string>): Promise<{ acts: string[][]; child?: string; failure: string | null }> {
	let child: string | undefined;
	const ranActs: string[][] = [];
	const bind = (a: string[]) => child === undefined ? a : a.map(arg => arg.replaceAll(CHILD, child!));
	for (const act of acts) {
		const argv = bind(act);
		ranActs.push(argv);
		const r = await run(argv, { cwd, deadline_s: 60, env });
		if (r.rc !== 0) return { acts: ranActs.concat(acts.slice(ranActs.length).map(bind)), child, failure: `act failed rc ${r.rc}: ${argv.slice(0, 4).join(" ")}: ${text(r.stderr).slice(0, 200)}` };
		if (argv[1] === "create") {
			let doc: unknown;
			try { doc = JSON.parse(text(r.stdout)); } catch { doc = null; }
			const id = doc !== null && typeof doc === "object" && "id" in doc ? doc.id : undefined;
			if (typeof id !== "string" || id === "") return { acts: ranActs, child, failure: `act failed: br create printed no child id: ${text(r.stdout).slice(0, 200)}` };
			child = id;
		}
	}
	return { acts: ranActs, child, failure: null };
}

/** The fields verify reads from one `br show --json` row, or null when br names no such bead. `related` lists the ids its `related` dependencies point at. */
interface BeadRow { id: string; title: string; description: string; acceptance: string; status: string; assignee: string | null; labels: string[]; parent: string | null; related: string[] }

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
	return { id: field("id") ?? id, title: field("title") ?? "", description: field("description") ?? "", acceptance: field("acceptance_criteria") ?? "", status: field("status") ?? "", assignee: field("assignee"), labels, parent: field("parent"), related };
}

export interface LiveReadbackInput { bead: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; family?: string }

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
	const harnessRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
	const scratch = ownedTmp("verify-live", { bead: input.bead, ...(harnessRoot === undefined ? {} : { root: harnessRoot }) });
	const realBr = resolveRealBr(env.PATH);
	if (realBr === null) return refuse("NOT_IN_REVIEW", "UNJUDGED: no resolvable br on PATH; unmet prerequisite: real br binary");
	const replayEnv = { ...env, TMPDIR: scratch.path, GRADE_WAVE_SCRATCH: scratch.path, PATH: `${installReadonlyBr(scratch.path, realBr)}:${env.PATH ?? "/usr/bin:/bin"}` };
	const replays: BoxReplay[] = [];
	for (const box of toRun) {
		const command = commandOf(box.body)!;
		const expected = expectedOf(box.body);
		const started = Date.now();
		const r = await run(["sh", "-c", command], { cwd: input.repo, deadline_s: 900, env: replayEnv, max_output_bytes: 4 * 1024 * 1024 });
		const out = text(r.stdout) + text(r.stderr);
		const v = judge(expected, r.rc, out);
		const excerpt = v.pass ? "" : childExcerpt(r.rc, r.timed_out, out);
		replays.push({ index: box.index, letter: box.letter, command, expected, outcome: v.outcome, rc: r.rc, pass: v.pass, detail: v.detail + excerpt });
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
		acts.push(["br", "close", child.id, "--reason", `live readback of ${parent.id} by ${input.actor} (family: ${family}) on the installed kit: ${replays.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}`, "--transition-comment", `CLOSED ${child.id} by ${input.actor} (family: ${family})\n${log.join("\n")}`, "--actor", input.actor]);
	}
	const code: VerifyResult["code"] = input.dryRun ? "DRY_RUN" : failed.length > 0 ? "REWORK" : "CLOSED";
	if (input.dryRun) return { ok: failed.length === 0, code, bead: input.bead, export: "installed", replays, log: log.join("\n"), acts };
	const done = await executeActs(acts, input.repo, env);
	if (done.failure !== null) return { ok: false, code: "REWORK", bead: input.bead, export: "installed", replays, log: log.concat(done.failure).join("\n"), acts: done.acts };
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
