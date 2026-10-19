// Native leg of the post-compaction reread gate (ompkit-xa5s.24 AC4).
// Spawned by compact-reread.e2e.sh; drives one owned `omp --mode=rpc` child.
// Usage: bun compact-reread.drive.ts <work-dir> <guard.ts> <fake-br>
// The fake br is invoked by absolute path: omp's bash tool rebuilds PATH from the
// login shell, and the guard matches the executable basename. OMP_E2E_PROFILE /
// OMP_E2E_MODEL optional.
// Writes <work>/report.json; prints one JSON summary line; exit 0 PASS, 1 FAIL,
// 3 INCONCLUSIVE (the model never issued a write call a step needed, so the guard
// was never exercised there: that is neither a block nor an allow).
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [work, guard, br] = process.argv.slice(2);
if (!work || !guard || !br) throw new Error("usage: bun compact-reread.drive.ts <work-dir> <guard.ts> <fake-br>");
const proj = join(work, "proj");
const sessions = join(work, "sessions");
mkdirSync(sessions, { recursive: true });
const log = join(work, "rpc.jsonl");
writeFileSync(log, "");
const target = join(proj, "target.txt");
const agents = join(proj, "AGENTS.md");
writeFileSync(target, "original\n");

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v !== undefined && !["AGENT_NAME", "BR_ACTOR", "BR_AGENT_NAME", "TMUX_PANE", "TMUX"].includes(k)) env[k] = v;
}
env.AGENT_NAME = "NativeProbe";
env.TMPDIR = work;
const argv = ["omp", "--mode=rpc", "--no-ui", "--no-extensions", "-e", guard, "--session-dir", sessions, "--max-time=900"];
if (process.env.OMP_E2E_PROFILE) argv.splice(1, 0, "--profile", process.env.OMP_E2E_PROFILE);
if (process.env.OMP_E2E_MODEL) argv.splice(1, 0, "--model", process.env.OMP_E2E_MODEL);
appendFileSync(log, JSON.stringify({ argv, cwd: proj }) + "\n");

type Frame = { type?: string; id?: string; toolName?: string; isError?: boolean; status?: string; success?: boolean;
	data?: { tokensBefore?: number };
	result?: { content?: unknown; details?: { truncation?: { truncated?: boolean }; meta?: { limits?: { columnTruncated?: unknown } } } } };
const t0 = performance.now();
const child = Bun.spawn(argv, { cwd: proj, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const frames: Frame[] = [];
const waiters: { pred: (f: Frame) => boolean; res: (f: Frame) => void }[] = [];
(async () => {
	let buf = "";
	const dec = new TextDecoder();
	for await (const chunk of child.stdout) {
		buf += dec.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			appendFileSync(log, line + "\n");
			let f: Frame; try { f = JSON.parse(line) as Frame; } catch { continue; }
			frames.push(f);
			for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.res(f); }
		}
	}
})();
(async () => { writeFileSync(join(work, "stderr.log"), await new Response(child.stderr).text()); })();
const waitFor = (pred: (f: Frame) => boolean, ms = 300_000) => new Promise<Frame>((res, rej) => {
	const hit = frames.find(pred); if (hit) return res(hit);
	waiters.push({ pred, res }); setTimeout(() => rej(new Error("TIMEOUT")), ms);
});
let n = 0;
const cmd = (f: Record<string, unknown>, ms?: number) => {
	const id = `c${++n}`;
	child.stdin.write(JSON.stringify({ ...f, id }) + "\n");
	return waitFor(x => x.type === "response" && x.id === id, ms);
};
/** `cut`: OMP marked the shown result as display-truncated (a line cut to its column cap, or the whole output). */
type Step = { status: unknown; ends: { tool?: string; isError?: boolean; cut: boolean; text: string }[] };
async function prompt(message: string): Promise<Step> {
	const id = `p${++n}`; const start = frames.length;
	child.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
	const result = await waitFor(x => x.type === "prompt_result" && x.id === id);
	const ends = frames.slice(start).filter(x => x.type === "tool_execution_end")
		.map(x => ({ tool: x.toolName, isError: x.isError, text: JSON.stringify(x.result?.content ?? x.result).slice(0, 400),
			cut: x.result?.details?.meta?.limits?.columnTruncated !== undefined || x.result?.details?.truncation?.truncated === true }));
	return { status: result.status ?? result, ends };
}
const lastWrite = (s: Step) => s.ends.filter(e => e.tool === "write").at(-1);
const only = "Make exactly the tool calls described, nothing else, then reply DONE.";
const noWrite = "Do not attempt any write.";
const WRITE_ATTEMPTS = 3;
/**
 * Ask for one write until the model actually issues a write call, at most WRITE_ATTEMPTS prompts.
 * The wording is neutral: no "do not read" order competing with the guard's reread reminder.
 * `first`: the write was the step's first tool call. When the model obeys the guard's reminder and
 * rereads before writing, the gate may legitimately clear first, so that step cannot probe the armed gate.
 */
async function tryWrite(line: string): Promise<{ step: Step; attempts: number; attempted: boolean; first: boolean }> {
	let step: Step = { status: null, ends: [] };
	for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
		step = await prompt(`Use the write tool now to overwrite ${target} with the single line: ${line}. If the write tool returns an error, reply with that error and stop; do not retry it. ${only}`);
		if (lastWrite(step) !== undefined) return { step, attempts: attempt, attempted: true, first: step.ends[0]?.tool === "write" };
	}
	return { step, attempts: WRITE_ATTEMPTS, attempted: false, first: false };
}

const report: Record<string, unknown> = { argv, cwd: proj, guard };
let code = 1;
try {
	await waitFor(x => x.type === "ready", 60_000);
	report.startupMs = Math.round(performance.now() - t0);
	await cmd({ type: "negotiate_protocol", protocolVersion: 2 });
	const pre = await tryWrite("pre");
	const preText = readFileSync(target, "utf8");
	await prompt(`Use the read tool to read ${join(proj, "big.txt")} and then summarise it in one sentence. ${only}`);
	const compact = await cmd({ type: "compact" }, 300_000);
	report.compact = { success: compact.success, tokensBefore: compact.data?.tokensBefore };
	const blocked = await tryWrite("blocked-attempt");
	const blockedText = readFileSync(target, "utf8");
	// Planted negative: AGENTS.md read plus plain-text `br show` must NOT clear the gate.
	const plain = await prompt(`Use the read tool on exactly the path ${agents}, then use the bash tool to run exactly: ${br} show kn-9jr. ${noWrite} ${only}`);
	const stillBlocked = await tryWrite("plain-attempt");
	const plainText = readFileSync(target, "utf8");
	// The fake br's --json row is over 768 bytes, so OMP shows it cut; only the guard's own confirmation can clear.
	const brCallsBefore = readFileSync(`${br}.calls`, "utf8").trim().split("\n").filter(Boolean).length;
	const json = await prompt(`Use the bash tool to run exactly: ${br} show kn-9jr --json. ${noWrite} ${only}`);
	const allowed = await tryWrite("after");
	const afterText = readFileSync(target, "utf8");
	const blockReason = lastWrite(blocked.step)?.text ?? "";
	const brCalls = readFileSync(`${br}.calls`, "utf8").trim().split("\n").filter(Boolean);
	const attempts = { pre: pre.attempts, blocked: blocked.attempts, stillBlocked: stillBlocked.attempts, allowed: allowed.attempts };
	// Exercised: a write was issued; for the armed-gate probes it was also the step's first tool call, and the
	// planted negative only probes an armed gate if the first probe did.
	const exercised = {
		pre: pre.attempted,
		blocked: blocked.attempted && blocked.first,
		stillBlocked: blocked.attempted && blocked.first && stillBlocked.attempted && stillBlocked.first,
		allowed: allowed.attempted,
	};
	const unexercised = Object.entries(exercised).filter(([, ok]) => !ok).map(([name]) => name);
	// File contents compare trimmed: the model may write "pre" with or without a trailing newline; that is not a guard outcome.
	const verdict = {
		falseBlocks: pre.attempted ? (lastWrite(pre.step)?.isError === false && preText.trim() === "pre" ? 0 : 1) : null,
		compacted: compact.success === true,
		blockedAfterCompact: blocked.attempted && lastWrite(blocked.step)?.isError === true && blockReason.includes("COMPACTION_REREAD") && blockedText.trim() === "pre",
		plainBrShowRan: plain.ends.some(e => e.tool === "bash" && e.isError === false),
		plainTextStaysBlocked: stillBlocked.attempted && lastWrite(stillBlocked.step)?.isError === true && plainText.trim() === "pre",
		jsonBrShowRan: json.ends.some(e => e.tool === "bash" && e.isError === false),
		jsonShownTruncated: json.ends.some(e => e.tool === "bash" && e.isError === false && e.cut),
		guardConfirmedOwnership: brCalls.slice(brCallsBefore).some(c => c === "show kn-9jr --json --no-auto-import --no-auto-flush"),
		allowedAfterJsonReread: allowed.attempted && lastWrite(allowed.step)?.isError === false && afterText.trim() === "after",
	};
	Object.assign(report, { pre, blocked, plain, stillBlocked, json, allowed, attempts, exercised, unexercised, verdict, blockReason });
	const sessionText = readdirSync(sessions).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(join(sessions, f), "utf8")).join("\n");
	report.fakeBrCalls = brCalls;
	report.compactionEntries = (sessionText.match(/"type":"compaction"/g) ?? []).length;
	const pass = verdict.falseBlocks === 0 && verdict.compacted && verdict.blockedAfterCompact
		&& verdict.plainBrShowRan && verdict.plainTextStaysBlocked && verdict.jsonBrShowRan && verdict.jsonShownTruncated
		&& verdict.guardConfirmedOwnership && verdict.allowedAfterJsonReread;
	// A step that never probed what it names exercised nothing: INCONCLUSIVE, unless an exercised step FAILED outright.
	const failedOutright = (exercised.pre && verdict.falseBlocks !== 0) || (exercised.blocked && !verdict.blockedAfterCompact)
		|| (exercised.stillBlocked && !verdict.plainTextStaysBlocked)
		|| (exercised.blocked && exercised.stillBlocked && exercised.allowed && !verdict.allowedAfterJsonReread);
	report.result = pass ? "PASS" : unexercised.length > 0 && !failedOutright ? "INCONCLUSIVE" : "FAIL";
	code = report.result === "PASS" ? 0 : report.result === "INCONCLUSIVE" ? 3 : 1;
} catch (error) {
	report.result = "FAIL";
	report.error = error instanceof Error ? error.message : String(error);
} finally {
	child.kill();
}
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
const v = report.verdict as Record<string, unknown> | undefined;
console.log(JSON.stringify({ result: report.result, startupMs: report.startupMs, falseBlocks: v?.falseBlocks ?? null,
	compact: report.compact, compactionEntries: report.compactionEntries, fakeBrCalls: report.fakeBrCalls, unexercised: report.unexercised ?? null,
	verdict: v ?? null, error: report.error ?? null, guard }));
process.exit(code);
