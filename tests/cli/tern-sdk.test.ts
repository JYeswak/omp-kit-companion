import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS, member } from '../../src/tern/model.ts';
import { compileProgram, luaString, luaValue, emitCall, memberAllowedInContext } from '../../src/tern/luau.ts';
import { extractDeclarations, compareInventory, verifySdk, docsReport } from '../../src/tern/coverage.ts';
import routes from '../../scripts/tern-script-routes.json';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { checkNativeValues, executeProgram, readProgramReply } from '../../src/tern/api.ts';
import { parseNativeResult } from '../../src/tern/transport.ts';
import { runTern } from '../../src/tern/command.ts';
const nonce = 'a'.repeat(32);
test('Lua strings are UTF-8 byte escaped and finite JSON has explicit empty/null representation', () => {
    assert.equal(luaString('"\n'), '"\\034\\010"');
    assert.equal(luaString('😀'), '"\\240\\159\\152\\128"');
    assert.equal(luaValue([]), 'tern.json.array({})');
    assert.equal(luaValue(null), 'tern.json.null');
    assert.throws(() => luaValue(Infinity));
    assert.throws(() => luaValue(2 ** 60));
});
test('opaque handles cannot escape and references must name earlier steps', () => {
    assert.throws(() => compileProgram({ context: 'carly', steps: [{ id: 's', member: 'cx.layout.snapshot', capture: true }] }, nonce), { code: 'OPAQUE_HANDLE_CAPTURE' });
    assert.throws(() => compileProgram({ context: 'carly', steps: [{ id: 's', member: 'cx.layout.restore', args: [{ $ref: 'future' }] }] }, nonce));
});
test('host-only calls and callback registrations cannot be flattened into Carly JSON', () => {
    for (const symbol of ['tern.block.define', 'tern.pane.write', 'tern.secrets.get', 'tern.timer'])
        assert.throws(() => compileProgram({ context: 'carly', steps: [{ id: 'bad', member: symbol }] }, nonce));
});
test('callback implementations are required and definition scopes do not leak', () => {
    assert.throws(() => emitCall('LensDef.open', 'host-lens', ''), { code: 'CALLBACK_SOURCE_REQUIRED' });
    assert.throws(() => emitCall('LensDef.open', 'host-block', 'function() end'), { code: 'WRONG_CONTEXT' });
    assert.throws(() => emitCall('BlockDef.event', 'host-lens', 'function() end'), { code: 'WRONG_CONTEXT' });
});
test('Lens EffectCx inheritance exposes effects without block/window authority', () => {
    for (const symbol of ['effect.toast', 'effect.open', 'effect.copy']) {
        assert.equal(memberAllowedInContext(member(symbol), 'host-lens'), true);
        assert.equal(memberAllowedInContext(member(symbol), 'host-block'), true);
        assert.equal(memberAllowedInContext(member(symbol), 'host-effect'), true);
        assert.equal(memberAllowedInContext(member(symbol), 'host'), false);
        assert.equal(memberAllowedInContext(member(symbol), 'carly'), false);
        assert.throws(() => emitCall(symbol, 'window', '"diagnostic"'), { code: 'WRONG_CONTEXT' });
    }
    assert.equal(memberAllowedInContext(member('BlockDef.event'), 'host-lens'), false);
    assert.equal(memberAllowedInContext(member('LensDef.event'), 'host-lens'), true);
    assert.equal(memberAllowedInContext(member('cx.session.panes'), 'host-lens'), false);
    assert.equal(memberAllowedInContext(member('tern.block.define'), 'host-lens'), true);
});
test('declaration parser discovers new global, nested, extern and handle functions independently', () => {
    const source = `-- decoy function ignored(self): ()\ndeclare extern type SessionCx with\nfunction panes(self): {any}\nfunction new_verb(self, value: string): ()\nend\ndeclare tern: { now: () -> number, nested: { future: (x: string) -> () }, value: string }\nexport type Awaitable<T> = { kind: string, next: (self: Awaitable<T>, cb: (x: T) -> ()) -> () }`;
    const e = extractDeclarations(source);
    for (const s of ['cx.session.panes', 'cx.session.new_verb', 'tern.now', 'tern.nested.future', 'handle.Awaitable.next'])
        assert(e.symbols.includes(s));
    assert(compareInventory(e.symbols, MEMBERS.map(m => m.symbol)).missing.includes('cx.session.new_verb'));
    const report = verifySdk(Buffer.from(source));
    assert.equal(report.status, 'FAIL');
    assert.equal(report.source_changed, true);
});
test('new unrecognized SDK owner fails the coverage audit', () => { const r = extractDeclarations('declare extern type FutureCx with function surprise(self): () end'); assert.deepEqual(r.unknownOwners, ['FutureCx.surprise']); });
test('inventory labels distinguish unmapped declarations, stale mappings and duplicate mappings', () => {
    assert.deepEqual(compareInventory(['tern.now', 'tern.new'], ['tern.now', 'tern.old', 'tern.now']), {
        missing: ['tern.new'], unexpected: ['tern.old'], duplicates: ['tern.now'],
    });
});
test('missing source pages fail documentation coverage', () => {
    const report = docsReport({ schema_version: 1, scope: 'SCRIPT_DOCUMENTATION_TABLE_ROWS', pages: [] });
    assert.equal(report.status, 'FAIL');
    assert((report.missing_pages as string[]).includes('scripts/index.html'));
});

function census() {
    return {
        schema_version: 1, scope: 'SCRIPT_DOCUMENTATION_TABLE_ROWS',
        pages: ['scripts/index.html', ...Object.keys(routes.pages)].map(path => ({
            path, sha256: 'a'.repeat(64), known_family: true,
            rows: [{ line: 10, heading: 'Commands', first_cell: '`read`' }],
        })),
    };
}
function baseline(report: { pages: { path: string; sha256: string }[] }) {
    return { pages: Object.fromEntries(report.pages.map(page => [page.path, page.sha256])) };
}
test('embedded lock claims cannot approve a docs report without an explicit baseline', () => {
    const report = census();
    for (const lock_status of ['MATCH', 'DRIFT', 'FAIL']) {
        const result = docsReport({ ...report, lock_status });
        assert.equal(result.source_lock, 'UNREVIEWED');
        assert.equal(result.status, 'INVENTORIED');
    }
    const compared = docsReport(report, baseline(report));
    assert.equal(compared.source_lock, 'MATCH');
    assert.equal(compared.semantic_coverage, 'REQUIRES_REVIEW');
});
test('docs require the scripts index even when all family pages and hashes match', () => {
    const report = census(), lock = baseline(report);
    report.pages = report.pages.filter(page => page.path !== 'scripts/index.html');
    const result = docsReport(report, lock);
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.missing_pages, ['scripts/index.html']);
    assert.deepEqual(result.removed_pages, ['scripts/index.html']);
});
test('docs hash drift cannot be hidden behind an embedded MATCH', () => {
    const report = census(), lock = baseline(report);
    report.pages[0]!.sha256 = 'b'.repeat(64);
    const result = docsReport({ ...report, lock_status: 'MATCH' }, lock);
    assert.equal(result.source_lock, 'DRIFT');
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.changed_pages, ['scripts/index.html']);
});
test('new linked script families fail and are retained in drift inventory', () => {
    const report = census(), lock = baseline(report);
    report.pages.push({ path: 'scripts/future.html', sha256: 'c'.repeat(64), known_family: false, rows: [] });
    const result = docsReport(report, lock);
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.unknown_pages, ['scripts/future.html']);
    assert.deepEqual(result.added_pages, ['scripts/future.html']);
});
test('duplicate pages, failed fetches, invalid content hashes and malformed rows fail', () => {
    const duplicate = census();
    duplicate.pages.push({ ...duplicate.pages[0]! });
    assert.deepEqual(docsReport(duplicate).duplicate_pages, ['scripts/index.html']);
    assert.equal(docsReport(duplicate).status, 'FAIL');
    for (const patch of [
        { error: 'fetch failed' }, { sha256: '' }, { sha256: 'a'.repeat(64) + '\n' },
        { sha256: 'a'.repeat(100000) }, { rows: null },
        { rows: [{ line: 0, heading: '', first_cell: 'read' }] },
    ]) {
        const report = census();
        Object.assign(report.pages[0]!, patch);
        assert.equal(docsReport(report).status, 'FAIL');
        assert.equal(docsReport(report).unusable_pages, 1);
    }
});
test('invalid census and baseline shapes reject instead of trusting lock metadata', () => {
    for (const input of [null, { schema_version: 1, pages: [] }, { ...census(), pages: Array(101).fill(null) }])
        assert.throws(() => docsReport(input), { code: 'INVALID_DOCS_REPORT' });
    for (const lock of [null, {}, { pages: [] }, { pages: { 'scripts/index.html': 'not-a-hash' } }])
        assert.throws(() => docsReport(census(), lock), { code: 'INVALID_DOCS_BASELINE' });
});
test('declaration comments and strings cannot invent functions or callback slots', () => {
    const result = extractDeclarations(`--[=[ declare tern: { forged: () -> () } ]=]
declare tern: { now: () -> number, description: "function forged(self): ()", nested: { read: (x: {key: string}) -> (string, boolean) } }`);
    assert.deepEqual(result.symbols, ['tern.nested.read', 'tern.now']);
    assert.equal(result.signatures['tern.now'], '( ) -> number');
});
test('changed signatures and noncallable source edits retain full-file drift evidence', () => {
    const first = Buffer.from('declare tern: { now: () -> number }');
    const signature = Buffer.from('declare tern: { now: () -> string }');
    const comment = Buffer.from(first.toString() + '\n-- documentation changed');
    const a = verifySdk(first, ['tern.now']), b = verifySdk(signature, ['tern.now']), c = verifySdk(comment, ['tern.now']);
    assert.equal(a.mapping_pass, true);
    assert.equal(b.mapping_pass, true);
    assert.equal(c.mapping_pass, true);
    assert.equal(b.status, 'FAIL');
    assert.equal(c.status, 'FAIL');
    assert.notEqual(a.current_git_blob, b.current_git_blob);
    assert.notEqual(a.current_git_blob, c.current_git_blob);
    assert.notEqual(a.signatures['tern.now'], b.signatures['tern.now']);
    assert.equal(a.signatures['tern.now'], c.signatures['tern.now']);
});
test('repeated upstream declarations fail mapping rather than silently collapsing', () => {
    const report = verifySdk(Buffer.from('declare tern: { now: () -> number, now: () -> number }'), ['tern.now']);
    assert.equal(report.mapping_pass, false);
    assert.deepEqual(report.declaration_duplicates, ['tern.now']);
});
test('unbalanced declaration input refuses partial inventories', () => {
    assert.throws(() => extractDeclarations('declare tern: { now: (x: {value: string}) -> number'));
});

test('same-VM handle programs keep mutation classification without exporting handles', () => {
    const result = compileProgram({ context: 'carly', steps: [
        { id: 'snap', member: 'cx.layout.snapshot' },
        { id: 'restore', member: 'cx.layout.restore', args: [{ $ref: 'snap' }] },
    ] }, nonce);
    assert.equal(result.readOnly, false);
    const read = compileProgram({ context: 'carly', steps: [{ id: 'focused', member: 'cx.session.focused' }] }, nonce);
    assert.equal(read.readOnly, true);
});
test('program shape, receiver, references and JSON argument errors reject before dispatch', () => {
    const step = { id: 'focused', member: 'cx.session.focused' };
    const compile = (steps: unknown[]) => compileProgram({ context: 'carly', steps }, nonce);
    assert.throws(() => compileProgram({ context: 'carly', steps: [] }, nonce), { code: 'INVALID_PROGRAM' });
    assert.throws(() => compileProgram({ context: 'carly', steps: [step] }, 'bad'), { code: 'INVALID_NONCE' });
    assert.throws(() => compile([step, step]), { code: 'INVALID_STEP_ID' });
    assert.throws(() => compile([{ ...step, args: Array(33).fill(0) }]), { code: 'INVALID_ARGUMENTS' });
    assert.throws(() => compile([{ ...step, receiver: {} }]), { code: 'UNEXPECTED_RECEIVER' });
    assert.throws(() => compile([{ id: 'agent', member: 'handle.Agent.tocarly' }]), { code: 'RECEIVER_REQUIRED' });
    assert.throws(() => compile([{ ...step, capture: 'yes' }]), { code: 'INVALID_CAPTURE' });
    assert.throws(() => compile([{ ...step, args: [undefined] }]), { code: 'NON_JSON_ARGUMENT' });
    assert.throws(() => compile([{ ...step, args: [{ $ref: 'future' }] }]), { code: 'INVALID_REFERENCE' });
    assert.throws(() => compile([{ ...step, args: [{ $literal: true, extra: true }] }]), { code: 'UNKNOWN_FIELDS' });
});

test('captured results require every expected ID exactly once and no other IDs', () => {
    const program = { context: 'carly', steps: [
        { id: 'a', member: 'tern.now' },
        { id: 'b', member: 'tern.now', capture: true },
        { id: 'hidden', member: 'tern.now', capture: false },
    ] };
    compileProgram(program, nonce);
    const a = { id: 'a', values: [1] }, b = { id: 'b', values: [2] };
    for (const values of [
        [], [a], [a, a], [a, b, a], [a, b, { id: 'unknown', values: [] }],
        [a, b, { id: 'hidden', values: [] }], [a, b, { id: 'unknown', values: null }],
    ]) {
        assert.throws(() => checkNativeValues(program, values), { code: 'INVALID_RESULT', exit: 4 });
    }
    assert.deepEqual(checkNativeValues(program, [b, a]), [b, a]);
});

test('uncaptured handles and null/multiple native returns preserve their result contract', () => {
    const program = { context: 'carly', steps: [
        { id: 'snap', member: 'cx.layout.snapshot', capture: false },
        { id: 'restored', member: 'cx.layout.restore', args: [{ $ref: 'snap' }] },
    ] };
    compileProgram(program, nonce);
    const values = [{ id: 'restored', values: [true, null] }];
    assert.deepEqual(checkNativeValues(program, values), [{ id: 'restored', values: [true, null] }]);
    assert.throws(() => checkNativeValues(program, [...values, { id: 'snap', values: [] }]), { code: 'INVALID_RESULT', exit: 4 });
    const implicitHandle = { context: 'carly', steps: [{ id: 'snap', member: 'cx.layout.snapshot' }] };
    compileProgram(implicitHandle, nonce);
    assert.deepEqual(checkNativeValues(implicitHandle, []), []);
    const uncaptured = { context: 'carly', steps: [{ id: 'a', member: 'tern.now', capture: false }] };
    compileProgram(uncaptured, nonce);
    assert.deepEqual(checkNativeValues(uncaptured, []), []);
    assert.throws(() => checkNativeValues(uncaptured, [{ id: 'a', values: [1] }]), { code: 'INVALID_RESULT', exit: 4 });
    for (const tuple of [[], [null], [false], [null, false, 3, null]]) {
        assert.deepEqual(checkNativeValues({ steps: [{ id: 'a', member: 'tern.now' }] }, [{ id: 'a', values: tuple }]), [{ id: 'a', values: tuple }]);
    }
});

test('only complete correlated results classify explicit native failure envelopes as known failures', () => {
    for (const [symbol, tuple, code] of [
        ['cx.browser.call', [{ error: 'browser failed' }], 'NATIVE_BROWSER_FAILED'],
        ['tern.process.run', [{ status: 1, timed_out: false }], 'NATIVE_PROCESS_FAILED'],
        ['tern.fetch', [{ error: 'network failed' }], 'NATIVE_FETCH_FAILED'],
        ['cx.layout.restore', [false, 'snapshot refused'], 'NATIVE_OPERATION_REFUSED'],
    ] as const) {
        const program = { steps: [{ id: 'a', member: symbol }] };
        const values = [{ id: 'a', values: tuple }];
        const text = `OMP_KIT_TERN:${nonce}:${Buffer.from(JSON.stringify(values)).toString('base64')}`;
        const decoded = readProgramReply([{ carly: { last_tool: { text } } }], nonce);
        assert.throws(() => checkNativeValues(program, decoded), { code, exit: 1 });
        assert.throws(() => checkNativeValues({ steps: [...program.steps, { id: 'b', member: 'tern.now' }] }, decoded),
            { code: 'INVALID_RESULT', exit: 4 });
    }
});

test('unbound failed or replaced Carly answers cannot establish this request failed', () => {
    for (const last_tool of [
        { error: 'another caller failed' }, { error: 'failed', text: 'no matching nonce' },
        { text: `OMP_KIT_TERN:${'b'.repeat(32)}:W10=` }, { text: '' },
    ]) {
        assert.throws(() => readProgramReply([{ carly: { last_tool } }], nonce),
            { code: 'ANSWER_CORRELATION_FAILED', exit: 4 });
    }
    assert.throws(() => readProgramReply([], nonce), { code: 'ANSWER_CORRELATION_FAILED', exit: 4 });
});

for (const failureAt of [1, 2, 3]) {
    test(`native command ${failureAt} rejection before correlated completion is uncertain and retains its cause`, async () => {
        const server = createServer(socket => {
            let received = 0;
            socket.on('data', () => {
                received++;
                if (received === failureAt)
                    socket.end(JSON.stringify({ ok: false, error: 'Carly failed' }) + '\n');
                else
                    socket.write(JSON.stringify({ ok: true }) + '\n');
            });
        });
        server.listen(0, '127.0.0.1');
        try {
            await once(server, 'listening');
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('Expected a listening TCP endpoint');
            await assert.rejects(executeProgram({ context: 'carly', steps: [{ id: 'a', member: 'tern.now' }] },
                { endpoint: String(address.port) }), (error: unknown) => {
                if (!(error instanceof Error) || !('code' in error) || !('exit' in error) || !('cause' in error))
                    throw Object.assign(new Error('Expected a classified API error with its cause'), { cause: error });
                assert.equal(error.code, 'OUTCOME_UNKNOWN');
                assert.equal(error.exit, 4);
                const cause = error.cause;
                if (!(cause instanceof Error) || !('code' in cause) || !('details' in cause))
                    throw Object.assign(new Error('Expected the original native rejection'), { cause });
                assert.equal(cause.code, 'NATIVE_REJECTED');
                assert.equal(cause.message, 'Carly failed');
                assert.deepEqual(cause.details, {
                    dispatched: failureAt, received: failureAt,
                    earlier_replies: Array.from({ length: failureAt - 1 }, () => ({ ok: true })),
                });
                return true;
            });
            await assert.rejects(executeProgram({ context: 'carly', steps: [{ id: 'a', member: 'tern.now' }] },
                { endpoint: 'relative.sock' }), { code: 'INVALID_ENDPOINT', exit: 2 });
            await assert.rejects(executeProgram({ context: 'carly', steps: [] },
                { endpoint: String(address.port) }), { code: 'INVALID_PROGRAM', exit: 2 });
        }
        finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });
}

test('native false values alone are not failure envelopes', () => {
    for (const symbol of ['cx.browser.call', 'tern.process.run', 'tern.fetch', 'cx.layout.restore', 'cx.session.focused']) {
        assert.deepEqual(checkNativeValues({ steps: [{ id: 'a', member: symbol }] }, [{ id: 'a', values: [false] }]), [{ id: 'a', values: [false] }]);
    }
});

test('transport uncertainty remains exit 4 without inventing a native rejection', async () => {
    const server = createServer(socket => socket.once('data', () => socket.destroy()));
    server.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Expected a listening TCP endpoint');
        await assert.rejects(executeProgram({ context: 'carly', steps: [{ id: 'a', member: 'tern.now' }] },
            { endpoint: String(address.port) }), { code: 'OUTCOME_UNKNOWN', exit: 4 });
    }
    finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('a signalled or unreported native CLI exit cannot establish failure after dispatch', () => {
    for (const signal of ['SIGTERM', 'SIGKILL', null]) {
        assert.throws(() => parseNativeResult({
            code: null, signal, stdout: 'submission accepted', stderr: 'partial native diagnostic',
        }), {
            code: 'OUTCOME_UNKNOWN', exit: 4,
            details: { code: null, signal, stderr: 'partial native diagnostic' },
        });
    }
});

test('an explicit native CLI failure remains distinct from an uncertain outcome', () => {
    assert.throws(() => parseNativeResult({
        code: 7, signal: null, stdout: '', stderr: 'native operation refused',
    }), {
        code: 'NATIVE_CLI_FAILED', exit: 1,
        details: { code: 7, stderr: 'native operation refused' },
    });
});

for (const [flag, value] of [['--timeout-ms', '0'], ['--endpoint', 'relative.sock']] as const) {
    test(`doctor refuses invalid ${flag} rather than reporting native unavailability`, async () => {
        const result = await runTern({ command: 'doctor', flags: {
            '--binary': `omp-kit-tern-missing-${crypto.randomUUID()}`, [flag]: value,
        } });
        assert.equal(result.code, 2);
        assert.equal(result.data.status, 'REFUSED');
    });
}

test('doctor keeps missing native binaries distinct from invalid requests', async () => {
    const result = await runTern({ command: 'doctor', flags: {
        '--binary': `omp-kit-tern-missing-${crypto.randomUUID()}`,
    } });
    assert.equal(result.code, 3);
    assert.equal(result.data.status, 'UNAVAILABLE');
});
