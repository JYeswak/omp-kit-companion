import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync, type ReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { redactFullTestCause } from "./full-test-runner.ts";
import type { MineCoverage, MineSourceContext, MineSourceFinding } from "./mine.ts";

const SNAPSHOTS = "bead history snapshots", GIT = "git correction commits", LOGS = "repo hook/gate logs";
const MAX_SNAPSHOTS = 2048, MAX_ISSUES = 100_000, MAX_LOG_FILES = 512, MAX_TEXT_BYTES = 32 * 1024 * 1024, MAX_LINE_BYTES = 1024 * 1024;
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const physical = (path: string): string => realpathSync(path);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function time(value: unknown): number | null {
	if (typeof value === "number") {
		const ms = value < 100_000_000_000 ? value * 1000 : value;
		return Number.isFinite(ms) && ms >= 0 && ms <= 8_640_000_000_000_000 ? ms : null;
	}
	// An explicit zone is required: a log's host timezone is not event evidence.
	if (typeof value !== "string" || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
	const n = Date.parse(value); return Number.isFinite(n) ? n : null;
}
function rowTime(row: Record<string, unknown>): number | null {
	return time(row.time_ms ?? row.timestamp ?? row.ts ?? row.at ?? row.recorded_at ?? row.finished_ms ?? row.time);
}
function partial(cov: MineCoverage, detail: string): void {
	cov.status = "PARTIAL";
	if (!cov.detail.includes(detail)) cov.detail += `${cov.detail ? " " : ""}${detail}`;
}
function observe(cov: MineCoverage, t: number): void {
	const iso = new Date(t).toISOString();
	if (!cov.first_timestamp || iso < cov.first_timestamp) cov.first_timestamp = iso;
	if (!cov.last_timestamp || iso > cov.last_timestamp) cov.last_timestamp = iso;
}
type State = { status: string; updated: number | null; citation: string; project: string };

/** Read native history, reachable git commits and existing gitdir logs. Never opens a live tracker database. */
export async function mineHistory(ctx: MineSourceContext): Promise<void> {
	const seen = new Set<string>(), trackers = new Set<string>(), gitdirs = new Set<string>(), logFiles = new Set<string>();
	const projectPaths = new Set(ctx.projects.map(p => { try { return physical(p.path); } catch { return resolve(p.path); } }));
	let textBytes = 0, logFileCount = 0;
	function safe(value: string): string {
		return redactFullTestCause({ cause_code: "", cause_name: "", cause_message: "", cause_stack_head: value.replace(/[\r\n\t]+/g, " ") }, []).cause_stack_head ?? "";
	}
	function emit(finding: MineSourceFinding): void {
		if (finding.time_ms < ctx.since_ms || finding.time_ms >= ctx.until_ms || seen.has(finding.identity)) return;
		seen.add(finding.identity); ctx.emit({ ...finding, summary: safe(finding.summary) });
	}
	function finding(class_id: string, project: string, t: number, producer: string, citation: string, summary: string, identity: string, proxy_minutes: number, measured_minutes: number | null = null): void {
		emit({ class_id, project, time_ms: t, producer, citation, summary, identity, proxy_minutes, measured_minutes });
	}
	function owner(row: Record<string, unknown>, fallback: string): string {
		const source = text(row.source_repo_path);
		if (!source || !isAbsolute(source)) return fallback;
		try { const path = physical(source); return projectPaths.has(path) ? path : fallback; } catch { return fallback; }
	}
	async function tracker(project: string): Promise<void> {
		const beads = join(project, ".beads");
		const cov = ctx.coverage(SNAPSHOTS, join(beads, ".br_history"), "Snapshot inference only: status differs between retained rows; updated_at is a proxy for transition time, not a native audit witness. Current state alone never counts. Live tracker SQLite is not opened.");
		let canonical: string;
		try { canonical = physical(beads); } catch { cov.status = "MISSING"; return; }
		if (trackers.has(canonical)) { cov.detail = `Shared tracker ${canonical}; already read once.`; return; }
		trackers.add(canonical);
		const canonicalOwner = projectPaths.has(dirname(canonical)) ? dirname(canonical) : project;
		const history = join(canonical, ".br_history");
		let names: string[];
		try { names = readdirSync(history, { withFileTypes: true }).filter(e => e.isFile() && /^issues\.\d{8}_\d{6}_\d+\.jsonl$/.test(e.name)).map(e => e.name).sort(); }
		catch { cov.status = "MISSING"; return; }
		// Filename clocks have no zone. Use a whole-day margin for selection only; event dates come from rows.
		const lower = new Date(ctx.since_ms - 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
		const upper = new Date(ctx.until_ms + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
		const before = names.filter(n => n.slice(7, 15) < lower).at(-1);
		names = [...(before ? [before] : []), ...names.filter(n => n.slice(7, 15) >= lower && n.slice(7, 15) <= upper)];
		if (names.length > MAX_SNAPSHOTS) { partial(cov, `Snapshot bound ${MAX_SNAPSHOTS} reached; later history omitted.`); names = names.slice(0, MAX_SNAPSHOTS); }
		if (!names.length) partial(cov, "No timestamp-named native snapshots; export alone cannot establish a transition.");
		let prior = new Map<string, State>();
		for (const path of [...names.map(n => join(history, n)), join(canonical, "issues.jsonl")]) {
			if (ctx.expired()) { partial(cov, "Shared deadline reached; remaining history omitted."); break; }
			const next = new Map<string, State>(); let overflow = false;
			const read = await ctx.readLines(path, SNAPSHOTS, (row, citation) => {
				const id = text(row.id); if (!id) return;
				const target = owner(row, canonicalOwner);
				for (const raw of Array.isArray(row.comments) ? row.comments : []) {
					const c = object(raw); if (!c) continue;
					const content = text(c.text) ?? text(c.body) ?? "", t = time(c.created_at ?? c.timestamp);
					if (t !== null && /^(?:REWORK\b|(?:VERDICT|Verdict):[ \t]*REWORK\b)/.test(content.trimStart())) {
						finding("rework", target, t, SNAPSHOTS, `${citation}#comment=${typeof c.id === "string" || typeof c.id === "number" ? c.id : "unknown"}`, `REWORK ${id}`, `rework:${target}:${id}:${new Date(t).toISOString().slice(0, 10)}`, 5);
					}
				}
				const status = text(row.status)?.toLowerCase(); if (!status) return;
				if (next.size >= MAX_ISSUES && !next.has(id)) { overflow = true; return; }
				next.set(id, { status, updated: time(row.updated_at), citation, project: target });
			});
			cov.rows += read.rows;
			if (overflow) partial(cov, `Issue bound ${MAX_ISSUES} reached.`);
			if (read.status !== "READ" || overflow) { partial(cov, "Incomplete snapshot is not used as a transition baseline."); continue; }
			for (const [id, state] of next) {
				const old = prior.get(id), t = state.updated;
				if (old && old.status !== state.status) {
					if (t === null || (old.updated !== null && t <= old.updated)) partial(cov, "Changed status without increasing dated updated_at remains unknown.");
					else {
						const kind = state.status === "rework" ? "rework" : old.status === "closed" && state.status !== "tombstone" ? "reopened-bead" : state.status === "blocked" ? "bead-blocked" : null;
						if (kind) {
							const identity = `${kind === "rework" ? "rework" : kind === "reopened-bead" ? "reopen" : "blocked"}:${state.project}:${id}:${new Date(t).toISOString().slice(0, 10)}`;
							finding(kind, state.project, t, SNAPSHOTS, state.citation, `Snapshot inference: ${id} ${old.status} -> ${state.status}; updated_at proxy; prior ${old.citation}`, identity, kind === "reopened-bead" ? 10 : 5);
							if (t >= ctx.since_ms && t < ctx.until_ms) observe(cov, t);
						}
					}
				}
			}
			prior = next;
		}
		ctx.markSource(canonicalOwner, SNAPSHOTS, cov.rows);
	}
	function logRow(row: Record<string, unknown>, citation: string, project: string, location: string, cov: MineCoverage): void {
		const data = object(row.data) ?? row, t = rowTime(row) ?? rowTime(data);
		if (t === null) { partial(cov, "Undated rows remain unknown; no filesystem timestamps used."); return; }
		if (t < ctx.since_ms || t >= ctx.until_ms) return;
		observe(cov, t);
		const rc = typeof data.rc === "number" ? data.rc : typeof data.exit_code === "number" ? data.exit_code : null;
		const outcome = (text(data.verdict) ?? text(data.outcome) ?? text(data.kind) ?? text(data.decision) ?? text(data.status) ?? text(data.action) ?? "").toLowerCase();
		const refused = ["refuse", "refused", "deny", "denied", "block", "blocked"].includes(outcome);
		if (!(rc !== null && rc !== 0) && !refused && !["fail", "failed", "error", "timeout"].includes(outcome)) return;
		const gate = safe(text(data.gate) ?? text(data.rule) ?? "unknown").replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 96);
		const file = basename(location), isFresh = file.startsWith("fresh-gate-runs.jsonl"), release = /release|autocut/.test(file);
		const kind = isFresh ? "gate-failure:fresh-gate" : release ? "release-fail" : `${refused && data.act === "commit" ? "commit-refusal" : refused ? "guard-friction" : "gate-failure"}:${gate}`;
		const tree = text(data.tree) ?? "unknown", checks = text(data.checks) ?? "unknown";
		const identity = release && data.verdict === "FAIL" && data.tree ? `verdict:${project}:${tree}:${checks}:${t}` : `repo-log:${project}:${text(row.event_id) ?? text(row.id) ?? digest(JSON.stringify([kind, t, data.commit, data.tree, data.gate, data.rule, rc, outcome, data.reason]))}`;
		const timing = object(data.timing), wall = typeof timing?.wall_ms === "number" ? timing.wall_ms : typeof data.duration_ms === "number" ? data.duration_ms : null;
		finding(kind, project, t, LOGS, citation, `${isFresh ? "fresh-gate" : release ? "release" : "hook/gate"} ${outcome || "nonzero exit"} rc=${rc ?? "unknown"} gate=${gate} commit=${text(data.commit) ?? tree}`, identity, release ? 15 : 2, wall !== null && Number.isFinite(wall) && wall >= 0 ? wall / 60_000 : null);
	}
	async function textLog(path: string, project: string): Promise<void> {
		const cov = ctx.coverage(LOGS, path, "Only individually timestamped structured refusals/failures are admitted; undated terminal output is unknown.");
		let stream: ReadStream | undefined;
		let pending = "", line = 0;
		function consume(raw: string): void {
			line++; cov.rows++; if (!raw.trim()) return;
			try { const row = object(JSON.parse(raw)); if (row) { logRow(row, `${path}:${line}`, project, path, cov); return; } } catch { /* Native text logs are not necessarily JSON. */ }
			const match = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\]?\s+(.*)$/.exec(raw);
			if (!match) { partial(cov, "Undated/unparseable text remains unknown; filenames and mtimes do not date events."); return; }
			const t = time(match[1]), message = match[2] ?? "";
			if (t === null) { partial(cov, "Invalid explicit timestamp."); return; }
			if (t < ctx.since_ms || t >= ctx.until_ms) return;
			observe(cov, t);
			// Do not treat test assertions, quoted transcript prose, or an incidental word FAIL as an incident.
			if (!/^(?:FULL-SUITE:\s+VERDICT FAIL\b|(?:release-verdict|release|hook|gate|pre-push|pre-commit):\s+(?:FAIL(?:ED)?|ERROR|REFUS(?:E|ED|AL)|BLOCK(?:ED)?|DEN(?:Y|IED))\b)/i.test(message)) return;
			const release = /^(?:FULL-SUITE|release)/i.test(message);
			finding(release ? "release-fail" : "guard-friction:hook", project, t, LOGS, `${path}:${line}`, message, `repo-text:${project}:${t}:${digest(message)}`, release ? 15 : 2);
		}
		try {
			const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink()) throw new Error("nonregular log");
			stream = createReadStream(path, { highWaterMark: 64 * 1024 });
			const decoder = new TextDecoder("utf-8", { fatal: true });
			for await (const chunk of stream) {
				textBytes += chunk.length;
				if (textBytes > MAX_TEXT_BYTES || ctx.expired()) throw new Error("text byte/deadline bound");
				pending += decoder.decode(chunk, { stream: true });
				let end: number;
				while ((end = pending.indexOf("\n")) >= 0) {
					if (end > MAX_LINE_BYTES) throw new Error("line bound");
					consume(pending.slice(0, end)); pending = pending.slice(end + 1);
				}
				if (pending.length > MAX_LINE_BYTES) throw new Error("line bound");
			}
			pending += decoder.decode();
			if (pending.trim()) partial(cov, "Unterminated tail omitted.");
		} catch { partial(cov, "Unreadable/nonregular log or 32 MiB shared text/1 MiB line/deadline bound reached."); }
		finally { stream?.destroy(); }
		ctx.markSource(project, LOGS, cov.rows);
	}
	async function logs(directory: string, project: string, depth = 0): Promise<void> {
		let entries;
		try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
		catch { ctx.coverage(LOGS, directory).status = "MISSING"; return; }
		for (const e of entries) {
			if (ctx.expired() || logFileCount >= MAX_LOG_FILES) { partial(ctx.coverage(LOGS, directory), "Shared deadline or 512 log-file bound reached."); break; }
			const path = join(directory, e.name);
			if (e.isDirectory() && depth < 2 && /hook|gate|refus|release/.test(e.name) && e.name !== "full-suite-verdicts") { await logs(path, project, depth + 1); continue; }
			if (!/\.(?:jsonl(?:\.\d+)?|log(?:\.\d+)?)$/.test(e.name)) continue;
			if (e.isSymbolicLink() || !e.isFile()) { partial(ctx.coverage(LOGS, path), "Nonregular log not followed."); continue; }
			const canonical = physical(path); if (logFiles.has(canonical)) continue;
			logFiles.add(canonical); logFileCount++;
			if (/\.jsonl(?:\.\d+)?$/.test(e.name)) {
				// The shared reader owns JSONL byte/row/file limits and malformed-row coverage.
				const detail = ctx.coverage(LOGS, path, "Explicit timestamps and structured failure fields only.");
				const read = await ctx.readLines(path, LOGS, (row, citation) => logRow(row, citation, project, path, detail));
				ctx.markSource(project, LOGS, read.rows);
			} else if (textBytes < MAX_TEXT_BYTES) await textLog(path, project);
			else partial(ctx.coverage(LOGS, path), "32 MiB shared text-log bound reached; log omitted.");
		}
	}
	for (const configured of ctx.projects) {
		const project = (() => { try { return physical(configured.path); } catch { return resolve(configured.path); } })();
		if (ctx.expired()) { partial(ctx.coverage(SNAPSHOTS, project), "Shared deadline reached before project scan."); partial(ctx.coverage(GIT, project), "Shared deadline reached before project scan."); continue; }
		await tracker(project);
		const cov = ctx.coverage(GIT, project, "Reachable refs, committer timestamp UTC [since,until); correction declarations are observed commits, not independent proof of a defect. Bounded to 16 MiB and 15 seconds.");
		const top = await ctx.command(["git", "-C", project, "rev-parse", "--show-toplevel"], project);
		if (!top) { cov.status = "MISSING"; ctx.coverage(LOGS, join(project, ".git", "omp-kit")).status = "MISSING"; continue; }
		let actualTop: string; try { actualTop = physical(top); } catch { partial(cov, "Cannot resolve git top-level."); continue; }
		if (actualTop !== project) { partial(cov, `Ancestor repository refused: ${actualTop}; project is not its root.`); partial(ctx.coverage(LOGS, project), "Ancestor gitdir logs refused."); continue; }
		const directory = await ctx.command(["git", "-C", project, "rev-parse", "--absolute-git-dir"], project);
		if (!directory || !isAbsolute(directory)) { partial(cov, "Absolute gitdir unavailable."); continue; }
		let gitdir: string; try { gitdir = physical(directory); } catch { partial(cov, "Gitdir cannot be resolved."); continue; }
		if (gitdirs.has(gitdir)) { cov.detail = `Shared gitdir ${gitdir}; already mined.`; continue; }
		gitdirs.add(gitdir);
		const output = await ctx.command(["git", "-C", project, "log", "--all", "--no-show-signature", "--no-decorate", "--no-color", `--since-as-filter=${new Date(ctx.since_ms).toISOString()}`, `--until=${new Date(ctx.until_ms).toISOString()}`, "--format=%H%x00%ct%x00%B%x00"], project, 15, 16 * 1024 * 1024);
		if (output === null) partial(cov, "Git log failed, exceeded output/deadline bound, or repository has no readable history.");
		else {
			const parts = output.split("\0");
			for (let i = 0; i + 2 < parts.length; i += 3) {
				const sha = parts[i]?.trim() ?? "", seconds = parts[i + 1] ?? "", body = parts[i + 2] ?? "";
				if (!/^[a-f0-9]{40,64}$/.test(sha) || !/^\d+$/.test(seconds)) { partial(cov, "Malformed git log record omitted."); continue; }
				const t = Number(seconds) * 1000; if (t < ctx.since_ms || t >= ctx.until_ms) continue;
				cov.rows++; observe(cov, t);
				const subject = body.split("\n", 1)[0] ?? "";
				const kind = /^revert(?:\b|:)/i.test(subject) || /^This reverts commit [a-f0-9]{7,64}\.?$/m.test(body) ? "git-revert" : /^supersedes?\b/i.test(subject) || /^Supersedes:\s+\S/m.test(body) ? "git-supersedes" : null;
				if (kind) finding(kind, project, t, GIT, `${project}#git:${sha}`, `${kind === "git-revert" ? "Revert" : "Supersedes"} commit ${sha}: ${subject}`, `git-correction:${sha}`, 5);
			}
			if (parts.length % 3 !== 1 || parts.at(-1)?.trim()) partial(cov, "Incomplete git log tail omitted.");
		}
		ctx.markSource(project, GIT, cov.rows);
		if (existsSync(join(gitdir, "omp-kit"))) await logs(join(gitdir, "omp-kit"), project);
		else ctx.coverage(LOGS, join(gitdir, "omp-kit")).status = "MISSING";
	}
}
