import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { inspectEffectiveRules, inspectEffectiveRulesAsync, runEffectiveRuleProbe, type EffectiveRulesInput } from "../../src/diagnostics.ts";

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
});

test("names an older kit plugin version", () => {
	const finding = inspectEffectiveRules(input({ default: { plugin: true }, codex: { plugin: true, version: "0.2.4" }, claude: { plugin: true } }));
	const codex = (finding.evidence?.profiles as Array<{ profile: string; status: string; plugin_version: string }>).find(row => row.profile === "codex");
	expect(finding.status).toBe("DEGRADED");
	expect(codex).toMatchObject({ status: "DEGRADED", plugin_version: "0.2.4" });
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
