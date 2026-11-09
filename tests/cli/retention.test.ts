import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retainReleases, runKitUpdateJob, type KitUpdateJobConfig } from "../../src/kit-update-job.ts";
import { retainFleetCaches } from "../../src/cache-retain.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
const roots: string[] = [];
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const versionsIn = (from: number, to: number): string[] => {
	const out: string[] = [];
	for (let minor = from; minor <= to; minor++) out.push(`0.2.${minor}`);
	return out;
};

function makePrefix(versions: string[], active: string, polls: string[] = [], pinned: string[] = []): { prefix: string; stateRoot: string } {
	const root = realpathSync(ownedTmp("stateretain", { root: join(import.meta.dir, "../../var/agent-tmp") }).path);
	roots.push(root);
	const prefix = join(root, "kit");
	mkdirSync(join(prefix, "releases"), { recursive: true });
	for (const version of versions) {
		mkdirSync(join(prefix, "releases", version, "bin"), { recursive: true });
		writeFileSync(join(prefix, "releases", version, "bin", "omp-kit"), "#!/bin/sh\nexit 0\n");
	}
	mkdirSync(join(prefix, "bin"), { recursive: true });
	symlinkSync(`../releases/${active}/bin/omp-kit`, join(prefix, "bin", "omp-kit"));
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	for (const poll of polls) {
		mkdirSync(join(stateRoot, poll), { recursive: true });
		writeFileSync(join(stateRoot, poll, "release-index.json"), "{}\n");
	}
	if (pinned.length > 0) writeFileSync(join(prefix, "releases", ".pinned"), `${pinned.join("\n")}\n`);
	return { prefix, stateRoot };
}

test("STATERETAIN1: active, predecessor and last five releases survive; older releases are pruned", () => {
	const { prefix, stateRoot } = makePrefix(versionsIn(95, 104), "0.2.104");
	const retention = retainReleases(prefix, stateRoot, "0.2.104", [null]);
	expect(retention.status).toBe("APPLIED");
	// Planted negative: the active release and its predecessor are never pruned.
	expect(retention.kept).toEqual(["0.2.99", "0.2.100", "0.2.101", "0.2.102", "0.2.103", "0.2.104"]);
	expect([...retention.removed].sort()).toEqual(["0.2.95", "0.2.96", "0.2.97", "0.2.98"]);
	expect(retention.removed).not.toContain("0.2.104");
	expect(retention.removed).not.toContain("0.2.103");
	for (const version of retention.removed) expect(existsSync(join(prefix, "releases", version))).toBe(false);
	for (const version of retention.kept) expect(existsSync(join(prefix, "releases", version))).toBe(true);
	expect(existsSync(join(prefix, "bin", "omp-kit"))).toBe(true);
});

test("STATERETAIN1: pinned releases survive outside the window; invalid pin lines are ignored", () => {
	const { prefix, stateRoot } = makePrefix(versionsIn(95, 104), "0.2.104", [],
		["0.2.95", "# operator hold for rollback", "not-a-version", ""]);
	const retention = retainReleases(prefix, stateRoot, "0.2.104", []);
	expect(retention.status).toBe("APPLIED");
	expect(retention.kept).toContain("0.2.95");
	expect(retention.removed).not.toContain("0.2.95");
	expect(existsSync(join(prefix, "releases", "0.2.95"))).toBe(true);
	expect(existsSync(join(prefix, "releases", "0.2.96"))).toBe(false);
	// The pin file itself is never mistaken for a release.
	expect(retention.removed).not.toContain(".pinned");
	expect(existsSync(join(prefix, "releases", ".pinned"))).toBe(true);
});

test("STATERETAIN1: protected running versions survive outside the window", () => {
	const { prefix, stateRoot } = makePrefix(versionsIn(95, 104), "0.2.104");
	const retention = retainReleases(prefix, stateRoot, "0.2.104", ["0.2.95"]);
	expect(retention.status).toBe("APPLIED");
	expect(retention.kept).toContain("0.2.95");
	expect(retention.removed).not.toContain("0.2.95");
	expect(existsSync(join(prefix, "releases", "0.2.95"))).toBe(true);
});

test("STATERETAIN1: poll dirs older than the window are pruned by leading version; kept, newer and unparseable polls survive", () => {
	const { prefix, stateRoot } = makePrefix(versionsIn(99, 104), "0.2.104", [
		"poll-0.2.95",
		"poll-0.2.95.stale-interrupted-20261019",
		"poll-0.2.99",
		"poll-0.2.104",
		"poll-0.2.110",
		"poll-next",
	]);
	const retention = retainReleases(prefix, stateRoot, "0.2.104", []);
	expect(retention.status).toBe("APPLIED");
	// Planted negative: the active release's poll is never pruned.
	expect(retention.pollsRemoved).toContain("poll-0.2.95");
	expect(retention.pollsRemoved).toContain("poll-0.2.95.stale-interrupted-20261019");
	expect(retention.pollsRemoved).not.toContain("poll-0.2.104");
	expect(retention.pollsRemoved).not.toContain("poll-0.2.99");
	expect(retention.pollsRemoved).not.toContain("poll-0.2.110");
	expect(retention.pollsRemoved).not.toContain("poll-next");
	expect(existsSync(join(stateRoot, "poll-0.2.95"))).toBe(false);
	expect(existsSync(join(stateRoot, "poll-0.2.95.stale-interrupted-20261019"))).toBe(false);
	expect(existsSync(join(stateRoot, "poll-0.2.104"))).toBe(true);
	expect(existsSync(join(stateRoot, "poll-next"))).toBe(true);
});

test("STATERETAIN1: retention refuses without touching anything when the active link is unverified", () => {
	const { prefix, stateRoot } = makePrefix(versionsIn(99, 104), "0.2.104", ["poll-0.2.99"]);
	rmSync(join(prefix, "bin", "omp-kit"));
	symlinkSync("../releases/0.2.999/bin/omp-kit", join(prefix, "bin", "omp-kit"));
	const retention = retainReleases(prefix, stateRoot, "0.2.104", []);
	expect(retention.status).toBe("FAILED");
	expect(retention.removed).toEqual([]);
	expect(retention.pollsRemoved).toEqual([]);
	expect(readdirSync(join(prefix, "releases")).filter(name => name !== ".pinned")).toHaveLength(6);
	expect(existsSync(join(stateRoot, "poll-0.2.99"))).toBe(true);
});

function jobConfig(prefix: string, stateRoot: string): KitUpdateJobConfig {
	return { enabled: true, prefix, stateRoot, home: prefix,
		platform: { os: "darwin", arch: "arm64", libc: "none" },
		pollRelease: async () => ({ indexPath: join(prefix, "index.json"), archivePath: join(prefix, "kit.tar"), version: "1.0.7", sourceTag: "v1.0.7" }) };
}

test("STATERETAIN1: postcheck FAIL after a successful activation still prunes older than active+5", async () => {
	// The deadlock: retention used to require postcheck PASS, so a bloated state
	// root failed every postcheck and retention never ran. The job now retains on
	// activation success alone. Planted negative: pre-change code leaves
	// result.retention undefined here, failing the APPLIED assertion below.
	const { prefix, stateRoot } = makePrefix(
		["1.0.0", "1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6", "1.0.7", "1.1.0"], "1.0.7",
		["poll-1.0.0", "poll-1.0.7"]);
	const savedPoll = process.env.OMP_KIT_UPDATE_POLL, savedRepo = process.env.OMP_KIT_UPDATE_REPO;
	delete process.env.OMP_KIT_UPDATE_POLL; delete process.env.OMP_KIT_UPDATE_REPO;
	try {
		const result = await runKitUpdateJob(jobConfig(prefix, stateRoot), {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" }) as never,
			apply: async () => ({ status: "UPDATED", exitCode: 0, receiptId: "stateretain-r1",
				activeVersion: "1.0.7", postcheck: { status: "FAIL", matcher: "PASS", live: "PASS", reason: "KIT_POSTCHECK_FAILED" },
				provenance: "SIGSTORE_VERIFIED" }),
			relink: async () => ({ ok: true, detail: "fixture relink", receiptId: "fixture-plugin", undoCommand: "omp-kit undo fixture-plugin --yes" }),
			reconcile: async () => ({ ok: true, detail: "fixture reconcile" }),
			refreshHooks: async () => ({ repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 0, results: [] }),
			notify: () => {},
		});
		expect(result.status).toBe("UPDATED");
		expect(result.retention?.status).toBe("APPLIED");
		expect(result.retention?.kept).toContain("1.0.7");
		expect(result.retention?.kept).toContain("1.0.6");
		expect(result.retention?.removed).toContain("1.0.0");
		expect(result.retention?.removed).toContain("1.0.1");
		expect(result.retention?.removed).not.toContain("1.0.7");
		expect(result.retention?.removed).not.toContain("1.0.6");
		expect(existsSync(join(prefix, "releases", "1.0.0"))).toBe(false);
		expect(existsSync(join(prefix, "releases", "1.0.7"))).toBe(true);
		expect(existsSync(join(prefix, "releases", "1.0.6"))).toBe(true);
		expect(existsSync(join(stateRoot, "poll-1.0.0"))).toBe(false);
		expect(existsSync(join(stateRoot, "poll-1.0.7"))).toBe(true);
	} finally {
		if (savedPoll !== undefined) process.env.OMP_KIT_UPDATE_POLL = savedPoll;
		if (savedRepo !== undefined) process.env.OMP_KIT_UPDATE_REPO = savedRepo;
	}
});

test("STATERETAIN1: a CURRENT no-op job run writes no record while a FAILED run still does", async () => {
	// Planted negative: pre-change code writes a kit-update-job-*.json record for
	// the CURRENT tick, failing the zero-records assertion below.
	const { prefix, stateRoot } = makePrefix(["1.0.7"], "1.0.7");
	const idle: KitUpdateJobConfig = { ...jobConfig(prefix, stateRoot), pollRelease: async () => null };
	const current = await runKitUpdateJob(idle);
	expect(current).toMatchObject({ status: "CURRENT", activeVersion: "1.0.7" });
	expect(readdirSync(stateRoot).filter(name => name.startsWith("kit-update-job-"))).toEqual([]);
	const failing = await runKitUpdateJob(jobConfig(prefix, stateRoot), {
		plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" }) as never,
		apply: async () => { throw new Error("fixture activation refused"); },
	});
	expect(failing.status).toBe("FAILED");
	const records = readdirSync(stateRoot).filter(name => name.startsWith("kit-update-job-"));
	expect(records).toHaveLength(1);
});

test("STATERETAIN1: cache-retain expires old upgrade-notice and git-lock-rate files and keeps young ones", async () => {
	// Planted negative: pre-change selection keeps upgrade-notice-* forever,
	// failing the expired-notice assertion below. plugin-* receipts stay out of
	// expiry because recovery reads them.
	const DAY = 86_400_000, now = Date.now();
	const root = realpathSync(ownedTmp("stateretain-cache", { root: join(import.meta.dir, "../../var/agent-tmp") }).path);
	roots.push(root);
	const home = join(root, "home"), kit = join(home, ".local", "state", "omp-kit");
	mkdirSync(kit, { recursive: true });
	const aged = (name: string, ageDays: number) => {
		writeFileSync(join(kit, name), JSON.stringify({ name }));
		const at = new Date(now - ageDays * DAY);
		utimesSync(join(kit, name), at, at);
	};
	aged("upgrade-notice-0123456789abcdef.json", 120);
	aged("upgrade-notice-fedcba9876543210.json", 0);
	aged("git-lock-rate.ledger", 120);
	aged("plugin-keepme.json", 120);
	const report = await retainFleetCaches(home, join(root, "removed.jsonl"), { nowMs: now, openFiles: new Set() });
	expect(report.overall).toBe("OK");
	expect(existsSync(join(kit, "upgrade-notice-0123456789abcdef.json"))).toBe(false);
	expect(existsSync(join(kit, "upgrade-notice-fedcba9876543210.json"))).toBe(true);
	expect(existsSync(join(kit, "git-lock-rate.ledger"))).toBe(false);
	expect(existsSync(join(kit, "plugin-keepme.json"))).toBe(true);
});
