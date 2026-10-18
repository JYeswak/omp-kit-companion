import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "observe-bindings-"));
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

test("witness bindings hash the exact runtime, launcher and native addon bytes", () => {
	const identity = resolveOmpIdentity(process.env);
	const rules = join(scratch, "rules");
	const cases = join(scratch, "cases.tsv");
	mkdirSync(rules, { recursive: true });
	writeFileSync(join(rules, "external-binding.md"), "---\ncondition: 'BINDING_KEY'\nscope: text\ninterruptMode: never\n---\nBinding witness.\n");
	writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nexternal-binding\tfire\ttext\t-\t-\tBINDING_KEY\tbinding\n");
	const result = Bun.spawnSync([process.execPath, join(REPO_ROOT, "scripts", "ttsr-harness.ts"), "--observe", "--rules", rules, "--cases", cases, "--rule", "external-binding", "--line", "2"], { cwd: REPO_ROOT, env: { ...process.env, OMP_SRC: identity.source, OMP_BIN: identity.launcher }, stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode).toBe(0);
	const { bindings } = JSON.parse(result.stdout.toString());
	const digest = (...parts: Uint8Array[]) => parts.reduce((hash, part) => hash.update(part), createHash("sha256")).digest("hex");
	expect(bindings.harness_runtime_sha256).toBe(digest(readFileSync(process.execPath)));
	expect(bindings.omp_launcher_sha256).toBe(digest(readFileSync(bindings.omp_launcher)));
	const matcher = join(identity.source, "export/ttsr.ts");
	const nativeRoot = resolve(dirname(Bun.resolveSync("@oh-my-pi/pi-natives", matcher)), "..");
	const platformManifest = Bun.resolveSync("@oh-my-pi/pi-natives-" + process.platform + "-" + process.arch + "/package.json", matcher);
	const platformRoot = dirname(platformManifest);
	const addons = readdirSync(platformRoot).filter(file => file.endsWith(".node")).sort();
	const nativeParts = [join(nativeRoot, "package.json"), join(nativeRoot, "native/loader-state.js"), platformManifest, ...addons.map(file => join(platformRoot, file))]
		.flatMap(file => [Buffer.from(file.slice(file.lastIndexOf("/") + 1)), readFileSync(file)]);
	expect(bindings.native_sha256).toBe(digest(...nativeParts));
});
