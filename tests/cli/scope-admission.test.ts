import { expect, test } from "bun:test";
import { inspectOmpSessions } from "../../src/session-doctor.ts";
import { inventoryServices, type InventoryDeps } from "../../src/services.ts";

// ompkit-bj08.5: the native scopes emit the launcher members and the
// authority/generation refs the admission branches bind.

test("[a] sessions scope names launcher members with an explicit authority gap", () => {
	const report = inspectOmpSessions({
		processes: [{
			pid: 42,
			ppid: 7,
			command: "bun /fixture/.bun/bin/omp --profile claude",
			start_epoch_ms: 3000,
			start_text: "Sat Oct 3 10:00:00 2026",
		}],
		panes: [{ pane: "omp-test 0.1", pid: 7, start_command: "omp --profile claude" }],
		components: [],
		now_epoch_ms: 4000,
	});
	expect(report.admission.launchers).toEqual([{ pid: 42, command: "bun /fixture/.bun/bin/omp --profile claude", pane: "omp-test 0.1" }]);
	expect(report.admission.authority).toMatchObject({ state: "UNKNOWN", confirmed: false, generation: null });
	expect(typeof report.admission.authority.reason).toBe("string");
});

const stubDeps: InventoryDeps = {
	listAll: () => ({ code: 1, stdout: "" }),
	printDomain: () => 1,
	printPath: () => null,
	plistDirs: () => [],
	pathEnv: "/usr/bin:/bin",
};

test("[a] services scope names the authority gap even when launchd is unavailable", () => {
	const report = inventoryServices({ home: "/fixture/home" }, stubDeps);
	expect(report.status).toBe("UNVERIFIED");
	expect(report.admission.launchers).toEqual([]);
	expect(report.admission.authority).toMatchObject({ state: "UNKNOWN", confirmed: false, generation: null });
	expect(typeof report.admission.authority.reason).toBe("string");
});

test("an unavailable launchctl is not a verified empty inventory", () => {
	const input = { home: "/fixture/home" };
	const missing = inventoryServices(input, { ...stubDeps, listAll: () => ({ code: 127, stdout: "" }) });
	expect(missing.status).toBe("UNVERIFIED");
	expect(missing.reason).toContain("LAUNCHCTL_NOT_FOUND");
	const empty = inventoryServices(input, { ...stubDeps, listAll: () => ({ code: 0, stdout: "" }) });
	expect(empty.status).toBe("OK");
	expect(empty.rows).toEqual([]);
});
