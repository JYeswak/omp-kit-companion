#!/usr/bin/env python3
"""Fetch-backed source quotes and an offline, staged citation ratchet (SOURCEGATE1)."""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import fnmatch
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sys
import unicodedata
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, urlunsplit

from kitlib_io import atomic_replace_bytes
from kitlib_run import run
from kitlib_tmp import owned_tmp

LIMIT = 8 * 1024 * 1024
REGISTRY = 'docs/research/sources.jsonl'
BASELINE = '.omp/sources-baseline.json'
APPLICATION = 'docs/research/APPLICATION.md'
# Delimited, disjoint character classes; scans are bounded by LIMIT.
SRC = re.compile(r'\[src:([^\]\s]+)\]')
URL = re.compile(r'https?://[^\s<>\[\]()"\x27]+', re.IGNORECASE)
TRANSLATION = str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '−': '-'})


def normalize(text: str) -> str:
    return ' '.join(unicodedata.normalize('NFKC', text).translate(TRANSLATION).split())


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.in_title = False
        self.parts: list[str] = []
        self.title: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag == 'title':
            self.in_title = True
        if not self.hidden:
            self.parts.append(' ')

    def handle_endtag(self, tag: str) -> None:
        if tag in ('script', 'style') and self.hidden:
            self.hidden -= 1
        if tag == 'title':
            self.in_title = False
        if not self.hidden:
            self.parts.append(' ')

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)
            if self.in_title:
                self.title.append(data)


def fetch(url: str) -> dict:
    if urlsplit(url).scheme not in ('http', 'https'):
        raise ValueError('FETCH_FAILED: only http(s) URLs are supported')
    # An honest tool identity, not a browser imitation: cdc.gov answers 403 to "Mozilla/5.0 (compatible; ...)"
    # and 200 to this string (measured 2026-10-25).
    request = Request(url, headers={'User-Agent': 'omp-kit-sources/1.0 (+https://github.com/JYeswak/omp-kit-companion)'})
    with urlopen(request, timeout=30) as response:
        body = response.read(LIMIT + 1)
        if len(body) > LIMIT:
            raise ValueError('FETCH_FAILED: body exceeds 8 MiB')
        info = dict(final_url=response.geturl(), http_status=response.status,
                    content_type=response.headers.get('Content-Type', ''), body_sha256=sha(body))
        charset = response.headers.get_content_charset() or 'utf-8'
    title = ''
    if 'application/pdf' in info['content_type'].lower() or body.startswith(b'%PDF'):
        adapter = shutil.which('pdftotext')
        if not adapter:
            raise ValueError('UNSUPPORTED_CONTENT: PDF requires pdftotext on PATH')
        with owned_tmp('sources-pdf') as work:
            pdf = Path(work) / 'source.pdf'
            pdf.write_bytes(body)
            result = run([adapter, str(pdf), '-'], deadline_s=30, max_output_bytes=LIMIT)
            if result.rc != 0 or result.timed_out or result.truncated:
                raise ValueError('UNSUPPORTED_CONTENT: pdftotext failed or exceeded bounds')
            text = result.stdout.decode('utf-8')
    else:
        page = Page()
        page.feed(body.decode(charset, errors='replace'))
        text, title = ''.join(page.parts), ''.join(page.title)
    text = normalize(unescape(text))
    return dict(info, text=text, title=normalize(title), text_sha256=sha(text.encode()))


# Presentation, not content: a quote copied from a markdown rendering of a page carries backticks, emphasis, escapes,
# list bullets and inline tags that the page's text does not. Each pattern is linear (no nested quantifiers).
MARKUP = (
    (re.compile(r'<[^>]{1,200}>'), ''),
    (re.compile(r'\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)'), r'\1'),
    (re.compile(r'\\([\\`*_{}\[\]()#+.!|-])'), r'\1'),
    (re.compile(r'(?m)^[ \t]{0,8}[*+-][ \t]{1,8}'), ''),
    (re.compile(r'(?m)^:::[ \t]{0,8}[A-Za-z]{0,20}[ \t]{0,8}$'), ''),
    (re.compile(r'`|\*\*'), ''),
)


def strip_markup(quote: str) -> str:
    for pattern, replacement in MARKUP:
        quote = pattern.sub(replacement, quote)
    return quote


def quote_record(text: str, quote: str) -> dict:
    folded = text.casefold()
    original = quote
    needle = normalize(quote).casefold()
    index = folded.find(needle) if needle else -1
    if index < 0:
        # One retry with presentation markup removed; the stored text is the form actually found on the page.
        quote = strip_markup(quote)
        needle = normalize(quote).casefold()
        index = folded.find(needle) if needle else -1
    if index < 0:
        raise ValueError(f'QUOTE_NOT_FOUND: {original}')
    # Case folding can expand characters. Convert folded offsets back to the
    # normalized original-case text rather than slicing with folded indices.
    folded_position = 0
    start = end = 0
    for position, char in enumerate(text):
        next_position = folded_position + len(char.casefold())
        if folded_position <= index < next_position:
            start = position
        if next_position >= index + len(needle):
            end = position + 1
            break
        folded_position = next_position
    excerpt = text[max(0, start - 400):end + 400]
    record = dict(text=quote, excerpt=excerpt, excerpt_sha256=sha(excerpt.encode()))
    if quote != original:
        record['quoted_as'] = original
    return record


def load_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    ids = set()
    for row in rows:
        if row.get('schema') != 1 or not isinstance(row.get('id'), str) or row['id'] in ids:
            raise ValueError('INVALID_REGISTRY: schema or duplicate id')
        ids.add(row['id'])
        for key in ('url', 'final_url', 'quotes'):
            if key not in row:
                raise ValueError(f'INVALID_REGISTRY: missing {key}')
    return rows


def publish(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_replace_bytes(str(path.absolute()), data, mode=0o644, durability='full')


def canonical_url(url: str) -> str:
    parts = urlsplit(unescape(url))
    return urlunsplit(('https', parts.netloc.lower(), parts.path.rstrip('/'), parts.query, ''))


def application_sources(text: str) -> set[str]:
    """Read the application table; only complete, actionable rows grant coverage."""
    valid = set()
    columns = {}
    for line in text.splitlines():
        if not line.strip().startswith('|'):
            continue
        cells = [cell.strip().replace('`', '') for cell in line.strip().strip('|').split('|')]
        if cells and cells[0].casefold() == 'source':
            aliases = {'decision it changed': 'decision', 'applied by (artifact)': 'artifact'}
            columns = {aliases.get(cell.casefold(), cell.casefold()): i for i, cell in enumerate(cells)}
            continue
        if not all(key in columns for key in ('source', 'decision', 'artifact', 'status')):
            continue
        if len(cells) <= max(columns.values()):
            continue
        row = {key: cells[index] for key, index in columns.items()}
        status = row['status']
        if not row['decision'] or status not in ('cited', 'procedure', 'built-not-wired', 'applied', 'enforced'):
            continue
        def bead(value: str) -> bool:
            prefix, separator, suffix = value.partition('-')
            return bool(separator and prefix.isalnum() and suffix and
                        all(char.isalnum() or char in '.-' for char in suffix))
        def location(value: str) -> bool:
            path, separator, number = value.rpartition(':')
            return bool(separator and path and number.isdecimal() and int(number) > 0)
        if not any(location(token) or bead(token) for token in row['artifact'].split()):
            continue
        if status == 'cited' and not any(bead(token.strip(',')) for token in row.get('gap bead', '').split()):
            continue
        for source in row['source'].split(','):
            source = source.strip()
            marker = SRC.fullmatch(source)
            valid.add(marker[1] if marker else source)
    return valid


def findings(files: dict[str, str], rows: list[dict], application: str = '') -> list[dict]:
    result = []
    ids = {row['id'] for row in rows}
    urls = {canonical_url(row[key]) for row in rows for key in ('url', 'final_url')}
    applied = application_sources(application)
    for row in rows:
        for quote in row['quotes']:
            excerpt = quote.get('excerpt', '')
            if (not normalize(quote.get('text', '')) or
                    normalize(quote['text']).casefold() not in normalize(excerpt).casefold() or
                    sha(excerpt.encode()) != quote.get('excerpt_sha256')):
                result.append(dict(file=REGISTRY, code='EXCERPT_TAMPERED', detail=row['id']))
    for name, text in files.items():
        if len(text.encode()) > LIMIT:
            raise ValueError(f'FILE_TOO_LARGE: {name}')
        lower = text.casefold()
        for marker in ('[standard reading]', 'cited from memory'):
            for _ in range(lower.count(marker)):
                result.append(dict(file=name, code='MEMORY_CITATION', detail=marker))
        cited = set()
        for match in SRC.finditer(text):
            if match[1] not in ids:
                result.append(dict(file=name, code='UNRESOLVED_SRC', detail=match[1]))
            else:
                cited.add(match[1])
        for match in URL.finditer(text):
            if canonical_url(match[0]) not in urls:
                result.append(dict(file=name, code='UNREGISTERED_LINK', detail=match[0]))
            else:
                cited.update(row['id'] for row in rows if canonical_url(match[0]) in
                             (canonical_url(row['url']), canonical_url(row['final_url'])))
        for ident in sorted(cited - applied):
            result.append(dict(file=name, code='APPLICATION_MISSING', detail=ident))
    return result


def baseline_data(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError('INVALID_BASELINE: expected a file-to-finding map')
    for name, codes in data.items():
        if not isinstance(name, str) or not isinstance(codes, dict):
            raise ValueError('INVALID_BASELINE: expected a file-to-finding map')
        for code, identities in codes.items():
            if type(identities) is int:
                raise ValueError('INVALID_BASELINE: legacy count format has no finding identities; '
                                 'review original links and replace counts with normalized URL lists')
            if (code != 'UNREGISTERED_LINK' or not isinstance(identities, list) or
                    any(not isinstance(url, str) or not URL.fullmatch(url) or
                        canonical_url(url) != url for url in identities) or
                    len(set(identities)) != len(identities)):
                raise ValueError('INVALID_BASELINE: only unique normalized UNREGISTERED_LINK URL lists allowed')
    return data


def baseline(path: Path) -> dict:
    return baseline_data(json.loads(path.read_text()) if path.exists() else {})


def within_baseline(current: dict, ceiling: dict) -> bool:
    return all(set(codes.get('UNREGISTERED_LINK', [])) <=
               set(ceiling.get(name, {}).get('UNREGISTERED_LINK', []))
               for name, codes in current.items())


def judge(files: dict[str, str], rows: list[dict], old: dict, write: Path | None = None,
          application: str = '') -> tuple[list, int]:
    baseline_data(old)
    found = findings(files, rows, application)
    current = {name: dict(codes) for name, codes in old.items() if name not in files}
    for name in files:
        identities = sorted({canonical_url(f['detail']) for f in found
                             if f['file'] == name and f['code'] == 'UNREGISTERED_LINK'})
        if identities:
            current[name] = {'UNREGISTERED_LINK': identities}
    if write is not None:
        if write.exists() and not within_baseline(current, old):
            raise ValueError('BASELINE_RAISED: new finding identities are not allowed')
        if any(f['code'] != 'UNREGISTERED_LINK' for f in found):
            return found, 1
        publish(write, (json.dumps(current, indent=2, sort_keys=True) + '\n').encode())
        return found, 0
    for item in found:
        item['covered'] = (item['code'] == 'UNREGISTERED_LINK' and canonical_url(item['detail']) in
                           old.get(item['file'], {}).get('UNREGISTERED_LINK', []))
    return found, int(any(not item['covered'] for item in found))


def git(repo: Path, *args: str, missing: bool = False) -> bytes | None:
    result = run(['git', '-C', str(repo), *args], deadline_s=30, max_output_bytes=LIMIT)
    if missing and result.rc == 128 and not result.timed_out and not result.truncated:
        return None
    if result.rc != 0 or result.timed_out or result.truncated:
        raise ValueError('GIT_FAILED: ' + result.stderr.decode(errors='replace'))
    return result.stdout


def staged(repo: Path) -> int:
    config = repo / '.omp/sources.toml'
    if not config.exists():
        return 0
    # Only this top-level key is supported; literal_eval accepts quoted arrays,
    # including multiline arrays, without a Python 3.11 tomllib dependency.
    content = config.read_text().strip()
    key, separator, value = content.partition('=')
    if key.strip() != 'globs' or not separator:
        raise ValueError('INVALID_CONFIG: expected globs = ["*.md"]')
    globs = ast.literal_eval(value.strip())
    if not isinstance(globs, list) or not all(isinstance(x, str) for x in globs):
        raise ValueError('INVALID_CONFIG: globs must be strings')
    names_blob = git(repo, 'diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z')
    assert names_blob is not None
    names = names_blob.decode().split('\0')
    selected = [name for name in names if name.endswith('.md') and any(
        fnmatch.fnmatchcase(name, pattern) or Path(name).match(pattern) for pattern in globs)]
    # Registry and baseline are also read from the index, never from an
    # unstaged working-tree edit. HEAD is the ceiling for a staged baseline.
    rows_blob = git(repo, 'show', ':' + REGISTRY, missing=True)
    base_blob = git(repo, 'show', ':' + BASELINE, missing=True)
    head_blob = git(repo, 'show', 'HEAD:' + BASELINE, missing=True)
    old = baseline_data(json.loads(base_blob) if base_blob else {})
    ceiling = baseline_data(json.loads(head_blob) if head_blob else {})
    if head_blob and not within_baseline(old, ceiling):
        raise ValueError('BASELINE_RAISED: staged baseline must only shrink')
    application_blob = git(repo, 'show', ':' + APPLICATION, missing=True)
    root = repo / 'var/agent-tmp'
    root.mkdir(parents=True, exist_ok=True)
    os.environ['TMPDIR'] = str(root)
    with owned_tmp('staged-sources') as work:
        work = Path(work)
        registry = work / 'sources.jsonl'
        registry.write_bytes(rows_blob or b'')
        bp = work / 'baseline.json'
        bp.write_bytes(base_blob or b'{}')
        old = baseline(bp)
        files = {}
        for number, name in enumerate(selected):
            target = work / str(number)
            blob = git(repo, 'show', ':' + name)
            assert blob is not None
            target.write_bytes(blob)
            files[name] = target.read_text()
        found, rc = judge(files, load_rows(registry), old,
                          application=(application_blob or b'').decode())
    for item in found:
        print(f"{item['file']}: {item['code']}: {item['detail']}")
    return rc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('add', 'check', 'verify', 'staged'):
        p = sub.add_parser(command)
        p.add_argument('--repo', type=Path, default=Path.cwd())
        p.add_argument('--registry', type=Path)
        if command == 'add':
            for key in ('url', 'claim', 'id'):
                p.add_argument('--' + key, required=True)
            p.add_argument('--quote', action='append', required=True)
            p.add_argument('--by', default=os.environ.get('AGENT_NAME', 'unknown'))
            p.add_argument('--replace', action='store_true')
        if command == 'check':
            p.add_argument('files', nargs='+')
            p.add_argument('--baseline', type=Path)
            p.add_argument('--json', action='store_true')
            p.add_argument('--write-baseline', action='store_true')
        if command == 'verify':
            p.add_argument('--ids', nargs='+')
    args = parser.parse_args(argv)
    try:
        repo = args.repo.absolute()
        registry = args.registry or repo / REGISTRY
        if not registry.is_absolute():
            registry = repo / registry
        if args.command == 'staged':
            return staged(repo)
        rows = load_rows(registry)
        if args.command == 'add':
            if any(row['id'] == args.id for row in rows) and not args.replace:
                raise ValueError('DUPLICATE_ID: ' + args.id)
            page = fetch(args.url)
            quotes = [quote_record(page['text'], quote) for quote in args.quote]
            page.pop('text')
            row = dict(page, schema=1, id=args.id, url=args.url, quotes=quotes,
                       retrieved_at=datetime.now(timezone.utc).isoformat(), claim=args.claim, by=args.by)
            rows = [r for r in rows if r['id'] != args.id] + [row]
            publish(registry, ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows).encode())
            print('ADDED: ' + args.id)
            return 0
        if args.command == 'check':
            bp = args.baseline or repo / BASELINE
            if not bp.is_absolute():
                bp = repo / bp
            files = {name: (repo / name).read_text() for name in args.files}
            application = repo / APPLICATION
            found, rc = judge(files, rows, baseline(bp), bp if args.write_baseline else None,
                              application=application.read_text() if application.exists() else '')
            if args.json:
                print(json.dumps(found))
            else:
                for item in found:
                    print(f"{item['file']}: {item['code']}: {item['detail']}")
            return rc
        wanted = set(args.ids or [row['id'] for row in rows])
        unknown = wanted - {row['id'] for row in rows}
        failed = bool(unknown)
        for name in sorted(unknown):
            print(name + ': FETCH_FAILED: unknown id')
        for row in rows:
            if row['id'] not in wanted:
                continue
            try:
                text = fetch(row['url'])['text']
                for quote in row['quotes']:
                    quote_record(text, quote['text'])
                status = 'OK'
            except ValueError as error:
                status = 'QUOTE_MISSING' if str(error).startswith('QUOTE_NOT_FOUND:') else 'FETCH_FAILED'
            except (OSError, LookupError) as error:
                status = 'FETCH_FAILED'
            print(row['id'] + ': ' + status)
            failed |= status != 'OK'
        return int(failed)
    except (OSError, ValueError, KeyError, TypeError, SyntaxError, LookupError) as error:
        print(str(error), file=sys.stderr)
        return 2 if str(error).startswith('UNSUPPORTED_CONTENT:') else 1


if __name__ == '__main__':
    sys.exit(main())
