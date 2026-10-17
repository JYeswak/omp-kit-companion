import { readFileSync, writeFileSync, lstatSync, openSync, closeSync, constants, fstatSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATALOG, MEMBERS, TernError, record } from './model.ts';
import type { Context } from './model.ts';
import { TERN_COMMAND } from './registry.ts';
import type { Parsed } from './registry.ts';
import routes from '../../scripts/tern-script-routes.json';
import { bindingModule, compileProgram, emitCall, memberAllowedInContext } from './luau.ts';
import { verifySdk, docsReport } from './coverage.ts';
import { executeProgram } from './api.ts';
import { control, nativeProcess, parseNativeResult, validateLine } from './transport.ts';
import { startReceipt, digest } from './receipts.ts';
import { encodeMessage, encodeBlob, WireDecoder, WIRE_VERBS, FRAME_OPS } from './surface.ts';
export type ExitCode = 0 | 1 | 2 | 3 | 4;
export interface CommandResult {
    code: ExitCode;
    data: Record<string, unknown>;
    errors?: {
        code: string;
        message: string;
        remediation: string;
    }[];
    verification: 'PERFORMED' | 'UNVERIFIED';
}
export interface Environment {
    receiptRoot?: string;
}
const CONTEXTS: Context[] = ['host', 'window', 'carly', 'host-effect', 'host-block', 'host-lens'];
function readBounded(path: string, max = 4 * 1024 * 1024): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const s = fstatSync(fd);
        if (!s.isFile() || s.size > max)
            throw new TernError('INVALID_INPUT_FILE', 'Input must be a bounded regular file, not a symlink');
        const b = Buffer.alloc(s.size + 1);
        let n = 0;
        while (n < b.length) {
            const got = readFileSyncChunk(fd, b, n, b.length - n, null);
            if (!got)
                break;
            n += got;
        }
        if (n > s.size || n > max)
            throw new TernError('INPUT_CHANGED', 'Input grew during the read');
        return b.subarray(0, n);
    }
    finally {
        closeSync(fd);
    }
}
import { readSync as readFileSyncChunk } from 'node:fs';
function json(text: string): unknown { try {
    return JSON.parse(text);
}
catch {
    throw new TernError('INVALID_JSON', 'Input is not valid JSON');
} }
function str(p: Parsed, name: string, otherwise?: string): string {
    const v = p.flags[name] ?? otherwise;
    if (typeof v !== 'string' || !v)
        throw new TernError('MISSING_ARGUMENT', `${name} requires a value`);
    return v;
}
function integer(p: Parsed, name: string, defaultValue: number): number {
    const n = Number(p.flags[name] ?? defaultValue);
    if (!Number.isSafeInteger(n) || n < 1 || n > 600000)
        throw new TernError('INVALID_LIMIT', `${name} must be an integer from 1 to 600000`);
    return n;
}
function ok(data: Record<string, unknown>, code: ExitCode = 0): CommandResult { return { code, data, verification: 'UNVERIFIED' }; }
function planned(p: Parsed, details: Record<string, unknown>): CommandResult | null {
    if (!p.flags['--apply'])
        return ok({ status: 'PLAN', ...details, execution: 'NOT_RUN', confirmation: '--apply --yes', undo: 'Native effects are not generally reversible; no automatic omp-kit undo is claimed.' });
    if (!p.flags['--yes'])
        throw new TernError('CONSENT_REQUIRED', 'Effects require both --apply and --yes');
    return null;
}
async function effect(p: Parsed, env: Environment, details: Record<string, unknown>, run: () => Promise<Record<string, unknown>>): Promise<CommandResult> {
    const plan = planned(p, details);
    if (plan)
        return plan;
    // No raw arguments, source, transcripts, secrets or results enter the audit journal.
    const r = startReceipt({ command: p.command, flags: p.flags, ...details }, env.receiptRoot);
    try {
        const data = await run();
        r.finish('NATIVE_RETURNED', { status: data.status });
        return ok({ ...data, receipt_id: r.id, receipt_path: r.path, undo: 'NOT_AUTOMATIC' });
    }
    catch (e) {
        const err = e instanceof TernError ? e : new TernError('OUTCOME_UNKNOWN', e instanceof Error ? e.message : 'Operation failed', 4);
        try {
            r.finish(err.exit === 4 ? 'OUTCOME_UNKNOWN' : 'FAILED', { code: err.code });
        }
        catch { /* Do not replace the original failure after a possible native effect. */ }
        err.details = { receipt_id: r.id, receipt_path: r.path, detail: err.details };
        throw err;
    }
}
function fileOut(p: Parsed, text: string, data: Record<string, unknown>): CommandResult {
    const out = p.flags['--out'];
    if (out === undefined)
        return ok({ ...data, text });
    const path = typeof out === 'string' ? resolve(out) : '';
    const plan = planned(p, { operation: 'CREATE_FILE', path, bytes: Buffer.byteLength(text), sha256: digest(text) });
    if (plan)
        return plan;
    // Exclusive creation, not a rewrite of a user's existing configuration or source file.
    try {
        writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    }
    catch (e) {
        throw new TernError('OUTPUT_NOT_CREATED', `Output not created: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    return ok({ ...data, path, bytes: Buffer.byteLength(text), sha256: digest(text) });
}
export function nativeArgv(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 1024 || value.some(x => typeof x !== 'string' || x.includes('\0')))
        throw new TernError('INVALID_ARGV', '--argv must be 1..1024 strings');
    const args = value as string[];
    // Keep native grammar after the verb. Global selector only; no shell, arbitrary executable or silent default install.
    let i = 0;
    if (args[i] === '--window') {
        if (!args[i + 1])
            throw new TernError('INVALID_ARGV', '--window needs its native window key');
        i += 2;
    }
    const root = args[i];
    if (!['plugin', 'shot', 'serve', 'ctl', 'browser', 'help', '--control', '--help', '--version'].includes(root ?? ''))
        throw new TernError('UNKNOWN_NATIVE_ROUTE', 'Use a documented native Tern CLI family');
    if (root === 'plugin' && !['list', 'reload', 'dir', 'install', 'remove', 'link', 'unlink', 'types', '--help'].includes(args[i + 1] ?? ''))
        throw new TernError('UNKNOWN_NATIVE_ROUTE', 'Unknown native plugin verb; audit the changed SDK before adding it');
    return args;
}
function scriptLines(text: string): string[] {
    const result = text.split(/\r?\n/).filter(s => s.trim() && !s.trimStart().startsWith('#'));
    result.forEach(validateLine);
    if (!result.length)
        throw new TernError('EMPTY_SCENARIO', 'Scenario contains no commands');
    return result;
}
function validateRequest(p: Parsed): void {
    const spec = TERN_COMMAND.subcommands.find(command => command.name === p.command);
    if (!spec)
        throw new TernError('UNKNOWN_COMMAND', p.command);
    for (const key in p.flags) {
        if (!Object.hasOwn(p.flags, key))
            continue;
        const flag = spec.flags.find(candidate => candidate.name === key);
        const outputFlag = key === '--json' || key === '--robot';
        if (!flag && !outputFlag)
            throw new TernError('UNKNOWN_FLAG', `Unknown ${p.command} flag ${key}`);
        const value = p.flags[key];
        if (value === false)
            continue;
        if (flag?.value ? typeof value !== 'string' : value !== true)
            throw new TernError('INVALID_FLAG_VALUE', `${key} ${flag?.value ? 'requires a string value' : 'does not take a value'}`);
    }
    if (p.flags['--yes'] && !p.flags['--apply'])
        throw new TernError('INVALID_CONFIRMATION', '--yes requires --apply');
    if (p.flags['--plan'] && p.flags['--apply'])
        throw new TernError('INVALID_CONFIRMATION', '--plan and --apply are mutually exclusive');
    const operation = p.flags['--operation'];
    if ((p.command === 'sdk' && operation === 'check' || p.command === 'surface' && operation === 'decode') && p.flags['--out'])
        throw new TernError('UNUSED_OUTPUT', `${p.command} ${operation} does not create an output file`);
    if ((p.command === 'sdk' || p.command === 'surface') && !p.flags['--out'] && (p.flags['--apply'] || p.flags['--plan'] || p.flags['--yes']))
        throw new TernError('UNUSED_CONFIRMATION', 'Confirmation flags require an explicit --out for generated output');
    if (p.command === 'coverage' && p.flags['--docs-baseline'] && !p.flags['--docs-report'])
        throw new TernError('MISSING_DOCS_REPORT', '--docs-baseline requires --docs-report');
}
async function execute(p: Parsed, env: Environment): Promise<CommandResult> {
    if (p.command === 'catalog') {
        const filter = String(p.flags['--filter'] ?? '').toLowerCase();
        const rows = MEMBERS.filter(m => m.symbol.toLowerCase().includes(filter)).map(m => ({ ...m, available_contexts: CONTEXTS.filter(context => memberAllowedInContext(m, context)) }));
        return ok({ status: 'SOURCE_INVENTORY', sdk_commit: CATALOG.sdk_commit, kit_base: CATALOG.kit_base, callables: MEMBERS.filter(m => m.kind !== 'callback').length,
            callback_slots: MEMBERS.filter(m => m.kind === 'callback').length, rows, events: CATALOG.events, native: routes, wire_verbs: WIRE_VERBS, frame_operations: FRAME_OPS,
            source_byte_check: 'NOT_RUN_HERE', native_runtime_verification: 'NOT_RUN', known_deltas: CATALOG.known_deltas });
    }
    if (p.command === 'doctor') {
        const checks: Record<string, unknown>[] = [];
        const binary = str(p, '--binary', 'tern');
        const timeoutMs = integer(p, '--timeout-ms', 5000);
        try {
            const r = await nativeProcess(binary, ['--version'], timeoutMs);
            checks.push({ name: 'native_binary', ...parseNativeResult(r), proof: 'VERSION_ONLY' });
        }
        catch (e) {
            if (e instanceof TernError && e.exit === 2) throw e;
            checks.push({ name: 'native_binary', status: 'UNAVAILABLE', code: e instanceof TernError ? e.code : 'ERROR' });
        }
        if (p.flags['--endpoint'])
            try {
                const r = await control(['state'], { endpoint: str(p, '--endpoint'), timeoutMs });
                checks.push({ name: 'endpoint', status: 'CONNECTED', proof: 'ONE_STATE_REPLY', reply_count: r.replies.length });
            }
            catch (e) {
                if (e instanceof TernError && e.exit === 2) throw e;
                checks.push({ name: 'endpoint', status: 'UNAVAILABLE', code: e instanceof TernError ? e.code : 'ERROR' });
            }
        else
            checks.push({ name: 'endpoint', status: 'NOT_RUN' });
        const unavailable = checks.some(c => c.status === 'UNAVAILABLE');
        return ok({ status: unavailable ? 'UNAVAILABLE' : 'OBSERVED', checks, native_sdk_members: 'UNVERIFIED', plugin_loading: 'UNVERIFIED' }, unavailable ? 3 : 0);
    }
    if (p.command === 'ctl' || p.command === 'script') {
        const lines = p.command === 'ctl' ? [str(p, '--line')] : scriptLines(readBounded(str(p, '--file')).toString('utf8'));
        lines.forEach(validateLine);
        const endpoint = str(p, '--endpoint');
        return effect(p, env, { operation: 'NATIVE_CONTROL', endpoint, commands: lines.length, request_sha256: digest(JSON.stringify(lines)) }, async () => {
            const r = await control(lines, { endpoint, timeoutMs: integer(p, '--timeout-ms', 25000) });
            return { status: 'ACKNOWLEDGED', ...r, effects: 'NOT_INDEPENDENTLY_VERIFIED', warning: 'ok=true may acknowledge a dialog, simulated state, or still-running work. Check the relevant native result.' };
        });
    }
    if (p.command === 'native') {
        const argv = nativeArgv(json(str(p, '--argv'))), binary = str(p, '--binary', 'tern');
        return effect(p, env, { operation: 'NATIVE_CLI', binary, argv_sha256: digest(JSON.stringify(argv)), argument_count: argv.length }, async () => {
            const r = await nativeProcess(binary, argv, integer(p, '--timeout-ms', 65000));
            return { ...parseNativeResult(r), effects: 'NOT_INDEPENDENTLY_VERIFIED', plugin_loading: 'UNVERIFIED' };
        });
    }
    if (p.command === 'api') {
        if (p.flags['--file'] && (p.flags['--member'] || p.flags['--args']))
            throw new TernError('CONFLICTING_INPUT', 'Choose --file or --member/--args');
        const program = p.flags['--file'] ? json(readBounded(str(p, '--file')).toString('utf8')) : { context: 'carly', steps: [{ id: 'result', member: str(p, '--member'), args: json(str(p, '--args', '[]')) }] };
        const compiled = compileProgram(program, '0'.repeat(32));
        const endpoint = str(p, '--endpoint');
        return effect(p, env, { operation: 'CARLY_NATIVE_LUA', endpoint, symbols: compiled.symbols, program_sha256: digest(JSON.stringify(program)), read_only_members: compiled.readOnly }, async () => executeProgram(program, { endpoint, timeoutMs: integer(p, '--timeout-ms', 25000) }) as Promise<Record<string, unknown>>);
    }
    if (p.command === 'sdk') {
        const operation = str(p, '--operation', 'module');
        if (operation === 'check') {
            const report = verifySdk(readBounded(str(p, '--file')));
            return ok(report, report.status === 'PASS' ? 0 : 1);
        }
        const context = str(p, '--context', 'window') as Context;
        if (!CONTEXTS.includes(context))
            throw new TernError('WRONG_CONTEXT', 'Unknown native Luau context');
        if (operation === 'module')
            return fileOut(p, bindingModule(context), { status: 'GENERATED', context, proof: 'LAZY_NATIVE_FORWARDING', runtime_verified: false });
        if (operation === 'emit') {
            const symbol = str(p, '--member');
            const source = p.flags['--file'] ? readBounded(str(p, '--file')).toString('utf8') : '';
            return fileOut(p, emitCall(symbol, context, source, str(p, '--receiver', 'receiver')), { status: 'GENERATED', context, member: symbol, proof: 'NATIVE_SOURCE_EMITTED', runtime_verified: false });
        }
        throw new TernError('UNKNOWN_OPERATION', 'sdk operation is module, emit, or check');
    }
    if (p.command === 'coverage') {
        if (!p.flags['--types'] && !p.flags['--docs-report'])
            return ok({ status: 'NOT_RUN', reason: 'Provide --types from tern plugin types and/or --docs-report from the independent crawler', mapped_callables: MEMBERS.filter(m => m.kind !== 'callback').length, live_verified: 0 }, 3);
        const sdk = p.flags['--types'] ? verifySdk(readBounded(str(p, '--types'))) : null;
        const baseline = p.flags['--docs-baseline'] ? json(readBounded(str(p, '--docs-baseline'), 16 * 1024 * 1024).toString('utf8')) : undefined;
        const docs = p.flags['--docs-report'] ? docsReport(json(readBounded(str(p, '--docs-report'), 16 * 1024 * 1024).toString('utf8')), baseline) : null;
        const bad = sdk?.status === 'FAIL' || docs?.status === 'FAIL';
        const unreviewed = docs !== null && docs.source_lock !== 'MATCH';
        return ok({ status: bad ? 'FAIL' : sdk ? 'DECLARATIONS_MATCHED' : 'DOCS_INVENTORIED', sdk, docs, native_runtime: 'NOT_RUN', all_options_semantically_verified: false }, bad ? 1 : unreviewed ? 3 : 0);
    }
    if (p.command === 'surface') {
        const operation = str(p, '--operation'), bytes = readBounded(str(p, '--file'), 24 * 1024 * 1024);
        let wire: Buffer;
        if (operation === 'decode') {
            const decoder = new WireDecoder();
            const parts = decoder.feed(bytes);
            decoder.end();
            return ok({ status: 'DECODED', parts: parts.map(v => v.type === 'bytes' ? { type: 'bytes', base64: v.bytes!.toString('base64') } : v), proof: 'OFFLINE_CODEC_ONLY' });
        }
        const apc = integer(p, '--apc', 65536);
        if (operation === 'encode')
            wire = encodeMessage(json(bytes.toString('utf8')) as Parameters<typeof encodeMessage>[0], apc);
        else if (operation === 'blob')
            wire = encodeBlob(bytes, str(p, '--mime', 'application/octet-stream'), apc);
        else
            throw new TernError('UNKNOWN_OPERATION', 'surface operation is encode, decode, or blob');
        if (p.flags['--out']) {
            const path = resolve(str(p, '--out'));
            const plan = planned(p, { operation: 'CREATE_WIRE_FILE', path, bytes: wire.length, sha256: digest(wire) });
            if (plan)
                return plan;
            writeFileSync(path, wire, { flag: 'wx', mode: 0o600 });
            return ok({ status: 'ENCODED', path, bytes: wire.length, proof: 'OFFLINE_CODEC_ONLY' });
        }
        return ok({ status: 'ENCODED', wire_base64: wire.toString('base64'), bytes: wire.length, proof: 'OFFLINE_CODEC_ONLY' });
    }
    if (p.command === 'render') {
        const path = resolve(str(p, '--sdk')), operation = str(p, '--operation', 'plain');
        if (!['plain', 'print', 'ask'].includes(operation))
            throw new TernError('UNKNOWN_OPERATION', 'render operation is plain, print, or ask');
        const node = json(readBounded(str(p, '--file')).toString('utf8')), options = json(str(p, '--options', '{}'));
        if (!record(options))
            throw new TernError('INVALID_OPTIONS', 'Native helper options must be an object');
        const s = lstatSync(path);
        if (!s.isFile() || s.isSymbolicLink())
            throw new TernError('INVALID_SDK_MODULE', '--sdk must be a trusted regular entry module');
        if (operation !== 'plain' && (p.flags['--json'] || p.flags['--robot']))
            throw new TernError('MIXED_OUTPUT_REFUSED', 'Interactive TSP owns the terminal. Use plain with --json, or print/ask without --json/--robot.');
        return effect(p, env, { operation: 'TRUSTED_NATIVE_SDK_IMPORT', entry: path, helper: operation, entry_sha256: digest(readBounded(path)) }, async () => {
            const sdk = await import(pathToFileURL(path).href);
            if (typeof sdk.fromJson !== 'function' || typeof sdk[operation] !== 'function')
                throw new TernError('SDK_EXPORT_MISSING', 'Native SDK needs fromJson and the selected helper');
            const view = sdk.fromJson(node);
            const value = operation === 'plain' ? sdk.plain(view) : await sdk[operation](view, options);
            return { status: 'NATIVE_HELPER_RETURNED', value: value ?? null, rendering: 'NATIVE_OR_PLAIN_FALLBACK', not_proven: 'No independent Tern display/effect observation; the SDK owns negotiation and cleanup.' };
        });
    }
    throw new TernError('UNKNOWN_COMMAND', p.command);
}
export async function runTern(input: Parsed, env: Environment = {}): Promise<CommandResult> {
    try {
        validateRequest(input);
        return await execute(input, env);
    }
    catch (e) {
        const err = e instanceof TernError ? e : new TernError('INVALID_REQUEST', e instanceof Error ? e.message : String(e));
        const exit: ExitCode = ([1, 2, 3, 4].includes(err.exit) ? err.exit : 4) as ExitCode;
        return { code: exit, data: { status: err.exit === 4 ? 'OUTCOME_UNKNOWN' : err.exit === 3 ? 'UNAVAILABLE' : 'REFUSED', details: err.details }, errors: [{ code: err.code, message: err.message, remediation: err.exit === 4 ? 'Inspect native state before retrying; effects may already have happened.' : 'Correct the input or make the explicitly selected native dependency available.' }], verification: 'UNVERIFIED' };
    }
}
