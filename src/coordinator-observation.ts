// ompkit-bj08.4: coordinator input/decision-observation seam contract.
//
// Measurement result, recorded as a pure decision function so the consumer
// (ompkit-bj08.6 director-terminal-continuance) inherits the exact boundary:
// a coordinator-consumption claim requires a packet-bound native coordinator
// decision plus a live delivery cursor on the receiving side. Everything else
// is UNKNOWN with no action, and pending references are preserved verbatim.
// No new service or authority ledger: the single custodian is CB1
// (mechanical worker callbacks) and the pending source is reference-only
// Agent Mail inbox/delivery events.

export type CoordinatorDisposition = "CONSUMED" | "UNKNOWN";

export interface PacketDecision {
	generation: string;
}

export interface DeliveryCursor {
	cursorId: string;
	expired: boolean;
}

export interface SeamObservation {
	/** Worker callback receipt present (e.g. CB1 mechanical callback). */
	workerCallback: boolean;
	/** Visible terminal marker present. */
	visibleMarker: boolean;
	/** Packet-bound native coordinator decision, or null when absent. */
	packetDecision: PacketDecision | null;
	/** Expected coordinator generation, or null when omitted. */
	coordinatorGeneration: string | null;
	/** Receiving-side delivery cursor, or null when absent. */
	deliveryCursor: DeliveryCursor | null;
	/** Message identity, or null when absent. */
	messageId: string | null;
	/** Receiving-side event; "sender-log" is a sender-side substitute, not a receipt. */
	receivingEvent: "delivery" | "sender-log" | null;
	/** Reference-only pending references; echoed verbatim, never mutated. */
	pendingRefs: readonly string[];
}

export interface SeamDecision {
	disposition: CoordinatorDisposition;
	custodian: "CB1";
	pendingSource: "agent-mail-inbox-delivery-events";
	action: "hand-to-continuance" | "no-action";
	pendingRefs: string[];
	reason: string;
}

const CUSTODIAN = "CB1" as const;
const PENDING_SOURCE = "agent-mail-inbox-delivery-events" as const;

function unknown(observation: SeamObservation, reason: string): SeamDecision {
	return {
		disposition: "UNKNOWN",
		custodian: CUSTODIAN,
		pendingSource: PENDING_SOURCE,
		action: "no-action",
		pendingRefs: [...observation.pendingRefs],
		reason,
	};
}

export function selectCoordinatorObservation(observation: SeamObservation): SeamDecision {
	if (!observation.workerCallback || !observation.visibleMarker) {
		return unknown(observation, "callback or visible marker absent: no observation to join");
	}
	if (observation.packetDecision === null) {
		return unknown(observation, "no packet-bound native coordinator decision: callback receipt is not consumption proof");
	}
	if (observation.coordinatorGeneration === null) {
		return unknown(observation, "coordinator generation omitted: decision cannot be bound to this coordinator");
	}
	if (observation.coordinatorGeneration !== observation.packetDecision.generation) {
		return unknown(observation, "coordinator generation mismatch: decision belongs to another generation");
	}
	if (observation.receivingEvent !== "delivery") {
		return unknown(observation, "no receiving-side delivery event: a sender log is not a receipt");
	}
	if (observation.deliveryCursor === null) {
		return unknown(observation, "delivery cursor absent: consumption position unknown");
	}
	if (observation.deliveryCursor.expired) {
		return unknown(observation, "delivery cursor expired: position no longer authoritative");
	}
	if (observation.messageId === null) {
		return unknown(observation, "message identity absent: cursor cannot be distinguished from the message");
	}
	if (observation.deliveryCursor.cursorId === observation.messageId) {
		return unknown(observation, "delivery cursor and message identity coincide: cursor must stay distinct from the message");
	}
	return {
		disposition: "CONSUMED",
		custodian: CUSTODIAN,
		pendingSource: PENDING_SOURCE,
		action: "hand-to-continuance",
		pendingRefs: [...observation.pendingRefs],
		reason: "packet-bound decision matches coordinator generation with a live, distinct delivery cursor on a receiving-side event",
	};
}
