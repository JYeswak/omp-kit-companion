import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const base = ownedTmp("published-commit-gate-test").path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function runOk(args: string[], cwd: string): Promise<string> {
	const result = await run(args, { cwd, deadline_s: 60 });
	if (result.rc !== 0) throw new Error(`${args.join(" ")} -> ${result.rc}: ${new TextDecoder().decode(result.stderr)}`);
	return new TextDecoder().decode(result.stdout).trim();
}

async function makeRepo(): Promise<{ dir: string; sha: string; env: Record<string, string>; marker: string }> {
	const dir = join(base, "repo");
	mkdirSync(dir, { recursive: true });
	await runOk(["git", "init", "-q"], dir);
	await runOk(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-q", "--allow-empty", "-m", "root [test]"], dir);

	const origin = join(base, "origin.git");
	await runOk(["git", "init", "--bare", "-q", origin], base);
	await runOk(["git", "remote", "add", "origin", origin], dir);
	await runOk(["git", "push", "-q", "origin", "HEAD:main"], dir);

	const marker = join(base, "replayed.marker");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "replay.sh"), "#!/bin/sh\nprintf 'replayed' > \"$PUBLICATION_REPLAY_MARKER\"\nprintf 'replay ok\\n'\n");
	chmodSync(join(dir, "scripts", "replay.sh"), 0o755);
	await runOk(["git", "add", "scripts/replay.sh"], dir);
	await runOk(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "unpublished replay fixture [test]"], dir);
	const sha = await runOk(["git", "rev-parse", "HEAD"], dir);

	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const bead = {
		id: "kit-1",
		status: "in_review",
		assignee: "Author",
		updated_at: "2026-11-01T00:00:00Z",
		labels: [],
		acceptance_criteria: "- [ ] [a] [build] `sh scripts/replay.sh` -> replay ok",
	};
	writeFileSync(join(bin, "br"), `#!/bin/sh\nif [ \"$1\" = show ]; then printf '%s' '${JSON.stringify([bead])}'; exit 0; fi\nexit 0\n`);
	chmodSync(join(bin, "br"), 0o755);
	return { dir, sha, marker, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PUBLICATION_REPLAY_MARKER: marker } };
}

test("omp-kit verify refuses an unpublished export before replay and admits it after publish", async () => {
	const { dir, sha, marker, env } = await makeRepo();
	const args = (exportSha: string) => [
		"bun", "run",
		...(process.env.PUBLISH_GATE_MUTATION_PRELOAD ? ["--preload", process.env.PUBLISH_GATE_MUTATION_PRELOAD] : []),
		"--silent", cliPath, "verify", "kit-1", "--export", exportSha, "--project", dir, "--actor", "Peer", "--lesson", "publication fixture", "--dry-run", "--json",
	];

	const missingSha = "0".repeat(40);
	const missing = await run(args(missingSha), { cwd: base, deadline_s: 60, env });
	const unknown = JSON.parse(new TextDecoder().decode(missing.stdout)) as { data: { overall: string; replays: unknown[]; acts: unknown[] } };
	expect({ overall: unknown.data.overall, replayed: existsSync(marker) }).toEqual({ overall: "UNKNOWN", replayed: false });
	expect(unknown.data.replays).toEqual([]);
	expect(unknown.data.acts).toEqual([]);

	const refused = await run(args(sha), { cwd: base, deadline_s: 60, env });
	const refusal = JSON.parse(new TextDecoder().decode(refused.stdout)) as { data: { overall: string; log: string; replays: unknown[]; acts: unknown[] } };
	expect({ overall: refusal.data.overall, replayed: existsSync(marker) }).toEqual({ overall: "NOT_PUBLISHED", replayed: false });
	expect(refusal.data.log).toContain(sha.slice(0, 7));
	expect(refusal.data.log).toContain("git_converge.py --push");
	expect(refusal.data.replays).toEqual([]);
	expect(refusal.data.acts).toEqual([]);

	await runOk(["git", "push", "-q", "origin", "HEAD:main"], dir);
	const admitted = await run(args(sha), { cwd: base, deadline_s: 60, env });
	expect(admitted.rc).toBe(0);
	const result = JSON.parse(new TextDecoder().decode(admitted.stdout)) as { data: { overall: string; replays: { pass: boolean | null }[] } };
	expect(result.data.overall).toBe("DRY_RUN");
	expect(result.data.replays.map(replay => replay.pass)).toEqual([true]);
	expect(readFileSync(marker, "utf8")).toBe("replayed");

	unlinkSync(marker);
	await runOk(["git", "remote", "set-url", "origin", join(base, "missing-origin.git")], dir);
	const fetchFailure = await run(args(sha), { cwd: base, deadline_s: 60, env });
	const fetchUnknown = JSON.parse(new TextDecoder().decode(fetchFailure.stdout)) as { data: { overall: string; replays: unknown[]; acts: unknown[] } };
	expect({ overall: fetchUnknown.data.overall, replayed: existsSync(marker) }).toEqual({ overall: "UNKNOWN", replayed: false });
	expect(fetchUnknown.data.replays).toEqual([]);
	expect(fetchUnknown.data.acts).toEqual([]);
}, 60_000);

test("planted negative: removing the ancestry check makes the unpublished regression fail", async () => {
	const helperPath = join(import.meta.dir, "..", "..", "extensions", "kit-published-commit.ts");
	const helperSource = readFileSync(helperPath, "utf8");
	const needle = 'const ancestor = await runPublicationGit(["merge-base", "--is-ancestor", commit.out, tip.out]);';
	if (!helperSource.includes(needle)) throw new Error("published-commit mutation site changed");

	const mutationDir = join(base, "mutation");
	mkdirSync(mutationDir, { recursive: true });
	const preloadPath = join(mutationDir, "disable-ancestry-check.ts");
	const markerPath = join(mutationDir, "mutant-loaded");
	writeFileSync(preloadPath, `
import { readFileSync, writeFileSync } from "node:fs";
const helperPath = ${JSON.stringify(helperPath)};
const markerPath = ${JSON.stringify(markerPath)};
const needle = ${JSON.stringify(needle)};
Bun.plugin({
	name: "published-commit-ancestry-mutation",
	setup(builder) {
		builder.onLoad({ filter: /kit-published-commit\\.ts$/ }, () => {
			const source = readFileSync(helperPath, "utf8");
			if (!source.includes(needle)) throw new Error("published-commit mutation site changed");
			writeFileSync(markerPath, "ancestry-check-removed");
			return {
				contents: source.replace(needle, 'const ancestor = { rc: 0, out: "", failed: false };'),
				loader: "ts",
			};
		});
	},
});
`);

	const testPath = join(import.meta.dir, "published-commit-gate.test.ts");
	const result = await run([
		"bun", "test", "--timeout", "60000", "--test-name-pattern",
		"omp-kit verify refuses an unpublished export before replay and admits it after publish",
		testPath,
	], {
		cwd: join(import.meta.dir, "..", ".."),
		deadline_s: 90,
		env: {
			...process.env,
			PUBLISH_GATE_MUTATION_PRELOAD: preloadPath,
		},
	});
	const output = `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;
	expect(result.rc).toBe(1);
	if (!existsSync(markerPath)) throw new Error(output);
	expect(output).toContain("NOT_PUBLISHED");
	expect(output).toContain("DRY_RUN");
}, 90_000);
