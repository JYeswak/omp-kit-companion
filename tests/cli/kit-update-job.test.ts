import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runKitUpdateJob, type KitUpdateJobConfig } from "../../src/kit-update-job.ts";
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

test("fake newer certified release becomes UPDATED and writes a run receipt", async () => {
	const value = config(); let applied = false;
	const result = await runKitUpdateJob(value, { plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY", current: { version: "1.2.3", sha256: "a".repeat(64), target: "../releases/1.2.3/bin/omp-kit", binary: "/x" }, release: {} } as never), apply: async () => { applied = true; return { status: "UPDATED", exitCode: 0, receiptId: "r1", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }; } });
	expect(applied).toBe(true); expect(result).toMatchObject({ status: "UPDATED", receiptId: "r1", activeVersion: "1.2.4" }); expect(readdirSync(value.stateRoot)).toHaveLength(1);
});

test("postcheck failure reports UNDONE and notifies", async () => {
	const value = config(); const notes: string[] = []; const result = await runKitUpdateJob(value, { plan: async () => ({ status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never), apply: async () => ({ status: "PARTIAL", exitCode: 1, receiptId: "r2", activeVersion: "1.2.3", postcheck: { status: "FAIL", matcher: "PASS", live: "FAIL" }, provenance: "INTEGRITY_ONLY" }), notify: message => { notes.push(message); } });
	expect(result).toMatchObject({ status: "UNDONE", receiptId: "r2", notification: true }); expect(notes[0]).toContain("automatic undo"); expect(existsSync(join(value.stateRoot, readdirSync(value.stateRoot)[0]!))).toBe(true);
});
