import { expect, test } from "bun:test";
import { inspectEffectiveRules, type EffectiveRulesInput } from "../../src/diagnostics.ts";

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
