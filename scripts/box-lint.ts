#!/usr/bin/env bun
/**
 * box-lint.ts — acceptance replayability for bead admission (REPLAYABLE1 ompkit-fp72.135.3.71).
 *
 * bead_lint.py (the create and update lint) runs this entry instead of keeping a second copy of the
 * box grammar: every judgment here is src/verify.ts's own parseBoxes, commandOf, expectedOf and
 * unreplayableReason, the functions `omp-kit verify` replays and refuses ACCEPTANCE_NOT_REPLAYABLE by.
 * The release ships this file bundled (scripts/package-release.ts), run by the release binary with
 * BUN_BE_BUN=1, so the installed lint and the installed verb carry the same code.
 *
 * stdin:  {"items": [{"id": str, "acceptance": str, "baseline": str | null}]}
 * stdout: {"schema": "box-lint/v1", "items": [{"id", "boxes", "replayable", "refused", "legacy", "exit_only"}]}
 * `baseline` is the acceptance before the write (null for a create). A non-`[v]` box verify cannot replay
 * is `refused` when it is new or changed against the baseline and `legacy` when it is unchanged, so a
 * legacy bead is reported and never refused. `exit_only` lists replayable boxes with no expected outcome.
 * Exit 0 with the verdict; exit 2 on unreadable input.
 */
import { expectedOf, parseBoxes, unreplayableReason, type Box } from "../src/verify.ts";

interface Item { id: string; acceptance: string; baseline: string | null }
type Reason = "unsupported-phase" | "no-command" | "command-not-followed-by-expected";
interface Finding { index: number; letter: string | null; phase: string | null; reason: Reason; line: string; detail: string }

const PHASES = ["build", "landed", "live", "after"];
/** A box's identity across a write: its tags and body, not its checked state or position. */
const key = (box: Box) => JSON.stringify([box.letter, box.phase, box.body]);

function correctedShape(box: Box): string {
	const words = (box.phase ?? "").split(/[\s,;]+/);
	const phase = PHASES.find(name => words.includes(name)) ?? "build";
	const letter = box.letter ?? (/^[a-z](?=[\s,;]|$)/.exec(box.phase ?? "")?.[0] ?? "a");
	return `- [ ] [${letter}] [${phase}] <what it proves> \`<one bounded command>\` -> rc 0 (or: N pass 0 fail, prints <text>)`;
}

function finding(box: Box, reason: Reason): Finding {
	const why = reason === "unsupported-phase"
		? "has a tag run that is not one scope letter a-z then one phase (build, landed, live, after)"
		: reason === "no-command"
			? "names no backticked command"
			: "has a first backticked span not followed by -> <expected> or expect: <expected>, so verify would run that text unjudged; quote an obligation's own backticks with single quotes, or put Replay `<cmd>` -> <expected>; first";
	return { index: box.index, letter: box.letter, phase: box.phase, reason, line: box.line, detail: `box ${box.index} ${JSON.stringify(box.line)} ${why}; corrected shape: ${correctedShape(box)}` };
}

export function judgeItem(item: Item) {
	const boxes = parseBoxes(item.acceptance).filter(box => box.letter !== "v");
	const before = new Set(item.baseline === null ? [] : parseBoxes(item.baseline).map(key));
	const refused: Finding[] = [];
	const legacy: Finding[] = [];
	const exitOnly: number[] = [];
	for (const box of boxes) {
		const reason = unreplayableReason(box);
		if (reason === null) {
			if (expectedOf(box.body) === null) exitOnly.push(box.index);
			continue;
		}
		(before.has(key(box)) ? legacy : refused).push(finding(box, reason));
	}
	const replayable = boxes.length > 0 && refused.length === 0 && legacy.length === 0;
	return { id: item.id, boxes: boxes.length, replayable, refused, legacy, exit_only: exitOnly };
}

if (import.meta.main) {
	let items: Item[];
	try {
		const doc = JSON.parse(await Bun.stdin.text()) as { items?: unknown };
		if (!Array.isArray(doc.items)) throw new Error("items must be an array");
		items = doc.items.map((raw, n) => {
			const row = raw as Partial<Item>;
			if (typeof row.acceptance !== "string" || (row.baseline !== null && row.baseline !== undefined && typeof row.baseline !== "string")) throw new Error(`item ${n}: acceptance must be a string and baseline a string or null`);
			return { id: String(row.id ?? n), acceptance: row.acceptance, baseline: row.baseline ?? null };
		});
	} catch (error) {
		process.stderr.write(`box-lint: BOX_LINT_INPUT_INVALID ${(error as Error).message}\n`);
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify({ schema: "box-lint/v1", items: items.map(judgeItem) })}\n`);
}
