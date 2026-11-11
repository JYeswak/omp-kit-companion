import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runSync } from "../kitlib/run.ts";
import { physicalTarget, targets } from "./durability.ts";
import { commandFromEvent, commandName, executedShellCommands, privateCheckout, repositoryRoot, reservationGaps, type ReservationGaps, type ShellInspection, type ShellWord } from "./git.ts";
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
 *
 * WRITEOWNCHILD1 (ompkit-1ra0d.126): a native task child writes under its parent seat's custody. The seat is the
 * caller's AGENT_NAME (never the child's spawn-minted name); the child's own exclusive holds add cover without
 * renaming the owner. A path nobody holds is not refused: the guard reserves it for the seat itself (exclusive,
 * ttl 3600 s per the kit's reservation TTL convention, reason naming the seat's held bead else `auto: first write`),
 * says so in one line, and admits the write. A granted reserve that still reports a conflict, or that the
 * attested re-read does not confirm, refuses instead. Only a path another agent exclusively holds is refused,
 * naming the holder. `agent not found` naming the queried agent is an answer (zero holds), never a lookup outage.
 */

/** Fleet opt-in state of a repository root (extensions/fleet-policy.ts fleetPolicyState). */
export interface FleetPolicyVerdict { kind: "on" | "off" | "unavailable"; root: string; reason?: string }

export interface WriteOwnContext extends FleetGuardContext {
	fleetPolicy: (directory: string) => Promise<FleetPolicyVerdict>;
	/** NATIVEPREGRADE1 (ompkit-1ra0d.41) + WRITEOWNCHILD1: a native task child's own spawn-minted, registered name
	 * (extensions/native-identity.ts, minted at before_subagent_spawn). Its exclusive holds cover its writes; custody
	 * stays the seat's (AGENT_NAME), so the seat may reserve on the child's behalf and first writes auto-reserve. */
	childAgentName?: string;
}

/**
 * `file`: the path itself; `children`: some file directly or deeper under the directory; `blanket`: unscoped staging
 * there; `unresolved`: a `git add` pathspec spelled through a variable, judged where the checkout is (`path`).
 */
interface Candidate { path: string; spelled: string; scope: "file" | "children" | "blanket" | "unresolved" }

const SCRATCH = "var/agent-tmp";
/** OMP-internal routes (out://, local://, cfg://, agent://, artifact://, skill://, xd://, proc://, history://, mcp://, ssh://): never filesystem writes in any repository. */
const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//;
const CHILD_PROBE = "\0";
const SAFE_SHELL_WORD = /^[A-Za-z0-9_./@%+=:,-]+$/;
const COPIERS = new Set(["cp", "mv", "install", "gcp", "gmv", "ginstall"]);
const EXPORT_ROUTE = "or develop in an exact-commit export under var/agent-tmp/ (`omp-kit scratch new --export <sha>`; use data.exportDir for source, data.dir for TMPDIR and release)";

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

/** WRITEOWNCHILD1 (a): custody belongs to the parent seat. The seat's name is the caller's AGENT_NAME
 * (context.agentName, else the given environment); a native child's spawn-minted name never is, so a
 * caller that passes only the child's name falls back to the seat. MAILGUARDSLIM1 reuses this for a
 * child's Agent Mail reservation rewrite: no second seat resolution. */
export function seatIdentity(context: { agentName?: string; childAgentName?: string }, env: Record<string, string | undefined> = process.env): string | undefined {
	if (context.agentName !== undefined && context.agentName !== context.childAgentName) return context.agentName;
	const seat = env.AGENT_NAME;
	return seat !== undefined && seat.trim() !== "" ? seat.trim() : undefined;
}

function say(context: WriteOwnContext, message: string): void {
	if (context.warn) context.warn(message);
	else console.warn(message);
}

const RUN_OUTPUT_CAP = 64 * 1024;
const RESERVE_DEADLINE_S = 30;
const REASON_DEADLINE_S = 10;
/** Lease length of an automatic reserve: the kit's existing reservation TTL convention (the `am
 * file_reservations reserve` CLI default and the `custody check --reserve` default, both 3600 s). */
const RESERVE_TTL_S = 3600;

/** The live process environment as strings: runSync resolves its binary through the passed env. */
function currentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return env;
}

/** One owned (in_progress/rework) bead id assigned to the seat, read bounded from the target tracker's `br list`;
 * undefined when the read fails or the seat holds no bead, and the reserve reason falls back. */
function heldBead(root: string, seat: string): string | undefined {
	let result;
	try {
		// Bun resolves the binary through options.env, not the live process environment, so hand the
		// current environment over explicitly; a runtime PATH shim (like the tests') must win.
		result = runSync(["br", "list", "--assignee", seat, "--json", "--no-auto-import", "--no-auto-flush"],
			{ deadline_s: REASON_DEADLINE_S, max_output_bytes: RUN_OUTPUT_CAP, cwd: root, env: currentEnv() });
	} catch { return undefined; }
	if (result.rc !== 0 || result.timed_out) return undefined;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
		const rows: unknown = Array.isArray(parsed) ? parsed
			: (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).issues)
				? (parsed as Record<string, unknown>).issues : undefined);
		if (!Array.isArray(rows)) return undefined;
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const entry = row as Record<string, unknown>;
			if ((entry.status === "in_progress" || entry.status === "rework")
				&& typeof entry.assignee === "string" && entry.assignee.toLowerCase() === seat.toLowerCase()
				&& typeof entry.id === "string" && entry.id !== "") return entry.id;
		}
	} catch { return undefined; }
	return undefined;
}

/** Refusal naming the live foreign holder: two writers on one file is the one hazard that keeps a write refused. */
function heldRefusal(root: string, agent: string, entry: Judged, holder: string, shown: (entry: Judged) => string): FleetGuardBlock {
	return refuse("WRITE_OWN_UNRESERVED", `${entry.candidate.spelled} is ${shown(entry)} in the canonical checkout ${root}, which ${holder} holds under a live exclusive Agent Mail reservation; ask ${holder} to release or hand it over. ${agent} holds no live exclusive reservation covering it, so the write is refused; no files were changed. ${EXPORT_ROUTE}`);
}

/** WRITEOWNCHILD1 (b): reserve the free paths for the seat itself, exclusive, at the kit's reservation TTL. The
 * granted answer's body comes back too, so a conflict the exit code hides still fails the write. */
function reserveForSeat(root: string, seat: string, paths: readonly string[], reason: string): { ok: true; body: string } | { ok: false; why: string } {
	let result;
	try {
		result = runSync(["am", "file_reservations", "reserve", root, seat, ...paths, "--exclusive", "--ttl", String(RESERVE_TTL_S), "--reason", reason],
			{ deadline_s: RESERVE_DEADLINE_S, max_output_bytes: RUN_OUTPUT_CAP, env: currentEnv() });
	} catch (error) {
		return { ok: false, why: `am file_reservations reserve could not run (${error instanceof Error ? error.message : String(error)})` };
	}
	if (result.timed_out) return { ok: false, why: "am file_reservations reserve did not answer within 30 s" };
	if (result.rc !== 0) {
		const detail = new TextDecoder().decode(result.stderr).trim().split("\n")[0]?.trim() ?? "";
		return { ok: false, why: `am file_reservations reserve exited ${result.rc}${detail !== "" ? `: ${detail.slice(0, 200)}` : ""}` };
	}
	return { ok: true, body: new TextDecoder().decode(result.stdout) };
}

/** The granted reserve answer, read for real: the real success body is JSON with `granted` rows and a `conflicts`
 * array (lead-captured sample var/agent-tmp/am-reserve-success-sample.json). A non-empty `conflicts` array is an
 * explicit conflict and fails at once. A grant that does not cover every requested path counts as not taken, but
 * never admits on its own: the attested re-read below still decides admission. Anything that is not this JSON
 * shape falls back to the text tripwire (an explicit `conflict(s) found:` or a bare `conflict` not negated by
 * `no conflict`), because older or foreign output cannot be judged structurally. */
type GrantCheck =
	| { status: "conflict"; why: string }
	| { status: "complete" }
	| { status: "short"; missing: string[] };
function checkReserveGrant(body: string, paths: readonly string[]): GrantCheck {
	let parsed: unknown;
	try { parsed = JSON.parse(body); }
	catch {
		const text = body.toLowerCase();
		if (text.includes("conflict(s) found:") || (text.includes("conflict") && !text.includes("no conflict")))
			return { status: "conflict", why: body.trim().split("\n")[0]?.trim() ?? body.trim() };
		return { status: "complete" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "complete" };
	const record = parsed as Record<string, unknown>;
	const conflicts = record.conflicts;
	if (Array.isArray(conflicts) && conflicts.length > 0) {
		const first: unknown = conflicts[0];
		let detail: string | undefined;
		if (typeof first === "string") detail = first;
		else {
			try { detail = JSON.stringify(first); } catch { detail = undefined; }
		}
		if (detail === undefined || detail === "") detail = "a conflicting hold";
		return { status: "conflict", why: detail.slice(0, 200) };
	}
	const granted = record.granted;
	if (!Array.isArray(granted)) return { status: "complete" };
	const patterns: string[] = [];
	for (const entry of granted) {
		if (typeof entry === "string") { patterns.push(entry); continue; }
		if (entry !== null && typeof entry === "object") {
			const pattern = (entry as Record<string, unknown>).path_pattern ?? (entry as Record<string, unknown>).path;
			if (typeof pattern === "string") patterns.push(pattern);
		}
	}
	const missing = paths.filter((path) => !patterns.includes(path));
	return missing.length === 0 ? { status: "complete" } : { status: "short", missing };
}
async function judge(candidates: readonly Candidate[], context: WriteOwnContext): Promise<FleetGuardBlock | undefined> {
	const byRoot = new Map<string, Judged[]>();
	const policies = new Map<string, FleetPolicyVerdict>();
	const callingRoot = repositoryRoot(resolve(context.cwd ?? process.cwd()));
	for (const candidate of candidates) {
		if (INTERNAL_URL.test(candidate.spelled)) continue;
		let physical: string;
		try { physical = await physicalTarget(candidate.path); }
		catch (error) { return refuse("WRITE_OWN_UNRESOLVED", `cannot resolve write target ${candidate.spelled} (${String(error)})`); }
		const root = repositoryRoot(physical);
		if (!root || privateCheckout(root)) continue;
		// A fixture repository created inside owned scratch (its own git init beneath var/agent-tmp) is scratch,
		// not a canonical checkout: a root inside the calling repository's var/agent-tmp is skipped like scratch
		// itself. The calling repository bounds the skip so a simulated canonical checkout nested under another
		// checkout's scratch is still judged as canonical.
		if (callingRoot !== undefined) {
			let outer: string | undefined = repositoryRoot(dirname(root));
			while (outer !== undefined && outer !== callingRoot) outer = repositoryRoot(dirname(outer));
			if (outer !== undefined) {
				const outerRel = relative(callingRoot, root).split(sep).join("/");
				if (outerRel === SCRATCH || outerRel.startsWith(`${SCRATCH}/`)) continue;
			}
		}
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
		const seat = seatIdentity(context);
		const primary = seat ?? context.childAgentName;
		let gaps: ReservationGaps = primary === undefined ? { kind: "identity" }
			: reservationGaps(root, judged.map((entry) => entry.probe), primary);
		const first = judged[0]!;
		const shown = (entry: Judged): string => entry.candidate.scope === "children" ? `${entry.rel}/*` : entry.rel;
		if (gaps.kind === "identity") {
			return refuse("WRITE_OWN_NO_IDENTITY", `writing ${first.candidate.spelled} (${shown(first)} in the canonical checkout ${root}) needs an identified caller holding an exclusive reservation; set AGENT_NAME to your Agent Mail identity and reserve it: \`am file_reservations reserve ${quote(root)} <AGENT_NAME> ${quote(shown(first))} --exclusive --reason <bead>\`, ${EXPORT_ROUTE}`);
		}
		if (gaps.kind === "unavailable") {
			return refuse("WRITE_OWN_LOOKUP_UNAVAILABLE", `the reservation lookup \`am robot reservations --project ${quote(root)} --agent ${quote(gaps.agent)} --json\` failed: ${gaps.why}; so ${shown(first)} in the canonical checkout ${root} cannot be proven reserved; restore Agent Mail reservation reads before writing`);
		}
		if (seat !== undefined && context.childAgentName !== undefined && gaps.kind === "checked" && gaps.uncovered.length > 0) {
			// The child's own exclusive holds add cover without renaming the owner: custody stays the seat's.
			// Foreign holders from BOTH reads union over the original uncovered set first: a live foreign hold
			// is a hard stop even where the child holds cover. A failing child read never moves the seat's
			// verdict (an unknown spawn name already reads as zero holds at the read).
			const own = reservationGaps(root, gaps.uncovered, context.childAgentName);
			if (own.kind === "checked") {
				const holders = new Map<string, string>();
				for (const entry of [...gaps.foreign, ...own.foreign])
					if (gaps.uncovered.includes(entry.path) && !holders.has(entry.path)) holders.set(entry.path, entry.holder);
				const stopped = judged.find((entry) => holders.has(entry.probe));
				if (stopped !== undefined) return heldRefusal(root, gaps.agent, stopped, holders.get(stopped.probe) ?? "another agent", shown);
				const still = new Set(own.uncovered);
				gaps = { kind: "checked", agent: gaps.agent, uncovered: own.uncovered,
					foreign: [...gaps.foreign, ...own.foreign].filter((entry) => still.has(entry.path)) };
			}
		}
		// Before reserving anything: any uncovered probe with a live foreign holder refuses, whichever
		// candidate named it first. One call can never reserve a free path alongside a foreign-held one.
		const uncovered = gaps.uncovered;
		const foreign = gaps.foreign;
		const stopped = judged.find((entry) => uncovered.includes(entry.probe)
			&& foreign.some((other) => other.path === entry.probe));
		if (stopped !== undefined) {
			const holder = foreign.find((entry) => entry.path === stopped.probe)?.holder ?? "another agent";
			return heldRefusal(root, gaps.agent, stopped, holder, shown);
		}
		const missing = judged.find((entry) => uncovered.includes(entry.probe));
		if (!missing) continue;
		// No one holds these paths, so the guard completes the act instead of refusing it: one exclusive
		// reserve for the seat, one line saying so, and the write is admitted.
		const freeEntries = uncovered
			.filter((probe) => !foreign.some((entry) => entry.path === probe))
			.map((probe) => judged.find((entry) => entry.probe === probe))
			.filter((entry) => entry !== undefined);
		const free = [...new Set(freeEntries.map((entry) => shown(entry)))];
		const freeProbes = freeEntries.map((entry) => entry.probe);
		const reason = heldBead(root, gaps.agent) ?? "auto: first write";
		const reserved = reserveForSeat(root, gaps.agent, free.length > 0 ? free : [shown(missing)], reason);
		if (!reserved.ok) {
			const path = quote(shown(missing));
			return refuse("WRITE_OWN_UNRESERVED", `${missing.candidate.spelled} is ${shown(missing)} in the canonical checkout ${root}, and ${gaps.agent} holds no live exclusive Agent Mail reservation covering it. The guard's automatic reserve failed (${reserved.why}); reserve it first: \`am file_reservations reserve ${quote(root)} ${quote(gaps.agent)} ${path} --exclusive --reason <bead>\` (MCP file_reservation_paths project_key=${JSON.stringify(root)} agent_name=${JSON.stringify(gaps.agent)} paths=[${JSON.stringify(shown(missing))}] exclusive=true), ${EXPORT_ROUTE}`);
		}
		const grant = checkReserveGrant(reserved.body, free.length > 0 ? free : [shown(missing)]);
		if (grant.status === "conflict") {
			return refuse("WRITE_OWN_UNRESERVED", `${missing.candidate.spelled} is ${shown(missing)} in the canonical checkout ${root}, and ${gaps.agent} holds no live exclusive Agent Mail reservation covering it. The guard's automatic reserve reported a conflict (${grant.why}); ask the holder to release or hand it over, no files were changed. ${EXPORT_ROUTE}`);
		}
		// The reserve answered without an explicit conflict, but only the attested re-read proves the grant stuck:
		// a lost race or a partial grant still refuses instead of admitting.
		const verify = reservationGaps(root, freeProbes.length > 0 ? freeProbes : [missing.probe], gaps.agent);
		if (verify.kind === "unavailable") {
			return refuse("WRITE_OWN_LOOKUP_UNAVAILABLE", `the post-reserve reservation re-read \`am robot reservations --project ${quote(root)} --agent ${quote(gaps.agent)} --json\` failed: ${verify.why}; so ${shown(missing)} in the canonical checkout ${root} cannot be proven reserved; restore Agent Mail reservation reads before writing`);
		}
		const stillOpen = verify.kind === "checked" ? verify.uncovered : freeProbes;
		if (stillOpen.length > 0) {
			const entry = freeEntries.find((candidate) => stillOpen.includes(candidate.probe)) ?? missing;
			const holder = verify.kind === "checked" ? verify.foreign.find((other) => other.path === entry.probe)?.holder : undefined;
			if (holder !== undefined) return heldRefusal(root, gaps.agent, entry, holder, shown);
			const short = grant.status === "short" ? ` the grant covered [${free.filter((path) => !grant.missing.includes(path)).join(", ")}] but not ${grant.missing.join(",")}` : "";
			return refuse("WRITE_OWN_UNRESERVED", `${entry.candidate.spelled} is ${shown(entry)} in the canonical checkout ${root}, and ${gaps.agent} holds no live exclusive Agent Mail reservation covering it. The guard's automatic reserve did not take${short}; reserve it first: \`am file_reservations reserve ${quote(root)} ${quote(gaps.agent)} ${quote(shown(entry))} --exclusive --reason <bead>\`, ${EXPORT_ROUTE}`);
		}
		say(context, `fleet-guard write-ownership: auto-reserved ${free.length > 0 ? free.join(", ") : shown(missing)} in ${root} for ${gaps.agent} (exclusive, ttl ${RESERVE_TTL_S}s, reason ${reason}); the write is admitted.`);
	}
	return undefined;
}

export async function check(event: FleetGuardEvent, context: WriteOwnContext): Promise<FleetGuardBlock | undefined> {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const inputCwd = tool === "bash" && event.input && typeof event.input === "object"
		? (event.input as Record<string, unknown>).cwd : undefined;
	const cwd = resolve(typeof inputCwd === "string" && inputCwd
		? resolve(context.cwd ?? process.cwd(), inputCwd)
		: context.cwd ?? (typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd()));
	const candidates: Candidate[] = [];
	if (tool === "write" || tool === "edit") {
		try {
			for (const entry of await targets(event)) {
				if (INTERNAL_URL.test(entry.path)) continue;
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
