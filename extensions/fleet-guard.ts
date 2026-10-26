import { resolve } from "node:path";
import { check as checkGit } from "../src/fleet-guard/git.ts";
import { check as checkReservations, exportAgentMailStorageRoot } from "../src/fleet-guard/reservations.ts";
import { applyScratchEnv, check as checkScratch, hostAgentName, scratchDirFor, writeScratchOwner, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent } from "../src/fleet-guard/scratch.ts";
import { endSeat, liveSeatEndDeps, type SeatEndDeps } from "../src/fleet-guard/seat-end.ts";
import { check as checkDurability } from "../src/fleet-guard/durability.ts";
import { check as checkWriteOwnership } from "../src/fleet-guard/write-own.ts";
import { checkPlutilInPlace } from "../src/fleet-guard/plutil.ts";
import { fleetPolicyState } from "./fleet-policy.ts";
import { ownerIdentity } from "../src/kitlib/owner.ts";

/**
 * fleet-guard: force the fleet rules inside the session instead of asking.
 * Scratch goes to the repo-local var/agent-tmp (never /tmp), work happens on main,
 * every write outside var/agent-tmp in a fleet checkout needs the caller's exclusive
 * Agent Mail reservation, and agent calls never switch the commit guard off.
 * Always on, opt-in or not: plutil edits must name their output (PLUTIL_IN_PLACE).
 * Shipped in the plugin; installed per profile by the kit.
 */

interface ToolCallContext {
	cwd: string;
	localProtocolOptions?: { getArtifactsDir?: () => string | null };
	sessionManager?: { getSessionId?: () => string | undefined };
}

interface ExtensionApi {
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: FleetGuardEvent, context?: ToolCallContext) => Promise<FleetGuardBlock | undefined>): void;
	on(event: "session_shutdown", handler: (event: unknown, context?: ToolCallContext) => Promise<void>): void;
}

export interface GuardDeps {
	cwd?: string;
	pid?: number;
	env?: Record<string, string | undefined>;
	/** Test seam for the session-end disposal; defaults to ps and the kit's own release. */
	seatEnd?: SeatEndDeps;
}

/** Ordered chain: lexical scratch, Git, repository facts, write ownership, then reservations. First block wins. */
export async function handleToolCall(event: FleetGuardEvent, context: FleetGuardContext): Promise<FleetGuardBlock | undefined> {
	const reservations = { cwd: context.cwd, agentName: context.agentName,
		isTrackedPath: context.isTrackedPath, lookupReservations: context.lookupReservations, warn: context.warn };
	return checkScratch(event, context) ?? checkGit(event, context) ?? await checkDurability(event, context) ??
		await checkWriteOwnership(event, { ...context, fleetPolicy: fleetPolicyState }) ??
		await checkReservations(event, reservations) ?? undefined;
}
export default async function fleetGuard(pi: ExtensionApi, deps?: GuardDeps): Promise<void> {
	const cwd = deps?.cwd ?? process.cwd();
	const pid = deps?.pid ?? process.pid;
	const initial = await fleetPolicyState(cwd);
	// PLUTILINPLACE1 (ompkit-ffb85): the plists it protects live outside every repository, so no opt-in scopes it.
	if (initial.kind === "off") {
		pi.on("tool_call", async event => checkPlutilInPlace(event));
		return;
	}
	// The seat dir is owned by the agent and its omp session, never by a bare pid. The session id is only known
	// once the session manager is in a tool-call context, so the first call records it (once: later calls may
	// belong to a subagent session).
	let seat: { dir: string; repo: string; created: string; identity: { pid: number; process_start: string }; recorded: boolean; agent?: string; session?: string } | null = null;
	if (initial.kind === "on") {
		const identity = ownerIdentity(pid);
		if (identity === null) throw new Error("fleet-guard: process identity unavailable; scratch was not created");
		const dir = scratchDirFor(initial.root, identity.pid);
		const created = new Date().toISOString();
		writeScratchOwner(dir, { ...identity, label: "omp", repo: initial.root, created, bin: "throwaway" });
		seat = { dir, repo: initial.root, created, identity, recorded: false };
		applyScratchEnv(dir);
		try { await exportAgentMailStorageRoot(); }
		catch {
			console.warn("fleet-guard: Agent Mail storage-root discovery unavailable; reservation admission reports storage failures separately");
		}
	}
	pi.setLabel("fleet-guard");
	pi.on("tool_call", async (event, context) => {
		const agent = seat !== null && !seat.recorded ? hostAgentName(deps?.env) : undefined;
		const session = agent !== undefined ? context?.sessionManager?.getSessionId?.() : undefined;
		if (seat !== null && agent !== undefined && session) {
			seat.recorded = true;
			seat.agent = agent;
			seat.session = session;
			try { writeScratchOwner(seat.dir, { ...seat.identity, label: "omp", repo: seat.repo, created: seat.created, agent, session, bin: "throwaway" }); }
			catch { /* the process-incarnation owner remains valid without seat binding */ }
		}
		const inPlace = checkPlutilInPlace(event);
		if (inPlace) return inPlace;
		const callingCwd = context?.cwd ?? cwd;
		const policy = await fleetPolicyState(callingCwd);
		if (policy.kind === "off") return undefined;
		if (policy.kind === "unavailable") return { block: true, reason: `fleet-guard applicability: ${policy.reason}` };
		// OMP supplies the calling session's mapping (including subagent sharing).
		// No cwd/default-session guess: an absent backing root fails closed for local://.
		const artifactsDir = context?.localProtocolOptions?.getArtifactsDir?.();
		return handleToolCall(event, { cwd: callingCwd,
			localRoot: artifactsDir ? resolve(artifactsDir, "local") : undefined });
	});
	// The session that recorded the seat ends it; a respawn (marker from respawn_seat) hands the dir on instead.
	pi.on("session_shutdown", async (_event, context) => {
		if (seat === null) return;
		try {
			endSeat({ dir: seat.dir, agent: seat.agent, session: seat.session }, pid, context?.sessionManager?.getSessionId?.(), deps?.seatEnd ?? liveSeatEndDeps());
		} catch { /* a failed disposal leaves the dir for the reaper, as before */ }
	});
}
