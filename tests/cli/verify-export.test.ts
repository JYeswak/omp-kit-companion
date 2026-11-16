import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { mapRepoPaths, verifyBead, type VerifyResult } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity, sh } from "./verify-fixture.ts";

jest.setTimeout(fixtureDeadlineS(15) * 1_000);
const scratch = ownedTmp("verify-export-test", process.env.GRADE_WAVE_SCRATCH === undefined
	? {} : { root: process.env.GRADE_WAVE_SCRATCH });
const base = scratch.path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const callerStateHome = process.env.XDG_STATE_HOME;
beforeAll(() => {
	installFixtureIdentity();
	process.env.XDG_STATE_HOME = join(base, "state");
});
afterAll(() => {
	restoreFixtureIdentity();
	if (callerStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = callerStateHome;
	scratch.cleanup();
});

test("VERIFYENV1 product: caller tracker selectors and agent-bin entries never reach replay; clean control is unchanged", async () => {
	const { dir, sha } = await repo("verifyenv-scrub", { "env.sh": [
		"#!/bin/sh",
		"[ \"${BEADS_DIR+x}\" != x ] && [ \"${BEADS_DB+x}\" != x ] || exit 21",
		"case \":$PATH:\" in *\"/agent-bin:\"*) exit 22;; esac",
		"[ \"$VERIFY_CONTROL\" = preserved ] || exit 23",
		"printf 'SCRUB_OK\\n'",
	].join("\n") + "\n" });
	for (const planted of [false, true]) {
		const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/env.sh` -> prints SCRUB_OK"));
		const cleanPath = br.env.PATH!.split(delimiter).filter(dir => dir.split("/").filter(Boolean).at(-1) !== "agent-bin").join(delimiter);
		const res = await verifyBead({
			bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer",
			env: { ...br.env, PATH: cleanPath, VERIFY_CONTROL: "preserved", ...(planted ? {
				BEADS_DIR: join(base, "caller", ".beads"), BEADS_DB: join(base, "caller", ".beads", "beads.db"),
				PATH: `${join(base, "agent-bin")}:${cleanPath}:${join(base, "other", "agent-bin")}`,
			} : {}) },
		});
		expect(res.code).toBe("CLOSED");
		expect(res.replays.map(r => r.pass)).toEqual([true]);
	}
});

test("VERIFYENV1 product: failed CLI box retains complete raw output after export cleanup, with per-box evidence references", async () => {
	// More than 24 KiB, including invalid UTF-8: the middle is absent from the 4,000-char display.
	const stdout = Buffer.concat([Buffer.from("HEAD\n"), Buffer.alloc(12_000, 120), Buffer.from("\nMIDDLE_WITNESS\n"), Buffer.alloc(12_000, 121), Buffer.from([0xff]), Buffer.from("\nTAIL\n")]);
	const stderr = Buffer.from("stderr witness\n");
	const script = `import { writeSync } from "node:fs"; writeSync(1, Buffer.from("${stdout.toString("base64")}", "base64")); writeSync(2, Buffer.from("${stderr.toString("base64")}", "base64")); process.exit(1);\n`;
	const { dir, sha } = await repo("verifyenv-evidence", { "large.ts": script });
	const br = fakeBr(inReview("- [ ] [a] [build] `bun scripts/large.ts` -> exit 0\n- [ ] [b] [build] `bun scripts/large.ts` -> prints NEVER"));
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	expect(r.rc).toBe(1);
	const result = JSON.parse(new TextDecoder().decode(r.stdout)).data;
	expect(result.overall).toBe("REWORK");
	const exportLine = result.log.split("\n").find((line: string) => line.startsWith("exported "));
	expect(existsSync(exportLine.slice(exportLine.indexOf(" to ") + 4))).toBe(false);
	for (const box of result.replays) {
		expect(box.detail).toContain("chars omitted");
		expect(box.detail).not.toContain("MIDDLE_WITNESS");
		expect(box.output).toMatchObject({ bytes: stdout.length + stderr.length, complete: true });
		expect(readFileSync(box.output.path)).toEqual(Buffer.concat([stdout, stderr]));
		expect(readFileSync(join(dirname(box.output.path), ".owner"), "utf8")).toContain("bead=kit-1");
		expect(result.acts[0].join(" ")).toContain(box.output.path);
	}
	expect(result.replays[0].output.path).not.toBe(result.replays[1].output.path);
});

test("VERIFYENV1 product: evidence measures the 8 MiB capture ceiling and labels over-limit output incomplete", async () => {
	const cap = 4 * 1024 * 1024;
	const { dir, sha } = await repo("verifyenv-bound", {
		"bound.ts": 'import { writeFileSync } from "node:fs"; const n = Number(process.argv[2]); writeFileSync(1, Buffer.alloc(n, 120)); writeFileSync(2, Buffer.alloc(n, 121)); process.exit(1);\n',
	});
	for (const n of [cap, cap + 1]) {
		const br = fakeBr(inReview(`- [ ] [a] [build] \`bun scripts/bound.ts ${n}\` -> exit 0`));
		const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
		expect(res.code).toBe("REWORK");
		const output = res.replays[0]!.output!;
		expect(output.bytes).toBe(2 * cap);
		expect(output.complete).toBe(n === cap);
		const bytes = readFileSync(output.path);
		expect(bytes).toEqual(Buffer.concat([Buffer.alloc(cap, 120), Buffer.alloc(cap, 121)]));
		if (n > cap) {
			expect(res.replays[0]!.detail).toContain("OUTPUT_LIMIT");
			expect(res.replays[0]!.detail).toContain("INCOMPLETE");
		}
		console.error(`VERIFYENV1 evidence emitted=${2 * n} retained=${bytes.length} complete=${output.complete}`);
	}
}, fixtureDeadlineS(60) * 1_000);

// VERIFYABSPATH1 (ompkit-fp72.120.16.267): a repo path named absolutely, by ~ or by $HOME replays the export.
const LIVE_PASS = "#!/bin/sh\necho ' 0 fail'\n";
const EXPORT_FAIL = "#!/bin/sh\necho 'selftest: FAIL'\nexit 1\n";
async function livePassExportFail(name: string): Promise<{ dir: string; sha: string }> {
	const made = await repo(name, { "live.sh": EXPORT_FAIL }, true);
	writeFileSync(join(made.dir, "scripts", "live.sh"), LIVE_PASS); // dirty live tree; the commit still fails
	return made;
}

test("VERIFYABSPATH1 planted: a live-pass/export-fail absolute-path box is not PASS and names the token", async () => {
	const { dir, sha } = await livePassExportFail("abspath-planted");
	const token = join(dir, "scripts", "live.sh");
	const br = fakeBr(inReview(`- [ ] [a] [build] \`sh ${token}\` -> 0 fail`));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", false]]);
	expect(res.log).toContain(`REPO_PATH_MAPPED ${JSON.stringify(token)}`);
	expect(res.replays[0]!.detail).toContain("selftest: FAIL");
	expect(br.state().status).toBe("rework");
});

test("VERIFYABSPATH1 control: the relative-path box on the same commit reports the export's result", async () => {
	const { dir, sha } = await livePassExportFail("abspath-control");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/live.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", false]]);
	expect(res.log).not.toContain("REPO_PATH_MAPPED");
	// Control for the control: a committed passing script, named absolutely, still closes.
	const ok = await repo("abspath-control-pass", {}, true);
	const okBr = fakeBr(inReview(`- [ ] [a] [build] \`sh ${join(ok.dir, "scripts", "t.sh")}\` -> 0 fail`));
	const closed = await verifyBead({ bead: "kit-1", exportSha: ok.sha, repo: ok.dir, actor: "Peer", env: okBr.env });
	expect(closed.code).toBe("CLOSED");
});

test("VERIFYABSPATH1 mutant: without the mapping the planted absolute-path command reports PASS", async () => {
	const { dir, sha } = await livePassExportFail("abspath-mutant");
	const token = join(dir, "scripts", "live.sh");
	const exportDir = join(base, "abspath-mutant-export");
	mkdirSync(exportDir, { recursive: true });
	await sh(["sh", "-c", `git -C ${JSON.stringify(dir)} archive ${sha} | tar -x -C ${JSON.stringify(exportDir)}`], base);
	// The pre-fix replay: the unmapped command, in the export cwd, runs the live tree and passes.
	const unmapped = await run(["sh", token], { cwd: exportDir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(unmapped.rc).toBe(0);
	expect(new TextDecoder().decode(unmapped.stdout)).toContain("0 fail");
	// The mapped command runs the export's bytes and fails.
	const mapped = mapRepoPaths(`sh ${token}`, dir, exportDir);
	expect(mapped.command).toBe(`sh ${join(exportDir, "scripts", "live.sh")}`);
	const fixed = await run(["sh", join(exportDir, "scripts", "live.sh")], { cwd: exportDir, deadline_s: fixtureDeadlineS(30), env: { ...process.env } as Record<string, string> });
	expect(fixed.rc).toBe(1);
});

test("VERIFYABSPATH1 mapping: ~, $HOME, ${HOME} and symlinked aliases map; outside, sibling-prefix and .beads tracker paths stay; unsafe export is unmapped", () => {
	const home = join(base, "abspath-home");
	const root = join(home, "proj");
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "x.py"), "");
	const alias = join(home, "alias");
	if (!existsSync(alias)) symlinkSync(root, alias);
	const exp = join(base, "abspath-export");
	const m = mapRepoPaths(`python3 ~/proj/scripts/x.py --a=$HOME/proj/scripts/x.py "\${HOME}/proj" '${alias}/scripts/x.py' ${root}/new/file`, root, exp, home);
	expect(m.command).toBe(`python3 ${exp}/scripts/x.py --a=${exp}/scripts/x.py "${exp}" '${exp}/scripts/x.py' ${exp}/new/file`);
	expect(m.unmapped).toEqual([]);
	const keep = `br --db ${root}/.beads/beads.db show x && /usr/bin/env sh ${root}-other/x ~/other/y scripts/x.py ~user/proj $HOMER/proj https://h/proj ${home}`;
	expect(mapRepoPaths(keep, root, exp, home)).toEqual({ command: keep, mapped: [], unmapped: [] });
	const unsafe = mapRepoPaths(`sh ${root}/scripts/x.py`, root, join(base, "export dir"), home);
	expect(unsafe.unmapped).toEqual([`${root}/scripts/x.py`]);
	expect(unsafe.command).toBe(`sh ${root}/scripts/x.py`);
	// Linear scan: a 200 KB near-miss (no boundary before any /) finishes fast.
	const t0 = performance.now();
	mapRepoPaths("a/".repeat(100_000), root, exp, home);
	expect(performance.now() - t0).toBeLessThan(1_000);
});

test("VERIFYABSPATH1 unmappable: a repo path that cannot be rewritten is UNJUDGED naming the token, never PASS", async () => {
	const { dir, sha } = await livePassExportFail("abspath-unmapped");
	const token = join(dir, "scripts", "live.sh");
	const br = fakeBr(inReview(`- [ ] [a] [build] \`sh ${token}\` -> 0 fail`));
	// A scratch root with a space makes the export path shell-unsafe, so the token cannot be rewritten.
	const unsafeRoot = join(base, "unsafe root");
	mkdirSync(unsafeRoot, { recursive: true });
	const prior = process.env.GRADE_WAVE_SCRATCH;
	process.env.GRADE_WAVE_SCRATCH = unsafeRoot;
	let res: VerifyResult;
	try {
		res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	} finally {
		if (prior === undefined) delete process.env.GRADE_WAVE_SCRATCH; else process.env.GRADE_WAVE_SCRATCH = prior;
	}
	expect(res.code).toBe("ENVIRONMENT");
	expect(res.replays.map(r => [r.letter, r.pass, r.rc])).toEqual([["a", null, null]]);
	expect(res.replays[0]!.detail).toContain(`UNJUDGED REPO_PATH_UNMAPPED: ${JSON.stringify(token)}`);
});

