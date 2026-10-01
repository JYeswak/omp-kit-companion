#!/bin/sh
# plugin-lifecycle.sh — G1: the repo as a native OMP plugin, end to end.
#
# In an isolated HOME against the real installed OMP: link the repo,
# prove the 17 stream rules arrive via omp-plugins, walk the
# precedence matrix (legacy < plugin < overlay, disable reactivates
# legacy), run one live tripwire through the linked plugin, prove the
# same scenario does NOT block with the plugin disabled, then uninstall
# clean. Optional git-install/upgrade (INSTALL_REF) and release-archive
# (ARCHIVE_VERSION) checks.
#
# Every step appends one JSONL line
# ({step, argv, rc, seconds, verdict, artifact}) to steps.jsonl and keeps
# its complete producer stdout in a per-step log. A failing step
# prints its input and observed vs expected values, then exits nonzero.
#
# Usage: sh scripts/plugin-lifecycle.sh
# Env:   OMP=/path/to/omp  REPO=/abs/repo (default: this checkout)
#        INSTALL_REF=branch-or-tag (skip git install/upgrade when empty)
#        ARCHIVE_VERSION=X.Y.Z  ARCHIVE_PLATFORM=darwin-arm64-none (skip archive check when empty)
#        TIMEOUT=120 (seconds per live scenario)
#        KEEP=1 (keep the scratch dir)
set -u
HERE=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
REPO="${REPO:-$HERE}"
case "$REPO" in /*) ;; *) echo "REPO must be absolute: $REPO" >&2; exit 2 ;; esac
[ -f "$REPO/package.json" ] || { echo "REPO has no package.json: $REPO" >&2; exit 2; }
omp_candidate=${OMP:-$(command -v omp || true)}
case "$omp_candidate" in ""|/*) ;; *) echo "OMP must be an absolute path or on PATH" >&2; exit 2 ;; esac
[ -x "$omp_candidate" ] || { echo "omp not found or not executable: $omp_candidate" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required for JSON assertions" >&2; exit 3; }
command -v git >/dev/null || { echo "git is required" >&2; exit 2; }
unset OMP_PROFILE PI_PROFILE PI_CODING_AGENT_DIR

S="var/agent-tmp/plugin-lifecycle-$$"
mkdir -p "$HERE/$S" || exit 2
printf 'label=plugin-lifecycle\nrepo=omp-kit-companion\ncreated=%s\n' "$(date -u +%FT%TZ)" >"$HERE/$S/.owner"
H="$HERE/$S/home"
mkdir -p "$H/.agents/rules" "$H/.omp/agent/rules" "$H/.config" "$H/.cache" "$H/.local/share" "$H/.local/state" "$H/tmp" "$HERE/$S/logs"
LOG="$HERE/$S/steps.jsonl"
N=0
LASTLOG=""

export HOME="$H" \
  XDG_CONFIG_HOME="$H/.config" \
  XDG_CACHE_HOME="$H/.cache" \
  XDG_DATA_HOME="$H/.local/share" \
  XDG_STATE_HOME="$H/.local/state" \
  TMPDIR="$H/tmp" GIT_CONFIG_NOSYSTEM=1

isolate() {
  export HOME="$H" \
    XDG_CONFIG_HOME="$H/.config" \
    XDG_CACHE_HOME="$H/.cache" \
    XDG_DATA_HOME="$H/.local/share" \
    XDG_STATE_HOME="$H/.local/state" \
    TMPDIR="$H/tmp" GIT_CONFIG_NOSYSTEM=1
}

step() {
  name="$1"; shift
  N=$((N + 1))
  tag=$(printf '%02d' "$N")
  out="$HERE/$S/logs/step-$tag-$name.log"
  LASTLOG="$out"
  start=$(date +%s)
  (isolate && cd "$H" && "$@" >"$out" 2>&1)
  rc=$?
  seconds=$(( $(date +%s) - start ))
  if [ "$rc" -eq 0 ]; then verdict="pass"; else verdict="fail"; fi
  argv=$(printf '%s ' "$@" | sed 's/ $//')
  printf '{"step":"%s","argv":%s,"rc":%d,"seconds":%d,"verdict":"%s","artifact":%s}\n' \
    "$name" "$(printf '%s' "$argv" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$rc" "$seconds" "$verdict" "$(printf '%s' "logs/step-$tag-$name.log" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >>"$LOG"
  echo "step $tag $name rc=$rc ${seconds}s $verdict"
  return "$rc"
}

need_rc() {
  name="$1"; want="$2"; shift 2
  if step "$name" "$@"; then got=0; else got=$?; fi
  [ "$got" -eq "$want" ] || { echo "FAIL $name: want rc=$want got rc=$got; see $LOG" >&2; exit 1; }
}

# 0. Record the exact producer and repo under test.
need_rc versions-omp 0 "$omp_candidate" --version
need_rc versions-repo 0 git -C "$REPO" rev-parse HEAD

# 1. Link the repo as a plugin.
need_rc plugin-link 0 "$omp_candidate" plugin link "$REPO"
need_rc plugin-list 0 "$omp_candidate" plugin list
grep -q "omp-kit-companion" "$LASTLOG" || { echo "FAIL plugin-list: linked plugin absent; see $LASTLOG" >&2; exit 1; }

# 2. The 17 condition-bearing kit rules arrive via omp-plugins.
# kit-standing-law has no stream condition (alwaysApply prompt), so the
# matcher never lists it; every other rules/*.md must appear exactly once.
step list-rules "$omp_candidate" ttsr list --json || { echo "FAIL list-rules rc!=0" >&2; exit 1; }
LISTLOG="$LASTLOG"
python3 - "$LISTLOG" "$REPO/rules" <<'EOF' || exit 1
import json, os, sys
log, rules = sys.argv[1], sys.argv[2]
text = open(log).read()
try:
    data = json.loads(text)
except ValueError:
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0])
    data = json.loads(text[start:])
items = data if isinstance(data, list) else data.get("rules", [])
got = sorted(r["name"] for r in items if r.get("provider") == "omp-plugins")
want = sorted(n[:-3] for n in os.listdir(rules) if n.endswith(".md")
              and "condition:" in open(os.path.join(rules, n)).read())
print(f"plugin rules: {len(got)}, stream rules in repo: {len(want)}")
if got != want:
    sys.exit(f"list-rules: MISMATCH got={got} want={want}")
EOF

# 3. Re-run the skill's verified blocks verbatim against this HOME.
python3 - "$REPO/skills/omp-native/SKILL.md" "$H" <<'EOF' || exit 1
import os, re, subprocess, sys
md = open(sys.argv[1]).read()
home = sys.argv[2]
blocks = re.findall(r"```sh verified([^\n]*)\n(.*?)```", md, re.S)
assert blocks, "skill has no verified blocks"
for i, (meta, body) in enumerate(blocks, 1):
    rc = int(re.search(r"rc=(\d+)", meta).group(1))
    frag = re.search(r"contains=\"([^\"]*)\"|contains='([^']*)'", meta)
    frag = frag.group(1) if frag and frag.group(1) is not None else frag.group(2)
    p = subprocess.run(["sh", "-c", body.strip()], capture_output=True, text=True, cwd=home)
    ok = p.returncode == rc and frag in p.stdout
    print(f"skill block {i} ({body.strip().splitlines()[0]}): rc={p.returncode} {'pass' if ok else 'FAIL'}")
    if not ok:
        sys.exit(f"skill block {i} failed: want rc={rc} with {frag!r}, got rc={p.returncode} stdout={p.stdout[:500]!r}")
EOF

# 4. Matcher fire through the plugin.
step fire-pipe-exit "$omp_candidate" ttsr test --rule "$REPO/rules/bash-pipe-exit.md" \
  --source tool --tool bash 'deploy.sh | head -1; echo $?' --json || { echo "FAIL fire-pipe-exit rc!=0" >&2; exit 1; }
FIRELOG="$LASTLOG"
python3 - "$FIRELOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
print(f"triggered={names}")
# --rule tests the file in isolation, so the path is the input itself;
# discovery placement is proven by the list-rules and precedence rows.
assert names == ["bash-pipe-exit"], f"fire: want [bash-pipe-exit] got {names}"
EOF

# 5. Legacy same-name copy loses to the plugin (90 > 70).
cp "$REPO/rules/bash-pipe-exit.md" "$H/.agents/rules/bash-pipe-exit.md"
step legacy-loses "$omp_candidate" ttsr test --source tool --tool bash 'deploy.sh | head -1; echo $?' --json \
  || { echo "FAIL legacy-loses rc!=0" >&2; exit 1; }
LEGACYLOG="$LASTLOG"
python3 - "$LEGACYLOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
paths = [t.get("path", "") for t in data.get("triggered", [])]
print(f"triggered={names} paths={paths}")
assert names == ["bash-pipe-exit"], f"legacy: want [bash-pipe-exit] got {names}"
assert all("/plugins/" in p for p in paths), f"legacy: plugin must win, got {paths}"
EOF

# 6. Native overlay shadows the plugin; the plugin stops firing there.
printf -- '---\ncondition: OVERLAY_ONLY_XYZ\nscope: tool:bash\ninterruptMode: never\n---\nOverlay probe.\n' \
  >"$H/.omp/agent/rules/bash-pipe-exit.md"
step overlay-fires "$omp_candidate" ttsr test --source tool --tool bash 'echo OVERLAY_ONLY_XYZ' --json \
  || { echo "FAIL overlay-fires rc!=0" >&2; exit 1; }
OVERLAYLOG="$LASTLOG"
python3 - "$OVERLAYLOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
paths = [t.get("path", "") for t in data.get("triggered", [])]
print(f"triggered={names} paths={paths}")
assert names == ["bash-pipe-exit"], f"overlay: want [bash-pipe-exit] got {names}"
assert all(".omp/agent/rules" in p for p in paths), f"overlay: overlay must win, got {paths}"
EOF
step overlay-shadows "$omp_candidate" ttsr test --source tool --tool bash 'deploy.sh | head -1; echo $?' --json \
  || { echo "FAIL overlay-shadows rc!=0" >&2; exit 1; }
SHADOWLOG="$LASTLOG"
python3 - "$SHADOWLOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
print(f"triggered={names}")
assert names == [], f"overlay shadows plugin: want [] got {names}"
EOF
rm "$H/.omp/agent/rules/bash-pipe-exit.md"

# 7. Disabling the plugin reactivates the identical legacy copy.
need_rc plugin-disable 0 "$omp_candidate" plugin disable omp-kit-companion
step legacy-reactivates "$omp_candidate" ttsr test --source tool --tool bash 'deploy.sh | head -1; echo $?' --json \
  || { echo "FAIL legacy-reactivates rc!=0" >&2; exit 1; }
REACTLOG="$LASTLOG"
python3 - "$REACTLOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
paths = [t.get("path", "") for t in data.get("triggered", [])]
print(f"triggered={names} paths={paths}")
assert names == ["bash-pipe-exit"], f"disabled: want [bash-pipe-exit] got {names}"
assert all(".agents/rules" in p for p in paths), f"disabled: legacy must take over, got {paths}"
EOF
need_rc plugin-enable 0 "$omp_candidate" plugin enable omp-kit-companion
rm "$H/.agents/rules/bash-pipe-exit.md"

# 8. One live tripwire blocks through the linked repo plugin.
if ONLY="test-skip-fire" OMP_KIT_RULES_VIA=plugin OMP_KIT_PLUGIN_SOURCE="$REPO" \
    TIMEOUT="${TIMEOUT:-120}" sh "$HERE/scripts/e2e-live.sh" >"$HERE/$S/logs/step-live-fire.log" 2>&1; then
  live_rc=0
else
  live_rc=$?
fi
printf '{"step":"live-fire","argv":%s,"rc":%d,"seconds":-1,"verdict":"%s","artifact":"logs/step-live-fire.log"}\n' \
  "$(printf 'ONLY=test-skip-fire OMP_KIT_RULES_VIA=plugin OMP_KIT_PLUGIN_SOURCE=%s sh scripts/e2e-live.sh' "$REPO" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
  "$live_rc" "$([ "$live_rc" -eq 0 ] && echo pass || echo fail)" >>"$LOG"
echo "live-fire rc=$live_rc"
[ "$live_rc" -eq 0 ] || { echo "FAIL live-fire: test-skip-fire did not block through the plugin" >&2; exit 1; }

# 9. Planted negative: with the plugin disabled the same scenario does NOT block.
if ONLY="test-skip-fire" OMP_KIT_RULES_VIA=plugin OMP_KIT_PLUGIN_SOURCE="$REPO" \
    OMP_KIT_PLUGIN_DISABLE_AFTER_LINK=omp-kit-companion TIMEOUT="${TIMEOUT:-120}" \
    sh "$HERE/scripts/e2e-live.sh" >"$HERE/$S/logs/step-live-disabled.log" 2>&1; then
  disabled_rc=0
else
  disabled_rc=$?
fi
printf '{"step":"live-disabled","argv":"ONLY=test-skip-fire ... OMP_KIT_PLUGIN_DISABLE_AFTER_LINK=omp-kit-companion sh scripts/e2e-live.sh","rc":%d,"seconds":-1,"verdict":"%s","artifact":"logs/step-live-disabled.log"}\n' \
  "$disabled_rc" "$([ "$disabled_rc" -ne 0 ] && echo pass || echo fail)" >>"$LOG"
echo "live-disabled rc=$disabled_rc"
if [ "$disabled_rc" -eq 0 ]; then echo "FAIL live-disabled: scenario blocked without the plugin" >&2; exit 1; fi
grep -q "test-skip-fire" "$HERE/$S/logs/step-live-disabled.log" || { echo "FAIL live-disabled: scenario id absent from log" >&2; exit 1; }

# 10. Uninstall leaves nothing behind.
need_rc plugin-uninstall 0 "$omp_candidate" plugin uninstall omp-kit-companion
step list-clean "$omp_candidate" ttsr list --json || { echo "FAIL list-clean rc!=0" >&2; exit 1; }
CLEANLOG="$LASTLOG"
python3 - "$CLEANLOG" <<'EOF' || exit 1
import json, sys
text = open(sys.argv[1]).read()
try:
    data = json.loads(text)
except ValueError:
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0])
    data = json.loads(text[start:])
items = data if isinstance(data, list) else data.get("rules", [])
left = [r["name"] for r in items if r.get("provider") == "omp-plugins"]
print(f"remaining omp-plugins rules: {left}")
assert left == [], f"uninstall left rules behind: {left}"
EOF

# 11. Git install + upgrade (only when INSTALL_REF names a pushed ref).
if [ -n "${INSTALL_REF:-}" ]; then
  need_rc plugin-install 0 "$omp_candidate" plugin install "github:JYeswak/omp-kit-companion#${INSTALL_REF}"
  step install-fires "$omp_candidate" ttsr test --source tool --tool bash 'deploy.sh | head -1; echo $?' --json \
    || { echo "FAIL install-fires rc!=0" >&2; exit 1; }
  INSTALLLOG="$LASTLOG"
  python3 - "$INSTALLLOG" <<'EOF' || exit 1
import json, sys
data = json.loads(open(sys.argv[1]).read())
names = [t["name"] for t in data.get("triggered", [])]
assert names == ["bash-pipe-exit"], f"git install: want [bash-pipe-exit] got {names}"
print(f"triggered={names}")
EOF
  step plugin-upgrade "$omp_candidate" plugin upgrade omp-kit-companion \
    || { echo "FAIL plugin-upgrade rc!=0" >&2; exit 1; }
  grep -E '"changed"|changed' "$LASTLOG" | head -3
  need_rc plugin-uninstall-git 0 "$omp_candidate" plugin uninstall omp-kit-companion
else
  echo "skip git install/upgrade: INSTALL_REF is empty"
fi

# 12. Release archive carries the manifest needs (only when ARCHIVE_VERSION is set).
if [ -n "${ARCHIVE_VERSION:-}" ]; then
  mkdir -p "$HERE/$S/archive"
  need_rc archive-build 0 sh "$HERE/scripts/package-release.sh" --version "$ARCHIVE_VERSION" \
    --platform "${ARCHIVE_PLATFORM:-darwin-arm64-none}" --out "$HERE/$S/archive"
  tar -tf "$HERE/$S"/archive/*.tar | sort >"$HERE/$S/logs/archive-contents.txt"
  for want in package.json rules/bash-pipe-exit.md extensions/kit-guard-optin.ts; do
    grep -qx "$want" "$HERE/$S/logs/archive-contents.txt" || { echo "FAIL archive: missing $want" >&2; exit 1; }
  done
  echo "archive check pass"
else
  echo "skip archive check: ARCHIVE_VERSION is empty"
fi

echo "plugin-lifecycle: all steps pass; log $LOG"
[ "${KEEP:-0}" = 1 ] || rm -rf "${HERE:?}/${S:?}/home" "${HERE:?}/${S:?}/archive"
