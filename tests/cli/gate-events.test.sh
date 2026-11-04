#!/bin/sh
# Standalone recorder contract: Python/git only; no Bun/Node in installed hooks.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
python3 - "$root" <<'PY'
from __future__ import annotations
import datetime, hashlib, json, os, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / 'scripts'))
from kitlib_tmp import owned_tmp
from kitlib_run import RunResult, run

def execute(argv: list[str], *, cwd: pathlib.Path | None = None, env: dict[str, str] | None = None, check: bool = True) -> RunResult:
    result = run(argv, cwd=str(cwd) if cwd is not None else None, env=env, deadline_s=60)
    assert not result.timed_out and not result.truncated, (argv, result)
    if check:
        assert result.rc == 0, 'command %r rc=%s stdout=%s stderr=%s' % (argv, result.rc, result.stdout.decode('utf-8', errors='replace'), result.stderr.decode('utf-8', errors='replace'))
    return result

with owned_tmp('gate-event-replay') as scratch:
    base = pathlib.Path(scratch)
    os.environ['GIT_CEILING_DIRECTORIES'] = str(base)
    os.environ['TMPDIR'] = str(base)
    repo = base / 'repo'; repo.mkdir()
    def git(*args: str) -> bytes:
        return execute(['git', '-C', str(repo), *args]).stdout
    git('init', '--quiet', '--template=')
    git('config', 'core.hooksPath', '.git/hooks')
    (repo / 'ordinary.txt').write_text('ordinary staged content\n')
    git('add', '--', 'ordinary.txt')
    message = repo / 'message'; message.write_text('fix: ordinary commit\n\nBead: kit-replay\n')
    state = base / 'state'
    env = dict(os.environ, XDG_STATE_HOME=str(state), BR_ACTOR='ReplaySeat')
    sentinel = 'ghp_' + '7cX9' * 10
    env.update(OMP_KIT_GATE_EVENT_RC='7', OMP_KIT_GATE_EVENT_MESSAGE_FILE=str(message), OMP_KIT_GATE_EVENT_HOOK='commit-msg', OMP_KIT_GATE_EVENT_COMMAND='git commit -F ' + str(message), OMP_KIT_GATE_EVENT_ARGUMENTS=json.dumps([str(message), sentinel + 'x' * 70000]))
    script = root / 'scripts' / 'gate-event.sh'
    execute(['sh', str(script), 'commit', 'HEAD', 'fixture-hook', 'refuse', 'native-shell-17', 'rc=7'], cwd=repo, env=env)
    ledger = state / 'omp-kit' / 'gate-events.jsonl'
    row = json.loads(ledger.read_text().splitlines()[0])
    assert row['event_id'] == 'native-shell-17'
    assert row['rc'] == 7
    assert row['repo'] == str(repo) and row['member'] == 'fixture-hook'
    assert datetime.datetime.fromisoformat(row['started_at'].replace('Z', '+00:00')).tzinfo is not None
    assert row['duration_s'] == 0
    replay = row['replay']
    assert replay['cwd'] == str(repo)
    assert replay['staged_paths'] == ['ordinary.txt']
    assert replay['diff_sha256'] == hashlib.sha256(git('diff', '--cached', '--binary', '--no-ext-diff')).hexdigest()
    assert replay['message'] == message.read_text()
    assert replay['custody'] is not None
    assert replay['arguments']['command'] == env['OMP_KIT_GATE_EVENT_COMMAND']
    assert replay['redacted'] is True and replay['truncated'] is True
    assert len(json.dumps(replay, ensure_ascii=False, separators=(',', ':')).encode()) <= 32768
    assert sentinel not in ledger.read_text()
    # A source zero cannot become a refusal merely because a caller's label says so.
    env['OMP_KIT_GATE_EVENT_RC'] = '0'
    execute(['sh', str(script), 'commit', 'HEAD', 'fixture-hook', 'refuse', 'native-shell-zero', 'rc=0'], cwd=repo, env=env)
    zero = json.loads(ledger.read_text().splitlines()[-1])
    assert zero['kind'] != 'refuse' and zero['rc'] == 0
    # Installed recorder retains the same context without any source checkout imports.
    installed = base / 'installed'; installed.mkdir()
    for name in ('gate-event.sh', 'gate_event_replay.py', 'kitlib_jsonl.py', 'kitlib_lock.py', 'kitlib_run.py', 'pysafe.py'):
        shutil.copyfile(root / 'scripts' / name, installed / name)
    shutil.copyfile(root / 'src' / 'cc-credential-shapes.v1.json', installed / 'cc-credential-shapes.v1.json')
    shutil.copyfile(root / 'src' / 'secret-output-policy.v1.json', installed / 'secret-output-policy.v1.json')
    execute(['sh', str(installed / 'gate-event.sh'), 'commit', 'HEAD', 'installed-hook', 'refuse', 'installed-id', 'rc=7'], cwd=repo, env=dict(env, OMP_KIT_GATE_EVENT_RC='7'))
    installed_row = json.loads(ledger.read_text().splitlines()[-1])
    assert installed_row['replay']['message'] == message.read_text()
    assert installed_row['replay']['redacted'] is True
    # Missing policy produces no raw fallback row, while the recorder still cannot change exit.
    count = len(ledger.read_text().splitlines())
    (installed / 'secret-output-policy.v1.json').unlink()
    execute(['sh', str(installed / 'gate-event.sh'), 'commit', 'HEAD', 'missing-policy', 'refuse', 'missing-policy-id', 'rc=7'], cwd=repo, env=env)
    assert len(ledger.read_text().splitlines()) == count
    # Exercise the real installed chain runner, not a synthetic replacement.
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture seed')
    (repo / 'ordinary.txt').write_text('changed staged content\n')
    git('add', '--', 'ordinary.txt')
    install_env = dict(env, OMP_KIT_GATE_EVENTS_SKIP='1')
    execute(['sh', str(root / 'scripts' / 'install-commit-msg-bead.sh'), '--no-pushed-beads', str(repo)], env=install_env)
    members = repo / '.git' / 'hooks' / 'hooks.d' / 'commit-msg'
    for member in members.glob('[0-9][0-9]-*'):
        member.chmod(0o600)
    refusing = members / '00-replay-fixture'
    refusing.write_text('#!/bin/sh\nprintf \"fixture refused\\n\" >&2\nexit 7\n')
    refusing.chmod(0o700)
    runner_env = {key: value for key, value in env.items() if not key.startswith('OMP_KIT_GATE_EVENT_')}
    result = execute(['sh', str(repo / '.git' / 'hooks' / 'commit-msg'), str(message)], cwd=repo, env=runner_env, check=False)
    assert result.rc == 7
    hooked = json.loads(ledger.read_text().splitlines()[-1])
    assert hooked['gate'] == '00-replay-fixture' and hooked['rc'] == 7, (hooked, result.stdout, result.stderr)
    assert hooked['replay']['arguments']['argv'] == [str(message)]
    assert hooked['replay']['message'] == message.read_text()
    assert hooked['replay']['staged_paths'] == ['ordinary.txt']
    assert hooked['repo'] == str(repo) and hooked['member'] == '00-replay-fixture'
    assert hooked['duration_s'] > 0 and hooked['started_at'] <= hooked['ts']
    # A real pre-push chain records both the quiet control and planted refusal, with distinct attempts.
    push_members = repo / '.git' / 'hooks' / 'hooks.d' / 'pre-push'
    for member in push_members.glob('[0-9][0-9]-*'):
        member.chmod(0o600)
    for name, body in [('00-quiet-fixture', 'exit 0'), ('01-refusing-fixture', 'sleep 0.05\nexit 9')]:
        member = push_members / name
        member.write_text('#!/bin/sh\n' + body + '\n'); member.chmod(0o700)
    previous = len(ledger.read_text().splitlines())
    push = execute(['sh', str(repo / '.git' / 'hooks' / 'pre-push'), 'origin', 'fixture-remote'], cwd=repo, env=runner_env, check=False)
    assert push.rc == 9, (push.rc, push.stdout, push.stderr)
    push_rows = [json.loads(line) for line in ledger.read_text().splitlines()[previous:]]
    assert [(row['member'], row['kind'], row['rc']) for row in push_rows] == [('00-quiet-fixture', 'pass', 0), ('01-refusing-fixture', 'refuse', 9)], (push_rows, push.stdout, push.stderr)
    assert all(row['repo'] == str(repo) and row['hook'] == 'pre-push' and row['duration_s'] > 0 and row['started_at'] <= row['ts'] for row in push_rows)
    assert len({row['attempt'] for row in push_rows}) == 1
    assert push_rows[1]['duration_s'] >= 0.05
    again = execute(['sh', str(repo / '.git' / 'hooks' / 'pre-push'), 'origin', 'fixture-remote'], cwd=repo, env=runner_env, check=False)
    assert again.rc == 9 and json.loads(ledger.read_text().splitlines()[-1])['attempt'] != push_rows[0]['attempt']
    # Every metadata field is another secret surface, not just the replay object.
    metadata_env = dict(env, BR_ACTOR=sentinel, OMP_KIT_GATE_EVENT_RC='7')
    execute(['sh', str(script), sentinel, sentinel, sentinel, 'refuse', sentinel, sentinel + 'x' * 70000], cwd=repo, env=metadata_env)
    raw_metadata = ledger.read_text().splitlines()[-1]
    metadata = json.loads(raw_metadata)
    assert sentinel not in raw_metadata and metadata['metadata_redacted'] is True
    assert metadata['metadata_truncated'] is True
    # Replacement decoding is visibly lossy, never an exact replay claim.
    message.write_bytes(b'commit message with invalid UTF-8: \xff\n')
    execute(['sh', str(script), 'commit', 'HEAD', 'invalid-utf8', 'refuse', 'invalid-utf8-id', 'rc=7'], cwd=repo, env=dict(env, OMP_KIT_GATE_EVENT_RC='7'))
    lossy = json.loads(ledger.read_text().splitlines()[-1])['replay']
    assert lossy['truncated'] is True
print('gate-event replay contract passed')
PY
