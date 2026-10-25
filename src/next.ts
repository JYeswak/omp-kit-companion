import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { run } from "./kitlib/run.ts";
import type { DataSchema } from "./commands.ts";
import { parseSkillStations, skillStationReport, type ApplicableSkill } from "./skill-stations.ts";

export type Station = "dag-repair" | "finish" | "grade" | "rework" | "claim" | "research" | "publish" | "inbox" | "dispose";
export type Action = { station: Station; why: string; commands: string[] };
export type Observation = { status: "KNOWN"; value: unknown; source: string } | { status: "UNKNOWN"; value: null; source: string; reason: string };
export type AdapterName = "issues" | "cycles" | "blocked" | "ready" | "triage" | "git" | "changes" | "acks" | "scratch" | "pulse" | "sitrep";
export type NextOptions = { role: string; repo?: string; agent?: string };
export type Context = { repo: string; agent: string | null };
export type Adapter = (context: Context) => Promise<Observation>;
export type Adapters = Record<AdapterName, Adapter>;
const unknown = (source: string, reason: string): Observation => ({ status: "UNKNOWN", value: null, source, reason });
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const records = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(object);
const quote = (s: string) => `'${s.split("'").join("'\\''")}'`;
const brFlags = ["--no-auto-import", "--no-auto-flush", "--json"];

/** All subprocesses are bounded, noninteractive, captured and read-only. */
export function command(tool: string, args: (c: Context) => string[], parse: (text: string) => unknown = JSON.parse,
	runtime: { which: (tool: string) => string | null; run: typeof run } = { which: tool => Bun.which(tool), run }): Adapter {
	return async c => {
		const argv = [tool, ...args(c)];
		const source = argv.map(quote).join(" ");
		if (!runtime.which(tool)) return unknown(source, `${tool} absent`);
		try {
			const result = await runtime.run(argv, { cwd: c.repo, deadline_s: 10, grace_s: 0.2, max_output_bytes: 16 * 1024 * 1024 });
			if (result.timed_out) return unknown(source, "timeout after 10 s");
			if (result.truncated) return unknown(source, "output truncated");
			if (result.rc !== 0) return unknown(source, `exit ${result.rc}: ${new TextDecoder().decode(result.stderr).trim()}`);
			try { return { status: "KNOWN", value: parse(new TextDecoder().decode(result.stdout)), source }; }
			catch { return unknown(source, "malformed JSON or unsupported output shape"); }
		} catch (error) { return unknown(source, String(error)); }
	};
}
const list = (text: string) => {
	const v: unknown = JSON.parse(text);
	if (records(v)) return v;
	if (object(v) && records(v.issues) && v.has_more !== true) return v.issues;
	if (object(v) && records(v.cycles)) return v.cycles;
	throw Error("unsupported or incomplete list");
};

/** Worktree/index changes plus unpushed commits; all four git reads share command()'s bounds. */
export function changeSetAdapter(): Adapter {
	return async context => {
		const reads = await Promise.all(["HEAD", "origin/main...HEAD"].flatMap(base => [
			command("git", () => ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base], text => text.split("\0").filter(Boolean))(context),
			command("git", () => ["diff", "--no-ext-diff", "--no-textconv", "--unified=1000000", base], text => text)(context),
		]));
		const source = reads.map(read => read.source).join("; ");
		const failed = reads.find(read => read.status === "UNKNOWN");
		if (failed?.status === "UNKNOWN") return unknown(source, `change set incomplete: ${failed.reason}`);
		const paths = [...new Set(reads.filter((_, i) => i % 2 === 0).flatMap(read => read.value as string[]))];
		const diffText = reads.filter((_, i) => i % 2 === 1).map(read => read.value as string).join("\n");
		return { status: "KNOWN", value: { paths, diffText }, source };
	};
}
export function realNextAdapters(): Adapters {
	const unsafeScript = (name: string): Adapter => async () => {
		const path = join(homedir(), "Developer", "omp-kit", "scripts", name);
		return unknown(path, existsSync(path) ? "producer writes scratch/cache/history; no read-only mode, not executed" : "optional fleet script absent");
	};
	return {
		issues: command("br", () => ["list", "--status", "all", ...brFlags], list),
		ready: command("br", () => ["ready", ...brFlags], list),
		cycles: command("br", () => ["dep", "cycles", "--blocking-only", ...brFlags], list),
		blocked: async c => {
			const inventory = await command("br", () => ["list", "--status", "blocked", ...brFlags], list)(c);
			if (inventory.status === "UNKNOWN") return inventory;
			const rows = inventory.value as Record<string, unknown>[];
			if (!rows.length) return inventory;
			if (!rows.every(row => typeof row.id === "string")) return unknown(inventory.source, "malformed blocked inventory IDs");
			return command("br", () => ["show", ...rows.map(row => String(row.id)), ...brFlags], list)(c);
		},
		triage: command("bv", () => ["--robot-triage", "--db", ".beads/issues.jsonl"]),
		git: command("git", () => ["rev-list", "--count", "origin/main..HEAD"], text => {
			const ahead = Number(text.trim()); if (!text.trim() || !Number.isSafeInteger(ahead) || ahead < 0) throw Error(); return { ahead };
		}),
		changes: changeSetAdapter(),
		acks: async c => c.agent ? command("am", x => ["acks", "pending", x.repo, x.agent!])(c) : unknown("am acks pending", "agent identity not supplied"),
		scratch: command("omp-kit", () => ["scratch", "plan", "--json"]),
		pulse: unsafeScript("fleet-pulse.sh"), sitrep: unsafeScript("sitrep.sh"),
	};
}

const actionSchema = { type: "object", required: ["station", "why", "commands"], properties: {
	station: { enum: ["dag-repair", "finish", "grade", "rework", "claim", "research", "publish", "inbox", "dispose"] },
	why: { type: "string" }, commands: { type: "array", items: { type: "string" } },
} };
export const NEXT_DATA_SCHEMA: DataSchema = { type: "object", required: ["role", "next_action", "actions", "facts", "adapters", "applicable_skills"], properties: {
	role: { enum: ["worker", "director"] }, next_action: { anyOf: [actionSchema, { type: "null" }] },
	actions: { type: "array", items: actionSchema }, facts: { type: "object" },
	applicable_skills: { type: "array", items: { type: "object", required: ["skill", "station", "mandatory", "trigger", "why"], properties: {
		skill: { type: "string" }, station: { type: "string" }, mandatory: { type: "boolean" }, trigger: { type: "string" }, why: { type: "string" },
	} } },
	adapters: { type: "array", items: { type: "object", required: ["name", "status", "source"], properties: {
		name: { type: "string" }, status: { enum: ["KNOWN", "UNKNOWN"] }, source: { type: "string" }, reason: { type: "string" },
	} } },
} };

export async function next(options: NextOptions, adapters: Adapters = realNextAdapters()) {
	if (options.role !== "worker" && options.role !== "director") return { code: 2 as const, data: { overall: "NOT_RUN" }, verification: "NOT_RUN" as const,
		errors: [{ code: "INVALID_ROLE", message: "--role must be worker or director", remediation: "Run omp-kit next --role worker --json or omp-kit next --role director --json." }], commands: [] as string[] };
	const context = { repo: resolve(options.repo ?? process.cwd()), agent: options.agent ?? process.env.AGENT_NAME ?? null };
	const names = Object.keys(adapters) as AdapterName[];
	const observations = await Promise.all(names.map(async name => {
		try { return await adapters[name](context); } catch (error) { return unknown(name, String(error)); }
	}));
	const facts = Object.fromEntries(names.map((name, i) => [name, observations[i]!])) as Record<AdapterName, Observation>;
	const value = (name: AdapterName) => facts[name].value;
	const reject = (name: AdapterName) => { if (facts[name].status === "KNOWN") facts[name] = unknown(facts[name].source, "malformed JSON or unsupported output shape"); };
	for (const name of ["issues", "cycles", "blocked"] as const) if (facts[name].status === "KNOWN" && !records(value(name))) reject(name);
	const blockedValue = value("blocked");
	if (records(blockedValue) && !blockedValue.every(row => typeof row.id === "string" && records(row.dependencies)
		&& row.dependencies.every(dep => typeof dep.dependency_type === "string" && typeof dep.status === "string"))) reject("blocked");
	const issues = records(value("issues")) ? value("issues") as Record<string, unknown>[] : [];
	const sorted = [...issues].sort((a, b) => Number(a.priority ?? 4) - Number(b.priority ?? 4) || String(a.id).localeCompare(String(b.id)));
	const actions: Action[] = [];
	const add = (station: Station, why: string, source: string, commands: string[]) => actions.push({ station, why: `${why} (source: ${source})`, commands });
	const inspect = (id: unknown) => `cd ${quote(context.repo)} && br show ${quote(String(id))} --no-auto-import --no-auto-flush --json`;
	const own = (row: Record<string, unknown>) => context.agent !== null && row.assignee === context.agent;
	const hasLabel = (row: Record<string, unknown>, label: string) => Array.isArray(row.labels) && row.labels.includes(label);
	const blocked = records(value("blocked")) ? value("blocked") as Record<string, unknown>[] : [];
	// Only an open blocks dependency is a fix; a parent-child or closed edge is not.
	const noFix = blocked.filter(row => records(row.dependencies)
		&& !row.dependencies.some(dep => dep.dependency_type === "blocks" && dep.status !== "closed" && dep.status !== "tombstone"));
	const cycles = value("cycles");
	if (Array.isArray(cycles) && cycles.length > 0 || noFix.length > 0) add("dag-repair", `${Array.isArray(cycles) ? cycles.length : "UNKNOWN"} cycles; ${facts.blocked.status === "KNOWN" ? noFix.length : "UNKNOWN"} explicit blocked rows without fixes`, `${facts.cycles.source}; ${facts.blocked.source}`, [`cd ${quote(context.repo)} && br dep cycles --blocking-only --no-auto-import --no-auto-flush --json`, ...noFix.slice(0, 1).map(row => inspect(row.id))]);
	if (options.role === "worker") {
		const held = sorted.find(row => row.status === "in_progress" && own(row));
		if (held) add("finish", `held in_progress ${held.id}: finish or release before another claim`, facts.issues.source, [inspect(held.id)]);
		const review = sorted.find(row => row.status === "in_review" && context.agent !== null && typeof row.assignee === "string" && !own(row) && row.owner !== context.agent && row.created_by !== context.agent);
		if (review) add("grade", `another seat's in_review ${review.id}`, facts.issues.source, [inspect(review.id)]);
		const rework = sorted.find(row => own(row) && (row.status === "rework" || hasLabel(row, "rework")));
		if (rework) add("rework", `own rework ${rework.id}`, facts.issues.source, [inspect(rework.id)]);
		const triage = value("triage");
		if (facts.triage.status === "KNOWN") {
			if (!object(triage) || !object(triage.triage) || !Array.isArray(triage.triage.quick_wins)) reject("triage");
			else {
				const recommendations = [...(Array.isArray(triage.triage.recommendations) ? triage.triage.recommendations : []), ...triage.triage.quick_wins];
				const ready = value("ready");
				if (facts.ready.status === "KNOWN" && !records(ready)) reject("ready");
				for (const pick of recommendations) if (object(pick) && typeof pick.id === "string") {
					const row = issues.find(row => row.id === pick.id);
					if (row && records(ready) && ready.some(candidate => candidate.id === pick.id) && (row.status === "open" || row.status === "ready") && !row.assignee && !["human-gate", "owner-decision", "kind:process"].some(label => hasLabel(row, label))) {
						add("claim", `top eligible bv pick ${pick.id}; inspect current readiness before claiming`, `${facts.triage.source}; ${facts.ready.source}`, [`cd ${quote(context.repo)} && br ready --no-auto-import --no-auto-flush --json`, inspect(pick.id)]); break;
					}
				}
			}
		}
		const topBlocked = sorted.find(row => row.status === "blocked");
		if (topBlocked) add("research", `research top blocked ${topBlocked.id}`, facts.issues.source, [inspect(topBlocked.id)]);
	} else {
		const pulse = value("pulse");
		if (facts.pulse.status === "KNOWN" && !object(pulse)) reject("pulse");
		if (object(pulse)) {
			for (const [field, station, instruction] of [["blocked_no_fix", "dag-repair", "repair blocked beads without a fix"], ["stale_in_progress", "finish", "inspect stale in_progress; verify no live holder before reclaiming"], ["panes_idle", "claim", "route idle seats to ready supply"], ["review_queue_count", "grade", "route the review queue"]] as const) {
				if (typeof pulse[field] === "number" && pulse[field] > 0 && (field !== "panes_idle" || typeof pulse.ready === "number" && pulse.ready > 0)) add(station, `${instruction}: ${field}=${pulse[field]}; review oldest_age_s=${pulse.review_queue_oldest_age_s ?? "UNKNOWN"}`, facts.pulse.source, [`omp-kit next --role worker --repo ${quote(context.repo)} --json`]);
			}
		}
		if (facts.pulse.status === "KNOWN" || facts.sitrep.status === "KNOWN") add("inbox", "hourly REPORT obligation; last delivery UNKNOWN (no read-only report-history producer)", "AGENTS.md Guide loop director cadence", [`sh ${quote(join(homedir(), "Developer", "omp-kit", "scripts", "sitrep.sh"))} --json`]);
	}
	const git = value("git");
	if (facts.git.status === "KNOWN" && (!object(git) || !Number.isSafeInteger(git.ahead) || Number(git.ahead) < 0)) reject("git");
	if (object(git) && typeof git.ahead === "number" && git.ahead > 0) add("publish", `${git.ahead} local commits ahead of origin/main; verify gates before publishing`, facts.git.source, [`git -C ${quote(context.repo)} push origin main`]);
	const acks = value("acks");
	if (facts.acks.status === "KNOWN" && !Array.isArray(acks)) reject("acks");
	if (Array.isArray(acks) && acks.length) add("inbox", `${acks.length} pending acknowledgements; act on each ask before acknowledging`, facts.acks.source, [`am acks pending ${quote(context.repo)} ${quote(context.agent ?? "")}`]);
	const scratch = value("scratch");
	if (facts.scratch.status === "KNOWN") {
		if (!object(scratch) || !object(scratch.data) || !Array.isArray(scratch.data.sessions)) reject("scratch");
		else if (scratch.data.sessions.length) add("dispose", `${scratch.data.sessions.length} scratch sessions require inspection; plan is not disposal authorization`, facts.scratch.source, ["omp-kit scratch plan --json"]);
	}
	if (!actions.length) add("publish", "stock checkout: inspect git state; fleet work UNKNOWN or no actionable observations", facts.git.source, [`git -C ${quote(context.repo)} status --short --branch`]);
	const changes = value("changes");
	let skills: { applicable_skills: ApplicableSkill[]; warnings: string[] } = { applicable_skills: [], warnings: [] };
	if (facts.changes.status === "KNOWN") {
		if (!object(changes) || !Array.isArray(changes.paths) || !changes.paths.every(p => typeof p === "string") || typeof changes.diffText !== "string") reject("changes");
		else skills = skillStationReport(changes.paths, changes.diffText);
	}
	if (facts.changes.status === "UNKNOWN") {
		const map = parseSkillStations();
		skills.warnings.push(...map.errors, ...map.warnings);
	}
	return { code: 0 as const, data: { role: options.role, next_action: actions[0]!, actions, applicable_skills: skills.applicable_skills, facts, adapters: names.map(name => {
		const fact = facts[name];
		return { name, status: fact.status, source: fact.source, ...(fact.status === "UNKNOWN" ? { reason: fact.reason } : {}) };
	}) }, commands: actions[0]!.commands, verification: "UNVERIFIED" as const,
		warnings: [...names.filter(name => facts[name].status === "UNKNOWN").map(name => `${name}: ${(facts[name] as Extract<Observation, { status: "UNKNOWN" }>).reason}`), ...skills.warnings] };
}

export function formatNext(data: { actions: Action[]; applicable_skills: ApplicableSkill[] }): string {
	return [...data.actions.map((action, i) => `${i === 0 ? "NEXT" : "then"} ${action.station}: ${action.why} → ${action.commands.join("; ")}`),
		...data.applicable_skills.map(row => `skill ${row.skill} [${row.station}${row.mandatory ? ", mandatory" : ""}]: ${row.trigger} — ${row.why}`)].join("\n");
}
