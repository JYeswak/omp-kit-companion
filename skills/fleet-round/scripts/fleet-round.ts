#!/usr/bin/env bun
// fleet-round validator CLI. A director's round report is a claim; this recomputes it from br, git,
// tmux, ps and Agent Mail identity files, all read-only. See ../SKILL.md.
//
//   collect    --config C --project P --out RAW.json
//   check      --config C --project P [--raw RAW.json] [--focus a,b,c] [--snapshot S.json] [--now ISO] [--out-json F] [--out-md F]
//   validate   --config C --project P --report R.md [--raw RAW.json] [--snapshot S.json] [--now ISO] [--out-json F] [--out-md F]
//   snapshot   --config C --project P --out S.json [--raw RAW.json] [--round-start ISO]
//   spot-check --config C --project P --since ISO --seed SEED [--rate 0.1] [--raw RAW.json] [--now ISO]
//   score      --measured M.json --predictions DOC.md [--predictions DOC.md ...]
//   barrier    --config C --round N --phase INSIGHT|AGREE|SORT --opened-at ISO --state ROUND_DIR [--raw PROJECT=RAW.json ...] [--now ISO] [--out-json F] [--out-md F]
//
// Exit: 0 PASS/ACCEPTED, 1 FAIL/REJECTED, 3 UNKNOWN/UNVERIFIED, 2 usage or unreadable input.
// barrier: 0 MET, 1 MISSED, 3 any source unavailable (never MET on unknown), 4 OPEN, 2 usage.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { barrierExit, barrierMarkdown, loadState, readThread, runBarrier, saveState, type Validation, writeAtomic } from "./lib/barrier.ts";
import { type CheckOptions, type CheckResult, checkDag, checkFocus, checkFrontier, checkMission, checkPile, findMissions, metrics, overall, type Snapshot, spotCheck } from "./lib/checks.ts";
import { BARRIER_PHASES, type BarrierPhase, collect, type Config, loadConfig } from "./lib/collect.ts";
import { HELD_STATUSES, isRecord, parseSeats, parseTracker, type RawBundle } from "./lib/model.ts";
import { matchLine, ROUND_NUMBER } from "./lib/patterns.ts";
import { loadMeasured, loadPredictionDoc, scoreAll } from "./lib/predictions.ts";
import { type ReportVerdict, validateReport } from "./lib/report.ts";

const USAGE = "usage: fleet-round.ts collect|check|validate|snapshot|spot-check|score|barrier [flags]; see the header of this file";

class Usage extends Error {}

function flags(argv: string[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		if (!flag.startsWith("--") || i + 1 >= argv.length) throw new Usage(`expected --flag value, got ${flag}`);
		out.set(flag.slice(2), [...(out.get(flag.slice(2)) ?? []), argv[++i]!]);
	}
	return out;
}

function one(args: Map<string, string[]>, name: string): string | null {
	const values = args.get(name);
	if (!values) return null;
	if (values.length > 1) throw new Usage(`--${name} given twice`);
	return values[0]!;
}

function need(args: Map<string, string[]>, name: string): string {
	const value = one(args, name);
	if (value === null) throw new Usage(`--${name} is required`);
	return value;
}

function time(text: string, flag: string): number {
	const ms = Date.parse(text);
	if (Number.isNaN(ms)) throw new Usage(`--${flag} ${JSON.stringify(text)} is not an ISO timestamp`);
	return ms;
}

function bundleFor(args: Map<string, string[]>, config: Config, project: string): RawBundle {
	const raw = one(args, "raw");
	return raw === null ? collect(config, project) : loadRaw(raw, project);
}

function loadRaw(raw: string, project: string): RawBundle {
	const bundle: unknown = JSON.parse(readFileSync(raw, "utf8"));
	if (!isRecord(bundle) || bundle.schema !== "fleet-round.raw/v1") throw new Usage(`${raw}: not a fleet-round.raw/v1 bundle`);
	const typed = bundle as RawBundle; // shape enforced field by field in parseTracker/parseSeats
	if (typed.project !== project) throw new Usage(`${raw} captures project ${typed.project}, not ${project}`);
	return typed;
}

function loadSnapshot(path: string | null): Snapshot | null {
	if (path === null) return null;
	const json: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(json) || json.schema !== "fleet-round.snapshot/v1" || typeof json.round_start !== "string" || !Array.isArray(json.beads)) throw new Usage(`${path}: not a fleet-round.snapshot/v1 file`);
	if (Number.isNaN(Date.parse(json.round_start))) throw new Usage(`${path}: round_start is not an ISO timestamp`);
	return json as Snapshot; // beads entries are read by id only; a missing id is reported per bead
}

type Verdict = {
	schema: "fleet-round.verdict/v1";
	project: string;
	captured_at: string;
	now: string;
	sources: Record<string, unknown>;
	pass_bar: string;
	checks: CheckResult[];
	metrics: Record<string, number>;
	report?: ReportVerdict;
};

function evaluate(bundle: RawBundle, config: Config, options: CheckOptions): Verdict {
	const tracker = parseTracker(bundle);
	const seats = parseSeats(bundle);
	const results = [checkMission(bundle.docs, options.approver), checkPile(tracker, seats, options), checkDag(tracker), checkFrontier(tracker, options), checkFocus(tracker, options)];
	return {
		schema: "fleet-round.verdict/v1",
		project: bundle.project,
		captured_at: bundle.captured_at,
		now: new Date(options.now).toISOString(),
		sources: {
			br_version: bundle.br.version,
			git_head: bundle.git.head,
			docs_repo: bundle.git.repo,
			docs_ref: bundle.git.ref,
			docs_read: Object.keys(bundle.docs).length,
			statuses: tracker.statuses,
			status_source: tracker.status_source,
			held_statuses: HELD_STATUSES,
			seats_available: seats.available,
			seat_reasons: seats.reasons,
			panes: seats.panes.length,
			agent_panes: seats.panes.filter(p => p.agent !== null).length,
			identity_dirs: bundle.seats.identity.map(d => ({ key: d.key, dir: d.dir, files: d.files === null ? null : Object.keys(d.files).length })),
			config_stale_hours: config.stale_hours,
		},
		pass_bar: overall(results),
		checks: results,
		metrics: metrics(tracker, results, findMissions(bundle.docs).length),
	};
}

function markdown(verdict: Verdict): string {
	const s = verdict.sources;
	const out = [
		`# fleet-round verdict: ${verdict.project}`,
		"",
		`- pass bar: **${verdict.pass_bar}**`,
		`- captured: ${verdict.captured_at} (now ${verdict.now})`,
		`- tracker: ${String(s.br_version)}; statuses from ${String(s.status_source)}`,
		`- docs: ${String(s.docs_read)} committed docs of ${String(s.docs_repo)} at ${String(s.docs_ref)} (${String(s.git_head)})`,
		`- seats: ${s.seats_available ? "available" : `UNAVAILABLE (${(s.seat_reasons as string[]).join("; ")})`}, ${String(s.agent_panes)} agent panes of ${String(s.panes)}`,
		"",
	];
	if (verdict.report) {
		out.push(`## Report: ${verdict.report.status}`, "");
		for (const error of verdict.report.errors) out.push(`- REJECT: ${error}`);
		for (const note of verdict.report.unverified) out.push(`- UNVERIFIED: ${note}`);
		for (const claim of verdict.report.claims) out.push(`- CLAIM ${claim.id} ${claim.metric}: reported ${claim.reported}, measured ${claim.measured ?? "n/a"} → ${claim.status}`);
		out.push("");
	}
	for (const check of verdict.checks) {
		out.push(`## ${check.name}: ${check.status}`, "", check.summary, "");
		for (const finding of check.findings) out.push(`- ${finding.status} ${finding.kind}${finding.id ? ` ${finding.id}` : ""}: ${finding.detail}`);
		if (check.findings.length > 0) out.push("");
	}
	return `${out.join("\n").trimEnd()}\n`;
}

function emit(verdict: Verdict, args: Map<string, string[]>): void {
	const json = `${JSON.stringify(verdict, null, 2)}\n`;
	const jsonOut = one(args, "out-json");
	const mdOut = one(args, "out-md");
	if (jsonOut) writeFileSync(jsonOut, json);
	if (mdOut) writeFileSync(mdOut, markdown(verdict));
	process.stdout.write(jsonOut || mdOut ? markdown(verdict) : json);
}

function code(status: string): number {
	return status === "PASS" || status === "ACCEPTED" ? 0 : status === "FAIL" || status === "REJECTED" ? 1 : 3;
}

const FLAGS: Record<string, string[]> = {
	collect: ["config", "project", "out"],
	check: ["config", "project", "raw", "focus", "snapshot", "now", "out-json", "out-md"],
	validate: ["config", "project", "report", "raw", "snapshot", "now", "out-json", "out-md"],
	snapshot: ["config", "project", "out", "raw", "round-start"],
	"spot-check": ["config", "project", "since", "seed", "rate", "raw", "now"],
	score: ["measured", "predictions"],
	barrier: ["config", "round", "phase", "opened-at", "state", "raw", "now", "out-json", "out-md"],
};

/** The report validator: claims recomputed against the bundle, focus taken from the report's own FOCUS line, MISSION checked against the validator's mission. */
function validateWith(report: string, bundle: RawBundle, config: Config, options: CheckOptions): Verdict & { report: ReportVerdict } {
	const base = evaluate(bundle, config, options);
	const first = validateReport(report, base.metrics, bundle.project);
	const verdict = first.fields.focus === null ? base : evaluate(bundle, config, { ...options, focus: first.fields.focus });
	const checked = validateReport(report, verdict.metrics, bundle.project);
	if (checked.fields.mission !== null) {
		const mission = verdict.checks.find(c => c.name === "mission")!;
		const cited = (mission.data?.missions as { citation: string }[] | undefined)?.map(m => m.citation) ?? [];
		if (!cited.includes(checked.fields.mission)) checked.errors.push(`field mission: report cites ${checked.fields.mission}, validator found ${cited.join(", ") || "no mission"}`);
		if (checked.errors.length > 0) checked.status = "REJECTED";
	}
	return { ...verdict, report: checked };
}

function barrier(args: Map<string, string[]>, config: Config, configPath: string): number {
	const settings = config.barrier;
	if (settings === null) throw new Usage(`${configPath}: barrier needs a "barrier" section (agent_mail_db, mail_project, hours)`);
	const roundText = need(args, "round");
	if (!matchLine(ROUND_NUMBER, roundText)) throw new Usage(`--round ${JSON.stringify(roundText)} is not a round number`);
	const phaseText = need(args, "phase");
	if (!Object.hasOwn(BARRIER_PHASES, phaseText)) throw new Usage(`--phase must be one of ${Object.keys(BARRIER_PHASES).join("|")}`);
	const phase = phaseText as BarrierPhase; // checked against BARRIER_PHASES above
	const openedAt = time(need(args, "opened-at"), "opened-at");
	const now = one(args, "now") === null ? Date.now() : time(one(args, "now")!, "now");
	const dir = need(args, "state");
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Usage(`--state ${dir} is not a directory (the private round dir)`);
	const raws = new Map<string, string>();
	for (const spec of args.get("raw") ?? []) {
		const eq = spec.indexOf("=");
		const project = spec.slice(0, eq);
		if (eq <= 0 || !config.projects[project]) throw new Usage(`--raw ${JSON.stringify(spec)}: expected PROJECT=RAW.json naming a configured project`);
		raws.set(project, spec.slice(eq + 1));
	}
	// Barrier judges the report only (status and claims); the pass bar is the measure phase's business, so no snapshot.
	const options: CheckOptions = { now, staleHours: config.stale_hours, frontierTop: config.frontier_top, approver: config.approver, focus: null, snapshot: null };
	const validate = (project: string, body: string): Validation => {
		try {
			const bundle = raws.has(project) ? loadRaw(raws.get(project)!, project) : collect(config, project);
			const report = validateWith(body, bundle, config, options).report;
			if (report.status === "ACCEPTED") return { status: "ACCEPTED", reasons: [] };
			return { status: "REJECTED", reasons: report.status === "REJECTED" ? report.errors : report.unverified.map(note => `unverified: ${note}`) };
		} catch (error) {
			if (error instanceof Usage) throw error;
			return { status: "UNKNOWN", reasons: [`${project}: sources unavailable: ${(error as Error).message}`] };
		}
	};
	const round = Number(roundText);
	const state = loadState(dir);
	const mail = readThread(settings.database, settings.mail_project, `fleet-round-${round}`);
	const input = { round, phase, reportPhase: BARRIER_PHASES[phase], projects: Object.keys(config.projects), openedAt, timeboxHours: settings.hours[phase], now, database: settings.database, mailProject: settings.mail_project };
	const result = runBarrier(input, mail, validate, state);
	saveState(dir, state);
	const json = `${JSON.stringify(result, null, 2)}\n`;
	const jsonOut = one(args, "out-json");
	const mdOut = one(args, "out-md");
	if (jsonOut) writeAtomic(jsonOut, json);
	if (mdOut) writeAtomic(mdOut, barrierMarkdown(result));
	process.stdout.write(jsonOut || mdOut ? barrierMarkdown(result) : json);
	return barrierExit(result);
}

function main(argv: string[]): number {
	const [command, ...rest] = argv;
	const args = flags(rest);
	const allowed = FLAGS[command ?? ""];
	if (!allowed) throw new Usage(USAGE);
	for (const name of args.keys()) if (!allowed.includes(name)) throw new Usage(`${command} does not take --${name}`);
	if (command === "score") {
		const measured = loadMeasured(readFileSync(need(args, "measured"), "utf8"), need(args, "measured"));
		const paths = args.get("predictions") ?? [];
		if (paths.length === 0) throw new Usage("--predictions is required");
		const result = scoreAll(paths.map(path => loadPredictionDoc(readFileSync(path, "utf8"), path)), measured);
		process.stdout.write(`${JSON.stringify({ schema: "fleet-round.scores/v1", ...result }, null, 2)}\n`);
		return 0;
	}
	const configPath = need(args, "config");
	const config = loadConfig(readFileSync(configPath, "utf8"), configPath);
	if (command === "barrier") return barrier(args, config, configPath);
	const project = need(args, "project");
	if (command === "collect") {
		writeFileSync(need(args, "out"), `${JSON.stringify(collect(config, project), null, 2)}\n`);
		return 0;
	}
	const bundle = bundleFor(args, config, project);
	const now = one(args, "now") === null ? Date.parse(bundle.captured_at) : time(one(args, "now")!, "now");
	if (command === "snapshot") {
		const tracker = parseTracker(bundle);
		const snapshot: Snapshot = {
			schema: "fleet-round.snapshot/v1",
			project,
			round_start: one(args, "round-start") ?? bundle.captured_at,
			beads: [...tracker.beads.values()].filter(b => HELD_STATUSES.includes(b.status)).map(b => ({ id: b.id, status: b.status, assignee: b.assignee })),
		};
		time(snapshot.round_start, "round-start");
		writeFileSync(need(args, "out"), `${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}
	if (command === "spot-check") {
		const rate = Number(one(args, "rate") ?? "0.1");
		if (!(rate > 0 && rate <= 1)) throw new Usage("--rate must be in (0, 1]");
		const result = spotCheck(parseTracker(bundle), time(need(args, "since"), "since"), now, need(args, "seed"), rate);
		process.stdout.write(`${JSON.stringify({ schema: "fleet-round.spot-check/v1", project, seed: need(args, "seed"), rate, ...result, rerun: result.sample.map(id => `br show ${id} --json`) }, null, 2)}\n`);
		return 0;
	}
	const focusArg = one(args, "focus");
	const options: CheckOptions = {
		now,
		staleHours: config.stale_hours,
		frontierTop: config.frontier_top,
		approver: config.approver,
		focus: focusArg === null ? null : focusArg.split(",").map(s => s.trim()).filter(Boolean),
		snapshot: loadSnapshot(one(args, "snapshot")),
	};
	if (command === "check") {
		const verdict = evaluate(bundle, config, options);
		emit(verdict, args);
		return code(verdict.pass_bar);
	}
	// validate: focus comes only from the report's FOCUS line (FLAGS refuses --focus), so the report is judged on its own declaration.
	const verdict = validateWith(readFileSync(need(args, "report"), "utf8"), bundle, config, options);
	emit(verdict, args);
	const codes = [code(verdict.report.status), code(verdict.pass_bar)];
	return codes.includes(1) ? 1 : codes.every(c => c === 0) ? 0 : 3;
}

if (import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(`fleet-round: ${error instanceof Usage ? "" : "error: "}${(error as Error).message}`);
		process.exitCode = 2;
	}
}
