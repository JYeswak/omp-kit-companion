import { mkdirSync, lstatSync, writeFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TernError } from './model.ts';
export function digest(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function secureDirectory(path: string): void {
    if (!isAbsolute(path))
        throw new TernError('INVALID_STATE_ROOT', 'Receipt root must be absolute');
    let current = parse(path).root;
    for (const part of path.slice(current.length).split('/').filter(Boolean)) {
        current = join(current, part);
        try {
            mkdirSync(current, { mode: 0o700 });
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new TernError('UNSAFE_STATE_ROOT', 'Receipt path contains a symlink or non-directory');
    }
    const stat = lstatSync(path);
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
        throw new TernError('UNSAFE_STATE_ROOT', 'Receipt directory must be owned by the caller and mode 0700');
    if (realpathSync(path) !== path)
        throw new TernError('UNSAFE_STATE_ROOT', 'Receipt path must be canonical');
}
/** Isolated subjournal, deliberately not a fabricated omp-kit undo receipt. No arguments/results/secrets stored. */
export function startReceipt(operation: unknown, root?: string): {
    id: string;
    path: string;
    finish: (state: string, details?: unknown) => void;
} {
    const base = root ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'omp-kit', 'tern-runs');
    secureDirectory(base);
    const id = randomUUID(), path = join(base, id + '.jsonl');
    const append = (x: unknown) => writeFileSync(path, JSON.stringify(x) + '\n', { flag: 'a', mode: 0o600 });
    // Exclusive creation before any native effect. Raw input is deliberately absent.
    writeFileSync(path, JSON.stringify({ schema_version: 1, id, event: 'PREPARED', operation_sha256: digest(JSON.stringify(operation)), at: new Date().toISOString(), undo: 'NOT_AUTOMATIC' }) + '\n', { flag: 'wx', mode: 0o600 });
    return { id, path, finish: (state, details = null) => append({ id, event: state, at: new Date().toISOString(), details }) };
}
