import { open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { MineSourceContext } from "./mine.ts";
import { classifyMineResult } from "./mine-cause.ts";
import { captureMineReplay, type MineReplay } from "./mine-replay.ts";

const PRODUCER = "omp-transcript";
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function time(value: unknown): number | null {
	const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(n) ? n : null;
}
function content(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map(part => { const p = object(part); return p?.type === "text" ? text(p.text) : ""; }).filter(Boolean).join("\n");
}
function toolName(value: unknown): string { return (captureMineReplay({ tool: text(value) }).tool ?? "").replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "unknown"; }
function captureCallReplay(tool: string, args: unknown, cwd: string): MineReplay {
	const fields = object(args);
	return captureMineReplay({ tool, cwd, ...(args !== undefined ? { arguments: args } : {}),
		...(typeof fields?.message === "string" ? { message: fields.message } : {}),
		...(fields?.custody !== undefined ? { custody: fields.custody } : {}) });
}

/** Stream native session records; filenames and filesystem dates never determine event time. */
export async function mineTranscripts(ctx: MineSourceContext): Promise<void> {
	const canonical = async (path: string) => { try { return await realpath(path); } catch { return resolve(path); } };
	const projects = await Promise.all(ctx.projects.map(async p => ({ ...p, canonical: await canonical(p.path) })));
	const byCwd = (cwd: string) => projects.filter(p => [p.canonical, resolve(p.path)].some(root => cwd === root || cwd.startsWith(root + sep))).sort((a, b) => b.canonical.length - a.canonical.length)[0];
	const seen = new Set<string>(), visited = new Set<string>(), covered = new Set<string>();
	let files = 0;
	async function entries(path: string) {
		try { return await readdir(path, { withFileTypes: true }); }
		catch (error) { const cov = ctx.coverage(PRODUCER, path, `Cannot enumerate sessions: ${String(error)}`); cov.status = object(error)?.code === "ENOENT" ? "MISSING" : "PARTIAL"; return []; }
	}
	async function consume(path: string, rootProject: typeof projects[number] | undefined) {
		const physical = await canonical(path);
		if (visited.has(physical)) return;
		visited.add(physical);
		// Session artifact directories also hold regression corpora and captures named *.jsonl.
		// Admit the native session envelope before spending the shared streaming budget on a file.
		let native = false, headerProject: typeof projects[number] | undefined;
		try {
			const handle = await open(path, "r");
			try {
				const prefix = Buffer.alloc(65_536), read = await handle.read(prefix, 0, prefix.length, 0);
				for (const line of prefix.subarray(0, read.bytesRead).toString("utf8").split("\n")) {
					try { const header = object(JSON.parse(line)); if (header?.type === "session" && text(header.id) && text(header.cwd)) { native = true; headerProject = byCwd(resolve(text(header.cwd))); break; } } catch { /* Incomplete prefix or non-session artifact. */ }
				}
			} finally { await handle.close(); }
		} catch { const c = ctx.coverage(PRODUCER, path, "Native session header unreadable or changed during discovery"); c.status = "PARTIAL"; return; }
		if (!native) { ctx.coverage(PRODUCER, path, "Non-session artifact JSONL skipped: no native session header in bounded 64 KiB prefix."); return; }
		if (ctx.targetProject && headerProject?.path !== ctx.targetProject) return;
		if (headerProject) { covered.add(headerProject.path); ctx.markSource(headerProject.path, PRODUCER, 0); }
		if (ctx.skipFile?.(path)) { ctx.coverage(PRODUCER, path, "Complete unchanged event-time index and mapped native header prove no records in the requested UTC cell."); return; }
		let project = headerProject ?? rootProject, session = "", cwd = "", records = 0, gaps = 0, unmapped = 0, first: string | null = null, last: string | null = null;
		type CallContext = { name: string; start: number | null; replay: MineReplay; completedKind?: "message" | "execution" };
		const calls = new Map<string, CallContext>(), completed = new Map<string, CallContext>();
		let droppedContexts = 0;
		function rememberCall(id: string, call: CallContext): void {
			completed.delete(id);
			calls.delete(id);
			calls.set(id, call);
			if (calls.size > 256) { calls.delete(calls.keys().next().value!); droppedContexts++; }
		}
		const cov = await ctx.readLines(path, PRODUCER, (row, citation) => {
			if (row.type === "title") return; // Mutable display metadata has updatedAt, not an event timestamp.
			if (row.type === "session") {
				session = text(row.id) || text(row.sessionId);
				if (text(row.cwd)) { cwd = text(row.cwd); project = byCwd(resolve(cwd)); }
				return;
			}
			const message = object(row.message), data = object(row.data) ?? row;
			const t = time(row.timestamp ?? message?.timestamp);
			if (t === null) { gaps++; return; }
			const executionResult = object(data.result);
			const id = text(message?.toolCallId) || text(row.toolCallId) || text(data.tool_call_id) || text(data.toolCallId);
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					const call = object(part);
					if (call?.type === "toolCall" && text(call.id)) rememberCall(text(call.id), {
						name: toolName(call.name), start: calls.get(text(call.id))?.start ?? null,
						replay: captureCallReplay(toolName(call.name), call.arguments, cwd),
					});
				}
			}
			if (row.type === "tool_execution_start" && id) {
				const previous = calls.get(id);
				rememberCall(id, { name: toolName(data.toolName ?? data.name ?? previous?.name), start: t,
					replay: Object.hasOwn(data, "input") || !previous ? captureCallReplay(toolName(data.toolName ?? data.name ?? previous?.name), data.input, cwd) : previous.replay });
			}
			const result = message?.role === "toolResult" || row.type === "tool_execution_end";
			const call = calls.get(id) ?? completed.get(id);
			if (result && call) {
				const previous = completed.get(id), kind = message?.role === "toolResult" ? "message" : "execution";
				calls.delete(id);
				completed.delete(id);
				if (!previous || previous.completedKind === kind) completed.set(id, { ...call, completedKind: kind });
				// Native execution-end and persisted toolResult can describe the same call.
				// Keep bounded, sanitized context for either representation, including across UTC cells.
				if (completed.size > 256) completed.delete(completed.keys().next().value!);
			}
			if (t < ctx.since_ms || t >= ctx.until_ms) return;
			if (!project) { unmapped++; return; }
			records++;
			const iso = new Date(t).toISOString();
			if (first === null || iso < first) first = iso;
			if (last === null || iso > last) last = iso;
			const retainedResult = { ...data, ...(message?.role === "toolResult" ? message : executionResult) };
			const body = result ? content(message?.content ?? executionResult?.content ?? data.result ?? data.output) || text(data.message) || text(data.error)
				: message?.role === "user" ? content(message.content) : text(data.message) || text(data.reason);
			const name = toolName(message?.toolName ?? data.toolName ?? data.name ?? call?.name);
			let classId = "", summary = "";
			if (result) {
				const cause = classifyMineResult({ tool: name, result: retainedResult });
				if (cause) { classId = cause.class_id; summary = cause.summary; }
			} else if (message?.role === "user" && /^(?:no[,!\s]|stop\b|why did\b|that's wrong\b|that’s wrong\b|do not\b)/i.test(body.trim())) classId = "user-correction";
			else if ((/^(?:guard|refusal|hook)[._:-](?:refused|blocked|deny|denied|refusal)$/.test(text(row.type))
				|| (["guard", "refusal", "hook"].includes(text(row.type)) && ["refused", "blocked", "deny", "denied", "refusal"].includes(text(data.status) || text(data.outcome)))) && body) classId = `${data.act === "commit" ? "commit-refusal" : "guard-friction"}:${toolName(data.code ?? row.type)}`;
			if (!classId) return;
			const identity = `${PRODUCER}:${project.canonical}:${session}:${id || text(row.id) || createHash("sha256").update(`${t}:${classId}:${body}`).digest("hex")}:${classId}`;
			if (seen.has(identity)) return;
			seen.add(identity);
			const start = call?.start;
			const nested = executionResult ?? object(message?.result);
			const custody = retainedResult.custody ?? object(retainedResult.details)?.custody
				?? nested?.custody ?? object(nested?.details)?.custody ?? call?.replay.custody;
			const actualMessage = typeof retainedResult.commit_message === "string" ? retainedResult.commit_message : call?.replay.message;
			const replay = captureMineReplay({ tool: name, cwd, ...(call ? { arguments: call.replay.arguments } : {}),
				...(typeof actualMessage === "string" ? { message: actualMessage } : {}), ...(custody !== undefined && custody !== null ? { custody } : {}) });
			if (call) { replay.redacted ||= call.replay.redacted; replay.truncated ||= call.replay.truncated; }
			const safeSummary = captureMineReplay({ message: summary || (classId === "user-correction" ? "Heuristic user correction: " : "") + (body || `${name} reported an error`) }).message ?? "";
			ctx.emit({ class_id: classId, project: project.path, time_ms: t, producer: PRODUCER, citation,
				summary: safeSummary.replace(/\s+/g, " ").trim().slice(0, 400), ...(id || text(row.id) ? { event_id: id || text(row.id) } : {}), replay,
				measured_minutes: result && start !== null && start !== undefined && start <= t ? (t - start) / 60_000 : null, proxy_minutes: 0, identity });
		});
		cov.first_timestamp = first; cov.last_timestamp = last;
		// Preserve the shared reader's malformed/truncated status while exposing window-only counts.
		cov.rows = records;
		if (gaps || unmapped) { cov.status = "PARTIAL"; cov.detail += `; timestamp gaps=${gaps}; unmapped window records=${unmapped} (unconfigured cwd excluded)`; }
		if (droppedContexts) { cov.status = "PARTIAL"; cov.detail += `; bounded replay context evictions=${droppedContexts} (omitted inputs remain explicit)`; }
		if (project) { covered.add(project.path); ctx.markSource(project.path, PRODUCER, records); }
	}
	async function walk(path: string, project: typeof projects[number] | undefined, depth = 0): Promise<void> {
		if (ctx.expired() || depth > 32 || files >= 100_000) { const c = ctx.coverage(PRODUCER, path, "Transcript traversal limit/deadline reached"); c.status = "PARTIAL"; return; }
		for (const entry of (await entries(path)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			if (ctx.expired()) { const c = ctx.coverage(PRODUCER, path, "Transcript deadline reached"); c.status = "PARTIAL"; break; }
			const child = join(path, entry.name);
			if (entry.isDirectory() && !entry.name.endsWith(".log") && !entry.name.startsWith(".")) await walk(child, project, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) { files++; await consume(child, project); }
		}
	}
	const root = join(ctx.home, ".omp", "profiles");
	const roots: { path: string; project: typeof projects[number] }[] = [];
	for (const profile of (await entries(root)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		if (!profile.isDirectory()) continue;
		const sessions = join(root, profile.name, "agent", "sessions");
		for (const entry of (await entries(sessions)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			if (!entry.isDirectory() || entry.name.includes("-var-agent-tmp-")) continue;
			const expected = (p: typeof projects[number]) => [`-${relative(ctx.home, p.canonical).split(sep).join("-")}`, p.canonical.split(sep).join("-")];
			const exact = projects.filter(p => expected(p).includes(entry.name));
			const matches = exact.length ? exact : projects.filter(p => expected(p).some(name => entry.name.startsWith(name + "-")));
			const project = matches.sort((a, b) => b.canonical.length - a.canonical.length)[0];
			if (project) roots.push({ path: join(sessions, entry.name), project });
		}
	}
	// Mine all profiles for the explicitly uncovered projects before large already-normalized fleets.
	const priority = (p: typeof projects[number]) => ["jev", "localbench", "uds", "zestroku"].includes(basename(p.canonical)) ? 0 : 1;
	roots.sort((a, b) => priority(a.project) - priority(b.project) || (a.project.path < b.project.path ? -1 : a.project.path > b.project.path ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	for (const source of roots) {
		if (!ctx.targetProject) { covered.add(source.project.path); ctx.markSource(source.project.path, PRODUCER, 0); }
		ctx.coverage(PRODUCER, source.path, `Native project session directory: ${source.project.path}`);
		await walk(source.path, source.project);
	}
	for (const project of projects) if ((!ctx.targetProject || project.path === ctx.targetProject) && !covered.has(project.path)) {
		const cov = ctx.coverage(PRODUCER, project.path, "No mapped native transcript records discovered"); cov.status = "MISSING";
	}
}
