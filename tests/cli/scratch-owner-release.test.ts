// SCRATCHOWNER1 (ompkit-ngq78): a dir made by `export TMPDIR=$(omp-kit scratch new ...)` is owned by a shell that is
// gone by the time the same agent releases it from another shell. Release is allowed when the recorded creator is dead
// and the caller is the same agent (and the same omp session when the record names one); a different agent, or any
// caller while a different live owner holds the dir, is still refused caller-not-owner.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultLiveness } from "../../src/scratch.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const companion = resolve(import.meta.dir, "../..");
const cliPath = join(companion, "src", "cli.ts");
const scratchParent = join(companion, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const owned: OwnedTmp[] = [];
afterEach(() => { for (const tmp of owned.splice(0)) tmp.cleanup(); });

function world(): { repo: string; home: string; root: string } {
	const tmp = ownedTmp("owner-release", { root: scratchParent });
	owned.push(tmp);
	const repo = join(tmp.path, "repo");
	const home = join(tmp.path, "home");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	return { repo, home, root: join(repo, "var", "agent-tmp") };
}

/**
 * Run the CLI detached from this test's process tree (reparented to launchd), as a fresh tool shell is: no ancestor
 * holds the test runner's omp session lease, so only the record's own identity can authorize.
 */
async function detached(args: string[], w: { repo: string; home: string; root: string }, agent: string, tag: string): Promise<{ code: number; envelope: Record<string, any> }> {
	const out = join(w.home, `${tag}.out`);
	const code = join(w.home, `${tag}.code`);
	const env = { ...process.env, HOME: w.home, XDG_STATE_HOME: join(w.home, "state"), OMP_KIT_SCRATCH_ROOTS: w.root, AGENT_NAME: agent };
	delete env.BR_ACTOR;
	delete env.BR_AGENT_NAME;
	const launcher = Bun.spawnSync(["sh", "-c", '( "$@" --json >"$OUT" 2>/dev/null; echo $? >"$CODE.tmp"; mv "$CODE.tmp" "$CODE" ) </dev/null >/dev/null 2>&1 &', "detach", process.execPath, cliPath, ...args],
		{ cwd: w.repo, env: { ...env, OUT: out, CODE: code }, stdout: "ignore", stderr: "ignore" });
	expect(launcher.exitCode).toBe(0);
	for (let attempt = 0; attempt < 600 && !existsSync(code); attempt++) await Bun.sleep(50);
	// The detached child is not ours to await (reparented on purpose), so its finished-file is the only signal.
	return { code: Number(readFileSync(code, "utf8").trim()), envelope: JSON.parse(readFileSync(out, "utf8")) };
}

async function created(w: { repo: string; home: string; root: string }): Promise<string> {
	const made = await detached(["scratch", "new", "--label", "ownr"], w, "AgentX", "new");
	expect(made.code).toBe(0);
	const dir = made.envelope.data.dir as string;
	expect(readFileSync(join(dir, ".owner"), "utf8")).toContain("AgentX");
	return dir;
}

test("the same agent releases from another shell once the creating shell is gone", async () => {
	const w = world();
	const dir = await created(w);
	const released = await detached(["scratch", "release", dir, "--bin", "throwaway", "--now"], w, "AgentX", "rel");
	expect(released.code).toBe(0);
	expect(existsSync(dir)).toBe(false);
}, 60_000);

test("a different agent is refused caller-not-owner", async () => {
	const w = world();
	const dir = await created(w);
	const refused = await detached(["scratch", "release", dir, "--bin", "throwaway", "--now"], w, "AgentY", "rel");
	expect(refused.code).not.toBe(0);
	expect(JSON.stringify(refused.envelope)).toContain("caller-not-owner");
	expect(existsSync(dir)).toBe(true);
}, 60_000);

test("the same agent is refused while a different live owner holds the dir", async () => {
	const w = world();
	const holder = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
	try {
		const start = defaultLiveness().processStart(holder.pid);
		expect(start).not.toBeNull();
		mkdirSync(w.root, { recursive: true });
		const dir = join(w.root, `ownr.${holder.pid}`);
		mkdirSync(dir, { mode: 0o700 });
		writeFileSync(join(dir, ".owner"), `pid=${holder.pid}\nprocess_start=${start}\nlabel=ownr\nrepo=${w.repo}\ncreated_at=${new Date().toISOString()}\nargv0=sleep\nagent=AgentX\n`);
		const refused = await detached(["scratch", "release", dir, "--bin", "throwaway", "--now"], w, "AgentX", "rel");
		expect(refused.code).not.toBe(0);
		expect(JSON.stringify(refused.envelope)).toContain("caller-not-owner");
		expect(existsSync(dir)).toBe(true);
	} finally {
		holder.kill();
	}
}, 60_000);
