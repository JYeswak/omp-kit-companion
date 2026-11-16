import { beforeAll, expect, test } from "bun:test";
import { ensureOmpSource } from "../../src/omp-source-cache.ts";
import { observeOmpLauncherVersion, resolveSeatOmp } from "../../src/paths.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// SDKLIFECYCLE2181: the real dynamic SDK and its globals execute only in this isolated JS child.
const nativeScript = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.LIFECYCLE_ROOT;
const kit = process.env.LIFECYCLE_KIT;
const sdk = process.env.LIFECYCLE_SDK;
const variant = process.env.LIFECYCLE_VARIANT ?? 'healthy';
const paused = process.env.LIFECYCLE_PAUSED === '1';
assert(root && kit && sdk);
const home = join(root, 'home');
const cwd = join(root, 'workspace');
for (const path of [home, cwd, join(root, 'tmp'), join(root, 'agent'), join(root, 'sessions')]) mkdirSync(path, { recursive: true });
const path = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: path, HOME: home, TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', TERM: 'dumb', PI_NO_TITLE: '1' });
process.chdir(cwd);
const load = async spec => import(pathToFileURL(Bun.resolveSync(spec, sdk)).href);
const { AuthStorage, ModelRegistry, SessionManager, Settings, SqliteAuthCredentialStore, createAgentSession } = await load('@oh-my-pi/pi-coding-agent');
const { AssistantMessageEventStream } = await load('@oh-my-pi/pi-ai');
const { getBundledModel } = await load('@oh-my-pi/pi-catalog/models');
const { initializeExtensions } = await load('@oh-my-pi/pi-coding-agent/modes/runtime-init');
const { AsyncJobManager } = await import(pathToFileURL(join(sdk, 'src/async/job-manager.ts')).href);
const model = getBundledModel('openai', 'gpt-4o-mini');
const state = { root, kit, home, cwd, variant, callbacks: [], ends: [], reads: [], contexts: [], toolExecutions: 0, providerHeld: Promise.withResolvers(), responseRelease: Promise.withResolvers(), paused: Promise.withResolvers(), terminal: Promise.withResolvers() };
Reflect.set(globalThis, Symbol.for('omp-kit.sdk-lifecycle.control'), state);
const wrapper = join(root, 'extension.ts');
writeFileSync(wrapper, \`
import inbox, { cursorPath } from \${JSON.stringify(join(kit, 'extensions/kit-inbox-wake.ts'))};
import composer from \${JSON.stringify(join(kit, 'extensions/kit-composer-state.ts'))};
import keepalive from \${JSON.stringify(join(kit, 'extensions/kit-goal-keepalive.ts'))};
import activity from \${JSON.stringify(join(kit, 'extensions/kit-model-activity.ts'))};
import guard from \${JSON.stringify(join(kit, 'extensions/kit-agent-mail-guard.ts'))};
import callback, { dispatchAgentCallback } from \${JSON.stringify(join(kit, 'extensions/kit-callback.ts'))};
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type } from \${JSON.stringify(Bun.resolveSync('@oh-my-pi/omptype', sdk))};
export default async function lifecycle(pi) {
 const s = Reflect.get(globalThis, Symbol.for('omp-kit.sdk-lifecycle.control'));
 const env = { AGENT_NAME: 'SdkLifecycle', AGENT_MAIL_PROJECT: s.cwd };
 const cursor = cursorPath(s.home, env.AGENT_NAME, s.cwd);
 mkdirSync(dirname(cursor), { recursive: true });
 writeFileSync(cursor, JSON.stringify({ schema: 1, cursor: 0, delivered: [] }));
 await composer(pi, { home: s.home, env });
 await activity(pi, { stateRoot: s.root + '/activity', env });
 await keepalive(pi, { env, cwd: s.cwd });
 await guard(pi, { home: s.home, env });
 callback(pi);
 pi.on('agent_end', async event => {
  const e = s.variant === 'terminal-mutant' ? { ...event, willContinue: false } : event;
  await dispatchAgentCallback(e, { home: s.home, pane: 'owned-worker', agent: env.AGENT_NAME,
   readConfig: () => ({ sessions: [{ workerPanes: ['owned-worker'], coordinatorPane: 'owned-owner', coordinatorSession: 'fixture' }] }),
   send: (_session, _pane, text) => { s.callbacks.push(text); } });
 });
 const read = async (_agent, _project, after) => {
  s.reads.push(after);
  if (s.reads.length === 1) return { events: [{ cursor: 1, message_id: 101, kind: 'to', subject: 'QUESTION first', from: 'FixtureSender' }], next_cursor: 1, tail_cursor: 3 };
  if (s.reads.length === 2) {
   await s.providerHeld.promise;
   return { events: [{ cursor: 2, message_id: 101, kind: 'to', subject: 'QUESTION duplicate', from: 'FixtureSender' }, { cursor: 3, message_id: 102, kind: 'to', subject: 'QUESTION second', from: 'FixtureSender' }], next_cursor: 3, tail_cursor: 3 };
  }
  return { events: [], next_cursor: after, tail_cursor: after };
 };
 // Two real instances share the on-disk cursor, as a reload does; transport alone is controlled.
 for (let n = 0; n < 2; n++) await inbox(pi, { home: s.home, env, policyOn: async () => true, read });
 pi.registerTool({ name: 'mcp__mcp_agent_mail_fetch_inbox_product', label: 'owned forbidden bulk read', description: 'Must be refused before execution', parameters: type({}),
  async execute() { s.toolExecutions++; throw new Error('guard allowed an irreversible bulk read'); } });
 pi.on('agent_end', event => {
  s.ends.push({ willContinue: event.willContinue === true, awaiting: event.awaitingAsyncWork === true });
  if (event.awaitingAsyncWork) s.paused.resolve();
  if (!event.willContinue) s.terminal.resolve();
 });
}
\`);
const marker = join(cwd, '.omp');
mkdirSync(marker, { recursive: true });
writeFileSync(join(marker, 'fleet.json'), JSON.stringify({ enabled: true }));
const authStore = await SqliteAuthCredentialStore.open(join(root, 'agent/auth.sqlite'));
const authStorage = new AuthStorage(authStore);
authStorage.keys.setRuntime('openai', 'fixture-only-not-a-credential');
const settings = await Settings.loadIsolated({ cwd, agentDir: join(root, 'agent'), inMemory: true });
const modelRegistry = new ModelRegistry(authStorage, join(root, 'agent/models.yml'), { settings, cacheDbPath: join(root, 'agent/models.sqlite'), fetch: async () => { throw new Error('offline lifecycle control forbids network'); } });
let session;
const jobRelease = Promise.withResolvers();
const errors = [];
let initialized;
try {
 const created = await createAgentSession({ cwd, agentDir: join(root, 'agent'), settings, authStorage, modelRegistry, model, sessionManager: SessionManager.create(cwd, join(root, 'sessions')), disableExtensionDiscovery: true, additionalExtensionPaths: [wrapper], preloadedCustomToolPaths: [], noContextFiles: true, contextFiles: [], skills: [], rules: [], enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, cacheWarming: false, deferRetryFallbackValidation: true, disableModelFallback: true, bindProcessState: false, toolNames: [], titleSystemPrompt: '' });
 session = created.session;
 assert.deepEqual(created.extensionsResult.errors, [], 'actual SDK loader failed');
 assert(session.extensionRunner, 'actual SDK runner absent');
 // Match a restored fleet session: its journal already exists before native lifecycle observers run.
 await session.sessionManager.ensureOnDisk();
 await session.sessionManager.flush();
 const goal = paused ? { enabled: false, mode: 'active', goal: { id: 'owned-paused', objective: 'Do not resume', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: Date.now(), updatedAt: Date.now() } } : undefined;
 session.setGoalModeState(goal);
 const goalBefore = JSON.stringify(session.getGoalModeState());
 const nativeEvents = [];
 const nativePause = Promise.withResolvers();
 session.subscribe(event => { if (event.type === 'agent_pause' || event.type === 'agent_end') nativeEvents.push(event.type); if (event.type === 'agent_pause') nativePause.resolve(); });
 session.agent.setFollowUpMode('all');
 session.agent.setInterruptMode('wait');
 session.agent.streamFn = async (m, context, options = {}) => {
  const ordinal = state.contexts.length + 1;
  state.contexts.push(context.messages);
  await options.onPayload({ fixture: 'sdk-lifecycle', ordinal }, m, options.signal);
  if (ordinal === 1) { state.providerHeld.resolve(); await state.responseRelease.promise; }
  await options.onResponse({ status: 200, headers: {}, requestId: String(ordinal) }, m, options.signal);
  const tool = ordinal === 1;
  const content = tool ? [{ type: 'toolCall', id: 'owned-bulk-read', name: 'mcp__mcp_agent_mail_fetch_inbox_product', arguments: {} }] : [{ type: 'text', text: 'DONE owned lifecycle control' }];
  const message = { role: 'assistant', content, api: m.api, provider: m.provider, model: m.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
 };
 await session.setActiveToolsByName(['mcp__mcp_agent_mail_fetch_inbox_product']);
 const manager = AsyncJobManager.instance();
 assert(manager, 'native root job manager absent');
 const ownerId = session.extensionRunner.createContext().agent.id;
 const jobId = manager.register('eval', 'owned lifecycle pause', async () => await jobRelease.promise, { ownerId });
 const queued = Promise.withResolvers();
 const unsubscribe = session.agent.onQueueChange(() => { if (session.agent.peekFollowUpQueue().some(message => message.customType === 'kit-inbox-wake' && message.content.includes('#102'))) queued.resolve(); });
 initialized = initializeExtensions(session, { mode: 'tui', uiContext: { ...session.extensionRunner.getUIContext(), getEditorText: () => 'owned unsent draft' }, reportRuntimeError: error => errors.push(error), reportSendError: (action, error) => errors.push({ action, message: error.message }) });
 await state.providerHeld.promise;
 await queued.promise;
 assert.equal(session.isStreaming, true, 'wake did not queue while native provider was busy');
 state.responseRelease.resolve();
 await initialized;
 await Promise.all([nativePause.promise, state.paused.promise]);
 assert.equal(session.isRunActive, true, 'pending native job lost its active run');
 assert(!nativeEvents.includes('agent_end'), 'native run ended before its pending job');
 assert.equal(state.callbacks.length, 0, 'SDKLIFECYCLE2181_FALSE_TERMINAL_CALLBACK: pause dispatched a completed-worker callback');
 const { composerRecordPath } = await import(pathToFileURL(join(kit, 'extensions/kit-composer-state.ts')).href);
 const composer = JSON.parse(readFileSync(composerRecordPath(home, session.sessionFile), 'utf8'));
 assert.equal(composer.empty, false, 'native pause erased the unsent draft');
 assert.equal(composer.chars, 'owned unsent draft'.length, 'native composer lost draft identity');
 assert.equal(session.extensionRunner.getUIContext().getEditorText(), 'owned unsent draft');
 assert.equal(JSON.stringify(session.getGoalModeState()), goalBefore, 'native pause resumed or created a goal');
 assert.equal(state.toolExecutions, 0, 'native SDK bypassed the Kit bulk-read guard');
 const toolResults = session.agent.state.messages.filter(message => message.role === 'toolResult');
 assert(toolResults.some(message => JSON.stringify(message.content).includes('AM_BULK_READ')), 'native guarded tool result did not reach the model context');
 const wakes = session.agent.state.messages.filter(message => message.role === 'custom' && message.customType === 'kit-inbox-wake');
 assert.equal(wakes.length, 2, 'native queued wakes lost delivery or duplicated a source message');
 assert.equal(wakes.filter(message => message.content.includes('#101')).length, 1);
 assert.equal(wakes.filter(message => message.content.includes('#102')).length, 1);
 const ledger = readFileSync(join(home, '.local/state/omp-kit/mail-wake.jsonl'), 'utf8').trim().split('\\n').map(JSON.parse);
 assert.deepEqual(ledger.map(row => row.message_id), [101, 102], 'wake cursor dedup changed across native callbacks');
 jobRelease.resolve('OWNED_NATIVE_JOB_COMPLETED');
 await manager.getJob(jobId).promise;
 await manager.drainDeliveries();
 await session.waitForRunEnd();
 await state.terminal.promise;
 assert.equal(session.isRunActive, false);
 assert.equal(nativeEvents.filter(event => event === 'agent_end').length, 1);
 assert.equal(state.callbacks.length, 1, 'native terminal completion did not dispatch exactly once');
 assert.equal(JSON.stringify(session.getGoalModeState()), goalBefore, 'completion resumed an owner-paused or goal-less mode');
 const { readActivityJournal } = await import(pathToFileURL(join(kit, 'src/model-activity-journal.ts')).href);
 const journal = readActivityJournal(join(root, 'activity'));
 const opens = journal.records.filter(row => row.kind === 'open');
 const settled = journal.records.filter(row => row.kind === 'settle');
 assert.equal(journal.complete, true, 'native activity journal became incomplete');
 assert(settled.length > 0 && settled.every(row => row.reason === null && row.model?.provider === model.provider && row.model?.model === model.id), \`native lifecycle lost primary model attribution: \${JSON.stringify(settled.map(row => ({ reason: row.reason, model: row.model, modelsSeen: row.models_seen })))}\`);
 assert.deepEqual(opens.map(row => row.identity.segment_id), settled.map(row => row.identity.segment_id), 'native lifecycle lost or duplicated a turn settlement');
 assert.deepEqual(errors, [], 'native SDK runtime/send failed');
 unsubscribe();
 console.log('SDKLIFECYCLE_RESULT', JSON.stringify({ variant, paused, nativeEvents, extensionEnds: state.ends, reads: state.reads, callbacks: state.callbacks.length, messages: wakes.length, activityEvents: journal.records.length, sdk: realpathSync(sdk), sdkVersion: JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version, sdkSha256: createHash('sha256').update(readFileSync(join(sdk, 'src/session/agent-session.ts'))).digest('hex') }));
} finally {
 state.responseRelease.resolve();
 jobRelease.resolve('OWNED_CLEANUP');
 if (session) { await session.abort(); await session.dispose(); }
 await authStorage.close();
}
`;

const kitRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let sdkRoot: string;
beforeAll(() => {
	// This case targets the reviewed 18.21 boundary even on a minimum-version CI lane.
	// Reuse the stock verified-source cache; never alter the installed OMP or profiles.
	sdkRoot = ensureOmpSource("18.21.0", process.env);
	const seat = resolveSeatOmp();
	console.error("SDKLIFECYCLE_IDENTITY", JSON.stringify({
		launcher: seat?.launcher ?? null,
		launcherVersion: seat ? observeOmpLauncherVersion(seat.launcher, process.env) : null,
		sdk: sdkRoot,
		sdkVersion: JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version,
	}));
});

async function runNativeCase(variant: "healthy" | "terminal-mutant", paused: boolean) {
	const scratch = ownedTmp("sdk-lifecycle-native");
	try {
		const script = join(scratch.path, "control.mjs");
		writeFileSync(script, nativeScript);
		const result = await runFixtureAsync([process.execPath, "--no-env-file", script], {
			cwd: scratch.path,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: scratch.path,
				TMPDIR: scratch.path,
				TMP: scratch.path,
				TEMP: scratch.path,
				KITLIB_TMP_ROOT: scratch.path,
				LIFECYCLE_ROOT: scratch.path,
				LIFECYCLE_KIT: kitRoot,
				LIFECYCLE_SDK: sdkRoot,
				LIFECYCLE_VARIANT: variant,
				LIFECYCLE_PAUSED: paused ? "1" : "0",
			},
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.timed_out).toBe(false);
		expect(result.killed).toBe(false);
		expect(result.truncated || result.total_truncated).toBe(false);
		return { rc: result.rc, output };
	} finally {
		scratch.cleanup();
	}
}

for (const paused of [false, true]) {
	test(`SDKLIFECYCLE2181 native SDK healthy ${paused ? "owner-paused" : "goal-less"} consumer control`, async () => {
		const result = await runNativeCase("healthy", paused);
		expect(result.rc, result.output).toBe(0);
		expect(result.output).toContain("SDKLIFECYCLE_RESULT");
		console.error(result.output);
	}, fixtureDeadlineS(90) * 1000);
}

test("SDKLIFECYCLE2181 terminal-misclassified native boundary fails the same callback consumer", async () => {
	const result = await runNativeCase("terminal-mutant", false);
	expect(result.rc).toBe(1);
	expect(result.output).toContain("SDKLIFECYCLE2181_FALSE_TERMINAL_CALLBACK");
	expect(result.output).not.toContain("actual SDK loader failed");
	console.error("SDKLIFECYCLE_MUTANT_KILLED: native pause dispatched a false completion");
}, fixtureDeadlineS(90) * 1000);
