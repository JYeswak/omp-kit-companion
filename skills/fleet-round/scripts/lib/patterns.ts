// Every regular expression the fleet-round validator ships. Each one is anchored, gives each
// repeated span exclusive ownership of its characters, and only ever runs on text already capped
// by matchLine(), so a near-miss costs at most O(cap). references/regex-conformance.json pins each
// pattern's exact source and flags with positive, negative and pumped near-miss cases; the test
// suite refuses a pattern here that the conformance file does not pin.

/** Longest line (UTF-16 units) any pattern is applied to. Longer lines never match. */
export const MAX_LINE = 4096;

/**
 * A report's labeled line: `KEY: value` or `KEY id: value`. KEY is upper snake case (ROUND,
 * PROJECT, PREDICTION, CLAIM, ...); the optional id names a prediction or claim. The single
 * space before the id and the `[ \t]+` / `[^ \t\n]` split around the value are disjoint, so the
 * match is linear in the line length.
 */
export const LABEL_LINE = /^([A-Z][A-Z_]{0,31})(?: ([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?:[ \t]+([^ \t\n][^\n]*)$/;

/** A CLAIM line's value: `metric = value` plus optional free text after whitespace. */
export const CLAIM_VALUE = /^([a-z][a-z0-9_]{0,63})[ \t]*=[ \t]*([^ \t\n=]{1,128})(?:[ \t]+[^\n]*)?$/;

/** A tmux seat `session:window.pane` (tmux replaces `:` and `.` in session names, so neither can appear). */
export const SEAT = /^([A-Za-z0-9_][A-Za-z0-9_-]{0,63}):(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

/** A `path:line` citation; the path itself is validated segment by segment in code, not here. */
export const CITATION = /^([^:\s]{1,1024}):([1-9][0-9]{0,6})$/;

/** A non-negative round number without leading zeros. */
export const ROUND_NUMBER = /^(0|[1-9][0-9]{0,5})$/;

/** First line of a kit-callback DONE comment: `DONE <bead> <sha> ...`. */
export const DONE_CALLBACK = /^DONE[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+([0-9a-f]{7,40})(?:[ \t][^\n]*)?$/;

/** First line of a recorded no-epic reason comment: `no-epic: <reason>`. */
export const NO_EPIC = /^no-epic:[ \t]+([^ \t\n][^\n]*)$/;

/** All shipped patterns by name, for the conformance pin check. */
export const PATTERNS: Record<string, RegExp> = { LABEL_LINE, CLAIM_VALUE, SEAT, CITATION, ROUND_NUMBER, DONE_CALLBACK, NO_EPIC };

/** Match a pattern only after bounding the input; an overlong line is a non-match, never a scan. */
export function matchLine(pattern: RegExp, line: string): RegExpExecArray | null {
	if (line.length > MAX_LINE) return null;
	return pattern.exec(line);
}

/** First line of a multi-line text, without its terminator. */
export function firstLine(text: string): string {
	const end = text.indexOf("\n");
	const line = end < 0 ? text : text.slice(0, end);
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
