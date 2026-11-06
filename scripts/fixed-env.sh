#!/bin/sh
# FIXEDENV1: one tool search order for release qualification and storegate.
# System Python precedes Homebrew (the latter may be a new, unprovisioned minor).
# Prefer Tern's native OMP launcher where installed; never the HOME-sensitive trust wrapper.
# Package-manager tools precede user shims; caller additions never enter this list.
PATH="${HOME}/Library/Application Support/Tern/omp/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:${HOME}/.bun/bin:${HOME}/.cargo/bin:${HOME}/.local/bin:${HOME}/bin"
LANG=C
LC_ALL=C
export PATH LANG LC_ALL
# Execute a gate in the allowlist constructed by suite-metrics. The directory is
# explicit so sourced helpers and fixture-owned policies use their own judge.
fixed_env_exec() {
	fixed_env_dir=$1
	shift
	fixed_env_command=$(CDPATH='' cd -- "$fixed_env_dir" && python3 -I -B suite-metrics.py shell-environment) || exit 1
	# Only trusted, shlex-quoted constructor output is evaluated. Arguments stay
	# positional; exec preserves the gate PID and its existing lifecycle owner.
	eval "exec $fixed_env_command \"\$@\""
}
hash -r
