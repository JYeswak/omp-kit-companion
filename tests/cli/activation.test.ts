// activation.test.ts — ACTIVEDEFAULT1 (bead ompkit-fp72.135.3.77): the activation
// manifest and doctor scope, proven against owned fixture HOME dirs, never the
// real ~. Plugin rules are read through the shared profilePluginRuleStatus
// probe (owned by src/diagnostics.ts) against a real .omp link farm in the
// fixture home. Only the rules-fleet/ pack runs the real planRules helper
// against a fixture home. Services, hooks and opt-outs are injected fakes;
// the enumerated link list is faked to mirror the farm.
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { inspectActivation, recordOptOut, readOptOutFile, type ActivationDeps, type OptOut } from "../../src/activation.ts";
import type { HookRepoRow } from "../../src/hook-refresh.ts";
import { KNOWN_JOBS } from "../../src/service.ts";
import type { ServiceRow } from "../../src/services.ts";
import type { PluginLink } from "../../src/plugin-release.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const scratch = join(import.meta.dir, "../../var/agent-tmp");

type F = { root: string; home: string; oldRoot: string | null };

function writeRelease(root: string, opts?: { version?: string; brokenExtension?: boolean; alphaBytes?: string; skipPkg?: boolean }): void {
	const version = opts?.version ?? "9.9.9";
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "rules-fleet"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(join(root, "extensions"), { recursive: true });
	const alpha = opts?.alphaBytes ?? "kit original\n";
	const fleet = "fleet protocol\n";
	writeFileSync(join(root, "rules", "alpha.md"), alpha);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nalpha\t${createHash("sha256").update(alpha).digest("hex")}\treminder\tabcdef0\n`);
	writeFileSync(join(root, "rules-fleet", "fleet.md"), fleet);
	writeFileSync(join(root, "MANIFEST.fleet.tsv"), `name\tsha256\tclass\tpack\nfleet\t${createHash("sha256").update(fleet).digest("hex")}\treminder\tabcdef0\n`);
	writeFileSync(join(root, "extensions", "good.ts"), "export const good = 1;\n");
	writeFileSync(join(root, "extensions", "needs-lib.ts"), 'import { lib } from "./lib";\nexport const x = lib;\n');
	writeFileSync(join(root, "extensions", "lib.ts"), "export const lib = 2;\n");
	if (opts?.brokenExtension) writeFileSync(join(root, "extensions", "broken.ts"), 'import { nope } from "./missing-lib";\nexport const y = nope;\n');
	if (!opts?.skipPkg) writeFileSync(join(root, "package.json"), JSON.stringify({
		version,
		omp: {
			extensions: ["extensions/good.ts", "extensions/needs-lib.ts", "extensions/lib.ts", ...(opts?.brokenExtension ? ["extensions/broken.ts"] : [])],
			notLoadedExtensions: {},
		},
	}, null, 2));
}

function installRule(home: string, name: string, bytes: string): void {
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", `${name}.md`), bytes);
}

/** Recreate the profile plugin link the shared probe resolves: default scope lives under home/.omp. */
function linkFarm(home: string, target: string): void {
	const dir = join(home, ".omp", "plugins", "node_modules");
	mkdirSync(dir, { recursive: true });
	symlinkSync(target, join(dir, "omp-kit-companion"));
}

function farmLink(home: string, target: string | null, version: string | null): PluginLink[] {
	return [{
		profile: "default",
		path: join(home, ".omp", "plugins", "node_modules", "omp-kit-companion"),
		target,
		version,
		linkedAtMs: 1_700_000_000_000,
	}];
}

function serviceRows(loaded: Record<string, boolean>): ServiceRow[] {
	return Object.entries(KNOWN_JOBS).map(([name, job]) => ({
		label: job.label,
		class: loaded[name] === false ? "NOT_LOADED" : "IDLE_OK",
		domain: "user",
		loaded: loaded[name] === false ? "no" : "yes",
		query_ok: true,
		query_error: null,
		pid: null,
		last_exit: 0,
		trigger: "interval",
		program: "/bin/true",
		args: "",
		program_ok: "ok",
		loaded_plist: loaded[name] === false ? null : `/fixture/Library/LaunchAgents/${job.label}.plist`,
		tags: [],
		omp_related: true,
		verified: true,
	}) as ServiceRow);
}

function freshHookRows(): HookRepoRow[] {
	return [{
		repo: "/fixture/repo-a",
		source: "test",
		hooks_dir: "/fixture/repo-a/.hooks",
		hooks_path_config: null,
		tracked: false,
		members: [{ member: "hooks.d/pre-commit/45-x", installed_sha256: "a", source_sha256: "a", status: "FRESH" }],
		stale: [],
		state: "FRESH",
	}];
}

function deps(f: F, overrides?: Partial<ActivationDeps>): ActivationDeps {
	return {
		services: () => serviceRows({}),
		hookRows: freshHookRows,
		pluginLinks: () => farmLink(f.home, f.root, "9.9.9"),
		readOptOuts: () => ({ optouts: [] as OptOut[], issue: null }),
		...overrides,
	};
}

function fixture(run: (f: F) => void, opts?: { brokenExtension?: boolean; staleLink?: boolean; noLink?: boolean; noPkg?: boolean }): void {
	const owned = ownedTmp("activation", { root: scratch });
	const root = join(owned.path, "release");
	const home = join(owned.path, "home");
	mkdirSync(home, { recursive: true });
	writeRelease(root, opts);
	let oldRoot: string | null = null;
	if (opts?.staleLink) {
		oldRoot = join(owned.path, "old");
		writeRelease(oldRoot, { version: "9.9.8", alphaBytes: "stale rule bytes\n" });
		linkFarm(home, oldRoot);
	} else if (opts?.noPkg) {
		oldRoot = join(owned.path, "nopkg");
		writeRelease(oldRoot, { skipPkg: true });
		linkFarm(home, oldRoot);
	} else if (!opts?.noLink) {
		linkFarm(home, root);
	}
	try {
		run({ root, home, oldRoot });
	} finally {
		owned.cleanup();
	}
}

test("control: every safeguard on gives PASS with the full manifest", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const report = inspectActivation(f.root, f.home, deps(f));
	expect(report.overall).toBe("PASS");
	expect(report.manifest_issue).toBeNull();
	expect(report.off_no_reason).toBe(0);
	const ids = new Set(report.items.map(entry => entry.item));
	expect(ids.has("rule:rules/alpha")).toBe(true);
	expect(ids.has("rule:rules-fleet/fleet")).toBe(true);
	expect(ids.has("extension:extensions/good.ts")).toBe(true);
	expect(ids.has("extension:extensions/needs-lib.ts")).toBe(true);
	expect(ids.has("service:omp-watch")).toBe(true);
	expect(report.items.length).toBeGreaterThan(Object.keys(KNOWN_JOBS).length);
	expect(ids.has("hook:/fixture/repo-a::hooks.d/pre-commit/45-x")).toBe(true);
	expect(ids.has("profile-link:default")).toBe(true);
	const rule = report.items.find(entry => entry.item === "rule:rules/alpha");
	expect(rule?.status).toBe("ON");
	expect(rule?.detail).toMatch(/1\/1 linked profiles load manifest bytes/);
	for (const entry of report.items) {
		expect(entry.status).toBe("ON");
		expect(entry.apply.length).toBeGreaterThan(0);
		expect(entry.readback.startsWith("omp-kit doctor --scope ")).toBe(true);
	}
}));

test("planted: a profile on an older release reports its plugin rules STALE/OFF", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const report = inspectActivation(f.root, f.home, deps(f, {
		pluginLinks: () => farmLink(f.home, f.oldRoot, "9.9.8"),
	}));
	const rule = report.items.find(entry => entry.item === "rule:rules/alpha");
	expect(rule?.status).toBe("OFF_NO_REASON");
	expect(rule?.detail).toMatch(/STALE/);
	expect(report.overall).toBe("FAIL");
	expect(report.off_no_reason).toBeGreaterThanOrEqual(1);
}, { staleLink: true }));

test("planted: a linked release with no readable version reads UNVERIFIED/OFF", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const report = inspectActivation(f.root, f.home, deps(f, {
		pluginLinks: () => farmLink(f.home, f.oldRoot, null),
	}));
	const rule = report.items.find(entry => entry.item === "rule:rules/alpha");
	expect(rule?.status).toBe("OFF_NO_REASON");
	expect(rule?.detail).toMatch(/UNVERIFIED/);
	expect(report.overall).toBe("FAIL");
}, { noPkg: true }));

test("planted: a rules-fleet rule removed with no opt-out is OFF-NO-REASON and FAIL", () => fixture(f => {
	const report = inspectActivation(f.root, f.home, deps(f));
	const fleet = report.items.find(entry => entry.item === "rule:rules-fleet/fleet");
	expect(fleet?.status).toBe("OFF_NO_REASON");
	expect(report.overall).toBe("FAIL");
	expect(report.off_no_reason).toBeGreaterThanOrEqual(1);
}));

test("control: the same removal with an opt-out reason is OFF-WITH-REASON and PASS", () => fixture(f => {
	const record = recordOptOut(f.home, "rule:rules-fleet/fleet", "fleet pool not enrolled yet", { by: "test", at: "2026-10-27T00:00:00.000Z" });
	expect(record).toEqual({ item: "rule:rules-fleet/fleet", reason: "fleet pool not enrolled yet", by: "test", at: "2026-10-27T00:00:00.000Z" });
	const fromDisk = inspectActivation(f.root, f.home, deps(f, { readOptOuts: () => ({ optouts: [record], issue: null }) }));
	const fleet = fromDisk.items.find(entry => entry.item === "rule:rules-fleet/fleet");
	expect(fleet?.status).toBe("OFF_WITH_REASON");
	expect(fleet?.opt_out?.reason).toBe("fleet pool not enrolled yet");
	expect(fromDisk.overall).toBe("PASS");
	expect(fromDisk.off_no_reason).toBe(0);
}));

test("planted: an opt-out with an empty reason is refused", () => fixture(f => {
	expect(() => recordOptOut(f.home, "rule:rules-fleet/fleet", "")).toThrow(/OPT_OUT_REASON_REQUIRED/);
	expect(() => recordOptOut(f.home, "rule:rules-fleet/fleet", "   ")).toThrow(/OPT_OUT_REASON_REQUIRED/);
}));

test("planted: an unloaded service is OFF-NO-REASON and FAIL", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const report = inspectActivation(f.root, f.home, deps(f, { services: () => serviceRows({ "omp-watch": false }) }));
	const job = report.items.find(entry => entry.item === "service:omp-watch");
	expect(job?.status).toBe("OFF_NO_REASON");
	expect(report.overall).toBe("FAIL");
}));

test("control: the unloaded service with an opt-out reason is OFF-WITH-REASON and PASS", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const record = recordOptOut(f.home, "service:omp-watch", "no watch needed on this host", { by: "test", at: "2026-10-27T00:00:00.000Z" });
	const report = inspectActivation(f.root, f.home, deps(f, {
		services: () => serviceRows({ "omp-watch": false }),
		readOptOuts: () => ({ optouts: [record], issue: null }),
	}));
	expect(report.items.find(entry => entry.item === "service:omp-watch")?.status).toBe("OFF_WITH_REASON");
	expect(report.overall).toBe("PASS");
}));

test("planted: a stale hook member is OFF-NO-REASON", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const rows = freshHookRows();
	rows[0]!.members[0]!.status = "STALE";
	const report = inspectActivation(f.root, f.home, deps(f, { hookRows: () => rows }));
	expect(report.items.find(entry => entry.item === "hook:/fixture/repo-a::hooks.d/pre-commit/45-x")?.status).toBe("OFF_NO_REASON");
	expect(report.overall).toBe("FAIL");
}));

test("planted: an extension with an unresolvable import is OFF-NO-REASON", () => {
	fixture(f => {
		installRule(f.home, "fleet", "fleet protocol\n");
		const report = inspectActivation(f.root, f.home, deps(f));
		expect(report.items.find(entry => entry.item === "extension:extensions/broken.ts")?.status).toBe("OFF_NO_REASON");
		expect(report.overall).toBe("FAIL");
	}, { brokenExtension: true });
});

test("planted: an absent plugin link is OFF-NO-REASON", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	const report = inspectActivation(f.root, f.home, deps(f, {
		pluginLinks: () => farmLink(f.home, null, null),
	}));
	expect(report.items.find(entry => entry.item === "profile-link:default")?.status).toBe("OFF_NO_REASON");
	expect(report.items.find(entry => entry.item === "rule:rules/alpha")?.status).toBe("OFF_NO_REASON");
	expect(report.overall).toBe("FAIL");
}, { noLink: true }));

test("planted: a corrupt opt-out record fails closed", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	mkdirSync(join(f.home, ".config", "omp-kit"), { recursive: true });
	writeFileSync(join(f.home, ".config", "omp-kit", "activation-optouts.json"), "{nope");
	const read = readOptOutFile(f.home);
	expect(read.optouts).toEqual([]);
	expect(read.issue).toMatch(/not JSON/);
	const report = inspectActivation(f.root, f.home, deps(f, { readOptOuts: () => read }));
	expect(report.optouts_issue).toMatch(/not JSON/);
	expect(report.overall).toBe("FAIL");
}));

test("planted: an unlisted extension file breaks the manifest", () => fixture(f => {
	installRule(f.home, "fleet", "fleet protocol\n");
	writeFileSync(join(f.root, "extensions", "stowaway.ts"), "export const s = 1;\n");
	const report = inspectActivation(f.root, f.home, deps(f));
	expect(report.manifest_issue).toMatch(/unlisted/);
	expect(report.overall).toBe("FAIL");
}));
