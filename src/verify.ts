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
/** Phases the verifier understands. Anything else in a tag is unsupported, not a box to skip. */
export const KNOWN_PHASES: Record<string, true> = { build: true, landed: true, live: true, after: true };

/** One acceptance box; `line` is the trimmed source line, so a lint can name it and tell a new box from an unchanged one. */
export interface Box { index: number; letter: string | null; checked: boolean; phase: string | null; body: string; line: string }
export interface BoxReplay { index: number; letter: string | null; command: string | null; expected: string | null; outcome: "exit-only" | "named"; rc: number | null; pass: boolean | null; detail: string }
export interface VerifyResult {
	ok: boolean;
	code: "CLOSED" | "REWORK" | "NON_AUTHOR_REQUIRED" | "ACCEPTANCE_NOT_REPLAYABLE" | "NOT_IN_REVIEW" | "EXPORT_FAILED" | "DRY_RUN" | "PENDING";
	bead: string;
	export: string;
	replays: BoxReplay[];
	log: string;
	acts: string[][];
}

export function parseBoxes(acceptance: string): Box[] {
	const out: Box[] = [];
	for (const raw of acceptance.split("\n")) {
		const line = raw.trim();
		const head = /^- \[([ xX])\] +(.+)$/.exec(line);
		if (!head) continue;
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
		out.push({ index: out.length + 1, letter, checked: head[1] !== " ", phase, body: rest, line });
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
export function unreplayableReason(box: Box): "unsupported-phase" | "no-command" | null {
	if (box.phase !== null && KNOWN_PHASES[box.phase] !== true) return "unsupported-phase";
	return commandOf(box.body) === null ? "no-command" : null;
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

export interface VerifyInput { bead: string; exportSha: string; repo: string; actor: string; env?: Record<string, string>; dryRun?: boolean; family?: string }

export async function verifyBead(input: VerifyInput): Promise<VerifyResult> {
	const env = { ...process.env, ...(input.env ?? {}) } as Record<string, string>;
	const acts: string[][] = [];
	const log: string[] = [`verify ${input.bead} export ${input.exportSha} actor ${input.actor} ${new Date().toISOString()}`];
	const pre = await preflightBead("close", input.repo, input.bead, { actor: input.actor, env });
	const blocking = pre.findings.filter(f => f.blocking);
	if (blocking.some(f => f.code === "SELF_CLOSE")) return { ok: false, code: "NON_AUTHOR_REQUIRED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`refused: ${input.actor} is the assignee`).join("\n"), acts };
	if (blocking.some(f => f.code === "NOT_IN_REVIEW" || f.code === "UNJUDGED")) return { ok: false, code: "NOT_IN_REVIEW", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(blocking.map(f => `${f.code}: ${f.detail}`)).join("\n"), acts };
	const show = await run(["br", "show", input.bead, "--json"], { cwd: input.repo, deadline_s: 60, env, max_output_bytes: 4 * 1024 * 1024 });
	let acceptance = "";
	try { const doc = JSON.parse(text(show.stdout)); const row = Array.isArray(doc) ? doc[0] : doc; acceptance = typeof row?.acceptance_criteria === "string" ? row.acceptance_criteria : ""; } catch { /* handled below as not replayable */ }
	const boxes = parseBoxes(acceptance);
	const replayable = boxes.filter(b => b.letter !== "v");
	const tag = (b: { letter: string | null; index: number }) => `[${b.letter ?? b.index}]`;
	const bad = replayable.filter(b => unreplayableReason(b) !== null);
	if (replayable.length === 0 || bad.length > 0) {
		log.push(`not replayable: ${bad.length ? bad.map(b => unreplayableReason(b) === "unsupported-phase" ? `${tag(b)} unsupported phase [${b.phase}]` : `${tag(b)} names no command`).join("; ") : "no boxes"}`);
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
	const replayEnv = { ...env, TMPDIR: scratch.path, ...(wantsOwned ? { OWNED_TRACKER_DB: ownedDb } : {}), PATH: `${replayBin}:${env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}` };
	if (wantsOwned) log.push(`owned fixture ${ownedDb} (per-run read-only replay)`);
	const exportDir = join(scratch.path, "export");
	mkdirSync(exportDir, { recursive: true });
	const archive = await run(["sh", "-c", `git -C ${JSON.stringify(input.repo)} archive ${JSON.stringify(input.exportSha)} | tar -x -C ${JSON.stringify(exportDir)}`], { deadline_s: 300, env });
	if (archive.rc !== 0 || !existsSync(join(exportDir, "scripts")) && !existsSync(join(exportDir, "src"))) {
		return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export failed rc ${archive.rc}: ${text(archive.stderr).slice(0, 200)}`).join("\n"), acts };
	}
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
	const pending = replays.filter(r => r.pass === null);
	if (pending.length > 0) {
		return { ok: false, code: "PENDING", bead: input.bead, export: input.exportSha, replays, log: log.concat(`pending: ${pending.map(p => `${tag(p)} ${p.detail}`).join("; ")}`).join("\n"), acts };
	}
	const exitOnly = replays.filter(r => r.outcome === "exit-only").map(r => tag(r));
	const family = input.family ?? "unknown (set --family)";
	const reason = `verified by ${input.actor} (family: ${family}) on export ${input.exportSha}: ${replays.map(r => `${tag(r)} ${r.command} -> ${r.detail}`).join("; ")}${exitOnly.length ? `; exit-only boxes: ${exitOnly.join(" ")}` : ""}`;
	acts.push(["br", "update", input.bead, "--check-acceptance", replays.filter(r => r.pass === true).map(r => String(r.index)).join(","), "--actor", input.actor]);
	acts.push(["br", "gate", "report", input.bead, "--gate", "min_reviewers", "--provider", `reviewer:${input.actor}`, "--status", "pass", "--to", "closed", "--actor", input.actor]);
	acts.push(["br", "close", input.bead, "--reason", reason, "--transition-comment", `CLOSED ${input.bead} by ${input.actor} (family: ${family})\n${log.join("\n")}`, "--actor", input.actor]);
	if (!input.dryRun) {
		for (const a of acts) {
			const r = await run(a, { cwd: input.repo, deadline_s: 60, env });
			if (r.rc !== 0) return { ok: false, code: "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.concat(`act failed rc ${r.rc}: ${a.slice(0, 4).join(" ")}: ${text(r.stderr).slice(0, 200)}`).join("\n"), acts };
		}
	}
	return { ok: true, code: input.dryRun ? "DRY_RUN" : "CLOSED", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
}

export function verifyProject(flag: unknown): string { return resolve(typeof flag === "string" && flag.trim() ? flag : process.cwd()); }
