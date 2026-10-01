import { isAbsolute, join, relative, sep } from "node:path";
import { applyExtensions, planExtensions, type ExtensionPlan } from "./apply-extensions.ts";
import { applyPolicyPlan, planPolicy, type PolicyPlan } from "./apply-policy.ts";
import { applyRulePlan, planRules, type RulePlan } from "./apply-rules.ts";
import { inspectPendingMutations, type ApplyOptions } from "./mutations.ts";

export type NamedScope = "rules" | "policy" | "extensions";
export type NamedApplyInput = Readonly<{ root: string; home: string; stateRoot: string; project?: string; scope: NamedScope; profileConfigHome?: string }>;
export type NamedStep = Readonly<{ action: string; path: string; profile?: string; key?: string; command?: string; beforeSha256: string | null; afterSha256: string | null; beforeMode: number | null; afterMode: number | null }>;
export type NamedApplyPlan = Readonly<{ scope: NamedScope; changes: number; steps: readonly NamedStep[] }>;
export type NamedApplyResult = Readonly<{ status: "APPLIED" | "UNCHANGED"; receiptId: string | null; backupId: string | null; files: number }>;

type Backing = { input: NamedApplyInput; plan: RulePlan | PolicyPlan | ExtensionPlan };
const plans = new WeakMap<NamedApplyPlan, Backing>();
function inside(base: string, path: string): boolean {
	const name = relative(base, path);
	return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
}

function homeRelative(home: string, path: string): string {
	const name = relative(home, path);
	if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error("UNSAFE_PATH");
	return name;
}

export function validateNamedApplyPaths(input: Pick<NamedApplyInput, "root" | "home" | "stateRoot">): void {
	if (![input.root, input.home, input.stateRoot].every(path => isAbsolute(path)) ||
		inside(input.root, input.stateRoot) || inside(input.stateRoot, input.root) ||
		inside(input.stateRoot, input.home) || inside(join(input.home, ".omp"), input.stateRoot) ||
		inside(join(input.home, ".agents"), input.stateRoot)) throw new Error("UNSAFE_PATH");
}

/** Exact, independent scope preview. No subset of a colliding plan is ever applied. */
export function planNamedApply(input: NamedApplyInput): NamedApplyPlan {
	if (!(["rules", "policy", "extensions"] as readonly string[]).includes(input.scope)) throw new Error("UNSUPPORTED_REPAIR_SCOPE");
	validateNamedApplyPaths(input);
	if (inspectPendingMutations(input.stateRoot).length) throw new Error("PENDING_RECOVERY");
	const plan = input.scope === "rules" ? planRules(input) : input.scope === "policy" ?
		planPolicy({ root: input.root, home: input.home, stateRoot: input.stateRoot, project: input.project, profileConfigHome: input.profileConfigHome }) : planExtensions({ ...input, includeDefault: true });
	if (input.scope === "rules" && (plan as RulePlan).blocked) throw new Error("RULE_COLLISION");
	if (input.scope === "policy" && (plan as PolicyPlan).blockedProfiles.length) throw new Error("DISABLED_RULE_REFUSED");
	let steps: NamedStep[];
	if (input.scope === "rules") steps = (plan as RulePlan).entries.filter(entry => ["install", "update", "retire"].includes(entry.action))
		.map(entry => ({ action: entry.action, path: entry.path, beforeSha256: entry.beforeSha256, afterSha256: entry.desiredSha256,
			beforeMode: entry.beforeMode, afterMode: entry.desiredMode }));
	else if (input.scope === "policy") steps = (plan as PolicyPlan).steps.map(step => ({
		action: "config set", path: step.path, profile: step.profile, key: step.key, command: step.command,
		beforeSha256: step.beforeSha256, afterSha256: null, beforeMode: step.beforeMode, afterMode: null,
	}));
	else {
		const extension = plan as ExtensionPlan;
		steps = extension.steps.map(step => {
			const image = extension.mutation?.files.find(file => file.path === step.path);
			if (!image) throw new Error("INVALID_PLAN");
			return { action: step.beforeSha256 === null ? "install" : "update",
				path: homeRelative(input.home, step.path), ...(step.profile ? { profile: step.profile } : {}),
				beforeSha256: step.beforeSha256, afterSha256: step.afterSha256,
				beforeMode: image.before?.mode ?? null, afterMode: image.after?.mode ?? null };
		});
	}
	const result: NamedApplyPlan = Object.freeze({ scope: input.scope, changes: steps.length,
		steps: Object.freeze(steps.map(step => Object.freeze(step))) });
	plans.set(result, { input: { ...input }, plan });
	return result;
}

/** Caller supplies actual user consent. Replan and compare source, selection and targets before any write. */
export function applyNamedPlan(plan: NamedApplyPlan, options: { confirmed: true; onBoundary?: ApplyOptions["onBoundary"] }): NamedApplyResult {
	if (options?.confirmed !== true) throw new Error("CONSENT_REQUIRED");
	const saved = plans.get(plan);
	if (!saved) throw new Error("INVALID_PLAN");
	if (inspectPendingMutations(saved.input.stateRoot).length) throw new Error("PENDING_RECOVERY");
	if (saved.input.scope === "extensions") {
		let fresh: NamedApplyPlan;
		try { fresh = planNamedApply(saved.input); } catch (error) {
			if (error instanceof Error && error.message === "PENDING_RECOVERY") throw error;
			throw new Error("FRESH_PLAN");
		}
		if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("FRESH_PLAN");
		// The P13 chokepoint compares target preimages under its lock; this check also
		// compares the source bytes, selected profiles and resulting steps.
		const receipt = applyExtensions(plans.get(fresh)!.plan as ExtensionPlan, { onBoundary: options.onBoundary });
		return { status: receipt.receiptId ? "APPLIED" : "UNCHANGED", receiptId: receipt.receiptId, backupId: null, files: receipt.files };
	}
	if (saved.input.scope === "rules") {
		const receipt = applyRulePlan(saved.plan as RulePlan, { confirmed: true });
		return { status: receipt.status, receiptId: receipt.id, backupId: null, files: receipt.files };
	}
	if (saved.input.scope === "policy") {
		const receipt = applyPolicyPlan(saved.plan as PolicyPlan, { confirmed: true });
		return { status: receipt.status, receiptId: null, backupId: receipt.backupId, files: receipt.files };
	}
	throw new Error("INVALID_PLAN");
}
