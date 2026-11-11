import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { retainReleases, runKitUpdateJob, type KitUpdateJobConfig } from "../../src/kit-update-job.ts";
import { retainFleetCaches } from "../../src/cache-retain.ts";
import { retainStateLedgers } from "../../src/ledger-retain.ts";
import { appendJsonl, readJsonl } from "../../src/kitlib/jsonl.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
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

function makeLedgerRoot(): string {
	const root = realpathSync(ownedTmp("stateretain-ledger", { root: join(import.meta.dir, "../../var/agent-tmp") }).path);
	roots.push(root);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}
/** Narrow one fixture row to its numeric `n`; the unchecked cast would trust the JSON shape blind. */
function rowNumber(row: unknown): number {
	if (row !== null && typeof row === "object" && "n" in row && typeof row.n === "number") return row.n;
	throw new Error(`expected a fixture row with numeric n, got ${JSON.stringify(row)?.slice(0, 80)}`);
}

test("STATERETAIN1: a ledger past the size threshold is archived; its newest window stays readable by the real reader", async () => {
	const root = makeLedgerRoot();
	const now = Date.now();
	const rows = Array.from({ length: 30 }, (_, index) => JSON.stringify({ n: index, pad: "x".repeat(40) }));
	writeFileSync(join(root, "gate-events.jsonl"), `${rows.join("\n")}\n`);
	const report = await retainStateLedgers(root, { maxBytes: 500, keepRows: 10, timestamp: "20261111T101800Z", nowMs: now });
	expect(report.errors).toEqual([]);
	expect(report.rotated).toHaveLength(1);
	const rotation = report.rotated[0]!;
	expect(rotation.ledger).toBe("gate-events.jsonl");
	expect(rotation.archive).toBe("gate-events.jsonl.20261111T101800Z.gz");
	expect(rotation.archivedRows).toBe(20);
	expect(rotation.keptRows).toBe(10);
	// The real reader (kitlib readJsonl, the same reader push-latency and project wakes use) sees the newest window.
	const read = readJsonl(join(root, "gate-events.jsonl"));
	expect(read.errors).toEqual([]);
	expect(read.rows.map(rowNumber)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
	// The archive holds exactly the oldest rows, compressed.
	const archived = gunzipSync(readFileSync(join(root, rotation.archive))).toString("utf8").trim().split("\n")
		.map(line => rowNumber(JSON.parse(line) as unknown));
	expect(archived).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
	// Planted negative: the oldest row is gone from the live ledger.
	expect(readFileSync(join(root, "gate-events.jsonl"), "utf8")).not.toContain('"n":0,');
	expect(readFileSync(join(root, "gate-events.jsonl"), "utf8")).toContain('"n":29,');
});

test("STATERETAIN1: a small stale ledger rotates by age; a fresh one and mail-wake are byte-identical", async () => {
	const root = makeLedgerRoot();
	const now = Date.now();
	const stale = Array.from({ length: 5 }, (_, index) => JSON.stringify({ n: index }));
	writeFileSync(join(root, "bash-corpus.jsonl"), `${stale.join("\n")}\n`);
	const agedAt = new Date(now - 40 * 86_400_000);
	utimesSync(join(root, "bash-corpus.jsonl"), agedAt, agedAt);
	// mail-wake.jsonl is excluded from rotation (bare appendFileSync writers the
	// lock cannot serialize); even stale it stays untouched.
	const wake = Array.from({ length: 5 }, (_, index) => JSON.stringify({ n: index }));
	writeFileSync(join(root, "mail-wake.jsonl"), `${wake.join("\n")}\n`);
	utimesSync(join(root, "mail-wake.jsonl"), agedAt, agedAt);
	const wakeBefore = readFileSync(join(root, "mail-wake.jsonl"));
	const fresh = Array.from({ length: 5 }, (_, index) => JSON.stringify({ m: index }));
	writeFileSync(join(root, "gate-events.jsonl"), `${fresh.join("\n")}\n`);
	const before = readFileSync(join(root, "gate-events.jsonl"), "utf8");
	const report = await retainStateLedgers(root, { maxBytes: 100 * 1024 * 1024, keepRows: 20_000, timestamp: "20261111T101800Z", nowMs: now });
	expect(report.errors).toEqual([]);
	expect(report.rotated.map(entry => entry.ledger)).toEqual(["bash-corpus.jsonl"]);
	const archived = gunzipSync(readFileSync(join(root, "bash-corpus.jsonl.20261111T101800Z.gz"))).toString("utf8").trim().split("\n")
		.map(line => rowNumber(JSON.parse(line) as unknown));
	expect(archived).toEqual([0]);
	const kept = readJsonl(join(root, "bash-corpus.jsonl"));
	expect(kept.errors).toEqual([]);
	expect(kept.rows.map(rowNumber)).toEqual([1, 2, 3, 4]);
	// Planted negative: the fresh ledger under both thresholds is untouched.
	expect(report.skipped).toContain("gate-events.jsonl: under both thresholds");
	expect(readFileSync(join(root, "gate-events.jsonl"), "utf8")).toBe(before);
	expect(readdirSync(root).filter(name => name.startsWith("gate-events.jsonl."))).toEqual([]);
	// Planted negative: mail-wake.jsonl is never rotated, however stale.
	expect(readFileSync(join(root, "mail-wake.jsonl")).equals(wakeBefore)).toBe(true);
	expect(readdirSync(root).filter(name => name.startsWith("mail-wake.jsonl."))).toEqual([]);
});

test("STATERETAIN1: planted — appends racing the rotation keep every row", async () => {
	// Without the writer lock the rename can land between a racing append's
	// open and write, stranding the row in the unlinked inode. The lock makes the
	// union exact in either order.
	const root = makeLedgerRoot();
	const now = Date.now();
	const ledger = join(root, "gate-events.jsonl");
	const rows = Array.from({ length: 500 }, (_, index) => JSON.stringify({ n: index, pad: "x".repeat(40) }));
	writeFileSync(ledger, `${rows.join("\n")}\n`);
	const rotation = retainStateLedgers(root, { maxBytes: 500, keepRows: 10, timestamp: "20261111T101800Z", nowMs: now });
	const racing = (async (): Promise<void> => {
		for (let index = 500; index < 520; index++) {
			await appendJsonl(ledger, () => ({ n: index }), { deadline_s: fixtureDeadlineS(), state_dir: root });
		}
	})();
	const [report] = await Promise.all([rotation, racing]);
	expect(report.errors).toEqual([]);
	expect(report.rotated).toHaveLength(1);
	const live = readJsonl(ledger);
	expect(live.errors).toEqual([]);
	const archived = gunzipSync(readFileSync(join(root, report.rotated[0]!.archive))).toString("utf8").trim().split("\n")
		.map(line => rowNumber(JSON.parse(line) as unknown));
	const all = [...archived, ...live.rows.map(rowNumber)].sort((a, b) => a - b);
	expect(all).toEqual(Array.from({ length: 520 }, (_, index) => index));
});

test("STATERETAIN1: a crash orphan archive with identical rows is reused, never duplicated", async () => {
	const root = makeLedgerRoot();
	const now = Date.now();
	const rows = Array.from({ length: 30 }, (_, index) => JSON.stringify({ n: index, pad: "x".repeat(40) }));
	writeFileSync(join(root, "gate-events.jsonl"), `${rows.join("\n")}\n`);
	const orphanText = `${rows.slice(0, 20).join("\n")}\n`;
	writeFileSync(join(root, "gate-events.jsonl.20261111T101800Z.gz"), gzipSync(Buffer.from(orphanText, "utf8")));
	const report = await retainStateLedgers(root, { maxBytes: 500, keepRows: 10, timestamp: "20261111T101800Z", nowMs: now });
	expect(report.errors).toEqual([]);
	expect(report.rotated).toHaveLength(1);
	expect(report.rotated[0]!.archive).toBe("gate-events.jsonl.20261111T101800Z.gz");
	// Planted negative: every row exists exactly once across the live ledger and the reused archive.
	const live = readJsonl(join(root, "gate-events.jsonl"));
	expect(live.errors).toEqual([]);
	const archived = gunzipSync(readFileSync(join(root, "gate-events.jsonl.20261111T101800Z.gz"))).toString("utf8").trim().split("\n")
		.map(line => rowNumber(JSON.parse(line) as unknown));
	const all = [...archived, ...live.rows.map(rowNumber)].sort((a, b) => a - b);
	expect(all).toEqual(Array.from({ length: 30 }, (_, index) => index));
});

test("STATERETAIN1: a foreign archive under the canonical name gets a fresh -N name; the orphan is untouched", async () => {
	const root = makeLedgerRoot();
	const now = Date.now();
	const rows = Array.from({ length: 30 }, (_, index) => JSON.stringify({ n: index, pad: "x".repeat(40) }));
	writeFileSync(join(root, "gate-events.jsonl"), `${rows.join("\n")}\n`);
	const orphan = gzipSync(Buffer.from("unrelated\n", "utf8"));
	writeFileSync(join(root, "gate-events.jsonl.20261111T101800Z.gz"), orphan);
	const report = await retainStateLedgers(root, { maxBytes: 500, keepRows: 10, timestamp: "20261111T101800Z", nowMs: now });
	expect(report.errors).toEqual([]);
	expect(report.rotated).toHaveLength(1);
	expect(report.rotated[0]!.archive).toBe("gate-events.jsonl.20261111T101800Z-2.gz");
	// Planted negative: the foreign orphan is byte-identical and the fresh archive holds the oldest rows.
	expect(readFileSync(join(root, "gate-events.jsonl.20261111T101800Z.gz")).equals(orphan)).toBe(true);
	const archived = gunzipSync(readFileSync(join(root, "gate-events.jsonl.20261111T101800Z-2.gz"))).toString("utf8").trim().split("\n")
		.map(line => rowNumber(JSON.parse(line) as unknown));
	expect(archived).toEqual(Array.from({ length: 20 }, (_, index) => index));
});

test("STATERETAIN1: claude-save receipts older than 30 days are archived; young ones and non-receipts stay", async () => {
	const root = makeLedgerRoot();
	const now = Date.now();
	const DAY = 86_400_000;
	const aged = (name: string, ageDays: number): void => {
		writeFileSync(join(root, name), JSON.stringify({ receipt: name }));
		const at = new Date(now - ageDays * DAY);
		utimesSync(join(root, name), at, at);
	};
	aged("claude-save-abc123.json", 40);
	aged("claude-save-young.json", 1);
	aged("unrelated.json", 40);
	const original = readFileSync(join(root, "claude-save-abc123.json"));
	const report = await retainStateLedgers(root, { nowMs: now, timestamp: "20261111T101800Z" });
	expect(report.errors).toEqual([]);
	expect(report.receiptsArchived.map(entry => entry.receipt)).toEqual(["claude-save-abc123.json"]);
	expect(existsSync(join(root, "claude-save-abc123.json"))).toBe(false);
	expect(existsSync(join(root, "claude-save-abc123.json.gz"))).toBe(true);
	expect(gunzipSync(readFileSync(join(root, "claude-save-abc123.json.gz"))).equals(original)).toBe(true);
	// Planted negatives: the young receipt and the non-receipt are untouched.
	expect(existsSync(join(root, "claude-save-young.json"))).toBe(true);
	expect(existsSync(join(root, "claude-save-young.json.gz"))).toBe(false);
	expect(existsSync(join(root, "unrelated.json"))).toBe(true);
	expect(existsSync(join(root, "unrelated.json.gz"))).toBe(false);
});

test("STATERETAIN1: planted negatives — bad arguments throw and a missing ledger is skipped, never created", async () => {
	const root = makeLedgerRoot();
	await expect(retainStateLedgers(join(root, "missing"))).rejects.toThrow("LEDGER_RETENTION_ARGUMENT_INVALID");
	expect(() => retainStateLedgers(root, { timestamp: "yesterday" })).toThrow("LEDGER_RETENTION_ARGUMENT_INVALID");
	expect(() => retainStateLedgers(root, { maxBytes: 0 })).toThrow("LEDGER_RETENTION_ARGUMENT_INVALID");
	const report = await retainStateLedgers(root, { nowMs: Date.now(), timestamp: "20261111T101800Z" });
	expect(report.errors).toEqual([]);
	expect(report.rotated).toEqual([]);
	expect(report.receiptsArchived).toEqual([]);
	expect(existsSync(join(root, "gate-events.jsonl"))).toBe(false);
});
