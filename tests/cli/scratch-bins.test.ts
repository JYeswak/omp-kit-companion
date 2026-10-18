// ompkit-774u.15 SCRATCHBIN1 A and B: an owner record names the bin a scratch dir goes to when its work ends, a hold is
// bounded to 14 days and never reaped while it stands, and the owner's release records the bin with the reference that
// proves where the content went.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScratch, inspectOne, inspectSession, parseOwnerFile, releaseScratch, SCRATCH_BINS,
	type InspectDeps, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";

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
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null };
const deps = (extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness: noPid, run: clearRun, now: NOW, ...extra });
const ownerText = (pid: number, extra = "", created = CREATED) => `pid=${pid}\nlabel=work\nrepo=${repo}\ncreated=${created}\n${extra}`;

function fixture(owner: string, label = "work"): { dir: string; root: string; home: string } {
	const root = mkdtempSync(join(scratchParent, "bins-"));
	const home = mkdtempSync(join(scratchParent, "bins-home-"));
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

test("a malformed bin group makes the owner record malformed: unknown bin, purpose or bead alone, a bad token, expires on a non-hold", () => {
	for (const extra of ["bin=archive\n", "purpose=probe\n", "bead=ompkit-1\n", "bin=throwaway\nexpires=2026-10-20\n", "bin=throwaway\npurpose=has space\n",
		`bin=throwaway\npurpose=${"p".repeat(41)}\n`, "bin=throwaway\nbead=-bad\n", "bin=\n"])
		expect({ extra, parsed: parseOwnerFile(ownerText(42, extra)) }).toEqual({ extra, parsed: null });
	expect(parseOwnerFile(ownerText(42, `bin=throwaway\npurpose=${"p".repeat(40)}\n`))).not.toBeNull();
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
	const root = mkdtempSync(join(scratchParent, "bins-hold-"));
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
	const root = mkdtempSync(join(scratchParent, "bins-create-"));
	cleanup.push(root);
	const live: LivenessDeps = { ...noPid, processStart: () => "Mon Oct 18 17:32:44 2026" };
	const ok = createScratch("probe", root, deps({ liveness: live }), { bin: "hold", purpose: "probe", bead: "ompkit-774u.15", expires: "2026-10-25" });
	expect(ok).toMatchObject({ ok: true, reason: "created" });
	expect(parseOwnerFile(readFileSync(join(ok.dir, ".owner"), "utf8"))).toMatchObject({ bin: "hold", purpose: "probe", bead: "ompkit-774u.15", expires: "2026-10-25" });
	const bad = createScratch("other", root, deps({ liveness: live }), { bin: "hold", purpose: "probe" });
	expect(bad).toMatchObject({ ok: false, reason: "bin-invalid" });
	expect(existsSync(join(root, "var", "agent-tmp", `other.${process.pid}`))).toBe(false);
});

test("release --bin throwaway records the bin with no reference, and the release still moves the dir to quarantine", () => {
	const { dir, root, home } = fixture(ownerText(process.pid));
	expect(releaseScratch(dir, home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, changed: true });
	expect(readFileSync(join(dir, ".omp-kit-release"), "utf8")).toContain("bin=throwaway\n");
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "QUARANTINE", reason: "owner-released-would-quarantine" });
});

test("release --bin evidence or promote needs a reference that exists: a tracked file in the owner's repo or a bead br finds", () => {
	const projectDir = mkdtempSync(join(scratchParent, "bins-repo-"));
	cleanup.push(projectDir);
	const git = (...args: string[]) => Bun.spawnSync(["git", "-C", projectDir, ...args], { stdout: "pipe", stderr: "pipe" });
	expect(git("init", "-q").exitCode).toBe(0);
	mkdirSync(join(projectDir, "docs"));
	writeFileSync(join(projectDir, "docs", "tracked.md"), "evidence\n");
	writeFileSync(join(projectDir, "docs", "untracked.md"), "loose\n");
	expect(git("add", "docs/tracked.md").exitCode).toBe(0);
	const real = deps({ run: (args) => { const r = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; } });
	const owner = `pid=${process.pid}\nlabel=work\nrepo=${projectDir}\ncreated=${CREATED}\n`;
	const attempt = (opts: Parameters<typeof releaseScratch>[3], run: Partial<InspectDeps> = {}) => {
		const f = fixture(owner);
		return { f, result: releaseScratch(f.dir, f.home, { ...real, ...run }, opts) };
	};
	const refused: [string, Parameters<typeof releaseScratch>[3], string][] = [
		["no reference", { bin: "evidence" }, "ref-required"],
		["a malformed reference", { bin: "evidence", ref: "docs/tracked.md" }, "ref-invalid"],
		["a reference with whitespace", { bin: "promote", ref: "file:docs/a b.md" }, "ref-invalid"],
		["a file outside the repo", { bin: "evidence", ref: "file:../../etc/hosts" }, "ref-outside-repo"],
		["a missing file", { bin: "evidence", ref: "file:docs/nope.md" }, "ref-missing"],
		["an untracked file", { bin: "evidence", ref: "file:docs/untracked.md" }, "ref-not-tracked"],
		["a reference on a throwaway", { bin: "throwaway", ref: "file:docs/tracked.md" }, "throwaway-takes-no-ref"],
		["a hold at release", { bin: "hold", ref: "bead:ompkit-1" }, "hold-is-declared-at-creation"],
		["a reference with no bin", { ref: "file:docs/tracked.md" }, "ref-without-bin"],
	];
	for (const [name, opts, reason] of refused) {
		const { f, result } = attempt(opts);
		expect({ name, ...result }).toMatchObject({ name, ok: false, changed: false, reason });
		expect(existsSync(join(f.dir, ".omp-kit-release"))).toBe(false);
	}
	const tracked = attempt({ bin: "evidence", ref: "file:docs/tracked.md" });
	expect(tracked.result).toMatchObject({ ok: true, changed: true });
	expect(readFileSync(join(tracked.f.dir, ".omp-kit-release"), "utf8")).toContain("bin=evidence\nref=file:docs/tracked.md\n");
	expect(attempt({ bin: "promote", ref: `file:${join(projectDir, "docs", "tracked.md")}` }).result).toMatchObject({ ok: true });
	const beadOk = attempt({ bin: "evidence", ref: "bead:ompkit-774u.15" }, { run: () => ({ code: 0, stdout: "[{\"id\":\"ompkit-774u.15\"}]", stderr: "" }) });
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
