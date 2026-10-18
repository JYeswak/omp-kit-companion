#!/usr/bin/env python3
"""Exercise candidate indexing with detached minimum/certified OMP receipts."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "native-candidate.py"
with (ROOT / "scripts" / "omp-compat.json").open(encoding="utf-8") as source:
    COMPAT = json.load(source)
MINIMUM = COMPAT["minimum"]
CERTIFIED = COMPAT["certified"]
PLATFORMS = ("darwin-arm64-none", "darwin-x64-none", "linux-arm64-gnu", "linux-x64-gnu")
RELEASE_PLATFORMS = ("darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu")
PROOF_NAMES = {
    "status", "doctor", "fast", "full", "lsp", "lsp_setup", "memory", "memory_off",
    "mnemopi_manual", "model_roles", "mcp", "mcp_readiness", "project_preflight", "lsp_deep",
    "memory_audit", "redactor_warning",
}

spec = importlib.util.spec_from_file_location("native_candidate", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
native_candidate = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(native_candidate)


# Isolate receipt aggregation from the production CLI's clean-checkout precondition.
def allow_test_source(source_sha: str) -> None:
    if len(source_sha) != 40:
        raise AssertionError("candidate did not preserve the source SHA shape")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class CandidateReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = ROOT / "var" / "agent-tmp"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="native-candidate-test-", dir=scratch)
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.receipts = self.root / "receipts"
        self.version = "1.2.3"
        self.source_sha = "a" * 40
        self.asset_by_platform = {}
        self.producer = {
            "repository": "JYeswak/omp-kit-companion",
            "workflow_ref": "JYeswak/omp-kit-companion/.github/workflows/release.yml@refs/heads/main",
            "run_id": "1234",
            "run_attempt": "1",
        }
        environment = unittest.mock.patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": self.producer["repository"],
            "GITHUB_WORKFLOW_REF": self.producer["workflow_ref"],
            "GITHUB_RUN_ID": self.producer["run_id"],
            "GITHUB_RUN_ATTEMPT": self.producer["run_attempt"],
        })
        environment.start()
        self.addCleanup(environment.stop)
        source_check = unittest.mock.patch.object(native_candidate, "verified_source", allow_test_source)
        source_check.start()
        self.addCleanup(source_check.stop)
        self._write_assets()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_assets(self) -> None:
        for platform in PLATFORMS:
            os_name, arch, libc = platform.split("-")
            directory = self.assets / ("candidate-" + platform)
            filename = f"omp-kit-v{self.version}-{platform}.tar"
            archive = ("fixture archive " + platform).encode()
            (directory / filename).parent.mkdir(parents=True, exist_ok=True)
            (directory / filename).write_bytes(archive)
            asset = {
                "os": os_name,
                "arch": arch,
                "libc": libc,
                "filename": filename,
                "sha256": hashlib.sha256(archive).hexdigest(),
                "manifest_sha256": "b" * 64,
            }
            write_json(directory / "asset.json", asset)
            self.asset_by_platform[platform] = asset

    def _write_receipts(self, tracks=("minimum", "certified"), omit=None) -> None:
        for platform in PLATFORMS:
            for track in tracks:
                if omit == (platform, track):
                    continue
                receipt = {
                    "schema_version": 1,
                    "version": self.version,
                    "source_sha": self.source_sha,
                    "platform": platform,
                    "asset": self.asset_by_platform[platform],
                    "omp_track": track,
                    "requested_omp_version": MINIMUM if track == "minimum" else CERTIFIED,
                    "omp_version": MINIMUM if track == "minimum" else CERTIFIED,
                    "archive_staging": {
                        "schema_version": 1,
                        "scope": "source-workflow-integrity",
                        "source_sha": self.source_sha,
                        "archive_sha256": self.asset_by_platform[platform]["sha256"],
                        "manifest_sha256": self.asset_by_platform[platform]["manifest_sha256"],
                        "producer": self.producer,
                        "public_installation": "NOT_VERIFIED",
                    },
                    "proofs": {
                        name: {
                            "status": "PASS", "stdout_sha256": "c" * 64,
                            **({"stage_durations_ms": {"manifest": 1}} if name == "full" else {}),
                        }
                        for name in PROOF_NAMES
                    },
                    "certified": True,
                }
                write_json(
                    self.receipts / f"native-receipt-{platform}-{track}" / "receipt.json",
                    receipt,
                )

    def _args(self):
        return types.SimpleNamespace(
            version=self.version,
            source_sha=self.source_sha,
            assets=str(self.assets),
            receipts=str(self.receipts),
            out=str(self.root / "out"),
        )

    def test_candidate_records_both_versions_for_each_certified_platform(self) -> None:
        self._write_receipts()

        self.assertEqual(native_candidate.candidate(self._args()), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertEqual(set(release_index["assets"]), set(PLATFORMS))
        self.assertEqual(proof["omp_versions"], {"minimum": MINIMUM, "certified": CERTIFIED})
        self.assertEqual(proof["certified_platforms"], list(PLATFORMS))
        self.assertEqual(
            proof["platform_omp_versions"],
            {platform: {"minimum": MINIMUM, "certified": CERTIFIED} for platform in PLATFORMS},
        )

    def test_staging_cannot_claim_public_installation(self) -> None:
        self._write_receipts()
        path = self.receipts / f"native-receipt-{PLATFORMS[0]}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["archive_staging"]["public_installation"] = "VERIFIED"
        write_json(path, receipt)
        with self.assertRaises(ValueError):
            native_candidate.candidate(self._args())
        self.assertFalse((self.root / "out" / "release-index.json").exists())

    def test_staging_from_another_native_run_is_rejected(self) -> None:
        self._write_receipts()
        path = self.receipts / f"native-receipt-{PLATFORMS[0]}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["archive_staging"]["producer"]["run_id"] = "9999"
        write_json(path, receipt)
        with self.assertRaises(ValueError):
            native_candidate.candidate(self._args())
        self.assertFalse((self.root / "out" / "release-index.json").exists())

    def test_candidate_refuses_when_minimum_receipts_are_missing(self) -> None:
        self._write_receipts(tracks=("certified",))

        with self.assertRaisesRegex(ValueError, f"minimum={MINIMUM}"):
            native_candidate.candidate(self._args())

    def test_candidate_refuses_when_certified_receipts_are_missing(self) -> None:
        self._write_receipts(tracks=("minimum",))

        with self.assertRaisesRegex(ValueError, f"certified={CERTIFIED}"):
            native_candidate.candidate(self._args())

    def test_full_receipt_with_telemetry_error_and_no_durations_is_accepted(self) -> None:
        self._write_receipts()
        platform = PLATFORMS[0]
        path = self.receipts / f"native-receipt-{platform}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        del receipt["proofs"]["full"]["stage_durations_ms"]
        receipt["telemetry_error"] = "native full report omitted stage-start marker(s)"
        write_json(path, receipt)

        self.assertEqual(
            native_candidate.certified_omp_versions(
                self._args(), platform, self.asset_by_platform[platform],
                {"minimum": MINIMUM}, PROOF_NAMES),
            {"minimum": MINIMUM})

    def test_full_receipt_with_invalid_stage_durations_is_rejected(self) -> None:
        self._write_receipts()
        platform = PLATFORMS[0]
        path = self.receipts / f"native-receipt-{platform}-minimum" / "receipt.json"
        receipt = json.loads(path.read_text(encoding="utf-8"))
        receipt["proofs"]["full"]["stage_durations_ms"] = {"manifest": -1}
        write_json(path, receipt)

        with self.assertRaisesRegex(ValueError, "detached native proof"):
            native_candidate.certified_omp_versions(
                self._args(), platform, self.asset_by_platform[platform],
                {"minimum": MINIMUM}, PROOF_NAMES)

    def test_incomplete_platform_is_not_advertised_when_other_platforms_have_both_versions(self) -> None:
        incomplete = PLATFORMS[0]
        self._write_receipts(omit=(incomplete, "certified"))

        self.assertEqual(native_candidate.candidate(self._args()), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertNotIn(incomplete, release_index["assets"])
        self.assertNotIn(incomplete, proof["platform_omp_versions"])
        self.assertEqual(set(proof["certified_platforms"]), set(PLATFORMS[1:]))

    def test_release_candidate_refuses_failing_linux_x64_ship_leg(self) -> None:
        self._write_receipts()
        receipt_path = self.receipts / "native-receipt-linux-x64-gnu-minimum" / "receipt.json"
        failed_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        failed_receipt["certified"] = False
        failed_receipt["failure"] = "planted linux-x64 minimum certification failure"
        write_json(receipt_path, failed_receipt)
        args = self._args()
        args.release = True

        with self.assertRaisesRegex(ValueError, "linux-x64-gnu"):
            native_candidate.candidate(args)

        self.assertFalse((self.root / "out" / "release-index.json").exists())
        self.assertFalse((self.root / "out" / "candidate-proof.json").exists())

    def test_release_candidate_excludes_certified_darwin_x64(self) -> None:
        self._write_receipts()
        args = self._args()
        args.release = True

        self.assertEqual(native_candidate.candidate(args), 0)
        release_index = json.loads((self.root / "out" / "release-index.json").read_text(encoding="utf-8"))
        proof = json.loads((self.root / "out" / "candidate-proof.json").read_text(encoding="utf-8"))

        self.assertEqual(set(release_index["assets"]), set(RELEASE_PLATFORMS))
        self.assertEqual(proof["certified_platforms"], list(RELEASE_PLATFORMS))

    def test_refusal_detail_names_failing_stage_and_scenarios(self) -> None:
        payload = {
            "data": {"test": {
                "status": "FAIL",
                "stages": {"fast": {"status": "PASS"}, "full": {"status": "FAIL"}},
                "failures": ["G4 live scenario planted-fail"],
                "live_scenarios": {"expected_ids": ["planted-fail", "planted-pass"], "observed_ids": ["planted-pass"]},
            }},
            "errors": [{"code": "LIVE_FAIL", "message": "planted-fail refused"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(payload).encode(), stderr=b"tail")
        detail = native_candidate.refusal_detail("test --full", child)
        self.assertEqual(detail["command"], "test --full")
        self.assertEqual(detail["rc"], 1)
        self.assertEqual(detail["failed_stages"], ["full"])
        self.assertIn("G4 live scenario planted-fail", detail["failures"])
        self.assertEqual(detail["missing_scenarios"], ["planted-fail"])

    def test_refusal_detail_keeps_failing_stage_producer_tail_only_on_failure(self) -> None:
        failing = self._failing_full(
            "e2e-live", "x" * 6000 + "coverage producer_rc=2\nRED   e2e-live producer_rc=2",
            "e" * 3000 + "launcher boom")
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(failing).encode(), stderr=b"tail")
        detail = native_candidate.refusal_detail("test --full", child)
        self.assertTrue(detail["producer_stdout_tail"].endswith("RED   e2e-live producer_rc=2"))
        self.assertIn("coverage producer_rc=2", detail["producer_stdout_tail"])
        self.assertTrue(detail["producer_stderr_tail"].endswith("launcher boom"))
        self.assertLessEqual(len(detail["producer_stdout_tail"]), 2500)
        self.assertLessEqual(len(detail["producer_stderr_tail"]), 1000)
        passing = self._failing_full("e2e-live", "private failing output")
        passing["data"]["test"]["stages"]["e2e-live"]["status"] = "PASS"
        detail = native_candidate.refusal_detail("test --full", types.SimpleNamespace(returncode=1, stdout=json.dumps(passing).encode(), stderr=b"tail"))
        self.assertNotIn("producer_stdout_tail", detail)
        self.assertNotIn("producer_stderr_tail", detail)

    def test_refusal_detail_attaches_probe_tail_on_failing_deep_probe(self) -> None:
        payload = {
            "data": {"deep_probe": {
                "checks": {"lsp_ok": True, "hover": False, "references": False},
                "timeout_observation": "hover exceeded 5000 ms",
                "json_rpc_trace": [{"id": n} for n in range(12)],
            }},
            "errors": [{"code": "LSP_INCOMPLETE", "message": "planted probe failure"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(payload).encode(), stderr=b"tail")
        detail = native_candidate.refusal_detail("lsp-deep", child)
        self.assertEqual(detail["probe_tail"]["failed_checks"], ["hover", "references"])
        self.assertEqual(detail["probe_tail"]["timeout_observation"], "hover exceeded 5000 ms")
        self.assertEqual(detail["probe_tail"]["json_rpc_trace"], [{"id": n} for n in range(4, 12)])

    def test_refusal_detail_omits_probe_tail_when_probe_clean_or_absent(self) -> None:
        clean = {
            "data": {"deep_probe": {"checks": {"lsp_ok": True}, "json_rpc_trace": []}},
            "errors": [{"code": "OTHER", "message": "planted"}],
        }
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(clean).encode(), stderr=b"tail")
        self.assertNotIn("probe_tail", native_candidate.refusal_detail("lsp-deep", child))
        absent = {"data": {}, "errors": [{"code": "OTHER", "message": "planted"}]}
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(absent).encode(), stderr=b"tail")
        self.assertNotIn("probe_tail", native_candidate.refusal_detail("lsp-deep", child))

    @staticmethod
    def _failing_full(stage: str, stdout: str, stderr: str = "") -> dict:
        return {"data": {"test": {
            "status": "FAIL", "stages": {"manifest": {"status": "PASS"}, stage: {
                "status": "FAIL", "output": {
                    "stdout_chars": len(stdout),
                    **({"stdout_head": stdout} if len(stdout) > 2500 else {}),
                    "stdout_tail": stdout, "stderr_tail": stderr}}},
            "failures": [f"Stage {stage} returned producer_rc=1"], "live_scenarios": {"expected_ids": [], "observed_ids": []},
            "producer": {"producer_rc": 1, "stdout": "bounded ladder tail is not the failing-stage verdict", "stderr": ""}}}, "errors": []}

    def test_refusal_detail_keeps_the_head_of_oversized_stage_output_where_the_verdict_is(self) -> None:
        # regex-budget prints its verdict first and then one 800 KB JSON line: the tail alone can never name the cause.
        verdict = "REGEX-BUDGET: FAIL\nlive stream: FAIL file=x total=600.0ms / 500ms\n"
        stdout = verdict + "JSON_REPORT=" + "x" * 800_000
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(self._failing_full("regex-budget", stdout)).encode(), stderr=b"")
        detail = native_candidate.refusal_detail("test --full", child)
        self.assertTrue(detail["producer_stdout_head"].startswith(verdict))
        self.assertEqual(detail["producer_stdout_chars"], len(stdout))
        self.assertEqual(detail["producer_stdout_tail"], stdout[-2500:])
        retained = sum(len(detail[key]) for key in ("producer_stdout_head", "producer_stdout_tail"))
        self.assertLessEqual(retained, 5000)
        # Output the tail already holds in full gets no head; a passing stage gets no producer text at all.
        short = "RED   regex-budget producer_rc=1"
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(self._failing_full("regex-budget", short)).encode(), stderr=b"")
        shortened = native_candidate.refusal_detail("test --full", child)
        self.assertNotIn("producer_stdout_head", shortened)
        self.assertEqual(shortened["producer_stdout_tail"], short)
        passing = self._failing_full("regex-budget", stdout)
        passing["data"]["test"]["stages"]["regex-budget"] = {"status": "PASS"}
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(passing).encode(), stderr=b"")
        clean = native_candidate.refusal_detail("test --full", child)
        for key in ("producer_stdout_head", "producer_stdout_tail", "producer_stdout_chars"):
            self.assertNotIn(key, clean)


    def test_refusal_detail_reports_measured_stage_durations_including_the_failing_stage(self) -> None:
        stderr = (b"OMP_KIT_STAGE_START name=manifest started_at_ms=1000\n"
                  b"OMP_KIT_STAGE_START name=regex-budget started_at_ms=1500\nnoise\n")
        child = types.SimpleNamespace(returncode=1, stdout=json.dumps(self._failing_full("regex-budget", "RED")).encode(), stderr=stderr)
        detail = native_candidate.refusal_detail("test --full", child, finished_at_ms=3500)
        self.assertEqual(detail["stage_durations_ms"], {"manifest": 500, "regex-budget": 2000})
        self.assertEqual(detail["failed_stage_durations_ms"], {"regex-budget": 2000})
        # No marker or no finish time means no invented timing; a repeated marker keeps the first.
        bare = types.SimpleNamespace(returncode=1, stdout=child.stdout, stderr=b"tail")
        self.assertNotIn("stage_durations_ms", native_candidate.refusal_detail("test --full", bare, finished_at_ms=3500))
        self.assertNotIn("stage_durations_ms", native_candidate.refusal_detail("test --full", child))
        repeated = types.SimpleNamespace(returncode=1, stdout=child.stdout, stderr=stderr + b"OMP_KIT_STAGE_START name=manifest started_at_ms=9000\n")
        self.assertEqual(native_candidate.refusal_detail("test --full", repeated, finished_at_ms=3500)["stage_durations_ms"]["manifest"], 500)
        # Bounded: a run with many stages reports at most 32.
        many = b"".join(b"OMP_KIT_STAGE_START name=s%d started_at_ms=%d\n" % (n, 1000 + n) for n in range(80))
        wide = types.SimpleNamespace(returncode=1, stdout=child.stdout, stderr=many)
        self.assertEqual(len(native_candidate.refusal_detail("test --full", wide, finished_at_ms=5000)["stage_durations_ms"]), 32)

    def test_refusal_verdict_lines_name_the_failing_stage_and_its_duration(self) -> None:
        detail = {"failed_stages": ["regex-budget"], "failed_stage_durations_ms": {"regex-budget": 2000},
                  "probe_tail": {"failed_checks": ["hover", "references"]}}
        self.assertEqual(native_candidate.refusal_verdict_lines(detail),
                         ["verdict: failing checks: hover,references", "verdict: failing stage regex-budget after 2000 ms"])
        self.assertEqual(native_candidate.refusal_verdict_lines({"failed_stages": ["e2e-live"]}), ["verdict: failing stage e2e-live"])
        self.assertEqual(native_candidate.refusal_verdict_lines({}), [])
        self.assertEqual(native_candidate.refusal_verdict_lines(None), [])




class CertEnvTests(unittest.TestCase):
    """RELEASE BLOCKER A2: the CI-judge signal must survive the scrubbed env."""

    def test_github_actions_passes_through_when_set(self) -> None:
        home, root = Path("/tmp/home"), Path("/tmp/root")
        saved = os.environ.get("GITHUB_ACTIONS")
        os.environ["GITHUB_ACTIONS"] = "true"
        try:
            env = native_candidate.cert_env(home, root)
        finally:
            if saved is None:
                del os.environ["GITHUB_ACTIONS"]
            else:
                os.environ["GITHUB_ACTIONS"] = saved
        self.assertEqual(env["GITHUB_ACTIONS"], "true")
        self.assertEqual(env["CI"], "true")
        self.assertEqual(env["HOME"], "/tmp/home")

    def test_github_actions_absent_when_unset(self) -> None:
        home, root = Path("/tmp/home"), Path("/tmp/root")
        saved = os.environ.pop("GITHUB_ACTIONS", None)
        try:
            env = native_candidate.cert_env(home, root)
        finally:
            if saved is not None:
                os.environ["GITHUB_ACTIONS"] = saved
        self.assertNotIn("GITHUB_ACTIONS", env)
        self.assertEqual(env["CI"], "true")


class ScopedRunTests(unittest.TestCase):
    """fp72.48: certification children die as a group, so teardown never races live writers."""

    def test_timeout_reaps_detached_grandchild_and_tree_removes_cleanly(self) -> None:
        work = Path(tempfile.mkdtemp(prefix="scoped-writer-", dir=ROOT / "var" / "agent-tmp"))
        self.addCleanup(shutil.rmtree, work, True)
        late = work / "late.txt"
        pidfile = work / "writer.pid"
        # Child detaches a grandchild that writes into the tree, then sleeps
        # past the timeout: without a group kill the grandchild survives and a
        # later rmtree races it (native Errno 66 masking a 900 s timeout).
        inner_path = work / "writer.py"
        inner_path.write_text(
            "import os, time\n"
            f"open({str(pidfile)!r}, 'w').write(str(os.getpid()))\n"
            f"open({str(late)!r}, 'a').write('late\\n')\n"
            "time.sleep(300)\n",
            encoding="utf-8")
        script = (
            "import subprocess, sys\n"
            f"subprocess.Popen([sys.executable, {str(inner_path)!r}])\n"
            "import time; time.sleep(60)\n"
        )
        with self.assertRaises(subprocess.TimeoutExpired):
            native_candidate.run_scoped(
                [sys.executable, "-c", script],
                cwd=str(work), env=os.environ.copy(), timeout=5)
        writer = int(pidfile.read_text(encoding="utf-8").strip())
        for _ in range(100):
            try:
                os.kill(writer, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail("detached writer survived the group kill")
        shutil.rmtree(work)
        self.assertFalse(work.exists())

    def test_clean_exit_returns_completed_process(self) -> None:
        result = native_candidate.run_scoped(
            [sys.executable, "-c", "print('ok')"],
            cwd=str(ROOT), env=os.environ.copy(), timeout=60)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"ok", result.stdout)

    def test_timeout_receipt_names_interrupted_ladder_stage_and_elapsed_ms(self) -> None:
        with self.assertRaises(subprocess.TimeoutExpired) as timeout:
            native_candidate.run_scoped(
                ["/bin/sh", str(ROOT / "scripts" / "ladder.sh"), "--selftest-interruption", "e2e-live"],
                cwd=str(ROOT), env=os.environ.copy(), timeout=0.15)

        detail = native_candidate.timeout_detail("full", timeout.exception, 0.15)
        self.assertTrue(detail["timed_out"])
        self.assertEqual(detail["current_stage"]["name"], "e2e-live")
        self.assertGreaterEqual(detail["current_stage"]["elapsed_ms"], 100)

class FullProofTests(unittest.TestCase):
    def test_passing_full_proof_retains_stage_durations_without_telemetry_error(self) -> None:
        child = types.SimpleNamespace(
            stdout=b"full report",
            stderr=(b"OMP_KIT_STAGE_START name=harness-gate started_at_ms=100\n"
                    b"OMP_KIT_STAGE_START name=e2e-live started_at_ms=220\n"),
        )
        test = {"stages": {
            "harness-gate": {"status": "PASS"},
            "e2e-live": {"status": "PASS"},
            "optional-stage": {"status": "NOT_RUN"},
        }}
        receipt = {"proofs": {}}

        proof = native_candidate.proof_record(
            "full", child, test, finished_at_ms=300, receipt=receipt)

        self.assertEqual(proof["status"], "PASS")
        self.assertEqual(proof["stdout_sha256"], hashlib.sha256(child.stdout).hexdigest())
        self.assertEqual(proof["stage_durations_ms"], {"harness-gate": 120, "e2e-live": 80})
        self.assertEqual(receipt["proofs"]["full"], proof)
        self.assertNotIn("telemetry_error", receipt)

    def test_missing_stage_marker_records_bounded_telemetry_without_refusing_full_proof(self) -> None:
        child = types.SimpleNamespace(
            stdout=b"full report",
            stderr=b"OMP_KIT_STAGE_START name=harness-gate started_at_ms=100\n",
        )
        stages = {"harness-gate": {"status": "PASS"}}
        stages.update({f"missing-{index:03}": {"status": "PASS"} for index in range(40)})
        receipt = {"proofs": {}}

        proof = native_candidate.proof_record(
            "full", child, {"stages": stages}, finished_at_ms=300, receipt=receipt)

        self.assertEqual(proof["status"], "PASS")
        self.assertNotIn("stage_durations_ms", proof)
        self.assertEqual(receipt["proofs"]["full"], proof)
        self.assertIn("telemetry_error", receipt)
        self.assertIn("missing-", receipt["telemetry_error"])
        self.assertLessEqual(len(receipt["telemetry_error"]), 300)


def native_failure_log() -> None:
    """Plant a real packaged stage failure; never create a passing native receipt."""
    archive_dir = Path(os.environ["OMP_KIT_NATIVE_FAILURE_ARCHIVE_DIR"])
    target = os.environ["TARGET"]
    original_env = native_candidate.cert_env
    original_run = native_candidate.run_scoped
    full_reports: list[dict] = []

    def recording_run(argv: list[str], *, cwd: Path, env: dict, timeout: int) -> subprocess.CompletedProcess:
        child = original_run(argv, cwd=cwd, env=env, timeout=timeout)
        if argv[1:] == ["test", "--full", "--json"]:
            full_reports.append(json.loads(child.stdout)["data"]["test"])
        return child

    head = "CIOUT1 planted stage head: owned nice exits 1"
    tail = "CIOUT1 planted stage tail: owned nice exits 1"
    error = "CIOUT1 planted stage stderr: owned nice exits 1"

    def failing_stage_env(home: Path, root: Path) -> dict:
        env = original_env(home, root)
        fault_bin = root / "fault-bin"
        fault_bin.mkdir()
        nice = fault_bin / "nice"
        # Preserve the real preceding stages: their long output must not hide this verdict.
        # Sleep only in the failing child so heavy can establish its process identity.
        nice.write_text(
            "#!/bin/sh\nfor arg do\nif [ \"${arg##*/}\" = regex-budget.ts ]; then\n"
            "/bin/sleep 1\nprintf '%s\\n' " + repr(head) + " " + repr("x" * 8000) + " " + repr(tail)
            + "\nprintf '%s\\n' " + repr(error) + " >&2\nexit 1\nfi\ndone\n"
            "exec /usr/bin/nice \"$@\"\n", encoding="utf-8")
        nice.chmod(0o700)
        return {**env, "PATH": str(fault_bin) + os.pathsep + env["PATH"]}

    with tempfile.TemporaryDirectory(prefix="native-failure-log-") as work:
        args = types.SimpleNamespace(
            version=os.environ["CANDIDATE_VERSION"], platform=target,
            source_sha=os.environ["SOURCE_SHA"], omp_version=os.environ["OMP_VERSION"],
            omp_track=os.environ["OMP_TRACK"], asset=str(archive_dir / "asset.json"),
            archive_dir=str(archive_dir), out=str(Path(work) / "refusal.json"))
        stdout, stderr = io.StringIO(), io.StringIO()
        with unittest.mock.patch.object(native_candidate, "cert_env", failing_stage_env), \
                unittest.mock.patch.object(native_candidate, "run_scoped", recording_run):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = native_candidate.native(args)
        # Print the real native console, not a reconstruction of its receipt.
        print(stdout.getvalue(), end="", flush=True)
        print(stderr.getvalue(), end="", file=sys.stderr, flush=True)
        receipt = json.loads(Path(args.out).read_text(encoding="utf-8"))
        check = unittest.TestCase()
        public_report = full_reports[0]
        public_stage = public_report["stages"]["regex-budget"]
        check.assertEqual(public_stage["status"], "FAIL")
        check.assertEqual(public_stage["producer_rc"], 1)
        check.assertGreaterEqual(public_stage["duration_ms"], 1000)
        output = public_stage["output"]
        check.assertIn(head, output["stdout_head"])
        check.assertIn(tail, output["stdout_tail"])
        check.assertIn(error, output["stdout_tail"])
        for key, limit in (("stdout_head", 2500), ("stdout_tail", 2500), ("stderr_tail", 1000)):
            check.assertLessEqual(len(output.get(key, "")), limit)
        check.assertLessEqual(len(public_report["producer"]["stdout"]), 2500)
        check.assertLessEqual(len(public_report["producer"]["stderr"]), 1000)
        print(json.dumps({"scope": "actual public CLI failure JSON, expected refusal",
                          "stage": public_stage}), flush=True)
        check.assertEqual(code, 1)
        check.assertIs(receipt["certified"], False)
        check.assertEqual(receipt["failure"], "native full refused rc=1")
        check.assertNotIn("full", receipt["proofs"])
        check.assertEqual(set(receipt["proofs"]), {"status", "doctor", "fast"})
        detail = receipt["refusal_detail"]
        check.assertEqual(detail["failed_stages"], ["regex-budget"])
        check.assertGreaterEqual(detail["failed_stage_durations_ms"]["regex-budget"], 1000)
        check.assertIn("verdict: failing stage regex-budget after ", stdout.getvalue())
        check.assertIn(head, detail["producer_stdout_head"])
        check.assertIn(tail, detail["producer_stdout_tail"])
        check.assertIn(error, detail["producer_stdout_tail"])
        for key, limit in (("producer_stdout_head", 2500), ("producer_stdout_tail", 2500),
                           ("producer_stderr_tail", 1000)):
            check.assertLessEqual(len(detail.get(key, "")), limit)
        check.assertIn(head, stderr.getvalue())
        check.assertIn(tail, stderr.getvalue())
        receipt_out = os.environ.get("OMP_KIT_NATIVE_FAILURE_RECEIPT_OUT")
        if receipt_out:
            destination = Path(receipt_out)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.out, destination)
        print("CIOUT1 native forced-exit console: PASS (expected refusal, not certification)")


def native_ship_failure_index() -> None:
    """Feed a real native refusal through the unchanged aggregation CLI."""
    check = unittest.TestCase()
    positive = json.loads(
        (Path(os.environ["OMP_KIT_NATIVE_INDEX_DIR"]) / "candidate-proof.json").read_text(encoding="utf-8"))
    check.assertEqual(positive["source_sha"], os.environ["SOURCE_SHA"])
    check.assertEqual(positive["version"], os.environ["CANDIDATE_VERSION"])
    check.assertEqual(positive["certified_platforms"], list(RELEASE_PLATFORMS))
    refusal_path = Path(os.environ["OMP_KIT_NATIVE_FAILURE_RECEIPT"])
    refusal = json.loads(refusal_path.read_text(encoding="utf-8"))
    check.assertIs(refusal["certified"], False)
    check.assertEqual(refusal["platform"], "linux-x64-gnu")
    check.assertEqual(refusal["omp_track"], "certified")
    with tempfile.TemporaryDirectory(prefix="native-ship-failure-index-") as work:
        root = Path(work)
        receipts = root / "receipts"
        # Never alter the passing receipts used by the real candidate.
        shutil.copytree(os.environ["OMP_KIT_NATIVE_RECEIPTS_DIR"], receipts)
        shutil.copyfile(refusal_path, receipts / "native-receipt-linux-x64-gnu-certified" / "receipt.json")
        out = root / "candidate-index"
        child = subprocess.run(
            [sys.executable, str(SCRIPT), "candidate", "--release",
             "--version", os.environ["CANDIDATE_VERSION"], "--source-sha", os.environ["SOURCE_SHA"],
             "--assets", os.environ["OMP_KIT_NATIVE_ASSETS_DIR"], "--receipts", str(receipts),
             "--out", str(out)],
            cwd=ROOT, capture_output=True, timeout=60)
        print(child.stdout.decode(errors="replace"), end="", flush=True)
        print(child.stderr.decode(errors="replace"), end="", file=sys.stderr, flush=True)
        check.assertEqual(child.returncode, 1)
        check.assertIn("release candidate missing certified ship platform(s): linux-x64-gnu",
                       child.stderr.decode(errors="replace"))
        check.assertFalse((out / "release-index.json").exists())
        check.assertFalse((out / "candidate-proof.json").exists())
    print("REL1 native shipping refusal blocks candidate-index: PASS (controlled negative, not certification)")


def native_timeout_log(binary: str) -> None:
    """Exercise the original 900-second bound on a real packaged full CLI."""
    scratch = ROOT / "var" / "agent-tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-timeout-log-", dir=scratch) as work:
        root = Path(work)
        (root / ".owner").write_text(
            f"pid={os.getpid()}\nlabel=native-timeout-log\nrepo={ROOT}\ncreated={time.time()}\n",
            encoding="utf-8")
        home = root / "home"
        home.mkdir()
        fault_bin = root / "fault-bin"
        fault_bin.mkdir()
        nice = fault_bin / "nice"
        nice.write_text("#!/bin/sh\nexec /bin/sleep 1800\n", encoding="utf-8")
        nice.chmod(0o700)
        env = native_candidate.cert_env(home, root)
        env.update(PATH=str(fault_bin) + os.pathsep + env["PATH"],
                   OMP_KIT_CASE_CWD=str(ROOT), OMP_KIT_TEST_WORK_ROOT=str(root),
                   OMP_KIT_NATIVE_STAGE_PROGRESS="1")
        started = time.monotonic()
        try:
            child = native_candidate.run_scoped(
                [str(Path(binary).resolve()), "test", "--full", "--json"],
                cwd=ROOT, env=env, timeout=900)
        except subprocess.TimeoutExpired as error:
            detail = native_candidate.timeout_detail("full", error, 900)
            check = unittest.TestCase()
            check.assertIs(detail["timed_out"], True)
            check.assertEqual(detail["timeout_seconds"], 900)
            check.assertEqual(detail["current_stage"]["name"], "harness-gate")
            wall_seconds = time.monotonic() - started
            check.assertGreaterEqual(wall_seconds, 900)
            check.assertGreater(detail["current_stage"]["elapsed_ms"], 0)
            check.assertLessEqual(detail["current_stage"]["elapsed_ms"], round(wall_seconds * 1000))
            print(json.dumps({"scope": "packaged CLI timeout, not native certification",
                              "wall_seconds": round(wall_seconds, 3), "detail": detail}))
        else:
            raise AssertionError(f"owned hung stage did not reach the 900-second timeout: {child!r}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--native-failure-log"]:
        native_failure_log()
    elif sys.argv[1:] == ["--native-ship-failure-index"]:
        native_ship_failure_index()
    elif len(sys.argv) == 3 and sys.argv[1] == "--native-timeout-log":
        native_timeout_log(sys.argv[2])
    else:
        unittest.main()
