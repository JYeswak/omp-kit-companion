import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { TernError, record } from './model.ts';
export function endpointAddress(endpoint: string): {
    path: string;
} | {
    host: string;
    port: number;
} {
    if (/^\d+$/.test(endpoint)) {
        const port = Number(endpoint);
        if (port < 1 || port > 65535)
            throw new TernError('INVALID_ENDPOINT', 'Client port must be 1..65535; 0 is for server creation only');
        return { host: '127.0.0.1', port };
    }
    if (!isAbsolute(endpoint) || /[\r\n\0]/.test(endpoint))
        throw new TernError('INVALID_ENDPOINT', 'Supply an absolute Unix socket path or loopback TCP port');
    return { path: endpoint };
}
/** Script grammar has exactly four escapes, unlike JSON or shell quoting. */
export function scriptToken(token: string): string {
    if (/[\r\0\x01-\x08\x0b-\x1f\x7f]/.test(token))
        throw new TernError('INVALID_SCRIPT_TOKEN', 'Unsupported control character in script argument');
    return '"' + token.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}
/** This is for scenario grammar. Raw-selector control forms deliberately use a separate path. */
export function scenarioLine(verb: string, args: string[]): string {
    if (!/^[a-z][a-z0-9-]*$/.test(verb))
        throw new TernError('INVALID_VERB', 'Expected one native scenario verb');
    return [verb, ...args.map(scriptToken)].join(' ');
}
export function validateLine(line: string): void {
    if (!line.trim() || /[\r\n\0]/.test(line))
        throw new TernError('INVALID_CONTROL_LINE', 'One nonempty command line per request; embedded newlines must be script escapes');
    if (Buffer.byteLength(line) > 1024 * 1024)
        throw new TernError('REQUEST_TOO_LARGE', 'Control request exceeds 1 MiB');
}
export interface ControlOptions {
    endpoint: string;
    timeoutMs?: number;
    maxReplyBytes?: number;
    signal?: AbortSignal;
}
export interface ControlResult {
    replies: Record<string, unknown>[];
    dispatched: number;
}
/** Documented one-line command / one-line JSON protocol. Never silently retries a mutation. */
export async function control(lines: string[], opts: ControlOptions): Promise<ControlResult> {
    if (lines.length < 1 || lines.length > 1000)
        throw new TernError('INVALID_BATCH', 'Use 1..1000 commands');
    lines.forEach(validateLine);
    const address = endpointAddress(opts.endpoint), limit = opts.maxReplyBytes ?? 4 * 1024 * 1024, timeout = opts.timeoutMs ?? 25000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024)
        throw new TernError('INVALID_LIMIT', 'Invalid timeout or reply limit');
    if (opts.signal?.aborted)
        throw new TernError('CANCELLED_BEFORE_SEND', 'No command was sent', 4);
    return await new Promise((resolve, reject) => {
        const socket = createConnection(address);
        let buffer = Buffer.alloc(0), done = false, dispatched = 0, totalBytes = 0;
        const replies: Record<string, unknown>[] = [];
        const timer = setTimeout(() => finish(new TernError(dispatched ? 'OUTCOME_UNKNOWN' : 'TERN_UNAVAILABLE', dispatched ? 'Deadline expired after dispatch; native effects may still complete. Reconcile; do not blindly retry.' : 'Tern connection deadline expired', dispatched ? 4 : 3, { dispatched, received: replies.length })), timeout);
        function finish(error?: Error) {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', abort);
            socket.destroy();
            if (error)
                reject(error);
            else
                resolve({ replies, dispatched });
        }
        function abort() { finish(new TernError(dispatched ? 'OUTCOME_UNKNOWN' : 'CANCELLED_BEFORE_SEND', 'Client cancelled; cancellation does not roll back or cancel a native action already submitted', 4, { dispatched, received: replies.length })); }
        function sendNext() { const line = lines[replies.length]; if (line === undefined) {
            finish();
            return;
        } dispatched++; socket.write(line + '\n'); }
        opts.signal?.addEventListener('abort', abort, { once: true });
        socket.on('connect', sendNext);
        socket.on('error', () => finish(new TernError(dispatched ? 'OUTCOME_UNKNOWN' : 'TERN_UNAVAILABLE', dispatched ? 'Connection failed after dispatch; reconcile native state' : 'Cannot connect to the explicitly selected Tern endpoint', dispatched ? 4 : 3, { dispatched, received: replies.length })));
        socket.on('end', () => { if (!done)
            finish(new TernError(dispatched ? 'OUTCOME_UNKNOWN' : 'TERN_UNAVAILABLE', 'Tern closed the connection before all replies arrived', dispatched ? 4 : 3, { dispatched, received: replies.length })); });
        socket.on('data', (chunk: Buffer) => {
            if (done)
                return;
            totalBytes += chunk.length;
            if (totalBytes > limit) {
                finish(new TernError('OUTCOME_UNKNOWN', 'Reply exceeded the local bound after dispatch; native effect was not rolled back', 4, { dispatched, received: replies.length }));
                return;
            }
            buffer = Buffer.concat([buffer, chunk]);
            const pos = buffer.indexOf(10);
            if (pos < 0)
                return;
            const line = buffer.subarray(0, pos).toString('utf8');
            buffer = buffer.subarray(pos + 1);
            if (buffer.length) {
                finish(new TernError('PROTOCOL_ERROR', 'Unsolicited bytes after reply; do not use an endpoint shared with an incompatible protocol', 4));
                return;
            }
            let reply: unknown;
            try {
                reply = JSON.parse(line);
            }
            catch {
                finish(new TernError('PROTOCOL_ERROR', 'Tern reply is not JSON', 4));
                return;
            }
            if (!record(reply) || typeof reply.ok !== 'boolean') {
                finish(new TernError('PROTOCOL_ERROR', 'Tern reply lacks boolean ok', 4));
                return;
            }
            replies.push(reply);
            if (!reply.ok) {
                finish(new TernError('NATIVE_REJECTED', String(reply.error ?? 'Tern rejected the request'), 1, { dispatched, received: replies.length, earlier_replies: replies.slice(0, -1) }));
                return;
            }
            sendNext();
        });
    });
}
export interface ProcessResult {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}
export async function nativeProcess(binary: string, args: string[], timeoutMs = 65000, maxBytes = 8 * 1024 * 1024): Promise<ProcessResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new TernError('INVALID_LIMIT', 'Invalid process limits');
    if (!binary || /[\0\r\n]/.test(binary) || args.some(a => a.includes('\0')))
        throw new TernError('INVALID_PROCESS', 'Invalid native argv');
    return await new Promise((resolve, reject) => {
        const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let size = 0, settled = false;
        const out: Buffer[] = [], err: Buffer[] = [];
        const timer = setTimeout(() => stop(new TernError('OUTCOME_UNKNOWN', 'Native CLI deadline expired; background/native work may continue', 4)), timeoutMs);
        function stop(error: Error) { if (settled)
            return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); reject(error); }
        function collect(dest: Buffer[], chunk: Buffer) { size += chunk.length; if (size > maxBytes)
            stop(new TernError('OUTCOME_UNKNOWN', 'Native output exceeded local bound', 4));
        else
            dest.push(chunk); }
        child.stdout.on('data', b => collect(out, b));
        child.stderr.on('data', b => collect(err, b));
        child.on('error', () => stop(new TernError('TERN_UNAVAILABLE', 'Native Tern executable could not be started', 3)));
        child.on('close', (code, signal) => { if (settled)
            return; settled = true; clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }); });
    });
}
export function parseNativeResult(p: ProcessResult): {
    status: string;
    value: unknown;
    warnings: string[];
} {
    if (p.code !== 0)
        throw new TernError('NATIVE_CLI_FAILED', `Native CLI exited ${p.code ?? p.signal}`, p.code === 124 ? 4 : 1, { code: p.code, stderr: p.stderr });
    let value: unknown;
    try {
        value = JSON.parse(p.stdout);
    }
    catch {
        value = { text: p.stdout };
    }
    if (record(value) && value.ok === false)
        throw new TernError('NATIVE_REJECTED', String(value.error ?? 'Native JSON reports failure'), 1);
    const problems = record(value) && Array.isArray(value.problems) ? value.problems : [];
    const warnings = [...(p.stderr.trim() ? [p.stderr] : []), ...problems.map(String)];
    return { status: warnings.length ? 'NATIVE_COMPLETED_WITH_WARNINGS' : 'NATIVE_COMPLETED', value, warnings };
}
