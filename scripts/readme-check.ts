// readme-check.ts -- README currency gate (fresh-gate step `readme`, CI).
//
// README.md went stale for 87 commits because nothing checked it. This gate makes staleness a RED:
//   1. Every top-level command and every `doctor --scope` value in the COMMANDS registry
//      (src/commands.ts, imported -- never grepped) appears in README.md's `## Command reference`
//      as `omp-kit <command>` / `--scope <value>`.
//   2. README.md pins no release version: no `vX.Y.Z` / `X.Y.Z` / `KIT_VERSION=X.Y.Z` outside the
//      generated OMP footer (scripts/docs-footer.sh owns that block). Install snippets resolve the
//      latest release at run time.
//   3. The readme-update gate (skill readme-update, --profile product) passes when it is installed;
//      the repo's own structural checks always run (CI has no skills directory).
//
// Usage: bun scripts/readme-check.ts [--root DIR] [--readme PATH] [--registry PATH] [--no-readme-gate]
// Exit 0 GREEN, 1 RED (each finding named), 2 usage or unreadable input.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const FOOTER_START = "<!-- verified-ttsr-docs:start -->";
const FOOTER_END = "<!-- verified-ttsr-docs:end -->";
/** A release-shaped version triple not embedded in a longer dotted or word token (127.0.0.1 is not one). */
export const VERSION_LITERAL = /(?<![\w.-])v?(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?!\.?\d)/g;
/** readme-update forbids worklog headings (W1-W3); mirrored here for runs without the skill. */
const WORKLOG_HEADING = /^#{1,6}[ \t]+(?:changelog|release notes|what'?s new|recent(?:ly)?|new in|updates|latest|todo|this session|built today|worklog)\b/i;

type Registry = { commands: string[]; scopes: string[] };
/** Shipped inventory the README may count: rules/*.md, package.json omp.extensions, skills/<name>/SKILL.md. */
type Inventory = { rules: number; extensions: number; skills: number };

function loadInventory(root: string): Inventory {
	const rules = readdirSync(join(root, "rules")).filter(name => name.endsWith(".md")).length;
	const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const omp = manifest && typeof manifest === "object" && "omp" in manifest ? manifest.omp : undefined;
	const extensions = omp && typeof omp === "object" && "extensions" in omp && Array.isArray(omp.extensions) ? omp.extensions.length : 0;
	const skillsDir = join(root, "skills");
	const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter(name => existsSync(join(skillsDir, name, "SKILL.md"))).length : 0;
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

/** README text with the generated footer removed (it legitimately carries OMP versions). */
function withoutFooter(readme: string): string {
	const start = readme.indexOf(FOOTER_START);
	const end = readme.indexOf(FOOTER_END);
	if (start < 0 || end < start) return readme;
	return readme.slice(0, start) + readme.slice(end + FOOTER_END.length);
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

export function checkReadme(readme: string, registry: Registry, inventory: Inventory): string[] {
	const findings: string[] = [];
	const body = withoutFooter(readme);
	const reference = section(body, "## Command reference");
	if (reference === undefined) {
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
		for (const match of line.matchAll(VERSION_LITERAL))
			findings.push(`README.md:${index + 1} pins a release version literal \`${match[0]}\`; resolve the latest release at run time instead`);
		if (WORKLOG_HEADING.test(line)) findings.push(`README.md:${index + 1} worklog/changelog heading (readme-update W1-W3); history belongs in CHANGELOG.md: ${line.trim()}`);
		if (/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]/.test(line)) findings.push(`README.md:${index + 1} task checkbox (readme-update W7)`);
		const actual: Record<string, number> = {
			rules: inventory.rules, scopes: registry.scopes.length, commands: registry.commands.length,
			extensions: inventory.extensions, skills: inventory.skills,
		};
		for (const match of line.matchAll(COUNT_CLAIM)) {
			const word = match[1]!.toLowerCase();
			const claimed = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word);
			const kind = match[2]!.toLowerCase();
			if (claimed !== actual[kind])
				findings.push(`README.md:${index + 1} claims "${match[0]}" but the tree ships ${actual[kind]} ${kind}; update the count`);
		}
	});
	const h2 = body.split("\n").filter(line => /^## /.test(line)).map(line => line.slice(3).trim());
	for (const required of ["Limitations", "About Contributions", "License"]) {
		if (!h2.includes(required)) findings.push(`README.md has no \`## ${required}\` section`);
	}
	if (h2.length && h2.at(-1) !== "License") findings.push(`README.md: \`## License\` must be the last H2 (found \`## ${h2.at(-1)}\`)`);
	return findings;
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
	const child = Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
	return { ran: true, ok: child.exitCode === 0, output: `${child.stdout.toString()}${child.stderr.toString()}`.trimEnd() };
}

async function main(argv: string[]): Promise<number> {
	let root = resolve(import.meta.dir, "..");
	let readmePath: string | undefined;
	let registryPath: string | undefined;
	let readmeGate = true;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--no-readme-gate") { readmeGate = false; continue; }
		if (!value || value.startsWith("--")) usage(`missing value for ${flag}`);
		if (flag === "--root") root = resolve(value);
		else if (flag === "--readme") readmePath = resolve(value);
		else if (flag === "--registry") registryPath = resolve(value);
		else usage(`unknown flag ${flag}`);
		index++;
	}
	readmePath ??= join(root, "README.md");
	registryPath ??= join(root, "src/commands.ts");
	if (!existsSync(readmePath)) usage(`no README at ${readmePath}`);
	const registry = await loadRegistry(registryPath);
	const inventory = loadInventory(root);
	const findings = checkReadme(readFileSync(readmePath, "utf8"), registry, inventory);
	console.log(`readme-check: registry ${registry.commands.length} commands, ${registry.scopes.length} doctor scopes (${registryPath}); ${inventory.rules} rules, ${inventory.extensions} extensions, ${inventory.skills} skills`);
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
