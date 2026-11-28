import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { applyActivationManifest, recordOptOut, updatePostApplyEnvelope } from "../../src/activation.ts";
import { plistPath, serviceLabel } from "../../src/service.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import type { HookRefreshIo } from "../../src/hook-refresh.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const base = resolve(ownedTmp("activation-apply").path);
afterAll(() => rmSync(base, { recursive: true, force: true }));

function sha(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function fixtureDirs(tag: string): { root: string; home: string; stateRoot: string } {
	const dir = join(base, tag);
	const root = join(dir, "root"), home = join(dir, "home");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "rules-fleet"), { recursive: true });
	mkdirSync(join(root, "policy"), { recursive: true });
	mkdirSync(join(root, "retired"), { recursive: true });
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(home, { recursive: true });
	const rule = "# Foo rule\n";
	const fleetRule = "# Bar fleet rule\n";
	writeFileSync(join(root, "policy", "extensions.json"), JSON.stringify({ extensions: ["hello.ts"], skipProfiles: [] }));
	writeFileSync(join(root, "extensions", "hello.ts"), "// hello\nexport const x = 1;\n");
	writeFileSync(join(root, "rules", "foo.md"), rule);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nfoo\t${sha(rule)}\ttripwire\t1234567\n`);
	writeFileSync(join(root, "rules-fleet", "bar.md"), fleetRule);
	writeFileSync(join(root, "MANIFEST.fleet.tsv"), `name\tsha256\tclass\tpack\nbar\t${sha(fleetRule)}\ttripwire\t1234567\n`);
	writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9", omp: { extensions: ["extensions/hello.ts"], notLoadedExtensions: {} } }));
	return { root, home, stateRoot: join(home, ".local", "state", "omp-kit") };
}
// The real `omp-kit service install <job> --apply --yes --json` output (captured from the 0.2.140 update): the envelope has no
// top-level `code`; `ok` is the verdict. A stub that prints {code: 0} passed the old check while every real run failed it.
const serviceEnvelope = (ok: boolean, errors: unknown[] = []) => JSON.stringify({ ok, tool_version: "0.2.140",
	data: { backup: null, changed: false, detail: "Identical bytes and loaded; no-op.", job: "scratch-reaper", label: "com.omp-kit.scratch-reaper", ok, overall: ok ? "OK" : "FINDINGS" },
	meta: { schema_version: "1", verification: "UNVERIFIED" }, warnings: [], commands: [], errors });
const okService = () => async (_argv: readonly string[]) => ({ exit: 0, stdout: serviceEnvelope(true), stderr: "" });
function hookIo(record: string[]): HookRefreshIo {
	return {
		repos: () => [],
		kitRoot: () => "/nonexistent-kit",
		digest: () => null,
		hooksDir: () => ({ dir: null, config: null, tracked: false }),
		check: async () => ({ rc: 0, output: "" }),
		hasKitMembers: () => false,
		pullRepos: () => [],
		runInstaller: (repo: string) => { record.push(repo); return { ok: true, detail: "fake" }; },
	};
}
const envelopeBase = { code: 0 as const, data: { overall: "UNVERIFIED", action: "UPDATED" } };

test("positive: whole manifest applies from owned fixtures, envelope UPDATED", async () => {
	const { root, home, stateRoot } = fixtureDirs("positive");
	const installed: string[] = [];
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo(installed) });
	expect(result.ok).toBe(true);
	expect(result.failed).toEqual([]);
	expect(result.rulesApplied).toBe(4);
	expect(result.extensionsApplied).toBeGreaterThan(0);
	expect(result.servicesApplied.length).toBeGreaterThan(0);
	expect(readFileSync(join(home, ".agents", "rules", "foo.md"), "utf8")).toContain("Foo rule");
	expect(readFileSync(join(home, ".agents", "rules", "bar.md"), "utf8")).toContain("Bar fleet rule");
	expect(readFileSync(join(home, ".omp", "omp-extensions", "hello.ts"), "utf8")).toContain("hello");
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, receiptId: "r1", detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
});

test("opt-outs skip without failure, envelope stays UPDATED with records", async () => {
	const { root, home, stateRoot } = fixtureDirs("optout");
	recordOptOut(home, "rule:rules/foo", "operator keeps custom foo");
	recordOptOut(home, "service:kit-update", "no auto service here");
	const calls: string[][] = [];
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async (argv) => { calls.push([...argv]); return { exit: 0, stdout: serviceEnvelope(true), stderr: "" }; } });
	expect(result.ok).toBe(true);
	expect(result.failed).toEqual([]);
	expect(result.skipped.map((s) => s.item)).toContain("rules:rules");
	expect(result.skipped.map((s) => s.item)).toContain("service:kit-update");
	expect(calls.some((argv) => argv.includes("kit-update"))).toBe(false);
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
});
test("manifest apply ignores an unrelated caller project guard", async () => {
	const { root, home, stateRoot } = fixtureDirs("unrelated-cwd");
	const project = join(base, "unrelated-project");
	mkdirSync(project, { recursive: true });
	symlinkSync(base, join(project, ".omp"));
	const callerDirectory = process.cwd();
	try {
		process.chdir(project);
		const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
			exec: okService(), hookIo: hookIo([]) });
		expect(result.ok, JSON.stringify(result)).toBe(true);
		expect(result.failed).toEqual([]);
	} finally {
		process.chdir(callerDirectory);
	}
});

test("opt-out keeps shared support dependencies untouched", async () => {
	const { root, home, stateRoot } = fixtureDirs("support-optout");
	const entry = 'import { helper } from "../src/helper.ts";\nexport const x = helper;\n';
	const extensions = ["extensions/hello.ts", "extensions/other.ts"];
	const newHelper = "export const helper = 'new';\n";
	mkdirSync(join(root, "src"), { recursive: true });
	for (const name of ["hello.ts", "other.ts"]) writeFileSync(join(root, "extensions", name), entry);
	writeFileSync(join(root, "src", "helper.ts"), newHelper);
	writeFileSync(join(root, "policy", "extensions.json"), JSON.stringify({ extensions: ["hello.ts", "other.ts"], skipProfiles: [] }));
	writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9", omp: { extensions, notLoadedExtensions: {} } }));
	mkdirSync(join(home, ".omp", "omp-extensions"), { recursive: true });
	for (const name of ["hello.ts", "other.ts"]) writeFileSync(join(home, ".omp", "omp-extensions", name), entry);
	recordOptOut(home, "extension:extensions/other.ts", "retain installed extension");

	const result = await applyActivationManifest({
		root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo([]),
	});
	expect(result.ok, JSON.stringify(result)).toBe(true);
	expect(existsSync(join(home, ".omp", "src", "helper.ts"))).toBe(false);
	expect(result.skipped.map(entry => entry.item)).toContain("extensions");
});
test("opt-out prevents relinking an already-installed extension", async () => {
	const { root, home, stateRoot } = fixtureDirs("preinstalled-optout");
	const profile = join(home, ".omp", "agent");
	mkdirSync(profile, { recursive: true });
	const config = join(profile, "config.yml");
	writeFileSync(config, "extensions: []\n");
	const installed = join(home, ".omp", "omp-extensions");
	mkdirSync(installed, { recursive: true });
	writeFileSync(join(installed, "hello.ts"), readFileSync(join(root, "extensions", "hello.ts")));
	recordOptOut(home, "extension:extensions/hello.ts", "keep disabled");

	const result = await applyActivationManifest({
		root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo([]),
	});
	expect(result.ok, JSON.stringify(result)).toBe(true);
	expect(result.failed).toEqual([]);
	expect(result.skipped.map(entry => entry.item)).toContain("extensions");
	expect(readFileSync(config, "utf8")).toBe("extensions: []\n");
});

test("planted: a failing service apply reports FINDINGS, never UPDATED", async () => {
	const { root, home, stateRoot } = fixtureDirs("servicefail");
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async (argv) => argv.includes("kit-update")
			? { exit: 1, stdout: serviceEnvelope(false, [{ code: "BOOTSTRAP_FAILED", message: "synthetic" }]), stderr: "" }
			: { exit: 0, stdout: serviceEnvelope(true), stderr: "" } });
	expect(result.ok).toBe(false);
	expect(result.failed.map((f) => f.item)).toContain("service:kit-update");
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(1);
	expect(out.data["overall"]).toBe("FINDINGS");
	const section = out.data["manifest"];
	expect(section !== null && typeof section === "object" && "status" in section ? section.status : null).toBe("FINDINGS");
});

test("planted: exit 0 with ok:false, exit 1 with ok:true and unparsable output each read as a failed service; the real envelope reads applied", async () => {
	const shapes: [string, { exit: number; stdout: string }][] = [
		["ok-false", { exit: 0, stdout: serviceEnvelope(false) }],
		["exit-1", { exit: 1, stdout: serviceEnvelope(true) }],
		["garbage", { exit: 0, stdout: "not json" }],
		["legacy-code-shape", { exit: 0, stdout: JSON.stringify({ code: 0, data: {} }) }],
	];
	for (const [name, shape] of shapes) {
		const { root, home, stateRoot } = fixtureDirs(`shape-${name}`);
		const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: async () => ({ ...shape, stderr: "" }) });
		expect(result.failed.some((f) => f.item === "service:kit-update"), name).toBe(true);
	}
	const { root, home, stateRoot } = fixtureDirs("shape-real");
	const real = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo([]) });
	expect(real.failed.some((f) => f.item.startsWith("service:"))).toBe(false);
	expect(real.servicesApplied).toContain("kit-update");
});

const refusedService = (code: string) => async (_argv: readonly string[]) => ({ exit: 1, stdout: serviceEnvelope(false, [{ code, message: `${code} synthetic` }]), stderr: "" });
// SERVICESKIP1: the clean-home update used to fail 23 jobs the host never set up and exit 1 with ok:false although the release was installed.
test("a job this host never set up and cannot set up is skipped, not failed, and the envelope stays UPDATED", async () => {
	for (const code of ["LAUNCHER_UNAVAILABLE", "FLEET_ADAPTER_ABSENT", "AUTOCUT_UNCONFIGURED", "LOOP_CLOSE_UNCONFIGURED"]) {
		const { root, home, stateRoot } = fixtureDirs(`never-set-up-${code}`);
		const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: refusedService(code), hookIo: hookIo([]) });
		expect(result.failed, code).toEqual([]);
		expect(result.ok, code).toBe(true);
		const kept = result.skipped.find((s) => s.item === "service:kit-update");
		expect(kept?.reason, code).toContain(code);
		expect(kept?.reason, code).toContain("not installed on this host");
		const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
		expect(out.code, code).toBe(0);
		expect(out.data["overall"], code).toBe("UPDATED");
	}
});
test("planted: the same refusal for a job that IS installed, and any other refusal for a job that is not, stays a failed service", async () => {
	const { root, home, stateRoot } = fixtureDirs("installed-refusal");
	const definition = process.platform === "darwin" ? plistPath(home, serviceLabel("kit-update")) : join(home, ".config", "systemd", "user", "omp-kit-kit-update.service");
	mkdirSync(dirname(definition), { recursive: true });
	writeFileSync(definition, "installed\n");
	const installed = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: refusedService("LAUNCHER_UNAVAILABLE"), hookIo: hookIo([]) });
	expect(installed.failed.map((f) => f.item)).toEqual(["service:kit-update"]);
	expect(installed.failed[0]?.detail).toContain("LAUNCHER_UNAVAILABLE");
	expect(installed.ok).toBe(false);
	for (const code of ["BOOTSTRAP_FAILED", "AUTOCUT_CONFIG_INVALID"]) {
		const fresh = fixtureDirs(`other-refusal-${code}`);
		const other = await applyActivationManifest({ root: fresh.root, home: fresh.home, stateRoot: fresh.stateRoot, binary: "/nonexistent/omp-kit", exec: refusedService(code), hookIo: hookIo([]) });
		expect(other.failed.some((f) => f.item === "service:kit-update"), code).toBe(true);
		expect(other.ok, code).toBe(false);
	}
});

test("SVCDISABLED1: manifest refresh leaves the host-disabled job untouched", async () => {
	const { root, home, stateRoot } = fixtureDirs("launchd-disabled");
	const disabled = plistPath(home, serviceLabel("claude-save"));
	mkdirSync(dirname(disabled), { recursive: true });
	writeFileSync(disabled, "existing disabled plist\n");
	const result = await applyActivationManifest({
		root, home, stateRoot, platform: "darwin", binary: "/nonexistent/omp-kit", hookIo: hookIo([]),
		exec: async (argv) => {
			if (argv[1] === "print-disabled") return { exit: 0, stderr: "", stdout: `
			disabled services = {
				"fixture foreign label line one
fixture foreign label line two" => enabled
				"${serviceLabel("claude-save")}" => disabled
				"${serviceLabel("kit-update")}" => enabled
			}` };
			if (argv[3] === "claude-save") throw new Error("the disabled job must not be installed");
			expect(argv).toContain("--preserve-disabled");
			return { exit: 0, stdout: serviceEnvelope(true), stderr: "" };
		},
	});
	expect(result.failed).toEqual([]);
	expect(result.skipped).toContainEqual({ item: "service:claude-save", reason: "disabled by launchd; left untouched" });
	expect(result.servicesApplied).toContain("kit-update");
	expect(readFileSync(disabled, "utf8")).toBe("existing disabled plist\n");
});

test("SVCUNINSTALLSTICKY1 refresh leaves a job disabled after the initial launchd scan", async () => {
	const { root, home, stateRoot } = fixtureDirs("launchd-late-disable");
	const result = await applyActivationManifest({
		root, home, stateRoot, platform: "darwin", binary: "/nonexistent/omp-kit", hookIo: hookIo([]),
		exec: async (argv) => {
			if (argv[1] === "print-disabled") return { exit: 0, stdout: "disabled services = {}\n", stderr: "" };
			if (argv[3] === "claude-save" && argv.includes("--preserve-disabled")) {
				return { exit: 0, stdout: JSON.stringify({ ok: true, data: { skipped: "disabled" } }), stderr: "" };
			}
			return { exit: 0, stdout: serviceEnvelope(true), stderr: "" };
		},
	});
	expect(result.failed).toEqual([]);
	expect(result.skipped).toContainEqual({ item: "service:claude-save", reason: "disabled by launchd; left untouched" });
	expect(result.servicesApplied).not.toContain("claude-save");
});

// RULESKEEP1: an edited managed rule is kept; the update that installed the release reports it as skipped, not as a failure.
test("a locally edited managed rule is kept untouched and named under skipped; the update is not failed", async () => {
	const { root, home, stateRoot } = fixtureDirs("rules-kept");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "foo.md"), "operator edited foo\n");
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo([]) });
	expect(result.failed).toEqual([]);
	expect(result.ok).toBe(true);
	const kept = result.skipped.find((s) => s.item === "rules:rules");
	expect(kept?.reason).toContain("foo");
	expect(kept?.reason).toContain("migrate --plan");
	expect(readFileSync(join(home, ".agents", "rules", "foo.md"), "utf8")).toBe("operator edited foo\n");
	expect(readFileSync(join(home, ".agents", "rules", "bar.md"), "utf8")).toContain("Bar fleet rule");
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
});
test("planted: a failed relink reports FINDINGS, never UPDATED", async () => {
	const out = updatePostApplyEnvelope(envelopeBase,
		{ ok: false, detail: "synthetic relink break" }, null, "/nonexistent/store");
	expect(out.code).toBe(1);
	expect(out.data["overall"]).toBe("FINDINGS");
	expect(out.data["manifest"]).toBeNull();
	expect(out.errors?.some((e) => e.code === "PLUGIN_RELINK_FAILED")).toBe(true);
});

test("corrupt opt-out record fails the loop without applying", async () => {
	const { root, home, stateRoot } = fixtureDirs("badoptout");
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	writeFileSync(join(home, ".config", "omp-kit", "activation-optouts.json"), "{corrupt");
	let execCalls = 0;
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async () => { execCalls += 1; return { exit: 0, stdout: "{}", stderr: "" }; } });
	expect(result.ok).toBe(false);
	expect(result.failed.map((f) => f.item)).toContain("opt-outs");
	expect(execCalls).toBe(0);
	expect(result.rulesApplied).toBe(0);
});

const MANIFEST_MEMBER = "40-omp-kit-manifest-evidence";
const MANIFEST_OLD = "# manifest evidence old\n";
const MANIFEST_NEW = "# manifest evidence new\n";
const MANIFEST_OWNER = "# owner modified hook\n";
const MANIFEST_ASSERTION = "HOOKMANIFESTEVIDENCE1 retained member evidence";
type ManifestRepoKind = "managed" | "owner" | "never";
type ManifestRepo = { repo: string; dest: string; tracked: boolean; kind: ManifestRepoKind; source: string };

function manifestChildEnv(root: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root, TMP: root, TEMP: root, KITLIB_TMP_ROOT: root,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: root, NO_COLOR: "1" };
}

async function manifestGit(cwd: string, repo: string, args: string[], env: Record<string, string>): Promise<string> {
	const result = await runFixtureAsync(["git", "-C", repo, ...args], { cwd, env, floor_s: 30 });
	const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
	expect(result.rc, output).toBe(0);
	return new TextDecoder().decode(result.stdout).trim();
}

async function prepareManifestRepos(tag: string, env: Record<string, string>, rows: { name: string; tracked: boolean; kind: ManifestRepoKind }[]): Promise<{ repos: ManifestRepo[]; sourceFile: string; before: Map<string, { bytes: string | null; head: string }> }> {
	const dir = join(base, tag);
	mkdirSync(dir, { recursive: true });
	const sourceFile = join(dir, "release-source.sh");
	writeFileSync(sourceFile, MANIFEST_NEW);
	const repos: ManifestRepo[] = [];
	const before = new Map<string, { bytes: string | null; head: string }>();
	for (const row of rows) {
		const repo = join(dir, row.name);
		mkdirSync(repo, { recursive: true });
		await manifestGit(dir, repo, ["init", "-q"], env);
		if (row.tracked) await manifestGit(dir, repo, ["config", "core.hooksPath", ".githooks"], env);
		const hooks = row.tracked ? join(repo, ".githooks") : join(repo, ".git", "hooks");
		const dest = join(hooks, MANIFEST_MEMBER);
		const bytes = row.kind === "never" ? null : row.kind === "owner" ? MANIFEST_OWNER : MANIFEST_OLD;
		if (bytes !== null) {
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, bytes);
		}
		if (row.tracked) await manifestGit(dir, repo, ["add", "--", ".githooks"], env);
		await manifestGit(dir, repo, ["-c", "user.name=ManifestFixture", "-c", "user.email=manifest@example.invalid",
			"commit", "-q", "--allow-empty", "-m", "owned manifest hook fixture"], env);
		before.set(repo, { bytes, head: await manifestGit(dir, repo, ["rev-parse", "HEAD"], env) });
		repos.push({ repo, dest, tracked: row.tracked, kind: row.kind, source: `owned:${tag}` });
	}
	return { repos, sourceFile, before };
}

/** Real owned-filesystem HookRefreshIo: the existing refreshFleetHooks producer reads real git dirs, real digests and real file copies. */
function manifestHookIo(repos: ManifestRepo[], sourceFile: string): HookRefreshIo {
	const byRepo = new Map(repos.map((row) => [resolve(row.repo), row]));
	const selected = (repo: string): ManifestRepo => {
		const row = byRepo.get(resolve(repo));
		if (!row) throw new Error("manifest fixture rejects a foreign repository");
		return row;
	};
	const digest = (path: string): string | null => existsSync(path) ? sha(readFileSync(path)) : null;
	const hasKitMembers = (dir: string): boolean => {
		const stack = [dir];
		while (stack.length > 0) {
			const current = stack.pop()!;
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				if (entry.isDirectory()) stack.push(join(current, entry.name));
				else if (entry.name.startsWith("40-omp-kit-") || entry.name.startsWith("41-omp-kit-")) return true;
			}
		}
		return false;
	};
	return {
		repos: () => [],
		kitRoot: () => "/nonexistent-kit",
		digest,
		hooksDir: (repo: string) => {
			const row = selected(repo);
			return { dir: row.tracked ? join(row.repo, ".githooks") : join(row.repo, ".git", "hooks"), config: null, tracked: row.tracked };
		},
		check: async (repo: string) => {
			const { dest } = selected(repo);
			return existsSync(dest) && readFileSync(dest).equals(readFileSync(sourceFile))
				? { rc: 0, output: "" }
				: { rc: 3, output: `install-commit-msg-bead: STALE installed member: ${dest} differs from ${sourceFile}; rerun install-commit-msg-bead.sh\n` };
		},
		hasKitMembers,
		pullRepos: () => repos.map((row) => ({ repo: row.repo, source: row.source })),
		runInstaller: (repo: string) => {
			const { dest } = selected(repo);
			if (!existsSync(dest) || readFileSync(dest, "utf8") !== MANIFEST_OLD)
				return { ok: false, detail: "owned installer refuses an owner-modified postimage" };
			copyFileSync(sourceFile, dest);
			return { ok: true, detail: "owned filesystem member copied" };
		},
	};
}

test("HOOKMANIFESTEVIDENCE1: refreshed and never-enrolled member outcomes survive the manifest and update envelopes", async () => {
	const env = manifestChildEnv(base);
	const { repos, sourceFile, before } = await prepareManifestRepos("manifest-untracked", env, [
		{ name: "enrolled repo", tracked: false, kind: "managed" },
		{ name: "never enrolled", tracked: false, kind: "never" },
	]);
	const { root, home, stateRoot } = fixtureDirs("manifest-untracked-activation");
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: okService(), hookIo: manifestHookIo(repos, sourceFile) });
	expect(result.ok, JSON.stringify(result)).toBe(true);
	expect([result.hooksRefreshed, result.hooksRepos, result.hooksFailed]).toEqual([1, 2, 0]);
	expect(result.hooksResults.map((row) => row.repo).sort()).toEqual(repos.map((row) => resolve(row.repo)).sort());
	const managed = result.hooksResults.find((row) => row.repo === resolve(repos[0]!.repo))!;
	expect(managed, MANIFEST_ASSERTION).toMatchObject({ source: repos[0]!.source, status: "REFRESHED",
		members: [{ member: MANIFEST_MEMBER, before_sha256: sha(MANIFEST_OLD), after_sha256: sha(MANIFEST_NEW), refreshed: true }],
		paths: [repos[0]!.dest] });
	const never = result.hooksResults.find((row) => row.repo === resolve(repos[1]!.repo))!;
	expect(never, MANIFEST_ASSERTION).toMatchObject({ source: repos[1]!.source, status: "FRESH", members: [], paths: [] });
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, receiptId: "r-manifest", detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
	const section = out.data["manifest"] as { status: string; hooks_refreshed: number; hooks_repos: number; hooks_failed: number; hooks_results: unknown };
	expect(section.status).toBe("APPLIED");
	expect([section.hooks_refreshed, section.hooks_repos, section.hooks_failed]).toEqual([1, 2, 0]);
	expect(section.hooks_results, MANIFEST_ASSERTION).toEqual(result.hooksResults);
	expect(JSON.parse(JSON.stringify(section.hooks_results)), MANIFEST_ASSERTION).toEqual(result.hooksResults);
	expect(readFileSync(repos[0]!.dest, "utf8")).toBe(MANIFEST_NEW);
	expect(existsSync(repos[1]!.dest)).toBe(false);
	for (const row of repos)
		expect(await manifestGit(join(base, "manifest-untracked"), row.repo, ["rev-parse", "HEAD"], env)).toBe(before.get(row.repo)!.head);
}, fixtureDeadlineS(60) * 1000);

test("HOOKMANIFESTEVIDENCE1: tracked pending-commit and failed owner outcomes survive the manifest and update envelopes", async () => {
	const env = manifestChildEnv(base);
	const { repos, sourceFile, before } = await prepareManifestRepos("manifest-tracked", env, [
		{ name: "tracked repo", tracked: true, kind: "managed" },
		{ name: "owner modified", tracked: false, kind: "owner" },
		{ name: "never enrolled", tracked: false, kind: "never" },
	]);
	const { root, home, stateRoot } = fixtureDirs("manifest-tracked-activation");
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: okService(), hookIo: manifestHookIo(repos, sourceFile) });
	expect(result.ok, JSON.stringify(result)).toBe(false);
	expect([result.hooksRefreshed, result.hooksRepos, result.hooksFailed]).toEqual([0, 3, 1]);
	expect(result.failed.map((entry) => entry.item)).toContain("hooks");
	const tracked = result.hooksResults.find((row) => row.repo === resolve(repos[0]!.repo))!;
	expect(tracked, MANIFEST_ASSERTION).toMatchObject({ source: repos[0]!.source, status: "PENDING_COMMIT", tracked: true,
		members: [{ member: MANIFEST_MEMBER, before_sha256: sha(MANIFEST_OLD), after_sha256: sha(MANIFEST_NEW), refreshed: true }],
		paths: [repos[0]!.dest] });
	const owner = result.hooksResults.find((row) => row.repo === resolve(repos[1]!.repo))!;
	expect(owner, MANIFEST_ASSERTION).toMatchObject({ source: repos[1]!.source, status: "FAILED", members: [] });
	expect(owner.detail).toContain("refuses");
	expect(readFileSync(repos[1]!.dest, "utf8")).toBe(MANIFEST_OWNER);
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(1);
	expect(out.data["overall"]).toBe("FINDINGS");
	const section = out.data["manifest"] as { status: string; hooks_refreshed: number; hooks_repos: number; hooks_failed: number; hooks_results: unknown };
	expect(section.status).toBe("FINDINGS");
	expect([section.hooks_refreshed, section.hooks_repos, section.hooks_failed]).toEqual([0, 3, 1]);
	expect(section.hooks_results, MANIFEST_ASSERTION).toEqual(result.hooksResults);
	expect(JSON.parse(JSON.stringify(section.hooks_results)), MANIFEST_ASSERTION).toEqual(result.hooksResults);
	expect(readFileSync(repos[0]!.dest, "utf8")).toBe(MANIFEST_NEW);
	for (const row of repos)
		expect(await manifestGit(join(base, "manifest-tracked"), row.repo, ["rev-parse", "HEAD"], env)).toBe(before.get(row.repo)!.head);
}, fixtureDeadlineS(60) * 1000);

test("HOOKMANIFESTEVIDENCE1_MUTANT: losing only member retention fails the unchanged envelope consumers", async () => {
	const scratch = ownedTmp("hook-manifest-retention-mutant");
	try {
		const target = realpathSync(join(import.meta.dir, "../../src/activation.ts"));
		const preload = join(scratch.path, "drop-member-results.ts");
		const loaded = join(scratch.path, "mutant-loaded");
		writeFileSync(preload, `
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const target = ${JSON.stringify(target)};
const loaded = ${JSON.stringify(loaded)};
Bun.plugin({ name: "hook-manifest-member-retention-only", setup(builder) {
	builder.onLoad({ filter: /activation\\.ts$/ }, args => {
		if (realpathSync(args.path) !== target) return;
		const source = readFileSync(target, "utf8");
		const needle = "hooksReport = report;";
		if (source.split(needle).length !== 3) throw new Error("hook retention mutant site is not unique");
		writeFileSync(loaded, "member-results-removed");
		return { contents: source.split(needle).join(""), loader: "ts", resolveDir: dirname(target) };
	});
}});
`);
		const argv = [process.execPath, "--no-env-file", "test", join(import.meta.dir, "activation-apply.test.ts"), "-t", "^HOOKMANIFESTEVIDENCE1:"];
		const env = manifestChildEnv(scratch.path);
		const healthy = await runFixtureAsync(argv, { cwd: scratch.path, env, floor_s: 180 });
		const healthyOutput = new TextDecoder().decode(healthy.stdout) + new TextDecoder().decode(healthy.stderr);
		expect(healthy.rc, healthyOutput).toBe(0);
		expect(healthyOutput).toContain("2 pass");
		const mutant = await runFixtureAsync([...argv.slice(0, 3), "--preload", preload, ...argv.slice(3)], { cwd: scratch.path, env, floor_s: 180 });
		const mutantOutput = new TextDecoder().decode(mutant.stdout) + new TextDecoder().decode(mutant.stderr);
		expect(mutant.rc, mutantOutput).toBe(1);
		expect(existsSync(loaded), mutantOutput).toBe(true);
		expect(readFileSync(loaded, "utf8")).toBe("member-results-removed");
		expect(mutantOutput).toContain(MANIFEST_ASSERTION);
		expect(mutantOutput).toContain("2 fail");
		console.log("HOOKMANIFESTEVIDENCE1_MUTANT_WITNESS " + JSON.stringify({
			healthy_rc: healthy.rc, mutant_rc: mutant.rc,
			retained_member_assertion_failed: mutantOutput.includes(MANIFEST_ASSERTION),
			two_original_consumers_failed: mutantOutput.includes("2 fail"),
		}));
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(600) * 1000);
