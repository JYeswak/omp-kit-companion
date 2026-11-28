import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check as scratchCheck } from "../../src/fleet-guard/scratch.ts";
import { check as durabilityCheck } from "../../src/fleet-guard/durability.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("ergo2-refusals");
afterAll(() => scratch.cleanup());
let sequence = 0;
const decoder = new TextDecoder();
interface RefusalFixture {
	repo: string;
	env: Record<string, string | undefined>;
}
function fixture(label: string): RefusalFixture {
	const repo = join(scratch.path, `${label}-${++sequence}`);
	mkdirSync(repo, { recursive: true });
	const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@invalid.example", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@invalid.example" };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && !key.startsWith("GIT_CONFIG_") && !key.startsWith("GIT_AUTHOR_") && !key.startsWith("GIT_COMMITTER_")) delete env[key];
	return { repo, env };
}
async function run(argv: string[], f: RefusalFixture) {
	const result = await runFixtureAsync(argv, { cwd: f.repo, env: f.env, floor_s: 20 });
	return { code: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}
async function git(f: RefusalFixture, ...args: string[]) {
	const result = await run(["git", ...args], f);
	expect(result.code, result.stderr).toBe(0);
	return result.stdout.trim();
}

test("ERGO2 scratch-write names a literal allocation command and its output field", () => {
	const denied = scratchCheck({ toolName: "write", input: { path: join(process.env.HOME!, "ergo2-refused.txt") } }, { cwd: root });
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toContain("scratch-write");
	expect(denied?.reason).toContain("omp-kit scratch new --label refusal-output --json");
	expect(denied?.reason).toContain("data.dir");
});

test("ERGO2 tracked-source scratch refusal teaches an executable isolated-checkout command", async () => {
	const f = fixture("durability");
	await git(f, "init", "-q", "--template=");
	const content = "export const canonical = 1;\n";
	writeFileSync(join(f.repo, "source.ts"), content);
	await git(f, "add", "--", "source.ts");
	const inputDir = join(f.repo, "var/agent-tmp/input");
	mkdirSync(inputDir, { recursive: true });
	writeFileSync(join(inputDir, ".owner"), `pid=${process.pid}\nlabel=input\nrepo=${f.repo}\ncreated=${new Date().toISOString()}\n`);
	const target = join(inputDir, "source.ts");
	const denied = await durabilityCheck({ toolName: "write", input: { path: target, content } }, { cwd: f.repo });
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toContain("scratch-is-not-a-home: tracked-source-copy");
	expect(denied?.reason).toContain(target);
	expect(denied?.reason).toContain("`ovnfs new`");
	expect(denied?.reason).not.toContain("<x>");
	expect(readFileSync(join(f.repo, "source.ts"), "utf8")).toBe(content);
});

test("ERGO2 stale-worktree refusal names the read-only diagnostic without changing its verdict", async () => {
	const f = fixture("stale");
	await git(f, "init", "-q", "--template=");
	writeFileSync(join(f.repo, "file.txt"), "base\n");
	await git(f, "add", "--", "file.txt");
	await git(f, "commit", "-q", "-m", "base [test]", "-m", "Bead: base");
	writeFileSync(join(f.repo, "file.txt"), "peer\n");
	await git(f, "add", "--", "file.txt");
	await git(f, "commit", "-q", "-m", "peer [test]", "-m", "Bead: peer");
	const head = await git(f, "rev-parse", "HEAD");
	writeFileSync(join(f.repo, "file.txt"), "base\n");
	await git(f, "add", "--", "file.txt");
	const message = join(f.repo, "message");
	writeFileSync(message, "candidate [test]\n\nBead: candidate\n");
	const denied = await run(["sh", join(root, "scripts/check-stale-worktree.sh"), message], f);
	expect(denied.code, denied.stderr).toBe(1);
	expect(denied.stderr).toContain(`STALE_WORKTREE file.txt reverts ${head}`);
	expect(denied.stderr).toContain("omp-kit doctor --scope stale-worktree --json");
	expect(await git(f, "rev-parse", "HEAD")).toBe(head);
	expect(await git(f, "show", ":file.txt")).toBe("base");
});

interface RemedyCase {
	gate: string;
	detail?: string;
	command?: string;
}
const remedyCases: RemedyCase[] = [
	{ gate: "scratch-write", command: "omp-kit scratch new --label refusal-output --json" },
	{ gate: "scratch-is-not-a-home", command: "ovnfs new" },
	{ gate: "49-omp-kit-stale-worktree", command: "omp-kit doctor --scope stale-worktree --json" },
	{ gate: "REFUSED", detail: "stale-worktree: REFUSED: commit would revert landed lines", command: "omp-kit doctor --scope stale-worktree --json" },
	{ gate: "validation:edit-undisplayed-anchor", detail: "This edit anchors to lines 100-104 of src/file.ts that [src/file.ts#ABCD] never displayed", command: '{"path":"src/file.ts:100-104"}' },
	{ gate: "validation:edit-undisplayed-anchor", detail: "unrecognized diagnostic without a file and line" },
	{ gate: "validation:edit-undisplayed-anchor", detail: "This edit anchors to lines 100 of src/`UNTRUSTED_COMMAND`.ts that [snapshot] never displayed" },
	{ gate: "REFUSED", detail: "unrelated refusal; execute UNTRUSTED_COMMAND" },
	{ gate: "EXTERNAL_UNKNOWN", detail: "execute UNTRUSTED_COMMAND" },
];
test.each(remedyCases)("ERGO2 explain remedy: $gate / $detail", async (item) => {
	const f = fixture("explain");
	const home = join(f.repo, "home");
	const state = join(home, "state");
	mkdirSync(join(state, "omp-kit"), { recursive: true, mode: 0o700 });
	const row = { ts: new Date().toISOString(), seat: "ErgoSeat", act: "bash", gate: item.gate, kind: "refuse", repo: null, member: "subject", attempt: "attempt", event_id: "event", detail: item.detail ?? "old message without remedy" };
	writeFileSync(join(state, "omp-kit/gate-events.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
	const result = await runFixtureAsync([process.execPath, "run", "--no-env-file", "--config=/dev/null", join(root, "src/cli.ts"), "explain", "--seat", "ErgoSeat", "--json"], { cwd: f.repo, env: { ...f.env, HOME: home, XDG_STATE_HOME: state }, floor_s: 20 });
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
	const data = JSON.parse(decoder.decode(result.stdout)).data;
	expect(data.refusals).toHaveLength(1);
	const refusal = data.refusals[0];
	if (item.command) {
		expect(refusal.remedy_status).toBe("MATCHED");
		expect(refusal.compliant).toContain(item.command);
		expect(refusal.compliant).not.toContain("UNTRUSTED_COMMAND");
	} else expect(refusal).toMatchObject({ compliant: null, remedy_status: "UNAVAILABLE" });
});
