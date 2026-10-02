import { PROFILE_RECIPE_KINDS } from "./profile-recipes.ts";

export type Flag = {
	readonly aliases?: readonly string[];
	readonly dataSchema?: DataSchema;
	readonly name: string;
	readonly description: string;
	readonly value?: string;
	/** Documented but not advertised as runnable by capabilities until its mode is wired. */
	readonly available?: boolean;
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
		component: { type: "string" }, status: { enum: ["OK", "DEGRADED", "UNVERIFIED", "FAIL", "NOT_RUN"] }, reason: { type: "string" }, recommended_action: { type: "string" },
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
const doctorData: DataSchema = { ...statusData, properties: { ...statusData.properties, report: lspReportData, deep_probe: { oneOf: [deepDoctorData, lspProbeData] } } };
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

export const COMMANDS: readonly Command[] = [
	{ name: "status", description: "Inspect kit and OMP presence without changing configuration", usage: "status", flags: [], example: "omp-kit status --json", runnable: true, dataSchema: statusData },
	{ name: "doctor", description: "Diagnose installed components (deeper probe needs separate consent)", usage: "doctor [--scope COMPONENT] [--project PATH --file PATH] [--profile NAME] [--services PATH] [--deep --yes]", flags: [
		{ name: "--scope", value: "kit|omp|rules|policy|settings|extensions|router|profile|lsp|project-loading|memory|mcp|context|services|dicklesworthstone", description: "Restrict diagnosis to a named component; settings reads native TTSR keys selected by optional XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json, or all profiles when absent" },
		{ name: "--project", value: "PATH", description: "LSP, project-loading or context: select session cwd instead of the current directory" },
		{ name: "--file", value: "PATH", description: "LSP only: inspect a target file without changing session cwd" },
		{ name: "--profile", value: "NAME", description: "Memory, MCP or context: inspect an on-disk profile, not effective runtime activation" },
		{ name: "--services", value: "PATH", description: "Services only: validate a declared required-jobs JSON file against launchd inventory" },
		{ name: "--deep", available: true, description: "With --scope lsp, probe the built-in TypeScript route in a private fixture; other deep scopes remain unavailable" },
		{ name: "--yes", available: true, description: "Explicit consent for --scope lsp --deep; never implied by --robot" },
	], example: "omp-kit doctor --scope lsp --json", runnable: true, dataSchema: doctorData },
	{ name: "health", description: "Strict monitoring status", usage: "health", flags: [], example: "omp-kit health --json", runnable: true, dataSchema: statusData },
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
	{ name: "test", description: "Run bundled matcher conformance, external G1-G3 packs, a public-synthetic external G4 marker fixture, a required-capability check, per-profile integration proof, metamorphic relation report, or mutation adequacy",
		usage: "test [--project PATH] [--full] [--record] [--capabilities ABS_JSON] | [--rules ABS_DIR --cases ABS_FILE [--live-fixture ABS_JSON]] | [--integrations [--profile A,B] [--plan] [--out ABS_FILE]] | [--metamorphic [--rules ABS_DIR --cases ABS_FILE [--baseline ABS_FILE]]] | [--mutants [--mutant-budget-secs N] [--rules ABS_DIR --cases ABS_FILE]]", flags: [
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
		{ name: "--metamorphic", description: "Report metamorphic relation breaks over authored cases through the G2 matcher path; exits 1 on any break, or only on NEW breaks with --baseline" },
		{ name: "--baseline", value: "ABS_FILE", description: "Metamorphic only: ratchet against a checked-in baseline of known break ids; exits 1 only on NEW breaks" },
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
	{ name: "apply", description: "Plan or apply a named kit component", usage: "apply rules|policy|extensions [--plan|--apply]", flags: [], subcommands: [
		{ name: "rules", description: "Manage kit-owned rules", usage: "apply rules [--plan|--apply]", flags: planApply, example: "omp-kit apply rules --plan --json", runnable: false, mutation: true },
		{ name: "policy", description: "Per-profile TTSR policy via native OMP config get/set with durable profile backup", usage: "apply policy [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Override optional XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json; absent file selects all named profiles or default if none exist" },
			{ name: "--include-default", description: "Include the default profile in the operator list or named selection" },
		], example: "omp-kit apply policy --plan --json", runnable: false, mutation: true },
		{ name: "extensions", description: "Opt-in guard extension for selected profiles", usage: "apply extensions [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Select existing named profiles" },
			{ name: "--include-default", description: "Include the default profile explicitly" },
		], example: "omp-kit apply extensions --plan --json", runnable: false, mutation: true },
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
		{ name: "run", description: "Execute one job now (what launchd runs); writes a job receipt (omp-watch notifies on failure, scratch-reaper reports)", usage: "service run JOB", argument: "JOB", flags: [], example: "omp-kit service run omp-watch --json", runnable: false, dataSchema: serviceData },
	], example: "omp-kit service list --json", runnable: false, dataSchema: serviceData },
	{ name: "scratch", description: "Reap dead operator scratch: owned+dead+lsof-clear sessions, idle unowned quarantine, expired quarantine delete", usage: "scratch plan|apply [--apply --yes]", flags: [], subcommands: [
		{ name: "plan", description: "Read-only reap report over all scratch roots; changes nothing", usage: "scratch plan", flags: [], example: "omp-kit scratch plan --json", runnable: false, dataSchema: scratchData },
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
