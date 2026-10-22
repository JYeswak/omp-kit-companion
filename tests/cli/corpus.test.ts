import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import process from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { sanitizedEnv } from "../../src/runtime.ts";
import { nativeCacheEnv, writeBundledHarness } from "./release-manifest-fixture.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let owned: OwnedTmp | undefined;
let base = "";
let binary = "";
let home = "";
let sessions = "";
let release = "";
let environment: Record<string, string>;

function toolCall(id: string, name: string, args: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, timestamp: "2026-09-30T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
}

function assistantText(id: string, text: string): string {
	return JSON.stringify({ type: "message", id, timestamp: "2026-09-30T10:01:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] } });
}

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	owned = ownedTmp("omp-kit-corpus");
	base = owned.path;
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	sessions = join(base, "sessions");
	for (const directory of [join(release, "bin"), join(release, "scripts"), sessions,
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeBundledHarness(release);
	writeFileSync(join(sessions, "s1.jsonl"), [
		`{"type":"title","v":1,"title":"fixture","updatedAt":"2026-09-30T10:00:00.000Z"}`,
		`{"type":"session","version":3,"id":"s1","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
		`{"version": `,
		assistantText("t1", "fixture note"),
		toolCall("c1", "bash", { command: "echo zzzz_systemwide_canary_9c42" }),
		toolCall("c2", "bash", { command: "grep -rl 'x' crates/*/Cargo.toml 2>/dev/null" }),
		toolCall("c3", "bash", { command: "echo hello" }),
		...["c1", "c2", "c3"].map((toolCallId, index) => JSON.stringify({
			type: "message", id: `r${index + 1}`, timestamp: "2026-09-30T10:01:00.000Z",
			message: { role: "toolResult", toolCallId, content: [{ type: "text", text: "fixture result" }] },
		})),
	].join("\n") + "\n");
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(binary, 0o755);
	environment = {
		...nativeCacheEnv,
		OMP_KIT_CASE_CWD: process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || REPO_ROOT,
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin", OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	owned?.cleanup();
});

type CorpusRule = { rule?: string; kind?: string; scanned?: number; fires?: number; rate?: number;
	ci_low?: number; ci_high?: number; upper_3n?: number | null };

function runCli(args: string[]): { exitCode: number; envelope: Record<string, unknown> } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Record<string, unknown> };
}

function corpusOf(envelope: Record<string, unknown>): { overall?: string; corpus?: {
	files?: number; assistant_messages?: number; parse_errors?: number; versions?: string[];
	events?: Record<string, number>; rules?: CorpusRule[] } } {
	return envelope.data as { overall?: string; corpus?: {
		files?: number; assistant_messages?: number; parse_errors?: number; versions?: string[];
		events?: Record<string, number>; rules?: CorpusRule[] } };
}

function findRule(set: CorpusRule[] | undefined, rule: string, kind: string): CorpusRule {
	const row = (set ?? []).find(entry => entry.rule === rule && entry.kind === kind);
	if (!row) throw new Error(`missing corpus row ${rule}/${kind}`);
	return row;
}

test("corpus reports exact planted fire counts with Wilson intervals", () => {
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--json"]);
	expect(exitCode, JSON.stringify(envelope.errors)).toBe(0);
	const set = corpusOf(envelope);
	expect(set.overall).toBe("OK");
	expect(set.corpus?.files).toBe(1);
	expect(set.corpus?.assistant_messages).toBe(4);
	expect(set.corpus?.parse_errors).toBe(1);
	expect(set.corpus?.versions).toEqual(["v:1", "version:3"]);
	expect(set.corpus?.events).toMatchObject({ bash: 3, text: 1 });
	const canary = findRule(set.corpus?.rules, "zz-canary-scope-probe", "bash");
	expect(canary.scanned).toBe(3);
	expect(canary.fires).toBe(1);
	expect(canary.rate).toBeCloseTo(1 / 3, 6);
	expect(canary.ci_low).toBeCloseTo(0.0615, 3);
	expect(canary.ci_high).toBeCloseTo(0.7923, 3);
	expect(canary.upper_3n).toBeNull();
	const glob = findRule(set.corpus?.rules, "bash-glob-silenced", "bash");
	expect(glob.scanned).toBe(3);
	expect(glob.fires).toBe(1);
	const close = findRule(set.corpus?.rules, "kit-close-needs-evidence", "bash");
	expect(close.scanned).toBe(3);
	expect(close.fires).toBe(0);
	expect(close.rate).toBe(0);
	expect(close.upper_3n).toBeCloseTo(1, 6);
}, 300_000);

test("corpus redacts command text and writes only to the chosen path", () => {
	const before = new Set(readdirSync(sessions));
	const out = join(base, "corpus-report.json");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--out", out, "--json"]);
	expect(exitCode, JSON.stringify(envelope.errors)).toBe(0);
	expect(JSON.parse(readFileSync(out, "utf8")).corpus.files).toBe(1);
	expect(JSON.stringify(envelope)).not.toContain("crates/*/Cargo.toml");
	expect(JSON.stringify(envelope)).not.toContain("sample_fire");
	expect(new Set(readdirSync(sessions))).toEqual(before);
}, 300_000);

test("corpus --plan prints the schema without reading anything", () => {
	const missing = join(base, "no-such-dir");
	const { exitCode, envelope } = runCli(["corpus", "--plan", "--sessions", missing, "--json"]);
	expect(exitCode).toBe(0);
	const plan = (envelope.data as { corpus_plan?: { reads?: string[]; accepted_versions?: string[]; refuses?: string } }).corpus_plan;
	expect(plan?.reads?.length).toBeGreaterThan(0);
	expect(plan?.accepted_versions).toContain("top-level numeric version 3 (session rows)");
	expect(plan?.refuses).toContain("unknown session schema version");
	expect(plan?.refuses).toContain("invalid-schema refusal");
	expect(plan?.refuses).toContain("invalid-record refusal");
	expect(plan?.refuses).toContain("parse_errors");
}, 120_000);

test("CORPUS_SCHEMA_PLANT: an unknown session schema version refuses with no counts", () => {
	const badDir = join(base, "bad-sessions");
	mkdirSync(badDir, { recursive: true });
	writeFileSync(join(badDir, "s9.jsonl"), [
		`{"type":"session","version":99,"id":"s9","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
		toolCall("c9", "bash", { command: "echo zzzz_systemwide_canary_9c42" }),
	].join("\n") + "\n");
	const out = join(base, "unknown-schema-report.json");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", badDir, "--out", out, "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code, JSON.stringify(envelope.errors)).toBe("UNKNOWN_SESSION_SCHEMA");
	expect(envelope.data).not.toHaveProperty("corpus");
	expect(existsSync(out)).toBe(false);
}, 300_000);

test("CORPUS_SCHEMA_PLANT: a string-shaped session version refuses as invalid-schema", () => {
	const badDir = join(base, "bad-shape-sessions");
	mkdirSync(badDir, { recursive: true });
	writeFileSync(join(badDir, "s9.jsonl"), [
		`{"type":"session","version":"3","id":"s9","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
		toolCall("c9", "bash", { command: "echo zzzz_systemwide_canary_9c42" }),
	].join("\n") + "\n");
	const out = join(base, "invalid-schema-report.json");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", badDir, "--out", out, "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code, JSON.stringify(envelope.errors)).toBe("INVALID_SESSION_SCHEMA");
	expect(envelope.data).not.toHaveProperty("corpus");
	expect(existsSync(out)).toBe(false);
}, 300_000);

test("CORPUS_RECORD_PLANT: structurally invalid assistant records refuse as invalid-record", () => {
	const variants: { dir: string; line: string }[] = [
		{ dir: join(base, "bad-content-sessions"), line: `{"type":"message","id":"c9","timestamp":"2026-09-30T10:01:00.000Z","message":{"role":"assistant","content":{"type":"text","text":"not an array"}}}` },
		{ dir: join(base, "bad-toolname-sessions"), line: `{"type":"message","id":"c9","timestamp":"2026-09-30T10:01:00.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c9","name":7,"arguments":{"command":"echo hi"}}]}}` },
	];
	for (const variant of variants) {
		mkdirSync(variant.dir, { recursive: true });
		writeFileSync(join(variant.dir, "s9.jsonl"), [
			`{"type":"session","version":3,"id":"s9","timestamp":"2026-09-30T10:00:00.000Z","cwd":"/tmp"}`,
			variant.line,
		].join("\n") + "\n");
		const out = join(base, "invalid-record-report.json");
		rmSync(out, { force: true });
		const { exitCode, envelope } = runCli(["corpus", "--sessions", variant.dir, "--out", out, "--json"]);
		expect(exitCode, variant.dir).toBe(2);
		expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code, JSON.stringify(envelope.errors)).toBe("INVALID_SESSION_RECORD");
		expect(envelope.data).not.toHaveProperty("corpus");
		expect(existsSync(out)).toBe(false);
	}
}, 300_000);

test("corpus producer errors keep kit-relative module paths", () => {
	const harness = join(release, "scripts", "ttsr-harness.ts");
	const original = readFileSync(harness, "utf8");
	try {
		writeFileSync(harness, `await import(${JSON.stringify(pathToFileURL(join(release, "scripts", "missing-module.ts")).href)});\n`);
		const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--json"]);
		const error = (envelope.errors as { message?: string }[] | undefined)?.[0]?.message ?? "";
		expect(exitCode, JSON.stringify(envelope.errors)).toBe(2);
		expect(error).toContain("producer_rc=1");
		expect(error).toContain("./scripts/missing-module.ts");
		expect(error).toContain("./scripts/ttsr-harness.ts");
		expect(error).not.toContain(base);
		writeFileSync(harness, `await import(${JSON.stringify(pathToFileURL(join(resolveOmpIdentity(process.env).source, "export", "ci-missing-module.ts")).href)});\n`);
		const ompFailure = runCli(["corpus", "--sessions", sessions, "--json"]);
		const ompError = (ompFailure.envelope.errors as { message?: string }[] | undefined)?.[0]?.message ?? "";
		expect(ompFailure.exitCode, JSON.stringify(ompFailure.envelope.errors)).toBe(2);
		expect(ompError).toContain("<omp-source>/export/ci-missing-module.ts");
		expect(ompError).not.toContain(resolveOmpIdentity(process.env).source);
	} finally {
		writeFileSync(harness, original);
	}
}, 300_000);

test("corpus refuses a relative sessions dir", () => {
	const { exitCode, envelope } = runCli(["corpus", "--sessions", "relative/path", "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code).toBe("INVALID_CORPUS_SELECTION");
}, 120_000);

test("corpus refuses a file as the sessions directory", () => {
	const sessionsFile = join(base, "not-a-sessions-directory");
	writeFileSync(sessionsFile, "not a directory\n");
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessionsFile, "--json"]);
	expect(exitCode).toBe(2);
	expect((envelope.errors as { code?: string }[] | undefined)?.[0]?.code, JSON.stringify(envelope.errors)).toBe("INVALID_CORPUS_SELECTION");
	expect(envelope.data).not.toHaveProperty("corpus");
}, 120_000);

test("corpus seeded fixture reproduces identical counts on repeat runs", () => {
	const first = runCli(["corpus", "--sessions", sessions, "--json"]);
	const second = runCli(["corpus", "--sessions", sessions, "--json"]);
	expect(first.exitCode).toBe(0);
	expect(second.exitCode).toBe(0);
	expect(corpusOf(second.envelope).corpus).toEqual(corpusOf(first.envelope).corpus);
}, 300_000);

type EgressRecord = { exitCode: number; stdout: string; stderr: string; attempts: string[] };

/** Box 6 no-egress verdict over a retained run record: exit plus observed direct attempts. */
function noEgressVerdict(record: EgressRecord): string | null {
	if (record.exitCode !== 0) return `subject exited ${record.exitCode}: ${record.stderr.slice(0, 300)}`;
	if (record.attempts.length > 0) {
		return `observer saw ${record.attempts.length} direct connection attempt(s): ${record.attempts.join(", ")}`;
	}
	return null;
}

async function startHoneypot(): Promise<{ port: number; attempts: string[]; firstConnection: Promise<void>; close: () => Promise<void> }> {
	const attempts: string[] = [];
	let notifyFirst: () => void = () => {};
	const firstConnection = new Promise<void>((resolvePromise) => { notifyFirst = resolvePromise; });
	const server = createServer((socket: Socket) => {
		attempts.push(`${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`);
		socket.destroy();
		notifyFirst();
	});
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("honeypot bound to an unexpected address");
	return {
		port: address.port, attempts, firstConnection,
		close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
	};
}

test("corpus runs with no network egress (poisoned proxy + honeypot over the descendant tree)", async () => {
	// Box 6: the corpus must work with the network stack poisoned, and no
	// direct-dial egress may leave the complete descendant tree (compiled
	// CLI parent plus its real matcher child). The poisoned proxy proves
	// proxy-respecting egress would fail; the loopback honeypot observes
	// direct connection attempts from any descendant. The planted control
	// below proves the honeypot path is live, so zero attempts is evidence,
	// not a vacuous listen. Residual: dials to non-loopback remotes have no
	// observer in this sandbox; that gap is stated, not covered.
	const honeypot = await startHoneypot();
	const poison: Record<string, string> = {
		HTTP_PROXY: "http://127.0.0.1:9/", HTTPS_PROXY: "http://127.0.0.1:9/",
		http_proxy: "http://127.0.0.1:9/", https_proxy: "http://127.0.0.1:9/",
		ALL_PROXY: "http://127.0.0.1:9/", all_proxy: "http://127.0.0.1:9/",
		NO_PROXY: "", no_proxy: "",
	};
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(poison)) {
		saved[key] = process.env[key];
		process.env[key] = poison[key];
	}
	try {
		let controlThrew = false;
		try {
			await fetch("https://example.com/");
		} catch {
			controlThrew = true;
		}
		expect(controlThrew).toBe(true);
		const child = Bun.spawnSync([binary, "corpus", "--sessions", sessions, "--json"], {
			cwd: home, env: { ...environment, ...poison }, stdout: "pipe", stderr: "pipe",
		});
		const record: EgressRecord = {
			exitCode: child.exitCode,
			stdout: child.stdout.toString(),
			stderr: child.stderr.toString(),
			attempts: [...honeypot.attempts],
		};
		if (!record.stdout.trim()) throw new Error(`poisoned corpus returned no JSON (rc=${record.exitCode}): ${record.stderr.slice(0, 500)}`);
		expect(noEgressVerdict(record), `stderr: ${record.stderr.slice(0, 500)}`).toBeNull();
		const envelope = JSON.parse(record.stdout) as Record<string, unknown>;
		const errors = "errors" in envelope ? envelope.errors : undefined;
		expect(record.exitCode, JSON.stringify(errors)).toBe(0);
		const set = corpusOf(envelope);
		expect(set.overall).toBe("OK");
		expect(set.corpus?.files).toBe(1);
		expect(set.corpus?.assistant_messages).toBe(4);
		expect(set.corpus?.parse_errors).toBe(1);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await honeypot.close();
	}
}, 300_000);

test("CORPUS_EGRESS_PLANT: a direct-dial control through the same child runtime is observed and fails qualification", async () => {
	// Planted negative for box 6: the in-tree control runs through the same
	// boundary as the real matcher child (the compiled binary as a bun
	// runtime with the allowlisted child env) and dials direct via node:net
	// with every proxy variable stripped. The honeypot must observe that
	// attempt and the box 6 verdict must fail for that reason. A parent-only
	// fetch-poison check still passes at the same time, proving proxy-only
	// coverage cannot pass this case.
	const honeypot = await startHoneypot();
	const controlPath = join(release, "scripts", "corpus-egress-control.ts");
	writeFileSync(controlPath, [
		`import { connect } from "node:net";`,
		`const port = Number(process.env.OMP_KIT_CORPUS_HONEYPOT_PORT);`,
		`const socket = connect(port, "127.0.0.1");`,
		`socket.on("connect", () => { console.log("egress-control: connected"); socket.destroy(); });`,
		`socket.on("error", (error: Error) => { console.error("egress-control: " + error.message); process.exit(1); });`,
		``,
	].join("\n"));
	try {
		const omp = resolveOmpIdentity(process.env);
		const privateRoot = join(base, "egress-child");
		mkdirSync(privateRoot);
		const childEnv: Record<string, string> = {
			...sanitizedEnv(omp, process.env, privateRoot),
			BUN_BE_BUN: "1",
			OMP_KIT_CORPUS_HONEYPOT_PORT: String(honeypot.port),
		};
		for (const key of Object.keys(childEnv)) {
			if (key.toLowerCase().includes("proxy")) delete childEnv[key];
		}
		const child = Bun.spawn([binary, controlPath], {
			cwd: home, env: childEnv, stdout: "pipe", stderr: "pipe",
		});
		const exitCode = await child.exited;
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("egress-control: connected");
		// The server accepts before the client handshake completes, so by
		// the time the child reports "connected" the observation has fired;
		// awaiting the event (not a timer) keeps this deterministic.
		await honeypot.firstConnection;
		expect(honeypot.attempts.length).toBeGreaterThan(0);
		const verdict = noEgressVerdict({ exitCode, stdout, stderr, attempts: [...honeypot.attempts] });
		expect(verdict).not.toBeNull();
		expect(verdict ?? "").toContain("direct connection attempt");
		const poison: Record<string, string> = {
			HTTP_PROXY: "http://127.0.0.1:9/", HTTPS_PROXY: "http://127.0.0.1:9/",
			http_proxy: "http://127.0.0.1:9/", https_proxy: "http://127.0.0.1:9/",
		};
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(poison)) {
			saved[key] = process.env[key];
			process.env[key] = poison[key];
		}
		try {
			let fetchThrew = false;
			try {
				await fetch("https://example.com/");
			} catch {
				fetchThrew = true;
			}
			expect(fetchThrew).toBe(true);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	} finally {
		rmSync(controlPath, { force: true });
		await honeypot.close();
	}
}, 300_000);

test("corpus --plan states fire rates are not false-fire or calibration proof", () => {
	// Box 14 honesty: the actual compiled report/help carries the no-claim
	// distinction, so a consumer cannot read blocking/calibration out of it.
	const { exitCode, envelope } = runCli(["corpus", "--plan", "--json"]);
	expect(exitCode).toBe(0);
	const plan = (envelope.data as { corpus_plan?: { interpretation?: string } }).corpus_plan;
	expect(plan?.interpretation ?? "").toContain("not a false-fire rate");
	expect(plan?.interpretation ?? "").toContain("does not establish blocking or calibration");
}, 120_000);

type RealReportEvidence = {
	sessionsDir: string; realRoot: string; binaryPath: string; binarySha256: string;
	expectedBinarySha256: string; files: number | undefined; assistantMessages: number | undefined;
	ruleCount: number | undefined; versions: string[] | undefined;
	configWritesObserved: string[]; reportText: string;
};

/** Parent box 14 gate: only a real-root run of the released binary with full count evidence qualifies. */
function qualifyRealReport(evidence: RealReportEvidence): string | null {
	if (evidence.sessionsDir !== evidence.realRoot) return "synthetic-root run does not qualify as the real report";
	if (evidence.binarySha256 !== evidence.expectedBinarySha256) return `wrong binary identity: ${evidence.binaryPath}`;
	if (evidence.files === undefined || evidence.assistantMessages === undefined
		|| evidence.ruleCount === undefined || !evidence.versions || evidence.versions.length === 0) {
		return "missing real-root/count evidence";
	}
	if (evidence.configWritesObserved.length > 0) {
		return `observed profile/config write: ${evidence.configWritesObserved.join(", ")}`;
	}
	// Label scan is a fixed-literal alternation (no quantifiers; substring
	// search over bounded report JSON): verified in Bun/JSC with required
	// matches, rejects (falsefire, false_fire_rate, empty), a 1M-char
	// near-miss in 0.1 ms, and a silent regexploit -f js run.
	if (/false-fire|calibrat|blocking/i.test(evidence.reportText)) {
		return "report labels corpus fires as false-fire/calibration/blocking proof";
	}
	return null;
}

test("CORPUS_REPORT_PLANT: box14 gate keeps the real execution and refuses everything else", () => {
	// Positive first: a real-root run of the built binary with complete
	// count evidence and no observed writes qualifies. The plants below
	// then prove the gate refuses instead of passing vacuously.
	const { exitCode, envelope } = runCli(["corpus", "--sessions", sessions, "--json"]);
	expect(exitCode, JSON.stringify(envelope.errors)).toBe(0);
	const set = corpusOf(envelope);
	const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
	const positive: RealReportEvidence = {
		sessionsDir: sessions, realRoot: sessions, binaryPath: binary,
		binarySha256: sha256, expectedBinarySha256: sha256,
		files: set.corpus?.files, assistantMessages: set.corpus?.assistant_messages,
		ruleCount: set.corpus?.rules?.length, versions: set.corpus?.versions,
		configWritesObserved: [], reportText: JSON.stringify(envelope),
	};
	expect(set.corpus?.files).toBe(1);
	expect(qualifyRealReport(positive)).toBeNull();
	const plants: { name: string; mutate: (evidence: RealReportEvidence) => void; reason: string }[] = [
		{ name: "false-fire label", mutate: (evidence) => { evidence.reportText += `{"false-fire rate": 0.02}`; }, reason: "false-fire" },
		{ name: "calibration label", mutate: (evidence) => { evidence.reportText += "calibration curve approved"; }, reason: "calibration" },
		{ name: "blocking label", mutate: (evidence) => { evidence.reportText += "blocking proof established"; }, reason: "blocking" },
		{ name: "synthetic root", mutate: (evidence) => { evidence.sessionsDir = join(base, "other-sessions"); }, reason: "synthetic-root" },
		{ name: "wrong binary", mutate: (evidence) => { evidence.binarySha256 = "0".repeat(64); }, reason: "wrong binary identity" },
		{ name: "missing counts", mutate: (evidence) => { evidence.files = undefined; evidence.ruleCount = undefined; }, reason: "missing real-root/count evidence" },
		{ name: "config write", mutate: (evidence) => { evidence.configWritesObserved = ["/profiles/x.json"]; }, reason: "profile/config write" },
	];
	for (const plant of plants) {
		const evidence: RealReportEvidence = { ...positive, versions: [...(positive.versions ?? [])], configWritesObserved: [...positive.configWritesObserved] };
		plant.mutate(evidence);
		const verdict = qualifyRealReport(evidence);
		expect(verdict, plant.name).not.toBeNull();
		expect(verdict ?? "", plant.name).toContain(plant.reason);
	}
}, 300_000);
