// readme-check.ts -- README currency gate (fresh-gate step `readme`, CI).
//
// README.md went stale for 87 commits because nothing checked it. This gate makes staleness a RED:
//   1. Every top-level command and every `doctor --scope` value in the COMMANDS registry
//      (src/commands.ts, imported -- never grepped) appears in README.md's `## Command reference`
//      as `omp-kit <command>` / `--scope <value>`.
//   2. README.md pins no release version: no `vX.Y.Z` / `X.Y.Z` / `KIT_VERSION=X.Y.Z` outside the
//      generated OMP footer (scripts/docs-footer.sh owns that block) and the generated release
//      line (`<!-- kit-release:start --> … `Current release: vX.Y.Z`, stamped via
//      scripts/stamp-release-line.sh). The line states the latest published release: it equals the
//      package.json version, or (NEXTVERSION1, ompkit-d8qic: main states the version it will ship
//      as) package.json is exactly its next patch and tag vX.Y.Z exists in the repo (--repo, default
//      the working directory); unreadable tags fail closed with a named finding.
//      Install snippets resolve the latest release at run time.
//   3. The readme-update gate (skill readme-update, --profile product) passes when it is installed;
//      the repo's own structural checks always run (CI has no skills directory).
//
// Applicability (README APPLY1, ompkit-v66l.22.3). The staged-readme hook runs this checker in any repo with a README
// obligation (check-staged-readme.sh: README.md or scripts/readme-check.ts in the index or HEAD), and CFS's README is
// not omp-kit's. So each rule runs only where the tree declares its inputs:
//   - a repo shipping its own scripts/readme-check.ts declares the whole kit README policy: every rule runs and every
//     input is required (a missing registry, rules/ or package.json fails exactly as before);
//   - otherwise rule 1 and the command/scope counts need src/commands.ts (or --registry); rule 2 needs the README's
//     kit-release markers or scripts/stamp-release-line.sh; rules/extensions/skills counts need rules/, package.json
//     omp.extensions and skills/; the Limitations / About Contributions / License-last sections need the kit policy;
//   - worklog headings, task checkboxes and the readme-update gate (rule 3) judge every README.
// A rule whose input is not declared prints one `NOT_APPLICABLE <rule>: <missing input>` line; it never passes silently.
//
// Usage: bun scripts/readme-check.ts [--root DIR] [--readme PATH] [--registry PATH] [--repo DIR] [--no-readme-gate]
// Exit 0 GREEN, 1 RED (each finding named), 2 usage or unreadable input.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const FOOTER_START = "<!-- verified-ttsr-docs:start -->";
const FOOTER_END = "<!-- verified-ttsr-docs:end -->";
/** Generated release line the train stamps at tag time (scripts/stamp-release-line.sh owns this block). */
export const RELEASE_START = "<!-- kit-release:start -->";
export const RELEASE_END = "<!-- kit-release:end -->";
/** A release-shaped version triple not embedded in a longer dotted or word token (127.0.0.1 is not one). */
export const VERSION_LITERAL = /(?<![\w.-])v?(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?!\.?\d)/g;
/** readme-update forbids worklog headings (W1-W3); mirrored here for runs without the skill. */
const WORKLOG_HEADING = /^#{1,6}[ \t]+(?:changelog|release notes|what'?s new|recent(?:ly)?|new in|updates|latest|todo|this session|built today|worklog)\b/i;

type Registry = { commands: string[]; scopes: string[] };
/** Whether tag v<README release-line version> exists; "unreadable" when tags cannot be listed (fails closed). */
export type ReleaseTag = "present" | "absent" | "unreadable";
/** Shipped inventory the README may count: rules/*.md, package.json omp.extensions, skills/<name>/SKILL.md; null when the tree declares no such inventory. */
type Inventory = { rules: number | null; extensions: number | null; skills: number | null };

/** Under the kit policy every inventory input is required (a missing rules/ or package.json throws, as before). */
function loadInventory(root: string, kitPolicy: boolean): Inventory {
	const rulesDir = join(root, "rules"), skillsDir = join(root, "skills"), manifestPath = join(root, "package.json");
	const rules = kitPolicy || existsSync(rulesDir) ? readdirSync(rulesDir).filter(name => name.endsWith(".md")).length : null;
	let extensions: number | null = null;
	if (kitPolicy || existsSync(manifestPath)) {
		let manifest: unknown;
		try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
		catch (error) { if (kitPolicy) throw error; }
		const omp = manifest && typeof manifest === "object" && "omp" in manifest ? manifest.omp : undefined;
		const declared = omp && typeof omp === "object" && "extensions" in omp && Array.isArray(omp.extensions) ? omp.extensions.length : null;
		extensions = declared ?? (kitPolicy ? 0 : null);
	}
	const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter(name => existsSync(join(skillsDir, name, "SKILL.md"))).length
		: kitPolicy ? 0 : null;
	return { rules, extensions, skills };
}

function usage(message: string): never {
	console.error(`readme-check: ${message}`);
	console.error("usage: bun scripts/readme-check.ts [--root DIR] [--readme PATH] [--registry PATH] [--no-readme-gate]");
	process.exit(2);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadRegistry(path: string): Promise<Registry> {
	// Runtime-selected: --registry points tests (and doc-drift style checks) at a planted copy.
	const module: unknown = await import(path);
	const commands = module && typeof module === "object" && "COMMANDS" in module ? module.COMMANDS : undefined;
	if (!Array.isArray(commands)) usage(`${path} exports no COMMANDS array`);
	const names: string[] = [];
	let scopeValue: unknown;
	for (const command of commands) {
		if (!command || typeof command !== "object" || !("name" in command) || typeof command.name !== "string") usage(`${path}: a COMMANDS entry has no name`);
		names.push(command.name);
		if (command.name !== "doctor" || !("flags" in command) || !Array.isArray(command.flags)) continue;
		for (const flag of command.flags) {
			if (flag && typeof flag === "object" && "name" in flag && flag.name === "--scope" && "value" in flag) scopeValue = flag.value;
		}
	}
	if (typeof scopeValue !== "string" || !scopeValue) usage(`${path}: the doctor command has no --scope value list`);
	return { commands: names, scopes: scopeValue.split("|") };
}

/** README text with one generated block removed (generated blocks legitimately carry versions). */
function withoutBlock(readme: string, startMarker: string, endMarker: string): string {
	const start = readme.indexOf(startMarker);
	const end = readme.indexOf(endMarker);
	if (start < 0 || end < start) return readme;
	return readme.slice(0, start) + readme.slice(end + endMarker.length);
}
/** The generated release-line body, or undefined when either marker is missing. */
export function releaseBlock(readme: string): string | undefined {
	const start = readme.indexOf(RELEASE_START);
	const end = readme.indexOf(RELEASE_END);
	if (start < 0 || end < start) return undefined;
	return readme.slice(start + RELEASE_START.length, end).trim();
}

function section(readme: string, heading: string): string | undefined {
	const lines = readme.split("\n");
	const start = lines.findIndex(line => line.trim() === heading);
	if (start < 0) return undefined;
	const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
	return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** "30 rules", "five guard extensions", "30 diagnostic scopes": a count claim about the shipped inventory. */
export const COUNT_CLAIM = new RegExp(`(?<![\\w.-])(\\d{1,4}|${NUMBER_WORDS.join("|")})[ \\t]+(?:[a-z]+(?:-[a-z]+)*[ \\t]+)?(rules|scopes|commands|extensions|skills)\\b`, "gi");

/** Which input-dependent rules the tree declares (see Applicability above); registry null means rule 1 is not applicable. */
export type ReadmeScope = { registry: Registry | null; inventory: Inventory; release: boolean; sections: boolean };

export function checkReadme(readme: string, scope: ReadmeScope, releaseVersion?: string,
	releaseTag?: (version: string) => ReleaseTag): string[] {
	const { registry, inventory } = scope;
	const findings: string[] = [];
	// The OMP footer sits at the end of the file so stripping it shifts no finding line; the
	// release line sits at the top, so it stays in the scanned body and only its own line range
	// is exempt from the version-literal rule (stripping it would misnumber every finding below).
	const body = withoutBlock(readme, FOOTER_START, FOOTER_END);
	const block = releaseBlock(readme);
	if (!scope.release) {
		// Rule 2 is not applicable: no release train stamps this README.
	} else if (block === undefined) {
		findings.push(`README.md has no generated release line (${RELEASE_START} … ${RELEASE_END}); the release train stamps it at tag time with sh scripts/stamp-release-line.sh`);
	} else if (releaseVersion === undefined) {
		findings.push("README.md release line is unverifiable: no package.json version supplied to checkReadme");
	} else if (block !== `Current release: v${releaseVersion}`) {
		const stated = /^Current release: v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(block)?.[1];
		const [major, minor, patch] = (stated ?? "").split(".").map(Number);
		if (stated === undefined || releaseVersion !== `${major}.${minor}.${patch! + 1}`) {
			findings.push(`README.md release line says \`${block}\` but package.json is ${releaseVersion}; refresh with sh scripts/stamp-release-line.sh --version ${releaseVersion}`);
		} else {
			// package.json already states the next patch (NEXTVERSION1); README may name the release it follows only once that release exists.
			const tag = releaseTag?.(stated) ?? "unreadable";
			if (tag === "absent")
				findings.push(`README.md release line says v${stated} and package.json is its next patch ${releaseVersion}, but tag v${stated} does not exist; the line must state a published release`);
			else if (tag === "unreadable")
				findings.push(`README.md release line says v${stated} and package.json is its next patch ${releaseVersion}, but the repository tags cannot be read to prove v${stated} is published (pass --repo DIR); failing closed`);
		}
	}
	const releaseStart = body.indexOf(RELEASE_START);
	const releaseEnd = body.indexOf(RELEASE_END);
	const exemptFrom = releaseStart < 0 ? -1 : body.slice(0, releaseStart).split("\n").length - 1;
	const exemptTo = releaseEnd < releaseStart ? -1 : body.slice(0, releaseEnd + RELEASE_END.length).split("\n").length - 1;
	const reference = registry ? section(body, "## Command reference") : undefined;
	if (!registry) {
		// Rule 1 is not applicable: the tree has no COMMANDS registry to document.
	} else if (reference === undefined) {
		findings.push("README.md has no `## Command reference` section");
	} else {
		for (const name of registry.commands) {
			if (!new RegExp(`(?<![\\w-])omp-kit ${escapeRegExp(name)}(?![\\w-])`).test(reference))
				findings.push(`README.md command reference is missing \`omp-kit ${name}\` (src/commands.ts COMMANDS)`);
		}
		for (const scope of registry.scopes) {
			if (!new RegExp(`(?<![\\w-])--scope ${escapeRegExp(scope)}(?![\\w-])`).test(reference))
				findings.push(`README.md command reference is missing \`doctor --scope ${scope}\` (src/commands.ts doctor --scope)`);
		}
	}
	body.split("\n").forEach((line, index) => {
		if (scope.release && (index < exemptFrom || index > exemptTo))
			for (const match of line.matchAll(VERSION_LITERAL))
				findings.push(`README.md:${index + 1} pins a release version literal \`${match[0]}\`; resolve the latest release at run time instead`);
		if (WORKLOG_HEADING.test(line)) findings.push(`README.md:${index + 1} worklog/changelog heading (readme-update W1-W3); history belongs in CHANGELOG.md: ${line.trim()}`);
		if (/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]/.test(line)) findings.push(`README.md:${index + 1} task checkbox (readme-update W7)`);
		const actual: Record<string, number | null> = {
			rules: inventory.rules, scopes: registry ? registry.scopes.length : null, commands: registry ? registry.commands.length : null,
			extensions: inventory.extensions, skills: inventory.skills,
		};
		for (const match of line.matchAll(COUNT_CLAIM)) {
			const word = match[1]!.toLowerCase();
			const claimed = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word);
			const kind = match[2]!.toLowerCase();
			// A kind the tree declares no inventory for (a business README's "12 rules") is not a shipped-inventory claim.
			if (actual[kind] !== null && claimed !== actual[kind])
				findings.push(`README.md:${index + 1} claims "${match[0]}" but the tree ships ${actual[kind]} ${kind}; update the count`);
		}
	});
	if (!scope.sections) return findings;
	const h2 = body.split("\n").filter(line => /^## /.test(line)).map(line => line.slice(3).trim());
	for (const required of ["Limitations", "About Contributions", "License"]) {
		if (!h2.includes(required)) findings.push(`README.md has no \`## ${required}\` section`);
	}
	if (h2.length && h2.at(-1) !== "License") findings.push(`README.md: \`## License\` must be the last H2 (found \`## ${h2.at(-1)}\`)`);
	return findings;
}

/** The file's one process site (kitlib-ratchet-baseline.json counts 1): the readme-update gate and the tag lookup share it. */
function spawnText(args: string[], dir: string): { ok: boolean; stdout: string; output: string } {
	const child = Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const stdout = child.stdout.toString();
	return { ok: child.exitCode === 0, stdout, output: `${stdout}${child.stderr.toString()}`.trimEnd() };
}

/**
 * readme-update's validator, when installed. M1-mandatory is disabled for one reason only: its
 * contributions needle is another author's personal policy text, and this repo carries Josh's own
 * About Contributions policy (decision recorded on bead ompkit-readme-changelog-currency-vrrn).
 * checkReadme() above re-checks the sections M1 would have required.
 */
function runReadmeGate(readmePath: string): { ran: boolean; ok: boolean; output: string } {
	const gate = process.env.README_GATE ?? join(homedir(), ".claude/skills/readme-update/scripts/readme-gate.py");
	if (!existsSync(gate)) return { ran: false, ok: true, output: `readme-gate: not installed at ${gate}; repo structural checks only` };
	const dir = dirname(readmePath);
	const args = ["python3", gate, "--profile", "product", "--disable", "M1-mandatory"];
	if (existsSync(join(dir, "README-NOTES.md"))) args.push("--notes", join(dir, "README-NOTES.md"));
	args.push(readmePath);
	const child = spawnText(args, dir);
	return { ran: true, ok: child.ok, output: child.output };
}

/** `git tag -l vX.Y.Z` in the repo; any git failure (or a missing repo dir) is "unreadable", never "absent". */
function releaseTagIn(repo: string): (version: string) => ReleaseTag {
	return version => {
		if (!existsSync(repo)) return "unreadable";
		const listed = spawnText(["git", "-C", repo, "tag", "-l", `v${version}`], repo);
		if (!listed.ok) return "unreadable";
		return listed.stdout.split("\n").includes(`v${version}`) ? "present" : "absent";
	};
}

async function main(argv: string[]): Promise<number> {
	let root = resolve(import.meta.dir, "..");
	let readmePath: string | undefined;
	let registryPath: string | undefined;
	let readmeGate = true;
	let repo = process.cwd();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--no-readme-gate") { readmeGate = false; continue; }
		if (!value || value.startsWith("--")) usage(`missing value for ${flag}`);
		if (flag === "--root") root = resolve(value);
		else if (flag === "--readme") readmePath = resolve(value);
		else if (flag === "--registry") registryPath = resolve(value);
		else if (flag === "--repo") repo = resolve(value);
		else usage(`unknown flag ${flag}`);
		index++;
	}
	const registryFlag = registryPath;
	readmePath ??= join(root, "README.md");
	registryPath ??= join(root, "src/commands.ts");
	if (!existsSync(readmePath)) usage(`no README at ${readmePath}`);
	const readme = readFileSync(readmePath, "utf8");
	// Declarations (see Applicability above): the repo's own checker declares the whole kit README policy.
	const kitPolicy = existsSync(join(root, "scripts", "readme-check.ts"));
	const registryDeclared = kitPolicy || registryFlag !== undefined || existsSync(registryPath);
	const registry = registryDeclared ? await loadRegistry(registryPath) : null;
	const inventory = loadInventory(root, kitPolicy);
	const release = kitPolicy || readme.includes(RELEASE_START) || readme.includes(RELEASE_END) || existsSync(join(root, "scripts", "stamp-release-line.sh"));
	let releaseVersion: string | undefined;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const version = manifest && typeof manifest === "object" && "version" in manifest ? manifest.version : undefined;
		if (typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) releaseVersion = version;
	} catch { releaseVersion = undefined; }
	const findings = checkReadme(readme, { registry, inventory, release, sections: kitPolicy }, releaseVersion, releaseTagIn(repo));
	const count = (value: number | null) => value ?? "undeclared";
	console.log(`readme-check: ${registry ? `registry ${registry.commands.length} commands, ${registry.scopes.length} doctor scopes (${registryPath})` : "no registry"}; ${count(inventory.rules)} rules, ${count(inventory.extensions)} extensions, ${count(inventory.skills)} skills`);
	if (!registry) console.log("NOT_APPLICABLE command-reference: no COMMANDS registry at src/commands.ts; the command reference and command/scope counts are not judged");
	if (!release) console.log(`NOT_APPLICABLE release-line: README.md has no ${RELEASE_START} block and the repo has no scripts/stamp-release-line.sh; the release line and version pins are not judged`);
	for (const [kind, input] of [["rules", "rules/ directory"], ["extensions", "package.json omp.extensions"], ["skills", "skills/ directory"]] as const)
		if (inventory[kind] === null) console.log(`NOT_APPLICABLE ${kind}-count: no ${input}; "N ${kind}" claims are not judged`);
	if (!kitPolicy) console.log("NOT_APPLICABLE kit-sections: the repo ships no scripts/readme-check.ts; the Limitations / About Contributions / License-last sections are omp-kit README policy");
	if (readmeGate) {
		const gate = runReadmeGate(readmePath);
		console.log(gate.output);
		if (!gate.ok) findings.push("readme-update gate (--profile product) refused README.md; see its output above");
	}
	for (const finding of findings) console.log(`RED ${finding}`);
	console.log(findings.length ? `README-CHECK: RED (${findings.length} findings)` : "README-CHECK: GREEN");
	return findings.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
