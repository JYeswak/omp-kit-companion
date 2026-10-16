import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeMessage, encodeBlob, WireDecoder, validateFrame } from '../../src/tern/surface.ts';
function decode(bytes: Buffer, chunk = bytes.length) { const d = new WireDecoder(), out = []; for (let n = 0; n < bytes.length; n += chunk)
    out.push(...d.feed(bytes.subarray(n, n + chunk))); d.end(); return out; }
test('extra frame operands reject instead of changing operation meaning', () => {
    const ops = [['add', 'a', 'main', null, { id: 'a', k: 'text' }], ['set', 'a', { text: 'x' }], ['text', 'a', 'append', 'x'], ['splice', 'a', 0, 1, 'y'], ['move', 'a', 'main', null], ['del', 'a'], ['settle', 'a'], ['focus', 'a'], ['reveal', 'a', 'nearest'], ['scroll', 'a', 'page-down'], ['suspend'], ['resume']];
    for (const op of ops)
        assert.throws(() => validateFrame({ sf: 'main', s: 1, ops: [[...op, 'EXTRA']] }), { code: 'INVALID_FRAME_OP' });
});
test('large Unicode payload chunks and decodes across every-byte fragmentation', () => {
    const body = { text: '😀ñ'.repeat(3000) };
    const w = encodeMessage({ verb: 'r', body }, 128);
    const result = decode(w, 1);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.message?.body, body);
    for (const raw of w.toString('binary').split('\x1b\\').filter(Boolean))
        assert(Buffer.byteLength(raw, 'binary') + 2 <= 128);
    for (const raw of w.toString('binary').split('\x1b\\').filter(Boolean))
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'binary'));
});
test('native parameter-shaped chunk tails preserve exact bytes', () => {
    const body = { text: ('word=value;'.repeat(1000) + 'a=b;c=d;😀') };
    assert.deepEqual(decode(encodeMessage({ verb: 'r', body }, 128), 23)[0]?.message?.body, body);
});
test('blob IDs are SHA-256 checked at encode', () => {
    assert.throws(() => encodeMessage({ verb: 'b', params: { id: 'wrong' }, body: 'YQ==' }));
    const r = decode(encodeBlob(Buffer.from('hello'), 'text/plain', 128));
    assert.equal(r[0]?.message?.body, 'aGVsbG8=');
});
test('OSC 877 replies with BEL and ST parse without dropping ordinary bytes', () => {
    for (const term of ['\x07', '\x1b\\']) {
        const r = decode(Buffer.from('before\x1b]877;tsp;r;{"ok":1}' + term + 'after'), 2);
        assert.deepEqual(r.find(x => x.type === 'message')?.message?.body, { ok: 1 });
        assert.equal(Buffer.concat(r.filter(x => x.type === 'bytes').map(x => x.bytes!)).toString(), 'beforeafter');
    }
});
test('bracketed pasted protocol text is inert input, never a TSP event', () => {
    const w = Buffer.concat([Buffer.from('\x1b[200~'), encodeMessage({ verb: 'e', body: { ev: 'action' } }), Buffer.from('\x1b[201~')]);
    const r = decode(w, 1);
    assert(r.every(x => x.type === 'bytes'));
    assert(Buffer.concat(r.map(x => x.bytes!)).equals(w));
});
test('incomplete and interrupted sequences refuse rather than silently succeed', () => {
    const d = new WireDecoder();
    d.feed(Buffer.from('\x1b_tsp;'));
    assert.throws(() => d.end());
    const c = new WireDecoder();
    c.feed(Buffer.from('\x1b_tsp;r;c=abc;m=1;{"text":\x1b\\'));
    assert.throws(() => c.feed(Buffer.from('\x1b_tsp;e;{}\x1b\\')));
});
test('nonfinite values, malformed operations and caller-owned chunk headers refuse', () => {
    assert.throws(() => encodeMessage({ verb: 'r', body: { x: NaN } }));
    assert.throws(() => encodeMessage({ verb: 'f', body: { sf: 's', s: 1, ops: [['invented']] } }));
    assert.throws(() => encodeMessage({ verb: 'r', params: { c: 'attack' }, body: {} }));
});
test('source-documented sibling IDs and scroll directions reject index/coordinate impostors', () => {
    assert.throws(() => validateFrame({ sf: 's', s: 1, ops: [['move', 'a', 'main', 0]] }));
    assert.throws(() => validateFrame({ sf: 's', s: 1, ops: [['scroll', 'a', { y: 10 }]] }));
});

// Independent framing expectations follow the pinned SDK's key=value; scanner,
// not WireDecoder's output: typescript/src/wire.ts leadsWithParameter/chunkEnd and
// python/src/tern_sdk/wire.py split at f3f9fee82bf692166c2a477a895a347ac2a47ca2.
test('parameter-like continuation spanning the next budget retains every byte', () => {
    const text = 'z'.repeat(81) + 'a=' + 'x'.repeat(89) + ';';
    const json = '{"text":"' + text + '"}';
    const id = createHash('sha256').update(json).digest('hex').slice(0, 16);
    const expected = Buffer.from(
        `\x1b_tsp;r;id=x;c=${id};m=1;{"text":\x1b\\` +
        `\x1b_tsp;r;c=${id};m=1;"${'z'.repeat(81)}a=${'x'.repeat(11)}\x1b\\` +
        `\x1b_tsp;r;c=${id};${'x'.repeat(78)};"}\x1b\\`
    );
    const wire = encodeMessage({ verb: 'r', params: { id: 'x' }, body: { text } }, 128);
    assert.deepEqual(wire, expected);
    for (const size of [1, 2, 23, 127, wire.length]) {
        assert.deepEqual(decode(wire, size), [{ type: 'message', message: { verb: 'r', params: { id: 'x' }, body: { text } } }]);
    }
});

test('official-style independently framed chunks join before UTF-8 and JSON decoding', () => {
    const wire = Buffer.concat([
        Buffer.from('\x1b_tsp;r;id=source;c=abc;m=1;{"text":"'),
        Buffer.from([0xf0, 0x9f]),
        Buffer.from('\x1b\\\x1b_tsp;r;c=abc;'),
        Buffer.from([0x98, 0x80]),
        Buffer.from('a=b;c=d;"}\x1b\\'),
    ]);
    for (let split = 1; split < wire.length; split++) {
        const d = new WireDecoder();
        const result = [...d.feed(wire.subarray(0, split), 0), ...d.feed(wire.subarray(split), 1)];
        d.end();
        assert.deepEqual(result, [{ type: 'message', message: { verb: 'r', params: { id: 'source' }, body: { text: '😀a=b;c=d;' } } }]);
    }
});

test('complete APC byte budget is exact at the unchunked boundary', () => {
    const exact = encodeMessage({ verb: 'r', body: 'x'.repeat(116) }, 128);
    assert.equal(exact.length, 128);
    assert.equal(exact.toString(), '\x1b_tsp;r;"' + 'x'.repeat(116) + '"\x1b\\');
    const chunked = encodeMessage({ verb: 'r', body: 'x'.repeat(117) }, 128);
    const frames = chunked.toString('binary').split('\x1b\\').filter(Boolean);
    assert(frames.length > 1);
    assert(frames.every(frame => Buffer.byteLength(frame, 'binary') + 2 <= 128));
    assert.deepEqual(decode(chunked, 7)[0]?.message?.body, 'x'.repeat(117));
    for (const apc of [127, 262145, NaN, 128.5])
        assert.throws(() => encodeMessage({ verb: 'r', body: {} }, apc), { code: 'TSP_LIMIT' });
    assert.throws(() => encodeMessage({ verb: 'r', params: { id: 'x'.repeat(128) }, body: {} }, 128), { code: 'TSP_LIMIT' });
});

test('long ordinary text stays chunkable while unrepresentable key boundaries refuse', () => {
    const text = 'z'.repeat(512 * 1024);
    for (const ordinary of [text, text + '=x ;', text + '=x']) {
        const wire = encodeMessage({ verb: 'r', body: { text: ordinary } }, 128);
        assert.deepEqual(decode(wire)[0]?.message?.body, { text: ordinary });
    }
    // No native-safe boundary exists inside this key run within the complete APC
    // budget. Never use the SDK's forward fallback here, which would exceed our cap.
    assert.throws(() => encodeMessage({ verb: 'r', body: { text: text + '=x;' } }, 128), { code: 'TSP_CHUNK_BOUNDARY' });
    const value = 'a='.repeat(128 * 1024) + ';';
    assert.deepEqual(decode(encodeMessage({ verb: 'r', body: { text: value } }, 128))[0]?.message?.body, { text: value });
});

test('overflowing JSON numbers reject as structured finite-value errors, including OSC', () => {
    for (const [prefix, term] of [['\x1b_tsp;r;', '\x1b\\'], ['\x1b]877;tsp;r;', '\x07']]) {
        for (const json of ['{"x":1e400}', '{"nested":[-1e400]}', '1e400']) {
            for (const size of [1, 7, 1000])
                assert.throws(() => decode(Buffer.from(prefix + json + term), size), { name: 'TernError', code: 'TSP_JSON', exit: 2 });
        }
    }
    assert.deepEqual(decode(Buffer.from('\x1b_tsp;r;{"x":1e308,"zero":-0}\x1b\\'))[0]?.message?.body, { x: 1e308, zero: -0 });
    for (const x of [NaN, Infinity, -Infinity])
        assert.throws(() => encodeMessage({ verb: 'r', body: { x } }), { code: 'TSP_JSON' });
});

test('JSON depth bound is shared by encoding and decoding without stack-overflow errors', () => {
    for (const depth of [128, 129, 10000]) {
        const json = '['.repeat(depth) + '0' + ']'.repeat(depth);
        const body: unknown = JSON.parse(json);
        if (depth === 128) {
            assert.equal(encodeMessage({ verb: 'r', body }).toString(), '\x1b_tsp;r;' + json + '\x1b\\');
            assert.deepEqual(decode(Buffer.from('\x1b_tsp;r;' + json + '\x1b\\'), 3)[0]?.message?.body, body);
        } else {
            assert.throws(() => encodeMessage({ verb: 'r', body }), { name: 'TernError', code: 'TSP_LIMIT', exit: 2 });
            assert.throws(() => decode(Buffer.from('\x1b_tsp;r;' + json + '\x1b\\')), { name: 'TernError', code: 'TSP_LIMIT', exit: 2 });
        }
    }
    assert.throws(() => decode(Buffer.from('\x1b_tsp;r;{"x":}\x1b\\')), { code: 'TSP_PARSE' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => encodeMessage({ verb: 'r', body: cyclic }), { code: 'TSP_LIMIT' });
    assert.throws(() => encodeMessage({ verb: 'r', body: { x: undefined } }), { code: 'TSP_JSON' });
});

test('chunk interruption, expiry and incomplete streams keep structured errors', () => {
    for (const [next, now] of [
        ['\x1b_tsp;r;c=other;1}\x1b\\', 1],
        ['\x1b_tsp;e;c=a;1}\x1b\\', 1],
        ['\x1b_tsp;r;c=a;1}\x1b\\', 1001],
    ] as const) {
        const d = new WireDecoder();
        assert.deepEqual(d.feed(Buffer.from('\x1b_tsp;r;c=a;m=1;{"x":\x1b\\'), 0), []);
        assert.throws(() => d.feed(Buffer.from(next), now), { code: 'TSP_CHUNK_INTERRUPTED' });
    }
    for (const input of ['\x1b_', '\x1b[200~paste', '\x1b_tsp;r;c=a;m=1;{}\x1b\\']) {
        const d = new WireDecoder();
        d.feed(Buffer.from(input), 0);
        assert.throws(() => d.end(), { code: 'TSP_INCOMPLETE' });
    }
});

test('frame diagnostics do not claim native transaction rollback or apply document state', () => {
    const body = { sf: 's', s: 1, ops: [['del', 'missing'], ['text', 'a', 'append', 'kept']] };
    assert.equal(encodeMessage({ verb: 'f', body }).toString(), '\x1b_tsp;f;{"sf":"s","s":1,"ops":[["del","missing"],["text","a","append","kept"]]}\x1b\\');
    assert.deepEqual(decode(Buffer.from('\x1b_tsp;r;{"sf":"s","s":1,"errors":[{"op":0,"code":"missing"}]}\x1b\\'))[0]?.message?.body,
        { sf: 's', s: 1, errors: [{ op: 0, code: 'missing' }] });
});

test('joined and incomplete byte limits fail with typed errors before parsing', () => {
    const limit = 24 * 1024 * 1024;
    assert.throws(() => encodeMessage({ verb: 'r', body: 'x'.repeat(limit - 1) }), { code: 'TSP_LIMIT' });
    const d = new WireDecoder();
    assert.deepEqual(d.feed(Buffer.concat([
        Buffer.from('\x1b_tsp;r;c=large;m=1;'),
        Buffer.alloc(limit, 32),
        Buffer.from('\x1b\\'),
    ]), 0), []);
    assert.throws(() => d.feed(Buffer.from('\x1b_tsp;r;c=large;0\x1b\\'), 1), { code: 'TSP_LIMIT' });
    const incomplete = new WireDecoder();
    assert.throws(() => incomplete.feed(Buffer.concat([Buffer.from('\x1b_tsp;r;'), Buffer.alloc(limit + 4096, 32)])), { code: 'TSP_LIMIT' });
});
