// `omp-kit save -m MSG -- PATH...` (ompkit-ypiyn SAVEVERB1 AC1): land with implied --apply --yes and one
// output line. Failure modes: a save that reports SAVED without origin holding the commit, a refused save
// that still publishes or commits, a save that leaves no save-log row for the p50 measure, and `--` leaking
// to commands that never take child arguments.
import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { cliPath, commandEnvironment, fixture, git, remoteHead, repoRoot, scratch, stringEnvironment } from "./private-index-land.helpers.ts";

const decoder = new TextDecoder();
const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];

function saveOnce(work: string, fakeBin: string, args: string[]) {
	const env = commandEnvironment(work, hold, { amDir: fakeBin });
	const result = runFixture(["bun", cliPath, "save", ...args], { cwd: work, env: stringEnvironment(env), floor_s: 60 });
	return { status: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

// The human line is `REFUSED OWNER_UNKNOWN: …`; --json carries the code as errors[0].code.
function ownerUnknown(stdout: string): boolean {
	if (stdout.split("\n").some(line => line.startsWith("REFUSED OWNER_UNKNOWN: "))) return true;
	let body: unknown;
	try { body = JSON.parse(stdout); } catch { return false; }
	if (!body || typeof body !== "object" || !("errors" in body) || !Array.isArray(body.errors)) return false;
	const first: unknown = body.errors[0];
	return !!first && typeof first === "object" && "code" in first && first.code === "OWNER_UNKNOWN";
}

// land resolves the pane owner with `am agents resolve-pane` under a fixed 10 s product timeout (src/land.ts
// spawnSync timeout: 10_000) and refuses OWNER_UNKNOWN, before any mutation, when it expires. The 2026-11-04
// 18:35Z commit-gate run (log 74fa3e9e…T183526Z) failed the moved-origin case here at 28591 ms with exactly that
// refusal. As in private-index-land-2b and -3b, save re-runs only on that pre-mutation refusal, inside a load-scaled
// budget; `retried` counts the refused runs, whose save-log rows the cases assert as REFUSED OWNER_UNKNOWN.
function save(work: string, fakeBin: string, args: string[]) {
	const until = Date.now() + fixtureDeadlineS(30) * 1000;
	let result = saveOnce(work, fakeBin, args);
	let retried = 0;
	while (result.status === 1 && ownerUnknown(result.stdout) && Date.now() < until) {
		retried++;
		result = saveOnce(work, fakeBin, args);
	}
	return { ...result, retried };
}

function saveLog(work: string): Record<string, unknown>[] {
	const path = join(work, ".git", "omp-kit", "save.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("save converges a moved origin, publishes, prints one SAVED line and logs the save", () => {
	const { work, fakeBin } = fixture();
	const peerWork = join(scratch, `save-peer-${globalThis.fixtureNumber++}`);
	git(scratch, ["clone", git(work, ["remote", "get-url", "origin"]).trim(), peerWork]);
	writeFileSync(join(peerWork, "remote.txt"), "peer origin advance\n");
	git(peerWork, ["add", "remote.txt"]);
	git(peerWork, ["commit", "-m", "peer origin advance [test]"]);
	git(peerWork, ["push", "origin", "HEAD:refs/heads/main"]);
	const peerTip = git(peerWork, ["rev-parse", "HEAD"]).trim();
	const localBase = git(work, ["rev-parse", "HEAD"]).trim();
	expect(remoteHead(work)).toBe(peerTip);
	expect(peerTip).not.toBe(localBase);

	writeFileSync(join(work, "owned.txt"), "saved by omp-kit save\n");
	const run = save(work, fakeBin, ["-m", "feat(save): publish reserved fixture [test]", "--", "owned.txt"]);
	expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
	const lines = run.stdout.split("\n").filter(Boolean);
	expect(lines.length, run.stdout).toBe(1);
	const match = /^SAVED ([0-9a-f]{40}) on origin in (\d+(?:\.\d)?) s$/.exec(lines[0] ?? "");
	expect(match, lines[0]).not.toBeNull();
	const published = match![1]!;
	expect(remoteHead(work)).toBe(published);
	// The published commit carries the owned change on top of the peer's commit, not over it.
	expect(git(work, ["merge-base", "--is-ancestor", peerTip, published]).trim()).toBe("");
	expect(git(work, ["show", `${published}:owned.txt`])).toBe("saved by omp-kit save\n");
	expect(git(work, ["show", `${published}:remote.txt`])).toBe("peer origin advance\n");

	const rows = saveLog(work);
	expect(rows.length).toBe(1 + run.retried);
	for (const row of rows.slice(0, run.retried)) expect(row).toMatchObject({ outcome: "REFUSED", code: "OWNER_UNKNOWN", sha: null });
	const savedRow = rows[run.retried]!;
	expect(savedRow).toMatchObject({ sha: published, outcome: "SAVED", code: "PUSHED" });
	expect(typeof savedRow.elapsed_s).toBe("number");
	expect(Number(savedRow.elapsed_s)).toBe(Number(match![2]));
	expect(typeof savedRow.ts).toBe("string");
	expect(typeof savedRow.repo).toBe("string");
}, { timeout: fixtureDeadlineS(180) * 1000 });

test("a failing commit hook refuses the save: nothing committed, nothing published, REFUSED line names land's code", () => {
	const { work, fakeBin } = fixture();
	const hook = join(work, ".git", "hooks", "pre-commit");
	writeFileSync(hook, "#!/bin/sh\necho 'planted commit-time check failure' >&2\nexit 1\n");
	chmodSync(hook, 0o755);
	const headBefore = git(work, ["rev-parse", "HEAD"]).trim();
	const originBefore = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "never committed\n");

	const run = save(work, fakeBin, ["-m", "feat(save): refused fixture [test]", "--", "owned.txt"]);
	expect(run.status, `${run.stdout}${run.stderr}`).toBe(1);
	const lines = run.stdout.split("\n").filter(Boolean);
	expect(lines.length, run.stdout).toBe(1);
	expect(lines[0]).toMatch(/^REFUSED COMMIT_CREATION_REFUSED: \S/);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
	expect(remoteHead(work)).toBe(originBefore);
	// The owned change is still the caller's uncommitted work.
	expect(git(work, ["diff", "--name-only", "HEAD", "--", "owned.txt"]).trim()).toBe("owned.txt");

	// --json keeps land's typed error and adds the save object.
	const json = save(work, fakeBin, ["--json", "-m", "feat(save): refused fixture [test]", "--", "owned.txt"]);
	expect(json.status).toBe(1);
	const body = JSON.parse(json.stdout) as { errors: { code: string }[]; data: { overall: string; save: { line: string; elapsed_s: number } } };
	expect(body.errors[0]?.code).toBe("COMMIT_CREATION_REFUSED");
	expect(body.data.overall).toBe("REFUSED");
	expect(body.data.save.line).toMatch(/^REFUSED COMMIT_CREATION_REFUSED: /);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
	expect(remoteHead(work)).toBe(originBefore);

	const rows = saveLog(work);
	const ownerRows = rows.filter(row => row.code === "OWNER_UNKNOWN");
	expect(ownerRows.length).toBe(run.retried + json.retried);
	for (const row of ownerRows) expect(row).toMatchObject({ outcome: "REFUSED", sha: null });
	const landed = rows.filter(row => row.code !== "OWNER_UNKNOWN");
	expect(landed.length).toBe(2);
	for (const row of landed) expect(row).toMatchObject({ outcome: "REFUSED", code: "COMMIT_CREATION_REFUSED", sha: null });
}, { timeout: fixtureDeadlineS(180) * 1000 });

test("save grammar refuses a missing message or missing paths, and `--` stays refused elsewhere", () => {
	const cases: [string[], string][] = [
		[["save", "--json", "--", "owned.txt"], "MISSING_VALUE"],
		[["save", "--json", "-m", "--", "owned.txt"], "MISSING_VALUE"],
		[["save", "--json", "-m", "feat: x"], "MISSING_ARGUMENT"],
		[["save", "--json", "-m", "feat: x", "--"], "MISSING_ARGUMENT"],
		[["save", "--json", "-m", "feat: x", "owned.txt"], "UNEXPECTED_ARGUMENT"],
		[["land", "--json", "--", "owned.txt"], "UNEXPECTED_SEPARATOR"],
		[["status", "--json", "--", "x"], "UNEXPECTED_SEPARATOR"],
	];
	for (const [args, code] of cases) {
		const result = runFixture(["bun", cliPath, ...args], { cwd: repoRoot, env: stringEnvironment(process.env), floor_s: 30 });
		const body = JSON.parse(decoder.decode(result.stdout)) as { errors: { code: string }[] };
		expect(result.rc, args.join(" ")).toBe(2);
		expect(body.errors[0]?.code, args.join(" ")).toBe(code);
	}
}, { timeout: 120_000 });

test("GATELOCK1 save prepares the installed gate before commit and preserves its RED judgment", () => {
	const { work, fakeBin } = fixture();
	const hooks = join(work, ".git/hooks");
	const members = join(hooks, "hooks.d/commit-msg");
	mkdirSync(members, { recursive: true });
	copyFileSync(join(repoRoot, "scripts/check-commit-gate.sh"), join(members, "55-omp-kit-commit-gate"));
	copyFileSync(join(repoRoot, "scripts/kitlib-tmp.sh"), join(members, "kitlib-tmp.sh"));
	writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\nexec sh "$(dirname "$0")/hooks.d/commit-msg/55-omp-kit-commit-gate" "$@"\n');
	chmodSync(join(hooks, "commit-msg"), 0o755);
	const gate = join(hooks, "hooks.d/pre-push/40-omp-kit-fresh-gate");
	mkdirSync(join(hooks, "hooks.d/pre-push"), { recursive: true });
	writeFileSync(gate, '#!/bin/sh\nread -r lref candidate rref base\nif [ "$(git show "$candidate:owned.txt")" = broken ]; then echo "planted RED owned.txt" >&2; exit 7; fi\n');
	chmodSync(gate, 0o755);
	writeFileSync(join(work, "owned.txt"), "saved through prepared admission\n");
	const green = save(work, fakeBin, ["-m", "[test] prepared save", "--", "owned.txt"]);
	expect(green.status, green.stdout + green.stderr).toBe(0);
	expect(git(work, ["show", `${remoteHead(work)}:owned.txt`])).toBe("saved through prepared admission\n");
	const before = git(work, ["rev-parse", "HEAD"]).trim();
	writeFileSync(join(work, "owned.txt"), "broken\n");
	const red = save(work, fakeBin, ["--json", "-m", "[test] red save", "--", "owned.txt"]);
	expect(red.status, red.stdout + red.stderr).toBe(1);
	expect(red.stdout).toContain("COMMIT_GATE_REFUSED");
	expect(red.stdout).toContain("planted RED owned.txt");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(before);
	expect(remoteHead(work)).toBe(before);
}, { timeout: fixtureDeadlineS(180) * 1000 });
