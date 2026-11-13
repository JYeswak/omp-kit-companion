import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const base = ownedTmp("preflight-ovnfs-test").path;
const kitScripts = new URL("../../scripts/", import.meta.url).pathname;

const MARKER = "OVNFS_SOURCE_MARKER_1ra0d_238";
const REQUIRED_MEMBERS = [
	"50-omp-kit-staged-tempsafe",
	"51-omp-kit-staged-kitlib",
	"54-omp-kit-staged-portable-paths",
	"55-omp-kit-staged-wallclock",
];

function cleanEnv(path: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined) env[key] = value;
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
		delete env[key];
	env["GIT_CEILING_DIRECTORIES"] = base;
	env["PATH"] = path;
	return { ...env, ...extra };
}

function pathWithoutOvnfs(): string {
	return (process.env["PATH"] ?? "").split(delimiter).filter((part) => {
		if (!part) return false;
		try {
			return !existsSync(join(part, "ovnfs"));
		} catch {
			return true;
		}
	}).join(delimiter);
}

async function git(cwd: string, args: string[], env: Record<string, string>): Promise<void> {
	const result = await runFixtureAsync(["git", ...args], { cwd, env, floor_s: 60, label: "git" });
	if (result.rc !== 0)
		throw new Error("git " + args.join(" ") + " -> " + result.rc + ": " + new TextDecoder().decode(result.stderr));
}

async function initRepo(dir: string, env: Record<string, string>): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await git(dir, ["init", "-q"], env);
	await git(dir, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "root [test]"], env);
}

async function setupPair(name: string): Promise<{ checkout: string; withOvnfs: Record<string, string>; withoutOvnfs: Record<string, string> }> {
	const root = join(base, name);
	const seedEnv = cleanEnv(process.env["PATH"] ?? "", { GIT_CEILING_DIRECTORIES: base });
	const source = join(root, "source");
	const checkout = join(root, "checkout");
	await initRepo(source, seedEnv);
	await initRepo(checkout, seedEnv);
	const chain = join(source, ".git", "hooks", "hooks.d", "pre-commit");
	mkdirSync(chain, { recursive: true });
	for (const member of REQUIRED_MEMBERS) {
		const body = member === REQUIRED_MEMBERS[0]
			? "#!/bin/sh\nprintf '%s\\n' '" + MARKER + "'\nexit 0\n"
			: "#!/bin/sh\nexit 0\n";
		writeFileSync(join(chain, member), body);
		chmodSync(join(chain, member), 0o755);
	}
	const runner = join(source, ".git", "hooks", "pre-commit");
	writeFileSync(runner, "#!/bin/sh\nexit 0\n");
	chmodSync(runner, 0o755);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const stub = join(bin, "ovnfs");
	writeFileSync(stub, "#!/bin/sh\nprintf '%s' \"$OVNFS_JSON\"\n");
	chmodSync(stub, 0o755);
	writeFileSync(join(checkout, "probe.txt"), "probe\n");
	const listing = JSON.stringify({ checkouts: [{ name: name + "-checkout", path: checkout, source }] });
	const withOvnfs = cleanEnv(bin + delimiter + (process.env["PATH"] ?? ""), { OVNFS_JSON: listing });
	const withoutOvnfs = cleanEnv(pathWithoutOvnfs());
	return { checkout, withOvnfs, withoutOvnfs };
}

async function runPreflight(checkout: string, env: Record<string, string>): Promise<{ rc: number; text: string }> {
	const result = await runFixtureAsync(
		["python3", "-B", join(kitScripts, "commit-preflight.py"), "--files", "probe.txt"],
		{ cwd: checkout, env, floor_s: 60, label: "commit-preflight" },
	);
	const decode = new TextDecoder();
	return { rc: result.rc, text: decode.decode(result.stdout) + decode.decode(result.stderr) };
}

test("preflight ovnfs fallback uses the source hooks chain", { timeout: fixtureDeadlineS(90) * 1000 }, async () => {
	const { checkout, withOvnfs } = await setupPair("fallback");
	const { rc, text } = await runPreflight(checkout, withOvnfs);
	expect(text).toContain("installed-gate: using source hooks ");
	expect(text).toContain(MARKER);
	expect(text).not.toContain("no installed hook chain");
	expect(rc).toBe(0);
});

test("preflight without ovnfs keeps the exact no-chain UNKNOWN", { timeout: fixtureDeadlineS(90) * 1000 }, async () => {
	const { checkout, withoutOvnfs } = await setupPair("negative");
	const { rc, text } = await runPreflight(checkout, withoutOvnfs);
	expect(text).toContain("UNKNOWN installed-gate: no installed hook chain");
	expect(text).not.toContain(MARKER);
	expect(rc).toBe(0);
});
