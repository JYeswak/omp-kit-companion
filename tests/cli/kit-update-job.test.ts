import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollPublishedRelease, runKitUpdateJob, type KitUpdateJobConfig } from "../../src/kit-update-job.ts";
const dirs: string[] = [];
function config(enabled = true): KitUpdateJobConfig {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp/l8-job-")); dirs.push(root);
	return { enabled, prefix: root, stateRoot: join(root, "state"), home: root, platform: { os: "darwin", arch: "arm64", libc: "none" }, project: root, pollRelease: async () => ({ indexPath: join(root, "index.json"), archivePath: join(root, "kit.tar"), version: "1.2.4", sourceTag: "v1.2.4" }) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("kit-update job is disabled by default and does not poll", async () => {
	let polled = false; const value = config(false); value.pollRelease = async () => { polled = true; return await config().pollRelease(); };
	const result = await runKitUpdateJob(value);
	expect(result).toMatchObject({ status: "DISABLED", notification: false }); expect(polled).toBe(false);
});

test("fake newer certified release becomes UPDATED, relinks the plugin and notifies one line", async () => {
	const value = config(); let applied = false; const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY", current: { version: "1.2.3", sha256: "a".repeat(64), target: "../releases/1.2.3/bin/omp-kit", binary: "/x" }, release: {} } as never),
		apply: async () => { applied = true; return { status: "UPDATED", exitCode: 0, receiptId: "r1", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }; },
		relink: async binary => { expect(binary).toBe(join(value.prefix, "bin", "omp-kit")); return { ok: true, detail: "linked" }; },
		notify: message => { notes.push(message); },
	});
	expect(applied).toBe(true); expect(result).toMatchObject({ status: "UPDATED", receiptId: "r1", activeVersion: "1.2.4", notification: true, relink: "APPLIED" });
	expect(notes).toHaveLength(1); expect(notes[0]).toContain("1.2.4"); expect(notes[0]).toContain("r1");
	expect(readdirSync(value.stateRoot)).toHaveLength(1);
});

test("postcheck failure reports UNDONE, notifies and never relinks", async () => {
	const value = config(); const notes: string[] = []; let relinked = false;
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => ({ status: "PARTIAL", exitCode: 1, receiptId: "r2", activeVersion: "1.2.3", postcheck: { status: "FAIL", matcher: "PASS", live: "FAIL" }, provenance: "INTEGRITY_ONLY" }),
		notify: message => { notes.push(message); },
		relink: async () => { relinked = true; return { ok: true, detail: "" }; },
	});
	expect(result).toMatchObject({ status: "UNDONE", receiptId: "r2", notification: true, relink: "NOT_RUN" });
	expect(relinked).toBe(false); expect(notes[0]).toContain("automatic undo");
	expect(existsSync(join(value.stateRoot, readdirSync(value.stateRoot)[0]!))).toBe(true);
});

test("planted: relink failure keeps the update, reports BLOCKED and keeps the receipt", async () => {
	const value = config(); const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => ({ status: "UPDATED", exitCode: 0, receiptId: "r3", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }),
		notify: message => { notes.push(message); },
		relink: async () => ({ ok: false, detail: "exit 1: link refused" }),
	});
	expect(result).toMatchObject({ status: "UPDATED", receiptId: "r3", activeVersion: "1.2.4", notification: true, reason: "PLUGIN_RELINK_FAILED", relink: "FAILED" });
	expect(notes).toHaveLength(1); expect(notes[0]).toContain("BLOCKED"); expect(notes[0]).toContain("r3");
});

function installSymlink(root: string, version: string): void {
	mkdirSync(join(root, "bin"), { recursive: true });
	mkdirSync(join(root, "releases", version, "bin"), { recursive: true });
	symlinkSync(`../releases/${version}/bin/omp-kit`, join(root, "bin", "omp-kit"));
}

function withPollEnv(repo: string | null, fn: () => Promise<void>): Promise<void> {
	const savedPoll = process.env.OMP_KIT_UPDATE_POLL, savedRepo = process.env.OMP_KIT_UPDATE_REPO;
	try {
		if (repo === null) { delete process.env.OMP_KIT_UPDATE_POLL; delete process.env.OMP_KIT_UPDATE_REPO; }
		else { process.env.OMP_KIT_UPDATE_POLL = "github"; process.env.OMP_KIT_UPDATE_REPO = repo; }
		return fn();
	} finally {
		if (savedPoll === undefined) delete process.env.OMP_KIT_UPDATE_POLL; else process.env.OMP_KIT_UPDATE_POLL = savedPoll;
		if (savedRepo === undefined) delete process.env.OMP_KIT_UPDATE_REPO; else process.env.OMP_KIT_UPDATE_REPO = savedRepo;
	}
}

test("poll is inert without OMP_KIT_UPDATE_POLL: the static tuple still flows", async () => {
	await withPollEnv(null, async () => {
		const value = config(); let polled = false;
		value.pollRelease = async () => { polled = true; return { indexPath: join(value.prefix, "i"), archivePath: join(value.prefix, "a"), version: "9.9.9", sourceTag: "v9.9.9" }; };
		const seen = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async () => { throw new Error("network must not be touched"); } });
		expect(seen).toBeNull(); expect(polled).toBe(false);
		const result = await runKitUpdateJob(value, { plan: async input => ({ ...input, status: "CURRENT", exitCode: 0, provenance: "INTEGRITY_ONLY", current: { version: "9.9.9", sha256: "b".repeat(64), target: "t", binary: "b" } } as never) });
		expect(polled).toBe(true); expect(result).toMatchObject({ status: "CURRENT", relink: "NOT_RUN" });
	});
});

test("poll downloads a newer published release into one directory", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		const calls: string[][] = [];
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
			calls.push([...argv]);
			if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
			const dir = argv[argv.indexOf("--dir") + 1]!;
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "release-index.json"), "{}");
			writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
			return { exit: 0, stdout: "", stderr: "" };
		} });
		expect(tuple).toMatchObject({ version: "1.2.4", sourceTag: "v1.2.4" });
		expect(tuple!.indexPath).toBe(join(value.stateRoot, "poll-1.2.4", "release-index.json"));
		expect(tuple!.archivePath).toBe(join(value.stateRoot, "poll-1.2.4", "omp-kit-v1.2.4-darwin-arm64-none.tar"));
		expect(calls[0]).toContain("view");
	});
});

test("planted: poll returns null when the published release is not newer (no downgrade, no download)", async () => {
	await withPollEnv("o/r", async () => {
		for (const installed of ["1.2.4", "1.2.9"]) {
			const value = config(); installSymlink(value.prefix, installed);
			let downloads = 0;
			const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
				if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
				downloads++;
				return { exit: 0, stdout: "", stderr: "" };
			} });
			expect(tuple).toBeNull(); expect(downloads).toBe(0);
		}
	});
});

test("planted: poll refuses a non-semver latest tag instead of installing it", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform,
			{ exec: async () => ({ exit: 0, stdout: "v1.2.4-rehearsal.1.1\n", stderr: "" }) })).rejects.toThrow("KIT_UPDATE_POLL_UNVERIFIED");
	});
});

test("planted: poll refuses a missing repo slug instead of querying blindly", async () => {
	await withPollEnv("not a slug!", async () => {
		const value = config();
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform,
			{ exec: async () => { throw new Error("network must not be touched"); } })).rejects.toThrow("KIT_UPDATE_POLL_CONFIG");
	});
});
