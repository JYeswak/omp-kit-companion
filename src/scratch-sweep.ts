import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applyOwnedQuarantine, eachSessionDir, inspectSession, measureScratchTree, readScratchSizeSnapshot, resolveScratchRoots, resolveSystemWorkDirs } from "./scratch.ts";
import type { ApplyDeps, InspectDeps, ScratchRunner, ScratchTreeEvidence, ScratchVerdict } from "./scratch.ts";

// Inventory can veto a mutation, never authorize it. Only a fresh deterministic
// owner/fd/identity/complete-deepest-idle check can authorize recoverable staging.
export const SWEEP_BUDGET_MS = 60_000;
export const PRESSURE_FREE_PCT = 10;
export const PRESSURE_IDLE_HOURS = 24;
export const SWEEP_IDLE_HOURS = 72;
const INVENTORY_MAX_AGE_MS = 60_000;
export const SWEEP_NO_CLAIM = "Quarantine is recoverable staging, not deletion or proof of deadness. Staged logical bytes are not measured APFS container-free delta. Inventory coverage and unrun paths are reported separately.";

export interface SweepTrackingEntry {
	device: number;
	inode: number;
	sizeBytes: number;
	measuredAtMs: number;
	status: "complete" | "partial" | "unknown";
	source: "create-or-done" | "sweep";
}
export interface SweepTracking {
	lastRunMs: number;
	entries: Record<string, SweepTrackingEntry>;
}
export interface SweepInventoryEntry {
	path: string;
	axis: string;
	sizeBytes: number | null;
	veto: string | null;
}
export interface SweepInventory {
	status: "DONE" | "UNRUN" | "UNKNOWN";
	reason: string;
	observedAtMs: number;
	freePct: number | null;
	entries: SweepInventoryEntry[];
	unrunPaths: string[];
}
export interface SweepOpts {
	nowMs: number;
	budgetMs?: number;
	deadlineMs?: number;
	inventory: SweepInventory;
	tracking?: SweepTracking;
	clockMs?: () => number;
	nameRequired?: boolean;
	/** Already-discovered direct targets, e.g. standalone TMPDIR work dirs. */
	targets?: string[];
}
export interface SweepOwnerBytes {
	owner: string;
	bytes: number;
}
export interface SweepResult {
	status: "DONE" | "UNRUN" | "FAILED";
	reason: string;
	roots: string[];
	walkedDirs: number;
	windowSkipped: number;
	rows: ScratchVerdict[];
	sizeEvidence: Record<string, ScratchTreeEvidence>;
	refused: number;
	failed: number;
	quarantined: ScratchVerdict[];
	plannedBytes: number;
	stagedBytes: number;
	gb: number;
	topOwners: SweepOwnerBytes[];
	undoLines: string[];
	unrunPaths: string[];
	idleHours: number;
	inventory: SweepInventory;
	nextTracking: SweepTracking;
	noClaim: string;
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function unknownInventory(reason: string, nowMs: number): SweepInventory {
	return { status: "UNKNOWN", reason, observedAtMs: nowMs, freePct: null, entries: [], unrunPaths: ["fsw:inventory"] };
}

/** Supported fsw scan envelope only. No reclaim/propose/dry-run path is reachable. */
export function parseSweepInventory(value: unknown, nowMs: number): SweepInventory {
	const envelope = object(value);
	const data = object(envelope?.data);
	if (envelope?.schema_version !== "1.0.0" || data?.schema_version !== "1.0.0" ||
		!Array.isArray(data.entries) || !Array.isArray(data.axes) || !Array.isArray(data.axes_unreached) ||
		typeof data.wall_budget_exhausted !== "boolean" || !nonnegative(data.scanned_at_epoch) ||
		!Array.isArray(data.denylist_rules) || data.denylist_rules.length === 0) return unknownInventory("inventory-envelope-invalid", nowMs);
	const partial = data.wall_budget_exhausted;
	if (!(envelope.success === true && envelope.code === "PASS") &&
		!(partial && envelope.success === false && envelope.failure_kind === "WALL_BUDGET_EXHAUSTED")) {
		return unknownInventory("inventory-probe-error", nowMs);
	}
	const observedAtMs = data.scanned_at_epoch * 1000;
	if (observedAtMs > nowMs + 1000 || nowMs - observedAtMs > INVENTORY_MAX_AGE_MS) return unknownInventory("inventory-stale", nowMs);
	const control = object(data.positive_control);
	if (control?.ran !== true || control.passed !== true) return unknownInventory("inventory-positive-control-failed", nowMs);
	const host = object(data.host_free);
	const freePct = host && nonnegative(host.total_bytes) && host.total_bytes > 0 && nonnegative(host.free_bytes) &&
		host.free_bytes <= host.total_bytes ? 100 * host.free_bytes / host.total_bytes : null;
	const entries: SweepInventoryEntry[] = [];
	const unrunPaths: string[] = [];
	for (const axis of data.axes_unreached) {
		if (typeof axis !== "string") return unknownInventory("inventory-coverage-invalid", nowMs);
		unrunPaths.push(`fsw:axis:${axis}`);
	}
	for (const raw of data.axes) {
		const axis = object(raw);
		if (!axis || typeof axis.axis !== "string" || typeof axis.axis_budget_exhausted !== "boolean" ||
			!nonnegative(axis.candidates) || !nonnegative(axis.measured) || !Array.isArray(axis.unmeasured) || !Array.isArray(axis.denied) ||
			axis.candidates !== axis.measured + axis.unmeasured.length + axis.denied.length) return unknownInventory("inventory-coverage-invalid", nowMs);
		if (axis.axis_budget_exhausted) unrunPaths.push(`fsw:axis:${axis.axis}:partial`);
		for (const rawUnmeasured of axis.unmeasured) {
			const item = object(rawUnmeasured);
			if (!item || typeof item.path !== "string" || !isAbsolute(item.path)) return unknownInventory("inventory-coverage-invalid", nowMs);
			unrunPaths.push(item.path);
		}
		for (const path of axis.denied) {
			if (typeof path !== "string" || !isAbsolute(path)) return unknownInventory("inventory-coverage-invalid", nowMs);
			entries.push({ path, axis: axis.axis, sizeBytes: null, veto: "inventory-denylist" });
		}
	}
	for (const raw of data.entries) {
		const entry = object(raw);
		if (!entry || typeof entry.path !== "string" || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path ||
			typeof entry.axis !== "string") return unknownInventory("inventory-entry-invalid", nowMs);
		const measurement = object(entry.measurement);
		const liveness = object(entry.liveness);
		const identity = object(entry.identity);
		const ownership = object(entry.ownership);
		const denial = object(entry.denial);
		let veto: string | null = null;
		if (entry.denial !== undefined && entry.denial !== null) veto = `inventory-denylist:${typeof denial?.rule === "string" ? denial.rule : "unknown"}`;
		else if (entry.class === "LIVE" || liveness?.live === true) veto = "inventory-live";
		else if (!["SCRATCH", "REGENERABLE", "SUPERSEDED", "ORPHANED"].includes(String(entry.class))) veto = "inventory-unknown";
		else if (liveness?.live !== false || liveness.indeterminate !== false || !Array.isArray(liveness.probes) ||
			liveness.probes.length === 0 || liveness.probes.some(rawProbe => {
				const probe = object(rawProbe);
				return probe?.ran !== true || probe.live !== false;
			})) veto = "inventory-probe-error";
		else if (identity?.vetoes_reclaim !== false) veto = "inventory-identity-veto";
		else if (ownership?.vetoes_reclaim !== false) veto = "inventory-ownership-veto";
		else if (measurement?.state !== "complete" || !nonnegative(measurement.bytes)) veto = "inventory-size-unmeasured";
		const sizeBytes = measurement?.state === "complete" && nonnegative(measurement.bytes) ? measurement.bytes : null;
		entries.push({ path: entry.path, axis: entry.axis, sizeBytes, veto });
		if (sizeBytes === null) unrunPaths.push(entry.path);
	}
	return { status: partial || unrunPaths.length > 0 ? "UNRUN" : "DONE", reason: partial ? "inventory-wall-budget-exhausted" : "inventory-read",
		observedAtMs, freePct, entries, unrunPaths: [...new Set(unrunPaths)] };
}

export function collectSweepInventory(run: ScratchRunner, nowMs: number, budgetMs = 5000): SweepInventory {
	if (budgetMs < 2000) return unknownInventory("inventory-budget-exhausted", nowMs);
	// Leave time inside the adapter cap for fsw to serialize its partial receipt.
	const seconds = Math.max(1, Math.floor((Math.min(5000, budgetMs) - 1000) / 1000));
	try {
		const result = run(["fsw", "--json", "--wall-budget", String(seconds), "--axis-budget", "1", "--deadline", "1", "scan"], { timeoutMs: Math.min(5000, budgetMs) });
		if (result.code === null || result.stdout.trim() === "") return unknownInventory("inventory-probe-error", nowMs);
		const envelope: unknown = JSON.parse(result.stdout);
		if (object(envelope)?.exit_code !== result.code) return unknownInventory("inventory-exit-mismatch", nowMs);
		return parseSweepInventory(envelope, nowMs);
	} catch {
		return unknownInventory("inventory-probe-error", nowMs);
	}
}

function overlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function inventoryVeto(dir: string, inventory: SweepInventory, nowMs: number): string | null {
	if (inventory.status === "UNKNOWN") return inventory.reason;
	if (inventory.observedAtMs > nowMs + 1000 || nowMs - inventory.observedAtMs > INVENTORY_MAX_AGE_MS) return "inventory-stale";
	// Josh's live index and interpreter are never a sweep target.
	if (overlap(dir, "/Volumes/ZestData/mathlas-index")) return "protected-live-mathlas";
	return inventory.entries.find(entry => entry.veto !== null && overlap(dir, entry.path))?.veto ?? null;
}
function ownerBytes(rows: ScratchVerdict[]): SweepOwnerBytes[] {
	const byOwner = new Map<string, number>();
	for (const row of rows) byOwner.set(row.owner?.label ?? "unowned", (byOwner.get(row.owner?.label ?? "unowned") ?? 0) + row.sizeBytes);
	return [...byOwner.entries()].map(([owner, bytes]) => ({ owner, bytes })).sort((a, b) => b.bytes - a.bytes || a.owner.localeCompare(b.owner)).slice(0, 3);
}

/** Plan only. Callers run the entire invocation in the standard supervised job. */
export function planSweep(root: string, inspect: InspectDeps, opts: SweepOpts): SweepResult {
	const clock = opts.clockMs ?? Date.now;
	const deadlineMs = Math.min(opts.deadlineMs ?? Infinity, clock() + Math.max(0, Math.min(opts.budgetMs ?? SWEEP_BUDGET_MS, SWEEP_BUDGET_MS)));
	const idleHours = opts.inventory.freePct !== null && opts.inventory.freePct < PRESSURE_FREE_PCT ? PRESSURE_IDLE_HOURS : SWEEP_IDLE_HOURS;
	const rows: ScratchVerdict[] = [];
	const quarantined: ScratchVerdict[] = [];
	const sizeEvidence: Record<string, ScratchTreeEvidence> = {};
	const unrunPaths: string[] = [];
	const tracked: Record<string, SweepTrackingEntry> = { ...opts.tracking?.entries };
	let walkedDirs = 0;
	let windowSkipped = 0;
	const finish = (): SweepResult => ({
		status: unrunPaths.length > 0 || opts.inventory.status !== "DONE" ? "UNRUN" : "DONE",
		reason: unrunPaths.length > 0 ? "sweep-coverage-incomplete" : "sweep-planned",
		roots: [root], walkedDirs, windowSkipped, rows, sizeEvidence, refused: 0, failed: 0, quarantined,
		plannedBytes: quarantined.reduce((n, row) => n + row.sizeBytes, 0), stagedBytes: 0, gb: 0,
		topOwners: ownerBytes(quarantined), undoLines: [], unrunPaths: [...new Set([...opts.inventory.unrunPaths, ...unrunPaths])],
		idleHours, inventory: opts.inventory, nextTracking: { lastRunMs: opts.nowMs, entries: tracked }, noClaim: SWEEP_NO_CLAIM,
	});
	let dirs: string[];
	inspect.onStage?.({ action: "sweep-enumerate", path: root });
	try {
		if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== resolve(root)) {
			unrunPaths.push(`${root}:root-identity-refused`);
			return finish();
		}
		dirs = opts.targets ?? readdirSync(root).sort().map(entry => join(root, entry));
	} catch (error) {
		unrunPaths.push(`${root}:enumeration-error:${error instanceof Error ? error.message : String(error)}`);
		return finish();
	}
	for (let index = 0; index < dirs.length; index++) {
		const dir = dirs[index]!;
		if (clock() >= deadlineMs) {
			unrunPaths.push(...dirs.slice(index));
			break;
		}
		let stat;
		inspect.onStage?.({ action: "sweep-identity", path: dir });
		try { stat = lstatSync(dir); } catch {
			unrunPaths.push(`${dir}:identity-probe-error`);
			continue;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			rows.push({ dir, action: "SKIP", reason: "not-a-real-directory", owner: null, sizeBytes: 0 });
			continue;
		}
		const snapshot = readScratchSizeSnapshot(dir);
		if (snapshot !== null) tracked[dir] = { ...snapshot, source: "create-or-done" };
		let verdict: ScratchVerdict;
		inspect.onStage?.({ action: "sweep-inspect-owner-fds", path: dir });
		try {
			verdict = inspectSession(dir, root, { ...inspect, now: opts.nowMs, skipSize: true, idleHours, deadlineMs }, opts.nameRequired ?? true);
		} catch {
			verdict = { dir, action: "SKIP", reason: "owner-probe-error", owner: null, sizeBytes: 0 };
		}
		walkedDirs++;
		const veto = inventoryVeto(dir, opts.inventory, opts.nowMs);
		if (veto !== null) verdict = { ...verdict, action: "SKIP", reason: veto };
		inspect.onStage?.({ action: "sweep-measure-idle", path: dir });
		const tree = measureScratchTree(dir, { deadlineMs, maxEntries: 10_000 });
		sizeEvidence[dir] = tree;
		if (tree.status !== "complete") {
			unrunPaths.push(`${dir}:${tree.reason ?? "tree-evidence-incomplete"}`);
			rows.push({ ...verdict, action: verdict.action === "LIVE" ? "LIVE" : "SKIP", reason: `${verdict.reason}+tree-evidence-incomplete`, sizeBytes: 0 });
			continue;
		}
		tracked[dir] = { device: stat.dev, inode: stat.ino, sizeBytes: tree.sizeBytes, measuredAtMs: opts.nowMs, status: "complete", source: "sweep" };
		verdict = { ...verdict, sizeBytes: tree.sizeBytes };
		// Unchanged root mtime is NOT a lease: owner, descriptors and descendants
		// are re-inspected on every run, even when the informational size is tracked.
		if (verdict.action === "REAP" && veto === null) {
			if (tree.freshestMtimeMs < opts.nowMs - idleHours * 3600_000) {
				verdict = { ...verdict, action: "QUARANTINE", reason: `${verdict.reason}+idle-${idleHours}h-quarantine-only` };
				quarantined.push(verdict);
			} else {
				windowSkipped++;
				verdict = { ...verdict, action: "SKIP", reason: `owner-dead-but-idle-under-${idleHours}h` };
			}
		}
		rows.push(verdict);
	}
	return finish();
}

/** One whole-job deadline includes inventory, discovery, fresh inspection and apply. */
export function sweepScratch(home: string, deps: ApplyDeps, opts: { nowMs: number; budgetMs?: number; tracking?: SweepTracking; apply?: boolean }): SweepResult {
	const deadlineMs = Date.now() + Math.max(0, Math.min(opts.budgetMs ?? SWEEP_BUDGET_MS, SWEEP_BUDGET_MS));
	deps.onStage?.({ action: "fsw-read-only-inventory", path: home });
	const inventory = collectSweepInventory(deps.run, opts.nowMs, Math.min(5000, deadlineMs - Date.now()));
	deps.onStage?.({ action: "sweep-discover-roots", path: home });
	const roots = resolveScratchRoots(home);
	const standalone = resolveSystemWorkDirs();
	// Build lanes are inventoried, not inferred reclaimable from a directory name.
	// A pooled target without the kit's deterministic owner identity remains SKIP.
	const pooled = inventory.entries.filter(entry => entry.axis === "A5_BUILD_LANES").map(entry => entry.path);
	const targetsByRoot = new Map<string, string[]>();
	const discoveryUnrun: string[] = [];
	const addTarget = (dir: string): void => {
		const root = dirname(dir);
		const targets = targetsByRoot.get(root) ?? [];
		targets.push(dir);
		targetsByRoot.set(root, targets);
	};
	for (const root of roots) {
		deps.onStage?.({ action: "sweep-discover-targets", path: root });
		discoveryUnrun.push(...eachSessionDir(root, addTarget, addTarget, deadlineMs));
		if (!targetsByRoot.has(root)) targetsByRoot.set(root, []);
	}
	for (const dir of standalone) {
		if (Date.now() >= deadlineMs) {
			discoveryUnrun.push(dir);
			continue;
		}
		deps.onStage?.({ action: "sweep-canonical-system-target", path: dir });
		try {
			if (lstatSync(dir).isSymbolicLink()) discoveryUnrun.push(`${dir}:system-target-symlink`);
			else addTarget(realpathSync(dir));
		} catch {
			discoveryUnrun.push(`${dir}:system-target-identity-unavailable`);
		}
	}
	for (const dir of pooled) addTarget(dir);
	const plans: SweepResult[] = [];
	const seen = new Set<string>();
	for (const [root, targets] of targetsByRoot) {
		const plan = planSweep(root, deps, { ...opts, deadlineMs, inventory, targets, nameRequired: roots.includes(root) });
		plan.rows = plan.rows.filter(row => !seen.has(row.dir));
		plan.quarantined = plan.quarantined.filter(row => !seen.has(row.dir));
		for (const row of plan.rows) seen.add(row.dir);
		plans.push(plan);
	}
	const rows = plans.flatMap(plan => plan.rows);
	const allCandidates = plans.flatMap(plan => plan.quarantined);
	// A staged ancestor already contains its nested work dirs. Never double-stage
	// or sum those bytes twice; an ineligible ancestor does not hide a safe child.
	const candidates = allCandidates.filter(candidate => !allCandidates.some(other =>
		other !== candidate && candidate.dir.startsWith(`${other.dir}/`)));
	for (const candidate of allCandidates) {
		if (!candidates.includes(candidate)) {
			const index = rows.findIndex(row => row.dir === candidate.dir);
			rows[index] = { ...candidate, action: "SKIP", reason: "covered-by-planned-ancestor", sizeBytes: 0 };
		}
	}
	const unrunPaths = [...inventory.unrunPaths, ...discoveryUnrun, ...plans.flatMap(plan => plan.unrunPaths)];
	const staged: ScratchVerdict[] = [];
	if (opts.apply) {
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index]!;
			if (Date.now() >= deadlineMs) {
				unrunPaths.push(...candidates.slice(index).map(row => row.dir));
				break;
			}
			const plan = plans.find(plan => plan.quarantined.includes(candidate))!;
			const root = plan.roots[0]!;
			deps.onStage?.({ action: "sweep-quarantine-only", path: candidate.dir });
			const terminal = applyOwnedQuarantine(candidate.dir, root, { ...candidate, action: "REAP" }, {
				...deps, now: opts.nowMs, skipSize: true, idleHours: plan.idleHours, deadlineMs,
			}, roots.includes(root));
			const rowIndex = rows.findIndex(row => row.dir === candidate.dir);
			rows[rowIndex] = terminal;
			deps.onProgress?.(terminal);
			if (terminal.action === "QUARANTINE") staged.push(terminal);
		}
	}
	const stagedBytes = staged.reduce((n, row) => n + row.sizeBytes, 0);
	const failed = rows.filter(row => row.status === "FAILED").length;
	const refused = rows.filter(row => row.status === "REFUSED").length;
	return {
		status: failed > 0 ? "FAILED" : unrunPaths.length > 0 || inventory.status !== "DONE" ? "UNRUN" : "DONE",
		reason: failed > 0 ? "sweep-apply-failed" : unrunPaths.length > 0 || inventory.status !== "DONE" ? "sweep-coverage-incomplete" : opts.apply ? "sweep-applied" : "sweep-planned",
		roots: [...new Set([...roots, ...targetsByRoot.keys()])], walkedDirs: plans.reduce((n, plan) => n + plan.walkedDirs, 0),
		windowSkipped: plans.reduce((n, plan) => n + plan.windowSkipped, 0), rows, refused, failed,
		sizeEvidence: Object.assign({}, ...plans.map(plan => plan.sizeEvidence)),
		quarantined: opts.apply ? staged : candidates,
		plannedBytes: candidates.reduce((n, row) => n + row.sizeBytes, 0), stagedBytes, gb: stagedBytes / 1e9,
		topOwners: ownerBytes(opts.apply ? staged : candidates),
		undoLines: staged.flatMap(row => row.undo ? [row.undo] : []),
		unrunPaths: [...new Set(unrunPaths)], idleHours: plans[0]?.idleHours ?? SWEEP_IDLE_HOURS, inventory,
		nextTracking: { lastRunMs: opts.nowMs, entries: Object.assign({}, opts.tracking?.entries, ...plans.map(plan => plan.nextTracking.entries)) },
		noClaim: SWEEP_NO_CLAIM,
	};
}

