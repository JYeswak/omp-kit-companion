// Coverage: src/apply-policy.ts, src/cli.ts, src/paths.ts, src/omp-source-cache.ts, tests/cli/profile-fixture.ts
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
import { delimiter, dirname, join, resolve } from "node:path";
import { YAML } from "bun";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { cachedOmpPackage, ompSourceCacheRoot } from "../../src/omp-source-cache.ts";
import { writeProfileConfig } from "./profile-fixture.ts";

const nativeIdentity = resolveOmpIdentity();
export const nativeOmp = nativeIdentity.launcher;
const nativeVersion: unknown = JSON.parse(readFileSync(join(nativeIdentity.packageRoot, "package.json"), "utf8")).version;
const nativeSourceCache = typeof nativeVersion === "string" && cachedOmpPackage(nativeVersion, process.env) === nativeIdentity.packageRoot
	? ompSourceCacheRoot(process.env) : null;
const fixtures: string[] = [];
export const nativeTest = (name: string, body: () => void | Promise<void>) => test(name, body, 120_000);
let compiled: { path: string; result: { exitCode: number | null; stdout: Buffer; stderr: Buffer } } | undefined;
let compiledRoot: string | undefined;
export async function compiledFixture(binary: string, cwd: string) {
	if (!compiled) {
		compiledRoot = ownedTmp("policy-compiled", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
		const path = join(compiledRoot, "omp-kit");
		const result = await run([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
			resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", path], { cwd, deadline_s: 120 });
		compiled = { path, result: { exitCode: result.rc, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) } };
	}
	if (compiled.result.exitCode === 0) copyFileSync(compiled.path, binary, constants.COPYFILE_FICLONE);
	return compiled.result;
}
export function cleanupPolicyFixtures() {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
}
export function cleanupCompiledFixture() {
	if (compiledRoot) rmSync(compiledRoot, { recursive: true, force: true });
	compiled = undefined;
	compiledRoot = undefined;
}
type NativeConfigResult = { code: number | null; stdout: string; stderr: string };
export function nativeTestEnv(home: string): Record<string, string> {
	const tmp = join(home, "tmp"), bin = join(home, "bin");
	mkdirSync(tmp, { recursive: true, mode: 0o700 });
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	const launcher = join(bin, "omp");
	if (!existsSync(launcher)) symlinkSync(nativeOmp, launcher);
	const env: Record<string, string> = {
		HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
		XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_CACHE_HOME: join(home, "xdg-cache"),
		XDG_DATA_HOME: join(home, "xdg-data"), XDG_STATE_HOME: join(home, "xdg-state"),
		PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"), NO_COLOR: "1", TERM: "dumb",
	};
	if (nativeSourceCache) {
		env.OMP_KIT_OMP_SRC_CACHE = nativeSourceCache;
		env.OMP_KIT_OMP_SRC_FETCH = "0";
	}
	return env;
}
function runNativeConfig(home: string, project: string, profile: string, args: string[]): NativeConfigResult {
	const selected = profile === "default" ? [] : ["--profile", profile];
	const child = runSync([nativeOmp, ...selected, "config", ...args], {
		cwd: project, env: nativeTestEnv(home), deadline_s: 30,
	});
	return { code: child.rc, stdout: Buffer.from(child.stdout).toString(), stderr: Buffer.from(child.stderr).toString() };
}
export function setNativeValue(home: string, project: string, profile: string, key: string, value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const result = runNativeConfig(home, project, profile, ["set", key, text, "--json"]);
	if (result.code !== 0) throw new Error(`OMP config set failed for ${profile}/${key}: rc=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`);
}
export function nativeConfigValue(home: string, project: string, profile: string, key: string): unknown {
	const result = runNativeConfig(home, project, profile, ["get", key, "--json"]);
	if (result.code !== 0) throw new Error(`OMP config get failed for ${profile}/${key}: rc=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`);
	const value: unknown = JSON.parse(result.stdout);
	if (!value || typeof value !== "object" || !("key" in value) || value.key !== key || !("value" in value))
		throw new Error(`OMP config get returned invalid JSON for ${profile}/${key}`);
	return value.value;
}
export function seedProfile(home: string, name: string, values: Record<string, unknown>): string {
	return writeProfileConfig(home, name, YAML.stringify({ model: "owned-by-user", ttsr: values }), 0o600);
}
export const policyValues = { enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] };
export function fixture(options: { legacyRules?: boolean } = {}) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	const workspace = ownedTmp("p12-policy-native", { root: base }).path;
	fixtures.push(workspace);
	const root = join(workspace, "release"), home = join(workspace, "home"), project = join(workspace, "project");
	const body = "# Managed\nDo not leak secrets.\n";
	const digest = createHash("sha256").update(body).digest("hex");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(join(root, "policy"));
	if (options.legacyRules !== false) {
		const legacyRules = join(home, ".agents", "rules");
		mkdirSync(legacyRules, { recursive: true });
		writeFileSync(join(legacyRules, "managed.md"), body);
	}
	mkdirSync(project);
	writeFileSync(join(root, "rules", "managed.md"), body);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nmanaged\t${digest}\talways\taaaaaaa\n`);
	writeFileSync(join(root, "policy", "ttsr.json"), JSON.stringify(policyValues));
	return { workspace, root, home, project, input: { root, home, project, ompPath: nativeOmp, stateRoot: join(home, ".local", "state", "omp-kit") } };
}
