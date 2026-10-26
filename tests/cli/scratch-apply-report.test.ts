// ompkit-774u.15 SCRATCHBIN1 C and D through the real CLI: `scratch mine` lists the caller's own dirs and what each still
// owes, and `scratch apply` prints the gap report.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

interface Envelope { ok: boolean; data: Record<string, unknown>; errors?: { code: string }[] }

// The CLI runs as a seat (ompkit-z31zh): `scratch mine` charges only exact ownership, so the caller's own dir is one whose
// owner names the caller's agent and an omp session lease it holds. Each CLI process opens the session lease itself and
// names its agent, so successive invocations are the same seat, as a respawned omp session is.
const AGENT = "ScratchMineSeat";
// A lease id no real omp seat holds, so a host further up this test's ancestry cannot be mistaken for it.
const SESSION = "0f0f0f0f-bbbb-7ccc-8ddd-eeeeffff0001";

function world(): { root: string; home: string; env: Record<string, string> } {
	const root = ownedTmp("cli-bins", { root: scratchParent }).path;
	const home = ownedTmp("cli-bins-home", { root: scratchParent }).path;
	mkdirSync(join(home, "state"), { recursive: true });
	mkdirSync(join(home, "session-owners"));
	const lock = join(home, "session-owners", `${SESSION}.lock`);
	writeFileSync(lock, "");
	const env = { ...process.env as Record<string, string>, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config"),
		OMP_KIT_SCRATCH_ROOTS: root, OMP_KIT_OMP_SRC_FETCH: "0", OMP_KIT_FLEET_WATCH_CONFIG: join(home, "absent.json"),
		AGENT_NAME: AGENT, LOCK: lock, BUN: process.execPath, CLI: join(repo, "src", "cli.ts") };
	return { root, home, env };
}
async function cli(env: Record<string, string>, ...args: string[]): Promise<{ code: number; envelope: Envelope }> {
	const child = await run(["sh", "-c", `exec 9<>"$LOCK"; exec "$BUN" run "$CLI" "$@"`, "sh", ...args, "--json"], { env, deadline_s: 120 });
	return { code: child.rc ?? -1, envelope: JSON.parse(new TextDecoder().decode(child.stdout)) as Envelope };
}
const plant = (root: string, name: string, owner: string): string => {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(join(dir, "work.txt"), "work");
	writeFileSync(join(dir, ".owner"), owner);
	return dir;
};
// An unseated process owner is reclaimable only when its recorded incarnation is known dead.
const ownerOf = (pid: number, label: string, extra = "") => `pid=${pid}\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=${label}\nrepo=${repo}\ncreated_at=2026-10-18T17:00:00Z\nargv0=test\n${extra}`;
// The caller's seat: its agent and the session lease it holds, whatever pid created the dir.
const seatOf = (label: string, extra = "") => ownerOf(59310, label, `agent=${AGENT}\nsession=${SESSION}\n${extra}`);

test("scratch mine lists the caller's own dirs by seat with state and bin, reports FINDINGS while one is unreleased, and never lists another owner's or an ancestor's", async () => {
	const { root, env } = world();
	plant(root, "mine.1", seatOf("mine"));
	plant(root, "theirs.59302", ownerOf(59302, "theirs"));
	// The CLI's parent (this test process) is an ancestor, never the caller (ompkit-z31zh).
	plant(root, "parent.2", ownerOf(process.pid, "parent"));
	plant(root, "other-seat.3", ownerOf(59311, "other-seat", `agent=OtherSeat\nsession=${SESSION}\n`));
	const first = await cli(env, "scratch", "mine");
	expect(first.code).toBe(0);
	expect(first.envelope.data).toMatchObject({ overall: "FINDINGS", unreleased: 1, dirs: [{ label: "mine", state: "unreleased", bin: "unbinned" }] });

	const released = await cli(env, "scratch", "release", join(root, "mine.1"), "--bin", "throwaway");
	expect(released.envelope.data).toMatchObject({ action: "RELEASED", changed: true, bin: "throwaway", ref: null });
	const second = await cli(env, "scratch", "mine");
	expect(second.envelope.data).toMatchObject({ overall: "OK", unreleased: 0, dirs: [{ label: "mine", state: "released", bin: "throwaway" }] });
	// A hold whose expiry has passed is owed again: it is flagged, never reaped.
	plant(root, "lapsed.59303", seatOf("lapsed", "bin=hold\nbead=ompkit-774u.15\nexpires=2026-01-05\n").replace("created_at=2026-10-18T17:00:00Z", "created_at=2026-01-01T00:00:00Z"));
	const third = await cli(env, "scratch", "mine");
	expect(third.envelope.data).toMatchObject({ overall: "FINDINGS", unreleased: 1 });
	expect(third.envelope.data.dirs).toMatchObject([{ label: "lapsed", state: "hold-expired", bin: "hold" }, { label: "mine", state: "released" }]);
}, 180_000);

test("scratch apply prints the gap report for what it reclaimed and the CLI schema lists mine", async () => {
	const { root, env } = world();
	const dir = plant(root, "gone.59301", ownerOf(59301, "gone"));
	const applied = await cli(env, "scratch", "apply", "--apply", "--yes");
	const report = applied.envelope.data.gapReport as { rows: { label: string; class: string; guard: string; bin: string }[]; by_class: Record<string, { count: number }> };
	expect(report.rows).toMatchObject([{ label: "gone", class: "pid-keyed-owner-never-released", guard: "ompkit-774u.9.3", bin: "unbinned" }]);
	expect(report.by_class["pid-keyed-owner-never-released"]).toMatchObject({ count: 1 });
	expect(existsSync(dir)).toBe(false);
	const help = Bun.spawnSync([process.execPath, "run", join(repo, "src", "cli.ts"), "help", "scratch"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	expect(help.stdout.toString()).toContain("scratch mine");
}, 180_000);

test("scratch apply without --file-gaps prints the exact filing commands and files nothing", async () => {
	const { root, home, env } = world();
	plant(root, "gone.59301", ownerOf(59301, "gone"));
	const stale = join(root, "stale.1");
	mkdirSync(stale);
	writeFileSync(join(stale, "work.txt"), "work");
	const old = new Date("2026-10-01T00:00:00Z");
	utimesSync(stale, old, old);
	utimesSync(join(stale, "work.txt"), old, old);
	const applied = await cli(env, "scratch", "apply", "--apply", "--yes");
	const commands = applied.envelope.data.gapFileCommands as string[];
	expect(commands).toHaveLength(1);
	expect(commands[0]).toContain("br comments add ompkit-774u.9.3");
	expect(commands[0]).toContain("pid-keyed-owner-never-released");
	expect(JSON.stringify(commands)).not.toContain("NO GUARD");
	expect(applied.envelope.data).not.toHaveProperty("gapFiled");
	const log = join(home, "state", "omp-kit", "scratch-reap-log.jsonl");
	expect(readFileSync(log, "utf8")).not.toContain("gap_filed");
}, 180_000);

test("scratch mine counts over-budget dirs: a dir past its declared budget is flagged, an unbounded or fitting dir is not", async () => {
	const { root, env } = world();
	plant(root, "over.1", seatOf("over", "budget=10\n"));
	plant(root, "fit.2", seatOf("fit", "budget=100000\n"));
	plant(root, "free.3", seatOf("free"));
	const mined = await cli(env, "scratch", "mine");
	expect(mined.envelope.data).toMatchObject({ overBudget: 1 });
	const byLabel = Object.fromEntries((mined.envelope.data.dirs as { label: string; overBudget: boolean; budget: number | null }[]).map((row) => [row.label, row]));
	expect(byLabel.over).toMatchObject({ overBudget: true, budget: 10 });
	expect(byLabel.fit).toMatchObject({ overBudget: false, budget: 100000 });
	expect(byLabel.free).toMatchObject({ overBudget: false, budget: null });
}, 180_000);

test("scratch mine --at logs one flag row naming only the caller's owed dirs; a plain mine, a clean mine and the session dir log nothing", async () => {
	const { root, home, env } = world();
	const log = join(home, "state", "omp-kit", "scratch-reap-log.jsonl");
	const flags = (): Record<string, unknown>[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [])
		.filter((row) => row.event === "flag");
	plant(root, "owed.1", seatOf("owed"));
	plant(root, "theirs.59304", ownerOf(59304, "theirs"));
	plant(root, "omp.59305", seatOf("omp", "bin=throwaway\n"));
	expect((await cli(env, "scratch", "mine")).code).toBe(0);
	expect(flags()).toEqual([]);
	const flagged = await cli(env, "scratch", "mine", "--at", "review");
	expect(flagged.envelope.data).toMatchObject({ overall: "FINDINGS", unreleased: 1 });
	expect(flags()).toMatchObject([{ point: "review", dirs: [{ dir: join(root, "owed.1"), state: "unreleased", bin: "unbinned" }] }]);
	expect(JSON.stringify(flags())).not.toContain("theirs");
	expect(JSON.stringify(flags())).not.toContain("omp.59305");
	// planted negatives: an unknown point is refused without logging, and a clean caller logs nothing
	const refused = await cli(env, "scratch", "mine", "--at", "whenever");
	expect(refused.envelope.errors?.[0]?.code).toBe("SCRATCH_MINE_POINT_INVALID");
	expect(flags()).toHaveLength(1);
	await cli(env, "scratch", "release", join(root, "owed.1"), "--bin", "throwaway");
	expect((await cli(env, "scratch", "mine", "--at", "close")).envelope.data).toMatchObject({ overall: "OK", unreleased: 0 });
	expect(flags()).toHaveLength(1);
}, 180_000);
