// NFSPROBE1 (ompkit-bdu5b, ompkit-1ra0d.255): a process launched by launchd cannot open() anything on the user's ovnfs NFS
// mount (stat answers, every open blocks until a signal), so the scheduled reaper's worker sat in openat on its first
// checkout root until the 30 minute cap on every run. One bounded `ls -A` per network mount now tells a blocked mount from
// a readable one, and roots under a blocked mount are skipped and reported instead of scanned.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, findBlockedNetworkMounts, isApplyFailure, parseProbeMounts, resolveScratchRootEntries, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const scratchParent = join(resolve(import.meta.dir, "../.."), "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const owned: OwnedTmp[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const tmp of owned.splice(0)) tmp.cleanup();
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// Every owner pid is dead, so an owned dir older than the guards is reapable.
const allDead: LivenessDeps = {
	signalAlive: () => false,
	psVisible: () => false,
	processStart: () => null,
	probe: owner => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }),
};

const OVNFS_LINE = "</Users/josh/.local/state/ovnfs/nfs.sock>:/ on /Users/josh/checkouts (nfs, nodev, nosuid, noatime, nobrowse, mounted by josh)";
const APFS_LINE = "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)";

function netRunner(mount: string, probeCode: number | null, calls: string[][]): ScratchRunner {
	return args => {
		calls.push([...args]);
		if (args[0] === "mount") return { code: 0, stdout: `${APFS_LINE}\n</state/nfs.sock>:/ on ${mount} (nfs, nodev, nosuid, noatime, nobrowse, mounted by josh)\n`, stderr: "" };
		if (args[0] === "ls") return { code: probeCode, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};
}

function world(): { root: string; home: string; mount: string; dead: string } {
	const tmp = ownedTmp("nfsprobe", { root: scratchParent });
	owned.push(tmp);
	const mount = join(tmp.path, "repo");
	const root = join(mount, "var", "agent-tmp");
	const home = join(tmp.path, "home");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	const dead = join(root, "f-dead.599901");
	mkdirSync(dead);
	writeFileSync(join(dead, "work.txt"), "work");
	writeFileSync(join(dead, ".owner"), `pid=599901\nlabel=f-dead\nrepo=${mount}\ncreated=2026-10-01T00:00:00Z\nbin=throwaway\npurpose=probe\n`);
	return { root, home, mount, dead };
}

test("NFSPROBE1: a mount whose probe returns nothing is reported, its roots are not scanned, and nothing under it is touched", () => {
	const { root, home, mount, dead } = world();
	const calls: string[][] = [];
	const result = applyScratch(home, { liveness: allDead, run: netRunner(mount, null, calls), home, systemTempBases: [], cursorStore: null, probeNetworkMounts: true, networkProbeTimeoutMs: 50 });
	expect(result.blockedMounts?.map(blocked => blocked.mount)).toEqual([mount]);
	expect(result.blockedMounts?.[0]?.probe).toBe(`ls -A ${mount}`);
	expect(result.roots).not.toContain(root);
	expect(result.sessions).toHaveLength(0);
	expect(existsSync(dead)).toBe(true);
	expect(calls.filter(call => call[0] === "ls")).toEqual([["ls", "-A", mount]]);
}, fixtureDeadlineS() * 1000);

test("NFSPROBE1 control: the same mount answering its probe is scanned and the dead dir is reaped", () => {
	const { root, home, mount, dead } = world();
	const result = applyScratch(home, { liveness: allDead, run: netRunner(mount, 0, []), home, systemTempBases: [], cursorStore: null, probeNetworkMounts: true });
	expect(result.blockedMounts).toEqual([]);
	expect(result.roots).toContain(root);
	expect(existsSync(dead)).toBe(false);
}, fixtureDeadlineS() * 1000);

test("NFSPROBE1: a probe that answers with an error still counts as readable", () => {
	expect(findBlockedNetworkMounts(netRunner("/Users/josh/checkouts", 1, []))).toEqual([]);
});

test("NFSPROBE1: probing is off unless asked, and then no mount or ls child runs", () => {
	const { home, mount, dead } = world();
	const calls: string[][] = [];
	const result = applyScratch(home, { liveness: allDead, run: netRunner(mount, null, calls), home, systemTempBases: [], cursorStore: null });
	expect(result.blockedMounts).toBeUndefined();
	expect(calls.filter(call => call[0] === "mount" || call[0] === "ls")).toEqual([]);
	expect(existsSync(dead)).toBe(false);
}, fixtureDeadlineS() * 1000);

test("NFSPROBE1: only network mount points are probed, each once, never a local volume or a root", () => {
	const calls: string[][] = [];
	expect(findBlockedNetworkMounts(netRunner("/Users/josh/checkouts", null, calls), 50).map(blocked => blocked.mount)).toEqual(["/Users/josh/checkouts"]);
	expect(calls.filter(call => call[0] === "ls")).toEqual([["ls", "-A", "/Users/josh/checkouts"]]);
});

test("NFSPROBE1: while a mount is blocked, root discovery drops roots under it (a sibling sharing the prefix stays) and the state is cleared afterwards", () => {
	const { home, mount } = world();
	process.env.OMP_KIT_SCRATCH_ROOTS = [join(mount, "var", "agent-tmp"), `${mount}X/var/agent-tmp`].join(":");
	const result = applyScratch(home, { liveness: allDead, run: netRunner(mount, null, []), home, systemTempBases: [], cursorStore: null, probeNetworkMounts: true, networkProbeTimeoutMs: 50 });
	expect(result.roots).toEqual([`${mount}X/var/agent-tmp`]);
	expect(resolveScratchRootEntries(home).map(entry => entry.root)).toEqual([join(mount, "var", "agent-tmp"), `${mount}X/var/agent-tmp`]);
});

test("NFSPROBE1: parseProbeMounts keeps network volumes and anything under /Volumes, and nothing else", () => {
	const text = [OVNFS_LINE, APFS_LINE, "//josh@nas._smb._tcp.local/My Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by josh)",
		"/dev/disk8s2 on /Volumes/ZestData (apfs, local, nodev, nosuid, journaled)",
		"devfs on /dev (devfs, local, nobrowse)", "garbage with no parentheses", "x on relative/path (nfs)", "x on /srv/odd (constructor, local)"].join("\n");
	expect(parseProbeMounts(text)).toEqual(["/Users/josh/checkouts", "/Volumes/My Share", "/Volumes/ZestData"]);
});

test("NFSPROBE1: the probe command is the caller's, carries its environment, and a silent probe names the command in the report", () => {
	const seen: { args: readonly string[]; env: Record<string, string> | undefined }[] = [];
	const run: ScratchRunner = (args, opts) => {
		if (args[0] === "mount") return { code: 0, stdout: "/dev/disk8s2 on /Volumes/ZestData (apfs, local, nodev, nosuid, journaled)\n", stderr: "" };
		seen.push({ args, env: opts?.env });
		return { code: null, stdout: "", stderr: "" };
	};
	const blocked = findBlockedNetworkMounts(run, 50, mount => ({ args: ["self", "--probe"], env: { OMP_KIT_SCRATCH_PROBE: mount } }));
	expect(seen).toEqual([{ args: ["self", "--probe"], env: { OMP_KIT_SCRATCH_PROBE: "/Volumes/ZestData" } }]);
	expect(blocked.map(row => [row.mount, row.probe])).toEqual([["/Volumes/ZestData", "self --probe"]]);
});

test("NFSPROBE1: a pathological long line is ignored in linear time", () => {
	const long = `${"a on ".repeat(2000)}(nfs`;
	const started = Date.now();
	expect(parseProbeMounts(`${long}\n${OVNFS_LINE}`)).toEqual(["/Users/josh/checkouts"]);
	expect(Date.now() - started).toBeLessThan(500);
});

// PeachLeopard AM92344 (ompkit-1ra0d.255 [c]): a run passes when it ends COMPLETE with exit 0; refusing to touch something still in use is the
// safety working and is counted in refused_count, while an operational error stays a failure.
test("REAPFAIL1: a dir still in use or whose owner changed is a refusal, an operational error is a failure", () => {
	const skip = (reason: string) => ({ dir: "x", action: "SKIP" as const, reason, owner: null, sizeBytes: 0 });
	for (const reason of ["owner-released-but-open-fds-present", "owner-changed-after-initial-check", "owner-release-changed-after-initial-check"]) expect(isApplyFailure(skip(reason))).toBe(false);
	for (const reason of ["delete-failed", "atomic-quarantine-failed", "quarantine-rollback-failed", "lsof-evidence-unavailable"]) expect(isApplyFailure(skip(reason))).toBe(true);
});
