import { auditMutations, undoMutation, whyMutation, type ApplyOptions, type AuditReport } from "./mutations.ts";

/** Explicit state root is required: HOME and custom XDG_STATE_HOME must never split receipts. */
export function audit(stateRoot: string): AuditReport[] { return auditMutations(stateRoot); }
export function why(stateRoot: string, id: string): AuditReport { return whyMutation(stateRoot, id); }
/** CLI supplies confirmed:true only after the explicit --yes consent check. */
export function undo(stateRoot: string, id: string, options: { confirmed: true; onBoundary?: ApplyOptions["onBoundary"] }): { id: string; files: number; status: "RESTORED" } {
	return undoMutation(stateRoot, id, options);
}
export type { AuditReport, AuditFile, AuditStatus } from "./mutations.ts";
