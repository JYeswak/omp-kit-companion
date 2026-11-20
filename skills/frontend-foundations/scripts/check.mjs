// Runs every foundation's verifier itself and binds the results to the exact
// build and the exact decisions file. Nothing the user records is trusted:
// no stored exit code, no saved-output substring, no claimed PASS counts.
// A foundation passes only when its own verifier command exits 0 in this run.
// Outputs are bound by hash: buildDigest covers the served build directory
// named by the decisions file, criteriaDigest covers the decisions file bytes.
// An evidence file seals both digests plus per-foundation results; check
// refuses evidence whose digests do not match the current files.
// Owner approval names the digests it approves; --require-approval refuses
// when the record is missing or names other digests. Items that need a human
// judge are reported as NEEDS_JUDGE, never PASS.
// The exact F0-F29 inventory comes from references/foundations.md (single
// source); an empty object therefore fails with 30 named missing ids.
// The Kit frontend check command supplies its bounded process runner and the
// installed reference path. The checker itself does not start processes.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, relative } from "node:path";
import { constants } from "node:os";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_BUILD_FILES = 20000;
const MAX_BUILD_BYTES = 256 * 1024 * 1024;

function sha256Hex(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function canonicalIds(md, source) {
  const ids = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/);
    if (!m) continue;
    const cells = m.slice(1, 6).map((c) => c.trim());
    if (!/^F\d+$/.test(cells[0])) continue;
    if (!ids.includes(cells[0])) ids.push(cells[0]);
  }
  const want = [];
  for (let n = 0; n <= 29; n++) want.push("F" + n);
  const missing = want.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !want.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push("missing " + missing.join(", "));
    if (extra.length > 0) parts.push("unexpected " + extra.join(", "));
    throw new Error(source + " must name exactly F0-F29 (" + parts.join("; ") + ")");
  }
  return want;
}

// Never silently omit unreadable directories, symlinks or special files: a
// served file outside this tree would otherwise escape the build binding.
function digestBuildDir(buildDirAbs) {
  try {
    const files = [];
    let total = 0;
    const walk = (dirAbs) => {
      for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
        const full = join(dirAbs, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          if (files.length >= MAX_BUILD_FILES) throw new Error("build file limit exceeded");
          const size = statSync(full).size;
          total += size;
          if (total > MAX_BUILD_BYTES) throw new Error("build byte limit exceeded");
          files.push({ full, path: relative(buildDirAbs, full).split("\\").join("/") });
        } else throw new Error("unsupported build entry (symlink or special file): " + full);
      }
    };
    walk(buildDirAbs);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const hash = createHash("sha256");
    for (const file of files) {
      const bytes = readFileSync(file.full);
      hash.update(file.path + "\0" + bytes.length + "\0");
      hash.update(bytes);
      hash.update("\0");
    }
    return { digest: "sha256:" + hash.digest("hex"), files: files.length };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function validArgv(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const argv = v.argv;
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (!argv.every((a) => typeof a === "string" && a.length > 0)) return null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (v.timeoutMs !== undefined) {
    if (!Number.isInteger(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 300000) return null;
    timeoutMs = v.timeoutMs;
  }
  return { argv, timeoutMs };
}

// Runs the verifier command itself: argv only, no shell, bounded time and
// output. Returns the real exit plus a hash of the real output.
async function runVerifier(argv, timeoutMs, cwd, run) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const finish = (result) => ({ ...result, startedAt, durationMs: Date.now() - started });
  let r;
  try {
    r = await run(argv, { cwd, deadline_s: timeoutMs / 1000, max_output_bytes: MAX_OUTPUT_BYTES });
  } catch (error) {
    return finish({ exit: null, refusal: "could not start (" + String(error.message || error) + ")", outputSha256: sha256Hex("") });
  }
  const hash = createHash("sha256");
  hash.update(r.stdout);
  hash.update(r.stderr);
  const result = {
    exit: r.rc !== null && r.rc >= 0 ? r.rc : null,
    outputSha256: "sha256:" + hash.digest("hex"),
    signal: r.rc < 0 ? Object.keys(constants.signals).find((name) => constants.signals[name] === -r.rc) ?? null : null,
  };
  if (r.timed_out) result.timedOut = true;
  else if (r.truncated) result.refusal = "exceeded its output limit";
  else if (r.killed) result.refusal = "left running descendants";
  return finish(result);
}

async function evaluate(doc, ctx, run, judgesApproved) {
  const problems = [];
  const results = {};
  const canonical = canonicalIds(ctx.foundationsMd, ctx.foundationsSource);
  const foundations = (doc && doc.foundations) || {};
  for (const id of canonical) {
    if (!Object.prototype.hasOwnProperty.call(foundations, id)) {
      problems.push(id + ": missing (no decision in " + ctx.decisionsName + "; run init.mjs)");
    }
  }
  for (const id of Object.keys(foundations).sort()) {
    const f = foundations[id] || {};
    if (!canonical.includes(id)) {
      problems.push(id + ": unknown foundation (not in " + ctx.foundationsSource + ")");
      continue;
    }
    const choice = f.choice;
    const decided =
      choice === "default" ||
      (typeof choice === "string" &&
        choice.startsWith("override:") &&
        choice.slice("override:".length).trim().length > 0);
    if (!decided) {
      problems.push(id + ": undecided (choice must be \"default\" or \"override: <value>\")");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(f, "judge") &&
        (typeof f.judge !== "string" || !f.judge.trim() || f.verifier !== undefined)) {
      problems.push(id + ": malformed judge (use a non-empty judge note OR verifier.argv, not both)");
      continue;
    }
    if (typeof f.judge === "string" && f.judge.trim().length > 0) {
      const reason = f.judge.trim();
      results[id] = { kind: "judge", reason, status: "NEEDS_JUDGE" };
      if (!judgesApproved) problems.push(id + ": NEEDS_JUDGE (" + reason.slice(0, 160) + ")");
      continue;
    }
    const verifier = validArgv(f.verifier);
    if (!verifier) {
      problems.push(id + ": malformed verifier (needs non-empty verifier.argv and an integer timeoutMs from 1 to 300000; legacy evidence/status never trusted)");
      continue;
    }
    const live = await runVerifier(verifier.argv, verifier.timeoutMs, ctx.projectDir, run);
    results[id] = { kind: "verifier", argv: verifier.argv, ...live };
    if (live.refusal) {
      problems.push(id + ": verifier " + live.refusal.slice(0, 160));
      continue;
    }
    if (live.timedOut) {
      problems.push(id + ": verifier timed out after " + verifier.timeoutMs + "ms");
      continue;
    }
    if (live.exit !== 0) {
      problems.push(id + ": verifier failed (exit " + live.exit + " after " + live.durationMs + "ms)");
      continue;
    }
  }
  return { problems, results };
}

export async function checkFrontend(flags, { cwd, reference, run, out, err }) {
  const opt = (name, dflt) => flags.get(name) ?? dflt;
  const inPath = resolve(cwd, opt("--in", "frontend.foundations.json"));
  const mdPath = resolve(cwd, opt("--foundations", reference));
  const decisionsName = relative(cwd, inPath) || inPath;

  let docBytes;
  try {
    docBytes = readFileSync(inPath);
  } catch {
    err("cannot read " + inPath + " (run init.mjs first)");
    return 1;
  }
  let doc;
  try {
    doc = JSON.parse(docBytes.toString("utf8"));
  } catch {
    err(inPath + " is not valid JSON");
    return 1;
  }
  let md;
  try {
    md = readFileSync(mdPath, "utf8");
  } catch {
    err("cannot read " + mdPath);
    return 1;
  }
  const criteriaDigest = sha256Hex(docBytes);
  const projectDir = dirname(inPath);
  const buildDirGiven = doc && typeof doc.buildDir === "string" ? doc.buildDir : null;
  const problems = [];
  let buildDigest = null;
  let buildFiles = 0;
  if (!buildDirGiven || buildDirGiven.length === 0) {
    problems.push("build: decisions file names no build directory (add buildDir; results bind to the served build)");
  } else {
    const buildAbs = resolve(projectDir, buildDirGiven);
    if (!existsSync(buildAbs) || !statSync(buildAbs).isDirectory()) {
      problems.push("build: directory missing at " + buildAbs);
    } else {
      const bd = digestBuildDir(buildAbs);
      if (bd.error) {
        problems.push("build: " + bd.error);
      } else if (bd.files === 0) {
        problems.push("build: directory " + buildAbs + " is empty (nothing to bind results to)");
      } else {
        buildDigest = bd.digest;
        buildFiles = bd.files;
      }
    }
  }

  // Evidence presented for validation: digests must match before anything
  // else is believed. A stale record refuses fast, without running verifiers.
  const evidencePath = opt("--evidence", null);
  let evidence = null;
  if (evidencePath !== null) {
    const evAbs = resolve(cwd, evidencePath);
    try {
      evidence = JSON.parse(readFileSync(evAbs, "utf8"));
    } catch {
      problems.push("evidence: cannot read " + evAbs);
    }
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      problems.push("evidence: " + evidencePath + " is not an evidence object");
      evidence = null;
    }
  }
  if (evidence !== null) {
    if (evidence.version !== 1 || !evidence.results || typeof evidence.results !== "object" || Array.isArray(evidence.results)) {
      problems.push("evidence refused: malformed sealed results");
    }
    if (evidence.buildDigest !== buildDigest) {
      problems.push(
        "evidence stale: build digest mismatch (evidence " + String(evidence.buildDigest).slice(0, 19) +
          ", current " + String(buildDigest).slice(0, 19) + "; rebuild changed, re-verify)"
      );
    }
    if (evidence.criteriaDigest !== criteriaDigest) {
      problems.push(
        "evidence stale: criteria digest mismatch (evidence " + String(evidence.criteriaDigest).slice(0, 19) +
          ", current " + String(criteriaDigest).slice(0, 19) + "; decisions changed, re-verify)"
      );
    }
  }

  // Approval gate for shipping. Approval never makes a judge item PASS;
  // it records the owner judging the NEEDS_JUDGE items against these digests.
  const requireApproval = flags.has("--require-approval");
  const approvalPath = opt("--approval", null);
  let approval = null;
  let approvalOk = false;
  let approver = "";
  if (requireApproval) {
    if (approvalPath === null) {
      problems.push("owner approval required (--require-approval) but no --approval file was given");
    } else {
      const apAbs = resolve(cwd, approvalPath);
      try {
        approval = JSON.parse(readFileSync(apAbs, "utf8"));
        if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
          problems.push("approval refused: record must be an object");
          approval = null;
        }
      } catch {
        problems.push("owner approval required but cannot read " + apAbs);
      }
      if (approval !== null) {
        if (approval.decision !== "approve") problems.push("approval refused: explicit decision must be approve");
        approver = typeof approval.approver === "string" ? approval.approver.trim() : "";
        if (approver.length === 0) problems.push("approval refused: no approver named in " + approvalPath);
        if (approval.buildDigest !== buildDigest) {
          problems.push(
            "approval refused: it names build digest " + String(approval.buildDigest).slice(0, 19) +
              " but the current build is " + String(buildDigest).slice(0, 19)
          );
        }
        if (approval.criteriaDigest !== criteriaDigest) {
          problems.push(
            "approval refused: it names criteria digest " + String(approval.criteriaDigest).slice(0, 19) +
              " but the current criteria are " + String(criteriaDigest).slice(0, 19)
          );
        }
      }
    }
  }
  if (requireApproval && approval !== null && problems.every((p) => !p.startsWith("approval refused") && !p.startsWith("owner approval"))) {
    approvalOk = approver.length > 0;
  }

  const ctx = {
    foundationsMd: md,
    foundationsSource: "references/foundations.md",
    decisionsName,
    projectDir,
  };
  let live = { problems: [], results: {} };
  const evidenceStale = problems.some((p) => p.startsWith("evidence stale"));
  if (!evidenceStale) {
    try {
      live = await evaluate(doc, ctx, run, approvalOk);
    } catch (error) {
      err(String(error.message || error));
      return 1;
    }
    problems.push(...live.problems);
  }
  // A verifier may not change the thing being certified. Bind again after
  // execution, not just before it, and refuse approval/evidence if it moved.
  let inputsStable = true;
  try {
    const after = buildDirGiven ? digestBuildDir(resolve(projectDir, buildDirGiven)) : {};
    if (after.digest !== buildDigest || sha256Hex(readFileSync(inPath)) !== criteriaDigest) {
      inputsStable = false;
      problems.push("inputs changed during verification: build or criteria digest mismatch; re-verify immutable inputs");
    }
  } catch {
    inputsStable = false;
    problems.push("inputs unreadable after verification");
  }

  // Cross-check presented evidence against the live run: a hand-written exit
  // or output hash that disagrees with what the verifier just did is refused.
  if (evidence !== null && !evidenceStale) {
    const evResults = (evidence.results && typeof evidence.results === "object") ? evidence.results : {};
    for (const id of Object.keys(live.results).sort()) {
      const claimed = evResults[id];
      const got = live.results[id];
      if (got.kind === "judge") {
        if (claimed && String(claimed.status).toUpperCase() === "PASS") {
          problems.push("evidence refused: it claims PASS for NEEDS_JUDGE item " + id);
        }
        continue;
      }
      if (!claimed || typeof claimed !== "object") {
        problems.push("evidence refused: no sealed result for " + id);
        continue;
      }
      if (claimed.exit !== got.exit) {
        problems.push(
          "evidence refused: " + id + " records exit " + String(claimed.exit) +
            " but the verifier just exited " + String(got.exit)
        );
        continue;
      }
      if (claimed.outputSha256 !== got.outputSha256) {
        problems.push("evidence refused: " + id + " output does not match the live verifier run");
      }
    }
  }

  const judged = Object.keys(live.results).filter((id) => live.results[id].kind === "judge").sort();
  const writePath = opt("--write-evidence", evidencePath === null ? join(projectDir, "frontend.evidence.json") : null);
  if (writePath !== null && inputsStable && !evidenceStale) {
    const outAbs = resolve(cwd, writePath);
    const buildRelative = buildDirGiven ? relative(resolve(projectDir, buildDirGiven), outAbs) : "..";
    if (outAbs === inPath || outAbs === mdPath ||
        (approvalPath !== null && outAbs === resolve(cwd, approvalPath)) ||
        (buildRelative !== ".." && !buildRelative.startsWith("../") && !buildRelative.startsWith("..\\"))) {
      err("refusing: evidence output must be outside the build and may not overwrite criteria, reference or approval");
      return 1;
    }
    if (evidencePath !== null && resolve(cwd, evidencePath) === outAbs) {
      err("refusing: --evidence and --write-evidence name the same file");
      return 1;
    }
    const sealed = {
      version: 1,
      check: "frontend-foundations check.mjs",
      buildDir: buildDirGiven,
      buildDigest,
      criteriaDigest,
      buildFiles,
      createdAt: new Date().toISOString(),
      results: live.results,
    };
    try {
      writeFileSync(outAbs, JSON.stringify(sealed, null, 2) + "\n");
    } catch {
      err("cannot write " + writePath);
      return 1;
    }
  }

  if (problems.length > 0) {
    err(problems.join("\n"));
    const judgedNote = judged.length > 0
      ? (approvalOk ? " (" + judged.length + " judged by owner approval from " + approver + ")" : " (" + judged.length + " NEEDS_JUDGE)")
      : "";
    err(problems.length + " finding(s)" + judgedNote + " — build " + String(buildDigest).slice(0, 19) + ", criteria " + String(criteriaDigest).slice(0, 19));
    return 1;
  }
  for (const id of judged) {
    out(id + ": NEEDS_JUDGE (covered by explicit owner approval from " + approver + ")");
  }
  out(
    (judged.length === 0 ? "all 30 foundations decided and verified" :
      (30 - judged.length) + " verifiers passed; " + judged.length + " NEEDS_JUDGE covered by explicit owner approval") +
      " (build " + String(buildDigest).slice(0, 19) + ", " + buildFiles + " files; criteria " + String(criteriaDigest).slice(0, 19) + ")" +
      (approvalOk ? " + owner approval by " + approver : "")
  );
  return 0;
}
