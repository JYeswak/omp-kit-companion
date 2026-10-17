#!/usr/bin/env python3
"""Independent, read-only docs census. No automatic approval or lock regeneration.
Fetches published Markdown pages, follows the scripts index for added families,
preserves every table's first cell with its heading and source line. A first run
is UNREVIEWED (exit 3). A supplied reviewed lock must match all bytes (exit 0);
new/changed/missing pages fail (exit 1). This is not semantic runtime proof.
"""
# Adapted from omp-kit-tern bundle 5330617e644953da3c973984b342c9e553f9392a7dd88bf6e88b870b5ce90929.
# Copyright (c) 2026 Contributors to the OMP Kit Tern integration; MIT (src/tern/LICENSE).
from __future__ import annotations
import argparse
from collections.abc import Callable
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urljoin, urlparse
from urllib.error import URLError
ROOT = "https://docs.stencil.so/tern/"
LIMIT = 4 * 1024 * 1024


def table_rows(text: str) -> list[dict]:
    lines = text.splitlines(); result = []; heading = []; in_table = False
    for n, line in enumerate(lines, 1):
        if re.match(r"^#{1,6}\s", line):
            depth = len(line) - len(line.lstrip('#'))
            heading = heading[:depth-1] + [line[depth:].strip()]
        stripped = line.strip().strip('|').strip()
        if '|' not in stripped:
            in_table = False; continue
        if re.match(r"^\s*:?-+:?\s*\|", stripped):
            in_table = True; continue
        if in_table:
            # Split only unescaped pipes outside inline-code spans.
            cell = []; code = False; escaped = False
            for ch in stripped:
                if ch == '|' and not escaped and not code: break
                cell.append(ch)
                if ch == '`' and not escaped: code = not code
                escaped = ch == '\\' and not escaped
            first = ''.join(cell).strip()
            result.append({'line': n, 'heading': ' / '.join(heading), 'first_cell': first})
    return result


def collect(fetch: Callable[[str], str]) -> dict:
    routes = json.loads(Path(__file__).resolve().with_name('tern-script-routes.json').read_text(encoding='utf-8'))
    pending = {'scripts/index.html', *routes['pages']}; pages = []; seen = set()
    while pending:
        path = sorted(pending)[0]; pending.remove(path)
        if path in seen: continue
        seen.add(path)
        if len(seen) > 100: raise ValueError('Too many pages; manual audit required')
        try:
            text = fetch(path)
            if not text.strip(): raise ValueError('Empty page')
            for link in re.findall(r'\]\(([^)\s]+)', text):
                url = urljoin(ROOT+path, link); p = urlparse(url)
                if p.netloc != 'docs.stencil.so' or not p.path.startswith('/tern/scripts/'): continue
                child = p.path[len('/tern/'):]
                if child.endswith('.md'): child=child[:-3]+'.html'
                if child.endswith('.html') and '..' not in child.split('/'): pending.add(child)
            pages.append({'path':path,'url':ROOT+path,'sha256':hashlib.sha256(text.encode()).hexdigest(),
                          'rows':table_rows(text),'route':'NATIVE_GRAMMAR_DELEGATED',
                          'known_family':path in routes['pages'] or path=='scripts/index.html'})
        except (OSError, ValueError, UnicodeError, URLError) as e:
            pages.append({'path':path,'error':str(e),'rows':[]})
    return {'schema_version':1,'basis':'independently fetched published Markdown',
            'scope':'SCRIPT_DOCUMENTATION_TABLE_ROWS','pages':pages,
            'not_proven':['semantic effect of each verb','all option combinations','live Tern runtime']}


def compare_lock(report: dict, lock: dict | None) -> tuple[str, int]:
    pages = report['pages']
    if any(p.get('error') or not p.get('known_family') for p in pages): return 'FAIL', 1
    if lock is None: return 'UNREVIEWED', 3
    now = {p['path']:p.get('sha256') for p in pages}
    return ('MATCH',0) if now == lock.get('pages') else ('DRIFT',1)


def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out',type=Path,required=True)
    ap.add_argument('--lock',type=Path,help='Previously reviewed {pages:{path:sha256}}; never overwritten')
    ap.add_argument('--source-dir',type=Path,help='Read independently captured .md pages instead of network')
    args=ap.parse_args()
    def fetch(path: str) -> str:
        relative=path[:-5]+'.md'
        if args.source_dir:
            raw=(args.source_dir/relative).read_bytes()
        else:
            with urlopen(Request(ROOT+relative,headers={'User-Agent':'omp-kit-tern-census/0.1'}),timeout=15) as r:
                raw=r.read(LIMIT+1)
        if len(raw)>LIMIT: raise ValueError('Page exceeds 4 MiB')
        return raw.decode('utf-8',errors='strict')
    report=collect(fetch)
    lock=json.loads(args.lock.read_text()) if args.lock else None
    status, code=compare_lock(report,lock);report['lock_status']=status
    # Exclusive output; a failure cannot overwrite a prior source record.
    with args.out.open('x',encoding='utf-8') as f: json.dump(report,f,indent=2);f.write('\n')
    print(json.dumps({'status':status,'pages':len(report['pages']),'table_rows':sum(len(p['rows']) for p in report['pages']), 'report':str(args.out)}))
    return code
if __name__=='__main__':
    try: raise SystemExit(main())
    except (OSError,ValueError) as e: print(str(e),file=sys.stderr);raise SystemExit(2)
