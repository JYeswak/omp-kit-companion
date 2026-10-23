#!/bin/sh
# br-create-guard-lockfd.test.sh — KL02 (ompkit-t8dfi): native `br create` runs holding the guard's
# create-admission lock through kitlib_run inherit_fds. Planted proof, two halves:
#   held:  the child owns a descriptor on the lock inode (fstat inode match over its open fds);
#   race:  SIGKILL the guard mid-create; the lock must stay held by the orphaned child, so a second
#          admission cannot take it. Without inherit_fds both halves fail (the race reopens).
set -u

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
GUARD="$REPO_ROOT/scripts/br-create-guard.py"
REPO_TMP=$(CDPATH='' cd -- "$REPO_ROOT/var/agent-tmp" && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$REPO_ROOT/scripts/kitlib-tmp.sh"
printenv TMPDIR >/dev/null || KITLIB_TMP_ROOT=$REPO_TMP
kitlib_tmp TMP br-create-guard-lockfd-test || exit 1

mkdir -p "$TMP/bin" "$TMP/project/.beads" "$TMP/state"
: > "$TMP/project/.beads/beads.db"
cat > "$TMP/bin/br" <<'EOF'
#!/bin/sh
if [ "$1" = "list" ]; then printf '[]\n'; exit 0; fi
if [ "$1" = "create" ]; then
	python3 - "$LOCKFD_LOCK" "$LOCKFD_DIR/held" <<'PY'
import os, sys
lock, out = sys.argv[1:]
want = os.stat(lock)
held = []
for name in os.listdir("/dev/fd"):
    try:
        info = os.fstat(int(name))
    except OSError:
        continue
    if (info.st_dev, info.st_ino) == (want.st_dev, want.st_ino):
        held.append(name)
with open(out, "w", encoding="utf-8") as handle:
    handle.write("HELD\n" if held else "NOT-HELD\n")
PY
	printf '%s\n' "$$" > "$LOCKFD_DIR/probe.pid"
	: > "$LOCKFD_DIR/entered"
	# Bounded: the test reaps this orphan after `release`; a lost release still ends here in 30 s.
	n=0
	while [ ! -f "$LOCKFD_DIR/release" ] && [ "$n" -lt 3000 ]; do sleep 0.01; n=$((n + 1)); done
	printf 'created lockfd-1\n'
fi
exit 0
EOF
chmod +x "$TMP/bin/br"

export XDG_STATE_HOME="$TMP/state"
export OMP_KIT_FLEET_WATCH_CONFIG="$TMP/no-fleet-watch.json"
export BR_SHIM_REAL="$TMP/bin/br" BR_SHIM_PROJECT="$TMP/project" BR_SHIM_DB="$TMP/project/.beads/beads.db"
export BR_SHIM_AGENT=LockProbe BR_SHIM_ENTRY="$REPO_ROOT/scripts/br-shim.sh" LOCKFD_DIR="$TMP"
LOCKFD_LOCK=$(python3 - "$REPO_ROOT/scripts" "$BR_SHIM_DB" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import kitlib_lock
print(kitlib_lock.resolve_lock({"namespace": "create-admission", "path": sys.argv[2]}, None)["path"])
PY
) || { printf 'FAIL lockfd: cannot resolve the admission lock path\n'; exit 1; }
export LOCKFD_LOCK
pass=0
fail=0

python3 -B "$GUARD" create "lock fd probe" > "$TMP/guard.out" 2>&1 &
guard_pid=$!
waited=0
while [ ! -f "$TMP/entered" ] && [ "$waited" -lt 1000 ]; do sleep 0.01; waited=$((waited + 1)); done
kill -9 "$guard_pid" 2>/dev/null
wait "$guard_pid" 2>/dev/null

if [ "$(cat "$TMP/held" 2>/dev/null)" = "HELD" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL lockfd-held: child=%s guard<<<%s>>>\n' "$(cat "$TMP/held" 2>/dev/null)" "$(cat "$TMP/guard.out")"
fi

# The guard is dead; only the orphaned native create can still hold the lock.
if python3 - "$LOCKFD_LOCK" > "$TMP/race.out" 2>&1 <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)
print("RACE: a second admission took the lock while native br create was still running")
sys.exit(1)
PY
then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL lockfd-race: %s\n' "$(cat "$TMP/race.out")"
fi
: > "$TMP/release"
# The orphaned native create must exit on release before the test's temp dir goes away; otherwise it
# polls a deleted dir forever (ten such shells, ~3% CPU each, were found live on 2026-10-23).
probe=$(cat "$TMP/probe.pid" 2>/dev/null)
n=0
while [ -n "$probe" ] && kill -0 "$probe" 2>/dev/null && [ "$n" -lt 500 ]; do sleep 0.01; n=$((n + 1)); done
if [ -n "$probe" ] && ! kill -0 "$probe" 2>/dev/null; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL lockfd-reap: probe pid=%s still running after release\n' "${probe:-unknown}"
	[ -n "$probe" ] && kill "$probe" 2>/dev/null
fi

printf 'br-create-guard-lockfd: %s pass %s fail\n' "$pass" "$fail"
[ "$fail" = "0" ]
