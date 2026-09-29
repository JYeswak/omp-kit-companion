import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { confirmMutation, renderOutput } from "../../src/output.ts";

const versions = { toolVersion: "1.2.3", schemaVersion: "1" };

describe("deterministic CLI presentation", () => {
	test("robot response is one byte-identical JSON object with sorted findings/errors and no clock", () => {
		const result = {
			code: 1 as const,
			data: { findings: [
				{ component: "zeta", status: "FAIL", reason: "bad", recommended_action: "repair" },
				{ component: "alpha", status: "UNVERIFIED", reason: "not checked", recommended_action: "inspect" },
			] },
			errors: [
			{ code: "Z_MISSING", message: "Missing", remediation: "Install it" },
			{ code: "A_FAILED", message: "Failed", remediation: "Inspect it" },
		],
		commands: ["omp-kit status", "omp-kit doctor"],
		verification: "UNVERIFIED" as const,
	};
		const first = renderOutput(result, { ...versions, json: true });
		const second = renderOutput(result, { ...versions, json: true });
		expect(second).toEqual(first);
		expect(first.exitCode).toBe(1);
		expect(first.stderr).toBe("");
		expect(first.stdout.endsWith("\n")).toBe(true);
		expect(first.stdout.slice(0, -1)).not.toContain("\n");
		const envelope = JSON.parse(first.stdout);
		expect(Object.keys(envelope)).toEqual(["ok", "tool_version", "data", "meta", "warnings", "commands", "errors"]);
		expect(envelope.ok).toBe(false);
		expect(envelope.data.findings.map((finding: { component: string }) => finding.component)).toEqual(["alpha", "zeta"]);
		expect(envelope.errors.map((error: { code: string }) => error.code)).toEqual(["A_FAILED", "Z_MISSING"]);
		expect(envelope.commands).toEqual(["omp-kit status", "omp-kit doctor"]);
		expect(envelope.meta).toEqual({ schema_version: "1", verification: "UNVERIFIED" });
		expect(first.stdout).not.toContain("generated_at");
	});

	test("missing verification never becomes performed and unknown findings remain unknown", () => {
		const rendered = renderOutput({ code: 0, data: { overall: "UNVERIFIED", findings: [{ component: "profile", status: "UNVERIFIED" }] } }, { ...versions, json: true });
		const envelope = JSON.parse(rendered.stdout);
		expect(envelope.ok).toBe(true); // Inventory completed; evidence did not.
		expect(envelope.meta.verification).toBe("NOT_RUN");
		expect(envelope.data).toEqual({ findings: [{ component: "profile", status: "UNVERIFIED" }], overall: "UNVERIFIED" });
		expect(envelope.errors).toEqual([]);
	});

	test("human diagnostics and warnings go only to stderr while data goes to stdout", () => {
		const failed = renderOutput({ code: 2, data: { overall: "NOT_RUN" }, warnings: ["No changes made"], errors: [
			{ code: "CONSENT_REQUIRED", message: "Explicit approval needed", remediation: "Pass --yes" },
		] }, { ...versions, json: false });
		expect(failed.stdout).toBe("");
		expect(failed.stderr).toContain("CONSENT_REQUIRED: Explicit approval needed\nPass --yes\n");
		expect(failed.stderr).toContain("No changes made\n");
		expect(failed.exitCode).toBe(2);
		const success = renderOutput({ code: 0, data: { text: "Usage: omp-kit\nflags" } }, { ...versions, json: false });
		expect(success.stdout).toBe("Usage: omp-kit\nflags\n");
		expect(success.stderr).toBe("");
	});
});

describe("mutation consent boundary", () => {
	const intent = { action: "apply rules", explicit: true, yes: false, json: false, robot: false, noColor: false };

	test("robot, JSON, no-color and hostile environments refuse rather than prompt", async () => {
		for (const changes of [
			{ robot: true }, { json: true }, { noColor: true },
			{ env: { NO_COLOR: "" } }, { env: { CI: "true" } }, { env: { TERM: "dumb" } },
		]) {
			expect(await confirmMutation({ ...intent, ...changes })).toBe(false);
		}
	});

	test("only explicit intent with --yes authorizes a noninteractive request", async () => {
		expect(await confirmMutation({ ...intent, explicit: false, yes: true })).toBe(false);
		expect(await confirmMutation({ ...intent, yes: true, robot: true, json: true })).toBe(true);
	});

	test("closed stdin and piped stdout cannot be promoted to TTY by an isTTY claim", async () => {
		const input = new PassThrough() as PassThrough & { isTTY: boolean; fd?: number };
		input.isTTY = true;
		input.end();
		const output = new PassThrough() as PassThrough & { isTTY: boolean; fd?: number };
		output.isTTY = true;
		const diagnostics = new PassThrough() as PassThrough & { isTTY: boolean; fd?: number };
		diagnostics.isTTY = true;
		expect(await confirmMutation({ ...intent, env: {}, stdin: input, stdout: output, stderr: diagnostics })).toBe(false);
		expect(output.read()).toBeNull();
		expect(diagnostics.read()).toBeNull();
	});
});
