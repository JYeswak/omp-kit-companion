// activation.ts — ACTIVEDEFAULT1 (bead ompkit-fp72.135.3.77): every kit safeguard is
// ON by default after install; turning one off needs a recorded reason.
//
// One activation manifest lists each safeguard and the verb that turns it on:
// the plugin rule pack (rules/, loaded by OMP through each profile's plugin
// link), the opt-in fleet rule pack (rules-fleet/, installed into
// ~/.agents/rules), plugin extensions (package.json omp.extensions, loaded
// through the same plugin link), kit services (KNOWN_JOBS launchd labels),
// hook members per fleet repo, and every profile's plugin link to the
// installed release.
// `omp-kit doctor --scope activation` reports each item as ON, OFF-WITH-REASON
// or OFF-NO-REASON. OFF-NO-REASON is a FAIL (nonzero exit). The doctor is
// read-only; there is no apply verb in this slice.
//
// Readbacks reuse the kit's existing helpers and never reimplement them:
// readManifest for the plugin rule manifest, planRules (apply rules plan) for
// the fleet pack only, profilePluginRuleStatus (owned by src/diagnostics.ts,
// shared with doctor --scope rules) for per-profile plugin rule activation,
// extractImportSpecifiers for plugin extension loadability, inventoryServices
// for launchd loaded state, censusHookFreshness for per-repo hook members, and
// the plugin-release link reader for profile links. `apply rules --plan`
// without --fleet manages legacy ~/.agents copies ("legacy ... owned by
// migrate" in doctor --scope rules), which is not activation and is not read
// here.
import { run } from "./kitlib/run.ts";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyRulePlan, planRules } from "./apply-rules.ts";
import { applyExtensions, planExtensions } from "./apply-extensions.ts";
import { profilePluginRuleStatus, readManifest } from "./diagnostics.ts";
import { extractImportSpecifiers } from "./extensions.ts";
import { HOOK_MEMBER_PAIRS, censusHookFreshness, liveHookFreshnessIo, liveHookRefreshIo, refreshFleetHooks, type HookRefreshIo, type HookRepoRow } from "./hook-refresh.ts";
import { KNOWN_JOBS } from "./service.ts";
import { livePluginReleaseIo, type PluginLink } from "./plugin-release.ts";
import { defaultInventoryDeps, inventoryServices, type ServiceRow } from "./services.ts";

export const ACTIVATION_VERSION = 1;

export type ActivationStatus = "ON" | "OFF_WITH_REASON" | "OFF_NO_REASON";
export type ActivationKind = "rule" | "extension" | "service" | "hook" | "profile-link";

export interface ActivationItem {
	item: string;
	kind: ActivationKind;
	/** The verb that turns this safeguard on. Never executed by the doctor. */
	apply: string;
	/** The readback that proves it is on. */
	readback: string;
	status: ActivationStatus;
	detail: string;
	opt_out?: { reason: string; by: string; at: string };
}

export interface ActivationReport {
	scope: "activation";
	overall: "PASS" | "FAIL";
	items: ActivationItem[];
	on: number;
	off_with_reason: number;
	off_no_reason: number;
	manifest_issue: string | null;
	optouts_issue: string | null;
}

export interface OptOut {
	item: string;
	reason: string;
	by: string;
	at: string;
}

/** Injectable seams: live wiring shells out (launchd, git); tests inject fakes. */
export interface ActivationDeps {
	services: (home: string) => ServiceRow[];
	hookRows: () => HookRepoRow[];
	pluginLinks: () => PluginLink[];
	readOptOuts: () => { optouts: OptOut[]; issue: string | null };
}

export function activationOptOutPath(home: string): string {
	return join(home, ".config", "omp-kit", "activation-optouts.json");
}

function fail(code: string, detail?: string): never {
	throw new Error(detail ? `${code}: ${detail}` : code);
}

function parseOptOuts(raw: string): OptOut[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		fail("OPT_OUT_RECORD_UNREADABLE", "opt-out file is not JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("OPT_OUT_RECORD_UNREADABLE", "opt-out file shape is not recognized");
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.optouts)) fail("OPT_OUT_RECORD_UNREADABLE", "opt-out file shape is not recognized");
	const out: OptOut[] = [];
	for (const entry of record.optouts as unknown[]) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("OPT_OUT_RECORD_UNREADABLE", "opt-out entry shape is not recognized");
		const row = entry as Record<string, unknown>;
		if (typeof row.item !== "string" || row.item.length === 0 ||
			typeof row.reason !== "string" || row.reason.trim().length === 0 ||
			typeof row.by !== "string" || typeof row.at !== "string") fail("OPT_OUT_RECORD_UNREADABLE", "opt-out entry shape is not recognized");
		out.push({ item: row.item, reason: row.reason, by: row.by, at: row.at });
	}
	return out;
}

export function readOptOutFile(home: string): { optouts: OptOut[]; issue: string | null } {
	const path = activationOptOutPath(home);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { optouts: [], issue: null };
		return { optouts: [], issue: `opt-out file unreadable: ${path}` };
	}
	try {
		return { optouts: parseOptOuts(raw), issue: null };
	} catch (error) {
		return { optouts: [], issue: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Record an opt-out for one activation item. Refuses an empty reason and
 * refuses to append to a corrupt record (fail closed). Library only: the
 * doctor never writes.
 */
export function recordOptOut(home: string, item: string, reason: string, opts?: { by?: string; at?: string }): OptOut {
	if (typeof item !== "string" || item.trim().length === 0) fail("OPT_OUT_ITEM_REQUIRED");
	if (typeof reason !== "string" || reason.trim().length === 0) fail("OPT_OUT_REASON_REQUIRED");
	if (!isAbsolute(home) || resolve(home) !== home) fail("OPT_OUT_HOME_INVALID");
	const path = activationOptOutPath(home);
	let optouts: OptOut[];
	try {
		optouts = parseOptOuts(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") optouts = [];
		else throw error;
	}
	const record: OptOut = {
		item,
		reason: reason.trim(),
		by: opts?.by ?? `uid:${process.getuid?.() ?? "unknown"}`,
		at: opts?.at ?? new Date().toISOString(),
	};
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ version: 1, optouts: [...optouts, record] }, null, 2)}\n`, { mode: 0o600 });
	return record;
}

interface ManifestRuleEntry {
	id: string;
	name: string;
	apply: string;
	desiredSha256: string | null;
	action: string;
}


/** Plugin-pack (rules/) manifest entries from the release manifest. */
function pluginRuleEntries(root: string): ManifestRuleEntry[] {
	const manifest = readManifest(root);
	if (manifest.error) fail("ACTIVATION_MANIFEST_INVALID", manifest.error);
	return manifest.rules.map((rule) => ({
		id: `rule:rules/${rule.name}`,
		name: rule.name,
		apply: "omp-kit apply plugin --store <release> --profiles all --include-default --apply",
		desiredSha256: rule.sha256,
		action: "plugin-link",
	}));
}

/** Fleet-pack (rules-fleet/) entries via the apply-rules plan helper. */
function fleetRuleEntries(root: string, home: string): ManifestRuleEntry[] {
	const plan = planRules({ root, home, fleet: true });
	return plan.entries
		.filter((entry) => entry.desiredSha256 !== null)
		.map((entry) => ({
			id: `rule:rules-fleet/${entry.name}`,
			name: entry.name,
			apply: "omp-kit apply rules --fleet --apply --yes",
			desiredSha256: entry.desiredSha256,
			action: entry.action,
		}));
}

function extensionEntries(root: string): { id: string; file: string; apply: string }[] {
	let pkg: unknown;
	try {
		pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	} catch {
		fail("ACTIVATION_MANIFEST_INVALID", "release package.json is unreadable");
	}
	const omp = (pkg as Record<string, unknown>)?.omp;
	const listed = (omp as Record<string, unknown>)?.extensions;
	const notLoaded = (omp as Record<string, unknown>)?.notLoadedExtensions;
	if (!Array.isArray(listed) || !listed.every((entry) => typeof entry === "string")) {
		fail("ACTIVATION_MANIFEST_INVALID", "package.json omp.extensions is not a string list");
	}
	if (!notLoaded || typeof notLoaded !== "object" || Array.isArray(notLoaded)) {
		fail("ACTIVATION_MANIFEST_INVALID", "package.json omp.notLoadedExtensions is not a reason map");
	}
	for (const [file, reason] of Object.entries(notLoaded as Record<string, unknown>)) {
		if (typeof reason !== "string" || reason.trim().length === 0) {
			fail("ACTIVATION_MANIFEST_INVALID", `${file} has an empty not-loaded reason`);
		}
	}
	const inListed = new Set(listed as string[]);
	const inNotLoaded = new Set(Object.keys(notLoaded as Record<string, unknown>));
	let shipped: string[];
	try {
		shipped = readdirSync(join(root, "extensions"))
			.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
			.sort()
			.map((entry) => `extensions/${entry}`);
	} catch {
		fail("ACTIVATION_MANIFEST_INVALID", "release extensions/ is unreadable");
	}
	const unlisted = (shipped as string[]).filter((file) => !inListed.has(file) && !inNotLoaded.has(file));
	const overlap = (shipped as string[]).filter((file) => inListed.has(file) && inNotLoaded.has(file));
	if (unlisted.length > 0 || overlap.length > 0) {
		fail("ACTIVATION_MANIFEST_INVALID", `extension coverage broken: unlisted=[${unlisted.join(",")}] overlap=[${overlap.join(",")}]`);
	}
	for (const file of listed as string[]) {
		try {
			if (!lstatSync(join(root, file)).isFile()) fail("ACTIVATION_MANIFEST_INVALID", `listed extension missing: ${file}`);
		} catch {
			fail("ACTIVATION_MANIFEST_INVALID", `listed extension unreadable: ${file}`);
		}
	}
	return (listed as string[]).map((file) => ({
		id: `extension:${file}`,
		file,
		apply: "omp-kit apply plugin --store <release> --profiles all --include-default --apply",
	}));
}

function rootVersion(root: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch { /* fall through */ }
	fail("ACTIVATION_MANIFEST_INVALID", "release package.json version is unreadable");
}


/**
 * Is plugin extension `file` loadable for one profile? ON iff the link
 * resolves to the release under diagnosis, the file ships there, and its
 * relative imports resolve there (what OMP would load at session start).
 */
function profilePluginExtensionStatus(rootVersion: string, link: PluginLink, file: string): { on: boolean; detail: string } {
	if (link.target === null) return { on: false, detail: `profile ${link.profile}: plugin link is missing or broken` };
	if (link.version !== rootVersion) {
		return { on: false, detail: `profile ${link.profile}: links release ${link.version ?? "unknown"}, expected ${rootVersion} (STALE)` };
	}
	let source: string;
	try {
		source = readFileSync(join(link.target, file), "utf8");
	} catch {
		return { on: false, detail: `profile ${link.profile}: extension absent in the linked release` };
	}
	const specs = extractImportSpecifiers(source)
		.map((spec) => spec.specifier)
		.filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"));
	const missing: string[] = [];
	for (const specifier of specs) {
		const base = join(link.target, file.slice(0, file.lastIndexOf("/")), specifier);
		const candidates = [specifier.endsWith(".ts") || specifier.endsWith(".js") ? base : `${base}.ts`, `${base}.js`, base];
		let found = false;
		for (const candidate of candidates) {
			try {
				if (lstatSync(candidate).isFile()) {
					found = true;
					break;
				}
			} catch { /* try next */ }
		}
		if (!found) missing.push(specifier);
	}
	return missing.length > 0
		? { on: false, detail: `profile ${link.profile}: unresolvable relative imports: ${missing.join(", ")}` }
		: { on: true, detail: `profile ${link.profile}: ships and ${specs.length} relative import(s) resolve` };
}

export function liveActivationDeps(root: string, home: string): ActivationDeps {
	return {
		services: (probeHome: string) =>
			inventoryServices({ home: probeHome }, defaultInventoryDeps(probeHome, process.env.PATH ?? "/usr/bin:/bin")).rows,
		hookRows: () => censusHookFreshness(liveHookFreshnessIo(home, root)),
		pluginLinks: () => livePluginReleaseIo(home).links().map((link) => ({ profile: link.profile, target: link.target, version: link.version })),
		readOptOuts: () => readOptOutFile(home),
	};
}

export function inspectActivation(root: string, home: string, deps: ActivationDeps): ActivationReport {
	const items: ActivationItem[] = [];
	let manifest_issue: string | null = null;
	const optoutRead = deps.readOptOuts();
	const optouts_issue = optoutRead.issue;
	const optouts = new Map(optoutRead.optouts.map((entry) => [entry.item, entry]));

	const decide = (item: string, kind: ActivationKind, apply: string, readback: string, on: boolean, detail: string): void => {
		if (on) {
			items.push({ item, kind, apply, readback, status: "ON", detail });
			return;
		}
		const opt = optouts_issue === null ? optouts.get(item) : undefined;
		if (opt) {
			items.push({ item, kind, apply, readback, status: "OFF_WITH_REASON", detail, opt_out: { reason: opt.reason, by: opt.by, at: opt.at } });
		} else {
			items.push({ item, kind, apply, readback, status: "OFF_NO_REASON", detail: optouts_issue ? `${detail}; opt-out record unreadable` : detail });
		}
	};

	try {
		const links = deps.pluginLinks();
		const baseline = rootVersion(root);
		const pluginRules = pluginRuleEntries(root);
		const manifestSha = new Map(pluginRules.map((entry) => [entry.name, entry.desiredSha256 ?? ""]));
		for (const entry of pluginRules) {
			const probes = links.map((link) => profilePluginRuleStatus(home, link.profile, entry.name, {
				version: baseline,
				sha256: (name) => manifestSha.get(name) ?? null,
			}));
			const bad = probes.filter((probe) => probe.status !== "ON");
			const detail = bad.length === 0
				? `${links.length}/${links.length} linked profiles load manifest bytes`
				: bad.map((probe) => `${probe.profile}: ${probe.status} (${probe.reason})`).join("; ");
			decide(entry.id, "rule", entry.apply.replace("<release>", root), "omp-kit doctor --scope rules --json",
				bad.length === 0, detail);
		}
		for (const entry of fleetRuleEntries(root, home)) {
			const on = entry.action === "unchanged" || entry.action === "unowned-identical";
			const want = entry.desiredSha256 === null ? "absent" : entry.desiredSha256.slice(0, 12);
			decide(entry.id, "rule", entry.apply, "omp-kit doctor --scope rules --json",
				on, on ? `installed bytes match the fleet manifest (${want})` : `plan action ${entry.action}: installed is ${entry.action === "install" ? "absent" : "not matching the fleet manifest"}`);
		}
		for (const entry of extensionEntries(root)) {
			const probes = links.map((link) => profilePluginExtensionStatus(baseline, link, entry.file));
			const bad = probes.filter((probe) => !probe.on);
			const detail = bad.length === 0
				? `${links.length}/${links.length} linked profiles load a resolvable copy`
				: bad.map((probe) => probe.detail).join("; ");
			decide(entry.id, "extension", entry.apply.replace("<release>", root), "omp-kit doctor --scope extensions --json",
				bad.length === 0, detail);
		}
		const rows = deps.services(home);
		const byLabel = new Map(rows.map((row) => [row.label, row]));
		for (const [name, job] of Object.entries(KNOWN_JOBS)) {
			const row = byLabel.get(job.label);
			const on = !!row && row.loaded === "yes";
			decide(`service:${name}`, "service", `omp-kit service install ${name} --apply --yes`, "omp-kit doctor --scope services --json",
				on, row ? `launchd loaded=${String(row.loaded)} class=${row.class}` : "no launchd inventory row: job is not loaded");
		}
		const versionNote = `release baseline ${baseline}`;
		for (const row of deps.hookRows()) {
			if (row.members.length === 0) {
				decide(`hook:${row.repo}::*`, "hook",
					`sh <release>/scripts/install-commit-msg-bead.sh ${row.repo}`, "omp-kit doctor --scope hooks --json",
					false, `hook members unreadable for this repo (state=${row.state})`);
				continue;
			}
			for (const member of row.members) {
				const on = member.status === "FRESH";
				decide(`hook:${row.repo}::${member.member}`, "hook",
					`sh <release>/scripts/install-commit-msg-bead.sh ${row.repo}`, "omp-kit doctor --scope hooks --json",
					on, on ? "installed bytes match the release" : `member ${member.status} (${versionNote})`);
			}
		}
		for (const link of deps.pluginLinks()) {
			const on = link.target !== null && link.version === baseline;
			decide(`profile-link:${link.profile}`, "profile-link",
				`omp-kit apply plugin --store ${root} --profiles all --include-default --apply`, "omp-kit doctor --scope plugin_release --json",
				on, link.target === null ? "plugin link is missing or broken" : `linked version ${link.version ?? "unknown"} vs ${versionNote}`);
		}
	} catch (error) {
		manifest_issue = error instanceof Error ? error.message : String(error);
	}

	const on = items.filter((entry) => entry.status === "ON").length;
	const off_with_reason = items.filter((entry) => entry.status === "OFF_WITH_REASON").length;
	const off_no_reason = items.filter((entry) => entry.status === "OFF_NO_REASON").length;
	const overall = manifest_issue !== null || optouts_issue !== null || off_no_reason > 0 ? "FAIL" : "PASS";
	return { scope: "activation", overall, items, on, off_with_reason, off_no_reason, manifest_issue, optouts_issue };
}
/**
 * update --apply manifest loop (ACTIVEDEFAULT1, ompkit-fp72.135.3.77 AC4).
 * Applies the whole activation manifest after install using the existing
 * planners and appliers: both rule packs, extensions, fleet hooks and
 * services. Items with a recorded opt-out are never force-applied: a pack,
 * repo or job whose planned changes would touch an opted-out item is skipped
 * with the items named. Never throws; failures are recorded.
 */
export interface ManifestApplySkip { item: string; reason: string; }
export interface ManifestApplyFailure { item: string; detail: string; }
export interface ManifestApplyResult {
	ok: boolean;
	rulesApplied: number;
	extensionsApplied: number;
	hooksRefreshed: number;
	hooksRepos: number;
	hooksFailed: number;
	hooksSkippedRepos: string[];
	servicesApplied: string[];
	skipped: ManifestApplySkip[];
	failed: ManifestApplyFailure[];
}
export interface ManifestApplyDeps {
	exec?: (argv: readonly string[]) => Promise<{ exit: number; stdout: string; stderr: string }>;
	hookIo?: HookRefreshIo;
}
const MANIFEST_TOUCH_ACTIONS: Record<string, true> = { collision: true, install: true, retire: true, update: true };
async function manifestExec(argv: readonly string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
	const ran = await run(argv, { deadline_s: 120 });
	return { exit: ran.rc ?? 1, stdout: Buffer.from(ran.stdout).toString("utf8"), stderr: Buffer.from(ran.stderr).toString("utf8") };
}
function manifestErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
export async function applyActivationManifest(input: { root: string; home: string; stateRoot: string; binary: string } & ManifestApplyDeps): Promise<ManifestApplyResult> {
	const { root, home, stateRoot, binary } = input;
	const exec = input.exec ?? manifestExec;
	const skipped: ManifestApplySkip[] = [];
	const failed: ManifestApplyFailure[] = [];
	let rulesApplied = 0, extensionsApplied = 0, hooksRefreshed = 0, hooksRepos = 0, hooksFailed = 0;
	const hooksSkippedRepos: string[] = [];
	const servicesApplied: string[] = [];
	const done = (ok: boolean): ManifestApplyResult => ({ ok, rulesApplied, extensionsApplied, hooksRefreshed, hooksRepos, hooksFailed, hooksSkippedRepos, servicesApplied, skipped, failed });
	const optoutRead = readOptOutFile(home);
	if (optoutRead.issue !== null) {
		failed.push({ item: "opt-outs", detail: optoutRead.issue });
		return done(false);
	}
	const optedOut = new Set(optoutRead.optouts.map((entry) => entry.item));
	for (const fleet of [false, true]) {
		const packId = fleet ? "rules-fleet" : "rules";
		try {
			const plan = planRules({ root, home, stateRoot, fleet });
			const touch = plan.entries.filter((entry) =>
				optedOut.has(`rule:${packId}/${entry.name}`) && MANIFEST_TOUCH_ACTIONS[entry.action] === true);
			if (touch.length > 0) {
				skipped.push({ item: `rules:${packId}`, reason: `opted-out items would change: ${touch.map((entry) => `${entry.name}(${entry.action})`).join(", ")}` });
				continue;
			}
			rulesApplied += applyRulePlan(plan, { confirmed: true }).files;
		} catch (error) {
			failed.push({ item: `rules:${packId}`, detail: manifestErrorText(error) });
		}
	}
	try {
		const plan = planExtensions({ root, home, stateRoot, project: process.cwd(), profiles: "all", includeDefault: true });
		const destination = join(home, ".omp", "omp-extensions");
		const manifestId = (stepPath: string): string => `extension:extensions/${relative(destination, stepPath)}`;
		const touch = plan.steps.filter((step) =>
			step.kind === "extension" && step.beforeSha256 !== step.afterSha256 &&
			optedOut.has(manifestId(step.path)));
		if (touch.length > 0) {
			skipped.push({ item: "extensions", reason: `opted-out extensions would change: ${touch.map((step) => manifestId(step.path)).join(", ")}` });
		} else {
			extensionsApplied += applyExtensions(plan).files;
		}
	} catch (error) {
		failed.push({ item: "extensions", detail: manifestErrorText(error) });
	}
	try {
		const hookOptOuts = [...optedOut].filter((item) => item.startsWith("hook:"));
		if (hookOptOuts.length === 0) {
			const report = await refreshFleetHooks(input.hookIo ?? liveHookRefreshIo(home, root));
			hooksRefreshed = report.refreshed; hooksRepos = report.repos; hooksFailed = report.failed;
			if (report.failed > 0) failed.push({ item: "hooks", detail: `${report.failed} repo(s) failed` });
		} else {
			const io = input.hookIo ?? liveHookRefreshIo(home, root);
			const census = censusHookFreshness(io);
			const censusRepos = new Set(census.map((row) => resolve(row.repo)));
			const staleRepos = new Set<string>();
			for (const row of census) {
				for (const member of row.members) {
					const id = `hook:${row.repo}::${member.member}`;
					if (optedOut.has(id) && member.status !== "FRESH") {
						staleRepos.add(resolve(row.repo));
						skipped.push({ item: id, reason: `opted out and ${member.status}; repo skipped` });
					}
				}
			}
			const filtered: HookRefreshIo = { ...io,
				pullRepos: () => io.pullRepos().filter((entry) => {
					const resolved = resolve(entry.repo);
					if (staleRepos.has(resolved)) return false;
					if (!censusRepos.has(resolved)) {
						hooksSkippedRepos.push(resolved);
						skipped.push({ item: `hook:${entry.repo}::*`, reason: "repo not in freshness census; skipped" });
						return false;
					}
					return true;
				}) };
			const report = await refreshFleetHooks(filtered);
			hooksRefreshed = report.refreshed; hooksRepos = report.repos; hooksFailed = report.failed;
			if (report.failed > 0) failed.push({ item: "hooks", detail: `${report.failed} repo(s) failed` });
		}
	} catch (error) {
		failed.push({ item: "hooks", detail: manifestErrorText(error) });
	}
	for (const name of Object.keys(KNOWN_JOBS)) {
		const item = `service:${name}`;
		if (optedOut.has(item)) {
			skipped.push({ item, reason: "opted out" });
			continue;
		}
		try {
			const ran = await exec([binary, "service", "install", name, "--apply", "--yes", "--json"]);
			let code = -1, detail = "";
			try {
				const parsed = JSON.parse(ran.stdout) as { code?: unknown; errors?: unknown };
				if (typeof parsed.code === "number") code = parsed.code;
				const firstError = Array.isArray(parsed.errors) ? parsed.errors[0] as { code?: unknown; message?: unknown } | undefined : undefined;
				if (firstError && (typeof firstError.code === "string" || typeof firstError.message === "string")) {
					detail = `${String(firstError.code ?? "ERROR")}: ${String(firstError.message ?? "")}`.trim();
				}
			} catch { detail = (ran.stdout + ran.stderr).slice(-300).trim(); }
			if (ran.exit !== 0 || code !== 0) {
				failed.push({ item, detail: detail || `exit ${ran.exit}: ${(ran.stdout + ran.stderr).slice(-300).trim()}` });
			} else {
				servicesApplied.push(name);
			}
		} catch (error) {
			failed.push({ item, detail: manifestErrorText(error) });
		}
	}
	return done(failed.length === 0);
}
/**
 * Assemble the update --apply result after install: a failed plugin relink
 * reports FINDINGS (never UPDATED) and skips the manifest loop; a failed
 * manifest application reports FINDINGS; a clean loop reports UPDATED.
 */
export function updatePostApplyEnvelope(
	envelope: { code: number; data: Record<string, unknown>; errors?: readonly { code: string; message: string; remediation: string }[] },
	link: { ok: boolean; receiptId?: string; undoCommand?: string; detail: string },
	manifest: ManifestApplyResult | null,
	store: string | null,
): { code: 0 | 1; data: Record<string, unknown>; errors?: { code: string; message: string; remediation: string }[]; verification: "UNVERIFIED" } {
	const plugin = {
		plugin_relink: link.ok ? "APPLIED" as const : "FAILED" as const,
		plugin_receipt_id: link.receiptId ?? null,
		plugin_undo_command: link.undoCommand ?? null,
		plugin_relink_detail: link.detail,
	};
	if (!link.ok) {
		return { code: 1,
			data: { ...envelope.data, overall: "FINDINGS", manifest: null, ...plugin },
			errors: [...(envelope.errors ?? []), {
				code: "PLUGIN_RELINK_FAILED",
				message: `Kit update succeeded, but plugin relinking did not complete: ${link.detail}`,
				remediation: link.undoCommand
					? `Undo partial profile changes with \`${link.undoCommand}\`, inspect the plugin receipt, then retry relinking.`
					: `Inspect omp-kit apply plugin --plan --store ${store ?? "<release-root>"} --profiles all --include-default before retrying.`,
			}],
			verification: "UNVERIFIED" };
	}
	const section = manifest === null ? null : {
		status: manifest.ok ? "APPLIED" as const : "FINDINGS" as const,
		rules_applied: manifest.rulesApplied,
		extensions_applied: manifest.extensionsApplied,
		hooks_refreshed: manifest.hooksRefreshed,
		hooks_repos: manifest.hooksRepos,
		hooks_failed: manifest.hooksFailed,
		hooks_skipped_repos: manifest.hooksSkippedRepos,
		services_applied: manifest.servicesApplied,
		skipped: manifest.skipped,
		failed: manifest.failed,
	};
	if (manifest === null || !manifest.ok) {
		return { code: 1,
			data: { ...envelope.data, overall: "FINDINGS", ...plugin, manifest: section },
			errors: [...(envelope.errors ?? []), ...(manifest?.failed ?? []).map((entry) => ({
				code: "MANIFEST_APPLY_FAILED",
				message: `${entry.item}: ${entry.detail}`,
				remediation: "Inspect the manifest section; fix the cause or record an opt-out, then retry the update.",
			}))],
			verification: "UNVERIFIED" };
	}
	return { code: 0, data: { ...envelope.data, overall: "UPDATED", ...plugin, manifest: section }, verification: "UNVERIFIED" };
}
