import { cpus } from "node:os";
import { resolve } from "node:path";
import { check as checkGit } from "../src/fleet-guard/git.ts";
import { commandFromEvent } from "../src/fleet-guard/git.ts";
import { check as checkReservations, exportAgentMailStorageRoot } from "../src/fleet-guard/reservations.ts";
import { adoptOwnerlessDir, applyScratchEnv, autoCompletedLine, check as checkScratch, checkSystemTemp, createdScratchTops, hostAgentName, rewriteShellCommand, rewriteToolInput, scratchDirFor, toolTargetPaths, writeScratchOwner, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent, type RewriteMapping } from "../src/fleet-guard/scratch.ts";
import { endSeat, liveSeatEndDeps, type SeatEndDeps } from "../src/fleet-guard/seat-end.ts";
import { check as checkDurability } from "../src/fleet-guard/durability.ts";
import { check as checkWriteOwnership } from "../src/fleet-guard/write-own.ts";
import { checkPlutilInPlace } from "../src/fleet-guard/plutil.ts";
import { fleetPolicyState } from "./fleet-policy.ts";
import { nativeIdentity, type NativeContext } from "./native-identity.ts";
import { recordGateEvent } from "./gate-events.ts";

/**
 * fleet-guard: force the fleet rules inside the session instead of asking.
 * Scratch goes to the repo-local var/agent-tmp (never /tmp), work happens on main,
 * every write outside var/agent-tmp in a fleet checkout needs the caller's exclusive
 * Agent Mail reservation, and agent calls never switch the commit guard off.
 * Always on, opt-in or not: plutil edits must name their output (PLUTIL_IN_PLACE), and system temp is never written
 * (TMPWRITE1; remedy `omp-kit scratch new`).
 * Shipped in the plugin; installed per profile by the kit.
 */

interface ToolCallContext {
	cwd: string;
	localProtocolOptions?: { getArtifactsDir?: () => string | null };
	sessionManager?: { getSessionId?: () => string | undefined };
	ui?: { notify?: (message: string, type?: string) => void };
}

/** The calling session's local:// backing root, from OMP's own mapping; never guessed from cwd. */
function localRootOf(context: ToolCallContext | undefined): string | undefined {
	const artifactsDir = context?.localProtocolOptions?.getArtifactsDir?.();
	return artifactsDir ? resolve(artifactsDir, "local") : undefined;
}

interface ExtensionApi {
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: FleetGuardEvent, context?: ToolCallContext) => Promise<FleetGuardBlock | GuardRewrite | undefined>): void;
	on(event: "session_shutdown", handler: (event: unknown, context?: ToolCallContext) => Promise<void>): void;
}
/** A completed literal: revised input and/or the AUTO_COMPLETED notice the result carries. */
export interface GuardRewrite { input?: Record<string, unknown>; additionalContext?: string }

export interface GuardDeps {
	cwd?: string;
	pid?: number;
	env?: Record<string, string | undefined>;
	/** Test seam for the session-end disposal; defaults to ps and the kit's own release. */
	seatEnd?: SeatEndDeps;
}

/**
 * CONTENTION1 (ompkit-fp72.120.16.172). On 2026-11-04 one contention proof ran 64 unbounded `while :; do :; done`
 * loops outside heavy admission; load reached 152 on 32 cores and every seat, Agent Mail included, stalled.
 * Always on (the machine is shared by every session). A pure check over the command text: a busy loop is admitted
 * only as `omp-kit heavy ... timeout <s>|--deadline ... nice -n 19`, with at most ncpu/2 copies; heavy itself
 * refuses admission while load1 >= ncpu. Every pattern is linear: no nested or overlapping quantifiers.
 */
// A loop whose condition and body are both no-ops (`:`/`true`), `yes` or a /dev/zero copy discarded to /dev/null.
const BUSY_LOOP = /(?:^|[\s;&|(`'"])(?:while\s+(?::|true)\s*(?:;\s*)?do\s+(?::|true)\s*(?:;\s*)?done|yes(?:\s+[^\s;&|<>]+)?\s*>\s*\/dev\/null|cat\s+\/dev\/(?:u?random|zero)\s*>\s*\/dev\/null)(?=$|[\s;&|)`'"])/g;
// `for v in $(seq [a] N)` or `{a..N}`: the copy count when its body backgrounds a busy loop.
const FAN_OUT = /(?:^|[\s;&|(`'"])for\s+\w+\s+in\s+(?:\$\(\s*seq\s+(?:\d{1,9}\s+)?(\d{1,9})\s*\)|\{\d{1,9}\.\.(\d{1,9})\})\s*(?:;\s*)?do(?=\s)/g;
const HEAVY = /^\s*omp-kit\s+heavy\s/;
const DEADLINE = /(?:^|\s)(?:timeout\s+\d{1,9}[smhd]?|--deadline(?:=|\s+)\d)/;
const NICE19 = /(?:^|\s)nice\s+-n\s*19\s/;
const CONTENTION_REMEDY = "run contention fixtures as `omp-kit heavy --label <x> -- timeout <s> nice -n 19 <cmd>`, at most ncpu/2 loops, and only when load1 < ncpu (heavy refuses admission otherwise)";

export function checkContention(event: FleetGuardEvent, ncpu = cpus().length): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const loops = command.match(BUSY_LOOP)?.length ?? 0;
	if (loops === 0) return undefined;
	let copies = loops;
	if (/&/.test(command)) for (const fan of command.matchAll(FAN_OUT)) copies = Math.max(copies, loops * Number(fan[1] ?? fan[2]));
	const cap = Math.max(1, Math.floor(ncpu / 2));
	const bounded = HEAVY.test(command) && DEADLINE.test(command) && NICE19.test(command);
	if (bounded && copies <= cap) return undefined;
	const why = bounded ? `${copies} busy-loop copies exceed ncpu/2 = ${cap}` : `${copies} unbounded busy loop${copies === 1 ? "" : "s"} outside the heavy lane, deadline and nice 19`;
	return { block: true, reason: `fleet-guard CONTENTION1: ${why}; ${CONTENTION_REMEDY}` };
}

/** Ordered chain: lexical scratch, Git, repository facts, write ownership, then reservations. First block wins. */
export async function handleToolCall(event: FleetGuardEvent, context: FleetGuardContext & { childAgentName?: string }): Promise<FleetGuardBlock | undefined> {
	const reservations = { cwd: context.cwd, agentName: context.agentName,
		isTrackedPath: context.isTrackedPath, lookupReservations: context.lookupReservations, warn: context.warn };
	const early = checkScratch(event, context) ?? checkGit(event, context) ?? await checkDurability(event, context) ??
		await checkWriteOwnership(event, { ...context, fleetPolicy: fleetPolicyState });
	if (early) return early;
	// NATIVEPREGRADE1: a native child's own hold admits the write as well as the seat's (the parent may reserve for it).
	if (context.childAgentName && !(await checkReservations(event, { ...reservations, agentName: context.childAgentName }))) return undefined;
	return await checkReservations(event, reservations) ?? undefined;
}
/**
 * Per-guard session rewrite state: one owned scratch dir, the literal -> file mapping, the
 * scratch-top dirs this session created (M3: only these may be adopted), and adopted dirs to
 * release at session end exactly like the seat dir.
 */
export interface SessionRewriteState { dir: string; aliases: Map<string, string>; createdDirs: Set<string>; adopted: string[] }
/** One AUTO_COMPLETED line per mapping, with the M2 disclaimer when a real file also sits at the literal. */
export function rewriteNotice(mapped: Array<RewriteMapping>): string {
	return mapped.map((entry) => {
		const line = autoCompletedLine(entry.from, entry.to);
		return entry.note === undefined ? line : `${line} (${entry.note})`;
	}).join("\n");
}
/**
 * TMPREWRITE1 (ompkit-1ra0d.144): complete a literal simple /tmp file into the session scratch
 * instead of refusing it. Returns the revised input plus the AUTO_COMPLETED notice when every
 * system-temp target proves a rewritable whole word; undefined runs the existing checks
 * unchanged (today's refusal included). The revised input is rechecked through the same guard
 * chain before it is returned, so a rewrite never bypasses another guard.
 */
export async function maybeSessionRewrite(event: FleetGuardEvent, opts: { callingCwd: string; localRoot: string | undefined; agent?: string; session?: string; state: SessionRewriteState | null; recheck: (event: FleetGuardEvent) => Promise<FleetGuardBlock | undefined> | FleetGuardBlock | undefined }): Promise<GuardRewrite | undefined> {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	if (tool !== "write" && tool !== "edit" && tool !== "read" && tool !== "bash") return undefined;
	if (opts.state === null) return undefined;
	const context: FleetGuardContext = { cwd: opts.callingCwd, ...(opts.localRoot !== undefined ? { localRoot: opts.localRoot } : {}), ...(opts.agent !== undefined ? { agentName: opts.agent } : {}) };
	const rewriteOpts = { cwd: opts.callingCwd, context, sessionDir: opts.state.dir, aliases: opts.state.aliases };
	if (tool === "bash") {
		const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
		if (!command) return undefined;
		const rewritten = rewriteShellCommand(command, { cwd: opts.callingCwd, home: process.env.HOME ?? "", sessionDir: opts.state.dir, aliases: opts.state.aliases });
		if (rewritten === undefined || "refuse" in rewritten) return undefined;
		const input = { ...(typeof event.input === "object" && event.input !== null ? event.input as Record<string, unknown> : {}), command: rewritten.command };
		if (await opts.recheck({ ...event, input })) return undefined;
		return { input, additionalContext: rewriteNotice(rewritten.mapped) };
	}
	const rewritten = rewriteToolInput(tool, event.input, rewriteOpts);
	if (rewritten === undefined || "refuse" in rewritten) return undefined;
	if (await opts.recheck({ ...event, input: rewritten.input })) return undefined;
	return { input: rewritten.input, additionalContext: rewriteNotice(rewritten.mapped) };
}
/**
 * Adopt a session-created ownerless scratch dir before the write-ownership guard sees it (M3).
 * Only directories the session guard state recorded as created by this session are eligible; an
 * ownerless directory the session did not create keeps today's refusal, with the remedy text.
 * Returns the AUTO_COMPLETED notice when a dir was adopted; undefined otherwise.
 */
export function maybeAdoptOwnerless(event: FleetGuardEvent, opts: { callingCwd: string; agent?: string; session?: string; createdDirs?: ReadonlySet<string>; adoptedDirs?: string[] }): string | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	if ((tool !== "write" && tool !== "edit") || !event.input || typeof event.input !== "object") return undefined;
	let adopted: string | undefined;
	for (const value of toolTargetPaths(event.input)) {
		const result = adoptOwnerlessDir(value, { cwd: opts.callingCwd, agent: opts.agent, session: opts.session, createdDirs: opts.createdDirs });
		if ("refuse" in result) continue;
		if (opts.adoptedDirs !== undefined && !opts.adoptedDirs.includes(result.dir)) opts.adoptedDirs.push(result.dir);
		const line = `AUTO_COMPLETED: adopted ownerless scratch dir ${result.dir} for ${opts.agent ?? "the calling seat"}`;
		adopted = adopted === undefined ? line : `${adopted}\n${line}`;
	}
	return adopted;
}
/** Append the session scratch dir to a temp/scratch refusal so the agent can use it directly. */
function withSessionHint(block: FleetGuardBlock | undefined, dir: string | null): FleetGuardBlock | undefined {
	if (!block?.block || dir === null) return block;
	if (!/system-temp|scratch-write|scratch ownership|scratch-alloc|\.owner/.test(block.reason)) return block;
	if (block.reason.includes("Session scratch:")) return block;
	return { block: true, reason: `${block.reason}\nSession scratch: ${dir} (a literal /tmp/<name> auto-completes there when it is a simple file; use this dir directly).` };
}
/** Best-effort completion ledger row; a ledger failure never changes the verdict. */
async function recordCompletion(seatName: string | undefined, tool: string, notice: string, from: string): Promise<void> {
	try {
		await recordGateEvent({ seat: seatName ?? null, act: tool, target: from, gate: "tmp-rewrite", kind: "auto_complete", detail: notice.slice(0, 200) });
	} catch { /* the verdict stands; the ledger is best effort */ }
}
export default async function fleetGuard(pi: ExtensionApi, deps?: GuardDeps): Promise<void> {
	const cwd = deps?.cwd ?? process.cwd();
	const pid = deps?.pid ?? process.pid;
	const initial = await fleetPolicyState(cwd);
	// PLUTILINPLACE1 (ompkit-ffb85): the plists it protects live outside every repository, so no opt-in scopes it.
	// TMPWRITE1 (ompkit-fp72.120.16.158): system-temp writes are refused in every session, seat or subagent alike.
	if (initial.kind === "off") {
		pi.on("tool_call", async (event, context) => checkPlutilInPlace(event) ?? checkContention(event) ?? checkSystemTemp(event, { cwd: context?.cwd ?? cwd,
			localRoot: localRootOf(context) }));
		return;
	}
	// The seat dir is owned by the agent and its omp session, never by a bare pid. The session id is only known
	// once the session manager is in a tool-call context, so the first call records it (once: later calls may
	// belong to a subagent session).
	let seat: { dir: string; repo: string; created: string; recorded: boolean; agent?: string; session?: string } | null = null;
	if (initial.kind === "on") {
		const dir = scratchDirFor(initial.root, pid);
		const created = new Date().toISOString();
		writeScratchOwner(dir, { pid, label: "omp", repo: initial.root, created, bin: "throwaway" });
		seat = { dir, repo: initial.root, created, recorded: false };
		applyScratchEnv(dir);
		try { await exportAgentMailStorageRoot(); }
		catch {
			console.warn("fleet-guard: Agent Mail storage-root discovery unavailable; reservation admission reports storage failures separately");
		}
	}
	pi.setLabel("fleet-guard");
	const state: SessionRewriteState = { dir: "", aliases: new Map(), createdDirs: new Set(), adopted: [] };
	pi.on("tool_call", async (event, context) => {
		const agent = seat !== null && !seat.recorded ? hostAgentName(deps?.env) : undefined;
		const session = agent !== undefined ? context?.sessionManager?.getSessionId?.() : undefined;
		if (seat !== null && agent !== undefined && session) {
			seat.recorded = true;
			seat.agent = agent;
			seat.session = session;
			try { writeScratchOwner(seat.dir, { pid, label: "omp", repo: seat.repo, created: seat.created, agent, session, bin: "throwaway" }); }
			catch { /* the pid-only owner stays valid */ }
		}
		if (seat !== null) state.dir = seat.dir;
		const contention = checkContention(event);
		if (contention) return contention;
		const inPlace = checkPlutilInPlace(event);
		if (inPlace) return inPlace;
		const callingCwd = context?.cwd ?? cwd;
		const seatAgent = seat?.agent ?? hostAgentName(deps?.env);
		const seatSession = seat?.session ?? context?.sessionManager?.getSessionId?.();
		// L1: the session-scratch hint only names the seat's repo; a call from another repo
		// gets today's refusal byte-identical.
		const hintDir = seat !== null && (callingCwd === seat.repo || callingCwd.startsWith(`${seat.repo}/`)) ? seat.dir : null;
		const policy = await fleetPolicyState(callingCwd);
		if (policy.kind === "off") {
			const refusal = checkSystemTemp(event, { cwd: callingCwd, localRoot: localRootOf(context) });
			return withSessionHint(refusal, hintDir);
		}
		if (policy.kind === "unavailable") return { block: true, reason: `fleet-guard applicability: ${policy.reason}` };
		// OMP supplies the calling session's mapping (including subagent sharing).
		// No cwd/default-session guess: an absent backing root fails closed for local://.
		// NATIVEPREGRADE1 (ompkit-1ra0d.41): a native child's own spawn-minted name; its holds cover its own writes.
		const childAgentName = context ? nativeIdentity(context as unknown as NativeContext)?.id : undefined;
		const guardContext: FleetGuardContext = { cwd: callingCwd, localRoot: localRootOf(context), ...(childAgentName ? { childAgentName } : {}) };
		const tool = typeof event.toolName === "string" ? event.toolName : "tool";
		// Track scratch-top dirs this admitted call creates (M3); adoption later proves the session made them.
		const trackCreated = (blocked: boolean): void => {
			if (blocked) return;
			if (tool !== "write" && tool !== "edit" && tool !== "bash") return;
			const command = tool === "bash" ? (commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined)) : undefined;
			for (const top of createdScratchTops(tool, command, toolTargetPaths(event.input), callingCwd)) state.createdDirs.add(top);
		};
		if (seat !== null) {
			const adopted = maybeAdoptOwnerless(event, { callingCwd, agent: seatAgent, session: seatSession, createdDirs: state.createdDirs, adoptedDirs: state.adopted });
			if (adopted !== undefined) {
				const recheck = await handleToolCall(event, guardContext);
				if (recheck) return withSessionHint(recheck, hintDir);
				await recordCompletion(seatAgent, tool, adopted, adopted);
				context?.ui?.notify?.(adopted, "info");
				return { additionalContext: adopted };
			}
			const rewritten = await maybeSessionRewrite(event, { callingCwd, localRoot: localRootOf(context), agent: seatAgent, session: seatSession,
				state, recheck: (probe) => handleToolCall(probe, guardContext) });
			if (rewritten !== undefined) {
				trackCreated(false);
				const first = rewritten.additionalContext?.split("\n")[0] ?? "";
				const from = first.slice("AUTO_COMPLETED: ".length).split(" -> ")[0] ?? "";
				await recordCompletion(seatAgent, tool, rewritten.additionalContext ?? "", from);
				context?.ui?.notify?.(rewritten.additionalContext ?? "", "info");
				return rewritten;
			}
		}
		const verdict = await handleToolCall(event, guardContext);
		trackCreated(verdict?.block === true);
		return withSessionHint(verdict, hintDir);
	});
	// The session that recorded the seat ends it, plus every dir it adopted (same identity and
	// mechanism as the seat dir); a respawn (marker from respawn_seat) hands them on instead.
	pi.on("session_shutdown", async (_event, context) => {
		if (seat === null) return;
		const ending = context?.sessionManager?.getSessionId?.();
		const finish = deps?.seatEnd ?? liveSeatEndDeps();
		try {
			endSeat({ dir: seat.dir, agent: seat.agent, session: seat.session }, pid, ending, finish);
		} catch { /* a failed disposal leaves the dir for the reaper, as before */ }
		for (const dir of state.adopted) {
			try {
				endSeat({ dir, agent: seat.agent, session: seat.session }, pid, ending, finish);
			} catch { /* a failed disposal leaves the dir for the reaper, as before */ }
		}
	});
}
