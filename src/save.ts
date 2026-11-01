// `omp-kit save -m MSG -- PATH...` (ompkit-ypiyn SAVEVERB1): land with implied --apply --yes and one line
// of output. Every check, the commit and the publication are landCommand's; save only shapes the request,
// times it, prints one line and appends one save-log row for the p50 measure.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";
import { landCommand } from "./land.ts";
import { runSync } from "./kitlib/run.ts";

function gitLine(cwd: string, args: string[]): string | null {
	const result = runSync(["git", ...args], { cwd, deadline_s: 10 });
	if (result.rc !== 0) return null;
	return new TextDecoder().decode(result.stdout).trim() || null;
}

/** `<git-common-dir>/omp-kit/save.log`, or null outside a repository. */
function saveLogPath(cwd: string): { repo: string; log: string } | null {
	const repo = gitLine(cwd, ["rev-parse", "--show-toplevel"]);
	const common = gitLine(cwd, ["rev-parse", "--git-common-dir"]);
	if (!repo || !common) return null;
	return { repo, log: join(resolve(cwd, common), "omp-kit", "save.log") };
}

export async function saveCommand(request: ParsedCommand): Promise<CliResult> {
	const message = request.flags.get("--message");
	const paths = request.commandArgs ?? [];
	if (paths.some((path) => path.length === 0 || path.includes("\n")))
		return { code: 2, data: { overall: "NOT_RUN" }, errors: [{ code: "LAND_PATH_INVALID", message: "Save paths must be nonempty single-line repository-relative files", remediation: "Pass each reserved file after `--`; nothing was committed." }], verification: "NOT_RUN" };
	const flags = new Map<string, string | true>([
		["--message", typeof message === "string" ? message : ""],
		["--paths", paths.join("\n")],
		["--apply", true],
		["--yes", true],
	]);
	const started = performance.now();
	const land = await landCommand({ ...request, flags, commandArgs: undefined });
	const elapsed = Math.round((performance.now() - started) / 100) / 10;
	const pushed = land.code === 0 && land.data.overall === "PUSHED" && typeof land.data.pushed_sha === "string";
	const sha = typeof land.data.pushed_sha === "string" ? land.data.pushed_sha
		: typeof land.data.commit === "string" ? land.data.commit : null;
	const first = land.errors?.[0];
	const code = pushed ? "PUSHED" : first?.code ?? String(land.data.overall ?? "UNKNOWN");
	const line = pushed
		? `SAVED ${sha} on origin in ${elapsed.toFixed(1)} s`
		: `REFUSED ${code}: ${first?.remediation ?? "land did not publish; rerun with --json for detail."}`;
	const warnings = [...(land.warnings ?? [])];
	const target = saveLogPath(process.cwd());
	if (target) {
		const row = { ts: new Date().toISOString(), repo: target.repo, sha, outcome: pushed ? "SAVED" : "REFUSED", code, elapsed_s: elapsed };
		try {
			mkdirSync(dirname(target.log), { recursive: true });
			appendFileSync(target.log, `${JSON.stringify(row)}\n`);
		} catch (error) {
			warnings.push(`SAVE_LOG_UNWRITABLE: ${target.log}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const save = { line, elapsed_s: elapsed };
	if (request.json) return { ...land, data: { ...land.data, save }, ...(warnings.length ? { warnings } : {}) };
	// Human mode: exactly one stdout line. Land's typed errors stay in --json; the line names the first one.
	return { code: land.code, data: { ...land.data, save, text: line }, ...(warnings.length ? { warnings } : {}), ...(land.verification ? { verification: land.verification } : {}) };
}
