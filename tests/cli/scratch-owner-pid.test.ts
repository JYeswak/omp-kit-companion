import { expect, test } from "bun:test";
import { parseOwnerFileEx } from "../../src/scratch.ts";

/** LINUXPID1 (ompkit-4tn55): Linux pid_max reaches 4194304, so owner records carry 7-digit pids. */
const owner = (pid: string) => JSON.stringify({
	pid, process_start: "Sun Nov 8 12:52:51 2026", label: "x", repo: "/r", created_at: "2026-11-08T19:52:51.833Z", argv0: "omp-kit",
});

test("LINUXPID1: owner records with Linux 7-digit pids parse; macOS 5-digit pids still parse", () => {
	for (const pid of ["62533", "2327366", "4194304", "1"]) {
		const parsed = parseOwnerFileEx(owner(pid));
		expect("owner" in parsed, pid).toBe(true);
	}
});

test("LINUXPID1 planted: 8-digit, leading-zero, zero and non-numeric pids stay refused on the pid field", () => {
	for (const pid of ["12345678", "0123", "0", "12a", ""]) {
		const parsed = parseOwnerFileEx(owner(pid));
		expect("failure" in parsed ? parsed.failure.field : "accepted", pid).toBe("pid");
	}
});
