#!/bin/sh
# OVNFSACCESS1: stat, not a lying NFS executable-access response, enables a member.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
. "$root/tests/cli/git-env-fixtures.sh"
python3 -B - "$root" <<'PY'
from __future__ import annotations
import os, pathlib, sys

root = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(root / 'scripts'))
from kitlib_tmp import owned_tmp
from kitlib_run import run


def execute(argv: list[str], *, cwd: pathlib.Path, env: dict[str, str]) -> None:
    result = run(argv, cwd=str(cwd), env=env, deadline_s=60)
    assert not result.timed_out and not result.truncated, (argv, result)
    assert result.rc == 0, (argv, result.rc, result.stdout.decode(), result.stderr.decode())


with owned_tmp('hook-runner-mode') as scratch:
    base = pathlib.Path(scratch).resolve()
    repo = base / 'repo'
    repo.mkdir()
    env = dict(os.environ, TMPDIR=str(base), GIT_CEILING_DIRECTORIES=str(base))
    for name in ('BASH_ENV', 'ENV'):
        env.pop(name, None)
    execute(['git', 'init', '--quiet', '--template='], cwd=repo, env=env)
    execute(['git', 'config', 'core.hooksPath', '.git/hooks'], cwd=repo, env=env)
    execute(['sh', str(root / 'scripts/install-commit-msg-bead.sh'), '--no-pushed-beads', str(repo)],
            cwd=repo, env=dict(env, OMP_KIT_GATE_EVENTS_SKIP='1'))
    hooks = repo / '.git/hooks'
    # Keep the actual generated runner; isolate its members, not production gates.
    (hooks / 'hooks.d').rename(hooks / 'installed-members')
    members = hooks / 'hooks.d/pre-commit'
    members.mkdir(parents=True)
    enabled = members / '01-enabled'
    disabled = members / '02-disabled'
    # No shebang: an access-only runner invokes these through sh even on Linux,
    # where the kernel would reject direct execution of the mode-600 member.
    enabled.write_text('printf ran > "$MODE_ENABLED_RAN"\n')
    disabled.write_text('printf ran > "$MODE_DISABLED_RAN"\n')
    enabled.chmod(0o700)
    disabled.chmod(0o600)
    assert disabled.stat().st_mode & 0o777 == 0o600
    enabled_ran = base / 'enabled-ran'
    disabled_ran = base / 'disabled-ran'
    access_lie = '''function [ {
    if test "$#" = 3 && test "$1" = -x && test "$2" = "$MODE_DISABLED"; then
        return 0
    fi
    builtin [ "$@"
}
. "$0"
'''

    def skipped_disabled(runner: pathlib.Path) -> bool:
        enabled_ran.unlink(missing_ok=True)
        disabled_ran.unlink(missing_ok=True)
        case_env = dict(env, MODE_DISABLED=str(runner.parent / 'hooks.d/pre-commit/02-disabled'),
                        MODE_ENABLED_RAN=str(enabled_ran), MODE_DISABLED_RAN=str(disabled_ran))
        execute(['bash', '--noprofile', '--norc', '-c', access_lie, str(runner)], cwd=repo, env=case_env)
        assert enabled_ran.read_text() == 'ran', 'enabled member did not execute'
        return not disabled_ran.exists()

    runner = hooks / 'pre-commit'
    assert skipped_disabled(runner), 'mode-600 member executed when executable access lied'
    # Planted access-only mutant loses the SAME real-member oracle. Application
    # errors cannot count as a kill: skipped_disabled requires a clean runner
    # exit and the enabled member's real output before examining the disabled one.
    mutant_hooks = base / 'mutant-hooks'
    mutant_hooks.mkdir()
    (mutant_hooks / 'hooks.d').symlink_to(hooks / 'hooks.d', target_is_directory=True)
    mutant = mutant_hooks / 'pre-commit'
    # The old -x-only selection is a planted defect, not a copy or text check
    # of the new implementation. Both runners execute the same real members.
    mutant.write_text('''#!/bin/sh
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
for hook in "$here/hooks.d/pre-commit"/[0-9][0-9]-*; do
    [ -e "$hook" ] || continue
    [ -x "$hook" ] || continue
    sh "$hook" || exit "$?"
done
''')
    assert not skipped_disabled(mutant), 'access-only mutant survived the disabled-member oracle'

print('hook runner mode contract passed')
PY
