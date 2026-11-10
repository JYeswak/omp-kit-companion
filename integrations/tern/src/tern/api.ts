import { randomBytes } from 'node:crypto';
import { compileProgram } from './luau.ts';
import { control, scenarioLine } from './transport.ts';
import type { ControlOptions } from './transport.ts';
import { record, TernError } from './model.ts';
export function readProgramReply(replies: Record<string, unknown>[], nonce: string): unknown {
    const state = replies[replies.length - 1];
    const carly = state && record(state.carly) ? state.carly : null;
    const answer = carly && record(carly.last_tool) ? carly.last_tool : null;
    if (!answer || answer.error || typeof answer.text !== 'string')
        throw new TernError('NATIVE_TOOL_FAILED', 'No successful Carly Lua answer was observed', 1);
    const prefix = 'OMP_KIT_TERN:' + nonce + ':';
    const lines = answer.text.split(/\r?\n/).filter(x => x.startsWith(prefix));
    if (lines.length !== 1)
        throw new TernError('ANSWER_CORRELATION_FAILED', 'No unique matching request result; another client may have replaced last_tool. Do not blindly retry.', 4);
    const encoded = lines[0]!.slice(prefix.length).trim();
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
        throw new TernError('INVALID_RESULT', 'Result marker body is not canonical base64', 4);
    try {
        return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    }
    catch {
        throw new TernError('INVALID_RESULT', 'Result marker body is not JSON', 4);
    }
}
export async function executeProgram(program: unknown, opts: ControlOptions): Promise<unknown> {
    const nonce = randomBytes(16).toString('hex');
    const compiled = compileProgram(program, nonce);
    // `carly lua` may return ok=true while the tool has failed. `carly ok` checks the tool error.
    // `state` is untruncated here, unlike native `ctl --file`'s 400-char display.
    const response = await control([scenarioLine('carly', ['lua', compiled.code]), 'carly ok', 'state'], opts);
    const values = readProgramReply(response.replies, nonce);
    checkNativeValues(program, values);
    return { status: 'NATIVE_RESULT_OBSERVED', symbols: compiled.symbols, values,
        proof: 'ONE_NATIVE_CALL_PATH', not_proven: ['overall task completion', 'cancellation of native work after client timeout', 'correctness beyond the requested native operation'] };
}
/** Only explicit native failure envelopes, never "false means error" for arbitrary getters. */
export function checkNativeValues(program: unknown, values: unknown): void {
    if (!record(program) || !Array.isArray(program.steps) || !Array.isArray(values))
        throw new TernError('INVALID_RESULT', 'Expected a correlated native result array', 4);
    const byId = new Map(program.steps.filter(record).map(s => [s.id, s.member]));
    for (const row of values) {
        if (!record(row) || typeof row.id !== 'string' || !byId.has(row.id) || !Array.isArray(row.values))
            throw new TernError('INVALID_RESULT', 'Invalid native result row', 4);
        const symbol = byId.get(row.id), first = row.values[0];
        if (symbol === 'cx.browser.call' && record(first) && first.error)
            throw new TernError('NATIVE_BROWSER_FAILED', 'Native browser returned its error envelope', 1, { native: first });
        if (symbol === 'tern.process.run' && record(first) && (first.status !== 0 || first.timed_out === true))
            throw new TernError('NATIVE_PROCESS_FAILED', 'Native process returned nonzero status or timeout', 1, { native: first });
        if (symbol === 'tern.fetch' && record(first) && (first.error || first.timed_out === true))
            throw new TernError('NATIVE_FETCH_FAILED', 'Native fetch returned a transport error', 1, { native: first });
        if (['cx.layout.restore', 'cx.layout.move_to_tab', 'cx.layout.float', 'cx.layout.dock', 'cx.layout.park', 'cx.layout.unpark', 'cx.layout.rename_session'].includes(String(symbol)) && first === false && typeof row.values[1] === 'string')
            throw new TernError('NATIVE_OPERATION_REFUSED', row.values[1], 1);
    }
}
