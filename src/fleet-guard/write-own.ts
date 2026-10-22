import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { physicalTarget, targets } from "./durability.ts";
import { commandFromEvent, commandName, executedShellCommands, repositoryRoot, reservationGaps, type ShellInspection, type ShellWord } from "./git.ts";
import { resolveFilesystemWriteTarget, type FleetGuardBlock, type FleetGuardContext, type FleetGuardEvent } from "./scratch.ts";

/**
 * WRITEOWN1 (ompkit-vf33j): ownership is checked at the write, not at commit. In the canonical checkout of a
 * fleet-enabled repository (the nearest Git root of the target, with `.omp/fleet.json` enabled), every write outside
 * `var/agent-tmp/` needs a live exclusive Agent Mail reservation held by the caller's AGENT_NAME, read through the
 * same lookup `git commit --only` uses (git.ts reservationGaps). Covered acts: write/edit tool targets, and in bash
 * output redirections, cp/mv/install destinations (mv sources too), tee and `sed -i` files, and `git add`/`git stage`
 * pathspecs; staging without a pathspec is refused outright (staging happens inside `git commit --only -- <paths>`).
 * A failed lookup refuses with a named error. A target spelled only through an unknown variable (`"$TMPDIR/x"`), or
 * relative to a directory a computed `cd` chose, is not lexically resolvable and is not judged.
 */

/** Fleet opt-in state of a repository root (extensions/fleet-policy.ts fleetPolicyState). */
export interface FleetPolicyVerdict { kind: "on" | "off" | "unavailable"; root: string; reason?: string }

export interface WriteOwnContext extends FleetGuardContext {
	fleetPolicy: (directory: string) => Promise<FleetPolicyVerdict>;
}

/**
 * `file`: the path itself; `children`: some file directly or deeper under the directory; `blanket`: unscoped staging
 * there; `unresolved`: a `git add` pathspec spelled through a variable, judged where the checkout is (`path`).
 */
interface Candidate { path: string; spelled: string; scope: "file" | "children" | "blanket" | "unresolved" }

const SCRATCH = "var/agent-tmp";
const CHILD_PROBE = "\0";
const SAFE_SHELL_WORD = /^[A-Za-z0-9_./@%+=:,-]+$/;
const COPIERS = new Set(["cp", "mv", "install", "gcp", "gmv", "ginstall"]);
const EXPORT_ROUTE = "or develop in an exact-commit export under var/agent-tmp/ (`omp-kit scratch new --export <sha>`)";

function quote(word: string): string {
	return SAFE_SHELL_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function refuse(code: string, detail: string): FleetGuardBlock {
	return { block: true, reason: `fleet-guard write-ownership (${code}): ${detail}; no files were changed.` };
}

function home(): string | undefined {
	const value = process.env.HOME;
	return value && isAbsolute(value) ? value : undefined;
}

// Deterministic leading expansions: `~`, `~/…`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}`.
function leadingExpansion(text: string, base: string | undefined): string {
	const homeDir = home();
	for (const [prefix, value] of [["~", homeDir], ["$HOME", homeDir], ["${HOME}", homeDir], ["$PWD", base], ["${PWD}", base]] as const) {
		if (value !== undefined && (text === prefix || text.startsWith(`${prefix}/`))) return value + text.slice(prefix.length);
	}
	return text;
}

function expansionIndex(text: string): number {
	for (let index = 0; index < text.length; index++) {
		if ("$`*?[~".includes(text[index]!)) return index;
	}
	return -1;
}

/** The judged path of one shell word, or undefined when the shell decides it from state this pass cannot see. */
function wordCandidate(word: ShellWord, base: string | undefined): Candidate | undefined {
	const text = word.expanded ? leadingExpansion(word.text, base) : word.text;
	const cut = word.expanded ? expansionIndex(text) : -1;
	if (cut < 0) {
		if (!isAbsolute(text) && base === undefined) return undefined;
		return { path: resolve(base ?? "/", text), spelled: word.text, scope: "file" };
	}
	if (cut === 0) return undefined;
	const slash = text.lastIndexOf("/", cut - 1);
	const directory = slash < 0 ? "." : text.slice(0, slash) || "/";
	if (!isAbsolute(directory) && base === undefined) return undefined;
	return { path: resolve(base ?? "/", directory), spelled: word.text, scope: "children" };
}

function isDirectory(word: ShellWord, base: string | undefined): boolean {
	if (word.expanded || (base === undefined && !isAbsolute(word.text))) return false;
	try { return statSync(resolve(base ?? "/", word.text)).isDirectory(); }
	catch { return false; }
}

function intoDirectory(directory: ShellWord, source: ShellWord): ShellWord {
	let end = source.text.length;
	while (end > 1 && source.text[end - 1] === "/") end--;
	const trimmed = source.text.slice(0, end);
	const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	const joined = directory.text.endsWith("/") ? `${directory.text}${name}` : `${directory.text}/${name}`;
	return { text: joined, expanded: directory.expanded || source.expanded };
}

// cp/mv/install: destinations (`-t DIR`, last operand, or DIR/basename per source) and, for mv, the removed sources.
function copyTargets(name: string, argv: readonly ShellWord[], base: string | undefined): ShellWord[] {
	const program = name.startsWith("g") ? name.slice(1) : name;
	const valueLetters = program === "install" ? "tSmogBf" : "tS";
	let targetDirectory: ShellWord | undefined;
	let noTargetDirectory = false;
	let directories = false;
	const operands: ShellWord[] = [];
	for (let index = 1; index < argv.length; index++) {
		const word = argv[index]!;
		const text = word.text;
		if (text === "--") { operands.push(...argv.slice(index + 1)); break; }
		if (text.startsWith("--")) {
			if (text === "--target-directory") targetDirectory = argv[++index];
			else if (text.startsWith("--target-directory=")) targetDirectory = { text: text.slice("--target-directory=".length), expanded: word.expanded };
			else if (text === "--no-target-directory") noTargetDirectory = true;
			else if (text === "--directory") directories = true;
			else if (["--suffix", "--mode", "--owner", "--group"].includes(text)) index++;
			continue;
		}
		if (text.startsWith("-") && text.length > 1) {
			for (let letter = 1; letter < text.length; letter++) {
				const flag = text[letter]!;
				if (flag === "T" && program !== "install") noTargetDirectory = true;
				if (flag === "d" && program === "install") directories = true;
				if (valueLetters.includes(flag)) {
					const rest = text.slice(letter + 1);
					const value = rest ? { text: rest, expanded: word.expanded } : argv[++index];
					if (flag === "t") targetDirectory = value;
					break;
				}
			}
			continue;
		}
		operands.push(word);
	}
	if (directories) return operands;
	const sources = targetDirectory ? operands : operands.slice(0, -1);
	const destination = targetDirectory ?? operands.at(-1);
	if (!destination || sources.length === 0) return [];
	const written = program === "mv" ? [...sources] : [];
	const into = targetDirectory !== undefined ||
		(!noTargetDirectory && (sources.length > 1 || destination.text.endsWith("/") || isDirectory(destination, base)));
	if (!into) written.push(destination);
	else for (const source of sources) written.push(intoDirectory(destination, source));
	return written;
}

function teeTargets(argv: readonly ShellWord[]): ShellWord[] {
	const files: ShellWord[] = [];
	let options = true;
	for (const word of argv.slice(1)) {
		if (options && word.text === "--") { options = false; continue; }
		if (options && word.text.startsWith("-") && word.text.length > 1) continue;
		files.push(word);
	}
	return files;
}

// `sed -i` (GNU `-i[SUFFIX]`, `--in-place[=SUFFIX]`; BSD `-i SUFFIX` with an empty or dotted suffix word): the file
// operands after the script (every operand when -e/-f supplied the script).
function sedTargets(argv: readonly ShellWord[]): ShellWord[] {
	let inPlace = false;
	let scriptGiven = false;
	const operands: ShellWord[] = [];
	for (let index = 1; index < argv.length; index++) {
		const text = argv[index]!.text;
		if (text === "--") { operands.push(...argv.slice(index + 1)); break; }
		if (text === "--in-place" || text.startsWith("--in-place=")) { inPlace = true; continue; }
		if (text === "--expression" || text === "--file") { scriptGiven = true; index++; continue; }
		if (text.startsWith("--expression=") || text.startsWith("--file=")) { scriptGiven = true; continue; }
		if (text.startsWith("--")) continue;
		if (text.startsWith("-") && text.length > 1) {
			for (let letter = 1; letter < text.length; letter++) {
				const flag = text[letter]!;
				const attached = text.slice(letter + 1) !== "";
				if (flag === "i") {
					inPlace = true;
					const next = argv[index + 1]?.text;
					if (!attached && next !== undefined && (next === "" || next.startsWith("."))) index++;
					break;
				}
				if (flag === "e" || flag === "f" || flag === "l") {
					if (flag !== "l") scriptGiven = true;
					if (!attached) index++;
					break;
				}
			}
			continue;
		}
		operands.push(argv[index]!);
	}
	if (!inPlace) return [];
	return scriptGiven ? operands : operands.slice(1);
}

const STAGE_ALL_FLAGS = new Set(["-A", "--all", "--no-ignore-removal", "-u", "--update", "--renormalize", "-i", "--interactive", "-p", "--patch", "-e", "--edit"]);

// `git add`/`git stage`: each pathspec is judged as a path; staging with no pathspec, a pathspec file, magic
// (`:/`, `:(…)`), or a pathspec this pass cannot resolve is unscoped staging of the checkout.
function gitAddCandidates(argv: readonly ShellWord[], base: string | undefined): Candidate[] {
	let gitBase = base;
	let index = 1;
	while (index < argv.length) {
		const word = argv[index]!;
		if (word.text === "-C") {
			const directory = argv[index + 1];
			if (!directory) return [];
			const text = directory.expanded ? leadingExpansion(directory.text, gitBase) : directory.text;
			gitBase = (directory.expanded && expansionIndex(text) >= 0) || (gitBase === undefined && !isAbsolute(text)) ? undefined : resolve(gitBase ?? "/", text);
			index += 2;
			continue;
		}
		if (["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(word.text)) { index += 2; continue; }
		if (!word.text.startsWith("-")) break;
		index++;
	}
	const subcommand = argv[index]?.text;
	if (subcommand !== "add" && subcommand !== "stage") return [];
	const spelled = argv.map((word) => word.text).join(" ");
	if (gitBase === undefined) return [];
	const blanket: Candidate = { path: gitBase, spelled, scope: "blanket" };
	const pathspecs: ShellWord[] = [];
	for (index++; index < argv.length; index++) {
		const word = argv[index]!;
		const text = word.text;
		if (text === "--") { pathspecs.push(...argv.slice(index + 1)); break; }
		if (text === "-n" || text === "--dry-run") return [];
		if (text.startsWith("--pathspec-from-file")) return [blanket];
		if (text === "--chmod") { index++; continue; }
		if (STAGE_ALL_FLAGS.has(text) || text.startsWith("-")) {
			if (!text.startsWith("--") && text.length > 1 && text.slice(1).includes("n")) return [];
			continue;
		}
		pathspecs.push(word);
	}
	if (pathspecs.length === 0) return [blanket];
	const candidates: Candidate[] = [];
	for (const word of pathspecs) {
		if (word.text.startsWith(":")) return [blanket];
		// A quoted glob is a git pathspec pattern: judge the directory its literal prefix names.
		const pattern = !word.expanded && ["*", "?", "["].some((glob) => word.text.includes(glob));
		const candidate = wordCandidate(pattern ? { text: word.text, expanded: true } : word, gitBase);
		if (!candidate) return [{ path: gitBase, spelled: word.text, scope: "unresolved" }];
		candidates.push(candidate);
	}
	return candidates;
}

// `cd`/`pushd` with a literal operand moves the base; a computed one (or `-`, `popd`) makes it unknown.
function changedDirectory(argv: readonly ShellWord[], base: string | undefined): string | undefined {
	const operand = argv.slice(1).find((word) => !(word.text.startsWith("-") && word.text.length > 1));
	if (!operand) return home();
	if (operand.text === "-") return undefined;
	const text = operand.expanded ? leadingExpansion(operand.text, base) : operand.text;
	if (operand.expanded && expansionIndex(text) >= 0) return undefined;
	if (!isAbsolute(text) && base === undefined) return undefined;
	return resolve(base ?? "/", text);
}

function shellCandidates(inspection: ShellInspection, cwd: string): Candidate[] {
	const candidates: Candidate[] = [];
	const add = (word: ShellWord, base: string | undefined): void => {
		const candidate = wordCandidate(word, base);
		if (candidate) candidates.push(candidate);
	};
	let base: string | undefined = cwd;
	for (let at = 0; at <= inspection.commands.length; at++) {
		for (const write of inspection.writes) if (write.at === at) add(write.target, base);
		const executed = inspection.commands[at];
		if (!executed) break;
		const { argv } = executed;
		const name = commandName(argv[0]!.text);
		if (name === "cd" || name === "pushd") base = changedDirectory(argv, base);
		else if (name === "popd") base = undefined;
		else if (COPIERS.has(name)) for (const word of copyTargets(name, argv, base)) add(word, base);
		else if (name === "tee") for (const word of teeTargets(argv)) add(word, base);
		else if (name === "sed" || name === "gsed") for (const word of sedTargets(argv)) add(word, base);
		else if (name === "git") candidates.push(...gitAddCandidates(argv, base));
	}
	return candidates;
}

interface Judged { candidate: Candidate; rel: string; probe: string }

async function judge(candidates: readonly Candidate[], context: WriteOwnContext): Promise<FleetGuardBlock | undefined> {
	const byRoot = new Map<string, Judged[]>();
	const policies = new Map<string, FleetPolicyVerdict>();
	for (const candidate of candidates) {
		let physical: string;
		try { physical = await physicalTarget(candidate.path); }
		catch (error) { return refuse("WRITE_OWN_UNRESOLVED", `cannot resolve write target ${candidate.spelled} (${String(error)})`); }
		const root = repositoryRoot(physical);
		if (!root) continue;
		const rel = relative(root, physical).split(sep).join("/");
		if (rel === SCRATCH || rel.startsWith(`${SCRATCH}/`) || rel.startsWith("../") || rel === "..") continue;
		let policy = policies.get(root);
		if (!policy) {
			policy = await context.fleetPolicy(root);
			policies.set(root, policy);
		}
		if (policy.kind === "off") continue;
		if (policy.kind === "unavailable") return refuse("WRITE_OWN_POLICY_UNAVAILABLE", `${policy.reason ?? "fleet policy unreadable"} at ${root}`);
		if (candidate.scope === "unresolved") {
			return refuse("WRITE_OWN_UNRESOLVED_PATHSPEC", `git add pathspec ${candidate.spelled} in the canonical checkout ${root} is spelled through a variable this guard cannot resolve; name the reserved paths literally (git commit --only requires literal reserved paths too)`);
		}
		if (candidate.scope === "blanket" || rel === "") {
			return refuse("WRITE_OWN_BLANKET_ADD", `\`${candidate.spelled}\` stages without naming reserved paths in the canonical checkout ${root}; stage only inside \`git commit --only -m <msg> -- <reserved paths>\``);
		}
		const probe = candidate.scope === "children" ? `${rel}/${CHILD_PROBE}` : rel;
		byRoot.set(root, [...byRoot.get(root) ?? [], { candidate, rel, probe }]);
	}
	for (const [root, judged] of byRoot) {
		const gaps = reservationGaps(root, judged.map((entry) => entry.probe), context.agentName);
		const first = judged[0]!;
		const shown = (entry: Judged): string => entry.candidate.scope === "children" ? `${entry.rel}/*` : entry.rel;
		if (gaps.kind === "identity") {
			return refuse("WRITE_OWN_NO_IDENTITY", `writing ${first.candidate.spelled} (${shown(first)} in the canonical checkout ${root}) needs an identified caller holding an exclusive reservation; set AGENT_NAME to your Agent Mail identity and reserve it: \`am file_reservations reserve ${quote(root)} <AGENT_NAME> ${quote(shown(first))} --exclusive --reason <bead>\`, ${EXPORT_ROUTE}`);
		}
		if (gaps.kind === "unavailable") {
			return refuse("WRITE_OWN_LOOKUP_UNAVAILABLE", `the reservation lookup \`am robot reservations --project ${quote(root)} --agent ${quote(gaps.agent)} --json\` failed or was not attested current, so ${shown(first)} in the canonical checkout ${root} cannot be proven reserved; restore Agent Mail reservation reads before writing`);
		}
		const missing = judged.find((entry) => gaps.uncovered.includes(entry.probe));
		if (missing) {
			const path = quote(shown(missing));
			return refuse("WRITE_OWN_UNRESERVED", `${missing.candidate.spelled} is ${shown(missing)} in the canonical checkout ${root}, and ${gaps.agent} holds no live exclusive Agent Mail reservation covering it. Reserve it first: \`am file_reservations reserve ${quote(root)} ${quote(gaps.agent)} ${path} --exclusive --reason <bead>\` (MCP file_reservation_paths project_key=${JSON.stringify(root)} agent_name=${JSON.stringify(gaps.agent)} paths=[${JSON.stringify(shown(missing))}] exclusive=true), ${EXPORT_ROUTE}`);
		}
	}
	return undefined;
}

export async function check(event: FleetGuardEvent, context: WriteOwnContext): Promise<FleetGuardBlock | undefined> {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const cwd = resolve(context.cwd ?? (typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd()));
	const candidates: Candidate[] = [];
	if (tool === "write" || tool === "edit") {
		try {
			for (const entry of await targets(event)) {
				if (entry.path.toLowerCase().startsWith("ssh://")) continue;
				const path = resolveFilesystemWriteTarget(cwd, entry.path, context);
				if (path !== undefined) candidates.push({ path, spelled: entry.path, scope: "file" });
			}
		} catch (error) {
			return refuse("WRITE_OWN_UNRESOLVED", `write targets cannot be established from this payload (${error instanceof Error ? error.message : String(error)})`);
		}
	} else if (tool === "bash") {
		const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
		if (!command) return undefined;
		const inspection = executedShellCommands(command);
		if ("refusal" in inspection) return { block: true, reason: inspection.refusal };
		candidates.push(...shellCandidates(inspection, cwd));
	} else return undefined;
	return candidates.length === 0 ? undefined : judge(candidates, context);
}

export default check;
