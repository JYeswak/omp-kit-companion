import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const root = resolve(import.meta.dir, "../..");
const marker = "HANDLERCAUSE1 fixture failure";
const secret = "synthetic-handler-cause-token";
type FailureEnvelope = {
	ok: boolean;
	data: { overall: string; diagnostics_path: string | null };
	meta: { verification: string };
	errors: { code: string; message: string; remediation: string }[];
};
type Diagnostic = {
	schema_version: number;
	cause: { cause_name: string; cause_message: string; cause_stack_head: string | null };
};

async function withFailure(message: string, variant: "normal" | "blocked-state" | "uninspectable", check: (result: {
	code: number | null; envelope: FailureEnvelope; output: string; state: string;
}) => void): Promise<void> {
	const scratch = ownedTmp("cli-dispatch-test");
	try {
		const home = join(scratch.path, "home");
		const state = join(scratch.path, "state");
		mkdirSync(home, { mode: 0o700 });
		if (variant === "blocked-state") writeFileSync(state, "not a directory");
		const driver = `
import { registerCommandHandler, runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};
function handlerCauseFixture() {
	if (process.env.HANDLERCAUSE_VARIANT === "uninspectable") throw Object.create(null);
	throw new TypeError(process.env.HANDLERCAUSE_MESSAGE);
}
registerCommandHandler("status", handlerCauseFixture);
process.exitCode = await runCli(["status", "--json"]);
`;
		const result = await run([process.execPath, "--eval", driver], {
			cwd: root, deadline_s: 30,
			env: { ...process.env, HOME: home, XDG_STATE_HOME: state,
				TMPDIR: scratch.path, CC_STATE: join(scratch.path, "cc"),
				AGENT_NAME: "HandlerCauseFixture", HANDLERCAUSE_MESSAGE: message, HANDLERCAUSE_VARIANT: variant },
		});
		const output = new TextDecoder().decode(result.stdout);
		expect(result.timed_out).toBe(false);
		expect(output).toContain('"HANDLER_FAILED"');
		const envelope: FailureEnvelope = JSON.parse(output);
		check({ code: result.rc, envelope, output, state });
	} finally {
		scratch.cleanup();
	}
}

function checkFailure(code: number | null, envelope: FailureEnvelope): void {
	expect(code).toBe(1);
	expect(envelope.ok).toBe(false);
	expect(envelope.data.overall).toBe("UNVERIFIED");
	expect(envelope.meta.verification).toBe("UNVERIFIED");
	expect(envelope.errors).toHaveLength(1);
	expect(envelope.errors[0]?.code).toBe("HANDLER_FAILED");
	expect(envelope.errors[0]?.message).toContain("TypeError");
	expect(envelope.errors[0]?.message).toContain(marker);
}

test("HANDLERCAUSE1 retains a redacted cause and names the private diagnostic file", async () => {
	await withFailure(`${marker}; Bearer ${secret}`, "normal", ({ code, envelope, output, state }) => {
		checkFailure(code, envelope);
		expect(envelope.errors[0]?.message).toContain("handlerCauseFixture");
		expect(output).not.toContain(secret);
		const path = envelope.data.diagnostics_path;
		expect(typeof path).toBe("string");
		if (typeof path !== "string") throw new Error("diagnostics path missing");
		expect(path.startsWith(join(state, "omp-kit", "diagnostics") + "/")).toBe(true);
		expect(envelope.errors[0]?.remediation).toContain(path);
		const bytes = readFileSync(path, "utf8");
		expect(bytes).not.toContain(secret);
		const diagnostic: Diagnostic = JSON.parse(bytes);
		expect(diagnostic.schema_version).toBe(1);
		expect(diagnostic.cause.cause_name).toBe("TypeError");
		expect(diagnostic.cause.cause_message).toContain(marker);
		expect(diagnostic.cause.cause_stack_head).toContain("handlerCauseFixture");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});

test("HANDLERCAUSE1 bounds retained causes without losing the first stack frame", async () => {
	await withFailure(`${marker}; Bearer ${secret}\n${"detail ".repeat(2000)}`, "normal", ({ code, envelope, output }) => {
		checkFailure(code, envelope);
		expect(output).not.toContain(secret);
		expect(envelope.errors[0]?.message).toContain("handlerCauseFixture");
		const path = envelope.data.diagnostics_path;
		if (typeof path !== "string") throw new Error("diagnostics path missing");
		const bytes = readFileSync(path, "utf8");
		expect(Buffer.byteLength(bytes)).toBeLessThan(4000);
		const diagnostic: Diagnostic = JSON.parse(bytes);
		expect(diagnostic.cause.cause_name.length).toBeLessThanOrEqual(100);
		expect(diagnostic.cause.cause_message.length).toBeLessThanOrEqual(200);
		expect(diagnostic.cause.cause_stack_head?.length).toBeLessThanOrEqual(400);
		expect(diagnostic.cause.cause_stack_head).toContain("handlerCauseFixture");
	});
});

test("HANDLERCAUSE1 preserves the original failure when diagnostic storage is unavailable", async () => {
	await withFailure(marker, "blocked-state", ({ code, envelope, state }) => {
		checkFailure(code, envelope);
		expect(envelope.data.diagnostics_path).toBeNull();
		expect(existsSync(join(state, "omp-kit", "diagnostics"))).toBe(false);
		expect(envelope.errors[0]?.remediation).not.toContain(join(state, "omp-kit", "diagnostics"));
	});
});

test("HANDLERCAUSE1 cannot crash while inspecting a non-Error thrown value", async () => {
	await withFailure(marker, "uninspectable", ({ code, envelope }) => {
		expect(code).toBe(1);
		expect(envelope.ok).toBe(false);
		expect(envelope.data.overall).toBe("UNVERIFIED");
		expect(envelope.errors[0]?.code).toBe("HANDLER_FAILED");
		const path = envelope.data.diagnostics_path;
		if (typeof path !== "string") throw new Error("diagnostics path missing");
		const diagnostic: Diagnostic = JSON.parse(readFileSync(path, "utf8"));
		expect(diagnostic.cause.cause_name).toBe("object");
		expect(diagnostic.cause.cause_stack_head).toBeNull();
	});
});
