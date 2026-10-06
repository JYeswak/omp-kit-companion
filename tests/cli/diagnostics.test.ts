import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diagnose, health, inspectDicklesworthstone, inspectEffectiveRules, inspectPaneIdentity, inspectRegexTools, type Finding } from "../../src/diagnostics.ts";
import { ompFingerprint, recordTestReceipt } from "../../src/omp-watch.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

const fixtures: string[] = [];
interface Fixture { base: string; root: string; home: string; project: string; bytes: string; ompPath: string }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

function fixture(): Fixture {
	const base = mkdtempSync(join(tmpdir(), "omp-kit-diagnostics-"));
	fixtures.push(base);
	const root = join(base, "release");
	const home = join(base, "home");
	const project = join(base, "project");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(home);
	mkdirSync(project);
	const bytes = "# Rule A\n";
	writeFileSync(join(root, "rules", "rule-a.md"), bytes);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nrule-a\t${hash(bytes)}\ttripwire\tabc1234\n`);
	return { base, root, home, project, bytes, ompPath: join(base, "omp", "bin", "omp") };
}
function installOmp(f: Fixture, version: string | null = "18.4.0") {
	const pkg = join(f.base, "omp", "releases", "v1");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	mkdirSync(join(pkg, "src", "export"), { recursive: true });
	mkdirSync(join(pkg, "src", "capability"), { recursive: true });
	mkdirSync(join(pkg, "src", "discovery"), { recursive: true });
	mkdirSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	mkdirSync(join(f.base, "omp", "bin"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", ...(version ? { version } : {}) }));
	writeFileSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) writeFileSync(join(pkg, "src", file), "export {};\n");
	writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 91\n");
	chmodSync(join(pkg, "dist", "cli.js"), 0o755);
	symlinkSync(join(pkg, "dist", "cli.js"), f.ompPath);
}
function tree(dir: string, prefix = ""): string[] {
	return readdirSync(dir).sort().flatMap((name) => {
		const file = join(dir, name);
		const stat = lstatSync(file);
		const relative = join(prefix, name);
		if (stat.isSymbolicLink()) return [`${relative}:link:${readFileSync(file).toString("hex")}`];
		if (stat.isDirectory()) return [`${relative}:dir:${stat.mode & 0o777}`, ...tree(file, relative)];
		return [`${relative}:file:${stat.mode & 0o777}:${readFileSync(file).toString("hex")}`];
	});
}
function finding(rows: readonly Finding[], component: string): Finding {
	const result = rows.find((row) => row.component === component);
	if (!result) throw new Error(`missing ${component}`);
	return result;
}

test("fresh release verifies shipped bytes but does not claim unapplied rules or effective profile", async () => {
	const f = fixture(); installOmp(f);
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "kit").status).toBe("OK");
	expect(finding(rows, "manifest").status).toBe("OK");
	expect(finding(rows, "omp").evidence?.version).toBe("18.4.0");
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	expect(finding(rows, "installed_rules").recommended_action).toContain("omp-kit apply rules --plan");
	expect(finding(rows, "effective_profile").status).toBe("UNVERIFIED");
	expect(finding(rows, "matcher").status).toBe("NOT_RUN");
	expect(finding(rows, "retired_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "unknown_rules").status).toBe("UNVERIFIED");
	expect(health(rows)).toBe("UNVERIFIED");
});

test("effective profile probes do not replace installed-byte diagnostics", async () => {
	const f = fixture(); installOmp(f);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	const effective = finding(rows, "effective_rules");
	expect(effective.status).toBe("DEGRADED");
	expect((effective.evidence?.profiles as Array<{ status: string }>)[0]?.status).toBe("UNVERIFIED");
	expect(finding(rows, "installed_rules").evidence?.missing).toEqual(["rule-a"]);
});

test("without a native profile probe, installed-byte diagnostics remain available", async () => {
	const f = fixture();
	const rows = await diagnose({ root: f.root, home: f.home });
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	expect(finding(rows, "installed_rules").evidence?.missing).toEqual(["rule-a"]);
	expect(rows.some((row) => row.component === "effective_rules")).toBe(false);
});

test("an absent installed directory cannot prove absence of retired or unknown Markdown", async () => {
	const f = fixture(); installOmp(f);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "installed_rules").evidence?.missing).toEqual(["rule-a"]);
	expect(finding(rows, "retired_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "unknown_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "retired_rules").reason).toContain("not inspected");
	expect(finding(rows, "unknown_rules").recommended_action).toContain("rules");
});

test("unknown profile takes precedence over optional deterioration without concealing either finding", () => {
	const rows: Finding[] = [
		{ component: "profile", status: "UNVERIFIED", reason: "Profile not inspected", recommended_action: "Inspect with consent." },
		{ component: "rules", status: "DEGRADED", reason: "Rule missing", recommended_action: "Review apply plan." },
	];
	expect(health(rows)).toBe("UNVERIFIED");
	expect(rows[0]?.status).toBe("UNVERIFIED");
	expect(health([...rows, { component: "manifest", status: "FAIL", reason: "Bad source", recommended_action: "Replace release." }])).toBe("FAIL");
	expect(health([{ component: "matcher", status: "NOT_RUN", reason: "Not tested", recommended_action: "Run test." }])).toBe("UNVERIFIED");
});

test("matching installed bytes establish equality but an old record never confers ownership", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "rules", "rule-a.md"), f.bytes);
	mkdirSync(join(f.home, ".local", "state", "omp-kit"), { recursive: true });
	writeFileSync(join(f.home, ".local", "state", "omp-kit", "installed.tsv"), `name\tsha256\tpack\tinstalled_utc\nrule-a\t${hash(f.bytes)}\tabc1234\t2026-09-28T00:00:00Z\n`);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "installed_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "installed_rules").evidence?.matching).toEqual(["rule-a"]);
	expect(finding(rows, "installed_rules").evidence?.ownership).toBe("LEGACY_RECORD_ONLY");
	expect(finding(rows, "installed_rules").recommended_action).toContain("omp-kit apply rules --plan");
});

test("installed byte drift cannot inherit a legacy ownership claim", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "rules", "rule-a.md"), "user edit\n");
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	expect(finding(rows, "installed_rules").evidence?.drifted).toEqual(["rule-a"]);
	expect(finding(rows, "installed_rules").evidence?.ownership).toBe("UNVERIFIED");
	expect(finding(rows, "installed_rules").recommended_action).toContain("omp-kit apply rules --plan");
});

test.each(["rule-a\tbad\ttripwire\tabc1234", "rule-a\tHASH\ttripwire\tabc1234\nrule-a\tHASH\ttripwire\tabc1234", "../outside\tHASH\ttripwire\tabc1234", "rule-a\tHASH\tunknown\tabc1234", "rule-a\tHASH\ttripwire\t../bad"]) ("invalid manifest row rejects inventory: %s", async (row) => {
	const f = fixture(); installOmp(f);
	writeFileSync(join(f.root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\n${row.replaceAll("HASH", hash(f.bytes))}\n`);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "manifest").status).toBe("FAIL");
	expect(finding(rows, "installed_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "manifest").recommended_action).toContain("release");
	expect(health(rows)).toBe("FAIL");
});

test("documented uncommitted pack is valid source bytes but not verified release provenance", async () => {
	const f = fixture(); installOmp(f);
	writeFileSync(join(f.root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nrule-a\t${hash(f.bytes)}\ttripwire\tuncommitted-2026-09-28\n`);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "manifest").status).toBe("UNVERIFIED");
	expect(finding(rows, "manifest").evidence?.source_proof).toBe("SOURCE_UNVERIFIED");
	expect(finding(rows, "kit").status).toBe("UNVERIFIED");
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	expect(finding(rows, "manifest").recommended_action).toContain("release");
});

test("shipped rule byte mismatch invalidates source manifest even when installed copy matches declared hash", async () => {
	const f = fixture(); installOmp(f);
	writeFileSync(join(f.root, "rules", "rule-a.md"), "tampered source\n");
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "manifest").status).toBe("FAIL");
	expect(finding(rows, "installed_rules").status).toBe("UNVERIFIED");
});

test("retired and unknown Markdown remain observable without being removed", async () => {
	const f = fixture(); installOmp(f);
	writeFileSync(join(f.root, "retired", "old-rule.md"), "retired\n");
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "rules", "old-rule.md"), "user owned\n");
	writeFileSync(join(f.home, ".agents", "rules", "other.md"), "other\n");
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "retired_rules").evidence?.present).toEqual(["old-rule"]);
	expect(finding(rows, "unknown_rules").evidence?.names).toEqual(["other"]);
	expect(finding(rows, "retired_rules").recommended_action).toContain("omp-kit apply rules --plan");
	expect(finding(rows, "unknown_rules").status).toBe("DEGRADED");
});

test("symlinked shipped rule and installed target never read outside their roots", async () => {
	const f = fixture(); installOmp(f);
	const outside = join(f.base, "outside.md");
	writeFileSync(outside, f.bytes);
	rmSync(join(f.root, "rules", "rule-a.md"));
	symlinkSync(outside, join(f.root, "rules", "rule-a.md"));
	let rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "manifest").status).toBe("FAIL");
	rmSync(join(f.root, "rules", "rule-a.md"));
	writeFileSync(join(f.root, "rules", "rule-a.md"), f.bytes);
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	symlinkSync(outside, join(f.home, ".agents", "rules", "rule-a.md"));
	rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	expect(finding(rows, "installed_rules").evidence?.unsafe).toEqual(["rule-a"]);
});

test("project shadow with different bytes reports precedence risk without executing project contents", async () => {
	const f = fixture(); installOmp(f);
	const local = join(f.project, ".omp", "rules");
	mkdirSync(local, { recursive: true });
	writeFileSync(join(local, "rule-a.md"), "#!/bin/sh\nexit 72\n");
	const before = tree(f.project);
	const rows = await diagnose({ root: f.root, home: f.home, project: f.project, ompPath: f.ompPath });
	expect(tree(f.project)).toEqual(before);
	expect(finding(rows, "project_rules").status).toBe("DEGRADED");
	expect(finding(rows, "project_rules").evidence?.mismatched_shadows).toEqual(["rule-a"]);
	expect(finding(rows, "project_rules").recommended_action).toContain("project");
});

test("missing selected project is not a verified absence of shadow rules", async () => {
	const f = fixture(); installOmp(f);
	const missing = join(f.base, "missing-project");
	const rows = await diagnose({ root: f.root, home: f.home, project: missing, ompPath: f.ompPath });
	expect(finding(rows, "project_rules").status).toBe("UNVERIFIED");
	expect(finding(rows, "project_rules").reason).toContain("not inspected");
	expect(finding(rows, "project_rules").recommended_action).toContain("project");
});

test("missing OMP and unverifiable package version stay distinct from verified OMP", async () => {
	const f = fixture();
	let rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "omp").status).toBe("FAIL");
	expect(finding(rows, "omp").evidence?.availability).toBe("UNAVAILABLE");
	expect(finding(rows, "omp").recommended_action).toContain("OMP");
	installOmp(f, null);
	rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(finding(rows, "omp").status).toBe("UNVERIFIED");
	expect(finding(rows, "omp").evidence?.version).toBe(null);
});

test("recognized default and named YAML compare policy and extension bytes without asserting runtime activation", async () => {
	const f = fixture(); installOmp(f);
	const config = "ttsr:\n  enabled: true\n  repeatMode: after-gap\n  repeatGap: 0\n  contextMode: keep\n  disabledRules: []\nextensions:\n  - PATH\n";
	mkdirSync(join(f.root, "policy")); mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	writeFileSync(join(f.root, "policy", "extensions.json"), '{"extensions":["kit-guard-optin.ts"],"skipProfiles":[]}');
	writeFileSync(join(f.root, "extensions", "kit-guard-optin.ts"), "export const guard = true;\n");
	const extension = join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts");
	mkdirSync(join(f.home, ".omp", "omp-extensions"), { recursive: true });
	writeFileSync(extension, "export const guard = true;\n");
	for (const dir of [join(f.home, ".omp", "agent"), join(f.home, ".omp", "profiles", "work", "agent")]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.yml"), config.replace("PATH", extension));
	}
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "policy").status).toBe("OK");
	expect(finding(rows, "policy").evidence?.matching_profiles).toEqual(["default", "work"]);
	expect(finding(rows, "extensions").status).toBe("OK");
	expect(finding(rows, "extensions").evidence?.listed_profiles).toEqual(["default", "work"]);
	expect(finding(rows, "effective_profile").status).toBe("UNVERIFIED");
	expect(finding(rows, "effective_profile").evidence?.backup_scope).toContain(join(f.home, ".omp", "profiles", "work", "agent", "settings.json"));
});

test("opaque or malformed profile remains unverified with concrete backup and consent boundary", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	const agent = join(f.home, ".omp", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "config.yml"), "ttsr: [not a mapping]\n");
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "policy").status).toBe("UNVERIFIED");
	const effective = finding(rows, "effective_profile");
	expect(effective.evidence?.backup_scope).toEqual(expect.arrayContaining([join(agent, "config.yml"), join(agent, "settings.json")]));
	expect(effective.recommended_action).toContain("omp config list");
	expect(effective.recommended_action).not.toContain("--deep");
});

test("removed named profile is not recreated or treated as an observed config", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.home, ".omp", "profiles", "gone"), { recursive: true });
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "effective_profile").evidence?.profiles).toEqual(["default"]);
	expect(finding(rows, "policy").status).toBe("UNVERIFIED");
});

test("disabled global, project, and unknown-provider names remain disabled and distinctly conflicted", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	const agent = join(f.home, ".omp", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "config.yml"), "ttsr:\n  enabled: true\n  repeatMode: after-gap\n  repeatGap: 0\n  contextMode: keep\n  disabledRules: [rule-a, project-only, builtin-only]\n");
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(f.home, ".agents", "rules", "rule-a.md"), f.bytes);
	mkdirSync(join(f.project, ".omp", "rules"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "rules", "project-only.md"), "local\n");
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, project: f.project, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "policy").status).toBe("DEGRADED");
	expect(finding(rows, "policy").evidence?.disabled_conflicts).toEqual([
		{ profile: "default", name: "rule-a", provider: "global" },
		{ profile: "default", name: "project-only", provider: "project" },
		{ profile: "default", name: "builtin-only", provider: "unknown" },
	]);
	expect(finding(rows, "policy").recommended_action).toContain("Do not re-enable");
});

test("skipProfiles and project extensions empty override never count installed bytes as loaded", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy")); mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "policy", "extensions.json"), '{"extensions":["kit-guard-optin.ts"],"skipProfiles":["work"]}');
	writeFileSync(join(f.root, "extensions", "kit-guard-optin.ts"), "guard\n");
	const ext = join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts");
	mkdirSync(join(f.home, ".omp", "omp-extensions"), { recursive: true });
	writeFileSync(ext, "guard\n");
	const config = `extensions:\n  - ${ext}\n`;
	for (const dir of [join(f.home, ".omp", "agent"), join(f.home, ".omp", "profiles", "work", "agent")]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.yml"), config);
	}
	mkdirSync(join(f.project, ".omp"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "config.yml"), "extensions: []\n");
	const before = tree(f.home); const projectBefore = tree(f.project);
	const rows = await diagnose({ root: f.root, home: f.home, project: f.project, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(tree(f.project)).toEqual(projectBefore);
	expect(finding(rows, "extensions").status).toBe("UNVERIFIED");
	expect(finding(rows, "extensions").evidence?.skipped_profiles).toEqual(["work"]);
	expect(finding(rows, "extensions").evidence?.project_override).toBe("EMPTY_ARRAY");
	expect(finding(rows, "extensions").reason).toContain("inactive");
});

test("fresh and partial opt-in installs remain separate from rule hash findings and optional JSM", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy")); mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	writeFileSync(join(f.root, "policy", "extensions.json"), '{"extensions":["kit-guard-optin.ts"],"skipProfiles":[]}');
	writeFileSync(join(f.root, "extensions", "kit-guard-optin.ts"), "shipped\n");
	let rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath, jsmPath: join(f.base, "missing-jsm") });
	expect(finding(rows, "policy").status).toBe("UNVERIFIED");
	expect(finding(rows, "extensions").status).toBe("UNVERIFIED");
	expect(finding(rows, "extensions").evidence?.missing).toEqual(["kit-guard-optin.ts"]);
	expect(finding(rows, "router").status).toBe("DEGRADED");
	expect(finding(rows, "router").evidence?.optional).toBe(true);
	expect(finding(rows, "installed_rules").status).toBe("DEGRADED");
	const dir = join(f.home, ".omp", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), "extensions: []\n");
	rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath, jsmPath: join(f.base, "missing-jsm") });
	expect(finding(rows, "extensions").status).toBe("DEGRADED");
	expect(finding(rows, "extensions").evidence?.missing).toEqual(["kit-guard-optin.ts", "profile:default"]);
});

test("unsafe profile config symlink does not read outside HOME", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	const outside = join(f.base, "outside.yml");
	writeFileSync(outside, "ttsr:\n  enabled: true\n  repeatMode: after-gap\n  repeatGap: 0\n  contextMode: keep\n  disabledRules: []\n");
	const agent = join(f.home, ".omp", "agent");
	mkdirSync(agent, { recursive: true });
	symlinkSync(outside, join(agent, "config.yml"));
	const before = tree(f.home);
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	expect(tree(f.home)).toEqual(before);
	expect(finding(rows, "policy").status).toBe("UNVERIFIED");
	expect(finding(rows, "policy").evidence?.unverified_profiles).toEqual(["default"]);
});

test("project-level disabledRules overlay is not hidden by a matching global policy", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy"));
	writeFileSync(join(f.root, "policy", "ttsr.json"), '{"enabled":true,"repeatMode":"after-gap","repeatGap":0,"contextMode":"keep","disabledRules":[]}');
	mkdirSync(join(f.home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(f.home, ".omp", "agent", "config.yml"), "ttsr:\n  enabled: true\n  repeatMode: after-gap\n  repeatGap: 0\n  contextMode: keep\n  disabledRules: []\n");
	mkdirSync(join(f.project, ".omp", "rules"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "rules", "project-only.md"), "local\n");
	writeFileSync(join(f.project, ".omp", "config.yml"), "ttsr:\n  disabledRules: [project-only]\n");
	const rows = await diagnose({ root: f.root, home: f.home, project: f.project, ompPath: f.ompPath });
	expect(finding(rows, "policy").status).toBe("DEGRADED");
	expect(finding(rows, "policy").evidence?.matching_profiles).toEqual(["default"]);
	expect(finding(rows, "policy").evidence?.disabled_conflicts).toEqual([{ profile: "project", name: "project-only", provider: "project" }]);
});

test("omp_drift tracks the OMP of the last recorded test and clears only after a recorded re-test", async () => {
	const f = fixture(); installOmp(f, "18.4.4");
	const stateRoot = join(f.base, "state", "omp-kit");
	const drift = async () => finding(await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath, stateRoot }), "omp_drift");
	const record = (status: string) => expect(recordTestReceipt(stateRoot, { schema_version: 1, kit_version: "0.0.0-test", scope: "fast",
		status, recorded_at: "2026-10-01T00:00:00.000Z", ...ompFingerprint(resolveOmpIdentity({ PATH: dirname(f.ompPath) })) })).toBe(true);
	expect(await drift()).toMatchObject({ status: "NOT_RUN", recommended_action: expect.stringContaining("omp-kit test --record") });
	record("PASS");
	expect((await drift()).status).toBe("OK");
	// An updater rewrites the package: same launcher bytes, new version.
	const pkg = join(f.base, "omp", "releases", "v1");
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.5" }));
	const updated = await drift();
	expect(updated.status).toBe("DEGRADED");
	expect(updated.reason).toContain("18.4.4 → 18.4.5");
	expect(updated.recommended_action).toContain("omp-kit test --record");
	record("PASS");
	expect((await drift()).status).toBe("OK");
	// Same version string but different launcher bytes (a rebuilt or replaced OMP) is still a change.
	writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 92\n");
	expect((await drift()).status).toBe("DEGRADED");
	record("FAIL");
	expect(await drift()).toMatchObject({ status: "DEGRADED", reason: expect.stringContaining("did not pass (FAIL)") });
});

test("agent_mail_guard flags an unset or dangling storage root and passes a live one", async () => {
	const f = fixture(); installOmp(f);
	const saved = process.env.AGENT_MAIL_STORAGE_ROOT;
	const live = mkdtempSync(join(tmpdir(), "omp-kit-am1-"));
	try {
		delete process.env.AGENT_MAIL_STORAGE_ROOT;
		let rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
		expect(finding(rows, "agent_mail_guard").status).toBe("UNVERIFIED");
		expect(finding(rows, "agent_mail_guard").reason).toContain("fails open");
		process.env.AGENT_MAIL_STORAGE_ROOT = join(live, "missing");
		rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
		expect(finding(rows, "agent_mail_guard").status).toBe("DEGRADED");
		process.env.AGENT_MAIL_STORAGE_ROOT = live;
		rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
		expect(finding(rows, "agent_mail_guard").status).toBe("OK");
		expect(finding(rows, "agent_mail_guard").evidence?.storage_root).toBe(live);
	} finally {
		if (saved === undefined) delete process.env.AGENT_MAIL_STORAGE_ROOT; else process.env.AGENT_MAIL_STORAGE_ROOT = saved;
		rmSync(live, { recursive: true, force: true });
	}
});

test("dicklesworthstone scope reports installed vs latest with one source per tool", async () => {
	const bindir = mkdtempSync(join(tmpdir(), "omp-kit-js1-"));
	const bin = (name: string, version: string) => {
		writeFileSync(join(bindir, name), `#!/bin/sh\necho '${version}'\n`);
		chmodSync(join(bindir, name), 0o755);
	};
	bin("br", "br 0.6.0");
	bin("ntm", "ntm 1.36.1");
	bin("dsr", "dsr 0.2.1");
	bin("ms", "ms 0.1.0");
	writeFileSync(join(bindir, "gh"), "#!/bin/sh\necho '{\"data\":{\"r3\":{\"latestRelease\":{\"tagName\":\"v0.7.4\"}},\"r18\":{\"latestRelease\":{\"tagName\":\"v1.36.1\"}},\"r11\":{\"latestRelease\":{\"tagName\":\"v0.2.1\"}}}}'\n");
	chmodSync(join(bindir, "gh"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = bindir;
	try {
		const found = await inspectDicklesworthstone();
		expect(found.component).toBe("dicklesworthstone");
		expect(found.status).toBe("DEGRADED");
		const tools = found.evidence?.tools as { bin: string; source: string; installed_version: string | null; latest_release: string | null; state: string }[];
		const byBin = Object.fromEntries(tools.map((tool) => [tool.bin, tool]));
		expect(byBin.br?.state).toBe("behind");
		expect(byBin.ntm?.state).toBe("current");
		expect(byBin.dsr?.state).toBe("current");
		expect(byBin.dsr?.source).toContain("undecided");
		expect(byBin.br?.source).toBe("homebrew dicklesworthstone/tap/br");
		expect(byBin.ms?.state).toBe("unknown");
		expect(byBin.xf?.state).toBe("absent");
		expect(found.evidence?.behind).toEqual(["br"]);
	} finally {
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		rmSync(bindir, { recursive: true, force: true });
	}
});

test("dual-config and policy-skipped profiles surface as not covered with named reasons", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.root, "policy")); mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "policy", "extensions.json"), '{"extensions":["kit-guard-optin.ts"],"skipProfiles":["work"]}');
	writeFileSync(join(f.root, "extensions", "kit-guard-optin.ts"), "export const guard = true;\n");
	const extension = join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts");
	mkdirSync(join(f.home, ".omp", "omp-extensions"), { recursive: true });
	writeFileSync(extension, "export const guard = true;\n");
	const good = `extensions:\n  - ${extension}\n`;
	for (const dir of [join(f.home, ".omp", "agent"), join(f.home, ".omp", "profiles", "work", "agent")]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.yml"), good);
	}
	const dual = join(f.home, ".omp", "profiles", "claude", "agent");
	mkdirSync(dual, { recursive: true });
	writeFileSync(join(dual, "config.yml"), good);
	writeFileSync(join(dual, "settings.json"), "{}\n");
	const rows = await diagnose({ root: f.root, home: f.home, ompPath: f.ompPath });
	const notCovered = finding(rows, "extensions").evidence?.not_covered_profiles as { profile: string; reason: string }[];
	const reasons = Object.fromEntries(notCovered.map(entry => [entry.profile, entry.reason]));
	expect(reasons.work).toMatch(/policy skipProfiles/);
	expect(reasons.claude).toMatch(/^DUAL_CONFIG: config\.yml \+ settings\.json/);
	expect(finding(rows, "extensions").evidence?.skipped_profiles).toEqual(["work"]);
});

test("a same-named rule from a foreign plugin is not a kit win", () => {
	const home = "/test-home";
	const kitDir = "/test-home/.omp/plugins/node_modules/omp-kit-companion";
	const pluginEntry = { name: "omp-kit-companion", version: "0.2.5", path: kitDir };
	const base = { home, ompPath: "/bin/omp", kitVersion: "0.2.5", ompVersion: "18.6.1", rules: ["rule-a"], profiles: [{ name: "p" }] };
	const kitRow = inspectEffectiveRules({ ...base, probe: (profile, command) => command === "ttsr"
		? [{ name: "rule-a", path: `${kitDir}/rules/rule-a.md`, provider: "plugin" }]
		: { npm: [pluginEntry], marketplace: [] } });
	expect(kitRow.status).toBe("OK");
	const foreignRow = inspectEffectiveRules({ ...base, probe: (profile, command) => command === "ttsr"
		? [{ name: "rule-a", path: "/test-home/.omp/plugins/node_modules/other/rules/rule-a.md", provider: "plugin" }]
		: { npm: [pluginEntry], marketplace: [] } });
	expect(foreignRow.status).toBe("DEGRADED");
	const profiles = foreignRow.evidence !== undefined && "profiles" in foreignRow.evidence ? foreignRow.evidence.profiles : undefined;
	expect(Array.isArray(profiles)).toBe(true);
	const first = Array.isArray(profiles) ? profiles[0] : undefined;
	const kitRules = first !== null && typeof first === "object" && "kit_rules" in first ? first.kit_rules : undefined;
	expect(kitRules !== null && typeof kitRules === "object" && "plugin" in kitRules ? kitRules.plugin : undefined).toEqual([]);
	expect(kitRules !== null && typeof kitRules === "object" && "missing" in kitRules ? kitRules.missing : undefined).toEqual(["rule-a"]);
});

test("regex tools finder names the install command per missing tool", () => {
	const empty = inspectRegexTools("");
	expect(empty.status).toBe("DEGRADED");
	const missing = empty.evidence?.missing;
	expect(Array.isArray(missing) && missing.includes("grex")).toBe(true);
	expect(empty.reason).toContain("cargo install grex");
	expect(empty.reason).toContain("pip3 install --user regexploit");
});

test("planted missing grex is reported with its install command", () => {
	const dir = mkdtempSync(join(tmpdir(), "regex-tools-"));
	fixtures.push(dir);
	for (const bin of ["pomsky", "regexploit", "regexploit-js", "regexploit-py", "rgx"]) {
		const path = join(dir, bin);
		writeFileSync(path, "#!/bin/sh\n");
		chmodSync(path, 0o755);
	}
	const row = inspectRegexTools(dir);
	expect(row.status).toBe("DEGRADED");
	expect(row.evidence?.missing).toEqual(["grex"]);
	expect(row.reason).toContain("grex (cargo install grex)");
});

test("all regex tools present reports OK", () => {
	const dir = mkdtempSync(join(tmpdir(), "regex-tools-"));
	fixtures.push(dir);
	for (const bin of ["grex", "pomsky", "regexploit", "regexploit-js", "regexploit-py", "rgx"]) {
		const path = join(dir, bin);
		writeFileSync(path, "#!/bin/sh\n");
		chmodSync(path, 0o755);
	}
	expect(inspectRegexTools(dir).status).toBe("OK");
});

test("one identity on two live panes fails with both panes named", () => {
	const row = inspectPaneIdentity({
		listPanes: () => [
			{ session: "s", window: "0", index: "0", id: "%101" },
			{ session: "s", window: "0", index: "1", id: "%102" },
		],
		resolvePane: () => "SharedName",
		listAgents: () => [],
	});
	expect(row.status).toBe("FAIL");
	expect(row.reason).toContain("SharedName");
	expect(row.reason).toContain("%101");
	expect(row.reason).toContain("%102");
});

test("a live pane without an identity file degrades", () => {
	const row = inspectPaneIdentity({
		listPanes: () => [{ session: "s", window: "0", index: "1", id: "%103" }],
		resolvePane: () => null,
		listAgents: () => [],
	});
	expect(row.status).toBe("DEGRADED");
});

test("an idle registration with no live pane degrades as stale", () => {
	const now = Date.now();
	const row = inspectPaneIdentity({
		now,
		listPanes: () => [{ session: "s", window: "0", index: "0", id: "%101" }],
		resolvePane: () => "LiveAgent",
		listAgents: () => [
			{ name: "LiveAgent", lastActiveMs: now - 1000 },
			{ name: "DeadAgent", lastActiveMs: now - 8 * 24 * 3600 * 1000 },
		],
	});
	expect(row.status).toBe("DEGRADED");
	expect(row.reason).toContain("DeadAgent");
});

test("distinct identities on live panes pass, unavailable tmux is unverified", () => {
	const clean = inspectPaneIdentity({
		listPanes: () => [
			{ session: "s", window: "0", index: "0", id: "%101" },
			{ session: "s", window: "0", index: "1", id: "%102" },
		],
		resolvePane: (id) => id === "%101" ? "AgentA" : "AgentB",
		listAgents: () => [],
	});
	expect(clean.status).toBe("OK");
	expect(inspectPaneIdentity({ listPanes: () => null, resolvePane: () => null, listAgents: () => null }).status).toBe("UNVERIFIED");
});
