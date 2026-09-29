import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnose, health, type Finding } from "../../src/diagnostics.ts";

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
	expect(finding(rows, "effective_profile").recommended_action).toContain(join(agent, "config.yml"));
	expect(finding(rows, "effective_profile").recommended_action).toContain(join(agent, "settings.json"));
	expect(finding(rows, "effective_profile").recommended_action).toContain("omp-kit doctor --deep --yes");
	expect(finding(rows, "effective_profile").recommended_action).toContain("P15");
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
