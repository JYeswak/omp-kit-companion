// Conformance tests for src/kitlib/lock.ts (ompkit-lsn3a, KL08). Every case
// comes from tests/fixtures/kitlib-lock/corpus.json, the same corpus
// tests/scripts/kitlib_lock_test.py runs against scripts/kitlib_lock.py, so the
// two languages cannot drift. Holders are real processes in either language,
// so a Python holder blocks this TypeScript waiter on the same inode.
import { afterAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
	chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync,
	readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { __testing, canonicalPath, privateLock, PrivateLockError, resolveLock, type LockResource, type PrivateLock } from "../../src/kitlib/lock";
import { run } from "../../src/kitlib/run";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

type Json = Record<string, unknown>;
type Step = Json & { op: string; when?: "normal" | "bypassed" };
type Case = { id: string; detector?: string; control?: boolean; resource: LockResource; steps: Step[] };
type Corpus = { schema: string; detectors: string[]; holders: Record<"ts" | "py", string[]>; zombie_wrapper: string[]; inheritor_argv: string[]; cases: Case[] };

const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-lock/corpus.json"), "utf8")) as Corpus;
const MODULE_TS = join(import.meta.dir, "../../src/kitlib/lock.ts");
const SCRIPTS_DIR = join(import.meta.dir, "../../scripts");
const PYTHON = Bun.which("python3");
const decoder = new TextDecoder();

// popen(3) is the ordinary exec path that keeps every descriptor not marked close-on-exec;
// Bun.spawn closes every descriptor it is not handed, so it cannot observe FD_CLOEXEC.
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
	popen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	pclose: { args: [FFIType.ptr], returns: FFIType.i32 },
});

function substitute<T>(value: T, vars: Record<string, string>): T {
	if (typeof value === "string") return value.replace(/\{[A-Z_]+\}/g, token => vars[token.slice(1, -1)] ?? token) as T;
	if (Array.isArray(value)) return value.map(item => substitute(item, vars)) as T;
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)])) as T;
	return value;
}

function replaceLockfile(lockfile: string): void {
	renameSync(lockfile, `${lockfile}.replaced`);
	const fd = openSync(lockfile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	fchmodSync(fd, 0o600);
	closeSync(fd);
}

type Holder = { proc: Bun.Subprocess<"pipe", "pipe", "inherit">; pid: number };
type Inheritor = { file: number; fifo: string };

async function firstLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
	const reader = stream.getReader();
	let text = "";
	const end = performance.now() + ms;
	try {
		while (!text.includes("\n")) {
			const remaining = end - performance.now();
			if (remaining <= 0) throw new Error(`no holder line within ${ms} ms: ${JSON.stringify(text)}`);
			const chunk = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
			if (chunk === null) continue;
			if (chunk.done) break;
			text += decoder.decode(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return text.split("\n")[0]!;
}

async function exitedWithin(proc: Bun.Subprocess, ms: number): Promise<void> {
	const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
	if (!done) throw new Error(`process ${proc.pid} did not exit within ${ms} ms`);
}

class CaseRun {
	readonly locks = new Map<string, PrivateLock>();
	readonly holders = new Map<string, Holder>();
	readonly inheritors = new Map<string, Inheritor>();
	readonly inodes = new Map<string, number>();
	constructor(readonly testCase: Case, readonly vars: Record<string, string>, readonly bypassed: boolean) {}

	resource(step: Step): LockResource {
		return substitute((step.resource as LockResource | undefined) ?? this.testCase.resource, this.vars);
	}

	async step(raw: Step): Promise<void> {
		if (raw.when === "normal" && this.bypassed) return;
		if (raw.when === "bypassed" && !this.bypassed) return;
		// The case resource may name an alias planted by an earlier step, so its lock path resolves now.
		const resolved = resolveLock(substitute(this.testCase.resource, this.vars), { state_dir: this.vars.STATE });
		this.vars.LOCKDIR = resolved.dir;
		this.vars.LOCKFILE = resolved.path;
		const step = substitute(raw, this.vars);
		const where = `${this.testCase.id} step ${JSON.stringify(raw)}`;
		const path = step.path as string;
		switch (step.op) {
		case "mkdir": mkdirSync(path); chmodSync(path, Number.parseInt(step.mode as string, 8)); break;
		case "write": writeFileSync(path, step.text as string); break;
		case "symlink": symlinkSync(step.target as string, path); break;
		case "hardlink": linkSync(step.target as string, path); break;
		case "chmod": chmodSync(path, Number.parseInt(step.mode as string, 8)); break;
		case "utime-epoch": utimesSync(path, 0, 0); break;
		case "replace-lockfile": replaceLockfile(this.vars.LOCKFILE!); break;
		case "record-inode": this.inodes.set(step.as as string, lstatSync(path).ino); break;
		case "expect-inode": {
			const info = lstatSync(path);
			expect(info.isFile(), where).toBe(true);
			if (step.same_as !== undefined) expect(info.ino, where).toBe(this.inodes.get(step.same_as as string)!);
			if (step.mtime_epoch) expect(info.mtimeMs, where).toBe(0);
			if (step.text !== undefined) expect(readFileSync(path, "utf8"), where).toBe(step.text as string);
			break;
		}
		case "keys-equal": {
			const resolved = (step.resources as LockResource[]).map(item => resolveLock(item, { state_dir: this.vars.STATE }));
			for (const item of resolved) expect([item.key, item.path], where).toEqual([resolved[0]!.key, resolved[0]!.path]);
			break;
		}
		case "hook":
			if (step.expect_uid === "other") __testing.expectUid = process.getuid!() + 1;
			if (step.skip_inherit) __testing.skipInherit = true;
			if (step.after_lock === "replace-lockfile") __testing.afterLock = replaceLockfile;
			break;
		case "holder": await this.holder(step, where); break;
		case "end-holder": {
			const holder = this.holders.get(step.as as string)!;
			if (step.how === "kill") holder.proc.kill("SIGKILL");
			else holder.proc.stdin.end();
			await exitedWithin(holder.proc, 15_000);
			this.holders.delete(step.as as string);
			break;
		}
		case "expect-zombie": {
			const pid = this.holders.get(step.as as string)!.pid;
			let state = "";
			for (let tries = 0; tries < 100 && !state.startsWith("Z"); tries++) {
				const ps = await run(["ps", "-o", "stat=", "-p", String(pid)], { deadline_s: 10 });
				state = decoder.decode(ps.stdout).trim();
				if (!state.startsWith("Z")) await Bun.sleep(50); // real-clock poll for another process's exit
			}
			expect(state, `${where}: holder ${pid} state`).toStartWith("Z");
			break;
		}
		case "acquire": await this.acquire(step, raw, where); break;
		case "release": {
			const want = this.bypassed && raw.expect_bypassed !== undefined ? step.expect_bypassed : step.expect;
			const lock = this.locks.get(step.as as string);
			expect(lock, where).toBeDefined();
			expect(lock!.release(), where).toBe(want as string);
			break;
		}
		case "inheritor": await this.inheritor(step); break;
		case "end-inheritor": this.endInheritor(step.as as string); break;
		default: throw new Error(`unknown corpus op ${step.op}`);
		}
	}

	async acquire(step: Step, raw: Step, where: string): Promise<void> {
		const want = (this.bypassed && raw.expect_bypassed !== undefined ? step.expect_bypassed : step.expect) as Json;
		const options = { state_dir: this.vars.STATE, ...(step.options as Json) } as Parameters<typeof privateLock>[1];
		let outcome: PrivateLock | unknown;
		try {
			outcome = await privateLock(this.resource(step), options);
		} catch (error) {
			outcome = error;
		}
		if (want.acquired) {
			if (outcome instanceof Error) throw new Error(`${where}: expected acquired, got ${outcome.message} ${JSON.stringify((outcome as PrivateLockError).evidence ?? {})}`);
			const lock = outcome as PrivateLock;
			// A bypassed run acquires through the planted state on purpose; only a clean run must show the private shape.
			if (!this.bypassed) {
				const info = statSync(lock.path);
				expect([info.ino, info.mode & 0o777, statSync(this.vars.LOCKDIR!).mode & 0o777], where).toEqual([lock.ino, 0o600, 0o700]);
			}
			this.locks.set((step.as as string) ?? "lock", lock);
			return;
		}
		if (!(outcome instanceof Error)) {
			(outcome as PrivateLock).release();
			throw new Error(`${where}: expected refusal ${JSON.stringify(want)}, but the lock was acquired`);
		}
		if (want.throws === "type") {
			expect(outcome, where).toBeInstanceOf(TypeError);
			return;
		}
		expect(outcome, where).toBeInstanceOf(PrivateLockError);
		const refusal = outcome as PrivateLockError;
		expect(refusal.code, `${where}: ${JSON.stringify(refusal.evidence)}`).toBe(want.code as PrivateLockError["code"]);
		expect(refusal.evidence.code, where).toBe(refusal.code);
		if (want.evidence !== undefined) expect(refusal.evidence, where).toMatchObject(want.evidence as Json);
		if (want.min_waited_s !== undefined) expect(refusal.evidence.waited_s as number, where).toBeGreaterThanOrEqual(want.min_waited_s as number);
	}

	async holder(step: Step, where: string): Promise<void> {
		const lang = step.lang as "ts" | "py";
		const zombie = step.mode === "zombie";
		const argv = substitute(corpus.holders[lang], {
			BUN: process.execPath, PYTHON: PYTHON!, MODULE_TS, SCRIPTS_DIR, STATE: this.vars.STATE!,
			RESOURCE_JSON: JSON.stringify(this.resource(step)), MODE: zombie ? "exit" : step.mode as string,
		});
		const proc = Bun.spawn(zombie ? [...corpus.zombie_wrapper, ...argv] : argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		this.holders.set(step.as as string, { proc, pid: proc.pid });
		const line = JSON.parse(await firstLine(proc.stdout, 30_000)) as { status: string; pid: number; code?: string };
		expect(line.status, `${where}: ${JSON.stringify(line)}`).toBe("ACQUIRED");
		this.holders.set(step.as as string, { proc, pid: line.pid });
	}

	async inheritor(step: Step): Promise<void> {
		const fifo = join(this.vars.TMP!, `fifo-${step.as as string}`);
		const made = await run(["mkfifo", "-m", "600", fifo], { deadline_s: 10 });
		expect(made.rc).toBe(0);
		const argv = substitute(corpus.inheritor_argv, { FIFO: fifo });
		const command = Buffer.from(`${argv.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" ")}\0`);
		const file = libc.symbols.popen(ptr(command), ptr(Buffer.from("r\0"))) as number | null;
		expect(file, "popen").not.toBeNull();
		this.inheritors.set(step.as as string, { file: file!, fifo });
	}

	endInheritor(name: string): void {
		const inheritor = this.inheritors.get(name);
		if (inheritor === undefined) return;
		this.inheritors.delete(name);
		// Opening the write end without blocking succeeds once the child's cat has the read end; closing it is EOF.
		const end = performance.now() + 10_000;
		for (;;) {
			try {
				closeSync(openSync(inheritor.fifo, constants.O_WRONLY | constants.O_NONBLOCK));
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENXIO" || performance.now() > end) throw error;
				Bun.sleepSync(10);
			}
		}
		libc.symbols.pclose(inheritor.file as never);
	}

	async cleanup(): Promise<void> {
		for (const lock of this.locks.values()) lock.release();
		for (const name of [...this.inheritors.keys()]) this.endInheritor(name);
		for (const { proc } of this.holders.values()) {
			proc.kill("SIGKILL");
			try { proc.stdin.end(); } catch { /* already closed */ }
			await proc.exited;
		}
	}
}

function resetSeam(): void {
	__testing.disabled = new Set();
	__testing.expectUid = undefined;
	__testing.skipInherit = false;
	__testing.afterLock = undefined;
}

async function runCase(testCase: Case, disabled: string[]): Promise<void> {
	const scratch = ownedTmp("kitlib-lock");
	const tmp = realpathSync(scratch.path);
	const vars: Record<string, string> = { TMP: tmp, STATE: join(tmp, "state") };
	const caseRun = new CaseRun(testCase, vars, testCase.detector !== undefined && disabled.includes(testCase.detector));
	resetSeam();
	__testing.disabled = new Set(disabled);
	try {
		for (const step of testCase.steps) await caseRun.step(step);
	} finally {
		resetSeam();
		await caseRun.cleanup();
		scratch.cleanup();
	}
}

describe("kitlib lock conformance corpus", () => {
	test("corpus is a kitlib-lock-corpus.v1 corpus and python3 is present for cross-language holders", () => {
		expect(corpus.schema).toBe("kitlib-lock-corpus.v1");
		expect(corpus.cases.length).toBeGreaterThan(0);
		expect(PYTHON).not.toBeNull();
	});
	for (const testCase of corpus.cases) {
		test(testCase.id, () => runCase(testCase, []), 60_000);
		if (testCase.detector !== undefined) {
			test(`${testCase.id} [detector ${testCase.detector} bypassed: the negative flips]`, () => runCase(testCase, [testCase.detector!]), 60_000);
		}
		if (testCase.control) test(`${testCase.id} [every detector bypassed: valid control still passes]`, () => runCase(testCase, corpus.detectors), 60_000);
	}
});

/** Descriptors of this process open on the inode at `path` (the kernel's view, through /dev/fd). */
function descriptorsOn(path: string): number[] {
	const target = statSync(path);
	return readdirSync("/dev/fd").map(Number).filter(fd => {
		try {
			const info = fstatSync(fd);
			return info.dev === target.dev && info.ino === target.ino;
		} catch {
			return false;
		}
	});
}

// TypeScript-only surface (Python cancellation is exception unwinding, tested in kitlib_lock_test.py).
describe("kitlib lock cancellation, platform and key parity", () => {
	const holderFor = async (state: string, resource: LockResource) => {
		const argv = substitute(corpus.holders.py, { PYTHON: PYTHON!, SCRIPTS_DIR, STATE: state, RESOURCE_JSON: JSON.stringify(resource), MODE: "stdin" });
		const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
		expect(JSON.parse(await firstLine(proc.stdout, 30_000)).status).toBe("ACQUIRED");
		return proc;
	};

	test("an abort while waiting closes the owner descriptor and rejects with the reason", async () => {
		const scratch = ownedTmp("kitlib-lock");
		const state = join(realpathSync(scratch.path), "state");
		const resource: LockResource = { namespace: "kl08", name: "abort-wait" };
		const holder = await holderFor(state, resource);
		try {
			const controller = new AbortController();
			// privateLock opens the descriptor and makes its first attempt synchronously, before its first await.
			const pending = privateLock(resource, { deadline_s: 30, state_dir: state, signal: controller.signal });
			const lockPath = resolveLock(resource, { state_dir: state }).path;
			expect(descriptorsOn(lockPath).length).toBe(1);
			controller.abort(new Error("operator cancel"));
			await expect(pending).rejects.toThrow("operator cancel");
			expect(descriptorsOn(lockPath)).toEqual([]);
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
			scratch.cleanup();
		}
	}, 60_000);

	test("an abort while held releases the lock", async () => {
		const scratch = ownedTmp("kitlib-lock");
		const state = join(realpathSync(scratch.path), "state");
		const resource: LockResource = { namespace: "kl08", name: "abort-held" };
		try {
			const controller = new AbortController();
			const lock = await privateLock(resource, { deadline_s: 0, state_dir: state, signal: controller.signal });
			expect(descriptorsOn(lock.path).length).toBe(1);
			controller.abort();
			expect(descriptorsOn(lock.path)).toEqual([]);
			expect(lock.release()).toBe("ALREADY_RELEASED");
			(await privateLock(resource, { deadline_s: 0, state_dir: state })).release();
		} finally {
			scratch.cleanup();
		}
	}, 30_000);

	test("an unsupported platform refuses instead of faking a lock", async () => {
		const scratch = ownedTmp("kitlib-lock");
		const state = join(realpathSync(scratch.path), "state");
		try {
			const script = `Object.defineProperty(process, "platform", { value: "win32" });
const { privateLock } = await import(${JSON.stringify(MODULE_TS)});
try { await privateLock({ namespace: "kl08", name: "x" }, { deadline_s: 0, state_dir: ${JSON.stringify(state)} }); console.log("ACQUIRED"); }
catch (error) { console.log(error.code); }`;
			const result = await run([process.execPath, "-e", script], { deadline_s: 30 });
			expect(decoder.decode(result.stdout).trim(), decoder.decode(result.stderr)).toBe("UNSUPPORTED_PLATFORM");
			expect(() => lstatSync(state)).toThrow();
		} finally {
			scratch.cleanup();
		}
	}, 30_000);

	test("path keys equal Python os.path.realpath on hard shapes", async () => {
		const scratch = ownedTmp("kitlib-lock");
		const tmp = realpathSync(scratch.path);
		try {
			mkdirSync(join(tmp, "real", "sub"), { recursive: true });
			symlinkSync(join(tmp, "real"), join(tmp, "abs"));
			symlinkSync("real/sub", join(tmp, "rel"));
			symlinkSync("loop-b", join(tmp, "loop-a"));
			symlinkSync("loop-a", join(tmp, "loop-b"));
			const shapes = [
				`${tmp}/abs/sub/missing/tail`, `${tmp}/rel/../x`, `${tmp}/abs/./sub//f`, `${tmp}/loop-a/x`,
				`${tmp}/missing/../abs`, `${tmp}/abs/sub/../../rel`, "relative/x", `${tmp}/`,
			];
			const script = "import json, os, sys\nprint(json.dumps([os.path.realpath(p) for p in json.loads(sys.argv[1])]))";
			const python = await run([PYTHON!, "-c", script, JSON.stringify(shapes)], { deadline_s: 30, cwd: tmp });
			expect(python.rc, decoder.decode(python.stderr)).toBe(0);
			const previous = process.cwd();
			process.chdir(tmp);
			try {
				expect(shapes.map(canonicalPath)).toEqual(JSON.parse(decoder.decode(python.stdout)));
			} finally {
				process.chdir(previous);
			}
		} finally {
			scratch.cleanup();
		}
	}, 30_000);
});

afterAll(() => cleanupAllOwnedTmp());
