#!/usr/bin/env node
// Writes a project's frontend.foundations.json from references/foundations.md.
// Every foundation starts decided ("default") with either a verifier command
// the project must implement (verifiers/<ID>.mjs) or a human judge note.
// `omp-kit frontend check` re-runs the verifiers; only actual exits count.
// Usage: node init.mjs [--in foundations.md] [--out frontend.foundations.json] [--build-dir dist] [--force]
// Node built-ins only.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const force = args.includes("--force");
const inPath = resolve(process.cwd(), opt("--in", join(here, "../references/foundations.md")));
const outPath = resolve(process.cwd(), opt("--out", "frontend.foundations.json"));
const buildDir = opt("--build-dir", "dist");

if (existsSync(outPath) && !force) {
  console.error("refusing: " + outPath + " exists (pass --force to overwrite)");
  process.exit(1);
}

let md;
try {
  md = readFileSync(inPath, "utf8");
} catch {
  console.error("cannot read " + inPath);
  process.exit(1);
}

const rows = [];
for (const line of md.split("\n")) {
  // Cells never cross a pipe, so negated classes keep this linear (regexploit:
  // no repeated span may sit beside what follows it). Trim in code, not in pattern.
  const m = line.match(/^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/);
  if (!m) continue;
  const cells = m.slice(1, 6).map((c) => c.trim());
  if (!/^F\d+$/.test(cells[0])) continue;
  rows.push({ id: cells[0], name: cells[1], question: cells[2], deflt: cells[3], verifier: cells[4] });
}
if (rows.length === 0) {
  console.error("no checklist rows parsed from " + inPath);
  process.exit(1);
}

// A verifier text that starts UNVERIFIED, or that demands owner accept, is a
// human judgment, not a command: record the judge note so check reports
// NEEDS_JUDGE instead of pretending a command ran.
function judgeReason(verifierText) {
  const text = verifierText.toLowerCase();
  return ["unverified", "owner accept", "critic", "review", "walkthrough"].some((term) => text.includes(term))
    ? verifierText : null;
}

const foundations = {};
let judges = 0;
for (const r of rows) {
  const entry = { choice: "default" };
  const judge = judgeReason(r.verifier);
  if (judge !== null) {
    entry.judge = judge;
    judges++;
  } else {
    entry.verifier = { argv: ["node", "verifiers/" + r.id + ".mjs"], timeoutMs: 15000 };
  }
  entry.name = r.name;
  entry.default = r.deflt;
  foundations[r.id] = entry;
}

const doc = {
  version: 2,
  generatedBy: "frontend-foundations init.mjs",
  source: "references/foundations.md",
  buildDir,
  note: "omp-kit frontend check runs each verifier.argv itself (argv, bounded time, no shell) and binds results to buildDir + this file. Implement every verifiers/<ID>.mjs as an executable exiting 0/1 with deterministic stdout, or replace its verifier with a judge note. Legacy evidence/status fields are never trusted.",
  foundations,
};
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log("wrote " + outPath + " (" + rows.length + " foundations, all default; " + judges + " NEEDS_JUDGE, " + (rows.length - judges) + " verifier commands to implement, buildDir " + buildDir + ")");
