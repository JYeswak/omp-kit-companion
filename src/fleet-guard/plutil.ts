import { commandFromEvent, commandName, executedShellCommands, type FleetGuardBlock, type FleetGuardEvent } from "./git.ts";

/**
 * PLUTILINPLACE1 (ompkit-ffb85). plutil's editing verbs write their result over the input file unless `-o` names the
 * output: on 2026-10-21 `plutil -extract ProgramArguments json <plist>` rewrote 12 LaunchAgent plists as JSON arrays
 * and kit services failed doctor for 25 h. Those plists live outside every repository, so this rule is always on:
 * extensions/fleet-guard.ts applies it in every session, ahead of and independent of the `.omp/fleet.json` opt-in.
 *
 * Words come from the shared shell traversal (executedShellCommands), so a quoted mention inside another command's
 * argument is not a plutil call, while chains, loops, wrappers, substitutions and nested shells are inspected.
 */

// Operand words each editing verb takes before its options (`-extract keypath fmt`, `-insert keypath -type value`).
const VERB_OPERANDS: ReadonlyMap<string, number> = new Map([["-extract", 2], ["-convert", 1], ["-insert", 3], ["-replace", 3], ["-remove", 1]]);
// `-insert`/`-replace` with a container type take no value word.
const CONTAINER_TYPES = new Set(["-dictionary", "-array"]);
// Options that consume the next word.
const VALUE_OPTIONS = new Set(["-e", "-expect"]);

/** The editing verb of a plutil invocation that would write over its input file, or undefined. */
export function plutilInPlaceVerb(words: readonly string[]): string | undefined {
	if (words.length < 2 || commandName(words[0]!) !== "plutil") return undefined;
	const verb = words[1]!;
	const operands = VERB_OPERANDS.get(verb);
	if (operands === undefined) return undefined;
	// `-extract keypath raw` prints the value to stdout; only `-o` makes it write a file.
	if (verb === "-extract" && words[3] === "raw") return undefined;
	let index = 2 + operands;
	if ((verb === "-insert" || verb === "-replace") && CONTAINER_TYPES.has(words[3] ?? "")) index--;
	for (; index < words.length; index++) {
		const word = words[index]!;
		// Every word after `--` is a file name, so a later `-o` names an input.
		if (word === "--") break;
		if (word === "-o" && index + 1 < words.length) return undefined;
		if (VALUE_OPTIONS.has(word)) index++;
	}
	return verb;
}

function inPlaceReason(verb: string): string {
	return `fleet-guard PLUTIL_IN_PLACE: plutil ${verb} without -o writes its result over the input file (on 2026-10-21 \`plutil -extract ProgramArguments json <plist>\` rewrote 12 LaunchAgent plists as JSON arrays). Add \`-o -\` to print the result or \`-o <path>\` to write it elsewhere; \`-lint\`, \`-p\` and \`-extract <keypath> raw\` only read; no files were changed.`;
}

/** PLUTILINPLACE1 for any session; the fleet-guard extension and the conformance corpus dispatch this predicate. */
export function checkPlutilInPlace(event: FleetGuardEvent): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const inspection = executedShellCommands(command);
	// The rule runs outside the opt-in too, so text the lexer cannot delimit is refused only when it names plutil.
	if ("refusal" in inspection) return command.includes("plutil") ? { block: true, reason: inspection.refusal } : undefined;
	for (const { words } of inspection.commands) {
		const verb = plutilInPlaceVerb(words);
		if (verb) return { block: true, reason: inPlaceReason(verb) };
	}
	return undefined;
}
