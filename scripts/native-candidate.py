#!/usr/bin/env python3
"""Certify a provisional archive on its native runner; never publish from CI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

PLATFORMS = ("darwin-arm64-none", "darwin-x64-none", "linux-arm64-gnu", "linux-x64-gnu")
OMP_VERSION = "18.4.2"


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


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


def native(args):
    if args.platform not in PLATFORMS or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
        raise ValueError("unsupported native candidate")
    if not re.fullmatch("[0-9a-f]{40}", args.source_sha):
        raise ValueError("source commit must be a full Git SHA-1")
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
               "platform": args.platform, "asset": asset, "omp_version": None,
               "proofs": {}, "certified": False}
    out = Path(args.out)
    try:
        with tempfile.TemporaryDirectory(prefix="omp-kit-native-") as temp:
            root = Path(temp).resolve()
            home = root / "home"
            home.mkdir()
            env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(root), "CI": "true",
                   "NO_COLOR": "1", "XDG_STATE_HOME": str(home / "state"),
                   "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data")}
            omp = subprocess.run(["omp", "--version"], cwd=root, env=env, capture_output=True, timeout=30)
            observed = (omp.stdout + omp.stderr).decode(errors="replace").strip()
            if omp.returncode != 0 or not re.search(r"(?<!\d)" + re.escape(OMP_VERSION) + r"(?!\d)", observed):
                raise ValueError("stock OMP version differs from the pinned native test version")
            receipt["omp_version"] = OMP_VERSION
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
                    raise ValueError(f"native {name} refused rc={child.returncode}")
                result = json.loads(child.stdout)
                if result.get("ok") is not True:
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
                            or omp_identity["version"] != OMP_VERSION
                            or omp_identity["version_proof"] != "PACKAGE_METADATA"
                            or any(finding(data, component)["status"] != "OK" for component in ("kit", "manifest", "omp"))):
                        raise ValueError(f"native {name} did not identify the installed release and stock OMP")
                elif name in ("fast", "full"):
                    test = data["test"]
                    fast_report = test["fast"] if name == "full" else test
                    fast = fast_report["proofs"]
                    if fast_report["status"] != "PASS":
                        raise ValueError(f"native {name} fast matcher did not pass")
                    for gate, observed_count in (("G1_registration", "observed_rules"),
                                                 ("G2_payload", "observed_cases"), ("G3_quiet_prefix", "quiet_prefix_fires")):
                        proof = fast[gate]
                        if proof["status"] != "PASS" or proof[observed_count] != (0 if gate == "G3_quiet_prefix" else 18 if gate == "G1_registration" else 274):
                            raise ValueError(f"native {name} {gate} is not the pinned passing corpus")
                    live = test["proofs"]["G4_live"] if name == "full" else fast["G4_live"]
                    if live["status"] != ("PASS" if name == "full" else "NOT_RUN"):
                        raise ValueError(f"native {name} live class differs from expected proof")
                    if name == "full":
                        scenarios = test["live_scenarios"]
                        snapshots = test["snapshots"]
                        if (test["status"] != "PASS" or test["proof_scope"] != "ISOLATED_FIXTURE_ONLY"
                                or test["omp_version"] != OMP_VERSION or live["plant"] != "PASS"
                                or live["expected_scenarios"] != 69 or live["observed_scenarios"] != 69
                                or scenarios["status"] != "PASS"
                                or len(scenarios["expected_ids"]) != 69
                                or len(set(scenarios["expected_ids"])) != 69
                                or scenarios["observed_ids"] != scenarios["expected_ids"]
                                or any(snapshots[part]["complete"] is not True or snapshots[part]["unchanged"] is not True
                                       for part in ("release", "home"))):
                            raise ValueError("native full ladder lacks 69 live scenarios, planted control, stock OMP, or complete unchanged release/HOME snapshots")
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
            receipt["certified"] = True
    except (AttributeError, KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        receipt["failure"] = str(error)
    save(out, receipt)
    print(f"native candidate {args.platform}: {'CERTIFIED' if receipt['certified'] else 'REFUSED'}")
    if not receipt["certified"]:
        print(receipt["failure"], file=sys.stderr)
        return 1
    return 0


def candidate(args):
    version = args.version
    source = args.source_sha
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version) or not re.fullmatch("[0-9a-f]{40}", source):
        raise ValueError("candidate identity invalid")
    verified_source(source)
    assets, certified = {}, []
    for platform in PLATFORMS:
        asset_dir = Path(args.assets) / ("candidate-" + platform)
        asset_path = asset_dir / "asset.json"
        if not asset_path.is_file():
            raise ValueError("candidate build missing: " + platform)
        asset = asset_for(asset_path, platform, version, asset_dir)
        receipt_path = Path(args.receipts) / ("native-receipt-" + platform) / "receipt.json"
        if not receipt_path.is_file():
            continue  # Missing or failing native runner never becomes advertised support.
        proof = load(receipt_path)
        if proof.get("certified") is False:
            # A native refusal excludes this target; it cannot turn another target's proof GREEN.
            if (proof.get("schema_version") != 1 or proof.get("version") != version
                    or proof.get("source_sha") != source or proof.get("platform") != platform
                    or proof.get("asset") != asset):
                raise ValueError("detached native refusal disagrees with archive or source: " + platform)
            continue
        if (proof.get("certified") is not True or proof.get("schema_version") != 1
                or proof.get("version") != version or proof.get("source_sha") != source
                or proof.get("platform") != platform or proof.get("asset") != asset
                or proof.get("omp_version") != OMP_VERSION or "failure" in proof
                or set(proof.get("proofs", {})) != {"status", "doctor", "fast", "full", "lsp", "lsp_setup", "memory",
                                                "memory_off", "mnemopi_manual", "model_roles", "mcp", "mcp_readiness",
                                                "project_preflight", "redactor_warning"}
                or any(set(item) != {"status", "stdout_sha256"} or item["status"] != "PASS"
                       or not isinstance(item["stdout_sha256"], str)
                       or re.fullmatch("[0-9a-f]{64}", item["stdout_sha256"]) is None
                       for item in proof["proofs"].values())):
            raise ValueError("detached native proof disagrees with archive or source: " + platform)
        assets[platform] = asset
        certified.append(platform)
    if not certified:
        raise ValueError("no native-certified platform: refusing an empty release candidate")
    save(Path(args.out) / "release-index.json", {"schema_version": 1, "version": version,
                                                  "source_tag": "v" + version, "assets": assets})
    save(Path(args.out) / "candidate-proof.json", {"schema_version": 1, "source_sha": source,
                                                    "version": version, "certified_platforms": certified,
                                                    "publication": "NOT_AUTHORIZED"})
    print("unpublished candidate index: " + ", ".join(certified))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    native_parser = commands.add_parser("native")
    for name in ("version", "platform", "asset", "archive-dir", "source-sha", "out"):
        native_parser.add_argument("--" + name, required=True)
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
