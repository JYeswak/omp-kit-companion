import { createHash } from 'node:crypto';
import { TernError, record } from './model.ts';
export const WIRE_VERBS = ['q', 'o', 'f', 'b', 't', 's', 'x', 'r', 'e'] as const;
export const FRAME_OPS = ['add', 'set', 'text', 'splice', 'move', 'del', 'settle', 'focus', 'reveal', 'scroll', 'suspend', 'resume'] as const;
const MAX_JOINED = 24 * 1024 * 1024, MAX_BLOB = 16 * 1024 * 1024;
export interface Message {
    verb: string;
    params?: Record<string, string>;
    body: unknown;
}
export interface WireItem {
    type: 'message' | 'bytes';
    message?: Message;
    bytes?: Buffer;
}
const START = Buffer.from('\x1b_tsp;'), OSC = Buffer.from('\x1b]877;tsp;'), ST = Buffer.from('\x1b\\');
function validateJson(value: unknown): void {
    const visit = (v: unknown, depth = 0) => {
        if (depth > 128)
            throw new TernError('TSP_LIMIT', 'JSON depth exceeds 128');
        if (v === null || typeof v === 'string' || typeof v === 'boolean')
            return;
        if (typeof v === 'number' && Number.isFinite(v))
            return;
        if (Array.isArray(v)) {
            v.forEach(x => visit(x, depth + 1));
            return;
        }
        if (record(v)) {
            Object.values(v).forEach(x => visit(x, depth + 1));
            return;
        }
        throw new TernError('TSP_JSON', 'Nonfinite or non-JSON value');
    };
    visit(value);
}
// Framing oracle: stencil-hq/tern-sdk f3f9fee82bf692166c2a477a895a347ac2a47ca2,
// typescript/src/wire.ts leadsWithParameter/chunkEnd; python/src/tern_sdk/wire.py split.
function keyByte(b: number): boolean {
    return b >= 48 && b <= 57 || b >= 65 && b <= 90 || b >= 97 && b <= 122 || b === 95 || b === 45;
}
interface ParameterScan {
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
}
function leadsWithParameter(body: Buffer, at: number, scan: ParameterScan): boolean {
    if (!keyByte(body[at]!))
        return false;
    // Cache whole key runs and printable value spans. Successive chunk targets
    // advance through the body; even a multi-MiB key or value is scanned only once,
    // not once per chunk. No suffix strings or per-byte boundary tables are needed.
    if (at < scan.keyStart || at >= scan.keyEnd) {
        scan.keyStart = at;
        while (scan.keyStart > 0 && keyByte(body[scan.keyStart - 1]!))
            scan.keyStart--;
        scan.keyEnd = at + 1;
        while (scan.keyEnd < body.length && keyByte(body[scan.keyEnd]!))
            scan.keyEnd++;
    }
    if (body[scan.keyEnd] !== 61)
        return false;
    const value = scan.keyEnd + 1;
    if (value < scan.valueStart || value > scan.valueEnd) {
        scan.valueStart = value;
        scan.valueEnd = value;
        while (scan.valueEnd < body.length && body[scan.valueEnd]! >= 33 && body[scan.valueEnd]! <= 126 && body[scan.valueEnd] !== 59)
            scan.valueEnd++;
    }
    return body[scan.valueEnd] === 59;
}
export function validateFrame(value: unknown): void {
    if (!record(value) || typeof value.sf !== 'string' || !value.sf || !Number.isSafeInteger(value.s) || !Array.isArray(value.ops))
        throw new TernError('INVALID_FRAME', 'Expected sf, integer s, and ops array');
    const arity: Record<string, number> = { add: 5, set: 3, text: 4, splice: 5, move: 4, del: 2, settle: 2, focus: 2, reveal: 3, scroll: 3, suspend: 1, resume: 1 };
    for (const [i, op] of value.ops.entries()) {
        if (!Array.isArray(op) || typeof op[0] !== 'string' || !Object.hasOwn(arity, op[0]) || op.length !== arity[op[0]])
            throw new TernError('INVALID_FRAME_OP', `Invalid operation shape at ${i}`);
        if (op[0] === 'add' && (!record(op[4]) || op[4].id !== op[1]))
            throw new TernError('INVALID_FRAME_OP', 'add id must equal node.id');
        if (['add', 'move'].includes(op[0]) && (typeof op[1] !== 'string' || !op[1] || typeof op[2] !== 'string' || !op[2] || !(op[3] === null || typeof op[3] === 'string')))
            throw new TernError('INVALID_FRAME_OP', 'add/move require string ids and a sibling id or null, not an index');
        if (op[0] === 'set' && !record(op[2]))
            throw new TernError('INVALID_FRAME_OP', 'set requires a props object');
        if (op[0] === 'scroll' && !['line-up', 'line-down', 'page-up', 'page-down', 'start', 'end'].includes(op[2]))
            throw new TernError('INVALID_FRAME_OP', 'scroll requires a documented direction');
        if (op[0] === 'text' && (!['append', 'replace'].includes(op[2]) || typeof op[3] !== 'string'))
            throw new TernError('INVALID_FRAME_OP', 'Invalid text operation');
        if (op[0] === 'splice' && (!Number.isSafeInteger(op[2]) || op[2] < 0 || !Number.isSafeInteger(op[3]) || op[3] < 0 || typeof op[4] !== 'string'))
            throw new TernError('INVALID_FRAME_OP', 'Invalid splice operation');
    }
    // Native Tern validates document state, vocabulary, surrogate boundaries and per-op errors.
    // Draw atomicity is NOT rollback atomicity: a rejected op does not roll back the whole frame.
}
export function encodeMessage(msg: Message, apc = 65536): Buffer {
    if (!(WIRE_VERBS as readonly string[]).includes(msg.verb))
        throw new TernError('UNKNOWN_WIRE_VERB', `Unreviewed protocol verb ${msg.verb}`);
    if (!Number.isSafeInteger(apc) || apc < 128 || apc > 262144)
        throw new TernError('TSP_LIMIT', 'APC limit must be 128..262144');
    const params = msg.params ?? {};
    for (const [k, v] of Object.entries(params))
        if (!/^[A-Za-z0-9_-]+$/.test(k) || typeof v !== 'string' || !/^[\x21-\x3a\x3c-\x7e]*$/.test(v) || k === 'c' || k === 'm')
            throw new TernError('INVALID_TSP_PARAMETER', 'Parameters must be printable tokens; c/m are owned by the chunker');
    if (msg.verb === 'f')
        validateFrame(msg.body);
    let text: string;
    if (msg.verb === 'b') {
        if (typeof msg.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.body))
            throw new TernError('INVALID_BLOB', 'Expected standard padded base64');
        const raw = Buffer.from(msg.body, 'base64');
        if (raw.length > MAX_BLOB || createHash('sha256').update(raw).digest('hex') !== params.id)
            throw new TernError('INVALID_BLOB', 'Blob hash mismatch or size limit');
        text = msg.body;
    }
    else {
        validateJson(msg.body);
        text = JSON.stringify(msg.body);
    }
    const body = Buffer.from(text);
    if (body.length > MAX_JOINED)
        throw new TernError('TSP_LIMIT', 'Joined body exceeds 24 MiB');
    const fields = Object.entries(params).map(([k, v]) => `;${k}=${v}`).join('');
    const raw = (p: string, b: Buffer) => Buffer.concat([Buffer.from(`\x1b_tsp;${msg.verb}${p};`), b, ST]);
    if (raw(fields, body).length <= apc)
        return raw(fields, body);
    const id = createHash('sha256').update(body).digest('hex').slice(0, 16), chunks: Buffer[] = [];
    const scan: ParameterScan = { keyStart: 0, keyEnd: 0, valueStart: -1, valueEnd: -1 };
    let at = 0;
    while (at < body.length) {
        const prefix = (at === 0 ? fields : '') + `;c=${id}`;
        const max = apc - raw(prefix + ';m=1', Buffer.alloc(0)).length;
        let to = Math.min(body.length, at + max);
        if (to <= at)
            throw new TernError('TSP_LIMIT', 'Parameter header exceeds APC budget');
        // Inspect the entire suffix, not just the next chunk's budget: a parameter's
        // semicolon can lie beyond that budget. Never split a UTF-8 code point either.
        while (to > at && to < body.length) {
            if ((body[to]! & 0xc0) === 0x80) {
                to--;
                continue;
            }
            if (!leadsWithParameter(body, to, scan))
                break;
            // Every position in this key run has the same unsafe suffix. Skip it
            // together instead of rescanning a long key once per byte.
            do { to--; } while (to > at && keyByte(body[to]!));
        }
        if (to === at)
            throw new TernError('TSP_CHUNK_BOUNDARY', 'No safe chunk boundary');
        chunks.push(raw(prefix + (to < body.length ? ';m=1' : ''), body.subarray(at, to)));
        at = to;
    }
    return Buffer.concat(chunks);
}
export function encodeBlob(bytes: Buffer, mime = 'application/octet-stream', apc = 65536): Buffer {
    return encodeMessage({ verb: 'b', params: { id: createHash('sha256').update(bytes).digest('hex'), mime }, body: bytes.toString('base64') }, apc);
}
function parsePayload(payload: Buffer): {
    verb: string;
    params: Record<string, string>;
    body: Buffer;
} {
    const semi = payload.indexOf(59);
    if (semi < 0)
        throw new TernError('TSP_PARSE', 'Missing verb delimiter');
    const verb = payload.subarray(0, semi).toString();
    let at = semi + 1;
    const params: Record<string, string> = {};
    while (true) {
        const end = payload.indexOf(59, at);
        if (end < 0)
            break;
        const s = payload.subarray(at, end).toString('latin1');
        const m = s.match(/^([A-Za-z0-9_-]+)=([\x21-\x3a\x3c-\x7e]*)$/);
        if (!m)
            break;
        params[m[1]!] = m[2]!;
        at = end + 1;
    }
    return { verb, params, body: payload.subarray(at) };
}
/** Streaming diagnostic decoder. Bracketed paste is never interpreted as protocol input. */
export class WireDecoder {
    private buffer = Buffer.alloc(0);
    private paste = false;
    private chunks: null | {
        id: string;
        verb: string;
        params: Record<string, string>;
        parts: Buffer[];
        size: number;
        at: number;
    } = null;
    feed(bytes: Buffer, nowMs = performance.now()): WireItem[] {
        this.buffer = Buffer.concat([this.buffer, bytes]);
        const output: WireItem[] = [];
        const emit = (b: Buffer) => { if (b.length)
            output.push({ type: 'bytes', bytes: b }); };
        const pasteStart = Buffer.from('\x1b[200~'), pasteEnd = Buffer.from('\x1b[201~');
        while (this.buffer.length) {
            if (this.paste) {
                const end = this.buffer.indexOf(pasteEnd);
                if (end < 0) {
                    if (this.buffer.length > pasteEnd.length) {
                        emit(this.buffer.subarray(0, -pasteEnd.length));
                        this.buffer = this.buffer.subarray(-pasteEnd.length);
                    }
                    break;
                }
                emit(this.buffer.subarray(0, end + pasteEnd.length));
                this.buffer = this.buffer.subarray(end + pasteEnd.length);
                this.paste = false;
                continue;
            }
            const escape = this.buffer.indexOf(27);
            if (escape < 0) {
                emit(this.buffer);
                this.buffer = Buffer.alloc(0);
                break;
            }
            if (escape > 0) {
                emit(this.buffer.subarray(0, escape));
                this.buffer = this.buffer.subarray(escape);
            }
            if (this.buffer.length >= pasteStart.length && this.buffer.subarray(0, pasteStart.length).equals(pasteStart)) {
                this.paste = true;
                emit(pasteStart);
                this.buffer = this.buffer.subarray(pasteStart.length);
                continue;
            }
            const starts = [START, OSC, pasteStart];
            if (starts.some(p => this.buffer.length < p.length && p.subarray(0, this.buffer.length).equals(this.buffer)))
                break;
            const prefix = [START, OSC].find(p => this.buffer.subarray(0, p.length).equals(p));
            if (!prefix) {
                emit(this.buffer.subarray(0, 1));
                this.buffer = this.buffer.subarray(1);
                continue;
            }
            let end = this.buffer.indexOf(ST, prefix.length), term = 2;
            if (prefix === OSC) {
                const bel = this.buffer.indexOf(7, prefix.length);
                if (bel >= 0 && (end < 0 || bel < end)) {
                    end = bel;
                    term = 1;
                }
            }
            if (end < 0) {
                if (this.buffer.length > MAX_JOINED + 4096)
                    throw new TernError('TSP_LIMIT', 'Incomplete input message exceeds decoder bound');
                break;
            }
            const p = parsePayload(this.buffer.subarray(prefix.length, end));
            this.buffer = this.buffer.subarray(end + term);
            if (this.chunks && (nowMs - this.chunks.at > 1000 || p.params.c !== this.chunks.id || p.verb !== this.chunks.verb)) {
                this.chunks = null;
                throw new TernError('TSP_CHUNK_INTERRUPTED', 'Chunk sequence expired or was interrupted');
            }
            let body = p.body, params = p.params;
            if (p.params.c) {
                if (!this.chunks)
                    this.chunks = { id: p.params.c, verb: p.verb, params: { ...p.params }, parts: [], size: 0, at: nowMs };
                this.chunks.parts.push(body);
                this.chunks.size += body.length;
                this.chunks.at = nowMs;
                if (this.chunks.size > MAX_JOINED) {
                    this.chunks = null;
                    throw new TernError('TSP_LIMIT', 'Chunk sequence exceeds 24 MiB');
                }
                if (p.params.m === '1')
                    continue;
                body = Buffer.concat(this.chunks.parts);
                params = this.chunks.params;
                delete params.c;
                delete params.m;
                this.chunks = null;
            }
            let value: unknown;
            try {
                value = p.verb === 'b' ? body.toString('ascii') : JSON.parse(body.toString('utf8'));
            }
            catch {
                throw new TernError('TSP_PARSE', 'Malformed message JSON');
            }
            if (p.verb !== 'b')
                validateJson(value);
            output.push({ type: 'message', message: { verb: p.verb, params, body: value } });
        }
        return output;
    }
    end(): void { if (this.buffer.length || this.chunks || this.paste)
        throw new TernError('TSP_INCOMPLETE', 'Stream ended inside an escape, chunk sequence or bracketed paste'); }
}
