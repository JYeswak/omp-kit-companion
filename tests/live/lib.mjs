// JSON-side helpers for scripts/e2e-live.sh (G4). The shell owns processes; this owns parsing.
//
//   bun lib.mjs coverage <rulesDir>          every managed rule has the scenarios its class needs
//   bun lib.mjs select full|plant            scenario indices to run, one per line
//   bun lib.mjs name <i>                     scenario id
//   bun lib.mjs prep <i> <outFile>           write the mock's {turns, chunk} file
//   bun lib.mjs verdict <i> <log> <proj> <ompExit>   print "ok" or "FAIL: ..."
//   bun lib.mjs probe <i> <log>              print PROBE omp-late-interrupt: continued|aborted (never fails)
//   bun lib.mjs config <policy.json> <out>   isolated-HOME config.yml
//   bun lib.mjs models <port> <out>          isolated-HOME models.yml pointing at the mock
//   bun lib.mjs plant <ruleFile>             overwrite kit-close-needs-evidence with the baseline condition
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const scenarios = JSON.parse(fs.readFileSync(path.join(HERE, "scenarios.json"), "utf8"));
const [cmd, ...args] = process.argv.slice(2);

// The pre-fix condition that fired on the streamed prefix `{"command":"br close` of an evidenced close.
const BASELINE_CLOSE = String.raw`'\b(br|bd)\s+close\b(?![^\n]*(--reason|-r)\s)'`;

/** Every string under `v`, depth-first. */
function strings(v, out = []) {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
	return out;
}
const isSystem = m => m.role === "system" || m.role === "developer";

async function coverage(rulesDir) {
	// Loaded here, not at the top: rule-class.ts imports omp's parser (~0.3 s), and every other
	// subcommand runs several times per scenario without needing it.
	const { loadRules } = await import("../../scripts/rule-class.ts");
	const errs = [];
	const rows = [];
	const { guardName } = await import("./admission-extension.mjs");
	const rules = [
		...loadRules(rulesDir).map(rule => ({ ...rule, backend: "ttsr" })),
		{ name: guardName, cls: "tripwire", backend: "admission" },
	];
	for (const { name, cls, backend } of rules) {
		const mine = scenarios.filter(s => s.rule === name && (s.backend ?? "ttsr") === backend && !s.plant);
		const kinds = mine.map(s => s.kind);
		for (const s of mine) if (s.class !== cls) errs.push(`${s.id}: declares class ${s.class}, omp's parsed rule says ${cls}`);
		if (cls === "always") {
			if (!kinds.includes("system")) errs.push(`${name}: no system-prompt scenario`);
		} else {
			if (!kinds.some(k => k === "fire" || k === "repeat")) errs.push(`${name}: no fire scenario`);
			if (!kinds.includes("near-miss")) errs.push(`${name}: no near-miss scenario`);
		}
		for (const s of mine.filter(s => s.kind === "fire" || s.kind === "repeat")) {
			const e = s.expect;
			const blocked = e.marker === "absent" || (e.files_absent ?? []).length > 0;
			const ran = e.marker === "present" || (e.files_present ?? []).length > 0;
			if (cls === "tripwire" && !blocked) errs.push(`${s.id}: tripwire fire must assert the action did not run`);
			if (cls !== "tripwire" && !ran) errs.push(`${s.id}: ${cls} fire must assert the action ran`);
			if (backend === "ttsr" && !(name in (e.rules ?? {}))) errs.push(`${s.id}: fire scenario does not expect ${name}`);
			if (backend === "admission" && e.admission?.refused !== true) errs.push(`${s.id}: admission fire must expect a bound refusal`);
		}
		for (const s of mine.filter(s => s.kind === "near-miss")) {
			if (name in (s.expect.rules ?? {})) errs.push(`${s.id}: near-miss expects its own rule`);
		}
		rows.push(`${backend.padEnd(9)} ${cls.padEnd(9)} ${name.padEnd(32)} ${kinds.join(",")}`);
	}
	const known = new Set(rules.map(r => `${r.backend}:${r.name}`));
	for (const s of scenarios) if (!known.has(`${s.backend ?? "ttsr"}:${s.rule}`)) errs.push(`${s.id}: backend/rule ${s.backend ?? "ttsr"}/${s.rule} is not registered`);
	const ids = scenarios.map(s => s.id);
	for (const id of ids) if (ids.indexOf(id) !== ids.lastIndexOf(id)) errs.push(`duplicate scenario id ${id}`);
	const byClass = {};
	for (const s of scenarios.filter(s => !s.plant)) {
		byClass[s.class] ??= {};
		byClass[s.class][s.kind] = (byClass[s.class][s.kind] ?? 0) + 1;
	}
	console.log(rows.join("\n"));
	console.log(
		`classes: ${Object.entries(byClass)
			.map(([c, k]) => `${c}{${Object.entries(k).map(([a, b]) => `${a}=${b}`).join(" ")}}`)
			.join(" ")}`,
	);
	if (errs.length) {
		console.log(`coverage FAIL:\n  ${errs.join("\n  ")}`);
		process.exit(1);
	}
	console.log(`coverage ok: ${rules.length} rules, ${scenarios.length} scenarios`);
}
function toolResultFailures(messages, expected) {
	// A model's scripted prose is not a command result; require a real tool-call binding.
	const result = messages.filter(m => m.role === "tool").at(-1);
	if (typeof result?.tool_call_id !== "string" || result.tool_call_id.length === 0) {
		return ["tool result is not bound to a bash call"];
	}
	const failures = [];
	const calls = messages.filter(m => m.role === "assistant").flatMap(m => m.tool_calls ?? []);
	const call = calls.find(c => c.id === result.tool_call_id && c.function?.name === "bash");
	let args;
	try {
		args = JSON.parse(call?.function?.arguments ?? "");
	} catch {
		failures.push("tool command arguments are not JSON");
	}
	if (args?.command !== expected.command) failures.push("tool command did not match " + expected.command);
	if (typeof result?.content !== "string" || result.isError === true || /Command exited with code [1-9]\d*/.test(result.content)) {
		failures.push(`tool result did not show ok=${expected.ok} action=${expected.action}`);
		return failures;
	}
	try {
		const payload = JSON.parse(result.content.split(/\r?\n/, 1)[0]);
		if (payload.ok !== expected.ok || payload.data?.action !== expected.action) {
			failures.push(`tool result did not show ok=${expected.ok} action=${expected.action}`);
		}
	} catch {
		failures.push("tool result is not JSON from the selected bash call");
	}
	return failures;
}

function admissionFailures(messages, scenario) {
	const expected = scenario.turns.find(turn => turn.tool)?.tool;
	const calls = messages.filter(message => message.role === "assistant").flatMap(message => message.tool_calls ?? []);
	const matching = calls.filter(call => {
		try { return call.function?.name === expected?.name && isDeepStrictEqual(JSON.parse(call.function.arguments), expected.args); }
		catch { return false; }
	});
	if (matching.length !== 1) return ["native admission call did not match the original tool and arguments exactly once"];
	const result = messages.find(message => message.role === "tool" && message.tool_call_id === matching[0].id);
	if (typeof result?.content !== "string") return ["native admission result is not bound to the original tool call"];
	const refused = result.content.startsWith(`fleet-guard ${scenario.rule}: `);
	if (refused !== scenario.expect.admission.refused) return ["native admission refusal disagrees with the expected action"];
	if (!refused && (result.isError === true || !result.content.includes("Successfully wrote")))
		return ["native admission quiet case did not return a successful write result"];
	return [];
}

function verdict(i, log, proj, ompExit) {
	const s = scenarios[i];
	const e = s.expect;
	const errs = [];
	if (ompExit === "124" || ompExit === "137") errs.push(`omp timed out (exit ${ompExit})`);
	if (!fs.existsSync(log)) return console.log("FAIL: omp never called the model");
	const reqs = fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map(l => JSON.parse(l))
		.filter(r => r.main);
	const minReq = e.min_requests ?? 2;
	if (reqs.length < minReq) errs.push(`${reqs.length} model request(s), want >=${minReq}`);
	if (reqs.length === 0) return console.log(`FAIL: ${errs.join("; ")}`);

	const system = strings(reqs[0].body.messages.filter(isSystem)).join("\n");
	for (const want of e.system_contains ?? []) {
		if (!system.includes(want)) errs.push(`system prompt lacks ${JSON.stringify(want)}`);
	}

	// The transcript omp sent back on its last call: every non-system message, decoded.
	const transcript = strings(reqs.at(-1).body.messages.filter(m => !isSystem(m))).join("\n");
	const named = {};
	for (const m of transcript.matchAll(/rule="([^"]+)"/g)) named[m[1]] = (named[m[1]] ?? 0) + 1;
	const want = e.rules ?? {};
	for (const [r, min] of Object.entries(want)) {
		if ((named[r] ?? 0) < min) errs.push(`rule ${r} named ${named[r] ?? 0}x, want >=${min}`);
	}
	for (const [r, c] of Object.entries(named)) {
		if (!(r in want)) errs.push(`unexpected rule ${r} named ${c}x`);
	}
	for (const t of e.transcript_contains ?? []) {
		if (!transcript.includes(t)) errs.push(`transcript lacks ${JSON.stringify(t)}`);
	}
	if (e.tool_result_json) errs.push(...toolResultFailures(reqs.at(-1).body.messages, e.tool_result_json));
	if (e.admission) errs.push(...admissionFailures(reqs.at(-1).body.messages, s));

	const marker = path.join(proj, `.ran_${s.id}`);
	if (e.marker === "present" && !fs.existsSync(marker)) errs.push(`marker .ran_${s.id} absent: the command did not run`);
	if (e.marker === "absent" && fs.existsSync(marker)) errs.push(`marker .ran_${s.id} present: the command ran`);
	for (const f of e.files_absent ?? []) if (fs.existsSync(path.join(proj, f))) errs.push(`${f} was written`);
	for (const f of e.files_present ?? []) if (!fs.existsSync(path.join(proj, f))) errs.push(`${f} was not written`);
	for (const [f, content] of Object.entries(e.file_contents ?? {})) {
		const target = path.join(proj, f);
		if (!fs.existsSync(target)) errs.push(f + " was not written");
		else if (fs.readFileSync(target, "utf8") !== content) errs.push(f + " changed unexpectedly");
	}
	console.log(errs.length ? `FAIL: ${errs.join("; ")}` : "ok");
}

switch (cmd) {
	case "coverage":
		await coverage(args[0]);
		break;
	case "select":
		scenarios.forEach((s, i) => {
			if (args[0] === "plant" ? s.plant : !s.plant) console.log(i);
		});
		break;
	case "name":
		console.log(scenarios[Number(args[0])].id);
		break;
	case "prep": {
		const s = scenarios[Number(args[0])];
		if (s.backend === "admission") {
			const project = args[2];
			if (!project) throw new Error("native admission fixture requires the actual project root");
			fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(project, ".omp", "fleet.json"), '{"enabled":true}\n');
			const scratch = path.join(project, "var", "agent-tmp", "probe");
			fs.mkdirSync(scratch, { recursive: true });
			fs.writeFileSync(path.join(scratch, ".owner"), `pid=${process.pid}\nlabel=probe\nrepo=${project}\ncreated=${new Date().toISOString()}\n`);
			const env = { ...process.env };
			for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
			Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
			for (const [sourcePath, content] of Object.entries(s.indexed_sources ?? {})) {
				const hash = execFileSync("git", ["-C", project, "hash-object", "-w", "--stdin", "--no-filters"], { env, input: content, encoding: "utf8" }).trim();
				execFileSync("git", ["-C", project, "update-index", "--add", "--cacheinfo", `100644,${hash},${sourcePath}`], { env });
			}
		}
		fs.writeFileSync(args[1], JSON.stringify({ turns: s.turns, chunk: s.chunk ?? 6 }));
		break;
	}
	case "verdict":
		verdict(Number(args[0]), args[1], args[2], args[3]);
		break;
	case "probe": {
		// Report-only OMP race probe: continued iff the scenario rule was named in the
		// last transcript. Never fails: unreadable input is an aborted observation, not a gate failure.
		let outcome = "aborted";
		const s = scenarios[Number(args[0])];
		try {
			if (!s || typeof s.rule !== "string") throw new Error("unknown probe scenario");
			const rows = fs.readFileSync(args[1], "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.main);
			const last = rows.at(-1);
			if (last) {
				const transcript = strings(last.body.messages.filter(m => !isSystem(m))).join("\n");
				const named = {};
				for (const m of transcript.matchAll(/rule="([^"]+)"/g)) named[m[1]] = (named[m[1]] ?? 0) + 1;
				if ((named[s.rule] ?? 0) >= 1) outcome = "continued";
			}
		} catch { /* report-only: keep aborted */ }
		console.log(`PROBE omp-late-interrupt: ${outcome}`);
		break;
	}
	case "config": {
		const t = JSON.parse(fs.readFileSync(args[0], "utf8"));
		const lines = ["ttsr:"];
		for (const [k, v] of Object.entries(t)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
		lines.push("memory:", '  backend: "off"', "");
		fs.writeFileSync(args[1], lines.join("\n"));
		break;
	}
	case "models":
		fs.writeFileSync(
			args[1],
			[
				"providers:",
				"  mock:",
				`    baseUrl: http://127.0.0.1:${args[0]}/v1`,
				"    apiKey: sk-mock",
				"    api: openai-completions",
				"    models:",
				"      - id: mock",
				"        name: mock",
				"        supportsTools: true",
				"        contextWindow: 128000",
				"        maxTokens: 4096",
				"",
			].join("\n"),
		);
		break;
	case "plant": {
		const f = args[0];
		const text = fs.readFileSync(f, "utf8");
		const next = text.replace(/^condition:.*\n(?:[ \t]+- .*\n)*/m, `condition: ${BASELINE_CLOSE}\n`);
		if (next === text) {
			console.error(`plant: no condition block in ${f}`);
			process.exit(1);
		}
		fs.writeFileSync(f, next);
		break;
	}
	default:
		console.error(`unknown command ${cmd}`);
		process.exit(2);
}
