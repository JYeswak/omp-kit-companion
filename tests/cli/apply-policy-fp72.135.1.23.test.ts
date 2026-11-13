import { afterAll, afterEach, expect } from "bun:test";
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { cleanupCompiledFixture, cleanupPolicyFixtures, compiledFixture, fixture, nativeTest, nativeTestEnv } from "./apply-policy.helpers.ts";
import { runFixture } from "./fixture-process.ts";

afterEach(cleanupPolicyFixtures);
afterAll(cleanupCompiledFixture);

// OUTSIDERPOLICY1 (ompkit-fp72.135.1.23): on a fresh HOME the third outsider
// journey's first `apply policy --plan` exited 2 with UNVERIFIED_PROFILE for a
// profile whose agent directory existed but whose config file did not exist
// yet, while an immediate retry exited 0 with a 3-step PLAN. Root cause: the
// native `omp config get` layer materializes profile files on first access
// while the kit is reading them, so the post-read staleness guards mistook
// the just-created config for a mid-read change. The kit now primes one key
// and re-snapshots before the verified read, and plans against the files the
// read was verified against. The fake omp below reproduces the journey era:
// it resolves the profile directory from a baked base (as an omp that honors
// the passwd home instead of $HOME would) and writes default config.yml on
// the first get for a profile that has none. It only speaks the five TTSR
// keys with scalar-or-[] YAML values, which is all these tests need.
function fakeOmpPackage(workspace: string, mode: "materialize" | "fail", profileBase: string): string {
	const pkg = join(workspace, "fakeomp");
	mkdirSync(join(pkg, "src", "export"), { recursive: true });
	mkdirSync(join(pkg, "src", "capability"), { recursive: true });
	mkdirSync(join(pkg, "src", "discovery"), { recursive: true });
	mkdirSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	mkdirSync(join(pkg, "bin"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.19.0" }));
	writeFileSync(join(pkg, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	for (const file of ["src/export/ttsr.ts", "src/capability/rule.ts", "src/discovery/helpers.ts"])
		writeFileSync(join(pkg, file), "export {};\n");
	const launcher = join(pkg, "bin", "omp");
	const onGet = mode === "fail"
		? "\tprintf 'native config unavailable\\n' >&2; exit 1"
		: "\tif [ ! -f \"$CFG\" ]; then\n"
		+ "\t\tmkdir -p \"$DIR\" || exit 2\n"
		+ "\t\tprintf 'model: owned-by-user\\nttsr:\\n  enabled: true\\n  repeatMode: once\\n  repeatGap: 5\\n  contextMode: discard\\n  disabledRules: []\\n' > \"$CFG\" || exit 2\n"
		+ "\tfi\n"
		+ "\tRAW=$(awk -v k=\"$SHORT\" '/^ttsr:/{t=1;next}/^[^[:space:]]/{t=0}(t==1){line=$0;sub(/^  /,\"\",line);p=index(line,\":\");if(p>0&&substr(line,1,p-1)==k){print substr(line,p+2);exit}}' \"$CFG\")\n"
		+ "\tcase \"$RAW\" in\n"
		+ "\t\ttrue|false) JSONVAL=\"$RAW\";;\n"
		+ "\t\t\"\") exit 2;;\n"
		+ "\t\t\"[]\") JSONVAL=\"[]\";;\n"
		+ "\t\t[0-9]*)\n"
		+ "\t\t\tcase \"$RAW\" in *[!0-9.]*) JSONVAL=\"\\\"$RAW\\\"\";; *) JSONVAL=\"$RAW\";; esac;;\n"
		+ "\t\t*) JSONVAL=\"\\\"$RAW\\\"\";;\n"
		+ "\tesac\n"
		+ "\tprintf '{\"key\":\"%s\",\"value\":%s}\\n' \"$KEY\" \"$JSONVAL\"\n"
		+ "\texit 0";
	writeFileSync(launcher, "#!/bin/sh\n"
		+ `BASE=${JSON.stringify(profileBase)}\n`
		+ "PROFILE=default\n"
		+ "if [ \"$1\" = \"--profile\" ]; then PROFILE=\"$2\"; shift 2; fi\n"
		+ "if [ \"$1\" = \"--version\" ]; then printf 'omp/18.19.0\\n'; exit 0; fi\n"
		+ "if [ \"$1\" != \"config\" ]; then exit 2; fi\n"
		+ "OP=\"$2\"; KEY=\"$3\"\n"
		+ "case \"$KEY\" in\n"
		+ "\tttsr.enabled|ttsr.repeatMode|ttsr.repeatGap|ttsr.contextMode|ttsr.disabledRules) ;;\n"
		+ "\t*) exit 2;;\n"
		+ "esac\n"
		+ "SHORT=\"${KEY#ttsr.}\"\n"
		+ "if [ \"$PROFILE\" = \"default\" ]; then DIR=\"$BASE/.omp/agent\"; else DIR=\"$BASE/.omp/profiles/$PROFILE/agent\"; fi\n"
		+ "CFG=\"$DIR/config.yml\"\n"
		+ "if [ \"$OP\" = \"get\" ]; then\n"
		+ "\tif [ \"$4\" != \"--json\" ]; then exit 2; fi\n"
		+ `${onGet}\n`
		+ "fi\n"
		+ "exit 2\n");
	chmodSync(launcher, 0o755);
	return launcher;
}

// The CLI resolves the release root from the running binary, so the plan runs
// against a fixture release (rules, policy, manifest) exactly like the
// compiled-binary policy tests; a checkout MANIFEST.tsv is generated, never
// exported, so running src/cli.ts from the repo root is not export-safe.
function fixtureRelease(workspace: string, root: string): string {
	const release = join(workspace, "release-kit");
	mkdirSync(join(release, "bin"), { recursive: true });
	for (const directory of ["rules", "retired", "policy"]) cpSync(join(root, directory), join(release, directory), { recursive: true });
	cpSync(join(root, "MANIFEST.tsv"), join(release, "MANIFEST.tsv"));
	return release;
}

async function planBinary(release: string): Promise<string> {
	const binary = join(release, "bin", "omp-kit");
	const compiled = await compiledFixture(binary, dirname(release));
	expect(compiled.exitCode, Buffer.from(compiled.stdout).toString() + Buffer.from(compiled.stderr).toString()).toBe(0);
	return binary;
}

function planOnce(binary: string, project: string, env: Record<string, string | undefined>) {
	const result = runFixture([binary, "apply", "policy", "--plan", "--json"],
		{ cwd: project, env, floor_s: 60, label: "outsiderpolicy1-plan" });
	const output = Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString();
	return { rc: result.rc, output, envelope: JSON.parse(Buffer.from(result.stdout).toString()) as {
		data: { action: string; profiles: string[]; steps: { key: string }[] };
		errors?: { code: string; message: string; remediation: string }[];
	} };
}

nativeTest("OUTSIDERPOLICY1: first apply policy plan succeeds when the native layer materializes the profile mid-read", async () => {
	const f = fixture();
	mkdirSync(join(f.home, ".omp", "profiles", "claude", "agent"), { recursive: true, mode: 0o700 });
	const launcher = fakeOmpPackage(f.workspace, "materialize", f.home);
	const binary = await planBinary(fixtureRelease(f.workspace, f.root));
	const base = nativeTestEnv(f.home);
	const first = planOnce(binary, f.project, { ...base, PATH: [dirname(launcher), base.PATH].join(delimiter) });
	expect(first.rc, first.output).toBe(0);
	expect(first.envelope.data.action).toBe("PLAN");
	expect(first.envelope.data.profiles).toEqual(["claude"]);
	expect(first.envelope.data.steps.map(step => step.key)).toEqual(["ttsr.repeatMode", "ttsr.repeatGap", "ttsr.contextMode"]);
});

nativeTest("OUTSIDERPOLICY1 (planted negative): a profile the native read truly cannot verify still refuses naming the cause", async () => {
	const f = fixture();
	mkdirSync(join(f.home, ".omp", "profiles", "claude", "agent"), { recursive: true, mode: 0o700 });
	const launcher = fakeOmpPackage(f.workspace, "fail", f.home);
	const binary = await planBinary(fixtureRelease(f.workspace, f.root));
	const base = nativeTestEnv(f.home);
	const refused = planOnce(binary, f.project, { ...base, PATH: [dirname(launcher), base.PATH].join(delimiter) });
	expect(refused.rc, refused.output).toBe(2);
	const error = refused.envelope.errors?.[0];
	expect(error?.code).toBe("UNVERIFIED_PROFILE");
	expect(error?.message).toContain("claude");
	expect(error?.message).toContain("NATIVE_CONFIG_UNAVAILABLE");
	expect(error?.remediation).toContain("omp --profile claude config get ttsr.enabled --json");
});
