"""Read-only evidence probe: what a seat looks like on this host.

Usage: python3 seat_shapes.py TMUX_SOCKET IDENTITY_ROOT PROJECT_ROOT [POLICY_YAML]
Prints the first panes from `tmux list-panes -a`, whether IDENTITY_ROOT/<hash(PROJECT_ROOT)[:12]>
exists for sha256 and for sha1, the raw bytes of the per-pane Agent Mail identity files in the sha1
directory under the bare (%N -> N) and composite (session-window-pane) keys, whether each carries
a pane_pid equal to the live pane_pid, one agent process command line found under a pane's process
tree, and the raw `statuses:` line of a tracker policy file.
Nothing is written; no pane receives input.
"""
import hashlib
import json
import os
import subprocess
import sys

sock, identity_root, project = sys.argv[1], sys.argv[2], sys.argv[3]
fmt = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{session_name}-#{window_index}-#{pane_index}"
panes = [line.split("\t") for line in subprocess.run(["tmux", "-S", sock, "list-panes", "-a", "-F", fmt], capture_output=True, text=True, check=True).stdout.splitlines()]
print("pane_count", len(panes), "first", [p[:3] for p in panes[:3]])
for algorithm in ("sha256", "sha1"):
    digest = hashlib.new(algorithm, project.encode()).hexdigest()[:12]
    print("identity_dir", algorithm, digest, "exists", os.path.isdir(os.path.join(identity_root, digest)))
folder = os.path.join(identity_root, hashlib.sha1(project.encode()).hexdigest()[:12])
print("identity_entries", sorted(os.listdir(folder)) if os.path.isdir(folder) else [])
shown = 0
for seat, pane_id, pane_pid, composite in panes:
    for key in (pane_id.lstrip("%"), composite):
        path = os.path.join(folder, key)
        if not os.path.isfile(path) or shown >= 8:
            continue
        shown += 1
        raw = open(path, encoding="utf-8").read()
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        bound_pid = parsed.get("pane_pid") if isinstance(parsed, dict) else None
        print("identity", seat, pane_id, "key", key, "raw", repr(raw[:200]), "has_pane_pid", bound_pid is not None, "pane_pid_matches", bound_pid == int(pane_pid))
procs = [line.split(None, 2) for line in subprocess.run(["ps", "-A", "-o", "pid=,ppid=,command="], capture_output=True, text=True, check=True).stdout.splitlines()]
children = {}
command = {}
for row in procs:
    if len(row) == 3:
        children.setdefault(int(row[1]), []).append(int(row[0]))
        command[int(row[0])] = row[2]
for seat, pane_id, pane_pid, _composite in panes:
    stack, seen = [int(pane_pid)], []
    while stack:
        pid = stack.pop()
        seen.append(pid)
        stack.extend(children.get(pid, []))
    agents = [command[p] for p in seen if p in command and ("/.bun/bin/omp" in command[p] or "pi-coding-agent/dist/cli.js" in command[p]) and "__omp_worker" not in command[p]]
    if agents:
        print("agent_process", seat, repr(agents[0][:160]))
        break
if len(sys.argv) > 4:
    for line in open(sys.argv[4], encoding="utf-8"):
        if line.strip().startswith("statuses:"):
            print("policy_statuses", repr(line.rstrip()))
