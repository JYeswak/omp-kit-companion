import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { snapshotWatched } from "./operator-snapshot.ts";

export type PluginLinkKind = "ABSENT" | "SYMLINK" | "DIRECTORY" | "FILE" | "OTHER";
export interface PluginProfile { name: string; configFiles: readonly string[]; pluginDir?: string; writable?: boolean; refusal_reason?: string }
export interface PluginSnapshot {
	installed: boolean;
	target: string | null;
	link_path?: string | null;
	plugins_dir_hash: string | null;
	package_hash?: string | null;
	lock_hash: string | null;
	link_target_text?: string | null;
	version?: string | null;
	link_kind?: PluginLinkKind;
	disabled_rules?: readonly string[];
	lock_kind?: "ABSENT" | "FILE" | "SYMLINK" | "OTHER";
	plugin_dir_present?: boolean;
	node_modules_present?: boolean;
	snapshot_issue?: string;
}
export interface PluginUndoBackup {
	lock_state: "ABSENT" | "FILE";
	lock_file?: string;
	lock_mode?: number;
	package_state: "ABSENT" | "SYMLINK" | "DIRECTORY";
	package_backup?: string;
	package_tree_hash?: string;
	plugin_dir_present: boolean;
	node_modules_present: boolean;
}
export interface PluginStep {
	profile: string;
	action: "LINK" | "UNCHANGED";
	command: readonly string[];
	before: PluginSnapshot | null;
	disabled_rules_after?: readonly string[];
	refusal_reason?: string;
}
export interface PluginPlanOptions {
	regex_budget?: RegexBudgetSelection;
	store_version?: string;
	package_hash?: string;
	available_rules?: readonly string[];
}
export interface PluginPlan {
	store: string;
	steps: readonly PluginStep[];
	skipped: readonly { profile: string; reason: string }[];
	regex_budget?: RegexBudgetSelection;
}
export interface PluginReceipt {
	schema_version: 1;
	id: string;
	store: string;
	created_at: string;
	regex_budget?: RegexBudgetSelection;
	regex_budget_report_file?: string;
	rows: readonly {
		profile: string;
		status: "APPLIED" | "PARTIAL" | "REFUSED" | "SKIPPED" | "UNCHANGED";
		before: PluginSnapshot | null;
		after: PluginSnapshot | null;
		reason?: string;
		backup?: PluginUndoBackup;
	}[];
}
export interface PluginRunner {
	snapshot(profile: string): PluginSnapshot;
	invoke(profile: string, args: readonly string[]): { code: number; stdout: string; stderr: string };
	setDisabledRules?(profile: string, rules: readonly string[]): { code: number; stdout: string; stderr: string };
	postcheck?: (profile: string) => { ok: boolean; reason?: string };
}
function pluginPathHash(path: string): string {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error("PLUGIN_SNAPSHOT_PATH_INVALID");
	const snapshot = snapshotWatched([path]);
	if (snapshot.incomplete.length) throw new Error(`PLUGIN_SNAPSHOT_INCOMPLETE:${snapshot.incomplete.join(",")}`);
	const entries = [...snapshot.entries].map(([entry, value]) => [relative(path, entry) || ".", value] as const);
	entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function pluginProfileHashes(pluginDir: string): Pick<PluginSnapshot, "plugins_dir_hash" | "lock_hash"> {
	return {
		plugins_dir_hash: pluginPathHash(pluginDir),
		lock_hash: pluginPathHash(join(pluginDir, "omp-plugins.lock.json")),
	};
}
export function pluginPackageHash(packageDir: string): string {
	if (!isAbsolute(packageDir) || resolve(packageDir) !== packageDir)
		throw new Error("PLUGIN_PACKAGE_PATH_INVALID");
	const paths = ["package.json", "rules", "extensions"].map(path => join(packageDir, path));
	const expected: Array<"FILE" | "DIRECTORY"> = ["FILE", "DIRECTORY", "DIRECTORY"];
	for (let index = 0; index < paths.length; index++) {
		if (filesystemKind(paths[index]!) !== expected[index]) throw new Error("PLUGIN_PACKAGE_LAYOUT_INVALID");
	}
	const snapshot = snapshotWatched(paths);
	if (snapshot.incomplete.length) throw new Error(`PLUGIN_PACKAGE_SNAPSHOT_INCOMPLETE:${snapshot.incomplete.join(",")}`);
	const entries = [...snapshot.entries].map(([path, value]) => [relative(packageDir, path), value] as const);
	entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
export type RegexBudgetSelection = Readonly<{
	status: "PASS" | "FAIL";
	excluded_rules: readonly string[];
	report_sha256: string;
	stream_total_ms: number;
	stream_budget_ms: number;
}>;

const ruleNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function validRuleName(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && ruleNamePattern.test(value);
}
function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Derive conservative profile exclusions from the regex-budget tool's emitted report. */
export function analyzeRegexBudgetOutput(output: string): RegexBudgetSelection {
	if (Buffer.byteLength(output, "utf8") > 8 * 1024 * 1024) throw new Error("REGEX_BUDGET_REPORT_TOO_LARGE");
	const lines = output.split(/\r?\n/).filter(line => line.startsWith("JSON_REPORT="));
	if (lines.length !== 1) throw new Error("REGEX_BUDGET_REPORT_MISSING");
	let value: unknown;
	try { value = JSON.parse(lines[0]!.slice("JSON_REPORT=".length)); } catch { throw new Error("REGEX_BUDGET_REPORT_INVALID"); }
	if (!record(value) || (value.status !== "PASS" && value.status !== "FAIL") || !record(value.engine) ||
		typeof value.engine.bun !== "string" || typeof value.engine.omp_source !== "string" ||
		typeof value.rules_loaded !== "number" || !Number.isInteger(value.rules_loaded) ||
		typeof value.conditions_measured !== "number" || !Number.isInteger(value.conditions_measured) ||
		!Array.isArray(value.measurements) || value.conditions_measured !== value.measurements.length ||
		!Array.isArray(value.lint_violations) || !record(value.stream) ||
		typeof value.stream.complete !== "boolean" || !finiteNumber(value.stream.total_ms) || value.stream.total_ms < 0 ||
		!finiteNumber(value.stream.budget_ms) || value.stream.budget_ms < 0 || !Array.isArray(value.stream.by_rule))
		throw new Error("REGEX_BUDGET_REPORT_INVALID");

	const measurements = value.measurements;
	const names = new Set<string>();
	const excluded = new Set<string>();
	const measuredConditions = new Map<string, number | null>();
	for (const item of measurements) {
		if (!record(item) || !validRuleName(item.rule) || typeof item.condition_index !== "number" ||
			!Number.isInteger(item.condition_index) || item.condition_index < 0 ||
			!["MEASURED", "TIMEOUT", "COMPILE_ERROR", "GATE_TIMEOUT"].includes(String(item.status)) ||
			!Array.isArray(item.failures) ||
			!item.failures.every(failure => record(failure) && typeof failure.code === "string"))
			throw new Error("REGEX_BUDGET_REPORT_INVALID");
		const key = `${item.rule}#${item.condition_index}`;
		if (measuredConditions.has(key)) throw new Error("REGEX_BUDGET_REPORT_INVALID");
		names.add(item.rule);
		if (item.status !== "MEASURED" || item.failures.length) excluded.add(item.rule);
		if (item.stream_ms !== undefined && (!finiteNumber(item.stream_ms) || item.stream_ms < 0))
			throw new Error("REGEX_BUDGET_REPORT_INVALID");
		measuredConditions.set(key, finiteNumber(item.stream_ms) ? item.stream_ms : null);
	}

	const timings = new Map<string, number>();
	let byRuleTotal = 0;
	for (const item of value.stream.by_rule) {
		if (!record(item) || !validRuleName(item.rule) || typeof item.condition_index !== "number" ||
			!Number.isInteger(item.condition_index) || item.condition_index < 0 ||
			!finiteNumber(item.ms) || item.ms < 0 || !names.has(item.rule))
			throw new Error("REGEX_BUDGET_REPORT_INVALID");
		const key = `${item.rule}#${item.condition_index}`;
		if (measuredConditions.get(key) !== item.ms) throw new Error("REGEX_BUDGET_REPORT_INVALID");
		byRuleTotal += item.ms;
		timings.set(item.rule, (timings.get(item.rule) ?? 0) + item.ms);
	}
	if (Math.abs(byRuleTotal - value.stream.total_ms) > 0.01 ||
		value.stream.complete !== (value.stream.by_rule.length === measurements.length))
		throw new Error("REGEX_BUDGET_REPORT_INVALID");

	for (const violation of value.lint_violations) {
		if (!record(violation) || !validRuleName(violation.rule) || !names.has(violation.rule))
			throw new Error("REGEX_BUDGET_REPORT_INVALID");
		excluded.add(violation.rule);
	}
	if (!value.stream.complete) {
		for (const item of measurements) {
			if (record(item) && item.stream_ms === undefined) excluded.add(item.rule as string);
		}
	}

	let remaining = [...timings].reduce((sum, [rule, ms]) => sum + (excluded.has(rule) ? 0 : ms), 0);
	if (value.status === "FAIL" && remaining > value.stream.budget_ms) {
		for (const [rule, ms] of [...timings].sort(([leftRule, leftMs], [rightRule, rightMs]) =>
			rightMs - leftMs || leftRule.localeCompare(rightRule))) {
			if (remaining <= value.stream.budget_ms) break;
			if (excluded.has(rule)) continue;
			excluded.add(rule);
			remaining -= ms;
		}
	}
	if ((value.status === "PASS" && (excluded.size > 0 || names.size === 0 || !value.stream.complete ||
			value.stream.total_ms > value.stream.budget_ms)) ||
		(value.status === "FAIL" && (excluded.size === 0 || remaining > value.stream.budget_ms)))
		throw new Error("REGEX_BUDGET_FAILURE_UNATTRIBUTED");

	return {
		status: value.status,
		excluded_rules: [...excluded].sort(),
		report_sha256: createHash("sha256").update(output).digest("hex"),
		stream_total_ms: value.stream.total_ms,
		stream_budget_ms: value.stream.budget_ms,
	};
}


function profileArgs(profile: string, command: "link" | "uninstall", target: string): readonly string[] {
	return ["omp", ...(profile === "default" ? [] : ["--profile", profile]), "plugin", command, target];
}

function samePluginSnapshot(left: PluginSnapshot, right: PluginSnapshot): boolean {
	return left.installed === right.installed && left.target === right.target && left.link_path === right.link_path &&
		left.link_target_text === right.link_target_text && left.plugins_dir_hash === right.plugins_dir_hash &&
		left.package_hash === right.package_hash && left.lock_hash === right.lock_hash &&
		left.version === right.version && left.link_kind === right.link_kind &&
		left.lock_kind === right.lock_kind && left.plugin_dir_present === right.plugin_dir_present &&
		left.node_modules_present === right.node_modules_present && left.snapshot_issue === right.snapshot_issue;
}

function sameSnapshot(left: PluginSnapshot, right: PluginSnapshot): boolean {
	return samePluginSnapshot(left, right) &&
		JSON.stringify(left.disabled_rules ?? null) === JSON.stringify(right.disabled_rules ?? null);
}
function filesystemKind(path: string): "ABSENT" | "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER" {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "SYMLINK";
		if (stat.isFile()) return "FILE";
		if (stat.isDirectory()) return "DIRECTORY";
		return "OTHER";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
		throw error;
	}
}

function captureUndoBackup(
	before: PluginSnapshot,
	profile: string,
	receiptId: string,
	stateRoot: string,
): PluginUndoBackup | undefined {
	if (before.lock_kind === undefined || before.plugin_dir_present === undefined ||
		before.node_modules_present === undefined || !before.link_path || !before.link_kind) return undefined;
	if (!isAbsolute(before.link_path) || resolve(before.link_path) !== before.link_path)
		throw new Error("PLUGIN_LINK_PATH_INVALID");
	if (before.link_kind !== "ABSENT" && before.link_kind !== "SYMLINK" && before.link_kind !== "DIRECTORY")
		throw new Error("PLUGIN_PATH_UNSAFE_TO_BACKUP");
	if (before.lock_kind !== "ABSENT" && before.lock_kind !== "FILE")
		throw new Error("PLUGIN_LOCK_UNSAFE_TO_BACKUP");
	if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || filesystemKind(stateRoot) !== "DIRECTORY")
		throw new Error("PLUGIN_BACKUP_ROOT_INVALID");

	const pluginDir = dirname(dirname(before.link_path));
	const nodeModulesDir = dirname(before.link_path);
	if (filesystemKind(pluginDir) !== (before.plugin_dir_present ? "DIRECTORY" : "ABSENT") ||
		filesystemKind(nodeModulesDir) !== (before.node_modules_present ? "DIRECTORY" : "ABSENT"))
		throw new Error("PLUGIN_DIRECTORIES_CHANGED_BEFORE_BACKUP");
	if (filesystemKind(before.link_path) !== before.link_kind)
		throw new Error("PLUGIN_LINK_CHANGED_BEFORE_BACKUP");

	const lockPath = join(pluginDir, "omp-plugins.lock.json");
	if (pluginPathHash(lockPath) !== before.lock_hash || filesystemKind(lockPath) !== before.lock_kind)
		throw new Error("PLUGIN_LOCK_CHANGED_BEFORE_BACKUP");

	const backupName = `plugin-${receiptId}-${createHash("sha256").update(profile).digest("hex").slice(0, 12)}`;
	const backup: PluginUndoBackup = {
		lock_state: before.lock_kind,
		package_state: before.link_kind,
		plugin_dir_present: before.plugin_dir_present,
		node_modules_present: before.node_modules_present,
	};
	if (before.link_kind === "DIRECTORY") {
		const packageTreeHash = pluginPathHash(before.link_path);
		const packageBackup = join(stateRoot, `${backupName}.package`);
		try {
			cpSync(before.link_path, packageBackup, {
				recursive: true,
				dereference: false,
				errorOnExist: true,
				force: false,
				preserveTimestamps: true,
			});
			if (pluginPathHash(packageBackup) !== packageTreeHash || pluginPathHash(before.link_path) !== packageTreeHash)
				throw new Error("PLUGIN_PACKAGE_CHANGED_DURING_BACKUP");
		} catch (error) {
			if (filesystemKind(packageBackup) === "DIRECTORY") rmSync(packageBackup, { recursive: true, force: true });
			throw error;
		}
		backup.package_backup = `${backupName}.package`;
		backup.package_tree_hash = packageTreeHash;
	}
	if (before.lock_kind === "FILE") {
		const lockStat = lstatSync(lockPath);
		const lockBytes = readFileSync(lockPath);
		if (pluginPathHash(lockPath) !== before.lock_hash)
			throw new Error("PLUGIN_LOCK_CHANGED_DURING_BACKUP");
		backup.lock_file = `${backupName}.lock`;
		backup.lock_mode = lockStat.mode & 0o7777;
		writeFileSync(join(stateRoot, backup.lock_file), lockBytes, { flag: "wx", mode: 0o600 });
	}
	return backup;
}

function removeEmptyDirectory(path: string): void {
	if (filesystemKind(path) === "ABSENT") return;
	if (filesystemKind(path) !== "DIRECTORY") throw new Error("PLUGIN_UNDO_DIRECTORY_UNSAFE");
	if (readdirSync(path).length) throw new Error("PLUGIN_UNDO_DIRECTORY_NOT_EMPTY");
	rmdirSync(path);
}

function restorePluginFilesystem(
	row: PluginReceipt["rows"][number],
	backup: PluginUndoBackup,
	store: string,
	stateRoot: string,
): void {
	const before = row.before!;
	const after = row.after!;
	const linkPath = before.link_path;
	if (!linkPath || linkPath !== after.link_path || !isAbsolute(linkPath) || resolve(linkPath) !== linkPath)
		throw new Error("PLUGIN_UNDO_LINK_PATH_INVALID");
	if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot || filesystemKind(stateRoot) !== "DIRECTORY")
		throw new Error("PLUGIN_BACKUP_ROOT_INVALID");
	if (backup.package_state !== before.link_kind) throw new Error("PLUGIN_UNDO_BACKUP_STATE_MISMATCH");

	const pluginDir = dirname(dirname(linkPath));
	const nodeModulesDir = dirname(linkPath);
	const currentKind = filesystemKind(linkPath);
	if (after.link_kind === "SYMLINK") {
		if (currentKind !== "SYMLINK" || resolve(dirname(linkPath), readlinkSync(linkPath)) !== resolve(store))
			throw new Error("PLUGIN_UNDO_LINK_POSTIMAGE_MISMATCH");
	} else if (after.link_kind !== "ABSENT" || currentKind !== "ABSENT")
		throw new Error("PLUGIN_UNDO_LINK_POSTIMAGE_MISMATCH");

	const lockPath = join(pluginDir, "omp-plugins.lock.json");
	const currentLockKind = filesystemKind(lockPath);
	if ((after.lock_kind !== "ABSENT" && after.lock_kind !== "FILE") || currentLockKind !== after.lock_kind)
		throw new Error("PLUGIN_UNDO_LOCK_POSTIMAGE_UNSAFE");
	if (backup.lock_state === "FILE") {
		if (!backup.lock_file || !/^[A-Za-z0-9._-]+$/.test(backup.lock_file) || backup.lock_mode === undefined)
			throw new Error("PLUGIN_UNDO_BACKUP_INVALID");
		const backupPath = join(stateRoot, backup.lock_file);
		if (filesystemKind(backupPath) !== "FILE") throw new Error("PLUGIN_UNDO_BACKUP_MISSING");
		const bytes = readFileSync(backupPath);
		writeFileSync(lockPath, bytes, { mode: backup.lock_mode });
		chmodSync(lockPath, backup.lock_mode);
	} else if (currentLockKind === "FILE") unlinkSync(lockPath);

	if (currentKind === "SYMLINK") unlinkSync(linkPath);
	if (backup.package_state === "SYMLINK") {
		const priorTarget = before.link_target_text ?? before.target;
		if (!priorTarget) throw new Error("PRIOR_PLUGIN_TARGET_UNAVAILABLE");
		symlinkSync(priorTarget, linkPath, "dir");
	} else if (backup.package_state === "DIRECTORY") {
		if (!backup.package_backup || !/^[A-Za-z0-9._-]+$/.test(backup.package_backup) ||
			!backup.package_tree_hash || !/^[0-9a-f]{64}$/.test(backup.package_tree_hash))
			throw new Error("PLUGIN_UNDO_BACKUP_INVALID");
		const packageBackup = join(stateRoot, backup.package_backup);
		if (filesystemKind(packageBackup) !== "DIRECTORY" || pluginPathHash(packageBackup) !== backup.package_tree_hash)
			throw new Error("PLUGIN_UNDO_PACKAGE_BACKUP_INVALID");
		cpSync(packageBackup, linkPath, {
			recursive: true,
			dereference: false,
			errorOnExist: true,
			force: false,
			preserveTimestamps: true,
		});
		if (pluginPathHash(linkPath) !== backup.package_tree_hash)
			throw new Error("PLUGIN_UNDO_PACKAGE_RESTORE_MISMATCH");
	} else if (backup.package_state !== "ABSENT") throw new Error("PLUGIN_UNDO_PACKAGE_STATE_INVALID");

	if (!backup.node_modules_present) removeEmptyDirectory(nodeModulesDir);
	if (!backup.plugin_dir_present) removeEmptyDirectory(pluginDir);
}

export function planPlugin(
	store: string,
	profiles: readonly PluginProfile[],
	snapshots: ReadonlyMap<string, PluginSnapshot> = new Map(),
	options: PluginPlanOptions = {},
): PluginPlan {
	if (!store.startsWith("/") || store.endsWith("/")) throw new Error("plugin store must be an absolute directory");
	const storePath = resolve(store);
	const steps: PluginStep[] = [];
	const skipped: { profile: string; reason: string }[] = [];
	if (options.regex_budget) {
		if (!options.available_rules) throw new Error("REGEX_BUDGET_RULES_UNVERIFIED");
		const available = new Set(options.available_rules);
		const missing = options.regex_budget.excluded_rules.filter(name => !available.has(name));
		if (missing.length) throw new Error(`REGEX_BUDGET_RULE_UNKNOWN:${missing.join(",")}`);
	}
	for (const profile of profiles) {
		const before = snapshots.get(profile.name) ?? null;
		if (profile.pluginDir) {
			const pluginDir = resolve(profile.pluginDir);
			if (storePath === pluginDir || storePath.startsWith(`${pluginDir}/`)) throw new Error("STORE_INSIDE_PROFILE_PLUGIN_DIR");
		}
		if (profile.configFiles.includes("config.yml") && profile.configFiles.includes("config.yaml")) {
			skipped.push({ profile: profile.name, reason: "DUAL_CONFIG" });
			continue;
		}
		let refusalReason = profile.refusal_reason;
		if (!refusalReason && profile.writable === false) refusalReason = "PROFILE_UNWRITABLE:EACCES";
		if (!refusalReason && before?.snapshot_issue) refusalReason = before.snapshot_issue;
		if (!refusalReason && before && (before.plugins_dir_hash === null || before.lock_hash === null))
			refusalReason = "PROFILE_SNAPSHOT_UNVERIFIED";
		let action: PluginStep["action"] = "LINK";
		if (!refusalReason && before?.installed &&
			(before.target === storePath || (options.package_hash !== undefined && before.package_hash === options.package_hash)))
			action = "UNCHANGED";
		if (!refusalReason && action === "LINK" && before?.lock_kind &&
			before.lock_kind !== "ABSENT" && before.lock_kind !== "FILE")
			refusalReason = "PROFILE_LOCK_UNSAFE";
		if (!refusalReason && action === "LINK" && before?.installed &&
			before.link_kind !== "SYMLINK" && before.link_kind !== "DIRECTORY")
			refusalReason = "EXISTING_PLUGIN_PACKAGE_UNSAFE_TO_REPLACE";
		if (!refusalReason && before && !before.installed && before.link_kind && before.link_kind !== "ABSENT")
			refusalReason = "UNMANAGED_PLUGIN_PATH";

		let disabledRulesAfter: readonly string[] | undefined;
		if (!refusalReason && options.regex_budget?.excluded_rules.length && profile.name !== "default") {
			if (!before || !Array.isArray(before.disabled_rules) || !before.disabled_rules.every(validRuleName))
				refusalReason = "PROFILE_POLICY_UNVERIFIED";
			else disabledRulesAfter = [...new Set([...before.disabled_rules, ...options.regex_budget.excluded_rules])];
		}
		steps.push({
			profile: profile.name,
			action,
			command: profileArgs(profile.name, "link", store),
			before,
			...(disabledRulesAfter ? { disabled_rules_after: disabledRulesAfter } : {}),
			...(refusalReason ? { refusal_reason: refusalReason } : {}),
		});
	}
	return { store, steps, skipped, ...(options.regex_budget ? { regex_budget: options.regex_budget } : {}) };
}

export function applyPlugin(plan: PluginPlan, runner: PluginRunner, stateRoot: string, regexBudgetReportOutput?: string): PluginReceipt {
	if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) throw new Error("PLUGIN_BACKUP_ROOT_INVALID");
	const id = randomUUID();
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	let budgetReceipt: { regex_budget: RegexBudgetSelection; regex_budget_report_file: string } | undefined;
	if (plan.regex_budget) {
		if (regexBudgetReportOutput === undefined) throw new Error("REGEX_BUDGET_REPORT_OUTPUT_REQUIRED");
		const verified = analyzeRegexBudgetOutput(regexBudgetReportOutput);
		if (JSON.stringify(verified) !== JSON.stringify(plan.regex_budget)) throw new Error("REGEX_BUDGET_PLAN_REPORT_MISMATCH");
		const reportFile = `plugin-${id}.regex-budget.out`;
		writeFileSync(join(stateRoot, reportFile), regexBudgetReportOutput, { flag: "wx", mode: 0o600 });
		budgetReceipt = { regex_budget: plan.regex_budget, regex_budget_report_file: reportFile };
	} else if (regexBudgetReportOutput !== undefined) throw new Error("REGEX_BUDGET_PLAN_REQUIRED");
	const rows: Array<PluginReceipt["rows"][number]> = [
		...plan.skipped.map(item => ({ profile: item.profile, status: "SKIPPED" as const, before: null, after: null, reason: item.reason })),
	];
	for (const step of plan.steps) {
		const before = step.before ?? runner.snapshot(step.profile);
		const current = runner.snapshot(step.profile);
		if (step.refusal_reason) {
			rows.push({ profile: step.profile, status: "REFUSED", before, after: current, reason: step.refusal_reason });
			continue;
		}
		if (step.before && !sameSnapshot(step.before, current)) {
			rows.push({ profile: step.profile, status: "REFUSED", before, after: current, reason: "FRESH_PLAN" });
			continue;
		}
		if (before.snapshot_issue || before.plugins_dir_hash === null || before.lock_hash === null) {
			rows.push({ profile: step.profile, status: "REFUSED", before, after: current, reason: "PROFILE_SNAPSHOT_UNVERIFIED" });
			continue;
		}
		let backup: PluginUndoBackup | undefined;
		if (step.action === "LINK") {
			try {
				backup = captureUndoBackup(before, step.profile, id, stateRoot);
			} catch (error) {
				rows.push({ profile: step.profile, status: "REFUSED", before, after: current,
					reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
		}
		const preMutation = runner.snapshot(step.profile);
		if (!sameSnapshot(before, preMutation)) {
			rows.push({ profile: step.profile, status: "REFUSED", before, after: preMutation, reason: "FRESH_PLAN" });
			continue;
		}
		const desiredRules = step.disabled_rules_after;
		const rulesChanged = desiredRules !== undefined &&
			JSON.stringify(desiredRules) !== JSON.stringify(before.disabled_rules ?? []);
		if (step.action === "UNCHANGED" && !rulesChanged) {
			const check = runner.postcheck?.(step.profile);
			rows.push(check && !check.ok
				? { profile: step.profile, status: "REFUSED", before, after: runner.snapshot(step.profile), reason: check.reason ?? "POSTCHECK_FAILED" }
				: { profile: step.profile, status: "UNCHANGED", before, after: runner.snapshot(step.profile) });
			continue;
		}
		if (rulesChanged) {
			if (!runner.setDisabledRules) {
				rows.push({ profile: step.profile, status: "REFUSED", before, after: runner.snapshot(step.profile), reason: "PROFILE_POLICY_WRITE_UNAVAILABLE" });
				continue;
			}
			const result = runner.setDisabledRules(step.profile, desiredRules);
			const after = runner.snapshot(step.profile);
			if (result.code !== 0 || JSON.stringify(after.disabled_rules) !== JSON.stringify(desiredRules)) {
				rows.push({ profile: step.profile, status: sameSnapshot(before, after) ? "REFUSED" : "PARTIAL", before, after,
					reason: result.stderr || "PROFILE_POLICY_POSTCHECK_FAILED", ...(backup ? { backup } : {}) });
				continue;
			}
			if (!samePluginSnapshot(before, after)) {
				const restore = runner.setDisabledRules(step.profile, before.disabled_rules ?? []);
				const restored = runner.snapshot(step.profile);
				rows.push({
					profile: step.profile,
					status: "REFUSED",
					before,
					after: restored,
					reason: restore.code === 0 && sameSnapshot(before, restored)
						? "PLUGIN_CHANGED_DURING_POLICY_UPDATE"
						: "PROFILE_CHANGED_DURING_POLICY_UPDATE",
				});
				continue;
			}
		}
		if (step.action === "LINK") {
			const result = runner.invoke(step.profile, step.command.slice(1));
			if (result.code !== 0) {
				const after = runner.snapshot(step.profile);
				rows.push({ profile: step.profile, status: sameSnapshot(before, after) ? "REFUSED" : "PARTIAL", before, after,
					reason: result.stderr || `plugin link exited ${result.code}`, ...(backup ? { backup } : {}) });
				continue;
			}
		}
		const check = runner.postcheck?.(step.profile);
		const after = runner.snapshot(step.profile);
		if (check && !check.ok)
			rows.push({ profile: step.profile, status: "PARTIAL", before, after, reason: check.reason ?? "POSTCHECK_FAILED", ...(backup ? { backup } : {}) });
		else if (after.snapshot_issue || after.plugins_dir_hash === null || after.lock_hash === null)
			rows.push({ profile: step.profile, status: "PARTIAL", before, after, reason: "PROFILE_SNAPSHOT_UNVERIFIED", ...(backup ? { backup } : {}) });
		else rows.push({ profile: step.profile, status: "APPLIED", before, after, ...(backup ? { backup } : {}) });
	}
	const receipt: PluginReceipt = { schema_version: 1, id, store: plan.store, created_at: new Date().toISOString(),
		...(budgetReceipt ?? {}), rows };
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const path = join(stateRoot, `plugin-${receipt.id}.json`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return receipt;
}

export function undoPlugin(
	receipt: PluginReceipt,
	runner: PluginRunner,
	stateRoot?: string,
): readonly { profile: string; status: "RESTORED" | "REFUSED"; reason?: string }[] {
	const rows: { profile: string; status: "RESTORED" | "REFUSED"; reason?: string }[] = [];
	for (const row of receipt.rows) {
		if (row.status !== "APPLIED" && row.status !== "PARTIAL") continue;
		if (!row.before || !row.after) {
			rows.push({ profile: row.profile, status: "REFUSED", reason: "RECEIPT_SNAPSHOT_MISSING" });
			continue;
		}
		const current = runner.snapshot(row.profile);
		if (!sameSnapshot(row.after, current)) {
			rows.push({ profile: row.profile, status: "REFUSED", reason: "POSTIMAGE_CHANGED" });
			continue;
		}
		let reason: string | undefined;
		const pluginChanged = row.before.installed !== row.after.installed || row.before.target !== row.after.target ||
			row.before.link_kind !== row.after.link_kind;
		if (pluginChanged && row.backup) {
			if (!stateRoot) reason = "PLUGIN_UNDO_BACKUP_ROOT_REQUIRED";
			else {
				try {
					restorePluginFilesystem(row, row.backup, receipt.store, stateRoot);
				} catch (error) {
					reason = error instanceof Error ? error.message : String(error);
				}
			}
		} else if (pluginChanged) {
			if (row.before.installed && !row.before.target) reason = "PRIOR_PLUGIN_TARGET_UNAVAILABLE";
			else {
				const command = row.before.installed ? "link" : "uninstall";
				const target = row.before.target ?? "omp-kit-companion";
				const result = runner.invoke(row.profile, profileArgs(row.profile, command, target).slice(1));
				if (result.code !== 0) reason = result.stderr || `plugin undo exited ${result.code}`;
			}
		}
		if (!reason && JSON.stringify(row.before.disabled_rules ?? []) !== JSON.stringify(row.after.disabled_rules ?? [])) {
			if (!runner.setDisabledRules || !row.before.disabled_rules) reason = "PROFILE_POLICY_UNDO_UNAVAILABLE";
			else {
				const result = runner.setDisabledRules(row.profile, row.before.disabled_rules);
				if (result.code !== 0) reason = result.stderr || "PROFILE_POLICY_UNDO_FAILED";
			}
		}
		const after = runner.snapshot(row.profile);
		if (!reason && !sameSnapshot(row.before, after)) reason = "UNDO_POSTCHECK_CHANGED";
		rows.push(reason ? { profile: row.profile, status: "REFUSED", reason } : { profile: row.profile, status: "RESTORED" });
	}
	return rows;
}

export function readPluginReceipt(path: string): PluginReceipt {
	return JSON.parse(readFileSync(path, "utf8")) as PluginReceipt;
}
