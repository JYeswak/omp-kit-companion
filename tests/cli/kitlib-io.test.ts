// Conformance tests for src/kitlib/io.ts (ompkit-67i70, KL06). Every case comes from
// tests/fixtures/kitlib-io/corpus.json, the same corpus tests/scripts/kitlib_io_test.py runs
// against scripts/kitlib_io.py, so the two languages cannot drift. Faults go through the
// atomicReplaceBytesWith seam; each case runs in its own dir inside one kitlib owned temp dir.
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync,
	unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run";
import {
	AtomicReplaceError, atomicReplaceBytes, atomicReplaceBytesWith, defaultIoOps, type AtomicReplaceOptions,
	type AtomicReplaceResult, type IoOps,
} from "../../src/kitlib/io";

type Setup = { file?: string; text?: string; mode?: number; dir?: string; symlink?: string; to?: string };
type Call = {
	path?: string; path_literal?: string; text?: string; hex?: string; mode: number; durability: string | null;
	stage_dir?: string; public_root?: string; umask?: number; validate?: "accept-exact" | "refuse";
};
type Fault = {
	temp_name?: string; write_fail?: { after: number; errno: string }; write_stall?: { after: number }; write_lie?: boolean;
	fsync_errno?: string; rename_errno?: string; dir_fsync_errno?: string; stage_other_device?: boolean; hardlink_temp?: string;
	at?: { boundary: string; do: "swap-temp" | "cancel" };
};
type Expect = {
	ok?: boolean; code?: string; published?: boolean; file_synced?: boolean; directory_synced?: boolean; durable?: boolean;
	cancelled_after_publish?: boolean; errno?: string; temp_left?: boolean; files?: Record<string, string>;
	files_hex?: Record<string, string>; symlinks?: Record<string, string>; modes?: Record<string, number>;
	entries?: Record<string, string[]>; reader_torn?: number; final_counter?: number;
};
type Case = { id: string; kind?: string; setup: Setup[]; call: Call; fault?: Fault; expect: Expect; writes?: number; size?: number; reader_argv?: string[] };
type Negative = { id: string; case: string; bypass: string[]; control: string };
type Outcome = { result: AtomicReplaceResult | null; error: unknown; readerTorn?: number; reads?: number; finalCounter?: number; stateBefore?: string; stateAfter?: string };

const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-io/corpus.json"), "utf8")) as { schema: string; cases: Case[]; planted_negatives: Negative[] };
if (corpus.schema !== "kitlib-io-corpus.v1" || corpus.cases.length === 0) throw new Error("tests/fixtures/kitlib-io/corpus.json is not a kitlib-io-corpus.v1 corpus");
const byId = new Map(corpus.cases.map(kase => [kase.id, kase]));

const owned = ownedTmp("kitlib-io-test", { bead: "ompkit-67i70" });
const ownedRoot = realpathSync(owned.path);
let serial = 0;

function caseDir(kase: Case): string {
	const dir = join(ownedRoot, `${String(serial++).padStart(3, "0")}-${kase.id}`);
	mkdirSync(dir, { mode: 0o700 });
	for (const entry of kase.setup) {
		if (entry.file !== undefined) writeFileSync(join(dir, entry.file), entry.text ?? "", { mode: entry.mode ?? 0o600, flag: "wx" });
		else if (entry.dir !== undefined) mkdirSync(join(dir, entry.dir), { mode: 0o700 });
		else if (entry.symlink !== undefined) symlinkSync(join(dir, entry.to!), join(dir, entry.symlink));
	}
	return dir;
}

function injected(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: injected by the kitlib-io test seam`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function globalState(): string {
	const mask = process.umask(0o022);
	process.umask(mask);
	return JSON.stringify([mask, ...["exit", "beforeExit", "SIGHUP", "SIGINT", "SIGTERM"].map(event => process.listenerCount(event))]);
}

function options(dir: string, kase: Case, extra: Partial<AtomicReplaceOptions> = {}): AtomicReplaceOptions {
	const call = kase.call;
	return {
		mode: call.mode,
		durability: (call.durability ?? undefined) as AtomicReplaceOptions["durability"],
		...(call.stage_dir !== undefined ? { stageDir: join(dir, call.stage_dir) } : {}),
		...(call.public_root !== undefined ? { publicRoot: join(dir, call.public_root) } : {}),
		...extra,
	};
}

function plainCall(dir: string, kase: Case, bypass: ReadonlySet<string>): Outcome {
	const call = kase.call, fault = kase.fault ?? {};
	const path = call.path_literal ?? join(dir, call.path!);
	const bytes = call.hex !== undefined ? Buffer.from(call.hex, "hex") : Buffer.from(call.text ?? "");
	const controller = new AbortController();
	const ops: IoOps = { ...defaultIoOps };
	if (fault.temp_name !== undefined) ops.tempName = () => fault.temp_name!;
	let writes = 0;
	if (fault.write_fail) {
		const { after, errno } = fault.write_fail;
		ops.write = (fd, data, offset, length) => {
			if (writes++ === 0) return defaultIoOps.write(fd, data, offset, Math.min(length, after));
			throw injected(errno);
		};
	}
	if (fault.write_stall) {
		const { after } = fault.write_stall;
		ops.write = (fd, data, offset, length) => writes++ === 0 ? defaultIoOps.write(fd, data, offset, Math.min(length, after)) : 0;
	}
	if (fault.write_lie) ops.write = (fd, data, offset, length) => { defaultIoOps.write(fd, data, offset, Math.ceil(length / 2)); return length; };
	if (fault.fsync_errno) ops.fsync = () => { throw injected(fault.fsync_errno!); };
	if (fault.rename_errno) ops.rename = () => { throw injected(fault.rename_errno!); };
	if (fault.dir_fsync_errno) ops.fsyncDirectory = () => { throw injected(fault.dir_fsync_errno!); };
	if (fault.stage_other_device) {
		const stage = join(dir, call.stage_dir!);
		ops.stat = target => {
			const info = statSync(target);
			return target === stage ? Object.assign(Object.create(Object.getPrototypeOf(info)) as Stats, info, { dev: info.dev + 1 }) : info;
		};
	}
	if (fault.hardlink_temp !== undefined) {
		ops.open = (target, flags, mode) => {
			const fd = defaultIoOps.open(target, flags, mode);
			linkSync(target, join(dir, fault.hardlink_temp!));
			return fd;
		};
	}
	const onBoundary = (boundary: string, temp: string) => {
		if (fault.at?.boundary !== boundary) return;
		if (fault.at.do === "cancel") controller.abort(new Error("cancelled by the kitlib-io test"));
		else { unlinkSync(temp); writeFileSync(temp, "attacker", { flag: "wx", mode: 0o600 }); }
	};
	const stage = call.stage_dir !== undefined ? join(dir, call.stage_dir) : dirname(path);
	const validate = call.validate === "refuse"
		? () => { throw new Error("the staged bytes are invalid"); }
		: call.validate === "accept-exact"
			? (temp: string) => {
				if (!readFileSync(temp).equals(bytes)) throw new Error("validate saw incomplete bytes");
				if ((statSync(temp).mode & 0o7777) !== call.mode) throw new Error("validate saw the wrong mode");
				if (dirname(temp) !== stage) throw new Error("validate saw a temp outside the stage");
			}
			: undefined;
	const prior = call.umask !== undefined ? process.umask(call.umask) : null;
	try {
		return { result: atomicReplaceBytesWith(ops, bypass, path, bytes, options(dir, kase, { signal: controller.signal, onBoundary, validate })), error: null };
	} catch (error) {
		return { result: null, error };
	} finally {
		if (prior !== null) process.umask(prior);
	}
}

async function concurrentReaders(dir: string, kase: Case): Promise<Outcome> {
	const target = join(dir, kase.call.path!), size = kase.size!;
	const a = Buffer.alloc(size, "a"), b = Buffer.alloc(size, "b");
	atomicReplaceBytes(target, a, options(dir, kase));
	// kitlib run installs its own exit sweep; the handler check below spans only the replacements.
	const reader = run(kase.reader_argv!.map(arg => arg.replaceAll("{DIR}", dir)), { deadline_s: 60 });
	for (const deadline = Date.now() + 30_000; !existsSync(join(dir, "ready")) && Date.now() < deadline;) Bun.sleepSync(10);
	const stateBefore = globalState();
	for (let n = 0; n < kase.writes!; n++) atomicReplaceBytes(target, n % 2 === 0 ? b : a, options(dir, kase));
	const stateAfter = globalState();
	writeFileSync(join(dir, "stop"), "");
	const done = await reader;
	const match = /^reads=(\d+) torn=(\d+)$/m.exec(new TextDecoder().decode(done.stdout));
	if (!match) return { result: null, error: new Error(`reader rc=${done.rc}: ${new TextDecoder().decode(done.stderr)}`), stateBefore, stateAfter };
	return { result: null, error: null, reads: Number(match[1]), readerTorn: Number(match[2]), stateBefore, stateAfter };
}

function rmwRace(dir: string, kase: Case): Outcome {
	const counter = join(dir, kase.call.path!);
	let interleaved = false;
	const increment = (onBoundary?: AtomicReplaceOptions["onBoundary"]) => {
		const next = Number(readFileSync(counter, "utf8")) + 1;
		atomicReplaceBytes(counter, Buffer.from(String(next)), options(dir, kase, { onBoundary }));
	};
	increment(boundary => { if (boundary === "temp-created" && !interleaved) { interleaved = true; increment(); } });
	return { result: null, error: null, finalCounter: Number(readFileSync(counter, "utf8")) };
}

function judge(dir: string, kase: Case, outcome: Outcome): string[] {
	const want = kase.expect, failures: string[] = [];
	const { result } = outcome;
	const error = outcome.error instanceof AtomicReplaceError ? outcome.error : null;
	if (outcome.error && !error) failures.push(`threw a non-AtomicReplaceError: ${String(outcome.error)}`);
	if (want.ok !== undefined && (result !== null) !== want.ok) failures.push(`ok: got ${result !== null} (${error?.message ?? "no error"})`);
	if (want.code !== undefined && error?.code !== want.code) failures.push(`code: got ${error?.code ?? "none"}`);
	if (want.published !== undefined && (result?.published ?? error?.published) !== want.published) failures.push(`published: got ${result?.published ?? error?.published}`);
	const fields = { file_synced: result?.fileSynced, directory_synced: result?.directorySynced, durable: result?.durable, cancelled_after_publish: result?.cancelledAfterPublish };
	for (const [key, got] of Object.entries(fields)) {
		const wanted = want[key as keyof typeof fields];
		if (wanted !== undefined && got !== wanted) failures.push(`${key}: got ${got}`);
	}
	if (want.errno !== undefined && error?.errno !== want.errno) failures.push(`errno: got ${error?.errno}`);
	if (want.temp_left !== undefined && (error?.tempLeft != null) !== want.temp_left) failures.push(`temp_left: got ${error?.tempLeft}`);
	for (const [name, text] of Object.entries(want.files ?? {})) {
		let got: string | null = null;
		try { got = readFileSync(join(dir, name), "utf8"); } catch { /* reported below */ }
		if (got !== text) failures.push(`file ${name}: got ${JSON.stringify(got)}`);
	}
	for (const [name, hex] of Object.entries(want.files_hex ?? {})) {
		let got: string | null = null;
		try { got = readFileSync(join(dir, name)).toString("hex"); } catch { /* reported below */ }
		if (got !== hex) failures.push(`file ${name}: got hex ${got}`);
	}
	for (const [name, to] of Object.entries(want.symlinks ?? {})) {
		let got: string | null = null;
		try { got = readlinkSync(join(dir, name)); } catch { /* reported below */ }
		if (got !== join(dir, to)) failures.push(`symlink ${name}: got ${got}`);
	}
	for (const [name, mode] of Object.entries(want.modes ?? {})) {
		const got = lstatSync(join(dir, name)).mode & 0o7777;
		if (got !== mode) failures.push(`mode ${name}: got ${got.toString(8)}`);
	}
	for (const [sub, names] of Object.entries(want.entries ?? {})) {
		const got = readdirSync(join(dir, sub)).sort();
		if (JSON.stringify(got) !== JSON.stringify(names)) failures.push(`entries ${sub}: got ${JSON.stringify(got)}`);
	}
	if (want.reader_torn !== undefined) {
		if (outcome.readerTorn !== want.reader_torn) failures.push(`reader_torn: got ${outcome.readerTorn} (${String(outcome.error)})`);
		if (!(outcome.reads! > 0)) failures.push(`reader made no reads`);
	}
	if (want.final_counter !== undefined && outcome.finalCounter !== want.final_counter) failures.push(`final_counter: got ${outcome.finalCounter}`);
	return failures;
}

async function runCase(kase: Case, bypass: ReadonlySet<string> = new Set()): Promise<string[]> {
	const dir = caseDir(kase);
	const before = globalState();
	const outcome = kase.kind === "concurrent-readers" ? await concurrentReaders(dir, kase)
		: kase.kind === "rmw-race" ? rmwRace(dir, kase)
			: plainCall(dir, kase, bypass);
	const failures = judge(dir, kase, outcome);
	const [from, to] = outcome.stateBefore !== undefined ? [outcome.stateBefore, outcome.stateAfter] : [before, globalState()];
	if (from !== to) failures.push(`process umask or exit/signal handlers changed: ${from} -> ${to}`);
	return failures;
}

describe("kitlib io conformance corpus", () => {
	for (const kase of corpus.cases) {
		test(kase.id, async () => {
			expect(await runCase(kase)).toEqual([]);
		}, 90_000);
	}
	for (const negative of corpus.planted_negatives) {
		test(`planted negative ${negative.id}: bypassing ${negative.bypass.join(",")} flips ${negative.case}; ${negative.control} still passes`, async () => {
			const kase = byId.get(negative.case)!, control = byId.get(negative.control)!;
			const bypass = new Set(negative.bypass);
			expect(await runCase(kase)).toEqual([]);
			expect((await runCase(kase, bypass)).length).toBeGreaterThan(0);
			expect(await runCase(control, bypass)).toEqual([]);
		});
	}
	test("every bypassed detector is a named branch in both languages", () => {
		const ts = readFileSync(join(import.meta.dir, "../../src/kitlib/io.ts"), "utf8");
		const py = readFileSync(join(import.meta.dir, "../../scripts/kitlib_io.py"), "utf8");
		for (const name of new Set(corpus.planted_negatives.flatMap(negative => negative.bypass))) {
			expect(ts.includes(`bypass.has("${name}")`)).toBe(true);
			expect(py.includes(`"${name}" in bypass`) || py.includes(`"${name}" not in bypass`)).toBe(true);
		}
	});
});

describe("kitlib io TypeScript-only surface", () => {
	test("a string is refused: serialization stays with the caller", () => {
		const dir = caseDir({ id: "string-refused", setup: [], call: { mode: 0o600, durability: "full" }, expect: {} });
		expect(() => atomicReplaceBytes(join(dir, "target"), "text" as unknown as Uint8Array, { mode: 0o600, durability: "full" }))
			.toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT", published: false }));
		expect(readdirSync(dir)).toEqual([]);
	});
});

afterAll(() => {
	owned.cleanup();
	cleanupAllOwnedTmp();
});
