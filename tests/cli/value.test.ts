import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findCommand } from "../../src/commands.ts";
import type { ParsedCommand } from "../../src/cli.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { valueCommand } from "../../src/value.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

const allocations: OwnedTmp[] = [];
afterEach(() => { for (const owned of allocations.splice(0)) owned.cleanup(); });

function projectDir(decl: unknown | null): string {
	const owned = ownedTmp("valueverb-test");
	allocations.push(owned);
	const root = owned.path;
	if (decl !== null) {
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp", "value.json"), JSON.stringify(decl));
	}
	return root;
}

function request(project: string): ParsedCommand {
	const command = findCommand("value");
	if (!command) throw new Error("value is not in the COMMANDS registry");
	return { command, parent: undefined, flags: new Map([["--project", project]]), json: true, robot: false };
}

test("VALUEVERB1 MET exits 0 with name, value, target, verdict and command", async () => {
	const root = projectDir({ name: "lead_reply_sla_hits_7d", command: ["sh", "-c", "echo 5"], target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data).toMatchObject({ overall: "MET", name: "lead_reply_sla_hits_7d", value: 5, target: 3,
		verdict: "MET", command: ["sh", "-c", "echo 5"] });
	expect(result.data.text).toBe("VALUE lead_reply_sla_hits_7d=5/3 MET");
	expect(result.verification).toBe("PERFORMED");
});

test("VALUEVERB1 MET at exactly target exits 0 and a missing name defaults to value", async () => {
	const root = projectDir({ command: ["sh", "-c", "echo 3"], target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(0);
	expect(result.data).toMatchObject({ overall: "MET", name: "value", value: 3, target: 3 });
	expect(result.data.text).toBe("VALUE value=3/3 MET");
});

test("VALUEVERB1 BELOW exits 1 and names the shortfall", async () => {
	const root = projectDir({ name: "lead_reply_sla_hits_7d", command: ["sh", "-c", "echo 2"], target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(1);
	expect(result.data).toMatchObject({ overall: "BELOW", name: "lead_reply_sla_hits_7d", value: 2, target: 3, verdict: "BELOW" });
	expect(result.data.text).toBe("VALUE lead_reply_sla_hits_7d=2/3 BELOW");
});

test("VALUEVERB1 UNDECLARED exits 2 with a remediation naming the file and its shape", async () => {
	const root = projectDir(null);
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(2);
	expect(result.data).toMatchObject({ overall: "UNDECLARED", value: null, target: null });
	const remediation = String(result.data.remediation ?? "");
	expect(remediation).toContain(".omp/value.json");
	expect(remediation).toContain("\"command\"");
	expect(remediation).toContain("\"target\"");
	expect(String(result.data.text)).toBe("VALUE value=?/? UNDECLARED");
});

test("VALUEVERB1 the CLI route exits 1 with a JSON envelope on BELOW", async () => {
	const root = projectDir({ name: "lead_reply_sla_hits_7d", command: ["sh", "-c", "echo 2"], target: 3 });
	const owned = ownedTmp("valueverb-cli");
	allocations.push(owned);
	const spawned = await runFixtureAsync([process.execPath, cliPath, "value", "--project", root, "--json"], { cwd: owned.path });
	expect(spawned.rc).toBe(1);
	const envelope = JSON.parse(new TextDecoder().decode(spawned.stdout));
	expect(envelope.ok).toBe(false);
	expect(envelope.data).toMatchObject({ name: "lead_reply_sla_hits_7d", value: 2, target: 3, verdict: "BELOW" });
}, fixtureDeadlineS(60) * 1000);

test("VALUEVERB1 UNDECLARED exits 2 when the declaration has an invalid shape", async () => {
	const root = projectDir({ name: "broken", command: "echo 5", target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(2);
	expect(result.data).toMatchObject({ overall: "UNDECLARED", value: null, target: null });
	expect(String(result.data.reason)).toContain("invalid");
	expect(String(result.data.remediation)).toContain(".omp/value.json");
});

test("VALUEVERB1 UNKNOWN exits 3 when the command fails", async () => {
	const root = projectDir({ name: "flaky", command: ["sh", "-c", "exit 3"], target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(3);
	expect(result.data).toMatchObject({ overall: "UNKNOWN", name: "flaky", value: null, target: 3, verdict: "UNKNOWN" });
	expect(String(result.data.reason)).toContain("exited 3");
});

test("VALUEVERB1 UNKNOWN exits 3 when stdout is not a number", async () => {
	const root = projectDir({ name: "chatty", command: ["sh", "-c", "echo hello"], target: 3 });
	const result = await valueCommand(request(root));
	expect(result.code, JSON.stringify(result)).toBe(3);
	expect(result.data).toMatchObject({ overall: "UNKNOWN", value: null });
	expect(String(result.data.reason)).toContain("no finite number");
});


test("VALUEVERB1 a token-shaped value in failing stderr or non-number stdout never reaches the reason", async () => {
	// Synthetic gh-shaped values; probes like cfs-infisical-run are credential-adjacent. VALUE_PREVIEW_CHARS cuts
	// inside the token when truncation runs first, which is the planted case.
	const token = "ghp_" + "B".repeat(36);
	// stderr: 190 zeros, a space, then the token, so the 200-char cut falls inside it.
	for (const [label, script] of [["stderr", `printf '%0190d %s' 0 ${token} >&2; exit 4`], ["stdout", `printf '%0190d %s\\n' 0 ${token}`]] as const) {
		const root = projectDir({ name: `leak-${label}`, command: ["sh", "-c", script], target: 3 });
		const result = await valueCommand(request(root));
		expect(result.code, JSON.stringify(result)).toBe(3);
		// The declared argv is echoed as-is (a declaration is the project's own text); the probe's output is not.
		expect(String(result.data.reason)).not.toContain("ghp_BBBB");
	}
});
