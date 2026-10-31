import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const member = join(repoRoot, "scripts", "check-staged-pysafe.sh");
const roots: OwnedTmp[] = [];
const decoder = new TextDecoder();
afterEach(() => { for (const root of roots.splice(0)) root.cleanup(); });

async function stagedFixture() {
	const owned = ownedTmp("pysafe-inline");
	roots.push(owned);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CEILING_DIRECTORIES = owned.path;
	env.TMPDIR = owned.path;
	const options = { cwd: owned.path, env, floor_s: 30 };
	const initialized = await runFixtureAsync(["git", "init", "-q"], options);
	if (initialized.rc !== 0) throw new Error(decoder.decode(initialized.stderr));
	return {
		path: owned.path,
		async stage(name: string, source: string) {
			writeFileSync(join(owned.path, name), source);
			const added = await runFixtureAsync(["git", "add", "--", name], options);
			if (added.rc !== 0) throw new Error(decoder.decode(added.stderr));
		},
		async judge() {
			const result = await runFixtureAsync(["sh", member], options);
			return { rc: result.rc, text: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
		},
	};
}

const unsafePython = "import subprocess\nsubprocess.run(['true'])\n";
const boundedPython = "import pysafe\npysafe.run_bounded(['true'], 1)\n";

function heredoc(source: string): string {
	return "python3 - <<'PY'\n" + source + "PY\n";
}

test("PYGATE2 judges staged quoted Python heredocs, not a repaired worktree, and admits the bounded control", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("worker.sh", heredoc(unsafePython));
	writeFileSync(join(fixture.path, "worker.sh"), heredoc(boundedPython));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("worker.sh:3:");
	expect(refused.text).toContain("subprocess-no-timeout");
	await fixture.stage("worker.sh", heredoc(boundedPython));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test("PYGATE2 judges python -c without executing its payload", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("worker.sh", "python3 -c 'import subprocess; subprocess.run([\"true\"])'\n");
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("worker.sh:1:");
	expect(refused.text).toContain("subprocess-no-timeout");
	await fixture.stage("worker.sh", "python3 -c 'open(\"must-not-run\", \"w\").write(\"sentinel\")'\n");
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
	expect(existsSync(join(fixture.path, "must-not-run"))).toBe(false);
});

test("PYGATE2 follows executable TypeScript argv literals while leaving Python-looking data inert", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("worker.ts", [
		'import { run } from "./kitlib/run.ts";',
		"await run([\"python3\", \"-c\", " + JSON.stringify(unsafePython) + "], { deadline_s: 1 });",
	].join("\n"));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("worker.ts:2:");
	expect(refused.text).toContain("subprocess-no-timeout");
	await fixture.stage("worker.ts", [
		'import { run } from "./kitlib/run.ts";',
		"const example = " + JSON.stringify(heredoc(unsafePython)) + ";",
		"await run([\"python3\", \"-c\", " + JSON.stringify(boundedPython) + "], { deadline_s: 1 });",
	].join("\n"));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test("PYGATE2 preserves escaped shell quotes and trailing command boundaries", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("quoted.sh", 'python3 -c "import subprocess; subprocess.run([\\"true\\"])"; printf done\\n\n');
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("quoted.sh:1:");
	expect(refused.text).toContain("subprocess-no-timeout");
});

test("PYGATE2 follows an aliased typed runner through a literal shell heredoc", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("nested.ts", [
		'import { run as bounded } from "./kitlib/run.ts";',
		"await bounded([\"sh\", \"-c\", " + JSON.stringify(heredoc(unsafePython)) + "], { deadline_s: 1 });",
	].join("\n"));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("nested.ts:2:");
	expect(refused.text).toContain("subprocess-no-timeout");
});

test("PYGATE2 refuses unresolved Python payloads without rejecting unrelated dynamic argv", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("dynamic.ts", [
		'import { run } from "./kitlib/run.ts";',
		"await run([\"python3\", \"-c\", process.env.PYTHON_CODE], { deadline_s: 1 });",
	].join("\n"));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("parse-error");
	await fixture.stage("dynamic.ts", [
		'import { run } from "./kitlib/run.ts";',
		"await run([\"git\", \"show\", `HEAD:${process.env.FILE}`], { deadline_s: 1 });",
	].join("\n"));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test("PYGATE2 rejects Python prefix-plus-junk while leaving a non-Python heredoc inert", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("whole.sh", "python3 - <<'PY'\npass\n@\nPY\n");
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("parse-error");
	await fixture.stage("whole.sh", "cat <<'DOC'\n" + heredoc(unsafePython) + "DOC\n");
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test.each([
	["joined -c", "python3 -c'import subprocess; subprocess.run([\"true\"])'\n"],
	["option argument", "python3 -X utf8 -c 'import subprocess; subprocess.run([\"true\"])'\n"],
])("PYGATE2 keeps native Python CLI argument ownership for %s", async (_label: string, command: string) => {
	const fixture = await stagedFixture();
	await fixture.stage("arguments.sh", command);
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("subprocess-no-timeout");
});

test("PYGATE2 refuses an unresolved executable shell string instead of judging only its template prefix", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("shell.ts", [
		'import { exec } from "node:child_process";',
		"exec(`python3 -c ${process.env.PYTHON_CODE}`);",
	].join("\n"));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("parse-error");
});

test("PYGATE2 preserves exec alias shell semantics and admits its bounded control", async () => {
	const fixture = await stagedFixture();
	const command = (program: string) => 'import { exec as execute } from "node:child_process";\nexecute('
		+ JSON.stringify("python3 -c '" + program + "'") + ");\n";
	await fixture.stage("alias.ts", command('import subprocess; subprocess.run(["true"])'));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("subprocess-no-timeout");
	await fixture.stage("alias.ts", command('import pysafe; pysafe.run_bounded(["true"], 1)'));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test("PYGATE2 does not borrow a named runner binding for an unrelated object method", async () => {
	const fixture = await stagedFixture();
	await fixture.stage("ownership.ts", [
		'import { run } from "./kitlib/run.ts";',
		"const data = { run(args: string[]) { return args; } };",
		"data.run(['python3', '-c', " + JSON.stringify(unsafePython) + "]);",
		"await run(['python3', '-c', " + JSON.stringify(boundedPython) + "], { deadline_s: 1 });",
	].join("\n"));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test.each([
	["then", (program: string) => "if true; then " + program + "; fi\n"],
	["else", (program: string) => "if false; then true; else " + program + "; fi\n"],
	["do", (program: string) => "for item in 1; do " + program + "; done\n"],
])("PYGATE2 follows executable shell %s boundaries", async (_label, wrap) => {
	const fixture = await stagedFixture();
	await fixture.stage("compound.sh", wrap('python3 -c \'import subprocess; subprocess.run(["true"])\''));
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("subprocess-no-timeout");
	await fixture.stage("compound.sh", wrap('python3 -c \'import pysafe; pysafe.run_bounded(["true"], 1)\''));
	const admitted = await fixture.judge();
	expect(admitted.rc, admitted.text).toBe(0);
});

test.each([
	["shell", "options.sh", 'FLAGS=-I\npython3 $FLAGS -c \'import subprocess; subprocess.run(["true"])\'\n'],
	["typed argv", "options.ts", 'import { run } from "./kitlib/run.ts";\nrun(["python3", process.env.FLAGS, "-c", '
		+ JSON.stringify(unsafePython) + "], { deadline_s: 1 });\n"],
])("PYGATE2 refuses unresolved %s arguments before selecting Python execution mode", async (_label, name, source) => {
	const fixture = await stagedFixture();
	await fixture.stage(name, source);
	const refused = await fixture.judge();
	expect(refused.rc, refused.text).toBe(1);
	expect(refused.text).toContain("parse-error");
});
