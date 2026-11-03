import { open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { MineSourceContext } from "./mine.ts";

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
function snippet(value: string): string {
	return value.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+[^\s]+)\b/gi, "[REDACTED]")
		.replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]").replace(/\s+/g, " ").trim().slice(0, 400);
}
function toolName(value: unknown): string { return text(value).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) || "unknown"; }

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
		let native = false;
		try {
			const handle = await open(path, "r");
			try {
				const prefix = Buffer.alloc(65_536), read = await handle.read(prefix, 0, prefix.length, 0);
				for (const line of prefix.subarray(0, read.bytesRead).toString("utf8").split("\n")) {
					try { const header = object(JSON.parse(line)); if (header?.type === "session" && text(header.id) && text(header.cwd)) { native = true; break; } } catch { /* Incomplete prefix or non-session artifact. */ }
				}
			} finally { await handle.close(); }
		} catch { const c = ctx.coverage(PRODUCER, path, "Native session header unreadable or changed during discovery"); c.status = "PARTIAL"; return; }
		if (!native) { ctx.coverage(PRODUCER, path, "Non-session artifact JSONL skipped: no native session header in bounded 64 KiB prefix."); return; }
		let project = rootProject, session = "", records = 0, gaps = 0, unmapped = 0, first: string | null = null, last: string | null = null;
		const calls = new Map<string, { name: string; start: number | null }>();
		const cov = await ctx.readLines(path, PRODUCER, (row, citation) => {
			if (row.type === "title") return; // Mutable display metadata has updatedAt, not an event timestamp.
			if (row.type === "session") {
				session = text(row.id) || text(row.sessionId);
				if (text(row.cwd)) project = byCwd(resolve(text(row.cwd)));
				return;
			}
			const message = object(row.message), data = object(row.data) ?? row;
			const t = time(row.timestamp ?? message?.timestamp);
			if (t === null) { gaps++; return; }
			const executionResult = object(data.result);
			const id = text(message?.toolCallId) || text(row.toolCallId) || text(data.tool_call_id) || text(data.toolCallId);
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) { const call = object(part); if (call?.type === "toolCall" && text(call.id)) calls.set(text(call.id), { name: toolName(call.name), start: null }); }
			}
			if (row.type === "tool_execution_start" && id) calls.set(id, { name: toolName(data.toolName ?? data.name ?? calls.get(id)?.name), start: t });
			if (t < ctx.since_ms || t >= ctx.until_ms) return;
			if (!project) { unmapped++; return; }
			records++;
			const iso = new Date(t).toISOString();
			if (first === null || iso < first) first = iso;
			if (last === null || iso > last) last = iso;
			const result = message?.role === "toolResult" || row.type === "tool_execution_end";
			const body = (result ? content(message?.content ?? executionResult?.content ?? data.result ?? data.output) || text(data.message) || text(data.error) : message?.role === "user" ? content(message.content) : text(data.message) || text(data.reason)).slice(0, 65_536);
			const name = toolName(message?.toolName ?? data.toolName ?? data.name ?? calls.get(id)?.name);
			let classId = "";
			if (result) {
				const refusal = body.match(/(?:^|\n)\s*(?:(?:omp-kit|commit)[ :\-]+)?(MEMBER_REFUSED|REFUSED)\b/);
				if (refusal && (name === "bash" || name === "shell" || name === "commit" || message?.isError === true || executionResult?.isError === true || data.isError === true)) classId = `commit-refusal:${refusal[1]}`;
				else if (/\b(?:timed out|timeout|deadline exceeded)\b/i.test(body) && (message?.isError === true || executionResult?.isError === true || data.isError === true || data.is_error === true || /^(?:error:|command timed out|execution timed out)/i.test(body.trim()))) classId = `timeout:${name}`;
				else if (message?.isError === true || executionResult?.isError === true || data.isError === true || data.is_error === true || data.success === false) classId = `tool-error:${name}`;
			} else if (message?.role === "user" && /^(?:no[,!\s]|stop\b|why did\b|that's wrong\b|that’s wrong\b|do not\b)/i.test(body.trim())) classId = "user-correction";
			else if ((/^(?:guard|refusal|hook)[._:-](?:refused|blocked|deny|denied|refusal)$/.test(text(row.type))
				|| (["guard", "refusal", "hook"].includes(text(row.type)) && ["refused", "blocked", "deny", "denied", "refusal"].includes(text(data.status) || text(data.outcome)))) && body) classId = `guard-refusal:${toolName(data.code ?? row.type)}`;
			if (!classId) return;
			const identity = `${PRODUCER}:${project.canonical}:${session}:${id || text(row.id) || createHash("sha256").update(`${t}:${classId}:${body}`).digest("hex")}:${classId}`;
			if (seen.has(identity)) return;
			seen.add(identity);
			const start = calls.get(id)?.start;
			ctx.emit({ class_id: classId, project: project.path, time_ms: t, producer: PRODUCER, citation,
				summary: snippet((classId === "user-correction" ? "Heuristic user correction: " : "") + (body || `${name} reported an error`)),
				measured_minutes: result && start !== null && start !== undefined && start <= t ? (t - start) / 60_000 : null, proxy_minutes: 0, identity });
		});
		cov.first_timestamp = first; cov.last_timestamp = last;
		// Preserve the shared reader's malformed/truncated status while exposing window-only counts.
		cov.rows = records;
		if (gaps || unmapped) { cov.status = "PARTIAL"; cov.detail += `; timestamp gaps=${gaps}; unmapped window records=${unmapped} (unconfigured cwd excluded)`; }
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
		covered.add(source.project.path); ctx.markSource(source.project.path, PRODUCER, 0);
		ctx.coverage(PRODUCER, source.path, `Native project session directory: ${source.project.path}`);
		await walk(source.path, source.project);
	}
	for (const project of projects) if (!covered.has(project.path)) {
		const cov = ctx.coverage(PRODUCER, project.path, "No mapped native transcript records discovered"); cov.status = "MISSING";
	}
}
