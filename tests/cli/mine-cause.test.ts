import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ccActionOutcome } from "../../src/cli.ts";
import { budgetLedgerGate, classifyMineResult } from "../../src/mine-cause.ts";
import { recordGateEvent } from "../../extensions/gate-events.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// The CC event path in mine.ts: the kit's action.result data is the record, its outcome the
// decision and its code the rule, exactly as runCli records the verb's exit and errors[].
function minedAction(surface: string, exitCode: number, errors?: { code: string }[]) {
	const { outcome, code } = ccActionOutcome(exitCode, errors);
	const data = { action_id: "fixture", outcome, code, duration_ms: 1200 };
	return classifyMineResult({ tool: surface, result: data, text: "", is_error: false, exit_code: undefined, timed_out: undefined, outcome, ...(code ? { code } : {}) });
}

test("cause classifier respects authoritative success and false timeout metadata", () => {
	for (const exit of [0, "0"]) expect(classifyMineResult({ tool: "bash", result: { isError: true, details: { rc: exit, timed_out: false }, content: "REFUSED: old output; timeout" } })).toBeNull();
	expect(classifyMineResult({ tool: "todo", result: { isError: true, timed_out: false, content: "Errors: Missing phase name for append operation\nremaining: timeout" } })?.class_id).toBe("validation:phase-name-required");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, timed_out: false, content: "Command timed out" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { kind: "refuse", detail: "findings=0 rc=0" }, text: "findings=0 rc=0", is_error: true, outcome: "refuse" })).toBeNull();
	expect(classifyMineResult({ tool: "bash", result: { code: 0 }, text: "REFUSED: historical output; timeout", is_error: true })).toBeNull();
});

test("explicit false timeout metadata overrides contradictory timeout exit and outcome", () => {
	for (const exit of [124, 142]) {
		expect(classifyMineResult({ tool: "bash", result: { isError: true, timed_out: false, exit_code: exit }, text: "Command timed out", outcome: "timeout" })?.class_id).toBe("tool-error:unclassified");
		expect(classifyMineResult({ tool: "bash", result: {}, timed_out: false, exit_code: exit, outcome: "timeout" })?.class_id).toBe("tool-error:unclassified");
	}
	expect(classifyMineResult({ tool: "write", result: { isError: true, timed_out: false }, text: "MCP failure server: mcp-agent-mail tool: file_reservation_paths transport: http stage: send failure: timeout retryable: no" })?.class_id).toBe("mcp-transport:mcp__mcp_agent_mail_file_reservation_paths");
});

test("cause classifier confines status discovery to actual native envelopes", () => {
	expect(classifyMineResult({ tool: "eval", result: { isError: true, content: "AssertionError: expected active project to equal requested project", details: { command: { rc: 0, timed_out: false } } } })?.class_id).toBe("assertion:expected-active-project-to-equal-requested-project");
	expect(classifyMineResult({ tool: "grep", result: { isError: false, content: "AssertionError: quoted assertion\nMCP failure server: mcp-agent-mail tool: file_reservation_paths transport: http stage: send failure: timeout retryable: no" } })).toBeNull();
	expect(classifyMineResult({ tool: "read", result: { content: [{ type: "text", text: JSON.stringify({ data: { isError: true, timed_out: true, message: "AssertionError: quoted" } }) }] } })).toBeNull();
	for (const tool of ["grep", "read"]) {
		const quoted = JSON.stringify({ isError: true, timed_out: true, message: "AssertionError: quoted" });
		expect(classifyMineResult({ tool, result: { isError: false, content: quoted }, text: quoted, is_error: false })).toBeNull();
	}
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "the prose mentions timeout and REFUSED but has no diagnostic prefix" } })?.class_id).toBe("tool-error:unclassified");
});

test("cause classifier resolves nested native MCP statuses and guard codes", () => {
	expect(classifyMineResult({ tool: "write", result: { isError: true, result: { tool: "mcp__mcp_agent_mail_file_reservation_paths", details: { timed_out: true }, content: "MCP error -32001: Request timed out" } } })?.class_id).toBe("mcp-transport:mcp__mcp_agent_mail_file_reservation_paths");
	expect(classifyMineResult({ tool: "write", result: { isError: true, content: "fleet-guard write-ownership (WRITE_OWN_LOOKUP_UNAVAILABLE): reservation lookup failed" } })?.class_id).toBe("guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE");
	expect(classifyMineResult({ tool: "commit", result: {}, outcome: "refused", code: "RESERVATION_REQUIRED" })?.class_id).toBe("commit-refusal:RESERVATION_REQUIRED");
	expect(classifyMineResult({ tool: "bash", result: {}, exit_code: 124 })?.class_id).toBe("timeout:bash");
});

test("cause diagnostics and derived class ids never retain raw credentials", () => {
	const result = classifyMineResult({ tool: "eval", result: { isError: true, content: "AssertionError: api_key=fixture-private-credential" } });
	expect(result?.class_id).toStartWith("assertion:");
	expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
});

test("untrusted tool names and guard codes cannot place credentials in class ids", () => {
	const credential = "ghp_" + "a".repeat(40);
	for (const name of [credential, "api_key=fixture-private-credential"]) {
		const timeout = classifyMineResult({ tool: name, result: { isError: true, timed_out: true } });
		const guard = classifyMineResult({ tool: "write", result: { isError: true }, outcome: "refused", code: name });
		expect(timeout?.class_id).toStartWith("timeout:");
		expect(guard?.class_id).toStartWith("guard-friction:");
		expect(JSON.stringify([timeout, guard])).not.toContain(credential);
		expect(JSON.stringify([timeout, guard])).not.toContain("fixture-private-credential");
	}
});

test("diagnostic prefixes reject bounded long near misses without keyword fallthrough", () => {
	for (const prefix of ["This edit anchors to lines ", "MCP failure server: ", "fleet-guard "]) {
		expect(classifyMineResult({ tool: "write", result: { isError: true, content: prefix + "x".repeat(65_536) + " timeout" } })?.class_id).toBe("tool-error:unclassified");
	}
});

test("JEVDOCTOR1 planted: a doctor finding exit with no errors[] is mined as finding:<surface>, not tool-error:unclassified", () => {
	const fire = minedAction("kit-doctor", 1);
	expect(fire?.class_id).toBe("finding:kit-doctor");
	expect(fire?.summary).toContain("FAIL finding");
	// The 2026-11-04 jev rows were recorded as HANDLER_FAILED before the producer fix; the miner names that recorded code.
	const recorded = { action_id: "c7bab9503ec07b89c23fae8191c65b9a", outcome: "failed", code: "HANDLER_FAILED", duration_ms: 4152 };
	expect(classifyMineResult({ tool: "kit-doctor", result: recorded, text: "", is_error: false, outcome: "failed", code: "HANDLER_FAILED" })?.class_id).toBe("tool-error:kit-doctor:HANDLER_FAILED");
	// Quiet: a passing doctor and a custody answer are not failures.
	expect(minedAction("kit-doctor", 0)).toBeNull();
	expect(minedAction("kit-custody", 10)).toBeNull();
});

test("JEVDOCTOR1 control: an error-coded doctor failure stays a tool error named by its code", () => {
	expect(minedAction("kit-doctor", 1, [{ code: "HANDLER_FAILED" }])?.class_id).toBe("tool-error:kit-doctor:HANDLER_FAILED");
	expect(minedAction("kit-doctor", 3, [{ code: "OMP_UNAVAILABLE" }])?.class_id).toBe("tool-error:kit-doctor:OMP_UNAVAILABLE");
	expect(minedAction("kit-doctor", 2)?.class_id).toBe("tool-error:kit-doctor:USAGE_OR_BLOCKED");
	// Exit 2 with a code is a refusal by the kit contract and keeps its guard-friction class.
	expect(minedAction("kit-doctor", 2, [{ code: "INVALID_FLAG" }])?.class_id).toBe("guard-friction:INVALID_FLAG");
	// Only the record's own code names the class: a guard rule on a failed call, or an uncoded failure, stays unclassified.
	expect(classifyMineResult({ tool: "bash", result: { is_error: true, guard_rule: "WRITE_OWN_LOOKUP_UNAVAILABLE", guard_decision: "allow" }, is_error: true, outcome: "allow", code: "WRITE_OWN_LOOKUP_UNAVAILABLE" })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "kit-check", result: { action_id: "x", outcome: "failed" }, outcome: "failed" })?.class_id).toBe("tool-error:unclassified");
	// Non-contract codes never enter a class id.
	for (const code of ["ghp_" + "a".repeat(40), "kit-doctor", "Finding", "FINDING\n"]) {
		const mined = classifyMineResult({ tool: "kit-doctor", result: { outcome: "failed", code }, outcome: "failed", code });
		expect(mined?.class_id).toBe("tool-error:unclassified");
		expect(JSON.stringify(mined)).not.toContain("ghp_");
	}
});

test("LEDGERCLASS1: guard-shaped error text names the gate, never tool-error:unclassified", () => {
	const cases: [string, string, string][] = [
		["bash", "fleet-guard scratch-is-not-a-home: scratch edit/write content cannot be established", "guard-friction:scratch-is-not-a-home"],
		["bash", "fleet-guard system-temp: writes to /tmp are blocked", "guard-friction:system-temp"],
		["bash", "Error: fleet-guard blanket-git: git add -A stages the shared tree", "guard-friction:blanket-git"],
		["bash", "dcg denied the bash tool call (core.filesystem:redirect-truncate-dynamic-path)", "guard-friction:core.filesystem-redirect-truncate-dynamic-path"],
		["bash", "dcg denied the bash tool call", "guard-friction:dcg-denied"],
		["bash", "Error: dcg denied the bash tool call", "guard-friction:dcg-denied"],
		["bash", "BRIEF_CONTRACT_REFUSED: build task lacks the current contract", "guard-friction:BRIEF_CONTRACT_REFUSED"],
		["bash", "Error: BRIEF_CONTRACT_REFUSED: build task lacks the current contract", "guard-friction:BRIEF_CONTRACT_REFUSED"],
		["bash", "verify OK ev_1 SCRATCH_RELEASE_REFUSED: Scratch release refused: ref-transfer-unproven", "guard-friction:SCRATCH_RELEASE_REFUSED"],
		["bash", "Embedded shell command blocked: shell redirect to a dynamic path", "guard-friction:embedded-blocked"],
		["bash", "Error: kit-agent-mail-guard AM_GUARD_FAILED: the check failed (AM_IDENTITY_MISMATCH: a native child)", "guard-friction:AM_IDENTITY_MISMATCH"],
		["bash", "shell redirect to a dynamic path may truncate a file. Rule: core.filesystem:redirect-truncate-dynamic-path", "guard-friction:core.filesystem-redirect-truncate-dynamic-path"],
		["bash", "env with no command dumps every environment value Rule: zeststream.fleet_hazards:env-dump-env", "guard-friction:zeststream.fleet_hazards-env-dump-env"],
		["bash", '{"ok":false,"data":{"overall":"NOT_RUN"},"errors":[{"code":"SCRATCH_RELEASE_REFUSED","message":"refused"}]}', "guard-friction:SCRATCH_RELEASE_REFUSED"],
		["bash", "RESOURCE_DEFERRED: all 2 heavy-work slots are occupied (--no-wait)", "guard-friction:resource-deferred"],
		["bash", "install-pre-push-gate: STALE installed member: hooks.d/pre-push/40-x", "guard-friction:stale-member"],
		["bash", "[close-evidence] BLOCKED: 4 close(s) carry no evidence", "guard-friction:close-evidence"],
		["bash", "SLB CAUTION: command logged for review. Proceed?", "guard-friction:slb-caution"],
		["bash", "SLB DANGEROUS: Requires 1 approval. Use 'slb request' to submit.", "guard-friction:slb-dangerous"],
		["bash", "Error: kit-agent-mail-guard IDENTITY_UNBOUND: Native child X is not registered", "guard-friction:IDENTITY_UNBOUND"],
	];
	for (const [tool, content, id] of cases) {
		expect(classifyMineResult({ tool, result: { isError: true, content } })?.class_id, content).toBe(id);
	}
});

test("LEDGERCLASS1: timeout, validation and check-answer shapes classify without the unclassified fallback", () => {
	const cases: [string, string, string][] = [
		["bash", "Extension /x/kit-save-guard.ts timed out after 30000ms", "timeout:bash"],
		["eval", "[eval cell timed out after 30s; kernel interrupted but keeps running]", "timeout:eval"],
		["bash", "find timed out after 20.0s at scoring passages", "timeout:bash"],
		["bash", "Error: EXPORT_COMPLETION_TIMEOUT at browser-run", "timeout:bash"],
		["edit", "This edit anchors to lines 8 of apps/x.ts, which were not fully displayed", "validation:edit-undisplayed-anchor"],
		["edit", "Edit rejected for omp-kit/x.ts: hash #1 is not from this session", "validation:edit-rejected"],
		["read", "Line 16 does not exist (file has 15 lines)", "validation:edit-line-out-of-range"],
		["bash", "error: patch failed: docs/x.md:1", "validation:edit-patch-failed"],
		["bash", "Error: cannot index [{}]", "validation:query-unindexable"],
		["bash", "a ``# pysafe`` comment without a reason suppression-no-reason", "validation:pysafe-suppression-reason"],
		["bash", "weekly_report_error: DECLARED_OPERATOR_AND_APPROVAL_REFERENCE_REQUIRED Wall time: 1s", "finding:bash"],
	];
	for (const [tool, content, id] of cases) {
		expect(classifyMineResult({ tool, result: { isError: true, content } })?.class_id, content).toBe(id);
	}
});

test("LEDGERCLASS1: agent input errors name the agent's mistake", () => {
	const cases: [string, string, string][] = [
		["eval", 'Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nNameError: name \'P\' is not defined', "agent-input:eval:nameerror"],
		["eval", 'Traceback (most recent call last):\n  File "<cell>", line 2, in <module>\nFileNotFoundError: [Errno 2] No such file', "agent-input:eval:path-not-found"],
		["eval", 'Traceback (most recent call last):\n  File "<cell>", line 1\nTypeError: cmd() takes 2 positional arguments but 3 were given', "agent-input:eval:invalid-arguments"],
		["bash", "Traceback (most recent call last):\n  File \"<cell>\", line 1", "agent-input:bash:python-error"],
		["edit", "`PUT 16.=16:` rejected: a selected boundary row is required for the file to parse", "validation:edit-rejected"],
		["bash", "error: patch fragment without header at line 314: @@ -850,6 +850,23 @@", "validation:edit-patch-failed"],
		["bash", "Apply failed: Overlapping replacements detected; refine pattern", "validation:edit-patch-failed"],
		["bash", "line 3: anchor line 494 is already targeted by another hunk on line 1. Issue ONE hunk", "validation:edit-patch-failed"],
		["bash", "line 1: payload line has no preceding hunk header. Use `PUT N.=M:`", "validation:edit-patch-failed"],
		["read", "Path 'scripts/commit-preflight.sh' not found", "agent-input:read:path-not-found"],
		["bash", "sh: scripts/commit-preflight.sh: No such file or directory", "agent-input:bash:path-not-found"],
		["bash", "bash: line 1: INFISICAL_TOKEN: unbound variable", "agent-input:bash:unbound-variable"],
		["bash", "src/x.ts(5,10): error TS2550: Property 'at' does not exist", "agent-input:bash:type-error"],
		["bash", "Cannot find module './missing' from '/repo/test'", "agent-input:bash:module-not-found"],
		["bash", "error: Module not found \"cli/src/index.ts\"", "agent-input:bash:module-not-found"],
		["bash", "node:internal/modules/package_json_reader:343 throw new ERR_MODULE_NOT_FOUND(packageName)", "agent-input:bash:module-not-found"],
		["bash", "Error: ENOENT: no such file or directory, open '/tmp/x'", "agent-input:bash:path-not-found"],
		["bash", "File not found: history_remove.py. Use the write tool to create new files.", "agent-input:bash:path-not-found"],
		["bash", "Cannot search omp://task.md: Documentation file not found: task.md Did you mean: natives", "agent-input:bash:unknown-reference"],
		["bash", "Unknown skill: foo-bar Available: ab-test-skill", "agent-input:bash:unknown-reference"],
		["bash", "fatal: unable to resolve revision: ladder.sh Ran in a temporary shell", "agent-input:bash:bad-git-state"],
		["bash", 'Error: {"error":{"type":"NOT_FOUND","message":"Agent not found: 235:LeadSource"}}', "agent-input:bash:unknown-agent"],
		["bash", "fatal: ambiguous argument 'HEAD': unknown revision or path", "agent-input:bash:bad-git-state"],
		["bash", "bash: -c: line 1: syntax error near unexpected token", "agent-input:bash:syntax-error"],
		["browser", 'ToolError: Unknown ARIA ref "e12". Run tab.ariaSnapshot() to refresh refs', "agent-input:browser:stale-ref"],
		["browser", 'ToolError: tab.click("x") failed fast after 2000ms; selector currently matches no elements', "agent-input:browser:selector-no-match"],
		["browser", 'ToolError: tab.press() takes (key, options) but was called as (selector, key)', "agent-input:browser:invalid-arguments"],
		["browser", "ToolError: handle.click() blocked: covered by <div>", "agent-input:browser:element-covered"],
		["bash", "error: unexpected argument '--fields' found", "agent-input:bash:invalid-arguments"],
		["bash", "error: pathspec 'x.ts' did not match any file(s) known to git", "agent-input:bash:path-not-found"],
		["bash", '{"code":"INVALID_ARGUMENTS","message":"bad grammar"}', "agent-input:bash:invalid-arguments"],
		["eval", "Error: R2 anchor count=0\n    at <anonymous> (js-cell-8757c316-adf4-4c1a:12:9)", "agent-input:eval:thrown-error"],
		["eval", "Error: Cannot find package '@noble/hashes' imported from /x/cell.ts", "agent-input:eval:module-not-found"],
	];
	for (const [tool, content, id] of cases) {
		expect(classifyMineResult({ tool, result: { isError: true, content } })?.class_id, content).toBe(id);
	}
});

test("LEDGERCLASS1: tool and environment failures stay tool-error rows with named causes", () => {
	const cases: [string, string, string][] = [
		["browser", "ToolError: No pages to adopt here (the browser would be connected)", "tool-error:browser:no-browser-target"],
		["browser", "ToolError: The browser relay at http://127.0.0.1:9224 is out of date", "tool-error:browser:stale-relay"],
		["read", "Tool execution was aborted: TTSR interrupt on another tool call", "tool-error:read:aborted"],
		["bash", "(node:123) [DEP001] DeprecationWarning: `module.register()` is deprecated", "tool-error:bash:warning"],
		["bash", "(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`", "tool-error:bash:warning"],
		["bash", '{"schemaVersion":1,"status":"RED","externalEffects":0}', "tool-error:bash:red-verdict"],
		["bash", '{"operationId":"x.pull","outcome":"partial","context":{}}', "tool-error:bash:incomplete-result"],
		["bash", '{"schemaVersion":"x","snapshotId":null,"delivery":"blocked"}', "tool-error:bash:delivery-blocked"],
		["bash", '1: "status": "BACKOFF" 5: "status": "BACKOFF"', "tool-error:bash:upstream-backoff"],
		["bash", 'error: twenty POST /attachments -> 500: {"error":"injected"}', "tool-error:bash:injected-fault"],
		["bash", "cf-secret: <redacted> failed — Infisical unreachable, no cache fallback", "tool-error:bash:backend-unreachable"],
		["bash", "cf-secret: <redacted> fetch failed Wall time: 1.98 seconds", "tool-error:bash:backend-unreachable"],
		["bash", "Error: twenty /cfsJobs incomplete: collected 2 with no cursor to advance at getAllPages", "tool-error:bash:incomplete-result"],
		["bash", '{"schemaVersion":1,"operationId":"x.render","context":{},"outcome":"conflict"}', "tool-error:bash:version-conflict"],
		["bash", '{"schemaVersion":1,"operationId":"x.pull","context":{},"outcome":"complete","sources":[]}', "tool-error:bash:wrapper-failed"],
		["bash", "error: send_message failed; queued a durable UNSENT artifact at /tmp/x", "tool-error:bash:message-unsent"],
		["bash", "cat: artifact://1:raw:1-1: Input/output error Command exited with code 1", "tool-error:bash:io-error"],
		["bash", "{'action': 'APPLIED', 'overall': 'UNVERIFIED', 'receipt_id': 'x'}", "finding:bash"],
		["bash", '{"ok":false,"data":{"bead":"b1","log":"refused: X is the assignee","overall":"NON_AUTHOR_REQUIRED"}}', "guard-friction:NON_AUTHOR_REQUIRED"],
		["bash", "cfs-infisical-run: machine-identity login failed", "tool-error:bash:backend-unreachable"],
		["bash", "io: git config: fatal: Unable to read current working directory: No such file or directory", "agent-input:bash:path-not-found"],
		["bash", "Identity resolution: Error: MISSING_PANE_ID: No pane_id provided", "tool-error:bash:identity-unresolved"],
		["bash", '{"schemaVersion":1,"error":{"code":"INVALID_LOCAL_RESULT"}}', "tool-error:bash:INVALID_LOCAL_RESULT"],
		["bash", '{"bridgeStatus":503,"error":"Shared lead card update unavailable"} {"phase":"cleaned"}', "tool-error:bash:upstream-unavailable"],
		["bash", '{"status":503,"messageUnchanged":true}', "tool-error:bash:upstream-unavailable"],
		["bash", "✖ dry run is default and performs no uploads (0.84ms) ✖ planted failed gate sends owner alert", "tool-error:bash:test-failure"],
		["bash", "rd=1 ℹ tests 30 ℹ pass 29 ℹ fail 1 Wall time: 27.95 seconds", "tool-error:bash:test-failure"],
		["bash", "unfixed_rc=1 Expected: 1 Received: 0 (fail) a shard whose connection drops leaves no verdict", "tool-error:bash:test-failure"],
		["bash", "bun test v1.4.3 test/reports-weekly.test.ts:\n327 | expect(createHash(\"sha256\").update(x))", "tool-error:bash:test-failure"],
		["bash", "bun test v1.4.3 test/g.test.ts: # Unhandled error between tests --- error: boom", "tool-error:bash:test-failure"],
		["bash", "rc=1 error: fixture plan rejected (fail) update derives the denominator", "tool-error:bash:test-failure"],
		["bash", "not ok 3 - retains native commits", "tool-error:bash:test-failure"],
		["bash", "Command aborted", "tool-error:bash:aborted"],
		["eval", "[Kernel died during execution; completion is uncertain]", "tool-error:eval:kernel-died"],
		["bash", "--- a/report.json\n+++ b/report.json\n@@ -1,3 +1,3 @@\n-old\n+new", "tool-error:bash:diff-differs"],
		["bash", "Files out/a.json and out/b.json differ", "tool-error:bash:diff-differs"],
		["bash", '1c1\n< {"expectations":1}\n---\n> {"expectations":2}', "tool-error:bash:diff-differs"],
		["mcp__mcp_agent_mail_whois", "MCP failure\nserver: mcp-agent-mail\ntool: whois\ntransport: http\nstage: send\nfailure: timeout\nretryable: no\nmessage: Request timeout after 30000ms", "mcp-transport:mcp__mcp_agent_mail_whois"],
		// RECLASS2: the live ledger shapes 0.2.110 still left unclassified (24 h of 2026-11-10 rows).
		["bash", "Working directory does not exist: /repo/var/agent-tmp/gone/fx", "tool-error:bash:missing-cwd"],
		["bash", '{"result": "LAUNCHED", "session": "s", "block": "1", "agent": "A", "pid": 2}\nCommand exited with code 143', "tool-error:bash:seat-restarted"],
		["bash", "Ran 595 tests in 44.017s\n\nFAILED (failures=47, errors=336, skipped=1)", "tool-error:bash:test-failure"],
		["bash", "(no output)\n\nWall time: 1.77 seconds\nCommand exited with code 1", "tool-error:bash:silent-exit"],
		["bash", "(no output) Wall time: 1.77 seconds Command exited with code 1", "tool-error:bash:silent-exit"],
		["bash", "exit=0 Command exited with code 1", "tool-error:bash:silent-exit"],
		["bash", "error: corrupt patch at line 57\nCommand exited with code 128", "validation:edit-patch-failed"],
		["bash", "patching file 'a.mjs'\npatch: **** malformed patch at line 10: @@ -1,6 +1,8 @@", "validation:edit-patch-failed"],
		["edit", 'Validation failed for tool "edit": - input: input must be a string (was missing)', "agent-input:edit:invalid-arguments"],
		["write", 'Invalid args for xd://retain: Validation failed for tool "retain": - items: missing', "agent-input:write:invalid-arguments"],
	];
	for (const [tool, content, id] of cases) {
		expect(classifyMineResult({ tool, result: { isError: true, content } })?.class_id, content).toBe(id);
	}
});

test("LEDGERCLASS1 boundaries: generic errors, bare exits and redacted bodies stay unclassified", () => {
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "Error: something went wrong" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "the timeout finished but nothing matched" } })?.class_id).toBe("tool-error:unclassified");
	// RECLASS2 boundary: a status-only line is silent-exit, but any other word in it leaves it unclassified,
	// and a long run of numbers is bounded before the pattern runs.
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "(no output) something Command exited with code 1" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "1 ".repeat(5_000) + "x Command exited with code 1" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "[REDACTED]" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "Rule: ghp_" + "x".repeat(20) } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "This edit anchors to lines " + "x".repeat(65_536) + " timeout" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "Rule: " + "y".repeat(65_536) + " timeout" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: '{"overall":"NOT_RUN"}' } })?.class_id).toBe("tool-error:unclassified");
	// Boundaries of the diff/eval/MCP shapes: a stack frame outside a JS cell, a "Files ... differ" with a spaced
	// path, prose mentioning a command abort and a lone "MCP failure" line name nothing.
	for (const content of ["Error: boom\n    at main (/x/app.ts:3:1)", "Files my report.json and b.json differ", "the Command aborted earlier", "MCP failure\nmessage: boom"])
		expect(classifyMineResult({ tool: "bash", result: { isError: true, content } })?.class_id, content).toBe("tool-error:unclassified");
});

test("LEDGERCLASS1: a fully redacted body stays unclassified without leaking", () => {
	const credential = "ghp_" + "a".repeat(40);
	const mined = classifyMineResult({ tool: credential, result: { isError: true, content: `Extension /x timed out after 30000ms ${credential}` } });
	expect(mined?.class_id).toBe("tool-error:unclassified");
	expect(JSON.stringify(mined)).not.toContain("ghp_");
	const ruled = classifyMineResult({ tool: "bash", result: { isError: true, content: `fleet-guard ${credential}: boom` } });
	expect(ruled?.class_id).toBe("tool-error:unclassified");
	expect(JSON.stringify(ruled)).not.toContain("ghp_");
});

// GATEBUDGETHYGIENE1 (ompkit-1ra0d.129): the refusal budget counts real refusals only, so a
// shim or handoff refusal observed in command output files under its real code, never as a
// tool-error row. Planted negative: the pre-fix classifier filed these as tool-error:unclassified.
test("GATEBUDGETHYGIENE1: shim and handoff refusals file under their real code, never tool-error:unclassified", () => {
	const handoff = "br-shim: HANDOFF_UNGATED requires a complete GREEN observation for the exact DONE source /r@abc; run: br verify";
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: handoff } })?.class_id).toBe("guard-friction:HANDOFF_UNGATED");
	const midline = "comment_rc 4 br-shim: BR_SHIM_RESERVATION_UNKNOWN Agent Mail cannot verify X (rc=1): error: x";
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: midline } })?.class_id).toBe("guard-friction:BR_SHIM_RESERVATION_UNKNOWN");
	const bare = "HANDOFF_UNGATED requires a complete GREEN observation";
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: bare } })?.class_id).toBe("guard-friction:HANDOFF_UNGATED");
	// The writer files them under the bare code, not tool-error:unclassified.
	expect(budgetLedgerGate("guard-friction:HANDOFF_UNGATED")).toBe("HANDOFF_UNGATED");
	expect(budgetLedgerGate("guard-friction:BR_SHIM_IDENTITY_REQUIRED")).toBe("BR_SHIM_IDENTITY_REQUIRED");
});

// GATEBUDGETHYGIENE1 (ompkit-1ra0d.129): classifier exhaust is not a refusal row; one refusal
// writes one row under its real code. Planted negative: the pre-fix writer emitted the second
// row below as guard-friction:SELF_CLOSE_REFUSED, so the ledger held the refusal twice.
test("GATEBUDGETHYGIENE1: classifier exhaust never becomes a refusal row; one refusal writes one row under its real code", async () => {
	const dir = ownedTmp("budget-hygiene").path;
	for (const exhaust of ["finding:bash", "finding:eval", "mcp-transport:mcp__mcp_agent_mail_ensure_project", "mcp-transport:mcp__mcp_agent_mail_fetch_inbox", "kit-flywheel-guard", "kit-flywheel-guard:", "commit-refusal:COMMIT_INCOMPLETE", "guard-friction:"]) {
		expect(budgetLedgerGate(exhaust), exhaust).toBeNull();
	}
	const passthrough: [string, string][] = [
		["guard-friction:SELF_CLOSE_REFUSED", "SELF_CLOSE_REFUSED"],
		["SELF_CLOSE_REFUSED", "SELF_CLOSE_REFUSED"],
		["HANDOFF_UNGATED", "HANDOFF_UNGATED"],
		["agent-input:bash:path-not-found", "agent-input:bash:path-not-found"],
		["tool-error:bash:test-failure", "tool-error:bash:test-failure"],
		["validation:edit-rejected", "validation:edit-rejected"],
	];
	for (const [gate, want] of passthrough) {
		expect(budgetLedgerGate(gate), gate).toBe(want);
	}
	// One refused act: the guard's own row plus the re-observed classification collapse to one row.
	const attempt = "attempt-budget-1";
	const ledger = join(dir, "budget-ledger.jsonl");
	const first = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "kit-1", gate: "SELF_CLOSE_REFUSED", kind: "refuse", attempt, event_id: attempt, detail: "kit-flywheel-guard SELF_CLOSE_REFUSED: held" }, { path: ledger });
	expect(first.ok).toBe(true);
	const cause = classifyMineResult({ tool: "bash", result: { isError: true, content: "kit-flywheel-guard SELF_CLOSE_REFUSED: not the author" } });
	expect(cause?.class_id).toBe("guard-friction:SELF_CLOSE_REFUSED");
	if (cause === null) throw new Error("expected the refusal text to classify");
	const gate = budgetLedgerGate(cause.class_id);
	expect(gate).toBe("SELF_CLOSE_REFUSED");
	if (gate !== null) await recordGateEvent({ seat: "PlumRaven", act: "unknown", target: null, gate, kind: "refuse", attempt, event_id: attempt, detail: cause.summary }, { path: ledger });
	const rows = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ gate: "SELF_CLOSE_REFUSED", kind: "refuse", attempt });
	// A shim refusal observed in command output writes one row under its real code.
	const shim = classifyMineResult({ tool: "bash", result: { isError: true, content: "closed rc 4 br-shim: BR_SHIM_IDENTITY_REQUIRED refusing to run br without AGENT_NAME" } });
	if (shim === null) throw new Error("expected the shim refusal to classify");
	const shimGate = budgetLedgerGate(shim.class_id);
	expect(shimGate).toBe("BR_SHIM_IDENTITY_REQUIRED");
	if (shimGate !== null) await recordGateEvent({ seat: "PlumRaven", act: "bash", target: null, gate: shimGate, kind: "refuse", attempt: "attempt-budget-2", event_id: "attempt-budget-2", detail: shim.summary }, { path: ledger });
	const after = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(after).toHaveLength(2);
	expect(after[1]).toMatchObject({ gate: "BR_SHIM_IDENTITY_REQUIRED", kind: "refuse" });
});
