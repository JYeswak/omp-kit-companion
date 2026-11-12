// value.ts -- `omp-kit value` (ompkit-zt589, ompkit-ccv4g, ompkit-ertgo): measure a
// project's declared user-value metric against its target.
//
// A project declares `<project>/.omp/value.json` as
// `{"name": str, "command": [argv...], "target": number}`. The command runs as
// an argv list, never through a shell, with cwd set to the project and a
// bounded deadline; its stdout must parse as one finite number. MET means
// value >= target. The turnline reader (omp-kit/scripts/turnline.py) validates
// the same shape; this verb never imports it.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { run } from "./kitlib/run.ts";
import { previewText } from "../extensions/secret-output-guard.ts";
import { isRecord } from "./type-guards.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

export const VALUE_SCHEMA = "omp-kit.value.v1";
/** One value probe is a quick local read (the CFS probe runs one script over a
 * local checkout). 30 s bounds a hung probe without stalling the loop-close
 * job that replays every lifecycle gap. */
export const VALUE_COMMAND_TIMEOUT_S = 30;
/** value.json is one small declaration; anything larger is not a declaration. */
const VALUE_MAX_DECL_BYTES = 64 * 1024;
/** A metric probe prints one number; output past this is truncated and judged. */
const VALUE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Stdout preview carried in UNKNOWN reasons; the envelope stays one line. */
const VALUE_PREVIEW_CHARS = 200;

export type ValueVerdict = "MET" | "BELOW" | "UNDECLARED" | "UNKNOWN";

export interface ValueDecl {
	readonly name: string;
	readonly command: readonly string[];
	readonly target: number;
}

export interface ValueOutcome {
	readonly verdict: ValueVerdict;
	readonly name: string;
	/** Measured value; null when no number was produced. */
	readonly value: number | null;
	/** Declared target; null when the declaration itself is missing or invalid. */
	readonly target: number | null;
	readonly command: readonly string[];
	readonly reason: string;
	readonly remediation: string;
}

/** Bounded read of a small declaration file: the size gate runs before any byte is kept. */
function readDeclBytes(path: string): Buffer {
	const fd = openSync(path, "r");
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > VALUE_MAX_DECL_BYTES) throw new Error("DECL_UNREADABLE");
		const out = Buffer.alloc(stat.size);
		let at = 0;
		while (at < out.length) {
			const read = readSync(fd, out, at, out.length - at, null);
			if (read === 0) break;
			at += read;
		}
		return out.subarray(0, at);
	} finally {
		closeSync(fd);
	}
}

/** The same declaration shape turnline's value_decl_for_repo accepts: a
 * nonempty argv list of nonempty strings, a finite numeric target, and a name
 * string (a missing name means "value"). */
export function parseValueDecl(raw: unknown): { decl: ValueDecl } | { invalid: string } {
	if (!isRecord(raw)) return { invalid: "the file does not hold a JSON object" };
	const { name, command, target } = raw;
	if (command === undefined || target === undefined)
		return { invalid: "the object needs both \"command\" and \"target\"" };
	if (!Array.isArray(command) || command.length === 0 || command.some(item => typeof item !== "string" || item.length === 0))
		return { invalid: "\"command\" must be a nonempty list of nonempty strings" };
	if (typeof target !== "number" || !Number.isFinite(target))
		return { invalid: "\"target\" must be one finite number" };
	if (name !== undefined && typeof name !== "string")
		return { invalid: "\"name\" must be a string when present" };
	return { decl: { name: name === undefined || name === "" ? "value" : name, command, target } };
}

/** One finite decimal number and nothing else; hex, Infinity and trailing text refuse. */
const METRIC_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

export function parseMetricValue(stdout: string): number | null {
	const text = stdout.trim();
	if (text === "" || !METRIC_PATTERN.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Run one project's declared metric probe; never throws for project-controlled states. */
export async function runValueVerb(project: string): Promise<ValueOutcome> {
	const root = isAbsolute(project) ? project : resolve(project);
	const declPath = join(root, ".omp", "value.json");
	let raw: unknown;
	try {
		raw = JSON.parse(readDeclBytes(declPath).toString("utf8"));
	} catch {
		return { verdict: "UNDECLARED", name: "value", value: null, target: null, command: [],
			reason: `No value metric declared: ${declPath} is missing or unreadable.`,
			remediation: `Declare {"name": str, "command": [argv...], "target": number} in ${declPath}; the command runs with cwd ${root} and must print one finite number.` };
	}
	const parsed = parseValueDecl(raw);
	if ("invalid" in parsed) {
		return { verdict: "UNDECLARED", name: "value", value: null, target: null, command: [],
			reason: `No value metric declared: ${declPath} is invalid: ${parsed.invalid}.`,
			remediation: `Declare {"name": str, "command": [argv...], "target": number} in ${declPath}; the command runs with cwd ${root} and must print one finite number.` };
	}
	const { decl } = parsed;
	let result;
	try {
		result = await run([...decl.command], { cwd: root, deadline_s: VALUE_COMMAND_TIMEOUT_S, max_output_bytes: VALUE_MAX_OUTPUT_BYTES });
	} catch (error) {
		return { verdict: "UNKNOWN", name: decl.name, value: null, target: decl.target, command: decl.command,
			reason: `The value command could not start: ${error instanceof Error ? error.message : String(error)}.`,
			remediation: "Fix the declared command so it starts; nothing was measured." };
	}
	if (result.timed_out) {
		return { verdict: "UNKNOWN", name: decl.name, value: null, target: decl.target, command: decl.command,
			reason: `The value command timed out after ${VALUE_COMMAND_TIMEOUT_S} s.`,
			remediation: "Make the probe finish inside its deadline; nothing was measured." };
	}
	// A cut capture may keep a valid-looking numeric prefix of output the probe never meant as its answer.
	if (result.truncated || result.total_truncated) {
		return { verdict: "UNKNOWN", name: decl.name, value: null, target: decl.target, command: decl.command,
			reason: `The value command printed more than ${VALUE_MAX_OUTPUT_BYTES} bytes, so its output was cut and is not judged.`,
			remediation: "Make the declared command print exactly one finite number; nothing was measured." };
	}
	if (result.rc !== 0) {
		// Scrub before truncating: probes like cfs-infisical-run are credential-adjacent, and a cut first can hide a token shape.
		const stderr = previewText(new TextDecoder().decode(result.stderr).trim(), VALUE_PREVIEW_CHARS);
		return { verdict: "UNKNOWN", name: decl.name, value: null, target: decl.target, command: decl.command,
			reason: `The value command exited ${String(result.rc)}${stderr === "" ? "" : `: ${stderr}`}.`,
			remediation: "Make the declared command exit 0 and print one finite number; nothing was measured." };
	}
	const stdout = new TextDecoder().decode(result.stdout);
	const measured = parseMetricValue(stdout);
	if (measured === null) {
		const preview = previewText(stdout.trim(), VALUE_PREVIEW_CHARS);
		return { verdict: "UNKNOWN", name: decl.name, value: null, target: decl.target, command: decl.command,
			reason: `The value command printed no finite number${preview === "" ? "" : `: ${JSON.stringify(preview)}`}.`,
			remediation: "Make the declared command print exactly one finite number on stdout; nothing was measured." };
	}
	const verdict: ValueVerdict = measured >= decl.target ? "MET" : "BELOW";
	return { verdict, name: decl.name, value: measured, target: decl.target, command: decl.command,
		reason: verdict === "MET" ? "The measured value meets its target." : "The measured value is below its target.",
		remediation: verdict === "MET" ? "None; the metric meets its target." : "Raise the measured value to its target." };
}

/** `omp-kit value [--project PATH] [--json]`. Exit classes are the verb's own:
 * 0 MET, 1 BELOW, 2 UNDECLARED, 3 UNKNOWN. */
export async function valueCommand(request: ParsedCommand): Promise<CliResult> {
	const project = request.flags.get("--project");
	const outcome = await runValueVerb(typeof project === "string" && project !== "" ? project : process.cwd());
	const code = outcome.verdict === "MET" ? 0 : outcome.verdict === "BELOW" ? 1 : outcome.verdict === "UNDECLARED" ? 2 : 3;
	const valueText = outcome.value === null ? "?" : String(outcome.value);
	const targetText = outcome.target === null ? "?" : String(outcome.target);
	return {
		code,
		data: { overall: outcome.verdict, schema: VALUE_SCHEMA, name: outcome.name, value: outcome.value,
			target: outcome.target, verdict: outcome.verdict, command: [...outcome.command],
			reason: outcome.reason, remediation: outcome.remediation,
			text: `VALUE ${outcome.name}=${valueText}/${targetText} ${outcome.verdict}` },
		verification: outcome.verdict === "MET" || outcome.verdict === "BELOW" ? "PERFORMED" : "UNVERIFIED",
	};
}
