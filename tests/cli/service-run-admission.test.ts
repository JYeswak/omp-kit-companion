import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { admitActuator, type AdmissionInput } from "../../src/actuator-admission.ts";
import { acquireRunLock, claimIncarnation, observeServiceLaunchers, readRunClaim } from "../../src/service-run.ts";

// ompkit-bj08.5: lock-claim incarnation binding for the service-run branch.
// The cli run handler double-reads the claim (gate time vs pre-body) and
// refuses when the holder changed hands in between.

const repoRoot = resolve(import.meta.dir, "../..");

function jobsDir(): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "service-run-admission."));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=service-run-admission-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const jobs = join(dir, "jobs");
	mkdirSync(jobs, { recursive: true });
	return jobs;
}

function serviceSnapshot(gateRead: string, bodyRead: string | null): AdmissionInput {
	return {
		launcherBinding: "keeper",
		authority: "ACTIVE",
		authorityConfirmed: true,
		authorityGeneration: bodyRead,
		launchers: [{ pid: 4242, command: "service run load-watch" }],
		keeper: { pid: 4242, command: "service run load-watch" },
		packet: { action: "service-run", ownedAction: "service-run", generation: gateRead },
		governedActions: ["service-run"],
	};
}


test("[a] stable holder across gate and body admits one run", () => {
	const decision = admitActuator(serviceSnapshot("4242:1791276000000", "4242:1791276000000"));
	expect(decision.verdict).toBe("ADMIT");
	expect(decision.admittedAction).toBe("service-run");
});

test("[b] planted: holder changed between gate and body refuses", () => {
	const decision = admitActuator(serviceSnapshot("4242:1791276000000", "9999:1791276999999"));
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
	expect(decision.reason).toContain("generation");
});

test("[b] planted: unreadable claim before body refuses fail-closed", () => {
	const decision = admitActuator(serviceSnapshot("4242:1791276000000", null));
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});

test("a previous claim cannot admit a reacquired keeper in the same clock tick", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_791_276_000_000);
	if (first.status !== "ACQUIRED") throw new Error("expected first claim");
	const gate = readRunClaim(dir, "load-watch");
	first.lock.release();
	const second = acquireRunLock(dir, "load-watch", 1_791_276_000_000);
	if (second.status !== "ACQUIRED") throw new Error("expected next claim");
	try {
		const body = readRunClaim(dir, "load-watch");
		if (gate === null || body === null) throw new Error("missing claim");
		const decision = admitActuator(serviceSnapshot(claimIncarnation(gate), claimIncarnation(body)));
		expect(decision.verdict).toBe("REFUSE");
		expect(decision.admittedAction).toBeNull();
	} finally {
		second.lock.release();
	}
});

// ompkit-bj08.5 [d]: the gate/body launcher set is observed via ps, never
// derived from the keeper claim. A live second launcher outside the claim
// refuses; substrings never match; ps failure is explicit.

function psRun(stdout: string, code = 0): (args: readonly string[]) => { code: number; stdout: string } {
	return (_args) => ({ code, stdout });
}

test("[d] observed launchers match exact argv tokens only", () => {
	const out = [
		"  101 /opt/bin/bun /repo/src/cli.ts service run fleet-watch --json",
		"  202 /opt/bin/bun /repo/src/cli.ts service run fleet-watcher --json",
		"  303 /usr/bin/companion-helper --daemon",
		"  404 sh -c service run fleet-watch",
		"notapid service run fleet-watch",
		"505",
	].join("\n");
	const seen = observeServiceLaunchers(psRun(out), "fleet-watch");
	if (!("launchers" in seen)) throw new Error("expected launchers, got " + JSON.stringify(seen));
	expect(seen.launchers).toEqual([
		{ pid: 101, command: "service run fleet-watch" },
		{ pid: 404, command: "service run fleet-watch" },
	]);
});

test("[d] planted: two live launchers against a one-launcher keeper claim refuse", () => {
	const out = [
		"  101 /opt/bin/bun /repo/src/cli.ts service run fleet-watch --json",
		"  102 /opt/bin/bun /repo/src/cli.ts service run fleet-watch --json",
	].join("\n");
	const seen = observeServiceLaunchers(psRun(out), "fleet-watch");
	if (!("launchers" in seen)) throw new Error("expected launchers, got " + JSON.stringify(seen));
	const decision = admitActuator({
		launcherBinding: "keeper",
		authority: "ACTIVE",
		authorityConfirmed: true,
		authorityGeneration: "gen-1",
		launchers: seen.launchers,
		keeper: { pid: 101, command: "service run fleet-watch" },
		packet: { action: "service-run", ownedAction: "service-run", generation: "gen-1" },
		governedActions: ["service-run"],
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
	expect(decision.reason).toContain("outside the keeper pid-file");
});

test("[d] ps failure is an explicit observation failure, never an empty set", () => {
	expect(observeServiceLaunchers(psRun("", 1), "fleet-watch")).toEqual({
		failure: "ps exited 1: launcher set unobservable",
	});
	expect(observeServiceLaunchers(() => { throw new Error("no ps"); }, "fleet-watch")).toEqual({
		failure: "ps probe threw: no ps",
	});
});
