/**
 * TOOLPIN1: a machine tool or library upgrade must account for every fleet
 * repo pin and every installed dependent. `upgrade-plan` refuses while a pin
 * is not covered by a bump plan; `upgrade-verify` starts every dependent
 * binary after the upgrade and names the ones that no longer start.
 */
import { join } from "node:path";
import { runSync } from "./kitlib/run.ts";

export type UpgradeRunResult = { code: number | null; signal?: string | null; stdout: string; stderr: string };
export type UpgradeRunner = (args: readonly string[], opts?: { timeoutMs?: number }) => UpgradeRunResult;
export type FileReader = (path: string) => string | null;

export interface RepoPin {
	repo: string;
	file: string;
	kind: "version-file" | "tool-versions" | "engines" | "packageManager" | "require-tool" | "rust-toolchain";
	version: string;
}

export interface DependentBinary { formula: string; binary: string }
export interface DependentFailure extends DependentBinary { reason: string }

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,99}$/;
const START_TIMEOUT_MS = 10_000;
const BREW_TIMEOUT_MS = 120_000;

/** Version files whose whole content pins one tool. */
const VERSION_FILES: Record<string, readonly string[]> = {
	bun: [".bun-version"],
	node: [".node-version", ".nvmrc"],
	python: [".python-version"],
	ruby: [".ruby-version"],
	go: [".go-version"],
};
const REQUIRE_TOOL_FILES = [".rch/config.toml", ".rch/rch.toml", "rch.toml"];

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every pin of `tool` that one repo declares. */
export function findRepoPins(repo: string, tool: string, read: FileReader): RepoPin[] {
	const pins: RepoPin[] = [];
	for (const file of VERSION_FILES[tool] ?? []) {
		const text = read(join(repo, file));
		const version = text?.trim().split("\n")[0]?.trim();
		if (version) pins.push({ repo, file, kind: "version-file", version });
	}
	const toolVersions = read(join(repo, ".tool-versions"));
	if (toolVersions) {
		for (const line of toolVersions.split("\n")) {
			const [name, version] = line.trim().split(/\s+/);
			if (name === tool && version) pins.push({ repo, file: ".tool-versions", kind: "tool-versions", version });
		}
	}
	const pkgText = read(join(repo, "package.json"));
	if (pkgText) {
		try {
			const pkg: unknown = JSON.parse(pkgText);
			if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
				if ("engines" in pkg && pkg.engines && typeof pkg.engines === "object" && tool in pkg.engines) {
					const version: unknown = Reflect.get(pkg.engines, tool);
					if (typeof version === "string") pins.push({ repo, file: "package.json", kind: "engines", version });
				}
				if ("packageManager" in pkg && typeof pkg.packageManager === "string" && pkg.packageManager.startsWith(`${tool}@`))
					pins.push({ repo, file: "package.json", kind: "packageManager", version: pkg.packageManager.slice(tool.length + 1) });
			}
		} catch {
			// Malformed package.json declares no readable pin.
		}
	}
	const requirePattern = new RegExp(`--require-tool[ =]${escapeRegex(tool)}@([^\\s"'\\]]+)`, "g");
	for (const file of REQUIRE_TOOL_FILES) {
		const text = read(join(repo, file));
		if (!text) continue;
		for (const match of text.matchAll(requirePattern)) pins.push({ repo, file, kind: "require-tool", version: match[1]! });
	}
	if (tool === "rust" || tool === "rustup") {
		for (const file of ["rust-toolchain.toml", "rust-toolchain"]) {
			const text = read(join(repo, file));
			const version = text?.match(/channel\s*=\s*"([^"]+)"/)?.[1] ?? (file === "rust-toolchain" ? text?.trim() : undefined);
			if (version) pins.push({ repo, file, kind: "rust-toolchain", version });
		}
	}
	return pins;
}

/** Installed Homebrew formulae that depend on `tool`. Null when brew cannot answer. */
export function installedDependents(tool: string, run: UpgradeRunner): string[] | null {
	const out = run(["brew", "uses", "--installed", "--recursive", tool], { timeoutMs: BREW_TIMEOUT_MS });
	if (out.code !== 0) return null;
	return out.stdout.split(/\s+/).filter((name) => name !== "").sort();
}

/** Executables each dependent formula links from its keg's top-level bin/sbin (never nested libexec helpers). */
export function dependentBinaries(formulae: readonly string[], run: UpgradeRunner): DependentBinary[] {
	const binaries: DependentBinary[] = [];
	for (const formula of formulae) {
		const out = run(["brew", "list", "--formula", formula], { timeoutMs: BREW_TIMEOUT_MS });
		if (out.code !== 0) continue;
		for (const path of out.stdout.split("\n")) {
			if (/\/Cellar\/[^/]+\/[^/]+\/s?bin\/[^/]+$/.test(path.trim())) binaries.push({ formula, binary: path.trim() });
		}
	}
	return binaries;
}

export type UpgradePlan =
	| { ok: true; pins: RepoPin[]; dependents: string[]; covered: RepoPin[] }
	| { ok: false; pins: RepoPin[]; dependents: string[]; uncovered: RepoPin[] };

/** Refuse while any pin's repo/file is not named by the bump plan. */
export function planUpgrade(pins: RepoPin[], dependents: string[], pinPlan: string | undefined): UpgradePlan {
	const plan = pinPlan ?? "";
	const uncovered = pins.filter((pin) => !plan.includes(join(pin.repo, pin.file)));
	if (uncovered.length) return { ok: false, pins, dependents, uncovered };
	return { ok: true, pins, dependents, covered: pins };
}

const LOAD_FAILURE = /Library not loaded|dyld|image not found|Symbol not found|cannot open shared object/i;

/**
 * Start every binary with --version. A binary that cannot be spawned, dies on
 * a signal, or reports a dynamic-loader error no longer starts; a plain
 * nonzero exit (it rejected --version) still proves it loaded.
 */
export function verifyDependents(binaries: readonly DependentBinary[], run: UpgradeRunner): DependentFailure[] {
	const failures: DependentFailure[] = [];
	for (const entry of binaries) {
		let out: UpgradeRunResult;
		try {
			out = run([entry.binary, "--version"], { timeoutMs: START_TIMEOUT_MS });
		} catch (error) {
			failures.push({ ...entry, reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const loadError = `${out.stderr}\n${out.stdout}`.split("\n").find((line) => LOAD_FAILURE.test(line));
		if (loadError) failures.push({ ...entry, reason: loadError.trim() });
		else if (out.signal) failures.push({ ...entry, reason: `killed by ${out.signal}` });
		else if (out.code === null) failures.push({ ...entry, reason: "did not exit within 10s" });
	}
	return failures;
}

export const defaultUpgradeRunner: UpgradeRunner = (args, opts) => {
	const out = runSync(args, { deadline_s: (opts?.timeoutMs ?? START_TIMEOUT_MS) / 1000 });
	const decoder = new TextDecoder();
	const signalled = !out.timed_out && out.rc !== null && out.rc < 0;
	return {
		code: out.timed_out || out.rc === null || out.rc < 0 ? null : out.rc,
		signal: signalled ? `signal ${-out.rc!}` : null,
		stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr),
	};
};
