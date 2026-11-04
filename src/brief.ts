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
		add(header || "violations judged by this executable member", `read and satisfy ${member} before changing its governed surface`);
	}
	return rules;
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
	const fingerprintHelpers = (path: string, source: string): void => {
		for (const match of source.matchAll(/\b([A-Za-z0-9_-]+\.(?:py|ts|sh|json))\b/g)) {
			const helper = join(dirname(path), match[1]!);
			if (visited.has(helper) || !existsSync(helper) || !statSync(helper).isFile()) continue;
			if (visited.size >= 256) throw new Error("brief: helper closure exceeds 256 files");
			visited.add(helper);
			const body = readFileSync(helper, "utf8");
			members.push({ member: `helper:${relative(repo, helper)}`, path: helper, sha256: hash(body) });
			fingerprintHelpers(helper, body);
		}
	};
	const inspect = (path: string, member: string) => {
		const source = readFileSync(path, "utf8");
		members.push({ member, path, sha256: hash(source) });
		visited.add(path);
		fingerprintHelpers(path, source);
		rules.push(...memberRules(member, source));
	};
	for (const kind of ["pre-commit", "commit-msg", "pre-push"]) {
		const runner = join(hooks, kind);
		if (existsSync(runner) && statSync(runner).isFile() && (statSync(runner).mode & 0o111)) {
			installed = true;
			inspect(runner, kind);
		}
		const chain = join(hooks, "hooks.d", kind);
		if (!existsSync(chain)) continue;
		for (const name of readdirSync(chain).filter(name => /^\d\d-/.test(name)).sort()) {
			const path = join(chain, name);
			if (!statSync(path).isFile() || !(statSync(path).mode & 0o111)) continue;
			installed = true;
			inspect(path, `${kind}/${name}`);
		}
	}
	const scripts = join(repo, "scripts");
	if (existsSync(scripts)) {
		for (const name of readdirSync(scripts).filter(name => /^check-staged-.*\.sh$/.test(name) || name === "fresh-gate.sh").sort()) inspect(join(scripts, name), `source:scripts/${name}`);
	}
	rules.push(
		{ member: "process:EXPORTINDEX1", refuses: "writes escaping an exported test tree", compliant: "exports are read-only source inputs; fixture repositories need their own git init and GIT_CEILING_DIRECTORIES so git never discovers the parent checkout" },
		{ member: "process:commit-notes", refuses: "a user-visible change without its own release note", compliant: "write changelog.d/<bead-without-ompkit-prefix>.md, user-facing '- ' bullets; update README's command reference for CLI changes" },
		{ member: "process:BRIEFCONTRACT1", refuses: "DONE without clean changed-path preflight evidence", compliant: "before DONE run sh scripts/commit-preflight.sh --files <every changed path>; report the exact command and its commit-preflight: ... 0 refused/unjudged output" },
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

export function renderBrief(contract: BriefContract, candidates: readonly BriefCandidate[] = []): string {
	return [`Gate contract: ${contract.repo}`, ...contract.rules.map(rule => `[${rule.member}] Refuses: ${rule.refuses}. Comply: ${rule.compliant}.`),
		...candidates.map(row => `${row.review} ${row.path}:${row.line}\n${row.hunk}`), contract.marker].join("\n");
}

/** Only explicitly read-only assignments bypass the build contract; an editing prohibition alone is not a mode. */
export function isBuildBriefTask(task: Record<string, unknown>): boolean {
	const selector = typeof task.agent === "string" ? task.agent : "";
	const body = typeof task.task === "string" ? task.task : "";
	if (["reviewer", "security-reviewer", "seance", "zeststream-planner", "zeststream-reviewer"].includes(selector)) return false;
	if (/^\s*(?:#\s*)?(?:read-only|analysis-only)\b/i.test(body)) return false;
	return !(/^\s*(?:analy[sz]e|analysis|investigate|review|inspect)\b/i.test(body)
		&& !/\b(?:implement|modify|edit|write|fix|refactor|remove|add|create|update)\b/i.test(body));
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
		for (const target of new Set(targets)) {
			const contract = await briefContract(resolve(cwd, target), exec);
			if (contract.installed && !text.split("\n").some(line => line.trim() === contract.marker)) return `BRIEF_CONTRACT_REFUSED: build task lacks the current contract for ${contract.repo}. Run omp-kit brief --repo ${JSON.stringify(contract.repo)} and paste its complete output into context (${contract.marker}).`;
		}
	}
	return undefined;
}

export function briefHandbackRefusal(text: string): string | undefined {
	if (text.length > 1_000_000) return "BRIEF_PREFLIGHT_REFUSED: handback exceeds the 1 MB evidence inspection limit.";
	if (!text.split("\n").some(line => line.trimStart().startsWith("DONE") && !/[A-Za-z0-9_]/.test(line.trimStart().charAt(4)))) return undefined;
	if (!/^[ \t]*(?:UNKNOWN|UNJUDGED|REFUSED)\b/m.test(text)
		&& /\bcommit-preflight\.sh\s+--files\s+\S+/.test(text)
		&& /commit-preflight:\s*\d+ checks, 0 refused(?:\/unjudged)?\b/.test(text)) return undefined;
	return "BRIEF_PREFLIGHT_REFUSED: DONE requires the exact changed-path commit-preflight command and its 0 refused/unjudged output, with no UNKNOWN, UNJUDGED or REFUSED findings. Return the handback to its author; it is not accepted work.";
}
