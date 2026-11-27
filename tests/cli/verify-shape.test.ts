import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { verifyBead } from "../../src/verify.ts";
import { fakeBr, inReview, installFixtureIdentity, restoreFixtureIdentity, sh } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// VERIFYSHAPE1 (ompkit-d61bv): an export is judged by the archive's own rc and a non-empty tree,
// not by a scripts/ or src/ top-level. This bounds fixture Git publication, not a product latency contract.
jest.setTimeout(fixtureDeadlineS(20) * 1_000);
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const markerRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-shape", markerRoot === undefined ? {} : { root: markerRoot }).path;
const PASSING = "- [ ] [a] [build] `sh lib/check.sh` -> 16 pass 0 fail";

async function publish(dir: string, name: string): Promise<string> {
	await sh(["git", "init", "-q", "-b", "main"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "fixture [test]"], dir);
	const origin = join(base, `${name}.origin.git`);
	await sh(["git", "init", "--bare", "-q", origin], base);
	await sh(["git", "remote", "add", "origin", origin], dir);
	await sh(["git", "push", "-q", "origin", "HEAD:main"], dir);
	return (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
}

test("VERIFYSHAPE1: a lib/ and tests/ export self-replays, and an empty or failed archive refuses with a named reason", async () => {
	const shaped = join(base, "shaped");
	mkdirSync(join(shaped, "lib"), { recursive: true });
	mkdirSync(join(shaped, "tests"), { recursive: true });
	writeFileSync(join(shaped, "lib", "check.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	writeFileSync(join(shaped, "tests", "note.txt"), "fixture\n");
	const shapedSha = await publish(shaped, "shaped");
	const shapedBr = fakeBr({ ...inReview(PASSING), status: "in_progress" });
	const replay = await verifyBead({ bead: "kit-1", exportSha: shapedSha, repo: shaped, actor: "Author", env: shapedBr.env, selfReplay: true });
	expect(replay.code).toBe("SELF_REPLAY");
	expect(replay.ok).toBe(true);
	expect(replay.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(replay.log).not.toContain("export failed");

	const empty = join(base, "empty");
	mkdirSync(empty, { recursive: true });
	const emptySha = await publish(empty, "empty");
	const emptyBr = fakeBr({ ...inReview(PASSING), status: "in_progress" });
	const emptyRes = await verifyBead({ bead: "kit-1", exportSha: emptySha, repo: empty, actor: "Author", env: emptyBr.env, selfReplay: true });
	expect(emptyRes.code).toBe("EXPORT_FAILED");
	expect(emptyRes.log).toContain("export extracted nothing");
	expect(emptyRes.log).not.toMatch(/export failed rc 0:\s*$/m);

	const realGit = Bun.which("git");
	expect(realGit).not.toBeNull();
	const wrap = join(base, "git-wrap");
	mkdirSync(wrap, { recursive: true });
	writeFileSync(join(wrap, "git"), `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$3" = "archive" ]; then printf '%s\\n' "planted archive refusal" >&2; exit 9; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
	chmodSync(join(wrap, "git"), 0o755);
	const failedBr = fakeBr({ ...inReview(PASSING), status: "in_progress" });
	const failed = await verifyBead({
		bead: "kit-1", exportSha: shapedSha, repo: shaped, actor: "Author", selfReplay: true,
		env: { ...failedBr.env, PATH: `${wrap}${delimiter}${failedBr.env.PATH}` },
	});
	expect(failed.code).toBe("EXPORT_FAILED");
	expect(failed.log).toContain("export failed rc 9: planted archive refusal");
	expect(existsSync(realGit!)).toBe(true);
});
