import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

test("native OMP fires kit-test-skip for a Go t.Skip edit", () => {
	const root = resolve(import.meta.dir, "../..");
	const identity = resolveOmpIdentity(process.env);
	const rule = resolve(root, "rules/kit-test-skip.md");
	const snippet = 'func TestX(t *testing.T) {\n\t' + 't.' + 'Skip("needs creds")\n}';
	const result = Bun.spawnSync([
		identity.launcher, "ttsr", "test", "--rule", rule, "--source", "tool", "--tool", "edit",
		"--path", "pkg/x_test.go", snippet, "--json",
	], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const report = JSON.parse(result.stdout.toString()) as { triggered?: { name?: string }[]; notTriggered?: { name?: string }[] };
	expect(report.triggered?.map(item => item.name)).toContain("kit-test-skip");
	expect(report.notTriggered?.map(item => item.name) ?? []).not.toContain("kit-test-skip");
});
