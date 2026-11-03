#!/usr/bin/env python3
"""Aggregate existing staged check entrypoints without running commit/fresh gates.

--files PATH... overlays working bytes onto HEAD in a private index; no option
judges the effective staged index, including GIT_INDEX_FILE. --message FILE
supplies planned trailers; absent it Deploy-Step is intentionally checked against
an empty message, so deployment obligations are discovered before composing it.
"""
import argparse
import os
from pathlib import Path
import sys
import time

from kitlib_run import run
from kitlib_tmp import owned_tmp

HERE = Path(__file__).resolve().parent


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--message', type=Path)
    parser.add_argument('--files', nargs='+')
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
        if args.files:
            # Literal pathspecs prevent wildcard expansion and option injection.
            env['GIT_INDEX_FILE'] = str(scratch / 'index')
            required(['git', 'read-tree', 'HEAD'], env)
            required(['git', '--literal-pathspecs', 'add', '-A', '--', *args.files], env)
        if message is None:
            message = scratch / 'message'
            message.write_text('preflight\n')
        elif not message.is_file():
            raise RuntimeError('unreadable --message file')
        checks = [(name, ['sh', str(HERE / ('check-staged-' + name + '.sh'))]) for name in
                  ('imports', 'readme', 'fragments', 'regexploit', 'pysafe', 'tempsafe', 'kitlib', 'sources', 'br-init', 'wallclock')]
        checks.append(('portable-paths', ['python3', '-B', str(HERE / 'portable_paths_check.py'), '--staged', '--repo', str(root)]))
        checks.append(('deploy-step', ['bash', str(HERE / 'check-deploy-step.sh'), str(message)]))
        message_checks = [
            ('stale-worktree', ['sh', str(HERE / 'check-stale-worktree.sh'), str(message)]),
            ('kitlib-reversal', ['python3', '-B', str(HERE / 'kitlib_ratchet.py'), '--verify-reversal-message', str(message), '--repo', str(root)]),
            ('commit-notes', ['sh', str(HERE / 'check-commit-notes.sh'), str(message)]),
        ]
        if args.message:
            checks.extend(message_checks)
        else:
            for name, _argv in message_checks:
                print('NOT_JUDGED ' + name + ': supply --message FILE with the planned Bead/Revert/Supersedes trailers', flush=True)
        # ShellCheck reads the very same staged bytes, never unstaged edits.
        paths = required(['git', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'], env).split(b'\0')
        for raw in paths:
            if not raw:
                continue
            path = os.fsdecode(raw)
            if not path.endswith(('.sh', '.bash')):
                continue
            dest = scratch / 'shell' / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(required(['git', 'show', ':' + path], env))
            checks.append(('shellcheck:' + path, ['shellcheck', str(dest)]))
        failures = 0
        for name, argv in checks:
            print('== ' + name, flush=True)
            try:
                result = command(argv, env)
                sys.stdout.write(result.stdout.decode(errors='replace'))
                sys.stdout.write(result.stderr.decode(errors='replace'))
                if result.rc:
                    failures += 1
                    print('REFUSED ' + name + ' (exit ' + str(result.rc) + ')')
            except (OSError, RuntimeError) as error:
                failures += 1
                print('UNJUDGED ' + name + ': ' + str(error))
        print(f'commit-preflight: {len(checks)} checks, {failures} refused, {time.monotonic() - started:.2f}s; no fresh gate or tests run')
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
