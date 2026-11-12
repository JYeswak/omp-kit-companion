// install-hooks.test.ts — KITHOOKDIRT1 (ompkit-1ra0d.208): kit updates must not
// leave dirt in a product repo whose hooks dir is git-tracked. When the target
// hooks dir (core.hooksPath=.githooks) has committed files, the installer puts
// kit-managed members and helpers in the $GIT_DIR-local mirror
// (<git-dir>/omp-kit-hooks/hooks.d/<kind>/), which git never lists, and one
// ignored dispatcher per kind (hooks.d/<kind>/99-omp-kit-managed) runs them
// through the tracked runner. Tracked files are never written; tracked kit
// copies left for the owner are reported for the one documented migration.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const installer = join(root, "scripts/install-commit-msg-bead.sh");

const gitEnv = (base: string, extra?: Record<string, string>) => ({
	...process.env,
	GIT_CEILING_DIRECTORIES: base,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	TMPDIR: base,
	...extra,
});

const err = (result: { stderr: Uint8Array | string }): string =>
	Buffer.from(result.stderr as Uint8Array).toString("utf8");

// A repo-owned chain runner, as clutterfreespaces.ios tracks its own: every
// executable NN- member of hooks.d/<kind> runs in sort order; first refusal wins.
const repoRunner = (): string => `#!/bin/sh
# repo-owned chain runner (fixture): every executable NN- member of hooks.d/<kind>; the first refusal wins.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
kind=$(basename -- "$0")
for member in "$here/hooks.d/$kind"/[0-9][0-9]-*; do
	[ -x "$member" ] || continue
	"$member" "$@" || exit $?
done
`;

// Stale tracked kit copies, as clutterfreespaces.ios tracks its own: an old
// member (inert here so only the mirror can refuse) and an old helper.
const STALE_MEMBER = "#!/bin/sh\n# stale tracked kit copy (fixture)\nexit 0\n";
const STALE_HELPER = "# stale tracked kit helper (fixture)\n";

const KINDS = ["commit-msg", "post-commit", "pre-commit", "pre-push", "reference-transaction"];

// Tracked-hooks fixture: tracked runners for every kind, one repo-owned
// member, and two stale tracked kit copies. Returns the repo path.
function trackedHooksRepo(scratchPath: string, name: string, env: Record<string, string>): string {
	const repo = join(scratchPath, name);
	for (const kind of KINDS) {
		mkdirSync(join(repo, ".githooks/hooks.d", kind), { recursive: true });
		writeFileSync(join(repo, ".githooks", kind), repoRunner());
		chmodSync(join(repo, ".githooks", kind), 0o755);
	}
	writeFileSync(join(repo, ".githooks/hooks.d/pre-commit/10-repo-owned"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(repo, ".githooks/hooks.d/pre-commit/10-repo-owned"), 0o755);
	writeFileSync(join(repo, ".githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"), STALE_MEMBER);
	chmodSync(join(repo, ".githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"), 0o755);
	writeFileSync(join(repo, ".githooks/hooks.d/pre-commit/check-commit-imports.sh"), STALE_HELPER);
	writeFileSync(join(repo, "README.txt"), "seed\n");
	expect(runFixture(["git", "init", "-q", "-b", "main", repo], { cwd: scratchPath, env }).rc).toBe(0);
	expect(runFixture(["git", "-C", repo, "config", "user.email", "t@example.invalid"], { cwd: scratchPath, env }).rc).toBe(0);
	expect(runFixture(["git", "-C", repo, "config", "user.name", "t"], { cwd: scratchPath, env }).rc).toBe(0);
	expect(runFixture(["git", "-C", repo, "config", "core.hooksPath", ".githooks"], { cwd: scratchPath, env }).rc).toBe(0);
	expect(runFixture(["git", "-C", repo, "add", "-A"], { cwd: scratchPath, env }).rc).toBe(0);
	expect(runFixture(["git", "-C", repo, "commit", "-q", "-m", "[test] seed fixture-1"], { cwd: scratchPath, env }).rc).toBe(0);
	return repo;
}

function statusPorcelain(repo: string, env: Record<string, string>): string {
	const st = runFixture(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"], { cwd: repo, env });
	expect(st.rc).toBe(0);
	return Buffer.from(st.stdout as Uint8Array).toString("utf8");
}

test("KITHOOKDIRT1 tracked hooks dir: install twice stays clean and the mirror members fire", async () => {
	const scratch = ownedTmp("install-hooks-kithookdirt1", { bead: "ompkit-1ra0d.208" });
	try {
		const env = gitEnv(scratch.path) as Record<string, string>;
		const repo = trackedHooksRepo(scratch.path, "tracked", env);
		const emptyDb = join(scratch.path, "empty.db");
		writeFileSync(emptyDb, "");
		const absentDb = join(scratch.path, "absent.db");

		const installed = await runFixtureAsync(["sh", installer, repo], { cwd: scratch.path, env, floor_s: 120 });
		expect(installed.rc).toBe(0);
		expect(Buffer.from(installed.stdout as Uint8Array).toString("utf8")).toContain("installed managed-mirror dispatcher");
		expect(err(installed)).toContain("TRACKED kit copies remain");
		expect(statusPorcelain(repo, env)).toBe("");
		// The tracked stale copies are byte-identical: the installer never wrote them.
		expect(readFileSync(join(repo, ".githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"), "utf8")).toBe(STALE_MEMBER);
		expect(readFileSync(join(repo, ".githooks/hooks.d/pre-commit/check-commit-imports.sh"), "utf8")).toBe(STALE_HELPER);

		// The mirror holds the current rules, byte-identical to the sources.
		const gitdir = Buffer.from(runFixture(["git", "-C", repo, "rev-parse", "--absolute-git-dir"], { cwd: scratch.path, env }).stdout as Uint8Array).toString("utf8").trim();
		const mirrorGate = join(gitdir, "omp-kit-hooks/hooks.d/commit-msg/55-omp-kit-commit-gate");
		expect(existsSync(mirrorGate)).toBe(true);
		expect(readFileSync(mirrorGate, "utf8")).toBe(readFileSync(join(root, "scripts/check-commit-gate.sh"), "utf8"));

		// The dispatchers are executable and ignored (the clean status above proves it).
		for (const kind of KINDS) {
			const dispatcher = join(repo, ".githooks/hooks.d", kind, "99-omp-kit-managed");
			expect(existsSync(dispatcher)).toBe(true);
		}

		// A second install is still clean.
		const again = await runFixtureAsync(["sh", installer, repo], { cwd: scratch.path, env, floor_s: 120 });
		expect(again.rc).toBe(0);
		expect(statusPorcelain(repo, env)).toBe("");

		// --check reports the owner migration (exit 3) instead of silently passing.
		const check = await runFixtureAsync(["sh", installer, "--check", repo], { cwd: scratch.path, env, floor_s: 60 });
		expect(check.rc).toBe(3);
		expect(err(check)).toContain("TRACKED installed member");
		expect(err(check)).not.toContain("MISSING installed member");
		expect(err(check)).not.toContain("STALE installed member");

		// The documented one-time migration closes the loop: delete the tracked
		// copies, commit, rerun. The install goes quiet and --check is fresh.
		expect(runFixture(["git", "-C", repo, "rm", "-q", "--",
			".githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree",
			".githooks/hooks.d/pre-commit/check-commit-imports.sh"], { cwd: scratch.path, env }).rc).toBe(0);
		const migrateEnv = gitEnv(scratch.path, { BEADS_DB: absentDb }) as Record<string, string>;
		const migrated = await runFixtureAsync(["git", "-C", repo, "commit", "-q", "-m", "[test] migrate tracked kit copies fixture-1\n\nBead: fixture-1"], { cwd: scratch.path, env: migrateEnv, floor_s: 60 });
		expect(migrated.rc).toBe(0);
		const closed = await runFixtureAsync(["sh", installer, repo], { cwd: scratch.path, env, floor_s: 120 });
		expect(closed.rc).toBe(0);
		expect(err(closed)).not.toContain("TRACKED kit copies remain");
		const fresh = await runFixtureAsync(["sh", installer, "--check", repo], { cwd: scratch.path, env, floor_s: 60 });
		expect(fresh.rc).toBe(0);
		expect(Buffer.from(fresh.stdout as Uint8Array).toString("utf8")).toContain("hooks fresh in");
		expect(statusPorcelain(repo, env)).toBe("");

		// The mirror members fire through the tracked runner: a valid commit
		// passes while the tracker is absent, and a message naming an
		// unresolvable bead id is refused naming the bead-id member.
		writeFileSync(join(repo, "notes.txt"), "notes\n");
		expect(runFixture(["git", "-C", repo, "add", "-A"], { cwd: scratch.path, env }).rc).toBe(0);
		const passEnv = gitEnv(scratch.path, { BEADS_DB: absentDb }) as Record<string, string>;
		const pass = await runFixtureAsync(["git", "-C", repo, "commit", "-q", "-m", "[test] add notes fixture-1"], { cwd: scratch.path, env: passEnv, floor_s: 60 });
		writeFileSync(join(repo, "more.txt"), "more\n");
		expect(runFixture(["git", "-C", repo, "add", "-A"], { cwd: scratch.path, env }).rc).toBe(0);
		const refuseEnv = gitEnv(scratch.path, { BEADS_DB: emptyDb }) as Record<string, string>;
		const refused = await runFixtureAsync(["git", "-C", repo, "commit", "-m", "[test] fix widgets ompkit-zzzz-1"], { cwd: scratch.path, env: refuseEnv, floor_s: 60 });
		expect(refused.rc).not.toBe(0);
		expect(err(refused)).toContain("commit-msg-bead");
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(180) * 1000);

test("KITHOOKDIRT1 planted: overwriting a tracked kit copy dirties the tree", async () => {
	const scratch = ownedTmp("install-hooks-kithookdirt1-planted", { bead: "ompkit-1ra0d.208" });
	try {
		const env = gitEnv(scratch.path) as Record<string, string>;
		const repo = trackedHooksRepo(scratch.path, "planted", env);
		// What today's installer did: write the current source bytes over the
		// tracked copy. The fixture must show that as modified tracked dirt,
		// proving the clean assertions above are not vacuous.
		writeFileSync(
			join(repo, ".githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree"),
			readFileSync(join(root, "scripts/check-stale-worktree.sh"), "utf8"),
		);
		const dirt = statusPorcelain(repo, env);
		expect(dirt).toContain(" M .githooks/hooks.d/commit-msg/49-omp-kit-stale-worktree");
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(60) * 1000);
