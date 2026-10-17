#!/bin/sh
# Startup authorization must fail before installing a shim or emitting exports.
# The unused system executable only satisfies executable discovery; no tracker
# command is executed or mocked. Each rejected invocation has a hard deadline.
set -u
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P) || exit 1
exec python3 - "$ROOT" "$@" <<'PY'
from __future__ import annotations

import datetime
import os
from pathlib import Path
import subprocess
import sys
import hashlib
import json
import shutil
import signal
import time

root = Path(sys.argv[1])
script = root / "scripts" / "agent-spawn-env.sh"
test_script = root / "tests" / "cli" / "agent-spawn-env.test.sh"
mode = sys.argv[2] if len(sys.argv) > 2 else ""


def capture(args, env, cwd, **kwargs):
    return subprocess.run(
        [str(arg) for arg in args], cwd=cwd, env=env,
        capture_output=True, text=True, timeout=15, check=False, **kwargs,
    )


def native_env(work, config):
    # Never give the disposable server real fleet credentials or configuration.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMUX", "TMUX_PANE")
           if key in os.environ}
    env.update(HOME=str(work / "home"), TMPDIR=str(work),
               DATABASE_URL="sqlite:///" + str(work / "storage.sqlite3"),
               STORAGE_ROOT=str(work / "archive"), HTTP_HOST="127.0.0.1",
               HTTP_PORT=str(config.get("port", 0)), BR_REAL=config["br"],
               PYTHONDONTWRITEBYTECODE="1")
    return env


def identity_snapshot(work):
    directory = work / "home" / ".config" / "agent-mail" / "identity"
    return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in directory.rglob("*") if path.is_file()}


def projected(name, work, env, mutate=False):
    args = ["--agent", name, "--project", str(work), "--kit-root", str(root)]
    if not mutate:
        return capture(["sh", script, *args], env, work)
    source = script.read_text(encoding="utf-8")
    guard = 'or proof.get("binding") != "verified-live"'
    if source.count(guard) != 1:
        raise RuntimeError("MUTATION_TARGET_UNAVAILABLE")
    # In-memory counterfactual only; never modify or eval the production file.
    return capture(["sh", "-s", "--", *args], env, work,
                   input=source.replace(guard, "or False"))


def peer(work, config, role):
    env = native_env(work, config)
    result = {"role": role, "pid": os.getpid(), "pane": os.environ["TMUX_PANE"]}
    actor = None
    try:
        if role == "dead":
            actor = config["peer_actor"]
        else:
            registration_env = env.copy()
            if role == "weak":
                # Ask the native writer for a new identity with unavailable
                # socket evidence. Do not manufacture a provider JSON response.
                suffix = env["TMUX"].rsplit(",", 2)[1:]
                registration_env["TMUX"] = ",".join([str(work / "missing.sock"), *suffix])
            registered = capture(
                [config["am"], "macros", "start-session", "--project", work,
                 "--program", "native-director-fixture" if role == "peer" else "native-weak-fixture",
                 "--model", "no-model-fixture", "--inbox-limit", "1", "--json"],
                registration_env, work,
            )
            if registered.returncode:
                raise RuntimeError("NATIVE_PEER_REGISTRATION_FAILED")
            actor = json.loads(registered.stdout)["agent"]["name"]
        result["actor"] = actor
        before = identity_snapshot(work)
        if not before:
            raise RuntimeError("NATIVE_IDENTITY_COVERAGE_EMPTY")
        # A diagnostic read must not adopt the dead alias before the actual
        # consumer runs. The dead case exercises the helper twice directly.
        if role != "dead":
            binding = capture([config["am"], "agents", "resolve-pane",
                               "--project", work, "--json"], env, work)
            result["binding_exit"] = binding.returncode
            if binding.returncode == 0:
                result["binding"] = json.loads(binding.stdout)
        if role == "peer":
            if result.get("binding", {}).get("binding") != "verified-live":
                raise RuntimeError("NATIVE_PEER_NOT_QUALIFIED")
            lease = capture(
                [config["am"], "file_reservations", "reserve", work, actor,
                 ".beads/beads.db", "--exclusive", "--ttl", "120",
                 "--reason", "owned native actor boundary fixture"], env, work,
            )
            result["lease_exit"] = lease.returncode
            if lease.returncode:
                raise RuntimeError("NATIVE_PEER_LEASE_FAILED")
        else:
            refusal = projected(actor, work, env, config.get("mutate", False))
            result.update(helper_exit=refusal.returncode, no_exports=not refusal.stdout,
                          identity_unchanged=identity_snapshot(work) == before)
            if role == "dead":
                repeated = projected(actor, work, env, config.get("mutate", False))
                result.update(repeat_helper_exit=repeated.returncode,
                              repeat_no_exports=not repeated.stdout,
                              identity_unchanged=identity_snapshot(work) == before)
    except Exception as error:
        result["harness_error"] = type(error).__name__ + ":" + (
            str(error) if isinstance(error, RuntimeError) else "NO_RAW_EXCEPTION")
    finally:
        (work / (role + ".json")).write_text(json.dumps(result), encoding="utf-8")
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "-S", role + "-ready"],
                       check=True, timeout=5)
    if role == "peer" and "harness_error" not in result:
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "peer-done"],
                       check=True, timeout=60)
        released = capture([config["am"], "file_reservations", "release", work, actor], env, work)
        if released.returncode:
            raise RuntimeError("NATIVE_PEER_RELEASE_FAILED")


def native_cases(work, config):
    env = native_env(work, config)
    result = {"scope": "owned native processes and disposable tracker; no fleet rollout",
              "source_sha256": hashlib.sha256(script.read_bytes()).hexdigest(),
              "mutant": bool(config.get("mutate")), "checks": {}, "caller_pid": os.getpid()}
    completed = False
    def cancelled(signum, _frame):
        result["harness_error"] = f"CANCELLED_{signum}"
        raise SystemExit(128 + signum)
    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, cancelled)
    server = None
    api_out = (work / "api.stdout").open("wb")
    api_err = (work / "api.stderr").open("wb")
    def check(name, condition):
        result["checks"][name] = bool(condition)
    def refused(name, argv=None, other_env=None):
        before = identity_snapshot(work)
        answer = capture(argv, other_env or env, work) if argv else projected(
            name, work, other_env or env, config.get("mutate", False))
        check(name, bool(before) and answer.returncode == 4 and not answer.stdout
              and identity_snapshot(work) == before)
        return answer
    def start_peer(role):
        started = capture(
            ["tmux", "-S", config["socket"], "new-window", "-d", "-P", "-F", "#{pane_id}",
             "-t", "actor-native", "-c", work, "sh", test_script,
             "--native-" + role, work], env, work)
        if started.returncode:
            raise RuntimeError("NATIVE_PEER_START_FAILED")
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", role + "-ready"],
                       check=True, timeout=30)
        value = json.loads((work / (role + ".json")).read_text(encoding="utf-8"))
        result[role] = value
        if "harness_error" in value:
            raise RuntimeError("NATIVE_PEER_FIXTURE_FAILED")
        return started.stdout.strip(), value
    try:
        server = subprocess.Popen(
            [config["am"], "serve-http", "--host", "127.0.0.1", "--port", "0", "--no-auth", "--no-tui"],
            cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=api_out, stderr=api_err,
        )
        (work / "api.pid").write_text(str(server.pid), encoding="ascii")
        result["api_pid"] = server.pid
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and server.poll() is None:
            listener = capture(["lsof", "-nP", "-a", "-p", server.pid,
                                "-iTCP", "-sTCP:LISTEN", "-Fn"], env, work)
            result["listener"] = {"exit": listener.returncode, "stdout": listener.stdout}
            addresses = [line[1:] for line in listener.stdout.splitlines()
                         if line.startswith("n127.0.0.1:")]
            if addresses:
                config["port"] = int(addresses[0].rsplit(":", 1)[1])
                break
            time.sleep(0.05)
        if not config.get("port"):
            raise RuntimeError("NATIVE_API_NOT_READY")
        (work / "config.json").write_text(json.dumps(config), encoding="utf-8")
        env = native_env(work, config)
        for args in ([config["am"], "--version"], [config["br"], "--version"],
                     ["git", "init", "-q", "--initial-branch=main", work],
                     [config["br"], "init", "--prefix", "a97"]):
            answer = capture(args, env, work)
            if answer.returncode:
                raise RuntimeError("NATIVE_PREREQUISITE_FAILED")
            if "--version" in args:
                result[str(args[0])] = answer.stdout.strip()
        registered = capture(
            [config["am"], "macros", "start-session", "--project", work,
             "--program", "native-owned-fixture", "--model", "no-model-fixture",
             "--inbox-limit", "1", "--json"], env, work)
        if registered.returncode:
            raise RuntimeError("NATIVE_REGISTRATION_FAILED")
        actor = json.loads(registered.stdout)["agent"]["name"]
        result["actor"] = actor
        proof = capture([config["am"], "agents", "resolve-pane",
                         "--project", work, "--json"], env, work)
        result["native_binding"] = json.loads(proof.stdout) if proof.returncode == 0 else {}
        check("qualified-native-binding", proof.returncode == 0
              and result["native_binding"].get("binding") == "verified-live"
              and result["native_binding"].get("agent_name") == actor)
        created = capture([config["br"], "--actor", actor, "create",
                           "native actor fixture", "--type", "task", "--json"], env, work)
        if created.returncode:
            raise RuntimeError("NATIVE_TRACKER_SEED_FAILED")
        issue = json.loads(created.stdout)["id"]
        shell = ('projection=$(sh "$1" --agent "$2" --project "$3" --kit-root "$4") || exit "$?"; '
                 'eval "$projection" || exit "$?"; br comments add "$5" "$6" --json')
        command = ["sh", "-c", shell, "native-actor-test", script, actor, work, root, issue]
        written = capture([*command, "ordinary-native-own-caller"], env, work)
        readback = capture([config["br"], "comments", "list", issue, "--json"], env, work)
        comments = json.loads(readback.stdout) if readback.returncode == 0 else []
        result["ordinary_comment_exit"] = written.returncode
        check("ordinary-comment-native-actor", written.returncode == 0 and readback.returncode == 0
              and any(row.get("author") == actor and row.get("text") == "ordinary-native-own-caller"
                      for row in comments))
        refused("unregistered-name", ["sh", script, "--agent", "UnregisteredOtherCaller",
                                     "--project", work, "--kit-root", root])
        missing = env.copy()
        missing.pop("TMUX", None)
        missing.pop("TMUX_PANE", None)
        refused("unavailable-runtime", ["sh", script, "--agent", actor,
                                        "--project", work, "--kit-root", root], missing)
        other = work / "other-project"
        other.mkdir()
        refused("wrong-project", ["sh", script, "--agent", actor,
                                  "--project", other, "--kit-root", root])
        peer_pane, peer_value = start_peer("peer")
        config["peer_actor"] = peer_value["actor"]
        (work / "config.json").write_text(json.dumps(config), encoding="utf-8")
        refused("director-substituted", ["sh", script, "--agent", peer_value["actor"],
                                        "--project", work, "--kit-root", root])
        borrowed = env.copy()
        borrowed["TMUX_PANE"] = peer_pane
        refused("another-live-pane", ["sh", script, "--agent", peer_value["actor"],
                                     "--project", work, "--kit-root", root], borrowed)
        def lease_rows():
            listed = capture([config["am"], "file_reservations", "list", work], env, work)
            if listed.returncode:
                raise RuntimeError("NATIVE_LEASE_READ_FAILED")
            rows = [tuple(line.split()) for line in listed.stdout.splitlines()
                    if line.split() and line.split()[0].isdecimal()]
            if not any(peer_value["actor"] in row for row in rows):
                raise RuntimeError("NATIVE_LEASE_POSITIVE_CONTROL_MISSING")
            return rows
        leases_before = lease_rows()
        identity_before = identity_snapshot(work)
        leased = capture([*command, "must-not-land-under-foreign-lease"], env, work)
        unchanged = capture([config["br"], "comments", "list", issue, "--json"], env, work)
        check("foreign-lease-no-tracker-write", leased.returncode == 4
              and "BR_SHIM_TRACKER_RESERVED" in leased.stderr
              and unchanged.returncode == 0 and unchanged.stdout == readback.stdout
              and lease_rows() == leases_before
              and identity_snapshot(work) == identity_before)
        _, weak = start_peer("weak")
        check("weak-native-binding-rejected",
              weak.get("binding", {}).get("binding") == "legacy-unverified"
              and weak.get("helper_exit") == 4 and weak.get("no_exports")
              and weak.get("identity_unchanged"))
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "-S", "peer-done"],
                       check=True, timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = capture(["tmux", "-S", config["socket"], "display-message", "-p",
                             "-t", peer_pane, "#{pane_dead}"], env, work)
            if state.stdout.strip() == "1":
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("NATIVE_PEER_DID_NOT_EXIT")
        restarted = capture(
            ["tmux", "-S", config["socket"], "respawn-pane", "-t", peer_pane,
             "-c", work, "sh", test_script, "--native-dead", work], env, work)
        if restarted.returncode:
            raise RuntimeError("NATIVE_DEAD_ALIAS_START_FAILED")
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "dead-ready"],
                       check=True, timeout=30)
        dead = json.loads((work / "dead.json").read_text(encoding="utf-8"))
        result["dead"] = dead
        check("dead-native-alias-rejected", "harness_error" not in dead
              and dead.get("helper_exit") == 4 and dead.get("no_exports")
              and dead.get("repeat_helper_exit") == 4 and dead.get("repeat_no_exports")
              and dead.get("identity_unchanged"))
        completed = True
    except Exception as error:
        result["harness_error"] = type(error).__name__ + ":" + (
            str(error) if isinstance(error, RuntimeError) else "NO_RAW_EXCEPTION")
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=3)
        result["api_exit"] = server.returncode if server is not None else None
        api_out.close()
        api_err.close()
        result["source_unchanged"] = hashlib.sha256(script.read_bytes()).hexdigest() == result["source_sha256"]
        result["exit"] = int(not completed or bool(result.get("harness_error"))
                             or not all(result["checks"].values()) or not result["source_unchanged"])
        (work / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "-S", "native-ready"],
                       check=True, timeout=5)


if mode.startswith("--native"):
    if mode != "--native":
        work = Path(sys.argv[3])
        config = json.loads((work / "config.json").read_text(encoding="utf-8"))
        if mode == "--native-pane":
            native_cases(work, config)
        else:
            peer(work, config, mode.removeprefix("--native-"))
        sys.exit(0)
    dependencies = {name: shutil.which(name) for name in ("am", "br", "tmux", "lsof")}
    if not all(dependencies.values()):
        print("UNSUPPORTED: native acceptance requires am, br, tmux and lsof")
        sys.exit(77)
    work = root / "var" / "agent-tmp" / f"actor-native.{os.getpid()}"
    work.mkdir(parents=True)
    (work / "home").mkdir()
    (work / ".owner").write_text(
        f"pid={os.getpid()}\nlabel=actor-native\nrepo={root}\n"
        f"created={datetime.datetime.now(datetime.timezone.utc).isoformat()}\n", encoding="utf-8")
    config = {"am": dependencies["am"], "br": os.environ.get("BR_REAL", dependencies["br"]),
              "socket": str(work / "s"), "mutate": "--mutant-binding" in sys.argv[3:]}
    (work / "config.json").write_text(json.dumps(config), encoding="utf-8")
    env = native_env(work, config)
    server_pid = None
    try:
        started = capture(
            ["tmux", "-f", "/dev/null", "-S", config["socket"], "new-session", "-d",
             "-P", "-F", "#{pid}", "-s", "actor-native", "-c", work,
             "sh", test_script, "--native-pane", work], env, work)
        if started.returncode:
            raise RuntimeError("NATIVE_CALLER_START_FAILED")
        server_pid = int(started.stdout.strip())
        capture(["tmux", "-S", config["socket"], "set-option", "-g", "remain-on-exit", "on"],
                env, work)
        subprocess.run(["tmux", "-S", config["socket"], "wait-for", "native-ready"],
                       check=True, timeout=120)
        result = json.loads((work / "result.json").read_text(encoding="utf-8"))
        print(json.dumps(result, indent=2))
        print("native_evidence=" + str(work / "result.json"))
        sys.exit(result["exit"])
    finally:
        # Only this invocation's recorded private tmux server, never a fleet pane.
        if server_pid is not None:
            try:
                os.kill(server_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

work = root / "var" / "agent-tmp" / f"agent-spawn-test.{os.getpid()}"
work.mkdir(parents=True)
(work / ".owner").write_text(
    f"pid={os.getpid()}\nlabel=agent-spawn-test\nrepo={root}\n"
    f"created={datetime.datetime.now(datetime.timezone.utc).isoformat()}\n",
    encoding="utf-8",
)
available = work / "available"
available.mkdir()
(available / "br").symlink_to("/bin/sh")
cases = [
    ("name-only", ["--agent", "UnregisteredSpawn"]),
    ("anonymous", []),
    ("multiline", ["--agent", "First\nSecond"]),
    ("missing-value", ["--agent"]),
]
failures = 0
for label, args in cases:
    case_dir = work / label
    home = case_dir / "home"
    home.mkdir(parents=True)
    env = os.environ.copy()
    env.update(HOME=str(home), TMPDIR=str(work),
               PATH=f"{available}:{env.get('PATH', '')}")
    for carrier in ("TMUX", "TMUX_PANE", "TERN_PANE", "HERDR_PANE_ID"):
        env.pop(carrier, None)
    stdout, stderr = case_dir / "stdout", case_dir / "stderr"
    with stdout.open("wb") as out, stderr.open("wb") as err:
        try:
            result = subprocess.run(
                ["sh", str(root / "scripts" / "agent-spawn-env.sh"), *args],
                cwd=root, env=env, stdout=out, stderr=err, timeout=3, check=False,
            )
        except subprocess.TimeoutExpired:
            failures += 1
            print(f"FAIL {label}: timeout is not an authorization refusal")
            continue
    refused = result.returncode == 4
    untouched = stdout.stat().st_size == 0 and not (home / ".local").exists()
    if refused and untouched:
        print(f"PASS {label}: no authority or filesystem effect")
    else:
        failures += 1
        print(f"FAIL {label}: exit={result.returncode}; authority or filesystem effect")
print(f"agent-spawn-env authorization: {len(cases) - failures} pass {failures} fail")
sys.exit(1 if failures else 0)
PY
