// ompkit-774u.15 SCRATCHBIN1 A and B: an owner record names the bin a scratch dir goes to when its work ends, a hold is
// bounded to 14 days and never reaped while it stands, and the owner's release records the bin with the reference that
// proves where the content went.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reapLogPath } from "../../src/scratch.ts";
import { createScratch, diagnoseOwnerFailure, inspectOne, inspectSession, parseOwnerFile, parseOwnerFileEx, releaseScratch, SCRATCH_BINS,
	type InspectDeps, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const NOW = Date.parse("2026-10-18T20:00:00.000Z");
const CREATED = "2026-10-18T17:32:44.000Z";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });
// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const deps = (extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness: noPid, run: clearRun, now: NOW, ...extra });
const ownerText = (pid: number, extra = "", created = CREATED) => `pid=${pid}\nlabel=work\nrepo=${repo}\ncreated=${created}\n${extra}`;

function fixture(owner: string, label = "work"): { dir: string; root: string; home: string } {
	const root = ownedTmp("bins", { root: scratchParent }).path;
	const home = ownedTmp("bins-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const dir = join(root, `${label}.${process.pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), owner);
	return { dir, root, home };
}

test("the four bins exist and an owner record carries bin, purpose and bead; no bin means unbinned", () => {
	expect([...SCRATCH_BINS]).toEqual(["throwaway", "evidence", "promote", "hold"]);
	expect(parseOwnerFile(ownerText(42))).toMatchObject({ bin: null, purpose: null, bead: null, expires: null });
	expect(parseOwnerFile(ownerText(42, "bin=throwaway\npurpose=probe\n"))).toMatchObject({ bin: "throwaway", purpose: "probe", bead: null });
	expect(parseOwnerFile(ownerText(42, "bin=evidence\nbead=ompkit-774u.15\n"))).toMatchObject({ bin: "evidence", bead: "ompkit-774u.15" });
	expect(parseOwnerFile(JSON.stringify({ pid: 42, label: "w", repo, created: CREATED, bin: "promote" }))).toMatchObject({ bin: "promote" });
});

test("a malformed bin group makes the owner record malformed: unknown bin, purpose alone, a bad token, expires on a non-hold", () => {
	for (const extra of ["bin=archive\n", "purpose=probe\n", "bin=throwaway\nexpires=2026-10-20\n", "bin=throwaway\npurpose=has space\n",
		`bin=throwaway\npurpose=${"p".repeat(41)}\n`, "bin=throwaway\nbead=-bad\n", "bin=\n"])
		expect({ extra, parsed: parseOwnerFile(ownerText(42, extra)) }).toEqual({ extra, parsed: null });
	expect(parseOwnerFile(ownerText(42, `bin=throwaway\npurpose=${"p".repeat(40)}\n`))).not.toBeNull();
});

test("a lone bead without a bin is valid (scratch new records the owning bead; unbinned)", () => {
	expect(parseOwnerFile(ownerText(42, "bead=ompkit-1\n"))).toMatchObject({ bin: null, bead: "ompkit-1" });
	expect(parseOwnerFile(ownerText(42, "bead=-bad\n"))).toBeNull();
});

test("a hold needs a bead and an expiry no later than 14 days after creation, and stays inside the pattern", () => {
	const hold = (extra: string) => parseOwnerFile(ownerText(42, `bin=hold\n${extra}`));
	expect(hold("bead=ompkit-1\nexpires=2026-10-25\n")).toMatchObject({ bin: "hold", bead: "ompkit-1", expires: "2026-10-25" });
	expect(hold("bead=ompkit-1\nexpires=2026-11-01T17:32:44Z\n")).not.toBeNull();
	expect(hold("bead=ompkit-1\nexpires=2026-11-01T17:32:45Z\n")).toBeNull();
	expect(hold("bead=ompkit-1\nexpires=2026-10-18T17:32:44Z\n")).toBeNull();
	expect(hold("bead=ompkit-1\nexpires=2026-10-01\n")).toBeNull();
	expect(hold("expires=2026-10-25\n")).toBeNull();
	expect(hold("bead=ompkit-1\n")).toBeNull();
	for (const bad of ["tomorrow", "2026-13-40", "2026-10-25T10", "2026-10-25 10:00:00Z", "2026-10-25T10:00:00+02:00"]) expect({ bad, parsed: hold(`bead=ompkit-1\nexpires=${bad}\n`) }).toEqual({ bad, parsed: null });
	const started = performance.now();
	expect(hold(`bead=ompkit-1\nexpires=2026-10-25T10:00${":00".repeat(20_000)}x\n`)).toBeNull();
	expect(performance.now() - started).toBeLessThan(500);
});

test("a hold outlives its dead owner until it expires, then it is flagged and never reaped; any other dead owner is reaped as before", () => {
	const root = ownedTmp("bins-hold", { root: scratchParent }).path;
	cleanup.push(root);
	const plant = (name: string, extra: string): string => {
		const dir = join(root, name);
		mkdirSync(dir);
		writeFileSync(join(dir, ".owner"), ownerText(Number(name.split(".")[1]), extra));
		return dir;
	};
	const held = plant("work.59801", "bin=hold\nbead=ompkit-1\nexpires=2026-10-25\n");
	const expired = plant("work.59802", "bin=hold\nbead=ompkit-1\nexpires=2026-10-19\n");
	const plain = plant("work.59803", "bin=throwaway\n");
	expect(inspectSession(held, root, deps())).toMatchObject({ action: "LIVE", reason: "held-by-bead" });
	expect(inspectSession(expired, root, deps({ now: Date.parse("2026-10-20T00:00:00Z") }))).toMatchObject({ action: "SKIP", reason: "hold-expired-unbinned" });
	expect(inspectSession(plain, root, deps())).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	expect(existsSync(expired)).toBe(true);
});

test("createScratch records the bin group and refuses an invalid one before creating anything", () => {
	const root = ownedTmp("bins-create", { root: scratchParent }).path;
	cleanup.push(root);
	process.env.OMP_KIT_SCRATCH_ROOTS = join(root, "var", "agent-tmp");
	const live: LivenessDeps = { ...noPid, processStart: () => "Mon Oct 18 17:32:44 2026" };
	const ok = createScratch("probe", root, deps({ liveness: live }), { bin: "hold", purpose: "probe", bead: "ompkit-774u.15", expires: "2026-10-25" }, false, join(root, "scratch-budgets.json"));
	expect(ok).toMatchObject({ ok: true, reason: "created" });
	expect(parseOwnerFile(readFileSync(join(ok.dir, ".owner"), "utf8"))).toMatchObject({ bin: "hold", purpose: "probe", bead: "ompkit-774u.15", expires: "2026-10-25" });
	const bad = createScratch("other", root, deps({ liveness: live }), { bin: "hold", purpose: "probe" }, false, join(root, "scratch-budgets.json"));
	expect(bad).toMatchObject({ ok: false, reason: "bin-invalid" });
	expect(existsSync(join(root, "var", "agent-tmp", `other.${process.pid}`))).toBe(false);
});

test("createScratch records a declared byte budget and refuses zero, negative and non-integer budgets", () => {
	const root = ownedTmp("bins-budget", { root: scratchParent }).path;
	cleanup.push(root);
	process.env.OMP_KIT_SCRATCH_ROOTS = join(root, "var", "agent-tmp");
	const live: LivenessDeps = { ...noPid, processStart: () => "Mon Oct 18 17:32:44 2026" };
	const ok = createScratch("probe", root, deps({ liveness: live }), { budgetBytes: 1000 }, false, join(root, "scratch-budgets.json"));
	expect(ok).toMatchObject({ ok: true, reason: "created" });
	expect(parseOwnerFile(readFileSync(join(ok.dir, ".owner"), "utf8"))).toMatchObject({ budget: 1000 });
	for (const [name, budgetBytes] of [["zero", 0], ["negative", -5], ["fraction", 10.5], ["nan", Number.NaN]] as const) {
		const bad = createScratch(`bad-${name}`, root, deps({ liveness: live }), { budgetBytes }, false, join(root, "scratch-budgets.json"));
		expect(bad, name).toMatchObject({ ok: false, reason: "budget-invalid" });
		expect(existsSync(join(root, "var", "agent-tmp", `bad-${name}.${process.pid}`))).toBe(false);
	}
	expect(parseOwnerFile("pid=1\nlabel=x\nrepo=/r\ncreated=2026-10-19T00:00:00Z\nbudget=0")).toBeNull();
	expect(parseOwnerFile("pid=1\nlabel=x\nrepo=/r\ncreated=2026-10-19T00:00:00Z\nbudget=100")).toMatchObject({ budget: 100 });
});

test("release --bin throwaway records the bin with no reference, and the release still moves the dir to quarantine", () => {
	const { dir, root, home } = fixture(ownerText(process.pid));
	expect(releaseScratch(dir, home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, changed: true });
	expect(readFileSync(join(dir, ".omp-kit-release"), "utf8")).toContain("bin=throwaway\n");
	const logged = readFileSync(reapLogPath(home), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { event: string; bin?: string });
	expect(logged.filter((event) => event.event === "release").map((event) => event.bin)).toEqual(["throwaway"]);
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "QUARANTINE", reason: "owner-released-would-quarantine" });
});

// TRANSFER1 (ompkit-jbiwx, Joshua's lifecycle review J-2026-10-22-02): an existing bead or an unrelated tracked file
// proved nothing, yet the release marker (the reaper) and --now retired the dir on it. The destination must carry the
// content: a bead comment or a committed and pushed file citing scratch-sha256:<digest>, or a pushed byte-identical copy.
test("release --bin evidence or promote needs a destination that proves the content arrived", () => {
	const projectDir = ownedTmp("bins-repo", { root: scratchParent }).path;
	const remoteDir = ownedTmp("bins-remote", { root: scratchParent }).path;
	cleanup.push(projectDir, remoteDir);
	const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = (...args: string[]) => Bun.spawnSync(["git", "-C", projectDir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv });
	expect(Bun.spawnSync(["git", "init", "-q", "--bare", remoteDir], { env: gitEnv }).exitCode).toBe(0);
	expect(git("init", "-q", "-b", "main").exitCode).toBe(0);
	mkdirSync(join(projectDir, "docs"));
	writeFileSync(join(projectDir, "docs", "tracked.md"), "evidence\n");
	writeFileSync(join(projectDir, "docs", "untracked.md"), "loose\n");
	expect(git("add", "docs/tracked.md").exitCode).toBe(0);
	expect(git("commit", "-q", "-m", "init").exitCode).toBe(0);
	expect(git("remote", "add", "origin", remoteDir).exitCode).toBe(0);
	expect(git("push", "-q", "-u", "origin", "main").exitCode).toBe(0);
	const realRun = (args: readonly string[]) => { const r = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };
	const real = deps({ run: realRun });
	const owner = `pid=${process.pid}\nlabel=work\nrepo=${projectDir}\ncreated=${CREATED}\n`;
	const scratchWith = (text: string) => { const f = fixture(owner); writeFileSync(join(f.dir, "run.out"), text); return f; };
	const attempt = (opts: Parameters<typeof releaseScratch>[3], run: Partial<InspectDeps> = {}, text = "measured\n") => {
		const f = scratchWith(text);
		return { f, result: releaseScratch(f.dir, f.home, { ...real, ...run }, opts) };
	};
	const refused: [string, Parameters<typeof releaseScratch>[3], string][] = [
		["no reference", { bin: "evidence" }, "ref-required"],
		["a malformed reference", { bin: "evidence", ref: "docs/tracked.md" }, "ref-invalid"],
		["a reference with whitespace", { bin: "promote", ref: "file:docs/a b.md" }, "ref-invalid"],
		["a file outside the repo", { bin: "evidence", ref: "file:../../etc/hosts" }, "ref-outside-repo"],
		["a missing file", { bin: "evidence", ref: "file:docs/nope.md" }, "ref-missing"],
		["an untracked file", { bin: "evidence", ref: "file:docs/untracked.md" }, "ref-not-tracked"],
		["planted: a pushed file unrelated to the content", { bin: "evidence", ref: "file:docs/tracked.md" }, "ref-transfer-unproven"],
		["a reference on a throwaway", { bin: "throwaway", ref: "file:docs/tracked.md" }, "throwaway-takes-no-ref"],
		["a hold at release", { bin: "hold", ref: "bead:ompkit-1" }, "hold-is-declared-at-creation"],
		["a reference with no bin", { ref: "file:docs/tracked.md" }, "ref-without-bin"],
	];
	for (const [name, opts, reason] of refused) {
		const { f, result } = attempt(opts);
		expect({ name, ...result }).toMatchObject({ name, ok: false, changed: false, reason });
		expect(existsSync(join(f.dir, ".omp-kit-release"))).toBe(false);
	}
	// The refusal names the token to cite; different content has a different token.
	const first = attempt({ bin: "evidence", ref: "file:docs/tracked.md" }, {}, "measured run A\n");
	const token = /scratch-sha256:[0-9a-f]{64}/.exec(first.result.detail ?? "")?.[0];
	expect(token).toBeDefined();
	expect(attempt({ bin: "evidence", ref: "file:docs/tracked.md" }, {}, "measured run B\n").result.detail).not.toContain(token!);
	// Citing the token: untracked, then staged, then committed but unpushed each refuse; pushed is admitted.
	writeFileSync(join(projectDir, "docs", "receipt.md"), `run A summary\n${token}\n`);
	const cite = () => {
		process.env.OMP_KIT_SCRATCH_ROOTS = first.f.root;
		return releaseScratch(first.f.dir, first.f.home, real, { bin: "evidence", ref: "file:docs/receipt.md" });
	};
	expect(cite()).toMatchObject({ ok: false, reason: "ref-not-tracked" });
	expect(git("add", "docs/receipt.md").exitCode).toBe(0);
	expect(cite()).toMatchObject({ ok: false, reason: "ref-uncommitted" });
	expect(git("commit", "-q", "-m", "receipt").exitCode).toBe(0);
	expect(cite()).toMatchObject({ ok: false, reason: "ref-unpushed" });
	expect(existsSync(join(first.f.dir, ".omp-kit-release"))).toBe(false);
	expect(git("push", "-q").exitCode).toBe(0);
	expect(cite()).toMatchObject({ ok: true, changed: true });
	expect(readFileSync(join(first.f.dir, ".omp-kit-release"), "utf8")).toContain("bin=evidence\nref=file:docs/receipt.md\n");
	// Near miss: a pushed byte-identical copy of a scratch file proves the content too (absolute paths resolve the same).
	writeFileSync(join(projectDir, "docs", "probe.ts"), "export const probe = 1;\n");
	expect(git("add", "docs/probe.ts").exitCode).toBe(0);
	expect(git("commit", "-q", "-m", "probe").exitCode).toBe(0);
	expect(git("push", "-q").exitCode).toBe(0);
	expect(attempt({ bin: "promote", ref: `file:${join(projectDir, "docs", "probe.ts")}` }, {}, "export const probe = 1;\n").result).toMatchObject({ ok: true });
	// Bead references: an existing bead with no citing comment is the planted negative; a comment citing the token passes.
	const bead = (comments: string[]) => ({ run: (args: readonly string[]) => args[0] === "br"
		? { code: 0, stdout: JSON.stringify([{ id: "ompkit-774u.15", comments: comments.map((text) => ({ text })) }]), stderr: "" } : realRun(args) });
	expect(attempt({ bin: "evidence", ref: "bead:ompkit-774u.15" }, bead(["unrelated note"]), "measured run A\n").result)
		.toMatchObject({ ok: false, reason: "ref-transfer-unproven" });
	const beadOk = attempt({ bin: "evidence", ref: "bead:ompkit-774u.15" }, bead([`run A results: ${token}`]), "measured run A\n");
	expect(beadOk.result).toMatchObject({ ok: true });
	expect(readFileSync(join(beadOk.f.dir, ".omp-kit-release"), "utf8")).toContain("ref=bead:ompkit-774u.15\n");
	expect(attempt({ bin: "evidence", ref: "bead:ompkit-nope" }, { run: () => ({ code: 1, stdout: "", stderr: "not found" }) }).result)
		.toMatchObject({ ok: false, reason: "ref-bead-unverified" });
});

test("a legacy free-form owner cannot be binned, and a marker whose bin and reference disagree is not a release", () => {
	const legacy = fixture("work\n");
	expect(releaseScratch(legacy.dir, legacy.home, deps(), { bin: "throwaway", legacyOwner: true, reason: "operator" })).toMatchObject({ ok: false, reason: "bin-needs-structured-owner" });
	const { dir, root, home } = fixture(ownerText(process.pid));
	expect(releaseScratch(dir, home, deps(), { bin: "throwaway" }).ok).toBe(true);
	const marker = readFileSync(join(dir, ".omp-kit-release"), "utf8");
	writeFileSync(join(dir, ".omp-kit-release"), marker.replace("bin=throwaway\n", "bin=evidence\n"));
	expect(inspectOne(dir, root, deps())?.reason).not.toBe("owner-released-would-quarantine");
	writeFileSync(join(dir, ".omp-kit-release"), marker.replace("bin=throwaway\n", "bin=hold\n"));
	expect(inspectOne(dir, root, deps())?.reason).not.toBe("owner-released-would-quarantine");
	writeFileSync(join(dir, ".omp-kit-release"), marker.replace("bin=throwaway\n", "bin=evidence\nref=not a reference\n"));
	expect(inspectOne(dir, root, deps())?.reason).not.toBe("owner-released-would-quarantine");
	writeFileSync(join(dir, ".omp-kit-release"), marker.replace("bin=throwaway\n", "bin=evidence\nref=file:docs/tracked.md\n"));
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "QUARANTINE", reason: "owner-released-would-quarantine" });
});

test("scratch release rejects an unknown --bin through the real CLI before touching anything", () => {
	const env = { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" };
	const child = Bun.spawnSync([process.execPath, "run", join(repo, "src", "cli.ts"), "scratch", "release", join(scratchParent, "none.1"), "--bin", "archive", "--json"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const out = child.stdout.toString();
	expect(out, child.stderr.toString()).toContain("SCRATCH_RELEASE_BIN_INVALID");
	expect(child.exitCode).not.toBe(0);
}, 120_000);

test("OWNERMSG1: a binned release on a one-bad-field JSON owner names the field and the accepted sets; valid legacy still releases", () => {
	const SETS = "pid,process_start,label,repo,created_at,argv0 or pid,label,repo,created";
	// Planted negative: the fleet-context form whose purpose contains a space.
	const spaced = JSON.stringify({ pid: process.pid, label: "work", repo, created: CREATED,
		purpose: "ompkit-774u.15.1 measurement scratch", bead: "ompkit-774u.15.1" });
	expect(parseOwnerFile(spaced)).toBeNull();
	expect(parseOwnerFileEx(spaced)).toMatchObject({ failure: { field: "purpose" } });
	expect(diagnoseOwnerFailure(spaced)).toContain("owner field 'purpose'");
	expect(diagnoseOwnerFailure(spaced)).toContain(SETS);
	const bad = fixture(spaced);
	const refused = releaseScratch(bad.dir, bad.home, deps(), { bin: "throwaway" });
	expect(refused).toMatchObject({ ok: false, changed: false, reason: "bin-needs-structured-owner" });
	expect(refused.detail).toContain("owner field 'purpose'");
	expect(refused.detail).toContain(SETS);
	expect(existsSync(join(bad.dir, ".omp-kit-release"))).toBe(false);
	// The no-bin refusal names the field too.
	const plain = fixture(JSON.stringify({ pid: 42, label: "w", repo, created: CREATED, purpose: "has space" }));
	const invalid = releaseScratch(plain.dir, plain.home, deps());
	expect(invalid).toMatchObject({ ok: false, reason: "owner-file-invalid" });
	expect(invalid.detail).toContain("owner field 'purpose'");
	// A valid legacy owner still releases with a bin.
	const legacy = fixture(ownerText(process.pid));
	expect(releaseScratch(legacy.dir, legacy.home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, changed: true });
	expect(diagnoseOwnerFailure(ownerText(42))).toBeNull();
});
