import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { nativeIdentity, nativePregrade, nativeRepo, rememberNativePregrade, requireNativeNonAuthor, type NativeContext, type NativeExec } from "../extensions/native-identity.ts";

export interface NativePregradeInput {
	bead: string;
	repo: string;
	tracker?: string;
	export_sha: string;
	ac_sha256: string;
	evidence: string;
}
export interface NativePregradeRecord {
	schema: "omp-kit.pregrade.v1";
	bead: string;
	ac_sha256: string;
	candidate_commit: string;
	verdict: "PASS";
	at: string;
	grader: string;
	author: string;
}

/** ac_phase.py:147-151: checkbox ticks do not invalidate the acceptance contract. */
export function nativeAcDigest(acceptance: string): string {
	if (acceptance.length > 65_536) throw new Error("NATIVE_AC_UNREADABLE: acceptance exceeds 65536 characters");
	return createHash("sha256").update(acceptance.split("\n").map(line => line.replace(/^(\s*-\s*\[)[xX](\])/, "$1 $2")).join("\n")).digest("hex");
}

async function checked(exec: NativeExec, command: string, args: string[], cwd: string): Promise<string> {
	const result = await exec(command, args, { cwd, timeout: 10_000 });
	if (result.code !== 0 || result.killed || result.stdout.length > 4 * 1024 * 1024) throw new Error(`NATIVE_AUTHORSHIP_UNPROVEN: ${command} ${args[0]} failed (${result.code}): ${result.stderr ?? ""}`);
	return result.stdout;
}

/** Exact Bead trailers, not substring matches; both git actors and observed native writes are checked.
 * Git names alone are NOT implementation provenance: the lead may have committed a child's edits.
 */
export async function nativeCommitAuthorship(repo: string, bead: string, sha: string, exec: NativeExec): Promise<{ authors: string[]; files: string[]; key: string; root: string }> {
	if (sha.length !== 40 || [...sha].some(c => !"0123456789abcdef".includes(c))) throw new Error("PREGRADE_CANDIDATE_UNBOUND: name an exact 40-character export commit SHA");
	const resolved = (await checked(exec, "git", ["rev-parse", "--verify", `${sha}^{commit}`], repo)).trim();
	if (resolved !== sha) throw new Error("PREGRADE_CANDIDATE_UNBOUND: export is not the exact commit named");
	const history = await checked(exec, "git", ["log", "-z", "--format=%H%x00%an%x00%cn%x00%B", "--fixed-strings", "--grep", `Bead: ${bead}`, "--max-count=101", sha], repo);
	const fields = history.split("\0");
	const authors: string[] = [];
	const files = new Set<string>();
	let commits = 0;
	for (let at = 0; at + 3 < fields.length; at += 4) {
		const [commit, author, committer, body] = fields.slice(at, at + 4) as [string, string, string, string];
		if (!body.split("\n").some(line => line.trim() === `Bead: ${bead}`)) continue;
		if (++commits > 100) throw new Error("NATIVE_AUTHORSHIP_UNPROVEN: more than 100 bead commits");
		authors.push(author, committer);
		const paths = await checked(exec, "git", ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit], repo);
		for (const path of paths.split("\0")) if (path) files.add(path);
	}
	if (commits === 0 || files.size === 0) throw new Error("NATIVE_AUTHORSHIP_UNPROVEN: export contains no implementation commit with the exact Bead trailer");
	const binding = await nativeRepo(repo, exec);
	return { authors, files: [...files], ...binding };
}

export async function recordNativePregrade(ctx: NativeContext, input: NativePregradeInput, exec: NativeExec, env: Record<string, string | undefined> = process.env): Promise<{ record: NativePregradeRecord; path: string }> {
	// Check the native caller BEFORE reading any caller-selected file or spawning a process.
	if (!nativeIdentity(ctx)) throw new Error("NATIVE_IDENTITY_UNBOUND: kit_record_pregrade requires a spawn-minted native child, not a seat or identity file");
	if (!input.bead || input.bead.length > 200 || [...input.bead].some(c => !"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-".includes(c))) throw new Error("NATIVE_BEAD_INVALID");
	if (!input.evidence.trim() || input.evidence.length > 65_536) throw new Error("NATIVE_EVIDENCE_REQUIRED");
	const repo = resolve(ctx.cwd, input.repo);
	const tracker = resolve(ctx.cwd, input.tracker ?? input.repo);
	const raw = JSON.parse(await checked(exec, "br", ["show", input.bead, "--json", "--no-auto-import", "--no-auto-flush"], tracker));
	const bead = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
	if (bead?.id !== input.bead || typeof bead.acceptance_criteria !== "string" || typeof bead.assignee !== "string" || !bead.assignee.trim()) throw new Error("NATIVE_AUTHORSHIP_UNPROVEN: bead needs current acceptance and a known implementer");
	const digest = nativeAcDigest(bead.acceptance_criteria);
	if (input.ac_sha256 !== digest) throw new Error("PREGRADE_AC_CHANGED: supplied digest is not the current acceptance contract");
	const commits = await nativeCommitAuthorship(repo, input.bead, input.export_sha, exec);
	const doneAuthors = Array.isArray(bead.comments) ? bead.comments.filter((comment: { text?: unknown }) => typeof comment.text === "string" && comment.text.trimStart().startsWith("DONE ")).map((comment: { author?: unknown }) => comment.author).filter((author: unknown): author is string => typeof author === "string") : [];
	const identity = requireNativeNonAuthor(ctx, [bead.assignee, ...doneAuthors, ...commits.authors], commits);
	// A changed acceptance during git reads must not produce a current-looking PASS.
	const freshRaw = JSON.parse(await checked(exec, "br", ["show", input.bead, "--json", "--no-auto-import", "--no-auto-flush"], tracker));
	const fresh = Array.isArray(freshRaw) && freshRaw.length === 1 ? freshRaw[0] : freshRaw;
	if (fresh?.id !== bead.id || fresh.assignee !== bead.assignee || fresh.acceptance_criteria !== bead.acceptance_criteria || JSON.stringify(fresh.comments) !== JSON.stringify(bead.comments)) throw new Error("PREGRADE_AC_CHANGED: bead changed during pregrade; retry against its current contract");
	const state = env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : "");
	if (!state || !isAbsolute(state)) throw new Error("NATIVE_STATE_UNBOUND: absolute XDG_STATE_HOME or HOME required");
	const path = join(state, "omp-kit", "pregrade", `${input.bead}.json`);
	const record: NativePregradeRecord = { schema: "omp-kit.pregrade.v1", bead: input.bead, ac_sha256: digest, candidate_commit: input.export_sha, verdict: "PASS", at: new Date().toISOString(), grader: identity.id, author: bead.assignee };
	const comment = `PASS native pregrade by ${identity.id} export ${input.export_sha}\n${input.evidence}`;
	await checked(exec, "br", ["comments", "add", input.bead, "--actor", identity.id, "-m", comment], tracker);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// The sibling belongs to this authenticated session; atomic replacement never exposes partial JSON.
	const pending = `${path}.${identity.principal}.pending`;
	try {
		writeFileSync(pending, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(pending, path);
	} finally { rmSync(pending, { force: true }); }
	rememberNativePregrade(ctx, input.bead, input.export_sha, digest, repo, tracker);
	return { record, path };
}

/** Called at the close boundary, never reconstructed from the record file or --actor. */
export async function checkNativeClose(ctx: NativeContext, bead: { id: string; assignee: string | null; acceptance: string | null; comments: readonly { author: string; text: string }[] }, repo: string, reason: string | null, exec: NativeExec): Promise<void> {
	const permit = nativePregrade(ctx, bead.id);
	const identity = nativeIdentity(ctx);
	if (!identity || !permit || resolve(ctx.cwd, repo) !== permit.tracker || nativeAcDigest(bead.acceptance ?? "") !== permit.digest) throw new Error("NATIVE_VERDICT_REQUIRED: this child needs its own current native pregrade in this tracker before closing");
	if (!reason?.includes(permit.sha)) throw new Error("NATIVE_VERDICT_REQUIRED: close reason must name the exact verified export SHA");
	const comment = bead.comments.at(-1);
	if (!comment || comment.author !== identity.id || !comment.text.startsWith(`PASS native pregrade by ${identity.id} export ${permit.sha}\n`)) throw new Error("NATIVE_VERDICT_REQUIRED: the newest verdict must be this child's export-bound PASS comment");
	const commits = await nativeCommitAuthorship(permit.repo, bead.id, permit.sha, exec);
	const doneAuthors = bead.comments.filter(comment => comment.text.trimStart().startsWith("DONE ")).map(comment => comment.author);
	requireNativeNonAuthor(ctx, [bead.assignee ?? "", ...doneAuthors, ...commits.authors], commits);
}

/** A kit command on the native tool surface: no shell flag/file can supply its caller context. */
export function registerNativePregradeTool(pi: Pick<ExtensionAPI, "registerTool" | "zod">, exec: NativeExec, env: Record<string, string | undefined>): void {
	const z = pi.zod;
	pi.registerTool({
		name: "kit_record_pregrade",
		label: "Record native non-author pregrade",
		description: "Record your independent PASS on an exact export SHA and current acceptance digest. Only a spawn-minted native child may call this; authors and implementation writers are refused. Does not close or transition the bead.",
		parameters: z.object({
			bead: z.string(),
			repo: z.string().describe("Implementation repository containing the exact export commit"),
			tracker: z.string().optional().describe("Tracker repository, if different from repo"),
			export_sha: z.string().describe("Exact 40-character exported commit SHA"),
			ac_sha256: z.string().describe("Current acceptance digest, with checklist ticks normalized to empty"),
			evidence: z.string().describe("Independent PASS verdict, commands, counts and every acceptance box"),
		}),
		async execute(_id, input, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Native pregrade cancelled");
			const result = await recordNativePregrade(ctx, input, exec, env);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
