#!/bin/sh
# Install project-bound storage-root bootstraps in Agent Mail pre-commit and pre-push chains.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
TARGET=$(git rev-parse --show-toplevel 2>/dev/null) || { echo 'install-pre-commit-storage-root-gate: run from a Git repository with Agent Mail hook chains' >&2; exit 2; }
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd -P)
HOOKS=$(git -C "$TARGET" rev-parse --git-path hooks)
case "$HOOKS" in
	/*) ;;
	*) HOOKS="$TARGET/$HOOKS" ;;
esac
command -v python3 >/dev/null 2>&1 || { echo 'install-pre-commit-storage-root-gate: python3 is required by the Agent Mail chain runner' >&2; exit 2; }

for phase in pre-commit pre-push; do
	CHAIN="$HOOKS/$phase"
	[ -x "$CHAIN" ] || { echo "install-pre-commit-storage-root-gate: expected executable Agent Mail chain runner: $CHAIN" >&2; exit 2; }
	if ! grep -q "mcp-agent-mail chain-runner ($phase)" "$CHAIN"; then
		echo "install-pre-commit-storage-root-gate: refusing to bypass a non-Agent-Mail $phase hook: $CHAIN" >&2
		exit 2
	fi
	if ! grep -Fq "ORIG = HOOK_DIR / '$phase.orig'" "$CHAIN"; then
		echo "install-pre-commit-storage-root-gate: unrecognized Agent Mail $phase chain boundary: $CHAIN" >&2
		exit 2
	fi
	for required in "import os" "import subprocess" "import sys" "RUN_DIR = HOOK_DIR / 'hooks.d' / '$phase'"; do
		if ! grep -Fq "$required" "$CHAIN"; then
			echo "install-pre-commit-storage-root-gate: missing expected Agent Mail chain runner code ($required): $CHAIN" >&2
			exit 2
		fi
	done
	if grep -Fq 'os.environ.setdefault("AGENT_MAIL_STORAGE_ROOT"' "$CHAIN" && ! grep -Fq '# Local fix (omp-kit AM1, 2026-10-02):' "$CHAIN"; then
		echo "install-pre-commit-storage-root-gate: refusing an unrecognized hard-coded Agent Mail root: $CHAIN" >&2
		exit 2
	fi
done

RESOLVED_ROOT=$(sh "$ROOT/scripts/pre-commit-storage-root-gate.sh" --resolve-root) || exit $?
git -C "$TARGET" config --local --replace-all omp-kit.agent-mail-storage-root "$RESOLVED_ROOT"

for phase in pre-commit pre-push; do
	DEST="$HOOKS/hooks.d/$phase/10-omp-kit-storage-root"
	mkdir -p "$(dirname "$DEST")"
	cp "$ROOT/scripts/pre-commit-storage-root-gate.sh" "$DEST"
	chmod +x "$DEST"
done

for phase in pre-commit pre-push; do
	python3 - "$HOOKS/$phase" "$phase" <<'PY'
import os
import re
import shutil
import stat
import sys
import time
from pathlib import Path

path = Path(sys.argv[1])
phase = sys.argv[2]
if path.is_symlink():
    raise SystemExit(f"refusing to patch symlinked Agent Mail chain runner: {path}")
text = path.read_text(encoding="utf-8")
if f"# mcp-agent-mail chain-runner ({phase})" not in text:
    raise SystemExit(f"unrecognized Agent Mail {phase} chain runner: {path}")

begin = "# omp-kit agent-mail storage-root bootstrap begin"
end = "# omp-kit agent-mail storage-root bootstrap end"
if begin in text or end in text:
    if text.count(begin) != 1 or text.count(end) != 1:
        raise SystemExit(f"incomplete or duplicate storage-root bootstrap in {path}")
    raise SystemExit(0)

legacy = re.compile(
    r"(?m)^# Local fix \(omp-kit AM1, 2026-10-02\):[^\n]*\n"
    r'^os\.environ\.setdefault\("AGENT_MAIL_STORAGE_ROOT", [^\n]*\)\n?'
)
text, _ = legacy.subn("", text)
if 'os.environ.setdefault("AGENT_MAIL_STORAGE_ROOT"' in text:
    raise SystemExit(f"found an unrecognized hard-coded Agent Mail root in {path}")

anchor = f"ORIG = HOOK_DIR / '{phase}.orig'"
if text.count(anchor) != 1:
    raise SystemExit(f"could not identify the Agent Mail {phase} chain boundary in {path}")
bootstrap = f'''{begin}
_omp_storage_root_gate = RUN_DIR / "10-omp-kit-storage-root"
try:
    _omp_storage_root_result = subprocess.run(
        [str(_omp_storage_root_gate), "--resolve-root"],
        capture_output=True, text=True, check=False, timeout=10,
    )
except (OSError, subprocess.TimeoutExpired) as exc:
    print(f"omp-kit Agent Mail guard: archive resolution failed: {{exc}}", file=sys.stderr)
    sys.exit(2)
if _omp_storage_root_result.returncode != 0:
    if _omp_storage_root_result.stderr:
        sys.stderr.write(_omp_storage_root_result.stderr)
    sys.exit(_omp_storage_root_result.returncode or 2)
_omp_storage_root = _omp_storage_root_result.stdout.strip()
if not _omp_storage_root:
    print("omp-kit Agent Mail guard: archive resolution returned an empty root", file=sys.stderr)
    sys.exit(2)
os.environ["AGENT_MAIL_STORAGE_ROOT"] = _omp_storage_root
os.environ["STORAGE_ROOT"] = _omp_storage_root
{end}'''
patched = text.replace(anchor, anchor + "\n" + bootstrap, 1)
backup = path.with_name(path.name + ".omp-kit-storage-root.bak." + str(time.time_ns()))
shutil.copy2(path, backup)
temporary = path.with_name(path.name + ".omp-kit-storage-root.tmp." + str(os.getpid()))
try:
    temporary.write_text(patched, encoding="utf-8")
    os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
    os.replace(temporary, path)
except Exception:
    if temporary.exists():
        temporary.unlink()
    raise
print(f"patched {path}; backup {backup}")
PY
done

printf 'installed project-bound Agent Mail storage-root bootstraps for %s\n' "$TARGET"
printf 'storage root: %s\n' "$RESOLVED_ROOT"
