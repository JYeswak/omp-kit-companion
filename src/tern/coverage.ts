import { createHash } from 'node:crypto';
import { CATALOG, MEMBERS, record, TernError } from './model.ts';
import routes from '../../scripts/tern-script-routes.json';
/** Lexes declaration syntax, excluding comments and string contents. No SDK name list is used here. */
export function tokens(source: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
        if (/\s/.test(source[i]!)) {
            i++;
            continue;
        }
        if (source.startsWith('--', i)) {
            const long = source.slice(i + 2).match(/^\[(=*)\[/);
            if (long) {
                const end = ']' + long[1] + ']';
                const j = source.indexOf(end, i + 2 + long[0].length);
                i = j < 0 ? source.length : j + end.length;
            }
            else {
                const j = source.indexOf('\n', i);
                i = j < 0 ? source.length : j + 1;
            }
            continue;
        }
        const c = source[i]!;
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < source.length) {
                if (source[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (source[j] === c) {
                    j++;
                    break;
                }
                j++;
            }
            out.push('STRING');
            i = j;
            continue;
        }
        const identifier = source.slice(i).match(/^[A-Za-z_][\w]*/);
        if (identifier) {
            out.push(identifier[0]);
            i += identifier[0].length;
            continue;
        }
        if (source.startsWith('->', i)) {
            out.push('->');
            i += 2;
            continue;
        }
        out.push(c);
        i++;
    }
    return out;
}
function close(t: string[], i: number): number {
    const pair: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
    const end = pair[t[i]!]!;
    let j = i + 1;
    for (; j < t.length; j++) {
        if (pair[t[j]!])
            j = close(t, j);
        else if (t[j] === end)
            return j;
    }
    throw new Error('Unbalanced declaration input');
}
function tableMembers(t: string[], start: number, prefix: string): {
    name: string;
    signature: string;
}[] {
    const out: {
        name: string;
        signature: string;
    }[] = [];
    const end = close(t, start);
    let i = start + 1;
    while (i < end) {
        if (t[i] === ',' || t[i] === ';') {
            i++;
            continue;
        }
        const name = t[i];
        if (!name || !/^\w+$/.test(name) || t[i + 1] !== ':') {
            throw new Error(`Unrecognized table declaration in ${prefix} near ${t.slice(i, i + 8).join(' ')}`);
        }
        i += 2;
        const a = i;
        while (i < end) {
            if (['{', '(', '['].includes(t[i]!)) {
                i = close(t, i) + 1;
                continue;
            }
            if (t[i] === ',' || t[i] === ';')
                break;
            i++;
        }
        const value = t.slice(a, i);
        if (value[0] === '{' && close(t, a) === i - 1)
            out.push(...tableMembers(t, a, prefix + '.' + name));
        else if (value.includes('->'))
            out.push({ name: prefix + '.' + name, signature: value.join(' ') });
    }
    return out;
}
export interface Extracted {
    symbols: string[];
    signatures: Record<string, string>;
    unknownOwners: string[];
    duplicates: string[];
}
export function extractDeclarations(source: string): Extracted {
    const t = tokens(source);
    const symbols = new Set<string>(), signatures: Record<string, string> = {};
    const unknownOwners: string[] = [], duplicates: string[] = [];
    // Semantic owner translation, not a list of methods. New methods are still discovered independently.
    const owners: Record<string, string> = { WindowCx: 'cx', EffectCx: 'effect', BlockCx: 'block', TimerHandle: 'handle.TimerHandle', ExportCall: 'handle.ExportCall', Agent: 'handle.Agent', Awaitable: 'handle.Awaitable' };
    for (const m of MEMBERS) {
        if (m.declaring_type && m.symbol.startsWith('cx.'))
            owners[m.declaring_type] = m.symbol.slice(0, m.symbol.lastIndexOf('.'));
    }
    function add(name: string, sig: string) {
        if (symbols.has(name))
            duplicates.push(name);
        symbols.add(name);
        signatures[name] = sig;
    }
    for (let i = 0; i < t.length; i++) {
        if (t[i] === 'declare' && t[i + 1] === 'tern' && t[i + 2] === ':' && t[i + 3] === '{') {
            for (const m of tableMembers(t, i + 3, 'tern'))
                add(m.name, m.signature);
            i = close(t, i + 3);
            continue;
        }
        if (t[i] === 'declare' && t[i + 1] === 'extern' && t[i + 2] === 'type') {
            const owner = t[i + 3]!;
            let j = i + 4;
            while (j < t.length && t[j] !== 'with')
                j++;
            for (j++; j < t.length && t[j] !== 'end'; j++)
                if (t[j] === 'function') {
                    const name = t[j + 1]!;
                    let k = j + 2;
                    if (t[k] !== '(')
                        throw new Error('Malformed extern function');
                    k = close(t, k) + 1;
                    if (t[k] === ':')
                        k++;
                    while (k < t.length && t[k] !== 'function' && t[k] !== 'end')
                        k++;
                    if (!owners[owner])
                        unknownOwners.push(owner + '.' + name);
                    else
                        add(owners[owner] + '.' + name, t.slice(j + 2, k).join(' '));
                    j = k - 1;
                }
            i = j;
            continue;
        }
        if (t[i] === 'export' && t[i + 1] === 'type') {
            const owner = t[i + 2]!;
            if (!['Awaitable', 'Agent', 'TimerHandle', 'BlockDef', 'LensDef', 'CommandDef'].includes(owner))
                continue;
            let j = i + 3;
            while (j < t.length && t[j] !== '=')
                j++;
            if (t[j + 1] !== '{')
                throw new Error(`Unsupported ${owner} definition; audit required`);
            const prefix = owners[owner] ?? owner;
            for (const m of tableMembers(t, j + 1, prefix))
                add(m.name, m.signature);
            i = close(t, j + 1);
        }
    }
    return { symbols: [...symbols].sort(), signatures, unknownOwners, duplicates };
}
/** Upstream declarations first, mapped catalog second: missing means unmapped upstream API. */
export function compareInventory(declared: string[], mapped: string[]): {
    missing: string[];
    unexpected: string[];
    duplicates: string[];
} {
    const a = new Set(declared), b = new Set(mapped);
    return { missing: [...a].filter(x => !b.has(x)).sort(), unexpected: [...b].filter(x => !a.has(x)).sort(), duplicates: mapped.filter((v, i) => mapped.indexOf(v) !== i) };
}
export function verifySdk(bytes: Buffer, expected = MEMBERS.map(m => m.symbol)) {
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const extraction = extractDeclarations(bytes.toString('utf8'));
    const diff = compareInventory(extraction.symbols, expected);
    const pass = extraction.symbols.length > 0 && !diff.missing.length && !diff.unexpected.length && !diff.duplicates.length && !extraction.duplicates.length && !extraction.unknownOwners.length;
    return { scope: 'DECLARED_CALLABLE_COVERAGE', status: pass && blob === CATALOG.sdk_git_blob ? 'PASS' : 'FAIL', mapping_pass: pass,
        current_git_blob: blob, reviewed_git_blob: CATALOG.sdk_git_blob, source_changed: blob !== CATALOG.sdk_git_blob,
        declared: extraction.symbols.length, mapped: extraction.symbols.filter(s => expected.includes(s)).length,
        ...diff, declaration_duplicates: extraction.duplicates, unknown_owners: extraction.unknownOwners, signatures: extraction.signatures,
        live_verified: 0, note: 'A matching inventory and source fingerprint prove declaration mapping only. They do not execute Tern, validate every option, or certify runtime behavior.' };
}

/**
 * Compare a census's complete page/hash inventory with an explicit caller baseline.
 * Embedded lock_status is never evidence; equality is not human approval/native proof.
 */
export function docsReport(value: unknown, baseline?: unknown): Record<string, unknown> {
    if (!record(value) || value.schema_version !== 1 || value.scope !== 'SCRIPT_DOCUMENTATION_TABLE_ROWS' ||
        !Array.isArray(value.pages) || value.pages.length > 100)
        throw new TernError('INVALID_DOCS_REPORT', 'Expected a docs-census v1 report with at most 100 pages');
    const required = ['scripts/index.html', ...Object.keys(routes.pages)];
    const found = new Map<string, string>();
    const duplicates: string[] = [], unknown: string[] = [];
    let unusable = 0, rows = 0;
    const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
    for (const page of value.pages) {
        if (!record(page) || typeof page.path !== 'string') {
            unusable++;
            continue;
        }
        if (found.has(page.path))
            duplicates.push(page.path);
        // Never silently omit new linked families or error pages from comparison.
        found.set(page.path, typeof page.sha256 === 'string' ? page.sha256 : '');
        if (!required.includes(page.path) || page.known_family !== true)
            unknown.push(page.path);
        if (page.error !== undefined || !hash(page.sha256) || !Array.isArray(page.rows) ||
            page.rows.some(row => !record(row) || !Number.isSafeInteger(row.line) || Number(row.line) < 1 ||
                typeof row.heading !== 'string' || typeof row.first_cell !== 'string')) {
            unusable++;
            continue;
        }
        rows += page.rows.length;
    }
    const missing = required.filter(path => !found.has(path));
    const added: string[] = [], removed: string[] = [], changed: string[] = [];
    if (baseline !== undefined) {
        if (!record(baseline) || !record(baseline.pages) || Object.keys(baseline.pages).length > 100 ||
            Object.entries(baseline.pages).some(([path, digest]) => !path || !hash(digest)))
            throw new TernError('INVALID_DOCS_BASELINE', 'Expected an explicit {pages:{path:sha256}} baseline');
        for (const [path, digest] of found) {
            if (!Object.hasOwn(baseline.pages, path))
                added.push(path);
            else if (baseline.pages[path] !== digest)
                changed.push(path);
        }
        for (const path of Object.keys(baseline.pages))
            if (!found.has(path))
                removed.push(path);
    }
    const invalid = missing.length > 0 || unusable > 0 || duplicates.length > 0 || unknown.length > 0;
    const drift = added.length > 0 || removed.length > 0 || changed.length > 0;
    const sourceLock = invalid ? 'FAIL' : baseline === undefined ? 'UNREVIEWED' : drift ? 'DRIFT' : 'MATCH';
    return {
        status: invalid || drift ? 'FAIL' : 'INVENTORIED',
        missing_pages: missing, unusable_pages: unusable, duplicate_pages: duplicates.sort(), unknown_pages: unknown.sort(),
        added_pages: added.sort(), removed_pages: removed.sort(), changed_pages: changed.sort(),
        pages: value.pages.length, table_rows: rows, source_lock: sourceLock,
        semantic_coverage: 'REQUIRES_REVIEW', native_path: 'ctl/script, exact native grammar forwarded',
    };
}
