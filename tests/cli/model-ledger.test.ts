import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { inspectModelLedger, observeWorkingModel, MODEL_LEDGER_MAX_READ_BYTES } from "../../src/model-ledger.ts";
import { run } from "../../src/kitlib/run.ts";
import { nativeBr } from "./lib/native-br.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fixturePycachePrefix } from "./lib/fixture-pycache.ts";

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
		.replace('"./kitlib/jsonl.ts"', JSON.stringify(join(root, "src/kitlib/jsonl.ts")));
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
