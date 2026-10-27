import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { inspectEffectiveRules, inspectEffectiveRulesAsync, isolatedProbeHome, profilePluginRuleStatus, runEffectiveRuleProbe, type EffectiveRulesInput, type Finding } from "../../src/diagnostics.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

const home = "/fixture/home";
const kitVersion = "0.2.5";
const rules = ["kit-a", "kit-b"];
const profiles = [{ name: "default" }, { name: "codex" }, { name: "claude" }];
const plugin = (profile: string) => `${home}/.omp/${profile === "default" ? "" : `profiles/${profile}/`}plugins/node_modules/omp-kit-companion/rules`;
const agentRules = (profile: string) => `${home}/.omp/${profile === "default" ? "agent" : `profiles/${profile}/agent`}/rules`;

function probeFor(config: Record<string, { plugin: boolean; version?: string; overlay?: string }>): EffectiveRulesInput["probe"] {
	return (profile, command) => {
		const selected = config[profile] ?? { plugin: false };
		if (command === "plugin") return { npm: selected.plugin ? [{ name: "omp-kit-companion", version: selected.version ?? kitVersion, extensions: ["kit-callback.ts"] }] : [], marketplace: [] };
		if (selected.plugin) return rules.map(name => selected.overlay === name ? ({ name, path: `${agentRules(profile)}/${name}.md`, provider: "agents" }) : ({ name, path: `${plugin(profile)}/${name}.md`, provider: "plugin" }));
		if (selected.overlay) return rules.map(name => ({ name, path: `${agentRules(profile)}/${name}.md`, provider: "agents" }));
		return rules.map(name => ({ name, path: `${home}/.agents/rules/${name}.md`, provider: "agents" }));
	};
}

function input(config: Record<string, { plugin: boolean; version?: string; overlay?: string }>): EffectiveRulesInput {
	return { home, ompPath: "/fixture/bin/omp", kitVersion, ompVersion: "18.6.0", rules, profiles, probe: probeFor(config) };
}

test("degrades when named profiles lack the kit plugin", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: true }, codex: { plugin: false }, claude: { plugin: false } }));
	expect(finding.status).toBe("DEGRADED");
	expect((finding.evidence?.profiles as Array<{ profile: string; status: string }>).filter(row => row.status === "DEGRADED").map(row => row.profile)).toEqual(["codex", "claude"]);
});

test("reports OK when every covered profile has the matching plugin", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: true }, codex: { plugin: true }, claude: { plugin: true } }));
	expect(finding.status).toBe("OK");
	expect(finding.component).toBe("effective_rules");
});

test("names an older kit plugin version", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: true }, codex: { plugin: true, version: "0.2.4" }, claude: { plugin: true } }));
	const codex = (finding.evidence?.profiles as Array<{ profile: string; status: string; plugin_version: string }>).find(row => row.profile === "codex");
	expect(finding.status).toBe("DEGRADED");
	expect(codex).toMatchObject({ status: "DEGRADED", plugin_version: "0.2.4" });
});

test("STAMP1: a plugin lock of 0.2.15 against installed 0.2.19 names versionMismatch; a matching profile stays OK", () => {
	const stale = inspectEffectiveRules({ ...input({ default: { plugin: true, version: "0.2.19" }, codex: { plugin: true, version: "0.2.15" }, claude: { plugin: true, version: "0.2.19" } }), kitVersion: "0.2.19" });
	const rows = stale.evidence?.profiles as Array<{ profile: string; status: string; versionMismatch?: string }>;
	expect(stale.status).toBe("DEGRADED");
	expect(rows.find(row => row.profile === "codex")).toMatchObject({ status: "DEGRADED", versionMismatch: "0.2.15 vs 0.2.19" });
	expect(rows.find(row => row.profile === "default")).toMatchObject({ status: "OK" });
	expect(rows.find(row => row.profile === "default")?.versionMismatch).toBeUndefined();
	const matching = inspectEffectiveRules({ ...input({ default: { plugin: true, version: "0.2.19" }, codex: { plugin: true, version: "0.2.19" }, claude: { plugin: true, version: "0.2.19" } }), kitVersion: "0.2.19" });
	expect(matching.status).toBe("OK");
	expect((matching.evidence?.profiles as Array<{ versionMismatch?: string }>).every(row => row.versionMismatch === undefined)).toBe(true);
});

test("accepts a native overlay and lists it as an overlay", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: true }, codex: { plugin: true, overlay: "kit-a" }, claude: { plugin: true } }));
	expect(finding.status).toBe("OK");
	const codex = (finding.evidence?.profiles as Array<{ profile: string; kit_rules: { overlays: string[] } }>).find(row => row.profile === "codex");
	expect(codex?.kit_rules.overlays).toEqual(["kit-a"]);
});

test("rejects legacy rules even when every legacy byte is present", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: false }, codex: { plugin: false }, claude: { plugin: false } }));
	expect(finding.status).toBe("DEGRADED");
	expect(finding.recommended_action).toContain("apply plugin");
});
test("real native probe invokes the stub with cwd and clean profile environment", () => {
	const root = join(process.cwd(), "var", "agent-tmp", "prof2-stub.77773");
	const homeDir = join(root, "home");
	const stub = join(root, "omp-stub.sh");
	mkdirSync(homeDir, { recursive: true, mode: 0o700 });
	writeFileSync(stub, "#!/bin/sh\npwd > probe-cwd.txt\ncase \"$*\" in *ttsr*) printf \"[{\\\"name\\\":\\\"kit-a\\\",\\\"path\\\":\\\"%s/.omp/plugins/node_modules/omp-kit-companion/rules/kit-a.md\\\",\\\"provider\\\":\\\"plugin\\\"}]\" \"$PWD\" ;; *) printf \"{\\\"npm\\\":[{\\\"name\\\":\\\"omp-kit-companion\\\",\\\"version\\\":\\\"0.2.5\\\"}],\\\"marketplace\\\":[]}\" ;; esac\n");
	chmodSync(stub, 0o755);
	const result = runEffectiveRuleProbe(stub, homeDir, "default", "ttsr") as Array<{ name: string; path: string }>;
	expect(result[0]?.name).toBe("kit-a");
	expect(result[0]?.path).toContain(homeDir);
});
test("bounded async profile probes stay parallel", async () => {
	const root = join(process.cwd(), "var", "agent-tmp", "prof2-stub.77773");
	const homeDir = join(root, "home");
	const stub = join(root, "omp-stub-sleep.sh");
	mkdirSync(homeDir, { recursive: true, mode: 0o700 });
	writeFileSync(stub, "#!/bin/sh\nsleep 0.05\ncase \"$*\" in *ttsr*) printf \"[{\\\"name\\\":\\\"kit-a\\\",\\\"path\\\":\\\"%s/.omp/plugins/node_modules/omp-kit-companion/rules/kit-a.md\\\",\\\"provider\\\":\\\"plugin\\\"}]\" \"$PWD\" ;; *) printf \"{\\\"npm\\\":[{\\\"name\\\":\\\"omp-kit-companion\\\",\\\"version\\\":\\\"0.2.5\\\"}],\\\"marketplace\\\":[]}\" ;; esac\n");
	chmodSync(stub, 0o755);
	const profiles = Array.from({ length: 17 }, (_, index) => ({ name: index === 0 ? "default" : `p${index}` }));
	const finding = await inspectEffectiveRulesAsync({ home: homeDir, ompPath: stub, kitVersion: "0.2.5", ompVersion: "18.6.0", rules: ["kit-a"], profiles });
	expect(finding.status).toBe("OK");
	expect(finding.evidence?.probe_concurrency).toBe(6);
	expect(finding.evidence?.probe_elapsed_ms).toBeLessThan(2000);
});

const ownedScratch: OwnedTmp[] = [];
afterEach(() => { for (const owned of ownedScratch.splice(0)) owned.cleanup(); });
function scratch(label: string): string {
	const owned = ownedTmp(label);
	ownedScratch.push(owned);
	return owned.path;
}

const fixRuleA = `---\ndescription: "fixture stream rule"\ncondition:\n  - 'fixture-token-xyz'\n---\nfixture stream body\n`;
const fixStanding = `---\ndescription: "fixture standing law"\nalwaysApply: true\n---\nfixture standing body\n`;
const fixASha = createHash("sha256").update(fixRuleA).digest("hex");
const fixStandingSha = createHash("sha256").update(fixStanding).digest("hex");
// DI seam: the manifest sha lookup the doctor wires from MANIFEST.tsv.
const fixLookup = (name: string): string | null => name === "kit-a" ? fixASha : name === "kit-standing-law" ? fixStandingSha : null;

function fixRelease(base: string, version: string, tag: string, stream = fixRuleA): string {
	const dir = join(base, `release-${tag}`);
	mkdirSync(join(dir, "rules"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omp-kit-companion", version, description: "fixture release", omp: { name: "omp-kit-companion", version, description: "fixture release", extensions: [] } }));
	writeFileSync(join(dir, "rules", "kit-a.md"), stream);
	writeFileSync(join(dir, "rules", "kit-standing-law.md"), fixStanding);
	return dir;
}

function fixHome(base: string, name: string, release: string | null, version: string | null, overlay: boolean): string {
	const dir = join(base, name);
	mkdirSync(join(dir, ".omp", "agent"), { recursive: true });
	writeFileSync(join(dir, ".omp", "agent", "config.yml"), "memory:\n  backend: off\n");
	if (release !== null && version !== null) {
		const plugins = join(dir, ".omp", "plugins");
		mkdirSync(join(plugins, "node_modules"), { recursive: true });
		symlinkSync(release, join(plugins, "node_modules", "omp-kit-companion"));
		writeFileSync(join(plugins, "omp-plugins.lock.json"), JSON.stringify({ plugins: { "omp-kit-companion": { version, enabled: true } }, settings: {} }));
		writeFileSync(join(plugins, "installed_plugins.json"), "{}");
		writeFileSync(join(plugins, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "omp-kit-companion": `github:JYeswak/omp-kit-companion#v${version}` } }));
		writeFileSync(join(dir, ".omp", "marketplaces.json"), "{}");
	}
	if (overlay) {
		mkdirSync(join(dir, ".omp", "agent", "rules"), { recursive: true });
		writeFileSync(join(dir, ".omp", "agent", "rules", "kit-a.md"), fixRuleA);
	}
	return dir;
}

// Boundary assert: the doctor's own finding shape, guaranteed by the code under test.
type ProfileRow = { status: unknown; plugin_version: unknown; versionMismatch?: unknown; kit_rules: { plugin: unknown; overlays: unknown; legacy: unknown; missing: unknown; always_apply: { rules: unknown; missing: unknown } } };
function rowOf(finding: Finding): ProfileRow {
	const envelope = finding.evidence as { profiles: [ProfileRow] };
	return envelope.profiles[0] as ProfileRow;
}

function stateFiles(dir: string): string[] {
	const found: string[] = [];
	const stack: string[] = [dir];
	while (stack.length) {
		const current = stack.pop() as string;
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			const stat = lstatSync(path);
			if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
			else if (/\.db(-wal|-shm|-journal)?$/.test(entry)) found.push(path);
		}
	}
	return found;
}

test("isolated probe HOME carries plugin scope and overlays but no state", () => {
	const base = scratch("prof2-probehome");
	const release = fixRelease(base, "7.7.7", "new");
	const home = fixHome(base, "home", release, "7.7.7", true);
	writeFileSync(join(home, ".omp", "agent", "agent.db"), "junk-state");
	const isolated = isolatedProbeHome(home, "default");
	try {
		expect(readlinkSync(join(isolated.home, ".omp", "plugins", "node_modules", "omp-kit-companion"))).toBe(release);
		expect(lstatSync(join(isolated.home, ".omp", "plugins", "omp-plugins.lock.json")).isFile()).toBe(true);
		expect(lstatSync(join(isolated.home, ".omp", "plugins", "package.json")).isFile()).toBe(true);
		expect(lstatSync(join(isolated.home, ".omp", "marketplaces.json")).isFile()).toBe(true);
		expect(lstatSync(join(isolated.home, ".omp", "agent", "config.yml")).isFile()).toBe(true);
		expect(lstatSync(join(isolated.home, ".omp", "agent", "rules", "kit-a.md")).isFile()).toBe(true);
		expect(stateFiles(isolated.home)).toEqual([]);
	} finally {
		isolated.cleanup();
	}
	expect(() => lstatSync(isolated.home)).toThrow();
});

test("profilePluginRuleStatus grades ON, STALE, MISSING and UNVERIFIED", () => {
	const base = scratch("prof2-rulestatus");
	const release = fixRelease(base, "7.7.7", "new");
	const home = fixHome(base, "home", release, "7.7.7", false);
	const at = { version: "7.7.7", sha256: fixLookup };
	expect(profilePluginRuleStatus(home, "default", "kit-a", at).status).toBe("ON");
	expect(profilePluginRuleStatus(home, "default", "kit-standing-law", at).status).toBe("ON");
	const stale = fixHome(base, "stale", release, "7.7.6", false);
	expect(profilePluginRuleStatus(stale, "default", "kit-a", at)).toMatchObject({ status: "STALE", version: "7.7.6" });
	const drifted = fixRelease(base, "7.7.7", "drift", `${fixRuleA}drift\n`);
	const driftHome = fixHome(base, "drift", drifted, "7.7.7", false);
	expect(profilePluginRuleStatus(driftHome, "default", "kit-a", at).status).toBe("STALE");
	const bare = fixHome(base, "bare", null, null, false);
	expect(profilePluginRuleStatus(bare, "default", "kit-a", at).status).toBe("MISSING");
	expect(profilePluginRuleStatus(home, "default", "../x", at).status).toBe("UNVERIFIED");
});

async function liveFinding(home: string): Promise<Finding> {
	return inspectEffectiveRulesAsync({
		home, ompPath: resolveOmpIdentity(process.env).launcher, kitVersion: "7.7.7", ompVersion: null,
		rules: ["kit-a", "kit-standing-law"], always_rules: ["kit-standing-law"], ruleSha256: fixLookup,
		profiles: [{ name: "default" }],
	});
}

test("fixture HOME with real omp: linked release reports OK with zero missing", async () => {
	const base = scratch("prof2-live-ok");
	const home = fixHome(base, "home", fixRelease(base, "7.7.7", "new"), "7.7.7", false);
	const finding = await liveFinding(home);
	const row = rowOf(finding);
	expect(finding.status).toBe("OK");
	expect(row.status).toBe("OK");
	expect(row.plugin_version).toBe("7.7.7");
	expect(row.kit_rules.plugin).toEqual(["kit-a"]);
	expect(row.kit_rules.missing).toEqual([]);
	expect(row.kit_rules.always_apply.missing).toEqual([]);
	expect(stateFiles(home)).toEqual([]);
}, 120_000);

test("fixture HOME with real omp: no plugin link reports every kit rule missing", async () => {
	const base = scratch("prof2-live-nolink");
	const home = fixHome(base, "home", null, null, false);
	const finding = await liveFinding(home);
	const row = rowOf(finding);
	expect(finding.status).toBe("DEGRADED");
	expect(row.plugin_version).toBeNull();
	expect(row.kit_rules.missing).toEqual(["kit-a"]);
	expect(row.kit_rules.always_apply.missing).toEqual(["kit-standing-law"]);
}, 120_000);

test("fixture HOME with real omp: older linked release reports STALE", async () => {
	const base = scratch("prof2-live-stale");
	const home = fixHome(base, "home", fixRelease(base, "7.7.6", "old"), "7.7.6", false);
	const finding = await liveFinding(home);
	const row = rowOf(finding);
	expect(finding.status).toBe("DEGRADED");
	expect(row.versionMismatch).toBe("7.7.6 vs 7.7.7");
	expect(row.kit_rules.always_apply.missing).toEqual(["kit-standing-law"]);
}, 120_000);

test("fixture HOME with real omp: native overlay keeps OK and is listed", async () => {
	const base = scratch("prof2-live-overlay");
	const home = fixHome(base, "home", fixRelease(base, "7.7.7", "new"), "7.7.7", true);
	const finding = await liveFinding(home);
	const row = rowOf(finding);
	expect(finding.status).toBe("OK");
	expect(row.kit_rules.overlays).toEqual(["kit-a"]);
	expect(row.kit_rules.missing).toEqual([]);
	expect(row.kit_rules.always_apply.missing).toEqual([]);
}, 120_000);
