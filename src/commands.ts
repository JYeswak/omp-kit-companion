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
const doctorData: DataSchema = { ...statusData, properties: { ...statusData.properties, report: lspReportData } };
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
	overall: { enum: ["UNVERIFIED"] }, action: { enum: ["PLAN", "APPLIED", "UNCHANGED"] },
	scope: { enum: ["rules", "policy", "extensions"] }, changes: { type: "number" },
	steps: { type: "array", items: { type: "object", required: ["action", "path"], properties: {
		action: { type: "string" }, path: { type: "string" }, profile: { type: "string" },
	} } }, receipt_id: { type: ["string", "null"] },
} };

export const COMMANDS: readonly Command[] = [
	{ name: "status", description: "Inspect kit and OMP presence without changing configuration", usage: "status", flags: [], example: "omp-kit status --json", runnable: true, dataSchema: statusData },
	{ name: "doctor", description: "Diagnose installed components (deeper probe needs separate consent)", usage: "doctor [--scope COMPONENT] [--project PATH --file PATH] [--profile NAME] [--deep --yes]", flags: [
		{ name: "--scope", value: "kit|omp|rules|policy|extensions|router|profile|lsp|project-loading|memory|mcp", description: "Restrict diagnosis to a named component" },
		{ name: "--project", value: "PATH", description: "LSP or project-loading: select session cwd instead of the current directory" },
		{ name: "--file", value: "PATH", description: "LSP only: inspect a target file without changing session cwd" },
		{ name: "--profile", value: "NAME", description: "Memory or MCP: inspect an on-disk profile, not effective runtime activation" },
		{ name: "--deep", available: false, description: "Request potentially migratory probe with guarded backup" },
		{ name: "--yes", available: false, description: "Consent to deep probe; not implied by --robot" },
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
	{ name: "test", description: "Run pack conformance and optional isolated live checks", usage: "test [--project PATH] [--full]", flags: [
		{ name: "--project", value: "PATH", description: "Inspect project overrides without executing project code" },
		{ name: "--full", description: "Request isolated live stage" },
	], example: "omp-kit test --json", runnable: false },
	{ name: "update", description: "Preview or guardedly update the kit; OMP updates are managed externally", usage: "update [--plan|--apply] --version X.Y.Z --index PATH --archive PATH", flags: [
		...planApply,
		{ name: "--version", value: "X.Y.Z", description: "Exact kit version; never infer latest from an unverified source" },
		{ name: "--index", value: "PATH", description: "Absolute local release index carrying kit archive integrity hashes" },
		{ name: "--archive", value: "PATH", description: "Absolute local release archive matching the selected index" },
	], example: "omp-kit update --plan --version 1.2.3 --index /absolute/release-index.json --archive /absolute/omp-kit.tar --json", runnable: false, mutation: true },
	{ name: "apply", description: "Plan or apply a named kit component", usage: "apply rules|policy|extensions [--plan|--apply]", flags: [], subcommands: [
		{ name: "rules", description: "Manage kit-owned rules", usage: "apply rules [--plan|--apply]", flags: planApply, example: "omp-kit apply rules --plan --json", runnable: false, mutation: true },
		{ name: "policy", description: "Opt-in policy for selected existing profiles", usage: "apply policy [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Select existing named profiles" },
			{ name: "--include-default", description: "Include the default profile explicitly" },
		], example: "omp-kit apply policy --plan --json", runnable: false, mutation: true },
		{ name: "extensions", description: "Opt-in guard extension for selected profiles", usage: "apply extensions [--plan|--apply]", flags: [...planApply,
			{ name: "--profiles", value: "NAMES|all", description: "Select existing named profiles" },
			{ name: "--include-default", description: "Include the default profile explicitly" },
		], example: "omp-kit apply extensions --plan --json", runnable: false, mutation: true },
	], example: "omp-kit apply rules --plan --json", runnable: false, mutation: true },
	{ name: "repair", description: "Plan a named reversible repair", usage: "repair --scope rules|policy|extensions [--plan|--apply --yes]", flags: [
		{ name: "--scope", value: "rules|policy|extensions", description: "Required exact reversible repair scope" }, ...planApply,
	], example: "omp-kit repair --scope rules --plan --json", runnable: false, mutation: true, dataSchema: repairData },
	{ name: "undo", description: "Guardedly restore one verified receipt", usage: "undo RUN_ID [--yes]", argument: "RUN_ID", flags: [
		{ name: "--yes", description: "Confirm restore after state verification" },
	], example: "omp-kit undo RUN_ID --yes", runnable: false, mutation: true },
	{ name: "audit", description: "Inspect receipt chronology", usage: "audit", flags: [], example: "omp-kit audit --json", runnable: false },
	{ name: "why", description: "Explain one recorded run", usage: "why RUN_ID", argument: "RUN_ID", flags: [], example: "omp-kit why RUN_ID --json", runnable: false },
	{ name: "quickstart", description: "Safe first commands and their limits", usage: "quickstart", flags: [], example: "omp-kit quickstart", runnable: true, dataSchema: textData },
	{ name: "examples", description: "Read-only examples and versioned profile recipes; never activates a profile", usage: "examples [memory-off|mnemopi-manual|model-roles|mcp]", flags: [],
		subcommandOptional: true, subcommands: [
			...PROFILE_RECIPE_KINDS.map((kind) => ({
				name: kind, description: "Show a versioned, unverified profile recipe for manual use",
				usage: `examples ${kind}`, flags: [], example: `omp-kit examples ${kind} --json`, runnable: true, dataSchema: profileRecipeData,
			})),
			{ name: "mcp", description: "Show a static manual example for an existing named MCP profile",
				usage: "examples mcp", flags: [], example: "omp-kit examples mcp --json", runnable: true, dataSchema: textData },
		], example: "omp-kit examples", runnable: true, dataSchema: textData },
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
