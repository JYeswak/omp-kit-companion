#!/usr/bin/env python3
"""SOURCEGATE1 paired controls, negatives and matching mutant; stdlib only."""
from __future__ import annotations
import contextlib
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import threading
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import sources
from kitlib_tmp import owned_tmp

PAGE = b'<title>Fixture</title><script>secret</script><p>The verified words are here.</p>'

class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, format: str, *args: object) -> None:
        pass


def main() -> None:
    global PAGE
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    count = 0
    try:
        with owned_tmp('sources-test') as work:
            repo = Path(work)
            url = f'http://127.0.0.1:{server.server_port}/page'
            def cli(*args: str) -> tuple[int, str]:
                out = io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    rc = sources.main([args[0], '--repo', str(repo), *args[1:]])
                return rc, out.getvalue()
            def add(quote: str, ident: str = 'fixture') -> tuple[int, str]:
                return cli('add', '--url', url, '--quote', quote, '--claim', 'Fixture claim', '--id', ident)
            registry = repo / sources.REGISTRY
            assert add('verified words')[0] == 0
            row = sources.load_rows(registry)[0]
            assert row['title'] == 'Fixture' and row['quotes'][0]['text'] == 'verified words'
            count += 1
            before = registry.read_bytes()
            rc, out = add('absent words', 'absent')
            assert rc == 1 and 'QUOTE_NOT_FOUND' in out and registry.read_bytes() == before
            count += 1
            assert add('secret', 'hidden')[0] == 1
            assert add('verified words')[0] == 1
            count += 2
            # A quote copied from a markdown rendering ("**verified** `words`") matches the page text, and the
            # row stores the form found on the page; markup stripping cannot make absent words match.
            assert add('The **verified** `words` are here', 'markdown')[0] == 0
            stored = [r for r in sources.load_rows(registry) if r['id'] == 'markdown'][0]['quotes'][0]
            assert stored['text'] == 'The verified words are here' and stored['quoted_as'].startswith('The **')
            assert add('The **unverified** `words`', 'markdown-absent')[0] == 1
            count += 2
            doc = repo / 'plan.md'
            doc.write_text('[src:fixture]')
            application = repo / sources.APPLICATION
            header = '| Source | Decision | Artifact | Status | Gap bead |\n|---|---|---|---|---|\n'
            valid_row = '| `fixture` | Use verified words | plan.md:1 | cited | ompkit-663q4 |\n'
            def missing_application() -> None:
                rc, out = cli('check', 'plan.md')
                assert rc == 1 and 'APPLICATION_MISSING: fixture' in out, (rc, out)
            missing_application()
            count += 1
            # Skipping application checking must kill the same refusal assertion.
            with patch.object(sources, 'application_sources', return_value={'fixture'}):
                try:
                    missing_application()
                except AssertionError:
                    count += 1
                else:
                    raise AssertionError('application-check-skipped mutant survived')
            application.write_text(header + valid_row)
            assert cli('check', 'plan.md')[0] == 0
            count += 1
            for invalid in (valid_row.replace('Use verified words', ''),
                            valid_row.replace('plan.md:1', 'plan.md'),
                            valid_row.replace('cited', 'unknown'),
                            valid_row.replace('ompkit-663q4', ''),
                            valid_row.replace('fixture', 'other')):
                application.write_text(header + invalid)
                missing_application()
                count += 1
            for status in ('procedure', 'built-not-wired', 'applied', 'enforced'):
                application.write_text(header + valid_row.replace('cited', status).replace('plan.md:1', 'ompkit-663q4'))
                assert cli('check', 'plan.md')[0] == 0
                count += 1
            application.write_text(header + valid_row)
            doc.write_text(url)
            application.write_text(header)
            missing_application()
            application.write_text(header + valid_row + valid_row.replace('fixture', 'markdown'))
            assert cli('check', 'plan.md')[0] == 0
            count += 2
            for text, code in [('[StAnDaRd ReAdInG]', 'MEMORY_CITATION'),
                               ('cited from memory', 'MEMORY_CITATION'),
                               ('[src:missing]', 'UNRESOLVED_SRC'),
                               ('https://unregistered.example/new', 'UNREGISTERED_LINK')]:
                doc.write_text(text)
                rc, out = cli('check', 'plan.md')
                assert rc == 1 and code in out, out
                count += 1
            doc.write_text('[src:fixture]')
            for change in ('excerpt', 'hash'):
                mutated = copy.deepcopy(row)
                quote = mutated['quotes'][0]
                if change == 'excerpt':
                    quote['excerpt'] = 'unrelated text'
                    quote['excerpt_sha256'] = sources.sha(quote['excerpt'].encode())
                else:
                    quote['excerpt_sha256'] = 'bad'
                registry.write_text(json.dumps(mutated) + '\n')
                rc, out = cli('check', 'plan.md')
                assert rc == 1 and 'EXCERPT_TAMPERED' in out
                count += 1
            registry.write_bytes(before)
            doc.write_text('https://unregistered.example/old')
            assert cli('check', 'plan.md', '--write-baseline')[0] == 0
            assert cli('check', 'plan.md')[0] == 0
            count += 2
            bp = repo / sources.BASELINE
            baseline_before = bp.read_bytes()
            # Verifier's counterexample: replacement, not an additional link.
            doc.write_text('https://unregistered.example/new')
            def replacement_refused() -> None:
                rc, out = cli('check', 'plan.md')
                assert rc == 1 and 'UNREGISTERED_LINK' in out, (rc, out)
            replacement_refused()
            rc, out = cli('check', 'plan.md', '--write-baseline')
            assert rc == 1 and 'BASELINE_RAISED' in out and bp.read_bytes() == baseline_before
            count += 2
            original_judge = sources.judge
            def count_only(files, rows, old, write=None, application=''):
                found, rc = original_judge(files, rows, old, write, application)
                if write is None:
                    debt = sum(len(c.get('UNREGISTERED_LINK', [])) for c in old.values())
                    rc = int(len(found) > debt or any(f['code'] != 'UNREGISTERED_LINK' for f in found))
                return found, rc
            with patch.object(sources, 'judge', side_effect=count_only):
                try:
                    replacement_refused()
                except AssertionError:
                    count += 1
                else:
                    raise AssertionError('per-class-baseline mutant survived')
            bp.write_text(json.dumps({'plan.md': {'UNREGISTERED_LINK': 1}}))
            rc, out = cli('check', 'plan.md')
            assert rc == 1 and 'legacy count format' in out
            bp.write_bytes(baseline_before)
            # Equivalent URL spelling is the same finding, not fresh debt.
            doc.write_text('http://UNREGISTERED.example/old/#section')
            assert cli('check', 'plan.md')[0] == 0
            count += 2
            doc.write_text('https://unregistered.example/old https://unregistered.example/new')
            assert cli('check', 'plan.md')[0] == 1
            rc, out = cli('check', 'plan.md', '--write-baseline')
            assert rc == 1 and 'BASELINE_RAISED' in out and bp.read_bytes() == baseline_before
            count += 2
            doc.write_text('clean')
            assert cli('check', 'plan.md', '--write-baseline')[0] == 0
            assert json.loads(bp.read_text()) == {}
            count += 1
            assert cli('verify')[0] == 0
            PAGE = b'<p>The fixture changed.</p>'
            rc, out = cli('verify')
            assert rc == 1 and 'QUOTE_MISSING' in out
            count += 2
            # The same absent-quote acceptance assertion must fail when matching
            # is disabled. Restore page so only the matcher is mutated.
            PAGE = b'<p>The verified words are here.</p>'
            caught = False
            with patch.object(sources, 'quote_record', return_value=row['quotes'][0]):
                try:
                    assert add('absent words', 'mutant')[0] == 1
                except AssertionError:
                    caught = True
            assert caught
            count += 1
            assert sources.SRC.findall('[src:ok] [src:bad space]') == ['ok']
            assert sources.URL.findall('https://example.org/x)') == ['https://example.org/x']
            started = time.monotonic()
            assert not sources.SRC.search('[src:' + 'a' * 1000000)
            assert time.monotonic() - started < 5
            count += 3
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    print(f'{count} passed, 0 failed')


if __name__ == '__main__':
    main()
