import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { inspectModelLedger, observeAuthorClaim, observeWorkingModel, MODEL_LEDGER_MAX_READ_BYTES } from "../../src/model-ledger.ts";
import { appendVerifyCorrection, inspectVerifyLedger } from "../../src/verify-ledger.ts";
import type { VerifyLedgerInspection } from "../../src/verify-ledger.ts";
import { verifyBead, type VerifyResult } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { nativeBr } from "./lib/native-br.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fixturePycachePrefix } from "./lib/fixture-pycache.ts";
import { projectActivityRecords } from "../../src/model-activity.ts";
import type { ModelActivityInspection } from "../../src/model-activity.ts";
import type { ActivityEvent, ActivityModel } from "../../src/model-activity-schema.ts";
import { appendActivityEvent, readActivityJournal } from "../../src/model-activity-journal.ts";
import { ACTIVITY_DIRECTORY, ACTIVITY_MAX_DAY_BYTES, ACTIVITY_MAX_FILES, ACTIVITY_MAX_READ_BYTES, isActivityEvent } from "../../src/model-activity-schema.ts";
import type { ActivityApi, ActivityContext, default as ActivityExtension } from "../../extensions/kit-model-activity.ts";

const sessionId = "claimmodel-session";
const claimCall = "claimmodel-claim-call";
const closeCall = "claimmodel-close-call";
function journal(path: string, records: unknown[], id = sessionId): void {
	writeFileSync(path, [
		{ type: "session", version: 3, id, cwd: "/claimmodel-fixture" },
		...records,
	].map(row => JSON.stringify(row)).join("\n") + "\n");
}
function assistant(id: string, parentId: string | null, call: string, model: string, provider = "openai-codex") {
	return { type: "message", id, parentId, message: { role: "assistant", provider, model,
		stopReason: "toolUse", content: [{ type: "toolCall", id: call, name: "bash", arguments: { command: "br update fixture --claim" } }] } };
}
function observe(path: string, call = claimCall, expectedSession = sessionId) {
	return observeWorkingModel({ PI_SESSION_FILE: path, PI_SESSION_ID: expectedSession, PI_TOOL_CALL_ID: call,
		BR_MODEL: "registration-is-not-evidence", OMP_MODEL: "default-is-not-evidence" });
}

test("CLAIMMODEL1 binds the originating assistant rather than a later default, fallback or auxiliary call", () => {
	const scratch = ownedTmp("claimmodel-causal");
	try {
		const path = join(scratch.path, "session.jsonl");
		journal(path, [
			assistant("claim-entry", null, claimCall, "gpt-6.1-sol"),
			{ type: "model_change", id: "role-change", parentId: "claim-entry", provider: "anthropic-api", modelId: "muse", role: "default" },
			assistant("close-entry", "role-change", closeCall, "muse", "anthropic-api"),
			{ type: "model_usage", id: "aux-entry", parentId: "close-entry", activeLeafId: "close-entry", provider: "anthropic-api", model: "haiku" },
		]);
		const claim = observe(path);
		expect(claim).toMatchObject({ status: "KNOWN", provider: "openai-codex", model: "gpt-6.1-sol",
			source: { session_id: sessionId, entry_id: "claim-entry", tool_call_id: claimCall } });
		const close = observe(path, closeCall);
		expect(close).toMatchObject({ status: "KNOWN", provider: "anthropic-api", model: "muse",
			source: { entry_id: "close-entry", tool_call_id: closeCall } });
	} finally { scratch.cleanup(); }
});

test("CLAIMMODEL1 missing causal IDs and unreadable or replaced sessions never inherit registration", () => {
	const scratch = ownedTmp("claimmodel-unknown");
	try {
		const path = join(scratch.path, "session.jsonl");
		journal(path, [assistant("claim-entry", null, claimCall, "gpt-6.1-sol")]);
		for (const evidence of [
			observe(join(scratch.path, "missing.jsonl")),
			observe(scratch.path),
			observe(path, "not-yet-persisted-call"),
			observe(path, claimCall, "previous-session"),
			observeWorkingModel({ PI_SESSION_FILE: path, PI_SESSION_ID: sessionId, BR_MODEL: "muse" }),
		]) expect(evidence.status).toBe("UNKNOWN");
		const replacement = join(scratch.path, "replacement.jsonl");
		journal(replacement, [assistant("replacement-entry", null, claimCall, "muse")], "replacement-session");
		renameSync(replacement, path);
		expect(observe(path).status).toBe("UNKNOWN");
		journal(path, [assistant("invalid-encoding", null, claimCall, String.fromCharCode(0xd800))]);
		expect(observe(path).status).toBe("UNKNOWN");
	} finally { scratch.cleanup(); }
});

test("CLAIMMODEL1 ambiguous, off-branch and auxiliary-only causal matches stay UNKNOWN", () => {
	const scratch = ownedTmp("claimmodel-branches");
	try {
		const path = join(scratch.path, "session.jsonl");
		journal(path, [assistant("one", null, claimCall, "gpt-6.1-sol"), assistant("two", "one", claimCall, "muse")]);
		expect(observe(path).status).toBe("UNKNOWN");
		journal(path, [assistant("one", null, claimCall, "gpt-6.1-sol"), assistant("two", null, closeCall, "muse"),
			{ type: "model_usage", id: "pin", parentId: "two", activeLeafId: "two", model: "haiku" }]);
		expect(observe(path).status).toBe("UNKNOWN");
		journal(path, [{ type: "model_usage", id: "aux", parentId: null, activeLeafId: null,
			model: "gpt-6.1-sol", toolCallId: claimCall }]);
		expect(observe(path).status).toBe("UNKNOWN");
	} finally { scratch.cleanup(); }
});

test("ACTIVECLOCK1 missing processing evidence is UNKNOWN, never zero active hours", () => {
	const scratch = ownedTmp("activeclock-empty");
	try {
		const report = inspectModelLedger(scratch.path, undefined, Date.UTC(2026, 10, 16));
		expect(report).toMatchObject({
			activity: {
				status: "UNKNOWN",
				active_ms: null,
				known_active_ms: null,
				valid_processing_segment_coverage: null,
			},
		});
	} finally { scratch.cleanup(); }
});

const root = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();

async function nativeFixture() {
	const scratchRoot = join(root, "var/agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const scratch = ownedTmp("claimmodel-native", { root: scratchRoot });
	const release = join(scratch.path, "release"), bin = join(scratch.path, "bin");
	for (const path of [bin, join(release, "bin"), join(release, "scripts")]) mkdirSync(path, { recursive: true });
	for (const name of ["br-shim.sh", "br-fixture-scope.py", "model-mutation.py", "kitlib_run.py", "kitlib_jsonl.py", "kitlib_lock.py", "kitlib_proc.py", "pysafe.py"]) {
		copyFileSync(join(root, "scripts", name), join(release, "scripts", name));
	}
	writeFileSync(join(release, "bin/omp-kit"), `#!${process.execPath}\nimport { runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`, { mode: 0o755 });
	writeFileSync(join(bin, "am"), "#!/bin/sh\nprintf 'owned fixture has no mail registration\\n' >&2\nexit 2\n", { mode: 0o755 });
	const python = Bun.which("python3");
	if (!python) throw new Error("CLAIMMODEL1 requires the shipped Python runtime dependency");
	symlinkSync(python, join(bin, "python3"));
	const backend = nativeBr(), database = join(scratch.path, ".beads/beads.db");
	const path = join(scratch.path, "session.jsonl");
	journal(path, [
		assistant("native-claim", null, claimCall, "gpt-6.1-sol"),
		assistant("native-close", "native-claim", closeCall, "muse", "anthropic-api"),
		assistant("native-reclaim", "native-close", "reclaim-call", "muse", "anthropic-api"),
	]);
	const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch.path, TMPDIR: scratch.path,
		XDG_STATE_HOME: join(scratch.path, "state"), OMP_KIT_CASE_CWD: root, BR_REAL: backend,
		PYTHONPYCACHEPREFIX: fixturePycachePrefix(), PI_SESSION_FILE: path, PI_SESSION_ID: sessionId,
		PI_TOOL_CALL_ID: claimCall, BR_MODEL: "registered-default-must-not-win" };
	async function call(args: string[], options: { native?: boolean; actor?: string; tool?: string } = {}) {
		const actor = options.actor ?? "ClaimAuthor";
		const argv = options.native ? [backend] : ["/bin/sh", join(release, "scripts/br-shim.sh")];
		const result = await run([...argv, "--db", database, ...args, "--actor", actor], {
			cwd: scratch.path, env: { ...env, AGENT_NAME: actor, PI_TOOL_CALL_ID: options.tool ?? claimCall },
			deadline_s: fixtureDeadlineS(60), max_output_bytes: 1024 * 1024,
		});
		expect(result.timed_out || result.truncated).toBe(false);
		return { rc: result.rc, out: decoder.decode(result.stdout), err: decoder.decode(result.stderr) };
	}
	try {
		const initialized = await call(["init", "--prefix", "cm"], { native: true });
		expect(initialized.rc, initialized.err).toBe(0);
		const created = await call(["create", "Owned journal attribution", "--json"], { native: true });
		expect(created.rc, created.err).toBe(0);
		const id: string = JSON.parse(created.out).id;
		return { scratch, release, database, env, path, id, call,
			inspect: () => inspectModelLedger(join(env.XDG_STATE_HOME, "omp-kit"), scratch.path) };
	} catch (error) { scratch.cleanup(); throw error; }
}

test("CLAIMMODEL1 real native shim binds author and peer closer; refusal preserves the exact native result", async () => {
	const f = await nativeFixture();
	try {
		const claimed = await f.call(["update", f.id, "--claim", "--json"]);
		expect(claimed.rc, claimed.err).toBe(0);
		const directRefusal = await f.call(["update", f.id, "--claim", "--json"], { native: true, actor: "Intruder" });
		const guardedRefusal = await f.call(["update", f.id, "--claim", "--json"], { actor: "Intruder" });
		expect(directRefusal.rc).not.toBe(0);
		expect(guardedRefusal).toEqual(directRefusal);
		const closed = await f.call(["close", f.id, "--reason", "owned native acceptance", "--json"], { actor: "PeerVerifier", tool: closeCall });
		expect(closed.rc, closed.err).toBe(0);
		const native = await f.call(["show", f.id, "--json", "--no-auto-import", "--no-auto-flush"], { native: true });
		const shown = JSON.parse(native.out);
		const bead = Array.isArray(shown) ? shown[0] : shown;
		expect({ status: bead.status, assignee: bead.assignee }).toEqual({ status: "closed", assignee: "ClaimAuthor" });
		const report = f.inspect();
		expect({ status: report.status, counts: report.counts }).toMatchObject({ status: "KNOWN",
			counts: { successful_claims: 1, known_claims: 1, unknown_claims: 0, refused_operations: 1 } });
		const claim = report.operations.find(row => row.intent.actor === "ClaimAuthor" && row.intent.kind === "claim")!;
		const close = report.operations.find(row => row.intent.kind === "close")!;
		expect(claim.outcome?.attribution).toMatchObject({ status: "KNOWN", model: "gpt-6.1-sol",
			source: { session_id: sessionId, entry_id: "native-claim", tool_call_id: claimCall } });
		expect(close.outcome?.attribution).toMatchObject({ status: "KNOWN", model: "muse", source: { entry_id: "native-close" } });
		expect(close.intent.actor).toBe("PeerVerifier");
		expect(close.intent.claim_incarnations[f.id]).toBe(claim.intent.operation_id);
		for (const scope of [["--project", f.scratch.path], ["--fleet"]]) {
			const inspected = await run([join(f.release, "bin/omp-kit"), "doctor", "--scope", "work", ...scope, "--json"], {
				cwd: f.scratch.path, env: f.env, deadline_s: fixtureDeadlineS(60), max_output_bytes: 1024 * 1024,
			});
			expect(inspected.rc, decoder.decode(inspected.stderr)).toBe(0);
			expect(JSON.parse(decoder.decode(inspected.stdout)).data.model_ledger.counts).toMatchObject({ successful_claims: 1, known_claims: 1 });
		}
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("CLAIMMODEL1 idempotent claim, reopen/reclaim and immutable prior model evidence remain distinct", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const original = f.inspect().operations[0]!;
		const originalBytes = JSON.stringify(original);
		expect((await f.call(["update", f.id, "--claim", "--json"], { tool: "reclaim-call" })).rc).toBe(0);
		let report = f.inspect();
		expect(report.operations[1]!.intent.claim_incarnations[f.id]).toBe(original.intent.operation_id);
		expect(JSON.stringify(report.operations[0])).toBe(originalBytes);
		expect((await f.call(["close", f.id, "--json"], { actor: "PeerVerifier", tool: closeCall })).rc).toBe(0);
		expect((await f.call(["reopen", f.id, "--json"], { actor: "PeerVerifier" })).rc).toBe(0);
		expect((await f.call(["update", f.id, "--claim", "--json"], { tool: "reclaim-call" })).rc).toBe(0);
		report = f.inspect();
		const reclaimed = report.operations[report.operations.length - 1]!;
		expect(reclaimed.intent.claim_incarnations[f.id]).toBe(reclaimed.intent.operation_id);
		expect(reclaimed.intent.operation_id).not.toBe(original.intent.operation_id);
		expect(reclaimed.outcome?.attribution).toMatchObject({ status: "KNOWN", model: "muse" });
		expect(JSON.stringify(report.operations[0])).toBe(originalBytes);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("CLAIMMODEL1 a missing journal records UNKNOWN while the real native claim still succeeds", async () => {
	const f = await nativeFixture();
	try {
		f.env.PI_SESSION_FILE = join(f.scratch.path, "missing-session.jsonl");
		const claimed = await f.call(["update", f.id, "--claim", "--json"]);
		expect(claimed.rc, claimed.err).toBe(0);
		expect(f.inspect().counts).toMatchObject({ successful_claims: 1, known_claims: 0, unknown_claims: 1 });
		expect(f.inspect().operations[0]!.outcome?.attribution).toMatchObject({ status: "UNKNOWN" });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("CLAIMMODEL1 replacement at the real mutation appends a correction instead of rewriting the captured intent", async () => {
	const f = await nativeFixture();
	try {
		const replacement = join(f.scratch.path, "replacement.jsonl");
		journal(replacement, [assistant("replacement-entry", null, claimCall, "muse")], "replacement-session");
		const backend = f.env.BR_REAL;
		const adapter = join(f.scratch.path, "replace-then-native.py");
		writeFileSync(adapter, `#!${Bun.which("python3")}\nimport os,sys\nif len(sys.argv)>3 and sys.argv[3]=='update':\n    os.replace(${JSON.stringify(replacement)},os.environ['PI_SESSION_FILE'])\nos.execv(${JSON.stringify(backend)},[${JSON.stringify(backend)},*sys.argv[1:]])\n`, { mode: 0o755 });
		f.env.BR_REAL = adapter;
		const claimed = await f.call(["update", f.id, "--claim", "--json"]);
		expect(claimed.rc, claimed.err).toBe(0);
		const report = f.inspect(), operation = report.operations[0]!;
		expect(operation.intent.attribution).toMatchObject({ status: "KNOWN", model: "gpt-6.1-sol" });
		expect(operation.outcome?.attribution).toMatchObject({ status: "UNKNOWN", reason: "SESSION_REPLACED" });
		expect(report.counts).toMatchObject({ successful_claims: 1, known_claims: 0, unknown_claims: 1 });
		const native = await f.call(["show", f.id, "--json"], { native: true });
		const shown = JSON.parse(native.out), bead = Array.isArray(shown) ? shown[0] : shown;
		expect(bead.status).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("CLAIMMODEL1 interrupted or rewritten model evidence never grants known coverage", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const operation = f.inspect().operations[0]!;
		const page = evidencePage(f.env, operation.intent.at);
		const outcomePage = evidencePage(f.env, operation.outcome!.at);
		const original = readFileSync(page, "utf8"), originalOutcome = readFileSync(outcomePage, "utf8");
		const pending = originalOutcome.trimEnd().split("\n").map(line => JSON.parse(line))
			.filter(row => row.phase !== "outcome" || row.operation_id !== operation.intent.operation_id);
		writeFileSync(outcomePage, pending.map(row => JSON.stringify(row)).join("\n") + (pending.length ? "\n" : ""));
		expect(f.inspect()).toMatchObject({ status: "UNKNOWN", known_claim_model_coverage: null,
			counts: { successful_claims: 0, unresolved_claims: 1 } });
		writeFileSync(outcomePage, originalOutcome);
		const rows = original.trimEnd().split("\n").map(line => JSON.parse(line));
		rows.find(row => row.phase === "intent" && row.operation_id === operation.intent.operation_id).attribution.model = "rewritten-registration";
		writeFileSync(page, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
		expect(f.inspect()).toMatchObject({ status: "UNKNOWN", known_claim_model_coverage: null });
		expect(f.inspect().problems).toContain("INTENT_OUTCOME_MISMATCH");
		writeFileSync(page, original);
		const timed = originalOutcome.trimEnd().split("\n").map(line => JSON.parse(line));
		timed.find(row => row.phase === "outcome" && row.operation_id === operation.intent.operation_id).native_timed_out = true;
		writeFileSync(outcomePage, timed.map(row => JSON.stringify(row)).join("\n") + "\n");
		expect(f.inspect()).toMatchObject({ status: "UNKNOWN", known_claim_model_coverage: null,
			counts: { successful_claims: 0, unresolved_claims: 1 } });
		writeFileSync(outcomePage, originalOutcome);
		expect(f.inspect().counts).toMatchObject({ successful_claims: 1, known_claims: 1 });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("CLAIMMODEL1 capacity failure bounds storage without refusing the native mutation or claiming complete coverage", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const seed = f.inspect().operations[0]!.intent;
		const code = `import importlib.util,json,os,sys,datetime,shutil
spec=importlib.util.spec_from_file_location("model_mutation",sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
seed=json.loads(sys.stdin.buffer.read(16385))
size=module.MAX_EVENT*3//4
for index in range(module.MAX_DAY//size+2):
    row={**seed,"operation_id":"capacity-"+str(index),"kind":"release","padding":"p"*size}
    try: module.append(row)
    except (module.kitlib_jsonl.JsonlError,ValueError) as error:
        directory=module.kitlib_lock.resolve_lock({"namespace":"model-evidence","name":"events"})["dir"]
        page=os.path.join(directory,datetime.datetime.now(datetime.timezone.utc).date().isoformat()+".jsonl")
        for small in range(module.MAX_DAY//len(module.encoded(seed))+2):
            row={**seed,"operation_id":str(module.uuid.uuid4())}
            try: module.append(row)
            except (module.kitlib_jsonl.JsonlError,ValueError): break
        else: raise RuntimeError("small records escaped the declared storage bound")
        page=max((path for _,path in module.pages(directory)),key=os.path.getsize)
        before=os.path.getsize(page)
        try: module.append(row)
        except (module.kitlib_jsonl.JsonlError,ValueError): pass
        # Seed both adjacent UTC buckets so midnight cannot reset the controlled capacity failure.
        today=datetime.datetime.now(datetime.timezone.utc).date()
        for day in (today,today+datetime.timedelta(days=1)):
            target=os.path.join(directory,day.isoformat()+".jsonl")
            if target!=page: shutil.copyfile(page,target); os.chmod(target,0o600)
        print(json.dumps({"refused":True,"before":before,"after":os.path.getsize(page),"bound":module.MAX_DAY}))
        break
else: raise RuntimeError("declared storage bound was not enforced")
`;
		const filled = await run([Bun.which("python3")!, "-c", code, join(root, "scripts/model-mutation.py")], {
			cwd: f.scratch.path, env: f.env, stdin: JSON.stringify(seed), deadline_s: fixtureDeadlineS(60), max_output_bytes: 64 * 1024,
		});
		expect(filled.rc, decoder.decode(filled.stderr)).toBe(0);
		const capacity = JSON.parse(decoder.decode(filled.stdout));
		expect(capacity.refused).toBe(true);
		expect(capacity.before).toBeLessThanOrEqual(capacity.bound);
		expect(capacity.after).toBe(capacity.before);
		const native = await f.call(["update", f.id, "--claim", "--json"]);
		expect(native.rc, native.err).toBe(0);
		expect(native.err).toContain("MODEL_EVIDENCE_UNKNOWN");
		expect(f.inspect().problems).toContain("LEDGER_DAY_CAPACITY");
		expect(f.inspect().known_claim_model_coverage).toBeNull();
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("CLAIMMODEL1 retention removes only expired producer pages and leaves foreign data explicit and untouched", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const seed = f.inspect().operations[0]!.intent;
		const directory = join(f.env.XDG_STATE_HOME, "omp-kit/model-evidence");
		const page = evidencePage(f.env, seed.at);
		const prior = readFileSync(page);
		const old = join(directory, "2020-01-01.jsonl");
		writeFileSync(old, JSON.stringify({ ...seed, operation_id: "retention-expired", at: "2020-01-01T00:00:00.000Z" }) + "\n", { mode: 0o600 });
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		expect(existsSync(old)).toBe(false);
		expect(readFileSync(page).subarray(0, prior.length)).toEqual(prior);
		const foreign = JSON.stringify({ schema_version: 1, producer: "not-omp-kit", at: "2020-01-01T00:00:00.000Z" }) + "\n";
		writeFileSync(old, foreign, { mode: 0o600 });
		const native = await f.call(["update", f.id, "--claim", "--json"]);
		expect(native.rc).toBe(0);
		expect(readFileSync(old, "utf8")).toBe(foreign);
		expect(native.err).toContain("FOREIGN_RETENTION_PAGE");
		expect(f.inspect().problems).toContain("RETENTION_PAGE_UNRESOLVED");
		expect(f.inspect().known_claim_model_coverage).toBeNull();
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("CLAIMMODEL1 oversized ledger reads are bounded and never promoted from a partial page", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const page = evidencePage(f.env, f.inspect().operations[0]!.intent.at);
		truncateSync(page, MODEL_LEDGER_MAX_READ_BYTES + 1);
		const report = f.inspect();
		expect(report.status).toBe("UNKNOWN");
		expect(report.known_claim_model_coverage).toBeNull();
		expect(report.bytes_read).toBeLessThanOrEqual(MODEL_LEDGER_MAX_READ_BYTES);
		expect(report.problems).toContain("LEDGER_PAGE_INCOMPLETE");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("CLAIMMODEL1 unavailable metadata state never becomes a new native claim refusal", async () => {
	const f = await nativeFixture();
	try {
		f.env.XDG_STATE_HOME = "relative-state-is-not-a-valid-ledger";
		const result = await f.call(["update", f.id, "--claim", "--json"]);
		expect(result.rc, result.err).toBe(0);
		expect(result.err).toContain("MODEL_EVIDENCE_UNKNOWN");
		const shown = await f.call(["show", f.id, "--json"], { native: true });
		const rows = JSON.parse(shown.out), bead = Array.isArray(rows) ? rows[0] : rows;
		expect(bead.status).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

function mutantModule(path: string, name: string, before: string, after: string): string {
	const original = readFileSync(join(root, "src/model-ledger.ts"), "utf8");
	let source = original.replace(before, after);
	if (source === original) throw new Error(`CLAIMMODEL1 ${name} mutation anchor no longer matches`);
	source = source.replace('"./plane-tern.ts"', JSON.stringify(join(root, "src/plane-tern.ts")))
		.replace('"./kitlib/jsonl.ts"', JSON.stringify(join(root, "src/kitlib/jsonl.ts")))
		.replace('"./model-activity.ts"', JSON.stringify(join(root, "src/model-activity.ts")))
		.replace('"./verify-ledger.ts"', JSON.stringify(join(root, "src/verify-ledger.ts")));
	const file = join(path, `${name}.ts`);
	writeFileSync(file, source);
	return file;
}

async function modelOracle(module: string, code: string, scratch: string) {
	const result = await run([process.execPath, "--eval", `import * as model from ${JSON.stringify(module)};\n${code}`], {
		cwd: root, env: { ...process.env, TMPDIR: scratch }, deadline_s: fixtureDeadlineS(30), max_output_bytes: 64 * 1024,
	});
	expect(result.timed_out || result.truncated).toBe(false);
	const witness = JSON.parse(decoder.decode(result.stdout));
	return { rc: result.rc, witness };
}

test("CLAIMMODEL1 consumer oracles kill registration inference and unbounded journal rescans", async () => {
	const scratch = ownedTmp("claimmodel-source-mutants");
	try {
		const path = join(scratch.path, "session.jsonl");
		journal(path, [assistant("claim-entry", null, claimCall, "gpt-6.1-sol"), assistant("later", "claim-entry", closeCall, "muse")]);
		const env = { PI_SESSION_FILE: path, PI_SESSION_ID: sessionId, PI_TOOL_CALL_ID: claimCall, BR_MODEL: "wrong-registration" };
		const known = `const result=model.observeWorkingModel(${JSON.stringify(env)});
const accepted=result.status==="KNOWN"&&result.model==="gpt-6.1-sol"&&result.source.entry_id==="claim-entry";
console.log(JSON.stringify({accepted,expected:"gpt-6.1-sol at claim-entry",observed:result.status==="KNOWN"?result.model:result.reason}));
process.exitCode=accepted?0:1;`;
		const source = join(root, "src/model-ledger.ts");
		const registration = mutantModule(scratch.path, "registration-mutant", "model: message.model,", "model: env.BR_MODEL ?? message.model,");
		const control = await modelOracle(source, known, scratch.path);
		const killed = await modelOracle(registration, known, scratch.path);
		expect(control).toMatchObject({ rc: 0, witness: { accepted: true } });
		expect(killed).toMatchObject({ rc: 1, witness: { accepted: false, observed: "wrong-registration" } });
		console.log("CLAIMMODEL1 registration mutant", JSON.stringify({ control: control.witness, killed: killed.witness }));
		journal(path, [assistant("claim-entry", null, claimCall, "gpt-6.1-sol"),
			{ type: "message", id: "large-user", parentId: "claim-entry", message: { role: "user", content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024 + 4096) }] } },
			{ type: "model_usage", id: "pin", parentId: "large-user", activeLeafId: "large-user", model: "auxiliary" }]);
		const bounded = `const result=model.observeWorkingModel(${JSON.stringify(env)});
const accepted=result.status==="UNKNOWN";
console.log(JSON.stringify({accepted,expected:"UNKNOWN beyond the bounded window",observed:result.status}));
process.exitCode=accepted?0:1;`;
		const rescan = mutantModule(scratch.path, "rescan-mutant", "MODEL_JOURNAL_WINDOW_BYTES = 8 * 1024 * 1024", "MODEL_JOURNAL_WINDOW_BYTES = 64 * 1024 * 1024");
		const boundedControl = await modelOracle(source, bounded, scratch.path);
		const rescanKilled = await modelOracle(rescan, bounded, scratch.path);
		expect(boundedControl).toMatchObject({ rc: 0, witness: { accepted: true } });
		expect(rescanKilled).toMatchObject({ rc: 1, witness: { accepted: false, observed: "KNOWN" } });
		console.log("CLAIMMODEL1 rescan mutant", JSON.stringify({ control: boundedControl.witness, killed: rescanKilled.witness }));
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("CLAIMMODEL1 consumer oracles kill closer-as-author projection and unchecked old-evidence rewrites", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		expect((await f.call(["close", f.id, "--json"], { actor: "PeerVerifier", tool: closeCall })).rc).toBe(0);
		const state = join(f.env.XDG_STATE_HOME, "omp-kit"), source = join(root, "src/model-ledger.ts");
		const joined = `const report=model.inspectModelLedger(${JSON.stringify(state)},${JSON.stringify(f.scratch.path)});
const claim=report.operations.find(row=>row.intent.kind==="claim"),close=report.operations.find(row=>row.intent.kind==="close");
const accepted=claim?.outcome?.attribution.status==="KNOWN"&&claim.outcome.attribution.model==="gpt-6.1-sol"
&&close?.intent.actor==="PeerVerifier"&&close.intent.claim_incarnations[${JSON.stringify(f.id)}]===claim.intent.operation_id;
console.log(JSON.stringify({accepted,expected:"peer close retains author claim incarnation",observed:close?.intent.claim_incarnations[${JSON.stringify(f.id)}]}));
process.exitCode=accepted?0:1;`;
		const closer = mutantModule(f.scratch.path, "closer-author-mutant",
			'operations.push({ intent, outcome, integrity: valid ? "KNOWN" : "UNKNOWN" });',
			'operations.push({ intent: intent.kind === "close" ? { ...intent, claim_incarnations: Object.fromEntries(intent.beads.map(id => [id, intent.operation_id])) } : intent, outcome, integrity: valid ? "KNOWN" : "UNKNOWN" });');
		const joinedControl = await modelOracle(source, joined, f.scratch.path);
		const joinedKilled = await modelOracle(closer, joined, f.scratch.path);
		expect(joinedControl).toMatchObject({ rc: 0, witness: { accepted: true } });
		expect(joinedKilled).toMatchObject({ rc: 1, witness: { accepted: false } });
		console.log("CLAIMMODEL1 closer-as-author mutant", JSON.stringify({ control: joinedControl.witness, killed: joinedKilled.witness }));
		const originalClaim = f.inspect().operations.find(row => row.intent.kind === "claim")!.intent;
		const page = evidencePage(f.env, originalClaim.at);
		const rows = readFileSync(page, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
		const captured = rows.find(row => row.phase === "intent" && row.operation_id === originalClaim.operation_id);
		captured.at = new Date(Date.parse(captured.at) - 1000).toISOString();
		writeFileSync(page, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
		const checked = `const report=model.inspectModelLedger(${JSON.stringify(state)},${JSON.stringify(f.scratch.path)});
const accepted=report.status==="UNKNOWN"&&report.known_claim_model_coverage===null;
console.log(JSON.stringify({accepted,expected:"UNKNOWN for rewritten original evidence",observed:report.status}));
process.exitCode=accepted?0:1;`;
		const unchecked = mutantModule(f.scratch.path, "unchecked-history-mutant", "outcome.intent_sha256 === digest", "true");
		const checkedControl = await modelOracle(source, checked, f.scratch.path);
		const checkedKilled = await modelOracle(unchecked, checked, f.scratch.path);
		expect(checkedControl).toMatchObject({ rc: 0, witness: { accepted: true } });
		expect(checkedKilled).toMatchObject({ rc: 1, witness: { accepted: false, observed: "KNOWN" } });
		console.log("CLAIMMODEL1 unchecked-history mutant", JSON.stringify({ control: checkedControl.witness, killed: checkedKilled.witness }));
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("CLAIMMODEL1 retention also bounds persistent append locks across daily page rotation", async () => {
	const f = await nativeFixture();
	try {
		expect((await f.call(["update", f.id, "--claim", "--json"])).rc).toBe(0);
		const seed = f.inspect().operations[0]!.intent;
		const code = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location("model_mutation",sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
seed=json.loads(sys.stdin.buffer.read(16385))
real_datetime=module.dt.datetime
base=real_datetime.fromisoformat(seed["at"].replace("Z","+00:00"))
class Clock(real_datetime):
    current=base
    @classmethod
    def now(cls,tz=None):
        return cls.current.astimezone(tz) if tz else cls.current.replace(tzinfo=None)
module.dt.datetime=Clock
binding=module.kitlib_lock.resolve_lock({"namespace":"model-evidence","name":"events"})
locks=os.path.join(binding["state"],"kitlib-jsonl")
before=len(os.listdir(locks))
for index in range(1,module.RETENTION_DAYS+8):
    Clock.current=base+module.dt.timedelta(days=index)
    module.append({**seed,"operation_id":"rotation-"+str(index),"at":module.timestamp()})
print(json.dumps({"before":before,"after":len(os.listdir(locks)),"pages":len(module.pages(binding["dir"])),"bound":module.MAX_FILES}))
`;
		const rotated = await run([Bun.which("python3")!, "-c", code, join(root, "scripts/model-mutation.py")], {
			cwd: f.scratch.path, env: f.env, stdin: JSON.stringify(seed), deadline_s: fixtureDeadlineS(60), max_output_bytes: 64 * 1024,
		});
		expect(rotated.rc, decoder.decode(rotated.stderr)).toBe(0);
		const witness = JSON.parse(decoder.decode(rotated.stdout));
		expect(witness.after).toBe(witness.before);
		expect(witness.pages).toBeLessThanOrEqual(witness.bound);
		console.log("CLAIMMODEL1 rotated resource bound", JSON.stringify(witness));
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

function evidencePage(env: Readonly<Record<string, string>>, at: string): string {
	return join(env.XDG_STATE_HOME, "omp-kit/model-evidence", `${at.slice(0, 10)}.jsonl`);
}

test("CLAIMMODEL1 supervised native failure preserves its signal and grants no successful mutation credit", async () => {
	const f = await nativeFixture();
	try {
		const backend = f.env.BR_REAL, adapter = join(f.scratch.path, "signal-then-native.py");
		writeFileSync(adapter, `#!${Bun.which("python3")}\nimport os,signal,sys\nsys.path.insert(0,${JSON.stringify(join(f.release, "scripts"))})\nfrom kitlib_proc import safe_pid\nif len(sys.argv)>3 and sys.argv[3]=='update':\n    os.kill(safe_pid(os.getpid()),signal.SIGTERM)\nos.execv(${JSON.stringify(backend)},[${JSON.stringify(backend)},*sys.argv[1:]])\n`, { mode: 0o755 });
		const args = ["--db", f.database, "update", f.id, "--claim", "--json", "--actor", "ClaimAuthor"];
		const direct = await run([adapter, ...args], { cwd: f.scratch.path, env: f.env,
			deadline_s: fixtureDeadlineS(30), max_output_bytes: 64 * 1024 });
		expect(direct.timed_out || direct.truncated).toBe(false);
		expect(direct.rc).toBe(-15);
		f.env.BR_REAL = adapter;
		const wrapped = await f.call(["update", f.id, "--claim", "--json"]);
		expect(wrapped.rc, wrapped.err).toBe(direct.rc);
		expect(f.inspect().counts).toMatchObject({ successful_claims: 0, known_claims: 0, refused_operations: 1 });
		const shown = await f.call(["show", f.id, "--json"], { native: true });
		const rows = JSON.parse(shown.out), bead = Array.isArray(rows) ? rows[0] : rows;
		expect(bead.status).toBe("open");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

type ActivityOpen = Extract<ActivityEvent, { kind: "open" }>;
type ActivitySettle = Extract<ActivityEvent, { kind: "settle" }>;
const ACTIVITY_BASE = Date.UTC(2026, 10, 16);
const ACTIVITY_A: ActivityModel = { provider: "openai-codex", model: "gpt-6.1-sol" };
const ACTIVITY_B: ActivityModel = { provider: "anthropic-api", model: "muse" };

function activityPair(
	index: number, start: number, end: number, model: ActivityModel,
	seat = "tern:7001",
): [ActivityOpen, ActivitySettle] {
	const identity = { seat, session_id: `activity-session-${index}`,
		session_file: `/activity/session-${index}.jsonl`, file_id: `1:${index + 1}`,
		incarnation: `activity-epoch-${index}`, run_id: `activity-run-${index}`,
		segment_id: `activity-segment-${index}`, turn_index: index };
	return [
		{ schema: 1, kind: "open", id: `${identity.segment_id}:open`, sequence: 1, identity,
			clock: { epoch_ms: start, mono_ns: (BigInt(start) * 1_000_000n).toString() },
			native_timestamp_ms: start },
		{ schema: 1, kind: "settle", id: `${identity.segment_id}:settle`, sequence: 2, identity,
			clock: { epoch_ms: end, mono_ns: (BigInt(end) * 1_000_000n).toString() },
			model, models_seen: [model], reason: null },
	];
}

test("ACTIVECLOCK1 clips processing to the week and unions same-seat overlap once by actual model", () => {
	const rows = [
		...activityPair(0, ACTIVITY_BASE - 50, ACTIVITY_BASE + 100, ACTIVITY_A),
		...activityPair(1, ACTIVITY_BASE + 50, ACTIVITY_BASE + 150, ACTIVITY_A),
		...activityPair(2, ACTIVITY_BASE + 200, ACTIVITY_BASE + 300, ACTIVITY_B),
	];
	const report = projectActivityRecords(rows, { start_ms: ACTIVITY_BASE, end_ms: ACTIVITY_BASE + 1000 });
	expect(report).toMatchObject({ status: "KNOWN", active_ms: 250, known_active_ms: 250,
		counts: { observed_segments: 3, valid_segments: 3, unknown_segments: 0 } });
	expect(report.by_model.find(row => row.provider === ACTIVITY_A.provider && row.model === ACTIVITY_A.model))
		.toMatchObject({ known_active_ms: 150 });
	expect(report.by_model.find(row => row.provider === ACTIVITY_B.provider && row.model === ACTIVITY_B.model))
		.toMatchObject({ known_active_ms: 100 });
	const twoSeats = projectActivityRecords([
		...activityPair(3, ACTIVITY_BASE, ACTIVITY_BASE + 100, ACTIVITY_A, "tern:7001"),
		...activityPair(4, ACTIVITY_BASE, ACTIVITY_BASE + 100, ACTIVITY_A, "tern:7002"),
	], { start_ms: ACTIVITY_BASE, end_ms: ACTIVITY_BASE + 1000 });
	expect(twoSeats.active_ms).toBe(200);
});

test("ACTIVECLOCK1 overlapping different models retain unknown attribution without double credit", () => {
	const report = projectActivityRecords([
		...activityPair(0, ACTIVITY_BASE, ACTIVITY_BASE + 200, ACTIVITY_A),
		...activityPair(1, ACTIVITY_BASE + 100, ACTIVITY_BASE + 300, ACTIVITY_B),
	], { start_ms: ACTIVITY_BASE, end_ms: ACTIVITY_BASE + 1000 });
	expect(report).toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: 300, unattributed_ms: 100 });
	expect(report.by_model.reduce((sum, row) => sum + row.known_active_ms, 0)).toBe(200);
});

test("ACTIVECLOCK1 unpaired, replaced, invalid-clock and unproven-model endpoints never fabricate hours", () => {
	const [open, settle] = activityPair(0, ACTIVITY_BASE, ACTIVITY_BASE + 100, ACTIVITY_A);
	const cases: [string, unknown[]][] = [
		["unmatched open", [open]],
		["orphan settle", [settle]],
		["source replaced", [open, { ...settle, identity: { ...settle.identity, file_id: "2:999" } }]],
		["clock moved backwards", [open, { ...settle, clock: { ...settle.clock, epoch_ms: ACTIVITY_BASE - 1 } }]],
		["epoch and monotonic disagree", [open, { ...settle, clock: { ...settle.clock, epoch_ms: ACTIVITY_BASE + 900 } }]],
		["no actual primary model", [open, { ...settle, model: null, models_seen: [] }]],
		["different primary models", [open, { ...settle, models_seen: [ACTIVITY_A, ACTIVITY_B] }]],
		["source identity unavailable", [ { ...open, identity: { ...open.identity, file_id: null } },
			{ ...settle, identity: { ...settle.identity, file_id: null } } ]],
		["non-finite clock", [open, { ...settle, clock: { ...settle.clock, epoch_ms: Number.NaN } }]],
	];
	for (const [label, rows] of cases) {
		const report = projectActivityRecords(rows, { start_ms: ACTIVITY_BASE, end_ms: ACTIVITY_BASE + 1000 });
		expect({ label, status: report.status, active_ms: report.active_ms })
			.toEqual({ label, status: "UNKNOWN", active_ms: null });
		expect(report.problems.length, label).toBeGreaterThan(0);
	}
});

test("ACTIVECLOCK1 replay is idempotent and conflicting replay or appended correction invalidates the segment", () => {
	const pair = activityPair(0, ACTIVITY_BASE, ACTIVITY_BASE + 100, ACTIVITY_A);
	const window = { start_ms: ACTIVITY_BASE, end_ms: ACTIVITY_BASE + 1000 };
	const replayed = projectActivityRecords([...pair, ...pair], window);
	expect(replayed).toMatchObject({ status: "KNOWN", active_ms: 100,
		counts: { observed_segments: 1, valid_segments: 1, duplicate_events: 2 } });
	const conflicting = projectActivityRecords([...pair, { ...pair[1], model: ACTIVITY_B, models_seen: [ACTIVITY_B] }], window);
	expect(conflicting).toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: null,
		valid_processing_segment_coverage: null });
	const correction: ActivityEvent = { schema: 1, kind: "invalidate", id: "activity-correction", sequence: 3,
		identity: pair[0].identity, clock: pair[1].clock, reason: "SOURCE_REPLACED" };
	expect(projectActivityRecords([...pair, correction], window)).toMatchObject({
		status: "UNKNOWN", active_ms: null, known_active_ms: null,
	});
	const gap = projectActivityRecords([pair[0], { ...pair[1], sequence: 3 }], window);
	expect(gap).toMatchObject({ status: "UNKNOWN", active_ms: null, valid_processing_segment_coverage: null });
});

test("ACTIVECLOCK1 genuine zero-duration epoch-zero work is distinct from missing or unreadable evidence", () => {
	expect(projectActivityRecords(activityPair(0, 0, 0, ACTIVITY_A), { start_ms: 0, end_ms: 1000 }))
		.toMatchObject({ status: "KNOWN", active_ms: 0, known_active_ms: 0, counts: { valid_segments: 1 } });
	expect(projectActivityRecords([], { start_ms: 0, end_ms: 1000 }))
		.toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: null, valid_processing_segment_coverage: null });
});

interface ActivityFixtureMessage {
	role: "assistant";
	provider: string;
	model: string;
	api: string;
	timestamp: number;
	duration: number;
	stopReason: "stop";
	content: { type: "text"; text: string }[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
}
type ActivityHandler = (event: unknown, ctx: ActivityContext) => void | Promise<void>;
interface ActivityFixture {
	scratch: { path: string; cleanup(): void };
	xdg: string;
	state: string;
	path: string;
	clock: { ms: number; ns: bigint };
	context: ActivityContext;
	fire(name: string, data?: Record<string, unknown>): Promise<void>;
	advance(ms: number): void;
	message(model: ActivityModel, duration?: number): ActivityFixtureMessage;
	turn(index: number, model: ActivityModel, elapsed?: number, duration?: number): Promise<void>;
	inspect(): ModelActivityInspection;
}

interface ActivityFixtureOptions {
	entry?: string;
	stateRoot?: string;
	sourceFile?: string;
	incarnation?: string;
	baseMs?: number;
	pane?: string | null;
}

async function activityFixture(options: ActivityFixtureOptions = {}): Promise<ActivityFixture> {
	const scratch = ownedTmp("activeclock-consumer");
	const xdg = join(scratch.path, "state"), state = options.stateRoot ?? join(xdg, "omp-kit");
	const path = options.sourceFile ?? join(scratch.path, "session.jsonl");
	if (!existsSync(path)) journal(path, [], "activity-session");
	const clock = { ms: options.baseMs ?? Date.now() - 86_400_000, ns: 1_000_000_000n };
	const context: ActivityContext = {
		cwd: scratch.path,
		sessionManager: { getSessionId: () => "activity-session", getSessionFile: () => path },
	};
	const handlers = new Map<string, ActivityHandler[]>();
	const api: ActivityApi = { on(name, handler) {
		let list = handlers.get(name);
		if (list === undefined) handlers.set(name, list = []);
		list.push(handler);
	} };
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const paths: unknown = manifest.omp?.extensions;
	if (!Array.isArray(paths)) { scratch.cleanup(); throw new Error("native plugin manifest has no extension entries"); }
	const entry = paths.find((value: unknown): value is string =>
		typeof value === "string" && value.endsWith("/kit-model-activity.ts"));
	if (!entry) { scratch.cleanup(); throw new Error("native plugin manifest does not load the activity recorder"); }
	try {
		// The shipped runtime registry, or an owned synthetic mutant, selects the
		// module. A static import would bypass the actual plugin load boundary.
		const loaded: { default: typeof ActivityExtension } = await import(options.entry ?? join(root, entry));
		await loaded.default(api, {
			...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
			env: { XDG_STATE_HOME: xdg, OMP_MODEL: "selected-default-must-not-supply-processing",
				...(options.pane === null ? {} : { TERN_PANE: options.pane ?? "7001" }) },
			now: () => clock.ms, monotonicNs: () => clock.ns,
			incarnation: options.incarnation ?? "activity-fixture",
		});
	} catch (error) { scratch.cleanup(); throw error; }
	async function fire(name: string, data: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...data }, context);
	}
	function advance(ms: number): void { clock.ms += ms; clock.ns += BigInt(ms) * 1_000_000n; }
	function message(model: ActivityModel, duration = 9_999_999): ActivityFixtureMessage {
		return { role: "assistant", provider: model.provider, model: model.model, api: "fixture-source",
			timestamp: clock.ms, duration, stopReason: "stop", content: [{ type: "text", text: "owned fixture response" }],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	}
	async function turn(index: number, model: ActivityModel, elapsed = 100, duration = 9_999_999): Promise<void> {
		await fire("turn_start", { turnIndex: index, timestamp: clock.ms });
		const actual = message(model, duration);
		await fire("message_start", { message: actual });
		advance(elapsed);
		await fire("turn_end", { turnIndex: index, message: actual, toolResults: [] });
	}
	return { scratch, xdg, state, path, clock, context, fire, advance, message, turn,
		inspect: () => inspectModelLedger(state, undefined, clock.ms + 1).activity };
}

test("ACTIVECLOCK1 the actually loaded native recorder excludes wait gaps and attributes each model through the real doctor CLI", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		f.advance(600_000);
		await f.turn(1, ACTIVITY_B, 200);
		await f.fire("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
		f.advance(600_000);
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 50);
		await f.fire("agent_end", { messages: [], willContinue: false });
		expect(f.inspect()).toMatchObject({ status: "KNOWN", active_ms: 350,
			counts: { observed_segments: 3, valid_segments: 3 } });
		const wrapper = join(f.scratch.path, "candidate-cli.ts");
		writeFileSync(wrapper, `import { runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`);
		const observed = await run([process.execPath, wrapper, "doctor", "--scope", "work", "--project", f.scratch.path,
			"--timeout-ms", "1000", "--jobs", "1", "--json"], {
			cwd: f.scratch.path,
			env: { PATH: process.env.PATH ?? "", HOME: f.scratch.path, XDG_STATE_HOME: f.xdg, TMPDIR: f.scratch.path },
			deadline_s: fixtureDeadlineS(60), max_output_bytes: 1024 * 1024,
		});
		expect(observed.timed_out || observed.truncated).toBe(false);
		expect(observed.rc, decoder.decode(observed.stderr)).toBe(0);
		const report = JSON.parse(decoder.decode(observed.stdout)).data.model_ledger.activity;
		expect(report).toMatchObject({ status: "KNOWN", active_ms: 350, known_active_ms: 350 });
		expect(report.by_model).toEqual(expect.arrayContaining([
			expect.objectContaining({ provider: ACTIVITY_A.provider, model: ACTIVITY_A.model, known_active_ms: 150 }),
			expect.objectContaining({ provider: ACTIVITY_B.provider, model: ACTIVITY_B.model, known_active_ms: 200 }),
		]));
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 native callbacks capture clocks before async writes and replayed boundaries do not open new work", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		const start = { turnIndex: 0, timestamp: f.clock.ms }, actual = f.message(ACTIVITY_A);
		const opening = f.fire("turn_start", start);
		const duplicateOpening = f.fire("turn_start", start);
		const modeling = f.fire("message_start", { message: actual });
		f.advance(100);
		const closing = f.fire("turn_end", { turnIndex: 0, message: actual, toolResults: [] });
		await Promise.all([opening, duplicateOpening, modeling, closing]);
		await f.fire("turn_end", { turnIndex: 0, message: actual, toolResults: [] });
		expect(f.inspect()).toMatchObject({ status: "KNOWN", active_ms: 100,
			counts: { observed_segments: 1, valid_segments: 1 } });
		const before = readActivityJournal(f.state, f.clock.ms + 1);
		// Persisted replay exercises the actual decoder without claiming a new
		// native operation; the shared schema supplies the complete event type.
		for (const row of before.records) {
			if (isActivityEvent(row)) await appendActivityEvent(f.state, row, f.clock.ms);
		}
		expect(f.inspect()).toMatchObject({ status: "KNOWN", active_ms: 100, counts: { valid_segments: 1 } });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 crash replacement retains incomplete evidence and never joins clocks across incarnations", async () => {
	const old = await activityFixture({ pane: null, incarnation: "before-crash" });
	let restarted: ActivityFixture | undefined;
	try {
		await old.fire("agent_start");
		await old.fire("turn_start", { turnIndex: 0, timestamp: old.clock.ms });
		restarted = await activityFixture({ pane: null, incarnation: "after-crash",
			stateRoot: old.state, sourceFile: old.path, baseMs: old.clock.ms + 500 });
		await restarted.fire("agent_start");
		await restarted.turn(0, ACTIVITY_B, 100);
		expect(restarted.inspect()).toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: 100,
			counts: { observed_segments: 2, valid_segments: 1, unknown_segments: 1 } });
	} finally { restarted?.scratch.cleanup(); old.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 a replaced live journal or missing primary-model start is not repaired with the selected role", async () => {
	for (const replace of [true, false]) {
		const f = await activityFixture();
		try {
			await f.fire("agent_start");
			await f.fire("turn_start", { turnIndex: 0, timestamp: f.clock.ms });
			const actual = f.message(ACTIVITY_A);
			await f.fire("message_start", { message: replace ? actual : { role: "user", provider: "auxiliary", model: "haiku" } });
			if (replace) { renameSync(f.path, `${f.path}.old`); journal(f.path, [], "activity-session"); }
			f.advance(100);
			await f.fire("turn_end", { turnIndex: 0, message: actual, toolResults: [] });
			expect(f.inspect()).toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: null });
		} finally { f.scratch.cleanup(); }
	}
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 a complete replay after observer restart is unioned once for the same real session seat", async () => {
	const first = await activityFixture({ pane: null, incarnation: "complete-replay-1" });
	let replay: ActivityFixture | undefined;
	try {
		const start = first.clock.ms;
		await first.fire("agent_start");
		await first.turn(0, ACTIVITY_A, 100);
		replay = await activityFixture({ pane: null, incarnation: "complete-replay-2",
			stateRoot: first.state, sourceFile: first.path, baseMs: start });
		await replay.fire("agent_start");
		await replay.turn(0, ACTIVITY_A, 100);
		expect(replay.inspect()).toMatchObject({ status: "KNOWN", active_ms: 100, known_active_ms: 100,
			counts: { observed_segments: 2, valid_segments: 2 } });
	} finally { replay?.scratch.cleanup(); first.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

async function activityResources(state: string): Promise<string[]> {
	const resources: string[] = [], prefix = `${ACTIVITY_DIRECTORY}/`;
	for await (const name of new Bun.Glob("**/*").scan({ cwd: state, onlyFiles: true, dot: true })) {
		const page = name.startsWith(prefix) && name.length === prefix.length + 16 && name.endsWith(".jsonl");
		if (!page && name !== `${prefix}current.jsonl`) resources.push(name);
	}
	return resources.sort();
}

test("ACTIVECLOCK1 daily rotation bounds producer pages and persistent resources while doctor never expires data", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		writeFileSync(join(f.state, "resource-control"), "owned matching resource control\n", { mode: 0o600 });
		const before = await activityResources(f.state);
		expect(before).toContain("resource-control");
		for (let day = 1; day < 35; day++) {
			f.advance(86_400_000);
			await f.turn(day, ACTIVITY_A, 100);
		}
		const after = await activityResources(f.state);
		const directory = join(f.state, ACTIVITY_DIRECTORY);
		const pages = readdirSync(directory).filter((name: string) => name.endsWith(".jsonl") && name !== "current.jsonl");
		expect(after).toEqual(before);
		expect(pages.length).toBeLessThanOrEqual(ACTIVITY_MAX_FILES);
		expect(f.inspect().status).toBe("KNOWN");
		console.log("ACTIVECLOCK1 rotated resource bound", JSON.stringify({
			before: before.length, after: after.length, pages: pages.length, bound: ACTIVITY_MAX_FILES,
		}));
		const expired = join(directory, "1970-01-01.jsonl"), foreign = join(directory, "1970-01-02.jsonl");
		writeFileSync(expired, JSON.stringify({ schema: 1, producer: "omp-kit/native-model-activity", day: "1970-01-01" }) + "\n", { mode: 0o600 });
		writeFileSync(foreign, "foreign evidence must remain byte-identical\n", { mode: 0o600 });
		const expiredBefore = readFileSync(expired), foreignBefore = readFileSync(foreign), metadata = statSync(expired);
		const readback = readActivityJournal(f.state, f.clock.ms + 1);
		expect(readback.complete).toBe(false);
		expect(readFileSync(expired)).toEqual(expiredBefore);
		expect(readFileSync(foreign)).toEqual(foreignBefore);
		expect(statSync(expired).mtimeMs).toBe(metadata.mtimeMs);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1000);

test("ACTIVECLOCK1 a crash before the dated link is recovered without rewriting the captured history", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		const directory = join(f.state, ACTIVITY_DIRECTORY);
		const day = new Date(f.clock.ms).toISOString().slice(0, 10), page = join(directory, `${day}.jsonl`);
		const captured = readFileSync(page, "utf8"), inode = statSync(page).ino;
		unlinkSync(page);
		expect(readActivityJournal(f.state, f.clock.ms + 1).complete).toBe(false);
		await f.turn(1, ACTIVITY_B, 200);
		expect(statSync(page).ino).toBe(inode);
		expect(readFileSync(page, "utf8").startsWith(captured)).toBe(true);
		expect(f.inspect()).toMatchObject({ status: "KNOWN", active_ms: 300, counts: { valid_segments: 2 } });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 the real reader continues beyond its first chunk and capacity never becomes native-operation refusal", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		const page = join(f.state, ACTIVITY_DIRECTORY, `${new Date(f.clock.ms).toISOString().slice(0, 10)}.jsonl`);
		const bulk: ActivityEvent[] = [];
		for (let index = 0; index < 100; index++) bulk.push(...activityPair(index, f.clock.ms - 90, f.clock.ms - 50, ACTIVITY_A));
		appendFileSync(page, bulk.map(row => JSON.stringify(row)).join("\n") + "\n");
		expect(statSync(page).size).toBeGreaterThan(64 * 1024);
		expect(f.inspect()).toMatchObject({ status: "KNOWN", active_ms: 100, counts: { valid_segments: 101 } });
		const padding = JSON.stringify(bulk[0]) + "\n", target = ACTIVITY_MAX_DAY_BYTES - 32 * 1024;
		appendFileSync(page, padding.repeat(Math.ceil((target - statSync(page).size) / Buffer.byteLength(padding))));
		const full = statSync(page).size;
		expect(full).toBeLessThanOrEqual(ACTIVITY_MAX_DAY_BYTES);
		await f.turn(1, ACTIVITY_B, 100);
		expect(statSync(page).size).toBeLessThanOrEqual(ACTIVITY_MAX_DAY_BYTES);
		expect(f.inspect()).toMatchObject({ status: "UNKNOWN", active_ms: null,
			valid_processing_segment_coverage: null });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 oversized owned evidence has a hard read budget and cannot receive complete coverage", async () => {
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		const page = join(f.state, ACTIVITY_DIRECTORY, `${new Date(f.clock.ms).toISOString().slice(0, 10)}.jsonl`);
		const header = readFileSync(page, "utf8").split("\n", 1)[0] + "\n";
		const event = activityPair(0, f.clock.ms - 100, f.clock.ms, ACTIVITY_A)[0];
		const wide = JSON.stringify({ ...event, identity: { ...event.identity, session_file: `/${"x".repeat(4095)}` } }) + "\n";
		writeFileSync(page, header + wide.repeat(Math.ceil((ACTIVITY_MAX_READ_BYTES + 64 * 1024) / Buffer.byteLength(wide))));
		const readback = readActivityJournal(f.state, f.clock.ms + 1);
		expect(readback.complete).toBe(false);
		expect(readback.bytes_read).toBeLessThanOrEqual(ACTIVITY_MAX_READ_BYTES);
		expect(readback.problems).toContain("ACTIVITY_READ_LIMIT");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 unavailable state and a bounded write queue preserve explicit lost coverage without rejecting native callbacks", async () => {
	const blocked = ownedTmp("activeclock-unavailable");
	const state = join(blocked.path, "not-a-directory");
	writeFileSync(state, "preserved foreign state path\n");
	const unavailable = await activityFixture({ stateRoot: state });
	try {
		await unavailable.fire("agent_start");
		await unavailable.turn(0, ACTIVITY_A, 100);
		expect(unavailable.inspect()).toMatchObject({ status: "UNKNOWN", active_ms: null, known_active_ms: null });
		expect(readFileSync(state, "utf8")).toBe("preserved foreign state path\n");
	} finally { unavailable.scratch.cleanup(); blocked.cleanup(); }
	const f = await activityFixture();
	try {
		await f.fire("agent_start");
		const calls: Promise<void>[] = [];
		for (let index = 0; index < 1000; index++) {
			const actual = f.message(ACTIVITY_A);
			calls.push(f.fire("turn_start", { turnIndex: index, timestamp: f.clock.ms }));
			calls.push(f.fire("message_start", { message: actual }));
			f.advance(1);
			calls.push(f.fire("turn_end", { turnIndex: index, message: actual, toolResults: [] }));
		}
		await Promise.all(calls);
		const evidence = readActivityJournal(f.state, f.clock.ms + 1);
		expect(evidence.records.some(row => isActivityEvent(row) && row.kind === "loss" && row.reason === "RECORDER_QUEUE_LIMIT")).toBe(true);
		expect(f.inspect()).toMatchObject({ status: "UNKNOWN", active_ms: null, valid_processing_segment_coverage: null });
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

interface ActivityMutant { entry: string; scratch: { path: string; cleanup(): void }; }
function activityMutant(kind: "recorder" | "projector", needle: string, replacement: string): ActivityMutant {
	const scratch = ownedTmp("activeclock-mutant");
	try {
		const area = kind === "recorder" ? "extensions" : "src";
		const file = kind === "recorder" ? "kit-model-activity.ts" : "model-activity.ts";
		const source = readFileSync(join(root, area, file), "utf8"), at = source.indexOf(needle);
		if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) throw new Error("activity mutation is not uniquely planted");
		mkdirSync(join(scratch.path, area));
		if (kind === "recorder") symlinkSync(join(root, "src"), join(scratch.path, "src"), "dir");
		else {
			symlinkSync(join(root, "src/model-activity-schema.ts"), join(scratch.path, "src/model-activity-schema.ts"));
			symlinkSync(join(root, "src/model-activity-journal.ts"), join(scratch.path, "src/model-activity-journal.ts"));
			symlinkSync(join(root, "src/kitlib"), join(scratch.path, "src/kitlib"), "dir");
		}
		const entry = join(scratch.path, area, file);
		// This is a disposable synthetic source input, never a second mutable
		// product home. Every assertion below judges its actual persisted result.
		writeFileSync(entry, source.slice(0, at) + replacement + source.slice(at + needle.length));
		return { entry, scratch };
	} catch (error) { scratch.cleanup(); throw error; }
}
function activityOracle(report: ModelActivityInspection, expected: number): boolean {
	return report.status === "KNOWN" && report.active_ms === expected;
}
async function activityDurationOutcome(entry?: string): Promise<ModelActivityInspection> {
	const f = await activityFixture({ entry });
	try {
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100, 60_000);
		return inspectModelLedger(f.state, undefined, f.clock.ms + 60_001).activity;
	} finally { f.scratch.cleanup(); }
}
async function activityReplayOutcome(entry?: string): Promise<ModelActivityInspection> {
	const first = await activityFixture({ entry, pane: null, incarnation: "oracle-replay-1" });
	let second: ActivityFixture | undefined;
	try {
		const start = first.clock.ms;
		await first.fire("agent_start");
		await first.turn(0, ACTIVITY_A, 100);
		second = await activityFixture({ entry, pane: null, incarnation: "oracle-replay-2",
			stateRoot: first.state, sourceFile: first.path, baseMs: start });
		await second.fire("agent_start");
		await second.turn(0, ACTIVITY_A, 100);
		return second.inspect();
	} finally { second?.scratch.cleanup(); first.scratch.cleanup(); }
}

test("ACTIVECLOCK1 the real persisted consumer oracle kills request-duration attribution", async () => {
	const needle = 'pi.on("turn_end", (value, ctx) => {\n\t\tconst clock = sample(), current = observe(ctx, clock);';
	const replacement = [
		'pi.on("turn_end", (value, ctx) => {',
		"\t\tconst measured = sample();",
		'\t\tconst requestMs = object(value) && object(value.message) && typeof value.message.duration === "number" ? value.message.duration : 0;',
		"\t\tconst clock: ActivityClockSample = { epoch_ms: measured.epoch_ms === null ? null : measured.epoch_ms + requestMs,",
		"\t\t\tmono_ns: measured.mono_ns === null ? null : (BigInt(measured.mono_ns) + BigInt(requestMs) * 1_000_000n).toString() };",
		"\t\tconst current = observe(ctx, clock);",
	].join("\n");
	const mutant = activityMutant("recorder", needle, replacement);
	try {
		const control = await activityDurationOutcome(), changed = await activityDurationOutcome(mutant.entry);
		const witness = { control: { accepted: activityOracle(control, 100), observed: control.active_ms },
			mutant: { accepted: activityOracle(changed, 100), observed: changed.active_ms, known: changed.known_active_ms }, expected: 100 };
		console.log("ACTIVECLOCK1 request-duration mutant", JSON.stringify(witness));
		expect(witness.control.accepted).toBe(true);
		expect(witness.mutant.accepted).toBe(false);
	} finally { mutant.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 the actual journal consumer oracle kills continuous credit across a waiting gap", async () => {
	const f = await activityFixture();
	const mutant = activityMutant("projector", "if (span > 0 && active.size > 0) {", "if (span > 0) {");
	try {
		const start = f.clock.ms;
		await f.fire("agent_start");
		await f.turn(0, ACTIVITY_A, 100);
		f.advance(10_000);
		await f.turn(1, ACTIVITY_A, 100);
		const source = readActivityJournal(f.state, f.clock.ms + 1);
		const window = { start_ms: start, end_ms: f.clock.ms + 1 };
		const context = { complete: source.complete, problems: source.problems };
		const control = projectActivityRecords(source.records, window, context);
		// An owned synthetic source path selects the changed production module;
		// static import would erase the deliberate mutation boundary.
		const loaded: { projectActivityRecords: typeof projectActivityRecords } = await import(mutant.entry);
		const changed = loaded.projectActivityRecords(source.records, window, context);
		const witness = { control: { accepted: activityOracle(control, 200), observed: control.active_ms },
			mutant: { accepted: activityOracle(changed, 200), observed: changed.active_ms, known: changed.known_active_ms }, expected: 200 };
		console.log("ACTIVECLOCK1 continuous-wait mutant", JSON.stringify(witness));
		expect(witness.control.accepted).toBe(true);
		expect(witness.mutant.accepted).toBe(false);
	} finally { mutant.scratch.cleanup(); f.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

test("ACTIVECLOCK1 the same native session consumer oracle kills duplicate replay credit after restart", async () => {
	const mutant = activityMutant("recorder", "return `session:${current.session}`;", "return `session:${incarnation}`;");
	try {
		const control = await activityReplayOutcome(), changed = await activityReplayOutcome(mutant.entry);
		const witness = { control: { accepted: activityOracle(control, 100), observed: control.active_ms },
			mutant: { accepted: activityOracle(changed, 100), observed: changed.active_ms }, expected: 100 };
		console.log("ACTIVECLOCK1 duplicate-credit mutant", JSON.stringify(witness));
		expect(witness.control.accepted).toBe(true);
		expect(witness.mutant.accepted).toBe(false);
	} finally { mutant.scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);

interface NativeFixture {
	scratch: { path: string; cleanup(): void };
	database: string;
	env: Record<string, string>;
	path: string;
	id: string;
	call(args: string[], options?: { native?: boolean; actor?: string; tool?: string }): Promise<{ rc: number | null; out: string; err: string }>;
}
type FirstVerifyProject = { dir: string };

async function firstVerifyGit(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
	const result = await run(["git", ...args], { cwd, env, deadline_s: fixtureDeadlineS(60), max_output_bytes: 64 * 1024 });
	expect(result.rc, `${args.join(" ")}: ${decoder.decode(result.stderr)}`).toBe(0);
	expect(result.timed_out || result.killed || result.truncated || result.total_truncated).toBe(false);
	return decoder.decode(result.stdout).trim();
}

async function firstVerifyProject(f: NativeFixture, name: string, script: string): Promise<{ project: FirstVerifyProject; sha: string }> {
	const dir = join(f.scratch.path, name), origin = join(f.scratch.path, `${name}.origin.git`);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "var/agent-tmp/\nvar/verify-evidence/\n.omp/lessons.local.jsonl\n");
	await firstVerifyGit(dir, ["init", "-q"], f.env);
	await firstVerifyGit(f.scratch.path, ["init", "--bare", "-q", origin], f.env);
	await firstVerifyGit(dir, ["remote", "add", "origin", origin], f.env);
	const project = { dir };
	return { project, sha: await firstVerifyPublish(f, project, script) };
}

async function firstVerifyPublish(f: NativeFixture, project: FirstVerifyProject, script: string): Promise<string> {
	writeFileSync(join(project.dir, "scripts", "t.sh"), script);
	await firstVerifyGit(project.dir, ["add", "-A"], f.env);
	await firstVerifyGit(project.dir, ["-c", "user.name=FIRSTVERIFY1", "-c", "user.email=firstverify1@example.test", "commit", "-q", "-m", "FIRSTVERIFY1 export"], f.env);
	await firstVerifyGit(project.dir, ["push", "-q", "origin", "HEAD:main"], f.env);
	return firstVerifyGit(project.dir, ["rev-parse", "HEAD"], f.env);
}

async function firstVerifyHandoff(f: NativeFixture, acceptance: string): Promise<void> {
	symlinkSync(f.env.BR_REAL!, join(f.scratch.path, "bin", "br"));
	for (const args of [
		["update", f.id, "--claim", "--json"],
		["update", f.id, "--description", "WHAT: FIRSTVERIFY1 verifier consumer fixture.\n\nWHY: verify attempt evidence must bind the actual author claim and exact Git export.", "--acceptance", acceptance, "--add-label", "kind:fix", "--json"],
		["update", f.id, "--status", "in_review", "--transition-comment", "FIRSTVERIFY1 author handoff", "--json"],
	]) {
		const result = await f.call(args, { actor: "ClaimAuthor", ...(args.includes("--claim") ? { tool: claimCall } : {}) });
		expect(result.rc, result.err).toBe(0);
	}
}

async function firstVerifyResume(f: NativeFixture, reclaimCallId?: string): Promise<void> {
	const started = await f.call(["update", f.id, "--status", "in_progress", "--transition-comment", "FIRSTVERIFY1 author resumed rework", "--json"], { actor: "ClaimAuthor" });
	expect(started.rc, started.err).toBe(0);
	if (reclaimCallId !== undefined) {
		const reclaimed = await f.call(["update", f.id, "--claim", "--json"], { actor: "ClaimAuthor", tool: reclaimCallId });
		expect(reclaimed.rc, reclaimed.err).toBe(0);
	}
	const handedOff = await f.call(["update", f.id, "--status", "in_review", "--transition-comment", "FIRSTVERIFY1 author re-handoff", "--json"], { actor: "ClaimAuthor" });
	expect(handedOff.rc, handedOff.err).toBe(0);
}

function firstVerifyEnv(f: NativeFixture, toolCallId = closeCall): Record<string, string> {
	return { ...f.env, BEADS_DB: f.database, PI_TOOL_CALL_ID: toolCallId };
}

function firstVerifyStateRoot(f: NativeFixture): string {
	const stateHome = f.env.XDG_STATE_HOME;
	if (stateHome === undefined) throw new Error("FIRSTVERIFY1 fixture has no isolated XDG_STATE_HOME");
	return join(stateHome, "omp-kit");
}

function firstVerifyReport(f: NativeFixture): VerifyLedgerInspection {
	return inspectVerifyLedger(firstVerifyStateRoot(f), Date.now(), f.database);
}

function firstVerifyAttempt(report: VerifyLedgerInspection, id: string) {
	const attempt = report.attempts.find(row => row.id === id);
	if (attempt === undefined) throw new Error(`FIRSTVERIFY1 attempt ${id} was not projected`);
	return attempt;
}


async function waitForFirstVerifyFile(path: string, settled: () => VerifyResult | undefined): Promise<void> {
	const deadline = Date.now() + fixtureDeadlineS(60) * 1_000;
	while (!existsSync(path)) {
		const early = settled();
		if (early !== undefined) throw new Error(`FIRSTVERIFY1 exited before replay barrier: ${early.log}`);
		if (Date.now() >= deadline) throw new Error(`FIRSTVERIFY1 timed out waiting for ${path}`);
		// An OS child must create this marker; fake timers cannot advance that process, so the short poll yields while checking real state.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 10);
		await promise;
	}
}

test("FIRSTVERIFY1 real verify consumer keeps the first FAIL across a later PASS, model/claim change and correction", async () => {
	const f = await nativeFixture();
	try {
		const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> right";
		const { project, sha: failedSha } = await firstVerifyProject(f, "firstverify-fail-pass", "#!/bin/sh\nprintf 'wrong\\n'\n");
		await firstVerifyHandoff(f, acceptance);
		const originalClaim = f.inspect().operations.find(row => row.intent.kind === "claim");
		if (originalClaim === undefined) throw new Error("FIRSTVERIFY1 original claim was not recorded");
		const firstResult = await verifyBead({ bead: f.id, exportSha: failedSha, repo: project.dir, actor: "PeerVerifier", env: firstVerifyEnv(f), lesson: "FIRSTVERIFY1 fixture review" });
		expect(firstResult.code).toBe("REWORK");
		expect(firstResult.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "FAIL" });
		const firstId = firstResult.verificationEvidence?.attemptId;
		if (firstId === undefined) throw new Error("FIRSTVERIFY1 failed review did not return its durable attempt id");
		const firstReport = firstVerifyReport(f);
		const original = firstVerifyAttempt(firstReport, firstId);
		expect(original).toMatchObject({
			outcome: "FAIL", complete: true, replayed: true,
			context: {
				tracker: f.database, bead: f.id, export_requested: failedSha, export_commit: failedSha,
				author: { status: "KNOWN", operation_id: originalClaim.intent.operation_id, attribution: { status: "KNOWN", model: "gpt-6.1-sol" } },
				verifier: { actor: "PeerVerifier", attribution: { status: "KNOWN", model: "muse" } },
			},
		});

		journal(f.path, [
			assistant("native-claim", null, claimCall, "gpt-6.1-sol"),
			assistant("native-close", "native-claim", closeCall, "muse", "anthropic-api"),
			assistant("native-reclaim", "native-close", "reclaim-call", "claude-sonnet-4.5", "anthropic-api"),
			assistant("verify-next", "native-reclaim", "verify-next-call", "haiku", "anthropic-api"),
		]);
		await firstVerifyResume(f, "reclaim-call");
		const claimHistory = f.inspect().operations.filter(row => row.intent.kind === "claim");
		expect(claimHistory).toHaveLength(2);
		const reclaimedClaim = claimHistory[1];
		if (reclaimedClaim === undefined) throw new Error("FIRSTVERIFY1 re-claim operation was not captured");
		expect(reclaimedClaim.intent.claim_incarnations[f.id]).toBe(originalClaim.intent.operation_id);
		expect(reclaimedClaim.outcome?.attribution).toMatchObject({ status: "KNOWN", model: "claude-sonnet-4.5" });
		const passedSha = await firstVerifyPublish(f, project, "#!/bin/sh\nprintf 'right\\n'\n");
		const secondResult = await verifyBead({ bead: f.id, exportSha: passedSha, repo: project.dir, actor: "PeerVerifier", env: firstVerifyEnv(f, "verify-next-call"), lesson: "FIRSTVERIFY1 fixture retry" });
		expect(secondResult.code).toBe("CLOSED");
		expect(secondResult.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "PASS" });
		const secondId = secondResult.verificationEvidence?.attemptId;
		if (secondId === undefined) throw new Error("FIRSTVERIFY1 passing review did not return its durable attempt id");
		let report = firstVerifyReport(f);
		const attempts = report.attempts.filter(row => row.context.tracker === f.database && row.context.bead === f.id);
		expect(attempts.map(row => row.outcome)).toEqual(["FAIL", "PASS"]);
		expect(report.first_attempts.filter(row => row.context.bead === f.id).map(row => row.outcome)).toEqual(["FAIL"]);
		const firstAfterRetry = firstVerifyAttempt(report, firstId);
		expect(firstAfterRetry.context).toEqual(original.context);
		const secondAttempt = firstVerifyAttempt(report, secondId);
		expect(secondAttempt.context).toMatchObject({
			export_requested: passedSha, export_commit: passedSha,
			verifier: { attribution: { status: "KNOWN", model: "haiku" } },
		});
		if (secondAttempt.context.author.status === "KNOWN")
			expect(secondAttempt.context.author.attribution.model).toBe("gpt-6.1-sol");
		else expect(secondAttempt.context.author.status).toBe("UNKNOWN");

		const currentAuthor = observeAuthorClaim(firstVerifyStateRoot(f), f.database, f.id);
		const ref = firstVerifyAttempt(report, firstId).attempt;
		if (ref === null) throw new Error("FIRSTVERIFY1 retained attempt has no correction reference");
		const correction = await appendVerifyCorrection(ref, { reason: "later claim evidence was revisited", author: currentAuthor });
		expect(correction.status).toBe("FINALIZED");
		report = firstVerifyReport(f);
		const preserved = firstVerifyAttempt(report, firstId);
		expect(preserved.outcome).toBe("FAIL");
		expect(preserved.context).toEqual(original.context);
		expect(report.first_attempts.filter(row => row.context.bead === f.id).map(row => row.outcome)).toEqual(["FAIL"]);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(240) * 1_000);

test("FIRSTVERIFY1 concurrent completion cannot let the later PASS outrun the first durable begin", async () => {
	const f = await nativeFixture();
	const started = join(f.scratch.path, "slow-started"), release = join(f.scratch.path, "slow-release");
	let firstRun: Promise<VerifyResult> | undefined;
	let firstSettled: VerifyResult | undefined;
	try {
		const script = "#!/bin/sh\nif [ \"$FIRSTVERIFY_MODE\" = slow ]; then\n  printf started > \"$FIRSTVERIFY_STARTED\"\n  while [ ! -e \"$FIRSTVERIFY_RELEASE\" ]; do sleep 0.01; done\n  printf 'wrong\\n'\nelse\n  printf 'right\\n'\nfi\n";
		const { project, sha } = await firstVerifyProject(f, "firstverify-concurrent", script);
		const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> right";
		await firstVerifyHandoff(f, acceptance);
		firstRun = verifyBead({ bead: f.id, exportSha: sha, repo: project.dir, actor: "PeerVerifier",
			env: { ...firstVerifyEnv(f), FIRSTVERIFY_MODE: "slow", FIRSTVERIFY_STARTED: started, FIRSTVERIFY_RELEASE: release }, lesson: "FIRSTVERIFY1 concurrent slow" })
			.then(result => { firstSettled = result; return result; });
		await waitForFirstVerifyFile(started, () => firstSettled);
		const later = await verifyBead({ bead: f.id, exportSha: sha, repo: project.dir, actor: "PeerVerifier",
			env: { ...firstVerifyEnv(f), FIRSTVERIFY_MODE: "fast", FIRSTVERIFY_STARTED: started, FIRSTVERIFY_RELEASE: release }, lesson: "FIRSTVERIFY1 concurrent fast" });
		expect(later.code).toBe("CLOSED");
		expect(later.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "PASS" });
		const laterId = later.verificationEvidence?.attemptId;
		if (laterId === undefined) throw new Error("FIRSTVERIFY1 later concurrent attempt has no id");
		const pending = firstVerifyReport(f).attempts.filter(row => row.context.bead === f.id);
		expect(pending).toHaveLength(2);
		const firstPending = pending[0], secondPending = pending[1];
		if (firstPending === undefined || secondPending === undefined) throw new Error("FIRSTVERIFY1 concurrent attempts were not both projected");
		expect(firstPending.complete).toBe(false);
		expect(secondPending.id).toBe(laterId);
		expect(secondPending.complete).toBe(true);
		expect(secondPending.outcome).toBe("PASS");

		writeFileSync(release, "continue");
		const earlier = await firstRun;
		expect(earlier.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "FAIL" });
		const earlierId = earlier.verificationEvidence?.attemptId;
		if (earlierId === undefined) throw new Error("FIRSTVERIFY1 earlier concurrent attempt has no id");
		const settled = firstVerifyReport(f);
		const attempts = settled.attempts.filter(row => row.context.bead === f.id);
		expect(attempts.map(row => row.id)).toEqual([earlierId, laterId]);
		expect(attempts.map(row => row.outcome)).toEqual(["FAIL", "PASS"]);
		expect(settled.first_attempts.filter(row => row.context.bead === f.id).map(row => row.outcome)).toEqual(["FAIL"]);
	} finally {
		writeFileSync(release, "continue");
		if (firstRun !== undefined) await firstRun.catch(() => undefined);
		f.scratch.cleanup();
	}
}, fixtureDeadlineS(240) * 1_000);

test("FIRSTVERIFY1 interrupted first replay stays UNJUDGED when a later exact export passes", async () => {
	const f = await nativeFixture();
	try {
		const acceptance = "- [ ] [a] [build] `exec sh scripts/t.sh` -> right";
		const { project, sha: interruptedSha } = await firstVerifyProject(f, "firstverify-interrupted", "#!/bin/sh\nkill -KILL $$\n");
		await firstVerifyHandoff(f, acceptance);
		const interrupted = await verifyBead({ bead: f.id, exportSha: interruptedSha, repo: project.dir, actor: "PeerVerifier", env: firstVerifyEnv(f), lesson: "FIRSTVERIFY1 interrupted fixture" });
		expect(interrupted.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "UNJUDGED" });
		expect(interrupted.replays[0]?.execution).toMatchObject({ eligible: true, attempted: true, completed: false });
		const execution = interrupted.replays[0]?.execution;
		expect(execution?.signal === 9 || execution?.timedOut === true || execution?.killed === true).toBe(true);

		await firstVerifyResume(f);
		const passedSha = await firstVerifyPublish(f, project, "#!/bin/sh\nprintf 'right\\n'\n");
		const passed = await verifyBead({ bead: f.id, exportSha: passedSha, repo: project.dir, actor: "PeerVerifier", env: firstVerifyEnv(f), lesson: "FIRSTVERIFY1 after interruption" });
		expect(passed.code).toBe("CLOSED");
		expect(passed.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "PASS" });
		const report = firstVerifyReport(f);
		expect(report.attempts.filter(row => row.context.bead === f.id).map(row => row.outcome)).toEqual(["UNJUDGED", "PASS"]);
		expect(report.first_attempts.filter(row => row.context.bead === f.id).map(row => row.outcome)).toEqual(["UNJUDGED"]);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(240) * 1_000);

test("FIRSTVERIFY1 begin failure and environment no-replay are explicit UNJUDGED outcomes", async () => {
	const f = await nativeFixture();
	try {
		const { project, sha } = await firstVerifyProject(f, "firstverify-no-replay", "#!/bin/sh\nprintf 'right\\n'\n");
		const token = join(project.dir, "scripts", "t.sh");
		const acceptance = `- [ ] [a] [build] \`sh ${token}\` -> right`;
		await firstVerifyHandoff(f, acceptance);

		const unavailable = await verifyBead({ bead: f.id, exportSha: sha, repo: project.dir,
			actor: "PeerVerifier", env: { ...firstVerifyEnv(f), XDG_STATE_HOME: "relative-state-is-not-valid" }, lesson: "FIRSTVERIFY1 begin failure" });
		expect(unavailable).toMatchObject({ code: "ENVIRONMENT", replays: [], verificationEvidence: { status: "UNAVAILABLE" } });
		expect(unavailable.acts).toEqual([]);

		const unsafeRoot = join(f.scratch.path, "unsafe root");
		mkdirSync(unsafeRoot, { recursive: true });
		const previous = process.env.GRADE_WAVE_SCRATCH;
		let result: VerifyResult;
		try {
			process.env.GRADE_WAVE_SCRATCH = unsafeRoot;
			result = await verifyBead({ bead: f.id, exportSha: sha, repo: project.dir,
				actor: "PeerVerifier", env: firstVerifyEnv(f), lesson: "FIRSTVERIFY1 environment failure" });
		} finally {
			if (previous === undefined) delete process.env.GRADE_WAVE_SCRATCH; else process.env.GRADE_WAVE_SCRATCH = previous;
		}
		expect(result.code).toBe("ENVIRONMENT");
		expect(result.replays.map(replay => [replay.pass, replay.rc, replay.execution?.attempted])).toEqual([[null, null, false]]);
		const unmapped = result.replays[0];
		if (unmapped === undefined) throw new Error("FIRSTVERIFY1 unmapped environment replay was not projected");
		expect(unmapped.detail).toContain(`UNJUDGED REPO_PATH_UNMAPPED: ${JSON.stringify(token)}`);
		expect(result.verificationEvidence).toMatchObject({ status: "FINALIZED", outcome: "UNJUDGED" });
		const attempts = firstVerifyReport(f).attempts.filter(row => row.context.bead === f.id);
		expect(attempts).toHaveLength(1);
		const noReplayAttempt = attempts[0];
		if (noReplayAttempt === undefined) throw new Error("FIRSTVERIFY1 no-replay attempt was not projected");
		expect(noReplayAttempt.outcome).toBe("UNJUDGED");
		expect(noReplayAttempt.replayed).toBe(false);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(240) * 1_000);

test("FIRSTVERIFY1 dry run replays the exact export without allocating review credit", async () => {
	const f = await nativeFixture();
	try {
		const { project, sha } = await firstVerifyProject(f, "firstverify-dry-run", "#!/bin/sh\nprintf 'right\\n'\n");
		await firstVerifyHandoff(f, "- [ ] [a] [build] `sh scripts/t.sh` -> right");
		const before = firstVerifyReport(f).attempts.length;
		const dryRun = await verifyBead({ bead: f.id, exportSha: sha, repo: project.dir, actor: "PeerVerifier", env: firstVerifyEnv(f), dryRun: true, lesson: "FIRSTVERIFY1 dry run" });
		expect(dryRun.code).toBe("DRY_RUN");
		expect(dryRun.replays.map(replay => replay.pass)).toEqual([true]);
		expect(dryRun.verificationEvidence).toMatchObject({ status: "NOT_RECORDED" });
		expect(firstVerifyReport(f).attempts).toHaveLength(before);
		const shown = await f.call(["show", f.id, "--json"], { native: true });
		const rows = JSON.parse(shown.out);
		const bead = Array.isArray(rows) ? rows[0] : rows;
		expect(bead.status).toBe("in_review");
		expect(bead.acceptance_criteria).toContain("- [ ]");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(180) * 1_000);
