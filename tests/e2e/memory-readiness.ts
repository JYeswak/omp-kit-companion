#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { isRecord } from "../../src/type-guards.ts";
import { inspectMemoryReadiness, type MemoryReadinessReport } from "../../src/memory-readiness.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const OMP_SOURCE_PATH = process.env.OMP_MEMORY_SOURCE_PATH ?? process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
if (!OMP_SOURCE_PATH) throw new Error("Set OMP_MEMORY_SOURCE_PATH or OMP_INSTALLED_PATH to a package-backed OMP launcher");
const OMP_PATH = realpathSync(OMP_SOURCE_PATH);
const OMP_ROOT = dirname(dirname(OMP_PATH));
const OMP_METADATA: unknown = JSON.parse(readFileSync(join(OMP_ROOT, "package.json"), "utf8"));
if (!isRecord(OMP_METADATA) || OMP_METADATA.name !== "@oh-my-pi/pi-coding-agent" || typeof OMP_METADATA.version !== "string") {
	throw new Error(`Not a package-backed OMP launcher: ${OMP_PATH}`);
}
const OMP_VERSION = OMP_METADATA.version;
const OMP_SOURCE_FILES = [
	"src/memory-backend/redact.ts",
	"src/memory-backend/settings.ts",
	"src/memory-backend/resolve.ts",
	"src/config/settings.ts",
] as const;

type Check = { name: string; expected: unknown; observed: unknown; passed: boolean };
type JsonObject = Record<string, unknown>;
function check(checks: Check[], name: string, expected: unknown, observed: unknown, passed: boolean): void {
	checks.push({ name, expected, observed, passed });
}
function emit(record: JsonObject, checks: Check[]): boolean {
	const passed = checks.every(item => item.passed);
	process.stdout.write(`${JSON.stringify({ schema_version: 1, ...record, assertion_total: checks.length, assertions: checks, passed })}\n`);
	return passed;
}
function writeCass(path: string): void {
	writeFileSync(path, [
		"#!/bin/sh",
		"printf '%s\\n' \"$*\" >> \"$0.calls\"",
		"if [ \"$*\" = \"status --json\" ]; then",
		"  printf '%s\\n' \"$CASS_STATUS_JSON\"",
		"  exit \"$CASS_STATUS_EXIT\"",
		"fi",
		"exit 97",
		"",
	].join("\n"));
	chmodSync(path, 0o755);
}
function memoryEvidence(stdout: string): { overall: string | null; finding_status: string | null; evidence: JsonObject | null } {
	try {
		const envelope: unknown = JSON.parse(stdout);
		if (!isRecord(envelope) || !isRecord(envelope.data) || !Array.isArray(envelope.data.findings)) return { overall: null, finding_status: null, evidence: null };
		const finding = envelope.data.findings.find(row => isRecord(row) && row.component === "memory");
		if (!isRecord(finding) || !isRecord(finding.evidence)) return {
			overall: typeof envelope.data.overall === "string" ? envelope.data.overall : null, finding_status: null, evidence: null,
		};
		return {
			overall: typeof envelope.data.overall === "string" ? envelope.data.overall : null,
			finding_status: typeof finding.status === "string" ? finding.status : null,
			evidence: finding.evidence,
		};
	} catch { return { overall: null, finding_status: null, evidence: null }; }
}

const work = mkdtempSync(join(tmpdir(), "omp-kit-memory-readiness-e2e-"));
const tools = join(work, "tools");
const cliHome = join(work, "cli-home");
const cliProject = join(work, "cli-project");
const cliTmp = join(work, "cli-tmp");
mkdirSync(tools, { recursive: true });
for (const directory of [join(cliHome, ".omp", "agent"), join(cliHome, ".local", "state"), join(cliHome, ".config"),
	join(cliHome, ".cache"), join(cliHome, ".local", "share"), cliProject, cliTmp]) mkdirSync(directory, { recursive: true });
symlinkSync(OMP_PATH, join(tools, "omp"));
const cassPath = join(tools, "cass");
writeCass(cassPath);
const callsPath = `${cassPath}.calls`;
const configPath = join(cliHome, ".omp", "agent", "config.yml");
const profileConfig = "memory:\n  backend: mnemopi\nmnemopi:\n  noEmbeddings: true\n  llmMode: none\n";
writeFileSync(configPath, profileConfig);
mkdirSync(join(cliProject, ".git"));
const launchAgents = join(cliHome, "Library", "LaunchAgents");
mkdirSync(launchAgents, { recursive: true });
const launchdPath = join(launchAgents, "com.dicklesworthstone.cass.incremental.plist");
const launchdContents = [
	"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
	"<plist version=\"1.0\"><dict>",
	"<key>Label</key><string>com.dicklesworthstone.cass.incremental</string>",
	"<key>ProgramArguments</key><array><string>/example/cass</string><string>schedule</string>",
	"<string>run</string><string>--job</string><string>incremental</string></array>",
	"<key>StartInterval</key><integer>900</integer>",
	"</dict></plist>",
].join("\n");
writeFileSync(launchdPath, launchdContents);

let allPassed = true;
function runCliScenario(caseId: string, statusExit: number, statusJson: string, schedulerExpected: string): void {
	writeFileSync(callsPath, "");
	const command = [process.execPath, CLI_PATH, "doctor", "--scope", "memory", "--json"];
	const childEnv = {
		...process.env,
		HOME: cliHome,
		TMPDIR: cliTmp,
		XDG_STATE_HOME: join(cliHome, ".local", "state"),
		XDG_CONFIG_HOME: join(cliHome, ".config"),
		XDG_CACHE_HOME: join(cliHome, ".cache"),
		XDG_DATA_HOME: join(cliHome, ".local", "share"),
		PATH: `${tools}:/usr/bin:/bin`,
		OMP: OMP_PATH,
		OMP_BIN: OMP_PATH,
		OMP_PATH,
		OMP_SRC: join(OMP_ROOT, "src"),
		OMP_KIT_OMP_SRC_FETCH: "0",
		CASS_STATUS_JSON: statusJson,
		CASS_STATUS_EXIT: String(statusExit),
	};
	delete childEnv.OMP_PROFILE;
	delete childEnv.PI_PROFILE;
	delete childEnv.PI_CODING_AGENT_DIR;
	const child = spawnSync(command[0]!, command.slice(1), {
		cwd: cliProject, env: childEnv, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
	});
	const stdout = typeof child.stdout === "string" ? child.stdout : "";
	const stderr = typeof child.stderr === "string" ? child.stderr : "";
	const parsed = memoryEvidence(stdout), evidence = parsed.evidence ?? {};
	const cass = isRecord(evidence.cass) ? evidence.cass : {};
	const scheduler = isRecord(evidence.scheduler) ? evidence.scheduler : {};
	const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";
	const storePath = join(cliHome, ".omp", "agent", "memories", "mnemopi", "mnemopi.db");
	const profileAfter = readFileSync(configPath, "utf8");
	const projectEntries = readdirSync(cliProject).sort();
	const checks: Check[] = [];
	const expectedCass = statusExit === 5 ? "MAINTENANCE_REQUIRED" : "AVAILABLE";
	check(checks, "CLI exit", 0, child.status, child.status === 0);
	check(checks, "memory finding present", true, parsed.evidence !== null, parsed.evidence !== null);
	check(checks, "Mnemopi configuration observed", "mnemopi/configured", `${String(evidence.backend)}/${String(evidence.configured)}`,
		evidence.backend === "mnemopi" && evidence.configured === true);
	check(checks, "CASS status disposition", expectedCass, cass.observed, cass.observed === expectedCass);
	check(checks, "CASS never qualifies retrieval", false, cass.retrieval_qualified, cass.retrieval_qualified === false);
	check(checks, "scheduler declaration only", schedulerExpected, scheduler.state, scheduler.state === schedulerExpected);
	check(checks, "scheduler owner remains unknown", "UNKNOWN", scheduler.owner, scheduler.owner === "UNKNOWN");
	check(checks, "no recall success claim", false, evidence.retrieval_qualified, evidence.retrieval_qualified === false);
	check(checks, "CASS call is status-only", "status --json\n", calls, calls === "status --json\n");
	check(checks, "memory store not created", false, existsSync(storePath), !existsSync(storePath));
	check(checks, "profile config unchanged", profileConfig, profileAfter, profileAfter === profileConfig);
	check(checks, "project directory unchanged", [".git"], projectEntries, JSON.stringify(projectEntries) === JSON.stringify([".git"]));
	const record = {
		case_id: caseId,
		fixture: { omp_version: OMP_VERSION, backend: "mnemopi", cass_exit_code: statusExit, launchd_declaration: schedulerExpected },
		command, exit_code: child.status, expected: { cass: expectedCass, retrieval_qualified: false, scheduler: schedulerExpected, owner: "UNKNOWN" },
		observed: { overall: parsed.overall, finding_status: parsed.finding_status, backend: evidence.backend, configured: evidence.configured,
			cass: evidence.cass, scheduler: evidence.scheduler, source_refs: evidence.source_refs },
		stdout, stderr, signal: child.signal,
	};
	allPassed = emit(record, checks) && allPassed;
}

try {
	const healthyStatus = JSON.stringify({ healthy: true, database: { exists: true }, index: { stale: false } });
	runCliScenario("configured-backend-and-healthy-status", 0, healthyStatus, "OBSERVED");
	runCliScenario("maintenance-required-despite-db-and-schedule", 5, healthyStatus, "OBSERVED");
	rmSync(launchdPath);
	runCliScenario("maintenance-required-with-unknown-scheduler-owner", 5, healthyStatus, "UNAVAILABLE");

	const sourceWork = join(work, "unreviewed-source");
	const sourceHome = join(sourceWork, "home"), sourceProject = join(sourceWork, "project"), sourcePackage = join(sourceWork, "omp");
	const sourceAgent = join(sourceHome, ".omp", "agent"), sourceDist = join(sourcePackage, "dist");
	for (const directory of [sourceAgent, sourceProject, sourceDist]) mkdirSync(directory, { recursive: true });
	writeFileSync(join(sourcePackage, "package.json"), readFileSync(join(OMP_ROOT, "package.json")));
	const sourceOmpPath = join(sourceDist, "cli.js");
	writeFileSync(sourceOmpPath, "#!/bin/sh\nexit 91\n");
	for (const relativePath of OMP_SOURCE_FILES) {
		const target = join(sourcePackage, relativePath);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, readFileSync(join(OMP_ROOT, relativePath)));
	}
	writeFileSync(join(sourceAgent, "config.yml"), profileConfig);
	const changedSourcePath = join(sourcePackage, "src/memory-backend/settings.ts");
	const changedSource = Buffer.from(readFileSync(changedSourcePath));
	changedSource[0] = (changedSource[0] ?? 0) ^ 1;
	writeFileSync(changedSourcePath, changedSource);
	const changedSourceHash = createHash("sha256").update(changedSource).digest("hex");
	const fixedCassPath = join(tools, "cass-maintenance");
	writeFileSync(fixedCassPath, [
		"#!/bin/sh",
		"printf '%s\\n' \"$*\" >> \"$0.calls\"",
		"if [ \"$*\" = \"status --json\" ]; then",
		`  printf '%s\\n' '${healthyStatus}'`,
		"  exit 5",
		"fi",
		"exit 97",
		"",
	].join("\n"));
	chmodSync(fixedCassPath, 0o755);
	const sourceChecks: Check[] = [];
	const report: MemoryReadinessReport = await inspectMemoryReadiness({ home: sourceHome, project: sourceProject, ompPath: sourceOmpPath, cassPath: fixedCassPath });
	const sourceDb = join(sourceAgent, "memories", "mnemopi", "mnemopi.db");
	const fixedCalls = existsSync(`${fixedCassPath}.calls`) ? readFileSync(`${fixedCassPath}.calls`, "utf8") : "";
	check(sourceChecks, "unreviewed source refuses backend qualification", "UNVERIFIED", report.backend, report.backend === "UNVERIFIED");
	check(sourceChecks, "maintenance result is preserved", "MAINTENANCE_REQUIRED", report.cass.observed, report.cass.observed === "MAINTENANCE_REQUIRED");
	check(sourceChecks, "retrieval remains unqualified", false, report.retrieval_qualified, report.retrieval_qualified === false);
	check(sourceChecks, "source hash remains cited", `src/memory-backend/settings.ts sha256=${changedSourceHash}`,
		report.source_refs.find(ref => ref === `src/memory-backend/settings.ts sha256=${changedSourceHash}`),
		report.source_refs.some(ref => ref === `src/memory-backend/settings.ts sha256=${changedSourceHash}`));
	check(sourceChecks, "scheduler owner remains unknown", "UNKNOWN", report.scheduler.owner, report.scheduler.owner === "UNKNOWN");
	check(sourceChecks, "no Mnemopi store created", false, existsSync(sourceDb), !existsSync(sourceDb));
	check(sourceChecks, "CASS call remains status-only", "status --json\n", fixedCalls, fixedCalls === "status --json\n");
	allPassed = emit({
		case_id: "unreviewed-source-preserves-cass-failure",
		fixture: { omp_version: OMP_VERSION, source_mutation: "one-byte settings.ts change", cass_exit_code: 5, scheduler_source: "absent" },
		command: ["inspectMemoryReadiness", "{home, project, ompPath, cassPath}"], exit_code: 0,
		expected: { backend: "UNVERIFIED", cass: "MAINTENANCE_REQUIRED", retrieval_qualified: false, scheduler_owner: "UNKNOWN" },
		observed: { backend: report.backend, cass: report.cass.observed, retrieval_qualified: report.retrieval_qualified,
			scheduler: report.scheduler, source_refs: report.source_refs },
	}, sourceChecks) && allPassed;
} finally {
	rmSync(work, { recursive: true, force: true });
}
if (!allPassed) process.exitCode = 1;
