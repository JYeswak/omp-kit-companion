// ompkit-bj08.5: inherited-actuator admission boundary.
//
// One deterministic admission check every effects branch must pass before
// issuing product work: bind the immutable authorized packet, the current
// authority and the recipient/session generation. Branches WITH a keeper
// surface (launcherBinding "keeper") additionally bind the complete observed
// launcher set against the keeper pid-file claim: any live launcher outside
// the claim refuses. Branches with no keeper surface (launcherBinding
// "none", recorded in the decision reason) are bound by authority,
// generation, recovery custody and resend rules only; their callers attest
// same-tick mint and the missing keeper surface stays explicit, never
// silently assumed. PAUSED, OFF, protected, unconfirmed, stale-generation or
// unknown authority refuses with zero governed effects. Recovery proceeds
// only on its own recovery custody, and a STARTED flush without a footer
// spinner authorizes no resend.
//
// Pure evaluation: refusing or admitting here performs no effects itself.

export type AuthorityState = "ACTIVE" | "PAUSED" | "OFF" | "PROTECTED";

export interface LauncherMember {
	pid: number;
	command: string;
}

export interface KeeperClaim {
	pid: number;
	command: string;
}

export interface AuthorizedPacket {
	/** Requested effects action. */
	action: string;
	/** The single owned action this packet may admit. */
	ownedAction: string;
	/** Packet generation, or null when the packet carries none. */
	generation: string | null;
}

export interface RecoveryRequest {
	/** True only with the recovery's own custody; send permission alone is false. */
	hasOwnRecoveryCustody: boolean;
	/** False when the observation shows a dead owner. */
	ownerLive: boolean;
}

export interface ResendRequest {
	/** Flush outcome for the pane, using the fleet's FlushResult vocabulary. */
	flushResult: "STARTED" | "STILL_STUCK" | "PLANNED" | "ALERTED" | "REPORTED" | "SKIPPED_CHANGED";
	/** Footer spinner visible on the pane. */
	spinnerVisible: boolean;
}

export interface AdmissionInput {
	/**
	 * "keeper": the branch binds the complete observed launcher set against
	 * the keeper pid-file claim. "none": the branch has no keeper surface;
	 * authority, generation, recovery and resend rules still bind, and the
	 * missing keeper surface is recorded in the decision reason.
	 */
	launcherBinding: "keeper" | "none";
	authority: AuthorityState;
	/** False when the authority state itself is unconfirmed or unknown. */
	authorityConfirmed: boolean;
	/** Current authority/recipient generation, or null when unobservable. */
	authorityGeneration: string | null;
	/** Complete observed live launcher set for the actuator. */
	launchers: LauncherMember[];
	/** Keeper pid-file claim, or null when absent. */
	keeper: KeeperClaim | null;
	packet: AuthorizedPacket;
	/** Actions under governance; anything else passes through untouched. */
	governedActions: readonly string[];
	recovery?: RecoveryRequest;
	resend?: ResendRequest;
}

export type AdmissionVerdict = "ADMIT" | "ALLOW" | "REFUSE";

export interface AdmissionDecision {
	verdict: AdmissionVerdict;
	/** Present only on ADMIT, and always exactly the packet's one owned action. */
	admittedAction: string | null;
	reason: string;
}

function refuse(reason: string): AdmissionDecision {
	return { verdict: "REFUSE", admittedAction: null, reason };
}

export function admitActuator(input: AdmissionInput): AdmissionDecision {
	if (!input.governedActions.includes(input.packet.action)) {
		return { verdict: "ALLOW", admittedAction: null, reason: "action outside governance: unrelated authorized work passes through" };
	}
	if (input.authority === "PAUSED") return refuse("authority paused: inherited packets cannot issue product work");
	if (input.authority === "OFF") return refuse("authority off: no governed effects while the off switch is set");
	if (input.authority === "PROTECTED") return refuse("authority protected: governed effects refused on protected ground");
	if (!input.authorityConfirmed) return refuse("authority unconfirmed: unknown authority admits nothing");
	if (input.authorityGeneration === null) {
		return refuse("authority generation unobservable: packet cannot be bound to this coordinator");
	}
	if (input.packet.generation === null) {
		return refuse("packet carries no generation: unbound packet admits nothing");
	}
	if (input.packet.generation !== input.authorityGeneration) {
		return refuse("stale packet generation: decision belongs to another generation");
	}
	if (input.launcherBinding === "keeper") {
		if (input.keeper === null) {
			return refuse("keeper claim absent: live launchers cannot be bound without it");
		}
		const uncovered = input.launchers.filter(
			(member) => member.pid !== input.keeper!.pid || member.command !== input.keeper!.command,
		);
		if (uncovered.length > 0) {
			return refuse(`launcher set exceeds keeper claim: ${uncovered.length} live launcher(s) outside the keeper pid-file`);
		}
	}
	if (input.recovery !== undefined) {
		if (!input.recovery.ownerLive) return refuse("dead-owner observation: recovery proceeds on no custody");
		if (!input.recovery.hasOwnRecoveryCustody) {
			return refuse("send permission is not recovery custody: isolated recovery needs its own custody");
		}
	}
	if (input.resend !== undefined) {
		if (input.resend.flushResult !== "STARTED" || !input.resend.spinnerVisible) {
			return refuse("no live start with spinner: pane cannot become idle and no resend is authorized");
		}
	}
	return {
		verdict: "ADMIT",
		admittedAction: input.packet.ownedAction,
		reason: input.launcherBinding === "keeper"
			? "bound launcher set, current generation and live authority admit the packet's one owned action"
			: "no keeper surface on this branch (recorded): current generation and live authority admit the packet's one owned action",
	};
}
