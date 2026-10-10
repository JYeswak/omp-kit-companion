#!/usr/bin/env bun
/**
 * rule-class.ts — the kit's one rule classifier, built on omp's own rule parser.
 *
 * Every caller (the harness, the live suite's coverage check, the manifest) classifies a
 * rule from the object omp itself builds with `buildRuleFromMarkdown`, so the kit cannot
 * disagree with omp about what a file says. A regex or awk read of the frontmatter can:
 * inline comments, quoted keys, flow maps, CRLF, folded scalars, and `astCondition` or
 * `question` rules without a `condition:` key all read differently to a line matcher.
 *
 * Usage: bun scripts/rule-class.ts <rule.md>...   prints `name<TAB>class` per file.
 * Env:   OMP_SRC (omp TypeScript source dir), as for ttsr-harness.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";

function packageSourceAbove(start: string): { src: string; version: string } | null {
	for (let dir = path.dirname(start); ; dir = path.dirname(dir)) {
		const pkg = path.join(dir, "package.json");
		if (fs.existsSync(pkg)) {
			const manifest = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: unknown; version?: unknown };
			if (manifest.name === PACKAGE_NAME) {
				const src = path.join(dir, "src");
				return fs.existsSync(src) ? { src, version: String(manifest.version) } : null;
			}
		}
		if (path.dirname(dir) === dir) return null;
	}
}

export interface OmpSourceLookup {
	env: NodeJS.ProcessEnv;
	/** Version printed by `<launcher> --version`, e.g. "18.8.8"; null when it cannot be read. */
	launcherVersion(launcher: string): string | null;
}

const defaultLookup: OmpSourceLookup = {
	env: process.env,
	launcherVersion(launcher) {
		// From the launcher's own directory: a trust-gated launcher refuses to run inside an untrusted project.
		const run = spawnSync(launcher, ["--version"], { cwd: path.dirname(launcher), encoding: "utf8", timeout: 15_000 });
		return run.status === 0 ? /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1] ?? null : null;
	},
};

/**
 * The TypeScript source of the omp that `omp` on PATH runs. The first launcher usually lives inside
 * its package. A compiled standalone launcher does not, so the same version's package is then taken
 * from another `omp` on PATH or from bun's global install; a package of any other version is refused,
 * because classifying rules with a different omp's parser is exactly the drift this file prevents.
 */
export function resolveOmpSource(lookup: OmpSourceLookup = defaultLookup): string {
	const { env } = lookup;
	if (env.OMP_SRC) return env.OMP_SRC;
	const launchers: string[] = [];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(dir || ".", "omp");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) launchers.push(fs.realpathSync(candidate));
		} catch {}
	}
	const executable = launchers[0];
	if (!executable) throw new Error("omp not found on PATH; install omp or set OMP_SRC to its source directory");
	const own = packageSourceAbove(executable);
	if (own) return own.src;
	const version = lookup.launcherVersion(executable);
	const bunRoot = env.BUN_INSTALL ?? path.join(env.HOME ?? os.homedir(), ".bun");
	const others = [...launchers.slice(1), path.join(bunRoot, "install", "global", "node_modules", PACKAGE_NAME, "package.json")];
	for (const other of others) {
		const found = packageSourceAbove(other);
		if (found && version !== null && found.version === version) return found.src;
	}
	throw new Error(`cannot locate the omp ${version ?? "(unknown version)"} package source for ${executable}; set OMP_SRC to its src directory (…/${PACKAGE_NAME}/src)`);
}

export const OMP_SRC = resolveOmpSource();
// OMP_SRC follows whichever omp is installed, so these specifiers cannot be static imports.
const helpersMod = await import(path.join(OMP_SRC, "discovery/helpers.ts"));
const utilsMod = await import(Bun.resolveSync("@oh-my-pi/pi-utils", path.join(OMP_SRC, "discovery/helpers.ts")));

export interface Rule {
	content?: string;
	name: string;
	path: string;
	alwaysApply?: boolean;
	condition?: string[];
	astCondition?: string[];
	question?: string;
	scope?: string[];
	interruptMode?: string;
}

export type RuleClass = "always" | "tripwire" | "reminder" | "canary" | "router";

export interface LoadedRule {
	name: string;
	file: string;
	rule: Rule;
	cls: RuleClass;
	/** Frontmatter as omp parses it (keys normalized to camelCase, as omp stores them). */
	frontmatter: Record<string, unknown>;
}

const buildRuleFromMarkdown = helpersMod.buildRuleFromMarkdown as (
	name: string,
	content: string,
	filePath: string,
	source: unknown,
	options?: { ruleName?: string },
) => Rule;
const createSourceMeta = helpersMod.createSourceMeta as (p: string, f: string, l: "user" | "project") => unknown;
const parseFrontmatter = utilsMod.parseFrontmatter as (
	content: string,
	options?: { source?: unknown },
) => { frontmatter: Record<string, unknown>; body: string };

/** The README contract: two named rules, then always / reminder / tripwire from omp's rule object. */
export function ruleClass(name: string, rule: Rule): RuleClass {
	if (name === "zz-canary-scope-probe") return "canary";
	if (name === "rs-unsafe-added-router") return "router";
	const hasCond = (rule.condition?.length ?? 0) > 0 || (rule.astCondition?.length ?? 0) > 0 || !!rule.question;
	if (rule.alwaysApply && !hasCond) return "always";
	if (rule.interruptMode === "never") return "reminder";
	return "tripwire";
}

export function loadRuleFile(file: string): LoadedRule {
	const abs = path.resolve(file);
	const content = fs.readFileSync(abs, "utf8");
	const name = path.basename(abs).replace(/\.(md|mdc)$/, "");
	const rule = buildRuleFromMarkdown(name, content, abs, createSourceMeta("agents", abs, "user"), { ruleName: name });
	const { frontmatter } = parseFrontmatter(content, { source: abs });
	return { name, file: abs, rule, cls: ruleClass(name, rule), frontmatter };
}

export function loadRules(dir: string): LoadedRule[] {
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".md"))
		.sort()
		.map(f => loadRuleFile(path.join(dir, f)));
}

if (import.meta.main) {
	const files = process.argv.slice(2);
	if (files.length === 0) {
		console.error("usage: bun scripts/rule-class.ts <rule.md>...");
		process.exit(2);
	}
	for (const f of files) {
		const lr = loadRuleFile(f);
		console.log(`${lr.name}\t${lr.cls}`);
	}
}
