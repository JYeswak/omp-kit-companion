#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = join(import.meta.dir, "..");
const limit = Number(process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : 10_000);
const plant = process.argv.includes("--plant-divergence");
mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
const root = mkdtempSync(join(repo, "var", "agent-tmp", "l9-fuzz-"));
const rulesDir = join(root, "rules"), caseFile = join(root, "cases.tsv"); mkdirSync(rulesDir, { recursive: true });
const ruleNames = readdirSync(join(repo, "rules")).filter(name => name.endsWith(".md")).map(name => name.slice(0, -3)).sort();
for (const name of ruleNames) writeFileSync(join(rulesDir, `${name}.md`), await Bun.file(join(repo, "rules", `${name}.md`)).text());
if (plant) { const name = "kit-no-pattern-kill"; const path = join(rulesDir, `${name}.md`); writeFileSync(path, (await Bun.file(path).text()).replace("pkill", "never-match-planted-pkill")); }
const fireSeeds: Record<string, { source: string; tool: string; path: string; snippet: string }> = {};
for (const line of (await Bun.file(join(repo, "cases", "cases.tsv")).text()).split("\n").slice(1)) { const fields = line.split("\t"); if (fields[0] && fields[1] === "fire" && fields[0] !== "kit-standing-law" && fireSeeds[fields[0]] === undefined) fireSeeds[fields[0]] = { source: fields[2]!, tool: fields[3]!, path: fields[4]!, snippet: fields[5]!.replaceAll("\\n", "\n") }; }
let state = 0x9e3779b97f4a7c15n;
function splitmix64(): bigint { state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn; let z = state; z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn; z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn; return z ^ (z >> 31n); }
function generatedCommand(): string { const words = ["echo", "printf", "git status", "pkill -f 'bun test'", "grep -rl 'x' crates/*/Cargo.toml 2>/dev/null", "br close x"]; const word = words[Number(splitmix64() % BigInt(words.length))]!; const wrapper = Number(splitmix64() % 5n); if (wrapper === 0) return `echo \"${word}\"`; if (wrapper === 1) return `echo \"$(${word})\"`; if (wrapper === 2) return `FOO=1 ${word}`; if (wrapper === 3) return `true; ${word}`; return word; }
const cases: { rule: string; source: string; tool: string; path: string; snippet: string }[] = [];
for (const name of ruleNames) if (fireSeeds[name]) cases.push({ rule: name, ...fireSeeds[name]! });
while (cases.length < limit) { const rule = ruleNames[Number(splitmix64() % BigInt(ruleNames.length))]!; cases.push({ rule, source: "tool", tool: "bash", path: "-", snippet: generatedCommand() }); }
const sourceByRule: Record<string, string> = {}; for (const name of ruleNames) sourceByRule[name] = join(repo, "rules", `${name}.md`);
const worker = Bun.spawn([process.execPath, join(repo, "scripts", "native-ttsr-worker.ts")], { cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
for (const item of cases) worker.stdin.write(JSON.stringify({ rulePath: sourceByRule[item.rule], snippet: item.snippet, source: item.source, tool: item.tool, path: item.path }) + "\n"); await worker.stdin.end();
const nativeLines = (await new Response(worker.stdout).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { fired?: boolean; error?: string }); await new Response(worker.stderr).text(); await worker.exited;
const rows = cases.map((item, index) => `${item.rule}\t${nativeLines[index]?.fired ? "fire" : "quiet"}\t${item.source}\t${item.tool}\t${item.path}\t${item.snippet}\tnative-${index}`); writeFileSync(caseFile, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n" + rows.join("\n") + "\n");
const kit = Bun.spawnSync([process.execPath, join(repo, "scripts", "ttsr-harness.ts"), "--gate-json", "--rules", rulesDir, "--cases", caseFile], { cwd: repo, stdout: "pipe", stderr: "pipe" }); const gate = JSON.parse(kit.stdout.toString()) as { failures?: unknown[]; cases?: { rule: string; g2: "fire" | "quiet" }[] };
const nativeCounts: Record<string, number> = {}, kitCounts: Record<string, number> = {}; for (const name of ruleNames) { nativeCounts[name] = 0; kitCounts[name] = 0; } for (let i = 0; i < cases.length; i += 1) if (nativeLines[i]?.fired) nativeCounts[cases[i]!.rule] += 1; for (const row of gate.cases ?? []) if (row.g2 === "fire") kitCounts[row.rule] += 1;
const zeroNative = ruleNames.filter(name => fireSeeds[name] && nativeCounts[name] === 0); const disagreements = gate.failures?.length ?? 0;
console.log(JSON.stringify({ schema_version: 1, generated: limit, rules: ruleNames.length, native_checked: nativeLines.length, worker_errors: nativeLines.filter(line => line.error).length, native_fire_counts: nativeCounts, kit_fire_counts: kitCounts, zero_native_rules: zeroNative, disagreements, planted_divergence: plant }));
rmSync(root, { recursive: true, force: true }); process.exit(disagreements === 0 && zeroNative.length === 0 ? 0 : plant && zeroNative.length === 0 ? 0 : 1);
