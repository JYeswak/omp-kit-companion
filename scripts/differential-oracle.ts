#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
const repo = join(import.meta.dir, "..");
const caseFile = process.argv[2] ?? join(repo, "cases", "cases.tsv");
const rows = readFileSync(caseFile, "utf8").trimEnd().split("\n").slice(1).map(line => { const fields = line.split("\t"); return { rule: fields[0]!, expected: fields[1] === "fire" ? "fire" as const : "quiet" as const, source: fields[2]!, tool: fields[3]!, path: fields[4]!, snippet: fields[5]!.replaceAll("\\n", "\n") }; });
const worker = Bun.spawn([process.execPath, join(repo, "scripts", "native-ttsr-worker.ts")], { cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
for (const row of rows) worker.stdin.write(JSON.stringify({ rulePath: join(repo, "rules", `${row.rule}.md`), ...row }) + "\n"); await worker.stdin.end();
const native = (await new Response(worker.stdout).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { fired?: boolean; error?: string }); await new Response(worker.stderr).text(); await worker.exited;
const kitProc = Bun.spawnSync([process.execPath, join(repo, "scripts", "ttsr-harness.ts"), "--gate-json", "--rules", join(repo, "rules"), "--cases", caseFile], { cwd: repo, stdout: "pipe", stderr: "pipe" });
const kit = JSON.parse(kitProc.stdout.toString()) as { cases?: { rule: string; g2: "fire" | "quiet" }[] };
const known = new Map([[214, { bead: "ompkit-7ez", reason: "PI3: kit-test-skip native AST edit-path mismatch" }]]);
const allMismatches = (kit.cases ?? []).flatMap((row, index) => { const nativeResult = native[index]?.fired ? "fire" : "quiet"; const expected = rows[index]?.expected; return row.g2 !== nativeResult || nativeResult !== expected ? [{ index, rule: rows[index]?.rule, source: rows[index]?.source, tool: rows[index]?.tool, path: rows[index]?.path, snippet: rows[index]?.snippet, expected, native: nativeResult, kit: row.g2 }] : []; });
const knownMismatches = allMismatches.flatMap(m => known.has(m.index) ? [{ ...m, ...known.get(m.index)! }] : []);
const unexpectedMismatches = allMismatches.filter(m => !known.has(m.index));
const errors = native.filter(row => row.error).length;
const kitExit = kitProc.exitCode ?? 1;
console.log(JSON.stringify({ schema_version: 1, rows: rows.length, native_checked: native.length, worker_errors: errors, kit_exit: kitExit, known_mismatches: knownMismatches, unexpected_mismatches: unexpectedMismatches, status: errors === 0 && kitExit === 0 && unexpectedMismatches.length === 0 ? "PASS" : "FAIL" }));
process.exit(errors === 0 && kitExit === 0 && unexpectedMismatches.length === 0 ? 0 : 1);
