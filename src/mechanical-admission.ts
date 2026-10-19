import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CorpusCase } from "./case-corpus.ts";
import { check as durabilityCheck } from "./fleet-guard/durability.ts";
import { writeScratchOwner } from "./fleet-guard/scratch.ts";

export interface MechanicalCase extends CorpusCase {
	argumentSpace?: boolean;
}
export type AdmissionEvaluator = typeof durabilityCheck;
/** Joins width-sized slices of the wire, as a streamed tool argument arrives. */
export type Reassembler = (wire: string, width: number) => string;

export const PARTITION_ERROR = "mechanical admission depends on chunk partition";
export const NONDETERMINISM_ERROR = "mechanical admission is nondeterministic on one fixture";

export const reassemble: Reassembler = (wire, width) => {
	let assembled = "";
	for (let i = 0; i < wire.length; i += width) assembled += wire.slice(i, i + width);
	return assembled;
};

/** Every chunk partition must reassemble to the exact wire, or the single verdict would not cover it. */
export function assertPartitionInvariant(wire: string, chunkWidths: readonly (number | undefined)[], join: Reassembler = reassemble): void {
	for (const chunkWidth of chunkWidths)
		if (join(wire, chunkWidth ?? Math.max(1, wire.length)) !== wire) throw new Error(PARTITION_ERROR);
}

interface Fixture {
	root: string;
	wire: string;
	toolName: string;
}

/** Builds one isolated real Git repository for the case; no operator repository or index is accessed. */
async function withFixture<T>(c: MechanicalCase, kit: string, use: (fixture: Fixture) => Promise<T>): Promise<T> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mechanical-case.${process.pid}.`)));
	writeScratchOwner(root, { pid: process.pid, label: "mechanical-case", repo: kit, created: new Date().toISOString() });
	try {
		const env: Record<string, string> = {};
		for (const key of ["PATH", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]!;
		Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
		const git = (args: string[], input?: string): string => {
			const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
				{ env, stdout: "pipe", stderr: "pipe", timeout: 2_000,
					...(input === undefined ? {} : { stdin: Buffer.from(input) }) });
			if (result.exitCode !== 0) throw new Error(`mechanical Git fixture setup failed: ${result.stderr.toString()}`);
			return result.stdout.toString().trimEnd();
		};
		git(["init", "--quiet"]);
		fs.mkdirSync(path.join(root, ".omp"));
		fs.writeFileSync(path.join(root, ".omp/fleet.json"), '{"enabled":true}\n');
		for (const [p, content] of Object.entries(c.reference?.tracked ?? {})) {
			const oid = git(["hash-object", "-w", "--no-filters", "--stdin"], content);
			git(["update-index", "--add", "--cacheinfo", `100644,${oid},${p}`]);
		}
		// Historical absolute fixture paths are projected into this real isolated
		// repository; no operator repository or its index is accessed.
		const marker = "var/agent-tmp/";
		const offset = c.path.indexOf(marker);
		const target = path.isAbsolute(c.path) && offset >= 0 ? c.path.slice(offset) : c.path;
		if (path.isAbsolute(target) || target.split("/").includes("..")) throw new Error("fixture target escapes isolated repository");
		if (offset >= 0) {
			const child = c.path.slice(offset + marker.length).split("/")[0]!;
			writeScratchOwner(path.join(root, marker, child), { pid: process.pid, label: child, repo: root, created: new Date().toISOString() });
		}
		const absolute = path.join(root, target);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		// A replacement edit must be applicable and unambiguous, not an unknown
		// payload whose generic refusal accidentally passes a source-copy case.
		if (c.tool === "edit") fs.writeFileSync(absolute, c.snippet);
		const input = c.tool === "write" ? { path: target, content: c.snippet }
			: c.tool === "edit" ? { path: target, oldText: c.snippet, newText: `${c.snippet}\n` }
			: { command: c.snippet };
		return await use({ root, wire: JSON.stringify(input, null, c.argumentSpace ? 2 : undefined), toolName: c.tool });
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** One dispatch decodes the complete wire and re-reads production repository facts live; nothing is cached. */
async function dispatch(fixture: Fixture, evaluate: AdmissionEvaluator): Promise<boolean> {
	const { root, wire, toolName } = fixture;
	return (await evaluate({ toolName, input: JSON.parse(wire), cwd: root }, { cwd: root }))?.block === true;
}

export interface MechanicalOptions {
	kit: string;
	evaluate?: AdmissionEvaluator;
	join?: Reassembler;
}

/** Dispatches twice on one fixture; unequal verdicts mean a single dispatch cannot stand for a case. */
async function deterministicDispatch(fixture: Fixture, evaluate: AdmissionEvaluator): Promise<boolean> {
	const first = await dispatch(fixture, evaluate);
	const second = await dispatch(fixture, evaluate);
	if (first !== second) throw new Error(NONDETERMINISM_ERROR);
	return first;
}

/**
 * Final-only admission sees the finished arguments, so every chunk partition that
 * reassembles to the exact wire shares the one verdict of the case. That verdict
 * is only trusted after a second dispatch on the same fixture agrees: exactly
 * one extra dispatch per case, never one per partition.
 */
export async function mechanicalVerdicts(c: MechanicalCase, chunkWidths: readonly (number | undefined)[], options: MechanicalOptions): Promise<boolean[]> {
	if (c.source !== "tool") return chunkWidths.map(() => false);
	return withFixture(c, options.kit, async fixture => {
		assertPartitionInvariant(fixture.wire, chunkWidths, options.join);
		const verdict = await deterministicDispatch(fixture, options.evaluate ?? durabilityCheck);
		return chunkWidths.map(() => verdict);
	});
}

/** The determinism check alone, for tests that need the case verdict without partition widths. */
export async function assertDeterministicAdmission(c: MechanicalCase, options: MechanicalOptions): Promise<boolean> {
	return withFixture(c, options.kit, fixture => deterministicDispatch(fixture, options.evaluate ?? durabilityCheck));
}
