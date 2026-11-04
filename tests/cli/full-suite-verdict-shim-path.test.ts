// SUITESHIMPATH1 (ompkit-774u.60.1): a seat PATH with the omp-kit agent-bin br shim first turned every
// fixture br call red (bun_fail=99). full-suite-verdict.sh refuses that PATH before any identity or suite,
// and release-verdict.sh (the publisher's automatic path) strips the shim dir before calling the runner.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

const KIT = resolve(import.meta.dir, "../..");
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const scratch = ownedTmp("suiteshimpath", { bead: "ompkit-774u.60.1" });
const root = scratch.path;
afterAll(() => scratch.cleanup());

// The caller's PATH minus any shim, so bun/python3/git stay reachable whatever seat runs the test.
const cleanPath = (process.env.PATH ?? "").split(":").filter(d => d
	&& !d.endsWith("/.local/share/omp-kit/agent-bin") && !existsSync(join(d, "br-shim.sh"))).join(":");

const home = join(root, "home");
const agentBin = join(home, ".local/share/omp-kit/agent-bin");
mkdirSync(agentBin, { recursive: true });
copyFileSync(join(KIT, "scripts/br-shim.sh"), join(agentBin, "br"));
chmodSync(join(agentBin, "br"), 0o755);
// A second shim layout: a dir whose br links to some kit checkout's scripts/br-shim.sh.
const otherKit = join(root, "otherkit/scripts");
mkdirSync(otherKit, { recursive: true });
copyFileSync(join(KIT, "scripts/br-shim.sh"), join(otherKit, "br-shim.sh"));
const linkBin = join(root, "linkbin");
mkdirSync(linkBin);
symlinkSync(join(otherKit, "br-shim.sh"), join(linkBin, "br"));
const realBin = join(root, "realbin");
mkdirSync(realBin);
writeFileSync(join(realBin, "br"), "#!/bin/sh\necho real-br\n");
chmodSync(join(realBin, "br"), 0o755);

const env = (path: string) => ({
	PATH: path, HOME: home, TMPDIR: process.env.TMPDIR ?? root,
	XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
});
const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];

function git(cwd: string, ...args: string[]) {
	const r = runFixture(["git", "-C", cwd, ...args], { cwd, env: { ...env(cleanPath), GIT_CONFIG_GLOBAL: "/dev/null" } });
	expect(r.rc).toBe(0);
	return dec(r.stdout).trim();
}

describe("full-suite-verdict.sh refuses a shim-first PATH", () => {
	for (const [name, dir] of [["agent-bin", agentBin], ["br-shim.sh link", linkBin]] as const) {
		test(`planted (${name}): exit 2, FULL_SUITE_SHIM_PATH, no verdict record`, () => {
			const cache = join(root, `cache-${name.replace(/\W/g, "")}`);
			const r = runFixture(["sh", join(KIT, "scripts/full-suite-verdict.sh"), "--repo", KIT, "--commit", "HEAD",
				"--judge-role", "main", "--cache-dir", cache], { cwd: root, env: env(`${dir}:${cleanPath}`) });
			const err = dec(r.stderr);
			expect(r.rc).toBe(2);
			expect(err).toContain(`FULL_SUITE_SHIM_PATH: br resolves to ${dir}/br; remove ${dir} from PATH`);
			expect(err).not.toContain("FULL-SUITE: VERDICT");
			expect(tree(cache)).toEqual([]);
			expect(tree(join(root, "state"))).toEqual([]);
		});
	}

	test("control: a real br first passes the guard", () => {
		const r = runFixture(["sh", join(KIT, "scripts/full-suite-verdict.sh"), "--check-env"],
			{ cwd: root, env: env(`${realBin}:${cleanPath}`) });
		expect(dec(r.stderr)).not.toContain("FULL_SUITE_SHIM_PATH");
		expect(dec(r.stdout)).toContain(`FULL_SUITE_ENV: ok (br=${realBin}/br)`);
		expect(r.rc).toBe(0);
	});
});

describe("release-verdict.sh hands the runner a sanitized PATH", () => {
	function fixtureRepo(name: string, releaseVerdict: string): { repo: string; log: string } {
		const repo = join(root, name);
		mkdirSync(join(repo, "scripts"), { recursive: true });
		git(repo, "init", "-q", "--template=", "-b", "main");
		git(repo, "config", "user.email", "t@example.invalid");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "scripts/release-verdict.sh"), releaseVerdict);
		copyFileSync(join(KIT, "scripts/kitlib-tmp.sh"), join(repo, "scripts/kitlib-tmp.sh"));
		const log = join(root, `${name}.path`);
		// The stub runner records the PATH it was handed and the br it would use.
		writeFileSync(join(repo, "scripts/full-suite-verdict.sh"),
			`#!/bin/sh\nprintf '%s\\n' "$PATH" >"${log}"\ncommand -v br >>"${log}" || :\n`);
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "[test] fixture");
		return { repo, log };
	}
	const run = (repo: string) => runFixture(["sh", join(repo, "scripts/release-verdict.sh"), "--commit", "HEAD", "--no-fetch"],
		{ cwd: repo, env: env(`${agentBin}:${linkBin}:${realBin}:${cleanPath}`) });
	const sanitized = (log: string) => {
		const [path, br] = readFileSync(log, "utf8").trim().split("\n");
		const dirs = (path ?? "").split(":");
		return !dirs.includes(agentBin) && !dirs.includes(linkBin) && br === join(realBin, "br");
	};

	const source = readFileSync(join(KIT, "scripts/release-verdict.sh"), "utf8");

	test("shim dirs removed, log line printed", () => {
		const { repo, log } = fixtureRepo("rv", source);
		const r = run(repo);
		expect(r.rc).toBe(0);
		expect(dec(r.stdout)).toContain(`release-verdict: PATH sanitized (removed ${agentBin}:${linkBin})`);
		expect(sanitized(log)).toBe(true);
	});

	test("planted negative: without the sanitize step the same check fails", () => {
		const start = source.indexOf("# SUITESHIMPATH1");
		const end = source.indexOf("GIT_DIR_ABS=");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const { repo, log } = fixtureRepo("rv-mutant", source.slice(0, start) + source.slice(end));
		const r = run(repo);
		expect(r.rc).toBe(0);
		expect(dec(r.stdout)).not.toContain("PATH sanitized");
		expect(sanitized(log)).toBe(false);
	});
});
