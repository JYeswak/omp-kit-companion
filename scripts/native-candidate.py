#!/usr/bin/env python3
"""Certify a provisional archive on its native runner; never publish from CI."""
# canonical-cli-scoping-allow-large: native acceptance stays in this assigned runner; scope excludes helper modules.
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

PLATFORMS = ("darwin-arm64-none", "darwin-x64-none", "linux-arm64-gnu", "linux-x64-gnu")


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def case_counts(release_root):
    manifest = load(release_root / "release-manifest.json")
    entries = [row for row in manifest.get("files", [])
               if isinstance(row, dict) and row.get("path") == "cases/cases.tsv"]
    cases_path = release_root / "cases" / "cases.tsv"
    if len(entries) != 1 or not cases_path.is_file() or digest(cases_path) != entries[0].get("sha256"):
        raise ValueError("native case corpus is absent from or differs from the release manifest")
    cases = quiet_cases = 0
    for row in cases_path.read_text(encoding="utf-8").split("\n")[1:]:
        row = row.removesuffix("\r")
        if row.strip() == "" or row.startswith("#"):
            continue
        columns = row.split("\t")
        if len(columns) < 6:
            continue
        cases += 1
        if columns[1] == "quiet":
            quiet_cases += 1
    return cases, quiet_cases


def rule_count(release_root):
    manifest = load(release_root / "release-manifest.json")
    rules = [row["path"] for row in manifest.get("files", [])
             if isinstance(row, dict) and isinstance(row.get("path"), str)
             and row["path"].startswith("rules/") and row["path"].endswith(".md")
             and row["path"].count("/") == 1]
    if not rules:
        raise ValueError("native release manifest declares no rules")
    return len(rules)


def live_scenario_ids(release_root):
    scenarios_path = release_root / "tests" / "live" / "scenarios.json"
    scenarios = load(scenarios_path)
    if not isinstance(scenarios, list):
        raise ValueError("native live scenario fixture is not a JSON array")
    ids = []
    for scenario in scenarios:
        if not isinstance(scenario, dict) or not isinstance(scenario.get("id"), str) or not scenario["id"]:
            raise ValueError("native live scenario fixture contains an invalid id")
        # Match full-test-runner: planted and report-only probe scenarios are not full-ladder runs.
        if not scenario.get("plant") and scenario.get("kind") != "probe":
            ids.append(scenario["id"])
    if len(ids) != len(set(ids)):
        raise ValueError("native live scenario fixture contains duplicate full-ladder ids")
    return ids


def full_live_condition_report(test, expected_live_ids, omp_version):
    proofs = test.get("proofs") if isinstance(test, dict) else {}
    live = proofs.get("G4_live") if isinstance(proofs, dict) else {}
    scenarios = test.get("live_scenarios") if isinstance(test, dict) else {}
    snapshots = test.get("snapshots") if isinstance(test, dict) else {}
    if not isinstance(live, dict):
        live = {}
    if not isinstance(scenarios, dict):
        scenarios = {}
    if not isinstance(snapshots, dict):
        snapshots = {}
    expected_ids = scenarios.get("expected_ids") if isinstance(scenarios.get("expected_ids"), list) else []
    observed_ids = scenarios.get("observed_ids") if isinstance(scenarios.get("observed_ids"), list) else []
    expected_count = len(expected_live_ids)
    checks = {
        "test_status": test.get("status") == "PASS",
        "proof_scope": test.get("proof_scope") == "ISOLATED_FIXTURE_ONLY",
        "omp_version": test.get("omp_version") == omp_version,
        "live_plant": live.get("plant") == "PASS",
        "live_expected_scenarios": live.get("expected_scenarios") == expected_count,
        "live_observed_scenarios": live.get("observed_scenarios") == expected_count,
        "scenarios_status": scenarios.get("status") == "PASS",
        "expected_ids_match": expected_ids == expected_live_ids,
        "expected_ids_count": len(expected_ids) == expected_count,
        "required_scenario": "settings-no-checkout-remedy" in expected_ids,
        "observed_ids_match": observed_ids == expected_ids,
        "release_snapshot": (snapshots.get("release") or {}).get("complete") is True and (snapshots.get("release") or {}).get("unchanged") is True,
        "home_snapshot": (snapshots.get("home") or {}).get("complete") is True and (snapshots.get("home") or {}).get("unchanged") is True,
    }
    return {
        "failed": [name for name, passed in checks.items() if not passed],
        "checks": checks,
        "observed": {
            "derived_count": expected_count,
            "live_expected_scenarios": live.get("expected_scenarios"),
            "live_observed_scenarios": live.get("observed_scenarios"),
            "expected_ids": expected_ids,
            "derived_ids": expected_live_ids,
            "observed_ids": observed_ids,
        },
    }


def valid_omp_version(value):
    return isinstance(value, str) and re.fullmatch(r"\d+\.\d+\.\d+", value) is not None


def load_omp_versions():
    """The two native tracks: the supported floor and the OMP release certified by omp-certify.yml."""
    compat_path = Path(__file__).resolve().with_name("omp-compat.json")
    compat = load(compat_path)
    if (not isinstance(compat, dict) or set(compat) != {"minimum", "certified"}
            or not all(valid_omp_version(compat[track]) for track in ("minimum", "certified"))):
        raise ValueError("scripts/omp-compat.json must contain only stable minimum and certified OMP versions")
    return {"minimum": compat["minimum"], "certified": compat["certified"]}


def save(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "x", encoding="utf-8") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")

def finding(data, component):
    matches = [row for row in data.get("findings", []) if row.get("component") == component]
    if len(matches) != 1:
        raise ValueError(f"native {component} inventory did not inspect the selected component")
    return matches[0]


def refusal_detail(name, child, expected_live_ids=None, omp_version=None):
    """Bounded, kit-redacted cause of a refused native command, so a CI receipt names the failing stage and scenarios."""
    detail = {"command": name, "rc": child.returncode, "stderr_tail": child.stderr.decode(errors="replace")[-2000:]}
    try:
        result = json.loads(child.stdout)
    except json.JSONDecodeError:
        detail["stdout_tail"] = child.stdout.decode(errors="replace")[-2000:]
        return detail
    detail["errors"] = [{"code": error.get("code"), "message": error.get("message")} for error in (result.get("errors") or [])[:5]]
    test = (result.get("data") or {}).get("test") or {}
    if test:
        scenarios = test.get("live_scenarios") or {}
        detail.update(status=test.get("status"),
                      failed_stages=[stage for stage, value in (test.get("stages") or {}).items() if value.get("status") == "FAIL"],
                      failures=(test.get("failures") or [])[:20],
                      missing_scenarios=sorted(set(scenarios.get("expected_ids") or []) - set(scenarios.get("observed_ids") or [])))
        if expected_live_ids is not None and omp_version is not None:
            detail["full_live_conditions"] = full_live_condition_report(test, expected_live_ids, omp_version)
    return detail


def isolated_snapshot(*roots):
    """Hash the complete bounded synthetic HOME/project without following links."""
    h = hashlib.sha256()
    entries = total_bytes = 0
    for root in roots:
        pending = [root]
        while pending:
            path = pending.pop()
            info = path.lstat()
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("native isolation fixture contains a non-regular entry")
            entries += 1
            total_bytes += info.st_size if stat.S_ISREG(info.st_mode) else 0
            if entries > 20000 or total_bytes > 16 * 1024 * 1024:
                raise ValueError("native isolation fixture exceeds snapshot bounds")
            h.update(f"{path.relative_to(root)}:{info.st_mode}:{info.st_size}:{info.st_mtime_ns}\n".encode())
            if stat.S_ISDIR(info.st_mode):
                pending.extend(sorted(path.iterdir(), reverse=True))
            else:
                h.update(bytes.fromhex(digest(path)))
    return h.digest()


def verified_source(source_sha):
    checkout = Path(__file__).resolve().parent.parent
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, capture_output=True, timeout=15)
    dirty = subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"],
                           cwd=checkout, capture_output=True, timeout=30)
    if commit.returncode != 0 or dirty.returncode != 0 or commit.stdout.decode().strip() != source_sha or dirty.stdout:
        raise ValueError("native source is not the exact clean requested commit")


def asset_for(path, platform, version, directory):
    asset = load(path)
    os_name, arch, libc = platform.split("-")
    expected = f"omp-kit-v{version}-{platform}.tar"
    if (set(asset) != {"os", "arch", "libc", "filename", "sha256", "manifest_sha256"}
            or (asset["os"], asset["arch"], asset["libc"], asset["filename"]) != (os_name, arch, libc, expected)
            or any(not isinstance(asset[key], str) or re.fullmatch("[0-9a-f]{64}", asset[key]) is None
                   for key in ("sha256", "manifest_sha256"))
            or digest(Path(directory) / expected) != asset["sha256"]):
        raise ValueError("candidate archive differs from the declared platform asset")
    return asset


def cert_env(home, root):
    """Scrubbed environment for certification children. CI=true always: these
    runs judge. GITHUB_ACTIONS passes through when the parent run sets it so
    nested CI judges (ladder regex-budget --judge-regardless-of-load) see the
    signal; local runs stay fail-closed. Nothing else leaks."""
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(root), "CI": "true",
           "NO_COLOR": "1", "XDG_STATE_HOME": str(home / "state"),
           "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data")}
    if os.environ.get("GITHUB_ACTIONS"):
        env["GITHUB_ACTIONS"] = os.environ["GITHUB_ACTIONS"]
    return env


def native(args):
    if args.platform not in PLATFORMS or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
        raise ValueError("unsupported native candidate")
    if not re.fullmatch("[0-9a-f]{40}", args.source_sha):
        raise ValueError("source commit must be a full Git SHA-1")
    required_omp_versions = load_omp_versions()
    if args.omp_track not in required_omp_versions:
        raise ValueError("unsupported native OMP certification track")
    omp_version = required_omp_versions[args.omp_track]
    if args.omp_version != omp_version:
        raise ValueError(f"native {args.omp_track} proof requires OMP {omp_version}")
    verified_source(args.source_sha)
    asset = asset_for(args.asset, args.platform, args.version, args.archive_dir)
    if (sys.platform == "darwin" and not args.platform.startswith("darwin-")
            or sys.platform == "linux" and not args.platform.startswith("linux-")
            or os.uname().machine not in ("arm64", "aarch64", "x86_64")):
        raise ValueError("archive is not selected for this native runner")
    expected_arch = "arm64" if os.uname().machine in ("arm64", "aarch64") else "x64"
    if asset["arch"] != expected_arch:
        raise ValueError("archive architecture does not match native runner")
    receipt = {"schema_version": 1, "version": args.version, "source_sha": args.source_sha,
               "platform": args.platform, "asset": asset, "omp_track": args.omp_track,
               "requested_omp_version": omp_version, "omp_version": None,
               "proofs": {}, "certified": False}
    out = Path(args.out)
    try:
        with tempfile.TemporaryDirectory(prefix="omp-kit-native-") as temp:
            root = Path(temp).resolve()
            home = root / "home"
            home.mkdir()
            env = cert_env(home, root)
            omp = subprocess.run(["omp", "--version"], cwd=root, env=env, capture_output=True, timeout=30)
            observed = (omp.stdout + omp.stderr).decode(errors="replace").strip()
            if omp.returncode != 0 or not re.search(r"(?<!\d)" + re.escape(omp_version) + r"(?!\d)", observed):
                raise ValueError(f"stock OMP version does not match requested {args.omp_track} version {omp_version}")
            receipt["omp_version"] = omp_version
            index = root / "release-index.json"
            save(index, {"schema_version": 1, "version": args.version, "source_tag": "v" + args.version,
                         "assets": {args.platform: asset}})
            prefix = root / "installed"
            installer = Path(__file__).resolve().parent.parent / "installer" / "install.sh"
            installed = subprocess.run(["sh", str(installer), "--version", args.version,
                                        "--index", str(index), "--offline", str(Path(args.archive_dir) / asset["filename"]),
                                        "--prefix", str(prefix)], cwd=root, env=env, capture_output=True, timeout=180)
            if installed.returncode != 0:
                raise ValueError("verified archive installation refused; inspect native runner logs privately")
            binary = prefix / "bin" / "omp-kit"
            release_root = prefix / "releases" / args.version
            if not binary.is_file() or binary.resolve() != (release_root / "bin" / "omp-kit").resolve():
                raise ValueError("native installer did not activate the selected release binary")
            expected_cases, expected_quiet_cases = case_counts(release_root)
            expected_rules = rule_count(release_root)
            expected_live_ids = live_scenario_ids(release_root)
            expected_live_scenarios = len(expected_live_ids)
            agent = home / ".omp" / "agent"
            agent.mkdir(parents=True)
            (agent / "config.yml").write_text("memory:\n  backend: off\n", encoding="utf-8")
            project = root / "startup-project"
            (project / ".omp" / "extensions").mkdir(parents=True)
            (project / ".omp" / "extensions" / "inventory-only.ts").write_text(
                "// On-disk startup input; never executed by this certification.\n", encoding="utf-8")
            (project / ".omp" / "lsp.json").write_text(json.dumps({"servers": {
                "fixture-lsp": {"command": str(root / "missing-lsp"), "rootMarkers": ["."], "fileTypes": ["ts"]},
                "marksman": {"command": "marksman", "rootMarkers": ["."], "fileTypes": ["md"]}}}),
                encoding="utf-8")
            profile = home / ".omp" / "profiles" / "native-fixture" / "agent"
            profile.mkdir(parents=True)
            (profile / "config.yml").write_text("memory:\n  backend: off\n", encoding="utf-8")
            mcp_command = root / "fixture-mcp"
            mcp_marker = root / "mcp-executed"
            mcp_command.write_text("#!/bin/sh\nprintf called > \"$1\"\nexit 99\n", encoding="utf-8")
            mcp_command.chmod(0o700)
            (profile / "mcp.json").write_text(json.dumps({"mcpServers": {"fixture": {
                "type": "stdio", "command": str(mcp_command), "args": [str(mcp_marker)]}}}), encoding="utf-8")
            checks = {"status": ["status", "--json"], "doctor": ["doctor", "--json"],
                      "fast": ["test", "--json"], "full": ["test", "--full", "--json"],
                      "lsp": ["doctor", "--scope", "lsp", "--project", str(project),
                              "--file", str(project / "example.ts"), "--json"],
                      "lsp_setup": ["lsp", "setup", "--plan", "--project", str(project),
                                    "--file", str(project / "example.ts"), "--json"],
                      "memory": ["doctor", "--scope", "memory", "--json"],
                      "memory_off": ["examples", "memory-off", "--json"],
                      "mnemopi_manual": ["examples", "mnemopi-manual", "--json"],
                      "model_roles": ["examples", "model-roles", "--json"],
                      "mcp": ["examples", "mcp", "--json"],
                      "mcp_readiness": ["doctor", "--scope", "mcp", "--profile", "native-fixture", "--json"],
                      "project_preflight": ["doctor", "--scope", "project-loading", "--project", str(project), "--json"]}
            for name, flags in checks.items():
                before = isolated_snapshot(home, project)
                child = subprocess.run([str(binary), *flags], cwd=root, env=env, capture_output=True,
                                       timeout=900 if name == "full" else 120)
                if isolated_snapshot(home, project) != before:
                    raise ValueError(f"native {name} changed the isolated HOME or startup project")
                (root / (name + ".stdout")).write_bytes(child.stdout)
                (root / (name + ".stderr")).write_bytes(child.stderr)
                if child.returncode != 0:
                    receipt["refusal_detail"] = refusal_detail(name, child)
                    raise ValueError(f"native {name} refused rc={child.returncode}")
                result = json.loads(child.stdout)
                if result.get("ok") is not True:
                    receipt["refusal_detail"] = refusal_detail(name, child)
                    raise ValueError(f"native {name} did not report a successful probe")
                data = result["data"]
                if name in ("status", "doctor"):
                    kit = data["kit"]
                    release = kit["release"]
                    omp_identity = data["omp"]
                    if (kit["version"] != args.version or release["source_tag"] != "v" + args.version
                            or release["identity"] != "RELEASE_ROOT_RESOLVED"
                            or Path(release["root"]).resolve() != release_root.resolve()
                            or Path(release["executable"]).resolve() != binary.resolve()
                            or omp_identity["status"] != "PRESENT"
                            or omp_identity["version"] != omp_version
                            or omp_identity["version_proof"] != "PACKAGE_METADATA"
                            or any(finding(data, component)["status"] != "OK" for component in ("kit", "manifest", "omp"))):
                        raise ValueError(f"native {name} did not identify the installed release and stock OMP")
                elif name in ("fast", "full"):
                    test = data["test"]
                    fast_report = test["fast"] if name == "full" else test
                    fast = fast_report["proofs"]
                    if fast_report["status"] != "PASS":
                        raise ValueError(f"native {name} fast matcher did not pass")
                    for gate, observed_count, expected_count in (
                            ("G1_registration", "observed_rules", expected_rules),
                            ("G2_payload", "observed_cases", expected_cases),
                            ("G3_quiet_prefix", "quiet_prefix_fires", 0)):
                        proof = fast[gate]
                        if proof["status"] != "PASS" or proof[observed_count] != expected_count:
                            raise ValueError(f"native {name} {gate} differs from the manifest-bound passing corpus")
                    payload, quiet = fast["G2_payload"], fast["G3_quiet_prefix"]
                    if (payload["expected_cases"] != expected_cases
                            or quiet["expected_cases"] != expected_cases
                            or quiet["expected_quiet_cases"] != expected_quiet_cases
                            or quiet["observed_cases"] != expected_cases
                            or quiet["observed_quiet_cases"] != expected_quiet_cases):
                        raise ValueError(f"native {name} fast case counts differ from the manifest-bound corpus")
                    live = test["proofs"]["G4_live"] if name == "full" else fast["G4_live"]
                    if live["status"] != ("PASS" if name == "full" else "NOT_RUN"):
                        raise ValueError(f"native {name} live class differs from expected proof")
                    if name == "full":
                        condition_report = full_live_condition_report(test, expected_live_ids, omp_version)
                        if not all(condition_report["checks"].values()):
                            receipt["refusal_detail"] = refusal_detail(name, child, expected_live_ids, omp_version)
                            raise ValueError(
                                f"native full ladder live condition(s) failed: {', '.join(condition_report['failed'])}"
                            )
                elif name == "memory_off":
                    if data.get("kind") != "memory-off" or "backend: off" not in data.get("content", ""):
                        raise ValueError("packaged memory-off recipe is unavailable")
                elif name == "mnemopi_manual":
                    if data.get("kind") != "mnemopi-manual" or any(s not in data.get("content", "") for s in (
                            "backend: mnemopi", "scoping: per-project", "autoRetain: false",
                            "autoRecall: false", "noEmbeddings: true", "llmMode: none")):
                        raise ValueError("manual-only memory recipe is unavailable")
                elif name == "model_roles":
                    if data.get("kind") != "model-roles" or "modelRoles: {}" not in data.get("content", ""):
                        raise ValueError("credential-free model-role recipe is unavailable")
                elif name == "mcp":
                    if any(s not in data.get("text", "") for s in (
                            "existing", "mcpServers", "--profile NAME", "NOT_PROBED")):
                        raise ValueError("existing-server MCP guidance is unavailable")
                elif name in ("lsp", "lsp_setup"):
                    report = data.get("report")
                    if (not isinstance(report, dict) or report.get("runtime") != "NOT_PROBED"
                            or report.get("status") not in ("DEGRADED", "UNVERIFIED")
                            or report.get("cwd") != str(project) or report.get("file") != str(project / "example.ts")
                            or not any(server.get("name") == "fixture-lsp" and server.get("configured") is True
                                       and server.get("executable_found") is False and server.get("eligible") is False
                                       and server.get("runtime") == "NOT_PROBED" for server in report.get("servers", []))):
                        raise ValueError("LSP inventory did not classify the uninstalled fixture server without running it")
                    if name == "lsp_setup":
                        marksman = next((server for server in report["servers"] if server.get("name") == "marksman"), None)
                        if not marksman or marksman.get("runtime") != "NOT_PROBED":
                            raise ValueError("LSP setup omitted the known manual server")
                        if marksman.get("executable_found") is False:
                            expected = "MANUAL" if sys.platform == "darwin" else "UNSUPPORTED"
                            command = "brew install marksman" if sys.platform == "darwin" else None
                            if not any(step.get("server") == "marksman" and step.get("status") == expected
                                       and step.get("command") == command for step in data["instructions"]):
                                raise ValueError("LSP setup omitted platform-specific manual guidance")
                elif name == "project_preflight":
                    project_finding = finding(data, "project-loading")
                    if (project_finding["status"] != "UNVERIFIED"
                            or not any(item.get("category") == "project_extension"
                                       and item.get("path") == ".omp/extensions/inventory-only.ts"
                                       for item in project_finding["evidence"]["inputs"])
                            or project_finding["evidence"]["version_semantics"] != "UNVERIFIED"):
                        raise ValueError("project startup inventory did not flag the synthetic execution input")
                elif name == "memory":
                    evidence = finding(data, "memory")["evidence"]
                    if (evidence["backend"] != "off" or evidence["configured"] is not False
                            or evidence["runtime"] != "NOT_PROBED"
                            or evidence["profile_observation"]["effective_active_profile"] != "UNVERIFIED"):
                        raise ValueError("memory inventory did not establish on-disk OFF without runtime claims")
                elif name == "mcp_readiness":
                    evidence = finding(data, "mcp")["evidence"]
                    if (evidence["profile"] != "native-fixture"
                            or evidence["proof"] != "ON_DISK_INVENTORY_ONLY"
                            or not any(server.get("name") == "fixture" and server.get("configured") is True
                                       and server.get("executable_found") is True
                                       and server.get("discoverable") in ("CANDIDATE", "UNVERIFIED")
                                       and server.get("startup_ready") == "NOT_PROBED"
                                       and server.get("actually_callable") == "NOT_PROBED"
                                       for server in evidence["servers"])
                            or mcp_marker.exists()):
                        raise ValueError("named-profile MCP inventory failed or executed the fixture server")
                receipt["proofs"][name] = {"status": "PASS", "stdout_sha256": hashlib.sha256(child.stdout).hexdigest()}
            lsp_root = root / "lsp-fixtures"
            lsp_root.mkdir()

            def lsp_project(name, has_package=True):
                selected = lsp_root / name
                selected.mkdir()
                if has_package:
                    (selected / "package.json").write_text(
                        json.dumps({"name": "native-lsp-fixture", "private": True}) + "\n", encoding="utf-8")
                target = selected / "example.ts"
                target.write_text("export const fixtureValue = 1;\n", encoding="utf-8")
                return selected, target

            def lsp_runtime_path(name, server_source=None):
                directory = root / "lsp-runtime" / name
                directory.mkdir(parents=True)
                for command in ("node", "omp", "bun", "git"):
                    executable = shutil.which(command, path=env["PATH"])
                    if executable is None:
                        if command == "bun":
                            continue
                        raise ValueError("native LSP runtime is missing a required node, OMP, or Git executable")
                    (directory / command).symlink_to(Path(executable).resolve())
                server = None
                if server_source is not None:
                    server = directory / "typescript-language-server"
                    server.write_text(server_source, encoding="utf-8")
                    server.chmod(0o700)
                return str(directory), server

            lsp_report_fields = {
                "status", "scope", "requested_project", "requested_file", "selected_server", "selected_command",
                "reason", "checks", "calls", "omp_rc", "timed_out", "timeout_observation", "fixture_git_init_rc",
                "protected_input_snapshots", "profile_template_unchanged", "profile_template_snapshots",
                "fixture_project_unchanged", "fixture_project_snapshots", "runtime_home_omp_inventory",
                "runtime_state_outputs", "mux_stop_rc", "temporary_workspace_removed"}

            def lsp_snapshot_unchanged(snapshot):
                return (isinstance(snapshot, dict) and snapshot.get("unchanged") is True
                        and snapshot.get("before") == snapshot.get("after"))

            def lsp_call(selected, target, expected_status, path=None):
                before = isolated_snapshot(home, project, selected)
                child = subprocess.run(
                    [str(binary), "doctor", "--scope", "lsp", "--deep", "--yes", "--project", str(selected),
                     "--file", str(target), "--json"],
                    cwd=root, env={**env, "PATH": path or env["PATH"]}, capture_output=True, timeout=240)
                if isolated_snapshot(home, project, selected) != before:
                    raise ValueError("compiled LSP probe changed protected HOME or project inputs")
                try:
                    envelope = json.loads(child.stdout)
                except json.JSONDecodeError as error:
                    raise ValueError("compiled LSP probe returned invalid JSON") from error
                report = envelope.get("data", {}).get("deep_probe")
                if (not isinstance(report, dict) or not lsp_report_fields.issubset(report)
                        or report.get("scope") != "OMP_LSP_TOOL_ROUTE"
                        or report.get("requested_project") != str(selected)
                        or report.get("requested_file") != str(target)
                        or report.get("status") != expected_status
                        or report.get("selected_server") != "typescript-language-server"
                        or report.get("temporary_workspace_removed") is not True):
                    observed_status = report.get("status") if isinstance(report, dict) else "NO_REPORT"
                    observed_reason = report.get("reason") if isinstance(report, dict) else str(envelope.get("errors", []))
                    failed_checks = [key for key, value in report.get("checks", {}).items() if value is False] if isinstance(report, dict) else []
                    raise ValueError(f"compiled LSP expected {expected_status}, observed {observed_status}, rc={child.returncode}; reason={observed_reason}; failed_checks={failed_checks}")
                if expected_status == "PASS":
                    static_data = envelope.get("data", {})
                    static_report = static_data.get("report")
                    lsp_finding = finding(static_data, "lsp")
                    if (child.returncode != 0 or envelope.get("ok") is not True
                            or static_data.get("overall") != "UNVERIFIED"
                            or envelope.get("meta", {}).get("verification") != "PERFORMED"
                            or not isinstance(static_report, dict)
                            or static_report.get("runtime") != "NOT_PROBED"
                            or lsp_finding.get("status") != "UNVERIFIED"
                            or report.get("timed_out") is not False
                            or report.get("timeout_observation") is not None):
                        raise ValueError("synthetic LSP route PASS did not preserve static readiness and least-privilege semantics")
                else:
                    expected_overall = "DEGRADED" if expected_status in ("MISSING", "WRONG_MARKER") else "UNVERIFIED"
                    if (child.returncode != (3 if expected_status == "MISSING" else 2)
                            or envelope.get("data", {}).get("overall") != expected_overall
                            or envelope.get("meta", {}).get("verification") != "UNVERIFIED"
                            or not envelope.get("errors")
                            or envelope["errors"][0].get("code") != "LSP_" + expected_status):
                        raise ValueError(f"compiled LSP {expected_status} did not preserve {expected_overall} and its error class")
                launched_statuses = ("PASS", "IMMEDIATE_EXIT", "TIMEOUT", "INCOMPLETE")
                if expected_status in launched_statuses:
                    protected = report.get("protected_input_snapshots")
                    if (report.get("fixture_git_init_rc") != 0
                            or not lsp_snapshot_unchanged(protected)
                            or report.get("profile_template_unchanged") is not True
                            or not lsp_snapshot_unchanged(report.get("profile_template_snapshots"))
                            or report.get("fixture_project_unchanged") is not True
                            or not lsp_snapshot_unchanged(report.get("fixture_project_snapshots"))
                            or report.get("mux_stop_rc") != 0
                            or report.get("checks", {}).get("lsp_mux_stopped") is not True
                            or report.get("temporary_workspace_removed") is not True):
                        raise ValueError("compiled LSP route did not prove bounded scoped cleanup and unchanged snapshots")
                if expected_status == "TIMEOUT":
                    timing = report.get("timeout_observation")
                    if (not isinstance(timing, dict)
                            or timing.get("source") != "LSP_TOOL_RESULT"
                            or timing.get("elapsed_scope") != "lsp_tool_call"
                            or type(timing.get("elapsed_ms")) not in (int, float)
                            or type(timing.get("deadline_ms")) not in (int, float)
                            or timing["deadline_ms"] != 60_000
                            or not 0 < timing["elapsed_ms"] <= timing["deadline_ms"] + 5_000
                            or not isinstance(timing.get("tool_result"), str)
                            or "timed out" not in timing["tool_result"].lower()
                            or report.get("timed_out") is not True):
                        raise ValueError("compiled LSP timeout lacked bounded tool-call timing evidence")
                elif report.get("timed_out") is not False or report.get("timeout_observation") is not None:
                    raise ValueError(f"compiled LSP {expected_status} carried inconsistent timeout evidence")
                return child, report

            positive_project, positive_file = lsp_project("positive")
            positive, lsp_pass = lsp_call(positive_project, positive_file, "PASS")
            positive_checks = ("lsp_tool_advertised", "only_lsp_tool_enabled", "read_only_action_arguments",
                               "all_tool_results_present", "selected_server_configured", "initialized_capabilities",
                               "known_positive_reference", "absent_symbol_control", "server_ready_after_request",
                               "profile_template_unchanged", "fixture_project_unchanged", "protected_inputs_unchanged",
                               "lsp_mux_stopped", "mock_model_clean", "process_output_complete")
            calls = lsp_pass["calls"]
            call_actions = [call.get("action") for call in calls]
            reference_call = next((call for call in calls if call.get("action") == "references"), None)
            absent_call = next((call for call in calls if call.get("action") == "symbols"), None)
            status_calls = [call for call in calls if call.get("action") == "status"]
            if (any(lsp_pass["checks"].get(key) is not True for key in positive_checks)
                    or lsp_pass["checks"].get("has_failed_checks") is not False
                    or lsp_pass["timed_out"] is not False or lsp_pass["omp_rc"] != 0
                    or len(calls) < 5 or not call_actions or call_actions[0] != "status"
                    or call_actions.count("capabilities") != 1 or len(status_calls) < 2
                    or reference_call is None or absent_call is None
                    or any(type(call.get("elapsed_ms")) not in (int, float)
                           or not 0 <= call["elapsed_ms"] <= 180_000 for call in calls)
                    or reference_call.get("symbol") != "lspProbeKnownSymbol"
                    or "Found " not in reference_call.get("result", "")
                    or not absent_call.get("query", "").startswith("LspProbeAbsentSymbol_")
                    or "No symbols matching" not in absent_call.get("result", "")
                    or lsp_pass["protected_input_snapshots"].get("unchanged") is not True
                    or lsp_pass["profile_template_unchanged"] is not True
                    or lsp_pass["fixture_project_unchanged"] is not True
                    or lsp_pass["timeout_observation"] is not None):
                raise ValueError("compiled LSP positive lacks timed known-reference, absent-symbol, or cleanup proof")
            node_executable = shutil.which("node", path=env["PATH"])
            omp_executable = shutil.which("omp", path=env["PATH"])
            if not node_executable or not omp_executable:
                raise ValueError("native LSP negative controls require the pinned Node and OMP launchers")
            missing_path, _ = lsp_runtime_path("missing")
            missing_project, missing_file = lsp_project("missing")
            missing, lsp_missing = lsp_call(missing_project, missing_file, "MISSING", missing_path)
            if lsp_missing.get("selected_command") is not None:
                raise ValueError("compiled LSP missing-binary negative selected an executable")
            wrong_project, wrong_file = lsp_project("wrong-marker", has_package=False)
            wrong, lsp_wrong = lsp_call(wrong_project, wrong_file, "WRONG_MARKER")
            if "root marker" not in lsp_wrong.get("reason", "").lower() or lsp_wrong["timed_out"]:
                raise ValueError("compiled LSP wrong-marker negative launched or misclassified the server")
            immediate_source = ("#!/bin/sh\nprintf started > \"$0.started\"\n"
                               "printf 'server exited during initialize\\n' >&2\nexit 0\n")
            immediate_path, immediate_server = lsp_runtime_path("immediate-exit", immediate_source)
            immediate_project, immediate_file = lsp_project("immediate-exit")
            immediate, lsp_exit = lsp_call(immediate_project, immediate_file, "IMMEDIATE_EXIT", immediate_path)
            if (not Path(str(immediate_server) + ".started").is_file() or lsp_exit["timed_out"]
                    or "exited" not in lsp_exit.get("reason", "").lower()):
                raise ValueError("compiled LSP immediate-exit process was not exercised and classified")
            incomplete_source = r'''#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.argv[1] + ".started", "started");
let input = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const boundary = input.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const headers = input.subarray(0, boundary).toString("ascii");
    const length = /Content-Length:\s*(\d+)/i.exec(headers);
    if (!length) process.exit(2);
    const start = boundary + 4;
    const size = Number(length[1]);
    if (input.length < start + size) return;
    const message = JSON.parse(input.subarray(start, start + size).toString("utf8"));
    input = input.subarray(start + size);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id,
        result: { capabilities: { textDocumentSync: 1, referencesProvider: true,
          workspaceSymbolProvider: true }, serverInfo: { name: "native-incomplete-lsp" } } });
    } else if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
    }
  }
});
'''
            incomplete_path, incomplete_server = lsp_runtime_path("incomplete-response", incomplete_source)
            incomplete_project, incomplete_file = lsp_project("incomplete-response")
            incomplete, lsp_incomplete = lsp_call(
                incomplete_project, incomplete_file, "INCOMPLETE", incomplete_path)
            incomplete_checks = lsp_incomplete.get("checks", {})
            incomplete_calls = lsp_incomplete.get("calls", [])
            if (not Path(str(incomplete_server) + ".started").is_file()
                    or incomplete_checks.get("lsp_tool_advertised") is not True
                    or incomplete_checks.get("all_tool_results_present") is not True
                    or incomplete_checks.get("server_ready_after_request") is not True
                    or incomplete_checks.get("initialized_capabilities") is not True
                    or incomplete_checks.get("known_positive_reference") is not False
                    or incomplete_checks.get("absent_symbol_control") is not True
                    or incomplete_checks.get("has_failed_checks") is not True
                    or len(incomplete_calls) != 5
                    or incomplete_calls[1].get("action") != "capabilities"
                    or not incomplete_calls[1].get("result")):
                raise ValueError("compiled LSP incomplete negative did not isolate a missing positive reference with healthy capabilities")
            pending_source = r'''#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.argv[1] + ".started", "started");
let input = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const boundary = input.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const headers = input.subarray(0, boundary).toString("ascii");
    const length = /Content-Length:\s*(\d+)/i.exec(headers);
    if (!length) process.exit(2);
    const start = boundary + 4;
    const size = Number(length[1]);
    if (input.length < start + size) return;
    const message = JSON.parse(input.subarray(start, start + size).toString("utf8"));
    input = input.subarray(start + size);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id,
        result: { capabilities: { textDocumentSync: 1, referencesProvider: true,
          workspaceSymbolProvider: true }, serverInfo: { name: "native-pending-reference-lsp" } } });
    } else if (message.method === "textDocument/references") {
      // Withhold only this response to exercise the bounded OMP tool-call deadline.
    } else if (message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: null });
    } else if (message.method === "exit") {
      process.exit(0);
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: [] });
    }
  }
});
'''
            pending_path, pending_server = lsp_runtime_path("pending-reference", pending_source)
            pending_project, pending_file = lsp_project("pending-reference")
            pending, lsp_timeout = lsp_call(pending_project, pending_file, "TIMEOUT", pending_path)
            timeout_checks = lsp_timeout.get("checks", {})
            if (not Path(str(pending_server) + ".started").is_file()
                    or lsp_timeout["timed_out"] is not True
                    or "bounded timeout" not in lsp_timeout.get("reason", "").lower()
                    or timeout_checks.get("initialized_capabilities") is not True
                    or timeout_checks.get("known_positive_reference") is not False
                    or timeout_checks.get("absent_symbol_control") is not True
                    or timeout_checks.get("server_ready_after_request") is not True):
                raise ValueError("compiled LSP reference-only timeout was not exercised with healthy capabilities and an answered absent-symbol control")
            workspace, _ = lsp_project("untrusted-parent-workspace")
            if any((ancestor / ".git").exists() for ancestor in (workspace, *workspace.parents)):
                raise ValueError("non-Git workspace negative has an unrelated Git rejection precondition")
            application = workspace / "packages" / "app"
            application.mkdir(parents=True)
            (application / "package.json").write_text("{\"private\":true}\n", encoding="utf-8")
            application_file = application / "example.ts"
            application_file.write_text("export const value = 1;\n", encoding="utf-8")
            dependency_bin = workspace / "node_modules" / ".bin"
            dependency_bin.mkdir(parents=True)
            workspace_server = dependency_bin / "typescript-language-server"
            workspace_server.write_text(incomplete_source, encoding="utf-8")
            workspace_server.chmod(0o700)
            workspace_before = isolated_snapshot(workspace)
            untrusted, lsp_untrusted = lsp_call(application, application_file, "UNVERIFIED",
                                              str(dependency_bin) + os.pathsep + env["PATH"])
            selected = next((server for server in json.loads(untrusted.stdout)["data"]["report"]["servers"]
                             if server.get("name") == "typescript-language-server"), None)
            if (not selected or selected.get("eligible") is not True
                    or selected.get("resolved_command") != str(workspace_server)
                    or lsp_untrusted.get("omp_rc") is not None or lsp_untrusted.get("calls") != []
                    or Path(str(workspace_server) + ".started").exists()
                    or isolated_snapshot(workspace) != workspace_before):
                raise ValueError("compiled LSP executed or mutated a non-Git parent workspace dependency")
            receipt["proofs"]["lsp_deep"] = {
                "status": "PASS",
                "stdout_sha256": hashlib.sha256(
                    positive.stdout + missing.stdout + wrong.stdout + immediate.stdout
                    + incomplete.stdout + pending.stdout + untrusted.stdout).hexdigest()}
            # The configured profile is synthetic; never test a real private memory store.
            (agent / "config.yml").write_text("memory:\n  backend: mnemopi\nmnemopi:\n  llmMode: none\n  noEmbeddings: true\n", encoding="utf-8")
            before = isolated_snapshot(home, project)
            check = subprocess.run([str(binary), "doctor", "--scope", "memory", "--json"],
                                   cwd=root, env=env, capture_output=True, timeout=120)
            if isolated_snapshot(home, project) != before:
                raise ValueError("synthetic memory inspection changed the isolated HOME or project")
            if check.returncode != 0:
                raise ValueError("synthetic memory readiness refused")
            warning_result = json.loads(check.stdout)
            if warning_result.get("ok") is not True:
                raise ValueError("synthetic memory inventory did not succeed")
            warning = warning_result["data"]
            evidence = finding(warning, "memory")["evidence"]
            if (evidence["backend"] != "mnemopi" or evidence["configured"] is not True
                    or evidence["runtime"] != "NOT_PROBED"
                    or evidence["redactor"]["coverage"] != "SYNTHETIC_ONLY"
                    or "pem_private_key" not in evidence["redactor"]["missed"]):
                raise ValueError("synthetic redactor limitation was not reported")
            receipt["proofs"]["redactor_warning"] = {"status": "PASS", "stdout_sha256": hashlib.sha256(check.stdout).hexdigest()}
            omp_launcher = shutil.which("omp", path=env["PATH"])
            bun = shutil.which("bun", path=env["PATH"])
            if not omp_launcher or not bun:
                raise ValueError("pinned OMP or Bun is unavailable for the synthetic memory audit")
            agent_root = Path(omp_launcher).resolve().parent.parent
            mnemopi_root = next((base / "node_modules" / "@oh-my-pi" / "pi-mnemopi"
                                 for base in (agent_root, *agent_root.parents)
                                 if (base / "node_modules" / "@oh-my-pi" / "pi-mnemopi" / "package.json").is_file()), None)
            if mnemopi_root is None:
                raise ValueError("pinned Mnemopi dependency is unavailable from the installed OMP package")
            schema = mnemopi_root / "src" / "core" / "beam" / "schema.ts"
            agent_metadata = load(agent_root / "package.json")
            mnemopi_metadata = load(mnemopi_root / "package.json")
            if (agent_metadata.get("name") != "@oh-my-pi/pi-coding-agent"
                    or agent_metadata.get("version") != omp_version
                    or mnemopi_metadata.get("name") != "@oh-my-pi/pi-mnemopi"
                    or mnemopi_metadata.get("version") != omp_version
                    or digest(schema) != "95490e3c2b7e4325cde97fadf3572d76f11e28491e24574b27ff885171058ed0"):
                raise ValueError("native synthetic memory fixture is not using the pinned stock initBeam schema")
            store_root = home / ".omp" / "agent" / "memories" / "mnemopi"
            seed = r'''
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const { initBeam } = await import(pathToFileURL(process.env.P29_SCHEMA).href);
if (typeof initBeam !== "function") throw new Error("initBeam unavailable");
const pem = ["-----BEGIN ", "PRIVATE KEY-----\n", "syntheticprivatekeymaterialnotvalid", "\n-----END PRIVATE KEY-----"].join("");
const banks = [
  ["default", ["public note", "Bearer syntheticbearerlettersonlyforevertoken"], [pem]],
  ["project_A", [["password", "=", "syntheticlettersforpasswordvalue"].join("")], ["postgres://syntheticuser:syntheticpassword@invalid.example/test"]],
];
for (const [name, working, episodic] of banks) {
  const path = name === "default" ? `${process.env.P29_STORE}/mnemopi.db` : `${process.env.P29_STORE}/banks/${name}/mnemopi.db`;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    initBeam(db);
    for (const [index, content] of working.entries()) db.run("INSERT INTO working_memory (id, content) VALUES (?, ?)", [`w-${index}`, content]);
    for (const [index, content] of episodic.entries()) db.run("INSERT INTO episodic_memory (id, content) VALUES (?, ?)", [`e-${index}`, content]);
  } finally { db.close(); }
}
'''
            seeded = subprocess.run([bun, "-e", seed], cwd=root,
                                    env={**env, "P29_SCHEMA": str(schema), "P29_STORE": str(store_root)},
                                    capture_output=True, timeout=120)
            if seeded.returncode != 0:
                raise ValueError("native initBeam synthetic Mnemopi stores could not be created")
            audit_env = {**env, "TMPDIR": str(root)}
            audit_args = [str(binary), "memory", "audit", "--store-root", str(store_root), "--json"]
            canaries = ("Bearer syntheticbearerlettersonlyforevertoken", "syntheticprivatekeymaterialnotvalid",
                        "syntheticlettersforpasswordvalue", "syntheticpassword", str(root),
                        str(home), str(project), str(store_root))

            def audit_call(flags):
                before = isolated_snapshot(home, project)
                child = subprocess.run([*audit_args[:-1], *flags, "--json"], cwd=project, env=audit_env,
                                       capture_output=True, timeout=120)
                if isolated_snapshot(home, project) != before:
                    raise ValueError("compiled memory audit changed synthetic HOME, project, or store inputs")
                output = child.stdout + child.stderr
                text = output.decode(errors="replace")
                if any(canary in text for canary in canaries):
                    raise ValueError("compiled memory audit leaked synthetic row content or protected paths")
                try:
                    result = json.loads(child.stdout)
                except json.JSONDecodeError as error:
                    raise ValueError("compiled memory audit returned invalid JSON") from error
                return child, result

            refused, refusal = audit_call([])
            if refused.returncode != 2 or not refusal.get("errors") or refusal["errors"][0].get("code") != "CONSENT_REQUIRED":
                raise ValueError("compiled memory audit did not refuse without separate consent")
            covered, match = audit_call(["--yes"])
            audit = match.get("data", {}).get("audit", {})
            if (covered.returncode != 1 or audit.get("status") != "MATCHES"
                    or audit.get("reason") != "COVERED_CONTENT_ONLY" or audit.get("version") != omp_version
                    or audit.get("coverage") != {
                        "banks_discovered": 2, "banks_scanned": 2, "stores_discovered": 2, "stores_scanned": 2,
                        "working_rows": 3, "episodic_rows": 2, "total_rows": 5,
                        "fields": ["working_memory.content", "episodic_memory.content"]}
                    or audit.get("categories") != {
                        "provider_token": 0, "bearer_token": 1, "private_key": 1,
                        "password_assignment": 1, "credential_url": 1}):
                raise ValueError("compiled memory audit missed the pinned two-bank exact-count canary")
            (store_root / "banks" / "project_A" / "mnemopi.db-wal").write_text(
                "synthetic pending WAL bytes", encoding="utf-8")
            active_wal, wal = audit_call(["--yes"])
            wal_audit = wal.get("data", {}).get("audit", {})
            if (active_wal.returncode != 3 or wal_audit.get("status") != "UNVERIFIED"
                    or wal_audit.get("reason") != "UNSAFE_STORE" or wal_audit.get("coverage") is not None):
                raise ValueError("compiled memory audit did not refuse the synthetic active-WAL store")
            receipt["proofs"]["memory_audit"] = {
                "status": "PASS",
                "stdout_sha256": hashlib.sha256(refused.stdout + covered.stdout + active_wal.stdout).hexdigest()}
            receipt["certified"] = True
    except (AttributeError, KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        receipt["failure"] = str(error)
    save(out, receipt)
    print(f"native candidate {args.platform}: {'CERTIFIED' if receipt['certified'] else 'REFUSED'}")
    if not receipt["certified"]:
        print(receipt["failure"], file=sys.stderr)
        if "refusal_detail" in receipt:
            print(json.dumps(receipt["refusal_detail"], indent=1), file=sys.stderr)
        return 1
    return 0


def certified_omp_versions(args, platform, asset, required_omp_versions, required_proofs):
    versions = {}
    for track, expected_omp_version in required_omp_versions.items():
        receipt_path = Path(args.receipts) / (f"native-receipt-{platform}-{track}") / "receipt.json"
        if not receipt_path.is_file():
            return None
        proof = load(receipt_path)
        identity_matches = (proof.get("schema_version") == 1 and proof.get("version") == args.version
                            and proof.get("source_sha") == args.source_sha and proof.get("platform") == platform
                            and proof.get("asset") == asset and proof.get("omp_track") == track
                            and proof.get("requested_omp_version") == expected_omp_version)
        if proof.get("certified") is False:
            if not identity_matches:
                raise ValueError(
                    "detached native refusal disagrees with archive, source, or OMP track: " + platform + "/" + track
                )
            return None
        if (not identity_matches or proof.get("certified") is not True
                or proof.get("omp_version") != expected_omp_version or "failure" in proof
                or set(proof.get("proofs", {})) != required_proofs
                or any(set(item) != {"status", "stdout_sha256"} or item["status"] != "PASS"
                       or not isinstance(item["stdout_sha256"], str)
                       or re.fullmatch("[0-9a-f]{64}", item["stdout_sha256"]) is None
                       for item in proof["proofs"].values())):
            raise ValueError(
                "detached native proof disagrees with archive, source, or OMP track: " + platform + "/" + track
            )
        versions[track] = expected_omp_version
    return versions


def candidate(args):
    version = args.version
    source = args.source_sha
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version) or not re.fullmatch("[0-9a-f]{40}", source):
        raise ValueError("candidate identity invalid")
    required_omp_versions = load_omp_versions()
    minimum = required_omp_versions["minimum"]
    certified_omp = required_omp_versions["certified"]
    verified_source(source)
    assets, certified, platform_omp_versions = {}, [], {}
    required_proofs = {"status", "doctor", "fast", "full", "lsp", "lsp_setup", "memory", "memory_off",
                       "mnemopi_manual", "model_roles", "mcp", "mcp_readiness", "project_preflight", "lsp_deep",
                       "memory_audit", "redactor_warning"}
    for platform in PLATFORMS:
        asset_dir = Path(args.assets) / ("candidate-" + platform)
        asset_path = asset_dir / "asset.json"
        if not asset_path.is_file():
            raise ValueError("candidate build missing: " + platform)
        asset = asset_for(asset_path, platform, version, asset_dir)
        versions = certified_omp_versions(args, platform, asset, required_omp_versions, required_proofs)
        if versions is None:
            continue
        assets[platform] = asset
        certified.append(platform)
        platform_omp_versions[platform] = versions
    if not certified:
        raise ValueError(
            "no native-certified platform has both required OMP versions "
            f"(minimum={minimum}, certified={certified_omp}): refusing an empty release candidate"
        )
    save(Path(args.out) / "release-index.json", {"schema_version": 1, "version": version,
                                                  "source_tag": "v" + version, "assets": assets})
    save(Path(args.out) / "candidate-proof.json", {"schema_version": 1, "source_sha": source,
                                                    "version": version, "certified_platforms": certified,
                                                    "omp_versions": required_omp_versions,
                                                    "platform_omp_versions": platform_omp_versions,
                                                    "publication": "NOT_AUTHORIZED"})
    print(
        f"unpublished candidate index (OMP minimum={minimum}, certified={certified_omp}): " + ", ".join(certified)
    )
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    native_parser = commands.add_parser("native")
    for name in ("version", "platform", "asset", "archive-dir", "source-sha", "out"):
        native_parser.add_argument("--" + name, required=True)
    native_parser.add_argument("--omp-version", required=True)
    native_parser.add_argument("--omp-track", choices=("minimum", "certified"), required=True)
    candidate_parser = commands.add_parser("candidate")
    for name in ("version", "source-sha", "assets", "receipts", "out"):
        candidate_parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        return native(args) if args.command == "native" else candidate(args)
    except (AttributeError, KeyError, ValueError, OSError, TypeError) as error:
        print("native-candidate: refused: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
