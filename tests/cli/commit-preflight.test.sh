#!/bin/sh
# Real checker integration: source and installed-gate fire/quiet controls,
# byte-identical caller indexes, and staged bytes rather than working bytes.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd -P)
fixture_deadline=$(bun --no-env-file --config=/dev/null -e 'const { fixtureDeadlineS } = await import(process.argv[1]); console.log(fixtureDeadlineS(60));' "$here/../tests/cli/fixture-process.ts")
exec python3 -B - "$here" "$fixture_deadline" <<'PY'
import json
import os
from pathlib import Path
import shutil
import sys
import time
sys.path.insert(0, sys.argv[1])
from kitlib_run import run
from kitlib_tmp import owned_tmp
scripts = Path(sys.argv[1])
def cmd(argv, cwd=None, env=None):
    indexes = []
    if Path(argv[1]).name == 'commit-preflight.sh':
        for path in {Path(cwd)/'.git/index', Path((env or {}).get('GIT_INDEX_FILE', str(Path(cwd)/'.git/index')))}:
            indexes.append((path, path.read_bytes() if path.exists() else None))
    r = run(argv, deadline_s=float(sys.argv[2]), cwd=cwd, env=env, max_output_bytes=8*1024*1024)
    assert not r.timed_out and not r.truncated, (argv, r)
    for path, before in indexes:
        assert (path.read_bytes() if path.exists() else None) == before, 'preflight changed caller index bytes: ' + str(path)
    return r
allocation = owned_tmp('preflight-test')
root = Path(allocation.path)
env = dict(os.environ, GIT_AUTHOR_NAME='test', GIT_AUTHOR_EMAIL='test@invalid', GIT_COMMITTER_NAME='test', GIT_COMMITTER_EMAIL='test@invalid')
# Native CLI resolution stays unavailable; installed hook members carry their
# own shipped helpers and must not silently fall back to source checkers.
env['PATH'] = os.pathsep.join(part for part in env.get('PATH', '').split(os.pathsep)
                              if part and not (Path(part) / 'omp-kit').is_file())
for key in ('GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR'):
    env.pop(key, None)
env.update(TMPDIR=str(root), GIT_CEILING_DIRECTORIES=str(root.parent), OMP_KIT_GATE_EVENTS_SKIP='1')
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
    (root/'quiet.txt').write_text('quiet\n')
    absent = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','quiet.txt'],root,env)
    absent_text = (absent.stdout+absent.stderr).decode()
    print('no-install quiet rc=' + str(absent.rc) + '\n' + absent_text, flush=True)
    assert absent.rc == 0 and 'UNKNOWN installed-gate: no installed hook chain' in absent_text, absent_text
    passed += 1
    # EXPORTTEST1 [a]: a planted test passes in the checkout but overflows a
    # path limit under the verdict-shaped export TMPDIR; preflight refuses it.
    limit = len(str(root)) + 40
    (root/'long.test.sh').write_text('#!/bin/sh\nif [ "${#TMPDIR}" -ge ' + str(limit) + ' ]; then\n    printf "path too long: %s bytes\\n" "${#TMPDIR}"\n    exit 1\nfi\n')
    checkout_run = cmd(['sh','long.test.sh'],root,env)
    assert checkout_run.rc == 0, 'planted file must pass in the checkout'
    planted = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','long.test.sh','--tests','long.test.sh'],root,env)
    planted_text = (planted.stdout+planted.stderr).decode()
    print('export-test planted rc=' + str(planted.rc) + '\n' + planted_text, flush=True)
    assert planted.rc == 1 and 'REFUSED EXPORT_TEST_FAILED long.test.sh (exit 1)' in planted_text, planted_text
    assert 'path too long:' in planted_text and '/archive)' in planted_text, planted_text
    passed += 1
    # [b] quiet control: a passing file in the same export is clean.
    (root/'ok.test.sh').write_text('#!/bin/sh\nif [ ! -d .git ] || git rev-parse -q --verify HEAD >/dev/null; then\n    exit 3\nfi\nprintf "ok\\n"\n')
    ok = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','ok.test.sh','--tests','ok.test.sh'],root,env)
    ok_text = (ok.stdout+ok.stderr).decode()
    print('export-test quiet rc=' + str(ok.rc) + '\n' + ok_text, flush=True)
    assert ok.rc == 0 and 'PASS export-test:ok.test.sh' in ok_text and 'EXPORT_TEST_FAILED' not in ok_text, ok_text
    assert '1 export test file(s) run' in ok_text, ok_text
    (root/'long.test.sh').unlink()
    (root/'ok.test.sh').unlink()
    passed += 1
    # Use the real installer in an owned unborn repository, then copy only its
    # pre-commit chain. No commit or unrelated tracker/ref hook ever runs.
    template = root/'hook-template'
    assert cmd(['git','init','-q',str(template)],env=env).rc == 0
    installed = cmd(['sh',str(scripts/'install-commit-msg-bead.sh'),'--no-pushed-beads',str(template)],template,env)
    assert installed.rc == 0, (installed.stdout+installed.stderr).decode()
    hooks = root/'installed-hooks'
    shutil.copytree(template/'.git/hooks/hooks.d/pre-commit', hooks/'hooks.d/pre-commit')
    shutil.copy2(template/'.git/hooks/pre-commit', hooks/'pre-commit')
    assert cmd(['git','config','core.hooksPath',str(hooks)],root,env).rc == 0
    (root/'tests').mkdir()
    (root/'scripts').mkdir()
    baseline = root/'scripts/kitlib-ratchet-baseline.json'
    accepted_baseline = {'schema': 1, 'counts': {'raw-spawn': {}}, 'totals': {'raw-spawn': 0}}
    baseline.write_text(json.dumps(accepted_baseline) + '\n')
    assert cmd(['git','add','--',str(baseline)],root,env).rc == 0
    tree = cmd(['git','write-tree'],root,env).stdout.decode().strip()
    commit = cmd(['git','commit-tree',tree,'-p',commit,'-m','fixture baseline'],root,env).stdout.decode().strip()
    assert cmd(['git','update-ref','HEAD',commit],root,env).rc == 0
    rejected_baseline = {**accepted_baseline, 'counts': {**accepted_baseline['counts'], 'unknown-rule': {}}}
    baseline.write_text(json.dumps(rejected_baseline) + '\n')
    assert cmd(['git','add','--',str(baseline)],root,env).rc == 0
    baseline.write_text(json.dumps(accepted_baseline) + '\n')
    fire = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    fire_text = (fire.stdout+fire.stderr).decode()
    print('installed-gate planted rc=' + str(fire.rc) + '\n' + fire_text, flush=True)
    assert fire.rc == 1 and 'REFUSED installed-gate:51-omp-kit-staged-kitlib' in fire_text, fire_text
    assert 'counts.unknown-rule: not a site rule' in fire_text, fire_text
    passed += 1
    quiet = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','scripts/kitlib-ratchet-baseline.json'],root,env)
    quiet_text = (quiet.stdout+quiet.stderr).decode()
    print('installed-gate quiet rc=' + str(quiet.rc) + '\n' + quiet_text, flush=True)
    assert quiet.rc == 0 and 'PASS installed-gate:51-omp-kit-staged-kitlib' in quiet_text, quiet_text
    for member in ('50-omp-kit-staged-tempsafe', '54-omp-kit-staged-portable-paths', '55-omp-kit-staged-wallclock'):
        assert 'PASS installed-gate:' + member in quiet_text, quiet_text
    passed += 1
    # The default path must also preserve an explicitly supplied caller index.
    private_index = root/'caller-index'
    shutil.copy2(root/'.git/index', private_index)
    explicit_env = dict(env, GIT_INDEX_FILE=str(private_index))
    explicit = cmd(['sh',str(scripts/'commit-preflight.sh')],root,explicit_env)
    assert explicit.rc == 1 and 'REFUSED installed-gate:51-omp-kit-staged-kitlib' in (explicit.stdout+explicit.stderr).decode()
    passed += 1
    assert cmd(['git','add','--',str(baseline)],root,env).rc == 0
    baseline.write_text(json.dumps(rejected_baseline) + '\n')
    staged_quiet = cmd(['sh',str(scripts/'commit-preflight.sh')],root,env)
    assert staged_quiet.rc == 0, (staged_quiet.stdout+staged_quiet.stderr).decode()
    files_fire = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','scripts/kitlib-ratchet-baseline.json'],root,env)
    assert files_fire.rc == 1 and 'REFUSED installed-gate:51-omp-kit-staged-kitlib' in (files_fire.stdout+files_fire.stderr).decode()
    passed += 1
    missing_member = hooks/'hooks.d/pre-commit/51-omp-kit-staged-kitlib'
    parked_member = root/'parked-kitlib'
    missing_member.rename(parked_member)
    missing_gate = cmd(['sh',str(scripts/'commit-preflight.sh'),'--files','quiet.txt'],root,env)
    missing_text = (missing_gate.stdout+missing_gate.stderr).decode()
    print('partial-install planted rc=' + str(missing_gate.rc) + '\n' + missing_text, flush=True)
    assert missing_gate.rc == 1 and 'UNKNOWN installed-gate:51-omp-kit-staged-kitlib' in missing_text, missing_text
    parked_member.rename(missing_member)
    baseline.write_text(json.dumps(accepted_baseline) + '\n')
    passed += 1
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
    # The bound scales with the larger of the start-sampled and end-observed load factors
    # (start factor fixtureDeadlineS(60)/60, both clamped 1..4): load1 is a 1-minute average and
    # lags a spike that lands mid-run, so a start-only bound still flakes when verdict slots fill
    # after it. The 2026-11-04 676f556d verdict at load1 40-108 on 32 cores read 22.044 s against
    # the fixed 20 s; the 2026-11-11 verdict read 23.24 s against a start-sampled factor near 1.
    end_factor = max(1.0, min(4.0, (os.getloadavg()[0] / (os.cpu_count() or 1)) * 4))
    bound = 20 * max(float(sys.argv[2]) / 60, end_factor)
    assert elapsed < bound, (elapsed, bound, end_factor)  # wallclock: p99=5s headroom=4x
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
