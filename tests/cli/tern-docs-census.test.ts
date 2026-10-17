import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import routes from '../../scripts/tern-script-routes.json';

// Ported from the supplied MIT omp-kit-tern docs_census_test.py. Exercise the
// real Python entry point on owned captured Markdown, never public network state.
const root = resolve(import.meta.dir, '../..');
const scratch = join(root, 'var/agent-tmp');
const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});

const markdown = '## SQLite\n| Action | Meaning |\n|---|---|\n| `query` | Execute SQL |\n| `a\\|b` | Literal pipe |\n';
const paths = ['scripts/index.html', ...Object.keys(routes.pages)];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const capturedPath = (directory: string, page: string) => join(directory, `${page.slice(0, -5)}.md`);

async function fixture() {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'tern-docs-census-test-'));
  owned.push(directory);
  for (const page of paths) {
    const path = capturedPath(directory, page);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
  }
  // This is an independently specified synthetic lock, not approval of a crawl.
  const lock = join(directory, 'reviewed-lock.json');
  const lockBytes = `${JSON.stringify({ pages: Object.fromEntries(paths.map(page => [page, digest(markdown)])) })}\n`;
  await writeFile(lock, lockBytes);
  return { directory, lock, lockBytes };
}

interface Page {
  path: string;
  error?: string;
  known_family?: boolean;
  sha256?: string;
  rows: { line: number; heading: string; first_cell: string }[];
}
interface Report { lock_status: string; pages: Page[] }
async function crawl(directory: string, name: string, lock?: string) {
  const out = join(directory, `${name}.json`);
  const process = Bun.spawn(['python3', join(root, 'scripts/tern-docs-census.py'),
    '--source-dir', directory, '--out', out, ...(lock ? ['--lock', lock] : [])],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  const report: Report = JSON.parse(await readFile(out, 'utf8'));
  return { code, stdout, stderr, report };
}

test('census preserves leaf cells, source lines and heading context', async () => {
  const { directory } = await fixture();
  const result = await crawl(directory, 'context');
  const page = result.report.pages.find(page => page.path === 'scripts/index.html');
  expect(page?.rows).toEqual([
    { line: 4, heading: 'SQLite', first_cell: '`query`' },
    { line: 5, heading: 'SQLite', first_cell: '`a\\|b`' },
  ]);
  expect(page?.sha256).toBe(digest(markdown));
});

test('first crawl is UNREVIEWED with exit 3, not an approved baseline', async () => {
  const { directory } = await fixture();
  const result = await crawl(directory, 'unreviewed');
  expect(result.code).toBe(3);
  expect(result.stderr).toBe('');
  expect(result.report.lock_status).toBe('UNREVIEWED');
  expect(JSON.parse(result.stdout).status).toBe('UNREVIEWED');
});

test('explicit reviewed fixture lock matches; changed page bytes drift without lock writes', async () => {
  const { directory, lock, lockBytes } = await fixture();
  const match = await crawl(directory, 'match', lock);
  expect(match.code).toBe(0);
  expect(match.report.lock_status).toBe('MATCH');
  await writeFile(capturedPath(directory, 'scripts/index.html'), `${markdown}\nChanged documentation.\n`);
  const drift = await crawl(directory, 'drift', lock);
  expect(drift.code).toBe(1);
  expect(drift.report.lock_status).toBe('DRIFT');
  expect(await readFile(lock, 'utf8')).toBe(lockBytes);
});

test('a newly linked family is fetched and fails even with a previously matching lock', async () => {
  const { directory, lock } = await fixture();
  await writeFile(capturedPath(directory, 'scripts/index.html'), `${markdown}\n[Future](future.md)\n`);
  await writeFile(capturedPath(directory, 'scripts/future.html'), '## Future\n| Verb | Meaning |\n|---|---|\n| `launch` | New operation |\n');
  const result = await crawl(directory, 'new-family', lock);
  expect(result.code).toBe(1);
  expect(result.report.lock_status).toBe('FAIL');
  expect(result.report.pages.find(page => page.path === 'scripts/future.html')).toMatchObject({
    known_family: false, rows: [{ line: 4, heading: 'Future', first_cell: '`launch`' }],
  });
});

test('a missing required page produces an error instead of a zero-verbs success', async () => {
  const { directory, lock } = await fixture();
  await rm(capturedPath(directory, 'scripts/index.html'));
  const result = await crawl(directory, 'missing', lock);
  expect(result.code).toBe(1);
  expect(result.report.lock_status).toBe('FAIL');
  const missing = result.report.pages.find(page => page.path === 'scripts/index.html');
  expect(missing?.error).toBeString();
  expect(missing?.error?.length).toBeGreaterThan(0);
  expect(missing?.rows).toEqual([]);
});

test('a wrong reviewed hash fails without regenerating or approving the baseline', async () => {
  const { directory, lock } = await fixture();
  const lockBytes = JSON.stringify({ pages: Object.fromEntries(paths.map(page => [page, '0'.repeat(64)])) });
  await writeFile(lock, lockBytes);
  const result = await crawl(directory, 'bad-hashes', lock);
  expect(result.code).toBe(1);
  expect(result.report.lock_status).toBe('DRIFT');
  expect(await readFile(lock, 'utf8')).toBe(lockBytes);
});

test('invalid UTF-8 is reported as a source error', async () => {
  const { directory } = await fixture();
  await writeFile(capturedPath(directory, 'scripts/index.html'), new Uint8Array([0xff]));
  const result = await crawl(directory, 'invalid-encoding');
  expect(result.code).toBe(1);
  expect(result.report.lock_status).toBe('FAIL');
  expect(result.report.pages.find(page => page.path === 'scripts/index.html')?.error).toContain('utf-8');
});
