import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { checkExtensionImports, extractImportSpecifiers } from "../../src/extensions.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

let base = "";
let binary = "";
let environment: Record<string, string>;

function mkhome(name: string): string {
	const home = join(base, name);
	mkdirSync(join(home, ".omp", "profiles", "codex", "agent", "hooks", "post"), { recursive: true });
	return home;
}

function writeHook(home: string, body: string): string {
	const path = join(home, ".omp", "profiles", "codex", "agent", "hooks", "post", "hook.ts");
	writeFileSync(path, body);
	return path;
}



beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "omp-kit-extensions-"));
	const release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	for (const directory of [join(release, "bin"), join(release, "scripts"), join(base, "home")]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	environment = {
		HOME: join(base, "home"), TMPDIR: join(base, "tmp"), TMP: join(base, "tmp"), TEMP: join(base, "tmp"),
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

type ExtensionsEnvelope = {
	data?: {
		overall?: string;
		findings?: { component?: string; status?: string; reason?: string; evidence?: {
			findings?: { profile?: string; kind?: string; file?: string; line?: number; specifier?: string }[];
			files_checked?: number;
		} }[];
	};
	errors?: { code?: string }[];
};

function runDoctor(home: string): { exitCode: number; envelope: ExtensionsEnvelope } {
	const child = Bun.spawnSync([binary, "doctor", "--scope", "extensions", "--json"], {
		cwd: home, env: { ...environment, HOME: home }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as ExtensionsEnvelope };
}

function extensionsOf(envelope: ExtensionsEnvelope) {
	const finding = (envelope.data?.findings ?? []).find((item) => item.component === "extension_imports");
	return { finding, importFindings: finding?.evidence?.findings ?? [] };
}

test("hardlinked hook with a relative import is DEGRADED naming file, line and specifier", () => {
	const home = mkhome("broken");
	const origin = writeHook(home, 'import { helper } from "./jev-only-relative-helper";\nexport const run = (): string => helper();\n');
	const linked = join(home, ".omp", "profiles", "codex", "agent", "hooks", "post", "hook-linked.ts");
	linkSync(origin, linked);
	const { exitCode, envelope } = runDoctor(home);
	expect(exitCode).toBe(0);
	const { finding, importFindings } = extensionsOf(envelope);
	expect(finding?.status).toBe("DEGRADED");
	expect(finding?.reason).toContain("jev-only-relative-helper");
	const hit = importFindings.find((item) => item.specifier === "./jev-only-relative-helper");
	expect(hit).toMatchObject({ profile: "codex", kind: "hook-post", line: 1 });
	expect(hit?.file?.endsWith("hook.ts") || hit?.file?.endsWith("hook-linked.ts")).toBe(true);
}, 120_000);

test("resolved absolute import is OK", () => {
	const home = mkhome("fixed");
	const lib = join(home, ".omp", "profiles", "codex", "agent", "hooks", "post", "lib.ts");
	writeFileSync(lib, "export const helper = (): string => \"ok\";\n");
	writeHook(home, `import { helper } from ${JSON.stringify(lib)};\nexport const run = (): string => helper();\n`);
	const { envelope } = runDoctor(home);
	const { finding, importFindings } = extensionsOf(envelope);
	expect(importFindings).toEqual([]);
	expect(finding?.status).toBe("OK");
}, 120_000);

test("imported modules are never executed", () => {
	const home = mkhome("sideeffect");
	const marker = join(home, "executed-by-import");
	const lib = join(home, ".omp", "profiles", "codex", "agent", "hooks", "post", "loud.ts");
	writeFileSync(lib, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const x = 1;\n`);
	writeHook(home, `import { x } from ${JSON.stringify(lib)};\nexport const run = (): number => x;\n`);
	const { envelope } = runDoctor(home);
	expect(extensionsOf(envelope).importFindings).toEqual([]);
	expect(existsSync(marker)).toBe(false);
}, 120_000);

test("unresolvable bare specifier is named with its line", () => {
	const home = mkhome("bare");
	const path = writeHook(home, 'import { a } from "node:fs";\nimport { b } from "no-such-package-omp-kit-verify";\nexport const run = [a, b];\n');
	const report = checkExtensionImports({ home });
	expect(report.status).toBe("DEGRADED");
	expect(report.findings).toEqual([{ profile: "codex", kind: "hook-post", file: path, line: 2,
		specifier: "no-such-package-omp-kit-verify", detail: "unresolvable from the file's directory" }]);
}, 120_000);

test("unresolvable type-only imports are ignored", () => {
	const specs = extractImportSpecifiers('import type { Missing } from "./missing-type";\nimport { ok } from "node:fs";\nexport type { Gone } from "./missing-type-too";\n');
	expect(specs.map((item) => item.specifier)).toEqual(["node:fs"]);
}, 120_000);

test("multiline import attributes the specifier to the from-line", () => {
	const specs = extractImportSpecifiers('import {\n\ta,\n\tb,\n} from "no-such-package-omp-kit-verify";\n');
	expect(specs).toEqual([{ specifier: "no-such-package-omp-kit-verify", line: 4 }]);
}, 120_000);

test("plugin package extension with a bad import is flagged under the package", () => {
	const home = mkhome("plugin");
	const pkg = join(home, ".omp", "plugins", "node_modules", "fixture-pkg");
	mkdirSync(join(pkg, "extensions"), { recursive: true });
	const entry = join(pkg, "extensions", "guard.ts");
	writeFileSync(entry, 'import { x } from "./missing-guard-dep";\nexport const y = x;\n');
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-pkg", version: "0.0.1",
		omp: { name: "fixture-pkg", version: "0.0.1" }, extensions: ["extensions/guard.ts"] }));
	const report = checkExtensionImports({ home });
	expect(report.status).toBe("DEGRADED");
	expect(report.findings).toEqual([{ profile: "plugin:fixture-pkg", kind: "plugin-extension", file: entry, line: 1,
		specifier: "./missing-guard-dep", detail: "unresolvable from the file's directory" }]);
	expect(report.plugin_packages).toEqual(["fixture-pkg"]);
}, 120_000);

test("a HOME with no extension or hook files is UNVERIFIED, never OK", () => {
	const report = checkExtensionImports({ home: mkhome("empty") });
	expect(report.status).toBe("UNVERIFIED");
	expect(report.files_checked).toBe(0);
}, 120_000);
