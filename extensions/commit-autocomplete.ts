/**
 * commit-autocomplete (AUTOCOMPLETE1, ompkit-fp72.135.3.17; plan section 23.3 primitive 2 and section 26 W4).
 *
 * On a `git commit` the kit already holds every fact the commit-msg chain demands: the seat's live Agent Mail
 * reservation names the bead (`reason=<bead> ...`), blame names the commits a staged change rewrites, and the
 * bead title is in the tracker. Shingo: mistake-proof at the source. This module computes those completions
 * from the Agent Mail store, the index and blame; the guard's `tool_call` hook applies them to the raw command
 * and reports each as `AUTO_COMPLETED:<what>`. What cannot be completed (a staged path no reservation covers,
 * no bead in the reservation reason) is one finding with its remedy; nothing is guessed.
 *
 * Library module: no extension entrypoint; imported by kit-flywheel-guard.ts.
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../src/kitlib/findings.ts";

export interface Completion { what: "bead-trailer" | "fragment" | "supersedes"; detail: string }
export interface AutocompletePlan { command: string; completed: Completion[]; findings: Finding[]; bead: string | null }

export type Exec = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** Parses a `git commit` bash command into {prefix, flags, message, paths}; null when it is not a plain commit. */
export function parseCommit(command: string): { prefix: string; args: string[] } | null {
	// Intended: a single `git commit ...` statement (optionally after `cd X &&` / env assignments), no pipes or
	// further statements, so patching the message is a textual append. Anything else is left alone.
	const m = /^((?:cd\s+\S+\s*&&\s*)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*)git\s+commit\b([^|;&]*)$/.exec(command.trim());
	if (!m) return null;
	return { prefix: m[1] ?? "", args: m[2]!.trim().split(/\s+/).filter(Boolean) };
}

const BEAD_RE = /\b([a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]*[a-z0-9])\b/;

/** Live exclusive reservations of `agent` for `projectKey`: path patterns with the bead named in each reason. */
export function liveReservations(storagePath: string, projectKey: string, agent: string, nowMs: number): { pattern: string; bead: string | null }[] {
	let db: Database | undefined;
	try {
		db = new Database(storagePath, { readonly: true });
		const rows = db.query(`SELECT r.path_pattern AS pattern, r.reason AS reason FROM file_reservations r
			JOIN agents a ON a.id = r.agent_id JOIN projects p ON p.id = r.project_id
			WHERE r.released_ts IS NULL AND r.expires_ts > ?1 AND lower(a.name) = lower(?2) AND p.human_key = ?3`).all(nowMs * 1000, agent, projectKey) as Array<{ pattern: unknown; reason: unknown }>;
		return rows.filter(r => typeof r.pattern === "string").map(r => ({ pattern: r.pattern as string, bead: typeof r.reason === "string" ? (BEAD_RE.exec(r.reason)?.[1] ?? null) : null }));
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

function covers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (!pattern.includes("*")) return path.startsWith(pattern.replace(/\/?$/, "/"));
	const re = new RegExp("^" + pattern.split("**").map(part => part.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
	return re.test(path);
}

/** Commits blamed for every removed line of the staged diff (the stale-worktree check's Supersedes set). */
export async function supersededCommits(exec: Exec, repo: string): Promise<string[]> {
	const diff = await exec(["git", "diff", "--cached", "-U0"], repo);
	if (diff.code !== 0) return [];
	const shas = new Set<string>();
	let file: string | null = null;
	for (const line of diff.stdout.split("\n")) {
		if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
		const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
		if (!m || !file) continue;
		const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
		if (n === 0) continue;
		const blame = await exec(["git", "blame", "-l", "-L", `${start},${start + n - 1}`, "HEAD", "--", file], repo);
		if (blame.code !== 0) continue;
		for (const row of blame.stdout.split("\n")) {
			// `-l` prints the full sha; a boundary (root) commit is marked `^` and its sha is then 39 chars wide.
			const m = /^\^?([0-9a-f]{39,40})\b/.exec(row);
			if (!m) continue;
			const sha = m[1]!.length === 40 ? m[1]! : ((await exec(["git", "rev-parse", m[1]!], repo)).stdout.trim() || m[1]!);
			if (/^[0-9a-f]{40}$/.test(sha)) shas.add(sha);
		}
	}
	return [...shas].sort();
}

export interface PlanInput {
	command: string;
	repo: string;
	agent: string | null;
	projectKey: string;
	storagePath: string | null;
	nowMs: number;
	exec: Exec;
	/** The bead title, for the fragment scaffold; null leaves the scaffold with the subject only. */
	beadTitle?: (bead: string) => string | null;
}

/** The completed command, what was completed, and the findings that block completion. Pure except for the fragment file. */
export async function planAutocomplete(input: PlanInput): Promise<AutocompletePlan | null> {
	const parsed = parseCommit(input.command);
	if (!parsed) return null;
	const findings: Finding[] = [];
	const completed: Completion[] = [];
	const push = (code: string, detail: string, remedy: string, fix: string[] | null = null) => findings.push({ gate: "commit-autocomplete", code, detail, remedy, fix, blocking: true });
	const staged = await input.exec(["git", "diff", "--cached", "--name-only"], input.repo);
	const paths = staged.code === 0 ? staged.stdout.split("\n").filter(Boolean) : [];
	if (paths.length === 0) return { command: input.command, completed, findings, bead: null };
	if (!input.agent) { push("NO_SEAT_IDENTITY", "no AGENT_NAME for this seat", "export AGENT_NAME=<you> so the reservation can be read"); return { command: input.command, completed, findings, bead: null }; }
	if (!input.storagePath) { push("NO_MAIL_STORE", "Agent Mail store not found", "set AGENT_MAIL_STORAGE_ROOT or the config.env root"); return { command: input.command, completed, findings, bead: null }; }
	const holds = liveReservations(input.storagePath, input.projectKey, input.agent, input.nowMs);
	const uncovered = paths.filter(p => !holds.some(h => covers(h.pattern, p)));
	for (const p of uncovered) push("PATH_UNRESERVED", `${p} is staged but no live reservation of ${input.agent} covers it`, "reserve the path first (file_reservation_paths) or unstage it", ["git", "restore", "--staged", "--", p]);
	const beads = [...new Set(holds.filter(h => paths.some(p => covers(h.pattern, p))).map(h => h.bead).filter((b): b is string => b !== null))];
	let bead: string | null = null;
	if (beads.length === 1) bead = beads[0]!;
	else if (beads.length > 1) push("BEAD_AMBIGUOUS", `the covering reservations name ${beads.join(", ")}`, "commit one bead's paths at a time, or pass the trailer yourself");
	else if (uncovered.length === 0) push("BEAD_UNKNOWN", "the covering reservations name no bead in their reason", "reserve with reason=<bead id> or add the Bead: trailer yourself");
	if (findings.length > 0) return { command: input.command, completed, findings, bead };
	// Only `-m` commits are completed (the trailers are appended as `--trailer` flags, so the message words are
	// never parsed); a message file or editor commit is left to the hooks. Presence checks read the raw command.
	if (!/\s-m\s/.test(input.command) && !/\s--message[= ]/.test(input.command)) return { command: input.command, completed, findings, bead };
	const text = input.command;
	let suffix = "";
	if (!/Bead[:=]\s*\S+/.test(text)) { suffix += ` --trailer Bead=${bead}`; completed.push({ what: "bead-trailer", detail: `Bead: ${bead} from reservation reason` }); }
	const fragment = join(input.repo, "changelog.d", `${bead!.replace(/^ompkit-/, "")}.md`);
	if (existsSync(join(input.repo, "changelog.d")) && !existsSync(fragment) && !paths.some(p => p.startsWith("changelog.d/"))) {
		const subject = (/-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text)?.slice(1).find(Boolean) ?? "change").replace(/\s*\[(test|live|pending|selftest)\]\s*$/, "");
		const title = input.beadTitle?.(bead!) ?? null;
		writeFileSync(fragment, `### Changed\n- ${bead} (${title ? title.split(":")[0] : "bead"}): ${subject}. (scaffolded by AUTOCOMPLETE1; complete before publish)\n`);
		await input.exec(["git", "add", "--", `changelog.d/${bead!.replace(/^ompkit-/, "")}.md`], input.repo);
		completed.push({ what: "fragment", detail: `changelog.d/${bead!.replace(/^ompkit-/, "")}.md scaffolded and staged; a draft, not release notes` });
	}
	const superseded = (await supersededCommits(input.exec, input.repo)).filter(s => !new RegExp(`Supersedes[:=]\\s*${s.slice(0, 7)}`).test(text));
	if (superseded.length > 0) {
		// Supersedes is an attestation (plan 23.2); it is appended only with the shas listed in the result so the
		// committer sees exactly what it attests to, and only when every sha is on HEAD's history (blame on HEAD).
		suffix += superseded.map(s => ` --trailer Supersedes=${s}`).join("");
		completed.push({ what: "supersedes", detail: `Supersedes: ${superseded.map(s => s.slice(0, 10)).join(", ")} (from git blame of the removed lines; verify they are rewrites, not stale reverts)` });
	}
	return { command: suffix ? `${input.command}${suffix}` : input.command, completed, findings, bead };
}
