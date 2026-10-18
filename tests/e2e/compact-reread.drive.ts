// Native leg of the post-compaction reread gate (ompkit-xa5s.24 AC4).
// Spawned by compact-reread.e2e.sh; drives one owned `omp --mode=rpc` child.
// Usage: bun compact-reread.drive.ts <work-dir> <guard.ts> <fake-br>
// The fake br is invoked by absolute path: omp's bash tool rebuilds PATH from the
// login shell, and the guard matches the executable basename. OMP_E2E_PROFILE /
// OMP_E2E_MODEL optional.
// Writes <work>/report.json; prints one JSON summary line; exit 0 PASS, 1 FAIL.
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
	data?: { tokensBefore?: number }; result?: { content?: unknown } };
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
type Step = { status: unknown; ends: { tool?: string; isError?: boolean; text: string }[] };
async function prompt(message: string): Promise<Step> {
	const id = `p${++n}`; const start = frames.length;
	child.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
	const result = await waitFor(x => x.type === "prompt_result" && x.id === id);
	const ends = frames.slice(start).filter(x => x.type === "tool_execution_end")
		.map(x => ({ tool: x.toolName, isError: x.isError, text: JSON.stringify(x.result?.content ?? x.result).slice(0, 400) }));
	return { status: result.status ?? result, ends };
}
const lastWrite = (s: Step) => s.ends.filter(e => e.tool === "write").at(-1);
const only = "Make exactly the tool calls described, nothing else, then reply DONE.";
const noWrite = "Do not attempt any write.";
const tryWrite = (line: string) => prompt(`Do NOT read any file. Immediately use the write tool to overwrite ${target} with the single line: ${line}. If it is refused, do not retry and do nothing else. Reply DONE.`);

const report: Record<string, unknown> = { argv, cwd: proj, guard };
let code = 1;
try {
	await waitFor(x => x.type === "ready", 60_000);
	report.startupMs = Math.round(performance.now() - t0);
	await cmd({ type: "negotiate_protocol", protocolVersion: 2 });
	const pre = await prompt(`Use the write tool to overwrite ${target} with the single line: pre. ${only}`);
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
	const json = await prompt(`Use the bash tool to run exactly: ${br} show kn-9jr --json. ${noWrite} ${only}`);
	const allowed = await prompt(`Use the write tool to overwrite ${target} with the single line: after. ${only}`);
	const afterText = readFileSync(target, "utf8");
	const blockReason = lastWrite(blocked)?.text ?? "";
	const verdict = {
		falseBlocks: lastWrite(pre)?.isError === false && preText === "pre\n" ? 0 : 1,
		compacted: compact.success === true,
		blockedAfterCompact: lastWrite(blocked)?.isError === true && blockReason.includes("COMPACTION_REREAD") && blockedText === "pre\n",
		plainBrShowRan: plain.ends.some(e => e.tool === "bash" && e.isError === false),
		plainTextStaysBlocked: lastWrite(stillBlocked)?.isError === true && plainText === "pre\n",
		jsonBrShowRan: json.ends.some(e => e.tool === "bash" && e.isError === false),
		allowedAfterJsonReread: lastWrite(allowed)?.isError === false && afterText === "after\n",
	};
	Object.assign(report, { pre, blocked, plain, stillBlocked, json, allowed, verdict, blockReason });
	const sessionText = readdirSync(sessions).filter(f => f.endsWith(".jsonl")).map(f => readFileSync(join(sessions, f), "utf8")).join("\n");
	report.fakeBrCalls = readFileSync(`${br}.calls`, "utf8").trim().split("\n").filter(Boolean);
	report.compactionEntries = (sessionText.match(/"type":"compaction"/g) ?? []).length;
	const pass = verdict.falseBlocks === 0 && verdict.compacted && verdict.blockedAfterCompact
		&& verdict.plainBrShowRan && verdict.plainTextStaysBlocked && verdict.jsonBrShowRan && verdict.allowedAfterJsonReread;
	code = pass ? 0 : 1;
	report.result = pass ? "PASS" : "FAIL";
} catch (error) {
	report.result = "FAIL";
	report.error = error instanceof Error ? error.message : String(error);
} finally {
	child.kill();
}
writeFileSync(join(work, "report.json"), JSON.stringify(report, null, 2));
const v = report.verdict as Record<string, unknown> | undefined;
console.log(JSON.stringify({ result: report.result, startupMs: report.startupMs, falseBlocks: v?.falseBlocks ?? null,
	compact: report.compact, compactionEntries: report.compactionEntries, fakeBrCalls: report.fakeBrCalls, verdict: v ?? null, error: report.error ?? null, guard }));
process.exit(code);
