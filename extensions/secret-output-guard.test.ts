/**
 * secret-output-guard.test.ts (ompkit-fp72.87 SECRETOUT1): planted negatives
 * with SYNTHETIC sentinels only. No real credential is read, printed, probed
 * or stored here; every sentinel below contains a SYNTH marker and matches no
 * live vault value by construction.
 */
import { expect, test } from "bun:test";
import secretOutputGuard, {
	cfSecretListNamesOnly,
	fingerprintOfSecret,
	isCfSecretListCommand,
	legacyListFirstField,
	previewText,
	redactBindingFields,
	redactGhTokenShapes,
	redactSecurityPasswordOutput,
	resultTextOf,
	scrubText,
	scrubToolResult,
	type SecretGuardApi,
	type SecretGuardExecutionEndEvent,
	type SecretGuardToolCallEvent,
} from "./secret-output-guard";

/** Synthetic sentinels: obviously fake, never live values. */
const GH_CLASSIC_SYNTH = "ghp_SYNTH4K3Y7T1C9DEADBEEF00TEST5INK";
const GHO_SYNTH = "gho_SYNTH9H1T2C4FAKE8TOKEN0TEST3AB";
const GH_PAT_SYNTH = "github_pat_SYNTH_11ABCDEFGH22IJKLMN33pq";
const SEC_SYNTH = "SYNTH-SECRET-VALUE-9K2Q7Z";
const REG_SYNTH = "SYNTH-REGISTRATION-TOKEN-8H3K9";
const SENDER_SYNTH = "SYNTH-SENDER-TOKEN-4T7W2";
const SESSION_SYNTH = "SYNTH-SESSION-TOKEN-6M1N8";

const GH_METADATA = [
	`user: synth-octocat`,
	`token: ${GH_CLASSIC_SYNTH}`,
	`oauth_token: ${GHO_SYNTH}`,
	`fine_grained: ${GH_PAT_SYNTH}`,
	`scopes: repo, read:org`,
	`status: ok`,
].join("\n");

function firstBytes(secret: string, n = 8): string {
	return secret.slice(0, n);
}

/* [a] gh shapes: full values and truncation variants never emitted. */

test("gh metadata scrubs every token shape but keeps safe metadata", () => {
	const clean = redactGhTokenShapes(GH_METADATA);
	for (const synth of [GH_CLASSIC_SYNTH, GHO_SYNTH, GH_PAT_SYNTH]) {
		expect(clean).not.toContain(synth);
		expect(clean).not.toContain(firstBytes(synth));
		expect(clean).toContain(`fp:${fingerprintOfSecret(synth)}`);
	}
	for (const safe of ["synth-octocat", "repo, read:org", "status: ok"]) expect(clean).toContain(safe);
});

test("gh guard-removal negative: raw metadata leaks the sentinel", () => {
	expect(GH_METADATA).toContain(GH_CLASSIC_SYNTH);
	expect(GH_METADATA.slice(0, 64)).toContain(firstBytes(GH_CLASSIC_SYNTH));
	const clean = previewText(GH_METADATA, 64);
	expect(clean).not.toContain(GH_CLASSIC_SYNTH);
	expect(clean).not.toContain(firstBytes(GH_CLASSIC_SYNTH));
});

test("gh truncation variant: prefix of the raw value leaks, prefix of the scrub does not", () => {
	const rawPrefix = GH_CLASSIC_SYNTH.slice(0, 24);
	expect(rawPrefix).toContain(firstBytes(GH_CLASSIC_SYNTH));
	const cleanPrefix = previewText(`token ${GH_CLASSIC_SYNTH}`, 24);
	expect(cleanPrefix).not.toContain(firstBytes(GH_CLASSIC_SYNTH));
});

test("gh safe action-direct output passes through unchanged", () => {
	const safe = "user: synth-octocat\nscopes: repo\nstatus: ok\nremedy: run gh auth login\n";
	expect(redactGhTokenShapes(safe)).toBe(safe);
	expect(scrubToolResult({ content: safe })).toBeUndefined();
});

/* [a] security find-generic-password through truncating/prefix consumers. */

const SECURITY_OUTPUT = [
	`keychain: "/Users/synth/Library/Keychains/login.keychain-db"`,
	`class: "genp"`,
	`attributes:`,
	`    "acct"<blob>="synth-user"`,
	`password: "${SEC_SYNTH}"`,
].join("\n");

test("security password value redacted before any emission", () => {
	const clean = redactSecurityPasswordOutput(SECURITY_OUTPUT);
	expect(clean).not.toContain(SEC_SYNTH);
	expect(clean).not.toContain(firstBytes(SEC_SYNTH));
	expect(clean).toContain('password: "[REDACTED]"');
	expect(clean).toContain("synth-user");
	expect(clean).toContain("login.keychain-db");
});

test("security guard-removal negative: raw output and its prefixes leak", () => {
	expect(SECURITY_OUTPUT).toContain(SEC_SYNTH);
	expect(SECURITY_OUTPUT.slice(0, SECURITY_OUTPUT.indexOf(SEC_SYNTH) + 8)).toContain(firstBytes(SEC_SYNTH));
	for (const width of [24, 64, 160]) {
		const clean = previewText(SECURITY_OUTPUT, SECURITY_OUTPUT.indexOf(SEC_SYNTH) + width);
		expect(clean).not.toContain(SEC_SYNTH);
		expect(clean).not.toContain(firstBytes(SEC_SYNTH));
	}
});

test("security split chunks and every channel stay contained", () => {
	const chunks = [`password: "${SEC_SYNTH.slice(0, 10)}`, `${SEC_SYNTH.slice(10)}"`];
	const joined = chunks.join("");
	expect(joined).toContain(SEC_SYNTH);
	expect(scrubText(joined)).not.toContain(SEC_SYNTH);
	for (const channel of ["stdout", "stderr", "output"] as const) {
		const scrubbed = scrubToolResult({ [channel]: SECURITY_OUTPUT, details: {} });
		expect(scrubbed).toBeDefined();
		expect(JSON.stringify(scrubbed)).not.toContain(SEC_SYNTH);
	}
	const viaException = scrubToolResult({ message: `security failed after printing password: "${SEC_SYNTH}"`, isError: true });
	expect(viaException).toBeDefined();
	expect(JSON.stringify(viaException)).not.toContain(SEC_SYNTH);
	expect(viaException?.isError).toBe(true);
});

/* [b] cf-secret --list with multiline values prints names only. */

const CF_LIST_MULTILINE = [
	`ALPHA=one`,
	`MULTI=line-one`,
	`line-two-continues-SYNTH-FRAG-7Q`,
	`line-three`,
	`export BETA="two"`,
	`ESCAPED=aaa\\nbbb-SYNTH-ESC-3Z`,
	``,
].join("\n");

test("cf-secret multiline list emits only key names", () => {
	const names = cfSecretListNamesOnly(CF_LIST_MULTILINE);
	expect(names).toBe("ALPHA\nMULTI\nBETA\nESCAPED\n");
	for (const fragment of ["line-one", "line-two-continues-SYNTH-FRAG-7Q", "line-three", "aaa", "bbb-SYNTH-ESC-3Z", "one", "two"]) {
		expect(names).not.toContain(fragment);
	}
});

test("cf-secret ordinary scoped list enumerates exact keys", () => {
	expect(cfSecretListNamesOnly("ONE=1\nTWO=2\n")).toBe("ONE\nTWO\n");
	expect(isCfSecretListCommand("cf-secret --scope triage --list")).toBe(true);
	expect(isCfSecretListCommand("cf-secret list")).toBe(true);
	expect(isCfSecretListCommand("cf-secret --scope triage get FOO")).toBe(false);
});

test("cf-secret old-helper mutant fails: first-field extraction leaks continuation lines", () => {
	const legacy = legacyListFirstField(CF_LIST_MULTILINE);
	expect(legacy).toContain("line-two-continues-SYNTH-FRAG-7Q");
	expect(cfSecretListNamesOnly(CF_LIST_MULTILINE)).not.toContain("line-two-continues-SYNTH-FRAG-7Q");
});

/* G8: binding fields nested in args, records, previews and exceptions. */

const TOOL_ARGS = {
	command: "am send",
	subject: "REPORT ompkit-fp72.87",
	registration_token: REG_SYNTH,
	nested: { sender_token: SENDER_SYNTH, session_token: SESSION_SYNTH, count: 3, name: "synth-seat" },
	recipients: ["synth-seat", "synth-chief"],
};

test("binding fields redacted before truncation, identifiers and counts preserved", () => {
	const redacted = redactBindingFields(TOOL_ARGS) as Record<string, unknown>;
	expect(JSON.stringify(redacted)).not.toContain(REG_SYNTH);
	expect(JSON.stringify(redacted)).not.toContain(SENDER_SYNTH);
	expect(JSON.stringify(redacted)).not.toContain(SESSION_SYNTH);
	expect(JSON.stringify(redacted)).not.toContain(firstBytes(REG_SYNTH));
	expect(redacted["registration_token"]).toBe("[REDACTED]");
	expect((redacted["nested"] as Record<string, unknown>)["name"]).toBe("synth-seat");
	expect((redacted["nested"] as Record<string, unknown>)["count"]).toBe(3);
	expect((redacted["recipients"] as string[]).length).toBe(2);
});

test("G8 guard-removal negative: raw preview reaches the sentinel, guarded preview does not", () => {
	const record = { subject: "REPORT x", registration_token: REG_SYNTH, sender: "synth-seat" };
	const rawPreview = JSON.stringify(record).slice(0, 400);
	expect(rawPreview).toContain(REG_SYNTH);
	const guarded = JSON.stringify(redactBindingFields(record)).slice(0, 400);
	expect(guarded).not.toContain(REG_SYNTH);
	expect(guarded).not.toContain(firstBytes(REG_SYNTH));
	expect(guarded).toContain("synth-seat");
	const tiny = JSON.stringify(redactBindingFields(record)).slice(0, 24);
	expect(tiny).not.toContain(firstBytes(REG_SYNTH));
});

test("AgentMail record and exception shapes redacted, counts kept", () => {
	const mail = { recipient: "synth-chief", messages: [{ id: 1 }, { id: 2 }], registration_token: REG_SYNTH };
	const clean = redactBindingFields(mail) as Record<string, unknown>;
	expect((clean["messages"] as unknown[]).length).toBe(2);
	expect(clean["recipient"]).toBe("synth-chief");
	const err = scrubToolResult({ message: "register failed", registration_token: REG_SYNTH, isError: true });
	expect(err).toBeDefined();
	expect(JSON.stringify(err)).not.toContain(REG_SYNTH);
	expect(JSON.stringify(err)).not.toContain(firstBytes(REG_SYNTH));
	expect(err?.isError).toBe(true);
});

/* Extension wiring: delegation to the pure scrub. */

interface Captured {
	calls: Array<(event: SecretGuardToolCallEvent) => unknown>;
	ends: Array<(event: SecretGuardExecutionEndEvent) => unknown>;
}

async function capture(): Promise<Captured> {
	const captured: Captured = { calls: [], ends: [] };
	const pi = {
		on(event: string, handler: (arg: never) => unknown) {
			if (event === "tool_call") captured.calls.push(handler as (event: SecretGuardToolCallEvent) => unknown);
			else captured.ends.push(handler as (event: SecretGuardExecutionEndEvent) => unknown);
		},
	} as unknown as SecretGuardApi;
	await secretOutputGuard(pi);
	return captured;
}
test("extension rewrites gh results, names-only for cf-secret list, silent otherwise", async () => {
	const captured = await capture();
	expect(captured.calls.length).toBe(1);
	expect(captured.ends.length).toBe(1);
	const onCall = captured.calls[0]!;
	const onEnd = captured.ends[0]!;

	await onCall({ type: "tool_call", toolCallId: "gh-1", input: { command: "gh auth status" } });
	const ghRewrite = (await onEnd({ type: "tool_execution_end", toolCallId: "gh-1", result: { stdout: GH_METADATA } })) as { content: Array<{ text: string }> } | undefined;
	expect(ghRewrite).toBeDefined();
	expect(JSON.stringify(ghRewrite)).not.toContain(GH_CLASSIC_SYNTH);

	await onCall({ type: "tool_call", toolCallId: "cf-1", input: { command: "cf-secret --scope triage --list" } });
	const cfRewrite = (await onEnd({ type: "tool_execution_end", toolCallId: "cf-1", result: { stdout: CF_LIST_MULTILINE } })) as { content: Array<{ text: string }> } | undefined;
	expect(cfRewrite).toBeDefined();
	expect(cfRewrite?.content[0]?.text).toBe("ALPHA\nMULTI\nBETA\nESCAPED\n");

	await onCall({ type: "tool_call", toolCallId: "ok-1", input: { command: "echo hello" } });
	const silent = await onEnd({ type: "tool_execution_end", toolCallId: "ok-1", result: { stdout: "hello\n" } });
	expect(silent).toBeUndefined();
});

test("resultTextOf spans native and older envelope shapes", () => {
	expect(resultTextOf({ content: [{ type: "text", text: "native" }] })).toBe("native");
	expect(resultTextOf({ stdout: "old" })).toBe("old");
	expect(resultTextOf({ details: { stderr: "deep" } })).toBe("deep");
	expect(resultTextOf({ message: "boom" })).toBe("boom");
	expect(resultTextOf(null)).toBeNull();
});
