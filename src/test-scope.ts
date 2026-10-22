import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Finding } from "./diagnostics.ts";

type Runner = "bun" | "vitest" | "jest" | "pytest" | "cargo" | "go";
type RepoRow = {
	repo: string;
	runner: Runner;
	config: string | null;
	verdict: "PASS" | "FAIL" | "UNVERIFIED";
	reason: string;
	fix_proposal: string;
};

type FleetEntry = { repo?: unknown };

function readText(path: string): string {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
}
function runnerConfigPath(repo: string, runner: Runner): string | null {
	const names: Record<Runner, readonly string[]> = {
		bun: ["bunfig.toml"],
		vitest: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "package.json"],
		jest: ["jest.config.js", "jest.config.ts", "jest.config.mjs", "package.json"],
		pytest: ["pyproject.toml", "pytest.ini", "setup.cfg"],
		cargo: ["Cargo.toml"],
		go: ["go.mod"],
	};
	for (const name of names[runner]) {
		const candidate = join(repo, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
function runnerFor(repo: string): Runner | null {
	if (existsSync(join(repo, "bunfig.toml"))) return "bun";
	const packageText = readText(join(repo, "package.json")).toLowerCase();
	if (packageText.includes("jest")) return "jest";
	if (packageText.includes("vitest")) return "vitest";
	if (packageText.includes("bun test")) return "bun";
	if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "pytest.ini")) || existsSync(join(repo, "setup.cfg"))) return "pytest";
	if (existsSync(join(repo, "Cargo.toml"))) return "cargo";
	if (existsSync(join(repo, "go.mod"))) return "go";
	return null;
}
function checkRunner(repo: string, runner: Runner, config: string | null): RepoRow {
	const proposal = `Add var/agent-tmp and ${tmpdir()} exclusions to ${config ?? "the runner configuration"}; file a bead in ${repo}/.beads.`; // tempsafe: names system temp in advice text, creates nothing
	if (runner === "cargo" || runner === "go") {
		return { repo, runner, config, verdict: "PASS", reason: `${runner} package discovery does not collect files from repository scratch without a module/package manifest`, fix_proposal: "No action required." };
	}
	if (config === null) return { repo, runner, config, verdict: "FAIL", reason: "runner configuration is absent; scratch exclusion cannot be verified", fix_proposal: proposal };
	const source = readText(config);
	const scratch = source.includes("var/agent-tmp") || source.includes("var\\/agent-tmp");
	const systemTemp = source.includes(tmpdir()) || source.includes("/tmp/") || source.includes("/var/tmp/") || source.includes("/var/folders/") || source.includes("system-temp"); // tempsafe: matches config text against system temp, creates nothing
	if (scratch && systemTemp) {
		return { repo, runner, config, verdict: "PASS", reason: "runner configuration excludes repository scratch and system temporary paths", fix_proposal: "No action required." };
	}
	return { repo, runner, config, verdict: "FAIL", reason: `runner configuration does not exclude var/agent-tmp and system temp (${tmpdir()})`, fix_proposal: proposal }; // tempsafe: names system temp in a report reason, creates nothing
}

export function inspectTestScope(configPath = process.env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(process.env.HOME ?? "", ".config", "omp-kit", "fleet-watch.json")): Finding {
	let parsed: unknown;
	try { parsed = JSON.parse(readFileSync(configPath, "utf8")); }
	catch (error) {
		return { component: "test-scope", status: "UNVERIFIED", reason: `fleet config unavailable: ${error instanceof Error ? error.message : String(error)}`, recommended_action: "Provide a readable fleet-watch config, then rerun omp-kit doctor --scope test-scope --json.", evidence: { config: configPath, repos: [] } };
	}
	const entries: FleetEntry[] = [];
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		for (const key of ["sessions", "herdr"] as const) {
			const values = (parsed as Record<string, unknown>)[key];
			if (Array.isArray(values)) for (const value of values) if (value && typeof value === "object" && !Array.isArray(value)) entries.push(value as FleetEntry);
		}
	}
	const rows: RepoRow[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry.repo !== "string") continue;
		const repo = resolve(entry.repo);
		if (seen.has(repo)) continue;
		seen.add(repo);
		const runner = runnerFor(repo);
		if (!runner) continue;
		rows.push(checkRunner(repo, runner, runnerConfigPath(repo, runner)));
	}
	rows.sort((left, right) => left.repo.localeCompare(right.repo));
	const failed = rows.filter(row => row.verdict === "FAIL");
	return { component: "test-scope", status: failed.length ? "FAIL" : "OK", reason: failed.length ? `${failed.length} fleet test runner(s) lack scratch exclusions` : `Checked ${rows.length} fleet test runner(s); scratch boundaries are present`, recommended_action: failed.length ? failed[0]!.fix_proposal : "No action required.", evidence: { config: configPath, repos: rows, runner_count: rows.length, system_temp: tmpdir() } }; // tempsafe: reports system temp path as evidence, creates nothing
}
