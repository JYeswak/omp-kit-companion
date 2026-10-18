import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { defaultRchReachability, diagnose as diagnoseNative, health, inspectActionsBilling, inspectDicklesworthstone, inspectEffectiveRules, inspectEffectiveRulesAsync, inspectPaneIdentity, inspectRchReachability, inspectRegexTools, type Finding, type RchReachabilityDeps } from "../../src/diagnostics.ts";
import { ompFingerprint, recordTestReceipt } from "../../src/omp-watch.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

const fixtures: string[] = [];
interface Fixture { base: string; root: string; home: string; project: string; bunRoot: string; bytes: string; ompPath: string }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const environmentKeys = ["PATH", "HOME", "BUN_INSTALL", "OMP_KIT_OMP_SRC_CACHE", "OMP_KIT_OMP_SRC_FETCH", "OMP_PATH", "OMP_BIN", "OMP", "OMP_SRC"] as const;
async function withEnvironment<T>(environment: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previous: Record<string, string | undefined> = {};
	for (const key of environmentKeys) {
		previous[key] = process.env[key];
		const value = environment[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key of environmentKeys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
type DiagnoseInput = Parameters<typeof diagnoseNative>[0];
async function diagnose(input: DiagnoseInput): Promise<Finding[]> {
	if (!input.ompPath) return diagnoseNative(input);
	return withEnvironment({
		PATH: dirname(input.ompPath),
		HOME: input.home,
		BUN_INSTALL: dirname(dirname(input.ompPath)),
		OMP_KIT_OMP_SRC_CACHE: join(input.home, "omp-source-cache"),
		OMP_KIT_OMP_SRC_FETCH: "0",
	}, () => diagnoseNative(input));
}

function fixture(): Fixture {
	const base = mkdtempSync(join(tmpdir(), "omp-kit-diagnostics-"));
	fixtures.push(base);
	const root = join(base, "release");
	const home = join(base, "home");
	const project = join(base, "project");
	const bunRoot = join(base, "bun");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(home);
	mkdirSync(project);
	const bytes = "# Rule A\n";
	writeFileSync(join(root, "rules", "rule-a.md"), bytes);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nrule-a\t${hash(bytes)}\ttripwire\tabc1234\n`);
	return { base, root, home, project, bunRoot, bytes, ompPath: join(bunRoot, "bin", "omp") };
}
function writeOmpPackage(pkg: string, version: string | null, launcherLog: string): void {
	mkdirSync(join(pkg, "dist"), { recursive: true });
	mkdirSync(join(pkg, "src", "export"), { recursive: true });
	mkdirSync(join(pkg, "src", "capability"), { recursive: true });
	mkdirSync(join(pkg, "src", "discovery"), { recursive: true });
	mkdirSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", ...(version ? { version } : {}) }));
	writeFileSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) writeFileSync(join(pkg, "src", file), "export {};\n");
	const launcherVersion = version ?? "18.4.0";
	const launcher = join(pkg, "dist", "cli.js");
	writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${launcherLog}'\nif [ "$#" -ne 1 ] || [ "$1" != "--version" ]; then exit 91; fi\nprintf 'omp/${launcherVersion}\\n'\n`);
	chmodSync(launcher, 0o755);
}
function installOmp(f: Fixture, version: string | null = "18.4.0", launcherLog = join(f.base, "bun-omp-argv.txt")): string {
	const pkg = join(f.bunRoot, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
	mkdirSync(join(f.bunRoot, "bin"), { recursive: true });
	writeOmpPackage(pkg, version, launcherLog);
	symlinkSync(join(pkg, "dist", "cli.js"), f.ompPath);
	return pkg;
}
function installTernOmp(f: Fixture, version: string, stateVersion = version, sourceVersion = version): { app: string; bin: string; launcher: string; cache: string } {
	const app = join(f.base, "tern-app");
	const bin = join(app, "bin");
	const launcher = join(bin, "omp");
	const binary = join(app, "versions", version);
	const cache = join(f.base, "tern-omp-src");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(app, "versions"), { recursive: true });
	writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(f.base, "tern-omp-argv.txt")}'\nif [ "$#" -ne 1 ] || [ "$1" != "--version" ]; then exit 91; fi\nprintf 'omp/${version}\\n'\n`);
	chmodSync(binary, 0o755);
	symlinkSync(join("..", "versions", version), launcher);
	writeFileSync(join(app, "state.json"), JSON.stringify({ installed: { version: stateVersion } }));
	writeOmpPackage(join(cache, version, "node_modules", "@oh-my-pi", "pi-coding-agent"), sourceVersion, join(f.base, "tern-source-omp-argv.txt"));
	return { app, bin, launcher, cache };
}
function installUnmanagedOmp(f: Fixture, version: string): string {
	const root = join(f.base, "unmanaged-omp");
	const bin = join(root, "bin");
	const launcher = join(bin, "omp");
	const pkg = join(root, "package");
	mkdirSync(bin, { recursive: true });
	writeOmpPackage(pkg, version, join(f.base, "unmanaged-omp-argv.txt"));
	symlinkSync(join(pkg, "dist", "cli.js"), launcher);
	return launcher;
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

test("scoped diagnostics retain the corresponding full findings and uncertainty", async () => {
	const f = fixture(); installOmp(f);
	const input = { root: f.root, home: f.home, project: f.project, ompPath: f.ompPath };
	const full = await diagnose(input);
	const scopes: Record<string, string[]> = {
		kit: ["kit", "manifest", "planning_skill"], profile: ["effective_profile"],
		settings: ["policy"], extensions: ["extensions", "extension_imports"], router: ["router"], state_root: ["state_root"],
	};
	for (const [scope, components] of Object.entries(scopes)) {
		const scoped = await diagnose({ ...input, scope });
		// kit deliberately diagnoses the missing planning skill as well.
		expect(scoped.filter(row => components.includes(row.component) && row.component !== "planning_skill"))
			.toEqual(full.filter(row => components.includes(row.component) && row.component !== "planning_skill"));
		expect(scoped.every(row => components.includes(row.component))).toBe(true);
	}
	// Explicit omp scope performs the launcher execution cross-check; unscoped
	// inventory never executes the launcher, so only the probe fields differ.
	const scopedOmp = await diagnose({ ...input, scope: "omp" });
	expect(scopedOmp.map(row => row.component)).toEqual(["omp"]);
	const fullOmp = finding(full, "omp");
	const scopedOmpFinding = finding(scopedOmp, "omp");
	expect(fullOmp.status).toBe(scopedOmpFinding.status);
	expect(fullOmp.evidence?.launcher_version).toBe(null);
	expect(fullOmp.evidence?.launcher_version_proof).toBe("NOT_RUN");
	expect(scopedOmpFinding.evidence?.launcher_version).toBe("18.4.0");
	expect(scopedOmpFinding.evidence?.launcher_version_proof).toBe("OMP_LAUNCHER");
	const maskProbe = (row: Finding) => ({ ...row, reason: "MASKED", recommended_action: "MASKED",
		evidence: { ...row.evidence, launcher_version: "MASKED", launcher_version_proof: "MASKED" } });
	expect(maskProbe(scopedOmpFinding)).toEqual(maskProbe(fullOmp));
	expect(finding(await diagnose({ ...input, scope: "kit" }), "planning_skill").status).toBe("UNVERIFIED");
	expect(finding(await diagnose({ ...input, scope: "omp", ompPath: join(f.base, "missing") }), "omp").status).toBe("FAIL");
	const unknown = await diagnose({ ...input, scope: "not-implemented" });
	expect(unknown).toEqual([]);
	expect(health(unknown)).toBe("UNVERIFIED");
});

test("scope filtering beats the real two-second bound and an eager negative breaches it", async () => {
	const f = fixture(); installOmp(f);
	mkdirSync(join(f.home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(f.home, ".omp", "agent", "config.yml"), "{}\n");
	const calls = join(f.base, "native-probes.log");
	// A real subprocess delay, not a fake clock. This is a synthetic regression
	// fixture, never evidence about latency of the operator's installed OMP.
	writeFileSync(f.ompPath, `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then printf 'omp/18.4.0\\n'; exit 0; fi\nprintf '%s\\n' "$*" >> '${calls}'\n/bin/sleep 2.1\nprintf '[]\\n'\n`);
	const input = { root: f.root, home: f.home, project: f.project, ompPath: f.ompPath };
	const began = performance.now();
	const scoped = await diagnose({ ...input, scope: "omp" });
	expect(performance.now() - began).toBeLessThan(2000);
	expect(scoped.map(row => row.component)).toEqual(["omp"]);
	expect(finding(scoped, "omp").status).toBe("OK");
	expect(() => readFileSync(calls)).toThrow();
	const inventory = await diagnose({ ...input, inventoryOnly: true });
	expect(finding(inventory, "effective_rules").status).toBe("NOT_RUN");
	expect(finding(inventory, "effective_rules").recommended_action).toContain("omp-kit doctor --scope rules --json");
	expect(health(inventory)).not.toBe("OK");
	expect(() => readFileSync(calls)).toThrow();
	const eagerStart = performance.now();
	const eager = await diagnose(input);
	expect(performance.now() - eagerStart).toBeGreaterThan(2000);
	expect(readFileSync(calls, "utf8").trim().split("\n").sort()).toEqual(["plugin list --json", "ttsr list --json"]);
	expect(finding(eager, "effective_rules").evidence?.probe_method).toBe("bounded_async_native_spawn");
	// The requested live scope still performs both checks and never reuses the
	// inventory's NOT_RUN or a prior result.
	const live = await diagnose({ ...input, scope: "rules", inventoryOnly: true });
	expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(4);
	expect(finding(live, "effective_rules").status).toBe(finding(eager, "effective_rules").status);
	expect(finding(live, "installed_rules")).toEqual(finding(eager, "installed_rules"));
}, 15_000);

test("CLI scopes and bare presence inventory keep explicit unperformed evidence", () => {
	const f = fixture(); installOmp(f);
	const cli = join(import.meta.dir, "../../src/cli.ts");
	const env = { ...process.env, HOME: f.home, PATH: `${dirname(f.ompPath)}:/usr/bin:/bin`, XDG_STATE_HOME: join(f.base, "state") };
	for (const args of [["doctor", "--scope", "omp"], ["doctor", "--scope", "profile"], ["status"], []]) {
		const began = performance.now();
		const result = Bun.spawnSync([process.execPath, cli, ...args, "--json"], { cwd: f.project, env, stdout: "pipe", stderr: "pipe", timeout: 4000 });
		expect(performance.now() - began, `${args.join(" ")}: ${result.stderr}`).toBeLessThan(2000);
		const envelope = JSON.parse(result.stdout.toString());
		const rows: Finding[] = envelope.data.findings;
		if (args[0] === "doctor") {
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(rows.map(row => row.component)).toEqual([args[2] === "omp" ? "omp" : "effective_profile"]);
			if (args[2] === "profile") expect(rows[0]?.status).toBe("UNVERIFIED");
		} else {
			expect(result.exitCode).toBe(rows.some(row => ["kit", "manifest", "plugin_links"].includes(row.component) && row.status === "FAIL") ? 1 : 0);
			expect(finding(rows, "effective_rules").status).toBe("NOT_RUN");
			expect(envelope.meta.verification).toBe("UNVERIFIED");
			expect(envelope.data.overall).not.toBe("OK");
		}
	}
	const missing = Bun.spawnSync([process.execPath, cli, "doctor", "--scope", "omp", "--json"], {
		cwd: f.project, env: { ...env, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 4000,
	});
	expect(missing.exitCode, missing.stderr.toString()).toBe(3);
	expect(JSON.parse(missing.stdout.toString()).errors[0].code).toBe("OMP_UNAVAILABLE");
});
test("stale plugin symlink fails by profile and the installed release target passes", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "omp-kit-companion", version: "0.2.24" }));
	const oldRoot = join(f.base, "old-release");
	mkdirSync(join(oldRoot, "rules"), { recursive: true });
	mkdirSync(join(oldRoot, "extensions"));
	writeFileSync(join(oldRoot, "package.json"), JSON.stringify({ name: "omp-kit-companion", version: "0.2.20" }));
	mkdirSync(join(f.home, ".omp", "profiles", "claude", "agent"), { recursive: true });
	const defaultLink = join(f.home, ".omp", "plugins", "node_modules", "omp-kit-companion");
	const claudeLink = join(f.home, ".omp", "profiles", "claude", "plugins", "node_modules", "omp-kit-companion");
	mkdirSync(dirname(defaultLink), { recursive: true });
	mkdirSync(dirname(claudeLink), { recursive: true });
	symlinkSync(oldRoot, defaultLink);
	symlinkSync(f.root, claudeLink);

	const staleRows = await diagnose({ root: f.root, home: f.home });
	const stale = finding(staleRows, "plugin_links");
	expect(stale.status).toBe("FAIL");
	expect(stale.reason).toContain("default");
	expect(stale.evidence?.stale_profiles).toEqual(["default"]);
	expect((stale.evidence?.links as Array<{ profile: string; status: string }>).find(row => row.profile === "claude")?.status).toBe("CURRENT");

	rmSync(defaultLink);
	symlinkSync(f.root, defaultLink);
	const current = finding(await diagnose({ root: f.root, home: f.home }), "plugin_links");
	expect(current.status).toBe("OK");
	expect(current.evidence?.stale_profiles).toEqual([]);
});
test("STAMP1: lock version differing from the release manifest is DEGRADED with versionMismatch", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "omp-kit-companion", version: "0.2.24" }));
	writeFileSync(join(f.root, "release-manifest.json"), JSON.stringify({ version: "0.2.24" }));
	mkdirSync(join(f.home, ".omp", "profiles", "claude", "agent"), { recursive: true });
	const defaultLink = join(f.home, ".omp", "plugins", "node_modules", "omp-kit-companion");
	const claudeLink = join(f.home, ".omp", "profiles", "claude", "plugins", "node_modules", "omp-kit-companion");
	mkdirSync(dirname(defaultLink), { recursive: true });
	mkdirSync(dirname(claudeLink), { recursive: true });
	symlinkSync(f.root, defaultLink);
	symlinkSync(f.root, claudeLink);
	const lock = (version: string) => JSON.stringify({ plugins: { "omp-kit-companion": { version } } });
	mkdirSync(join(f.home, ".omp", "plugins"), { recursive: true });
	writeFileSync(join(f.home, ".omp", "plugins", "omp-plugins.lock.json"), lock("0.2.20"));
	mkdirSync(join(f.home, ".omp", "profiles", "claude", "plugins"), { recursive: true });
	writeFileSync(join(f.home, ".omp", "profiles", "claude", "plugins", "omp-plugins.lock.json"), lock("0.2.24"));

	const degraded = finding(await diagnose({ root: f.root, home: f.home }), "plugin_links");
	expect(degraded.status).toBe("DEGRADED");
	expect(degraded.evidence?.mismatch_profiles).toEqual(["default"]);
	expect((degraded.evidence?.links as Array<{ profile: string; versionMismatch?: string }>).find(row => row.profile === "default" && row.versionMismatch)?.versionMismatch).toBe("0.2.20 vs 0.2.24");

	writeFileSync(join(f.home, ".omp", "plugins", "omp-plugins.lock.json"), lock("0.2.24"));
	const current = finding(await diagnose({ root: f.root, home: f.home }), "plugin_links");
	expect(current.status).toBe("OK");
	expect(current.evidence?.mismatch_profiles).toEqual([]);
});

test("plugin-link inventory treats a named profile without an agent directory as unverified", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "extensions"));
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "omp-kit-companion", version: "0.2.24" }));
	const defaultLink = join(f.home, ".omp", "plugins", "node_modules", "omp-kit-companion");
	mkdirSync(dirname(defaultLink), { recursive: true });
	symlinkSync(f.root, defaultLink);
	mkdirSync(join(f.home, ".omp", "profiles", "claude"), { recursive: true });

	const pluginLinks = finding(await diagnose({ root: f.root, home: f.home }), "plugin_links");
	expect(pluginLinks.status).toBe("UNVERIFIED");
	expect(pluginLinks.evidence?.missing_profiles).toEqual([]);
	expect(pluginLinks.evidence?.inventory_issue).toContain("claude");
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
test("OMP doctor reports both manager-installed versions and the exact PATH winner without mutation", async () => {
	const f = fixture();
	const tern = installTernOmp(f, "18.4.0");
	installOmp(f, "18.5.0");
	const homeBefore = tree(f.home);
	const ternBefore = tree(tern.app);
	const bunBefore = tree(f.bunRoot);
	const ternEnvironment = {
		PATH: `${tern.bin}${delimiter}${dirname(f.ompPath)}`,
		HOME: f.home,
		BUN_INSTALL: f.bunRoot,
		OMP_KIT_OMP_SRC_CACHE: tern.cache,
		OMP_KIT_OMP_SRC_FETCH: "0",
	};
	const ternFinding = finding(await withEnvironment(ternEnvironment, () => diagnoseNative({ root: f.root, home: f.home, scope: "omp", ompPath: tern.launcher })), "omp");
	expect(ternFinding.status).toBe("OK");
	expect(ternFinding.evidence).toMatchObject({
		availability: "PRESENT",
		location: realpathSync(tern.launcher),
		manager_source: "tern",
		manager_versions: {
			tern: { status: "PRESENT", version: "18.4.0", provenance: "TERN_STATE" },
			bun: { status: "PRESENT", version: "18.5.0", provenance: "BUN_PACKAGE_METADATA" },
		},
		version: "18.4.0",
		version_proof: "PACKAGE_METADATA",
		launcher_version: "18.4.0",
		launcher_version_proof: "OMP_LAUNCHER",
	});
	const bunEnvironment = { ...ternEnvironment, PATH: `${dirname(f.ompPath)}${delimiter}${tern.bin}` };
	const bunFinding = finding(await withEnvironment(bunEnvironment, () => diagnoseNative({ root: f.root, home: f.home, scope: "omp", ompPath: f.ompPath })), "omp");
	expect(bunFinding.status).toBe("OK");
	expect(bunFinding.evidence).toMatchObject({
		availability: "PRESENT",
		location: realpathSync(f.ompPath),
		manager_source: "bun",
		manager_versions: {
			tern: { status: "PRESENT", version: "18.4.0", provenance: "TERN_STATE" },
			bun: { status: "PRESENT", version: "18.5.0", provenance: "BUN_PACKAGE_METADATA" },
		},
		version: "18.5.0",
		version_proof: "PACKAGE_METADATA",
		launcher_version: "18.5.0",
		launcher_version_proof: "OMP_LAUNCHER",
	});
	expect(tree(f.home)).toEqual(homeBefore);
	expect(tree(tern.app)).toEqual(ternBefore);
	expect(tree(f.bunRoot)).toEqual(bunBefore);
	expect(readFileSync(join(f.base, "tern-omp-argv.txt"), "utf8").trim().split("\n").every(arg => arg === "--version")).toBe(true);
	expect(readFileSync(join(f.base, "bun-omp-argv.txt"), "utf8").trim().split("\n").every(arg => arg === "--version")).toBe(true);
});
test("native doctor CLI reports exact Tern and Bun manager observations", () => {
	const f = fixture();
	const tern = installTernOmp(f, "18.4.0");
	installOmp(f, "18.5.0");
	const cli = join(import.meta.dir, "../../src/cli.ts");
	const common = {
		...process.env,
		HOME: f.home,
		BUN_INSTALL: f.bunRoot,
		OMP_KIT_OMP_SRC_CACHE: tern.cache,
		OMP_KIT_OMP_SRC_FETCH: "0",
		XDG_STATE_HOME: join(f.base, "state"),
		OMP_PATH: "",
		OMP_BIN: "",
		OMP: "",
		OMP_SRC: "",
	};
	const agentConfigDir = join(f.home, ".omp", "agent");
	mkdirSync(agentConfigDir, { recursive: true });
	writeFileSync(join(agentConfigDir, "config.yml"), "extensions: []\n");
	const before = { config: tree(agentConfigDir), tern: tree(tern.app), bun: tree(f.bunRoot) };
	for (const [manager, bin, expectedVersion] of [
		["tern", tern.bin, "18.4.0"],
		["bun", dirname(f.ompPath), "18.5.0"],
	] as const) {
		const env = { ...common, PATH: `${bin}${delimiter}${manager === "tern" ? dirname(f.ompPath) : tern.bin}${delimiter}/usr/bin:/bin` };
		const result = Bun.spawnSync([process.execPath, cli, "doctor", "--scope", "omp", "--json"], {
			cwd: f.project, env, stdout: "pipe", stderr: "pipe", timeout: 5_000,
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const envelope = JSON.parse(result.stdout.toString());
		const rows: Finding[] = envelope.data.findings;
		expect(rows.map(row => row.component)).toEqual(["omp"]);
		expect(finding(rows, "omp")).toMatchObject({
			status: "OK",
			evidence: {
				location: realpathSync(join(bin, "omp")),
				manager_source: manager,
				manager_versions: {
					tern: { status: "PRESENT", version: "18.4.0", provenance: "TERN_STATE" },
					bun: { status: "PRESENT", version: "18.5.0", provenance: "BUN_PACKAGE_METADATA" },
				},
				version: expectedVersion,
				version_proof: "PACKAGE_METADATA",
				launcher_version: expectedVersion,
				launcher_version_proof: "OMP_LAUNCHER",
			},
		});
	}
	expect({ config: tree(agentConfigDir), tern: tree(tern.app), bun: tree(f.bunRoot) }).toEqual(before);
	expect(readFileSync(join(f.base, "tern-omp-argv.txt"), "utf8").trim().split("\n").every(arg => arg === "--version")).toBe(true);
	expect(readFileSync(join(f.base, "bun-omp-argv.txt"), "utf8").trim().split("\n").every(arg => arg === "--version")).toBe(true);
});
test("an unknown OMP manager is explicit and cannot yield a verified current finding", async () => {
	const f = fixture();
	const launcher = installUnmanagedOmp(f, "18.6.0");
	const environment = {
		PATH: dirname(launcher),
		HOME: f.home,
		BUN_INSTALL: join(f.base, "missing-bun"),
		OMP_KIT_OMP_SRC_CACHE: join(f.home, "omp-source-cache"),
		OMP_KIT_OMP_SRC_FETCH: "0",
	};
	const row = finding(await withEnvironment(environment, () => diagnoseNative({ root: f.root, home: f.home, scope: "omp", ompPath: launcher })), "omp");
	expect(row.status).toBe("UNVERIFIED");
	expect(row.evidence).toMatchObject({
		availability: "UNVERIFIED",
		location: realpathSync(launcher),
		manager_source: "unknown",
		manager_versions: {
			tern: { status: "UNAVAILABLE", version: null, provenance: "TERN_STATE" },
			bun: { status: "UNAVAILABLE", version: null, provenance: "BUN_PACKAGE_METADATA" },
		},
		version: "18.6.0",
		launcher_version: "18.6.0",
	});
});
test("a conflicting requested launcher cannot override the PATH winner", async () => {
	const f = fixture();
	const tern = installTernOmp(f, "18.4.0");
	installOmp(f, "18.5.0");
	const environment = {
		PATH: `${dirname(f.ompPath)}${delimiter}${tern.bin}`,
		HOME: f.home,
		BUN_INSTALL: f.bunRoot,
		OMP_KIT_OMP_SRC_CACHE: tern.cache,
		OMP_KIT_OMP_SRC_FETCH: "0",
	};
	const row = finding(await withEnvironment(environment, () => diagnoseNative({ root: f.root, home: f.home, scope: "omp", ompPath: tern.launcher })), "omp");
	expect(row.status).toBe("UNVERIFIED");
	expect(row.reason).toContain("PATH-selected launcher");
	expect(row.evidence).toMatchObject({
		availability: "UNVERIFIED",
		location: realpathSync(f.ompPath),
		requested_location: realpathSync(tern.launcher),
		manager_source: "bun",
	});
});
test("stale Tern manager state and wrong-version source remain unverified", async () => {
	const stale = fixture();
	const staleTern = installTernOmp(stale, "18.4.0", "18.3.0");
	const staleEnvironment = {
		PATH: staleTern.bin,
		HOME: stale.home,
		BUN_INSTALL: join(stale.base, "missing-bun"),
		OMP_KIT_OMP_SRC_CACHE: staleTern.cache,
		OMP_KIT_OMP_SRC_FETCH: "0",
	};
	const staleRow = finding(await withEnvironment(staleEnvironment, () => diagnoseNative({ root: stale.root, home: stale.home, scope: "omp", ompPath: staleTern.launcher })), "omp");
	expect(staleRow.status).toBe("UNVERIFIED");
	expect(staleRow.evidence).toMatchObject({
		manager_source: "tern",
		manager_versions: { tern: { status: "UNVERIFIED", version: "18.3.0", provenance: "TERN_STATE" } },
	});

	const wrongSource = fixture();
	const wrongTern = installTernOmp(wrongSource, "18.4.0", "18.4.0", "18.3.0");
	const wrongEnvironment = {
		PATH: wrongTern.bin,
		HOME: wrongSource.home,
		BUN_INSTALL: join(wrongSource.base, "missing-bun"),
		OMP_KIT_OMP_SRC_CACHE: wrongTern.cache,
		OMP_KIT_OMP_SRC_FETCH: "0",
	};
	const wrongRow = finding(await withEnvironment(wrongEnvironment, () => diagnoseNative({ root: wrongSource.root, home: wrongSource.home, scope: "omp", ompPath: wrongTern.launcher })), "omp");
	expect(wrongRow.status).toBe("UNVERIFIED");
	expect(wrongRow.evidence).toMatchObject({
		manager_source: "tern",
		manager_versions: { tern: { status: "PRESENT", version: "18.4.0", provenance: "TERN_STATE" } },
		version: null,
	});
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
	const pkg = join(f.bunRoot, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
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

test("doctor identity scope reaches the pane finder through diagnose", async () => {
	const f = fixture();
	const bin = join(f.base, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tmux"), "#!/bin/sh\nprintf 's 0 0 %%101\\ns 0 1 %%102\\n'\n");
	chmodSync(join(bin, "tmux"), 0o755);
	writeFileSync(join(bin, "am"), "#!/bin/sh\nprintf '{\"name\":\"SharedName\"}'\n");
	chmodSync(join(bin, "am"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
	try {
		const rows = await diagnose({ root: f.root, home: f.home, project: f.project, scope: "identity" });
		const row = finding(rows, "identity");
		expect(row.status).toBe("FAIL");
		expect(row.reason).toContain("SharedName");
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
	}
});

test("private repo with Actions enabled fails billing with remedy", () => {
	const row = inspectActionsBilling({ repo: "o/r", isPrivate: true, actionsEnabled: true });
	expect(row.status).toBe("FAIL");
	expect(row.reason).toContain("billable");
	expect(row.recommended_action).toContain("enabled=false");
});

test("public repo with Actions enabled and private repo without are OK", () => {
	expect(inspectActionsBilling({ repo: "o/r", isPrivate: false, actionsEnabled: true }).status).toBe("OK");
	expect(inspectActionsBilling({ repo: "o/r", isPrivate: true, actionsEnabled: false }).status).toBe("OK");
});

test("unknown visibility or Actions state is UNVERIFIED, never OK", () => {
	expect(inspectActionsBilling({ repo: "o/r", isPrivate: null, actionsEnabled: true }).status).toBe("UNVERIFIED");
	expect(inspectActionsBilling({ repo: "o/r", isPrivate: true, actionsEnabled: null }).status).toBe("UNVERIFIED");
});

test("diagnose includes the billing row only when a probe is supplied", async () => {
	const f = fixture();
	const plain = await diagnose({ root: f.root, home: f.home });
	expect(plain.some(row => row.component === "actions-billing")).toBe(false);
	const flagged = await diagnose({ root: f.root, home: f.home, actionsBilling: { repo: "o/r", isPrivate: true, actionsEnabled: true } });
	expect(finding(flagged, "actions-billing").status).toBe("FAIL");
});

test("effective-rules probe leaves the inspected HOME byte- and mtime-identical", async () => {
	// RELEASE BLOCKER A: OMP initializes SQLite state (agent.db-wal/shm)
	// under $HOME on startup, so probing with the inspected HOME mutated it.
	// The probe runs OMP against an isolated copy carrying only small configs.
	const omp = resolveOmpIdentity(process.env).launcher;
	const home = mkdtempSync(join(tmpdir(), "omp-kit-probe-home-"));
	fixtures.push(home);
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "memory:\n  backend: off\n");
	mkdirSync(join(home, ".omp", "profiles", "native-fixture", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "profiles", "native-fixture", "agent", "config.yml"), "memory:\n  backend: off\n");
	const snapshot = (dir: string): Record<string, string> => {
		const out: Record<string, string> = {};
		const stack: string[] = [dir];
		while (stack.length) {
			const current = stack.pop() as string;
			let entries: string[];
			try {
				entries = readdirSync(current);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry === "." || entry === "..") continue;
				const path = join(current, entry);
				let stat;
				try {
					stat = lstatSync(path);
				} catch {
					continue;
				}
				out[path] = `${stat.mode & 0o777}:${stat.size}:${stat.mtimeMs}`;
				if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path);
			}
		}
		return out;
	};
	const before = snapshot(home);
	const report = await inspectEffectiveRulesAsync({ home, ompPath: omp, kitVersion: null, ompVersion: null, rules: [], profiles: [{ name: "native-fixture" }] });
	expect(snapshot(home)).toEqual(before);
	expect(JSON.stringify(report)).toContain("native-fixture");
}, 120_000);
test("doctor lists tmux socket paths without a live server", async () => {
	const f = fixture();
	const directory = join(f.home, ".tmux-sockets", "tmux-" + process.getuid());
	mkdirSync(directory, { recursive: true });
	const stale = join(directory, "default");
	writeFileSync(stale, "orphaned socket path\n");
	const rows = await diagnose({ root: f.root, home: f.home });
	const sockets = rows.find(row => row.component === "tmux_sockets");
	expect(sockets?.status).toBe("DEGRADED");
	expect(sockets?.evidence?.stale_sockets).toEqual([stale]);
	expect(sockets?.reason).toContain(stale);
});

// --- RCHSOCK1 reachability (ompkit-774u.6.4) ------------------------------------

function unixListener(path: string): Promise<Server> {
	const server = createServer();
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	}).then(() => server);
}

function rchDeps(sockPath: string, over: Partial<RchReachabilityDeps> = {}): RchReachabilityDeps {
	return {
		uid: 501,
		daemon: () => ({ running: true, socketPath: sockPath }),
		platform: "darwin",
		daemonPid: () => 424242,
		lsofUnixSockets: () => [sockPath],
		statSocket: () => ({ kind: "missing", ino: null }),
		...over,
	};
}

function noCapacity(row: Finding): void {
	expect(`${row.reason} ${row.recommended_action}`.toLowerCase()).not.toContain("capacity");
}

test("rch: live listener on a present socket is RUNNING", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rch-run-"));
	fixtures.push(dir);
	const sock = join(dir, "rch.sock");
	const server = await unixListener(sock);
	try {
		const row = inspectRchReachability(rchDeps(sock, { statSocket: () => ({ kind: "socket", ino: 7 }) }));
		expect(row.component).toBe("rch");
		expect(row.status).toBe("OK");
		expect(row.evidence?.state).toBe("RUNNING");
		noCapacity(row);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("rch: unlinked path under a live holder is SOCKET_UNLINKED, never capacity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rch-unlink-"));
	fixtures.push(dir);
	const sock = join(dir, "rch.sock");
	const server = await unixListener(sock);
	try {
		rmSync(sock);
		const row = inspectRchReachability(rchDeps(sock));
		expect(row.status).toBe("FAIL");
		expect(row.evidence?.state).toBe("SOCKET_UNLINKED");
		expect(row.reason).toContain("unlinked");
		expect(row.recommended_action).toContain("launchctl kickstart");
		noCapacity(row);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("rch: path replaced by a regular file is SOCKET_UNLINKED", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rch-replaced-"));
	fixtures.push(dir);
	const sock = join(dir, "rch.sock");
	writeFileSync(sock, "not a socket\n");
	const row = inspectRchReachability(rchDeps(sock, { statSocket: () => ({ kind: "other", ino: null }) }));
	expect(row.status).toBe("FAIL");
	expect(row.evidence?.state).toBe("SOCKET_UNLINKED");
	noCapacity(row);
});

test("rch: stopped daemon is NOT_RUNNING, unknown daemon/path/pid/lsof is UNVERIFIED", async () => {
	const sock = join(tmpdir(), "rch-absent.sock");
	const stopped = inspectRchReachability(rchDeps(sock, { daemon: () => ({ running: false, socketPath: sock }) }));
	expect(stopped.status).toBe("OK");
	expect(stopped.evidence?.state).toBe("NOT_RUNNING");
	for (const [state, over] of [
		["RCH_UNAVAILABLE", { daemon: () => null }],
		["SOCKET_PATH_UNKNOWN", { daemon: () => ({ running: true, socketPath: null }) }],
		["PID_UNKNOWN", { daemonPid: () => null }],
		["LSOF_UNAVAILABLE", { lsofUnixSockets: () => null }],
	] as const) {
		const row = inspectRchReachability(rchDeps(sock, over));
		expect(row.evidence?.state).toBe(state);
		expect(row.status).toBe("UNVERIFIED");
		noCapacity(row);
	}
});

test("rch: default statSocket reads real fixture socket state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rch-default-"));
	fixtures.push(dir);
	const sock = join(dir, "rch.sock");
	const server = await unixListener(sock);
	try {
		const deps = defaultRchReachability();
		expect(deps.statSocket(sock).kind).toBe("socket");
		rmSync(sock);
		expect(deps.statSocket(sock).kind).toBe("missing");
		writeFileSync(sock, "not a socket\n");
		expect(deps.statSocket(sock).kind).toBe("other");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

// ---- oq1h.5: a fresh install without fleet tools is judged on what exists ------------------------------------
function planningSkillFixture(f: Fixture, localCopy: "absent" | "same" | "different"): void {
	const kit = Buffer.from("kit-owned planning protocol\n");
	mkdirSync(join(f.root, "skills", "jeff-planning-enhanced"), { recursive: true });
	writeFileSync(join(f.root, "skills", "jeff-planning-enhanced", "SKILL.md"), kit);
	if (localCopy === "absent") return;
	const local = join(f.home, ".agents", "skills", "jeff-planning-enhanced");
	mkdirSync(local, { recursive: true });
	writeFileSync(join(local, "SKILL.md"), localCopy === "same" ? kit : "a local edit\n");
}

test("oq1h.5: an unscoped inventory does not judge a planning skill the user never installed", async () => {
	const f = fixture(); installOmp(f); planningSkillFixture(f, "absent");
	const input = { root: f.root, home: f.home, ompPath: f.ompPath };
	expect((await diagnose(input)).map((row) => row.component)).not.toContain("planning_skill");
	// An explicit scope still reports the missing copy as drift.
	expect(finding(await diagnose({ ...input, scope: "kit" }), "planning_skill").status).toBe("DRIFT");
	expect(finding(await diagnose({ ...input, scope: "planning_skill" }), "planning_skill").status).toBe("DRIFT");
	// Planted negatives: an installed copy is judged again, so a dropped judgment cannot hide real drift.
	planningSkillFixture(f, "same");
	expect(finding(await diagnose(input), "planning_skill").status).toBe("OK");
	planningSkillFixture(f, "different");
	expect(finding(await diagnose(input), "planning_skill").status).toBe("DRIFT");
});

test("oq1h.5: an unscoped inventory omits rch when it is not installed, and the rch diagnostic scope still says so", async () => {
	const f = fixture(); installOmp(f);
	const input = { root: f.root, home: f.home, ompPath: f.ompPath };
	// Positive control for the planted state: the diagnose PATH (only the omp bin directory) must lack rch.
	expect(Bun.spawnSync(["/bin/sh", "-c", "command -v rch"], { env: { PATH: dirname(f.ompPath) } }).exitCode).not.toBe(0);
	expect((await diagnose(input)).map((row) => row.component)).not.toContain("rch");
	const scoped = finding(await diagnose({ ...input, scope: "rch" }), "rch");
	expect(scoped.status).toBe("UNVERIFIED");
	expect(scoped.evidence?.state).toBe("RCH_UNAVAILABLE");
	// Planted negative: with an rch on PATH the unscoped inventory judges it again.
	const bin = join(f.base, "rch-bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "rch"), `#!/bin/sh\nprintf '%s\\n' '{"data":{"running":false}}'\n`);
	chmodSync(join(bin, "rch"), 0o755);
	const present = await withEnvironment({
		PATH: `${dirname(f.ompPath)}${delimiter}${bin}`, HOME: f.home, BUN_INSTALL: dirname(dirname(f.ompPath)),
		OMP_KIT_OMP_SRC_CACHE: join(f.home, "omp-source-cache"), OMP_KIT_OMP_SRC_FETCH: "0",
	}, () => diagnoseNative(input));
	expect(finding(present, "rch").evidence?.state).toBe("NOT_RUNNING");
});

type RchRunCall = [string, readonly string[]];
function rchRunner(answers: Record<string, { code: number; out: string } | null>, calls: RchRunCall[] = []) {
	return (binary: string, args: readonly string[]) => {
		calls.push([binary, args]);
		return answers[binary] ?? null;
	};
}

test("oq1h.5: on Linux the rchd pid is the single rchd process of this uid, never a guess", () => {
	const uid = process.getuid?.() ?? 0;
	const calls: RchRunCall[] = [];
	expect(defaultRchReachability(rchRunner({ pgrep: { code: 0, out: "424242\n" } }, calls), "linux").daemonPid()).toBe(424242);
	expect(calls).toEqual([["pgrep", ["-u", String(uid), "-x", "rchd"]]]);
	// Several rchd processes are ambiguous (a real Mac showed three while launchd supervised one): unknown, not the first.
	expect(defaultRchReachability(rchRunner({ pgrep: { code: 0, out: "93530\n75440\n89873\n" } }), "linux").daemonPid()).toBeNull();
	expect(defaultRchReachability(rchRunner({ pgrep: { code: 1, out: "" } }), "linux").daemonPid()).toBeNull();
	expect(defaultRchReachability(rchRunner({}), "linux").daemonPid()).toBeNull();
	// macOS keeps its launchd lookup and never consults pgrep.
	const darwinCalls: RchRunCall[] = [];
	const darwin = defaultRchReachability(rchRunner({ launchctl: { code: 0, out: "state = running\n\tpid = 31337\n" } }, darwinCalls), "darwin");
	expect(darwin.daemonPid()).toBe(31337);
	expect(darwinCalls.map(([binary]) => binary)).toEqual(["launchctl"]);
});

test("oq1h.5: a live rchd on Linux reaches RUNNING through the same checks, and an ambiguous pid stays UNVERIFIED", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rch-linux-"));
	fixtures.push(dir);
	const sock = join(dir, "rch.sock");
	const server = await unixListener(sock);
	try {
		const status = { code: 0, out: JSON.stringify({ data: { running: true, socket_path: sock } }) };
		const running = inspectRchReachability(defaultRchReachability(rchRunner({
			rch: status, pgrep: { code: 0, out: "777\n" }, lsof: { code: 0, out: `p777\nn${sock}\n` },
		}), "linux"));
		expect(running.status).toBe("OK");
		expect(running.evidence?.state).toBe("RUNNING");
		expect(running.evidence?.pid).toBe(777);
		const ambiguous = inspectRchReachability(defaultRchReachability(rchRunner({ rch: status, pgrep: { code: 0, out: "1\n2\n" } }), "linux"));
		expect(ambiguous.status).toBe("UNVERIFIED");
		expect(ambiguous.evidence?.state).toBe("PID_UNKNOWN");
		expect(ambiguous.recommended_action).not.toContain("launchctl");
		// An unlinked socket under a live daemon is a FAIL on Linux too, with advice that is not launchd-only.
		rmSync(sock);
		const unlinked = inspectRchReachability(defaultRchReachability(rchRunner({
			rch: status, pgrep: { code: 0, out: "777\n" }, lsof: { code: 0, out: `p777\nn${sock}\n` },
		}), "linux"));
		expect(unlinked.status).toBe("FAIL");
		expect(unlinked.evidence?.state).toBe("SOCKET_UNLINKED");
		expect(unlinked.recommended_action).not.toContain("launchctl");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
