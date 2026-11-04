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
export interface BriefContract { repo: string; installed: boolean; digest: string; marker: string; rules: BriefRule[]; members: BriefMember[]; kit: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

let kitRelease: string | undefined;
/**
 * BRIEFSTABLE1: the kit release whose gate contract this code teaches, so a brief from another release
 * never matches. Read from the release-manifest.json beside the running module (the bundled guard) or
 * the compiled binary's release root; a source checkout reports "unreleased".
 */
export function briefKitRelease(): string {
	if (kitRelease !== undefined) return kitRelease;
	for (const root of [() => resolve(dirname(fileURLToPath(import.meta.url)), ".."), () => releaseRoot(process.execPath)]) {
		try {
			const manifest: unknown = JSON.parse(readFileSync(join(root(), "release-manifest.json"), "utf8"));
			if (manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string") return kitRelease = manifest.version;
		} catch { /* not a release root */ }
	}
	return kitRelease = "unreleased";
}

/** Committed blob bodies by object id: content-addressed, so a per-process cache never goes stale. */
const blobCache = new Map<string, string>();
const BLOB_CACHE_CAP = 4096;

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

/**
 * Read the hook location Git actually resolves (including core.hooksPath), plus source staged checks
 * at `rev` (default HEAD). `kit` defaults to the running release.
 */
export async function briefContract(repoPath: string, exec: BriefExec = execute, options: { rev?: string; kit?: string } = {}): Promise<BriefContract> {
	const rev = options.rev ?? "HEAD";
	const kit = options.kit ?? briefKitRelease();
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
	// BRIEFSTABLE1: source members are read from a commit, never the working tree, so in-flight edits by peers cannot move the digest.
	const listed = await exec("git", ["ls-tree", "-r", "-z", rev, "--", "scripts"], { cwd: repo, timeout: 3000 });
	const committed = new Map<string, string>();
	if (listed.code === 0) for (const entry of listed.stdout.split("\0")) {
		const tab = entry.indexOf("\t");
		const [, type, oid] = entry.slice(0, tab).split(" ");
		if (tab > 0 && type === "blob" && oid) committed.set(entry.slice(tab + 1), oid);
	}
	const readHead = async (path: string): Promise<string | undefined> => {
		const rel = relative(repo, path);
		const oid = committed.get(rel);
		if (oid === undefined) return undefined;
		const cached = blobCache.get(oid);
		if (cached !== undefined) return cached;
		const shown = await exec("git", ["cat-file", "blob", oid], { cwd: repo, timeout: 3000 });
		if (shown.code !== 0) throw new Error(`brief: cannot read ${rev}:${rel}`);
		if (blobCache.size >= BLOB_CACHE_CAP) blobCache.clear();
		blobCache.set(oid, shown.stdout);
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
	for (const rel of [...committed.keys()].filter(rel => /^scripts\/(?:check-staged-.*\.sh|fresh-gate\.sh)$/.test(rel)).sort()) await inspect(join(repo, rel), `source:${rel}`, readHead);
	rules.push(
		{ member: "process:EXPORTINDEX1", refuses: "writes escaping an exported test tree", compliant: "exports are read-only source inputs; fixture repositories need their own git init and GIT_CEILING_DIRECTORIES so git never discovers the parent checkout" },
		{ member: "process:commit-notes", refuses: "a user-visible change without its own release note", compliant: "write changelog.d/<bead-without-ompkit-prefix>.md, user-facing '- ' bullets; update README's command reference for CLI changes" },
		{ member: "process:BRIEFCONTRACT1", refuses: "DONE without clean changed-path preflight evidence", compliant: "before DONE run sh scripts/commit-preflight.sh --files <every changed path> --tests <changed test files>; report the exact command and its commit-preflight: ... 0 refused/unjudged ...; N export test file(s) run output" },
	);
	const digest = hash(JSON.stringify({ repo, kit, members, rules }));
	return { repo, installed, digest, marker: `omp-kit-brief: ${repo} ${digest}`, rules, members, kit };
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
/** SCRATCHNULL1 (ompkit-fp72.120.16.194): `jq -r .data.dir` on a refused `scratch new` yields the path `null`; teach the fail-closed form. */
export const BRIEF_SCRATCH_STEP = "[scratch] Hazard: a refused `scratch new` piped through `jq -r .data.dir` exports TMPDIR=null and writes ./null outside owned scratch, and `export TMPDIR=$(...) || exit 1` never exits because export returns 0. Comply: TMPDIR=$(omp-kit scratch new --label <x> --print-dir) || exit 1; export TMPDIR, run inside the owning repo.";

export function renderBrief(contract: BriefContract, candidates: readonly BriefCandidate[] = []): string {
	return [`Gate contract: ${contract.repo}`, ...contract.rules.map(rule => `[${rule.member}] Refuses: ${rule.refuses}. Comply: ${rule.compliant}.`),
		BRIEF_PRIOR_ART_STEP, BRIEF_SCRATCH_STEP,
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

/** BRIEFREPOWORD1: a pasted brief block (its `Gate contract:` header through its `omp-kit-brief: <path> <digest>` marker) is quoted hook text, never a target. An unterminated header hides nothing. */
export function stripBriefBlocks(text: string): string {
	const kept: string[] = [];
	let block: string[] | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!block) {
			if (trimmed.startsWith("Gate contract: ")) block = [line];
			else kept.push(line);
			continue;
		}
		if (trimmed.startsWith("omp-kit-brief: ") && trimmed.charAt(trimmed.length - 65) === " " && /^[0-9a-f]{64}$/.test(trimmed.slice(-64))) block = undefined;
		else block.push(line);
	}
	if (block) kept.push(...block);
	return kept.join("\n");
}

function trimPathToken(token: string): string {
	let end = token.length;
	while (end > 0 && "),;.:".includes(token[end - 1]!)) end--;
	return token.slice(0, end);
}

/** Repositories a brief targets: explicit repo labels, absolute paths' owning repos, else the session cwd. */
export function briefTargets(text: string, cwd: string): string[] {
	const prose = stripBriefBlocks(text);
	// BRIEFREPOWORD1: a label names a target only when it is absolute or an existing relative directory; '-', 'any', 'the' are prose.
	const targets = [...prose.matchAll(/(?:--repo\s+|\b(?:repo|repository)\s*[:=]\s*)["`']?([^\s"`'<>]+)/gi)]
		.map(match => trimPathToken(match[1]!))
		.filter(path => path && (isAbsolute(path) || (existsSync(resolve(cwd, path)) && statSync(resolve(cwd, path)).isDirectory())));
	// Absolute source paths also target their owning repo, even without a
	// "Repo:" label; no shell evaluation or dependence on the session cwd.
	for (const match of prose.matchAll(/(?:^|[\s`"'])(\/[^\s`"'<>]+)/g)) {
		let path = trimPathToken(match[1]!);
		while (path !== dirname(path)) {
			if (existsSync(join(path, ".git"))) { targets.push(path); break; }
			path = dirname(path);
		}
	}
	if (!targets.length) targets.push(cwd);
	return [...new Set(targets.map(target => resolve(cwd, target)))];
}

/**
 * BRIEFSTABLE1: a brief stays valid for BRIEF_WINDOW_MINUTES after a landing supersedes it, so a
 * landing between `omp-kit brief` and the spawn no longer refuses a freshly pasted contract.
 * Measured 2026-11-04 (companion, 167 first-parent commits since 11-03, gate-events.jsonl refusals):
 * the HEAD-bound digest changed 60 times with a median lifetime of 33.1 min; of 22 measured
 * companion paste ages, 16 were <= 14.9 min, and a 30 min window admits 20 of 22 (the two refused
 * pastes were 43 and 93 min old, older than a median digest lifetime). The walk is capped at
 * BRIEF_WINDOW_REVS first-parent commits: the peak in any 30 min window was 11.
 */
export const BRIEF_WINDOW_MINUTES = 30;
export const BRIEF_WINDOW_REVS = 16;

/** True when `lines` carries the marker of HEAD or of a first-parent ancestor superseded within the window. */
export async function briefMarkerAccepted(current: BriefContract, lines: ReadonlySet<string>, exec: BriefExec = execute, now = Date.now()): Promise<boolean> {
	if (lines.has(current.marker)) return true;
	const log = await exec("git", ["log", "--first-parent", `--max-count=${BRIEF_WINDOW_REVS + 1}`, "--format=%H %ct", "HEAD", "--"], { cwd: current.repo, timeout: 3000 });
	if (log.code !== 0) return false;
	const revs = log.stdout.trim().split("\n").map(line => line.split(" "));
	for (let k = 1; k < revs.length; k++) {
		// revs[k]'s contract was current until revs[k - 1] landed.
		if (Number(revs[k - 1]![1]) * 1000 < now - BRIEF_WINDOW_MINUTES * 60_000) return false;
		try {
			if (lines.has((await briefContract(current.repo, exec, { rev: revs[k]![0], kit: current.kit })).marker)) return true;
		} catch { /* an unreadable ancestor admits nothing */ }
	}
	return false;
}

/** A digest is checked against installed bytes, committed sources and the kit release, not merely a marker-shaped string. */
export async function checkTaskBrief(input: unknown, cwd: string, exec: BriefExec = execute): Promise<string | undefined> {
	if (!input || typeof input !== "object") return undefined;
	const value = input as Record<string, unknown>;
	const context = typeof value.context === "string" ? value.context : "";
	if (context.length > 1_000_000) return "BRIEF_CONTRACT_REFUSED: context exceeds the 1 MB contract inspection limit.";
	const tasks = Array.isArray(value.tasks) ? value.tasks : [];
	const lookup = async (target: string) => { try { return await briefContract(resolve(cwd, target), exec); } catch { return undefined; } };
	for (const item of tasks) {
		if (!item || typeof item !== "object") continue;
		const task = item as Record<string, unknown>;
		const body = typeof task.task === "string" ? task.task : "";
		if (body.length > 1_000_000) return "BRIEF_CONTRACT_REFUSED: task exceeds the 1 MB contract inspection limit.";
		if (!isBuildBriefTask(task)) continue;
		const text = `${context}\n${body}`;
		const lines = new Set(text.split("\n").map(line => line.trim()));
		// BRIEFREPOWORD1: a target that does not resolve is "no target named": fall back to the session cwd, never crash the guard.
		const contracts = (await Promise.all(briefTargets(text, cwd).map(lookup))).filter(contract => contract !== undefined);
		if (!contracts.length) {
			const fallback = await lookup(cwd);
			if (!fallback) return `BRIEF_CONTRACT_REFUSED: build task names no target checkout that resolves, and the session cwd ${cwd} is not a repository. Name the checkout as an absolute path and paste the complete output of omp-kit brief --repo <that path> into context.`;
			contracts.push(fallback);
		}
		for (const contract of contracts) {
			if (contract.installed && !await briefMarkerAccepted(contract, lines, exec)) return `BRIEF_CONTRACT_REFUSED: build task lacks the current contract for ${contract.repo}. Run omp-kit brief --repo ${JSON.stringify(contract.repo)} and paste its complete output into context (${contract.marker}). A brief stays valid ${BRIEF_WINDOW_MINUTES} min after a landing supersedes it; one from another kit release or gate contract never matches.`;
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
