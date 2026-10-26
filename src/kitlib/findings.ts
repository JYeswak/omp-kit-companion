/**
 * kitlib/findings: the FINDING line grammar hook members print and the envelope `omp-kit preflight` and the
 * chain runner share (GATEDIAG1, ompkit-fp72.135.3.16; plan section 23.3). Mirrors scripts/kitlib_findings.py.
 *
 * Line: FINDING<TAB>gate<TAB>code<TAB>detail<TAB>remedy<TAB>fix  (fix is "-" when there is no ready argv).
 * A member prints every finding, then exits 0; a non-zero exit means it could not judge (UNJUDGED).
 */
export interface Finding {
	gate: string;
	code: string;
	detail: string;
	remedy: string;
	fix: string[] | null;
	blocking: boolean;
}

export type PreflightAct = "commit" | "publish" | "claim" | "in-review" | "close" | "scratch-release";

export interface Envelope {
	ok: boolean;
	act: PreflightAct;
	target: string | null;
	/** What the findings were judged against (commit: the staged tree id; bead acts: the bead's updated_at). */
	snapshot: string;
	findings: Finding[];
}

const PREFIX = "FINDING\t";

export function parseFindingLines(text: string, blocking = true): Finding[] {
	const out: Finding[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith(PREFIX)) continue;
		const parts = line.split("\t");
		if (parts.length < 6) continue;
		const fix = parts[5]!.trim();
		out.push({ gate: parts[1]!, code: parts[2]!, detail: parts[3]!, remedy: parts[4]!, fix: fix === "" || fix === "-" ? null : fix.split(" "), blocking });
	}
	return out;
}

export function formatFindingLine(f: Finding): string {
	const clean = (s: string) => s.replace(/[\t\r\n]/g, " ");
	return [PREFIX.trimEnd(), clean(f.gate), clean(f.code), clean(f.detail), clean(f.remedy), f.fix ? clean(f.fix.join(" ")) : "-"].join("\t");
}

/** A member that could not judge: one blocking finding naming it, never a silent pass. */
export function unjudged(member: string, exit: number | null, lastLine: string): Finding {
	return { gate: member, code: "UNJUDGED", detail: lastLine || `exit ${exit ?? "signal"} with no message`, remedy: "fix the member's prerequisite, then retry", fix: null, blocking: true };
}

export function envelope(act: PreflightAct, target: string | null, snapshot: string, findings: Finding[]): Envelope {
	return { ok: !findings.some(f => f.blocking), act, target, snapshot, findings };
}

export function renderEnvelope(env: Envelope): string {
	if (env.ok) return `${env.act}: ok (${env.snapshot})`;
	const lines = [`${env.act} REFUSED: ${env.findings.length} finding(s); fix every one, then retry once (${env.snapshot}):`];
	for (const f of env.findings) {
		lines.push(`  ${f.gate} ${f.code}: ${f.detail}`, `    remedy: ${f.remedy}`);
		if (f.fix) lines.push(`    fix: ${f.fix.join(" ")}`);
	}
	return lines.join("\n");
}
