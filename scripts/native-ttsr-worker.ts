#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { join } from "node:path";
import { OMP_SRC, loadRuleFile } from "./rule-class.ts";
const ttsr = await import(join(OMP_SRC, "export/ttsr.ts"));
const TtsrManager = ttsr.TtsrManager as new (settings?: Record<string, unknown>) => { addRule(rule: unknown): boolean; checkDelta(delta: string, context: Record<string, unknown>): unknown; checkSnapshot(snapshot: string, context: Record<string, unknown>): unknown; checkAstSnapshot?(snapshot: string, context: Record<string, unknown>): unknown };
const policy = JSON.parse(await Bun.file(join(import.meta.dir, "../policy/ttsr.json")).text()) as Record<string, unknown>;
const settings = { ...policy, enabled: true, disabledRules: [] };
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
	if (!line.trim()) continue;
	try {
		const request = JSON.parse(line) as { rulePath: string; snippet: string; source?: string; tool?: string; path?: string };
		const loaded = loadRuleFile(request.rulePath);
		const manager = new TtsrManager(settings);
		const registered = manager.addRule(loaded.rule);
		const source = request.source ?? "tool";
		const toolName = request.tool ?? "bash";
		const context = { source, toolName, streamKey: `toolcall:l9:${request.path ?? "-"}`, ...(request.path && request.path !== "-" ? { filePaths: [request.path, join(process.cwd(), request.path)] } : {}) };
		const wire = request.snippet;
		let matches: unknown[] = [];
		const final = registered ? await manager.checkSnapshot(wire, context) : [];
		if (Array.isArray(final)) matches = matches.concat(final);
		const ast = registered && source === "tool" && toolName !== "bash" ? await manager.checkAstSnapshot?.(wire, context) : [];
		if (Array.isArray(ast)) matches = matches.concat(ast);
		const fired = matches.some((entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === loaded.name);
		process.stdout.write(JSON.stringify({ fired }) + "\n");
	} catch (error) { process.stdout.write(JSON.stringify({ error: String(error) }) + "\n"); }
}
