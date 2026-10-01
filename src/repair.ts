import { applyNamedPlan, planNamedApply, type NamedApplyPlan, type NamedApplyResult, type NamedScope } from "./apply.ts";
import { diagnose, type Finding } from "./diagnostics.ts";
import type { ApplyOptions } from "./mutations.ts";

export type RepairInput = Readonly<{ root: string; home: string; stateRoot: string; project?: string; scope?: string }>;
export type RepairRefusal = Readonly<{ code: string; reason: string }>;
export type RepairDecision =
	| Readonly<{ status: "READY"; scope: NamedScope; changes: number; steps: NamedApplyPlan["steps"]; finding: string; refusal?: never }>
	| Readonly<{ status: "REFUSED"; scope: string | null; refusal: RepairRefusal }>;
export type DeepDoctorDecision = Readonly<{ status: "UNVERIFIED"; scope: string; refusal: RepairRefusal }>;

const prepared = new WeakMap<RepairDecision, NamedApplyPlan>();
const supported: readonly string[] = ["rules", "policy", "extensions"];
const refusal = (scope: string | undefined, code: string, reason: string): RepairDecision =>
	Object.freeze({ status: "REFUSED", scope: scope ?? null, refusal: Object.freeze({ code, reason }) });
const strings = (item: Finding | undefined, key: string): string[] => {
	const field = item?.evidence?.[key];
	return Array.isArray(field) && field.every(value => typeof value === "string") ? field : [];
};
const has = (item: Finding | undefined, key: string): boolean => item?.evidence?.[key] !== undefined;

function findingRefusal(scope: NamedScope, findings: readonly Finding[], project?: string): RepairDecision | null {
	const row = (name: string) => findings.find(item => item.component === name);
	if (row("kit")?.status === "FAIL" || row("manifest")?.status === "FAIL")
		return refusal(scope, "INVALID_RELEASE", "The release manifest is not verified; replace the release before repairing installed files.");
	if (project && row("project_rules")?.status !== "OK")
		return refusal(scope, "PROJECT_OVERRIDE_UNVERIFIED", "The selected project has a shadow, unsafe path or unverified rule resolution; repair cannot change project-owned files.");
	if (scope === "rules") {
		const installed = row("installed_rules");
		if (!installed || strings(installed, "ownershipDrift").length || strings(installed, "unsafe").length)
			return refusal(scope, "RULE_PROVIDER_UNVERIFIED", "Inspect installed rules and ownership with omp-kit doctor --scope rules --json; do not adopt or overwrite unverified files.");
	} else if (scope === "policy") {
		const policy = row("policy");
		if (!policy || has(policy, "inventory_issue") || has(policy, "project_issue") || strings(policy, "unverified_profiles").length)
			return refusal(scope, "PROFILE_UNVERIFIED", "A profile or project policy is not safely understood; repair will not guess its values.");
		if (Array.isArray(policy.evidence?.disabled_conflicts) && policy.evidence.disabled_conflicts.length)
			return refusal(scope, "DISABLED_PROVIDER_REFUSED", "A disabled rule might be supplied by a project, builtin or unknown provider; generic consent cannot re-enable it.");
	} else {
		const extension = row("extensions");
		if (!extension || has(extension, "project_issue") || has(extension, "inventory_issue") || has(extension, "project_override"))
			return refusal(scope, "EXTENSION_PROVIDER_UNVERIFIED", "Project override or profile inventory prevents a known extension repair.");
		if (strings(extension, "unsafe").length || strings(extension, "drifted").length)
			return refusal(scope, "EXTENSION_COLLISION", "An extension destination is unsafe or differs from the shipped bytes; repair will not replace it.");
	}
	return null;
}

/** A diagnosis finding is a hint, never authority to edit. The scope planner supplies that authority. */
export async function planRepair(input: RepairInput): Promise<RepairDecision> {
	if (!input.scope) return refusal(undefined, "SCOPE_REQUIRED", "Select exactly one named repair scope: rules, policy, extensions or state.");
	if (!supported.includes(input.scope)) return refusal(input.scope, "UNSUPPORTED_REPAIR_SCOPE", "No bounded reversible repair exists for this component; OMP, JSM, credentials, router and builtin state are not edited.");
	const scope = input.scope as NamedScope;
	try {
		const findings = await diagnose({ root: input.root, home: input.home, project: input.project });
		const blocked = findingRefusal(scope, findings, input.project);
		if (blocked) return blocked;
		const plan = planNamedApply({ root: input.root, home: input.home, stateRoot: input.stateRoot, project: input.project, scope });
		const result: RepairDecision = Object.freeze({ status: "READY", scope, changes: plan.changes, steps: plan.steps,
			finding: scope === "rules" ? "installed_rules" : scope });
		prepared.set(result, plan);
		return result;
	} catch (error) {
		const code = error instanceof Error && /^[A-Z][A-Z0-9_]*(?::|$)/.test(error.message) ? error.message.split(":", 1)[0]! : "REPAIR_UNVERIFIED";
		const action = code === "PENDING_RECOVERY" ? "Run omp-kit audit --json and reconcile the pending receipt before another repair." :
			code === "RULE_COLLISION" || code === "UNMANAGED_EXTENSION_COLLISION" ?
				"Inspect the named collision with omp-kit doctor --json; resolve ownership manually before replanning." :
			code === "UNSAFE_PATH" || code === "STATE_UNSAFE" ?
				"Select a private receipt directory outside the release and managed paths, resolve unsafe links, then replan." :
			code === "GLOBAL_PREFLIGHT_FAILED" ?
				"Run omp-kit apply rules --plan --json; resolve missing or retired global rule files before policy repair." :
				"Inspect omp-kit doctor --json and the selected scope's read-only plan; no writes were authorized.";
		return refusal(scope, code, action);
	}
}

/** Unforgeable in-process plan; no write without explicit consent and the P10 durable receipt. */
export function applyRepairPlan(plan: RepairDecision, options: { confirmed: true; onBoundary?: ApplyOptions["onBoundary"] }): NamedApplyResult {
	if (options?.confirmed !== true) throw new Error("CONSENT_REQUIRED");
	if (plan.status !== "READY") throw new Error("REPAIR_REFUSED");
	const scopePlan = prepared.get(plan);
	if (!scopePlan) throw new Error("INVALID_PLAN");
	return applyNamedPlan(scopePlan, options);
}

/** Migratory OMP reads lack a proved closed backup set and post-migration inverse. Never execute them here. */
export async function planDeepDoctor(input: RepairInput & { confirmed?: boolean }): Promise<DeepDoctorDecision> {
	return { status: "UNVERIFIED", scope: input.scope ?? "effective_profile", refusal: {
		code: input.confirmed ? "DEEP_PROBE_UNVERIFIED" : "DEEP_CONSENT_REQUIRED",
		reason: "No complete migratory profile/settings backup, receipt and safe rollback can be established; no OMP command was run.",
	} };
}
