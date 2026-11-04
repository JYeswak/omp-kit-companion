import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { releaseRoot } from "./paths.ts";

export type BriefExec = (command: string, args: string[], options: { cwd: string; timeout: number; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;
const execute: BriefExec = async (command, args, options) => {
	const result = await run([command, ...args], { cwd: options.cwd, deadline_s: options.timeout / 1000, env: options.env, max_output_bytes: 4 * 1024 * 1024 });
	if (result.timed_out || result.truncated || result.total_truncated) throw new Error("brief: observation incomplete");
	return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
};
export interface BriefRule { member: string; refuses: string; compliant: string }
export interface BriefMember { member: string; path: string; sha256: string }
export interface BriefContract { repo: string; installed: boolean; digest: string; marker: string; rules: BriefRule[]; members: BriefMember[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Vocabulary is attached only to observed members, never to a repository name. */
function memberRules(member: string, source: string): BriefRule[] {
	const rules: BriefRule[] = [];
	const add = (refuses: string, compliant: string) => rules.push({ member, refuses, compliant });
	if (member.includes("kitlib") && !member.includes("reversal")) {
		add("hand-rolled process spawn", "TS product: run()/runSync() from src/kitlib/run.ts; tests: runFixture/runFixtureAsync from tests/cli/fixture-process.ts; Python: kitlib_run.run; shell: kitlib_run");
		add("unsafe signal targets", "signal through safePid/safe_pid/kitlib_signal with pid > 1");
		add("schema-compat: extending an installed schema-1 baseline or increasing its allowance", "preserve installed data schemas; new independently validated data uses a separate file; allowances only shrink");
	} else if (member.includes("tempsafe")) add("raw temporary directories", "TS: ownedTmp; Python: owned_tmp; shell: source scripts/kitlib-tmp.sh then kitlib_tmp VAR label, never in command substitution");
	else if (member.includes("wallclock")) add("literal test fixture deadlines and unmeasured timing assertions", "use fixtureDeadlineS() from tests/cli/fixture-process.ts; measured product bounds name their p99 and headroom");
	else if (member.includes("br-init")) add("unparseable tracker shell including heredocs inside command substitution", "use literal argv and description/acceptance files rather than a heredoc inside $(...)");
	else if (member.includes("stale-worktree")) add("stale or foreign-bead landed-line deletion", "review each affected hunk and its landed commit/bead; restore unintended deletions; only an author-decided replacement may declare Supersedes (never automatic)");
	else if (member.includes("gap-mention")) add("GAP_UNFILED: an unfiled gap in prose", "name the owning bead in each sentence or explicitly explain Gap-Bead: none (<reason>)");
	else if (member.includes("pysafe")) add("unbounded Python reads/waits or dynamic shell strings", "use bounded kitlib process/file primitives and argv, not variable-built bash -c");
	else if (member.includes("fresh-gate") || member.endsWith("/fresh-gate.sh")) {
		if (source.includes("live coverage")) add("changed TTSR rules without live scenario coverage", "add fire plus quiet corpus rows and fire/near-miss tests/live/scenarios.json scenarios; update README rule count");
		add("nonportable tests", "tests run in an exported tree without source git history or private HOME files; set TMPDIR inside the export's var/agent-tmp");
	}
	if (!rules.length) {
		const header = source.split("\n").slice(0, 12).filter(line => line.startsWith("#") && !line.startsWith("#!")).map(line => line.slice(1).trim()).join(" ").slice(0, 600);
		const { refusals, remedies } = memberRemedies(source);
		add(refusals.join("; ").slice(0, 600) || header || "violations judged by this executable member", remedies.join("; ").slice(0, 600) || `${GENERIC_COMPLY} ${member} before changing its governed surface`);
	}
	return rules;
}

export const GENERIC_COMPLY = "read and satisfy";
const tidy = (text: string) => text.replace(/\\n|%[sd]|\{[^}]*\}/g, " ").replace(/\s+/g, " ").replace(/[\s;:,.(]+$/, "").trim();
/** BRIEFSTABLE1: the member's own refusal and remedy strings, so Comply names a compliant form instead of "read the member". */
export function memberRemedies(source: string): { refusals: string[]; remedies: string[] } {
	const refusals = new Set<string>();
	const remedies = new Set<string>();
	for (const match of source.matchAll(/\b(?:Fix|Comply|[Rr]emedy)\s*:\s*([^"'`\n]{8,300})/g)) remedies.add(tidy(match[1]!));
	for (const match of source.matchAll(/REFUSED:\s*([^"'`\n]{8,300})/g)) {
		const text = match[1]!;
		const clause = text.match(/\((?:use|run|rerun)\s+([^)]{4,240})\)|[;,]\s*((?:use|run|rerun|reinstall|set|name|add|remove|restore)\s[^;]{4,240})/i);
		const head = tidy(clause ? text.slice(0, clause.index) : text);
		if (head.length >= 8) refusals.add(head);
		if (clause) remedies.add(tidy(clause[1] ? `use ${clause[1]}` : clause[2]!));
	}
	return { refusals: [...refusals].filter(Boolean).slice(0, 6), remedies: [...remedies].filter(text => text.length >= 4).slice(0, 6) };
}

/** Read the hook location Git actually resolves (including core.hooksPath), plus source staged checks. */
export async function briefContract(repoPath: string, exec: BriefExec = execute): Promise<BriefContract> {
	const cwd = realpathSync(resolve(repoPath));
	const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
	if (top.code !== 0) throw new Error(`brief: not a repository: ${cwd}`);
	const repo = realpathSync(top.stdout.trim());
	const found = await exec("git", ["rev-parse", "--git-path", "hooks"], { cwd: repo, timeout: 3000 });
	if (found.code !== 0) throw new Error("brief: cannot resolve installed hooks");
	const hooks = resolve(repo, found.stdout.trim());
	const members: BriefMember[] = [];
	const rules: BriefRule[] = [];
	let installed = false;
	const visited = new Set<string>();
	// BRIEFSTABLE1: source members are read from HEAD, never the working tree, so in-flight edits by peers cannot move the digest.
	const listed = await exec("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "scripts"], { cwd: repo, timeout: 3000 });
	const committed = new Set(listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : []);
	const readHead = async (path: string): Promise<string | undefined> => {
		const rel = relative(repo, path);
		if (!committed.has(rel)) return undefined;
		const shown = await exec("git", ["show", `HEAD:${rel}`], { cwd: repo, timeout: 3000 });
		if (shown.code !== 0) throw new Error(`brief: cannot read HEAD:${rel}`);
		return shown.stdout;
	};
	const readInstalled = async (path: string) => existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
	const fingerprintHelpers = async (path: string, source: string, read: (path: string) => Promise<string | undefined>): Promise<void> => {
		for (const match of source.matchAll(/\b([A-Za-z0-9_-]+\.(?:py|ts|sh|json))\b/g)) {
			const helper = join(dirname(path), match[1]!);
			if (visited.has(helper)) continue;
			const body = await read(helper);
			if (body === undefined) continue;
			if (visited.size >= 256) throw new Error("brief: helper closure exceeds 256 files");
			visited.add(helper);
			members.push({ member: `helper:${relative(repo, helper)}`, path: helper, sha256: hash(body) });
			await fingerprintHelpers(helper, body, read);
		}
	};
	const inspect = async (path: string, member: string, read: (path: string) => Promise<string | undefined>) => {
		const source = await read(path);
		if (source === undefined) return;
		members.push({ member, path, sha256: hash(source) });
		visited.add(path);
		await fingerprintHelpers(path, source, read);
		rules.push(...memberRules(member, source));
	};
	for (const kind of ["pre-commit", "commit-msg", "pre-push"]) {
		const runner = join(hooks, kind);
		if (existsSync(runner) && statSync(runner).isFile() && (statSync(runner).mode & 0o111)) {
			installed = true;
			await inspect(runner, kind, readInstalled);
		}
		const chain = join(hooks, "hooks.d", kind);
		if (!existsSync(chain)) continue;
		for (const name of readdirSync(chain).filter(name => /^\d\d-/.test(name)).sort()) {
			const path = join(chain, name);
			if (!statSync(path).isFile() || !(statSync(path).mode & 0o111)) continue;
			installed = true;
			await inspect(path, `${kind}/${name}`, readInstalled);
		}
	}
	for (const rel of [...committed].filter(rel => /^scripts\/(?:check-staged-.*\.sh|fresh-gate\.sh)$/.test(rel)).sort()) await inspect(join(repo, rel), `source:${rel}`, readHead);
	rules.push(
		{ member: "process:EXPORTINDEX1", refuses: "writes escaping an exported test tree", compliant: "exports are read-only source inputs; fixture repositories need their own git init and GIT_CEILING_DIRECTORIES so git never discovers the parent checkout" },
		{ member: "process:commit-notes", refuses: "a user-visible change without its own release note", compliant: "write changelog.d/<bead-without-ompkit-prefix>.md, user-facing '- ' bullets; update README's command reference for CLI changes" },
		{ member: "process:BRIEFCONTRACT1", refuses: "DONE without clean changed-path preflight evidence", compliant: "before DONE run sh scripts/commit-preflight.sh --files <every changed path> --tests <changed test files>; report the exact command and its commit-preflight: ... 0 refused/unjudged ...; N export test file(s) run output" },
	);
	const digest = hash(JSON.stringify({ repo, members, rules }));
	return { repo, installed, digest, marker: `omp-kit-brief: ${repo} ${digest}`, rules, members };
}

export interface BriefCandidate { path: string; sha: string; bead: string; line: number; hunk: string; review: string }
/** Reuse the stale-worktree judge on a private index/object store, never change the caller's index or refs. */
export async function briefCandidates(contract: BriefContract, paths: readonly string[], exec: BriefExec = execute): Promise<BriefCandidate[]> {
	if (!paths.length) return [];
	for (const path of paths) if (!path || isAbsolute(path) || relative(contract.repo, resolve(contract.repo, path)).startsWith("..") || /[\0\t\r\n]/.test(path)) throw new Error(`brief: paths must be repository-relative: ${path}`);
	const allocation = ownedTmp("brief-review");
	const env = { ...process.env, GIT_INDEX_FILE: join(allocation.path, "index"), GIT_OBJECT_DIRECTORY: join(allocation.path, "objects") } as Record<string, string>;
	mkdirSync(env.GIT_OBJECT_DIRECTORY!);
	const git = async (args: string[], privateEnv = env) => {
		const result = await exec("git", args, { cwd: contract.repo, timeout: 30_000, env: privateEnv });
		if (result.code !== 0) throw new Error(`brief: git ${args[0]} failed: ${result.stderr}`);
		return result.stdout;
	};
	try {
		const objects = (await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], process.env as Record<string, string>)).trim();
		env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(objects) + (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES ? `:${process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES}` : "");
		await git(["read-tree", "HEAD"]);
		await git(["--literal-pathspecs", "add", "-A", "--", ...paths]);
		const root = Bun.main.endsWith(".ts") ? resolve(dirname(fileURLToPath(import.meta.url)), "..") : releaseRoot(process.execPath);
		const checker = join(root, "scripts", "check-stale-worktree.sh");
		const judged = await exec("sh", [checker, "--review"], { cwd: contract.repo, timeout: 120_000, env });
		if (judged.code !== 0 && judged.code !== 1) throw new Error(`brief: stale-worktree review unavailable: ${judged.stderr}`);
		if (judged.code === 1 && !judged.stdout.includes("REVIEW_CANDIDATE\t")) throw new Error(`brief: stale-worktree review failed: ${judged.stderr}`);
		const candidates: BriefCandidate[] = [];
		for (const row of judged.stdout.split("\n")) {
			if (!row.startsWith("REVIEW_CANDIDATE\t")) continue;
			const [, path, sha, bead, line] = row.split("\t");
			if (!path || !sha || !line) throw new Error("brief: malformed stale-worktree candidate");
			const diff = await git(["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", path]);
			const hunks = diff.split(/(?=^@@ )/m).filter(hunk => {
				const range = /^@@ -(\d+)(?:,(\d+))?/.exec(hunk);
				return range && Number(line) >= Number(range[1]) && Number(line) < Number(range[1]) + Number(range[2] ?? 1);
			});
			candidates.push({ path, sha, bead: bead || "(no bead)", line: Number(line), hunk: hunks.join(""), review: `review: would revert ${sha} ${bead || "(no bead)"}` });
		}
		return candidates;
	} finally { allocation.cleanup(); }
}

/** PRIORSPAWN1: the brief contract teaches the prior-art step the spawn guard enforces. */
export const BRIEF_PRIOR_ART_STEP = "[prior-art] Refuses: a build task naming a bead with no prior-art comment (PRIOR_ART_SPAWN_REFUSED). Comply: br comment add <id> \"prior=<repo path:line> did=<...> applied=<...>\" before spawning; a verification, diagnosis or replay brief starts with `no-edit: verify` or `no-edit: diagnose`.";

export function renderBrief(contract: BriefContract, candidates: readonly BriefCandidate[] = []): string {
	return [`Gate contract: ${contract.repo}`, ...contract.rules.map(rule => `[${rule.member}] Refuses: ${rule.refuses}. Comply: ${rule.compliant}.`),
		BRIEF_PRIOR_ART_STEP,
		...candidates.map(row => `${row.review} ${row.path}:${row.line}\n${row.hunk}`), contract.marker].join("\n");
}

/** Only explicitly read-only assignments bypass the build contract; an editing prohibition alone is not a mode. */
export function isBuildBriefTask(task: Record<string, unknown>): boolean {
	const selector = typeof task.agent === "string" ? task.agent : "";
	const body = typeof task.task === "string" ? task.task : "";
	if (["reviewer", "security-reviewer", "seance", "zeststream-planner", "zeststream-reviewer"].includes(selector)) return false;
	if (/^\s*(?:#\s*)?(?:read-only|analysis-only)\b/im.test(body)) return false;
	// PRIORSPAWN1: an explicit verification/diagnosis/replay marker declares the task edits nothing.
	if (/^\s*(?:#\s*)?no-edit:\s*(?:verify|diagnose|replay)\b/im.test(body)) return false;
	// BRIEFSTABLE1: a task that declares it changes nothing is not a build task.
	if (/^\s*(?:#+\s*)?Change\s*(?::\s*|\n\s*)(?:None|N\/A|no changes?)\b/im.test(body)) return false;
	return !(/^\s*(?:analy[sz]e|analysis|investigate|review|inspect)\b/i.test(body)
		&& !/\b(?:implement|modify|edit|write|fix|refactor|remove|add|create|update)\b/i.test(body));
}

/** PRIORSPAWN1: a build brief edits files — it has a Change section or reserves paths. */
export function briefEditsFiles(task: Record<string, unknown>, context = ""): boolean {
	if (!isBuildBriefTask(task)) return false;
	const text = `${context}\n${typeof task.task === "string" ? task.task : ""}`;
	return /^[ \t]*#+[ \t]*Change\b/im.test(text) || /\breserved?\b[^\n]*\bfor you\b|\breserv(?:e|es|ed|ing)[ \t]+(?:these[ \t]+)?paths?\b/i.test(text);
}

/** Repositories a brief targets: explicit repo labels, absolute paths' owning repos, else the session cwd. */
export function briefTargets(text: string, cwd: string): string[] {
	const targets = [...text.matchAll(/(?:--repo\s+|\b(?:repo|repository)\s*[:=]\s*)["`']?([^\s"`'<>]+)/gi)].map(match => match[1]!);
	// Absolute source paths also target their owning repo, even without a
	// "Repo:" label; no shell evaluation or dependence on the session cwd.
	for (const match of text.matchAll(/(?:^|[\s`"'])(\/[^\s`"'<>]+)/g)) {
		let path = match[1]!.replace(/[),;.]$/, "");
		while (path !== dirname(path)) {
			if (existsSync(join(path, ".git"))) { targets.push(path); break; }
			path = dirname(path);
		}
	}
	if (!targets.length) targets.push(cwd);
	return [...new Set(targets.map(target => resolve(cwd, target)))];
}

/** A digest is checked against current installed bytes, not merely a marker-shaped string. */
export async function checkTaskBrief(input: unknown, cwd: string, exec: BriefExec = execute): Promise<string | undefined> {
	if (!input || typeof input !== "object") return undefined;
	const value = input as Record<string, unknown>;
	const context = typeof value.context === "string" ? value.context : "";
	if (context.length > 1_000_000) return "BRIEF_CONTRACT_REFUSED: context exceeds the 1 MB contract inspection limit.";
	const tasks = Array.isArray(value.tasks) ? value.tasks : [];
	for (const item of tasks) {
		if (!item || typeof item !== "object") continue;
		const task = item as Record<string, unknown>;
		const body = typeof task.task === "string" ? task.task : "";
		if (body.length > 1_000_000) return "BRIEF_CONTRACT_REFUSED: task exceeds the 1 MB contract inspection limit.";
		if (!isBuildBriefTask(task)) continue;
		const text = `${context}\n${body}`;
		for (const target of briefTargets(text, cwd)) {
			const contract = await briefContract(resolve(cwd, target), exec);
			if (contract.installed && !text.split("\n").some(line => line.trim() === contract.marker)) return `BRIEF_CONTRACT_REFUSED: build task lacks the current contract for ${contract.repo}. Run omp-kit brief --repo ${JSON.stringify(contract.repo)} and paste its complete output into context (${contract.marker}).`;
		}
	}
	return undefined;
}

export function briefHandbackRefusal(text: string): string | undefined {
	if (text.length > 1_000_000) return "BRIEF_PREFLIGHT_REFUSED: handback exceeds the 1 MB evidence inspection limit.";
	if (!text.split("\n").some(line => line.trimStart().startsWith("DONE") && !/[A-Za-z0-9_]/.test(line.trimStart().charAt(4)))) return undefined;
	const clean = !/^[ \t]*(?:UNKNOWN|UNJUDGED|REFUSED)\b/m.test(text)
		&& /\bcommit-preflight\.sh\s+--files\s+\S+/.test(text)
		&& /commit-preflight:\s*\d+ checks, 0 refused(?:\/unjudged)?\b/.test(text);
	if (!clean) return "BRIEF_PREFLIGHT_REFUSED: DONE requires the exact changed-path commit-preflight command and its 0 refused/unjudged output, with no UNKNOWN, UNJUDGED or REFUSED findings. Return the handback to its author; it is not accepted work.";
	// EXPORTTEST1: a handback that changed src or test files must show those tests ran in an export.
	const code = [...text.matchAll(/commit-preflight\.sh\b[^\n]*?--files\s+([^\n]*)/g)].some(match => match[1]!.split(/\s+/).some(path => /^(?:src|tests|extensions)\/|\.test\.[a-z]+$/.test(path)));
	if (code && !(/\bcommit-preflight\.sh\b[^\n]*\s--tests\s+\S+/.test(text) && /commit-preflight:\s*\d+ checks, 0 refused\/unjudged\b[^\n]*;\s*[1-9]\d* export test file\(s\) run\b/.test(text))) return "BRIEF_PREFLIGHT_REFUSED: DONE names changed src/test files but shows no export test run. Rerun sh scripts/commit-preflight.sh --files <every changed path> --tests <changed test files> and report its 'commit-preflight: N checks, 0 refused/unjudged ...; M export test file(s) run' line.";
	return undefined;
}
