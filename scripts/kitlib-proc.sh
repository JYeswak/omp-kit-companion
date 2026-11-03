#!/bin/sh
# PIDGUARD1: destructive signals must never accept pid 0, 1 or negative sentinels.
# Use kitlib_signal SIGNAL PID [group]; invalid input returns 2 without invoking kill.
kitlib_safe_pid() (
  [ "$#" -eq 1 ] || return 2
  value=$1
  [ "${#value}" -le 32 ] || return 2
  case "$value" in ''|*[!0-9]*) return 2 ;; esac
  while [ "${value#0}" != "$value" ]; do value=${value#0}; done
  [ -n "$value" ] && [ "${#value}" -le 10 ] || return 2
  [ "$value" -gt 1 ] && [ "$value" -le 2147483647 ] || return 2
  printf '%s\n' "$value"
)
kitlib_signal() (
  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || return 2
  pid=$(kitlib_safe_pid "$2") || return 2
  case "${3:-pid}" in
    pid) kill "-$1" "$pid" ;;
    group) kill "-$1" "-$pid" ;;
    *) return 2 ;;
  esac
)
