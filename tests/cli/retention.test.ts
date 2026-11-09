import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retainReleases } from "../../src/kit-update-job.ts";
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
