import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "../cli/fixture-process.ts";
import { createFlywheelHost } from "../fleet-guard/kit-flywheel-host.ts";
import type { FlywheelToolCallResult } from "../../extensions/kit-flywheel-guard.ts";

const repo = resolve(import.meta.dir, "../..");
const ruleCases = [
	["kit-tool-route", "cat src/cli.ts", true],
	["kit-tool-route", "head -n 40 src/cli.ts", true],
	["kit-tool-route", "tail -20 src/cli.ts", true],
	["kit-tool-route", "sed -n '20,40p' src/cli.ts", true],
	["kit-tool-route", "cat package.json extra.json | jq -s .", false],
	["kit-tool-route", "head -n 40 src/cli.ts tests/cli/cli-bins.test.ts", false],
	["kit-tool-route", "cat src/cli.ts | wc -l", false],
	["kit-tool-route", "printf '%s\\n' 'cat src/cli.ts'", false],
	["kit-tool-route-search", "grep -rn resolveOmpIdentity .", true],
	["kit-tool-route-search", "grep -nr 'resolveOmpIdentity' src", true],
	["kit-tool-route-search", "grep -rn 'connection refused' ./logs", false],
	["kit-tool-route-search", "grep -n resolveOmpIdentity log.txt", false],
	["kit-tool-route-edit", "sed -i '' 's/old/new/' src/cli.ts", true],
	["kit-tool-route-edit", "python3 -c 'from pathlib import Path; p = Path(\"src/cli.ts\"); p.write_text(p.read_text().replace(\"old\", \"new\"))'", true],
	["kit-tool-route-edit", "python3 -c 'from pathlib import Path; p = Path(\"notes.txt\"); p.write_text(p.read_text().replace(\"old\", \"new\"))'", false],
	["kit-tool-route-edit", "printf '%s\\n' old | sed 's/old/new/'", false],
	["kit-tool-route-edit", "python3 -c 'print(\"old\".replace(\"old\", \"new\"))'", false],
	["kit-tool-route-wait", "while ! test -f ready; do sleep 1; done", true],
	["kit-tool-route-wait", "for i in 1 2; do sleep 1; done", true],
	["kit-tool-route-wait", "sleep 1", false],
	["kit-tool-route-wait", "for i in 1 2; do printf 'sleep 1'; done", false],
] as const;

test.each(ruleCases)("native %s: %s → %s", (rule, command, fires) => {
	const { launcher } = resolveOmpIdentity(process.env);
	const result = runFixture([launcher, "ttsr", "test", "--rule", join(repo, "rules", `${rule}.md`),
		"--source", "tool", "--tool", "bash", "--json", JSON.stringify({ i: "Running shell command", command })], { cwd: repo });
	expect(result.rc, Buffer.from(result.stderr).toString()).toBe(0);
	const report = JSON.parse(Buffer.from(result.stdout).toString()) as { triggered: { name: string }[]; evaluated: number };
	expect(report.evaluated).toBe(1);
	expect(report.triggered.map(row => row.name)).toEqual(fires ? [rule] : []);
});

const ubCall = (command: string) => ({ type: "message", message: { role: "assistant", content: [
	{ type: "toolCall", id: "ubs-1", name: "bash", arguments: { command } },
] } });
const ubEnd = (isError = false, details: object = {}) => ({ type: "message", message: {
	role: "toolResult", toolCallId: "ubs-1", toolName: "bash", isError, details,
} });

test.each([
	["git commit -m 'fix: source'", [], true],
	["omp-kit land --paths src/cli.ts --message 'fix: source'", [], true],
	["git status --short", [], false],
	["printf 'git commit -m fix'", [], false],
	["git commit -m 'fix: source'", [ubCall("ubs --files src/cli.ts"), ubEnd()], false],
	["git commit -m 'fix: source'", [ubCall("ubs --files=src/cli.ts"), ubEnd()], false],
	["omp-kit land --paths src/cli.ts --message 'fix: source'", [ubCall("ubs --diff"), ubEnd()], false],
	["git commit -m 'fix: source'", [ubCall("ubs --help"), ubEnd()], true],
	["git commit -m 'fix: source'", [ubCall("ubs --files src/cli.ts"), ubEnd(true, { exitCode: 127 })], true],
	["git commit -m 'fix: source'", [ubCall("ubs --files src/cli.ts"), ubEnd(false, { async: { state: "running" } })], true],
	["git commit -m 'fix: source'", [ubCall("printf 'ubs --files src/cli.ts'"), ubEnd()], true],
	["git commit -m 'fix: source'", [ubCall("false && ubs --files src/cli.ts || true"), ubEnd()], true],
] as const)("commit advisory: %s with prior tool results %j → %s", async (command, entries, fires) => {
	const temp = ownedTmp("tool-route-ubs");
	try {
		const git = runFixture(["git", "init", "-q", temp.path], { cwd: temp.path });
		expect(git.rc, Buffer.from(git.stderr).toString()).toBe(0);
		const host = await createFlywheelHost(temp.path);
		const ctx = { ...host.ctx(temp.path), sessionManager: { getBranch: () => entries } };
		const results = await host.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } }, ctx);
		expect(results.some(result => (result as FlywheelToolCallResult | undefined)?.block === true)).toBe(false);
		const messages = host.notices.filter(line => line.startsWith("kit-tool-route-ubs:"));
		expect(messages).toEqual(fires ? ["kit-tool-route-ubs: Run `ubs --files <changed>` before saving; it scans changed files for bugs. Skill: `ubs`."] : []);
		expect(host.sent.filter(row => row.message.customType === "kit-tool-route-ubs").map(row => row.message.content)).toEqual(messages);
	} finally { temp.cleanup(); }
});
