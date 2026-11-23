import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runKitUpdateJob, type KitUpdateJobConfig, type KitUpdateJobDependencies } from "../../src/kit-update-job.ts";
import { ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS } from "./fixture-process.ts";

const roots: string[] = [];
let savedPath: string | undefined;
let savedDeadline: string | undefined;

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedPath !== undefined) process.env.PATH = savedPath;
	if (savedDeadline === undefined) delete process.env.OMP_KIT_START_PROBE_DEADLINE_S;
	else process.env.OMP_KIT_START_PROBE_DEADLINE_S = savedDeadline;
});

function setupGateFixture(ompBody?: string): {
	value: KitUpdateJobConfig; dependencies: KitUpdateJobDependencies; notes: string[];
	link: string; oldStore: string; applied: { count: number }; relinked: { count: number };
} {
	savedPath = process.env.PATH;
	savedDeadline = process.env.OMP_KIT_START_PROBE_DEADLINE_S;
	const root = ownedTmp("start-probe-gate", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(root);
	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	if (ompBody !== undefined) {
		writeFileSync(join(binDir, "omp"), ompBody, { mode: 0o755 });
		chmodSync(join(binDir, "omp"), 0o755);
		process.env.PATH = `${binDir}:${savedPath ?? "/usr/bin:/bin"}`;
	} else {
		// No omp anywhere on the probe's PATH: hermetic updater journeys run without one.
		process.env.PATH = `${binDir}:/usr/bin:/bin`;
	}
	// Product deadline: the gate reads its short test deadline from
	// OMP_KIT_START_PROBE_DEADLINE_S so the hung-probe fixture resolves in about
	// two seconds; the bun timeout below stays load-scaled through fixtureDeadlineS.
	process.env.OMP_KIT_START_PROBE_DEADLINE_S = "2";
	const oldStore = join(root, "old-store");
	const newStore = join(root, "new-store");
	mkdirSync(oldStore, { recursive: true });
	mkdirSync(newStore, { recursive: true });
	const link = join(root, "plugin-link");
	symlinkSync(oldStore, link);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const freshOmp = { launcher: "/seat/omp", version: "18.18.1", resolvedFrom: "tern-bundle" as const };
	const value: KitUpdateJobConfig = { enabled: true, prefix: root, stateRoot: join(root, "state"), home,
		platform: { os: "darwin", arch: "arm64", libc: "none" },
		pollRelease: async () => ({ indexPath: join(root, "index.json"), archivePath: join(root, "kit.tar"), version: "9.9.9", sourceTag: "v9.9.9" }) };
	const notes: string[] = [];
	const applied = { count: 0 };
	const relinked = { count: 0 };
	const dependencies: KitUpdateJobDependencies = {
		plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => {
			applied.count++;
			return { status: "UPDATED", exitCode: 0, receiptId: "r-gate", activeVersion: "9.9.9",
				postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: freshOmp };
		},
		relink: async () => {
			relinked.count++;
			rmSync(link, { force: true });
			symlinkSync(newStore, link);
			return { ok: true, detail: "gate fixture relink", receiptId: "plugin-gate", undoCommand: "omp-kit undo plugin-gate --yes" };
		},
		reconcile: async () => ({ ok: true, detail: "" }),
		omp: () => freshOmp,
		notify: message => { notes.push(String(message)); },
	};
	return { value, dependencies, notes, link, oldStore, applied, relinked };
}

test("TCCPROMPT1: a hung omp start holds the update (UPGRADE_HELD): the plugin link is not moved and no update notice is emitted", async () => {
	const gate = setupGateFixture("#!/bin/sh\nsleep 30\nexit 0\n");
	const result = await runKitUpdateJob(gate.value, gate.dependencies);
	expect(result).toMatchObject({ status: "SKIPPED", reason: "UPGRADE_HELD", notification: true, relink: "NOT_RUN", service: "NOT_RUN" });
	expect(gate.applied.count).toBe(0);
	expect(gate.relinked.count).toBe(0);
	expect(readlinkSync(gate.link)).toBe(gate.oldStore);
	expect(gate.notes.some(note => note.includes("updated to"))).toBe(false);
	expect(gate.notes.some(note => note.includes("UPGRADE_HELD"))).toBe(true);
	expect(gate.notes.some(note => note.includes("inside the deadline"))).toBe(true);
}, fixtureDeadlineS(30) * 1000);

test("TCCPROMPT1: a start that exits non-zero inside the deadline is healthy and does not hold", async () => {
	const gate = setupGateFixture("#!/bin/sh\nexit 1\n");
	const result = await runKitUpdateJob(gate.value, gate.dependencies);
	expect(result).toMatchObject({ status: "UPDATED", relink: "APPLIED" });
	expect(gate.applied.count).toBe(1);
	expect(gate.relinked.count).toBe(1);
	expect(readlinkSync(gate.link)).toBe(join(roots[0]!, "new-store"));
	expect(gate.notes.some(note => note.includes("updated to"))).toBe(true);
	expect(gate.notes.some(note => note.includes("UPGRADE_HELD"))).toBe(false);
}, fixtureDeadlineS(30) * 1000);

test("TCCPROMPT1: no omp on PATH is unprobeable and does not hold", async () => {
	const gate = setupGateFixture();
	const result = await runKitUpdateJob(gate.value, gate.dependencies);
	expect(result).toMatchObject({ status: "UPDATED", relink: "APPLIED" });
	expect(gate.applied.count).toBe(1);
	expect(gate.relinked.count).toBe(1);
	expect(readlinkSync(gate.link)).toBe(join(roots[0]!, "new-store"));
	expect(gate.notes.some(note => note.includes("updated to"))).toBe(true);
	expect(gate.notes.some(note => note.includes("UPGRADE_HELD"))).toBe(false);
}, fixtureDeadlineS(30) * 1000);

test("TCCPROMPT1 control: a healthy omp start moves the plugin link and emits the update notice", async () => {
	const gate = setupGateFixture("#!/bin/sh\nexit 0\n");
	const result = await runKitUpdateJob(gate.value, gate.dependencies);
	expect(result).toMatchObject({ status: "UPDATED", relink: "APPLIED" });
	expect(gate.applied.count).toBe(1);
	expect(gate.relinked.count).toBe(1);
	expect(readlinkSync(gate.link)).toBe(join(roots[0]!, "new-store"));
	expect(gate.notes.some(note => note.includes("updated to"))).toBe(true);
}, fixtureDeadlineS(30) * 1000);

test("TCCPROMPT1 mutant: the same hung fixture with the gate bypassed moves the link, so deleting the gate flips the hung test", async () => {
	const gate = setupGateFixture("#!/bin/sh\nsleep 30\nexit 0\n");
	const result = await runKitUpdateJob(gate.value, {
		...gate.dependencies,
		startProbe: async () => ({ started: true, timedOut: false, exit: 0, tail: "mutant: gate bypassed" }),
	});
	expect(result).toMatchObject({ status: "UPDATED", relink: "APPLIED" });
	expect(gate.relinked.count).toBe(1);
	expect(readlinkSync(gate.link)).toBe(join(roots[0]!, "new-store"));
	expect(gate.notes.some(note => note.includes("updated to"))).toBe(true);
}, fixtureDeadlineS(30) * 1000);
