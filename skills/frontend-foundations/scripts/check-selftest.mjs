// Exercises the real Kit frontend check and standalone reference renderer.
// The Kit supplies its bounded process runner; every verifier actually runs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

export async function selftestFrontend(flags, { cwd, reference, renderer, kit, node, run, out, err, fixtures }) {
const fileFlag = (name) => flags.has(name) ? resolve(cwd, flags.get(name)) : null;
const CHECK = fileFlag("--check");
const SEALER = fileFlag("--sealer") ?? CHECK;
const MD = fileFlag("--foundations") ?? reference;
const BUILD_REF = fileFlag("--build-reference") ?? renderer;

async function capture(argv, cwd) {
  const r = await run(argv, { cwd, deadline_s: 90, max_output_bytes: 1 << 20 });
  if (r.timed_out || r.truncated || r.killed || r.rc === null || r.rc < 0) {
    throw new Error("native selftest child did not return complete output: " + argv[0]);
  }
  const decoder = new TextDecoder();
  return { status: r.rc, stdout: decoder.decode(r.stdout), stderr: decoder.decode(r.stderr) };
}

function runCheck(args, cwd, checker = CHECK) {
  return capture([...(checker ? [node, checker] : kit), ...args], cwd);
}

const failures = [];
function pass(name, detail) {
  out("selftest: " + name + " refused as designed (" + detail + ")");
}
function fail(name, want, got) {
  failures.push(name);
  err("selftest: " + name + " RED — wanted " + want + "\ngot:\n" + got);
}
function ok(name, detail) {
  out("selftest: " + name + " passes as designed (" + detail + ")");
}

function mkTemp(label) {
  const dir = join(fixtures, label);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
function rmTemp(dir) {
  rmSync(dir, { recursive: true });
}
function sha256Hex(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

const EXIT0 = [node, "-e", "process.exit(0)"];
const EXIT1 = [node, "-e", "process.exit(1)"];
const EXIT7 = [node, "-e", "process.exit(7)"];

function ids() {
  const want = [];
  for (let n = 0; n <= 29; n++) want.push("F" + n);
  return want;
}
// Decisions fixture: every foundation decided with a runnable verifier,
// except overrides: { [id]: { judge } | { verifier } | "drop" }.
function decisionsDoc(dir, overrides) {
  const foundations = {};
  for (const id of ids()) {
    const o = (overrides || {})[id];
    if (o === "drop") continue;
    if (o && o.judge) {
      foundations[id] = { choice: "default", judge: o.judge };
    } else if (o && o.verifier) {
      foundations[id] = { choice: "default", verifier: o.verifier };
    } else {
      foundations[id] = { choice: "default", verifier: { argv: EXIT0, timeoutMs: 10000 } };
    }
    // Retain the old schema's alleged proof too: before/after runs use
    // identical inputs, not malformed inputs that the old checker rejects.
    const outputPath = join(dir, id + ".txt");
    writeFileSync(outputPath, id + " PASS: hand-written claim\n");
    foundations[id].evidence = { path: outputPath, exit: 0 };
    foundations[id].status = "pass";
  }
  return { version: 2, generatedBy: "check-selftest", buildDir: "build", foundations };
}
function writeProject(dir, doc, buildFiles) {
  mkdirSync(join(dir, "build"), { recursive: true });
  const files = buildFiles || { "index.html": "<h1>ship</h1>\n" };
  for (const name of Object.keys(files)) {
    writeFileSync(join(dir, "build", name), files[name]);
  }
  const p = join(dir, "frontend.foundations.json");
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  return p;
}
function digestOfFile(p) {
  return sha256Hex(readFileSync(p));
}

let count = 0;
async function positive() {
  const dir = mkTemp("positive");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, {}));
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status === 0 && /all 30 foundations decided and verified/.test(r.stdout)) {
      ok("positive", "complete fixture passes (30/30 live verifiers)");
    } else {
      fail("positive", "rc 0 + all-30-verified", "rc=" + r.status + "\n" + r.stdout + "\n" + r.stderr);
    }
    count++;
    const evidencePath = join(dir, "frontend.evidence.json");
    const sealed = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : {};
    const results = sealed.results || {};
    const realResults = ids().every((id) => {
      const result = results[id];
      return result && result.exit === 0 && result.outputSha256 === sha256Hex("") &&
        Number.isFinite(Date.parse(result.startedAt)) && result.durationMs >= 0;
    });
    if (realResults && sealed.criteriaDigest === digestOfFile(inPath) && typeof sealed.buildDigest === "string") {
      ok("sealed-results", "30 real exits + stdout/stderr hashes + run timestamps + both digests");
    } else fail("sealed-results", "complete measured evidence", JSON.stringify(sealed));
  } finally {
    rmTemp(dir);
  }
}
async function missingId() {
  const dir = mkTemp("missing");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, { F29: "drop" }));
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status !== 0 && /F29: missing/.test(r.stderr)) pass("missing-id", "F29");
    else fail("missing-id", "rc!=0 naming F29 missing", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
async function extraId() {
  const dir = mkTemp("extra");
  try {
    const doc = decisionsDoc(dir, {});
    doc.foundations.F30 = { choice: "default", verifier: { argv: EXIT0, timeoutMs: 10000 } };
    const inPath = writeProject(dir, doc);
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status !== 0 && /F30: unknown foundation/.test(r.stderr)) pass("extra-id", "F30");
    else fail("extra-id", "rc!=0 naming F30 unknown", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
async function emptyObject() {
  const dir = mkTemp("empty");
  try {
    const inPath = writeProject(dir, { version: 2, buildDir: "build", foundations: {} });
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status !== 0 && /F0: missing/.test(r.stderr) && /F29: missing/.test(r.stderr)) {
      pass("empty-object", "30 missing");
    } else fail("empty-object", "rc!=0 naming F0..F29 missing", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
async function undecided() {
  const dir = mkTemp("undecided");
  try {
    const doc = decisionsDoc(dir, {});
    doc.foundations.F0.choice = "";
    const inPath = writeProject(dir, doc);
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status !== 0 && /F0: undecided/.test(r.stderr)) pass("undecided", "F0");
    else fail("undecided", "rc!=0 naming F0 undecided", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
async function failedExit() {
  const dir = mkTemp("failedexit");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, { F2: { verifier: { argv: EXIT7, timeoutMs: 10000 } } }));
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    count++;
    if (r.status !== 0 && /F2: verifier failed \(exit 7/.test(r.stderr)) pass("failed-exit", "F2");
    else fail("failed-exit", "rc!=0 naming F2 exit 7", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
// (a) Hand-written exit 0 for a verifier that actually exits 1.
// The forged record carries the CORRECT digests, so only the exit lie is
// exercised: the live re-run must refuse it.
async function forgedExit() {
  const dir = mkTemp("forged");
  try {
    const attacked = decisionsDoc(dir, { F2: { verifier: { argv: EXIT1, timeoutMs: 10000 } } });
    const inPath = writeProject(dir, attacked);
    // Learn this project's real build digest from an all-pass twin file set:
    // same decisions shape, same build bytes, verifiers that exit 0.
    const twinPath = join(dir, "twin.foundations.json");
    writeFileSync(twinPath, JSON.stringify(decisionsDoc(dir, {}), null, 2) + "\n");
    const probePath = join(dir, "probe.json");
    const rp = await runCheck(["--in", twinPath, "--foundations", MD, "--write-evidence", probePath], dir, SEALER);
    if (rp.status !== 0) {
      count++;
      fail("forged-exit", "twin seals cleanly", "rc=" + rp.status + "\n" + rp.stderr);
      return;
    }
    const probe = JSON.parse(readFileSync(probePath, "utf8"));
    const forged = {
      version: 1,
      check: "hand-written lie",
      buildDir: "build",
      buildDigest: probe.buildDigest,
      criteriaDigest: digestOfFile(inPath),
      buildFiles: probe.buildFiles,
      createdAt: new Date().toISOString(),
      results: {},
    };
    for (const id of ids()) {
      forged.results[id] = {
        kind: "verifier",
        argv: id === "F2" ? EXIT1 : EXIT0,
        exit: 0,
        outputSha256: probe.results[id].outputSha256,
        durationMs: 1,
      };
    }
    const evPath = join(dir, "forged.json");
    writeFileSync(evPath, JSON.stringify(forged, null, 2) + "\n");
    count++;
    const r = await runCheck(["--in", inPath, "--foundations", MD, "--evidence", evPath], dir);
    if (r.status !== 0 && /F2 records exit 0 but the verifier just exited 1/.test(r.stderr)) {
      pass("forged-exit", "F2 hand-written exit 0 vs live exit 1");
    } else fail("forged-exit", "rc!=0 naming F2 exit lie", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
// (b) Evidence sealed for build A presented after one build file changes.
async function staleBuild() {
  const dir = mkTemp("stale");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, {}));
    const evPath = join(dir, "sealed.json");
    const r0 = await runCheck(["--in", inPath, "--foundations", MD, "--write-evidence", evPath], dir, SEALER);
    if (r0.status !== 0) {
      count++;
      fail("stale-build", "seal step rc 0", "rc=" + r0.status + "\n" + r0.stderr);
      return;
    }
    writeFileSync(join(dir, "build", "index.html"), "<h1>changed</h1>\n");
    count++;
    const r = await runCheck(["--in", inPath, "--foundations", MD, "--evidence", evPath], dir);
    if (r.status !== 0 && /evidence stale: build digest mismatch/.test(r.stderr)) {
      pass("stale-build", "build digest mismatch");
    } else fail("stale-build", "rc!=0 naming build digest mismatch", "rc=" + r.status + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
// (c) Approval record for another build digest under --require-approval.
async function wrongApproval() {
  const dir = mkTemp("approval");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, { F0: { judge: "owner accept fixture" }, F22: { judge: "event pipeline unwired fixture" } }));
    const criteriaDigest = digestOfFile(inPath);
    const probePath = join(dir, "probe.json");
    await runCheck(["--in", inPath, "--foundations", MD, "--write-evidence", probePath], dir, SEALER);
    const probe = JSON.parse(readFileSync(probePath, "utf8"));
    const goodApproval = {
      decision: "approve",
      buildDigest: probe.buildDigest,
      criteriaDigest,
      approver: "selftest owner",
      at: new Date().toISOString(),
    };
    const goodPath = join(dir, "approval.json");
    writeFileSync(goodPath, JSON.stringify(goodApproval, null, 2) + "\n");
    count++;
    const rGood = await runCheck(["--in", inPath, "--foundations", MD, "--require-approval", "--approval", goodPath], dir);
    if (rGood.status === 0 && /owner approval by selftest owner/.test(rGood.stdout) && !/NEEDS_JUDGE.*PASS|PASS.*NEEDS_JUDGE/.test(rGood.stdout)) {
      ok("matching-approval", "covers judge items without calling them PASS");
    } else {
      fail("matching-approval", "rc 0 with owner approval covering judges", "rc=" + rGood.status + "\n" + rGood.stdout + "\n" + rGood.stderr);
    }
    const badApproval = { ...goodApproval, buildDigest: "sha256:" + "0".repeat(64) };
    const badPath = join(dir, "approval-bad.json");
    writeFileSync(badPath, JSON.stringify(badApproval, null, 2) + "\n");
    count++;
    const r = await runCheck(["--in", inPath, "--foundations", MD, "--require-approval", "--approval", badPath], dir);
    if (r.status !== 0 && /approval refused: it names build digest/.test(r.stderr)) {
      pass("wrong-approval", "approval for another build refused");
    } else fail("wrong-approval", "rc!=0 naming approval build mismatch", "rc=" + r.status + "\n" + r.stderr);
    count++;
    const rMissing = await runCheck(["--in", inPath, "--foundations", MD, "--require-approval", "--approval", join(dir, "absent.json")], dir);
    if (rMissing.status !== 0 && /owner approval required/.test(rMissing.stderr)) {
      pass("missing-approval", "absent approval refused");
    } else fail("missing-approval", "rc!=0 for absent approval", "rc=" + rMissing.status + "\n" + rMissing.stderr);
    const failed = decisionsDoc(dir, { F0: { judge: "owner accept fixture" }, F2: { verifier: { argv: EXIT7, timeoutMs: 10000 } } });
    writeFileSync(inPath, JSON.stringify(failed));
    writeFileSync(goodPath, JSON.stringify({ ...goodApproval, criteriaDigest: digestOfFile(inPath) }));
    count++;
    const failure = await runCheck(["--in", inPath, "--foundations", MD, "--require-approval", "--approval", goodPath], dir);
    if (failure.status === 1 && failure.stderr.includes("F2: verifier failed (exit 7") &&
        !failure.stderr.includes("F0: NEEDS_JUDGE") && !failure.stderr.includes("approval refused")) {
      pass("approval-does-not-cover-verifier", "matching approval covers only the judge");
    } else fail("approval-does-not-cover-verifier", "rc1 with the verifier failure only", failure.stderr);
  } finally {
    rmTemp(dir);
  }
}
// (d) A NEEDS_JUDGE item never counts as passed.
async function needsJudge() {
  const dir = mkTemp("judge");
  try {
    const inPath = writeProject(dir, decisionsDoc(dir, { F5: { judge: "colour judgment needs eyes" } }));
    count++;
    const r = await runCheck(["--in", inPath, "--foundations", MD], dir);
    const namesPass = new RegExp("F5[^\\n]*\\bPASS\\b").test(r.stdout + "\n" + r.stderr);
    if (r.status !== 0 && /F5: NEEDS_JUDGE/.test(r.stderr) && !namesPass) {
      pass("needs-judge", "F5 NEEDS_JUDGE, never PASS");
    } else fail("needs-judge", "rc!=0 with F5 NEEDS_JUDGE and no PASS", "rc=" + r.status + "\n" + r.stdout + "\n" + r.stderr);
  } finally {
    rmTemp(dir);
  }
}
// (e) Preview renders with the overlay directory absent.
async function overlayAbsent() {
  const dir = mkTemp("overlay");
  try {
    const out = join(dir, "reference.html");
    count++;
    // Copy the standalone renderer beside its reference with NO overlays/
    // directory, exactly like an overlay-free portable installation.
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "scripts", "build-reference.mjs"), readFileSync(BUILD_REF));
    writeFileSync(join(dir, "references", "foundations.md"), readFileSync(MD));
    const r = await capture([node, join(dir, "scripts", "build-reference.mjs"), "--out", out], dir);
    const html = existsSync(out) ? readFileSync(out, "utf8") : "";
    const cards = (html.match(/data-open="F\d+"/g) || []).length;
    if (r.status === 0 && existsSync(out) && cards === 30) {
      ok("overlay-absent", "stock preview renders 30 cards, no overlay");
    } else fail("overlay-absent", "rc 0 + 30 cards without overlay", "rc=" + r.status + "\n" + r.stderr + "\ncards=" + cards);
  } finally {
    rmTemp(dir);
  }
}

async function malformed() {
  const dir = mkTemp("malformed");
  try {
    const doc = decisionsDoc(dir, {});
    doc.foundations.F5.verifier = { argv: [], timeoutMs: 0 };
    const input = writeProject(dir, doc);
    count++;
    const r = await runCheck(["--in", input, "--foundations", MD], dir);
    if (r.status !== 0 && r.stderr.includes("F5: malformed verifier")) pass("malformed-verifier", "F5");
    else fail("malformed-verifier", "nonzero naming malformed F5", "rc=" + r.status + "\n" + r.stdout + r.stderr);
    writeFileSync(input, "{ broken JSON");
    count++;
    const badJson = await runCheck(["--in", input, "--foundations", MD], dir);
    if (badJson.status !== 0 && badJson.stderr.includes("not valid JSON")) pass("malformed-json", "invalid JSON");
    else fail("malformed-json", "nonzero naming invalid JSON", "rc=" + badJson.status + "\n" + badJson.stdout + badJson.stderr);
  } finally { rmTemp(dir); }
}
async function wrongOutputAndCriteria() {
  const dir = mkTemp("wrong");
  try {
    const doc = decisionsDoc(dir, {});
    const input = writeProject(dir, doc);
    const evidencePath = join(dir, "sealed.json");
    const sealedRun = await runCheck(["--in", input, "--foundations", MD, "--write-evidence", evidencePath], dir, SEALER);
    if (sealedRun.status !== 0) {
      fail("wrong-evidence", "sealer rc0", sealedRun.stderr);
      return;
    }
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    evidence.results.F5.outputSha256 = sha256Hex("F6 PASS: wrong foundation's output\n");
    writeFileSync(evidencePath, JSON.stringify(evidence));
    count++;
    const r = await runCheck(["--in", input, "--foundations", MD, "--evidence", evidencePath], dir);
    if (r.status !== 0 && r.stderr.includes("F5 output does not match the live verifier run")) pass("wrong-evidence", "F6 output planted into F5 seal");
    else fail("wrong-evidence", "nonzero naming wrong F5 output", "rc=" + r.status + "\n" + r.stdout + r.stderr);
    doc.note = "criteria changed after sealing";
    writeFileSync(input, JSON.stringify(doc));
    count++;
    const stale = await runCheck(["--in", input, "--foundations", MD, "--evidence", evidencePath], dir);
    if (stale.status !== 0 && stale.stderr.includes("criteria digest mismatch")) pass("stale-criteria", "changed decisions");
    else fail("stale-criteria", "nonzero naming criteria digest mismatch", "rc=" + stale.status + "\n" + stale.stdout + stale.stderr);
    const approvalPath = join(dir, "null-approval.json");
    writeFileSync(approvalPath, "null");
    count++;
    const approval = await runCheck(["--in", input, "--foundations", MD, "--require-approval", "--approval", approvalPath], dir);
    if (approval.status !== 0 && approval.stderr.includes("approval refused: record must be an object")) pass("malformed-approval", "null is not approval");
    else fail("malformed-approval", "nonzero for null approval", "rc=" + approval.status + "\n" + approval.stdout + approval.stderr);
  } finally { rmTemp(dir); }
}

async function approvalDecisions() {
  const dir = mkTemp("approval-decision");
  try {
    const input = writeProject(dir, decisionsDoc(dir, {}));
    const evidencePath = join(dir, "probe.json");
    const probe = await runCheck(["--in", input, "--foundations", MD, "--write-evidence", evidencePath], dir, SEALER);
    if (probe.status !== 0) {
      fail("approval-decision-probe", "sealer rc0", probe.stderr);
      return;
    }
    const sealed = JSON.parse(readFileSync(evidencePath, "utf8"));
    for (const decision of [undefined, "reject"]) {
      const name = decision === undefined ? "missing-approval-decision" : "rejected-approval-decision";
      const record = { buildDigest: sealed.buildDigest, criteriaDigest: sealed.criteriaDigest, approver: "selftest owner", decision };
      const path = join(dir, name + ".json");
      writeFileSync(path, JSON.stringify(record));
      count++;
      const result = await runCheck(["--in", input, "--foundations", MD, "--require-approval", "--approval", path], dir);
      if (result.status !== 0 && result.stderr.includes("approval refused: explicit decision must be approve")) {
        pass(name, "matching digests do not imply approval");
      } else fail(name, "explicit approval refusal", "rc=" + result.status + "\n" + result.stdout + result.stderr);
    }
  } finally { rmTemp(dir); }
}

const approvalDecisionsOnly = flags.has("--approval-decisions-only");
if (approvalDecisionsOnly) {
  await approvalDecisions();
} else {
  for (const test of [positive, missingId, extraId, emptyObject, undecided, failedExit,
    forgedExit, staleBuild, wrongApproval, needsJudge, overlayAbsent, malformed,
    wrongOutputAndCriteria, approvalDecisions]) {
    await test();
  }
}

if (failures.length > 0) {
  err("selftest: RED — " + failures.length + " case(s) failed (" + count + " ran): " + failures.join(", "));
  return 1;
}
const witness = approvalDecisionsOnly
  ? "explicit approval decision negatives refused"
  : "positive 30/30 + every planted negative refused";
out("selftest: GREEN — " + count + " cases (" + witness + ")");
return 0;
}
