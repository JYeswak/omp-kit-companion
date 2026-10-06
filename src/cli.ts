#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { isatty } from "node:tty";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { COMMANDS, GLOBAL_FLAGS, REFUSAL_DATA_SCHEMA, commandFlags, findCommand, type Command, type Flag } from "./commands.ts";
import { audit, undo, why } from "./audit.ts";
import { applyExtensions, inspectPendingExtensions, planExtensions } from "./apply-extensions.ts";
import { analyzeRegexBudgetOutput, applyPlugin, planPlugin, pluginPackageHash, pluginProfileHashes, readPluginReceipt, undoPlugin, type PluginProfile, type PluginRunner, type PluginSnapshot, type RegexBudgetSelection } from "./apply-plugin.ts";
import { applyPolicyPlan, inspectPolicySettings, planPolicy } from "./apply-policy.ts";
import { applyRulePlan, planRules } from "./apply-rules.ts";
import { applyMigration, planMigration, planMigrationMutation } from "./migrate.ts";
import { applyRepairPlan, planDeepDoctor, planRepair, type RepairDecision } from "./repair.ts";
import { ContextInputError, contextFinding, runCapabilitiesCheck, runContextInventory, validateProfileName } from "./context.ts";
import { renderSkillSet, SkillSetInputError } from "./skill-set.ts";
import { CORPUS_PLAN, CorpusInputError, runCorpus } from "./corpus.ts";
import { calibrateCorpus, type CalibrationInput, type FireLabel } from "./rule-calibration.ts";
import { diagnose, health, inspectDicklesworthstone, inspectRegexTools, type DiagnosticStatus, type Finding } from "./diagnostics.ts";
import { inspectWorkFleet, resolveWorkRoots } from "./work-doctor.ts";
import { applyBrowserReap, collectBrowserProcesses, inspectBrowserProcesses, planBrowserReap } from "./browser-doctor.ts";
import { inspectOmpSessions } from "./session-doctor.ts";
import { censusLoad } from "./load-doctor.ts";
import { loadFleetWatchConfig, runFleetWatchOnce } from "./fleet-watch.ts";
import { inspectLspReadiness, planLspSetup, type LspReadinessInput, type LspReadinessReport } from "./lsp-readiness.ts";
import { probeLspReadiness } from "./lsp-probe.ts";
import { inspectMcpReadiness, mcpExample } from "./mcp-readiness.ts";
import { discoverSources, inspectMcpSources, listOmpProfiles, readSource, selectProfiles, type OmpProfileDir } from "./mcp-sources.ts";
import { applyMcpPlan, chooseMcpSelection, McpApplyError, parseEnvCommand, parseTimeouts, planMcpApply, planMcpEdit, readOverride, type McpApplyPlan, type WizardIo } from "./mcp-apply.ts";
import { parseCallSpec, parseExpectSpec, probeMcpProfiles, type McpCallSpec } from "./mcp-probe.ts";
import { defaultInventoryDeps, inventoryServices, ServicesInputError } from "./services.ts";
import { auditMemoryAtRest } from "./memory-audit.ts";
import { inspectMemoryReadiness } from "./memory-readiness.ts";
import { applyKitUpdate, kitUpdateEnvelope, planKitUpdate, undoKitUpdate, type KitUpdateInput } from "./kit-update.ts";
import { runKitUpdateJob } from "./kit-update-job.ts";
import { ensureMutationStateRoot, writePrivate, type PendingInspection } from "./mutations.ts";
import { releaseRoot, resolveOmpIdentity } from "./paths.ts";
import { inspectProjectTrust } from "./project-trust.ts";
import { PROFILE_RECIPE_KINDS, renderRecipe } from "./profile-recipes.ts";
import { confirmMutation, renderOutput, type PresentationResult } from "./output.ts";
import { runFullTest, type FullTestReport } from "./full-test-runner.ts";
import { ompFingerprint, recordTestReceipt, type OmpFingerprint } from "./omp-watch.ts";
import { inspectStateRoot, repairStateRootMode, type StateRootIssue } from "./state-root.ts";
import { runFastTest, type FastTestReport } from "./test-runner.ts";
import { parseRepeatReceipt, repeatVerdict, type RepeatReceipt } from "./repeat-stats.ts";
import { runMutants, MutantsInputError } from "./mutants.ts";
import { runMetamorphicReport } from "./metamorphic.ts";
import { INTEGRATIONS, runIntegrations, IntegrationsInputError } from "./integrations.ts";
import { ExternalPackInputError, readExternalPackSnapshot, runExternalPackTest } from "./external-pack.ts";
import { runInstalledRuleReview } from "./rule-review-runner.ts";
import { FalseFireInputError, runFalseFireReduction } from "./false-fire.ts";
import { matchesBounded } from "./regex-guards.ts";
import { ExternalLiveInputError, runExternalLive, type ExternalLiveInput } from "./external-live.ts";
import { KNOWN_JOBS, checkService, checkServiceLinux, defaultRunner, domain, executableFile, installService, installSystemd, jobReceiptPath, notifyJobFailure, oversizedOwnLogs, parseLaunchctlPrint, planInstall, plistPath, queryPrint, readInstalledPlist, renderLaunchdPlist, renderSystemdUnits, resolveWatchTarget, runLoadWatch, serviceLabel, stableLauncher, serviceHome, systemctlState, systemdTimer, uninstallService, uninstallSystemd, type ServiceCheck, type ServiceJobDef } from "./service.ts";
import { applyScratch, defaultLiveness, defaultRunner as scratchRunner, isApplyFailure, planScratch, releaseScratch, type ScratchApplyResult } from "./scratch.ts";
import { runHeavy } from "./heavy.ts";
import { runPlanningScore } from "./planning-score.ts";
import { validateMissionRecord } from "./mission.ts";
import { checkInfraCandidate, diffInfraPins, loadGate, parseInfraPins, promoteInfra, updatePinVersion, type InfraPins } from "./infra.ts";
import { proveSend } from "./send.ts";
import { auditReservationAge } from "./reservation-age.ts";
import { acquireRunLock, bunCapExec, gateRunLoad, OVERLAP_EXIT, readJobOff, RUN_TIME_CAPS_MS, runWithCap, SKIPPED_LOAD_EXIT } from "./service-run.ts";
import { appendLesson, appendLessonAndCommit, collectCheckinActivity, inspectLessons, latestCheckinAt, lessonIdentity, readLessonsLog, writeCheckin, writeCheckinAndCommit, type AddLessonInput, type CheckinInput, type LessonClass } from "./lessons.ts";
import { readLessonsConfig, runFleetLessonsOnce } from "./fleet-lessons.ts";

const SCHEMA_VERSION = "1";
const PROOF_CLASSES = ["G1 registration", "G2 payload", "G3 prefixes", "G4 isolated live", "installed files", "project shadow", "effective profile"] as const;
const EXIT_CODES = { success: 0, finding: 1, usage_or_blocked: 2, unavailable: 3, retryable: 4 } as const;

export type CliResult = PresentationResult;
export type ParsedCommand = { command: Command; parent?: Command; flags: ReadonlyMap<string, string | true>; argument?: string; commandArgs?: readonly string[]; json: boolean; robot: boolean };
export type CommandHandler = (request: ParsedCommand) => CliResult | Promise<CliResult>;
const handlers = new Map<string, CommandHandler>();

/** Register a real handler by grammar path (e.g. "apply rules"); absent handlers remain unavailable. */
export function registerCommandHandler(path: string, handler: CommandHandler): void {
	const parts = path.split(" ");
	const parent = findCommand(parts[0] ?? "");
	const command = parts.length === 2 ? findCommand(parts[1] ?? "", parent?.subcommands) : parent;
	if (parts.length > 2 || !command || (parts.length === 2 && !parent?.subcommands)) throw new Error(`unknown grammar command: ${path}`);
	if ((command.runnable && path !== "status") || handlers.has(path)) throw new Error(`command already registered: ${path}`);
	handlers.set(path, handler);
}

function isRunnable(command: Command, path: string): boolean {
	if (command.subcommands) return command.subcommands.some((child) => isRunnable(child, `${path} ${child.name}`));
	return command.runnable || handlers.has(path);
}

function availableCommands(commands: readonly Command[] = COMMANDS, prefix = ""): Command[] {
	return commands.filter((command) => isRunnable(command, `${prefix}${command.name}`)).map((command) => ({
		...command,
		runnable: true,
		flags: command.flags.filter((flag) => flag.available !== false),
		...(command.subcommands ? { subcommands: availableCommands(command.subcommands, `${prefix}${command.name} `) } : {}),
	}));
}

function printableFlags(flags: readonly Flag[]): string {
	return flags.map((flag) => `  ${flag.name}${flag.aliases?.length ? ` (${flag.aliases.join(", ")})` : ""}${flag.value ? ` ${flag.value}` : ""}  ${flag.description}${flag.available === false ? " (not yet available)" : ""}`).join("\n");
}

function help(command?: Command, parent?: Command): string {
	if (command) {
		const children = command.subcommands?.map((child) => `  ${child.usage} — ${child.description}${isRunnable(child, `${command.name} ${child.name}`) ? "" : " (not yet available)"}`).join("\n");
		return [`Usage: omp-kit ${command.usage}`, command.description,
			isRunnable(command, `${parent ? `${parent.name} ` : ""}${command.name}`) ? "" : "Handler not yet available; no action will be taken.",
			children ? `Subcommands:\n${children}` : "", `Flags:\n${printableFlags(commandFlags(command))}`,
			`Example: ${command.example}`].filter(Boolean).join("\n\n");
	}
	const scoped = COMMANDS.flatMap((command) => [
		...(command.flags.length ? [`  ${command.name}: ${command.flags.map((flag) => flag.name).join(" ")}`] : []),
		...(command.subcommands?.filter((child) => child.flags.length).map((child) => `  ${command.name} ${child.name}: ${child.flags.map((flag) => flag.name).join(" ")}`) ?? []),
	]);
	return ["Usage: omp-kit [GLOBAL FLAGS] [COMMAND] [FLAGS]", "Bare invocation inspects kit and OMP presence; it never applies rules or modifies profiles.",
		"Commands:", ...COMMANDS.map((item) => `  ${item.usage} — ${item.description}${isRunnable(item, item.name) ? "" : " (not yet available)"}`),
		`Global flags:\n${printableFlags(GLOBAL_FLAGS)}`, "Scoped flags:", ...scoped,
		"Use omp-kit help TOPIC for flag details. Unavailable handlers refuse without mutation."].join("\n");
}

function nearest(value: string, choices: readonly string[]): string | undefined {
	let best: string | undefined;
	let distance = 3;
	for (const candidate of choices) {
		const row = Array.from({ length: candidate.length + 1 }, (_, index) => index);
		for (let i = 1; i <= value.length; i++) {
			let prior = row[0] ?? 0;
			row[0] = i;
			for (let j = 1; j <= candidate.length; j++) {
				const previous = row[j] ?? 0;
				row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, prior + (value[i - 1] === candidate[j - 1] ? 0 : 1));
				prior = previous;
			}
		}
		const score = row[candidate.length] ?? 3;
		if (score < distance) { distance = score; best = candidate; }
		else if (score === distance) best = undefined; // ambiguous suggestions never authorize execution
	}
	return best;
}

function refusal(code: string, message: string, remediation: string): CliResult {
	return { code: 2, data: { overall: "NOT_RUN" }, errors: [{ code, message, remediation }], verification: "NOT_RUN" };
}

type ParseResult = { request: ParsedCommand } | { failure: CliResult; json: boolean };
function parse(args: readonly string[]): ParseResult {
	const separator = args.indexOf("--");
	const outerArgs = separator < 0 ? args : args.slice(0, separator);
	const childArgs = separator < 0 ? undefined : args.slice(separator + 1);
	const json = outerArgs.includes("--json") || outerArgs.includes("--robot");
	// A lone --version/-V is the conventional version query; `update --version X.Y.Z` keeps its meaning.
	const lone = outerArgs.filter((arg) => arg !== "--json" && arg !== "--robot" && arg !== "--no-color");
	if (lone.length === 1 && (lone[0] === "--version" || lone[0] === "-V"))
		return { request: { command: { name: "--version", usage: "--version", description: "Print the kit version", flags: [], example: "omp-kit --version", runnable: true }, flags: new Map(), json, robot: outerArgs.includes("--robot") } };
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	let command: Command | undefined;
	let parent: Command | undefined;
	for (let i = 0; i < outerArgs.length; i++) {
		const token = outerArgs[i] ?? "";
		if (!token.startsWith("-")) {
			positional.push(token);
			if (positional.length === 1) command = findCommand(token);
			if (positional.length === 2 && command?.subcommands) { parent = command; command = findCommand(token, command.subcommands); }
			continue;
		}
		const [rawName, attached] = token.split("=", 2);
		const known = [...GLOBAL_FLAGS, ...COMMANDS.flatMap((item) => item.flags), ...COMMANDS.flatMap((item) => item.subcommands?.flatMap((child) => child.flags) ?? [])];
		const flag = known.find((candidate) => candidate.name === rawName || candidate.aliases?.includes(rawName ?? ""));
		const name = flag?.name ?? rawName;
		if (!flag) {
			const hint = nearest(rawName ?? token, known.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));
			return { failure: refusal("UNKNOWN_FLAG", `Unknown flag: ${name}`, hint ? `Use ${hint} exactly; run omp-kit --help for grammar.` : "Run omp-kit --help for valid flags."), json };
		}
		if (flag.value) {
			const value = attached ?? outerArgs[++i];
			if (!value || value.startsWith("--")) return { failure: refusal("MISSING_VALUE", `${name} needs ${flag.value}`, `Use ${name} ${flag.value}.`), json };
			flags.set(name ?? "", flag.repeatable && typeof flags.get(name ?? "") === "string" ? `${String(flags.get(name ?? ""))}\n${value}` : value);
		} else {
			if (attached !== undefined) return { failure: refusal("UNEXPECTED_VALUE", `${name} does not take a value`, `Use ${name} without a value.`), json };
			flags.set(name ?? "", true);
		}
	}
	if (flags.has("--info") && positional.length === 0) return { request: { command: { name: "--info", usage: "--info", description: "Executable identity", flags: [], example: "omp-kit --info", runnable: true }, flags, json, robot: flags.has("--robot") } };
	if (flags.has("--info")) return { failure: refusal("INVALID_FLAG", "--info is a standalone global request", "Run omp-kit --info."), json };
	if (!positional.length) command = findCommand(flags.has("--help") ? "help" : "status");
	if (!command) {
		const candidates = parent?.subcommands ?? COMMANDS;
		const bad = positional[parent ? 1 : 0] ?? "";
		const hint = nearest(bad, candidates.map((item) => item.name));
		return { failure: refusal(parent ? "UNKNOWN_SUBCOMMAND" : "UNKNOWN_COMMAND", `Unknown ${parent ? "subcommand" : "command"}: ${bad}`, hint ? `Try omp-kit ${parent ? `${parent.name} ` : ""}${hint} exactly; no command was run.` : "Run omp-kit --help; no command was run."), json };
	}
	if (separator >= 0 && command.name !== "heavy") return { failure: refusal("UNEXPECTED_SEPARATOR", "The `--` command separator is supported only by heavy", "Run omp-kit heavy [flags] -- COMMAND [ARG ...]; no child command was run."), json };
	const allowedFlags = [...GLOBAL_FLAGS, ...(parent ? [...parent.flags, ...command.flags] : command.flags)].map((item) => item.name);
	for (const flag of flags.keys()) if (!allowedFlags.includes(flag)) return { failure: refusal("INVALID_FLAG", `${flag} is not valid for ${command.name}`, `Run omp-kit help ${parent ? `${parent.name} ` : ""}${command.name}.`), json };
	const consumed = parent ? 2 : (positional.length ? 1 : 0);
	const rest = positional.slice(consumed);
	if (command.name === "heavy") {
		if (rest.length) return { failure: refusal("UNEXPECTED_ARGUMENT", "Pass the child command after `--`", "Use omp-kit heavy [flags] -- COMMAND [ARG ...]; no child command was run."), json };
		if (!flags.has("--help") && (!childArgs || childArgs.length === 0)) return { failure: refusal("MISSING_ARGUMENT", "heavy needs `-- COMMAND [ARG ...]`", "Pass the child command after `--`; no command was run."), json };
		if (!flags.has("--help") && json) return { failure: refusal("RAW_OUTPUT_MODE", "heavy preserves the child command's raw output", "Omit --json/--robot before `--`; pass child-specific flags after `--`."), json };
	} else if (command.name === "send") {
		// send is the one three-positional command (SESSION PANE MESSAGE); the
		// message keeps its spaces because the request joins rest (see sendCommand).
		if (rest.length !== 3 && !flags.has("--help")) return { failure: refusal("MISSING_ARGUMENT", "send needs SESSION PANE MESSAGE", "Run omp-kit send SESSION PANE MESSAGE; nothing was sent."), json };
	} else if ((!command.argument && rest.length) || (command.argument && rest.length > (command.name === "help" ? 2 : 1))) {
		return { failure: refusal("UNEXPECTED_ARGUMENT", `Unexpected argument: ${rest[0]}`, `Run omp-kit help ${command.name}.`), json };
	}
	// A subcommand that declares --all accepts the flag in place of its positional (service status/doctor --all).
	const allDeclared = (parent ? [...parent.flags, ...command.flags] : command.flags).some((flag) => flag.name === "--all");
	if (command.argument && !rest.length && command.name !== "help" && command.name !== "heavy" && !flags.has("--help") && !(flags.has("--all") && allDeclared)) return { failure: refusal("MISSING_ARGUMENT", `${command.name} needs ${command.argument}`, `Run omp-kit help ${command.name}.`), json };
	const scope = flags.get("--scope");
	if (typeof scope === "string") {
		const grammar = (parent ? [...parent.flags, ...command.flags] : command.flags).find((flag) => flag.name === "--scope")?.value;
		if (grammar?.includes("|") && !grammar.split("|").includes(scope)) {
			return { failure: refusal("INVALID_VALUE", `Unknown scope: ${scope}`, `Use --scope ${grammar}.`), json };
		}
	}
	if (flags.has("--plan") && flags.has("--apply")) return { failure: refusal("CONFLICTING_FLAGS", "--plan and --apply cannot be combined", `Choose one mode for ${command.name}.`), json };
	if (flags.has("--deep") && !flags.has("--yes")) return { failure: refusal("CONSENT_REQUIRED", "doctor --deep requires explicit --yes", "Review the guarded deep probe, then supply --yes."), json };
	return { request: { command, parent, flags, argument: rest.join(" ") || undefined, ...(childArgs ? { commandArgs: childArgs } : {}), json, robot: flags.has("--robot") } };
}

function kitIdentity() {
	const source = Bun.main.endsWith(".ts");
	let root: string | undefined;
	let status = "UNVERIFIED";
	try {
		root = source ? resolve(dirname(Bun.main), "..") : releaseRoot(process.execPath);
		if (!source) status = "RELEASE_ROOT_RESOLVED";
	} catch { /* No release identity follows from an unrecognized launcher. */ }
	let version = "unreleased";
	let sourceTag: string | null = null;
	if (root && !source) {
		try {
			const metadata: unknown = JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8"));
			if (metadata && typeof metadata === "object" &&
				"version" in metadata && typeof metadata.version === "string" &&
				"source_tag" in metadata && typeof metadata.source_tag === "string") {
				version = metadata.version;
				sourceTag = metadata.source_tag;
			}
		} catch { /* A missing manifest is not a verified version. */ }
	}
	return { version, release: { identity: status, source_tag: sourceTag, root: root ?? null, executable: process.execPath, entrypoint: Bun.main }, data_paths: { state: process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state"), data: process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local", "share") }, platform: { os: process.platform, arch: process.arch } };
}

function ompIdentity(): Record<string, unknown> {
	try {
		const identity = resolveOmpIdentity(process.env);
		let version: string | null = null;
		try {
			const metadata: unknown = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
			if (metadata && typeof metadata === "object" && "version" in metadata && typeof metadata.version === "string") version = metadata.version;
		} catch { /* Source identity is resolved; reported version remains unknown. */ }
		return { status: "PRESENT", location: identity.launcher, source: identity.source, native_root: identity.nativeRoot, version, version_proof: version ? "PACKAGE_METADATA" : "UNVERIFIED" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { status: reason.includes("executable not found on PATH") ? "UNAVAILABLE" : "UNVERIFIED", location: null, version: null, reason };
	}
}

function schema(version: string): Record<string, unknown> {
	const commandData = Object.fromEntries([
		...COMMANDS.flatMap((command) => [
			[command.name, command.dataSchema ?? REFUSAL_DATA_SCHEMA],
			...(command.subcommands?.map((child) => [`${command.name} ${child.name}`, child.dataSchema ?? REFUSAL_DATA_SCHEMA]) ?? []),
		]),
		["--info", GLOBAL_FLAGS.find((flag) => flag.name === "--info")?.dataSchema ?? REFUSAL_DATA_SCHEMA],
	]);
	return { schema_version: SCHEMA_VERSION, tool_version: version,
		commands: COMMANDS, global_flags: GLOBAL_FLAGS, exit_codes: EXIT_CODES, proof_classes: PROOF_CLASSES,
		command_data: commandData, usage_error_data: REFUSAL_DATA_SCHEMA,
		envelope: { type: "object", required: ["ok", "tool_version", "data", "meta", "warnings", "commands", "errors"], properties: {
			ok: { type: "boolean" }, tool_version: { type: "string" }, data: { anyOf: Object.values(commandData) },
			meta: { type: "object", required: ["schema_version", "verification"], properties: { schema_version: { type: "string" }, verification: { enum: ["PERFORMED", "NOT_RUN", "UNVERIFIED"] } } },
			warnings: { type: "array", items: { type: "string" } }, commands: { type: "array", items: { type: "string" } },
			errors: { type: "array", items: { type: "object", required: ["code", "message", "remediation"], properties: {
				code: { type: "string" }, message: { type: "string" }, remediation: { type: "string" },
			} } },
		} },
	};
}

function completion(shell: string): string {
	const flagWords = (flags: readonly Flag[]) => flags.flatMap((flag) => [
		flag.name,
		...(flag.value?.includes("|") ? flag.value.split("|") : []),
	]).join(" ");
	const verbs = COMMANDS.map((command) => command.name).join(" ");
	const globals = GLOBAL_FLAGS.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])]).join(" ");
	const bashCases = COMMANDS.map((command) => {
		const subcommands = command.subcommands?.map((child) => child.name).join(" ");
		const flags = flagWords(command.flags);
		const children = command.subcommands?.map((child) => `${command.name}:${child.name}) words='${globals} ${flagWords(child.flags)}';;`).join(" ") ?? "";
		return `${command.name}:) words='${globals} ${flags}${subcommands ? ` ${subcommands}` : ""}';; ${children}`;
	}).join(" ");
	if (shell === "bash") return `# omp-kit documented grammar (unavailable handlers still refuse)
_omp_kit() {
  local words='${verbs} ${globals}' command='' subcommand='' i
  for ((i=1; i<COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      ${COMMANDS.map((command) => command.name).join("|")}) command="\${COMP_WORDS[i]}";;
      ${COMMANDS.flatMap((command) => command.subcommands?.map((child) => child.name) ?? []).join("|")}) subcommand="\${COMP_WORDS[i]}";;
    esac
  done
  case "$command:$subcommand" in ${bashCases} esac
  if [[ -z "$command" ]]; then words='${verbs} ${globals}'; fi
  COMPREPLY=( $(compgen -W "$words" -- "\${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _omp_kit omp-kit
`;
	if (shell === "zsh") {
		const branches = COMMANDS.map((command) => {
			const childWords = command.subcommands?.map((child) => child.name).join(" ") ?? "";
			const flags = flagWords(command.flags);
			const children = command.subcommands?.map((child) => `${child.name}) choices=(${globals} ${flagWords(child.flags)});;`).join(" ");
			return `${command.name}) choices=(${childWords} ${flags} ${globals});${children ? ` case "\${words[3]}" in ${children} esac;` : ""};`;
		}).join(" ");
		return `#compdef omp-kit
# Documented grammar; dispatch refuses unavailable handlers
_omp_kit() {
  local -a choices
  choices=(${verbs} ${globals})
  case "\${words[2]}" in ${branches} esac
  _describe 'omp-kit command or flag' choices
}
compdef _omp_kit omp-kit
`;
	}
	const scoped = COMMANDS.flatMap((command) => [
		...command.flags.map((flag) => `complete -c omp-kit -n '__fish_seen_subcommand_from ${command.name}' -l ${flag.name.slice(2)}${flag.value ? ` -r${flag.value.includes("|") ? ` -a '${flag.value.split("|").join(" ")}'` : ""}` : ""}`),
		...(command.subcommands?.flatMap((child) => [
			`complete -c omp-kit -f -n '__fish_seen_subcommand_from ${command.name}' -a '${child.name}'`,
			...child.flags.map((flag) => `complete -c omp-kit -n '__fish_seen_subcommand_from ${child.name}' -l ${flag.name.slice(2)}${flag.value ? ` -r${flag.value.includes("|") ? ` -a '${flag.value.split("|").join(" ")}'` : ""}` : ""}`),
		]) ?? []),
	]).join("\n");
	return `# omp-kit documented grammar; dispatch refuses unavailable handlers
${COMMANDS.map((command) => `complete -c omp-kit -f -n '__fish_use_subcommand' -a '${command.name}'`).join("\n")}
${GLOBAL_FLAGS.flatMap((flag) => [`complete -c omp-kit -l ${flag.name.slice(2)}`, ...(flag.aliases?.map((alias) => `complete -c omp-kit -s ${alias.slice(1)}`) ?? [])]).join("\n")}
${scoped}
`;
}

const SCOPE_COMPONENTS: Record<string, readonly string[]> = {
	kit: ["kit", "manifest", "planning_skill"],
	beads: ["beads"],
	omp: ["omp"],
	rules: ["installed_rules", "effective_rules", "retired_rules", "unknown_rules", "project_rules"],
	profile: ["effective_profile"],
	settings: ["policy"],
	extensions: ["extensions", "extension_imports"],
	browsers: ["browsers"],
	identity: ["identity"],
	"regex-tools": ["regex-tools"],
};

/** Components a read-only inventory can prove. Everything else is reported but never judged by health. */
const HEALTH_JUDGED_COMPONENTS: Record<string, true> = {
	kit: true, manifest: true, omp: true, state_root: true, installed_rules: true, omp_drift: true, planning_skill: true, beads: true,
};

interface NotJudgedComponent { component: string; status: DiagnosticStatus; reason: string }

async function workDoctor(request: ParsedCommand): Promise<CliResult> {
	const rootFlag = request.flags.get("--root");
	const timeoutFlag = request.flags.get("--timeout-ms");
	const jobsFlag = request.flags.get("--jobs");
	const timeoutMs = typeof timeoutFlag === "string" && Number.isFinite(Number(timeoutFlag)) ? Number(timeoutFlag) : undefined;
	const concurrency = typeof jobsFlag === "string" && Number.isFinite(Number(jobsFlag)) ? Number(jobsFlag) : undefined;
	const report = await inspectWorkFleet({ roots: resolveWorkRoots(typeof rootFlag === "string" ? rootFlag : undefined), ...(timeoutMs === undefined ? {} : { perRepoTimeoutMs: timeoutMs }), ...(concurrency === undefined ? {} : { concurrency }) });
	return { code: 0, data: report, commands: ["omp-kit doctor --scope work --json"], verification: "PERFORMED" };
}
function sessionDoctor(): CliResult {
	const report = inspectOmpSessions();
	return { code: 0, data: report, commands: ["omp-kit doctor --scope sessions --json"], verification: "PERFORMED" };
}
function loadDoctor(): CliResult {
	const report = censusLoad();
	return { code: 0, data: { scope: "load", overall: report.verdict, ...report }, commands: ["omp-kit doctor --scope load --json"], verification: "PERFORMED" };
}
function loadWatchCommand(): CliResult {
	const stateRoot = join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state"), "omp-kit", "load");
	const report = runLoadWatch(stateRoot);
	return { code: 0, data: { scope: "load", overall: report.verdict, ...report }, commands: ["omp-kit load watch --json"], verification: "PERFORMED" };
}
function readJsonFile(path: string, label: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(label + " is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
}

async function ruleCalibrationDoctor(request: ParsedCommand): Promise<CliResult> {
	const corpusRaw = request.flags.get("--corpus-report") ?? process.env.OMP_KIT_CORPUS_REPORT;
	const labelsRaw = request.flags.get("--labels") ?? process.env.OMP_KIT_FALSE_FIRE_LABELS;
	if (typeof corpusRaw !== "string" || typeof labelsRaw !== "string" || !isAbsolute(corpusRaw) || !isAbsolute(labelsRaw)) {
		return refusal("CALIBRATION_INPUT_REQUIRED", "doctor --scope rules calibration needs absolute --corpus-report and --labels paths", "Provide an F2 corpus JSON report and a deterministic false-fire label JSON file; no sessions were read.");
	}
	try {
		const corpusEnvelope = readJsonFile(corpusRaw, "corpus report") as Record<string, unknown>;
		const corpus = (corpusEnvelope.data && typeof corpusEnvelope.data === "object" ? (corpusEnvelope.data as Record<string, unknown>).corpus : corpusEnvelope.corpus) ?? corpusEnvelope;
		const labelEnvelope = readJsonFile(labelsRaw, "false-fire labels");
		const labels = Array.isArray(labelEnvelope) ? labelEnvelope : (labelEnvelope && typeof labelEnvelope === "object" && Array.isArray((labelEnvelope as Record<string, unknown>).labels) ? (labelEnvelope as Record<string, unknown>).labels : []);
		const seedRaw = request.flags.get("--seed");
		const sampleRaw = request.flags.get("--sample-size");
		const thresholdRaw = request.flags.get("--noisy-lower-bound");
		const input: CalibrationInput = { corpus: corpus as CalibrationInput["corpus"], labels: labels as FireLabel[], seed: seedRaw === undefined ? 1 : Number(seedRaw), sample_size: sampleRaw === undefined ? 64 : Number(sampleRaw), noisy_lower_bound: thresholdRaw === undefined ? 0.05 : Number(thresholdRaw) };
		const calibration = calibrateCorpus(input);
		return { code: 0, data: { overall: "OK", scope: "rules", status: "OK", calibration }, verification: "PERFORMED" };
	} catch (error) {
		return refusal("CALIBRATION_INPUT_INVALID", error instanceof Error ? error.message : String(error), "Fix the report or label JSON; no writes or session reads were performed.");
	}
}

/** CYCLE1: report exclusive Agent Mail holds older than the configured limit. */
function inspectReservationAge(request: ParsedCommand): Finding {
	const archiveRoot = process.env.AGENT_MAIL_STORAGE_ROOT;
	if (!archiveRoot) return { component: "reservations", status: "UNVERIFIED",
		reason: "AGENT_MAIL_STORAGE_ROOT is unset; reservation holds cannot be read",
		recommended_action: "Point AGENT_MAIL_STORAGE_ROOT at the live Agent Mail root." };
	const project = typeof request.flags.get("--project") === "string" ? String(request.flags.get("--project")) : process.cwd();
	const report = auditReservationAge({ archiveRoot, projectKey: project });
	if (report.overdue.length === 0) return { component: "reservations", status: "OK",
		reason: `No exclusive hold older than ${report.limit_minutes} min (${report.checked} checked)`,
		recommended_action: "No action required.",
		evidence: { checked: report.checked, unreadable: report.unreadable, limit_minutes: report.limit_minutes } };
	const worst = report.overdue[0]!;
	return { component: "reservations", status: "FAIL",
		reason: `${report.overdue.length} exclusive hold(s) older than ${report.limit_minutes} min; oldest ${worst.path_pattern} by ${worst.agent_name} at ${worst.age_minutes} min (${worst.bead || "no bead named"})`,
		recommended_action: "Land or release the overdue hold; a hold past the push is a stop sign.",
		evidence: { checked: report.checked, overdue: report.overdue } };
}

async function diagnosticInventory(request: ParsedCommand): Promise<CliResult> {
	if (request.command.name === "doctor" && request.flags.has("--deep")) {
		const scope = String(request.flags.get("--scope") ?? "effective_profile");
		if (scope === "lsp") return deepLspDoctor(request);
		const report = await planDeepDoctor({ root: kitIdentity().release.root ?? "", home: process.env.HOME ?? "", stateRoot: receiptStateRoot() ?? "", scope, confirmed: request.flags.has("--yes") });
		return { code: 2, data: { overall: "UNVERIFIED", deep_probe: report }, errors: [{
			code: report.refusal.code, message: report.refusal.reason,
			remediation: "Use read-only omp-kit doctor --json; no migratory probe was run or backup created.",
		}], verification: "UNVERIFIED" };
	}
	if (request.command.name === "doctor" && request.flags.get("--scope") === "browsers") {
		const collected = collectBrowserProcesses();
		const report = inspectBrowserProcesses(collected.processes, collected.sessions, Date.now(), collected.clones);
		return { code: 0, data: { overall: report.status === "OK" ? "OK" : "WARN", scope: "browsers", ...report }, commands: ["omp-kit doctor --scope browsers --json"], verification: "PERFORMED" };
	}
	if (request.command.name === "doctor" && request.flags.get("--scope") === "regex-tools") {
		const toolFinding = inspectRegexTools();
		const data = {
			overall: health([toolFinding]),
			kit: kitIdentity(),
			omp: { status: "UNVERIFIED", location: null, version: null, reason: "OMP was not inspected for regex-tools scope" },
			findings: [toolFinding],
			evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
			recommended_actions: toolFinding.status === "OK" ? [] : [toolFinding.recommended_action],
		};
		return {
			code: 0, data, commands: ["omp-kit doctor --scope regex-tools --json"],
			verification: toolFinding.status === "OK" ? "PERFORMED" : "UNVERIFIED",
		};
	}
	const kit = kitIdentity();
	const root = kit.release.root;
	const home = process.env.HOME;
	if (!root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no profile or rule data was read.",
		}], verification: "UNVERIFIED" };
	}
	let ompPath: string | undefined, ompLauncher: string | undefined;
	try {
		const identity = resolveOmpIdentity(process.env);
		for (const directory of (process.env.PATH ?? "").split(delimiter)) {
			const candidate = resolve(directory || ".", "omp");
			try {
				if (realpathSync(candidate) === identity.launcher) { ompPath = candidate; ompLauncher = identity.launcher; break; }
			} catch { /* The next PATH entry may contain the validated launcher. */ }
		}
	} catch { /* Diagnose records an unavailable or conflicting OMP identity explicitly. */ }
	const doctorScope = request.command.name === "doctor" && typeof request.flags.get("--scope") === "string" ? String(request.flags.get("--scope")) : undefined;
	const projectFlag = request.flags.get("--project");
	const diagnosticProject = typeof projectFlag === "string" && projectFlag ? resolve(projectFlag) : process.cwd();
	const diagnosedFindings = await diagnose({ root, home, project: diagnosticProject, ...(doctorScope ? { scope: doctorScope } : {}), ...(ompPath ? { ompPath } : {}) });
	const nativeSettings = request.command.name === "doctor" && (request.flags.get("--scope") === "settings" || request.flags.get("--scope") === "policy") ?
		inspectPolicySettings({ root, home, profileConfigHome: process.env.XDG_CONFIG_HOME, ...(ompLauncher ? { ompPath: ompLauncher } : {}) }) : null;
	const allFindings = nativeSettings ? [...diagnosedFindings.filter(item => item.component !== "policy"), nativeSettings] : diagnosedFindings;
	const ompFinding = allFindings.find((item) => item.component === "omp");
	const ompEvidence = ompFinding?.evidence;
	const availability = ompEvidence?.availability;
	const omp = {
		status: availability === "PRESENT" || availability === "UNAVAILABLE" ? availability : "UNVERIFIED",
		location: typeof ompEvidence?.location === "string" ? ompEvidence.location : null,
		version: typeof ompEvidence?.version === "string" ? ompEvidence.version : null,
		version_proof: typeof ompEvidence?.version_proof === "string" ? ompEvidence.version_proof : "UNVERIFIED",
		reason: ompFinding?.reason ?? "OMP identity was not inspected",
	};
	let findings = allFindings;
	if (request.command.name === "doctor") {
		const scope = request.flags.get("--scope");
		if (scope === "dicklesworthstone") {
			findings = [await inspectDicklesworthstone()];
		} else if (scope === "reservations") {
			findings = [inspectReservationAge(request)];
		} else if (typeof scope === "string") {
			const selected = SCOPE_COMPONENTS[scope] ?? [scope];
			const scoped = allFindings.filter((item) => selected.includes(item.component));
			findings = scoped.length ? scoped : [{
				component: scope,
				status: "UNVERIFIED",
				reason: `Read-only ${scope} inspection is not yet implemented; no profile or configuration probe was run`,
				recommended_action: "Review the existing OMP configuration manually without running a migratory probe.",
			}];
		} else {
			findings = [...allFindings, ...["policy", "extensions", "router"].filter((component) => !allFindings.some((item) => item.component === component)).map((component): Finding => ({
				component, status: "UNVERIFIED",
				reason: `Read-only ${component} inspection is not yet implemented; no profile or configuration probe was run`,
				recommended_action: "Review the existing OMP configuration manually without running a migratory probe.",
			}))].sort((left, right) => left.component.localeCompare(right.component));
		}
	}
	const byComponent = (component: string) => findings.find((item) => item.component === component)?.status ?? "NOT_RUN";
	const data = {
		overall: health(findings), kit, omp, findings,
		evidence: { effective_profile: byComponent("effective_profile"), installed_rules: byComponent("installed_rules"), matcher: byComponent("matcher") },
		recommended_actions: [...new Set(findings.filter((item) => item.status !== "OK").map((item) => item.recommended_action))],
	};
	const strict = request.command.name === "health";
	const notJudged: NotJudgedComponent[] = strict ? findings.filter((item) => !HEALTH_JUDGED_COMPONENTS[item.component])
		.map((item) => ({ component: item.component, status: item.status, reason: item.reason }))
		.sort((left, right) => left.component.localeCompare(right.component)) : [];
	const judgedOverall = strict ? health(findings.filter((item) => HEALTH_JUDGED_COMPONENTS[item.component])) : null;
	const healthData = strict ? { ...data, overall: judgedOverall, not_judged: notJudged } : data;
	if (availability === "UNAVAILABLE") return { code: 3, data: healthData, errors: [{
		code: "OMP_UNAVAILABLE", message: omp.reason, remediation: ompFinding?.recommended_action ?? "Install OMP and put it on PATH.",
	}], verification: "UNVERIFIED" };
	const failedRequired = findings.find((item) => (item.component === "kit" || item.component === "manifest") && item.status === "FAIL");
	if (failedRequired) return { code: 1, data: healthData, errors: [{
		code: "REQUIRED_FINDING_FAILED", message: failedRequired.reason, remediation: failedRequired.recommended_action,
	}], verification: "UNVERIFIED" };
	if (strict) return {
		code: judgedOverall !== "OK" ? 1 : 0,
		data: healthData,
		commands: ["omp-kit doctor --json"],
		verification: judgedOverall === "OK" ? "PERFORMED" : "UNVERIFIED",
	};
	return {
		code: 0,
		data,
		commands: ["omp-kit capabilities --json", "omp-kit doctor --json"],
		verification: data.overall === "OK" ? "PERFORMED" : "UNVERIFIED",
	};
}

function lspReadiness(request: ParsedCommand): CliResult {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no LSP configuration was read.",
		}], verification: "UNVERIFIED" };
	}
	const selected = request.flags.get("--project");
	let project: string;
	try {
		project = realpathSync(typeof selected === "string" ? resolve(process.cwd(), selected) : process.cwd());
		if (!isAbsolute(project) || !statSync(project).isDirectory()) throw new Error("not an absolute directory");
	} catch {
		return refusal("INVALID_PROJECT", "Selected LSP project is not an accessible absolute directory", "Provide an existing project directory with --project PATH.");
	}
	const omp = ompIdentity();
	if (omp.status !== "PRESENT" || typeof omp.location !== "string") {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: typeof omp.reason === "string" ? omp.reason : "Validated OMP launcher is unavailable",
			remediation: "Install a supported OMP package and put its launcher on PATH; no LSP server was started.",
		}], verification: "UNVERIFIED" };
	}
	const file = request.flags.get("--file");
	const input: LspReadinessInput = { home, project, ompPath: omp.location,
		...(process.env.PATH ? { pathEnv: process.env.PATH } : {}),
		...(typeof file === "string" ? { file } : {}) };
	if (request.parent?.name === "lsp") {
		const plan = planLspSetup(input);
		return { code: 0, data: { overall: plan.report.status, report: plan.report, instructions: plan.instructions },
			commands: ["omp-kit doctor --scope lsp --json"], verification: "UNVERIFIED" };
	}
	const report = inspectLspReadiness(input);
	const actions = [...new Set(report.servers.map((server) => server.recommended_action))];
	if (!actions.length) actions.push("Review the installed OMP LSP defaults and project configuration; server runtime was not probed.");
	const findings: Finding[] = [{
		component: "lsp", status: report.status,
		reason: report.opaque_layers.length ? "Some LSP configuration layers are unreadable or unsupported"
			: report.servers.some((server) => server.eligible) ? "Configured server eligibility is possible; runtime was not probed"
				: "No configured server is eligible for the selected session cwd and file; runtime was not probed",
		recommended_action: actions[0]!,
	}];
	return { code: 0, data: { overall: report.status, kit, omp, findings,
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: actions, report }, commands: ["omp-kit lsp setup --plan --json"], verification: "UNVERIFIED" };
}

async function deepLspDoctor(request: ParsedCommand): Promise<CliResult> {
	if (!request.flags.has("--yes")) return refusal("DEEP_CONSENT_REQUIRED", "Deep LSP probing requires explicit --yes consent.", "Rerun with --deep --yes only after reviewing the private-fixture probe scope.");
	const project = request.flags.get("--project");
	const file = request.flags.get("--file");
	if (typeof project !== "string" || !isAbsolute(project)) return refusal("INVALID_PROJECT", "Deep LSP probing requires an explicit absolute --project path.", "Provide an existing project directory with --project ABSOLUTE_PATH.");
	if (typeof file !== "string" || !isAbsolute(file)) return refusal("INVALID_FILE", "Deep LSP probing requires an explicit absolute --file path.", "Provide an in-project source file with --file ABSOLUTE_PATH.");
	const staticResult = lspReadiness(request);
	if (staticResult.code !== 0) return staticResult;
	type StaticLspData = { report?: LspReadinessReport; kit?: Record<string, unknown>; omp?: { location?: unknown; [key: string]: unknown }; findings?: Finding[]; evidence?: Record<string, unknown> };
	const staticData = staticResult.data as unknown as StaticLspData;
	if (!staticData.report || !staticData.kit || !staticData.omp || typeof staticData.omp.location !== "string" ||
		!Array.isArray(staticData.findings) || !staticData.evidence) {
		return refusal("LSP_INVENTORY_UNAVAILABLE", "Static LSP inventory did not produce a validated OMP identity and report.", "Rerun omp-kit doctor --scope lsp --json; no deep probe was run.");
	}
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) return refusal("INVENTORY_UNAVAILABLE", "An absolute HOME is required to snapshot the selected LSP profile inputs.", "Run the installed kit with an absolute HOME; no deep probe was run.");
	const probe = await probeLspReadiness({ readiness: staticData.report, home, ompPath: staticData.omp.location,
		...(process.env.PATH ? { pathEnv: process.env.PATH } : {}) });
	const passed = probe.status === "PASS";
	const probeStatus: Finding["status"] = probe.status === "MISSING" || probe.status === "WRONG_MARKER" ? "DEGRADED" : "UNVERIFIED";
	const findings = staticData.findings.map(finding => finding.component === "lsp" ? {
		...finding, status: probeStatus,
		reason: passed ? "OMP's real lsp tool passed its private synthetic TypeScript route; target project runtime remains unverified." : probe.reason,
		recommended_action: passed ? "The target project's language-server runtime remains unverified; this probe exercised a private fixture." : probe.reason,
	} : finding);
	const data = { overall: health(findings), kit: staticData.kit, omp: staticData.omp, findings,
		evidence: { ...staticData.evidence, lsp_probe: probe.status },
		recommended_actions: passed ? ["The OMP LSP route passed in a synthetic fixture; target project runtime remains unverified."] : [probe.reason],
		report: staticData.report, deep_probe: probe };
	const code = passed ? 0 : probe.status === "MISSING" ? 3 : 2;
	return { code, data,
		...(passed ? {} : { errors: [{ code: "LSP_" + probe.status, message: probe.reason,
			remediation: "Correct the reported preflight or runtime failure and rerun this explicitly consented probe; it does not execute workspace-configured commands." }] }),
		verification: passed ? "PERFORMED" : "UNVERIFIED" };
}

function projectTrustInventory(request: ParsedCommand): CliResult {
	const kit = kitIdentity();
	if (!kit.release.root || !process.env.HOME || !isAbsolute(process.env.HOME)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no project configuration was read.",
		}], verification: "UNVERIFIED" };
	}
	const omp = ompIdentity();
	if (omp.status !== "PRESENT") {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "Validated OMP package metadata is unavailable",
			remediation: "Install a supported OMP package and put its launcher on PATH; no project code was run.",
		}], verification: "UNVERIFIED" };
	}
	const selected = request.flags.get("--project");
	// Deliberately do not realpath: the inspector must see and reject a symlinked selected root.
	const project = typeof selected === "string" ? resolve(process.cwd(), selected) : process.cwd();
	const finding = inspectProjectTrust({ project,
		...(omp.version_proof === "PACKAGE_METADATA" && typeof omp.version === "string" ? { ompVersion: omp.version } : {}) });
	// A checkout can itself be the kit root or contain the installed OMP launcher. Hide all
	// identity paths on this scoped route, including XDG paths, rather than leaking project.
	const safeKit = { version: kit.version, release: { identity: kit.release.identity, root: null, executable: null, entrypoint: null },
		data_paths: {}, platform: kit.platform };
	const safeOmp = { status: omp.status, location: null, version: omp.version, version_proof: omp.version_proof };
	return { code: 0, data: { overall: finding.status, kit: safeKit, omp: safeOmp,
		findings: [finding], evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: [finding.recommended_action] }, verification: "UNVERIFIED" };
}

async function memoryInventory(request: ParsedCommand): Promise<CliResult> {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no memory rows were read.",
		}], verification: "UNVERIFIED" };
	}
	const xdgStateHome = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	if (!isAbsolute(xdgStateHome)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "XDG_STATE_HOME must be absolute for a reliable memory store inventory",
			remediation: "Use an absolute XDG_STATE_HOME or leave it unset to inspect the HOME state root.",
		}], verification: "UNVERIFIED" };
	}
	const omp = ompIdentity();
	if (omp.status !== "PRESENT" || typeof omp.location !== "string") {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "Validated OMP package is unavailable for memory inspection",
			remediation: "Install a supported OMP package and put its launcher on PATH; no backend was started.",
		}], verification: "UNVERIFIED" };
	}
	const requested = request.flags.get("--profile");
	const selected = typeof requested === "string" ? requested : "default";
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(selected) || selected.endsWith(".")) {
		return refusal("INVALID_PROFILE", "Selected profile name is not a safe OMP profile name", "Use a simple existing OMP profile name without path separators.");
	}
	const report = await inspectMemoryReadiness({ home, project: process.cwd(), profile: selected, ompPath: omp.location, xdgStateHome });
	const profileObservation = { selected, source: typeof requested === "string" ? "NAMED_ON_DISK" : "DEFAULT_ON_DISK", effective_active_profile: "UNVERIFIED" };
	const finding: Finding = { component: "memory", status: report.status, reason: report.reason,
		recommended_action: report.recommended_action, evidence: { ...report, profile_observation: profileObservation } };
	return { code: 0, data: { overall: report.status, kit, omp, findings: [finding],
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: [report.recommended_action] }, verification: "UNVERIFIED" };
}

function mcpInventory(request: ParsedCommand): CliResult {
	const selected = request.flags.get("--profile");
	if (typeof selected !== "string" || selected === "default" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(selected) || selected.endsWith(".")) {
		return refusal("PROFILE_REQUIRED", "MCP inventory requires an explicitly selected existing named profile", "Use omp-kit doctor --scope mcp --profile NAME, never the default profile.");
	}
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no MCP config was read.",
		}], verification: "UNVERIFIED" };
	}
	const omp = ompIdentity();
	if (omp.status !== "PRESENT" || typeof omp.location !== "string") {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "Validated OMP package is unavailable for MCP inspection",
			remediation: "Install a supported OMP package and put its launcher on PATH; no MCP server was started.",
		}], verification: "UNVERIFIED" };
	}
	try {
		if (!statSync(join(home, ".omp", "profiles", selected, "agent")).isDirectory()) throw new Error("not a directory");
	} catch {
		return refusal("PROFILE_UNAVAILABLE", "Selected named MCP profile does not exist as a directory", "Select an existing named OMP profile; this command never creates one.");
	}
	const report = inspectMcpReadiness({ home, profile: selected, project: process.cwd(), ompPath: omp.location,
		...(process.env.PATH ? { pathEnv: process.env.PATH } : {}) });
	const finding: Finding = { component: "mcp", status: report.status, reason: report.reason,
		recommended_action: report.recommended_action, evidence: { ...report } };
	// Configured MCP commands can live under the checkout; suppress all absolute identity paths.
	const safeKit = { version: kit.version, release: { identity: kit.release.identity, root: null, executable: null, entrypoint: null },
		data_paths: {}, platform: kit.platform };
	const safeOmp = { status: omp.status, location: null, version: omp.version, version_proof: omp.version_proof };
	return { code: 0, data: { overall: report.status, kit: safeKit, omp: safeOmp, findings: [finding],
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: [report.recommended_action] }, verification: "UNVERIFIED" };
}

async function contextInventory(request: ParsedCommand): Promise<CliResult> {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !kit.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no profile was inspected.",
		}], verification: "UNVERIFIED" };
	}
	const omp = ompIdentity();
	if (omp.status !== "PRESENT" || typeof omp.location !== "string") {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "Validated OMP package is unavailable for context inspection",
			remediation: "Install a supported OMP package and put its launcher on PATH; no profile was inspected.",
		}], verification: "UNVERIFIED" };
	}
	const requested = request.flags.get("--profile");
	let profile = "default";
	if (typeof requested === "string") {
		try {
			profile = validateProfileName(requested);
		} catch {
			return refusal("INVALID_PROFILE", "Selected profile name is not a safe OMP profile name", "Use a simple existing OMP profile name without path separators.");
		}
	}
	const selected = request.flags.get("--project");
	let project: string;
	try {
		project = realpathSync(typeof selected === "string" ? resolve(process.cwd(), selected) : process.cwd());
		if (!isAbsolute(project) || !statSync(project).isDirectory()) throw new Error("not an absolute directory");
	} catch {
		return refusal("INVALID_PROJECT", "Selected context project is not an accessible absolute directory", "Provide an existing project directory with --project PATH.");
	}
	let inventory;
	try {
		inventory = await runContextInventory({ root: kit.release.root, executablePath: kit.release.executable,
			home, profile, project });
	} catch (error) {
		if (error instanceof ContextInputError) {
			return { code: error.code === "INVALID_PROFILE" || error.code === "INVALID_PROJECT" ? 2 : 3,
				data: { overall: "UNVERIFIED" }, errors: [{
					code: error.code, message: error.message,
					remediation: "Check the selected profile, project, and installed OMP identity; no profile was changed.",
				}], verification: "UNVERIFIED" };
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "CONTEXT_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and OMP native loaders; no profile was changed.",
		}], verification: "UNVERIFIED" };
	}
	const finding: Finding = contextFinding(inventory, profile,
		typeof requested === "string" ? "NAMED_ON_DISK" : "DEFAULT_ON_DISK");
	return { code: 0, data: { overall: finding.status, kit, omp, findings: [finding],
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: [finding.recommended_action] }, verification: "UNVERIFIED" };
}

async function servicesInventory(request: ParsedCommand): Promise<CliResult> {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no service was inspected.",
		}], verification: "UNVERIFIED" };
	}
	const services = request.flags.get("--services");
	if (typeof services === "string" && !isAbsolute(services)) {
		return refusal("INVALID_SERVICES", "Declared services file requires an absolute path",
			"Pass an absolute schema_version 1 declared-jobs JSON file; no service was changed.");
	}
	const omp = ompIdentity();
	const dirsOverride = process.env.OMP_KIT_SERVICES_DIRS;
	let report;
	try {
		report = inventoryServices(
			{ home, ...(typeof services === "string" ? { servicesPath: services } : {}) },
			defaultInventoryDeps(home, process.env.PATH ?? "/usr/bin:/bin",
				typeof dirsOverride === "string" && dirsOverride ? dirsOverride.split(":") : undefined));
	} catch (error) {
		if (error instanceof ServicesInputError) {
			return refusal(error.code, error.message, "Correct the declared services file; no service was changed.");
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "SERVICES_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check launchd availability; no service was changed.",
		}], verification: "UNVERIFIED" };
	}
	const finding: Finding = { component: "services", status: report.status, reason: report.reason,
		recommended_action: report.status === "OK" ? "No action required."
			: "Inspect flagged jobs with launchctl; this command never loads, unloads, or writes.",
		evidence: { ...report } };
	return { code: 0, data: { overall: report.status, kit, omp, findings: [finding],
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" },
		recommended_actions: [finding.recommended_action] }, verification: "UNVERIFIED" };
}

async function privateMemoryAudit(request: ParsedCommand): Promise<CliResult> {
	if (!request.flags.has("--yes"))
		return refusal("CONSENT_REQUIRED", "Private memory audit needs separate explicit consent; no store was inspected",
			"Review the selected store root and covered fields, then pass memory audit --store-root PATH --yes.");
	const storeRoot = request.flags.get("--store-root");
	if (typeof storeRoot !== "string" || !isAbsolute(storeRoot) || resolve(storeRoot) !== storeRoot)
		return refusal("INVALID_STORE_ROOT", "Private memory audit requires a canonical absolute store root",
			"Pass the absolute directory containing mnemopi.db and all named banks; no store was inspected.");
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
		code: "HOME_UNAVAILABLE", message: "An absolute HOME is required to bound the private audit",
		remediation: "Set an absolute HOME before inspecting a selected store.",
	}], verification: "UNVERIFIED" };
	const omp = ompIdentity();
	if (omp.status !== "PRESENT" || typeof omp.location !== "string")
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "A pinned supported OMP installation is required for the private audit",
			remediation: "Install a supported OMP package; unknown versions cannot yield a clean audit.",
		}], verification: "UNVERIFIED" };
	const report = await auditMemoryAtRest({ consent: "AUDIT_PRIVATE_MEMORY", home, project: process.cwd(),
		storeRoot, ompPath: omp.location });
	// Never return source identity paths, scanned rows, snippets, or hashes.
	const audit = { status: report.status, reason: report.reason, version: report.version,
		coverage: report.coverage, categories: report.categories };
	const overall = report.status === "MATCHES" ? "FAIL" : report.status === "UNVERIFIED" ? "UNVERIFIED" : "OK";
	return { code: report.status === "MATCHES" ? 1 : report.status === "UNVERIFIED" ? 3 : 0,
		data: { overall, audit }, verification: "UNVERIFIED" };
}

function receiptStateRoot(): string | null {
	const home = process.env.HOME;
	if (!home || !isAbsolute(home) || resolve(home) !== home) return null;
	const xdg = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	return isAbsolute(xdg) && resolve(xdg) === xdg ? join(xdg, "omp-kit") : null;
}

/** Commands whose receipts live in the private state root; checked before consent so the real cause is shown. */
const STATE_ROOT_COMMANDS: Record<string, true> = {
	audit: true, why: true, undo: true, repair: true, update: true,
	"apply rules": true, "apply policy": true, "apply extensions": true, "apply plugin": true, "apply mcp": true,
	"service install": true, "service uninstall": true, "service run": true,
};

function stateRootRefusal(issue: StateRootIssue): CliResult {
	if (issue.problem === "MODE")
		return refusal("STATE_ROOT_PERMISSIONS", `Kit state root ${issue.path} has mode ${issue.mode}; receipts require ${issue.expected}, owned by you`,
			"Run omp-kit repair --scope state --plan, then --apply --yes. It changes only that directory's mode; its contents are untouched.");
	return refusal("STATE_UNSAFE", `Kit state root ${issue.path} is unusable (${issue.problem}, mode ${issue.mode})`,
		"Make it a real directory you own with mode 0700 (or move it aside); the kit will not change it.");
}

function receiptCommand(request: ParsedCommand): CliResult {
	const stateRoot = receiptStateRoot();
	if (!stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
		"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset; no receipt was changed.");
	try {
		if (request.command.name === "audit")
			return { code: 0, data: { overall: "UNVERIFIED", receipts: audit(stateRoot) }, verification: "UNVERIFIED" };
		if (!request.argument) return refusal("MISSING_ARGUMENT", "A receipt ID is required", "Pass a receipt ID reported by audit.");
		if (request.command.name === "why")
			return { code: 0, data: { overall: "UNVERIFIED", receipt: why(stateRoot, request.argument) }, verification: "UNVERIFIED" };
		if (request.command.name === "undo") {
			const pluginPath = join(stateRoot, `plugin-${request.argument}.json`);
			if (existsSync(pluginPath)) {
				const omp = resolveOmpIdentity(process.env).launcher;
				const home = process.env.HOME;
				if (!home || !isAbsolute(home) || resolve(home) !== home || !isAbsolute(omp))
					return refusal("OMP_UNAVAILABLE", "A canonical HOME and OMP launcher are required for plugin undo", "Restore the original profile paths and retry the recorded plugin undo.");
				const receipt = readPluginReceipt(pluginPath);
				const storeHash = receipt.rows.find(row => row.after?.package_hash)?.after?.package_hash ??
					receipt.rows.find(row => row.before?.package_hash)?.before?.package_hash ?? "";
				const runner = createPluginRunner(omp, home, pluginProfiles(home), receipt.store, storeHash);
				const rows = undoPlugin(receipt, runner, stateRoot);
				return { code: rows.some(row => row.status === "REFUSED") ? 1 : 0, data: { overall: "UNVERIFIED", status: rows.some(row => row.status === "REFUSED") ? "PARTIAL" : "RESTORED", receipt_id: request.argument, rows }, verification: "UNVERIFIED" };
			}
		}
		const recorded = why(stateRoot, request.argument);
		if (recorded.kind === "update") {
			if (recorded.scope === "omp")
				return refusal("OMP_UNDO_UNAVAILABLE", "The upstream OMP updater has no verified inverse",
					"Inspect the update receipt and follow OMP's own documented recovery instructions; do not claim a kit rollback reversed OMP.");
			const root = kitIdentity().release.root;
			if (!root) return refusal("KIT_UNDO_UNAVAILABLE", "An installed kit release is needed for guarded kit rollback",
				"Run the selected installed kit executable with the same private state root.");
			const restored = undoKitUpdate({ prefix: dirname(dirname(root)), stateRoot, receiptId: request.argument });
			return { code: restored.updatePending ? 1 : 0,
				data: { overall: "UNVERIFIED", status: restored.status, receipt_id: restored.receiptId,
					active_version: restored.activeVersion, pending_recovery: restored.updatePending,
					omp_rollback: "NOT_PERFORMED" },
				...(restored.updatePending ? { errors: [{
					code: "PENDING_RECOVERY", message: "Kit symlink restored, but the failed update receipt remains pending",
					remediation: "Inspect audit and both component postimages; a failed test was not converted to successful update proof.",
				}] } : {}), verification: "UNVERIFIED" };
		}
		const result = undo(stateRoot, request.argument, { confirmed: true });
		return { code: 0, data: { overall: "UNVERIFIED", status: result.status, id: request.argument,
			receipt_id: result.id, files: result.files }, verification: "UNVERIFIED" };
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "PENDING_RECOVERY" || code === "MUTATION_FAILED")
			return { code: 1, data: { overall: "UNVERIFIED" }, errors: [{
				code: "PARTIAL_UNDO", message: "Receipt or inverse mutation requires recovery before another action",
				remediation: "Inspect audit and current postimages; no automatic rollback or receipt deletion occurred.",
			}], verification: "UNVERIFIED" };
		const safe = ["BACKUP_CORRUPT", "FRESH_PLAN", "ALREADY_UNDONE", "STATE_UNSAFE", "UNSAFE_PATH",
			"LOCK_BUSY", "INVALID_PLAN", "KIT_RECEIPT_INVALID", "POSTIMAGE_CHANGED", "PRIOR_RELEASE_CHANGED"];
		return refusal(safe.includes(code) ? code : "RECEIPT_UNAVAILABLE",
			"Receipt cannot be verified or undone without changing unverified state",
			"Inspect the private receipt and current postimages; do not force replacement.");
	}
}

registerCommandHandler("audit", receiptCommand);
registerCommandHandler("why", receiptCommand);
registerCommandHandler("undo", receiptCommand);

function rulesCommand(request: ParsedCommand): CliResult {
	const root = kitIdentity().release.root, home = process.env.HOME;
	if (!root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run the compiled kit release with an absolute HOME; no rule or ownership record was changed.",
		}], verification: "UNVERIFIED" };
	const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	if (!isAbsolute(xdgState) || resolve(xdgState) !== xdgState)
		return refusal("INVALID_STATE_ROOT", "Private state root must be absolute and canonical", "Set an absolute XDG_STATE_HOME or leave it unset.");
	try {
		const plan = planRules({ root, home, stateRoot: join(xdgState, "omp-kit") });
		const entries = plan.entries.map(({ name, action, owned }) => ({ name, action, owned }));
		const data = { overall: plan.blocked ? "FAIL" : "UNVERIFIED", action: "PLAN",
			entries, changes: plan.changes, unknown_markdown: plan.unknownMarkdown,
			receipt_id: null as string | null };
		if (plan.blocked) return { code: 2, data, errors: [{
			code: "RULE_COLLISION", message: "An unowned or edited managed rule name blocks changes",
			remediation: "Inspect the named conflict and replan; identical unowned files remain unowned.",
		}], verification: "UNVERIFIED" };
		if (!request.flags.has("--apply")) return { code: 0, data, verification: "UNVERIFIED" };
		const result = applyRulePlan(plan, { confirmed: true });
		return { code: 0, data: { ...data, action: result.status, receipt_id: result.id }, verification: "UNVERIFIED" };
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "PENDING_RECOVERY" || code === "MUTATION_FAILED")
			return { code: 1, data: { overall: "UNVERIFIED" }, errors: [{
				code: "PARTIAL_APPLY", message: "Rule apply may have a durable pending receipt",
				remediation: "Inspect pending receipts and confirm postimages before attempting another apply; no rollback is implied.",
			}], verification: "UNVERIFIED" };
		const safe = ["SOURCE_INVALID", "STATE_UNSAFE", "UNSAFE_PATH", "RULE_COLLISION", "FRESH_PLAN",
			"INVALID_PLAN", "RULES_FAILED", "INSUFFICIENT_SPACE", "LOCK_BUSY"];
		return refusal(safe.includes(code) ? code : "RULE_PLAN_FAILED",
			"Rule plan or apply refused without claiming a completed change",
			"Inspect the release manifest and exact rule ownership, then replan.");
	}
}

registerCommandHandler("apply rules", rulesCommand);
function pluginProfiles(home: string): PluginProfile[] {
	const profiles: PluginProfile[] = [];
	const configFiles = (dir: string): string[] => {
		try { return readdirSync(dir).filter(name => ["config.yml", "config.yaml"].includes(name)); } catch { return []; }
	};
	const writable = (dir: string): boolean => { try { return (statSync(dir).mode & 0o200) !== 0; } catch { return true; } };
	profiles.push({ name: "default", configFiles: configFiles(join(home, ".omp", "agent")), pluginDir: join(home, ".omp", "plugins"), writable: writable(join(home, ".omp", "plugins")) });
	try {
		for (const name of readdirSync(join(home, ".omp", "profiles")).sort()) {
			if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) continue;
			profiles.push({ name, configFiles: configFiles(join(home, ".omp", "profiles", name, "agent")), pluginDir: join(home, ".omp", "profiles", name, "plugins"), writable: writable(join(home, ".omp", "profiles", name, "plugins")) });
		}
	} catch {}
	return profiles;
}

function nativePluginInvoke(omp: string, home: string, profile: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
	const env = { ...process.env, HOME: home };
	delete env.OMP_PROFILE; delete env.PI_PROFILE; delete env.PI_CODING_AGENT_DIR;
	const result = Bun.spawnSync([omp, ...(profile === "default" ? [] : ["--profile", profile]), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function pluginFilesystemKind(path: string): "ABSENT" | "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER" {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "SYMLINK";
		if (stat.isFile()) return "FILE";
		if (stat.isDirectory()) return "DIRECTORY";
		return "OTHER";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
		throw error;
	}
}

function pluginPackageMetadata(root: string): { hash: string; version: string; rules: string[] } {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.name !== "omp-kit-companion" ||
		typeof manifest.version !== "string" || !manifest.version)
		throw new Error("PLUGIN_PACKAGE_METADATA_INVALID");
	const rules = readdirSync(join(root, "rules"))
		.filter(name => /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name))
		.map(name => name.slice(0, -3));
	return { hash: pluginPackageHash(root), version: manifest.version, rules };
}

function createPluginRunner(omp: string, home: string, profiles: readonly PluginProfile[], store: string, storeHash: string): PluginRunner {
	const byName = new Map(profiles.map(profile => [profile.name, profile]));
	const invoke = (profile: string, args: readonly string[]) => {
		const normalized = args[0] === "--profile" && args[1] === profile ? args.slice(2) : args;
		return nativePluginInvoke(omp, home, profile, normalized);
	};
	const snapshot = (name: string): PluginSnapshot => {
		const profile = byName.get(name);
		const pluginDir = profile?.pluginDir;
		const linkPath = join(home, name === "default" ? ".omp/plugins" : `.omp/profiles/${name}/plugins`, "node_modules/omp-kit-companion");
		const base: PluginSnapshot = { installed: false, target: null, link_path: linkPath, plugins_dir_hash: null, lock_hash: null };
		if (!pluginDir) return { ...base, snapshot_issue: "PROFILE_UNAVAILABLE" };
		try {
			const pluginDirKind = pluginFilesystemKind(pluginDir);
			const nodeModulesDir = join(pluginDir, "node_modules");
			const nodeModulesKind = pluginFilesystemKind(nodeModulesDir);
			const lockPath = join(pluginDir, "omp-plugins.lock.json");
			const lockFsKind = pluginFilesystemKind(lockPath);
			const linkKind = pluginFilesystemKind(linkPath);
			let issue: string | undefined;
			if (!["ABSENT", "DIRECTORY"].includes(pluginDirKind) ||
				!["ABSENT", "DIRECTORY"].includes(nodeModulesKind) ||
				!["ABSENT", "SYMLINK", "DIRECTORY"].includes(linkKind) ||
				!["ABSENT", "FILE"].includes(lockFsKind)) issue = "PROFILE_PLUGIN_PATH_UNSAFE";
			let hashes: Pick<PluginSnapshot, "plugins_dir_hash" | "lock_hash"> | undefined;
			try { hashes = pluginProfileHashes(pluginDir); }
			catch (error) { issue ??= error instanceof Error ? error.message : String(error); }

			const listedResult = invoke(name, ["plugin", "list", "--json"]);
			if (listedResult.code !== 0 || listedResult.stderr.trim()) issue ??= "PLUGIN_LIST_UNAVAILABLE";
			let listed: Record<string, unknown> = {};
			try {
				const parsed: unknown = JSON.parse(listedResult.stdout);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PLUGIN_LIST_INVALID");
				listed = parsed as Record<string, unknown>;
			} catch { issue ??= "PLUGIN_LIST_INVALID"; }
			const entries = ["npm", "marketplace"].flatMap(key => Array.isArray(listed[key]) ? listed[key] : []);
			const kit = entries.find(item => item && typeof item === "object" && String((item as Record<string, unknown>).name ?? "") === "omp-kit-companion") as Record<string, unknown> | undefined;
			const installed = kit !== undefined;
			const listedPath = typeof kit?.path === "string" && isAbsolute(kit.path) ? kit.path : null;
			if (installed !== (linkKind !== "ABSENT") || (installed && !listedPath)) issue ??= "PLUGIN_LIST_FILESYSTEM_MISMATCH";
			let target: string | null = null;
			let targetText: string | null = null;
			if (linkKind === "SYMLINK") targetText = readlinkSync(linkPath);
			if (linkKind === "SYMLINK" || linkKind === "DIRECTORY") target = realpathSync(linkPath);
			if (listedPath && target) {
				try {
					if (realpathSync(listedPath) !== target) issue ??= "PLUGIN_LIST_TARGET_MISMATCH";
				} catch { issue ??= "PLUGIN_LIST_TARGET_UNAVAILABLE"; }
			}
			let packageHash: string | null = null, version: string | null = null;
			if (installed && target) {
				try {
					const metadata = pluginPackageMetadata(target);
					packageHash = metadata.hash;
					version = metadata.version;
				} catch (error) { issue ??= error instanceof Error ? error.message : String(error); }
			}
			const policy = invoke(name, ["config", "get", "ttsr.disabledRules", "--json"]);
			let disabledRules: readonly string[] | undefined;
			if (policy.code !== 0 || policy.stderr.trim() || policy.stdout.length > 64 * 1024) issue ??= "PROFILE_POLICY_UNVERIFIED";
			else {
				try {
					const value = JSON.parse(policy.stdout) as Record<string, unknown>;
					if (!value || value.key !== "ttsr.disabledRules" || !Array.isArray(value.value) ||
						!value.value.every(rule => typeof rule === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule)))
						throw new Error("PROFILE_POLICY_UNVERIFIED");
					disabledRules = value.value as string[];
				} catch { issue ??= "PROFILE_POLICY_UNVERIFIED"; }
			}
			return {
				...base,
				installed,
				target,
				plugins_dir_hash: hashes?.plugins_dir_hash ?? null,
				lock_hash: hashes?.lock_hash ?? null,
				package_hash: packageHash,
				version,
				link_target_text: targetText,
				link_kind: linkKind,
				lock_kind: lockFsKind === "ABSENT" ? "ABSENT" : lockFsKind === "FILE" ? "FILE" : "OTHER",
				plugin_dir_present: pluginDirKind === "DIRECTORY",
				node_modules_present: nodeModulesKind === "DIRECTORY",
				...(disabledRules ? { disabled_rules: disabledRules } : {}),
				...(issue ? { snapshot_issue: issue } : {}),
			};
		} catch (error) {
			return { ...base, snapshot_issue: error instanceof Error ? error.message : String(error) };
		}
	};
	return {
		invoke,
		snapshot,
		setDisabledRules: (profile, rules) => invoke(profile, ["config", "set", "ttsr.disabledRules", JSON.stringify(rules), "--json"]),
		postcheck: profile => {
			const current = snapshot(profile);
			return current.snapshot_issue === undefined && current.installed &&
				(current.target === store || current.package_hash === storeHash)
				? { ok: true }
				: { ok: false, reason: current.snapshot_issue ?? "POSTCHECK_PARTIAL:PLUGIN_PACKAGE_MISMATCH" };
		},
	};
}

function pluginCommand(request: ParsedCommand): CliResult {
	const root = kitIdentity().release.root, home = process.env.HOME, stateRoot = receiptStateRoot();
	if (!root || !home || !isAbsolute(home) || resolve(home) !== home || !stateRoot)
		return refusal("INSTALL_UNAVAILABLE", "An installed kit, canonical absolute HOME and private state root are required", "Run the compiled kit release with a canonical HOME; no plugin mutation was attempted.");
	const storeFlag = request.flags.get("--store");
	const store = typeof storeFlag === "string" ? storeFlag : root;
	if (!isAbsolute(store) || resolve(store) !== store) return refusal("INVALID_STORE", "Plugin store must be an absolute canonical package root", "Pass --store ABSOLUTE_DIR containing package.json, rules/, and extensions/.");
	const allProfiles = pluginProfiles(home), namedProfiles = allProfiles.filter(profile => profile.name !== "default");
	const selected = request.flags.get("--profiles");
	let selectedNames = namedProfiles.map(profile => profile.name);
	if (selected !== undefined) {
		if (typeof selected !== "string") return refusal("INVALID_PROFILES", "Profile selection must be a name list or all", "Use --profiles all or --profiles NAME[,NAME].");
		if (selected !== "all") selectedNames = selected.split(",");
	}
	if (selectedNames.some(name => !matchesBounded(name, 128, /^[a-z0-9][a-z0-9._-]{0,63}$/) || name.endsWith(".") || name === "default") ||
		new Set(selectedNames).size !== selectedNames.length)
		return refusal("INVALID_PROFILES", "Profile selection must name distinct existing named profiles", "Use --profiles all, --profiles NAME[,NAME], or --include-default for the default profile.");
	const existingNames = new Set(namedProfiles.map(profile => profile.name));
	if (selectedNames.some(name => !existingNames.has(name))) return refusal("INVALID_PROFILES", "A selected named profile does not exist", "Select existing OMP profiles with --profiles all or --profiles NAME[,NAME].");
	const includeDefault = request.flags.has("--include-default");
	const selectedSet = new Set(selectedNames);
	const profiles = allProfiles.filter(profile => profile.name === "default" ? includeDefault : selectedSet.has(profile.name));
	if (!profiles.length) return refusal("INVALID_PROFILES", "No OMP profiles were selected", "Select named profiles or pass --include-default.");
	const omp = resolveOmpIdentity(process.env).launcher;
	if (!omp || !isAbsolute(omp)) return refusal("OMP_UNAVAILABLE", "The OMP launcher is unavailable", "Install OMP or provide the canonical launcher; no profile was changed.");
	try {
		const metadata = pluginPackageMetadata(store);
		const reportPath = request.flags.get("--regex-budget-report");
		let reportOutput: string | undefined, regexBudget: RegexBudgetSelection | undefined;
		if (reportPath !== undefined) {
			if (typeof reportPath !== "string" || !isAbsolute(reportPath) || resolve(reportPath) !== reportPath)
				return refusal("INVALID_REGEX_BUDGET_REPORT", "Regex-budget report path must be absolute and canonical", "Pass the captured scripts/regex-budget.ts output file as an absolute path.");
			reportOutput = readFileSync(reportPath, "utf8");
			regexBudget = analyzeRegexBudgetOutput(reportOutput);
		}
		const runner = createPluginRunner(omp, home, allProfiles, store, metadata.hash);
		const snapshots = new Map(profiles.map(profile => [profile.name, runner.snapshot(profile.name)]));
		const plan = planPlugin(store, profiles, snapshots, {
			store_version: metadata.version,
			package_hash: metadata.hash,
			available_rules: metadata.rules,
			...(regexBudget ? { regex_budget: regexBudget } : {}),
		});
		const blocked = plan.skipped.length > 0 || plan.steps.some(step => step.refusal_reason !== undefined);
		const data = {
			overall: blocked ? "FAIL" : "UNVERIFIED",
			action: "PLAN",
			store,
			package_hash: metadata.hash,
			regex_budget: regexBudget ?? null,
			steps: plan.steps,
			skipped: plan.skipped,
			receipt_id: null as string | null,
		};
		if (!request.flags.has("--apply")) return { code: blocked ? 1 : 0, data, verification: "UNVERIFIED" };
		const receipt = applyPlugin(plan, runner, stateRoot, reportOutput);
		const failed = receipt.rows.some(row => row.status !== "APPLIED" && row.status !== "UNCHANGED");
		return {
			code: failed ? 1 : 0,
			data: { ...data, action: failed ? "PARTIAL" : "APPLIED", receipt_id: receipt.id, rows: receipt.rows },
			verification: "UNVERIFIED",
		};
	} catch (error) {
		return refusal("PLUGIN_APPLY_FAILED", error instanceof Error ? error.message : String(error), "Inspect the profile plan and receipt; no unverified rollback was attempted.");
	}
}

registerCommandHandler("apply plugin", pluginCommand);

function migrateCommand(request: ParsedCommand): CliResult {
	const root = kitIdentity().release.root, home = process.env.HOME;
	if (!root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run the compiled kit release with an absolute HOME; no rule file was changed.",
		}], verification: "UNVERIFIED" };
	const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	if (!isAbsolute(xdgState) || resolve(xdgState) !== xdgState)
		return refusal("INVALID_STATE_ROOT", "Private state root must be absolute and canonical", "Set an absolute XDG_STATE_HOME or leave it unset.");
	try {
		const plan = planMigration({ root, home, stateRoot: join(xdgState, "omp-kit") });
		const data = { overall: "UNVERIFIED", action: "PLAN", rows: plan.rows, pluginRules: plan.pluginRules,
			pluginAbsent: plan.pluginAbsent, removable: plan.removable, keptCount: plan.kept, receipt_id: null as string | null };
		if (!request.flags.has("--apply")) return { code: 0, data, verification: "UNVERIFIED" };
		if (plan.pluginAbsent) return { code: 2, data, errors: [{
			code: "PLUGIN_ABSENT", message: "No installed plugin serves kit rules; removing legacy copies would orphan them",
			remediation: "Install the kit plugin first, then re-run migrate --apply --yes; nothing was changed.",
		}], verification: "UNVERIFIED" };
		planMigrationMutation(plan, { root, home, stateRoot: join(xdgState, "omp-kit") });
		const result = applyMigration(plan, { root, home, stateRoot: join(xdgState, "omp-kit") }, { confirmed: true });
		return { code: 0, data: { ...data, action: "APPLIED", receipt_id: result.receiptId, kept: result.kept,
			backup_dir: result.backupDir, removed: result.removed, verified: result.verified }, verification: "UNVERIFIED" };
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "OMP_UNAVAILABLE") return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "OMP is not resolvable, so plugin sources cannot be read",
			remediation: "Install OMP and re-run; no rule file was changed.",
		}], verification: "UNVERIFIED" };
		if (code === "PLUGIN_ABSENT") return { code: 2, data: { overall: "UNVERIFIED" }, errors: [{
			code: "PLUGIN_ABSENT", message: "No installed plugin serves kit rules; removing legacy copies would orphan them",
			remediation: "Install the kit plugin first, then re-run migrate --apply --yes; nothing was changed.",
		}], verification: "UNVERIFIED" };
		if (code === "MIGRATE_VERIFY_FAILED") return { code: 1, data: { overall: "UNVERIFIED" }, errors: [{
			code: "MIGRATE_VERIFY_FAILED", message: "Post-apply source check failed; backup copies were kept",
			remediation: "Inspect the backup dir and ttsr list output; restore from backup or undo the receipt.",
		}], verification: "UNVERIFIED" };
		const safe = ["SOURCE_INVALID", "STATE_UNSAFE", "UNSAFE_PATH", "FRESH_PLAN", "INVALID_PLAN",
			"PLUGIN_LIST_FAILED", "RULES_FAILED", "INSUFFICIENT_SPACE", "LOCK_BUSY", "PENDING_RECOVERY", "MUTATION_FAILED"];
		return refusal(safe.includes(code) ? code : "MIGRATE_FAILED",
			"Rule migration refused without claiming a completed change",
			"Inspect the plugin install and exact rule bytes, then replan.");
	}
}

registerCommandHandler("migrate", migrateCommand);

function extensionCommand(request: ParsedCommand): CliResult {
	const root = kitIdentity().release.root, home = process.env.HOME;
	if (!root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run the compiled kit release with an absolute HOME; no extension or profile was changed.",
		}], verification: "UNVERIFIED" };
	const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	if (!isAbsolute(xdgState) || resolve(xdgState) !== xdgState)
		return refusal("INVALID_STATE_ROOT", "Private state root must be absolute and canonical", "Set an absolute XDG_STATE_HOME or leave it unset.");
	const selected = request.flags.get("--profiles");
	let profiles: "all" | string[] = "all";
	if (typeof selected === "string" && selected !== "all") {
		profiles = selected.split(",");
		if (profiles.some(name => !matchesBounded(name, 128, /^[a-z0-9][a-z0-9._-]{0,63}$/) || name.endsWith(".") || name === "default") ||
			new Set(profiles).size !== profiles.length)
			return refusal("INVALID_PROFILES", "Profile selection must name distinct existing named profiles",
				"Use --profiles all, --profiles NAME[,NAME], or --include-default for the default profile.");
	}
	const stateRoot = join(xdgState, "omp-kit");
	try {
		const plan = planExtensions({ root, home, stateRoot, project: process.cwd(), profiles,
			includeDefault: request.flags.has("--include-default") });
		const steps = plan.steps.map(step => ({ kind: step.kind, ...(step.profile ? { profile: step.profile } : {}) }));
		const guard = plan.guard;
		if (!request.flags.has("--apply"))
			return { code: guard.status === "FAIL" ? 1 : 0,
				data: { overall: guard.status === "FAIL" ? "FAIL" : "UNVERIFIED", action: "PLAN", guard,
					steps, skipped_profiles: plan.skippedProfiles, skipped_reasons: plan.skippedReasons, already_listed_profiles: plan.alreadyListedProfiles,
					receipt_id: null }, verification: "UNVERIFIED" };
		const applied = applyExtensions(plan);
		return { code: guard.status === "FAIL" ? 1 : 0,
			data: { overall: guard.status === "FAIL" ? "FAIL" : "UNVERIFIED", action: applied.receiptId ? "APPLIED" : "NO_CHANGE",
				guard, steps, skipped_profiles: plan.skippedProfiles, skipped_reasons: plan.skippedReasons, already_listed_profiles: plan.alreadyListedProfiles,
				receipt_id: applied.receiptId }, verification: "UNVERIFIED" };
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (["PENDING_RECOVERY", "MUTATION_FAILED"].includes(code)) {
			let pending: PendingInspection[] = [];
			try { pending = inspectPendingExtensions(stateRoot); } catch { /* Unsafe state cannot be described as recovered. */ }
			return { code: 1, data: { overall: "UNVERIFIED", pending },
				errors: [{ code: "PARTIAL_APPLY", message: "Extension apply may have left a durable pending receipt",
					remediation: "Inspect pending receipts and verify postimages before a new apply; no rollback is implied." }],
				verification: "UNVERIFIED" };
		}
		const safe = ["UNMANAGED_EXTENSION_COLLISION", "MISSING_PROFILE", "UNRECOGNIZED_PROFILE",
			"UNRECOGNIZED_PROFILE_CONFIG", "INVALID_EXTENSION_POLICY", "MISSING_EXTENSION_INPUT",
			"UNSAFE_PATH", "UNSAFE_PROJECT", "FRESH_PLAN", "INVALID_PLAN", "STATE_UNSAFE", "LOCK_BUSY"];
		return refusal(safe.includes(code) ? code : "EXTENSION_PLAN_FAILED",
			"Extension plan or apply refused without claiming a completed mutation",
			"Inspect the selected profile, extension destination, and private pending receipts, then replan.");
	}
}

registerCommandHandler("apply extensions", extensionCommand);

const MCP_SELECTION_FLAGS = "--from claude|cursor|codex|project|ABS_PATH --servers NAME[,NAME]|all --profiles all|NAME[,NAME], then --plan, or --apply --yes";

/** A walk-through needs a real terminal on every stream and no machine-output mode; edit mode is never interactive. */
function interactiveMcpApply(request: ParsedCommand): boolean {
	return !request.json && !request.robot && !request.flags.has("--servers") && !request.flags.has("--profiles") &&
		!request.flags.has("--env-command") && !request.flags.has("--enable") &&
		!Object.hasOwn(process.env, "CI") && process.env.TERM !== "dumb" && isatty(0) && isatty(1) && isatty(2);
}

function ompMcpSchema(): { schema: unknown; path: string } | null {
	try {
		const path = join(resolveOmpIdentity(process.env).packageRoot, "src", "config", "mcp-schema.json");
		return { schema: JSON.parse(readFileSync(path, "utf8")), path };
	} catch { return null; }
}

function terminalIo(): WizardIo & { close(): void } {
	const lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
	return {
		say: text => { process.stderr.write(`${text}\n`); },
		ask: async question => { process.stderr.write(question); const next = await lines.next(); return next.done ? "" : String(next.value); },
		close: () => { void lines.return?.(); },
	};
}

function mcpPlanText(plan: McpApplyPlan): string {
	const lines = plan.source ? [`source: ${plan.source.id} (${plan.source.path})`, `schema: ${plan.schema.path}`]
		: [`edit: ${[...(plan.edits?.env_commands ?? []).map(edit => `${edit.server} env.${edit.key}=${edit.command}`), ...(plan.edits?.enable ?? []).map(name => `enable ${name}`)].join("; ")}`, `schema: ${plan.schema.path}`];
	for (const server of plan.servers) {
		const notes = [server.env_refs.length ? `env refs ${server.env_refs.map(ref => ref.key === ref.var ? ref.key : `${ref.key}<-${ref.var}`).join(",")}` : "",
			server.env_literal.length ? `env literal ${server.env_literal.join(",")}` : "", server.env_unset.length ? `UNSET NOW ${server.env_unset.join(",")}` : "",
			server.override ? `override ${server.override}` : "", server.display.timeout ? `timeout ${String(server.display.timeout)}ms` : ""].filter(Boolean);
		lines.push(`server ${server.name}${notes.length ? `: ${notes.join("; ")}` : ""}`);
	}
	for (const row of plan.profiles) {
		lines.push("", `${row.action.padEnd(9)} ${row.profile}${row.reason ? ` - ${row.reason}` : ""}${row.already_present.length ? ` (already present: ${row.already_present.join(",")})` : ""}${row.conflicts.length ? ` (CONFLICT, left untouched: ${row.conflicts.join(",")})` : ""}`);
		if (row.diff) lines.push(row.diff);
	}
	if (plan.servers.some(server => server.env_unset.length))
		lines.push("", "UNSET NOW: OMP passes an unset env-name reference through as the literal name (config/resolve-config-value.ts); export it where omp runs or in the profile's agent/.env.");
	return lines.join("\n");
}

/** Shared refusal mapping for apply mcp: nothing is claimed written unless a receipt exists. */
function mcpApplyFailure(error: unknown): CliResult {
	if (error instanceof McpApplyError) return { code: 2, data: { overall: "NOT_RUN", findings_detail: error.findings },
		errors: [{ code: error.code, message: error.message, remediation: "Nothing was written. Fix the named server, source, override or edit, then replan." }], verification: "NOT_RUN" };
	const code = error instanceof Error ? error.message : "";
	if (code.startsWith("MISSING_PROFILE") || code === "INVALID_PROFILES" || code === "INVALID_SOURCE")
		return refusal(code.split(":")[0]!, code, `Pass ${MCP_SELECTION_FLAGS}; profiles are enumerated from ~/.omp at run time.`);
	if (["PENDING_RECOVERY", "MUTATION_FAILED"].includes(code))
		return { code: 1, data: { overall: "UNVERIFIED" }, errors: [{ code: "PARTIAL_APPLY", message: "MCP apply may have left a durable pending receipt",
			remediation: "Inspect omp-kit audit and the profile files before another apply; no rollback is implied." }], verification: "UNVERIFIED" };
	return refusal(["FRESH_PLAN", "INVALID_PLAN", "STATE_UNSAFE", "LOCK_BUSY", "UNSAFE_PATH"].includes(code) ? code : "MCP_APPLY_FAILED",
		"MCP plan or apply refused without claiming a completed mutation", "Inspect the selected profiles and omp-kit audit, then replan.");
}

/** Edit mode: change servers already in the profiles (env !command values, disabledServers removals); reads no source. */
function applyMcpEdit(request: ParsedCommand, home: string, stateRoot: string): CliResult {
	const flag = (name: string) => { const value = request.flags.get(name); return typeof value === "string" ? value : undefined; };
	for (const name of ["--from", "--servers", "--override", "--env-literal", "--startup-timeout-ms"])
		if (request.flags.has(name)) return refusal("INVALID_FLAG", `${name} belongs to import mode; --env-command and --enable edit servers already in the profiles`,
			"Run an edit as omp-kit apply mcp --profiles NAMES|all [--env-command SERVER:KEY=!CMD]... [--enable NAMES] --plan, and imports separately.");
	const profileSelection = flag("--profiles");
	if (!profileSelection) return refusal("MCP_SELECTION_REQUIRED", "apply mcp edit mode needs --profiles NAMES|all", "Pass --profiles all|NAME[,NAME], then --plan, or --apply --yes.");
	const schema = ompMcpSchema();
	if (!schema) return refusal("OMP_SCHEMA_UNAVAILABLE", "The installed OMP src/config/mcp-schema.json cannot be read", "Install OMP and put its launcher on PATH; nothing is written without schema validation.");
	const { profiles: allProfiles, skipped } = listOmpProfiles(home);
	try {
		const envCommands = (flag("--env-command") ?? "").split("\n").filter(Boolean).map(parseEnvCommand);
		const enable = (flag("--enable") ?? "").split(",").map(name => name.trim()).filter(Boolean);
		const plan = planMcpEdit({ profiles: selectProfiles(allProfiles, profileSelection), stateRoot, schema: schema.schema, schemaPath: schema.path, envCommands, enable });
		const text = mcpPlanText(plan);
		const data = { overall: "UNVERIFIED", action: "PLAN", source: null, servers: [], edits: plan.edits, overrides: [], schema: plan.schema,
			profiles: plan.profiles, skipped_profiles: skipped, receipt_id: null as string | null, text };
		if (!request.flags.has("--apply")) return { code: 0, data, verification: "UNVERIFIED" };
		const applied = applyMcpPlan(plan);
		const touched = [...new Set([...envCommands.map(edit => edit.server), ...enable])];
		return { code: 0, data: { ...data, action: applied.receiptId ? "APPLIED" : "NO_CHANGE", receipt_id: applied.receiptId,
			text: `${text}\n\n${applied.receiptId ? `APPLIED receipt ${applied.receiptId}; undo with: omp-kit undo ${applied.receiptId} --yes` : "NO_CHANGE"}` },
			commands: applied.receiptId ? [`omp-kit undo ${applied.receiptId} --yes`, `omp-kit test --mcp --profiles ${profileSelection} --servers ${touched.join(",")}`] : [],
			verification: "UNVERIFIED" };
	} catch (error) { return mcpApplyFailure(error); }
}

async function applyMcpCommand(request: ParsedCommand): Promise<CliResult> {
	const home = process.env.HOME, stateRoot = receiptStateRoot();
	if (!home || !isAbsolute(home) || !stateRoot)
		return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and private state root are required", "Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset; no profile was read.");
	if (request.flags.has("--env-command") || request.flags.has("--enable")) return applyMcpEdit(request, home, stateRoot);
	const interactive = interactiveMcpApply(request);
	const flag = (name: string) => { const value = request.flags.get(name); return typeof value === "string" ? value : undefined; };
	if (!interactive && (!flag("--servers") || !flag("--profiles") || !flag("--from")))
		return refusal("MCP_SELECTION_REQUIRED", "apply mcp without a terminal needs an explicit source, server and profile selection",
			`Pass ${MCP_SELECTION_FLAGS}. On a terminal, omit --servers and --profiles to be walked through it.`);
	const schema = ompMcpSchema();
	if (!schema) return refusal("OMP_SCHEMA_UNAVAILABLE", "The installed OMP src/config/mcp-schema.json cannot be read", "Install OMP and put its launcher on PATH; nothing is written without schema validation.");
	const { profiles: allProfiles, skipped } = listOmpProfiles(home);
	let from = flag("--from"), serverSelection = flag("--servers"), profileSelection = flag("--profiles");
	const io = interactive ? terminalIo() : null;
	try {
		if (io) {
			const sources = discoverSources(home, process.cwd());
			const chosen = await chooseMcpSelection(io, { from, profiles: allProfiles.map(profile => profile.name),
				sources: (from && !sources.some(source => source.id === from) ? [readSource(from, home, process.cwd())] : sources).map(source => ({ id: source.id, servers: source.servers.map(server => server.name) })) });
			if (!chosen) return refusal("MCP_SELECTION_CANCELLED", "No complete selection was made; nothing was written", `Run again, or pass ${MCP_SELECTION_FLAGS}.`);
			({ from } = chosen);
			serverSelection = chosen.servers.join(",");
			profileSelection = chosen.profiles.join(",");
		}
		const source = readSource(from!, home, process.cwd());
		if (source.status !== "PRESENT") return refusal("SOURCE_UNAVAILABLE", `MCP source ${source.id} is ${source.status}: ${source.path}`, "Pick a present, parseable source with omp-kit doctor --scope mcp --sources.");
		const overrides = (flag("--override") ?? "").split("\n").filter(Boolean).map(readOverride);
		const servers = serverSelection === "all" ? source.servers.map(server => server.name) : serverSelection!.split(",").map(name => name.trim()).filter(Boolean);
		const timeoutFlag = flag("--startup-timeout-ms");
		const plan = planMcpApply({ source, servers, profiles: selectProfiles(allProfiles, profileSelection!), stateRoot, schema: schema.schema, schemaPath: schema.path,
			overrides, envLiteral: new Set((flag("--env-literal") ?? "").split(",").map(name => name.trim()).filter(Boolean)),
			...(timeoutFlag ? { timeouts: parseTimeouts(timeoutFlag, servers) } : {}) });
		const text = mcpPlanText(plan);
		const data = { overall: "UNVERIFIED", action: "PLAN", source: plan.source, servers: plan.servers, overrides: plan.overrides, schema: plan.schema,
			profiles: plan.profiles, skipped_profiles: skipped, receipt_id: null as string | null, text };
		let applying = request.flags.has("--apply");
		if (io) {
			io.say(text);
			if (request.flags.has("--plan")) return { code: 0, data, verification: "UNVERIFIED" };
			if (!plan.mutation) return { code: 0, data: { ...data, action: "NO_CHANGE" }, verification: "UNVERIFIED" };
			applying = (await io.ask("Apply this plan to the listed profiles? Type CONFIRM to proceed: ")).trim() === "CONFIRM";
			if (!applying) return refusal("CONSENT_REQUIRED", "apply mcp was not confirmed; nothing was written", "Review the plan, then type CONFIRM, or pass --apply --yes.");
		}
		if (!applying) return { code: 0, data, verification: "UNVERIFIED" };
		const applied = applyMcpPlan(plan);
		return { code: 0, data: { ...data, action: applied.receiptId ? "APPLIED" : "NO_CHANGE", receipt_id: applied.receiptId,
			text: `${text}\n\n${applied.receiptId ? `APPLIED receipt ${applied.receiptId}; undo with: omp-kit undo ${applied.receiptId} --yes` : "NO_CHANGE"}` },
			commands: applied.receiptId ? [`omp-kit undo ${applied.receiptId} --yes`, `omp-kit test --mcp --profiles ${profileSelection} --servers ${servers.join(",")}`] : [],
			verification: "UNVERIFIED" };
	} catch (error) { return mcpApplyFailure(error); } finally { io?.close(); }
}

registerCommandHandler("apply mcp", applyMcpCommand);

function mcpSourcesInventory(): CliResult {
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) return refusal("INVENTORY_UNAVAILABLE", "An absolute HOME is required", "Run with an absolute HOME; no MCP config was read.");
	const report = inspectMcpSources(home, process.cwd());
	const servers = Object.keys(report.matrix).length;
	const action = "Import with omp-kit apply mcp --from SOURCE --servers NAMES --profiles all --plan, then prove with omp-kit test --mcp --profiles all --servers NAMES.";
	const finding: Finding = { component: "mcp_sources", status: "UNVERIFIED", reason: `Read-only: ${servers} MCP servers across ${report.sources.filter(source => source.status === "PRESENT").length} harness configs, ${report.profiles.length} OMP profiles; nothing started`,
		recommended_action: action };
	const kit = kitIdentity(), omp = ompIdentity();
	return { code: 0, data: { overall: "UNVERIFIED", kit: { version: kit.version, release: { identity: kit.release.identity }, data_paths: {}, platform: kit.platform },
		omp: { status: omp.status, location: null, version: omp.version }, findings: [finding],
		evidence: { effective_profile: "NOT_RUN", installed_rules: "NOT_RUN", matcher: "NOT_RUN" }, recommended_actions: [action], mcp_sources: report },
		verification: "UNVERIFIED" };
}

async function mcpTestCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--record", "--capabilities", "--rules", "--cases", "--live-fixture", "--project", "--integrations", "--profile", "--plan", "--out", "--metamorphic", "--mutants", "--repeat"])
		if (request.flags.has(flag)) return refusal("INVALID_FLAG", `test --mcp cannot be combined with ${flag}`, "Run omp-kit test --mcp --profiles all|NAME[,NAME] [--servers NAMES] [--call SERVER:TOOL:JSON --expect SERVER:REGEX]...");
	const home = process.env.HOME, stateRoot = receiptStateRoot();
	const selection = request.flags.get("--profiles");
	if (typeof selection !== "string") return refusal("PROFILE_REQUIRED", "test --mcp needs --profiles all|NAME[,NAME]", "Name the profiles to prove; nothing was started.");
	if (!home || !isAbsolute(home) || !stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and private state root are required", "Set an absolute HOME; nothing was started.");
	const timeoutRaw = request.flags.get("--startup-timeout-ms");
	const startupTimeoutMs = typeof timeoutRaw === "string" ? Number(timeoutRaw) : 180_000;
	if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 3_600_000)
		return refusal("INVALID_TIMEOUT", "--startup-timeout-ms needs an integer from 1000 to 3600000", "Pass milliseconds, e.g. --startup-timeout-ms 180000.");
	let launcher: string;
	try { launcher = resolveOmpIdentity(process.env).launcher; }
	catch { return refusal("OMP_UNAVAILABLE", "No validated OMP launcher on PATH", "Install OMP and put omp on PATH; nothing was started."); }
	let calls: McpCallSpec[], profiles: OmpProfileDir[], expects: { server: string; pattern: string }[];
	try {
		calls = String(request.flags.get("--call") ?? "").split("\n").filter(Boolean).map(parseCallSpec);
		expects = String(request.flags.get("--expect") ?? "").split("\n").filter(Boolean).map(parseExpectSpec);
		profiles = selectProfiles(listOmpProfiles(home).profiles, selection);
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		return refusal(code.split(":")[0] || "INVALID_SELECTION", code, "Use --call SERVER:TOOL:{\"arg\":1}, --expect SERVER:REGEX and --profiles all|NAME[,NAME]; nothing was started.");
	}
	const serverRaw = request.flags.get("--servers");
	const servers = typeof serverRaw === "string" && serverRaw !== "all" ? serverRaw.split(",").map(name => name.trim()).filter(Boolean) : undefined;
	if (calls.some((call, index) => calls.findIndex(other => other.server === call.server) !== index))
		return refusal("INVALID_CALL", "At most one --call per server", "Pass one --call SERVER:TOOL:JSON per server.");
	for (const [index, expect] of expects.entries()) {
		const call = calls.find(item => item.server === expect.server);
		if (!call || expects.findIndex(other => other.server === expect.server) !== index)
			return refusal("INVALID_EXPECT", `--expect ${expect.server} needs exactly one --call for that server and at most one --expect`, "Pass --call SERVER:TOOL:JSON and one --expect SERVER:REGEX per server; nothing was started.");
		call.expect = expect.pattern;
	}
	const workDir = mkdtempSync(join(tmpdir(), "omp-kit-mcp-test-"));
	let rows;
	try { rows = await probeMcpProfiles({ ompPath: launcher, profiles, ...(servers ? { servers } : {}), calls, startupTimeoutMs, workDir }); }
	finally { rmSync(workDir, { recursive: true, force: true }); }
	const pass = rows.length > 0 && rows.every(row => row.status === "PASS");
	const receiptId = `mcp-test-${new Date().toISOString().replace(/[:.]/g, "")}-${process.pid}`;
	const report = { schema_version: 1, receipt_id: receiptId, recorded_at: new Date().toISOString(), startup_timeout_ms: startupTimeoutMs,
		method: "fresh omp --mode rpc per profile on a private mirror of its agent config; env references and !command values checked; /mcp test per server; one mock-model tool call per --call, judged by --expect and an error-text check",
		claim_limit: "CALLABLE means the server answered one call through OMP with no error-shaped text and the answer matched --expect; it does not prove the answer is right beyond that pattern", profiles: rows };
	ensureMutationStateRoot(stateRoot);
	mkdirSync(join(stateRoot, "mcp-tests"), { recursive: true, mode: 0o700 });
	writePrivate(join(stateRoot, "mcp-tests", `${receiptId}.json`), `${JSON.stringify(report, null, 2)}\n`);
	const text = [`overall: ${pass ? "PASS" : "FAIL"}  receipt: ${receiptId}`, ...rows.flatMap(row => [
		`${row.status.padEnd(5)} ${row.profile}${row.ready_ms !== null ? ` (ready ${row.ready_ms} ms)` : ""}${row.detail ? ` - ${row.detail}` : ""}`,
		...row.servers.map(server => `  ${server.status.padEnd(17)} ${server.server}${server.tools !== null ? ` tools=${server.tools}` : ""}${server.connect_ms !== null ? ` connect=${server.connect_ms}ms` : ""}${server.call ? ` call=${server.call.tool} ${server.call.ms ?? "?"}ms: ${server.call.result_excerpt.slice(0, 80)}` : ""}${server.status === "CALLABLE" ? "" : ` - ${server.detail}`}`),
	]), "", report.claim_limit].join("\n");
	return { code: pass ? 0 : 1, data: { overall: pass ? "PASS" : "FAIL", mcp: { ...report, profiles: rows }, text }, verification: "PERFORMED" };
}

function policyCommand(request: ParsedCommand): CliResult {
	const root = kitIdentity().release.root, home = process.env.HOME, stateRoot = receiptStateRoot();
	if (!root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME; no policy was changed.",
		}], verification: "UNVERIFIED" };
	if (!stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
		"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset.");
	const selected = request.flags.get("--profiles");
	const profiles: "all" | string[] | undefined = typeof selected === "string" ? selected === "all" ? "all" : selected.split(",") : undefined;
	if (profiles !== undefined && profiles !== "all" && (profiles.some(name => !matchesBounded(name, 128, /^[a-z0-9][a-z0-9._-]{0,63}$/) || name.endsWith(".") || name === "default") ||
		new Set(profiles).size !== profiles.length))
		return refusal("INVALID_PROFILES", "Profile selection must name distinct existing named profiles",
			"Use --profiles all, --profiles NAME[,NAME], or --include-default for the default profile.");
	try {
		const plan = planPolicy({ root, home, stateRoot, project: process.cwd(), profileConfigHome: process.env.XDG_CONFIG_HOME, ...(profiles === undefined ? {} : { profiles }), includeDefault: request.flags.has("--include-default") });
		const data = { overall: plan.blockedProfiles.length ? "FAIL" : "UNVERIFIED", action: "PLAN", profiles: plan.profiles,
			steps: plan.steps.map(step => ({ profile: step.profile, path: step.path, key: "ttsr." + step.key, command: step.command })),
			blocked_profiles: plan.blockedProfiles, backup_id: null as string | null };
		if (plan.blockedProfiles.length) return { code: 2, data, errors: [{
			code: "DISABLED_RULE_REFUSED", message: "Selected profiles contain disabled names that policy would re-enable",
			remediation: "Keep disabled names unchanged; generic --yes cannot authorize a re-enable.",
		}], verification: "UNVERIFIED" };
		if (!request.flags.has("--apply")) return { code: 0, data, verification: "UNVERIFIED" };
		const result = applyPolicyPlan(plan, { confirmed: true });
		return { code: 0, data: { ...data, action: result.status, backup_id: result.backupId },
			verification: "UNVERIFIED" };
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const code = message.split(":")[0] ?? "";
		if (code === "PROFILE_LIST_UNVERIFIED") return refusal(code, "Optional TTSR profile list is invalid or unsafe",
			"Fix XDG_CONFIG_HOME/omp-kit/ttsr-profiles.json (default: $HOME/.config/omp-kit/ttsr-profiles.json), or pass explicit --profiles.");

		if (code === "POLICY_APPLY_PARTIAL") {
			const [, backupId, profile, key] = message.split(":");
			return { code: 1, data: { overall: "UNVERIFIED", action: "PARTIAL", backup_id: backupId ?? null, failed_profile: profile ?? null, failed_key: key ?? null }, errors: [{
				code, message: "Native policy apply did not complete; the original profile config is backed up under backup_id " + (backupId ?? "unknown"),
				remediation: "Inspect the named backup and each native TTSR key; do not retry until readback and profile state are reconciled.",
			}], verification: "UNVERIFIED" };
		}
		if (code === "PENDING_RECOVERY" || code === "MUTATION_FAILED") return { code: 1, data: { overall: "UNVERIFIED" }, errors: [{
				code: "PARTIAL_APPLY", message: "Policy apply may have left a durable pending receipt",
				remediation: "Inspect audit and verify exact postimages before another write; no rollback is implied.",
			}], verification: "UNVERIFIED" };
		const safe = ["SOURCE_INVALID", "STATE_UNSAFE", "UNSAFE_PATH", "UNSAFE_PROJECT",
			"MISSING_PROFILE", "UNRECOGNIZED_PROFILE", "UNRECOGNIZED_PROFILE_CONFIG", "UNRECOGNIZED_DISABLED_RULES",
			"PROFILE_INVENTORY_UNVERIFIED", "UNVERIFIED_PROFILE", "NATIVE_CONFIG_UNAVAILABLE", "NATIVE_CONFIG_RESULT_INVALID", "OMP_CONFIG_UNAVAILABLE", "OMP_IDENTITY_MISMATCH",
			"INVALID_POLICY", "INVALID_PROFILE_SELECTION", "DISABLED_RULE_REFUSED", "FRESH_PLAN", "INVALID_PLAN",
			"INSUFFICIENT_SPACE", "LOCK_BUSY"];
		return refusal(safe.includes(code) ? code : "POLICY_PLAN_FAILED",
			"Policy plan or apply refused without claiming a completed change",
			"Inspect the declared TTSR policy, selected profile configs and disabled rules, then replan.");
	}
}

registerCommandHandler("apply policy", policyCommand);

function repairPlanData(decision: Extract<RepairDecision, { status: "READY" }>) {
	return { overall: "UNVERIFIED", scope: decision.scope, action: "PLAN", changes: decision.changes,
		steps: decision.steps.map(({ action, path, profile, key, command }) => ({
			action, path, ...(profile ? { profile } : {}), ...(key ? { key } : {}), ...(command ? { command } : {}),
		})), receipt_id: null as string | null, backup_id: null as string | null };
}

function repairApplyFailure(error: unknown, data: ReturnType<typeof repairPlanData>): CliResult | null {
	const message = error instanceof Error ? error.message : "";
	const code = message.split(":")[0] ?? "";
	if (code === "POLICY_APPLY_PARTIAL") {
		const [, backupId] = message.split(":");
		return { code: 1, data: { ...data, action: "PARTIAL", backup_id: backupId ?? null }, errors: [{
			code, message: "Native policy repair did not complete; backup_id " + (backupId ?? "unknown"),
			remediation: "Inspect backup manifest and read back every selected TTSR key before retrying.",
		}], verification: "UNVERIFIED" };
	}
	if (["PENDING_RECOVERY", "MUTATION_FAILED"].includes(code)) return { code: 1, data: { ...data, action: "PARTIAL" }, errors: [{
		code: "PARTIAL_APPLY", message: "Repair may have a durable pending receipt",
		remediation: "Run omp-kit audit --json and reconcile its postimages before another repair; no rollback is implied.",
	}], verification: "UNVERIFIED" };
	return null;
}

async function repairCommand(request: ParsedCommand): Promise<CliResult> {
	const root = kitIdentity().release.root, home = process.env.HOME, stateRoot = receiptStateRoot();
	const scope = request.flags.get("--scope");
	if (scope === "state") {
		if (!stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
			"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset.");
		const issue = inspectStateRoot(stateRoot);
		const step = { action: "chmod 0700", path: stateRoot };
		const data = { overall: "UNVERIFIED", scope: "state", receipt_id: null };
		if (!issue) return { code: 0, data: { ...data, action: "UNCHANGED", changes: 0, steps: [] }, verification: "PERFORMED" };
		if (issue.problem !== "MODE") return stateRootRefusal(issue);
		if (!request.flags.has("--apply"))
			return { code: 0, data: { ...data, action: "PLAN", changes: 1, steps: [step], previous_mode: issue.mode }, verification: "UNVERIFIED" };
		const repaired = repairStateRootMode(stateRoot);
		return { code: 0, data: { ...data, action: "APPLIED", changes: 1, steps: [step], previous_mode: repaired.previous_mode },
			verification: "PERFORMED" };
	}
	if (!root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run the compiled kit release with an absolute HOME; no repair was attempted.",
		}], verification: "UNVERIFIED" };
	if (!stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
		"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset.");
	const decision = await planRepair({ root, home, stateRoot, project: process.cwd(), profileConfigHome: process.env.XDG_CONFIG_HOME, ...(typeof scope === "string" ? { scope } : {}) });
	if (decision.status === "REFUSED") return { code: 2,
		data: { overall: "UNVERIFIED", scope: decision.scope, action: "REFUSED" },
		errors: [{ code: decision.refusal.code, message: "No bounded repair is authorized for this state",
			remediation: decision.refusal.reason }], verification: "UNVERIFIED" };
	const data = repairPlanData(decision);
	if (!request.flags.has("--apply")) return { code: 0, data, verification: "UNVERIFIED" };
	try {
		const result = applyRepairPlan(decision, { confirmed: true });
		return { code: 0, data: { ...data, action: result.status, receipt_id: result.receiptId, backup_id: result.backupId },
			verification: "UNVERIFIED" };
	} catch (error) {
		const failure = repairApplyFailure(error, data);
		if (failure) return failure;
		const code = error instanceof Error ? error.message.split(":")[0] ?? "" : "";
		const safe = ["FRESH_PLAN", "INVALID_PLAN", "UNSAFE_PATH", "STATE_UNSAFE", "LOCK_BUSY",
			"RULE_COLLISION", "UNMANAGED_EXTENSION_COLLISION", "DISABLED_RULE_REFUSED", "PROFILE_UNVERIFIED", "UNVERIFIED_PROFILE", "NATIVE_CONFIG_UNAVAILABLE", "NATIVE_CONFIG_RESULT_INVALID"];
		return refusal(safe.includes(code) ? code : "REPAIR_PLAN_FAILED",
			"Selected repair refused without claiming completion",
			"Inspect the named scope and private receipts, then run omp-kit repair --scope NAME --plan --json again.");
	}
}

registerCommandHandler("repair", repairCommand);

async function externalLiveTest(input: ExternalLiveInput): Promise<CliResult> {
	const report = await runExternalLive(input);
	return { code: report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 3,
		data: { overall: report.status, test: report.fast, live: report.live },
		verification: report.status === "BLOCKED" ? "UNVERIFIED" : "PERFORMED",
		warnings: ["public-synthetic is a caller classification, not a privacy guarantee; the fixture is strictly data-only."],
		...(report.status === "PASS" ? {} : { errors: [{ code: report.status,
			message: "The external G1-G3 and G4 proof did not pass",
			remediation: "Check the selected pack, public-synthetic fixture, native matcher, and live marker evidence." }] }) };
}

function externalTestFailure(error: unknown, live: boolean): CliResult {
	if (error instanceof ExternalLiveInputError) return refusal(error.code, "The selected external live fixture could not be validated",
		"Correct the strict public-synthetic data schema; live fixtures never accept executable or path-bearing fields.");
	if (error instanceof ExternalPackInputError) return refusal(error.code, error.message,
		"Correct the external static rule markdown and seven-column cases TSV, then rerun.");
	return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
		code: live ? "EXTERNAL_LIVE_UNAVAILABLE" : "EXTERNAL_TEST_UNAVAILABLE",
		message: "The selected external matcher proof could not complete",
		remediation: "Check the installed kit release, OMP native matcher, and selected static inputs; unavailable observations are never passing quiet cases.",
	}], verification: "UNVERIFIED" };
}

async function externalTestCommand(request: ParsedCommand): Promise<CliResult> {
	const rules = request.flags.get("--rules"), cases = request.flags.get("--cases");
	const liveFixture = request.flags.get("--live-fixture");
	const liveRequested = request.flags.has("--live-fixture");
	if (request.flags.has("--full")) return refusal("CONFLICTING_FLAGS", "--full cannot be combined with an external pack",
		"Choose bundled --full mode or external --rules/--cases mode; external mode never runs project code.");
	if (request.flags.has("--project")) return refusal("CONFLICTING_FLAGS", "--project is only valid for bundled test mode",
		"Run external G1-G3 checks without --project; no project code is inspected or executed.");
	if (typeof rules !== "string" || typeof cases !== "string") return refusal("INVALID_EXTERNAL_PACK", "--rules and --cases must be supplied together",
		"Pass an absolute --rules directory and --cases TSV file, or omit both for the bundled test.");
	if (liveRequested && (typeof liveFixture !== "string" || !isAbsolute(liveFixture))) {
		return refusal("INVALID_EXTERNAL_LIVE_INPUT", "--live-fixture requires an absolute JSON path",
			"Pass a data-only public-synthetic fixture; commands and private transcripts are not accepted.");
	}
	const identity = kitIdentity();
	if (!identity.release.root || !identity.release.executable) return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
		code: "INSTALL_UNAVAILABLE", message: "Installed kit root is unavailable",
		remediation: "Run from an intact compiled release containing its bundled matcher harness.",
	}], verification: "UNVERIFIED" };
	try {
		const pack = readExternalPackSnapshot(rules, cases);
		if (typeof liveFixture === "string") return await externalLiveTest({
			root: identity.release.root, executablePath: identity.release.executable, pack, fixturePath: liveFixture,
		});
		const report = await runExternalPackTest({ root: identity.release.root, executablePath: identity.release.executable, pack });
		return { code: report.exitCode, data: { overall: report.status, test: report }, verification: "UNVERIFIED" };
	} catch (error) {
		return externalTestFailure(error, liveRequested);
	}
}

async function capabilitiesTestCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--rules", "--cases", "--live-fixture", "--record"] as const) {
		if (request.flags.has(flag)) {
			return refusal("CONFLICTING_FLAGS", `${flag} cannot be combined with --capabilities`,
				"Run the required-capability check alone; it never runs matcher packs or records.");
		}
	}
	const capabilities = request.flags.get("--capabilities");
	if (typeof capabilities !== "string" || !isAbsolute(capabilities)) {
		return refusal("INVALID_CAPABILITIES", "--capabilities requires an absolute JSON path",
			"Pass an absolute schema_version 1 capabilities file; commands and transcripts are not accepted.");
	}
	const identity = kitIdentity();
	const home = process.env.HOME;
	if (!identity.release.root || !identity.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME.",
		}], verification: "UNVERIFIED" };
	}
	const project = request.flags.get("--project");
	if (typeof project === "string" && !isAbsolute(project)) {
		return refusal("INVALID_PROJECT", "Project inspection requires an absolute path",
			"Pass an absolute --project path; project code is never executed.");
	}
	try {
		const report = await runCapabilitiesCheck({ root: identity.release.root, executablePath: identity.release.executable,
			home, profile: "default", project: typeof project === "string" ? project : process.cwd(), capabilitiesPath: capabilities });
		const passed = report.overall === "PASS";
		return { code: passed ? 0 : 1, data: { overall: report.overall, capabilities: report }, verification: "UNVERIFIED",
			...(!passed ? { errors: [{ code: "CAPABILITY_MISSING",
				message: `${report.missing} required capabilities are MISSING`,
				remediation: "Restore the missing capabilities with OMP's native knobs, then re-run the check." }] } : {}) };
	} catch (error) {
		if (error instanceof ContextInputError) {
			const invalid = error.code === "INVALID_CAPABILITIES" || error.code === "INVALID_CONTEXT_SELECTION"
				|| error.code === "INVALID_TIMEOUT";
			return invalid
				? refusal(error.code, error.message, "Correct the selected capabilities file and scope; no profile was changed.")
				: { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
					code: error.code, message: error.message,
					remediation: "Check the installed release and OMP native loaders; no profile was changed.",
				}], verification: "UNVERIFIED" };
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "CAPABILITY_CHECK_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and OMP native loaders; no profile was changed.",
		}], verification: "UNVERIFIED" };
	}
}
async function mutantsCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--record", "--capabilities", "--live-fixture", "--project", "--repeat", "--scenario", "--baseline"]) {
		if (request.flags.has(flag)) {
			return refusal("INVALID_FLAG", `test --mutants cannot be combined with ${flag}`,
				"Run mutation adequacy on the bundled pack or one external --rules/--cases pair; nothing was measured.");
		}
	}
	const identity = kitIdentity();
	const home = process.env.HOME;
	if (!identity.release.root || !identity.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "MUTANTS_UNAVAILABLE", message: "Installed kit release or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME; no rules were mutated.",
		}], verification: "UNVERIFIED" };
	}
	const selected = (name: string): string | undefined => {
		const value = request.flags.get(name);
		return typeof value === "string" ? value : undefined;
	};
	const rules = selected("--rules");
	const cases = selected("--cases");
	const budgetRaw = selected("--mutant-budget-secs");
	try {
		const report = await runMutants({ root: identity.release.root, executablePath: identity.release.executable,
			...(rules !== undefined ? { rules } : {}), ...(cases !== undefined ? { cases } : {}),
			...(budgetRaw !== undefined ? { budgetSecs: Number(budgetRaw) } : {}) });
		return { code: 0, data: { overall: "OK", mutants: report }, verification: "UNVERIFIED" };
	} catch (error) {
		if (error instanceof MutantsInputError) {
			return refusal(error.code, error.message, "Correct the selection; no rules were mutated and nothing was written.");
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "MUTANTS_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and OMP native matcher; no rules were mutated.",
		}], verification: "UNVERIFIED" };
	}
}


async function integrationsCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--record", "--capabilities", "--rules", "--cases", "--live-fixture", "--project"]) {
		if (request.flags.has(flag)) {
			return refusal("INVALID_FLAG", `test --integrations cannot be combined with ${flag}`,
				"Run integration proof on named profiles; nothing was measured.");
		}
	}
	const identity = kitIdentity();
	const home = process.env.HOME;
	if (!identity.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INTEGRATIONS_UNAVAILABLE", message: "Installed kit release or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME; no profile was read.",
		}], verification: "UNVERIFIED" };
	}
	if (request.flags.has("--plan")) {
		return { code: 0, data: { overall: "OK", integrations_plan: {
			reads: ["agent/config.yml extensions list", "agent/mcp.json servers", "agent/hooks tree"],
			integrations: [...INTEGRATIONS],
			writes: "isolated HOME under the work dir plus the optional --out report; the real profile is never written",
		} }, verification: "UNVERIFIED" };
	}
	const profileRaw = request.flags.get("--profile");
	if (typeof profileRaw !== "string" || profileRaw.trim() === "") {
		return refusal("PROFILE_REQUIRED", "test --integrations needs --profile NAME[,NAME...]",
			"Name the profiles to prove; the default profile is never assumed.");
	}
	const profiles = profileRaw.split(",").map(part => part.trim()).filter(part => part.length > 0);
	if (profiles.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))) {
		return refusal("INVALID_PROFILE", "Profile names must be simple directory names",
			"Use the profile directory name under .omp/profiles.");
	}
	const outRaw = request.flags.get("--out");
	if (outRaw !== undefined && (typeof outRaw !== "string" || !isAbsolute(outRaw))) {
		return refusal("INVALID_INTEGRATIONS_SELECTION", "integrations --out needs an absolute file path",
			"Pass an absolute --out path or omit it; the matrix still returns on stdout.");
	}
	const workDir = mkdtempSync(join(tmpdir(), `omp-kit-integrations-${process.pid}-`));
	// The reaper keys dead runs off this marker (same rule as omp-kit-work dirs).
	writeFileSync(join(workDir, ".owner"), `pid=${process.pid}\nlabel=omp-kit-integrations\nrepo=omp-kit-companion\ncreated=${new Date().toISOString()}\n`);
	// Per-case fake HOMEs inherit XDG_CACHE_HOME inside the work dir; uv would
	// otherwise grow a gigabyte cache per case home. Share one per-run cache.
	const uvCache = join(workDir, "uv-cache");
	mkdirSync(uvCache, { recursive: true });
	const priorUvCache = process.env.UV_CACHE_DIR;
	process.env.UV_CACHE_DIR = uvCache;
	const keepWorkDir = request.flags.has("--keep");
	try {
		const report = await runIntegrations({ root: identity.release.root, home,
			profiles, workDir, ...(typeof outRaw === "string" ? { out: outRaw } : {}) });
		return { code: 0, data: { overall: "OK", integrations: report }, verification: "UNVERIFIED" };
	} catch (error) {
		if (error instanceof IntegrationsInputError) {
			return refusal(error.code, error.message, "Correct the selection; no profile was read and nothing was written.");
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INTEGRATIONS_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and OMP installation; no profile was changed.",
		}], verification: "UNVERIFIED" };
	} finally {
		if (priorUvCache === undefined) delete process.env.UV_CACHE_DIR; else process.env.UV_CACHE_DIR = priorUvCache;
		if (!keepWorkDir) rmSync(workDir, { recursive: true, force: true });
	}
}

export async function repeatTestCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--record", "--capabilities", "--rules", "--cases", "--live-fixture", "--project", "--integrations", "--profile", "--plan", "--out", "--metamorphic", "--mutants"] as const) {
		if (request.flags.has(flag)) {
			return refusal("INVALID_FLAG", `test --repeat cannot be combined with ${flag}`,
				"Run repeat flake verdicts on live scenarios only; nothing was measured.");
		}
	}
	const rawN = request.flags.get("--repeat");
	if (typeof rawN !== "string" || !/^[1-9][0-9]*$/.test(rawN) || Number(rawN) > 1000) {
		return refusal("INVALID_REPEAT", "test --repeat needs a run count 1-1000",
			"Pass --repeat N with 1 <= N <= 1000; no scenario was run.");
	}
	const runs = Number(rawN);
	const scenarioRaw = request.flags.get("--scenario");
	if (scenarioRaw !== undefined && (typeof scenarioRaw !== "string" || scenarioRaw.trim() === "")) {
		return refusal("INVALID_SCENARIO", "test --repeat --scenario needs a scenario id",
			"Name a scenario from tests/live/scenarios.json or omit --scenario for the full live set.");
	}
	const baselineRaw = request.flags.get("--baseline");
	if (baselineRaw !== undefined && (typeof baselineRaw !== "string" || !isAbsolute(baselineRaw))) {
		return refusal("INVALID_BASELINE", "test --repeat --baseline needs an absolute receipt path",
			"Pass an absolute --baseline JSON receipt path or omit it; nothing was measured.");
	}
	const identity = kitIdentity();
	const home = process.env.HOME;
	if (!identity.release.root || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME.",
		}], verification: "UNVERIFIED" };
	}
	let omp: string;
	try { omp = resolveOmpIdentity(process.env).launcher; } catch {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "OMP_UNAVAILABLE", message: "OMP launcher could not be resolved for live repeats",
			remediation: "Install OMP and put it on PATH; no scenario was run.",
		}], verification: "UNVERIFIED" };
	}
	const scenario = typeof scenarioRaw === "string" ? scenarioRaw : undefined;
	if (scenario) {
		let ids: unknown;
		try { ids = JSON.parse(readFileSync(join(identity.release.root, "tests", "live", "scenarios.json"), "utf8")); } catch {
			return refusal("SCENARIO_INVENTORY_UNAVAILABLE", "The live scenario inventory could not be read",
				"Run from an intact release; no scenario was run.");
		}
		const known = Array.isArray(ids) ? ids.filter((entry): entry is { id: string } => !!entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string").map((entry) => entry.id) : [];
		if (!known.includes(scenario)) {
			return refusal("UNKNOWN_SCENARIO", `Scenario ${scenario} is not in the live inventory`,
				"Name a scenario from tests/live/scenarios.json or omit --scenario.");
		}
	}
	let baseline: RepeatReceipt | undefined;
	if (typeof baselineRaw === "string") {
		try { baseline = parseRepeatReceipt(JSON.parse(readFileSync(baselineRaw, "utf8"))); } catch (error) {
			return refusal("INVALID_BASELINE", error instanceof Error ? error.message : "Baseline receipt could not be read",
				"Pass a repeat receipt (version 1 with integer runs/failures) or omit --baseline.");
		}
	}
	if (baseline?.scenario && scenario && baseline.scenario !== scenario) {
		return refusal("INVALID_BASELINE", `SCENARIO_MISMATCH: current ${scenario} vs baseline ${baseline.scenario}`,
			"Compare a scenario only against its own baseline receipt; nothing was run.");
	}
	const script = join(identity.release.root, "scripts", "e2e-live.sh");
	const perRunMs = (Number(process.env.TIMEOUT) > 0 ? Number(process.env.TIMEOUT) : 120) * 1000 + 30000;
	const results: ("pass" | "fail")[] = [];
	let failureExcerpt: string | null = null;
	for (let index = 0; index < runs; index += 1) {
		const child = Bun.spawnSync(["sh", script], {
			cwd: identity.release.root,
			env: { ...process.env, OMP: omp, ...(scenario ? { ONLY: scenario } : {}) },
			timeout: perRunMs, stdout: "pipe", stderr: "pipe",
		});
		const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
		if (child.exitCode === 0) results.push("pass");
		else {
			results.push("fail");
			failureExcerpt = String(output).slice(-2000);
		}
	}
	const failures = results.filter((entry) => entry === "fail").length;
	const verdict = repeatVerdict({ version: 1, ...(scenario ? { scenario } : {}), runs, failures, results }, ...(baseline ? [{ baseline }] : []));
	const code = verdict.kind === "above-target" || verdict.kind === "regressed" ? 1 : 0;
	return { code, data: { overall: code ? "FAIL" : "OK",
		repeat: { version: 1, ...(scenario ? { scenario } : {}), runs, failures, results,
			verdict: verdict.kind, failure_rate: verdict.failure_rate, ci_lower: verdict.ci_lower, ci_upper: verdict.ci_upper,
			p_value: verdict.p_value, effect_size_h: verdict.effect_size_h, n_needed_post_hoc: verdict.n_needed_post_hoc,
			...(failureExcerpt === null ? {} : { failure_excerpt: failureExcerpt }) } }, verification: "UNVERIFIED" };
}

async function metamorphicCommand(request: ParsedCommand): Promise<CliResult> {
	for (const flag of ["--full", "--record", "--capabilities", "--live-fixture", "--project", "--repeat", "--scenario"]) {
		if (request.flags.has(flag)) {
			return refusal("INVALID_FLAG", `test --metamorphic cannot be combined with ${flag}`,
				"Run metamorphic relations on the bundled pack or one external --rules/--cases pair; nothing was measured.");
		}
	}
	const identity = kitIdentity();
	const home = process.env.HOME;
	if (!identity.release.root || !identity.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "METAMORPHIC_UNAVAILABLE", message: "Installed kit release or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME; no relations were measured.",
		}], verification: "UNVERIFIED" };
	}
	const selected = (name: string): string | undefined => {
		const value = request.flags.get(name);
		return typeof value === "string" ? value : undefined;
	};
	const rules = selected("--rules");
	const cases = selected("--cases");
	for (const path of [rules, cases]) {
		if (path !== undefined && (!isAbsolute(path) || resolve(path) !== path)) {
			return refusal("INVALID_PATH", "Metamorphic selection requires canonical absolute paths",
				"Pass absolute --rules and --cases paths; nothing was measured.");
		}
	}
	const report = await runMetamorphicReport({ root: identity.release.root, executablePath: identity.release.executable,
		...(rules !== undefined ? { rules } : {}), ...(cases !== undefined ? { cases } : {}) });
	return { code: report.status === "FAIL" ? 1 : report.status === "PASS" ? 0 : 3,
		data: { overall: report.status === "PASS" ? "OK" : report.status, metamorphic: report }, verification: "UNVERIFIED" };
}

async function fastTestCommand(request: ParsedCommand): Promise<CliResult> {
	const external = request.flags.has("--rules") || request.flags.has("--cases") || request.flags.has("--live-fixture");
	if (request.flags.has("--mutants")) return mutantsCommand(request);
	if (request.flags.has("--capabilities")) return capabilitiesTestCommand(request);
	if (request.flags.has("--integrations")) return integrationsCommand(request);
	if (request.flags.has("--mcp")) return mcpTestCommand(request);
	for (const flag of ["--profiles", "--servers", "--call", "--expect", "--startup-timeout-ms"])
		if (request.flags.has(flag)) return refusal("INVALID_FLAG", `${flag} is only valid with test --mcp`, "Run omp-kit test --mcp --profiles all|NAME[,NAME].");
	if (request.flags.has("--repeat")) return repeatTestCommand(request);
	if (request.flags.has("--metamorphic")) return metamorphicCommand(request);
	if (external && request.flags.has("--record"))
		return refusal("INVALID_FLAG", "--record applies to the bundled test only", "Drop --record, or run omp-kit test --record without external packs.");
	if (external) return externalTestCommand(request);
	const full = request.flags.has("--full");
	const identity = kitIdentity();


	const home = process.env.HOME;
	if (!identity.release.root || !home || !isAbsolute(home))
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INSTALL_UNAVAILABLE", message: "Installed kit root or absolute HOME is unavailable",
			remediation: "Run from an intact compiled release with an absolute HOME.",
		}], verification: "UNVERIFIED" };
	const project = request.flags.get("--project");
	if (typeof project === "string" && !isAbsolute(project))
		return refusal("INVALID_PROJECT", "Project inspection requires an absolute path",
			"Pass an absolute --project path; project code is never executed.");
	const input = { root: identity.release.root, executablePath: identity.release.executable,
		home, ...(typeof project === "string" ? { project } : {}) };
	// Fingerprint before the run: if OMP changes mid-test, the next status reports drift instead of a false OK.
	let omp: OmpFingerprint = { version: null, launcher_sha256: null };
	try { omp = ompFingerprint(resolveOmpIdentity(process.env)); } catch { /* recorded as an unknown OMP */ }
	let report: FullTestReport | FastTestReport | null = null;
	try { report = full ? await runFullTest(input) : await runFastTest(input); } catch { /* refused below; still recorded */ }
	let recorded: boolean | undefined;
	if (request.flags.has("--record")) {
		const stateRoot = receiptStateRoot();
		recorded = stateRoot !== null && recordTestReceipt(stateRoot, { schema_version: 1, kit_version: identity.version,
			scope: full ? "full" : "fast", status: report?.status ?? "UNAVAILABLE", recorded_at: new Date().toISOString(), ...omp });
	}
	if (!report) return { code: 3, data: { overall: "UNVERIFIED", ...(recorded === undefined ? {} : { recorded }) }, errors: [{
		code: full ? "FULL_TEST_UNAVAILABLE" : "FAST_TEST_UNAVAILABLE",
		message: "The selected matcher/live proof could not complete",
		remediation: "Check the installed release and OMP native matcher; no effective profile was certified.",
	}], verification: "UNVERIFIED" };
	return { code: report.exitCode, data: { overall: report.status === "FAIL" ? "FAIL" : "UNVERIFIED",
		test: report, ...(recorded === undefined ? {} : { recorded }) }, verification: "UNVERIFIED" };
}

registerCommandHandler("test", fastTestCommand);

async function reviewRulesCommand(request: ParsedCommand): Promise<CliResult> {
	const selectedPath = (name: string): string | null => {
		const value = request.flags.get(name);
		return typeof value === "string" && isAbsolute(value) ? value : null;
	};
	const incumbentRules = selectedPath("--incumbent-rules"), incumbentCases = selectedPath("--incumbent-cases");
	const candidateRules = selectedPath("--candidate-rules"), candidateCases = selectedPath("--candidate-cases");
	if (!incumbentRules || !incumbentCases || !candidateRules || !candidateCases) {
		return refusal("REVIEW_INPUT_REQUIRED", "Select both rule directories and both authored case files using absolute paths",
			"Run omp-kit help review rules; no missing side is replaced by the bundled pack.");
	}
	const root = kitIdentity().release.root;
	if (!root) return { code: 3, data: { overall: "UNVERIFIED", status: "UNAVAILABLE", scope: "MATCHER_PREFIX_ONLY", review: null },
		errors: [{ code: "KIT_RELEASE_UNAVAILABLE", message: "An installed kit release is required for native rule review",
			remediation: "Use an installed release with its bundled matcher harness and existing OMP installation." }], verification: "UNVERIFIED" };
	const report = await runInstalledRuleReview({ root, executablePath: process.execPath, incumbentRules, incumbentCases, candidateRules, candidateCases });
	const code = report.status === "UNAVAILABLE" ? 3 : report.review?.status === "NO_DELTA_IN_EXERCISED_WITNESSES" ? 0 : 1;
	return { code, data: { ...report, overall: report.status === "UNAVAILABLE" ? "UNVERIFIED" : report.review?.status },
		verification: report.status === "COMPLETE" ? "PERFORMED" : "UNVERIFIED",
		warnings: ["Only selected authored matcher/prefix observations; not semantic equivalence, live blocking, or effective-profile certification."],
		errors: report.reason ? [{ code: report.reason, message: "The selected paired native comparison could not be fully bound",
			remediation: "Check the selected files, resource limits, and installed OMP identity; unavailable observations are never passing quiet cases." }] : [] };
}

registerCommandHandler("review rules", reviewRulesCommand);

async function reviewReduceCommand(request: ParsedCommand): Promise<CliResult> {
	const rules = request.flags.get("--rules"), fixture = request.flags.get("--fixture");
	if (typeof rules !== "string" || !isAbsolute(rules) || typeof fixture !== "string" || !isAbsolute(fixture)) {
		return refusal("FALSE_FIRE_INPUT_REQUIRED", "Select an absolute --rules directory and --fixture JSON file",
			"Use a strict schema_version 1 false-fire fixture containing only public-synthetic witness data.");
	}
	const release = kitIdentity().release;
	if (!release.root || !release.executable) {
		return { code: 3, data: { overall: "UNVERIFIED", scope: "NATIVE_G2_G3_FALSE_FIRE", status: "UNAVAILABLE",
			attempts: 0, original_bytes: 0, candidate_bytes: null, replay_fixture: null },
		errors: [{ code: "KIT_RELEASE_UNAVAILABLE", message: "An installed compiled release is required for native false-fire reduction",
			remediation: "Run from an intact installed release with its bundled native matcher harness." }], verification: "UNVERIFIED" };
	}
	try {
		const report = await runFalseFireReduction({
			root: release.root, executablePath: release.executable, rulesDirectory: rules, fixturePath: fixture,
			replayOnly: request.flags.has("--replay-only"),
		});
		const success = report.status === "REDUCED" || report.status === "UNCHANGED" || report.status === "REPRODUCED";
		return { code: success ? 0 : report.status === "NOT_REPRODUCED" ? 1 : 3,
			data: { overall: report.status, ...report }, verification: success ? "PERFORMED" : "UNVERIFIED",
			warnings: ["public-synthetic is a caller classification, not a privacy guarantee; only allowlisted witness fields and identity hashes are exported."],
			...(!success ? { errors: [{ code: report.status, message: "The selected native false-fire proof did not produce a replayable reduction",
				remediation: "Check the public-synthetic fixture, selected rules, installed OMP identity, and matcher availability; no fixture is exported on a miss." }] } : {}) };
	} catch (error) {
		if (error instanceof FalseFireInputError || error instanceof ExternalPackInputError) {
			return refusal(error.code, "The selected false-fire fixture or external rules could not be validated",
				"Correct the strict fixture schema and static rule pack; private transcripts are not accepted.");
		}
		return { code: 3, data: { overall: "UNVERIFIED", scope: "NATIVE_G2_G3_FALSE_FIRE", status: "UNAVAILABLE",
			attempts: 0, original_bytes: 0, candidate_bytes: null, replay_fixture: null }, errors: [{
			code: "FALSE_FIRE_UNAVAILABLE", message: "The selected native false-fire proof could not complete",
			remediation: "Check the installed release and selected static inputs; no quiet result or replay fixture was certified.",
		}], verification: "UNVERIFIED" };
	}
}

registerCommandHandler("review reduce", reviewReduceCommand);
/** Last run time from the job receipt; null when the job never wrote one. */
function readJobFinishedAt(home: string, jobName: string): string | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(jobReceiptPath(home, jobName), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("finished_at" in parsed)) return null;
		return typeof parsed.finished_at === "string" ? parsed.finished_at : null;
	} catch {
		return null;
	}
}

/** Write a job receipt; false when the state root refuses (caller reports). Three guarded call sites share this shape. */
function recordJobReceipt(home: string, jobName: string, receipt: Record<string, unknown>): boolean {
	try {
		mkdirSync(dirname(jobReceiptPath(home, jobName)), { recursive: true, mode: 0o700 });
		writeFileSync(jobReceiptPath(home, jobName), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

/** First failed reaper action for the job summary: dir and verdict reason, same predicate as the failure count. */
export function firstFailure(result: Pick<ScratchApplyResult, "applied" | "killed">): string {
	const failed = result.applied.find(isApplyFailure);
	if (failed) return `; first: ${failed.dir} ${failed.reason}`;
	const unkilled = result.killed.find(kill => !kill.ok);
	if (unkilled) return `; first: pid ${unkilled.pid} ${unkilled.command} not reaped`;
	return "";
}

async function serviceCommand(request: ParsedCommand): Promise<CliResult> {
	const sub = request.command.name;
	const platform = process.platform;
	let home: string;
	try {
		home = serviceHome();
	} catch {
		return { code: 3, data: { overall: "UNAVAILABLE", job: request.argument ?? "" },
			errors: [{ code: "HOME_UNAVAILABLE", message: "Service commands need an absolute HOME",
				remediation: "Run with an absolute HOME; no service was changed." }], verification: "UNVERIFIED" };
	}
	const all = request.flags.has("--all");
	const names = sub === "list" || all ? Object.keys(KNOWN_JOBS) : [request.argument?.trim() ?? ""];
	if (names.length === 0 || names.some(name => !KNOWN_JOBS[name])) {
		return refusal("UNKNOWN_JOB", `Unknown service job: ${request.argument ?? "(none)"}`,
			`Known jobs: ${Object.keys(KNOWN_JOBS).join(", ")}.`);
	}
	if (platform !== "darwin" && platform !== "linux") {
		return { code: 3, data: { overall: "UNAVAILABLE", job: names.join(",") },
			errors: [{ code: "UNSUPPORTED_PLATFORM", message: `Service lifecycle supports macOS launchd and Linux systemd, not ${platform}`,
				remediation: "Run service commands on macOS or Linux; nothing was changed." }], verification: "UNVERIFIED" };
	}
	const linux = platform === "linux";
	const scoped: Record<string, ServiceJobDef> = {};
	try {
		for (const name of names) scoped[name] = { ...KNOWN_JOBS[name]!, label: serviceLabel(name) };
	} catch {
		return refusal("TEST_LABEL_NAMESPACE_INVALID", `OMP_KIT_TEST_LABEL_NAMESPACE=${process.env.OMP_KIT_TEST_LABEL_NAMESPACE ?? "(unset)"} is not a test namespace`,
			"Set OMP_KIT_TEST_LABEL_NAMESPACE=com.omp-kit.test.<random> in tests and smoke runs only; production leaves it unset.");
	}
 const resolveJob = (name: string) => {
		const job = scoped[name]!;
		const launcher = stableLauncher(home);
		const watch = job.kind === "watch" ? resolveWatchTarget() : null;
		return { job, launcher, watch };
	};
	if (sub === "list") {
		return { code: 0, data: { overall: "OK", job: names.join(","), jobs: names.map(name => {
			const { job, launcher } = resolveJob(name);
			const installed = platform === "darwin" ? readInstalledPlist(home, job.label) : null;
			const print = platform === "darwin" ? queryPrint(job.label) : null;
			const state = linux ? systemctlState(job, defaultRunner) : null;
			const loaded = print !== null ? print.loaded : (state !== null && (state.enabled || state.active));
			return { name, label: job.label, kind: job.kind, launcher, installed: installed !== null, loaded,
				lastExit: print?.lastExit ?? null, runs: print?.runs ?? null, last_run_at: readJobFinishedAt(home, name) };
		}) }, verification: "UNVERIFIED" };
	}
	if (sub === "install") {
		const dry = request.flags.has("--dry-run");
		if (!dry && !request.flags.has("--apply")) {
			return refusal("INSTALL_REQUIRES_APPLY", `service install ${names[0]} replaces the plist and bootstraps it`,
				"Re-run with --apply --yes, or add --dry-run to preview the render without changing anything.");
		}
		const [name] = names;
		const { job, launcher, watch } = resolveJob(name!);
		if (job.name === "fleet-watch") {
			const configPath = process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
			let configFile = false;
			try { configFile = statSync(configPath).isFile(); } catch {}
			if (!configFile) return refusal("FLEET_WATCH_CONFIG_MISSING", "fleet-watch config file is absent or is not a regular file",
				"Create fleet-watch.json or leave the opt-in service disabled.");
			const tmuxTmpDir = process.env.TMUX_TMPDIR;
			if (!tmuxTmpDir) return refusal("FLEET_WATCH_TMUX_TMPDIR_MISSING", "TMUX_TMPDIR is required for fleet-watch",
				"Set TMUX_TMPDIR to the tmux server's socket directory and retry.");
			let tmuxTmpDirValid = isAbsolute(tmuxTmpDir);
			if (tmuxTmpDirValid) {
				try { tmuxTmpDirValid = statSync(tmuxTmpDir).isDirectory(); } catch { tmuxTmpDirValid = false; }
			}
			if (!tmuxTmpDirValid) return refusal("FLEET_WATCH_TMUX_TMPDIR_INVALID", "TMUX_TMPDIR must be an absolute, existing directory",
				"Set TMUX_TMPDIR to the absolute tmux server socket directory and retry.");
		}
		if (!executableFile(launcher)) {
			return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
				errors: [{ code: "LAUNCHER_UNAVAILABLE", message: `Stable launcher ${launcher} is missing or not executable`,
					remediation: "Install the kit at the stable path first; no service was changed." }], verification: "UNVERIFIED" };
		}
		if (job.kind === "watch" && !watch) {
			return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
				errors: [{ code: "WATCH_TARGET_UNAVAILABLE", message: "OMP package is not resolvable, so there is nothing for the watcher to watch",
					remediation: "Install OMP, then reinstall the job; no service was changed." }], verification: "UNVERIFIED" };
		}
		if (platform === "linux") {
			const units = renderSystemdUnits(home, job, launcher, watch);
			if (dry) return { code: 0, data: { overall: "UNVERIFIED", job: job.name, dry_run: true, service: units.service, timer: units.timer, path: units.path }, verification: "UNVERIFIED" };
			const result = installSystemd(home, job, units, defaultRunner, request.flags.has("--replace"));
			return { code: result.ok ? 0 : 1, data: { overall: result.ok ? (result.changed ? "CHANGED" : "OK") : "FINDINGS", job: job.name, ...result }, verification: "UNVERIFIED",
				errors: result.ok ? [] : [{ code: result.error ?? "INSTALL_FAILED", message: result.detail, remediation: "Check systemctl output and rerun." }] };
		}
		const installed = readInstalledPlist(home, job.label);
		if (dry) {
			const plan = planInstall(home, job, launcher, watch, installed);
			return { code: 0, data: { overall: "UNVERIFIED", job: job.name, label: job.label, dry_run: true, changed: !plan.alreadyInstalled, backup: plan.backup, diff: plan.diff, plist: plan.plist }, verification: "UNVERIFIED" };
		}
		const print = parseLaunchctlPrint(defaultRunner(["launchctl", "print", `${domain()}/${job.label}`]).stdout);
		const result = installService(home, job, launcher, watch, installed, print, defaultRunner, request.flags.has("--replace"));
		return { code: result.ok ? 0 : 1, data: { overall: result.ok ? (result.changed ? "CHANGED" : "OK") : "FINDINGS", job: job.name, label: job.label, ...result }, verification: "UNVERIFIED",
			errors: result.ok ? [] : [{ code: result.error ?? "INSTALL_FAILED", message: result.detail, remediation: "Check launchctl output and rerun; a backup was kept when a plist was replaced." }] };
	}
	if (sub === "uninstall") {
		if (!request.flags.has("--dry-run") && !request.flags.has("--apply")) {
			return refusal("UNINSTALL_REQUIRES_APPLY", `service uninstall ${names[0]} boots out the job and moves its plist to backup`,
				"Re-run with --apply --yes, or add --dry-run to preview without changing anything.");
		}
		const [name] = names;
		const job = scoped[name!]!;
		if (linux) {
			if (request.flags.has("--dry-run")) {
				return { code: 0, data: { overall: "UNVERIFIED", job: job.name, dry_run: true }, verification: "UNVERIFIED" };
			}
		const result = uninstallSystemd(home, job, defaultRunner);
		return { code: 0, data: { overall: result.changed ? "CHANGED" : "OK", job: job.name, label: job.label, changed: result.changed, backup: result.backup, detail: result.detail, already_absent: result.alreadyAbsent }, verification: "UNVERIFIED" };
		}
		if (request.flags.has("--dry-run")) {
			const installed = readInstalledPlist(home, job.label);
			return { code: 0, data: { overall: "UNVERIFIED", job: job.name, label: job.label, dry_run: true, already_absent: installed === null }, verification: "UNVERIFIED" };
		}
		const result = uninstallService(home, job, defaultRunner, request.flags.has("--purge-logs"));
		return { code: 0, data: { overall: result.changed ? "CHANGED" : "OK", job: job.name, label: job.label, changed: result.changed, backup: result.backup, detail: result.detail, already_absent: result.alreadyAbsent }, verification: "UNVERIFIED" };
	}
	if (sub === "status") {
		const rows = names.map(name => {
			const job = scoped[name!]!;
			if (linux) {
				const state = systemctlState(job, defaultRunner);
				return { name, label: job.label, installed: state.fragmentPath !== null, loaded: state.enabled || state.active, state: state.active ? "active" : state.enabled ? "enabled" : "absent", fragmentPath: state.fragmentPath, lastExit: null, runs: null, last_run_at: readJobFinishedAt(home, name) };
			}
			const installed = readInstalledPlist(home, job.label);
			const print = queryPrint(job.label);
			return { name, label: job.label, installed: installed !== null, loaded: print.loaded, state: print.state, pid: print.pid, runs: print.runs, lastExit: print.lastExit, last_run_at: readJobFinishedAt(home, name) };
		});
		const down = rows.some(row => !row.loaded);
		return { code: down ? 1 : 0, data: { overall: down ? "FINDINGS" : "OK", job: names.join(","), status: rows }, verification: "UNVERIFIED" };
	}
	if (sub === "doctor") {
		if (request.flags.has("--fix") && !request.flags.has("--apply")) {
			return refusal("FIX_REQUIRES_APPLY", "doctor --fix changes plists and logs",
				"Re-run with --fix --apply --yes; without --apply this is a read-only report.");
		}
		if (request.flags.has("--fix")) {
			const stateRoot = receiptStateRoot();
			const issue = stateRoot ? inspectStateRoot(stateRoot) : null;
			if (issue) return stateRootRefusal(issue);
		}
		const allChecks: ServiceCheck[] = [];
		let fixed = 0;
		for (const name of names) {
			const job = scoped[name!]!;
			const launcher = stableLauncher(home);
			const watch = job.kind === "watch" ? resolveWatchTarget() : null;
			const checks = linux
				? checkServiceLinux({ home, job, launcher, unit: `omp-kit-${name}.service`, timer: null, pathUnit: null,
					renderedService: renderSystemdUnits(home, job, launcher, watch).service, ...systemctlState(job, defaultRunner) })
				: checkService({ home, job, launcher, watch, installed: readInstalledPlist(home, job.label), print: queryPrint(job.label),
					rendered: renderLaunchdPlist(home, job, launcher, watch).text });
			if (request.flags.has("--fix")) {
				const drifted = checks.find(check => check.id === "plist-matches-renderer" || check.id === "unit-matches-renderer");
				const missing = checks.find(check => (check.id === "plist-present" || check.id === "unit-present") && check.status === "FAIL");
				const unloaded = checks.find(check => check.id === "loaded" && check.status === "FAIL");
				if ((drifted && drifted.status !== "PASS") || missing || unloaded) {
					const installed = linux ? null : readInstalledPlist(home, job.label);
					const result = linux
						? installSystemd(home, job, renderSystemdUnits(home, job, launcher, watch), defaultRunner)
						: installService(home, job, launcher, watch, installed, queryPrint(job.label), defaultRunner);
					if (result.ok) fixed++;
				}
				for (const path of oversizedOwnLogs(home, job)) {
					try {
						renameSync(path, `${path}.1`);
						fixed++;
					} catch { /* rotation failure stays a finding */ }
				}
			}
			allChecks.push(...checks.map(check => ({ ...check, job: name })));
		}
		const failed = allChecks.filter(check => check.status === "FAIL").length;
		const warned = allChecks.filter(check => check.status === "WARN").length;
		return { code: failed > 0 || warned > 0 ? 1 : 0,
			data: { overall: failed > 0 || warned > 0 ? "FINDINGS" : "OK", job: names.join(","), fixed, checks: allChecks }, verification: "UNVERIFIED" };
	}
	if (sub === "logs") {
		const [name] = names;
		const job = scoped[name!]!;
		const count = Number(request.flags.get("-n") ?? 50);
		const file = join(home, "Library", "Logs", "omp-kit", request.flags.has("--errors") ? `${job.name}.err.log` : `${job.name}.out.log`);
		let text: string;
		try {
			const lines = readFileSync(file, "utf8").split("\n");
			text = (Number.isSafeInteger(count) && count > 0 ? lines.slice(-count) : lines).join("\n");
		} catch {
			return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
				errors: [{ code: "LOGS_UNAVAILABLE", message: `Log file ${file} is absent or unreadable`,
					remediation: "Install and run the job first; nothing was changed." }], verification: "UNVERIFIED" };
		}
		return { code: 0, data: { overall: "OK", job: job.name, text }, verification: "UNVERIFIED" };
	}

	if (sub === "run") {
		const [name] = names;
		const job = scoped[name!]!;
		const root = receiptStateRoot();
		const jobsDir = root ? join(root, "jobs") : join(home, ".local", "state", "omp-kit", "jobs");
		// SVC1 run gates, in order: off switch, single-flight, load gate. The
		// time cap applies where the job body runs below.
		const off = readJobOff(join(home, ".local", "state", "omp-kit", `${job.name}.off`));
		if (off.disabled) {
			return { code: 0, data: { overall: "OK", job: job.name, status: "OFF", ...(off.reason ? { reason: off.reason } : {}) }, verification: "UNVERIFIED" };
		}
		try {
			mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
		} catch { /* acquireRunLock reports unusable directories */ }
		const claimed = acquireRunLock(jobsDir, job.name);
		if (claimed.status !== "ACQUIRED") {
			const receipt = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), exit: OVERLAP_EXIT, omp_version: null, status: "SKIPPED-OVERLAP" };
			if (!recordJobReceipt(home, job.name, receipt)) {
				return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
					errors: [{ code: "RECEIPT_UNAVAILABLE", message: "Job receipt could not be written to the private state root",
						remediation: "Repair the state root; the job did not run." }], verification: "UNVERIFIED" };
			}
			return { code: OVERLAP_EXIT, data: { overall: "OK", job: job.name, status: "SKIPPED-OVERLAP", holder_age_ms: claimed.holderAgeMs, receipt }, verification: "UNVERIFIED" };
		}
		const lock = claimed.lock;
		// OMP_KIT_LOAD_OVERRIDE is a test-only seam (load1/ncpu); production reads the machine.
		const loadOverride = process.env.OMP_KIT_LOAD_OVERRIDE;
		let load1: number, ncpu: number;
		if (loadOverride !== undefined) {
			const parts = loadOverride.split("/");
			load1 = Number(parts[0]);
			ncpu = Number(parts[1] ?? "");
		} else {
			const loads = loadavg();
			load1 = loads[0] ?? 0;
			ncpu = cpus().length;
		}
		const gate = gateRunLoad(load1, ncpu);
		if (!gate.proceed) {
			lock.release();
			const receipt = { started_at: new Date().toISOString(), finished_at: new Date().toISOString(), exit: gate.exit, omp_version: null, status: "SKIPPED-LOAD" };
			if (!recordJobReceipt(home, job.name, receipt)) {
				return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
					errors: [{ code: "RECEIPT_UNAVAILABLE", message: "Job receipt could not be written to the private state root",
						remediation: "Repair the state root; the job did not run." }], verification: "UNVERIFIED" };
			}
			return { code: gate.exit, data: { overall: "OK", job: job.name, status: gate.status, detail: gate.detail, receipt }, verification: "UNVERIFIED" };
		}
		// OMP_KIT_RUN_CAP_MS is a test-only seam; production uses RUN_TIME_CAPS_MS.
		const capOverride = Number(process.env.OMP_KIT_RUN_CAP_MS);
		const capMs = Number.isFinite(capOverride) && capOverride > 0 ? capOverride : (RUN_TIME_CAPS_MS[job.name] ?? 600_000);
		const childEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") childEnv[key] = value;
		if (job.name === "load-watch") {
			const stateRoot = join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-kit", "load");
			const report = runLoadWatch(stateRoot);
			lock.release();
			return { code: 0, data: { overall: report.verdict, job: job.name, ...report }, verification: "UNVERIFIED" };
		}
		const launcher = stableLauncher(home);
		if (!executableFile(launcher)) {
			lock.release();
			return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
				errors: [{ code: "LAUNCHER_UNAVAILABLE", message: `Stable launcher ${launcher} is missing or not executable`,
					remediation: "Install the kit at the stable path first; the job did not run." }], verification: "UNVERIFIED" };
		}
		if (job.name === "kit-update") {
			const enabled = process.env.OMP_KIT_UPDATE_ENABLED === "1";
			const indexPath = process.env.OMP_KIT_UPDATE_INDEX, archivePath = process.env.OMP_KIT_UPDATE_ARCHIVE;
			const version = process.env.OMP_KIT_UPDATE_VERSION, sourceTag = process.env.OMP_KIT_UPDATE_SOURCE_TAG;
			if (!indexPath || !archivePath || !version || !sourceTag) { lock.release(); return refusal("KIT_UPDATE_JOB_CONFIG", "kit-update needs OMP_KIT_UPDATE_INDEX, ARCHIVE, VERSION and SOURCE_TAG", "Set the certified local release inputs or leave the job disabled."); }
			const identity = kitIdentity();
			if (!identity.release.root) { lock.release(); return refusal("KIT_UPDATE_JOB_UNAVAILABLE", "An installed kit release is required for kit-update", "Install a certified kit release before enabling the job."); }
			const platform = { os: process.platform === "darwin" ? "darwin" as const : "linux" as const, arch: process.arch === "arm64" ? "arm64" as const : "x64" as const, libc: process.platform === "darwin" ? "none" as const : "gnu" as const };
			const result = await runKitUpdateJob({ enabled, prefix: dirname(dirname(identity.release.root)), stateRoot: receiptStateRoot() ?? "", home: process.env.HOME ?? "", project: process.cwd(), platform, indexPath, archivePath, version, sourceTag, pollRelease: async () => ({ indexPath, archivePath, version, sourceTag }) }, { notify: message => notifyJobFailure({ title: "omp-kit update", message, platform: process.platform, run: defaultRunner, notifySendPresent: Bun.which("notify-send") !== null }) });
			lock.release();
			return { code: result.status === "FAILED" || result.status === "REFUSED" ? 1 : 0, data: { overall: result.status === "FAILED" ? "FINDINGS" : "OK", job: job.name, ...result }, verification: "UNVERIFIED" };
		}
		if (job.name === "fleet-watch") {
			const configPath = process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
			if (!existsSync(configPath)) { lock.release(); return refusal("FLEET_WATCH_CONFIG_MISSING", "fleet-watch config is absent", "Create fleet-watch.json or leave the opt-in service disabled."); }
			try {
				const config = loadFleetWatchConfig(configPath);
				const logPath = join(home, ".local", "state", "omp-kit", "fleet-watch.jsonl");
				const result = runFleetWatchOnce(config, {
					capture: (session, pane) => defaultRunner(["tmux", "capture-pane", "-p", "-t", session + ":" + pane]),
					send: (session, pane, text) => { defaultRunner(["ntm", "send", session, "--panes=" + pane, "--no-cass-check", text]); },
					sendKeys: (session, pane, keys) => { defaultRunner(["tmux", "send-keys", "-t", session + ":" + pane, ...keys]); },
					logPath,
				});
				lock.release();
				return { code: 0, data: { overall: "OK", job: job.name, actions: result }, verification: "UNVERIFIED" };
			} catch (error) { lock.release(); return refusal("FLEET_WATCH_FAILED", error instanceof Error ? error.message : String(error), "Fix the config or disable fleet-watch; no worker claim was made."); }
		}
		if (job.name === "scratch-reaper") {
			const started = new Date().toISOString();
			const result = applyScratch(home, { liveness: defaultLiveness(), run: scratchRunner, home });
			const browserInventory = collectBrowserProcesses();
			const browserPlan = planBrowserReap(inspectBrowserProcesses(browserInventory.processes, browserInventory.sessions));
			const browserResult = applyBrowserReap(browserPlan, {
				kill: pid => defaultRunner(["kill", "-TERM", String(pid)]).code === 0,
				quarantine: path => { try { const root = join(home, ".local", "state", "omp-kit", "browser-quarantine"); mkdirSync(root, { recursive: true, mode: 0o700 }); renameSync(path, join(root, `${Date.now()}-${path.split("/").pop() ?? "clone"}`)); return true; } catch { return false; } },
			});
			const failed = result.applied.filter(isApplyFailure).length + result.killed.filter(kill => !kill.ok).length;
			const receipt = { started_at: started, finished_at: new Date().toISOString(), exit: failed > 0 ? 1 : 0, omp_version: null };
			try {
				mkdirSync(dirname(jobReceiptPath(home, job.name)), { recursive: true, mode: 0o700 });
				writeFileSync(jobReceiptPath(home, job.name), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
			} catch {
				lock.release();
				return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
					errors: [{ code: "RECEIPT_UNAVAILABLE", message: "Job receipt could not be written to the private state root",
						remediation: "Repair the state root; the scratch apply may already have run." }], verification: "UNVERIFIED" };
			}
			lock.release();
			return { code: failed > 0 ? 1 : 0, data: { overall: failed > 0 ? "FINDINGS" : "OK", job: job.name, receipt,
				stats: { roots: result.roots.length, sessions: result.applied.length, browser_orphans: browserResult.killed.length, browser_clones: browserResult.quarantined.length, orphans: result.orphans.length,
					reaped: result.applied.filter(v => v.action === "REAP").length,
					quarantined: result.applied.filter(v => v.action === "QUARANTINE").length,
					deleted: result.expired.length, failures: failed,
					reapableBytes: result.reapableBytes, quarantinableBytes: result.quarantinableBytes },
				sessions: result.applied, orphans: result.orphans, killed: result.killed, expired: result.expired },
			errors: failed > 0 ? [{ code: "SCRATCH_APPLY_FAILED", message: `scratch-reaper had ${failed} failed action(s)${firstFailure(result)}`,
				remediation: "Inspect the applied verdicts and scratch reap JSONL receipt; refused paths were left in place." }] : [],
			verification: "UNVERIFIED" };
		}
		const started = new Date().toISOString();
		const run = await runWithCap({ argv: [launcher, "test", "--record", "--json"], cwd: home, env: childEnv, capMs, exec: bunCapExec() });
		const ompVersion = (() => { try { return ompIdentity().version; } catch { return null; } })();
		if (run.status === "TIMEOUT") {
			const receipt = { started_at: started, finished_at: new Date().toISOString(), exit: 1, omp_version: ompVersion, status: "TIMEOUT" };
			if (!recordJobReceipt(home, job.name, receipt)) {
				lock.release();
				return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
					errors: [{ code: "RECEIPT_UNAVAILABLE", message: "Job receipt could not be written to the private state root",
						remediation: "Repair the state root, then rerun; the test itself may have passed." }], verification: "UNVERIFIED" };
			}
			lock.release();
			return { code: 1, data: { overall: "FINDINGS", job: job.name, status: "TIMEOUT", receipt,
					detail: `test --record exceeded the ${capMs} ms cap and was killed after ${run.elapsedMs} ms.` },
				errors: [{ code: "TIMEOUT", message: `test --record exceeded the ${capMs} ms cap and was killed`,
					remediation: "Run the recorded command manually with --json and read its failures." }], verification: "UNVERIFIED" };
		}
		const receipt = { started_at: started, finished_at: new Date().toISOString(), exit: run.exit ?? 1, omp_version: ompVersion, status: run.status };
		try {
			mkdirSync(dirname(jobReceiptPath(home, job.name)), { recursive: true, mode: 0o700 });
			writeFileSync(jobReceiptPath(home, job.name), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
		} catch {
			lock.release();
			return { code: 3, data: { overall: "UNAVAILABLE", job: job.name },
				errors: [{ code: "RECEIPT_UNAVAILABLE", message: "Job receipt could not be written to the private state root",
					remediation: "Repair the state root, then rerun; the test itself may have passed." }], verification: "UNVERIFIED" };
		}
		// The watcher exists to be seen when the post-update test fails: notify in-process, best-effort.
		const notification = run.exit !== 0 && job.name === "omp-watch"
			? notifyJobFailure({ title: "omp-kit", message: "omp-kit test did not pass after an OMP update. Run: omp-kit test --json",
				platform, run: defaultRunner, notifySendPresent: Bun.which("notify-send") !== null })
			: { attempted: false, method: "none" as const };
		lock.release();
		return { code: run.exit === 0 ? 0 : 1, data: { overall: run.exit === 0 ? "OK" : "FINDINGS", job: job.name, status: run.status, receipt, notification }, verification: "UNVERIFIED",
			errors: run.exit === 0 ? [] : [{ code: "JOB_FAILED", message: `test --record exited ${run.exit}: ${run.out.trim().slice(0, 300)}`,
				remediation: "Run the recorded command manually with --json and read its failures." }] };
	}
	return refusal("UNKNOWN_SERVICE_COMMAND", `Unknown service subcommand: ${sub}`, "Run omp-kit help service for exact grammar.");
}

/** SEND1: send a fleet message and prove the marker landed; exit code is delivery, not the send call. */
async function sendCommand(request: ParsedCommand): Promise<CliResult> {
	try {
		serviceHome();
	} catch {
		return { code: 3, data: { overall: "UNAVAILABLE" },
			errors: [{ code: "HOME_UNAVAILABLE", message: "Send needs an absolute HOME",
				remediation: "Run with an absolute HOME; nothing was sent." }], verification: "UNVERIFIED" };
	}
	// The parser joins the three positionals; session and pane never contain
	// spaces, so the first two tokens delimit and the remainder is the message.
	const [session, pane, ...messageParts] = (request.argument ?? "").split(" ").filter(part => part !== "");
	if (!session || !pane || messageParts.length === 0) {
		return refusal("MISSING_ARGUMENT", "send needs SESSION PANE MESSAGE", "Run omp-kit send SESSION PANE MESSAGE; nothing was sent.");
	}
	const stateRoot = receiptStateRoot();
	if (!stateRoot) return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
		"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset; nothing was sent.");
	const dropFlag = request.flags.get("--drop-dir");
	if (typeof dropFlag === "string" && !isAbsolute(dropFlag)) {
		return refusal("INVALID_DROP_DIR", "The drop folder requires a canonical absolute path",
			"Pass an absolute --drop-dir; nothing was sent.");
	}
	const result = await proveSend({ session, pane, message: messageParts.join(" "), dropDir: typeof dropFlag === "string" ? dropFlag : join(stateRoot, "send-drop") });
	if (result.status === "OK") {
		return { code: 0, data: { overall: "OK", session, pane, status: result.status, marker: result.marker, sends: result.sends, drop_path: null, detail: result.detail }, verification: "UNVERIFIED" };
	}
	return { code: 1, data: { overall: "NOT_DELIVERED", session, pane, status: result.status, marker: result.marker, sends: result.sends, drop_path: result.drop_path, detail: result.detail }, verification: "UNVERIFIED",
		errors: [{ code: "NOT_DELIVERED", message: result.detail,
			remediation: result.drop_path ? `Relay the message manually; the full text is at ${result.drop_path}.` : "Retry the send; no drop file was written." }] };
}

const INFRA_BINARIES: Record<string, string> = { bun: "bun", "typescript-language-server": "typescript-language-server" };

function defaultPinFile(): string {
	const root = kitIdentity().release.root;
	if (root) return join(root, ".omp", "infra-pins.toml");
	return join(import.meta.dir, "..", ".omp", "infra-pins.toml");
}

/** Read and parse a pin file; fail-closed on missing, unsafe or malformed input. */
function readInfraPinFile(pinPath: string): { pins: InfraPins } | { error: string } {
	try {
		const stat = lstatSync(pinPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
			return { error: `Pin file ${pinPath} is not a safe regular file` };
		}
	} catch {
		return { error: `Pin file ${pinPath} is missing or unreadable` };
	}
	const pins = parseInfraPins(readFileSync(pinPath, "utf8"));
	if (!pins) return { error: `Pin file ${pinPath} is malformed or carries no pins` };
	return { pins };
}

function installedInfraVersions(): Record<string, string | null> {
	const versions: Record<string, string | null> = {};
	for (const [tool, binary] of Object.entries(INFRA_BINARIES)) {
		try {
			const run = defaultRunner([binary, "--version"]);
			versions[tool] = run.code === 0 ? (run.stdout.trim().split("\n")[0] ?? null) : null;
		} catch {
			versions[tool] = null;
		}
	}
	return versions;
}


/** TOOL1: pin, check, promote and undo the toolchain the gates run on. */
async function infraCommand(request: ParsedCommand): Promise<CliResult> {
	const sub = request.command.name;
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNAVAILABLE", command: sub },
			errors: [{ code: "HOME_UNAVAILABLE", message: "Infra commands need an absolute HOME",
				remediation: "Run with an absolute HOME; nothing was changed." }], verification: "UNVERIFIED" };
	}
	const flag = (name: string): string | undefined => {
		const value = request.flags.get(name);
		return typeof value === "string" ? value : undefined;
	};
	if (sub === "pin") {
		const pinPath = flag("--file") ?? defaultPinFile();
		if (!isAbsolute(pinPath)) {
			return refusal("INVALID_PIN_FILE", "The pin file requires a canonical absolute path",
				"Pass an absolute --file PATH; nothing was changed.");
		}
		const read = readInfraPinFile(pinPath);
		if ("error" in read) {
			return { code: 3, data: { overall: "UNAVAILABLE", command: sub },
				errors: [{ code: "PIN_FILE_UNAVAILABLE", message: read.error,
					remediation: "Certify a toolchain version with infra check/promote first; nothing was changed." }], verification: "UNVERIFIED" };
		}
		const drift = diffInfraPins(read.pins, installedInfraVersions());
		if (drift.length === 0) {
			return { code: 0, data: { overall: "OK", command: sub, status: "OK", drift, detail: "Installed toolchain matches every pin." }, verification: "UNVERIFIED" };
		}
		const first = drift[0]!;
		return { code: 1, data: { overall: "FINDINGS", command: sub, status: "DRIFT", drift,
				detail: `${first.tool} is ${first.installed ?? "unknown"}, pinned ${first.pinned}.` },
			errors: [{ code: "INFRA_DRIFT", message: `${drift.length} pinned tool(s) differ from installed`,
				remediation: "Run infra check on a candidate, then promote with --human; nothing was changed." }], verification: "UNVERIFIED" };
	}
	const stateRoot = receiptStateRoot();
	if (!stateRoot) {
		return refusal("INVALID_STATE_ROOT", "A canonical absolute HOME and state root are required",
			"Set an absolute HOME and XDG_STATE_HOME, or leave XDG_STATE_HOME unset; nothing was changed.");
	}
	if (sub === "undo") {
		if (!request.flags.has("--apply") || !request.flags.has("--yes")) {
			return refusal("UNDO_REQUIRES_APPLY", "infra undo restores the pin file from a promote backup",
				"Re-run with --apply --yes; without --apply this is a read-only refusal.");
		}
		const receiptPath = flag("--receipt");
		if (!receiptPath || !isAbsolute(receiptPath)) {
			return refusal("MISSING_ARGUMENT", "infra undo needs --receipt PATH",
				"Pass the promote receipt holding the backup path; nothing was changed.");
		}
		let receipt: unknown;
		try {
			receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		} catch {
			return refusal("RECEIPT_UNREADABLE", `Promote receipt ${receiptPath} is missing or unparsable`,
				"Pass the receipt written by infra promote; nothing was changed.");
		}
		if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
			!("pin_backup" in receipt) || typeof receipt.pin_backup !== "string" ||
			!("tool" in receipt) || typeof receipt.tool !== "string") {
			return refusal("RECEIPT_INVALID", `Promote receipt ${receiptPath} names no pin backup`,
				"Pass the receipt written by infra promote; nothing was changed.");
		}
		let backupText: string;
		try {
			backupText = readFileSync(receipt.pin_backup, "utf8");
		} catch {
			return refusal("BACKUP_MISSING", `Pin backup ${receipt.pin_backup} is absent; the pin file is untouched`,
				"Restore the pin file manually from version control; nothing was changed.");
		}
		const pinPath = flag("--file") ?? defaultPinFile();
		if (!isAbsolute(pinPath)) {
			return refusal("INVALID_PIN_FILE", "The pin file requires a canonical absolute path",
				"Pass an absolute --file PATH; nothing was changed.");
		}
		writeFileSync(pinPath, backupText, { mode: 0o600 });
		const readBack = readInfraPinFile(pinPath);
		if ("error" in readBack) {
			return { code: 1, data: { overall: "FINDINGS", command: sub, status: "UNVERIFIED", receipt_id: receiptPath,
					detail: `Pin file restored from backup but does not parse: ${readBack.error}` },
				errors: [{ code: "UNDO_UNVERIFIED", message: readBack.error,
					remediation: "Inspect the restored pin file manually." }], verification: "UNVERIFIED" };
		}
		return { code: 0, data: { overall: "CHANGED", command: sub, status: "RESTORED", receipt_id: receiptPath,
				detail: `Pin file restored from ${receipt.pin_backup}; ${receipt.tool} reads back ${JSON.stringify(readBack.pins.tools[receipt.tool] ?? null)}.` }, verification: "UNVERIFIED" };
	}
	const tool = flag("--tool"), candidate = flag("--candidate");
	if (!tool || !candidate) {
		return refusal("MISSING_ARGUMENT", `infra ${sub} needs --tool NAME --candidate VERSION`,
			"Pass the tool and candidate version; nothing was changed.");
	}
	const binaryName = INFRA_BINARIES[tool];
	if (!binaryName) {
		return refusal("UNKNOWN_TOOL", `Unknown tool ${tool}`,
			`Known tools: ${Object.keys(INFRA_BINARIES).join(", ")}; nothing was changed.`);
	}
	if (sub === "promote" && (!request.flags.has("--apply") || !request.flags.has("--yes"))) {
		return refusal("PROMOTE_REQUIRES_APPLY", "infra promote rewrites the pin file",
			"Re-run with --human --apply --yes; without --apply this is a read-only refusal.");
	}
	if (sub === "promote" && !request.flags.has("--human")) {
		return refusal("HUMAN_REQUIRED", "Only Josh promotes; agents prepare the check",
			"Josh re-runs with --human --apply --yes; nothing was changed.");
	}
	const binary = flag("--binary");
	if (!binary || !isAbsolute(binary) || !executableFile(binary)) {
		return refusal("CANDIDATE_UNAVAILABLE", `Candidate binary ${binary ?? "(none)"} is missing or not executable`,
			"Pass an executable --binary PATH; nothing was changed.");
	}
	const prefix = flag("--prefix") ?? join(stateRoot, "infra-check", `${tool}-${candidate}`);
	if (!isAbsolute(prefix)) {
		return refusal("INVALID_PREFIX", "The isolated prefix requires a canonical absolute path",
			"Pass an absolute --prefix DIR; nothing was changed.");
	}
	mkdirSync(join(prefix, "bin"), { recursive: true, mode: 0o700 });
	const staged = join(prefix, "bin", binaryName);
	writeFileSync(staged, readFileSync(binary), { mode: 0o755 });
	chmodSync(staged, 0o755);
	const probe = defaultRunner([staged, "--version"]);
	if (probe.code !== 0 || !probe.stdout.includes(candidate)) {
		return { code: 1, data: { overall: "FINDINGS", command: sub, tool, version: candidate, status: "FAIL", failed_stage: "candidate-mismatch",
				detail: `Staged ${binaryName} does not report ${candidate}.` },
			errors: [{ code: "CANDIDATE_MISMATCH", message: `Staged binary reports ${probe.stdout.trim().slice(0, 80) || `exit ${probe.code}`}, not ${candidate}`,
				remediation: "Pass the binary for the candidate version; nothing else was changed." }], verification: "UNVERIFIED" };
	}
	const waitFlag = request.flags.has("--wait");
	const forceFlag = request.flags.has("--force");
	if (waitFlag && forceFlag) {
		return refusal("CONFLICTING_FLAGS", "--wait and --force cannot be combined",
			`Choose waiting for quiet or forcing now for ${sub}; nothing was changed.`);
	}
	const timeoutRaw = flag("--wait-timeout-min");
	let timeoutMin = 120;
	if (timeoutRaw !== undefined) {
		timeoutMin = Number(timeoutRaw);
		if (!Number.isInteger(timeoutMin) || timeoutMin < 1) {
			return refusal("INVALID_TIMEOUT", "--wait-timeout-min needs a positive integer number of minutes",
				"Pass e.g. --wait-timeout-min 60; nothing was changed.");
		}
	}
	const readLoad = (): { load1: number; ncpu: number } => {
		const loads = loadavg();
		return { load1: loads[0] ?? 0, ncpu: cpus().length };
	};
	let sample = readLoad();
	let gate = loadGate(sample.load1, sample.ncpu);
	let waitedMs = 0;
	if (!gate.ok && waitFlag) {
		const waitStart = Date.now();
		const deadline = waitStart + timeoutMin * 60 * 1000;
		while (Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
			sample = readLoad();
			gate = loadGate(sample.load1, sample.ncpu);
			if (gate.ok) break;
		}
		waitedMs = Date.now() - waitStart;
	}
	if (!gate.ok && !waitFlag && !forceFlag) {
		return refusal("LOAD_TOO_HIGH", `1-minute load ${sample.load1} exceeds the 1.5x-cores check gate; retry when quiet`,
			"Re-run with --wait to wait for quiet, or --force to run now (the verdict will be INCONCLUSIVE); nothing was changed.");
	}
	const forced = !gate.ok;
	const repoTop = defaultRunner(["git", "rev-parse", "--show-toplevel"]);
	const originTip = defaultRunner(["git", "rev-parse", "--verify", "origin/main"]);
	if (repoTop.code !== 0 || originTip.code !== 0) {
		return refusal("NOT_A_CHECKOUT", "infra check runs the ladder from an export of origin/main",
			"Run from a contributor checkout with origin/main present; nothing was changed.");
	}
	const exportDir = join(prefix, "export");
	mkdirSync(exportDir, { recursive: true, mode: 0o700 });
	const archive = Bun.spawnSync(["git", "-C", repoTop.stdout.trim(), "archive", "origin/main"], { stdout: "pipe", stderr: "pipe" });
	if (archive.exitCode !== 0) {
		return refusal("ARCHIVE_FAILED", "git archive of origin/main failed; the ladder has no clean tree to run on",
			"Repair the checkout and re-run; nothing was changed.");
	}
	const untar = Bun.spawnSync(["tar", "-x", "-C", exportDir], { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" });
	if (untar.exitCode !== 0) {
		return refusal("ARCHIVE_FAILED", "Extracting the origin/main export failed; the ladder has no clean tree to run on",
			"Repair tar availability and re-run; nothing was changed.");
	}
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") childEnv[key] = value;
	let report;
	try {
		report = await checkInfraCandidate({ tool, version: candidate, repoRoot: exportDir, pathPrefix: prefix, baseEnv: childEnv,
			forcedHighLoad: forced || undefined,
			exec: { run: (argv, opts) => {
				const run = Bun.spawnSync([...argv], { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
				return Promise.resolve({ code: run.exitCode, out: `${run.stdout.toString()}\n${run.stderr.toString()}` });
			} } });
	} finally {
		try {
			rmSync(exportDir, { recursive: true, force: true });
		} catch { /* export cleanup is best-effort; evidence is in the report */ }
	}
	if (sub === "check") {
		if (report.status === "PASS") {
			return { code: 0, data: { overall: "OK", command: sub, tool, version: candidate, status: report.status,
					failed_stage: null, stages: report.stages, log_tail: report.logTail,
					detail: `${tool} ${candidate} passed the ladder with the candidate first on PATH.` }, verification: "UNVERIFIED" };
		}
		if (report.status === "INCONCLUSIVE") {
			return { code: 3, data: { overall: "UNVERIFIED", command: sub, tool, version: candidate, status: report.status,
					failed_stage: report.failedStage, stages: report.stages, log_tail: report.logTail,
					detail: `${tool} ${candidate} ran forced above the load limit${waitedMs > 0 ? ` after waiting ${Math.round(waitedMs / 60000)} min` : ""}; stages are evidence, never a verdict.` },
				errors: [{ code: "INCONCLUSIVE", message: "A forced run above the load limit cannot pass or fail",
					remediation: "Re-run when quiet (or with --wait); the machine toolchain is unchanged." }], verification: "UNVERIFIED" };
		}
		return { code: 1, data: { overall: "FINDINGS", command: sub, tool, version: candidate, status: report.status,
				failed_stage: report.failedStage, stages: report.stages, log_tail: report.logTail,
				detail: `${tool} ${candidate} failed at ${report.failedStage ?? "an unknown stage"}.` },
			errors: [{ code: "CHECK_FAILED", message: `${tool} ${candidate} failed the ladder at ${report.failedStage ?? "an unknown stage"}`,
				remediation: "Inspect the failing stage; the machine toolchain is unchanged." }], verification: "UNVERIFIED" };
	}
	if (sub !== "promote") {
		return refusal("UNKNOWN_INFRA_COMMAND", `Unknown infra subcommand: ${sub}`, "Run omp-kit help infra for exact grammar.");
	}
	if (report.status !== "PASS") {
		return { code: 1, data: { overall: "FINDINGS", command: sub, tool, version: candidate, status: report.status,
				failed_stage: report.failedStage, stages: report.stages, log_tail: report.logTail,
				detail: `Refusing promote: ${tool} ${candidate} failed at ${report.failedStage ?? "an unknown stage"}.` },
			errors: [{ code: "CHECK_FAILED", message: "A passing check for the exact candidate is required before promote",
				remediation: "Fix the failing stage and re-run infra check; nothing was changed." }], verification: "UNVERIFIED" };
	}
	const installed = installedInfraVersions()[tool] ?? null;
	if (installed === null || !installed.includes(candidate)) {
		return refusal("INSTALLED_MISMATCH", `${tool} is installed as ${installed ?? "unknown"}, not ${candidate}`,
			`Upgrade ${tool} to ${candidate} first, then promote to certify it; nothing was changed.`);
	}
	const pinPath = flag("--file") ?? defaultPinFile();
	if (!isAbsolute(pinPath)) {
		return refusal("INVALID_PIN_FILE", "The pin file requires a canonical absolute path",
			"Pass an absolute --file PATH; nothing was changed.");
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const certification = `ladder-${stamp}-${tool}-${candidate}-PASS`;
	const existing = readInfraPinFile(pinPath);
	if ("error" in existing) {
		const created = `# Toolchain pins: versions certified by ladder runs. See TOOL1.\n[tools.${tool}]\nversion = "${candidate}"\nreceipt = "${certification}"\n`;
		mkdirSync(dirname(pinPath), { recursive: true, mode: 0o700 });
		writeFileSync(pinPath, created, { mode: 0o600 });
		const receiptId = join(stateRoot, `infra-promote-${tool}-${stamp}.json`);
		writeFileSync(receiptId, JSON.stringify({ tool, from: null, to: candidate, check: "PASS", at: new Date().toISOString(), pin_receipt: certification, prior_receipt: null, pin_backup: null, pin_file: pinPath }), { mode: 0o600 });
		return { code: 0, data: { overall: "CHANGED", command: sub, tool, version: candidate, status: "PROMOTED",
				receipt_id: receiptId, detail: `${tool} ${candidate} certified as the first pin.` }, verification: "UNVERIFIED" };
	}
	const promoted = await promoteInfra({ tool, version: candidate, pins: existing.pins,
		check: { tool, version: candidate, status: "PASS" }, receipt: certification,
		human: true, install: () => Promise.resolve(true) });
	if (promoted.status !== "PROMOTED") {
		return { code: 1, data: { overall: "FINDINGS", command: sub, tool, version: candidate, status: promoted.status,
				detail: promoted.reason },
			errors: [{ code: "PROMOTE_REFUSED", message: promoted.reason,
				remediation: "Satisfy the guard and re-run; nothing was changed." }], verification: "UNVERIFIED" };
	}
	const backup = `${pinPath}.backup-${stamp}`;
	writeFileSync(backup, readFileSync(pinPath, "utf8"), { mode: 0o600 });
	const bumped = updatePinVersion(readFileSync(pinPath, "utf8"), tool, candidate, certification);
	if (!bumped) {
		return { code: 1, data: { overall: "FINDINGS", command: sub, tool, version: candidate, status: "FAILED",
				detail: `Pin file ${pinPath} resists the version bump; backup at ${backup}.` },
			errors: [{ code: "PIN_UPDATE_FAILED", message: `Pin file ${pinPath} resists the version bump`,
				remediation: `Restore from ${backup} or edit the pin file manually; the pin is unchanged.` }], verification: "UNVERIFIED" };
	}
	writeFileSync(pinPath, bumped, { mode: 0o600 });
	const receiptId = join(stateRoot, `infra-promote-${tool}-${stamp}.json`);
	writeFileSync(receiptId, JSON.stringify({ ...promoted.receipt, pin_backup: backup, pin_file: pinPath }), { mode: 0o600 });
	return { code: 0, data: { overall: "CHANGED", command: sub, tool, version: candidate, status: "PROMOTED",
			receipt_id: receiptId, detail: `${tool} certified at ${candidate}; backup at ${backup}.` }, verification: "UNVERIFIED" };
}

for (const subcommand of ["list", "install", "uninstall", "status", "doctor", "logs", "run"]) registerCommandHandler(`service ${subcommand}`, serviceCommand);
registerCommandHandler("load watch", loadWatchCommand);
registerCommandHandler("send", sendCommand);
for (const subcommand of ["pin", "check", "promote", "undo"]) registerCommandHandler(`infra ${subcommand}`, infraCommand);

async function scratchCommand(request: ParsedCommand): Promise<CliResult> {
	const sub = request.command.name;
	let home: string;
	try {
		home = serviceHome();
	} catch {
		return { code: 3, data: { overall: "UNAVAILABLE" },
			errors: [{ code: "HOME_UNAVAILABLE", message: "Scratch commands need an absolute HOME",
				remediation: "Run with an absolute HOME; no scratch was changed." }], verification: "UNVERIFIED" };
	}
	const deps = { liveness: defaultLiveness(), run: scratchRunner,
		onProgress: (verdict: { dir: string; action: string; reason: string }) => {
			process.stderr.write(`scratch ${sub}: ${verdict.action} ${verdict.dir} (${verdict.reason})\n`);
		} };
	if (sub === "release") {
		if (!request.argument) return refusal("SCRATCH_RELEASE_PATH_REQUIRED", "scratch release needs a directory path",
			"Run omp-kit scratch release ABSOLUTE_DIR from the owning session or one of its child processes.");
		const released = releaseScratch(request.argument, home, deps);
		if (!released.ok) return refusal("SCRATCH_RELEASE_REFUSED", `Scratch release refused: ${released.reason}`,
			"Use the exact owned task directory from its owner process; no directory was quarantined.");
		return { code: 0, data: { overall: released.changed ? "CHANGED" : "OK", action: "RELEASED",
			dir: released.dir, changed: released.changed }, verification: "UNVERIFIED" };
	}
	if (sub === "plan") {
		const plan = planScratch(home, deps);
		return { code: 0, data: { overall: "OK", roots: plan.roots, sessions: plan.sessions, orphans: plan.orphans,
			reapableBytes: plan.reapableBytes, quarantinableBytes: plan.quarantinableBytes }, verification: "UNVERIFIED" };
	}
	if (sub === "apply") {
		if (!request.flags.has("--apply")) {
			return refusal("SCRATCH_REQUIRES_APPLY", "scratch apply deletes scratch and kills orphaned harness servers",
				"Re-run with --apply --yes, or run scratch plan to preview without changing anything.");
		}
		const result = applyScratch(home, { ...deps, home });
		const failed = result.applied.filter(isApplyFailure).length + result.killed.filter(kill => !kill.ok).length;
		return { code: failed > 0 ? 1 : 0,
			data: { overall: failed > 0 ? "FINDINGS" : "OK", roots: result.roots, sessions: result.applied,
				orphans: result.orphans, killed: result.killed, expired: result.expired,
				reapableBytes: result.reapableBytes, quarantinableBytes: result.quarantinableBytes },
			verification: "UNVERIFIED" };
	}
	return refusal("UNKNOWN_SCRATCH_COMMAND", `Unknown scratch subcommand: ${sub}`, "Run omp-kit help scratch for exact grammar.");
}

for (const subcommand of ["plan", "release", "apply"]) registerCommandHandler(`scratch ${subcommand}`, scratchCommand);


async function updateCommand(request: ParsedCommand): Promise<CliResult> {
	const scope = "kit";
	const applying = request.flags.has("--apply");
	const home = process.env.HOME, stateRoot = receiptStateRoot(), release = kitIdentity().release.root;
	if (!home || !isAbsolute(home) || !stateRoot || !release)
		return refusal("UPDATE_CONTEXT_UNAVAILABLE", "An installed kit and canonical absolute HOME/state root are required",
			"Install a verified local kit archive, then set a canonical HOME and XDG_STATE_HOME.");
	const version = request.flags.get("--version"), indexPath = request.flags.get("--index"), archivePath = request.flags.get("--archive");
	if (typeof version !== "string" || typeof indexPath !== "string" || typeof archivePath !== "string" ||
		![indexPath, archivePath].every(path => isAbsolute(path) && resolve(path) === path))
		return refusal("LOCAL_SOURCE_REQUIRED", "Kit update requires an exact version and matching absolute local index/archive paths",
			"Pass --version X.Y.Z --index ABSOLUTE_INDEX --archive ABSOLUTE_ARCHIVE; no public latest endpoint is assumed.");
	if ((process.platform !== "darwin" && process.platform !== "linux") || (process.arch !== "arm64" && process.arch !== "x64"))
		return refusal("UNSUPPORTED_PLATFORM", "No native kit archive target is available for this operating system or architecture",
			"Use a supported macOS or GNU/Linux arm64/x64 target.");
	const input: KitUpdateInput = { prefix: dirname(dirname(release)), stateRoot, home, platform: {
		os: process.platform, arch: process.arch, libc: process.platform === "darwin" ? "none" : "gnu",
	}, version, sourceTag: `v${version}`, indexPath, archivePath };
	const plan = await planKitUpdate(input);
	if (!("current" in plan))
		return { code: plan.exitCode, data: { overall: "UNVERIFIED", scope, action: "REFUSED", reason: plan.reason },
			verification: "UNVERIFIED" };
	if (!applying)
		return { code: 0, data: { overall: "UNVERIFIED", scope, action: "PLAN",
			kit: { status: plan.status, start: plan.current.version, target: plan.release.version,
				source: plan.provenance, asset_sha256: plan.release.asset.sha256 },
		}, verification: "UNVERIFIED" };
	try {
		return kitUpdateEnvelope(plan, await applyKitUpdate(plan));
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "PENDING_RECOVERY") return { code: 1, data: { overall: "FAIL", scope, action: "PARTIAL" },
			errors: [{ code, message: "Previous kit/OMP update requires recovery",
				remediation: "Inspect omp-kit audit and verify both component postimages before another update." }], verification: "UNVERIFIED" };
		return refusal("KIT_UPDATE_REFUSED", "Kit version, archive, state or lock failed locked revalidation",
			"Inspect the exact archive and audit receipt; no completed update is claimed.");
	}
}

function planningScoreCommand(request: ParsedCommand): CliResult {
	const repoFlag = request.flags.get("--repo");
	if (repoFlag !== undefined && (typeof repoFlag !== "string" || !repoFlag.trim()))
		return refusal("INVALID_FLAG", "--repo requires a non-empty repository path", "Use omp-kit planning score --repo PATH or --fleet.");
	const kitRoot = kitIdentity().release.root ?? resolve(import.meta.dir, "..");
	return runPlanningScore({ kitRoot, ...(typeof repoFlag === "string" ? { repoPath: repoFlag } : {}), fleet: request.flags.has("--fleet"), cwd: process.cwd(), home: process.env.HOME });
}
registerCommandHandler("planning score", planningScoreCommand);
function missionValidateCommand(request: ParsedCommand): CliResult {
	const projectFlag = request.flags.get("--project");
	if (projectFlag !== undefined && (typeof projectFlag !== "string" || !projectFlag.trim()))
		return refusal("INVALID_FLAG", "--project requires a non-empty path", "Use omp-kit mission validate --project PATH or run from the project root.");
	const projectRoot = resolve(typeof projectFlag === "string" ? projectFlag : process.cwd());
	const report = validateMissionRecord(projectRoot);
	return { code: report.overall === "VALID" ? 0 : 1, data: { ...report }, verification: "PERFORMED" };
}
registerCommandHandler("mission validate", missionValidateCommand);

registerCommandHandler("update", updateCommand);

async function dispatch(request: ParsedCommand, version: string): Promise<CliResult> {
	const { command, parent, flags } = request;
	const path = `${parent ? `${parent.name} ` : ""}${command.name}`;
	if (flags.has("--help")) return { code: 0, data: { text: command.name === "help" ? help() : help(command, parent) }, verification: "PERFORMED" };
	if (command.name === "--version") return { code: 0, data: { text: `omp-kit ${version}`, version }, verification: "PERFORMED" };
	if (command.name === "--info") {
		const kit = kitIdentity();
		return { code: 0, data: { ...kit, omp: ompIdentity(), dependencies: { bun: "embedded when compiled", omp: "optional for help; required for status/test" } }, verification: "UNVERIFIED" };
	}
	const handler = handlers.get(path);
	if (handler && (STATE_ROOT_COMMANDS[path] || (path === "test" && flags.has("--record"))) && !(path === "repair" && flags.get("--scope") === "state")) {
		const stateRoot = receiptStateRoot();
		const issue = stateRoot ? inspectStateRoot(stateRoot) : null;
		if (issue) return stateRootRefusal(issue);
	}
	if (handler) {
		// An interactive apply mcp walk-through asks once, after showing the plan.
		if (command.mutation && (flags.has("--apply") || command.name === "undo") && !(path === "apply mcp" && interactiveMcpApply(request))) {
			const accepted = await confirmMutation({
				action: command.name === "undo" ? `${path} ${request.argument ?? ""}`.trim() : path,
				explicit: true,
				yes: flags.has("--yes"),
				json: request.json,
				robot: request.robot,
				noColor: flags.has("--no-color"),
			});
			if (!accepted) return refusal("CONSENT_REQUIRED", `${path} was not confirmed; no mutation was attempted`, "Review the plan, then pass --yes or type CONFIRM at an interactive terminal.");
		}
		return handler(request);
	}
	if (command.name === "help") {
		const words = request.argument?.split(" ") ?? [];
		const top = words.length ? findCommand(words[0] ?? "") : undefined;
		const topic = words.length === 2 ? findCommand(words[1] ?? "", top?.subcommands) : top;
		if (words.length && !topic) return refusal("UNKNOWN_TOPIC", `Unknown help topic: ${request.argument}`, "Run omp-kit --help for exact topics.");
		return { code: 0, data: { text: help(topic, words.length === 2 ? top : undefined) }, verification: "PERFORMED" };
	}
	if (command.name === "doctor" && flags.get("--scope") === "work") return workDoctor(request);
	if (command.name === "doctor" && flags.get("--scope") === "sessions") return sessionDoctor();
	if (command.name === "doctor" && flags.get("--scope") === "load") return loadDoctor();
	if (command.name === "doctor" && flags.has("--deep")) return diagnosticInventory(request);
	if (command.name === "doctor" && flags.has("--profile") && !["memory", "mcp", "context"].includes(String(flags.get("--scope")))) {
		return refusal("INVALID_FLAG", "--profile is only valid for doctor --scope memory, mcp or context", "Use omp-kit doctor --scope context --profile NAME.");
	}
	if (command.name === "doctor" && flags.has("--sources") && flags.get("--scope") !== "mcp") {
		return refusal("INVALID_FLAG", "--sources is only valid for doctor --scope mcp", "Use omp-kit doctor --scope mcp --sources.");
	}
	if (command.name === "doctor" && flags.has("--services") && flags.get("--scope") !== "services") {
		return refusal("INVALID_FLAG", "--services is only valid for doctor --scope services", "Use omp-kit doctor --scope services --services ABS_FILE.");
	}
	if (command.name === "doctor" && flags.get("--scope") === "rules" && (flags.has("--corpus-report") || flags.has("--labels"))) return ruleCalibrationDoctor(request);
	if (command.name === "doctor" && flags.get("--scope") === "lsp") return lspReadiness(request);
	if (command.name === "doctor" && flags.get("--scope") === "project-loading") {
		if (flags.has("--file")) return refusal("INVALID_FLAG", "--file is only valid for doctor --scope lsp", "Use omp-kit doctor --scope project-loading --project PATH.");
		return projectTrustInventory(request);
	}
	if (command.name === "doctor" && flags.get("--scope") === "memory") {
		if (flags.has("--project") || flags.has("--file")) return refusal("INVALID_FLAG", "memory scope inspects the actual session cwd and cannot accept --project or --file", "Use omp-kit doctor --scope memory --profile NAME.");
		return memoryInventory(request);
	}
	if (command.name === "doctor" && flags.get("--scope") === "mcp") {
		if (flags.has("--project") || flags.has("--file")) return refusal("INVALID_FLAG", "MCP scope inspects the actual session cwd and cannot accept --project or --file", "Use omp-kit doctor --scope mcp --profile NAME.");
		if (flags.has("--sources")) {
			if (flags.has("--profile")) return refusal("INVALID_FLAG", "--sources covers every profile and cannot take --profile", "Use omp-kit doctor --scope mcp --sources.");
			return mcpSourcesInventory();
		}
		return mcpInventory(request);
	}
	if (command.name === "doctor" && flags.get("--scope") === "services") {
		if (flags.has("--project") || flags.has("--file") || flags.has("--profile")) return refusal("INVALID_FLAG", "services scope inspects machine launchd state and cannot accept --project, --file or --profile", "Use omp-kit doctor --scope services [--services ABS_FILE].");
		return servicesInventory(request);
	}
	if (command.name === "doctor" && flags.get("--scope") === "context") {
		if (flags.has("--file")) return refusal("INVALID_FLAG", "--file is only valid for doctor --scope lsp", "Use omp-kit doctor --scope context [--profile NAME] [--project PATH].");
		return contextInventory(request);
	}
	if (command.name === "doctor" && (flags.has("--project") || flags.has("--file"))) {
		const scope = flags.get("--scope");
		const allowed = scope === "lsp" || scope === "project-loading" || (scope === "beads" && flags.has("--project") && !flags.has("--file")) || (scope === "reservations" && flags.has("--project") && !flags.has("--file")) || (scope === "identity" && flags.has("--project") && !flags.has("--file")) || (scope === "flywheel" && flags.has("--project") && !flags.has("--file")) || (scope === "derived" && flags.has("--project") && !flags.has("--file"));
		if (!allowed) return refusal("INVALID_FLAG", "--project and --file require doctor --scope lsp or project-loading; beads, reservations, identity, flywheel and derived accept only --project", "Use doctor --scope beads --project PATH for a tracker export, doctor --scope reservations --project PATH for another repo's holds, doctor --scope identity --project PATH for pane identities, doctor --scope flywheel --project PATH for fleet practice grades, or doctor --scope derived --project PATH for literal facts in config files.");
	}
	if (parent?.name === "memory" && command.name === "audit") return privateMemoryAudit(request);
	if (parent?.name === "lsp" && command.name === "setup") {
		if (!flags.has("--plan")) return refusal("PLAN_REQUIRED", "lsp setup only supports an explicit read-only --plan", "Run omp-kit lsp setup --plan.");
		return lspReadiness(request);
	}
async function skillSetExample(request: ParsedCommand): Promise<CliResult> {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !kit.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "INVENTORY_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no history was read.",
		}], verification: "UNVERIFIED" };
	}
	const daysRaw = request.flags.get("--from-history");
	const days = typeof daysRaw === "string" ? Number(daysRaw) : NaN;
	if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
		return refusal("INVALID_HISTORY_WINDOW", "--from-history requires an integer window of 1..90 days",
			"Pass the lookback window explicitly; session transcripts are only read, never written.");
	}
	const requested = request.flags.get("--profile");
	let profile = "default";
	if (typeof requested === "string") {
		try {
			profile = validateProfileName(requested);
		} catch {
			return refusal("INVALID_PROFILE", "Selected profile name is not a safe OMP profile name", "Use a simple existing OMP profile name without path separators.");
		}
	}
	try {
		const report = await renderSkillSet({ home, profile, days,
			root: kit.release.root, executablePath: kit.release.executable, project: process.cwd() });
		return { code: 0, data: { overall: report.capability_check.overall === "PASS" ? "OK" : "DEGRADED", skill_set: report },
			verification: "UNVERIFIED" };
	} catch (error) {
		if (error instanceof SkillSetInputError) {
			return refusal(error.code, error.message, "Correct the selected window and profile; no history was written.");
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "SKILL_SET_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and OMP session history; no profile was changed.",
		}], verification: "UNVERIFIED" };
	}
}

async function corpusReport(request: ParsedCommand): Promise<CliResult> {
	const kit = kitIdentity();
	const home = process.env.HOME;
	if (!kit.release.root || !kit.release.executable || !home || !isAbsolute(home)) {
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "CORPUS_UNAVAILABLE", message: "Kit release root or absolute HOME is unavailable",
			remediation: "Run an installed omp-kit executable with an absolute HOME; no history was read.",
		}], verification: "UNVERIFIED" };
	}
	if (request.flags.has("--plan")) {
		return { code: 0, data: { overall: "OK", corpus_plan: CORPUS_PLAN }, verification: "UNVERIFIED" };
	}
	const sessionsRaw = request.flags.get("--sessions");
	if (typeof sessionsRaw !== "string" || !isAbsolute(sessionsRaw)) {
		return refusal("INVALID_CORPUS_SELECTION", "corpus needs --sessions ABS_DIR",
			"Point --sessions at an absolute session transcripts directory; it is only read, never written.");
	}
	const outRaw = request.flags.get("--out");
	if (outRaw !== undefined && (typeof outRaw !== "string" || !isAbsolute(outRaw))) {
		return refusal("INVALID_CORPUS_SELECTION", "corpus --out needs an absolute file path",
			"Pass an absolute --out path or omit it; the JSON still returns on stdout.");
	}
	try {
		const report = await runCorpus({ root: kit.release.root, executablePath: kit.release.executable,
			sessionsDir: sessionsRaw, ...(typeof outRaw === "string" ? { out: outRaw } : {}) });
		return { code: 0, data: { overall: "OK", corpus: report }, verification: "UNVERIFIED" };
	} catch (error) {
		if (error instanceof CorpusInputError) {
			return refusal(error.code, error.message, "Correct the selection; session transcripts are only read, never written, and never leave the machine.");
		}
		return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "CORPUS_UNAVAILABLE", message: error instanceof Error ? error.message : String(error),
			remediation: "Check the installed release and session transcripts; no profile was changed.",
		}], verification: "UNVERIFIED" };
	}
}

	if (parent?.name === "examples") {
		if (command.name === "mcp") return { code: 0, data: { text: mcpExample() }, verification: "UNVERIFIED" };
		if (command.name === "skill-set") return skillSetExample(request);
		if (command.name === "omp-watch") {
			// Render-only: shows what `service install omp-watch` would write; installs nothing.
			const home = process.env.HOME ?? "";
			const launcher = stableLauncher(home);
			let ompPackageJson: string | null = null;
			try { ompPackageJson = join(resolveOmpIdentity(process.env).packageRoot, "package.json"); } catch { /* refused below */ }
			if (!isAbsolute(home) || !ompPackageJson) return refusal("WATCH_UNAVAILABLE",
				`${isAbsolute(home) ? "OMP" : "HOME and OMP"} ${isAbsolute(home) ? "is" : "are"} not resolvable, so there is nothing for the watcher to run or watch`,
				"Set a canonical absolute HOME, install OMP, then re-run omp-kit examples omp-watch.");
			let job: ServiceJobDef;
			try {
				job = { ...KNOWN_JOBS["omp-watch"]!, label: serviceLabel("omp-watch") };
			} catch {
				return refusal("TEST_LABEL_NAMESPACE_INVALID", `OMP_KIT_TEST_LABEL_NAMESPACE=${process.env.OMP_KIT_TEST_LABEL_NAMESPACE ?? "(unset)"} is not a test namespace`,
					"Set OMP_KIT_TEST_LABEL_NAMESPACE=com.omp-kit.test.<random> in tests and smoke runs only; production leaves it unset.");
			}
			const units = renderSystemdUnits(home, job, launcher, ompPackageJson);
			return { code: 0, data: { label: job.label, watch_path: ompPackageJson,
				launchd_plist: renderLaunchdPlist(home, job, launcher, ompPackageJson).text,
				systemd_path_unit: units.path, systemd_service_unit: units.service,
				guidance: "Render-only: installs nothing. Run omp-kit service install omp-watch --dry-run to preview the managed install, then --apply --yes to install it." }, verification: "UNVERIFIED" };
		}
		const kind = PROFILE_RECIPE_KINDS.find((entry) => entry === command.name);
		if (!kind) return refusal("UNKNOWN_RECIPE", "Unknown profile recipe", "Run omp-kit help examples for supported recipes.");
		const root = kitIdentity().release.root;
		if (!root) return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
			code: "RECIPE_UNAVAILABLE", message: "Kit release root is unavailable",
			remediation: "Run an installed omp-kit release with bundled versioned examples; no profile was changed.",
		}], verification: "UNVERIFIED" };
		try {
			return { code: 0, data: renderRecipe(kind, root), verification: "UNVERIFIED" };
		} catch {
			return { code: 3, data: { overall: "UNVERIFIED" }, errors: [{
				code: "RECIPE_UNAVAILABLE", message: "The requested versioned profile recipe is unavailable in this kit release",
				remediation: "Reinstall a complete kit release; no profile was changed or activated.",
			}], verification: "UNVERIFIED" };
		}
	}
	if (command.name === "status" || command.name === "health" || command.name === "doctor") return diagnosticInventory(request);
	if (command.name === "corpus") return corpusReport(request);
	if (command.name === "schema") return { code: 0, data: schema(version), verification: "PERFORMED" };
	if (command.name === "capabilities") return { code: 0, data: { schema_version: SCHEMA_VERSION, tool_version: version, commands: availableCommands(), global_flags: GLOBAL_FLAGS, exit_codes: EXIT_CODES, proof_classes: PROOF_CLASSES }, verification: "PERFORMED" };
	if (parent?.name === "completion") return { code: 0, data: { shell: command.name, text: completion(command.name) }, verification: "PERFORMED" };
	if (command.name === "examples") return { code: 0, data: { text: COMMANDS.map((item) => `${item.example}${isRunnable(item, item.name) ? "" : " # not yet available"}`).join("\n") }, verification: "PERFORMED" };
	if (command.name === "quickstart" || parent?.name === "robot-docs") return { code: 0, data: { text: `Run omp-kit status --json to inspect presence (not effective-profile proof).\nRun omp-kit capabilities --json to discover runnable handlers.\n${COMMANDS.filter((item) => isRunnable(item, item.name)).map((item) => item.example).join("\n")}\nMCP servers from other harnesses: omp-kit doctor --scope mcp --sources --json, then omp-kit apply mcp --from claude --servers NAMES --profiles all --plan --json (--apply --yes to write; omp-kit undo RUN_ID --yes restores; --env-command SERVER:KEY=!CMD and --enable NAMES edit servers already present), then omp-kit test --mcp --profiles all --servers NAMES --call SERVER:TOOL:JSON --expect SERVER:REGEX --json.\nMutation never follows from --robot; unavailable handlers refuse.` }, verification: "PERFORMED" };
	return refusal("HANDLER_UNAVAILABLE", `${path} is documented but its safe handler is not installed`, `Run omp-kit capabilities --json to see runnable commands; no ${command.mutation ? "mutation" : "probe"} was attempted.`);
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
	const parsed = parse(args);
	if ("request" in parsed && parsed.request.command.name === "heavy" && !parsed.request.flags.has("--help")) {
		const label = parsed.request.flags.get("--label");
		return runHeavy(parsed.request.commandArgs ?? [], {
			...(typeof label === "string" ? { label } : {}),
			noWait: parsed.request.flags.has("--no-wait"),
		});
	}
	const json = "request" in parsed ? parsed.request.json : parsed.json;
	const version = kitIdentity().version;
	let result: CliResult;
	try {
		result = "request" in parsed ? await dispatch(parsed.request, version) : parsed.failure;
	} catch {
		result = { code: 1, data: { overall: "UNVERIFIED" }, errors: [{ code: "HANDLER_FAILED", message: "Command failed without verified completion", remediation: "Inspect local diagnostics; no success or rollback is implied." }], verification: "UNVERIFIED" };
	}
	const rendered = renderOutput(result, { toolVersion: version, schemaVersion: SCHEMA_VERSION, json });
	if (rendered.stdout) process.stdout.write(rendered.stdout);
	if (rendered.stderr) process.stderr.write(rendered.stderr);
	return rendered.exitCode;
}

if (import.meta.main) {
	runCli().then((code) => { process.exitCode = code; }, (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`CLI_FAILURE: ${message}\n`);
		process.exitCode = 1;
	});
}
