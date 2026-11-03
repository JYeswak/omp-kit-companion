#!/bin/sh
# Real checker integration: six independent refusals in one call, clean
# control, private --files index, and staged bytes rather than working bytes.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd -P)
exec python3 -B - "$here" <<'PY'
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, sys.argv[1])
from kitlib_run import run
from kitlib_tmp import owned_tmp
scripts = Path(sys.argv[1])
def cmd(argv, cwd=None, env=None):
    r = run(argv, deadline_s=60, cwd=cwd, env=env, max_output_bytes=8*1024*1024)
    assert not r.timed_out and not r.truncated, (argv, r)
    return r
allocation = owned_tmp('preflight-test')
root = Path(allocation.path)
env = dict(os.environ, GIT_AUTHOR_NAME='test', GIT_AUTHOR_EMAIL='test@invalid', GIT_COMMITTER_NAME='test', GIT_COMMITTER_EMAIL='test@invalid')
for key in ('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR'):
    env.pop(key, None)
passed = 0
started = time.monotonic()
try:
    assert cmd(['git','init','-q',str(root)], env=env).rc == 0
    (root/'changelog.d').mkdir()
    (root/'changelog.d/seed.txt').write_text('seed\n')
    assert cmd(['git','add','.'],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    commit = cmd(['git','commit-tree',tree,'-m','fixture'],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',commit],root,env).rc == 0
    (root/'tests').mkdir()
    (root/'scripts').mkdir()
    (root/'tests/bad.py').write_text('import subprocess\nimport tempfile\nsubprocess.run(["true"])\ntempfile.mkdtemp()\ntimeout_s = 1\n')
    (root/'scripts/check-bad.sh').write_text('#!/bin/sh\npython3 "$dynamic"\necho $unquoted\n')
    index_before = cmd(['git','write-tree'],root,env).stdout
    t = time.monotonic()
    bad = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','tests/bad.py','scripts/check-bad.sh'],root,env)
    elapsed = time.monotonic()-t
    text = (bad.stdout+bad.stderr).decode()
    print(text)
    assert bad.rc == 1, bad.rc
    for needle in ('raw-spawn','tempsafe','pysafe','small-deadline','SC2086','DEPLOY_STEP_MISSING'):
        assert needle in text, needle
        passed += 1
    assert elapsed < 20, elapsed  # wallclock: p99=5s headroom=4x
    passed += 1
    assert cmd(['git','write-tree'],root,env).stdout == index_before
    passed += 1
    (root/'clean.sh').write_text('#!/bin/sh\nprintf "clean\\n"\n')
    clean = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','clean.sh'],root,env)
    assert clean.rc == 0, (clean.stdout+clean.stderr).decode()
    passed += 1
    assert cmd(['git','add','clean.sh'],root,env).rc == 0
    (root/'clean.sh').write_text('#!/bin/sh\necho $unstaged\n')
    staged = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    assert staged.rc == 0, (staged.stdout+staged.stderr).decode()
    passed += 1
    print(f'commit-preflight: {passed} pass 0 fail; six-finding run {elapsed:.2f}s; total {time.monotonic()-started:.2f}s')
finally:
    allocation.cleanup()
PY
