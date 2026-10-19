import { appendFileSync, mkdirSync, statSync, type Stats } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type IntakeKind = "rule" | "work";

export interface IntakeRecordRow {
	at: string;
	from: "joshua";
	text: string;
	kind: IntakeKind;
	route: string;
	bead: string | null;
	seat: string;
	role: string;
}

export interface IntakeBeadArgs {
	title: string;
	acceptance: string;
	parentPrompt: string;
}

export interface IntakeRun {
	argv: string[];
	code: number;
	out: string;
}

export type BrRunner = (argv: string[], opts: { cwd: string; timeoutMs: number }) => IntakeRun;

export const BR_TIMEOUT_MS = 30_000;
export const INTAKE_DECISIONS_REL = "decisions/joshua.jsonl";

function defaultRunner(argv: string[], opts: { cwd: string; timeoutMs: number }): IntakeRun {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd: opts.cwd,
		encoding: "utf8",
		timeout: opts.timeoutMs,
		maxBuffer: 4 * 1024 * 1024,
	});
	return {
		argv,
		code: result.status ?? 1,
		out: result.error?.message ?? result.stdout ?? "",
	};
}

/** Validate the repo root before any write. Throws on malformed paths; never writes. */
export function resolveDecisionsPath(repo: string): string {
	if (typeof repo !== "string" || repo.trim() === "") throw new Error("intake record refused: empty repo path");
	if (!isAbsolute(repo)) throw new Error("intake record refused: repo path must be absolute: " + repo);
	const root = resolve(repo);
	let stat: Stats;
	try {
		stat = statSync(root);
	} catch {
		throw new Error("intake record refused: repo path does not exist: " + root);
	}
	if (!stat.isDirectory()) throw new Error("intake record refused: repo path is not a directory: " + root);
	return join(root, INTAKE_DECISIONS_REL);
}

export interface RecordIntakeInput {
	repo: string;
	text: string;
	kind: IntakeKind;
	route: string;
	bead: string | null;
	seat: string;
	role: string;
	now?: () => string;
}

export function recordIntakeRow(input: RecordIntakeInput): IntakeRecordRow {
	if (typeof input.text !== "string" || input.text.trim() === "")
		throw new Error("intake record refused: empty request text");
	if (input.kind !== "rule" && input.kind !== "work")
		throw new Error("intake record refused: kind must be rule|work");
	for (const field of ["route", "seat", "role"] as const) {
		if (typeof input[field] !== "string" || input[field].trim() === "")
			throw new Error(`intake record refused: empty ${field}`);
	}
	if (input.bead !== null && (typeof input.bead !== "string" || input.bead.trim() === ""))
		throw new Error("intake record refused: bead must be an id or null");
	const path = resolveDecisionsPath(input.repo);
	const row: IntakeRecordRow = {
		at: input.now ? input.now() : new Date().toISOString(),
		from: "joshua",
		text: input.text,
		kind: input.kind,
		route: input.route,
		bead: input.bead,
		seat: input.seat,
		role: input.role,
	};
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
	return row;
}

/** Search open beads for the request. Returns the first matching open bead id, or null. */
export function resolveWorkIntake(
	text: string,
	opts: { cwd: string; runBr?: BrRunner },
): { bead: string | null; error?: string } {
	const runBr = opts.runBr ?? defaultRunner;
	let run: IntakeRun;
	try {
		run = runBr(["br", "search", "--json", "--status", "open", text], { cwd: opts.cwd, timeoutMs: BR_TIMEOUT_MS });
	} catch (error) {
		return { bead: null, error: error instanceof Error ? error.message : String(error) };
	}
	if (run.code !== 0) return { bead: null, error: run.out.slice(0, 200) || "br search exited " + run.code };
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.out);
	} catch {
		return { bead: null, error: "br search returned invalid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || !("issues" in parsed)) {
		return { bead: null, error: "br search returned an unexpected shape" };
	}
	const issuesRaw: unknown = parsed.issues;
	if (!Array.isArray(issuesRaw)) return { bead: null, error: "br search returned an unexpected shape" };
	const first: unknown = issuesRaw[0];
	if (first === null || typeof first !== "object" || !("id" in first)) return { bead: null };
	const id: unknown = first.id;
	return { bead: typeof id === "string" && id.trim() !== "" ? id : null };
}

/** Bead creation arguments for a work request with no open match. Printed, never created here. */
export function beadArgsFor(text: string): IntakeBeadArgs {
	const title = text.length > 80 ? text.slice(0, 77) + "..." : text;
	return {
		title,
		acceptance: "TBD: owner states observable done criteria before delivery slice claims this bead.",
		parentPrompt: "Parent intake request (verbatim): " + text,
	};
}

/** First stdout line of the route print format. */
export function formatRouteLine(route: string, bead: string | null, seat: string): string {
	if (route === "DO") return bead === null ? "DO" : `DO ${bead}`;
	if (route === "PENDING") return "PENDING";
	return `ROUTE ${bead} -> ${seat}`;
}

export interface HandleIntakeInput {
	repo: string;
	text: string;
	kind: IntakeKind;
	seat: string;
	role: string;
	runBr?: BrRunner;
	now?: () => string;
}

export interface HandleIntakeResult {
	row: IntakeRecordRow;
	stdout: string;
	json: { route: string; bead: string | null; reply: string; beadArgs?: IntakeBeadArgs };
}

/**
 * Record path for `intake --from joshua --text <request>`. No routing logic:
 * rule rows record route DO; work rows search open beads and, with no match,
 * record bead:null route PENDING and return the bead creation arguments for
 * the deliver slice (the bead is NOT created here).
 */
export function handleIntake(input: HandleIntakeInput): HandleIntakeResult {
	if (input.kind === "rule") {
		const row = recordIntakeRow({ ...input, route: "DO", bead: null });
		const reply = `recorded rule from joshua for ${input.seat}`;
		return {
			row,
			stdout: `${formatRouteLine("DO", null, input.seat)}\n${reply}\n`,
			json: { route: "DO", bead: null, reply },
		};
	}
	const found = resolveWorkIntake(input.text, { cwd: resolve(input.repo), runBr: input.runBr });
	if (found.bead !== null) {
		const route = `ROUTE ${found.bead} -> ${input.seat}`;
		const row = recordIntakeRow({ ...input, route, bead: found.bead });
		const reply = `recorded work from joshua; matches open bead ${found.bead}`;
		return {
			row,
			stdout: `${formatRouteLine(route, found.bead, input.seat)}\n${reply}\n`,
			json: { route, bead: found.bead, reply },
		};
	}
	const beadArgs = beadArgsFor(input.text);
	const row = recordIntakeRow({ ...input, route: "PENDING", bead: null });
	const reply =
		found.error !== undefined
			? `recorded work from joshua; br search unavailable (${found.error}); bead args follow`
			: "recorded work from joshua; no open bead matches; bead args follow";
	return {
		row,
		stdout: `PENDING\n${reply}\n${JSON.stringify(beadArgs)}\n`,
		json: { route: "PENDING", bead: null, reply, beadArgs },
	};
}
