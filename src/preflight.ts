/**
 * `omp-kit preflight <act> [<target>] --json` (GATEDIAG1, ompkit-fp72.135.3.16; plan section 23.3): run every
 * check an act will face and print every finding with its remedy and fix in one envelope, changing nothing.
 *
 * commit: the pre-commit members judge the index as staged (they already read GIT_INDEX_FILE / --cached), and the
 * commit-msg members judge a message file (`--message FILE`, default the repo's prepared COMMIT_EDITMSG or an
 * empty message, which is itself a finding). Each staged script with its own `--selftest` is run (the gate that was
 * missing on 2026-10-25 when tracker_snapshot.py reached origin with a NameError). Findings are bound to the staged
 * tree id so a later commit can tell whether the index moved.
 *
 * claim | in-review | close: the tracker's own predicates for the transition, read from `br show --json`; bound to
 * the bead's updated_at.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { envelope, parseFindingLines, unjudged, type Envelope, type Finding, type PreflightAct } from "./kitlib/findings.ts";
import { run } from "./kitlib/run.ts";

const MEMBER_DEADLINE_S = 120;
const SELFTEST_DEADLINE_S = 180;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function git(repo: string, args: string[]): Promise<{ rc: number | null; out: string; err: string }> {
	const r = await run(["git", "-C", repo, ...args], { deadline_s: 60, max_output_bytes: 4 * 1024 * 1024 });
	return { rc: r.rc, out: text(r.stdout).trim(), err: text(r.stderr).trim() };
}

function members(hooksDir: string, kind: string): string[] {
	const dir = join(hooksDir, "hooks.d", kind);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(name => /^[0-9][0-9]-/.test(name)).sort().map(name => join(dir, name))
		.filter(path => { try { return (statSync(path).mode & 0o111) !== 0; } catch { return false; } });
}

/** Match executable shebang dispatch; staged scripts need not have their executable bit set yet. */
function scriptCommand(path: string, fallback: string): string[] {
	const body = readFileSync(path, "utf8");
	if (!body.startsWith("#!")) return [fallback, path];
	if ((statSync(path).mode & 0o111) !== 0) return [path];
	const shebang = body.slice(2).split("\n", 1)[0]!.trim();
	let end = 0;
	while (end < shebang.length && shebang[end] !== " " && shebang[end] !== "\t") end++;
	const interpreter = shebang.slice(0, end);
	const argument = shebang.slice(end).trim();
	return argument ? [interpreter, argument, path] : [interpreter, path];
}

/** One member, run to completion: its FINDING lines, or one MEMBER_REFUSED/UNJUDGED finding when it exits non-zero without any. */
async function judge(member: string, args: string[], cwd: string, env: Record<string, string>): Promise<Finding[]> {
	const r = await run([...scriptCommand(member, "sh"), ...args], { deadline_s: MEMBER_DEADLINE_S, cwd, env, max_output_bytes: 2 * 1024 * 1024 });
	const found = parseFindingLines(text(r.stdout));
	if (found.length > 0 || r.rc === 0) return found;
	const err = text(r.stderr).split("\n").map(l => l.trim()).filter(Boolean);
	const name = basename(member);
	if (r.timed_out) return [unjudged(name, r.rc, `exceeded ${MEMBER_DEADLINE_S}s`)];
	const line = err.find(l => /REFUSE|refused|FAIL|error/.test(l)) ?? err[0] ?? "";
	return [{ gate: name, code: "MEMBER_REFUSED", detail: line || `exit ${r.rc} with no message`, remedy: "read the member's output; convert it to FINDING lines to get every defect at once", fix: null, blocking: true }];
}

/** Every staged script that answers `--selftest` is run; a failing one is a finding naming it (the missing gate). */
async function stagedSelftests(repo: string, staged: string[], env: Record<string, string>): Promise<Finding[]> {
	const out: Finding[] = [];
	for (const path of staged) {
		if (!/\.(py|sh)$/.test(path)) continue;
		const full = join(repo, path);
		let body: string;
		try { body = readFileSync(full, "utf8"); } catch { continue; }
		if (!body.includes("--selftest")) continue;
		const argv = [...scriptCommand(full, path.endsWith(".py") ? "python3" : "sh"), "--selftest"];
		const r = await run(argv, { deadline_s: SELFTEST_DEADLINE_S, cwd: repo, env, max_output_bytes: 1024 * 1024 });
		if (r.rc === 0) continue;
		const tail = (text(r.stderr) + text(r.stdout)).trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
		out.push({ gate: "staged-selftest", code: r.timed_out ? "SELFTEST_TIMEOUT" : "SELFTEST_FAILED", detail: `${path}: ${tail || `exit ${r.rc}`}`,
			remedy: `run ${argv.join(" ")} and fix it before committing`, fix: argv, blocking: true });
	}
	return out;
}

export async function preflightCommit(repo: string, options: { message?: string; env?: Record<string, string> } = {}): Promise<Envelope> {
	const env = { ...process.env, ...(options.env ?? {}) } as Record<string, string>;
	const tree = await git(repo, ["write-tree"]);
	if (tree.rc !== 0) return envelope("commit", null, "unknown", [unjudged("git", tree.rc, tree.err || "write-tree failed")]);
	const snapshot = `tree:${tree.out}`;
	const hooks = await git(repo, ["rev-parse", "--git-path", "hooks"]);
	const hooksDir = resolve(repo, hooks.out);
	const stagedOut = await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
	const staged = stagedOut.out ? stagedOut.out.split("\n") : [];
	const findings: Finding[] = [];
	if (staged.length === 0) findings.push({ gate: "preflight", code: "NOTHING_STAGED", detail: "the index has no staged change", remedy: "stage the paths you hold, then preflight again", fix: null, blocking: true });
	for (const member of members(hooksDir, "pre-commit")) findings.push(...await judge(member, [], repo, env));
	let message = options.message;
	if (message === undefined) {
		const prepared = join(resolve(repo, (await git(repo, ["rev-parse", "--git-dir"])).out), "COMMIT_EDITMSG");
		message = existsSync(prepared) ? prepared : undefined;
	}
	if (message === undefined) {
		findings.push({ gate: "preflight", code: "NO_MESSAGE", detail: "no commit message to judge (pass --message FILE)", remedy: "write the message file, then preflight commit --message FILE", fix: null, blocking: true });
	} else {
		for (const member of members(hooksDir, "commit-msg")) findings.push(...await judge(member, [message], repo, env));
	}
	findings.push(...await stagedSelftests(repo, staged, env));
	return envelope("commit", null, snapshot, findings);
}

interface BeadView { id: string; status: string; assignee: string | null; updated_at: string; acceptance: { index: number; checked: boolean; text: string }[]; labels: string[] }

async function readBead(repo: string, id: string, env: Record<string, string>): Promise<BeadView | Finding> {
	const r = await run(["br", "show", id, "--json"], { deadline_s: 60, cwd: repo, env, max_output_bytes: 4 * 1024 * 1024 });
	if (r.rc !== 0) return unjudged("br", r.rc, text(r.stderr).trim().split("\n")[0] ?? "br show failed");
	let doc: unknown;
	try { doc = JSON.parse(text(r.stdout)); } catch { return unjudged("br", r.rc, "br show printed no JSON"); }
	const row = Array.isArray(doc) ? doc[0] : doc;
	if (!row || typeof row !== "object") return unjudged("br", r.rc, "br show printed no bead");
	const b = row as Record<string, unknown>;
	const acText = typeof b.acceptance_criteria === "string" ? b.acceptance_criteria : "";
	const acceptance = acText.split("\n").filter(l => /^- \[[ xX]\]/.test(l)).map((l, i) => ({ index: i + 1, checked: /^- \[[xX]\]/.test(l), text: l }));
	return { id: String(b.id), status: String(b.status), assignee: typeof b.assignee === "string" && b.assignee ? b.assignee : null,
		updated_at: String(b.updated_at ?? ""), acceptance, labels: Array.isArray(b.labels) ? b.labels.map(String) : [] };
}

const PHASE_TAG = /\[(build|landed|live)\]/;

/** The tracker transition predicates, every one judged, none applied. */
export async function preflightBead(act: Exclude<PreflightAct, "commit" | "publish" | "scratch-release">, repo: string, id: string, options: { actor?: string; env?: Record<string, string> } = {}): Promise<Envelope> {
	const env = { ...process.env, ...(options.env ?? {}) } as Record<string, string>;
	const bead = await readBead(repo, id, env);
	if ("gate" in bead) return envelope(act, id, "unknown", [bead]);
	const snapshot = `bead:${bead.updated_at || "no-updated-at"}`;
	const f: Finding[] = [];
	const push = (code: string, detail: string, remedy: string, fix: string[] | null = null) => f.push({ gate: "br-policy", code, detail, remedy, fix, blocking: true });
	const actor = options.actor ?? env.AGENT_NAME ?? null;
	const gated = bead.labels.filter(l => ["human-gate", "owner-decision", "kind:process"].includes(l));
	if (act === "claim") {
		if (bead.status !== "open") push("NOT_OPEN", `${id} is ${bead.status}`, "claim only an open bead");
		if (bead.assignee) push("ASSIGNED", `${id} is assigned to ${bead.assignee}`, "pick another bead or ask the holder");
		if (gated.length) push("GATED_LABEL", `${id} carries ${gated.join(", ")}`, "route it; never claim a human-gate, owner-decision or kind:process bead");
		if (actor) {
			const mine = await run(["br", "list", "--assignee", actor, "--status", "in_progress", "--json"], { deadline_s: 60, cwd: repo, env, max_output_bytes: 4 * 1024 * 1024 });
			let n = 0;
			try { const rows = JSON.parse(text(mine.stdout)); n = Array.isArray(rows) ? rows.length : 0; } catch { /* unreadable list: not a finding about this bead */ }
			if (n > 0) push("SEAT_BUSY", `${actor} already holds ${n} in_progress bead(s)`, "finish or release it first (one bead in progress per seat)");
		}
	}
	if (act === "in-review") {
		if (bead.status !== "in_progress") push("NOT_IN_PROGRESS", `${id} is ${bead.status}`, "only an in_progress bead moves to in_review");
		if (bead.acceptance.length === 0) push("NO_ACCEPTANCE", `${id} has no acceptance checklist`, "write `- [ ] [a] [landed] ...` boxes citing replayable commands");
		const untagged = bead.acceptance.filter(a => !PHASE_TAG.test(a.text));
		if (untagged.length) push("AC_PHASE_MISSING", `${untagged.length} box(es) lack a [build]|[landed]|[live] tag: ${untagged.map(a => a.index).join(",")}`, "add the phase tag to each box");
		push("TRANSITION_COMMENT", "in_review requires --transition-comment", "pass --transition-comment naming export sha and the exact commands", ["br", "update", id, "--status", "in_review", "--transition-comment", "<DONE line>"]);
	}
	if (act === "close") {
		if (bead.status !== "in_review") push("NOT_IN_REVIEW", `${id} is ${bead.status}`, "a bead closes from in_review only");
		if (actor && bead.assignee && bead.assignee === actor) push("SELF_CLOSE", `${id} is assigned to ${actor}`, "a non-author closes; spawn a background verifier and hand the verdict to a peer");
		const unticked = bead.acceptance.filter(a => !a.checked);
		if (unticked.length) push("AC_UNTICKED", `${unticked.length} box(es) unticked: ${unticked.map(a => a.index).join(",")}`, "replay each, then tick with --check-acceptance", ["br", "update", id, "--check-acceptance", unticked.map(a => a.index).join(",")]);
		push("REVIEWER_GATE", "min_reviewers gate needs a pass report", "report the gate under your identity, then close", ["br", "gate", "report", id, "--gate", "min_reviewers", "--provider", `reviewer:${actor ?? "<you>"}`, "--status", "pass", "--to", "closed"]);
		push("TRANSITION_COMMENT", "close requires --reason with evidence and --transition-comment", "cite the commands you re-ran and their results, commit shas, verifier family", ["br", "close", id, "--reason", "<command -> result; commit sha>", "--transition-comment", "<same>"]);
	}
	// The last two for in-review/close are informational requirements of the act (always present), not defects.
	for (const x of f) if (x.code === "TRANSITION_COMMENT" || x.code === "REVIEWER_GATE") x.blocking = false;
	return envelope(act, id, snapshot, f);
}
