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
    writeSync,
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
	waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
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
type PopenChild = { file: number; pidPath: string; pid?: number; closed: boolean };
type Inheritor = PopenChild & { fifo: string };
// Real-process integration: fake timers cannot advance kernel child states or FIFO opens; polls use real time.

function shellWord(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

function startPopen(argv: string[], pidPath: string): PopenChild {
	// The shell records its own PID before exec, so the recorded child keeps that identity.
	const command = Buffer.from(`printf '%s\\n' "$$" > ${shellWord(pidPath)} || exit 125; exec ${argv.map(shellWord).join(" ")}\0`);
	const mode = Buffer.from("r\0");
	const file = libc.symbols.popen(ptr(command), ptr(mode)) as number | null;
	if (file === null) throw new Error("INHERITOR_POPEN_FAILED");
	return { file, pidPath, closed: false };
}

async function finishPopen(child: PopenChild, timeoutMs = 10_000, terminate = false): Promise<number> {
	if (child.closed) throw new Error("INHERITOR_ALREADY_CLOSED");
	const pidDeadline = performance.now() + 10_000;
	while (child.pid === undefined) {
		try {
			const recorded = readFileSync(child.pidPath, "utf8");
			if (recorded.endsWith("\n")) {
				const pid = Number(recorded.trim());
				if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INHERITOR_PID_INVALID");
				child.pid = pid;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (child.pid !== undefined) break;
		if (performance.now() >= pidDeadline) throw new Error("INHERITOR_PID_UNPROVED");
		await Bun.sleep(10); // Poll the child's completed PID record, not an assumed startup delay.
	}
	const deadline = performance.now() + timeoutMs;
	// POSIX waitid(P_PID, WEXITED|WNOHANG|WNOWAIT) observes only this child without reaping it.
	// https://pubs.opengroup.org/onlinepubs/9699919799.2018edition/functions/waitid.html
	// Darwin/Linux siginfo_t fit 128 bytes and begin with si_signo; WNOWAIT differs in their public wait.h.
	const info = new Int32Array(32);
	const flags = 1 | 4 | (process.platform === "darwin" ? 0x20 : 0x01000000);
	const exited = (): boolean => {
		info.fill(0);
		if (libc.symbols.waitid(1, child.pid!, ptr(info), flags) !== 0) {
			throw new Error(`INHERITOR_OWNERSHIP_UNPROVED pid=${child.pid}`);
		}
		return info[0] !== 0; // SIGCHLD is supplied only for a waitable exit.
	};
	if (terminate && !exited()) process.kill(child.pid, "SIGTERM");
	let timedOut = false;
	let drainDeadline = deadline;
	while (!exited()) {
		if (performance.now() >= drainDeadline) {
			if (timedOut) throw new Error(`INHERITOR_DRAIN_UNPROVED pid=${child.pid}`);
			process.kill(child.pid, "SIGKILL");
			timedOut = true;
			drainDeadline = performance.now() + 10_000;
		}
		await Bun.sleep(10); // The event loop and Bun's own test deadline remain live.
	}
	// No other code reaps this popen child. WNOWAIT left it waitable, so pclose cannot await a running child.
	const status = libc.symbols.pclose(child.file as never);
	child.closed = true;
	if (status < 0) throw new Error(`INHERITOR_PCLOSE_FAILED pid=${child.pid}`);
	console.log(`${new Date().toISOString()} INHERITOR_REAPED pid=${child.pid} status=${status}`);
	if (timedOut) throw new Error(`INHERITOR_EXIT_TIMEOUT pid=${child.pid} deadline_ms=${timeoutMs}`);
	return status;
}

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
		case "end-inheritor": await this.endInheritor(step.as as string); break;
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
		this.inheritors.set(step.as as string, { ...startPopen(argv, `${fifo}.pid`), fifo });
	}

	async endInheritor(name: string): Promise<void> {
		const inheritor = this.inheritors.get(name);
		if (inheritor === undefined) return;
		try {
			// A signal ends our child even while it is opening/reading the FIFO; EOF timing is not a handshake.
			await finishPopen(inheritor, 10_000, true);
		} finally {
			if (inheritor.closed) this.inheritors.delete(name);
		}
	}

	async cleanup(): Promise<void> {
		let failures: unknown[] | undefined;
		const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
			try { await action(); } catch (error) { (failures ??= []).push(error); }
		};
		for (const lock of this.locks.values()) await attempt(() => lock.release());
		for (const name of [...this.inheritors.keys()]) await attempt(() => this.endInheritor(name));
		for (const { proc } of this.holders.values()) {
			await attempt(async () => {
				proc.kill("SIGKILL");
				try { proc.stdin.end(); } catch { /* already closed */ }
				await exitedWithin(proc, 15_000);
				await proc.exited;
			});
		}
		if (failures) throw new AggregateError(failures, "lock corpus cleanup failed");
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
	let failure: unknown;
	let failed = false;
	try {
		for (const step of testCase.steps) await caseRun.step(step);
	} catch (error) {
		failure = error;
		failed = true;
	} finally {
		resetSeam();
		try {
			await caseRun.cleanup();
		} catch (error) {
			if (failed) throw new AggregateError([failure, error], "lock corpus case and cleanup failed");
			throw error;
		} finally {
			scratch.cleanup();
		}
	}
	if (failed) throw failure;
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

describe("kitlib lock inheritor shutdown", () => {
	async function delayedReader(tmp: string): Promise<PopenChild> {
		const fifo = join(tmp, "reader.fifo");
		const gate = join(tmp, "reader-gate.fifo");
		const made = await run(["mkfifo", "-m", "600", fifo, gate], { deadline_s: 10 });
		expect(made.rc).toBe(0);
		const anchor = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
		let child: PopenChild | undefined;
		try {
			try {
				child = startPopen(["sh", "-c", `read -r go < ${shellWord(gate)}; exec cat ${shellWord(fifo)}`], join(tmp, "reader.pid"));
				// Force the old writer open-and-close to finish before the child can open the data FIFO.
				closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
			} finally {
				closeSync(anchor);
			}
			const deadline = performance.now() + 10_000;
			for (;;) {
				let fd: number;
				try {
					fd = openSync(gate, constants.O_WRONLY | constants.O_NONBLOCK);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENXIO" || performance.now() >= deadline) throw error;
					await Bun.sleep(10);
					continue;
				}
				try { writeSync(fd, "go\n"); } finally { closeSync(fd); }
				return child;
			}
		} catch (error) {
			if (child) {
				try { await finishPopen(child, 10_000, true); } catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "delayed reader setup and cleanup failed");
				}
			}
			throw error;
		}
	}

	function expectReaped(child: PopenChild): void {
		let code: string | undefined;
		try { process.kill(child.pid!, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
		expect(code, `child ${child.pid} still exists after pclose`).toBe("ESRCH");
	}

	test("a delayed reader is terminated even after the old writer handshake has already disappeared", async () => {
		const scratch = ownedTmp("kitlib-lock-shutdown");
		let child: PopenChild | undefined;
		try {
			child = await delayedReader(realpathSync(scratch.path));
			await finishPopen(child, 10_000, true);
			expectReaped(child);
		} finally {
			if (child && !child.closed) await finishPopen(child, 10_000, true);
			scratch.cleanup();
		}
	}, 60_000);

	test("the old open-and-close handshake leaves the same delayed reader waiting until a named deadline", async () => {
		const scratch = ownedTmp("kitlib-lock-shutdown");
		let child: PopenChild | undefined;
		try {
			child = await delayedReader(realpathSync(scratch.path));
			// This child cannot exit naturally: its only writer closed before it could open the FIFO.
			await expect(finishPopen(child, 100)).rejects.toThrow("INHERITOR_EXIT_TIMEOUT");
			expectReaped(child);
		} finally {
			if (child && !child.closed) await finishPopen(child, 10_000, true);
			scratch.cleanup();
		}
	}, 60_000);

	test("a normal popen exit is reaped without waiting for a deadline", async () => {
		const scratch = ownedTmp("kitlib-lock-shutdown");
		const child = startPopen(["true"], join(realpathSync(scratch.path), "normal.pid"));
		try {
			expect(await finishPopen(child)).toBe(0);
			expectReaped(child);
		} finally {
			if (!child.closed) await finishPopen(child, 10_000, true);
			scratch.cleanup();
		}
	}, 60_000);

	test("a nonexiting popen child is killed and reaped at its deadline without touching another child", async () => {
		const scratch = ownedTmp("kitlib-lock-shutdown");
		const tmp = realpathSync(scratch.path);
		const fifo = join(tmp, "never.fifo");
		const controlFifo = join(tmp, "control.fifo");
		expect((await run(["mkfifo", "-m", "600", fifo, controlFifo], { deadline_s: 10 })).rc).toBe(0);
		const child = startPopen(["sh", "-c", `trap '' TERM; exec cat ${shellWord(fifo)}`], join(tmp, "never.pid"));
		const controlAbort = new AbortController();
		const { promise: controlReady, resolve: ready } = Promise.withResolvers<void>();
		let controlOutput = "";
		const control = run(["sh", "-c", 'printf "READY\\n"; read -r probe < "$1" && [ "$probe" = probe ] && printf "ALIVE\\n"', "sh", controlFifo], {
			deadline_s: 30,
			signal: controlAbort.signal,
			on_output: (stream, chunk) => {
				if (stream === "stdout") {
					controlOutput += decoder.decode(chunk);
					if (controlOutput.includes("READY\n")) ready();
				}
			},
		});
		try {
			await Promise.race([
				controlReady,
				control.then(result => {
					throw new Error(result.timed_out ? "UNRELATED_CONTROL_START_TIMEOUT" : `UNRELATED_CONTROL_EXITED_EARLY rc=${result.rc}`);
				}),
			]);
			await expect(finishPopen(child, 100)).rejects.toThrow("INHERITOR_EXIT_TIMEOUT");
			expectReaped(child);
			// A response to input supplied after the target's reap proves the unrelated child still works.
			const deadline = performance.now() + 10_000;
			for (;;) {
				let fd: number;
				try { fd = openSync(controlFifo, constants.O_WRONLY | constants.O_NONBLOCK); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENXIO" || performance.now() >= deadline) throw error;
					await Bun.sleep(10); // Real FIFO-open readiness belongs to the OS, not a fake test clock.
					continue;
				}
				try { writeSync(fd, "probe\n"); } finally { closeSync(fd); }
				break;
			}
			const result = await control;
			expect(result.rc).toBe(0);
			expect(result.timed_out).toBe(false);
			expect(result.killed).toBe(false);
			expect(decoder.decode(result.stdout)).toBe("READY\nALIVE\n");
		} finally {
			try {
				if (!child.closed) await finishPopen(child, 10_000, true);
			} finally {
				const teardown = new Error("UNRELATED_CONTROL_TEARDOWN");
				controlAbort.abort(teardown);
				try {
					await control;
				} catch (error) {
					if (error !== teardown) throw error; // Ignore only the abort this cleanup requested.
				} finally { scratch.cleanup(); }
			}
		}
	}, 60_000);
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
