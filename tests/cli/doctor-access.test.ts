import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inspectAccess, probeAccess } from "../../src/access-doctor.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { defaultRunner, type ScratchRunResult, type ScratchRunner } from "../../src/scratch.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// TCCPROMPT1 (ompkit-7pfj1): a blocked open is named TCC_CONSENT_PENDING, never read as a slow disk.
// The fake runners answer at once, so no test here waits on a deadline.

const HOME = "/Users/test";
const MOUNT_TABLE = [
	"/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
	"/dev/disk8s2 on /Volumes/ZestData (apfs, local, nodev, nosuid, journaled)",
	"<nfs.sock>:/ on /Users/test/checkouts (nfs, nodev, nosuid, noatime, nobrowse, mounted by test)",
].join("\n");

const ok: ScratchRunResult = { code: 0, stdout: "{}", stderr: "" };
const blocked: ScratchRunResult = { code: null, stdout: "", stderr: "" };
const unreadableMountTable: ScratchRunResult = { code: 1, stdout: "", stderr: "boom" };

/** A runner whose answer for each probed path comes from `answers` (default ok); the probe env carries the path. */
function runnerFor(answers: Record<string, ScratchRunResult>, mountTable: ScratchRunResult = { code: 0, stdout: MOUNT_TABLE, stderr: "" }): ScratchRunner {
	return (args, opts) => {
		if (args[0] === "mount") return mountTable;
		return answers[opts?.env?.OMP_KIT_SCRATCH_PROBE ?? ""] ?? ok;
	};
}

test("a blocked open of Desktop is TCC_CONSENT_PENDING and fails the scope, with the readable targets still OK", () => {
	const run = runnerFor({ [`${HOME}/Desktop`]: blocked });
	const finding = inspectAccess({ home: HOME, run });
	expect(finding.status).toBe("FAIL");
	expect(finding.reason).toContain("TCC_CONSENT_PENDING");
	expect(finding.reason).toContain(`${HOME}/Desktop`);
	expect(finding.reason).not.toContain(`${HOME}/Documents`);
	expect(finding.recommended_action).toContain("A person answers");
	const states = Object.fromEntries(probeAccess({ home: HOME, run }).rows.map(row => [row.target, row.state]));
	expect(states).toEqual({ [`${HOME}/Desktop`]: "TCC_CONSENT_PENDING", [`${HOME}/Documents`]: "OK", "/Volumes/ZestData": "OK", [`${HOME}/checkouts`]: "OK" });
});

test("a blocked network mount is named even when both folders open", () => {
	const finding = inspectAccess({ home: HOME, run: runnerFor({ [`${HOME}/checkouts`]: blocked }) });
	expect(finding.status).toBe("FAIL");
	expect(finding.reason).toContain(`${HOME}/checkouts`);
});

test("every target opening is OK, and the mounts are probed after the folders", () => {
	const run = runnerFor({});
	expect(inspectAccess({ home: HOME, run }).status).toBe("OK");
	expect(probeAccess({ home: HOME, run }).rows.map(row => `${row.kind}:${row.target}`)).toEqual([
		`folder:${HOME}/Desktop`, `folder:${HOME}/Documents`, "mount:/Volumes/ZestData", `mount:${HOME}/checkouts`,
	]);
});

test("a permission refusal is DENIED (degraded, fails fast), not pending", () => {
	const refused: ScratchRunResult = { code: 2, stdout: '{"error":"EPERM: operation not permitted, realpath"}', stderr: "" };
	const finding = inspectAccess({ home: HOME, run: runnerFor({ [`${HOME}/Documents`]: refused }) });
	expect(finding.status).toBe("DEGRADED");
	expect(finding.reason).toContain("DENIED");
	expect(finding.reason).not.toContain("TCC_CONSENT_PENDING");
});

test("an absent folder is not a finding, and a pending open outranks a refusal", () => {
	const absent: ScratchRunResult = { code: 2, stdout: '{"error":"ENOENT: no such file or directory"}', stderr: "" };
	expect(inspectAccess({ home: HOME, run: runnerFor({ [`${HOME}/Documents`]: absent }) }).status).toBe("OK");
	const refused: ScratchRunResult = { code: 2, stdout: "EACCES", stderr: "" };
	const both = inspectAccess({ home: HOME, run: runnerFor({ [`${HOME}/Documents`]: refused, [`${HOME}/Desktop`]: blocked }) });
	expect(both.status).toBe("FAIL");
});

test("an unreadable mount table leaves the folders probed and the verdict UNVERIFIED, never OK; a pending folder still fails", () => {
	const finding = inspectAccess({ home: HOME, run: runnerFor({}, unreadableMountTable) });
	expect(finding.status).toBe("UNVERIFIED");
	expect(probeAccess({ home: HOME, run: runnerFor({}, unreadableMountTable) }).rows).toHaveLength(2);
	expect(inspectAccess({ home: HOME, run: runnerFor({ [`${HOME}/Desktop`]: blocked }, unreadableMountTable) }).status).toBe("FAIL");
});

test("the real kit binary opens a readable folder and reports a missing one as absent (end to end through the self-probe)", () => {
	const home = ownedTmp("omp-kit-access").path;
	try {
		mkdirSync(join(home, "Desktop"));
		const noMounts: ScratchRunner = (args, opts) => args[0] === "mount" ? { code: 0, stdout: "", stderr: "" } : defaultRunner(args, opts);
		const { rows } = probeAccess({ home, run: noMounts, timeoutMs: fixtureDeadlineS(30) * 1000 });
		expect(rows.map(row => `${row.target.slice(home.length)}:${row.state}`)).toEqual(["/Desktop:OK", "/Documents:ABSENT"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);
