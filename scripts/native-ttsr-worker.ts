#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OMP_SRC, loadRuleFile } from "./rule-class.ts";
const ttsr = await import(join(OMP_SRC, "export/ttsr.ts"));
const TtsrManager = ttsr.TtsrManager as new (settings?: Record<string, unknown>) => { addRule(rule: unknown): boolean; checkDelta(delta: string, context: Record<string, unknown>): unknown; checkSnapshot(snapshot: string, context: Record<string, unknown>): unknown };
const policy = JSON.parse(await Bun.file(join(import.meta.dir, "../policy/ttsr.json")).text()) as Record<string, unknown>;
const settings = { ...policy, enabled: true, disabledRules: [] };
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
	if (!line.trim()) continue;
	try {
		const request = JSON.parse(line) as { rulePath: string; snippet: string };
		const loaded = loadRuleFile(request.rulePath);
		const manager = new TtsrManager(settings);
		const registered = manager.addRule(loaded.rule);
		const context = { source: "tool", toolName: "bash", streamKey: "toolcall:l9", command: request.snippet };
		let matches: unknown = registered ? manager.checkDelta(JSON.stringify({ command: request.snippet }), context) : [];
		matches = registered ? manager.checkSnapshot(JSON.stringify({ command: request.snippet }), context) : matches;
		const fired = Array.isArray(matches) && matches.some((entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === loaded.name);
		process.stdout.write(JSON.stringify({ fired }) + "\n");
	} catch (error) { process.stdout.write(JSON.stringify({ error: String(error) }) + "\n"); }
}
