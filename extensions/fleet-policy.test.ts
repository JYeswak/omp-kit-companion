import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fleetPolicyState } from "./fleet-policy";
import { ownedTmp } from "../src/kitlib/tmp.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helperPath = fileURLToPath(new URL("./fleet-policy.ts", import.meta.url));
const scratch = join(repository, "var", "agent-tmp");
mkdirSync(scratch, { recursive: true });
const owned = ownedTmp("fleet-policy-test", { root: scratch });
const base = owned.path;
afterAll(() => owned.cleanup());

function git(root: string, ...args: string[]): void {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
	const child = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null",
		"-c", "core.fsmonitor=false", ...args], {
		cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 2000,
	});
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
}

function repo(parent = base): string {
	const root = freshDir(parent, "repo-");
	git(root, "init");
	return root;
}

function policy(root: string, contents: string): void {
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "fleet.json"), contents);
}

test("stock policies need no Git or new files; explicit opt-in without Git is unavailable", () => {
	for (const enabled of [undefined, false, true]) {
		const root = repo();
		if (enabled !== undefined) policy(root, JSON.stringify({ enabled }));
		const before = readdirSync(root, { recursive: true }).sort();
		const noTools = freshDir(base, "no-tools-");
		const code = `import { fleetPolicyState } from ${JSON.stringify(helperPath)}; console.log(JSON.stringify(await fleetPolicyState(process.argv[1])));`;
		const child = Bun.spawnSync([process.execPath, "-e", code, root], {
			env: { ...process.env, PATH: noTools }, stdout: "pipe", stderr: "pipe", timeout: 3000,
		});
		expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: "" });
		const state = JSON.parse(child.stdout.toString());
		if (enabled === true) expect(state).toMatchObject({ kind: "unavailable", root });
		else expect(state).toEqual({ kind: "off", root });
		expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
	}
});

test("only a real nearest repository with explicit true enables fleet policy", async () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	const deep = join(root, "src", "deep");
	mkdirSync(deep, { recursive: true });
	expect(await fleetPolicyState(deep)).toEqual({ kind: "on", root });
	const nested = repo(root);
	expect(await fleetPolicyState(nested)).toEqual({ kind: "off", root: nested });
	policy(nested, '{"enabled":true}');
	expect(await fleetPolicyState(nested)).toEqual({ kind: "on", root: nested });
});

test("an invalid nested Git boundary defers to the nearest real repository", async () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	const fake = freshDir(root, "not-a-repo-");
	mkdirSync(join(fake, ".git"));
	expect(await fleetPolicyState(fake)).toEqual({ kind: "off", root: fake });
	policy(fake, '{"enabled":true}');
	// git ignores the empty `.git` directory, so the call is judged under the real
	// repository's own opt-in (APPLICSCRATCH1): the fake marker activates nothing by itself.
	expect(await fleetPolicyState(fake)).toEqual({ kind: "on", root });
	const plain = repo();
	const fake2 = freshDir(plain, "not-a-repo-");
	mkdirSync(join(fake2, ".git"));
	policy(fake2, '{"enabled":true}');
	expect(await fleetPolicyState(fake2)).toEqual({ kind: "off", root: plain });
});

test("a dead gitdir pointer plus marker stays unavailable without a verified state", async () => {
	// escape shape: a planted evil/.git pointer and marker inside an opted-in repo must not
	// switch the guard off (APPLICSCRATCH1, ompkit-1ra0d.127).
	const root = repo();
	policy(root, '{"enabled":true}');
	expect(await fleetPolicyState(root)).toEqual({ kind: "on", root });
	const evil = freshDir(root, "evil-");
	writeFileSync(join(evil, ".git"), "gitdir: /nonexistent/ovnfs/git/evil\n");
	policy(evil, '{"enabled":true}');
	expect(await fleetPolicyState(evil)).toMatchObject({ kind: "unavailable", root: evil });
	expect(await fleetPolicyState(root)).toEqual({ kind: "on", root });
});

test("a transient git failure retries once and succeeds", async () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	const bin = freshDir(base, "failonce-bin-");
	const failOnce = join(bin, "gitfailed");
	const git = process.env.PATH !== undefined && existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
	writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ ! -f "${failOnce}" ]; then touch "${failOnce}"; exit 128; fi\nexec ${git} "$@"\n`, { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
	try {
		expect(await fleetPolicyState(root)).toEqual({ kind: "on", root });
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
	}
	expect(existsSync(failOnce)).toBe(true);
});

test("a verified root keeps enforcing its policy while re-verification fails", async () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	expect(await fleetPolicyState(root)).toEqual({ kind: "on", root });
	renameSync(join(root, ".git"), join(root, ".git-hidden"));
	writeFileSync(join(root, ".git"), "gitdir: /nonexistent/ovnfs/git/broken\n");
	try {
		const state = await fleetPolicyState(root);
		expect(state.kind).toBe("on");
		expect(state).toMatchObject({ root });
		if (state.kind === "on") expect(state.notice).toContain("last verified policy");
	} finally {
		rmSync(join(root, ".git"));
		renameSync(join(root, ".git-hidden"), join(root, ".git"));
	}
	expect(await fleetPolicyState(root)).toEqual({ kind: "on", root });
});

test("malformed and unsupported enabled states are unavailable, never stock off", async () => {
	for (const contents of ["{", "null", "[]", "{}", '{"enabled":"false"}', '{"enabled":null}',
		'{"enabled":0}', '{"enabled":true,"version":2}', " ".repeat(16_385)]) {
		const root = repo();
		policy(root, contents);
		expect(await fleetPolicyState(root)).toMatchObject({ kind: "unavailable", root });
	}
});

test("invalid UTF-8 policy bytes and nonexistent cwd remain unavailable", async () => {
	const root = repo();
	mkdirSync(join(root, ".omp"));
	writeFileSync(join(root, ".omp", "fleet.json"), Buffer.from([0xff, 0xfe]));
	expect(await fleetPolicyState(root)).toMatchObject({ kind: "unavailable", root });
	const missing = join(root, "missing");
	expect(await fleetPolicyState(missing)).toMatchObject({ kind: "unavailable", root: missing });
});

test("inherited Git routing cannot redirect an explicit opt-in to another repository", () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	const foreign = repo();
	const code = `import { fleetPolicyState } from ${JSON.stringify(helperPath)}; console.log(JSON.stringify(await fleetPolicyState(process.argv[1])));`;
	const child = Bun.spawnSync([process.execPath, "-e", code, root], {
		env: { ...process.env, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign,
			GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" },
		stdout: "pipe", stderr: "pipe", timeout: 3000,
	});
	expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: "" });
	expect(JSON.parse(child.stdout.toString())).toEqual({ kind: "on", root });
});

test("directory, symlink, dangling symlink and invalid parent policy paths are unavailable", async () => {
	for (const shape of ["directory", "symlink", "dangling", "parent-link", "parent-file"]) {
		const root = repo();
		const target = join(root, "policy-target");
		writeFileSync(target, '{"enabled":false}');
		if (shape === "parent-link") {
			const config = freshDir(base, "config-");
			writeFileSync(join(config, "fleet.json"), '{"enabled":false}');
			symlinkSync(config, join(root, ".omp"));
		} else if (shape === "parent-file") writeFileSync(join(root, ".omp"), "not a directory");
		else {
			mkdirSync(join(root, ".omp"));
			const marker = join(root, ".omp", "fleet.json");
			if (shape === "directory") mkdirSync(marker);
			else symlinkSync(shape === "dangling" ? `${target}-missing` : target, marker);
		}
		expect(await fleetPolicyState(root)).toMatchObject({ kind: "unavailable", root });
	}
});

test("a symlink cwd resolves the physical nearest repository", async () => {
	const root = repo();
	policy(root, '{"enabled":true}');
	const alias = join(base, "repo-alias");
	symlinkSync(root, alias);
	expect(await fleetPolicyState(alias)).toEqual({ kind: "on", root });
});
