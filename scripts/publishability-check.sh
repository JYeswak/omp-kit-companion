#!/bin/sh
# publishability-check.sh — PUB1 publishability scan
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106).
# Scans tracked files (git ls-files) for shapes that must never go public:
# secret-shaped tokens, absolute home paths, private IPs and LAN hostnames.
# Skips var/agent-tmp scratch, .git and binaries. Prints file:line findings;
# exit 1 when any finding exists, 0 when clean. Neutral fixtures (worker-1,
# example.invalid, 192.0.2.x) pass. Local check: no network, no GitHub.
# Patterns follow the regex-engineering skill: literal-anchored, bounded
# classes, no nested quantifiers (linear in grep -E / ripgrep default).
# Usage: publishability-check.sh [ROOT]
set -u

ROOT=${1:-.}
fail() {
	printf 'publishability: %s\n' "$1" >&2
	exit 2
}

command -v git >/dev/null 2>&1 || fail "git is required (scans tracked files)"
command -v grep >/dev/null 2>&1 || fail "grep is required"

TMP_FINDINGS=$(mktemp "${TMPDIR:-/tmp}/publishability.XXXXXX") || fail "cannot create findings file"
trap 'rm -f "$TMP_FINDINGS"' EXIT INT TERM

cd -- "$ROOT" || fail "cannot cd to $ROOT"

# Tracked text files, one per line.
git ls-files | while IFS= read -r file; do
	case "$file" in
		var/agent-tmp/*|.git/*) continue ;;
	esac
	[ -f "$file" ] || continue
	{
		# Absolute per-user home roots are refused; $HOME, ~ and
		# shared-system paths pass.
		grep -HnE -- '/Users/[^ /:]+|/home/[^ /:]+' "$file" 2>/dev/null | grep -v '/Users/Shared/' | sed 's/^/home-path: /'
		# Secrets (fixed literal anchors, bounded token bodies).
		grep -HnEI -- 'ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,120}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,200}|sk-live-[A-Za-z0-9]{16,100}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$file" 2>/dev/null | sed 's/^/secret: /'
		# Private IPs except the documentation TEST-NETs.
		grep -HnEo -- '(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})' "$file" 2>/dev/null | grep -vE '192\.0\.2\.|198\.51\.100\.|203\.0\.113\.' | sed 's/^/private-ip: /'
		# LAN hostnames; example.invalid and worker-1 pass.
		grep -HnEo -- '[A-Za-z0-9_.-]+\.(local|lan|internal|corp|home\.arpa)\b' "$file" 2>/dev/null | sed 's/^/hostname: /'
	} >> "$TMP_FINDINGS"
done

if [ -s "$TMP_FINDINGS" ]; then
	sort -u "$TMP_FINDINGS"
	printf 'publishability: FAIL (%s finding(s))\n' "$(wc -l < "$TMP_FINDINGS" | tr -d ' ')" >&2
	exit 1
fi
printf 'publishability: OK\n'
