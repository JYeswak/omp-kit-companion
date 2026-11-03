import * as fs from "node:fs";
import { ownedTmp } from "./kitlib/tmp.ts";
import * as path from "node:path";
import type { CorpusCase } from "./case-corpus.ts";
import { check as durabilityCheck, type DurabilityBlock } from "./fleet-guard/durability.ts";
import { writeScratchOwner } from "./fleet-guard/scratch.ts";

export interface MechanicalCase extends CorpusCase {
	argumentSpace?: boolean;
}
export type AdmissionEvaluator = typeof durabilityCheck;
/** Joins width-sized slices of the wire, as a streamed tool argument arrives. */
export type Reassembler = (wire: string, width: number) => string;

export const PARTITION_ERROR = "mechanical admission depends on chunk partition";
export const NONDETERMINISM_ERROR = "mechanical admission is nondeterministic on one fixture";

/** A blocked live read is missing evidence, never a positive policy match or a verdict difference. */
export class AdmissionUnknownError extends Error {
	readonly status = "UNKNOWN";
	readonly block = true;
	constructor(readonly read: string, reason: string) {
		super(reason);
		this.name = "AdmissionUnknownError";
	}
}

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

/**
 * Builds one isolated real Git repository for the case; no operator repository or index is accessed.
 * Setup Git runs asynchronously, so independent cases may build their fixtures concurrently.
 */
async function withFixture<T>(c: MechanicalCase, kit: string, use: (fixture: Fixture) => Promise<T>): Promise<T> {
	const root = fs.realpathSync(ownedTmp("mechanical-case").path);
	writeScratchOwner(root, { pid: process.pid, label: "mechanical-case", repo: kit, created: new Date().toISOString() });
	try {
		const env: Record<string, string> = {};
		for (const key of ["PATH", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key]!;
		Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
		const git = async (args: string[], input?: string): Promise<string> => {
			const read = `fixture setup git ${args.join(" ")}`;
			try {
				const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
					{ env, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
				const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
				if (child.exitCode !== 0) throw new Error(`exit=${child.exitCode}, signal=${child.signalCode}: ${stderr}`);
				return stdout.trimEnd();
			} catch (error) {
				throw new AdmissionUnknownError(read, `UNKNOWN mechanical admission setup BLOCKED: ${read}: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		// No hooks or template files participate in admission; only this fixture's index and objects do.
		await git(["init", "--quiet", "--template="]);
		for (const [p, content] of Object.entries(c.reference?.tracked ?? {})) {
			const oid = await git(["hash-object", "-w", "--no-filters", "--stdin"], content);
			await git(["update-index", "--add", "--cacheinfo", `100644,${oid},${p}`]);
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
	} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}

/** One dispatch decodes the complete wire and re-reads production repository facts live; nothing is cached. */
async function dispatch(fixture: Fixture, evaluate: AdmissionEvaluator): Promise<DurabilityBlock | undefined> {
	const { root, wire, toolName } = fixture;
	return evaluate({ toolName, input: JSON.parse(wire), cwd: root }, { cwd: root });
}

export interface MechanicalOptions {
	kit: string;
	evaluate?: AdmissionEvaluator;
	join?: Reassembler;
}

/** Only completed live reads have verdicts to compare; missing facts block the proof as UNKNOWN. */
async function deterministicDispatch(fixture: Fixture, evaluate: AdmissionEvaluator): Promise<boolean> {
	const first = await dispatch(fixture, evaluate);
	const second = await dispatch(fixture, evaluate);
	const unknown = first?.status === "UNKNOWN" ? first : second?.status === "UNKNOWN" ? second : undefined;
	if (unknown) throw new AdmissionUnknownError(unknown.read, unknown.reason);
	const blocked = first?.block === true;
	if (blocked !== (second?.block === true)) throw new Error(NONDETERMINISM_ERROR);
	return blocked;
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
