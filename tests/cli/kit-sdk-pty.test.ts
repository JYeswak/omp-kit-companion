import { beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOmpSource } from "../../src/omp-source-cache.ts";
import { sdkSourceVersion } from "./kit-sdk-source.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

// The PTY adapter delegates execution, deadlines and group reaping to kitlib.
// No forkpty/setsid child escapes the launcher; only the explicitly passed fds survive exec.
const ptyDriver = String.raw`
import errno, fcntl, json, os, select, struct, sys, termios, threading, time
from pathlib import Path
sys.path.insert(0, str(Path(os.environ["PTY_KIT"]) / "scripts"))
from kitlib_run import run

root = Path(os.environ["PTY_ROOT"])
master, slave = os.openpty()
control_r, control_w = os.pipe()
continue_r, continue_w = os.pipe()
initial = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
os.set_blocking(master, False)
os.set_blocking(control_r, False)
limit = float(os.environ["PTY_DEADLINE_S"])
finished = threading.Event()
output, records, failures = bytearray(), [], []
control = bytearray()

def read_control():
    while True:
        try:
            chunk = os.read(control_r, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        control.extend(chunk)
    while b"\n" in control:
        line, _, rest = control.partition(b"\n")
        control[:] = rest
        records.append(json.loads(line))

def observe():
    end = time.monotonic() + limit + 3
    painted = False
    try:
        while time.monotonic() < end:
            saturated = any(row.get("phase") == "saturated" for row in records)
            if finished.is_set() and not saturated:
                read_control()
                return
            ready, _, _ = select.select([control_r, master] if saturated else [control_r], [], [], min(0.1, max(0, end - time.monotonic())))
            if control_r in ready:
                read_control()
            if master not in ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                read_control()
                return
            if not chunk:
                read_control()
                return
            output.extend(chunk)
            if len(output) > 4 * 1024 * 1024:
                raise AssertionError("PTY capture exceeded its bounded output budget")
            if not painted and b"SDK22_VISIBLE_AFTER_DRAIN" in output:
                painted = True
                os.write(continue_w, b"1")
        raise AssertionError("PTY protocol did not complete within its deadline")
    except BaseException as error:
        failures.append(repr(error))

reader = threading.Thread(target=observe, daemon=True)
reader.start()
env = dict(os.environ, PTY_CONTROL_FD=str(control_w), PTY_CONTINUE_FD=str(continue_r))
redirect = "import os,sys; fd=int(sys.argv[1]); [os.dup2(fd,n) for n in (0,1,2)]; os.close(fd); os.execv(sys.argv[2],sys.argv[2:])"
try:
    result = run([sys.executable, "-c", redirect, str(slave), os.environ["PTY_BUN"], "--no-env-file", str(root / "terminal.mjs")], cwd=root, env=env, inherit_fds=[slave, control_w, continue_r], deadline_s=limit, max_output_bytes=1024 * 1024)
    restored = termios.tcgetattr(slave) == initial
    finished.set()
    os.close(slave)
    slave = -1
    reader.join(limit + 3)
    (root / "terminal.bin").write_bytes(output)
    print(result.stdout.decode(), end="")
    print(result.stderr.decode(), end="", file=sys.stderr)
    print("SDKPTY22_OBSERVED", json.dumps({"rc": result.rc, "bytes": len(output), "termiosRestored": restored, "records": records, "readerErrors": failures}), flush=True)
    assert not reader.is_alive() and not failures, "PTY observer failed"
    assert result.rc == 0 and not result.timed_out and not result.killed and not result.truncated, "native PTY child failed"
    saturated = next(row for row in records if row.get("phase") == "saturated")
    done = next(row for row in records if row.get("phase") == "done")
    assert saturated["pending"] > 256 * 1024, "real native backpressure was not exercised"
    assert done["sdkVersion"] == os.environ["PTY_EXPECTED_SDK_VERSION"] and done["aborted"] is True
    assert done["drains"] > 0 and done["drainsAfterStop"] == 0
    assert b"SDK22_VISIBLE_AFTER_DRAIN" in output, "deferred native frame was not repainted after draining"
    assert b"\x1b[?25h" in output and b"\x1b[?2004l" in output, "terminal ownership was not restored"
    assert restored, "native stop left the PTY input mode changed"
    assert b"SDK22_FORBIDDEN_LATE" not in output, "SDKPTY22_LATE_OUTPUT: stopped application wrote to the handed-back PTY"
finally:
    finished.set()
    for fd in (master, slave, control_r, control_w, continue_r, continue_w):
        if fd >= 0:
            os.close(fd)
`;

// This is an ordinary Bun process on real tty descriptors, never bun:test's headless terminal.
const terminalProgram = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, read, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PTY_ROOT;
const sdk = process.env.PTY_SDK;
const variant = process.env.PTY_VARIANT;
const reportFd = Number(process.env.PTY_CONTROL_FD);
const continueFd = Number(process.env.PTY_CONTINUE_FD);
const path = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
const home = join(root, 'home');
const cwd = join(root, 'workspace');
for (const dir of [home, cwd, join(root, 'tmp'), join(root, 'agent'), join(root, 'sessions')]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, { PATH: path, HOME: home, TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TZ: 'UTC', PI_NO_TITLE: '1' });
process.chdir(cwd);
const report = value => writeSync(reportFd, JSON.stringify(value) + '\n');
const load = async spec => import(pathToFileURL(Bun.resolveSync(spec, sdk)).href);
let session, authStorage, tui;
try {
 assert.equal(process.stdin.isTTY, true, 'stdin is not a real PTY');
 assert.equal(process.stdout.isTTY, true, 'stdout is not a real PTY');
 const { ProcessTerminal, TUI } = await load('@oh-my-pi/pi-tui');
 const { AuthStorage, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore, createAgentSession } = await load('@oh-my-pi/pi-coding-agent');
 const { AssistantMessageEventStream } = await load('@oh-my-pi/pi-ai');
 const { getBundledModel } = await load('@oh-my-pi/pi-catalog/models');
 const model = getBundledModel('openai', 'gpt-4o-mini');
 authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(join(root, 'agent/auth.sqlite')));
 authStorage.keys.setRuntime('openai', 'fixture-only-not-a-credential');
 const settings = await Settings.loadIsolated({ cwd, agentDir: join(root, 'agent'), inMemory: true });
 const modelRegistry = new ModelRegistry(authStorage, join(root, 'agent/models.yml'), { settings, cacheDbPath: join(root, 'agent/models.sqlite'), fetch: async () => { throw new Error('PTY control forbids network'); } });
 const created = await createAgentSession({ cwd, agentDir: join(root, 'agent'), settings, authStorage, modelRegistry, model, sessionManager: SessionManager.create(cwd, join(root, 'sessions')), disableExtensionDiscovery: true, preloadedCustomToolPaths: [], noContextFiles: true, contextFiles: [], skills: [], rules: [], enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, cacheWarming: false, deferRetryFallbackValidation: true, disableModelFallback: true, bindProcessState: false, toolNames: [], titleSystemPrompt: '' });
 session = created.session;
 assert.deepEqual(created.extensionsResult.errors, []);
 const terminal = new ProcessTerminal();
 tui = new TUI(terminal);
 let text = 'SDK22_VISIBLE_AFTER_DRAIN';
 tui.addChild({ render: () => [text], invalidate() {} });
 tui.start();
 let drains = 0, drainsAfterStop = 0, stopped = false;
 const drained = Promise.withResolvers();
 const unsubscribe = terminal.onOutputDrain(() => {
  drains++;
  if (stopped) drainsAfterStop++;
  if (terminal.pendingOutputBytes <= 256 * 1024) drained.resolve();
 });
 terminal.write('x'.repeat(1024 * 1024));
 const pending = terminal.pendingOutputBytes;
 assert(pending > 256 * 1024, 'native output pump did not establish backpressure');
 // Synchronously arm the actual TUI drain subscription before the parent reads a byte.
 tui.renderNow();
 report({ phase: 'saturated', pending });
 const painted = Promise.withResolvers();
 read(continueFd, Buffer.alloc(1), 0, 1, null, (error, size) => {
  if (error) painted.reject(error);
  else if (size === 1) painted.resolve();
  else painted.reject(new Error('PTY paint acknowledgment was lost'));
 });
 await Promise.all([painted.promise, drained.promise]);
 const started = Promise.withResolvers();
 let aborted = false;
 session.agent.streamFn = async (m, context, options) => {
  await options.onPayload({ fixture: 'pty-abort' }, m, options.signal);
  await options.onResponse({ status: 200, headers: {}, requestId: 'owned-pty-abort' }, m, options.signal);
  const message = { role: 'assistant', content: [{ type: 'text', text: 'owned streaming response' }], api: m.api, provider: m.provider, model: m.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  options.signal.addEventListener('abort', () => {
   aborted = options.signal.aborted;
   stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted', errorMessage: 'owned PTY cancellation' } });
  }, { once: true });
  started.resolve();
  return stream;
 };
 const prompt = session.prompt('Owned PTY abort control');
 await started.promise;
 assert.equal(session.isStreaming, true, 'abort control never entered a native model stream');
 await session.abort();
 await prompt;
 await session.waitForRunEnd();
 assert.equal(aborted, true, 'native session did not abort its actual provider signal');
 assert.equal(session.isRunActive, false);
 assert(session.agent.state.messages.some(message => message.role === 'assistant' && message.stopReason === 'aborted'), 'native aborted result did not reach the session');
 await session.dispose();
 session = undefined;
 // A callback already queued before teardown must not paint into the next TTY owner.
 const late = Promise.withResolvers();
 queueMicrotask(() => {
  text = 'SDK22_FORBIDDEN_LATE';
  if (variant === 'late-write-mutant') process.stdout.write(text);
  else terminal.write(text);
  tui.requestRender(true);
  late.resolve();
 });
 tui.stop();
 stopped = true;
 await late.promise;
 const callbacksFlushed = Promise.withResolvers();
 setImmediate(callbacksFlushed.resolve);
 await callbacksFlushed.promise;
 unsubscribe();
 report({ phase: 'done', aborted, drains, drainsAfterStop, sdk: realpathSync(sdk), sdkVersion: JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version, tuiEntrySha256: createHash('sha256').update(readFileSync(Bun.resolveSync('@oh-my-pi/pi-tui', sdk))).digest('hex') });
} catch (error) {
 report({ phase: 'error', stack: error.stack ?? String(error) });
 process.exitCode = 1;
} finally {
 if (session) { await session.abort(); await session.dispose(); }
 tui?.stop();
 await authStorage?.close();
}
`;

const kitRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sdkVersion = sdkSourceVersion("pty", process.env);
let sdkRoot: string;
beforeAll(() => { sdkRoot = ensureOmpSource(sdkVersion, process.env); });

async function runPty(variant: "healthy" | "late-write-mutant") {
	const scratch = ownedTmp("sdk22-pty");
	try {
		writeFileSync(join(scratch.path, "terminal.mjs"), terminalProgram);
		const driver = join(scratch.path, "driver.py");
		writeFileSync(driver, ptyDriver);
		const result = await runFixtureAsync(["python3", driver], {
			cwd: scratch.path, floor_s: 65,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch.path,
				TMPDIR: scratch.path, TMP: scratch.path, TEMP: scratch.path, KITLIB_TMP_ROOT: scratch.path,
				PTY_ROOT: scratch.path, PTY_KIT: kitRoot, PTY_SDK: sdkRoot, PTY_EXPECTED_SDK_VERSION: sdkVersion,
				PTY_BUN: process.execPath, PTY_VARIANT: variant, PTY_DEADLINE_S: String(fixtureDeadlineS(45)),
			},
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.timed_out || result.killed || result.truncated || result.total_truncated, output).toBe(false);
		return { rc: result.rc, output };
	} finally {
		scratch.cleanup();
	}
}

test("SDKPTY22 real PTY drains deferred paint, aborts a native session and restores terminal ownership", async () => {
	const result = await runPty("healthy");
	expect(result.rc, result.output).toBe(0);
	console.error(result.output);
}, fixtureDeadlineS(90) * 1000);

test("SDKPTY22 late-writer mutant loses the unchanged real PTY output consumer", async () => {
	const result = await runPty("late-write-mutant");
	expect(result.rc, result.output).toBe(1);
	expect(result.output).toContain("SDKPTY22_LATE_OUTPUT");
	expect(result.output).toContain('"rc": 0');
	expect(result.output).not.toContain('"phase": "error"');
	console.error("SDKPTY22_MUTANT_KILLED: actual post-stop bytes lost the same PTY consumer");
}, fixtureDeadlineS(90) * 1000);
