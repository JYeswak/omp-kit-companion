// PIDIDENT1 (ompkit-a0vy1) AC1: no authority decision rests on a pid. `scratch new` mints a release capability and
// returns it once; `.owner` keeps only its sha256. A later process presenting the token releases the dir whatever its
// seat or pid. Replays the 2026-10-22 incident: an eval kernel with no AGENT_NAME ran `scratch new` as a subprocess,
// got a pid owner naming that short-lived CLI, and every later `scratch release` was refused caller-not-owner.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pollUntil } from "../../src/kitlib/poll.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { parseOwnerFile } from "../../src/scratch.ts";

const companion = resolve(import.meta.dir, "../..");
const cliPath = join(companion, "src", "cli.ts");
const scratchParent = join(companion, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const HAVE_LSOF = Bun.which("lsof") !== null;
// Lease ids no real seat holds, so an omp host up this test's own ancestry cannot be mistaken for them.
const SESSION = "0c0c0c0c-aaaa-7bbb-8ccc-a0a0a0a0a0a1";
const OTHER_SESSION = "0c0c0c0c-aaaa-7bbb-8ccc-a0a0a0a0a0a2";

const owned: OwnedTmp[] = [];
afterEach(() => { for (const tmp of owned.splice(0)) tmp.cleanup(); });

interface World { repo: string; home: string; root: string; io: string; owners: string }

function world(): World {
	const tmp = ownedTmp("scratch-capability", { root: scratchParent });
	owned.push(tmp);
	const w = { repo: join(tmp.path, "repo"), home: join(tmp.path, "home"), root: "", io: join(tmp.path, "io"), owners: join(tmp.path, "leases", "session-owners") };
	w.root = join(w.repo, "var", "agent-tmp");
	for (const dir of [join(w.repo, ".git"), join(w.home, "state"), w.io, w.owners]) mkdirSync(dir, { recursive: true });
	for (const session of [SESSION, OTHER_SESSION]) writeFileSync(join(w.owners, `${session}.lock`), "");
	return w;
}

/** A tool-shell environment: no host agent unless one is given, no capability in the environment unless given. */
function envFor(w: World, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	for (const key of ["AGENT_NAME", "BR_ACTOR", "BR_AGENT_NAME", "OMP_KIT_SCRATCH_CAPABILITY"]) delete env[key];
	return { ...env, HOME: w.home, XDG_STATE_HOME: join(w.home, "state"), OMP_KIT_SCRATCH_ROOTS: w.root, ...extra };
}

type Envelope = { ok?: boolean; data?: Record<string, unknown>; errors?: { code: string; message: string; remediation: string }[] };

/** One CLI subprocess of the test runner (the eval-kernel shape): it exits before the next call starts. */
async function cli(w: World, args: string[], extra: Record<string, string> = {}, json = true): Promise<{ code: number | null; stdout: string; envelope: Envelope | null }> {
	const out = await run([process.execPath, cliPath, ...args, ...(json ? ["--json"] : [])], { cwd: w.repo, env: envFor(w, extra), deadline_s: 120 });
	const stdout = new TextDecoder().decode(out.stdout);
	let envelope: Envelope | null = null;
	try { envelope = JSON.parse(stdout) as Envelope; } catch { envelope = null; }
	return { code: out.rc, stdout, envelope };
}

/**
 * One CLI subprocess run as a seat: a fresh shell holding the omp session lease `session` (fd 9) and naming `agent`,
 * detached from this test's process tree before the CLI starts (its own process group, parent gone, so launchd
 * adopts it). The only lease in its ancestry is the planted one, whatever seat runs this test.
 */
let tag = 0;
async function seatCli(w: World, agent: string, session: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; envelope: Envelope }> {
	const id = `seat-${++tag}`;
	const out = join(w.io, `${id}.out`), done = join(w.io, `${id}.code`);
	const script = [
		"set -m",
		'launcher=$$',
		'( while kill -0 "$launcher" 2>/dev/null; do sleep 0.05; done',
		'  exec 9<>"$LOCK"',
		'  "$BUN" "$CLI" "$@" --json >"$OUT" 2>/dev/null </dev/null',
		'  echo $? >"$DONE.tmp"; mv "$DONE.tmp" "$DONE" ) </dev/null >/dev/null 2>&1 &',
	].join("\n");
	const launched = await run(["/bin/sh", "-c", script, "seat", ...args], { cwd: w.repo, deadline_s: 30,
		env: envFor(w, { ...extra, AGENT_NAME: agent, LOCK: join(w.owners, `${session}.lock`), BUN: process.execPath, CLI: cliPath, OUT: out, DONE: done }) });
	expect(launched.rc).toBe(0);
	const finished = await pollUntil(() => existsSync(done), { deadline_s: 120, interval_s: 0.05, classify: ready => ready ? "success" : "retry" });
	expect(finished.outcome).toBe("success");
	return { code: Number(readFileSync(done, "utf8").trim()), envelope: JSON.parse(readFileSync(out, "utf8")) as Envelope };
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function ownerOf(dir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(dir, ".owner"), "utf8")) as Record<string, unknown>;
}

/** Every regular file below `root` (symlinks not followed). */
function filesBelow(root: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) found.push(...filesBelow(path));
		else if (stat.isFile()) found.push(path);
	}
	return found;
}

/** `scratch new` from a non-seat subprocess (no AGENT_NAME): the incident's creation. */
async function unseatedNew(w: World, label: string): Promise<{ dir: string; capability: string }> {
	const made = await cli(w, ["scratch", "new", "--label", label]);
	expect(made.code, made.stdout).toBe(0);
	const dir = made.envelope?.data?.dir as string;
	const capability = made.envelope?.data?.capability as string;
	expect(capability).toMatch(/^[0-9a-f]{64}$/);
	const owner = ownerOf(dir);
	// The incident's record: no seat, only the pid of the `scratch new` CLI that has already exited.
	expect(owner.agent).toBeUndefined();
	expect(owner.session).toBeUndefined();
	expect(owner.capability_sha256).toBe(sha256(capability));
	return { dir, capability };
}

test("AC1 replay: a non-seat parent's `scratch new` subprocess, then `scratch release --capability` from a second subprocess, releases and deletes the dir", async () => {
	const w = world();
	const { dir, capability } = await unseatedNew(w, "replay");
	writeFileSync(join(dir, "work.bin"), "x".repeat(4096));
	// Without the token this is exactly the incident: the recorded pid is gone and the caller holds no seat.
	const before = await cli(w, ["scratch", "release", dir, "--bin", "throwaway", "--now"]);
	expect(before.code).not.toBe(0);
	expect(before.envelope?.errors?.[0]?.code).toBe("SCRATCH_RELEASE_REFUSED");
	expect(before.envelope?.errors?.[0]?.message).toContain("caller-not-owner");
	expect(before.envelope?.errors?.[0]?.remediation).toContain("--capability");
	expect(existsSync(dir)).toBe(true);
	const released = await cli(w, ["scratch", "release", dir, "--capability", capability, "--bin", "throwaway", "--now"]);
	expect(released.code, released.stdout).toBe(0);
	expect(released.envelope?.data).toMatchObject({ action: "RELEASED", deleted: true });
	expect(existsSync(dir)).toBe(false);
}, 180_000);

test("AC1 replay through the environment: OMP_KIT_SCRATCH_CAPABILITY releases like the flag", async () => {
	const w = world();
	const { dir, capability } = await unseatedNew(w, "replay-env");
	const released = await cli(w, ["scratch", "release", dir, "--bin", "throwaway", "--now"], { OMP_KIT_SCRATCH_CAPABILITY: capability });
	expect(released.code, released.stdout).toBe(0);
	expect(existsSync(dir)).toBe(false);
}, 180_000);

test("text mode returns the capability too", async () => {
	const w = world();
	const made = await cli(w, ["scratch", "new", "--label", "text-mode"], {}, false);
	expect(made.code).toBe(0);
	const data = JSON.parse(made.stdout) as { dir: string; capability: string };
	expect(ownerOf(data.dir).capability_sha256).toBe(sha256(data.capability));
	expect((await cli(w, ["scratch", "release", data.dir, "--capability", data.capability, "--bin", "throwaway", "--now"])).code).toBe(0);
}, 180_000);

test("negative: a wrong token, or another agent with no token, is refused caller-not-owner and the dir stays", async () => {
	const w = world();
	const { dir, capability } = await unseatedNew(w, "wrong-token");
	const wrong = capability.slice(0, -1) + (capability.endsWith("0") ? "1" : "0");
	for (const [args, extra, detail] of [
		[["--capability", wrong], {}, "does not match"],
		[["--capability", "not-a-token"], {}, "does not match"],
		[[], { OMP_KIT_SCRATCH_CAPABILITY: wrong }, "does not match"],
		[[], { AGENT_NAME: "SomeOtherAgent" }, "no capability was presented"],
	] as [string[], Record<string, string>, string][]) {
		const refused = await cli(w, ["scratch", "release", dir, ...args, "--bin", "throwaway", "--now"], extra);
		expect(refused.code).not.toBe(0);
		expect(refused.envelope?.errors?.[0]?.message).toContain("caller-not-owner");
		expect(refused.envelope?.errors?.[0]?.message).toContain(detail);
		expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
		expect(existsSync(dir)).toBe(true);
	}
	// The real token still works afterwards: refusals changed nothing.
	expect((await cli(w, ["scratch", "release", dir, "--capability", capability, "--bin", "throwaway", "--now"])).code).toBe(0);
}, 180_000);

test("negative: the token is written nowhere: not in the dir, the repo, or the state root after `scratch new`", async () => {
	const w = world();
	const { dir, capability } = await unseatedNew(w, "no-leak");
	const searched = [...filesBelow(w.repo), ...filesBelow(w.home)];
	expect(searched).toContain(join(dir, ".owner"));
	expect(searched.some(path => path.endsWith("scratch-budgets.json"))).toBe(true);
	for (const path of searched) expect({ path, leaked: readFileSync(path, "latin1").includes(capability) }).toEqual({ path, leaked: false });
	// Only the digest is recorded, and it is not the token.
	expect(readFileSync(join(dir, ".owner"), "utf8")).toContain(sha256(capability));
}, 180_000);

test("old records without capability_sha256 behave as before: a presented token authorizes nothing", async () => {
	const w = world();
	mkdirSync(w.root, { recursive: true });
	const dir = join(w.root, "legacy.59031");
	mkdirSync(dir);
	const record = `pid=59031\nlabel=legacy\nrepo=${w.repo}\ncreated=2026-10-18T17:32:44.000Z\n`;
	writeFileSync(join(dir, ".owner"), record);
	expect(parseOwnerFile(record)?.capabilitySha256).toBeNull();
	const refused = await cli(w, ["scratch", "release", dir, "--capability", "a".repeat(64), "--bin", "throwaway", "--now"]);
	expect(refused.code).not.toBe(0);
	expect(refused.envelope?.errors?.[0]?.message).toContain("caller-not-owner");
	expect(refused.envelope?.errors?.[0]?.message).not.toContain("capability");
	expect(existsSync(dir)).toBe(true);
}, 180_000);

test("owner records: capability_sha256 must be 64 lowercase hex digits", () => {
	const base = "pid=42\nlabel=a\nrepo=/r\ncreated=2026-10-18T17:32:44.000Z\n";
	expect(parseOwnerFile(`${base}capability_sha256=${"a".repeat(64)}\n`)?.capabilitySha256).toBe("a".repeat(64));
	for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`]) expect(parseOwnerFile(`${base}capability_sha256=${bad}\n`)).toBeNull();
});

test.skipIf(!HAVE_LSOF)("control and negatives on the seat path: the owning seat releases with no token; another agent or another session without the token is refused", async () => {
	const w = world();
	const made = await seatCli(w, "AgentX", SESSION, ["scratch", "new", "--label", "seat"]);
	expect(made.code).toBe(0);
	const dir = made.envelope.data?.dir as string;
	const capability = made.envelope.data?.capability as string;
	// The seat is recorded (agent and planted session together), and the dir still carries a capability.
	expect(ownerOf(dir)).toMatchObject({ agent: "AgentX", session: SESSION, capability_sha256: sha256(capability) });
	for (const [agent, session] of [["AgentY", SESSION], ["AgentX", OTHER_SESSION]] as const) {
		const refused = await seatCli(w, agent, session, ["scratch", "release", dir, "--bin", "throwaway", "--now"]);
		expect({ agent, session, released: refused.code === 0 }).toEqual({ agent, session, released: false });
		expect(refused.envelope.errors?.[0]?.message).toContain("caller-not-owner");
		expect(existsSync(dir)).toBe(true);
	}
	const released = await seatCli(w, "AgentX", SESSION, ["scratch", "release", dir, "--bin", "throwaway", "--now"]);
	expect(released.code).toBe(0);
	expect(released.envelope.data).toMatchObject({ action: "RELEASED", deleted: true });
	expect(existsSync(dir)).toBe(false);
}, 240_000);

test.skipIf(!HAVE_LSOF)("a seat-owned dir is also released by its capability from a different seat", async () => {
	const w = world();
	const made = await seatCli(w, "AgentX", SESSION, ["scratch", "new", "--label", "seat-cap"]);
	expect(made.code).toBe(0);
	const dir = made.envelope.data?.dir as string;
	const released = await seatCli(w, "AgentY", OTHER_SESSION, ["scratch", "release", dir, "--capability", made.envelope.data?.capability as string, "--bin", "throwaway", "--now"]);
	expect(released.code).toBe(0);
	expect(existsSync(dir)).toBe(false);
}, 240_000);
