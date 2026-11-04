import { open, readdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { enforcement, type MineSourceContext, type MineEvidence, type MineWaste } from "./mine.ts";
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
function commitSubject(replay: MineReplay): string | null {
	const args = object(replay.arguments), command = (text(args?.command) || text(args?.code)).slice(0, 65_536);
	if (!/\bgit\s+commit\b|["']git["']\s*,\s*["']commit["']/.test(command)) return null;
	const label = text(args?.title), prefix = ["Commit ", "Retry ", "Retrying "].find(value => label.startsWith(value));
	return ((prefix ? label.slice(prefix.length) : label) || /(?:-m\s+|msg\s*=\s*)(?:'''|"""|["'])([^\n"']+)/.exec(command)?.[1]
		|| /-F\s+([^\s;&]+)/.exec(command)?.[1] || "commit without retained subject").slice(0, 200);
}
function safe(value: string): string {
	return (captureMineReplay({ message: value }).message ?? "[Unavailable cause]").replace(/\s+/g, " ").slice(0, 400);
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
		const fallback = rootProject?.path === "@unattributed" ? rootProject : undefined;
		if (ctx.targetProject && (headerProject ?? fallback)?.path !== ctx.targetProject) return;
		if (headerProject) { covered.add(headerProject.path); ctx.markSource(headerProject.path, PRODUCER, 0); }
		if (ctx.skipFile?.(path)) { ctx.coverage(PRODUCER, path, "Complete unchanged event-time index and mapped native header prove no records in the requested UTC cell."); return; }
		let project = headerProject ?? rootProject, session = "", cwd = "", records = 0, gaps = 0, unmapped = 0, first: string | null = null, last: string | null = null;
		type CallContext = { name: string; start: number | null; replay: MineReplay; issued?: number; tokensBefore?: number; completedKind?: "message" | "execution" };
		const calls = new Map<string, CallContext>(), completed = new Map<string, CallContext>();
		const background = new Map<string, string>(), wasteResults = new Set<string>();
		const commits = new Map<string, { first: number; tokensBefore: number; reasons: string[]; evidence: MineEvidence[] }>();
		const agentBriefs = new Map<string, { id: string; causes: string[]; evidence: MineEvidence[]; at: number }>();
		let recordedTokens = 0, hasTokens = false, droppedContexts = 0;
		function rememberCall(id: string, call: CallContext): void {
			completed.delete(id);
			calls.delete(id);
			calls.set(id, call);
			if (calls.size > 256) { calls.delete(calls.keys().next().value!); droppedContexts++; }
		}
		const cov = await ctx.readLines(path, PRODUCER, (row, citation) => {
			const rowType = text(row.customType) || row.type;
			if (row.type === "title") return; // Mutable display metadata has updatedAt, not an event timestamp.
			if (row.type === "session") {
				session = text(row.id) || text(row.sessionId);
				if (text(row.cwd)) { cwd = text(row.cwd); project = byCwd(resolve(cwd)) ?? fallback; }
				return;
			}
			const message = object(row.message), data = object(row.data) ?? row;
			const t = time(row.timestamp ?? message?.timestamp);
			if (t === null) { gaps++; return; }
			const executionResult = object(data.result);
			const asyncBody = rowType === "async-result" ? content(row.content) : "";
			const asyncJob = /Background job (bg_\d+) has completed/.exec(asyncBody)?.[1];
			const id = (asyncJob ? background.get(asyncJob) : undefined) || text(message?.toolCallId) || text(row.toolCallId) || text(data.tool_call_id) || text(data.toolCallId);
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content) {
					const call = object(part);
					if (call?.type === "toolCall" && text(call.id)) rememberCall(text(call.id), {
						name: toolName(call.name), start: calls.get(text(call.id))?.start ?? null,
						replay: captureCallReplay(toolName(call.name), call.arguments, cwd), issued: t, tokensBefore: recordedTokens,
					});
					if (call?.type === "toolCall" && toolName(call.name) === "task") {
						const args = object(call.arguments);
						for (const value of Array.isArray(args?.tasks) ? args.tasks : []) {
							const task = object(value), agent = text(task?.name);
							if (agent && !agentBriefs.get(agent)?.causes.length && agentBriefs.size < 2048) agentBriefs.set(agent, { id: `${text(call.id)}:${agent}`, causes: [], evidence: [], at: t });
						}
					}
				}
				const tokens = object(message.usage)?.totalTokens;
				if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) { recordedTokens += tokens; hasTokens = true; }
			}
			if (rowType === "tool_execution_start" && id) {
				const previous = calls.get(id);
				rememberCall(id, { name: toolName(data.toolName ?? data.name ?? previous?.name), start: t,
					replay: Object.hasOwn(data, "input") || !previous ? captureCallReplay(toolName(data.toolName ?? data.name ?? previous?.name), data.input, cwd) : previous.replay,
					issued: previous?.issued ?? t, tokensBefore: previous?.tokensBefore ?? recordedTokens });
			}
			const result = message?.role === "toolResult" || rowType === "tool_execution_end" || !!asyncJob;
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
			if (t >= ctx.until_ms) return;
			if (!project) { if (t >= ctx.since_ms) unmapped++; return; }
			const iso = new Date(t).toISOString();
			if (t >= ctx.since_ms) {
				records++;
				if (first === null || iso < first) first = iso;
				if (last === null || iso > last) last = iso;
			}
			const retainedResult = { ...data, ...(message?.role === "toolResult" ? message : executionResult) };
			const body = (asyncBody || (result ? content(message?.content ?? executionResult?.content ?? data.result ?? data.output) || text(data.message) || text(data.error)
				: message?.role === "user" ? content(message.content) : text(data.message) || text(data.reason))).slice(0, 65_536);
			const name = toolName(message?.toolName ?? data.toolName ?? data.name ?? call?.name);
			if (result && call?.name === "write" && !wasteResults.has(`brief:${id}`) && !classifyMineResult({ tool: name, result: retainedResult, text: body })) {
				const args = object(call.replay.arguments), target = text(args?.path), correction = text(args?.content).slice(0, 16_384);
				if (target.startsWith("agent://") && /\b(?:correction|rework|retract|wrong brief)\b/i.test(correction) && body.startsWith("Delivered to ")) {
					const agent = target.slice("agent://".length), brief = agentBriefs.get(agent);
					if (brief && t >= ctx.since_ms) {
						wasteResults.add(`brief:${id}`);
						brief.causes.push(safe(correction));
						brief.evidence.push({ citation, timestamp: iso, producer: PRODUCER, summary: safe(correction), event_id: id });
						brief.at = t;
					}
				}
			}
			const job = result && !asyncJob ? /\bBackgrounded\s+(?:as\s+)?(bg_\d+)\b|\b(bg_\d+)\b[^\n]{0,200}(?:running|background)/i.exec(body) : null;
			if (job && id) { background.set(job[1] || job[2] || "", id); return; }
			const subject = call ? commitSubject(call.replay) : null;
			if (result && call && subject && !wasteResults.has(id)) {
				const cause = classifyMineResult({ tool: name, result: retainedResult, text: body });
				const landed = /\[[^\]\n]{0,200} ([a-f0-9]{7,64})\]/.exec(body)?.[1];
				const explicitRc = retainedResult.rc ?? retainedResult.exit_code ?? object(retainedResult.details)?.exit_code;
				const diagnostic = body.split("\n").filter(line => /\b(?:REFUSED|STALE_WORKTREE|MEMBER_REFUSED|GAP_[A-Z_]+)\b/.test(line)).join("; ");
				const refusal = !landed && explicitRc !== 0 ? diagnostic || cause?.summary || "" : "";
				if (refusal || landed) {
					wasteResults.add(id);
					const key = `${project.path}:${subject}`, previous = commits.get(key);
					if (refusal) {
						const pending = previous ?? { first: call.issued ?? t, tokensBefore: call.tokensBefore ?? recordedTokens, reasons: [], evidence: [] };
						pending.reasons.push(safe(refusal));
						pending.evidence.push({ citation, timestamp: iso, producer: PRODUCER, summary: safe(refusal), event_id: id });
						commits.set(key, pending);
					} else if (landed && previous) {
						const minutes = Math.max(0, (t - previous.first) / 60_000);
						const waste: MineWaste = { kind: "commit-retries", subject: landed, attempts: previous.reasons.length,
							causes: previous.reasons, cost: { rounds: previous.reasons.length, minutes, tokens: hasTokens ? recordedTokens - previous.tokensBefore : null },
							counterfactual: `${enforcement("waste:commit-retries").change} Observed requirements: ${previous.reasons.join("; ")}` };
						if (t >= ctx.since_ms) ctx.emit({ class_id: "waste:commit-retries", project: project.path, time_ms: t, producer: PRODUCER, citation,
							summary: `${subject}: ${previous.reasons.length} refusals before landed ${landed}`, measured_minutes: minutes, proxy_minutes: 0,
							identity: `commit-retries:${project.path}:${landed}`, related_evidence: previous.evidence, waste });
						commits.delete(key);
					}
				}
			}
			if (t < ctx.since_ms) return;
			if (result && call?.name === "wait" && call.start !== null && call.start <= t && !wasteResults.has(`wait:${id}`) && !classifyMineResult({ tool: name, result: retainedResult, text: body })) {
				wasteResults.add(`wait:${id}`);
				const minutes = (t - call.start) / 60_000;
				ctx.emit({ class_id: "waste:idle-wait", project: project.path, time_ms: t, producer: PRODUCER, citation,
					summary: "Recorded wait-tool span (not proof the seat had no other work)", measured_minutes: minutes, proxy_minutes: 0,
					identity: `idle-wait:${id}`, waste: { kind: "idle-wait", subject: session, causes: [safe(body)],
						cost: { rounds: 1, minutes, tokens: null }, counterfactual: enforcement("waste:idle-wait").change } });
			}
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
		for (const [agent, brief] of agentBriefs) if (brief.causes.length && project) {
			ctx.emit({ class_id: "waste:brief-corrections", project: project.path, producer: PRODUCER, time_ms: brief.at,
				citation: brief.evidence[0]!.citation, identity: `direct-brief-corrections:${brief.id}`,
				summary: `${agent}: ${brief.causes.length} delivered brief corrections (DONE endpoint not retained)`, measured_minutes: null, proxy_minutes: 0,
				related_evidence: brief.evidence, waste: { kind: "brief-corrections", subject: brief.id, causes: brief.causes,
					correction_messages: brief.causes.length, cost: { rounds: brief.causes.length, minutes: null, tokens: null },
					counterfactual: `${enforcement("waste:brief-corrections").change} Missing brief requirements: ${brief.causes.join("; ")}` } });
		}
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
	// Wake retries are transport projections of a message, not extra correction rounds.
	const mail = join(ctx.state ?? join(ctx.home, ".local", "state", "omp-kit"), "mail-wake.jsonl");
	if (existsSync(mail)) {
		type Brief = { project: string; agent: string; subject: string; first: number; causes: string[]; evidence: MineEvidence[] };
		const briefs = new Map<string, Brief>(), messages = new Set<string>();
		function finish(key: string, brief: Brief, t: number, citation: string, done: boolean): void {
			if (t < ctx.since_ms || t >= ctx.until_ms || !brief.causes.length) return;
			const minutes = done ? Math.max(0, (t - brief.first) / 60_000) : null;
			ctx.emit({ class_id: "waste:brief-corrections", project: brief.project, producer: PRODUCER, time_ms: t, citation,
				identity: `brief-corrections:${key}:${brief.evidence[0]?.event_id}`, summary: `${brief.agent}: ${brief.causes.length} corrections ${done ? "before DONE" : "(no retained DONE; elapsed cost unknown)"} for ${brief.subject}`,
				measured_minutes: minutes, proxy_minutes: 0, related_evidence: brief.evidence,
				waste: { kind: "brief-corrections", subject: `${brief.agent}:${brief.subject}`, correction_messages: brief.causes.length,
					causes: brief.causes, cost: { rounds: brief.causes.length, minutes, tokens: null },
					counterfactual: `${enforcement("waste:brief-corrections").change} Missing brief requirements: ${brief.causes.join("; ")}` } });
		}
		await ctx.readLines(mail, PRODUCER, (row, citation) => {
			const t = time(row.ts), rawId = row.message_id;
			if (t === null || t >= ctx.until_ms || typeof rawId !== "number" && typeof rawId !== "string") return;
			const recipient = text(row.recipient), sender = text(row.sender), subject = text(row.subject).slice(0, 2048);
			const messageKey = `${rawId}:${recipient}`;
			if (messages.has(messageKey)) return;
			messages.add(messageKey);
			const project = text(row.project_key) ? byCwd(resolve(text(row.project_key))) : undefined;
			if (!project || ctx.targetProject && project.path !== ctx.targetProject) return;
			const thread = text(row.brief_id) || text(row.thread_id) || /\b[a-z][a-z0-9]*-[a-z0-9]+(?:\.[a-z0-9]+)*\b/i.exec(subject)?.[0];
			if (!thread) return;
			const done = /^\[?DONE\b/i.test(subject), correction = /^\[?(?:REWORK|CORRECTION|REVISE)\b/i.test(subject);
			const agent = done ? sender : recipient, key = `${project.path}:${agent}:${thread}`;
			if (done) {
				const brief = briefs.get(key);
				if (brief) { finish(key, brief, t, citation, true); briefs.delete(key); }
			} else if (correction && agent) {
				const brief = briefs.get(key) ?? { project: project.path, agent, subject: thread, first: t, causes: [], evidence: [] };
				brief.causes.push(safe(subject));
				brief.evidence.push({ citation, timestamp: new Date(t).toISOString(), producer: PRODUCER, summary: safe(subject), event_id: `mail:${rawId}:${recipient}` });
				briefs.set(key, brief);
			}
		});
		for (const [key, brief] of briefs) finish(key, brief, Date.parse(brief.evidence.at(-1)!.timestamp), brief.evidence[0]!.citation, false);
	}
	const decisions = ctx.ownerCorrectionsPath;
	if (decisions) await ctx.readLines(decisions, PRODUCER, (row, citation) => {
		const t = time(row.at), said = text(row.said).slice(0, 16_384), rule = text(row.rule);
		if (t === null || t < ctx.since_ms || t >= ctx.until_ms || !rule || !/\b(?:why|wrong|failure|stop|instead|should|must)\b/i.test(said)) return;
		const declared = text(row.repo) || text(row.project_path), project = declared ? byCwd(resolve(declared))?.path : "@unattributed";
		if (!project || ctx.targetProject && project !== ctx.targetProject) return;
		const id = text(row.id);
		if (!id || seen.has(`owner:${id}`)) return;
		seen.add(`owner:${id}`);
		ctx.emit({ class_id: "waste:owner-correction", project, producer: PRODUCER, time_ms: t, citation, summary: `${id}: ${safe(said)}`,
			identity: `owner-correction:${id}`, measured_minutes: null, proxy_minutes: 0,
			waste: { kind: "owner-correction", subject: id, correction_messages: 1, causes: [safe(said)],
				cost: { rounds: 1, minutes: null, tokens: null }, counterfactual: safe(rule) } });
	});
	// An explicitly selected coordinator transcript need not pretend its workspace is a repository.
	const coordinator = { name: "unattributed coordinator", path: "@unattributed", canonical: "@unattributed" };
	for (const path of ctx.sessionRoots ?? []) {
		if (!isAbsolute(path)) {
			const cov = ctx.coverage(PRODUCER, path, "OMP_KIT_MINE_SESSION_ROOTS requires absolute existing session files/directories."); cov.status = "PARTIAL";
		} else if (path.endsWith(".jsonl")) await consume(path, coordinator);
		else await walk(path, coordinator);
	}
	for (const source of roots) {
		if (!ctx.targetProject) { covered.add(source.project.path); ctx.markSource(source.project.path, PRODUCER, 0); }
		ctx.coverage(PRODUCER, source.path, `Native project session directory: ${source.project.path}`);
		await walk(source.path, source.project);
	}
	for (const project of projects) if ((!ctx.targetProject || project.path === ctx.targetProject) && !covered.has(project.path)) {
		const cov = ctx.coverage(PRODUCER, project.path, "No mapped native transcript records discovered"); cov.status = "MISSING";
	}
}
