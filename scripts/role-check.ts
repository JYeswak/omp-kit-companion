// role-check.ts — resolve every modelRole of one omp profile with omp's own resolver.
//
//   [OMP_SRC=<omp package>/src] [OMP_PROFILE=<name>] [OMP_KIT_USAGE_DIR=<dir>] bun role-check.ts < /dev/null
//   bun role-check.ts --selftest   fixture checks of the per-account quota rules; loads no omp code
//
// Prints exactly one line on stdout, "<STATUS> <evidence>":
//   RED    a role has nothing runnable: its model does not resolve and its fallback chain is empty;
//          or it resolves to an ollama/* tag that `ollama list` lacks (omp caches Ollama discovery
//          24 h per profile, so a parked or renamed tag still resolves and every call 404s);
//          or every account of its provider has a usage limit exhausted until a future reset, and no
//          fallback with quota can take over (retry.modelFallback off, or none left)
//   WARN   a role's configured model does not resolve, or its provider is out of quota, and omp runs
//          the named fallback instead
//   GREEN  every role resolves to its configured model and its provider has quota
// Uses the resolver omp itself calls (resolveModelRoleValue / resolveRoleChain), so aliases, bare ids
// such as `z-ai/glm-5.3-flash`, and `:effort` suffixes match exactly as they do at run time.
// Quota is per account, from `omp usage --json` dumps (what `omp usage` shows): this profile's dump
// names the accounts it holds for each provider (reports plus accountsWithoutUsage), and an account
// counts as exhausted when any dump shows a limit with status "exhausted" and a resetsAt still in the
// future, so a stale report expires on its own. A provider is out only when every account this profile
// holds for it is out. With OMP_KIT_USAGE_DIR (doctor writes <dir>/<profile>.json for every profile),
// an account exhausted in one profile counts in every profile that holds it; without it, this script
// runs `omp usage --json` for its own profile only and cannot see the other profiles' reports.
// Run with the caller's PI_CODING_AGENT_DIR/PI_PROFILE unset: they override OMP_PROFILE.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The slice of omp's internals this script calls. */
interface RoleModel {
	provider: string;
	id: string;
}
/** One profile's `omp usage --json`. */
interface UsageDump {
	reports?: Array<{
		provider: string;
		metadata?: { accountId?: string; email?: string };
		limits?: Array<{ status?: string; window?: { resetsAt?: number } }>;
	}>;
	accountsWithoutUsage?: Array<{ provider: string; accountId?: string; email?: string }>;
}
interface OmpSettings {
	getModelRoles(): Record<string, string> | undefined;
}
interface OmpAuth {
	close(): void;
}
interface OmpRegistry {
	refresh(strategy: "online-if-uncached"): Promise<void>;
	getAvailable(): RoleModel[];
}
interface OmpModules {
	Settings: { loadReadOnly(options: { cwd: string }): Promise<OmpSettings> };
	ModelRegistry: new (auth: OmpAuth, modelsPath?: string, options?: { settings: OmpSettings }) => OmpRegistry;
	discoverAuthStorage(dir: undefined, options: { settings: OmpSettings }): Promise<OmpAuth>;
	resolveModelRoleValue(value: string, pool: RoleModel[], options: { settings: OmpSettings }): { model?: RoleModel };
	resolveRoleChain(role: string, settings: OmpSettings, pool: RoleModel[]): Array<{ model: RoleModel }>;
	cfgRetry: { get(settings: OmpSettings): { enabled: boolean; modelFallback: boolean } };
}

function ollamaTags(): Set<string> | undefined {
	const out = Bun.spawnSync(["ollama", "list"], { stdout: "pipe", stderr: "pipe" });
	if (out.exitCode !== 0) return undefined;
	const lines = out.stdout.toString().split("\n").slice(1);
	return new Set(lines.map(l => l.split(/\s+/)[0]).filter(Boolean));
}

function parseDump(text: string): UsageDump | string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as UsageDump;
		return "usage JSON is not an object";
	} catch (err) {
		return `usage JSON unreadable: ${(err as Error).message.split("\n")[0]}`;
	}
}

/** This profile's usage dump plus every other dump in OMP_KIT_USAGE_DIR. */
async function loadDumps(profile: string): Promise<{ own: UsageDump | string; all: UsageDump[] }> {
	const dir = process.env.OMP_KIT_USAGE_DIR;
	if (!dir) {
		const out = Bun.spawnSync(["omp", "usage", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const own = out.exitCode === 0 ? parseDump(out.stdout.toString()) : `omp usage exited ${out.exitCode}`;
		return { own, all: typeof own === "string" ? [] : [own] };
	}
	const all: UsageDump[] = [];
	let own: UsageDump | string = `no ${profile}.json in ${dir}`;
	for (const file of new Bun.Glob("*.json").scanSync(dir)) {
		const dump = parseDump(await Bun.file(`${dir}/${file}`).text());
		if (file === `${profile}.json`) own = dump;
		if (typeof dump !== "string") all.push(dump);
	}
	return { own, all };
}

type UsageReport = NonNullable<UsageDump["reports"]>[number];

/** provider + account identity; undefined when the account carries neither id nor email. */
const accountKey = (provider: string, a: { accountId?: string; email?: string } | undefined) => {
	const id = a?.accountId ?? a?.email;
	return id ? `${provider}\t${id}` : undefined;
};

/** Latest future reset among a report's exhausted limits; undefined when none is exhausted. */
function reportExhaustedUntil(report: UsageReport, now: number): number | undefined {
	let until: number | undefined;
	for (const limit of report.limits ?? []) {
		const at = limit.window?.resetsAt;
		if (limit.status === "exhausted" && typeof at === "number" && at > now) until = Math.max(until ?? 0, at);
	}
	return until;
}

/** Providers whose every account held by this profile is exhausted until a future reset → earliest reset (ms). */
function exhaustedProviders(own: UsageDump, all: UsageDump[]): Map<string, number> {
	const now = Date.now();
	const exhaustedUntil = new Map<string, number>();
	for (const dump of all) {
		for (const report of dump.reports ?? []) {
			const key = accountKey(report.provider, report.metadata);
			const until = reportExhaustedUntil(report, now);
			if (key && until !== undefined) exhaustedUntil.set(key, Math.max(exhaustedUntil.get(key) ?? 0, until));
		}
	}
	// An account without identity cannot be matched across profiles; only its own report speaks for it.
	const held = new Map<string, Array<number | undefined>>();
	const hold = (provider: string, until: number | undefined) => held.set(provider, [...(held.get(provider) ?? []), until]);
	for (const report of own.reports ?? []) {
		const key = accountKey(report.provider, report.metadata);
		hold(report.provider, key ? exhaustedUntil.get(key) : reportExhaustedUntil(report, now));
	}
	for (const account of own.accountsWithoutUsage ?? []) {
		const key = accountKey(account.provider, account);
		hold(account.provider, key ? exhaustedUntil.get(key) : undefined);
	}
	const out = new Map<string, number>();
	for (const [provider, resets] of held) {
		if (resets.every((u): u is number => u !== undefined)) out.set(provider, Math.min(...resets));
	}
	return out;
}

if (process.argv.includes("--selftest")) {
	const future = Date.now() + 86_400_000;
	const past = Date.now() - 1_000;
	const exhausted = (provider: string, accountId: string | undefined, resetsAt: number): UsageReport => ({
		provider,
		metadata: accountId ? { accountId } : {},
		limits: [{ status: "exhausted", window: { resetsAt } }],
	});
	const cases: Array<[string, UsageDump, UsageDump[], string, number | undefined]> = [
		[
			"an account held here without a report, exhausted in another profile, blocks",
			{ accountsWithoutUsage: [{ provider: "m", accountId: "a" }] },
			[{ reports: [exhausted("m", "a", future)] }],
			"m",
			future,
		],
		[
			"one of two accounts exhausted leaves the provider usable",
			{
				reports: [
					exhausted("c", "a", future),
					{ provider: "c", metadata: { accountId: "b" }, limits: [{ status: "ok", window: { resetsAt: future } }] },
				],
			},
			[],
			"c",
			undefined,
		],
		["an exhausted limit whose reset has passed does not block", { reports: [exhausted("x", "a", past)] }, [], "x", undefined],
		[
			"an account without identity is not matched across profiles",
			{ accountsWithoutUsage: [{ provider: "m" }] },
			[{ reports: [exhausted("m", undefined, future)] }],
			"m",
			undefined,
		],
		["an account without identity is judged by its own report", { reports: [exhausted("m", undefined, future)] }, [], "m", future],
		[
			"the same account id under another provider does not count",
			{ accountsWithoutUsage: [{ provider: "p", accountId: "a" }] },
			[{ reports: [exhausted("q", "a", future)] }],
			"p",
			undefined,
		],
	];
	let failed = 0;
	for (const [label, own, others, provider, want] of cases) {
		const got = exhaustedProviders(own, [own, ...others]).get(provider);
		if (got !== want) failed++;
		console.log(`${got === want ? "ok  " : "FAIL"} ${label}: got ${got ?? "none"}, want ${want ?? "none"}`);
	}
	console.log(`role-check selftest: ${cases.length - failed}/${cases.length} ok`);
	process.exit(failed === 0 ? 0 : 1);
}

function ompSource(): string {
	if (process.env.OMP_SRC) return process.env.OMP_SRC;
	const executable = Bun.which("omp");
	if (!executable) throw new Error("omp not found on PATH; install omp or set OMP_SRC to its source directory");
	for (let dir = dirname(realpathSync(executable)); ; dir = dirname(dir)) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "@oh-my-pi/pi-coding-agent") {
			const src = join(dir, "src");
			if (existsSync(src)) return src;
			throw new Error(`${executable} belongs to omp but ${src} is missing; set OMP_SRC to its source directory`);
		}
		if (dirname(dir) === dir) break;
	}
	throw new Error(`cannot locate the omp package for ${executable}; set OMP_SRC to its source directory`);
}

let src: string;
try {
	src = ompSource();
} catch (err) {
	console.log(`RED ${(err as Error).message}`);
	process.exit(0);
}

let omp: OmpModules;
try {
	const loaded = await Promise.all([
		import(`${src}/config/settings`),
		import(`${src}/config/model-registry`),
		import(`${src}/sdk`),
		import(`${src}/config/model-resolver`),
		import(`${src}/session/settings`),
	]);
	// Loaded from a runtime path, so the compiler cannot see omp's types; OmpModules names the slice used.
	omp = Object.assign({}, ...loaded) as unknown as OmpModules;
} catch (err) {
	console.log(`RED cannot load omp internals from ${src}: ${(err as Error).message.split("\n")[0]}`);
	process.exit(0);
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const name = (m: RoleModel) => `${m.provider}/${m.id}`;

const settings = await omp.Settings.loadReadOnly({ cwd: process.cwd() });
const auth = await omp.discoverAuthStorage(undefined, { settings });
try {
	const registry = new omp.ModelRegistry(auth, undefined, { settings });
	await registry.refresh("online-if-uncached");
	const pool = registry.getAvailable();
	const roles = Object.entries(settings.getModelRoles() ?? {});
	if (roles.length === 0) {
		console.log("GREEN no modelRoles set (omp built-in defaults)");
		process.exit(0);
	}
	const dumps = await loadDumps(process.env.OMP_PROFILE ?? "default");
	const quota = typeof dumps.own === "string" ? dumps.own : exhaustedProviders(dumps.own, dumps.all);
	const blockedUntil = (m: RoleModel) => (typeof quota === "string" ? undefined : quota.get(m.provider));
	const retry = omp.cfgRetry.get(settings);
	const fallbackOn = retry.enabled && retry.modelFallback;
	let tags: Set<string> | undefined | null = null;
	const red: string[] = [];
	const warn: string[] = [];
	const ok: string[] = [];
	for (const [role, selector] of roles) {
		const primary = omp.resolveModelRoleValue(selector, pool, { settings }).model;
		const chain = omp.resolveRoleChain(role, settings, pool).map(c => c.model);
		const withQuota = chain.find(m => blockedUntil(m) === undefined);
		if (!primary) {
			const first = chain[0];
			const firstUntil = first ? blockedUntil(first) : undefined;
			if (!first) red.push(`${role}=${selector} does not resolve and has no fallback`);
			else if (firstUntil === undefined) warn.push(`${role}=${selector} does not resolve; runs ${name(first)} instead`);
			else if (fallbackOn && withQuota)
				warn.push(
					`${role}=${selector} does not resolve; runs ${name(first)} (quota exhausted until ${iso(firstUntil)}), then ${name(withQuota)}`,
				);
			else
				red.push(
					`${role}=${selector} does not resolve; runs ${name(first)} instead, whose quota is exhausted until ${iso(firstUntil)}`,
				);
			continue;
		}
		const id = name(primary);
		if (primary.provider === "ollama") {
			if (tags === null) tags = ollamaTags();
			if (tags === undefined) {
				red.push(`${role}=${id}: ollama list failed; cannot confirm the tag`);
				continue;
			}
			if (!tags.has(primary.id)) {
				red.push(
					`${role}=${id}: in this profile's cached catalog but not in ollama list; calls 404 (refresh: omp models refresh ollama)`,
				);
				continue;
			}
		}
		const until = blockedUntil(primary);
		if (until !== undefined) {
			if (fallbackOn && withQuota && name(withQuota) !== id)
				warn.push(`${role}=${id}: ${primary.provider} quota exhausted until ${iso(until)}; falls back to ${name(withQuota)}`);
			else
				red.push(
					`${role}=${id}: ${primary.provider} quota exhausted until ${iso(until)}; calls are refused (${fallbackOn ? "no fallback has quota" : !retry.enabled ? "retry.enabled off" : "retry.modelFallback off"})`,
				);
			continue;
		}
		ok.push(`${role}=${id}`);
	}
	const note = typeof quota === "string" ? ` [quota not checked: ${quota}]` : "";
	if (red.length > 0) console.log(`RED ${[...red, ...warn].join("; ")}${note}`);
	else if (warn.length > 0) console.log(`WARN ${warn.join("; ")}${note}`);
	else console.log(`GREEN every modelRole resolves: ${ok.join(" ")}${note}`);
} finally {
	auth.close();
}
