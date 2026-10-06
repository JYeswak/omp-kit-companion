import { PROFILE_RECIPE_KINDS } from "./profile-recipes.ts";

export type Flag = {
	readonly aliases?: readonly string[];
	readonly dataSchema?: DataSchema;
	readonly name: string;
	readonly description: string;
	readonly value?: string;
	/** Documented but not advertised as runnable by capabilities until its mode is wired. */
	readonly available?: boolean;
	/** Repeatable value flag; repeated values are joined with a newline. */
	readonly repeatable?: boolean;
};

export type DataSchema = {
	readonly type: "object";
	readonly required: readonly string[];
	readonly properties: Readonly<Record<string, unknown>>;
};

const textData: DataSchema = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
const profileRecipeData: DataSchema = { type: "object", required: ["kind", "version", "content", "status", "guidance"], properties: {
	kind: { enum: [...PROFILE_RECIPE_KINDS] }, version: { enum: [1] },
	content: { type: "string" }, status: { enum: ["UNVERIFIED"] }, guidance: { type: "string" },
} };
const completionData: DataSchema = { type: "object", required: ["text", "shell"], properties: {
	text: { type: "string" }, shell: { enum: ["bash", "zsh", "fish"] },
} };
const grammarData: DataSchema = { type: "object", required: ["schema_version", "tool_version", "commands", "global_flags", "exit_codes", "proof_classes"], properties: {
	schema_version: { type: "string" }, tool_version: { type: "string" }, commands: { type: "array" },
	global_flags: { type: "array" }, exit_codes: { type: "object" }, proof_classes: { type: "array" },
} };
const schemaData: DataSchema = { ...grammarData, required: [...grammarData.required, "envelope", "command_data", "usage_error_data"], properties: {
	...grammarData.properties, envelope: { type: "object" }, command_data: { type: "object" }, usage_error_data: { type: "object" },
} };
export const REFUSAL_DATA_SCHEMA: DataSchema = { type: "object", required: ["overall"], properties: {
	overall: { enum: ["NOT_RUN", "UNVERIFIED"] },
} };
const testData: DataSchema = { type: "object", required: ["overall"], properties: {
	overall: { enum: ["PASS", "FAIL", "BLOCKED", "UNVERIFIED", "NOT_RUN", "OK"] },
	recorded: { type: "boolean" },
	test: { type: "object", required: ["status"], properties: {
		status: { enum: ["PASS", "FAIL", "BLOCKED"] },
		scope: { enum: ["EXTERNAL_G1_G3", "CAPABILITY_CHECK"] },
	} },
	capabilities: { type: "object", required: ["overall", "capabilities"], properties: {
		overall: { enum: ["PASS", "FAIL"] },
		missing: { type: "number" },
		capabilities: { type: "array", items: { type: "object", required: ["kind", "name", "status"],
			properties: { kind: { type: "string" }, name: { type: "string" },
				status: { enum: ["RESOLVED", "HIDDEN_BUT_READABLE", "MISSING"] }, detail: { type: "string" } } } },
	} },
	live: { type: "object" },
	mutants: { type: "object" },
	integrations: { type: "object" },
	mcp: { type: "object", required: ["receipt_id", "profiles"], properties: { receipt_id: { type: ["string", "null"] }, profiles: { type: "array" } } },
	repeat: { type: "object" },
	metamorphic: { type: "object" },
} };

const statusData: DataSchema = { type: "object", required: ["overall", "kit", "omp", "findings", "evidence", "recommended_actions"], properties: {
	overall: { enum: ["OK", "DEGRADED", "UNVERIFIED", "FAIL"] },
	kit: { type: "object", required: ["version", "release", "data_paths", "platform"], properties: {
		version: { type: "string" }, release: { type: "object" }, data_paths: { type: "object" }, platform: { type: "object" },
	} },
	omp: { type: "object", required: ["status", "location", "version"], properties: {
		status: { enum: ["PRESENT", "UNAVAILABLE", "UNVERIFIED"] },
		location: { type: ["string", "null"] }, version: { type: ["string", "null"] },
	} },
	findings: { type: "array", items: { type: "object", required: ["component", "status", "reason", "recommended_action"], properties: {
		component: { type: "string" }, status: { enum: ["OK", "DEGRADED", "DRIFT", "UNVERIFIED", "FAIL", "NOT_RUN"] }, reason: { type: "string" }, recommended_action: { type: "string" },
	} } },
	evidence: { type: "object", required: ["effective_profile", "installed_rules", "matcher"], properties: {
		effective_profile: { enum: ["UNVERIFIED", "NOT_RUN"] },
		installed_rules: { enum: ["OK", "DEGRADED", "UNVERIFIED", "FAIL", "NOT_RUN"] },
		matcher: { enum: ["NOT_RUN"] },
	} },
	not_judged: { type: "array", items: { type: "object", required: ["component", "status", "reason"], properties: {
		component: { type: "string" }, status: { enum: ["OK", "DEGRADED", "UNVERIFIED", "FAIL", "NOT_RUN"] }, reason: { type: "string" },
	} } },
	recommended_actions: { type: "array", items: { type: "string" } },
} };
const lspReportData = { type: "object", required: ["status", "cwd", "file", "file_outside_cwd", "config_layers", "opaque_layers", "servers", "runtime"], properties: {
	status: { enum: ["DEGRADED", "UNVERIFIED"] }, cwd: { type: "string" }, file: { type: ["string", "null"] },
	file_outside_cwd: { type: "boolean" }, config_layers: { type: "array", items: { type: "string" } },
	opaque_layers: { type: "array", items: { type: "string" } },
	servers: { type: "array", items: { type: "object", required: ["name", "configured", "config_source", "command", "resolved_command", "executable_found", "root_markers", "file_types", "disabled", "eligible", "status", "runtime", "reason", "recommended_action"], properties: {
		name: { type: "string" }, configured: { type: "boolean" }, config_source: { type: "string" },
		command: { type: "string" }, resolved_command: { type: ["string", "null"] }, executable_found: { type: "boolean" },
		root_markers: { type: "array", items: { type: "string" } }, file_types: { type: "array", items: { type: "string" } },
		disabled: { type: "boolean" }, eligible: { type: "boolean" }, status: { enum: ["DEGRADED", "UNVERIFIED"] },
		runtime: { enum: ["NOT_PROBED"] }, reason: { type: "string" }, recommended_action: { type: "string" },
	} } }, runtime: { enum: ["NOT_PROBED"] },
} };
const deepDoctorData = { type: "object", required: ["status", "scope", "refusal"], properties: {
	status: { enum: ["UNVERIFIED"] }, scope: { type: "string" },
	refusal: { type: "object", required: ["code", "reason"], properties: { code: { type: "string" }, reason: { type: "string" } } },
} };
const lspProbeData = { type: "object", required: ["status", "scope", "requested_project", "requested_file", "selected_server", "selected_command", "reason", "checks", "calls", "omp_rc", "timed_out", "timeout_observation", "fixture_git_init_rc", "protected_input_snapshots", "profile_template_unchanged", "profile_template_snapshots", "fixture_project_unchanged", "fixture_project_snapshots", "runtime_home_omp_inventory", "runtime_state_outputs", "mux_stop_rc", "temporary_workspace_removed"], properties: {
	status: { enum: ["PASS", "MISSING", "IMMEDIATE_EXIT", "WRONG_MARKER", "INCOMPLETE", "TIMEOUT", "UNVERIFIED"] },
	scope: { enum: ["OMP_LSP_TOOL_ROUTE"] }, requested_project: { type: "string" }, requested_file: { type: ["string", "null"] },
	selected_server: { type: ["string", "null"] }, selected_command: { type: ["string", "null"] }, reason: { type: "string" }, checks: { type: "object" },
	calls: { type: "array", items: { type: "object", required: ["action", "result"], properties: {
		action: { type: "string" }, file: { type: "string" }, line: { type: "number" }, symbol: { type: "string" }, query: { type: "string" }, elapsed_ms: { type: "number" }, result: { type: "string" }, result_truncated: { type: "boolean" },
	} } }, omp_rc: { type: ["number", "null"] }, timed_out: { type: "boolean" },
	timeout_observation: { type: ["object", "null"], properties: { source: { enum: ["OMP_PROCESS_DEADLINE", "LSP_TOOL_RESULT"] }, elapsed_scope: { enum: ["whole_probe", "lsp_tool_call"] }, elapsed_ms: { type: "number" }, deadline_ms: { type: "number" }, tool_result: { type: ["string", "null"] } } },
	fixture_git_init_rc: { type: ["number", "null"] },
	protected_input_snapshots: { type: ["object", "null"], properties: { before: { type: "object" }, after: { type: "object" }, unchanged: { type: "boolean" } } },
	profile_template_unchanged: { type: ["boolean", "null"] }, profile_template_snapshots: { type: ["object", "null"], properties: { before: { type: "object" }, after: { type: "object" }, unchanged: { type: "boolean" } } },
	fixture_project_unchanged: { type: ["boolean", "null"] }, fixture_project_snapshots: { type: ["object", "null"], properties: { before: { type: "object" }, after: { type: "object" }, unchanged: { type: "boolean" } } },
	runtime_home_omp_inventory: { type: "array", items: { type: "string" } }, runtime_state_outputs: { type: "array", items: { type: "string" } },
	mux_stop_rc: { type: ["number", "null"] }, temporary_workspace_removed: { type: "boolean" },
} };
const workData: DataSchema = { type: "object", required: ["scope", "overall", "roots", "repos", "concurrency", "per_repo_timeout_ms", "elapsed_ms", "timed_out_repos", "text"], properties: {
	scope: { enum: ["work"] }, overall: { enum: ["REPORT"] }, roots: { type: "array" }, repos: { type: "array" }, concurrency: { type: "number" }, per_repo_timeout_ms: { type: "number" }, elapsed_ms: { type: "number" }, timed_out_repos: { type: "number" }, text: { type: "string" },
} };
const calibrationData: DataSchema = { type: "object", required: ["overall", "scope", "status", "calibration"], properties: { overall: { enum: ["OK"] }, scope: { enum: ["rules"] }, status: { enum: ["OK"] }, calibration: { type: "object" } } };
const sessionData: DataSchema = { type: "object", required: ["scope", "overall", "checked_at_epoch_ms", "components", "sessions", "text"], properties: {
	scope: { enum: ["sessions"] }, overall: { enum: ["REPORT"] }, checked_at_epoch_ms: { type: "number" },
	components: { type: "array", items: { type: "object", required: ["label", "path", "version", "installed_at_epoch_ms"], properties: { label: { type: "string" }, path: { type: "string" }, version: { type: ["string", "null"] }, installed_at_epoch_ms: { type: ["number", "null"] } } } },
	sessions: { type: "array", items: { type: "object", required: ["pid", "ppid", "command", "start_epoch_ms", "start_time", "pane", "pane_pid", "pane_start_command", "verdict", "predates"], properties: { pid: { type: "number" }, ppid: { type: "number" }, command: { type: "string" }, start_epoch_ms: { type: ["number", "null"] }, start_time: { type: ["string", "null"] }, pane: { type: ["string", "null"] }, pane_pid: { type: ["number", "null"] }, pane_start_command: { type: ["string", "null"] }, verdict: { enum: ["CURRENT", "STALE", "UNVERIFIED"] }, predates: { type: "array", items: { type: "string" } }, reason: { type: "string" } } } },
	text: { type: "string" },
} };
const doctorData: DataSchema = { ...statusData, properties: { ...statusData.properties, report: lspReportData, calibration: calibrationData, sessions: sessionData, deep_probe: { oneOf: [deepDoctorData, lspProbeData] }, mcp_sources: { type: "object" } } };
const planningScoreData: DataSchema = { type: "object", required: ["kind", "status", "metrics"], properties: {
	kind: { enum: ["mission", "overall"] }, repo: { type: "string" }, mission: { type: "string" },
	status: { enum: ["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"] }, weighted_score: { type: ["number", "null"] },
	metrics: { type: "object" }, repositories: { type: "array" }, mission_count: { type: "number" },
} };
const lspPlanData: DataSchema = { type: "object", required: ["overall", "report", "instructions"], properties: {
	overall: { enum: ["DEGRADED", "UNVERIFIED"] }, report: lspReportData,
	instructions: { type: "array", items: { type: "object", required: ["server", "status", "command", "note"], properties: {
		server: { type: "string" }, status: { enum: ["MANUAL", "UNSUPPORTED"] },
		command: { type: ["string", "null"] }, note: { type: "string" },
	} } },
} };
const memoryAuditData: DataSchema = { type: "object", required: ["overall", "audit"], properties: {
	overall: { enum: ["OK", "UNVERIFIED", "FAIL"] },
	audit: { type: "object", required: ["status", "reason", "version", "coverage", "categories"], properties: {
		status: { enum: ["MATCHES", "NO_MATCHES_IN_COVERED_CLASSES", "UNVERIFIED"] },
		reason: { type: "string" }, version: { type: ["string", "null"] },
		coverage: { type: ["object", "null"] }, categories: { type: "object" },
	} },
} };
const infoData: DataSchema = { type: "object", required: ["version", "release", "data_paths", "platform", "omp", "dependencies"], properties: {
	version: { type: "string" }, release: { type: "object" }, data_paths: { type: "object" },
	platform: { type: "object" }, omp: statusData.properties.omp, dependencies: { type: "object" },
} };

export type Command = {
	readonly name: string;
	readonly description: string;
	readonly usage: string;
	readonly flags: readonly Flag[];
	readonly dataSchema?: DataSchema;
	readonly subcommands?: readonly Command[];
	/** Preserve a runnable parent route while exposing its named children. */
	readonly subcommandOptional?: boolean;
	readonly argument?: string;
	readonly example: string;
	readonly runnable: boolean;
	readonly mutation?: boolean;
};

export const GLOBAL_FLAGS: readonly Flag[] = [
	{ name: "--json", description: "Return one JSON envelope" },
	{ name: "--robot", description: "JSON output without interaction" },
	{ name: "--no-color", description: "Disable terminal styling" },
	{ name: "--help", aliases: ["-h"], description: "Display command or topic help" },
	{ name: "--info", description: "Show executable and dependency identity", dataSchema: infoData },
];

const planApply: readonly Flag[] = [
	{ name: "--plan", description: "Inspect without changing files" },
	{ name: "--apply", description: "Request guarded mutation" },
	{ name: "--yes", description: "Confirm the requested mutation in noninteractive mode" },
];

const repairData: DataSchema = { type: "object", required: ["overall", "action", "scope", "changes", "steps", "receipt_id"], properties: {
	overall: { enum: ["UNVERIFIED"] }, action: { enum: ["PLAN", "APPLIED", "UNCHANGED", "PARTIAL"] },
	scope: { enum: ["rules", "policy", "extensions", "state"] }, changes: { type: "number" },
	steps: { type: "array", items: { type: "object", required: ["action", "path"], properties: {
		action: { type: "string" }, path: { type: "string" }, profile: { type: "string" }, key: { type: "string" }, command: { type: "string" },
	} } }, receipt_id: { type: ["string", "null"] }, backup_id: { type: ["string", "null"] },
} };

const migrateData: DataSchema = { type: "object", required: ["overall", "action"], properties: {
	overall: { enum: ["UNVERIFIED"] }, action: { enum: ["PLAN", "APPLIED"] },
	rows: { type: "array", items: { type: "object", required: ["name", "verdict"], properties: {
		name: { type: "string" }, file: { type: "string" }, legacySha256: { type: "string" },
		manifestSha256: { type: ["string", "null"] }, pluginSha256: { type: ["string", "null"] },
		pluginPath: { type: ["string", "null"] }, verdict: { enum: ["identical-to-plugin", "identical-to-manifest", "edited", "unknown-keep"] },
		overlay: { type: "boolean" }, overlayPath: { type: ["string", "null"] }, unlisted: { type: "boolean" },
		firstDiffLine: { type: ["number", "null"] }, diff: { type: ["string", "null"] },
	} } },
	pluginRules: { type: "number" }, pluginAbsent: { type: "boolean" },
	removable: { type: "number" }, keptCount: { type: "number" }, receipt_id: { type: ["string", "null"] },
	backup_dir: { type: "string" }, removed: { type: "array", items: { type: "string" } },
	kept: { type: "array", items: { type: "string" } },
	verified: { type: "array", items: { type: "object", required: ["name"], properties: {
		name: { type: "string" }, provider: { type: ["string", "null"] }, path: { type: ["string", "null"] },
	} } },
} };

const ruleReviewData: DataSchema = { type: "object", required: ["overall", "status", "scope", "review"], properties: {
	overall: { enum: ["UNVERIFIED", "CONFLICTS", "DELTA", "NO_DELTA_IN_EXERCISED_WITNESSES"] },
	status: { enum: ["COMPLETE", "UNAVAILABLE"] }, scope: { enum: ["MATCHER_PREFIX_ONLY"] },
	reason: { type: ["string", "null"] }, review: { type: ["object", "null"] },
	selectedPacksUnchanged: { type: "boolean" }, identityBracket: { type: ["object", "null"] }, producers: { type: "array" },
} };
const falseFireData: DataSchema = { type: "object", required: ["overall", "scope", "status", "attempts", "original_bytes", "candidate_bytes", "replay_fixture"], properties: {
	overall: { enum: ["REDUCED", "UNCHANGED", "REPRODUCED", "NOT_REPRODUCED", "UNAVAILABLE", "MINIMIZATION_INCOMPLETE", "UNVERIFIED"] },
	scope: { enum: ["NATIVE_G2_G3_FALSE_FIRE"] },
	status: { enum: ["REDUCED", "UNCHANGED", "REPRODUCED", "NOT_REPRODUCED", "UNAVAILABLE", "MINIMIZATION_INCOMPLETE"] },
	attempts: { type: "number" }, original_bytes: { type: "number" }, candidate_bytes: { type: ["number", "null"] },
	replay_fixture: { type: ["object", "null"] },
} };
const serviceData: DataSchema = { type: "object", required: ["overall", "job"], properties: {
	overall: { enum: ["OK", "CHANGED", "FINDINGS", "UNAVAILABLE", "UNVERIFIED"] },
	job: { type: "string" }, label: { type: ["string", "null"] }, changed: { type: "boolean" },
	backup: { type: ["string", "null"] }, dry_run: { type: "boolean" }, already_absent: { type: "boolean" },
	checks: { type: "array", items: { type: "object", required: ["id", "status", "message", "remediation"], properties: {
		id: { type: "string" }, status: { enum: ["PASS", "WARN", "FAIL"] }, message: { type: "string" }, remediation: { type: "string" },
	} } },
	receipt: { type: "object" }, detail: { type: "string" }, text: { type: "string" },
} };
const sendData: DataSchema = { type: "object", required: ["overall", "session", "pane", "status"], properties: {
	overall: { enum: ["OK", "NOT_DELIVERED", "UNAVAILABLE", "UNVERIFIED"] },
	session: { type: "string" }, pane: { type: "string" }, status: { enum: ["OK", "NOT_DELIVERED"] },
	marker: { type: ["string", "null"] }, sends: { type: ["number", "null"] },
	drop_path: { type: ["string", "null"] }, detail: { type: "string" },
} };
const infraData: DataSchema = { type: "object", required: ["overall", "command"], properties: {
	overall: { enum: ["OK", "CHANGED", "FINDINGS", "UNAVAILABLE", "UNVERIFIED"] },
	command: { enum: ["pin", "check", "promote", "undo"] },
	tool: { type: ["string", "null"] }, version: { type: ["string", "null"] },
	status: { type: "string" }, failed_stage: { type: ["string", "null"] },
	stages: { type: "array", items: { type: "object" } },
	log_tail: { type: "string" },
	drift: { type: "array", items: { type: "object" } },
	receipt_id: { type: ["string", "null"] }, drop_path: { type: ["string", "null"] },
	detail: { type: "string" },
} };
const scratchData: DataSchema = { type: "object", required: ["overall"], properties: {
	overall: { enum: ["OK", "CHANGED", "FINDINGS", "UNAVAILABLE", "UNVERIFIED"] },
	roots: { type: "array", items: { type: "string" } },
	sessions: { type: "array", items: { type: "object", required: ["dir", "action", "reason"], properties: {
		dir: { type: "string" }, action: { enum: ["REAP", "QUARANTINE", "DELETE", "LIVE", "SKIP"] },
		reason: { type: "string" }, sizeBytes: { type: "number" },
	} } },
	orphans: { type: "array", items: { type: "object" } },
	killed: { type: "array", items: { type: "object" } },
	expired: { type: "array", items: { type: "object" } },
	reapableBytes: { type: "number" }, quarantinableBytes: { type: "number" },
} };
const loadData: DataSchema = { type: "object", required: ["scope", "overall", "verdict", "sampled_at", "machine", "consumers", "system_groups", "lsp_counts", "heavy_jobs", "contention_streak", "sample_cost_ms", "text"], properties: { scope: { enum: ["load"] }, overall: { enum: ["OK", "CONTENDED"] }, verdict: { enum: ["OK", "CONTENDED"] }, sampled_at: { type: "string" }, machine: { type: "object" }, consumers: { type: "array" }, system_groups: { type: "array" }, lsp_counts: { type: "object" }, heavy_jobs: { type: "array" }, contention_streak: { type: "number" }, sample_cost_ms: { type: "number" }, text: { type: "string" } } };
const scratchReleaseData: DataSchema = { type: "object", required: ["overall", "action", "dir", "changed"], properties: {
	overall: { enum: ["OK", "CHANGED"] }, action: { enum: ["RELEASED"] }, dir: { type: "string" }, changed: { type: "boolean" },
} };
const missionData: DataSchema = { type: "object", required: ["overall", "mission_file", "identity", "stage", "pillars", "errors", "no_claim"], properties: {
	overall: { enum: ["VALID", "UNREGISTERED", "INVALID"] }, mission_file: { type: "string" },
	identity: { type: ["string", "null"] }, stage: { type: ["string", "null"] },
	pillars: { type: "array", items: { type: "object", required: ["id", "clause", "check", "status", "path", "sha256", "command_sha256"], properties: {
		id: { type: "string" }, clause: { type: "string" }, check: { type: "string" }, status: { enum: ["REGISTERED", "UNREGISTERED"] },
		path: { type: ["string", "null"] }, sha256: { type: ["string", "null"] }, command_sha256: { type: ["string", "null"] }, reason: { type: "string" },
	} } },
	errors: { type: "array", items: { type: "string" } }, no_claim: { type: "string" },
} };

export const COMMANDS: readonly Command[] = [
	{ name: "heavy", description: "Run one load-admitted heavy command at nice 10", usage: "heavy [--label LABEL] [--no-wait] -- COMMAND [ARG ...]", argument: "COMMAND", flags: [
		{ name: "--label", value: "LABEL", description: "Name the job in load census records" },
		{ name: "--no-wait", description: "Return exit 75 instead of waiting when admission is unavailable" },
	], example: "omp-kit heavy --label cli-tests -- bun test tests/cli", runnable: true },
	{ name: "status", description: "Inspect kit and OMP presence without changing configuration", usage: "status", flags: [], example: "omp-kit status --json", runnable: true, dataSchema: statusData },
	{ name: "planning", description: "Score planning history, beads and CI evidence", usage: "planning score [--repo PATH] [--fleet] [--json]", flags: [], example: "omp-kit planning score --fleet --json", subcommands: [
		{ name: "score", description: "Score mission planning evidence without writing repository state", usage: "planning score [--repo PATH] [--fleet] [--json]", flags: [
			{ name: "--repo", value: "PATH", description: "Score one repository; defaults to the current directory" },
			{ name: "--fleet", description: "Score the repositories declared in the kit planning-score tuning file" },
		], example: "omp-kit planning score --fleet --json", runnable: false, dataSchema: planningScoreData },
	], runnable: false },
	{ name: "mission", description: "Validate the local Mission Protocol record without running its checks", usage: "mission validate [--project PATH] [--json]", flags: [], subcommands: [
		{ name: "validate", description: "Check required mission fields and registered check hashes", usage: "mission validate [--project PATH] [--json]", flags: [
			{ name: "--project", value: "PATH", description: "Project root to validate; defaults to the current directory" },
		], example: "omp-kit mission validate --json", runnable: false, dataSchema: missionData },
	], example: "omp-kit mission validate --json", runnable: false },
	{ name: "load", description: "Inspect machine load attribution or run the opt-in census watcher", usage: "load watch", flags: [], subcommands: [{ name: "watch", description: "Write one load census sample to the state-root census files", usage: "load watch", flags: [], example: "omp-kit load watch --json", runnable: false, dataSchema: loadData }], runnable: false, dataSchema: loadData },
	{ name: "doctor", description: "Diagnose installed components (deeper probe needs separate consent)", usage: "doctor [--scope COMPONENT] [--project PATH --file PATH] [--profile NAME] [--sources] [--services PATH] [--deep --yes]", flags: [
			{ name: "--scope", value: "kit|omp|rules|policy|settings|extensions|router|profile|lsp|project-loading|work|sessions|load|memory|mcp|context|browsers|services|regex-tools|dicklesworthstone|beads|reservations", description: "Restrict diagnosis to a named component; beads checks that acceptance is kept in its dedicated field; reservations reports exclusive holds past the age limit" },
		{ name: "--corpus-report", value: "ABS_FILE", description: "Rules calibration: read an F2 corpus JSON report without writing" },
		{ name: "--labels", value: "ABS_FILE", description: "Rules calibration: read deterministic false-fire labels without writing" },
		{ name: "--seed", value: "N", description: "Rules calibration sampling seed" },
		{ name: "--sample-size", value: "N", description: "Rules calibration maximum labels per rule" },
		{ name: "--noisy-lower-bound", value: "P", description: "Rules calibration noisy-rule lower-bound threshold" },
		{ name: "--project", value: "PATH", description: "LSP, project-loading, context or beads: select a repository path instead of the current directory" },
		{ name: "--root", value: "PATHS", description: "Work scope root list separated by the platform path delimiter; defaults to OMP_KIT_WORK_ROOTS or ~/Developer" },
		{ name: "--timeout-ms", value: "N", description: "Work scope per-repository git command timeout in milliseconds" },
		{ name: "--jobs", value: "N", description: "Work scope bounded repository concurrency" },
		{ name: "--file", value: "PATH", description: "LSP only: inspect a target file without changing session cwd" },
		{ name: "--profile", value: "NAME", description: "Memory, MCP or context: inspect an on-disk profile, not effective runtime activation" },
		{ name: "--sources", description: "MCP only: list MCP servers configured for other harnesses (~/.claude.json, ~/.claude/mcp.json, ~/.cursor/mcp.json, ~/.codex/config.toml, ./.mcp.json) and which OMP profiles have each; read-only, env as names only" },
		{ name: "--services", value: "PATH", description: "Services only: validate a declared required-jobs JSON file against launchd inventory" },
		{ name: "--deep", available: true, description: "With --scope lsp, probe the built-in TypeScript route in a private fixture; other deep scopes remain unavailable" },
		{ name: "--yes", available: true, description: "Explicit consent for --scope lsp --deep; never implied by --robot" },
	], example: "omp-kit doctor --scope lsp --json", runnable: true, dataSchema: doctorData },
	{ name: "health", description: "Strict monitoring status", usage: "health", flags: [], example: "omp-kit health --json", runnable: true, dataSchema: statusData },
	{ name: "corpus", description: "Report per-rule fire rates over local OMP session transcripts; never uploads", usage: "corpus --sessions ABS_DIR [--out ABS_FILE] [--plan]", flags: [
		{ name: "--sessions", value: "ABS_DIR", description: "Absolute session transcripts root; read-only, never written" },
		{ name: "--out", value: "ABS_FILE", description: "Write the JSON report to this absolute path as well as stdout" },
		{ name: "--plan", description: "Print the session schema fields read before reading anything" },
	], example: "omp-kit corpus --sessions /absolute/sessions --json", runnable: true, dataSchema: { type: "object",
		required: ["overall"], properties: {
			overall: { enum: ["OK"] },
			corpus: { type: "object" },
			corpus_plan: { type: "object" },
		} } },
	{ name: "lsp", description: "Inspect installed OMP language-server readiness without starting servers", usage: "lsp setup --plan", flags: [], subcommands: [
		{ name: "setup", description: "Plan manual language-server setup; never install packages or start binaries", usage: "lsp setup --plan [--project PATH] [--file PATH]", flags: [
			{ name: "--plan", description: "Return read-only manual setup instructions" },
			{ name: "--project", value: "PATH", description: "Select session cwd instead of the current directory" },
			{ name: "--file", value: "PATH", description: "Inspect a target file without changing session cwd" },
		], example: "omp-kit lsp setup --plan --json", runnable: true, dataSchema: lspPlanData },
	], example: "omp-kit lsp setup --plan --json", runnable: true },
	{ name: "memory", description: "Separately consented, local covered-class audit of a selected Mnemopi store root", usage: "memory audit --store-root PATH --yes", flags: [], subcommands: [
		{ name: "audit", description: "Inspect pinned Mnemopi content columns without modifying stores; never certifies universal secret-freedom",
			usage: "memory audit --store-root PATH --yes", flags: [
				{ name: "--store-root", value: "PATH", description: "Absolute root containing mnemopi.db and every bank to inspect" },
				{ name: "--yes", description: "Separate explicit consent to inspect private memory rows" },
			], example: "omp-kit memory audit --store-root /private/isolated/mnemopi --yes --json",
			runnable: true, dataSchema: memoryAuditData },
	], example: "omp-kit memory audit --store-root /private/isolated/mnemopi --yes --json", runnable: true },
	{ name: "test", description: "Run bundled matcher conformance, external G1-G3 packs, a public-synthetic external G4 marker fixture, a required-capability check, per-profile integration proof, per-profile MCP callable proof, strict zero-break metamorphic relations, mutation adequacy, or repeat flake verdicts",
		usage: "test [--project PATH] [--full] [--record] [--capabilities ABS_JSON] | [--rules ABS_DIR --cases ABS_FILE [--live-fixture ABS_JSON]] | [--integrations [--profile A,B] [--plan] [--out ABS_FILE]] | [--mcp --profiles all|A,B [--servers A,B] [--call SERVER:TOOL:JSON [--expect SERVER:REGEX]]... [--startup-timeout-ms N]] | [--metamorphic [--rules ABS_DIR --cases ABS_FILE]] | [--mutants [--mutant-budget-secs N] [--rules ABS_DIR --cases ABS_FILE]] | [--repeat N [--scenario ID] [--baseline ABS_JSON]]", flags: [
		{ name: "--project", value: "PATH", description: "Inspect project overrides without executing project code (bundled mode only)" },
		{ name: "--full", description: "Request isolated live stage; cannot be combined with external packs" },
		{ name: "--record", description: "Record the verdict and the tested OMP in the private state root so status can flag a later OMP change (bundled mode only; the only write test makes)" },
		{ name: "--rules", value: "ABS_DIR", description: "Read-only external rules directory; run G1-G3 against its cases" },
		{ name: "--cases", value: "ABS_FILE", description: "Seven-column TSV cases file for the external rules" },
		{ name: "--live-fixture", value: "ABS_JSON", description: "Run one strict public-synthetic external G4 fixture after its selected G1-G3 pass" },
		{ name: "--capabilities", value: "ABS_JSON", description: "Check a declared required-capability set (skills, tools, rules, LSP) through OMP discovery; exit 1 on MISSING" },
		{ name: "--mutants", description: "Measure mutation adequacy of rule conditions against their cases through the real matcher" },
		{ name: "--mutant-budget-secs", value: "N", description: "Wall-clock budget bounding mutant evaluation; the report marks early stops truncated" },
		{ name: "--integrations", description: "Prove per-profile integrations live with a scripted mock model; never uploads" },
		{ name: "--profile", value: "NAME", description: "Integrations only: comma-separated profile names to prove" },
		{ name: "--plan", description: "Integrations only: print the scenario matrix without running anything" },
		{ name: "--out", value: "ABS_FILE", description: "Integrations only: write the JSON matrix report to this absolute path" },
		{ name: "--mcp", description: "Per profile, check each server's env references (ENV_UNSET) and !command values (COMMAND_FAILED), start a fresh OMP rpc session on a private mirror of the profile's MCP config, list each server's tools and make each --call through OMP; a call is CALLABLE only with no error-shaped text and a matching --expect (else CALL_FAILED or UNVERIFIED_RESULT); exit 1 unless every selected server is CALLABLE" },
		{ name: "--profiles", value: "NAMES|all", description: "MCP only: profiles to prove; all is the default profile plus every named profile" },
		{ name: "--servers", value: "NAMES|all", description: "MCP only: servers to prove; default is every server in each profile's mcp.json" },
		{ name: "--call", value: "SERVER:TOOL:JSON", repeatable: true, description: "MCP only: one tool call per server with a JSON object of arguments; repeat per server" },
		{ name: "--expect", value: "SERVER:REGEX", repeatable: true, description: "MCP only: a JS RegExp the --call result text for SERVER must match; without it a call is UNVERIFIED_RESULT, never CALLABLE" },
		{ name: "--startup-timeout-ms", value: "N", description: "MCP only: bound for OMP's initial MCP connections and each /mcp test (default 180000)" },
		{ name: "--repeat", value: "N", description: "Run live scenarios N times (1-1000) and judge the failure rate with exact binomial bounds plus Fisher against --baseline" },
		{ name: "--scenario", value: "ID", description: "Repeat only: run just this live scenario id from tests/live/scenarios.json" },
		{ name: "--metamorphic", description: "Report metamorphic relation breaks over authored cases through the G2 matcher path; exits 1 on any break" },
		{ name: "--baseline", value: "ABS_JSON", description: "Repeat only: absolute repeat receipt for Fisher comparison" },
	], example: "omp-kit test --rules /absolute/rules --cases /absolute/cases.tsv --live-fixture /absolute/live.json --json", runnable: false, dataSchema: testData },
	{ name: "review", description: "Compare authored rules or reduce a public-synthetic native false fire", usage: "review rules|reduce", flags: [], subcommands: [
		{ name: "rules", description: "Observe both rule versions on the frozen union of authored witnesses",
			usage: "review rules --incumbent-rules ABS_DIR --incumbent-cases ABS_FILE --candidate-rules ABS_DIR --candidate-cases ABS_FILE", flags: [
				{ name: "--incumbent-rules", value: "ABS_DIR", description: "Read-only incumbent rule directory" },
				{ name: "--incumbent-cases", value: "ABS_FILE", description: "Incumbent authored TSV; its witnesses cannot be erased by the candidate" },
				{ name: "--candidate-rules", value: "ABS_DIR", description: "Read-only candidate rule directory" },
				{ name: "--candidate-cases", value: "ABS_FILE", description: "Candidate authored TSV in the existing seven-column format" },
			], example: "omp-kit review rules --incumbent-rules /old/rules --incumbent-cases /old/cases.tsv --candidate-rules /new/rules --candidate-cases /new/cases.tsv --json",
			runnable: false, dataSchema: ruleReviewData },
		{ name: "reduce", description: "Minimize a reproduced public-synthetic quiet G2/G3 false-fire without weakening its benign context",
			usage: "review reduce --rules ABS_DIR --fixture ABS_JSON [--replay-only]", flags: [
				{ name: "--rules", value: "ABS_DIR", description: "Read-only absolute external rule directory" },
				{ name: "--fixture", value: "ABS_JSON", description: "Strict false-fire-fixture/v1 public-synthetic witness" },
				{ name: "--replay-only", description: "Reobserve the existing witness without reducing or exporting on a miss" },
			], example: "omp-kit review reduce --rules /absolute/rules --fixture /absolute/fixture.json --json",
			runnable: false, dataSchema: falseFireData },
	], example: "omp-kit help review rules", runnable: true },
	{ name: "update", description: "Preview or guardedly update the kit; OMP updates are managed externally", usage: "update [--plan|--apply] --version X.Y.Z --index PATH --archive PATH", flags: [
		...planApply,
		{ name: "--version", value: "X.Y.Z", description: "Exact kit version; never infer latest from an unverified source" },
		{ name: "--index", value: "PATH", description: "Absolute local release index carrying kit archive integrity hashes" },
		{ name: "--archive", value: "PATH", description: "Absolute local release archive matching the selected index" },
	], example: "omp-kit update --plan --version 1.2.3 --index /absolute/release-index.json --archive /absolute/omp-kit.tar --json", runnable: false, mutation: true },
	{ name: "apply", description: "Plan or apply a named kit component", usage: "apply rules|policy|extensions|plugin|mcp [--plan|--apply]", flags: [], subcommands: [
		{ name: "rules", description: "Manage kit-owned rules", usage: "apply rules [--plan|--apply]", flags: planApply, example: "omp-kit apply rules --plan --json", runnable: false, mutation: true },
		{ name: "plugin", description: "Link the kit plugin package into covered OMP profiles with a receipt and undo", usage: "apply plugin [--plan|--apply] --store ABS_DIR [--regex-budget-report ABS_FILE] [--profiles NAMES|all] [--include-default]", flags: [...planApply,
			{ name: "--store", value: "ABS_DIR", description: "Absolute installed kit package root containing package.json, rules/, and extensions/" },
			{ name: "--regex-budget-report", value: "ABS_FILE", description: "Captured output from scripts/regex-budget.ts; failing rules are disabled only in named profiles" },
			{ name: "--profiles", value: "NAMES|all", description: "Select existing profiles; default is all covered profiles" },
			{ name: "--include-default", description: "Include the default profile explicitly; regex-budget exclusions never change its policy" },
		], example: "omp-kit apply plugin --apply --store /absolute/kit-release --regex-budget-report /absolute/regex-budget.out --profiles all --include-default --json", runnable: false, mutation: true },
		{ name: "policy", description: "Per-profile TTSR policy via native OMP config get/set with durable profile backup", usage: "apply policy [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Override optional XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json; absent file selects all named profiles or default if none exist" },
			{ name: "--include-default", description: "Include the default profile in the operator list or named selection" },
		], example: "omp-kit apply policy --plan --json", runnable: false, mutation: true },
		{ name: "extensions", description: "Opt-in guard extension for selected profiles", usage: "apply extensions [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Select existing named profiles" },
			{ name: "--include-default", description: "Include the default profile explicitly" },
		], example: "omp-kit apply extensions --plan --json", runnable: false, mutation: true },
		{ name: "mcp", description: "Import MCP servers from another harness config into OMP profiles' mcp.json, or edit servers already there (env !command values, re-enable), with a receipt and undo; interactive on a terminal without --servers/--profiles",
			usage: "apply mcp --from claude|cursor|codex|project|ABS_PATH --servers NAMES|all --profiles NAMES|all [--plan|--apply --yes] [--startup-timeout-ms N|NAME=N,...] [--override NAME=ABS_JSON]... [--env-literal NAMES] | apply mcp --profiles NAMES|all [--env-command SERVER:KEY=!CMD]... [--enable NAMES] [--plan|--apply --yes]", flags: [...planApply,
			{ name: "--from", value: "claude|cursor|codex|project|ABS_PATH", description: "Source harness config; claude reads ~/.claude.json and ~/.claude/mcp.json" },
			{ name: "--servers", value: "NAMES|all", description: "Source servers to import" },
			{ name: "--profiles", value: "NAMES|all", description: "Target OMP profiles; all is the default profile plus every named profile" },
			{ name: "--startup-timeout-ms", value: "N|NAME=N,...", description: "Write OMP's per-server timeout (ms), which also bounds the connect handshake; omitted servers keep OMP's 30000 default" },
			{ name: "--override", value: "NAME=ABS_JSON", repeatable: true, description: "Replace one source entry with a server entry from a JSON file, without editing the source config; recorded in the receipt" },
			{ name: "--env-literal", value: "NAMES", description: "Copy these env values verbatim (secret-scanned, never printed); every other env value is written as an env-var reference" },
			{ name: "--env-command", value: "SERVER:KEY=!CMD", repeatable: true, description: "Edit mode: set env KEY of an existing SERVER entry to an OMP !command value (OMP runs it and caches stdout), in place; every other byte is kept; the command text is secret-scanned" },
			{ name: "--enable", value: "NAMES", description: "Edit mode: remove these servers from a profile's disabledServers list, in place" },
		], example: "omp-kit apply mcp --from claude --servers z3-prover --profiles all --plan --json", runnable: false, mutation: true },
	], example: "omp-kit apply rules --plan --json", runnable: false, mutation: true },
	{ name: "repair", description: "Plan a named reversible repair", usage: "repair --scope rules|policy|extensions|state [--plan|--apply --yes]", flags: [
		{ name: "--scope", value: "rules|policy|extensions|state", description: "Required exact reversible repair scope; state only restores the private state root to mode 0700" }, ...planApply,
	], example: "omp-kit repair --scope rules --plan --json", runnable: false, mutation: true, dataSchema: repairData },
	{ name: "migrate", description: "Move legacy ~/.agents/rules kit copies to native plugin layering; edited copies are kept and flagged for overlay", usage: "migrate [--plan|--apply --yes]", flags: planApply, example: "omp-kit migrate --plan --json", runnable: false, mutation: true, dataSchema: migrateData },
	{ name: "undo", description: "Guardedly restore one verified receipt", usage: "undo RUN_ID [--yes]", argument: "RUN_ID", flags: [
		{ name: "--yes", description: "Confirm restore after state verification" },
	], example: "omp-kit undo RUN_ID --yes", runnable: false, mutation: true },
	{ name: "audit", description: "Inspect receipt chronology", usage: "audit", flags: [], example: "omp-kit audit --json", runnable: false },
	{ name: "why", description: "Explain one recorded run", usage: "why RUN_ID", argument: "RUN_ID", flags: [], example: "omp-kit why RUN_ID --json", runnable: false },
	{ name: "quickstart", description: "Safe first commands and their limits", usage: "quickstart", flags: [], example: "omp-kit quickstart", runnable: true, dataSchema: textData },
	{ name: "examples", description: "Read-only examples and versioned profile recipes; never activates a profile", usage: "examples [memory-off|mnemopi-manual|model-roles|mcp|omp-watch|skill-set --from-history DAYS [--profile NAME]]", flags: [],
		subcommandOptional: true, subcommands: [
			...PROFILE_RECIPE_KINDS.map((kind) => ({
				name: kind, description: "Show a versioned, unverified profile recipe for manual use",
				usage: `examples ${kind}`, flags: [], example: `omp-kit examples ${kind} --json`, runnable: true, dataSchema: profileRecipeData,
			})),
			{ name: "mcp", description: "Show a static manual example for an existing named MCP profile",
				usage: "examples mcp", flags: [], example: "omp-kit examples mcp --json", runnable: true, dataSchema: textData },
			{ name: "skill-set", description: "Derive a usage-based candidate skill set from session history and render a pruned-profile recipe; never applies it",
				usage: "examples skill-set --from-history DAYS [--profile NAME]", flags: [
					{ name: "--from-history", value: "DAYS", description: "Look back this many days of session transcripts (1..90)" },
					{ name: "--profile", value: "NAME", description: "Profile whose history and settings are measured (default profile when omitted)" },
				], example: "omp-kit examples skill-set --from-history 7 --json", runnable: true, dataSchema: { type: "object",
					required: ["overall", "skill_set"], properties: {
						overall: { enum: ["OK", "DEGRADED"] },
						skill_set: { type: "object", required: ["candidate_skills", "reads", "explicit", "history", "bytes_before", "bytes_after", "capability_check", "recipe", "guidance"] },
					} } },
			{ name: "omp-watch", description: "Render the managed omp-watch launchd/systemd job exactly as service install would write it; never installs it",
				usage: "examples omp-watch", flags: [], example: "omp-kit examples omp-watch --json", runnable: true, dataSchema: { type: "object",
					required: ["label", "watch_path", "launchd_plist", "systemd_path_unit", "systemd_service_unit", "guidance"], properties: {
						label: { type: "string" }, watch_path: { type: "string" }, launchd_plist: { type: "string" },
						systemd_path_unit: { type: "string" }, systemd_service_unit: { type: "string" }, guidance: { type: "string" },
					} } },
		], example: "omp-kit examples", runnable: true, dataSchema: textData },
	{ name: "service", description: "Manage operator service jobs (launchd/systemd); reads foreign jobs, never rewrites them", usage: "service list|install|uninstall|status|doctor|logs|run", flags: [], subcommands: [
		{ name: "list", description: "List known jobs with installed and loaded state", usage: "service list", flags: [], example: "omp-kit service list --json", runnable: false, dataSchema: serviceData },
		{ name: "install", description: "Install a job: render, diff, backup, bootstrap, verify; refuses a label loaded from a different plist unless --replace", usage: "service install JOB [--dry-run] [--apply --yes] [--replace]", argument: "JOB", flags: [
			{ name: "--dry-run", description: "Render the plist, diff and commands without changing anything" },
			{ name: "--apply", description: "Request guarded install" },
			{ name: "--yes", description: "Confirm the install in noninteractive mode" },
			{ name: "--replace", description: "Take over a label already loaded from a different plist (a backup is kept)" },
		], example: "omp-kit service install omp-watch --dry-run --json", runnable: false, mutation: true, dataSchema: serviceData },
		{ name: "uninstall", description: "Bootout a job and move its plist to the backup dir (logs kept unless --purge-logs)", usage: "service uninstall JOB [--purge-logs] [--apply --yes]", argument: "JOB", flags: [
			{ name: "--purge-logs", description: "Delete the job's logs as well as moving the plist" },
			{ name: "--apply", description: "Request guarded uninstall" },
			{ name: "--yes", description: "Confirm the uninstall in noninteractive mode" },
		], example: "omp-kit service uninstall omp-watch --apply --yes --json", runnable: false, mutation: true, dataSchema: serviceData },
		{ name: "status", description: "Read-only loaded state for one job or --all", usage: "service status [JOB|--all]", argument: "JOB", flags: [
			{ name: "--all", description: "Report every known job" },
		], example: "omp-kit service status omp-watch --json", runnable: false, dataSchema: serviceData },
		{ name: "doctor", description: "Read-only checks for one job or --all; --fix reinstalls and rotates own logs", usage: "service doctor [JOB|--all] [--fix --apply --yes]", argument: "JOB", flags: [
			{ name: "--all", description: "Check every known job" },
			{ name: "--fix", description: "Reinstall drifted jobs and rotate oversized own logs" },
			{ name: "--apply", description: "Request guarded fixes" },
			{ name: "--yes", description: "Confirm fixes in noninteractive mode" },
		], example: "omp-kit service doctor omp-watch --json", runnable: false, mutation: true, dataSchema: serviceData },
		{ name: "logs", description: "Print a job's out/err logs", usage: "service logs JOB [--errors] [-n N]", argument: "JOB", flags: [
			{ name: "--errors", description: "Show the error log instead of the output log" },
			{ name: "-n", value: "N", description: "Print the last N lines" },
		], example: "omp-kit service logs omp-watch --json", runnable: false, dataSchema: serviceData },
		{ name: "run", description: "Execute one job now (what launchd runs); writes a receipt (omp-watch tests OMP, scratch-reaper applies scratch quarantine/deletion)", usage: "service run JOB", argument: "JOB", flags: [], example: "omp-kit service run omp-watch --json", runnable: false, dataSchema: serviceData },
	], example: "omp-kit service list --json", runnable: false, dataSchema: serviceData },
	{ name: "send", description: "Send a message to a fleet pane and prove it landed (marker poll up to 15 s, one retry, drop-folder fallback)", usage: "send SESSION PANE MESSAGE", flags: [
		{ name: "--drop-dir", value: "PATH", description: "Drop folder for undelivered messages (default: state-root send-drop)" },
	], example: "omp-kit send omp-test %54 \"status update\" --json", runnable: false, dataSchema: sendData },
	{ name: "infra", description: "Pin, check and promote the toolchain the gates run on (test before upgrade, human promotes)", usage: "infra pin|check|promote|undo", flags: [], subcommands: [
		{ name: "pin", description: "Show pinned toolchain versions and drift against installed", usage: "infra pin [--file PATH]", flags: [
			{ name: "--file", value: "PATH", description: "Pin file to read (default: kit .omp/infra-pins.toml)" },
		], example: "omp-kit infra pin --json", runnable: false, dataSchema: infraData },
		{ name: "check", description: "Run the ladder with a candidate binary first on PATH and name the failing stage", usage: "infra check --tool NAME --candidate VERSION --binary PATH [--prefix DIR] [--wait] [--force]", flags: [
			{ name: "--tool", value: "NAME", description: "Tool to check (bun, typescript-language-server)" },
			{ name: "--candidate", value: "VERSION", description: "Candidate version under test" },
			{ name: "--binary", value: "PATH", description: "Candidate binary to stage into the isolated prefix" },
			{ name: "--prefix", value: "DIR", description: "Isolated prefix root (default: state-root infra-check)" },
			{ name: "--wait", description: "Wait for the load to drop under 1.5x cores instead of refusing" },
			{ name: "--wait-timeout-min", value: "N", description: "Minutes to wait for quiet with --wait (default 120)" },
			{ name: "--force", description: "Run now above the load limit; the verdict is INCONCLUSIVE" },
		], example: "omp-kit infra check --tool bun --candidate 1.5.0 --binary /tmp/bun-1.5.0/bun --json", runnable: false, dataSchema: infraData },
		{ name: "promote", description: "Certify a checked candidate: update the pin with receipt (human only)", usage: "infra promote --tool NAME --candidate VERSION --binary PATH --human --apply --yes", flags: [
			{ name: "--tool", value: "NAME", description: "Tool to promote" },
			{ name: "--candidate", value: "VERSION", description: "Checked version to certify" },
			{ name: "--binary", value: "PATH", description: "Candidate binary (re-verified before certifying)" },
			{ name: "--human", description: "Explicit human authorization: Josh promotes, agents prepare" },
			{ name: "--apply", description: "Request the guarded pin update" },
			{ name: "--yes", description: "Confirm the pin update in noninteractive mode" },
		], example: "omp-kit infra promote --tool bun --candidate 1.5.0 --binary /tmp/bun-1.5.0/bun --human --apply --yes --json", runnable: false, mutation: true, dataSchema: infraData },
		{ name: "undo", description: "Restore the pin file from a promote backup", usage: "infra undo --receipt PATH --apply --yes", flags: [
			{ name: "--receipt", value: "PATH", description: "Promote receipt naming the backup to restore" },
			{ name: "--apply", value: "PATH", description: "Request the guarded restore" },
			{ name: "--yes", description: "Confirm the restore in noninteractive mode" },
		], example: "omp-kit infra undo --receipt PATH --apply --yes --json", runnable: false, mutation: true, dataSchema: infraData },
	], example: "omp-kit infra pin --json", runnable: false, dataSchema: infraData },
	{ name: "scratch", description: "Release finished owned task scratch; reap dead owned sessions, quarantine released or idle unowned entries, delete expired quarantine", usage: "scratch plan|release DIR|apply [--apply --yes]", flags: [], subcommands: [
		{ name: "plan", description: "Read-only reap report over all scratch roots; changes nothing", usage: "scratch plan", flags: [], example: "omp-kit scratch plan --json", runnable: false, dataSchema: scratchData },
		{ name: "release", description: "Mark one finished task directory for quarantine; only its owning process or a child process may release it", usage: "scratch release DIR", argument: "DIR", flags: [], example: "omp-kit scratch release /repo/var/agent-tmp/omp.123 --json", runnable: false, dataSchema: scratchReleaseData },
		{ name: "apply", description: "Quarantine and delete per the plan, then kill orphaned harness servers", usage: "scratch apply [--apply --yes]", flags: [
			{ name: "--apply", description: "Request guarded apply" },
			{ name: "--yes", description: "Confirm the apply in noninteractive mode" },
		], example: "omp-kit scratch apply --apply --yes --json", runnable: false, mutation: true, dataSchema: scratchData },
	], example: "omp-kit scratch plan --json", runnable: false, dataSchema: scratchData },
	{ name: "help", description: "Show grammar for a topic", usage: "help [TOPIC]", argument: "TOPIC", flags: [], example: "omp-kit help update", runnable: true, dataSchema: textData },
	{ name: "completion", description: "Generate shell completion for documented grammar", usage: "completion bash|zsh|fish", flags: [], subcommands: [
		{ name: "bash", description: "Bash completion", usage: "completion bash", flags: [], example: "omp-kit completion bash", runnable: true, dataSchema: completionData },
		{ name: "zsh", description: "Zsh completion", usage: "completion zsh", flags: [], example: "omp-kit completion zsh", runnable: true, dataSchema: completionData },
		{ name: "fish", description: "Fish completion", usage: "completion fish", flags: [], example: "omp-kit completion fish", runnable: true, dataSchema: completionData },
	], example: "omp-kit completion bash", runnable: true },
	{ name: "capabilities", description: "List only presently runnable commands", usage: "capabilities", flags: [], example: "omp-kit capabilities --json", runnable: true, dataSchema: grammarData },
	{ name: "schema", description: "Describe envelope, command data and grammar", usage: "schema", flags: [], example: "omp-kit schema --json", runnable: true, dataSchema: schemaData },
	{ name: "robot-docs", description: "Agent guidance from the live command grammar", usage: "robot-docs guide", flags: [], subcommands: [
		{ name: "guide", description: "Safe automation guidance", usage: "robot-docs guide", flags: [], example: "omp-kit robot-docs guide", runnable: true, dataSchema: textData },
	], example: "omp-kit robot-docs guide", runnable: true },
];

export function findCommand(name: string, children: readonly Command[] = COMMANDS): Command | undefined {
	return children.find((command) => command.name === name);
}

export function commandFlags(command: Command): readonly Flag[] {
	return [...GLOBAL_FLAGS, ...command.flags];
}
