/** Canonical CC credential-rule mechanics (scripts/cc/shapes.py).
 * Regex dialect conversion belongs to the generator, not to an untrusted line's hot path.
 * The normalized catalog retains all rules/allowlists and its Python Unicode digit table.
 * Only a fixed rule id leaves this module; matched credential text is never returned.
 */
interface RegexSpec { pattern: string; flags: string }
interface AllowSpec {
	condition?: string;
	target?: string;
	regexes?: RegexSpec[];
	stopwords?: string[];
	needs_path?: boolean;
}
interface RuleSpec {
	id: string;
	regex: RegexSpec;
	keywords?: string[];
	secret_group?: number;
	entropy?: number | null;
	allowlists?: AllowSpec[];
}
export interface CcCredentialCatalog {
	schema_version: string;
	regex_dialect: string;
	python_digit_ranges: number[][];
	global_allowlists?: AllowSpec[];
	rules: RuleSpec[];
}
export type CcCredentialScreen = (text: string) => string | null;
interface Allow {
	and: boolean;
	target: string;
	regexes: RegExp[];
	words: string[];
	applicable: boolean;
}
interface Rule {
	id: string;
	regex: RegExp;
	keywords: string[];
	group: number;
	entropy: number | null;
	allows: Allow[];
}
function compileRegex(spec: RegexSpec, global: boolean): RegExp {
	if (!spec.flags.includes("u") || spec.flags.includes("g") || spec.flags.includes("y")) {
		throw new Error("CC_CREDENTIAL_REGEX_DIALECT");
	}
	try {
		return new RegExp(spec.pattern, spec.flags + (global ? "g" : ""));
	} catch {
		throw new Error("CC_CREDENTIAL_REGEX_UNSUPPORTED");
	}
}
function compileAllow(spec: AllowSpec): Allow {
	const target = spec.target || "secret";
	if (target !== "secret" && target !== "match" && target !== "line") throw new Error("CC_CREDENTIAL_ALLOW_TARGET");
	const regexes = (spec.regexes ?? []).map((source) => compileRegex(source, false));
	const words = (spec.stopwords ?? []).map((word) => word.toLowerCase());
	const and = spec.condition === "AND";
	return { and, target, regexes, words, applicable: (regexes.length > 0 || words.length > 0) && !(and && spec.needs_path === true) };
}
function allows(allow: Allow, secret: string, match: string, line: string): boolean {
	if (!allow.applicable) return false;
	const target = allow.target === "line" ? line : allow.target === "match" ? match : secret;
	let regexMatch = false;
	for (const regex of allow.regexes) if (regex.test(target)) { regexMatch = true; break; }
	let wordMatch = false;
	if (allow.words.length > 0) {
		const lower = secret.toLowerCase();
		for (const word of allow.words) if (lower.includes(word)) { wordMatch = true; break; }
	}
	if (allow.and) return (allow.regexes.length === 0 || regexMatch) && (allow.words.length === 0 || wordMatch);
	return regexMatch || wordMatch;
}
/** Match Python 3.9 Counter insertion order and binary64 comparison; do not add a parity-hiding epsilon. */
function entropy(secret: string): number {
	const counts = new Map<string, number>();
	let total = 0;
	for (const char of secret) { counts.set(char, (counts.get(char) ?? 0) + 1); total++; }
	if (total === 0) return 0;
	let sum = 0;
	for (const count of counts.values()) { const probability = count / total; sum += probability * Math.log2(probability); }
	return -sum;
}
function digit(point: number, ranges: number[][]): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const range = ranges[mid]!;
		if (point < range[0]!) hi = mid - 1;
		else if (point > range[1]!) lo = mid + 1;
		else return true;
	}
	return false;
}
function hasDigit(secret: string, ranges: number[][]): boolean {
	for (const char of secret) if (digit(char.codePointAt(0)!, ranges)) return true;
	return false;
}
function captured(match: RegExpExecArray, group: number): string {
	if (group > 0 && group < match.length && match[group]) return match[group]!;
	for (let i = 1; i < match.length; i++) if (match[i]) return match[i]!;
	return match[0];
}
function matches(rule: Rule, text: string, lower: string, ranges: number[][], globalAllows: Allow[]): boolean {
	if (rule.keywords.length > 0) {
		let keyword = false;
		for (const word of rule.keywords) if (lower.includes(word)) { keyword = true; break; }
		if (!keyword) return false;
	}
	rule.regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = rule.regex.exec(text)) !== null) {
		const secret = captured(match, rule.group);
		if (match[0].length === 0) rule.regex.lastIndex += (text.codePointAt(rule.regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
		if (rule.entropy !== null && (entropy(secret) <= rule.entropy || (rule.id.startsWith("generic") && !hasDigit(secret, ranges)))) continue;
		let permitted = false;
		for (const allow of rule.allows) if (allows(allow, secret, match[0], text)) { permitted = true; break; }
		if (!permitted) for (const allow of globalAllows) if (allows(allow, secret, match[0], text)) { permitted = true; break; }
		if (!permitted) return true;
	}
	return false;
}
function checkDigitRanges(ranges: number[][]): void {
	let previous = -1;
	for (const range of ranges) {
		if (range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) ||
			range[0]! <= previous || range[0]! < 0 || range[1]! < range[0]! || range[1]! > 0x10ffff) {
			throw new Error("CC_CREDENTIAL_DIGIT_POLICY");
		}
		previous = range[1]!;
	}
	if (ranges.length === 0) throw new Error("CC_CREDENTIAL_DIGIT_POLICY");
}
/** Compile a generated catalog once, then screen bounded spool lines without invoking external tools. */
export function createCcCredentialScreen(catalog: CcCredentialCatalog): CcCredentialScreen {
	if (catalog.schema_version !== "omp-kit.cc.credential-shapes.v1" || catalog.regex_dialect !== "ecmascript-u" || catalog.rules.length === 0) {
		throw new Error("CC_CREDENTIAL_CATALOG");
	}
	checkDigitRanges(catalog.python_digit_ranges);
	const globalAllows = (catalog.global_allowlists ?? []).map(compileAllow);
	const rules: Rule[] = catalog.rules.map((spec) => {
		const threshold = spec.entropy ?? null;
		if (threshold !== null && !Number.isFinite(threshold)) throw new Error("CC_CREDENTIAL_ENTROPY");
		const group = spec.secret_group ?? 0;
		if (!Number.isSafeInteger(group) || group < 0) throw new Error("CC_CREDENTIAL_GROUP");
		return {
			id: spec.id, regex: compileRegex(spec.regex, true), keywords: (spec.keywords ?? []).map((word) => word.toLowerCase()),
			group, entropy: threshold, allows: (spec.allowlists ?? []).map(compileAllow),
		};
	});
	return (text: string): string | null => {
		const lower = text.toLowerCase();
		for (const rule of rules) if (matches(rule, text, lower, catalog.python_digit_ranges, globalAllows)) return rule.id;
		return null;
	};
}
