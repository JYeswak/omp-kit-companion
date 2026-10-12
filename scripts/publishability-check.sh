#!/bin/sh
# publishability-check.sh — PUB1 publishability scan
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106).
# Scans tracked files (git ls-files) for shapes that must never go public:
# secret-shaped tokens, absolute home paths, private IPs and LAN hostnames.
# Skips var/agent-tmp scratch and .git. Prints `class: file:line` and never the matched text
# (ompkit-rc-epic-land-fix-release-dogfood-rz5.106.7): this repo is public, so a printed token
# lands in a public CI log and in the pre-push gate.log. Binary files are scanned too (-a), and an
# unreadable tracked file is itself a finding (fail closed). Exit 1 when any finding exists, 0
# when clean. Neutral fixtures (worker-1, example.invalid, 192.0.2.x) pass. Local check: no network, no GitHub.
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

cd -- "$ROOT" || fail "cannot cd to $ROOT"
# ROOT must be the top of a git work tree: a plain directory nested inside another repo (an
# extracted archive, a scratch copy) would otherwise enumerate nothing and report OK (rz5.106.7).
top=$(git rev-parse --show-toplevel 2>/dev/null) || fail "UNRUN: $ROOT is not inside a git work tree"
[ "$(cd -P -- "$top" && pwd)" = "$(pwd -P)" ] || fail "UNRUN: $ROOT is not the top of its git work tree ($top is)"
# Scratch goes in the scanned repo's own var/agent-tmp unless TMPDIR is set; never /tmp.
scratch=${TMPDIR:-$(pwd -P)/var/agent-tmp}
mkdir -p "$scratch" || fail "cannot create scratch dir $scratch"
TMP_FINDINGS=$(mktemp "$scratch/publishability.XXXXXX") || fail "cannot create findings file"
TMP_FILES=$(mktemp "$scratch/publishability-files.XXXXXX") || fail "cannot create file list"
TMP_HITS=$(mktemp "$scratch/publishability-hits.XXXXXX") || fail "cannot create hit file"
trap 'rm -f "$TMP_FINDINGS" "$TMP_FILES" "$TMP_HITS"' EXIT INT TERM

# Every producer is checked (rz5.106.7): a failed enumeration or a grep error (rc > 1) is exit 2,
# never an empty scan that ends in OK. grep rc 1 means no match.
# core.quotePath=false keeps non-ASCII names literal; git still C-quotes a name holding a tab,
# newline, quote or backslash, which this line-based loop cannot open, so such a name is a finding
# (unscannable-name), never a silent skip.
git -c core.quotePath=false ls-files > "$TMP_FILES" || fail "git ls-files failed (rc $?): nothing was scanned"
# scan CLASS PATTERN FILE [EXEMPT]: report class: file:line for each match, never the match text.
# EXEMPT is an ERE over line:match that drops a hit (documentation nets, the shared users dir).
scan() {
	rc=0
	grep -naoE -- "$2" "$3" > "$TMP_HITS" || rc=$?
	[ "$rc" -le 1 ] || fail "grep failed on $3 (rc $rc): scan incomplete"
	if [ -n "${4:-}" ]; then grep -vE -- "$4" "$TMP_HITS" || true; else cat "$TMP_HITS"; fi \
		| cut -d: -f1 | F="$3" C="$1" awk '{ print ENVIRON["C"] ": " ENVIRON["F"] ":" $0 }' >> "$TMP_FINDINGS"
}
scanned=0
while IFS= read -r file; do
	case "$file" in
		var/agent-tmp/*|.git/*) continue ;;
	esac
	case "$file" in
		\"*) printf 'unscannable-name: %s\n' "$file" >> "$TMP_FINDINGS"; continue ;;
	esac
	[ -f "$file" ] || continue
	scanned=$((scanned + 1))
	if [ ! -r "$file" ]; then
		printf 'unreadable: %s\n' "$file" >> "$TMP_FINDINGS"
		continue
	fi
	# Absolute per-user home roots are refused; $HOME, ~ and shared-system paths pass.
	scan home-path '/Users/[^ /:]+|/home/[^ /:]+' "$file" '^[0-9]+:/Users/Shared$'
	# Secrets (fixed literal anchors, bounded token bodies).
	scan secret 'ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,120}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,200}|sk-live-[A-Za-z0-9]{16,100}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$file"
	# Private IPs except the documentation TEST-NETs.
	scan private-ip '(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})' "$file" '^[0-9]+:(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)'
	# LAN hostnames; example.invalid and worker-1 pass.
	scan hostname '[A-Za-z0-9_.-]+\.(local|lan|internal|corp|home\.arpa)\b' "$file"
done < "$TMP_FILES"

if [ -s "$TMP_FINDINGS" ]; then
	sort -u "$TMP_FINDINGS"
	printf 'publishability: FAIL (%s finding(s), %s file(s) scanned)\n' "$(wc -l < "$TMP_FINDINGS" | tr -d ' ')" "$scanned" >&2
	exit 1
fi
# Zero scanned subjects is not a clean result: an empty repo or an all-excluded tree proves nothing.
[ "$scanned" -gt 0 ] || fail "UNRUN: 0 tracked files scanned"
printf 'publishability: OK (%s file(s) scanned)\n' "$scanned"
