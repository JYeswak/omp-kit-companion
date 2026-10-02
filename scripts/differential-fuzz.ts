#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const repo = join(import.meta.dir, "..");
const rule = process.argv.includes("--rule") ? process.argv[process.argv.indexOf("--rule") + 1] : "kit-no-pattern-kill";
const limit = Number(process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : 10_000);
const plant = process.argv.includes("--plant-divergence");
mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
const root = mkdtempSync(join(repo, "var", "agent-tmp", "l9-fuzz-"));
const rules = join(root, "rules"), caseFile = join(root, "cases.tsv");
mkdirSync(rules, { recursive: true });
const sourceRule = join(repo, "rules", `${rule}.md`);
const ruleText = await Bun.file(sourceRule).text();
writeFileSync(join(rules, `${rule}.md`), plant ? ruleText.replace("pkill", "never-match-planted-pkill") : ruleText);
function next(seed: number): number { return (seed * 1664525 + 1013904223) >>> 0; }
function command(seed: number): { seed: number; text: string } {
	seed = next(seed); const words = ["echo", "printf", "git status", "pkill -f 'bun test'", "grep -rl 'x' crates/*/Cargo.toml 2>/dev/null", "br close x"]; const word = words[seed % words.length]; seed = next(seed); const wrapper = seed % 5;
	if (wrapper === 0) return { seed, text: `echo \"${word}\"` }; if (wrapper === 1) return { seed, text: `echo \"$(${word})\"` }; if (wrapper === 2) return { seed, text: `FOO=1 ${word}` }; if (wrapper === 3) return { seed, text: `true; ${word}` }; return { seed, text: word };
}
function shrink(input: string, disagreement: (value: string) => boolean): string { let current = input; for (let width = Math.max(1, Math.floor(current.length / 2)); width > 0; width = Math.floor(width / 2)) { let changed = true; while (changed) { changed = false; for (let start = 0; start + width <= current.length; start += 1) { const candidate = current.slice(0, start) + current.slice(start + width); if (candidate && disagreement(candidate)) { current = candidate; changed = true; break; } } } } return current; }
async function nativeFires(snippet: string): Promise<boolean> { const child = Bun.spawn(["omp", "ttsr", "test", "--rule", sourceRule, "--source", "tool", "--tool", "bash", snippet, "--json"], { cwd: repo, stdout: "pipe", stderr: "pipe" }); const stdout = await new Response(child.stdout).text(); await new Response(child.stderr).text(); await child.exited; try { const report = JSON.parse(stdout) as { triggered?: unknown[] }; return Array.isArray(report.triggered) && report.triggered.some((entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === rule); } catch { return false; } }
const snippets: string[] = []; let seed = 0x9e3779b9; for (let i = 0; i < limit; i += 1) { const generated = command(seed); seed = generated.seed; snippets.push(generated.text); }
const native: boolean[] = []; const concurrency = 1024; for (let offset = 0; offset < snippets.length; offset += concurrency) { native.push(...await Promise.all(snippets.slice(offset, offset + concurrency).map(nativeFires))); }
const rows = snippets.map((snippet, index) => `${rule}\t${native[index] ? "fire" : "quiet"}\ttool\tbash\t-\t${snippet.replaceAll("\n", "\\n")}\tnative-${index}`); writeFileSync(caseFile, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n" + rows.join("\n") + "\n");
const kit = Bun.spawnSync([process.execPath, join(repo, "scripts", "ttsr-harness.ts"), "--gate-json", "--rules", rules, "--cases", caseFile], { cwd: repo, stdout: "pipe", stderr: "pipe" }); const gate = JSON.parse(kit.stdout.toString()) as { failures?: unknown[] }; const disagreements = gate.failures?.length ?? 0; const shrunk = disagreements ? shrink(snippets[0]!, value => value.includes("pkill") || value.includes("br close")) : null;
console.log(JSON.stringify({ schema_version: 1, rule, generated: limit, native_checked: native.length, kit_failures: disagreements, disagreements, first_shrunk: shrunk, planted_divergence: plant })); rmSync(root, { recursive: true, force: true }); process.exit(disagreements === 0 || plant ? 0 : 1);
