import { afterAll, expect, test } from "bun:test";
import { captureMineReplay, readMineReplay } from "../../src/mine-replay.ts";
import { cpSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import policy from "../../src/secret-output-policy.v1.json";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fingerprintOfSecret, redactBindingFields, scrubText } from "../../extensions/secret-output-guard.ts";
import { checkPackagedExtensionLoads } from "../../scripts/package-release.ts";
import { runFixture, runFixtureAsync } from "./fixture-process.ts";

const scratch = ownedTmp("mine-replay-policy");
afterAll(() => scratch.cleanup());
const repository = resolve(import.meta.dir, "../..");

const sentinel = `ghp_${"7cX9".repeat(10)}`;

test("mine replay retains ordinary inputs without inventing absent context", () => {
	const replay = captureMineReplay({ tool: "bash", arguments: { command: "echo ordinary" }, cwd: "/repo" });
	expect(replay.arguments).toEqual({ command: "echo ordinary" });
	expect(replay.redacted).toBe(false);
	expect(replay.truncated).toBe(false);
	expect(replay.missing).toEqual(["staged_paths", "diff_sha256", "message", "custody"]);
	expect(replay.message).toBeNull();
});

test("mine replay scrubs full credential and binding values before prefix bounding", () => {
	const replay = captureMineReplay({ tool: "bash", arguments: { command: `echo ${sentinel}${"x".repeat(70000)}`, registration_token: "opaque-low-entropy", ordinary: "keep me" } });
	expect(replay.redacted).toBe(true);
	expect(replay.truncated).toBe(true);
	expect(JSON.stringify(replay)).not.toContain(sentinel);
	expect(JSON.stringify(replay)).not.toContain("opaque-low-entropy");
	expect((replay.arguments as Record<string, unknown>).ordinary).toBe("keep me");
});

test("mine replay bounds escaped multibyte aggregate objects and marks omitted data", () => {
	const replay = captureMineReplay({ tool: "bash", arguments: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key-${i}`, "\u0000🧪".repeat(6000)])), message: "m".repeat(9000) });
	expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThanOrEqual(32768);
	expect(replay.truncated).toBe(true);
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	expect(captureMineReplay({ arguments: cyclic }).truncated).toBe(true);
});

test("readMineReplay rescreens untrusted disk and preserves prior loss flags", () => {
	const replay = captureMineReplay({ tool: "read", arguments: { path: "ordinary" } });
	const retained = readMineReplay({ ...replay, redacted: false, truncated: true, arguments: { registration_token: "disk-binding-value", token: sentinel } });
	expect(retained?.redacted).toBe(true);
	expect(retained?.truncated).toBe(true);
	expect(JSON.stringify(retained)).not.toContain("disk-binding-value");
	expect(JSON.stringify(retained)).not.toContain(sentinel);
	expect(readMineReplay({ ...replay, version: 2 })).toBeNull();
	expect(readMineReplay({ ...replay, staged_paths: [7] })).toBeNull();
});

test("readMineReplay keeps source flags and missing claims even when retained fields look complete", () => {
	const replay = captureMineReplay({ tool: "read", arguments: {}, cwd: "/repo", staged_paths: [], diff_sha256: "a".repeat(64), message: "m", custody: { status: "UNAVAILABLE" } });
	const read = readMineReplay({ ...replay, redacted: true, truncated: true, missing: ["message"] });
	expect(read?.redacted).toBe(true);
	expect(read?.truncated).toBe(true);
	expect(read?.missing).toContain("message");
});

test("canonical secret policy baseline matches pre-extraction regex sources flags and binding keys", () => {
	const source = readFileSync(new URL("../../extensions/secret-output-guard.ts", import.meta.url), "utf8");
	const expected = {
		GH_CLASSIC: { pattern: String.raw`\bgh[po]_[A-Za-z0-9]{8,}`, flags: "g" },
		GH_FINE_GRAINED: { pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{8,}`, flags: "g" },
		HOSTS_OAUTH_TOKEN: { pattern: String.raw`^([ \t]*oauth_token[ \t]*:[ \t]*)(\S+)[ \t]*$`, flags: "gm" },
		SECURITY_PASSWORD: { pattern: String.raw`(password[ \t]*:[ \t]*)(?:"[^"\n]*"|'[^'\n]*')`, flags: "g" },
	};
	expect(policy.patterns).toEqual(expected);
	for (const [name, spec] of Object.entries(expected)) {
		const declaration = source.split("\n").find(line => line.startsWith(`const ${name} = /`));
		if (!declaration) {
			expect(source).toContain(`const ${name} = policyPattern("${name}")`);
			continue;
		}
		// Trusted repository regex literal, not input data; compare real native .source/.flags.
		const literal = declaration.slice(declaration.indexOf(" = ") + 3).replace(/;$/, "");
		const old = new Function(`return (${literal})`)() as RegExp;
		expect(spec).toEqual({ pattern: old.source, flags: old.flags });
	}
	expect(policy.binding_keys).toEqual(["registration_token", "sender_token", "bearer_token", "session_token", "access_token", "refresh_token", "auth_token"]);
	if (source.includes("const BINDING_KEYS: Record<string, true> = {")) {
		const block = source.split("const BINDING_KEYS: Record<string, true> = {")[1]!.split("};")[0]!;
		const keys = block.split("\n").map(line => line.trim()).filter(line => line.endsWith(": true,")).map(line => line.slice(0, -7));
		expect(policy.binding_keys).toEqual(keys);
	}
});

test("canonical secret policy TS Python parity screens the same complete synthetic values", async () => {
	const values = ["ordinary text", "ghp_12345678", "github_pat_12345678", 'password: "opaque-value"', "oauth_token: opaque-value", "oauth_token: opaque\u0085value", "oauth_token: opaque-value\r\n", "Ωghp_abcdef123456", "oauth_token: secret\ufefftail", sentinel, "ghp_1234567", "xghp_12345678", `${"x".repeat(70000)} ghp_1234567`];
	const started = performance.now();
	const expected = values.map(value => scrubText(value));
	expect(performance.now() - started).toBeLessThan(5000);
	const result = await runFixtureAsync(["python3", "-c",
		"import json,sys; sys.path.insert(0,sys.argv[1]); from gate_event_replay import ScrubPolicy; policy=ScrubPolicy()\nif sys.stdin.isatty(): raise RuntimeError('PIPE_INPUT_REQUIRED')\nprint(json.dumps([policy.scrub(value) for value in json.load(sys.stdin)]))",
		resolve(import.meta.dir, "../../scripts")], { cwd: repository, stdin: Buffer.from(JSON.stringify(values)) });
	if (result.rc !== 0) throw new Error(`Python scrub parity failed: ${Buffer.from(result.stderr).toString()}`);
	expect(result.rc).toBe(0);
	expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual(expected);
	const input = { registration_token: "opaque-value", ordinary: "keep" };
	const binding = await runFixtureAsync(["python3", "-c",
		"import json,sys; sys.path.insert(0,sys.argv[1]); from gate_event_replay import CredentialScreen,capture\nif sys.stdin.isatty(): raise RuntimeError('PIPE_INPUT_REQUIRED')\nprint(json.dumps(capture({'arguments':json.load(sys.stdin)},CredentialScreen())['arguments']))",
		resolve(import.meta.dir, "../../scripts")], { cwd: repository, stdin: Buffer.from(JSON.stringify(input)) });
	if (binding.rc !== 0) throw new Error(`Python binding parity failed: ${Buffer.from(binding.stderr).toString()}`);
	expect(binding.rc).toBe(0);
	expect(JSON.parse(Buffer.from(binding.stdout).toString())).toEqual(redactBindingFields(input));
});

test("canonical secret policy missing invalid and delete-pattern mutation never emits raw values in TS or Python", () => {
	for (const mode of ["missing", "invalid", "delete-pattern", "delete-replay-pattern", "delete-secret-flags"]) {
		const root = join(scratch.path, mode);
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "extensions"));
		cpSync(resolve(import.meta.dir, "../../extensions/secret-output-guard.ts"), join(root, "extensions/secret-output-guard.ts"));
		let changed: unknown = null;
		if (mode === "invalid") changed = { schema_version: "invalid" };
		if (mode === "delete-pattern") {
			const mutant = structuredClone(policy);
			delete (mutant.patterns as Partial<typeof mutant.patterns>).GH_CLASSIC;
			changed = mutant;
		}
		if (mode === "delete-replay-pattern") {
			const mutant = structuredClone(policy);
			delete (mutant.replay_patterns as Partial<typeof mutant.replay_patterns>).GENERIC_ASSIGNMENT;
			changed = mutant;
		}
		if (mode === "delete-secret-flags") {
			const mutant = structuredClone(policy);
			Reflect.deleteProperty(mutant, "secret_flags");
			changed = mutant;
		}
		const policyPath = join(root, "src/secret-output-policy.v1.json");
		if (changed !== null) writeFileSync(policyPath, JSON.stringify(changed));
		const ts = runFixture([process.execPath, "-e", "import {scrubText} from './extensions/secret-output-guard.ts'; process.stdout.write(scrubText('ghp_12345678'));"],
			{ cwd: root });
		if (ts.rc === 0) throw new Error(`TS invalid-policy probe unexpectedly passed: ${Buffer.from(ts.stderr).toString()}`);
		expect(ts.rc).not.toBe(0);
		expect(Buffer.from(ts.stdout).toString()).not.toContain("ghp_12345678");
		const py = runFixture(["python3", "-c",
			"import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from gate_event_replay import ScrubPolicy; print(ScrubPolicy(Path(sys.argv[2])).scrub('ghp_12345678'))",
			resolve(import.meta.dir, "../../scripts"), policyPath], { cwd: repository });
		if (py.rc === 0) throw new Error(`Python invalid-policy probe unexpectedly passed: ${Buffer.from(py.stderr).toString()}`);
		expect(py.rc).not.toBe(0);
		expect(Buffer.from(py.stdout).toString()).not.toContain("ghp_12345678");
	}
});

test("canonical replay assignment baseline matches old full-test-runner native regex", () => {
	const source = readFileSync(new URL("../../src/full-test-runner.ts", import.meta.url), "utf8");
	const spec = policy.replay_patterns.GENERIC_ASSIGNMENT;
	const expected = String.raw`(\b(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;"'<>]+)`;
	expect(spec).toEqual({ pattern: expected, flags: "gi" });
	const line = source.split("\n").find(line => line.includes(String.raw`authorization|proxy-authorization|api[_-]?key`));
	if (line) {
		const literal = line.slice(line.indexOf("/"), line.lastIndexOf(", "));
		const old = new Function(`return (${literal})`)() as RegExp;
		expect(spec).toEqual({ pattern: old.source, flags: old.flags });
	} else {
		expect(source).toContain('.replace(REPLAY_GENERIC_ASSIGNMENT, "$1<redacted>")');
	}
});

test("canonical replay assignment policy redacts low-entropy keyed and textual secrets before bounding", async () => {
	const secret = "low-entropy-fixture-value";
	const replay = captureMineReplay({ tool: "bash", arguments: { api_key: secret, command: `echo ordinary api_key="${secret}"` }, message: `password=${secret}` });
	expect(JSON.stringify(replay)).not.toContain(secret);
	expect(replay.redacted).toBe(true);
	expect((replay.arguments as Record<string, unknown>).command).toContain("echo ordinary");
	const python = await runFixtureAsync(["python3", "-c",
		"import json,sys; sys.path.insert(0,sys.argv[1]); from gate_event_replay import CredentialScreen,capture\nif sys.stdin.isatty(): raise RuntimeError('PIPE_INPUT_REQUIRED')\nprint(json.dumps(capture(json.load(sys.stdin),CredentialScreen())))",
		resolve(import.meta.dir, "../../scripts")], { cwd: repository, stdin: Buffer.from(JSON.stringify({ tool: "bash", arguments: { api_key: secret, command: `echo ordinary api_key="${secret}"` }, message: `password=${secret}` })) });
	if (python.rc !== 0) throw new Error(`Python replay parity failed: ${Buffer.from(python.stderr).toString()}`);
	expect(python.rc).toBe(0);
	expect(Buffer.from(python.stdout).toString()).not.toContain(secret);
	expect(JSON.parse(Buffer.from(python.stdout).toString()).redacted).toBe(true);
	expect(JSON.parse(Buffer.from(python.stdout).toString()).arguments).toEqual(replay.arguments);
	expect(JSON.parse(Buffer.from(python.stdout).toString()).message).toEqual(replay.message);
});

test("current package ship list includes replay dependencies and staged guard refuses missing policy JSON", () => {
	const source = readFileSync(new URL("../../scripts/package-release.ts", import.meta.url), "utf8");
	const opener = "const files = ";
	const start = source.indexOf(`${opener}[`);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("];", start);
	expect(end).toBeGreaterThan(start);
	// Trusted current packager data declaration, not HEAD's archived source.
	const files: unknown = new Function(`return (${source.slice(start + opener.length, end + 1)})`)();
	expect(Array.isArray(files)).toBe(true);
	for (const file of ["scripts/gate_event_replay.py", "src/cc-credential-shapes.v1.json", "src/secret-output-policy.v1.json"]) {
		expect(files).toContain(file);
	}
	const root = join(scratch.path, "current-package-policy");
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(join(root, "src"));
	for (const file of ["extensions/secret-output-guard.ts", "src/secret-output-policy.v1.json"]) {
		cpSync(resolve(import.meta.dir, "../..", file), join(root, file));
	}
	expect(checkPackagedExtensionLoads(root)).toEqual([]);
	unlinkSync(join(root, "src/secret-output-policy.v1.json"));
	const failures = checkPackagedExtensionLoads(root);
	expect(failures.map(failure => failure.file)).toEqual(["extensions/secret-output-guard.ts"]);
	expect(failures[0]?.error).toContain("secret-output-policy.v1.json");
});

test("canonical JS Python translation distinguishes class carets escaped carets and real anchors", async () => {
	const cases = [
		{ name: "class-caret", pattern: String.raw`^([ \t]*oauth_token[ \t]*:[ \t]*)([^\s]+)[ \t]*$`,
			values: ["oauth_token: opaque\u0085tail", "oauth_token: opaque value"] },
		{ name: "escaped-caret", pattern: String.raw`^([ \t]*oauth_token[ \t]*:[ \t]*\^)(\S+)[ \t]*$`,
			values: ["oauth_token: ^opaque-value", "oauth_token: opaque-value"] },
		{ name: "real-anchors", pattern: policy.patterns.HOSTS_OAUTH_TOKEN.pattern,
			values: ["prefix\n oauth_token: opaque-value\r\nsuffix", "prefix oauth_token: opaque-value suffix"] },
	];
	for (const item of cases) {
		const fixture = structuredClone(policy);
		fixture.patterns.HOSTS_OAUTH_TOKEN = { pattern: item.pattern, flags: "gm" };
		const path = join(scratch.path, `${item.name}.json`);
		writeFileSync(path, JSON.stringify(fixture));
		const native = new RegExp(item.pattern, "gm");
		const expected = item.values.map(value => value.replace(native, (_match, prefix: string, secret: string) => `${prefix}fp:${fingerprintOfSecret(secret)}`));
		expect(expected[0]).not.toBe(item.values[0]);
		expect(expected[1]).toBe(item.values[1]);
		const child = await runFixtureAsync(["python3", "-c",
			"import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from gate_event_replay import ScrubPolicy; policy=ScrubPolicy(Path(sys.argv[2]))\nif sys.stdin.isatty(): raise RuntimeError('PIPE_INPUT_REQUIRED')\nprint(json.dumps([policy.scrub(value) for value in json.load(sys.stdin)]))",
			resolve(import.meta.dir, "../../scripts"), path], { cwd: repository, stdin: Buffer.from(JSON.stringify(item.values)) });
		if (child.rc !== 0) throw new Error(`Python ${item.name} parity failed: ${Buffer.from(child.stderr).toString()}`);
		expect(child.rc).toBe(0);
		expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual(expected);
	}
});

const secretFlagCases = [
	{ argv: ["--api-key", "short-test-value"], expected: ["--api-key", "[REDACTED]"] },
	{ argv: ["--password", "x"], expected: ["--password", "[REDACTED]"] },
	{ argv: ["-p", "x"], expected: ["-p", "[REDACTED]"] },
	{ argv: ["--token", "x"], expected: ["--token", "[REDACTED]"] },
	{ argv: ["--api-key=short-test-value"], expected: ["--api-key=[REDACTED]"] },
	{ argv: ["--password=x"], expected: ["--password=[REDACTED]"] },
	{ argv: ["--token=x"], expected: ["--token=[REDACTED]"] },
	{ argv: ["-px"], expected: ["-p[REDACTED]"] },
	{ argv: ["--project", "visible-value"], expected: ["--project", "visible-value"] },
	{ argv: ["--token"], expected: ["--token"] },
];

test("secret flags redact split attached and trailing argv in TS without consuming ordinary values", () => {
	for (const item of secretFlagCases) {
		const replay = captureMineReplay({ arguments: { argv: item.argv } });
		expect(replay.arguments).toEqual({ argv: item.expected });
		expect(replay.redacted).toBe(item.argv.some((value, index) => value !== item.expected[index]));
	}
});

test("secret flags Python argv redaction matches TS and independent expectations", async () => {
	const child = await runFixtureAsync(["python3", "-c",
		"import json,sys; sys.path.insert(0,sys.argv[1]); from gate_event_replay import CredentialScreen,capture\nif sys.stdin.isatty(): raise RuntimeError('PIPE_INPUT_REQUIRED')\nrows=json.load(sys.stdin); screen=CredentialScreen(); print(json.dumps([capture({'arguments':{'argv':row}},screen)['arguments']['argv'] for row in rows]))",
		resolve(import.meta.dir, "../../scripts")], { cwd: repository, stdin: Buffer.from(JSON.stringify(secretFlagCases.map(item => item.argv))) });
	if (child.rc !== 0) throw new Error(`Python secret flag parity failed: ${Buffer.from(child.stderr).toString()}`);
	expect(JSON.parse(Buffer.from(child.stdout).toString())).toEqual(secretFlagCases.map(item => item.expected));
});
