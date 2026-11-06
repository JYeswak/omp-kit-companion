#!/bin/sh
# FIXEDENV1: one tool search order for release qualification and storegate.
# System Python precedes Homebrew (the latter may be a new, unprovisioned minor).
# Package-manager tools precede user shims; caller additions never enter this list.
PATH="/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:${HOME}/.bun/bin:${HOME}/.cargo/bin:${HOME}/.local/bin:${HOME}/bin"
LANG=C
LC_ALL=C
export PATH LANG LC_ALL
# Keep AGENT_NAME for reservation/commit custody; it is not a runtime input.
