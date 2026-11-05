# shellcheck shell=sh
# suite-lease.sh -- SUITESERIAL1 (ompkit-fp72.120.16.264): one full suite at a time machine-wide, whatever
# launched it.
#
# omp-kit/var/sitrep/capacity-plan.md recommendation 2 (lines 292-295): each extra concurrent suite costs 0.15 of
# P(clean) (0.59 -> 0.44 at zero seats), and 6 same-tree duplicates ran side by side. release-verdict.sh serialized
# only itself (193 'holds the lock' deferrals, line 264), so the overlaps came from the other launchers. Every full
# suite therefore runs under one lease that its launcher takes here: scripts/full-suite-verdict.sh (the common judge
# that the pre-push gate, `omp-kit land`, fresh-gate's named remedy and ad-hoc runs all call) and
# scripts/release-verdict.sh (which holds it around its runner and the CI-only judge beside it).
#
# Source it, never execute it, after kitlib-tmp.sh (kitlib owns the traps; the lease registers its release there):
#
#   SUITE_LEASE_LIB=<dir holding kitlib_lock.py, kitlib_proc.py and kitlib_run.py>
#   . "$SUITE_LEASE_LIB/suite-lease.sh"
#   suite_lease_take LAUNCHER TREE ROLE COMMIT STORE JOIN [ENTRY] || exit "$?"
#   case $SUITE_LEASE_STATE in held|joined|nested) ... ;; esac
#   suite_lease_release        # optional early release; it also runs at exit
#
# The lease is the kitlib flock {"namespace": "suite-lease", "name": "full-suite"} (scripts/kitlib_lock.py). Its
# state dir is FULL_SUITE_LEASE_DIR when set; else, when the caller judges into an isolated verdict store
# (--cache-dir or FULL_SUITE_VERDICT_CACHE_DIR, which only tests and fixtures pass), STORE/.suite-lease, so a
# fixture suite never queues behind the machine's real one; else kitlib's default, $XDG_STATE_HOME/omp-kit or
# ~/.local/state/omp-kit, one per machine user.
#
# A request whose exact tree and role match the running holder JOINS it: no second suite starts, and the caller
# reads the holder's verdict once the holder ends (or as soon as ENTRY, the caller's verdict record, appears).
# Any other request waits in a bounded FIFO queue. Queue, not refusal: every launcher's contract is to return the
# verdict (the pre-push gate, land and release-local have no retry), and the plan's minutes table (lines 220-223)
# shows two suites overlapping in 266 of 7,860 minutes, so a queue is short. Bounds, both overridable for tests:
# FULL_SUITE_LEASE_QUEUE_MAX waiting requests (default 3; a fourth refuses SUITE_LEASE_QUEUE_FULL) and
# FULL_SUITE_LEASE_WAIT_SECS (default 3600, two default suite deadlines; then SUITE_LEASE_WAIT_TIMEOUT). Both
# refusals exit 75. release-verdict.sh requests run first (priority release), so release-local's 7200 s verdict
# stage waits at most for the run in progress and is never starved by ad-hoc or land suites.
#
# A request from inside the holder's own process tree (release-verdict's runner, a suite fixture that judges with
# the machine store) is NESTED: it runs under the enclosing lease and takes none, so it cannot deadlock its owner.
#
# Release on every exit path (R32): the holder is a detached process holding the flock for the owner shell ($$).
# A normal exit, HUP, INT or TERM runs suite_lease_release from kitlib's exit registry, which signals the holder
# only after proving its pid still runs with its recorded start time (kitlib_proc) and waits until it is gone. A
# SIGKILLed owner cannot run it: the holder sees the owner identity-proven dead (dead, zombie or a reused pid) and
# lets go within PROBE_S. The kernel drops a dead holder's flock by itself; a queue ticket is reaped only when its
# owner is identity-proven dead, never on age or a bare pid.
#
# Names: public suite_lease_*; private suite_lease__*; state SUITE_LEASE_STATE (held, joined, nested, released),
# SUITE_LEASE_DETAIL (the helper's decision fields) and SUITE_LEASE__ROOT.

SUITE_LEASE_STATE=
SUITE_LEASE_DETAIL=
SUITE_LEASE__ROOT=
SUITE_LEASE__ATEXIT=
if [ -z "${SUITE_LEASE_LIB:-}" ] || [ ! -f "$SUITE_LEASE_LIB/kitlib_lock.py" ] || [ ! -f "$SUITE_LEASE_LIB/kitlib_proc.py" ]; then
	printf 'suite-lease: SUITE_LEASE_LIB must name the dir holding kitlib_lock.py and kitlib_proc.py (got %s)\n' "${SUITE_LEASE_LIB:-unset}" >&2
	return 2
fi

# suite_lease__root STORE: the lease state dir into SUITE_LEASE__ROOT ('' means kitlib's machine default).
suite_lease__root() {
	if [ -n "${FULL_SUITE_LEASE_DIR:-}" ]; then
		SUITE_LEASE__ROOT=$FULL_SUITE_LEASE_DIR
	elif [ -n "$1" ]; then
		SUITE_LEASE__ROOT=${1%/}/.suite-lease
	else
		SUITE_LEASE__ROOT=
	fi
	case $SUITE_LEASE__ROOT in
		''|/*) ;;
		*) SUITE_LEASE__ROOT=$PWD/$SUITE_LEASE__ROOT ;;
	esac
}

# suite_lease_take LAUNCHER TREE ROLE COMMIT STORE JOIN [ENTRY]: take, join or nest; 75 with a named refusal.
suite_lease_take() {
	if ! command -v kitlib_tmp_atexit >/dev/null 2>&1; then
		printf 'suite-lease: REFUSED SUITE_LEASE_ERROR source kitlib-tmp.sh first: the lease must be released at exit\n' >&2
		return 75
	fi
	suite_lease__root "$5"
	sl_wait=${FULL_SUITE_LEASE_WAIT_SECS:-3600}
	sl_max=${FULL_SUITE_LEASE_QUEUE_MAX:-3}
	case $sl_wait in ''|*[!0-9]*) printf 'suite-lease: REFUSED SUITE_LEASE_CONFIG FULL_SUITE_LEASE_WAIT_SECS must be a non-negative integer\n' >&2; return 75 ;; esac
	case $sl_max in ''|*[!0-9]*) printf 'suite-lease: REFUSED SUITE_LEASE_CONFIG FULL_SUITE_LEASE_QUEUE_MAX must be a non-negative integer\n' >&2; return 75 ;; esac
	sl_priority=normal
	[ "$1" != release-verdict ] || sl_priority=release
	sl_rc=0
	sl_out=$(suite_lease__py acquire --owner "$$" --launcher "$1" --tree "$2" --role "$3" --commit "$4" \
		--state "$SUITE_LEASE__ROOT" --join "$6" --entry "${7:-}" --priority "$sl_priority" \
		--wait-secs "$sl_wait" --queue-max "$sl_max") || sl_rc=$?
	case "$sl_rc:$sl_out" in
		"0:ACQUIRED "*)
			SUITE_LEASE_STATE=held
			if [ -z "$SUITE_LEASE__ATEXIT" ]; then
				SUITE_LEASE__ATEXIT=1
				kitlib_tmp_atexit 'suite_lease_release'
			fi ;;
		"0:JOINED "*) SUITE_LEASE_STATE=joined ;;
		"0:NESTED "*) SUITE_LEASE_STATE=nested ;;
		"75:REFUSED "*) printf 'suite-lease: %s\n' "$sl_out" >&2; return 75 ;;
		*) printf 'suite-lease: REFUSED SUITE_LEASE_ERROR helper rc=%s: %s\n' "$sl_rc" "$sl_out" >&2; return 75 ;;
	esac
	# shellcheck disable=SC2034 # read by the sourcing launcher
	SUITE_LEASE_DETAIL=${sl_out#* }
	return 0
}

# suite_lease_release: give the held lease back now; a no-op unless this shell holds it.
suite_lease_release() {
	[ "$SUITE_LEASE_STATE" = held ] || return 0
	SUITE_LEASE_STATE=released
	sl_rel_rc=0
	sl_rel=$(suite_lease__py release --owner "$$" --state "$SUITE_LEASE__ROOT") || sl_rel_rc=$?
	[ "$sl_rel_rc" = 0 ] || { printf 'suite-lease: release did not complete (rc=%s): %s\n' "$sl_rel_rc" "$sl_rel" >&2; return 1; }
	return 0
}

suite_lease__py() {
	python3 -B -I - "$SUITE_LEASE_LIB" "$@" <<'SUITE_LEASE_PY'
import json
import os
import select
import signal
import sys
import time

LIB = sys.argv[1]
sys.path.insert(0, LIB)
import kitlib_lock  # noqa: E402  (the kit's one flock primitive)
import kitlib_proc  # noqa: E402  (pid plus start-time identity)
import kitlib_run  # noqa: E402  (bounded ps)

NAMESPACE = "suite-lease"
LEASE = {"namespace": NAMESPACE, "name": "full-suite"}
QUEUE = {"namespace": NAMESPACE, "name": "queue"}
POLL_S = 0.25
PROBE_S = 5.0
REFUSED = 75
PRIORITY = {"release": 0, "normal": 1}
PS_ENV = {"LC_ALL": "C", "PATH": "/usr/bin:/bin"}


def _still_open(fd):
    try:
        os.fstat(fd)
    except OSError:
        return False
    return True


def _inherited_fds():
    for listing in ("/dev/fd", "/proc/self/fd"):
        try:
            names = os.listdir(listing)
        except OSError:
            continue
        # The listing's own descriptor is closed by now, so fstat drops it.
        return [fd for fd in sorted(int(name) for name in names if name.isdigit()) if fd > 2 and _still_open(fd)]
    return []


# Descriptors the launcher shell left open (its pipes); the detached holder closes them so it never keeps a
# reader of the launcher's output waiting. Taken before this process opens anything of its own.
INHERITED = _inherited_fds()


def say(text):
    sys.stderr.write("suite-lease: " + text + "\n")
    sys.stderr.flush()


def decide(line, code=0):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    sys.exit(code)


def refuse(code, detail):
    decide("REFUSED " + code + " " + detail, REFUSED)


def options(argv):
    parsed = {}
    while argv:
        if len(argv) < 2 or not argv[0].startswith("--"):
            refuse("SUITE_LEASE_ERROR", "bad helper arguments")
        parsed[argv[0][2:]] = argv[1]
        argv = argv[2:]
    return parsed


def gone(ident, thorough):
    """True only when the incarnation is identity-proven dead (dead, zombie or reused); unknown is alive."""
    try:
        os.kill(ident["pid"], 0)
        if not thorough:
            return False
    except ProcessLookupError:
        pass
    except PermissionError:
        if not thorough:
            return False
    return kitlib_proc.is_dead(kitlib_proc.probe_incarnation(ident))


def read_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        data = os.read(fd, 65537)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(data) > 65536:
        return None
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def write_json(path, value):
    pending = path + "." + str(os.getpid()) + ".tmp"
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.write("\n")
    os.replace(pending, path)


def unlink(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def identity_fields(value, prefix):
    pid, start = value.get(prefix + "_pid"), value.get(prefix + "_start")
    if isinstance(pid, bool) or not isinstance(pid, int) or not 1 < pid <= kitlib_proc.PID_MAX:
        return None
    if not isinstance(start, str) or not start.strip():
        return None
    return {"pid": pid, "start": start}


def valid(value, extra):
    if value is None or identity_fields(value, "owner") is None:
        return False
    return all(isinstance(value.get(key), str) for key in ("launcher", "tree", "role", "commit", *extra))


def describe(holder):
    if holder is None:
        return "a holder that has not recorded itself yet"
    return "run %d (%s, tree %s, role %s, since %s)" % (
        holder["owner_pid"], holder["launcher"], holder["tree"][:12], holder["role"], holder.get("acquired_at", "?"))


def signature(path):
    if not path:
        return None
    try:
        info = os.stat(path)
    except OSError:
        return ("absent",)
    return (info.st_ino, info.st_mtime_ns, info.st_size)


class Lease:
    def __init__(self, opts):
        state = opts.get("state") or None
        if state is not None:
            if not state.startswith("/"):
                refuse("SUITE_LEASE_CONFIG", "the lease state dir must be absolute: " + state)
            os.makedirs(os.path.dirname(state.rstrip("/")) or "/", mode=0o700, exist_ok=True)
        self.state = state
        self.dir = kitlib_lock.resolve_lock(LEASE, state)["dir"]
        self.record = os.path.join(self.dir, "holder.json")
        self.queue = os.path.join(self.dir, "queue")

    def mutex(self):
        return kitlib_lock.private_lock(QUEUE, deadline_s=30, state_dir=self.state)

    def try_lease(self):
        try:
            return kitlib_lock.private_lock(LEASE, deadline_s=0, state_dir=self.state)
        except kitlib_lock.PrivateLockError as error:
            if error.code == "DEADLINE":
                return None
            raise

    def ensure_queue(self):
        try:
            os.mkdir(self.queue, 0o700)
        except FileExistsError:
            pass
        info = os.lstat(self.queue)
        if not os.path.isdir(self.queue) or os.path.islink(self.queue) or info.st_uid != os.getuid():
            refuse("SUITE_LEASE_ERROR", "queue dir is not a private directory: " + self.queue)

    def holder(self):
        value = read_json(self.record)
        return value if valid(value, ()) and identity_fields(value, "holder") is not None else None

    def tickets(self, keep, thorough):
        """Live ticket names in queue order; a ticket whose owner is identity-proven dead is reaped."""
        live = []
        for name in sorted(os.listdir(self.queue)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.queue, name)
            value = read_json(path)
            owner = identity_fields(value, "owner") if value is not None else None
            if name != keep and (owner is None or gone(owner, thorough)):
                if owner is None and value is None and not os.path.exists(path):
                    continue
                unlink(path)
                continue
            live.append(name)
        return live


def acquire(opts):
    owner_pid = kitlib_proc.safe_pid(opts["owner"])
    own = kitlib_proc.incarnation(owner_pid)
    if own is None:
        refuse("SUITE_LEASE_OWNER_UNREADABLE", "cannot read the start time of run %d" % owner_pid)
    lease = Lease(opts)
    tree, role, commit, launcher = opts["tree"], opts["role"], opts["commit"], opts["launcher"]
    join = opts.get("join") == "1"
    priority = PRIORITY.get(opts.get("priority", "normal"), 1)
    wait_s, queue_max = int(opts["wait-secs"]), int(opts["queue-max"])
    entry = opts.get("entry") or ""
    entry_seen = signature(entry)
    started = time.monotonic()
    deadline = started + wait_s
    last_probe = started
    ticket = None
    checked = set()
    lineage = []
    announced = None

    def drop():
        if ticket is not None:
            unlink(os.path.join(lease.queue, ticket))

    def lineage_of():
        if lineage:
            return lineage
        lineage.append(owner_pid)
        pid = owner_pid
        for _ in range(64):
            result = kitlib_run.run(["ps", "-o", "ppid=", "-p", str(pid)], deadline_s=10, max_output_bytes=256, env=PS_ENV)
            text = result.stdout.decode("ascii", "replace").strip()
            if result.rc != 0 or result.timed_out or not text.isdigit() or int(text) <= 1:
                break
            pid = int(text)
            lineage.append(pid)
        return lineage

    try:
        passes = 0
        while passes == 0 or time.monotonic() < deadline:  # one attempt even with FULL_SUITE_LEASE_WAIT_SECS=0
            passes += 1
            now = time.monotonic()
            thorough = now - last_probe >= PROBE_S
            if thorough:
                last_probe = now
            if gone(own, thorough):
                drop()
                refuse("SUITE_LEASE_OWNER_GONE", "run %d exited while it waited" % owner_pid)
            if entry and signature(entry) != entry_seen:
                drop()
                decide("JOINED owner=none launcher=none reason=verdict-recorded waited_s=%.1f" % (now - started))
            held = joined = None
            position = 0
            with lease.mutex():
                lease.ensure_queue()
                taken = lease.try_lease()
                holder = None if taken is not None else lease.holder()
                ahead = describe(holder) if taken is None else "the request at the head of the queue"
                names = lease.tickets(ticket, thorough)
                if ticket is not None and ticket not in names:
                    ticket = None  # removed from outside: queue again at the back
                if taken is not None:
                    if (ticket is None and not names) or (ticket is not None and names[:1] == [ticket]):
                        drop()
                        ticket = None
                        unlink(lease.record)  # we hold the lease, so any record left is stale
                        held = taken
                    else:
                        taken.release()  # free, but a request queued earlier goes first
                elif holder is not None:
                    key = (holder["holder_pid"], holder["holder_start"])
                    if key not in checked:
                        checked.add(key)
                        if holder["owner_pid"] in lineage_of() and kitlib_proc.probe_incarnation(
                                identity_fields(holder, "owner"))["state"] == "live":
                            drop()
                            decide("NESTED owner=%d launcher=%s" % (holder["owner_pid"], holder["launcher"]))
                    if join and holder["tree"] == tree and holder["role"] == role:
                        drop()
                        ticket = None
                        joined = holder
                if held is None and joined is None:
                    if ticket is None:
                        if len(names) >= queue_max:
                            refuse("SUITE_LEASE_QUEUE_FULL", "%d request(s) already wait (FULL_SUITE_LEASE_QUEUE_MAX=%d) behind %s; tree %s was not judged"
                                   % (len(names), queue_max, ahead, tree))
                        seq = time.time_ns()
                        for name in names:
                            try:
                                seq = max(seq, int(name.split("-")[1]) + 1)
                            except (IndexError, ValueError):
                                pass
                        ticket = "%d-%020d-%d.json" % (priority, seq, owner_pid)
                        write_json(os.path.join(lease.queue, ticket), {
                            "owner_pid": owner_pid, "owner_start": own["start"], "launcher": launcher, "tree": tree,
                            "role": role, "commit": commit, "priority": priority, "seq": seq,
                            "enqueued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                        names = sorted(names + [ticket])
                    position = names.index(ticket) + 1 if ticket in names else 0
            if held is not None:
                become_holder(lease, held, own, opts, time.monotonic() - started)
            if joined is not None:
                join_wait(lease, joined, own, entry, entry_seen, started, deadline)
            view = (position, None if holder is None else (holder["holder_pid"], holder["holder_start"]))
            if view != announced:
                announced = view
                say("QUEUED tree %s role %s at position %d behind %s; waiting up to %d s" % (tree, role, position, ahead, wait_s))
            time.sleep(POLL_S)
        drop()
        refuse("SUITE_LEASE_WAIT_TIMEOUT", "waited %d s (FULL_SUITE_LEASE_WAIT_SECS) behind %s; tree %s was not judged"
               % (wait_s, ahead, tree))
    except kitlib_lock.PrivateLockError as error:
        drop()
        refuse("SUITE_LEASE_ERROR", "kitlib lock refused %s %s" % (error.code, getattr(error, "evidence", {}).get("path", "")))
    except BaseException:
        drop()
        raise


def join_wait(lease, holder, own, entry, entry_seen, started, deadline):
    say("JOINING run %d (%s): it judges the same tree %s role %s, so no second suite starts"
        % (holder["owner_pid"], holder["launcher"], holder["tree"], holder["role"]))
    key = (holder["holder_pid"], holder["holder_start"])
    last_probe = time.monotonic()
    while True:
        now = time.monotonic()
        thorough = now - last_probe >= PROBE_S
        if thorough:
            last_probe = now
        if gone(own, thorough):
            refuse("SUITE_LEASE_OWNER_GONE", "run %d exited while it waited" % own["pid"])
        if entry and signature(entry) != entry_seen:
            reason = "verdict-recorded"
            break
        with lease.mutex():
            taken = lease.try_lease()
            if taken is not None:
                taken.release()
                ended = True
            else:
                current = lease.holder()
                ended = current is None or (current["holder_pid"], current["holder_start"]) != key
        if ended:
            reason = "holder-ended"
            break
        if now >= deadline:
            refuse("SUITE_LEASE_WAIT_TIMEOUT", "joined %s did not finish within the wait bound" % describe(holder))
        time.sleep(POLL_S)
    decide("JOINED owner=%d launcher=%s reason=%s waited_s=%.1f"
           % (holder["owner_pid"], holder["launcher"], reason, time.monotonic() - started))


def become_holder(lease, held, own, opts, waited):
    """Fork the detached holder that keeps the flock for the owner, then report it."""
    read_end, write_end = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_end)
            os.setsid()
            null = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(null, fd)
            if null > 2:
                os.close(null)
            for fd in INHERITED:
                if fd not in (held.fd, write_end):
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            os.chdir("/")
            me = kitlib_proc.incarnation(os.getpid())
            if me is not None:
                write_json(lease.record, {
                    "holder_pid": me["pid"], "holder_start": me["start"], "owner_pid": own["pid"],
                    "owner_start": own["start"], "launcher": opts["launcher"], "tree": opts["tree"],
                    "role": opts["role"], "commit": opts["commit"],
                    "acquired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                hold(lease, held, own, me, write_end)
        except BaseException:
            pass
        os._exit(0)
    os.close(write_end)
    # The holder writes "ok" once its record is down and its signal handlers are set (one ps read, bounded at
    # 10 s); a holder that never says so is a refusal, and it lets go by itself once this owner is gone.
    ready = b""
    bound = time.monotonic() + 60
    while time.monotonic() < bound:
        readable, _, _ = select.select([read_end], [], [], max(0.0, bound - time.monotonic()))
        chunk = os.read(read_end, 64) if readable else b""
        if not chunk:
            break
        ready += chunk
    os.close(read_end)
    held.release()  # this process's descriptor only; the holder keeps the flock
    if ready != b"ok\n":
        refuse("SUITE_LEASE_ERROR", "the lease holder did not start")
    decide("ACQUIRED holder=%d waited_s=%.1f" % (pid, waited))


def hold(lease, held, own, me, ready_fd):
    """Keep the flock until the owner asks (TERM, INT, HUP) or is identity-proven dead; then let go at once."""
    def finish(*_):
        current = read_json(lease.record)
        if current is not None and current.get("holder_pid") == me["pid"] and current.get("holder_start") == me["start"]:
            unlink(lease.record)
        held.release()
        os._exit(0)

    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, finish)
    os.write(ready_fd, b"ok\n")
    os.close(ready_fd)
    last_probe = time.monotonic()
    thorough = False
    # Held for the owner's whole run: the loop ends only when the owner is identity-proven dead (or a signal
    # above ends it first).
    while not gone(own, thorough):
        time.sleep(POLL_S)
        now = time.monotonic()
        thorough = now - last_probe >= PROBE_S
        if thorough:
            last_probe = now
    finish()


def release(opts):
    owner_pid = kitlib_proc.safe_pid(opts["owner"])
    lease = Lease(opts)
    current = lease.holder()
    if current is None or current["owner_pid"] != owner_pid:
        decide("RELEASED none")
    holder = identity_fields(current, "holder")
    if kitlib_proc.probe_incarnation(holder)["state"] != "live":
        decide("RELEASED gone")
    pid = kitlib_proc.safe_pid(holder["pid"])
    os.kill(pid, signal.SIGTERM)
    bound = time.monotonic() + 10
    polls = 0
    while time.monotonic() < bound:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            decide("RELEASED holder=%d" % pid)
        polls += 1
        # Signal 0 also answers for a zombie the init process has not reaped yet; ps settles it twice a second.
        if polls % 10 == 0 and kitlib_proc.is_dead(kitlib_proc.probe_incarnation(holder)):
            decide("RELEASED holder=%d" % pid)
        time.sleep(0.05)
    decide("RELEASE_PENDING holder=%d still runs 10 s after TERM" % pid, 1)


if __name__ == "__main__":
    command = sys.argv[2] if len(sys.argv) > 2 else ""
    if command == "acquire":
        acquire(options(sys.argv[3:]))
    elif command == "release":
        release(options(sys.argv[3:]))
    refuse("SUITE_LEASE_ERROR", "unknown helper command " + command)
SUITE_LEASE_PY
}
