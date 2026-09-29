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
import * as fs from "node:fs";
import * as path from "node:path";

function ompSource(): string {
	if (process.env.OMP_SRC) return process.env.OMP_SRC;
	const executable = Bun.which("omp");
	if (!executable) throw new Error("omp not found on PATH; install omp or set OMP_SRC to its source directory");
	for (let dir = path.dirname(fs.realpathSync(executable)); ; dir = path.dirname(dir)) {
		const pkg = path.join(dir, "package.json");
		if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).name === "@oh-my-pi/pi-coding-agent") {
			const src = path.join(dir, "src");
			if (fs.existsSync(src)) return src;
			throw new Error(`${executable} belongs to omp but ${src} is missing; set OMP_SRC to its source directory`);
		}
		if (path.dirname(dir) === dir) break;
	}
	throw new Error(`cannot locate the omp package for ${executable}; set OMP_SRC to its source directory`);
}

export const OMP_SRC = ompSource();
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
