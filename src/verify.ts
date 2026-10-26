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
 * Box grammar: `- [ ] [a] [landed] \`<command>\` -> <expected>` or `... ; expect: <expected>` or `...; planted: ...`.
 * `<expected>` forms: `rc 0` (exit code), `prints <text>` / `contains <text>` (stdout+stderr substring),
 * `N pass 0 fail` (bun/pytest summary), `exit N`. A box with only a command and no expected form is judged
 * by `rc 0` AND is flagged `outcome: exit-only` in the log, so the closer sees what was proven.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { preflightBead } from "./preflight.ts";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const BOX = /^- \[([ xX])\] \[([a-z])\] (?:\[(build|landed|live)\] )?(.*)$/;
const CMD = /`([^`]+)`/;

export interface BoxReplay { index: number; letter: string; command: string | null; expected: string | null; outcome: "exit-only" | "named"; rc: number | null; pass: boolean | null; detail: string }
export interface VerifyResult {
	ok: boolean;
	code: "CLOSED" | "REWORK" | "NON_AUTHOR_REQUIRED" | "ACCEPTANCE_NOT_REPLAYABLE" | "NOT_IN_REVIEW" | "EXPORT_FAILED" | "DRY_RUN";
	bead: string;
	export: string;
	replays: BoxReplay[];
	log: string;
	acts: string[][];
}

export function parseBoxes(acceptance: string): { index: number; letter: string; checked: boolean; phase: string | null; body: string }[] {
	const out: { index: number; letter: string; checked: boolean; phase: string | null; body: string }[] = [];
	for (const line of acceptance.split("\n")) {
		const m = BOX.exec(line.trim());
		if (!m) continue;
		out.push({ index: out.length + 1, letter: m[2]!, checked: m[1] !== " ", phase: m[3] ?? null, body: m[4]! });
	}
	return out;
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
	const missing = replayable.filter(b => !CMD.test(b.body));
	if (replayable.length === 0 || missing.length > 0) {
		log.push(`not replayable: ${missing.length ? missing.map(b => `[${b.letter}] names no command`).join("; ") : "no boxes"}`);
		return { ok: false, code: "ACCEPTANCE_NOT_REPLAYABLE", bead: input.bead, export: input.exportSha, replays: [], log: log.join("\n"), acts: [["br", "update", input.bead, "--status", "open", "--add-label", "needs-intake"]] };
	}
	const scratch = ownedTmp("verify-" + input.bead.replace(/[^a-z0-9.-]/gi, "_"), { bead: input.bead });
	const exportDir = join(scratch.path, "export");
	mkdirSync(exportDir, { recursive: true });
	const archive = await run(["sh", "-c", `git -C ${JSON.stringify(input.repo)} archive ${JSON.stringify(input.exportSha)} | tar -x -C ${JSON.stringify(exportDir)}`], { deadline_s: 300, env });
	if (archive.rc !== 0 || !existsSync(join(exportDir, "scripts")) && !existsSync(join(exportDir, "src"))) {
		return { ok: false, code: "EXPORT_FAILED", bead: input.bead, export: input.exportSha, replays: [], log: log.concat(`export failed rc ${archive.rc}: ${text(archive.stderr).slice(0, 200)}`).join("\n"), acts };
	}
	log.push(`exported ${input.exportSha} to ${exportDir}`);
	const replays: BoxReplay[] = [];
	for (const box of replayable) {
		const command = CMD.exec(box.body)![1]!;
		const expected = expectedOf(box.body);
		const started = Date.now();
		const r = await run(["sh", "-c", command], { cwd: exportDir, deadline_s: 900, env: { ...env, TMPDIR: scratch.path }, max_output_bytes: 4 * 1024 * 1024 });
		const out = text(r.stdout) + text(r.stderr);
		const v = judge(expected, r.rc, out);
		replays.push({ index: box.index, letter: box.letter, command, expected, outcome: v.outcome, rc: r.rc, pass: v.pass, detail: v.detail });
		log.push(`[${box.letter}] ${v.pass ? "PASS" : "FAIL"} ${command} -> ${v.detail} (${Date.now() - started} ms)${r.timed_out ? " TIMEOUT" : ""}`);
	}
	const failed = replays.filter(r => !r.pass);
	if (failed.length > 0) {
		const comment = `REWORK ${input.bead}: ${failed.map(f => `[${f.letter}] ${f.detail}`).join("; ")}\n${log.join("\n")}`;
		acts.push(["br", "update", input.bead, "--status", "rework", "--transition-comment", comment]);
		if (!input.dryRun) for (const a of acts) await run(a, { cwd: input.repo, deadline_s: 60, env });
		return { ok: false, code: input.dryRun ? "DRY_RUN" : "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
	}
	const exitOnly = replays.filter(r => r.outcome === "exit-only").map(r => `[${r.letter}]`);
	const family = input.family ?? "unknown (set --family)";
	const reason = `verified by ${input.actor} (family: ${family}) on export ${input.exportSha}: ${replays.map(r => `[${r.letter}] ${r.command} -> ${r.detail}`).join("; ")}${exitOnly.length ? `; exit-only boxes: ${exitOnly.join(" ")}` : ""}`;
	acts.push(["br", "update", input.bead, "--check-acceptance", replayable.map(b => String(b.index)).join(",")]);
	acts.push(["br", "gate", "report", input.bead, "--gate", "min_reviewers", "--provider", `reviewer:${input.actor}`, "--status", "pass", "--to", "closed"]);
	acts.push(["br", "close", input.bead, "--reason", reason, "--transition-comment", `CLOSED ${input.bead} by ${input.actor} (family: ${family})\n${log.join("\n")}`]);
	if (!input.dryRun) {
		for (const a of acts) {
			const r = await run(a, { cwd: input.repo, deadline_s: 60, env });
			if (r.rc !== 0) return { ok: false, code: "REWORK", bead: input.bead, export: input.exportSha, replays, log: log.concat(`act failed rc ${r.rc}: ${a.slice(0, 4).join(" ")}: ${text(r.stderr).slice(0, 200)}`).join("\n"), acts };
		}
	}
	return { ok: true, code: input.dryRun ? "DRY_RUN" : "CLOSED", bead: input.bead, export: input.exportSha, replays, log: log.join("\n"), acts };
}

export function verifyProject(flag: unknown): string { return resolve(typeof flag === "string" && flag.trim() ? flag : process.cwd()); }
