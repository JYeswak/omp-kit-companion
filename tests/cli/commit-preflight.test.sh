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
# An installed omp-kit is deliberately unavailable: the gate's extracted tree
# has only the shipped Python helpers, and may not create native CLI scratch.
env['PATH'] = os.pathsep.join(part for part in env.get('PATH', '').split(os.pathsep)
                              if part and not (Path(part) / 'omp-kit').is_file())
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
    assert cmd(['git','update-ref','refs/tags/v0.0.1',commit],root,env).rc == 0
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
    clean_text = (clean.stdout+clean.stderr).decode()
    for check in ('stale-worktree', 'kitlib-reversal', 'commit-notes'):
        assert 'NOT_JUDGED ' + check in clean_text, clean_text
    passed += 1
    # SC2015 is info severity: local 0.11 no longer reports this exact idiom,
    # but focused CI's pinned 0.9 must refuse the same bytes as publication.
    (root/'tests/cli').mkdir()
    info = root/'tests/cli/info.sh'
    info.write_text('#!/bin/sh\nfor binding in "$@"; do\n    [ -f "$binding" ] && [ ! -L "$binding" ] || continue\n    printf "%s\\n" "$binding"\ndone\n')
    info_bad = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','tests/cli/info.sh'],root,env)
    info_text = (info_bad.stdout+info_bad.stderr).decode()
    assert info_bad.rc == 1 and 'SC2015 (info)' in info_text, info_text
    passed += 1
    info.write_text('#!/bin/sh\nfor binding in "$@"; do\n    if [ ! -f "$binding" ] || [ -L "$binding" ]; then\n        continue\n    fi\n    printf "%s\\n" "$binding"\ndone\n')
    info_clean = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','tests/cli/info.sh'],root,env)
    assert info_clean.rc == 0, (info_clean.stdout+info_clean.stderr).decode()
    passed += 1
    # Unavailable pinned engine must not silently accept via the local binary.
    offline_env = dict(env, DOCKER_HOST='unix://' + str(root/'absent-docker.sock'))
    offline_env.pop('DOCKER_CONTEXT', None)
    offline = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','clean.sh'],root,offline_env)
    offline_text = (offline.stdout+offline.stderr).decode()
    assert offline.rc == 1 and 'UNJUDGED shellcheck:clean.sh' in offline_text and 'docker pull koalaman/shellcheck:v0.9.0' in offline_text, offline_text
    passed += 1
    assert cmd(['git','add','clean.sh'],root,env).rc == 0
    (root/'clean.sh').write_text('#!/bin/sh\necho $unstaged\n')
    staged = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    assert staged.rc == 0, (staged.stdout+staged.stderr).decode()
    passed += 1
    # Exact native HEAD/Bead rule: the working copy removes a foreign-bead
    # landing. Without the real message this rule cannot be judged.
    (root/'src').mkdir()
    (root/'src/owned.txt').write_text('before landing\n')
    assert cmd(['git','add','src/owned.txt'],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    base = cmd(['git','commit-tree',tree,'-p',commit,'-m','fixture base'],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',base],root,env).rc == 0
    (root/'src/owned.txt').write_text('published foreign landing\n')
    assert cmd(['git','add','src/owned.txt'],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    landing = cmd(['git','commit-tree',tree,'-p',base,'-m','foreign landing\n\nBead: ompkit-other'],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',landing],root,env).rc == 0
    (root/'src/owned.txt').write_text('before landing\n')
    msg = root/'planned-message'
    msg.write_text('test: intentional fixture [test]\n\n[no-changelog] isolated test fixture\n\nBead: ompkit-demo\n')
    reverted = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/owned.txt'],root,env)
    reverted_text = (reverted.stdout+reverted.stderr).decode()
    assert reverted.rc == 1 and 'STALE_WORKTREE src/owned.txt' in reverted_text and landing in reverted_text, reverted_text
    passed += 1
    msg.write_text(msg.read_text() + '\nSupersedes: ' + landing + '\n')
    declared = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/owned.txt'],root,env)
    assert declared.rc == 0, (declared.stdout+declared.stderr).decode()
    passed += 1
    # Notes must judge the actual Bead trailer before the expensive fresh gate.
    (root/'src/probe.txt').write_text('new shipped path\n')
    msg.write_text('test: note coverage [test]\n\nBead: ompkit-demo\n')
    missing = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/probe.txt'],root,env)
    missing_text = (missing.stdout+missing.stderr).decode()
    assert missing.rc == 1 and 'has no changelog fragment: changelog.d/demo.md' in missing_text, missing_text
    passed += 1
    (root/'changelog.d/demo.md').write_text('- Cover the isolated preflight fixture. (ompkit-demo)\n- Exercise the original candidate. (ompkit-demo)\n')
    covered = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/probe.txt','changelog.d/demo.md'],root,env)
    assert covered.rc == 0, (covered.stdout+covered.stderr).decode()
    passed += 1
    # Reproduce cpf6: the old fragment exists since the release floor, but
    # this new commit has contributed no note to it. The push delta refuses.
    assert cmd(['git','add','src/probe.txt','changelog.d/demo.md'],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    published = cmd(['git','commit-tree',tree,'-p',landing,'-F',str(msg)],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',published],root,env).rc == 0
    (root/'src/probe.txt').write_text('new follow-on shipped change\n')
    reused = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/probe.txt'],root,env)
    reused_text = (reused.stdout+reused.stderr).decode()
    assert reused.rc == 1 and 'REFUSED commit-notes-delta' in reused_text, reused_text
    assert 'has no changelog fragment: changelog.d/demo.md' in reused_text, reused_text
    assert 'REFUSED commit-notes (' not in reused_text, reused_text
    passed += 1
    # Modifying the fragment only by deleting a line is not an added note.
    (root/'changelog.d/demo.md').write_text('- Cover the isolated preflight fixture. (ompkit-demo)\n')
    removed = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/probe.txt','changelog.d/demo.md'],root,env)
    removed_text = (removed.stdout+removed.stderr).decode()
    assert removed.rc == 1 and 'no added note line' in removed_text, removed_text
    passed += 1
    with (root/'changelog.d/demo.md').open('a') as fragment:
        fragment.write('- Cover the follow-on preflight change. (ompkit-demo)\n')
    updated = cmd(['sh',str(scripts/'commit-preflight.sh'),'--message',str(msg),'--files','src/probe.txt','changelog.d/demo.md'],root,env)
    assert updated.rc == 0, (updated.stdout+updated.stderr).decode()
    passed += 1
    # Source closure: an unchanged INDEX helper with a non-shell suffix must be
    # available to the changed caller. Unstaged helper/config dirt is irrelevant.
    helper = root/'scripts/report-data.inc'
    helper.write_text('REPORT_VALUE=staged\n')
    assert cmd(['git','add','scripts/report-data.inc'],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    helper_base = cmd(['git','commit-tree',tree,'-p',published,'-m','fixture helper'],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',helper_base],root,env).rc == 0
    caller = root/'tests/source-closure.sh'
    caller.write_text('#!/bin/sh\nROOT=.\n# shellcheck source=scripts/report-data.inc\n. "$ROOT/scripts/report-data.inc"\nprintf "%s\\\\n" "$REPORT_VALUE"\n')
    helper.write_text("REPORT_VALUE='unterminated\n")
    (root/'.shellcheckrc').write_text('this-is-not-a-valid-shellcheck-directive\n')
    closure = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','tests/source-closure.sh'],root,env)
    assert closure.rc == 0, (closure.stdout+closure.stderr).decode()
    passed += 1
    # Reverse the dirt: INDEX parse failure cannot be hidden by clean worktree.
    assert cmd(['git','add','scripts/report-data.inc','tests/source-closure.sh'],root,env).rc == 0
    helper.write_text('REPORT_VALUE=clean_worktree\n')
    broken_source = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    broken_text = (broken_source.stdout+broken_source.stderr).decode()
    assert broken_source.rc == 1 and 'SC1094' in broken_text, broken_text
    passed += 1
    # A helper absent from INDEX must still refuse, even if worktree has it.
    assert cmd(['git','update-index','--force-remove','--','scripts/report-data.inc'],root,env).rc == 0
    missing_source = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    missing_source_text = (missing_source.stdout+missing_source.stderr).decode()
    assert missing_source.rc == 1 and 'SC1091' in missing_source_text, missing_source_text
    passed += 1
    print(f'commit-preflight: {passed} pass 0 fail; six-finding run {elapsed:.2f}s; total {time.monotonic()-started:.2f}s')
finally:
    allocation.cleanup()
PY
