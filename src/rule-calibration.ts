export interface CorpusRuleLike {
	rule: string;
	kind: string;
	scanned: number;
	fires: number;
}

/** A human/fixture label for one sampled fire. `false_fire=true` is a false positive. */
export interface FireLabel {
	rule: string;
	kind: string;
	event_index: number;
	false_fire: boolean;
}

export interface CalibrationRule {
	rule: string;
	kind: string;
	scanned: number;
	fires: number;
	fire_rate: number;
	sample_size: number;
	false_fires: number;
	false_fire_rate: number | null;
	ci_low: number;
	ci_high: number;
	noisy: boolean;
}

export interface DeadRule {
	rule: string;
	kind: string;
	sessions: number;
}

export interface CalibrationReport {
	seed: number;
	sample_size: number;
	noisy_lower_bound: number;
	rules: CalibrationRule[];
	noisy_rules: CalibrationRule[];
	dead_rules: DeadRule[];
}

export interface CalibrationInput {
	corpus: { files: number; rules: readonly CorpusRuleLike[] };
	labels: readonly FireLabel[];
	seed: number;
	sample_size: number;
	noisy_lower_bound: number;
}

const WILSON_Z = 1.96;

export function wilsonInterval(successes: number, trials: number): { low: number; high: number } {
	if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials) || trials <= 0 || successes < 0 || successes > trials) {
		return { low: 0, high: 0 };
	}
	const p = successes / trials;
	const z2 = WILSON_Z * WILSON_Z;
	const denominator = 1 + z2 / trials;
	const center = (p + z2 / (2 * trials)) / denominator;
	const half = WILSON_Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials)) / denominator;
	return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

function random(seed: number): () => number {
	let state = (seed >>> 0) || 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

export function deterministicSample<T>(items: readonly T[], size: number, seed: number): T[] {
	if (!Number.isSafeInteger(size) || size <= 0) return [];
	const selected = [...items];
	const next = random(seed);
	for (let index = selected.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(next() * (index + 1));
		[selected[index], selected[swap]] = [selected[swap]!, selected[index]!];
	}
	return selected.slice(0, Math.min(size, selected.length));
}

export function calibrateRule(input: {
	rule: string;
	kind: string;
	scanned: number;
	fires: number;
	session_count: number;
	labels: readonly boolean[];
	noisy_lower_bound: number;
}): CalibrationRule {
	const sampleSize = input.labels.length;
	const falseFires = input.labels.filter((isTrueFire) => !isTrueFire).length;
	const interval = wilsonInterval(falseFires, sampleSize);
	const falseRate = sampleSize > 0 ? falseFires / sampleSize : null;
	return {
		rule: input.rule,
		kind: input.kind,
		scanned: input.scanned,
		fires: input.fires,
		fire_rate: input.scanned > 0 ? input.fires / input.scanned : 0,
		sample_size: sampleSize,
		false_fires: falseFires,
		false_fire_rate: falseRate,
		ci_low: interval.low,
		ci_high: interval.high,
		noisy: sampleSize > 0 && interval.low > input.noisy_lower_bound,
	};
}

export function calibrateCorpus(input: CalibrationInput): CalibrationReport {
	const sampleSize = Math.max(1, Math.trunc(input.sample_size));
	const labelsByRule = new Map<string, FireLabel[]>();
	for (const label of input.labels) {
		const key = `${label.rule}\0${label.kind}`;
		const current = labelsByRule.get(key) ?? [];
		current.push(label);
		labelsByRule.set(key, current);
	}
	const rules = input.corpus.rules.map((corpusRule) => {
		const key = `${corpusRule.rule}\0${corpusRule.kind}`;
		const labels = deterministicSample(labelsByRule.get(key) ?? [], sampleSize, input.seed ^ hashKey(key));
		return calibrateRule({ ...corpusRule, session_count: input.corpus.files, labels: labels.map((label) => !label.false_fire), noisy_lower_bound: input.noisy_lower_bound });
	});
	const noisyRules = rules.filter((rule) => rule.noisy);
	const deadRules = input.corpus.rules.filter((rule) => rule.fires === 0 && input.corpus.files > 0)
		.map((rule) => ({ rule: rule.rule, kind: rule.kind, sessions: input.corpus.files }));
	return { seed: input.seed, sample_size: sampleSize, noisy_lower_bound: input.noisy_lower_bound, rules, noisy_rules: noisyRules, dead_rules: deadRules };
}

function hashKey(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
	return hash >>> 0;
}
