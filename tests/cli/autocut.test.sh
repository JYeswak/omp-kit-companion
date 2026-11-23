#!/bin/sh
# autocut.test.sh -- AUTOCUT1 (ompkit-2uubn) contract for scripts/autocut.sh on an owned fixture repo.
# Each fixture commit carries a stub full-suite-verdict-store.py that answers PASS only for trees listed in
# $PASS_TREES, so verdicts are planted per tree; release and install are stub commands that record their args.
set -u
REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
AUTOCUT="${AUTOCUT_UNDER_TEST:-$REPO/scripts/autocut.sh}"
mkdir -p "$REPO/var/agent-tmp" || exit 1
. "$REPO/scripts/kitlib-tmp.sh"
KITLIB_TMP_ROOT="$REPO/var/agent-tmp" kitlib_tmp TMP autocut-test || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

origin="$TMP/origin.git"
git init -q --bare "$origin"
repo="$TMP/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email t@example.invalid
git -C "$repo" config user.name t
mkdir -p "$repo/scripts"
cat > "$repo/scripts/full-suite-verdict-store.py" <<'PY'
import os, sys
tree = sys.argv[sys.argv.index("--tree") + 1]
listed = open(os.environ["PASS_TREES"]).read().split() if os.path.exists(os.environ.get("PASS_TREES", "")) else []
pinned = os.environ.get("PINNED_DIR")
# AUTOCUTENV1: like the real store, a verdict is readable only by the interpreter order it was judged under.
if pinned and not os.environ.get("PATH", "").startswith(pinned + ":"):
    print("MISS")
    sys.exit(1)
print("PASS" if tree in listed else "MISS")
sys.exit(0 if tree in listed else 1)
PY
# The fixture's pinned tool order (the real one is scripts/fixed-env.sh): a no-op unless the test sets PINNED_DIR.
# shellcheck disable=SC2016 # the fixture's fixed-env.sh expands PINNED_DIR when sourced, not this shell
printf 'PATH="${PINNED_DIR:+$PINNED_DIR:}$PATH"\nexport PATH\n' > "$repo/scripts/fixed-env.sh"
# The verdict readback runs under the candidate's own scripts/pysafe.py, as in the real repo.
cp "$REPO/scripts/pysafe.py" "$repo/scripts/pysafe.py"
commit() { # VERSION MESSAGE -> prints the new sha
	printf '{"name":"fixture","version":"%s"}\n' "$1" > "$repo/package.json"
	printf '%s\n' "$2" > "$repo/note.txt"
	git -C "$repo" add -A
	git -C "$repo" commit -q -m "$2" --no-verify
	git -C "$repo" rev-parse HEAD
}
base=$(commit 0.1.0 base)
git -C "$repo" tag v0.1.0 "$base"
git -C "$repo" remote add origin "$origin"
git -C "$repo" push -q origin main --tags 2>/dev/null
commit 0.1.1 "prepare 0.1.1" >/dev/null
c2=$(commit 0.1.1 "work two")
c3=$(commit 0.1.1 "work three")
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
tree() { git -C "$repo" rev-parse "$1^{tree}"; }
export PASS_TREES="$TMP/pass-trees" AUTOCUT_NO_FETCH=1 TMPDIR="$TMP"
releases() { # PUBLISHED_AT for v0.1.0
	printf '[[{"tag_name":"v0.1.0","draft":false,"prerelease":false,"published_at":"%s"}]]\n' "$1" > "$TMP/releases.json"
}
releases "2026-01-01T00:00:00Z"
export AUTOCUT_RELEASES_JSON="$TMP/releases.json"
field() { printf '%s' "$1" | tail -n 1 | jq -r ".$2"; }

# 1. Newest commit FAIL/missing, previous PASS: the PASS one is picked (planted FAIL skips to the previous PASS).
tree "$c2" > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c2" ] && [ "$(field "$out" version)" = 0.1.1 ]; then ok; else bad "plan picks newest PASS: $out"; fi

# 1b. AUTOCUTENV1 (ompkit-2uubn): the verdict reader runs under the PATH the candidate's scripts/fixed-env.sh pins, not the caller's.
# The launchd job's PATH put Homebrew python 3.15 before /usr/bin 3.9.6, so every PASS judged under the pinned order read back MISS.
mkdir -p "$TMP/pinned"
ln -sf "$(command -v python3)" "$TMP/pinned/python3"
tree "$c2" > "$PASS_TREES"
out=$(PINNED_DIR="$TMP/pinned" sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c2" ]; then ok; else bad "pinned-order read finds the PASS: $out"; fi

# 2. No PASS anywhere: WAIT, naming each skipped commit.
: > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'no-pass'; then ok; else bad "no PASS waits: $out"; fi

# 3. The floor: a release published moments ago waits even with a PASS; --now cuts.
tree "$c3" > "$PASS_TREES"
releases "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'floor'; then ok; else bad "floor waits: $out"; fi
out=$(sh "$AUTOCUT" plan --repo "$repo" --now 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c3" ]; then ok; else bad "--now cuts: $out"; fi
releases "2026-01-01T00:00:00Z"

# 4. A version not newer than the release is never a candidate (no prepare commit yet).
c4=$(commit 0.1.0 "unprepared work")
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
tree "$c4" > "$PASS_TREES"
out=$(sh "$AUTOCUT" plan --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = WAIT ] && printf '%s' "$out" | grep -q 'version-0.1.0'; then ok; else bad "unprepared version waits: $out"; fi

# 5. run --dry-run: release-local gets the exact version, source and --dry-run; nothing installed.
tree "$c3" > "$PASS_TREES"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "%s/release-args"\n' "$TMP" > "$TMP/release-stub"
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" AUTOCUT_INSTALL="false" sh "$AUTOCUT" run --repo "$repo" --dry-run 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(cat "$TMP/release-args")" = "--version 0.1.1 --source $c3 --dry-run" ]; then ok; else bad "dry run args: $out / $(cat "$TMP/release-args" 2>/dev/null)"; fi

# 6. A push landing mid-cut never changes what is released (no freeze needed).
cat > "$TMP/release-pushes" <<EOF
#!/bin/sh
printf '%s\n' "\$*" > "$TMP/release-args"
printf 'mid-cut\n' > "$repo/mid.txt"
git -C "$repo" add mid.txt && git -C "$repo" commit -q -m "landed mid-cut" --no-verify && git -C "$repo" push -q origin main 2>/dev/null
EOF
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-pushes" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c3" ] \
	&& [ "$(cat "$TMP/release-args")" = "--version 0.1.1 --source $c3 --no-install" ] \
	&& [ "$(git -C "$origin" rev-parse main)" != "$c3" ]; then ok; else bad "mid-cut push: $out"; fi

# 7. An install that reads back another version fails the run (exit 4), never reports CUT.
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" AUTOCUT_INSTALL="echo 0.0.9 #" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ]; then ok; else bad "wrong installed version: rc=$rc $out"; fi

# 8. A refused release-local fails the run and never installs.
out=$(AUTOCUT_RELEASE_LOCAL="false" AUTOCUT_INSTALL="echo 0.1.1 #" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ]; then ok; else bad "refused release: rc=$rc $out"; fi

# 8b. The production cut (no test seam) runs release-local from an owned clone of origin at the source commit, never from the
# shared tree: the clone's HEAD is the source, its path is not the repo's, and release-local is told --no-install.
cat > "$repo/scripts/release-local.sh" <<EOF
#!/bin/sh
here=\$(CDPATH='' cd -- "\$(dirname -- "\$0")/.." && pwd -P)
printf '%s\n%s\n%s\n' "\$*" "\$here" "\$(git -C "\$here" rev-parse HEAD)" > "$TMP/clone-args"
EOF
c5=$(commit 0.1.2 "release stub in tree")
git -C "$repo" push -q origin main 2>/dev/null
git -C "$repo" fetch -q origin
tree "$c5" > "$PASS_TREES"
out=$(AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
clone_args=$(sed -n 1p "$TMP/clone-args" 2>/dev/null); clone_here=$(sed -n 2p "$TMP/clone-args" 2>/dev/null); clone_head=$(sed -n 3p "$TMP/clone-args" 2>/dev/null)
if [ "$(field "$out" action)" = CUT ] && [ "$(field "$out" source)" = "$c5" ] \
	&& [ "$clone_args" = "--version 0.1.2 --source $c5 --no-install" ] && [ "$clone_head" = "$c5" ] \
	&& [ -n "$clone_here" ] && [ "$clone_here" != "$repo" ]; then ok; else bad "clone cut: $out / $clone_args / $clone_here / $clone_head"; fi

# 8c. A transient failure that left a draft (release-local says so) is resumed once, with --resume-from-draft and no source.
cat > "$TMP/release-flaky" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$TMP/flaky-args"
if [ "\$(wc -l < "$TMP/flaky-args" | tr -d ' ')" = 1 ]; then
	printf 'release-local: refused: attest-local run 1 ended: completed failure (draft v0.1.2 kept; fix and redispatch, never re-tag)\n' >&2
	exit 4
fi
EOF
rm -f "$TMP/flaky-args"
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-flaky" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(wc -l < "$TMP/flaky-args" | tr -d ' ')" = 2 ] \
	&& [ "$(sed -n 1p "$TMP/flaky-args")" = "--version 0.1.2 --source $c5 --no-install" ] \
	&& [ "$(sed -n 2p "$TMP/flaky-args")" = "--resume-from-draft --version 0.1.2 --no-install" ]; then ok; else bad "resume once: $out / $(cat "$TMP/flaky-args" 2>/dev/null)"; fi

# 8d. Planted: a failure that kept no draft is never retried, and a second failure after a resume is FAILED, not a loop.
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/plain-args"\nprintf "release-local: refused: dirty tree\\n" >&2\nexit 4\n' "$TMP" > "$TMP/release-plain"
rm -f "$TMP/plain-args"
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-plain" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ] && [ "$(wc -l < "$TMP/plain-args" | tr -d ' ')" = 1 ]; then ok; else bad "no retry without a kept draft: rc=$rc $out / $(cat "$TMP/plain-args" 2>/dev/null)"; fi
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/twice-args"\nprintf "release-local: refused: attest ended (draft v0.1.2 kept; fix and redispatch)\\n" >&2\nexit 4\n' "$TMP" > "$TMP/release-twice"
rm -f "$TMP/twice-args"
out=$(AUTOCUT_RELEASE_LOCAL="sh $TMP/release-twice" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ] && [ "$(wc -l < "$TMP/twice-args" | tr -d ' ')" = 2 ]; then ok; else bad "one resume only: rc=$rc $out / $(cat "$TMP/twice-args" 2>/dev/null)"; fi

# 8e. The default install path (no AUTOCUT_INSTALL seam) with a fake gh and a fake omp-kit on PATH and a private HOME.
# The fake omp-kit prints $FAKE_ENVELOPE for `update` and exits $FAKE_RC; `--version` prints $FAKE_VERSION.
mkdir -p "$TMP/fakebin" "$TMP/fakehome"
cat > "$TMP/fakebin/gh" <<'EOF'
#!/bin/sh
dir=''
while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done
printf '{}\n' > "$dir/release-index.json"
printf 'archive-bytes\n' > "$dir/omp-kit-v0.1.2-darwin-arm64-none.tar.gz"
if [ "${FAKE_BAD_SUMS:-0}" = 1 ]; then printf '%064d  omp-kit-v0.1.2-darwin-arm64-none.tar.gz\n' 0 > "$dir/SHA256SUMS"
else (cd "$dir" && shasum -a 256 omp-kit-v0.1.2-darwin-arm64-none.tar.gz > SHA256SUMS); fi
EOF
cat > "$TMP/fakebin/omp-kit" <<'EOF'
#!/bin/sh
if [ "$1" = --version ]; then printf 'omp-kit %s\n' "$FAKE_VERSION"; exit 0; fi
printf 'update called\n' >> "$FAKE_CALLS"
cat "$FAKE_ENVELOPE"
exit "${FAKE_RC:-0}"
EOF
chmod +x "$TMP/fakebin/gh" "$TMP/fakebin/omp-kit"
envelope() { # POSTCHECK -> an update envelope for 0.1.2 with manifest findings
	printf '{"ok":false,"data":{"action":"UPDATED","overall":"FINDINGS","active_version":"0.1.2","matcher":"PASS","live":"PASS","postcheck":"%s"},"errors":[{"code":"MANIFEST_APPLY_FAILED","message":"service:cc: FLEET_ADAPTER_ABSENT: no fleet checkout"},{"code":"MANIFEST_APPLY_FAILED","message":"rules:rules: RULE_COLLISION"}]}\n' "$1" > "$TMP/envelope.json"
}
default_install() { # RC VERSION POSTCHECK [BAD_SUMS] -> output; leaves the calls file for the caller
	envelope "$3"
	rm -f "$TMP/update-calls"
	HOME="$TMP/fakehome" PATH="$TMP/fakebin:$PATH" FAKE_ENVELOPE="$TMP/envelope.json" FAKE_CALLS="$TMP/update-calls" FAKE_RC="$1" FAKE_VERSION="$2" FAKE_BAD_SUMS="${4:-0}" \
		AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" sh "$AUTOCUT" run --repo "$repo" 2>&1
}
# an update that exits 1 with the release active and every judge PASS is an installed release with named findings
out=$(default_install 1 0.1.2 PASS)
if [ "$(field "$out" action)" = CUT ] && printf '%s' "$out" | grep -q 'INSTALLED_WITH_FINDINGS' && printf '%s' "$out" | grep -q 'FLEET_ADAPTER_ABSENT' && printf '%s' "$out" | grep -q 'RULE_COLLISION'; then ok; else bad "installed with findings: $out"; fi
# the same exit with a failed postcheck, or with another version active, is a refusal
out=$(default_install 1 0.1.2 FAIL); rc=$?
if [ "$rc" = 4 ] && ! printf '%s' "$out" | grep -q '"action":"CUT"'; then ok; else bad "failed postcheck must refuse: rc=$rc $out"; fi
out=$(default_install 1 0.0.9 PASS); rc=$?
if [ "$rc" = 4 ] && ! printf '%s' "$out" | grep -q '"action":"CUT"'; then ok; else bad "other active version must refuse: rc=$rc $out"; fi
# a clean exit is a plain CUT with no findings decision
out=$(default_install 0 0.1.2 PASS)
if [ "$(field "$out" action)" = CUT ] && ! printf '%s' "$out" | grep -q 'INSTALLED_WITH_FINDINGS'; then ok; else bad "clean install: $out"; fi
# assets that do not match SHA256SUMS never reach the updater
out=$(default_install 0 0.1.2 PASS 1); rc=$?
if [ "$rc" = 4 ] && [ ! -e "$TMP/update-calls" ]; then ok; else bad "bad checksums must stop before update: rc=$rc $(cat "$TMP/update-calls" 2>/dev/null) $out"; fi

# 8f. AUTOCUTADVANCE1: a cut whose next-version commit did not land (release-local names `--advance-only` as the retry) is advanced
# from a fresh clone, never left published-but-uninstalled; the retry is bounded and only that hint triggers it.
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/adv-release-args"\nprintf "release-local: refused: next-version commit abc is on local main and origin moved; NEXT_VERSION_CONVERGE_FAILED (see above); retry: release-local --advance-only --version 0.1.2\\n" >&2\nexit 4\n' "$TMP" > "$TMP/release-adv"
# shellcheck disable=SC2016 # the generated stub expands $* and $n when it runs, not this shell
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/adv-args"\nn=$(wc -l < "%s/adv-args" | tr -d " ")\n[ "$n" -ge "${ADV_SUCCEED_AT:-2}" ] || { printf "advance: conflict\\n" >&2; exit 4; }\n' "$TMP" "$TMP" > "$TMP/advance-stub"
rm -f "$TMP/adv-args" "$TMP/adv-release-args"
out=$(AUTOCUT_ADVANCE_PAUSE_S=0 ADV_SUCCEED_AT=2 AUTOCUT_RELEASE_LOCAL="sh $TMP/release-adv" AUTOCUT_ADVANCE="sh $TMP/advance-stub" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
if [ "$(field "$out" action)" = CUT ] && [ "$(wc -l < "$TMP/adv-args" | tr -d ' ')" = 2 ] && [ "$(sed -n 1p "$TMP/adv-args")" = "--advance-only --version 0.1.2" ] \
	&& [ "$(wc -l < "$TMP/adv-release-args" | tr -d ' ')" = 1 ] && grep -q '"action":"ADVANCING"' "$repo/.git/omp-kit/autocut.log"; then ok; else bad "advance heals the next-version failure: $out / $(cat "$TMP/adv-args" 2>/dev/null)"; fi
# planted: an advance that fails three times is FAILED after exactly three attempts, and the install never runs
rm -f "$TMP/adv-args"
out=$(AUTOCUT_ADVANCE_PAUSE_S=0 ADV_SUCCEED_AT=99 AUTOCUT_RELEASE_LOCAL="sh $TMP/release-adv" AUTOCUT_ADVANCE="sh $TMP/advance-stub" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ] && [ "$(wc -l < "$TMP/adv-args" | tr -d ' ')" = 3 ]; then ok; else bad "advance is bounded at three: rc=$rc $out / $(wc -l < "$TMP/adv-args" 2>/dev/null)"; fi
# planted: a refusal without the advance-only hint (dirty tree) never triggers an advance
rm -f "$TMP/adv-args"
out=$(AUTOCUT_ADVANCE_PAUSE_S=0 AUTOCUT_RELEASE_LOCAL="sh $TMP/release-plain" AUTOCUT_ADVANCE="sh $TMP/advance-stub" AUTOCUT_INSTALL="echo" sh "$AUTOCUT" run --repo "$repo" 2>&1)
rc=$?
if [ "$rc" = 4 ] && [ "$(field "$out" action)" = FAILED ] && [ ! -e "$TMP/adv-args" ]; then ok; else bad "no advance without the hint: rc=$rc $out"; fi

# 8g. AUTOCUTRECONCILE1: an update left PARTIAL by fleet writes under the kit state root (and nothing else) is reconciled by the run;
# a failed stage, a failure outside the state root, or a missing receipt id is never reconciled.
cat > "$TMP/fakebin/omp-kit" <<'EOF'
#!/bin/sh
if [ "$1" = --version ]; then printf 'omp-kit %s\n' "$FAKE_VERSION"; exit 0; fi
case "$*" in
	*--reconcile*) printf 'reconcile %s\n' "$*" >> "$FAKE_CALLS"; printf '{"ok":true,"data":{"action":"RECONCILED"}}\n'; exit "${FAKE_RECONCILE_RC:-0}" ;;
esac
printf 'update called\n' >> "$FAKE_CALLS"
cat "$FAKE_ENVELOPE"
exit "${FAKE_RC:-0}"
EOF
chmod +x "$TMP/fakebin/omp-kit"
partial_envelope() { # FAILURE_JSON_ARRAY FAILED_STAGES_JSON_ARRAY RECEIPT -> a PARTIAL envelope for 0.1.2
	printf '{"ok":false,"data":{"action":"PARTIAL","overall":"FAIL","active_version":"0.1.2","matcher":"PASS","live":"PASS","postcheck":"FAIL","receipt_id":"%s","postcheck_detail":{"failed_stages":%s,"failures":%s}},"errors":[{"code":"KIT_POSTCHECK_FAILED","message":"x"}]}\n' "$3" "$2" "$1" > "$TMP/envelope.json"
}
partial_install() { # -> output; uses $TMP/envelope.json
	rm -f "$TMP/update-calls"
	HOME="$TMP/fakehome" PATH="$TMP/fakebin:$PATH" FAKE_ENVELOPE="$TMP/envelope.json" FAKE_CALLS="$TMP/update-calls" FAKE_RC=1 FAKE_VERSION=0.1.2 \
		AUTOCUT_RELEASE_LOCAL="sh $TMP/release-stub" sh "$AUTOCUT" run --repo "$repo" 2>&1
}
RCPT=95d0b12e-0fed-4076-a194-67256f795829
partial_envelope '["Operator file changed during isolated test: ~/.local/state/omp-kit/pregrade/evidence/x","Operator file changed during isolated test: ~/.local/state/omp-kit/pregrade/x.json"]' '[]' "$RCPT"
out=$(partial_install)
if [ "$(field "$out" action)" = CUT ] && printf '%s' "$out" | grep -q INSTALLED_RECONCILED && grep -q "reconcile update --reconcile $RCPT --yes --json" "$TMP/update-calls"; then ok; else bad "fleet-write PARTIAL is reconciled: $out / $(cat "$TMP/update-calls" 2>/dev/null)"; fi
partial_envelope '["Operator file changed during isolated test: ~/.agents/rules/mine.md"]' '[]' "$RCPT"
out=$(partial_install); rc=$?
if [ "$rc" = 4 ] && ! grep -q reconcile "$TMP/update-calls"; then ok; else bad "a failure outside the state root must not be reconciled: rc=$rc $out"; fi
partial_envelope '["Operator file changed during isolated test: ~/.local/state/omp-kit/pregrade/x.json"]' '["cli-crosscheck"]' "$RCPT"
out=$(partial_install); rc=$?
if [ "$rc" = 4 ] && ! grep -q reconcile "$TMP/update-calls"; then ok; else bad "a failed stage must not be reconciled: rc=$rc $out"; fi
partial_envelope '["Operator file changed during isolated test: ~/.local/state/omp-kit/pregrade/x.json","Planted negative control was not named RED"]' '[]' "$RCPT"
out=$(partial_install); rc=$?
if [ "$rc" = 4 ] && ! grep -q reconcile "$TMP/update-calls"; then ok; else bad "one non-fleet failure among fleet ones must not be reconciled: rc=$rc $out"; fi
partial_envelope '["Operator file changed during isolated test: ~/.local/state/omp-kit/pregrade/x.json"]' '[]' "not-a-receipt"
out=$(partial_install); rc=$?
if [ "$rc" = 4 ] && ! grep -q reconcile "$TMP/update-calls"; then ok; else bad "no valid receipt id must not be reconciled: rc=$rc $out"; fi

# 9. Every decision is logged.
if [ "$(wc -l < "$repo/.git/omp-kit/autocut.log" | tr -d ' ')" -ge 9 ]; then ok; else bad "autocut.log has $(wc -l < "$repo/.git/omp-kit/autocut.log") lines"; fi

printf 'autocut: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
