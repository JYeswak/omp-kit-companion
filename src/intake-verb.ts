// intake-verb: `omp-kit intake` CLI composition for INTAKE1 (bead ompkit-fp72.19.1.19).
// AC1: record rule/work rows in intake.jsonl (work -> br search, else print new
// bead arguments with acceptance, parent and blocks edge), resolve the receiving seat's
// role, print DO or ROUTE <bead> -> <seat> plus the one-line reply.
// AC2: ROUTE delivers through the existing path (br assignee + Agent Mail +
// tern delivery) via deliverRoute and proves delivery from the session file.
// AC3: every run reports the hourly ledger counts (received/routed/done/overridden).
// AC4 (role-prompt citations + Joshua approval) is explicitly out of scope here.

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
	beadArgsFor,
	recordIntakeRow,
	resolveWorkIntake,
	type BrRunner,
	type IntakeKind,
} from "./intake-record.ts";
import {
	formatRoute,
	resolveSeatRole,
	routeIntake,
	routeToJson,
	type SeatRole,
} from "./intake-route.ts";
import {
	deliverRoute,
	intakeCountsLine,
	readIntakeRows,
	summarizeIntakeHour,
	INTAKE_DELIVER_HOUR_MS,
	type DeliverDeps,
	type DeliverResult,
	type IntakeHourlyCounts,
} from "./intake-deliver.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

export const INTAKE_VERB_SCHEMA = "omp-kit.intake.v1";
export const INTAKE_BR_TIMEOUT_MS = 30_000;

export interface IntakeVerbOptions {
	from: string;
	text: string;
	seat: string;
	kind?: IntakeKind;
	roleOverride?: string;
	/** Absolute repo root: intake ledger + br cwd. Defaults to the caller cwd. */
	repo?: string;
	/** Tracker for br reads/writes (passed as --db right after br). */
	db?: string;
	/** Parsed fleet-watch.json value for role resolution + roster lookup. */
	config?: unknown;
	/** The runner would do the work itself; refused without roleOverride. */
	selfDo?: boolean;
	/** Parent bead for a newly created work bead. */
	parent?: string;
	/** Bead id the new work bead blocks (--deps blocks:<id>). */
	blocks?: string;
	/** Attempt AC2 delivery when the verdict is ROUTE. Default false. */
	deliver?: boolean;
	session?: string;
	pane?: string;
	windowKey?: string;
	dropDir?: string;
	project?: string;
	mailFrom?: string;
	mailSubject?: string;
	directorSeat?: string;
	workerSeat?: string;
	now?: () => string;
	nowMs?: () => number;
	runBr?: BrRunner;
	deliverDeps?: DeliverDeps;
}

export interface IntakeVerbResult {
	action: "DO" | "ROUTE" | "REFUSE" | "PENDING";
	bead: string | null;
	seat: string;
	role: SeatRole;
	stdout: string;
	json: Record<string, unknown>;
	deliver?: DeliverResult;
	counts: IntakeHourlyCounts;
	countsLine: string;
	exit: 0 | 1 | 2;
}

function fail(action: IntakeVerbResult["action"], seat: string, stdout: string, json: Record<string, unknown>, exit: 0 | 1 | 2): IntakeVerbResult {
	const counts: IntakeHourlyCounts = { hour: new Date(0).toISOString(), received: 0, routed: 0, doneInRole: 0, overridden: 0 };
	return { action, bead: null, seat, role: "UNKNOWN", stdout, json, counts, countsLine: intakeCountsLine(counts), exit };
}

function countForRepo(repo: string, nowMs: number): { counts: IntakeHourlyCounts; countsLine: string } {
	let rows;
	try {
		rows = readIntakeRows(repo);
	} catch {
		rows = [];
	}
	const hourStart = Math.floor(nowMs / INTAKE_DELIVER_HOUR_MS) * INTAKE_DELIVER_HOUR_MS;
	const counts = summarizeIntakeHour(rows, hourStart);
	return { counts, countsLine: intakeCountsLine(counts) };
}

function createdBeadId(stdout: string): string | null {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (Array.isArray(value)) value = value[0];
	if (typeof value !== "object" || value === null || !("id" in value)) return null;
	const id: unknown = value.id;
	return typeof id === "string" && id.trim() !== "" ? id : null;
}

function defaultBr(argv: string[], opts: { cwd: string; timeoutMs: number }): { argv: string[]; code: number; out: string } {
	const result = spawnSync(argv[0], argv.slice(1), { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
	return { argv, code: result.status ?? 1, out: result.error?.message ?? result.stdout ?? "" };
}

export async function runIntakeVerb(opts: IntakeVerbOptions, deps: { runBr?: BrRunner; deliverDeps?: DeliverDeps } = {}): Promise<IntakeVerbResult> {
	const seat = opts.seat.trim();
	const text = opts.text.trim();
	if (opts.from.trim() !== "joshua") {
		return fail("REFUSE", seat, "REFUSE WRONG_SOURCE\nRefused: intake records Joshua's requests; --from joshua is required.\n",
			{ action: "REFUSE", reason: "WRONG_SOURCE", reply: "Refused: intake records Joshua's requests; --from joshua is required." }, 2);
	}
	if (text === "" || seat === "") {
		return fail("REFUSE", seat, "REFUSE EMPTY_INPUT\nRefused: --text and --seat are both required.\n",
			{ action: "REFUSE", reason: "EMPTY_INPUT", reply: "Refused: --text and --seat are both required." }, 2);
	}
	const kind: IntakeKind = opts.kind ?? "work";
	if (kind !== "rule" && kind !== "work") {
		return fail("REFUSE", seat, "REFUSE BAD_KIND\nRefused: --kind must be rule|work.\n",
			{ action: "REFUSE", reason: "BAD_KIND", reply: "Refused: --kind must be rule|work." }, 2);
	}
	const repoRaw = (opts.repo ?? process.cwd()).trim();
	if (repoRaw === "" || !isAbsolute(repoRaw)) {
		return fail("REFUSE", seat, "REFUSE BAD_REPO\nRefused: --repo must be an absolute path.\n",
			{ action: "REFUSE", reason: "BAD_REPO", reply: "Refused: --repo must be an absolute path." }, 2);
	}
	const repo = resolve(repoRaw);
	const role: SeatRole = opts.config === undefined ? "UNKNOWN" : resolveSeatRole(opts.config, seat);
	const runBr = deps.runBr ?? opts.runBr ?? defaultBr;
	const now = opts.now ?? (() => new Date().toISOString());
	const nowMs = (opts.nowMs ?? Date.now)();

	if (kind === "rule") {
		const row = recordIntakeRow({ repo, text, kind: "rule", route: "DO", bead: null, seat, role, now });
		const reply = `recorded rule from joshua for ${seat}`;
		const tallied = countForRepo(repo, nowMs);
		return {
			action: "DO", bead: null, seat, role,
			stdout: `DO\n${reply}\n${tallied.countsLine}\n`,
			json: { action: "DO", bead: null, reply, row, counts: tallied.counts },
			counts: tallied.counts, countsLine: tallied.countsLine, exit: 0,
		};
	}

	const found = resolveWorkIntake(text, { cwd: repo, runBr });
	let bead = found.bead;
	let createdArgs: string[] | null = null;
	if (bead === null) {
		const args = beadArgsFor(text);
		const dbArgs = opts.db !== undefined && opts.db.trim() !== "" ? ["--db", opts.db.trim()] : [];
		const createArgv = ["br", ...dbArgs, "create", "--title", args.title, "--type", "task",
			"--description", args.parentPrompt, "--acceptance-criteria", args.acceptance];
		if (opts.parent !== undefined && opts.parent.trim() !== "") createArgv.push("--parent", opts.parent.trim());
		if (opts.blocks !== undefined && opts.blocks.trim() !== "") createArgv.push("--deps", `blocks:${opts.blocks.trim()}`);
		createdArgs = createArgv;
		let run;
		try {
			run = runBr(createArgv, { cwd: repo, timeoutMs: INTAKE_BR_TIMEOUT_MS });
		} catch (error) {
			run = { argv: createArgv, code: 1, out: error instanceof Error ? error.message : String(error) };
		}
		if (run.code !== 0) {
			const row = recordIntakeRow({ repo, text, kind: "work", route: "PENDING", bead: null, seat, role, now });
			const reply = `recorded work from joshua; bead creation failed (${run.out.slice(0, 160)}); bead args follow`;
			const tallied = countForRepo(repo, nowMs);
			return {
				action: "PENDING", bead: null, seat, role,
				stdout: `PENDING\n${reply}\n${JSON.stringify(args)}\n${tallied.countsLine}\n`,
				json: { action: "PENDING", bead: null, reply, beadArgs: args, row, counts: tallied.counts },
				counts: tallied.counts, countsLine: tallied.countsLine, exit: 1,
			};
		}
		bead = createdBeadId(run.out);
		if (bead === null) {
			const row = recordIntakeRow({ repo, text, kind: "work", route: "PENDING", bead: null, seat, role, now });
			const reply = "recorded work from joshua; bead created but the id was unreadable; bead args follow";
			const tallied = countForRepo(repo, nowMs);
			return {
				action: "PENDING", bead: null, seat, role,
				stdout: `PENDING\n${reply}\n${JSON.stringify(args)}\n${tallied.countsLine}\n`,
				json: { action: "PENDING", bead: null, reply, beadArgs: args, row, counts: tallied.counts },
				counts: tallied.counts, countsLine: tallied.countsLine, exit: 1,
			};
		}
	}

	const overrideQuote = (opts.roleOverride ?? "").trim();
	const verdict = routeIntake({
		seat, role, bead, text,
		selfDo: opts.selfDo === true || overrideQuote !== "" ? true : undefined,
		roleOverride: opts.roleOverride,
		directorSeat: opts.directorSeat, workerSeat: opts.workerSeat,
	}, opts.config);
	if (verdict.action === "ROUTE" && overrideQuote !== "") {
		// Joshua named this seat: it does the work itself. The ledger row
		// (role != owner) counts as overridden in the hourly tally.
		const reply = `Doing ${bead} on Joshua's words (${JSON.stringify(overrideQuote)}): ${text}`;
		const row = recordIntakeRow({ repo, text, kind: "work", route: `DO ${bead}`, bead, seat, role, now });
		const tallied = countForRepo(repo, nowMs);
		return {
			action: "DO", bead, seat, role,
			stdout: `DO ${bead}\n${reply}\n${tallied.countsLine}\n`,
			json: { action: "DO", bead, reply, roleOverride: overrideQuote, row, counts: tallied.counts },
			counts: tallied.counts, countsLine: tallied.countsLine, exit: 0,
		};
	}
	if (verdict.action === "REFUSE") {
		const row = recordIntakeRow({ repo, text, kind: "work", route: `REFUSE ${verdict.reason}`, bead, seat, role, now });
		const tallied = countForRepo(repo, nowMs);
		return {
			action: "REFUSE", bead, seat, role,
			stdout: `${formatRoute(verdict)}\n${tallied.countsLine}\n`,
			json: { ...routeToJson(verdict), row, counts: tallied.counts },
			counts: tallied.counts, countsLine: tallied.countsLine, exit: 2,
		};
	}
	const routeLine = verdict.action === "DO" ? `DO ${bead}` : `ROUTE ${bead} -> ${verdict.seat}`;
	recordIntakeRow({ repo, text, kind: "work", route: routeLine, bead, seat, role, now });

	let deliver: DeliverResult | undefined;
	let stdout = `${formatRoute(verdict)}\n`;
	let exit: 0 | 1 | 2 = 0;
	if (verdict.action === "ROUTE") {
		if (opts.deliver === true) {
			for (const [key, value] of [["session", opts.session], ["pane", opts.pane], ["windowKey", opts.windowKey], ["dropDir", opts.dropDir], ["project", opts.project]] as const) {
				if (typeof value !== "string" || value.trim() === "") {
					const tallied = countForRepo(repo, nowMs);
					return {
						action: "ROUTE", bead, seat, role,
						stdout: `${stdout}${tallied.countsLine}\n`,
						json: { ...routeToJson(verdict), delivery: null, counts: tallied.counts },
						counts: tallied.counts, countsLine: tallied.countsLine, exit: 2,
					};
				}
			}
			deliver = await deliverRoute({
				bead, seat: verdict.seat, text, repo,
				project: opts.project!.trim(), session: opts.session!.trim(), pane: opts.pane!.trim(),
				windowKey: opts.windowKey!.trim(), dropDir: opts.dropDir!.trim(),
				from: opts.mailFrom, subject: opts.mailSubject,
			}, deps.deliverDeps ?? opts.deliverDeps ?? {});
			stdout += `delivery: ${deliver.status} ${deliver.detail}\n`;
			if (deliver.status === "BR_FAILED" || deliver.status === "MAIL_FAILED" || deliver.status === "FALLBACK") exit = 1;
			const tallied = { counts: deliver.counts, countsLine: deliver.countsLine };
			stdout += `${tallied.countsLine}\n`;
			return {
				action: "ROUTE", bead, seat, role, stdout,
				json: { ...routeToJson(verdict), delivery: { status: deliver.status, marker: deliver.marker, sessionFile: deliver.sessionFile, dropPath: deliver.dropPath, detail: deliver.detail }, counts: tallied.counts },
				deliver, counts: tallied.counts, countsLine: tallied.countsLine, exit,
			};
		}
	}
	const tallied = countForRepo(repo, nowMs);
	stdout += `${tallied.countsLine}\n`;
	return {
		action: verdict.action, bead, seat, role, stdout,
		json: { ...routeToJson(verdict), counts: tallied.counts },
		counts: tallied.counts, countsLine: tallied.countsLine, exit,
	};
}

function flagOf(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
}

/** `omp-kit intake --from joshua --text <request> --seat <seat> [--kind rule|work ...]`. */
export async function intakeCommand(request: ParsedCommand): Promise<CliResult> {
	const home = process.env.HOME;
	if (typeof home !== "string" || home === "" || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNAVAILABLE" }, errors: [{ code: "HOME_UNAVAILABLE", message: "Intake needs an absolute HOME",
			remediation: "Run with an absolute HOME; nothing was recorded." }], verification: "UNVERIFIED" };
	}
	const seat = flagOf(request.flags, "--seat") ?? process.env.AGENT_NAME ?? "";
	const configPath = flagOf(request.flags, "--config")
		?? (typeof process.env.OMP_KIT_FLEET_WATCH_CONFIG === "string" && process.env.OMP_KIT_FLEET_WATCH_CONFIG !== ""
			? process.env.OMP_KIT_FLEET_WATCH_CONFIG : `${home}/.config/omp-kit/fleet-watch.json`);
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		config = undefined;
	}
	const kindFlag = flagOf(request.flags, "--kind");
	const result = await runIntakeVerb({
		from: flagOf(request.flags, "--from") ?? "",
		text: flagOf(request.flags, "--text") ?? "",
		seat,
		kind: kindFlag === undefined ? "work" : kindFlag as IntakeKind,
		selfDo: request.flags.has("--self-do"),
		roleOverride: flagOf(request.flags, "--role-override"),
		repo: flagOf(request.flags, "--repo"),
		db: flagOf(request.flags, "--db"),
		config,
		parent: flagOf(request.flags, "--parent"),
		blocks: flagOf(request.flags, "--blocks"),
		deliver: request.flags.has("--deliver"),
		session: flagOf(request.flags, "--session"),
		pane: flagOf(request.flags, "--pane"),
		windowKey: flagOf(request.flags, "--window-key"),
		dropDir: flagOf(request.flags, "--drop-dir"),
		project: flagOf(request.flags, "--project"),
		directorSeat: flagOf(request.flags, "--director-seat"),
		workerSeat: flagOf(request.flags, "--worker-seat"),
	});
	if (result.exit === 2 && (result.action === "REFUSE")) {
		const reason = typeof result.json.reason === "string" ? result.json.reason : "INTAKE_REFUSED";
		return { code: 2, data: { overall: "REFUSED", schema: INTAKE_VERB_SCHEMA, ...result.json, counts_line: result.countsLine },
			errors: [{ code: reason, message: result.stdout.split("\n")[1] ?? "Intake refused", remediation: "Fix the flagged input; nothing was recorded." }],
			verification: "UNVERIFIED" };
	}
	return {
		code: result.exit === 0 ? 0 : 1,
		data: { overall: result.exit === 0 ? "OK" : "FINDINGS", schema: INTAKE_VERB_SCHEMA, ...result.json, counts_line: result.countsLine },
		verification: "UNVERIFIED",
	};
}
