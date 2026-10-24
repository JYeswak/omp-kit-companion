#!/bin/sh
set -eu
exec python3 - "$0" "$@" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve().parents[2]
mutant = sys.argv[2] if len(sys.argv) == 3 else ""
if len(sys.argv) > 3 or mutant not in ("", "drop-head-filter", "earliest-run"):
    raise SystemExit("Usage: planning-main-green.sh [drop-head-filter|earliest-run]")
sys.path.insert(0, str(root / "scripts"))
from kitlib_tmp import owned_tmp

work_root = root / "var" / "agent-tmp"
work_root.mkdir(parents=True, exist_ok=True)
work = pathlib.Path(owned_tmp("planning-main-green", root=str(work_root), bead="ompkit-8hpf4").path)
os.environ["TMPDIR"] = str(work)
repo = work / "repo"
repo.mkdir()
home = work / "home"
home.mkdir()
bin_dir = work / "bin"
bin_dir.mkdir()
env = dict(os.environ, HOME=str(home), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)


def execute(argv, cwd=repo, environment=env):
    result = subprocess.run(argv, cwd=cwd, env=environment, text=True, capture_output=True, timeout=45)
    return {"command": argv, "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def git(*args):
    result = execute(["git", *args])
    if result["exit_code"] != 0:
        print(json.dumps(result), flush=True)
        raise SystemExit(1)
    return result["stdout"].strip()


git("init", "--initial-branch=main")
git("config", "user.name", "Planning CI fixture")
git("config", "user.email", "planning-ci@example.invalid")
(repo / "src").mkdir()
(repo / "src" / "fixture.ts").write_text("export const fixture = true;\n")
git("add", "--", "src/fixture.ts")
git("commit", "-m", "feat: fixture code")
old_head = git("rev-parse", "HEAD")
(repo / ".omp").mkdir()
(repo / ".beads").mkdir()
(repo / "PLAN_maingreen.md").write_text("# Fixture mission\n")
(repo / ".beads" / "issues.jsonl").write_text(json.dumps({"id": "fixture", "title": "Fixture only", "status": "open", "description": "PLAN_maingreen.md " + "detail " * 60, "acceptance_criteria": "Fixture acceptance touches `src/fixture.ts`; no live outcome claimed.", "labels": ["mission:maingreen"], "dependencies": [{"depends_on_id": "fixture-root", "type": "blocks"}]}) + "\n")
(repo / ".omp" / "planning-score.toml").write_text('[ci]\nmode = "hosted"\nbranch = "main"\nrequired_workflow = "ci.yml"\n[missions.maingreen]\nstage = "build"\n')
git("add", "--", ".omp/planning-score.toml", ".beads/issues.jsonl", "PLAN_maingreen.md")
git("commit", "-m", "plan(maingreen): draft")
head = git("rev-parse", "HEAD")

# Model gh's workflow filtering, field projection and result bound. Without a
# workflow selector the incumbent sees the newest unrelated certification green.
gh = bin_dir / "gh"
gh.write_text("#!" + sys.executable + "\n" + '''import json, os, sys
args = sys.argv[1:]
if args[:1] == ["api"]:
    if os.environ.get("MAINGREEN_API_ERROR") == "1" or args[-1].rsplit("/", 1)[-1] not in ("ci.yml", "17"):
        raise SystemExit(1)
    print(json.dumps({"id": 17, "path": ".github/workflows/ci.yml", "name": "CI"}))
    raise SystemExit(0)
if args[:2] != ["run", "list"]:
    raise SystemExit(2)
rows = json.loads(os.environ["MAINGREEN_RUNS"])
if "--workflow" in args:
    workflow = args[args.index("--workflow") + 1]
    if workflow not in ("17", "ci.yml", ".github/workflows/ci.yml"):
        raise SystemExit(1)
    rows = [row for row in rows if row.get("workflowDatabaseId") == 17]
rows = sorted(rows, key=lambda row: row.get("createdAt", ""), reverse=True)
limit = int(args[args.index("--limit") + 1])
fields = args[args.index("--json") + 1].split(",")
print(json.dumps([{key: value for key, value in row.items() if key in fields} for row in rows[:limit]]))
''')
gh.chmod(0o755)
cli = [os.environ["KIT"]] if os.environ.get("KIT") else [shutil.which("bun"), str(root / "src" / "cli.ts")]
if not cli[0]:
    raise SystemExit("Bun or KIT is required")
if mutant:
    if os.environ.get("KIT"):
        raise SystemExit("In-memory mutation requires the source Bun entrypoint, not KIT")
    cli = [cli[0], "--preload", str(root / "scripts" / "e2e" / "planning-main-green-mutant.ts"), cli[1]]
env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")


def run(identifier, sha=head, conclusion="success", status="completed", created="2026-10-15T01:00:00Z", attempt=1, workflow=17):
    return {"databaseId": identifier, "headSha": sha, "conclusion": conclusion, "status": status, "createdAt": created, "attempt": attempt, "workflowDatabaseId": workflow, "workflowName": "CI" if workflow == 17 else "OMP certification"}


old = run(100, sha=old_head)
green = run(101)
newer = "2026-10-15T02:00:00Z"
decoy = run(999, created="2026-10-15T03:00:00Z", workflow=99)
cases = [
    ("unrelated-green-required-red", [old, decoy, run(102, conclusion="failure", created=newer)], "FAIL", "ci.yml", False),
    ("same-head-newer-red", [green, run(102, conclusion="failure", created=newer)], "FAIL", "ci.yml", False),
    ("same-head-newer-cancelled", [green, run(102, conclusion="cancelled", created=newer)], "FAIL", "ci.yml", False),
    ("same-head-newer-pending", [green, run(102, conclusion="", status="in_progress", created=newer)], "UNKNOWN", "ci.yml", False),
    ("same-run-newer-attempt-red", [green, run(101, conclusion="failure", attempt=2)], "FAIL", "ci.yml", False),
    ("no-run-at-current-head", [old], "UNKNOWN", "ci.yml", False),
    ("newer-run-for-old-head-must-not-hide-current-green", [green, run(102, sha=old_head, created=newer)], "PASS", "ci.yml", False),
    ("malformed-latest-attempt-cannot-revive-green", [green, run(102, created=newer, attempt=0)], "UNKNOWN", "ci.yml", False),
    ("no-required-workflow", [green], "UNKNOWN", "", False),
    ("workflow-lookup-failed", [green], "UNKNOWN", "ci.yml", True),
    ("display-name-not-identity", [green], "UNKNOWN", "CI", False),
    ("required-head-green", [old, green], "PASS", "ci.yml", False),
    ("required-numeric-id-green", [green], "PASS", "17", False),
    ("required-numeric-literal-green", [green], "PASS", 17, False),
    ("required-full-path-green", [green], "PASS", ".github/workflows/ci.yml", False),
    ("unrelated-runs-cannot-hide-required-green", [run(1000 + i, created="2026-10-15T03:00:00Z", workflow=99) for i in range(21)] + [green], "PASS", "ci.yml", False),
]
failures = 0
print(json.dumps({"kind": "environment", "scratch": str(work), "head": head, "entrypoint": cli, "source_sha256": hashlib.sha256((root / "src" / "planning-score.ts").read_bytes()).hexdigest(), "gh_fixture_sha256": hashlib.sha256(gh.read_bytes()).hexdigest(), "in_memory_mutant": mutant or None, "mutation_loader_sha256": hashlib.sha256((root / "scripts" / "e2e" / "planning-main-green-mutant.ts").read_bytes()).hexdigest() if mutant else None}), flush=True)
for name, runs, expected, workflow, api_error in cases:
    (repo / ".omp" / "planning-score.toml").write_text('[ci]\nmode = "hosted"\nbranch = "main"\nrequired_workflow = ' + json.dumps(workflow) + '\n[missions.maingreen]\nstage = "build"\n')
    payload = json.dumps(runs)
    case_env = dict(env, MAINGREEN_RUNS=payload, MAINGREEN_API_ERROR="1" if api_error else "0", MAINGREEN_MUTANT=mutant)
    result = execute(cli + ["planning", "score", "--repo", str(repo), "--json"], cwd=root, environment=case_env)
    (work / (name + ".json")).write_text(json.dumps(result, indent=2) + "\n")
    try:
        rows = [json.loads(line)["data"] for line in result["stdout"].splitlines() if line.strip()]
        metric = next(row for row in rows if row.get("kind") == "mission")["metrics"]["main_green"]
    except (KeyError, ValueError, StopIteration):
        metric = {"status": "UNREADABLE", "evidence": {}}
    expected_exit = {"PASS": 0, "FAIL": 1, "UNKNOWN": 3}[expected]
    passed = metric.get("status") == expected and result["exit_code"] == expected_exit
    if expected == "PASS":
        evidence = metric.get("evidence", {})
        passed = passed and evidence.get("branch_head_sha") == head and evidence.get("workflow_id") == 17 and evidence.get("workflow_path") == ".github/workflows/ci.yml" and evidence.get("run_id") == green["databaseId"]
    failures += not passed
    print(json.dumps({"kind": "case", "fixture": name, "payload_sha256": hashlib.sha256(payload.encode()).hexdigest(), "command": result["command"], "exit_code": result["exit_code"], "expected_exit_code": expected_exit, "expected": expected, "observed": metric.get("status"), "evidence": metric.get("evidence"), "pass": passed}), flush=True)
print(json.dumps({"kind": "summary", "cases": len(cases), "passed": len(cases) - failures, "failed": failures}), flush=True)
raise SystemExit(1 if failures else 0)
PY
