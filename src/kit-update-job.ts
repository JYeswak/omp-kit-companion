import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyKitUpdate, planKitUpdate, type KitUpdateInput, type KitUpdatePlan, type KitUpdatePreview, type KitUpdateRefusal, type KitUpdateResult } from "./kit-update.ts";

export type KitUpdateJobConfig = Omit<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag"> & {
	enabled: boolean;
	pollRelease: () => Promise<Pick<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag">>;
};
export type KitUpdateJobDependencies = {
	plan?: (input: KitUpdateInput) => Promise<KitUpdatePreview>;
	apply?: (plan: KitUpdatePlan) => Promise<KitUpdateResult>;
	notify?: (message: string) => Promise<void> | void;
};
export type KitUpdateJobResult = { status: "DISABLED" | "CURRENT" | "UPDATED" | "REFUSED" | "UNDONE" | "FAILED"; receiptId: string | null; activeVersion: string | null; notification: boolean; reason?: string };

/** One opt-in poll/apply cycle. No network or service installation occurs unless the caller enables it. */
export async function runKitUpdateJob(config: KitUpdateJobConfig, dependencies: KitUpdateJobDependencies = {}): Promise<KitUpdateJobResult> {
	if (!config.enabled) return { status: "DISABLED", receiptId: null, activeVersion: null, notification: false };
	const plan = dependencies.plan ?? planKitUpdate;
	const apply = dependencies.apply ?? applyKitUpdate;
	let runId = randomUUID();
	try {
		const source = await config.pollRelease();
		const preview = await plan({ ...config, ...source });
		if (preview.status === "CURRENT") return record(config.stateRoot, runId, { status: "CURRENT", receiptId: null, activeVersion: preview.current.version, notification: false });
		if (preview.status !== "UPDATE_AVAILABLE") { const refusal = preview as KitUpdateRefusal; return record(config.stateRoot, runId, { status: "REFUSED", receiptId: null, activeVersion: null, notification: false, reason: refusal.reason }); }
		const result = await apply(preview);
		if (result.status === "PARTIAL") { await dependencies.notify?.("omp-kit update postcheck failed; automatic undo completed"); return record(config.stateRoot, runId, { status: "UNDONE", receiptId: result.receiptId, activeVersion: result.activeVersion, notification: true }); }
		return record(config.stateRoot, runId, { status: result.status, receiptId: result.receiptId, activeVersion: result.activeVersion, notification: false });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await dependencies.notify?.("omp-kit update job failed: " + reason);
		return record(config.stateRoot, runId, { status: "FAILED", receiptId: null, activeVersion: null, notification: true, reason });
	}
}

function record(stateRoot: string, runId: string, result: KitUpdateJobResult): KitUpdateJobResult {
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot, `kit-update-job-${runId}.json`), JSON.stringify({ schema_version: 1, run_id: runId, ...result }) + "\n", { mode: 0o600 });
	return result;
}
