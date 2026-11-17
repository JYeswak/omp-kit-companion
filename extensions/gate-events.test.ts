import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateEventsPath, gateFromReason, observeNativeToolModel, recordGateEvent, trackerAct } from "./gate-events";
import { recordNativeToolAttempt, type NativeToolAttemptInput } from "../src/native-tool-attempts.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { captureMineReplay } from "../src/mine-replay.ts";

const base = ownedTmp("gate-events").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("trackerAct: the tracker acts the fleet measures, with their targets", () => {
	expect(trackerAct("br close ompkit-774u.1.3 --reason x")).toEqual({ act: "close", target: "ompkit-774u.1.3" });
	expect(trackerAct("cd x && br --db d update ompkit-fixjo --claim --actor y")).toEqual({ act: "claim", target: "ompkit-fixjo" });
	expect(trackerAct("AGENT_NAME=x br --db /p/beads.db update ompkit-fp72.135.3.1 --status in_review --actor z")).toEqual({ act: "in-review", target: "ompkit-fp72.135.3.1" });
	expect(trackerAct('br update ompkit-a1 --status open --assignee ""')).toEqual({ act: "release", target: "ompkit-a1" });
	expect(trackerAct("br create --title t")).toEqual({ act: "create", target: null });
});

test("trackerAct planted: words that are not an invocation are not acts", () => {
	for (const command of ["git commit -m close", "brew update x", "echo br close", "grep br close f", "br show ompkit-a1 --json"]) {
		expect(trackerAct(command)).toBeNull();
	}
});

test("gateFromReason: JSON code, prose code, and the guard name as fallback", () => {
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard", code: "CLAIM_REFUSED", refusal: {} }))).toBe("CLAIM_REFUSED");
	expect(gateFromReason("kit-flywheel-guard BEAD_LINT_REFUSED: `br update` would leave")).toBe("BEAD_LINT_REFUSED");
	expect(gateFromReason("[kit-agent-mail-guard] AM_IDENTITY_MISMATCH: y")).toBe("AM_IDENTITY_MISMATCH");
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard" }))).toBe("kit-flywheel-guard");
});

test("gateFromReason: a prefixed refusal preserves its own code within three lines", () => {
	const refusal = [
		"CONSTRAINT full-suite wall 900/600 clearing=fx-1 holder=FixtureBuilder",
		"kit-flywheel-guard CLAIM_REFUSED: peer retains custody.",
		"Choose ready work without taking peer bytes.",
	].join("\n");
	expect(gateFromReason(refusal)).toBe("CLAIM_REFUSED");
	expect(gateFromReason(`CONSTRAINT none declarer=Lead\nkit-flywheel-guard SELF_CLOSE_REFUSED: x`)).toBe("SELF_CLOSE_REFUSED");
	expect(gateFromReason(`CONSTRAINT none declarer=Lead\nNo valid constraint.\n[kit-agent-mail-guard] AM_IDENTITY_MISMATCH: y`)).toBe("AM_IDENTITY_MISMATCH");
	// A quoted header beyond line three is not the refusal's own.
	expect(gateFromReason("CONSTRAINT x\na\nb\nkit-flywheel-guard CLAIM_REFUSED: quoted")).toBe("CONSTRAINT");
	// Linear on a long multi-line near-miss: only three lines are split and matched.
	const nearMiss = `kit-flywheel-guard ${"a".repeat(50_000)}\n`.repeat(200);
	const t0 = performance.now();
	expect(gateFromReason(nearMiss)).toBe("kit-flywheel-guard");
	expect(performance.now() - t0).toBeLessThan(500); // wallclock: p99=1.3ms headroom=380x (50 runs, 2026-11-04)
});

test("recordGateEvent appends one row per event under the state dir and never throws on a bad path", async () => {
	const env = { XDG_STATE_HOME: join(base, "state") };
	const path = gateEventsPath(env, base);
	expect(path).toBe(join(base, "state", "omp-kit", "gate-events.jsonl"));
	const first = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "SELF_CLOSE_REFUSED", kind: "refuse", detail: "x" }, { env, home: base });
	const second = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "flywheel", kind: "pass" }, { env, home: base });
	expect(first).toMatchObject({ ok: true, path });
	expect(second).toMatchObject({ ok: true, path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.map(r => [r.act, r.gate, r.kind, r.target])).toEqual([["close", "SELF_CLOSE_REFUSED", "refuse", "ompkit-a1"], ["close", "flywheel", "pass", "ompkit-a1"]]);
	expect(rows.every(r => typeof r.ts === "string" && r.seat === "PlumRaven")).toBe(true);
	expect(rows.every(r => "repo" in r && r.member === r.gate && Number.isFinite(Date.parse(r.started_at)) && r.duration_s >= 0)).toBe(true);
	// planted: a path whose parent is a file is reported, not thrown; the good ledger is untouched
	writeFileSync(join(base, "not-a-dir"), "x");
	const bad = await recordGateEvent({ seat: null, act: "claim", target: null, gate: "x", kind: "refuse" }, { path: join(base, "not-a-dir", "gate-events.jsonl") });
	expect(bad.ok).toBe(false);
	expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});

test("recordGateEvent retains sanitized replay and raw event identity before bounding", async () => {
	const path = join(base, "replay.jsonl");
	const sentinel = `ghp_${"7cX9".repeat(10)}`;
	const event = {
		seat: "PlumRaven", act: "bash", target: null, gate: "INPUT_REFUSED", kind: "refuse" as const,
		event_id: "native-tool-call-17",
		replay: {
			version: 1 as const, tool: "bash", arguments: { command: "echo ordinary", registration_token: "private-binding-value", oversized: `${"x".repeat(70000)} ${sentinel}` },
			cwd: "/repo", staged_paths: null, diff_sha256: null, message: null, custody: null,
			redacted: false, truncated: false, missing: ["staged_paths", "diff_sha256", "message", "custody"],
		},
	};
	expect((await recordGateEvent(event, { path })).ok).toBe(true);
	const row = JSON.parse(readFileSync(path, "utf8"));
	expect(row.event_id).toBe("native-tool-call-17");
	expect(row.replay.arguments.command).toBe("echo ordinary");
	expect(row.replay.redacted).toBe(true);
	expect(row.replay.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(row.replay))).toBeLessThanOrEqual(32768);
	expect(JSON.stringify(row)).not.toContain(sentinel);
	expect(JSON.stringify(row)).not.toContain("private-binding-value");
});

test("recordGateEvent records repo root and supplied check clock without replacing old fields", async () => {
	const repo = join(base, "timed-repo"), nested = join(repo, "nested");
	mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(nested);
	const path = join(base, "timed.jsonl"), started_at = "2026-11-03T12:00:00Z";
	await recordGateEvent({ seat: "Fixture", act: "publish", target: "main", gate: "40-full", kind: "pass",
		replay: captureMineReplay({ cwd: nested }), started_at, duration_s: 12.5 }, { path });
	expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ repo, member: "40-full", started_at, duration_s: 12.5,
		act: "publish", target: "main", gate: "40-full", kind: "pass" });
	expect((await recordGateEvent({ seat: null, act: "publish", target: null, gate: "bad", kind: "pass", duration_s: -1 }, { path })).ok).toBe(false);
});

test("recordGateEvent scrubs bounded metadata including unexpected credential-shaped IDs", async () => {
	const path = join(base, "metadata.jsonl");
	const sentinel = `ghp_${"7cX9".repeat(10)}`;
	await recordGateEvent({ seat: sentinel, act: sentinel, target: sentinel, gate: sentinel, kind: "refuse",
		attempt: sentinel, event_id: sentinel, detail: `${"x".repeat(70000)} ${sentinel}` }, { path });
	const raw = readFileSync(path, "utf8");
	const row = JSON.parse(raw);
	expect(raw).not.toContain(sentinel);
	expect(row.metadata_redacted).toBe(true);
	expect(row.metadata_truncated).toBe(true);
	expect(row.target).not.toBe(sentinel);
	expect(row.event_id).not.toBe(sentinel);
});

test("recordGateEvent rescreens split secret flags in untrusted retained argv", async () => {
	const path = join(base, "split-flags.jsonl");
	const replay = { ...captureMineReplay({ arguments: {} }), arguments: { argv: ["--api-key", "short-test-value", "--password=x", "-px", "--project", "visible-value", "--token"] } };
	await recordGateEvent({ seat: null, act: "commit", target: null, gate: "fixture", kind: "refuse", replay }, { path });
	const row = JSON.parse(readFileSync(path, "utf8"));
	expect(row.replay.arguments.argv).toEqual(["--api-key", "[REDACTED]", "--password=[REDACTED]", "-p[REDACTED]", "--project", "visible-value", "--token"]);
	expect(row.replay.redacted).toBe(true);
});

test("LEDGERCLASS1: one refused act writes one row; the derived second write is absorbed", async () => {
	const path = join(base, "ledgerclass-dedup.jsonl");
	const first = await recordGateEvent({ seat: "PlumRaven", act: "bash", target: null, gate: "PARTIAL_RELEASE_REFUSED", kind: "refuse",
		attempt: "attempt-dedup-1", event_id: "attempt-dedup-1", detail: "kit-flywheel-guard PARTIAL_RELEASE_REFUSED: held" }, { path });
	expect(first.ok).toBe(true);
	const second = await recordGateEvent({ seat: "PlumRaven", act: "unknown", target: null, gate: "guard-friction:PARTIAL_RELEASE_REFUSED", kind: "refuse",
		attempt: "attempt-dedup-1", event_id: "attempt-dedup-1", detail: "kit-flywheel-guard PARTIAL_RELEASE_REFUSED: held" }, { path });
	expect(second).toMatchObject({ ok: true, path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ gate: "PARTIAL_RELEASE_REFUSED", kind: "refuse", attempt: "attempt-dedup-1" });
});

test("LEDGERCLASS1: a derived refusal without a prior refusal is still recorded once", async () => {
	const path = join(base, "ledgerclass-singleton.jsonl");
	const only = await recordGateEvent({ seat: null, act: "read", target: null, gate: "guard-friction:IDENTITY_UNBOUND", kind: "refuse",
		attempt: "attempt-single-1", event_id: "attempt-single-1", detail: "kit-agent-mail-guard IDENTITY_UNBOUND" }, { path });
	expect(only.ok).toBe(true);
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ gate: "guard-friction:IDENTITY_UNBOUND", kind: "refuse" });
});

test("LEDGERCLASS1: a pass sibling does not absorb a later derived refusal; a commit-refusal derived row is absorbed", async () => {
	const path = join(base, "ledgerclass-pass.jsonl");
	await recordGateEvent({ seat: "PlumRaven", act: "close", target: "kit-1", gate: "kit-flywheel-guard", kind: "pass", attempt: "attempt-pass-1" }, { path });
	await recordGateEvent({ seat: "PlumRaven", act: "unknown", target: null, gate: "guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE", kind: "refuse", attempt: "attempt-pass-1" }, { path });
	await recordGateEvent({ seat: "PlumRaven", act: "commit", target: null, gate: "COMMIT_INCOMPLETE", kind: "refuse", attempt: "attempt-commit-1" }, { path });
	await recordGateEvent({ seat: "PlumRaven", act: "unknown", target: null, gate: "commit-refusal:COMMIT_INCOMPLETE", kind: "refuse", attempt: "attempt-commit-1" }, { path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.map(row => [row.gate, row.kind])).toEqual([
		["kit-flywheel-guard", "pass"],
		["guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE", "refuse"],
		["COMMIT_INCOMPLETE", "refuse"],
	]);
});

test("LEDGERCLASS1 planted negative: a passing act writes one pass row and no refusal", async () => {
	const path = join(base, "ledgerclass-pass-only.jsonl");
	await recordGateEvent({ seat: "PlumRaven", act: "close", target: "kit-9", gate: "kit-flywheel-guard", kind: "pass", attempt: "attempt-passonly-1" }, { path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ gate: "kit-flywheel-guard", kind: "pass" });
});

const nativeNow = Date.parse("2026-11-16T00:00:00.000Z");
test("native tool attempts count successful, refused, and error lifecycles once across reopen", async () => {
	const path = join(base, "native-attempts.json");
	const input = nativeInput({ tool_call_id: "call-one" });
	await recordNativeToolAttempt({ ...input, phase: "start", is_error: null }, { path, now: () => nativeNow });
	await recordNativeToolAttempt({ ...input, phase: "end", is_error: false }, { path, now: () => nativeNow + 1 });
	await recordNativeToolAttempt({ ...input, phase: "end", own_guard: "UNOBSERVED", is_error: false }, { path, now: () => nativeNow + 2 });
	await recordNativeToolAttempt({ ...input, phase: "start", is_error: null }, { path, now: () => nativeNow + 3 });
	const refusal = nativeInput({ tool_call_id: "call-two", own_guard: "REFUSED" });
	await recordNativeToolAttempt({ ...refusal, phase: "start", is_error: null }, { path, now: () => nativeNow + 4 });
	await recordNativeToolAttempt({ ...refusal, phase: "end", is_error: true }, { path, now: () => nativeNow + 5 });
	await recordNativeToolAttempt({ ...nativeInput({ tool_call_id: "call-three" }), phase: "end", is_error: true }, { path, now: () => nativeNow + 6 });
	const rows = JSON.parse(readFileSync(path, "utf8"));
	expect(rows.windows[0].buckets).toContainEqual(expect.objectContaining({
		seat: "seat-a", tool: "shell", model: "model-a", attempted: 3, own_guard_observed: 3,
		own_guard_refused: 1, native_error_results: 2, own_guard_refusal_rate: 1 / 3, all_guard_refusal_rate: null,
	}));
	requireNativeCohort(rows.windows[0].buckets[0]);
});

test("native tool attempts separate buckets and keep incomplete rates unknown", async () => {
	const path = join(base, "native-attempts-separate.json");
	for (const input of [
		nativeInput({ tool_call_id: "one" }),
		nativeInput({ tool_call_id: "two", tool: "read" }),
		nativeInput({ tool_call_id: "three", model: "model-b" }),
		nativeInput({ tool_call_id: "four", seat: "seat-b" }),
		nativeInput({ tool_call_id: "five", model: null }),
	]) await recordNativeToolAttempt(input, { path, now: () => nativeNow });
	const state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.windows[0].buckets).toHaveLength(5);
	const unknown = state.windows[0].buckets.find((bucket: { model: string | null }) => bucket.model === null);
	expect(unknown).toMatchObject({ attempted: 1, own_guard_refusal_rate: null, all_guard_refusal_rate: null });
	expect(state.windows[0].coverage.status).toBe("INCOMPLETE");
});

function nativeInput(overrides: Partial<NativeToolAttemptInput> = {}): NativeToolAttemptInput {
	return {
		seat: "seat-a", tool: "shell", tool_call_id: "call", session_id: "session-a", journal_identity: "journal-a",
		assistant_id: "assistant-a", assistant_at: "2026-11-16T00:00:00.000Z",
		model: "model-a", provider: "provider-a", attribution_reason: "bound-assistant",
		own_guard: "ALLOWED", phase: "end", is_error: false, observer_id: "observer-a", ...overrides,
	};
}
test("native tool attempts preserve corrupt state and report identity conflicts as incomplete", async () => {
	const path = join(base, "native-attempts-conflict.json");
	const first = nativeInput({ tool_call_id: "shared" });
	await recordNativeToolAttempt(first, { path, now: () => nativeNow });
	await recordNativeToolAttempt({ ...first, model: "model-b" }, { path, now: () => nativeNow + 1 });
	const state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.windows[0].coverage).toMatchObject({ status: "INCOMPLETE", reasons: ["IDENTITY_BINDING_CONFLICT"] });
	const corrupt = join(base, "native-attempts-corrupt.json");
	writeFileSync(corrupt, "{not-json");
	expect(await recordNativeToolAttempt(nativeInput(), { path: corrupt, now: () => nativeNow })).toMatchObject({ ok: false });
	expect(readFileSync(corrupt, "utf8")).toBe("{not-json");
});

test("native tool attempts serialize concurrent writers without losing successful attempts", async () => {
	const path = join(base, "native-attempts-concurrent.json");
	await Promise.all(Array.from({ length: 16 }, (_, index) =>
		recordNativeToolAttempt(nativeInput({ tool_call_id: `parallel-${index}` }), { path, now: () => nativeNow })));
	const state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.windows[0].buckets[0]).toMatchObject({ attempted: 16, own_guard_observed: 16 });
});
test("native tool attempts cap identifiers and preserve a lower-bound incomplete rate", async () => {
	const path = join(base, "native-attempts-cap.json");
	for (let index = 0; index < 129; index++) {
		await recordNativeToolAttempt(nativeInput({ tool_call_id: `cap-${index}` }), { path, now: () => nativeNow });
	}
	const state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.windows[0].attempts).toHaveLength(128);
	expect(state.windows[0].coverage.status).toBe("INCOMPLETE");
	expect(state.windows[0].buckets[0]).toMatchObject({ attempted: 128, own_guard_refusal_rate: null });
});
test("native tool attempts deduplicate retained identities across changed windows", async () => {
	const path = join(base, "native-attempts-cross-window.json");
	const first = nativeInput({ tool_call_id: "same" });
	await recordNativeToolAttempt(first, { path, now: () => nativeNow });
	await recordNativeToolAttempt({ ...first, assistant_at: "2026-11-16T00:10:00.000Z" },
		{ path, now: () => nativeNow + 600_000 });
	const state = JSON.parse(readFileSync(path, "utf8"));
	expect(state.windows).toHaveLength(1);
	expect(state.windows[0].coverage).toMatchObject({ status: "INCOMPLETE", reasons: ["IDENTITY_BINDING_CONFLICT"] });
	expect(state.windows[0].buckets[0]).toMatchObject({ attempted: 1 });
});
test("native tool attempt persistence drops extra runtime fields and redacted metadata", async () => {
	const path = join(base, "native-attempts-redacted.json");
	const unsafe = {
		...nativeInput({ tool_call_id: "redacted-call", model: "api_key=sentinel-secret" }),
		prompt: "sentinel-secret",
		native_args: { password: "sentinel-secret" },
	} as NativeToolAttemptInput;
	await recordNativeToolAttempt(unsafe, { path, now: () => nativeNow });
	const serialized = readFileSync(path, "utf8");
	expect(serialized).not.toContain("sentinel-secret");
	expect(JSON.parse(serialized).windows[0].attempts[0]).not.toHaveProperty("prompt");
});

/** Compile the real module/IO closure, changing only the named production statement.
 * A runtime-selected bundled mutant cannot use a static import or a shared module mock.
 * Compilation, import and IO errors stay outside the semantic mutant-kill assertion. */
async function nativeImplementation<T>(path: string, before: string, after: string): Promise<T> {
	const original = readFileSync(path, "utf8");
	const contents = original.replace(before, after);
	if (contents === original) throw new Error("Native mutant target unavailable");
	const built = await Bun.build({
		entrypoints: [path], target: "bun", write: false,
		plugins: [{ name: "native-attempt-negative", setup(build) {
			build.onLoad({ filter: /[.]ts$/ }, args => args.path === path ? { contents, loader: "ts" } : undefined);
		} }],
	});
	if (!built.success || built.outputs.length !== 1) throw new Error("Native mutant compilation failed");
	return await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString("base64")}`);
}

function requireNativeCohort(bucket: Record<string, unknown>): void {
	if (bucket.attempted !== 3 || bucket.own_guard_observed !== 3 || bucket.own_guard_refused !== 1
		|| bucket.native_error_results !== 2 || bucket.own_guard_refusal_rate !== 1 / 3 || bucket.all_guard_refusal_rate !== null)
		throw new Error("NATIVE_ATTEMPT_COHORT_MISMATCH");
}

for (const mutant of ["omitted-success", "double-count"] as const) {
	test(`GATEMODELRATE1: executed ${mutant} production mutant loses the native cohort oracle`, async () => {
		const path = join(base, `executed-${mutant}.json`);
		const implementation = await nativeImplementation<{ recordNativeToolAttempt: typeof recordNativeToolAttempt }>(
			join(import.meta.dir, "../src/native-tool-attempts.ts"),
			mutant === "omitted-success" ? "const captured = sanitizeInput(input);" : "bucket.attempted++;",
			mutant === "omitted-success"
				? 'if (input.own_guard === "ALLOWED" && input.is_error !== true) return { ok: true, path: options.path! };\n\tconst captured = sanitizeInput(input);'
				: "bucket.attempted += 2;",
		);
		for (const input of [
			nativeInput({ tool_call_id: "issued-refusal", own_guard: "REFUSED", is_error: true }),
			nativeInput({ tool_call_id: "issued-success", is_error: false }),
			nativeInput({ tool_call_id: "issued-error", is_error: true }),
		]) {
			const result = await implementation.recordNativeToolAttempt(input, { path, now: () => nativeNow });
			if (!result.ok) throw new Error(`Native mutant failed before the cohort oracle: ${result.why}`);
		}
		const bucket = JSON.parse(readFileSync(path, "utf8")).windows[0].buckets[0];
		expect(() => requireNativeCohort(bucket)).toThrow("NATIVE_ATTEMPT_COHORT_MISMATCH");
	});
}

test("GATEMODELRATE1: executed default-model production mutant loses the real refusal-row oracle", async () => {
	const sessionFile = join(base, "executed-model-session.jsonl");
	const assistant = { id: "served-assistant", parentId: null, type: "message", timestamp: new Date(nativeNow).toISOString(),
		message: { role: "assistant", model: "native-served", provider: "native-provider",
			content: [{ type: "toolCall", id: "issued-model-call", name: "bash" }] } };
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "served-session" })}\n${JSON.stringify(assistant)}\n`);
	const ctx = { sessionManager: {
		getSessionId: () => "served-session", getSessionFile: () => sessionFile,
		getLeafId: () => assistant.id, getEntry: () => assistant,
	} };
	const healthy = { observeNativeToolModel, recordGateEvent };
	const faulty = await nativeImplementation<typeof healthy>(join(import.meta.dir, "gate-events.ts"),
		'return { status: "KNOWN", model, provider, source: proof };',
		'return { status: "KNOWN", model: "registration-default", provider, source: proof };');
	const requireCausalRow = (row: Record<string, unknown>) => {
		if (row.kind !== "refuse" || row.model !== "native-served" || row.provider !== "native-provider")
			throw new Error("NATIVE_CAUSAL_MODEL_MISMATCH");
	};
	for (const [label, implementation] of [["healthy", healthy], ["default-model", faulty]] as const) {
		const path = join(base, `executed-${label}.jsonl`);
		const attribution = implementation.observeNativeToolModel(ctx, "issued-model-call", "bash");
		const result = await implementation.recordGateEvent({ seat: "seat-a", act: "close", target: "kit-a",
			gate: "SELF_CLOSE_REFUSED", kind: "refuse", attribution, attempt: "issued-model-call" }, { path });
		if (!result.ok) throw new Error(`Native model case failed before the row oracle: ${result.why}`);
		const row = JSON.parse(readFileSync(path, "utf8").trim());
		if (label === "healthy") { requireCausalRow(row); expect(row.attribution).toMatchObject({ status: "KNOWN", source: { tool_call_id: "issued-model-call" } }); }
		else expect(() => requireCausalRow(row)).toThrow("NATIVE_CAUSAL_MODEL_MISMATCH");
	}
});
