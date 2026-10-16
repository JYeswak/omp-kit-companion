#!/bin/sh
set -eu
exec python3 - "$0" "$@" <<'PY'
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve().parents[2]
mutant = sys.argv[2] if len(sys.argv) == 3 else ""
if len(sys.argv) > 3 or mutant not in ("", "stale-convert-guard", "old-output-key"):
    raise SystemExit("Usage: planning-share-name.sh [stale-convert-guard|old-output-key]")
work = root / "var" / "agent-tmp" / ("planning-share-name." + str(os.getpid()))
work.mkdir(parents=True)
(work / ".owner").write_text(json.dumps({"pid": os.getpid(), "label": "planning-share-name", "repo": str(root), "created": datetime.datetime.now(datetime.timezone.utc).isoformat()}) + "\n")
home = work / "home"
home.mkdir()
repo = work / "prose-repo"
repo.mkdir()
env = {key: value for key, value in os.environ.items() if key not in ("BEADS_DB", "BEADS_JSONL", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")}
env.update(HOME=str(home), TMPDIR=str(work), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
bun = shutil.which("bun")
br = shutil.which("br")
if not br or not bun:
    raise SystemExit("A real native br and Bun are required; base-entry cases are never skipped")
env["BR_BIN"] = br
cli = [os.environ["KIT"]] if os.environ.get("KIT") else [bun, str(root / "src" / "cli.ts")]
if mutant:
    if os.environ.get("KIT"):
        raise SystemExit("In-memory mutation requires the source Bun entrypoint, not KIT")
    cli = [bun, "--preload", str(root / "scripts" / "e2e" / "planning-share-name-mutant.ts"), cli[-1]]
    env["PLANNING_SHARE_MUTANT"] = mutant


def execute(command, cwd=repo):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=45)
    return {"command": command, "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def git(*args):
    result = execute(["git", *args])
    if result["exit_code"]:
        print(json.dumps(result), flush=True)
        raise SystemExit(1)


def no_test_share(value):
    if isinstance(value, dict):
        return "test_share" not in value and all(no_test_share(item) for item in value.values())
    return not isinstance(value, list) or all(no_test_share(item) for item in value)


def envelopes(result):
    return [json.loads(line)["data"] for line in result["stdout"].splitlines() if line.strip()]


failures = 0
cases = 0


def record(name, result, expected, observed, passed):
    global failures, cases
    cases += 1
    failures += not passed
    (work / (name + ".json")).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"fixture_id": "prose-only-share", "case": name, "command": result["command"], "exit_code": result["exit_code"], "expected": expected, "observed": observed, "pass": passed}), flush=True)


git("init", "--initial-branch=main")
git("config", "user.name", "Planning share fixture")
git("config", "user.email", "planning-share@example.invalid")
(repo / "src").mkdir()
(repo / "src" / "fixture.ts").write_text("export const fixture = true;\n")
(repo / ".beads").mkdir()
(repo / ".omp").mkdir()
(repo / "PLAN_share.md").write_text("# Prose-presence fixture; no executed tests claimed\n")
(repo / ".beads" / "issues.jsonl").write_text(json.dumps({"id": "prose-only-share", "title": "Prose only", "description": "PLAN_share.md " + "detail " * 60, "acceptance_criteria": "looks good", "status": "open", "labels": ["mission:share"], "dependencies": [{"depends_on_id": "fixture-root", "type": "blocks"}]}) + "\n")
normal_override = '[ci]\nmode = "local"\nbranch = "main"\ncheck = "fixture-only-no-execution-claim"\nreceipts = ".omp/receipts"\n[missions.share]\nstage = "build"\n'
override = repo / ".omp" / "planning-score.toml"
override.write_text(normal_override)
git("add", "--", "src/fixture.ts", ".beads/issues.jsonl", ".omp/planning-score.toml", "PLAN_share.md")
git("commit", "-m", "feat: isolated planning share fixture")

result = execute(cli + ["planning", "score", "--repo", str(repo), "--json"], root)
(work / "score-producer.json").write_text(json.dumps(result, indent=2) + "\n")
try:
    rows = envelopes(result)
    quality = next(row for row in rows if row.get("kind") == "mission")["metrics"]["bead_self_contained"]
except (KeyError, ValueError, StopIteration):
    print(json.dumps({"kind": "INVALID", "case": "score-startup", "scratch": str(work), "producer": result}), flush=True)
    raise SystemExit(2)
observed = {"metric": quality, "no_test_share_at_any_depth": no_test_share(rows)}
record("score-prose", result, {"acceptance_present_share": 1, "metric_status": "PASS", "no_test_share_at_any_depth": True}, observed,
       result["exit_code"] == 3 and quality["value"].get("acceptance_present_share") == 1 and quality["status"] == "PASS" and no_test_share(rows))
# Exit3 is deliberately retained: this fixture has NO local CI receipt. Presence is not execution.

result = execute(cli + ["planning", "convert", "--plan", str(root / "tests" / "fixtures" / "planning-convert" / "valid.md"), "--mission", "core8", "--dry-run", "--db", str(work / "native-convert"), "--json"], root)
(work / "convert-producer.json").write_text(json.dumps(result, indent=2) + "\n")
rows = envelopes(result)
report = rows[0]
observed = {"acceptance_share": report["planning_score_bead_metrics"]["acceptance_share"], "overall": report["overall"], "no_test_share_at_any_depth": no_test_share(rows)}
record("convert-native", result, {"acceptance_share": 1, "overall": "CLEAN", "no_test_share_at_any_depth": True}, observed,
       result["exit_code"] == 0 and observed == {"acceptance_share": 1, "overall": "CLEAN", "no_test_share_at_any_depth": True})

replacement = "bead_self_contained_acceptance_present_share"
for legacy in ("test_share", "bead_self_contained_test_share"):
    for mixed in (False, True):
        override.write_text(normal_override + "[targets]\n" + legacy + " = 0.9\n" + (replacement + " = 0.1\n" if mixed else ""))
        result = execute(cli + ["planning", "score", "--repo", str(repo), "--json"], root)
        diagnostic = result["stdout"] + result["stderr"]
        observed = {"nonzero": result["exit_code"] != 0, "migration_error": "Rename legacy" in diagnostic and replacement in diagnostic}
        record("legacy-override-" + legacy + "-" + str(mixed), result, {"nonzero": True, "migration_error": True}, observed, all(observed.values()))
override.write_text(normal_override)

# The CLI exposes no base-root override. Exercise its real exported entry function
# with isolated base DATA instead; do not copy source or invent a production flag.
original = (root / "config" / "planning-score.toml").read_text()
for legacy in ("test_share", "bead_self_contained_test_share"):
    base = work / ("base-" + legacy)
    (base / "config").mkdir(parents=True)
    (base / "config" / "planning-score.toml").write_text(original.replace(replacement, legacy))
    program = "import {runPlanningScore} from " + json.dumps(str(root / "src" / "planning-score.ts")) + ";const r=runPlanningScore({kitRoot:" + json.dumps(str(base)) + ",repoPath:" + json.dumps(str(repo)) + ",home:" + json.dumps(str(home)) + "});console.log(JSON.stringify(r));process.exit(r.code);"
    result = execute([bun, "--eval", program], root)
    diagnostic = result["stdout"] + result["stderr"]
    observed = {"nonzero": result["exit_code"] != 0, "migration_error": "Rename legacy" in diagnostic and replacement in diagnostic}
    record("legacy-base-entry-function-" + legacy, result, {"nonzero": True, "migration_error": True}, observed, all(observed.values()))

print(json.dumps({"kind": "totals", "cases": cases, "failed": failures, "in_memory_mutant": mutant or None, "scratch": str(work), "limits": ["Native public score+convert over isolated fixture data, not test quality or installed fleet adoption", "Base TOML uses the real exported score entry function because the CLI has no base-root override"]}), flush=True)
raise SystemExit(1 if failures else 0)
PY
