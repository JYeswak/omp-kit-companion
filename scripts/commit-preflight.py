#!/usr/bin/env python3
"""Aggregate source staged checks and the installed pre-commit staged members.

--files PATH... overlays working bytes onto HEAD; no option judges the caller's
effective staged index, including GIT_INDEX_FILE. Both use a private index and
object directory, never writing the caller's index or object store. --message
FILE supplies planned trailers; absent it Deploy-Step uses an empty message.
--tests FILE... (EXPORTTEST1, EXPORTPARITY1) runs those test files in the
verdict's shape: a stamped `git archive` of the HEAD commit with the judged index's changes
overlaid, a fresh `git init -q` (no history), a long TMPDIR under the export's
var/agent-tmp, each file through `heavy`. A
failing file is REFUSED EXPORT_TEST_FAILED naming it. Absent --tests no test runs.
--tests affected (PREFLIGHTAFFECTED1) selects the files the push gate's affected-test stage
would run for the staged paths (scripts/affected-tests.ts) and runs those the same way.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import shutil
import time

from kitlib_run import run
from kitlib_tmp import owned_tmp

HERE = Path(__file__).resolve().parent

# Pinned engine shared with fresh-gate's focused stage. Same tag, default
# severity and checker options in both runners.
SHELLCHECK_IMAGE = 'koalaman/shellcheck:v0.9.0'


def shellcheck_judge(path, staging, env):
    """Judge one staged shell file with the pinned engine, without a bind mount.

    DOCKERMOUNTWEDGE1: the staging tree may live on an NFS-backed checkout, and
    `docker run -v <nfs>:/archive` hangs OrbStack's file sharing. The engine
    image is scratch-based with no shell, so bake the judge argv at create
    time, `docker cp` the staging tree in (the client streams host bytes over
    the API; no guest mount), `docker start -a`, then remove the container by
    its id. Every docker call runs under command()'s bound, so a wedged daemon
    fails UNJUDGED in seconds instead of hanging the gate.
    """
    created = command(['docker', 'create', '--pull=never', '--network', 'none',
                       SHELLCHECK_IMAGE, '-x', '-P', '/archive', '/archive/' + path], env)
    if created.rc:
        raise RuntimeError('shellcheck create did not judge ' + path + ': '
                           + created.stderr.decode(errors='replace').strip())
    cid = created.stdout.decode(errors='replace').strip()
    if not cid:
        raise RuntimeError('shellcheck create returned no container id for ' + path)
    try:
        copied = command(['docker', 'cp', str(staging) + '/.', cid + ':/archive'], env)
        if copied.rc:
            raise RuntimeError('shellcheck stage copy did not judge ' + path + ': '
                               + copied.stderr.decode(errors='replace').strip())
        return command(['docker', 'start', '-a', cid], env)
    finally:
        removed = command(['docker', 'rm', '-f', cid], env)
        if removed.rc:
            raise RuntimeError('shellcheck container ' + cid + ' for ' + path
                               + ' was not removed and may leak (' +
                               removed.stderr.decode(errors='replace').strip() + ')')


def command(argv, env=None, cwd=None):
    result = run(argv, deadline_s=15, grace_s=0.2, max_output_bytes=8 * 1024 * 1024,
                 env=env, cwd=cwd)
    if result.timed_out or result.truncated:
        raise RuntimeError("command was not completely judged: " + str(argv))
    return result


def required(argv, env=None):
    result = command(argv, env)
    if result.rc:
        raise RuntimeError(result.stderr.decode(errors="replace") or str(argv))
    return result.stdout


def affected_tests(root: Path, env: dict) -> list:
    """PREFLIGHTAFFECTED1: `--tests affected` selects what the push gate will run, with the gate's own
    selector (scripts/affected-tests.ts) over every staged path, so a builder sees the gate's failures
    before the land does instead of after it."""
    changed = [os.fsdecode(raw) for raw in
               required(['git', 'diff', '--cached', '--name-only', '-z'], env).split(b'\0') if raw]
    if not changed:
        return []
    argv = ['bun', 'run', '--no-env-file', '--config=/dev/null', str(HERE / 'affected-tests.ts'), '--root', str(root)]
    for path in changed:
        argv += ['--changed-file', path]
    result = run(argv, deadline_s=120, grace_s=0.2, max_output_bytes=8 * 1024 * 1024, env=env, cwd=str(root))
    if result.timed_out or result.truncated or result.rc:
        raise RuntimeError('affected-test selection failed: ' + result.stderr.decode(errors='replace').strip())
    sys.stderr.write(result.stderr.decode(errors='replace'))
    return [line for line in result.stdout.decode().splitlines() if line.strip()]


def note_has_added_line(stdout, env):
    """Use the native judge's selected fragment; do not reimplement bead/waiver parsing."""
    try:
        verdict = json.loads(stdout)
    except (ValueError, UnicodeError) as error:
        raise RuntimeError('native notes judge returned unreadable JSON') from error
    if verdict.get('verdict') in ('waived', 'exempt'):
        return True
    fragment = verdict.get('fragment')
    if verdict.get('verdict') != 'covered' or not isinstance(fragment, str):
        raise RuntimeError('native notes judge returned no covered fragment')
    stat = required(['git', 'diff', '--cached', '--numstat', '-z', 'HEAD', '--', fragment], env)
    added = stat.split(b'\t', 1)[0]
    if not added.isdigit():
        raise RuntimeError('cannot read added-line count for native selected fragment ' + fragment)
    if int(added) > 0:
        return True
    print('commit-notes-delta: REFUSED: ' + fragment + ' has no added note line in this commit; add the note for this change')
    return False


def installed_checks(root: Path, env: dict) -> tuple[list, int]:
    """Resolve commit's hook location, not PATH or the source checkout's scripts."""
    hooks = Path(os.fsdecode(required(['git', 'rev-parse', '--git-path', 'hooks'], env)).strip())
    if not hooks.is_absolute():
        hooks = root / hooks
    chain = hooks / 'hooks.d' / 'pre-commit'
    candidates = sorted(chain.glob('[0-9][0-9]-omp-kit-staged-*'))
    if not candidates:
        print('UNKNOWN installed-gate: no installed hook chain at ' + str(hooks), flush=True)
        return [], 0
    if not os.access(hooks / 'pre-commit', os.X_OK):
        print('UNKNOWN installed-gate: installed pre-commit runner is missing or not executable at ' + str(hooks), flush=True)
        return [], 1
    members = [path for path in candidates if path.is_file() and os.access(path, os.X_OK)]
    # These members are required even if an incomplete installation lost one.
    required_members = ('50-omp-kit-staged-tempsafe', '51-omp-kit-staged-kitlib',
                        '54-omp-kit-staged-portable-paths', '55-omp-kit-staged-wallclock')
    missing = set(required_members) - {path.name for path in members}
    for name in sorted(missing):
        print('UNKNOWN installed-gate:' + name + ': missing or not executable at ' + str(chain / name), flush=True)
    return [('installed-gate:' + path.name, [str(path)]) for path in members], len(missing)


# fresh-gate's export shape: a long owned dir holding archive/, TMPDIR at
# archive/var/agent-tmp, so path-length limits fire here and not in the verdict.
EXPORT_DIR = 'fresh-gate.export-test.' + '0' * 24 + '/archive'


def export_tests(tests: list, env: dict, root: Path, workers: int = 1) -> int:
    """Run each test file in an exact export of the judged index; return failures.

    workers > 1 (the `--tests affected` selection) runs each runner's files as one stage with that
    many workers, as fresh-gate's run_affected_tests does; workers == 1 keeps one stage per file.

    EXPORTPARITY1: the export has the gate/verdict layout. Like fresh-gate's
    make_work it lives under the repository's var/agent-tmp, never the system
    temp root; it archives the HEAD commit (export-subst stamps package.json
    source_revision), overlays the judged index's changed bytes, and runs
    `git init -q` like full-suite-verdict.sh. .git/omp-kit-export.json names
    HEAD plus the overlay.
    """
    parent = root / 'var' / 'agent-tmp'
    parent.mkdir(parents=True, exist_ok=True)
    with owned_tmp('commit-preflight-export', root=str(parent)) as owned:
        return run_export_tests(tests, env, Path(owned), root, workers)


def run_export_tests(tests: list, env: dict, scratch: Path, root: Path, workers: int = 1) -> int:
    head = required(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], env).decode().strip()
    archive = scratch / EXPORT_DIR
    archive.mkdir(parents=True)
    tarball = scratch / 'export.tar'
    required(['git', 'archive', '--format=tar', '--output=' + str(tarball), head], env)
    if command(['tar', '-xf', str(tarball), '-C', str(archive)], env).rc:
        raise RuntimeError('export extract failed')
    tarball.unlink()
    changes = required(['git', 'diff', '--cached', '--name-status', '-z', '--no-renames', head], env).split(b'\0')
    overlay, deleted = [], []
    for status, raw in zip(changes[0::2], changes[1::2]):
        (deleted if status == b'D' else overlay).append(os.fsdecode(raw))
    for path in deleted:
        (archive / path).unlink(missing_ok=True)
    if overlay:
        # Exact judged index bytes over the stamped HEAD tree.
        required(['git', 'checkout-index', '-f', '--prefix=' + str(archive) + os.sep, '--', *overlay], env)
    clean_env = {key: value for key, value in env.items() if not key.startswith('GIT_')}
    clean_env['GIT_CEILING_DIRECTORIES'] = str(archive.parent)
    if command(['git', '-C', str(archive), 'init', '-q'], clean_env).rc:
        raise RuntimeError('export git init failed')
    stamp = {'source_revision': head, 'overlay': overlay, 'deleted': deleted}
    (archive / '.git' / 'omp-kit-export.json').write_text(json.dumps(stamp, indent=1) + '\n')
    print('export: HEAD ' + head + ' + ' + str(len(overlay)) + ' overlaid, ' + str(len(deleted)) + ' deleted (.git/omp-kit-export.json)', flush=True)
    if (root / 'node_modules').is_dir() and not (archive / 'node_modules').exists():
        (archive / 'node_modules').symlink_to(root / 'node_modules')
    # PREFLIGHTWS1 (ompkit-1ra0d.54): a workspace package's test resolves its own dependencies from the
    # node_modules beside it first, as in the checkout; link every such ancestor the checkout has.
    for path in tests:
        parent = Path(path).parent
        while parent != Path('.') and parent != Path(parent.anchor):
            source_modules = root / parent / 'node_modules'
            linked = archive / parent / 'node_modules'
            if ('node_modules' not in parent.parts and source_modules.is_dir()
                    and not linked.exists() and not linked.is_symlink()):
                linked.parent.mkdir(parents=True, exist_ok=True)
                linked.symlink_to(source_modules)
            parent = parent.parent
    tmp = archive / 'var' / 'agent-tmp'
    tmp.mkdir(parents=True, exist_ok=True)
    test_env = {key: value for key, value in env.items() if not key.startswith('GIT_')}
    test_env.update(TMPDIR=str(tmp), BUN_CONFIG_FILE=str(archive / 'bunfig.toml'))
    cli = HERE.parent / 'src' / 'cli.ts'
    tree = required(['git', 'write-tree'], env).decode().strip()
    bun_config = archive / 'bunfig.toml'
    failures = 0
    present = []
    for path in tests:
        if (archive / path).is_file():
            present.append(path)
        else:
            failures += 1
            print('REFUSED EXPORT_TEST_FAILED ' + path + ': not in the exported tree (add it to --files)')
    if workers > 1:
        groups = [[path for path in present if path.endswith(('.test.sh', '.py'))],
                  [path for path in present if not path.endswith(('.test.sh', '.py'))]]
    else:
        groups = [[path] for path in present]
    for index, group in enumerate(groups):
        if not group:
            continue
        runner = 'scripts' if group[0].endswith(('.test.sh', '.py')) else 'bun'
        print('== export-test:' + ' '.join(group) + ' (export ' + str(archive) + ')', flush=True)
        # The gate's own runner: fresh-gate's run_affected_tests stage, so bun gets
        # suite-metrics.py's flags (--timeout=120000, --config) and scripts its sh/python3 split.
        records = scratch / ('records-' + str(index))
        summary = Path(str(records) + '.summary.json')
        stage = ['python3', str(HERE / 'suite-metrics.py'), 'stage',
                 '--runner', runner,
                 '--records', str(records), '--cwd', str(archive), '--tree', tree,
                 '--summary', str(summary), '--workers', str(min(workers, len(group))), '--deadline', '3600']
        if bun_config.is_file():
            stage += ['--bun-config', str(bun_config)]
        # Heavy lane exactly as fresh-gate's heavy_step: the gate's own cli.
        argv = ['bun', 'run', '--no-env-file', '--config=/dev/null', str(cli), 'heavy',
                '--label', 'commit-preflight-export-test', '--disk-observer', 'statfs', '--',
                'env', 'PATH=' + test_env.get('PATH', ''), *stage, *group]
        result = run(argv, deadline_s=3700, grace_s=5, max_output_bytes=8 * 1024 * 1024,
                     env=test_env, cwd=str(archive))
        sys.stdout.write(result.stdout.decode(errors='replace'))
        sys.stdout.write(result.stderr.decode(errors='replace'))
        rows = []
        if len(group) > 1 and summary.is_file():
            try:
                rows = json.loads(summary.read_text()).get('files') or []
            except (OSError, ValueError):
                rows = []
        for position, path in enumerate(group):
            row = rows[position] if len(group) > 1 and len(rows) == len(group) else None
            if row is not None and row.get('path') == path and not result.timed_out and not result.truncated:
                # A row whose output never proved a run is not a pass even with rc 0; a row with no
                # completeness fact passes only when the whole stage did.
                ok = row.get('rc') == 0 and (row.get('complete') is True or (row.get('complete') is None and result.rc == 0))
                why = 'incomplete run' if row.get('complete') is False else 'exit ' + str(row.get('rc'))
            else:
                ok = not (result.rc or result.timed_out or result.truncated)
                why = 'timed out' if result.timed_out else 'output truncated' if result.truncated else 'exit ' + str(result.rc)
            if ok:
                print('PASS export-test:' + path)
            else:
                failures += 1
                print('REFUSED EXPORT_TEST_FAILED ' + path + ' (' + why + ')')
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--message', type=Path)
    parser.add_argument('--files', nargs='+')
    parser.add_argument('--tests', nargs='+')
    args = parser.parse_args()
    started = time.monotonic()
    root = Path(required(['git', 'rev-parse', '--show-toplevel']).decode().strip())
    os.chdir(root)
    message = args.message.resolve() if args.message else None
    scratch_root = Path(os.environ.get('TMPDIR') or root / 'var' / 'agent-tmp')
    scratch_root.mkdir(parents=True, exist_ok=True)
    allocation = owned_tmp('commit-preflight', root=str(scratch_root))
    scratch = Path(allocation.path)
    env = dict(os.environ, TMPDIR=str(scratch))
    try:
        # Even git write-tree (used by the installed wallclock member) updates
        # index cache entries. Copy default/explicit staged indexes before any
        # check; keep all new blobs, trees and probe commits in owned scratch.
        caller_index = Path(os.fsdecode(required(
            ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'index'], env)).strip())
        objects = os.fsdecode(required(
            ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], env)).strip()
        env['GIT_INDEX_FILE'] = str(scratch / 'index')
        private_objects = scratch / 'objects'
        private_objects.mkdir()
        env['GIT_OBJECT_DIRECTORY'] = str(private_objects)
        alternates = env.get('GIT_ALTERNATE_OBJECT_DIRECTORIES')
        env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = json.dumps(objects, ensure_ascii=False) + (os.pathsep + alternates if alternates else '')
        if args.files:
            # Literal pathspecs prevent wildcard expansion and option injection.
            required(['git', 'read-tree', 'HEAD'], env)
            required(['git', '--literal-pathspecs', 'add', '-A', '--', *args.files], env)
        elif caller_index.is_file():
            shutil.copyfile(caller_index, env['GIT_INDEX_FILE'])
            required(['git', 'update-index', '--no-split-index'], env)
        else:
            required(['git', 'read-tree', '--empty'], env)
        if message is None:
            message = scratch / 'message'
            message.write_text('preflight\n')
        elif not message.is_file():
            raise RuntimeError('unreadable --message file')
        checks, failures = installed_checks(root, env)
        checks.extend((name, ['sh', str(HERE / ('check-staged-' + name + '.sh'))]) for name in
                      ('imports', 'readme', 'fragments', 'regexploit', 'pysafe', 'tempsafe', 'kitlib', 'br-init', 'wallclock', 'embed'))
        checks.append(('portable-paths', ['python3', '-B', str(HERE / 'portable_paths_check.py'), '--staged', '--repo', str(root)]))
        checks.append(('deploy-step', ['bash', str(HERE / 'check-deploy-step.sh'), str(message)]))
        message_checks = [
            ('stale-worktree', ['sh', str(HERE / 'check-stale-worktree.sh'), str(message)]),
            ('kitlib-reversal', ['python3', '-B', str(HERE / 'kitlib_ratchet.py'), '--verify-reversal-message', str(message), '--repo', str(root)]),
            ('commit-notes', ['sh', str(HERE / 'check-commit-notes.sh'), str(message)]),
        ]
        if args.message:
            checks.extend(message_checks)
            if command(['git', 'cat-file', '-e', 'HEAD:changelog.d'], env).rc == 0:
                # The commit member judges since the release floor. A fragment
                # already published after that floor cannot cover this new
                # direct commit in the push delta. Reuse the SAME native judge
                # with HEAD as its floor; an untouched fragment earns no credit.
                checks.append(('commit-notes-delta', ['sh', str(HERE / 'release-notes.sh'),
                               'fragment-for', '--message', str(message), '--base', 'HEAD']))
        else:
            for name, _argv in message_checks:
                print('NOT_JUDGED ' + name + ': supply --message FILE with the planned Bead/Revert/Supersedes trailers', flush=True)
        # Resolve sourced helpers from the effective INDEX, including unchanged
        # and non-.sh helpers. Cwd/source paths must never fall back to worktree.
        paths = required(['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], env).split(b'\0')
        shell_paths = [os.fsdecode(raw) for raw in paths if raw.endswith((b'.sh', b'.bash'))]
        shell_root = scratch / 'shell'
        if shell_paths:
            shell_root.mkdir()
            required(['git', 'checkout-index', '--all', '--prefix=' + str(shell_root) + os.sep], env)
            # A staged link must not send source resolution back to the host
            # worktree. Missing external helpers remain genuine SC1091 errors.
            for member in shell_root.rglob('*'):
                if member.is_symlink() and not member.resolve().is_relative_to(shell_root):
                    member.unlink()
        for path in shell_paths:
            dest = shell_root / path
            # Keep the changed script byte-exact even if checkout filters exist.
            if dest.is_file() and not dest.is_symlink():
                dest.write_bytes(required(['git', 'show', ':' + path], env))
            # Same engine, default severity and checker options as fresh-gate's
            # focused stage (see shellcheck_judge for the no-bind-mount runner).
            # Local 0.11 misses SC2015 that pinned CI 0.9 reports.
            # Never download during cheap feedback or silently substitute local.
            checks.append(('shellcheck:' + path, None))
        shellcheck_probe = None
        for name, argv in checks:
            print('== ' + name, flush=True)
            try:
                if name.startswith('shellcheck:'):
                    if shellcheck_probe is None:
                        shellcheck_probe = command(['docker', 'image', 'inspect',
                                                    SHELLCHECK_IMAGE, '--format', '{{.Id}}'], env)
                    if shellcheck_probe.rc:
                        raise RuntimeError('pinned ShellCheck unavailable: ' + shellcheck_probe.stderr.decode(errors='replace').strip())
                    result = shellcheck_judge(name[len('shellcheck:'):], shell_root, env)
                else:
                    result = command(argv, env)
                sys.stdout.write(result.stdout.decode(errors='replace'))
                sys.stdout.write(result.stderr.decode(errors='replace'))
                if name.startswith('shellcheck:') and result.rc not in (0, 1):
                    raise RuntimeError('pinned ShellCheck did not judge the file (exit ' + str(result.rc) + ')')
                if result.rc:
                    failures += 1
                    print('REFUSED ' + name + ' (exit ' + str(result.rc) + ')')
                elif name.startswith('installed-gate:'):
                    print('PASS ' + name)
                elif name == 'commit-notes-delta' and not note_has_added_line(result.stdout, env):
                    failures += 1
                    print('REFUSED commit-notes-delta (no added note line)')
            except (OSError, RuntimeError) as error:
                failures += 1
                remedy = '; require Docker and cached engine: docker pull koalaman/shellcheck:v0.9.0' if name.startswith('shellcheck:') else ''
                print('UNJUDGED ' + name + ': ' + str(error) + remedy)
        workers = 1
        if args.tests == ['affected']:
            # fresh-gate's test_workers: a quarter of the online cores, 2..4.
            workers = min(4, max(2, (os.cpu_count() or 4) // 4))
            try:
                args.tests = affected_tests(root, env)
                print('affected tests selected: ' + (' '.join(args.tests) or 'none'), flush=True)
            except (OSError, RuntimeError) as error:
                failures += 1
                args.tests = []
                print('UNJUDGED affected-tests: ' + str(error))
        if args.tests:
            try:
                failures += export_tests(args.tests, env, root, workers)
            except (OSError, RuntimeError) as error:
                failures += 1
                print('UNJUDGED export-tests: ' + str(error))
            print(f'commit-preflight: {len(checks)} checks, {failures} refused/unjudged, {time.monotonic() - started:.2f}s; {len(args.tests)} export test file(s) run; no fresh gate run')
        elif workers > 1:
            # PREFLIGHTAFFECTED1: the gate selects nothing for these paths, so there is nothing to run.
            print(f'commit-preflight: {len(checks)} checks, {failures} refused/unjudged, {time.monotonic() - started:.2f}s; 0 export test file(s) run; affected selection empty')
        else:
            print(f'commit-preflight: {len(checks)} checks, {failures} refused/unjudged, {time.monotonic() - started:.2f}s; no fresh gate or tests run')
        if not args.message:
            print('commit-preflight: message-dependent checks NOT_JUDGED; this is staged-file feedback, not commit admission')
        return int(failures != 0)
    finally:
        allocation.cleanup()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, KeyError, ValueError) as error:
        print('commit-preflight: UNJUDGED: ' + str(error), file=sys.stderr)
        sys.exit(2)
