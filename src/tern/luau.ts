import { MEMBERS, member, record, exactKeys, TernError } from './model.ts';
import type { Context, Member } from './model.ts';
/** A source string, not an eval escape: every UTF-8 byte is represented as a decimal escape. */
export function luaString(text: string): string {
    return '"' + [...Buffer.from(text, 'utf8')].map(b => '\\' + String(b).padStart(3, '0')).join('') + '"';
}
export function luaValue(value: unknown, depth = 0): string {
    if (depth > 64)
        throw new TernError('VALUE_TOO_DEEP', 'Luau arguments exceed depth 64');
    if (value === null)
        return 'tern.json.null';
    if (typeof value === 'string')
        return luaString(value);
    if (typeof value === 'boolean')
        return String(value);
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (Number.isInteger(value) && !Number.isSafeInteger(value))
            throw new TernError('UNSAFE_INTEGER', 'Use native Luau / decimal text for integers outside JSON safe range');
        return Object.is(value, -0) ? '-0.0' : String(value);
    }
    if (Array.isArray(value))
        return `tern.json.array({${value.map(v => luaValue(v, depth + 1)).join(',')}})`;
    if (record(value))
        return '{' + Object.entries(value).map(([k, v]) => `[${luaString(k)}]=${luaValue(v, depth + 1)}`).join(',') + '}';
    throw new TernError('NON_JSON_ARGUMENT', 'Only finite JSON values are accepted');
}
/** Native scope inheritance only; callback slots remain tied to their definition. */
export function memberAllowedInContext(m: Member, ctx: Context): boolean {
    if (m.contexts.includes(ctx))
        return true;
    if (m.kind === 'callback')
        return false;
    const scopedHost = ctx === 'host-block' || ctx === 'host-lens' || ctx === 'host-effect';
    // BlockCx extends EffectCx; LensDef.open/event receive EffectCx too.
    return ((ctx === 'host-block' || ctx === 'host-lens') && m.contexts.includes('host-effect')) ||
        (scopedHost && m.contexts.includes('host'));
}
function target(m: Member, receiver?: string): {
    owner: string;
    field: string;
    self: boolean;
} {
    const fields = m.symbol.split('.');
    const field = fields.pop()!;
    if (m.kind === 'handle') {
        if (!receiver)
            throw new TernError('RECEIVER_REQUIRED', `${m.symbol} requires a same-VM receiver`);
        return { owner: receiver, field, self: true };
    }
    return { owner: (fields.join('.') === 'effect' || fields.join('.') === 'block') ? 'cx' : fields.join('.'), field, self: m.kind === 'method' };
}
export function nativeCall(m: Member, args: string[], receiver?: string): string {
    const t = target(m, receiver);
    // Bracket access permits fields such as `export`; self is never dropped.
    return `${t.owner}[${luaString(t.field)}](${[...(t.self ? [t.owner] : []), ...args].join(',')})`;
}
/** Thin lazy native forwarding. It neither implements SDK behavior nor claims runtime availability. */
export function bindingModule(context: Context): string {
    const lines = ['-- Generated native forwarding module; no cached scoped cx or fake native semantics.', 'local api = {}'];
    for (const m of MEMBERS.filter(x => x.kind !== 'callback' && memberAllowedInContext(x, context))) {
        const t = target(m, m.kind === 'handle' ? 'receiver' : undefined);
        const params = m.kind === 'handle' ? 'receiver, ...' : m.kind === 'method' ? 'cx, ...' : '...';
        lines.push(`api[${luaString(m.symbol)}] = function(${params})`, `  local owner = ${t.owner}`, `  assert(owner ~= nil and type(owner[${luaString(t.field)}]) == "function", ${luaString('Native SDK member unavailable: ' + m.symbol)})`, `  return owner[${luaString(t.field)}](${t.self ? 'owner, ' : ''}...)`, 'end');
    }
    lines.push('return api', '');
    return lines.join('\n');
}
export interface Step {
    id: string;
    member: string;
    args?: unknown[];
    receiver?: unknown;
    capture?: boolean;
}
export interface Program {
    context: 'carly';
    steps: Step[];
}
const handleProducers = new Set(['cx.layout.snapshot', 'cx.agents.get', 'cx.db.open']);
function argument(value: unknown, known: Set<string>, depth = 0): string {
    if (depth > 64)
        throw new TernError('VALUE_TOO_DEEP', 'Argument depth exceeds 64');
    if (record(value) && Object.hasOwn(value, '$ref')) {
        exactKeys(value, ['$ref', 'return', 'path'], 'reference');
        const id = value.$ref;
        const index = value.return ?? 1;
        const path = value.path ?? [];
        if (typeof id !== 'string' || !known.has(id))
            throw new TernError('INVALID_REFERENCE', 'A reference must name an earlier step');
        if (!Number.isSafeInteger(index) || Number(index) < 1 || Number(index) > 64 || !Array.isArray(path) || path.some(p => !(typeof p === 'string' || Number.isSafeInteger(p))))
            throw new TernError('INVALID_REFERENCE', 'Invalid reference return index or path');
        return `results[${luaString(id)}][${index}]` + path.map(p => `[${luaValue(p)}]`).join('');
    }
    if (record(value) && Object.hasOwn(value, '$literal')) {
        exactKeys(value, ['$literal'], 'literal');
        return luaValue(value.$literal);
    }
    if (value === null)
        return 'nil'; // Positional optional argument, not JSON-null userdata.
    if (Array.isArray(value))
        return 'tern.json.array({' + value.map(v => v === null ? 'tern.json.null' : argument(v, known, depth + 1)).join(',') + '})';
    if (record(value))
        return '{' + Object.entries(value).map(([k, v]) => `[${luaString(k)}]=${v === null ? 'tern.json.null' : argument(v, known, depth + 1)}`).join(',') + '}';
    return luaValue(value);
}
export function compileProgram(input: unknown, nonce: string): {
    code: string;
    symbols: string[];
    readOnly: boolean;
} {
    if (!record(input))
        throw new TernError('INVALID_PROGRAM', 'Program must be an object');
    exactKeys(input, ['context', 'steps'], 'program');
    if (input.context !== 'carly' || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 64)
        throw new TernError('INVALID_PROGRAM', 'Use context=carly and 1..64 steps');
    if (!/^[a-f0-9]{32}$/.test(nonce))
        throw new TernError('INVALID_NONCE', 'Expected 128-bit request nonce');
    const known = new Set<string>();
    const symbols: string[] = [];
    const lines = ['local results = {}', 'local outputs = tern.json.array({})',
        'local function pack(...) return {n=select("#", ...), ...} end',
        'local function json_results(p)', '  local a = tern.json.array({})',
        '  for i=1,p.n do if p[i] == nil then a[i] = tern.json.null else a[i] = p[i] end end', '  return a', 'end'];
    let readOnly = true;
    for (const raw of input.steps) {
        if (!record(raw))
            throw new TernError('INVALID_STEP', 'Step must be an object');
        exactKeys(raw, ['id', 'member', 'args', 'receiver', 'capture'], 'step');
        const id = raw.id;
        if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(id) || known.has(id))
            throw new TernError('INVALID_STEP_ID', 'Step IDs must be unique simple names');
        if (typeof raw.member !== 'string')
            throw new TernError('INVALID_STEP', 'Missing member');
        const m = member(raw.member);
        if (!memberAllowedInContext(m, 'carly') || m.kind === 'callback')
            throw new TernError('WRONG_CONTEXT', `${m.symbol} requires native plugin/handler code; use sdk emit or sdk module`);
        // Callback registrations cannot cross JSON. Use a native module/snippet for them.
        if (['tern.timer', 'handle.Awaitable.next', 'tern.carly.on_canvas'].includes(m.symbol))
            throw new TernError('CALLBACK_REQUIRES_LUA', `${m.symbol} requires a Luau function, not JSON`);
        const args = raw.args ?? [];
        if (!Array.isArray(args) || args.length > 32)
            throw new TernError('INVALID_ARGUMENTS', 'args must be an array of at most 32 positional arguments');
        if (raw.capture !== undefined && typeof raw.capture !== 'boolean')
            throw new TernError('INVALID_CAPTURE', 'capture must be boolean');
        if (m.kind === 'handle' && (!record(raw.receiver) || !Object.hasOwn(raw.receiver, '$ref')))
            throw new TernError('RECEIVER_REQUIRED', 'Use a $ref to a same-program handle');
        if (m.kind !== 'handle' && raw.receiver !== undefined)
            throw new TernError('UNEXPECTED_RECEIVER', 'Receiver is only valid for handle methods');
        const expr = nativeCall(m, args.map(x => argument(x, known)), m.kind === 'handle' ? argument(raw.receiver, known) : undefined);
        lines.push(`results[${luaString(id)}] = pack(${m.awaitable ? `await(${expr})` : expr})`);
        const capture = raw.capture ?? !handleProducers.has(m.symbol);
        if (capture && handleProducers.has(m.symbol))
            throw new TernError('OPAQUE_HANDLE_CAPTURE', 'Keep handles within one program; capture a later JSON-safe observation');
        if (capture)
            lines.push(`outputs[#outputs+1] = {id=${luaString(id)}, values=json_results(results[${luaString(id)}])}`);
        known.add(id);
        symbols.push(m.symbol);
        readOnly = readOnly && m.read_only;
    }
    lines.push(`print(${luaString('OMP_KIT_TERN:' + nonce + ':')} .. tern.base64.encode(tern.json.encode(outputs)))`, 'return nil');
    return { code: lines.join('\n'), symbols, readOnly };
}
export function emitCall(symbol: string, context: Context, argumentSource: string, receiver = 'receiver'): string {
    const m = member(symbol);
    if (!memberAllowedInContext(m, context))
        throw new TernError('WRONG_CONTEXT', `${symbol} is unavailable in ${context}`);
    if (m.kind === 'callback') {
        if (!argumentSource.trim())
            throw new TernError('CALLBACK_SOURCE_REQUIRED', 'Provide an actual callback implementation with --file');
        // Callback implementation is provided by the caller, verbatim native Luau source.
        return `-- ${m.declaring_type}.${symbol.split('.').pop()}: attach this function to the native definition.\n${argumentSource}\n`;
    }
    const expr = nativeCall(m, argumentSource.trim() ? [argumentSource] : [], receiver);
    return `-- ${m.source}\n-- Native ${context} scope; keep scoped cx inside its callback.\n${context === 'carly' && m.awaitable ? `return await(${expr})` : `return ${expr}`}\n`;
}
