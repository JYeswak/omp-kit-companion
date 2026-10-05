import { expect, test } from "bun:test";
import { checkInfraCandidate, diffInfraPins, parseInfraPins, promoteInfra, undoPromote, updatePinVersion, type InfraExec } from "../../src/infra.ts";

const GOOD = `[tools.bun]
version = "1.4.0"
receipt = "ladder-2026-10-05-8eebca6f"

[tools.typescript-language-server]
version = "4.3.3"
receipt = "ladder-2026-10-05-8eebca6f"
`;

test("TOOL1: a well-formed pin file parses with versions and receipts", () => {
	const pins = parseInfraPins(GOOD);
	expect(pins?.tools["bun"]).toEqual({ version: "1.4.0", receipt: "ladder-2026-10-05-8eebca6f" });
	expect(pins?.tools["typescript-language-server"]).toEqual({ version: "4.3.3", receipt: "ladder-2026-10-05-8eebca6f" });
});

test("TOOL1: matching installs report no drift", () => {
	const pins = parseInfraPins(GOOD)!;
	expect(diffInfraPins(pins, { bun: "1.4.0", "typescript-language-server": "4.3.3" })).toEqual([]);
});

test("TOOL1 planted: a moved toolchain reports DRIFT naming tool, pin and install", () => {
	const pins = parseInfraPins(GOOD)!;
	const drift = diffInfraPins(pins, { bun: "9.9.9", "typescript-language-server": "4.3.3" });
	expect(drift).toEqual([{ tool: "bun", pinned: "1.4.0", installed: "9.9.9" }]);
});

test("TOOL1: an unreadable install reports drift with null installed", () => {
	const pins = parseInfraPins(GOOD)!;
	const drift = diffInfraPins(pins, { bun: "1.4.0", "typescript-language-server": null });
	expect(drift).toEqual([{ tool: "typescript-language-server", pinned: "4.3.3", installed: null }]);
});

test("TOOL1: malformed pins fail closed", () => {
	expect(parseInfraPins("not toml [[")).toBeNull();
	expect(parseInfraPins("[tools.bun]\nversion = \"1.4.0\"\n")).toBeNull();
	expect(parseInfraPins("[other]\nversion = \"1\"\n")).toBeNull();
	expect(parseInfraPins("")).toBeNull();
});


function fakeExec(out: string, seen: { argv: readonly string[]; env: Record<string, string> }[]): InfraExec {
	return {
		run: (argv, opts) => {
			seen.push({ argv, env: opts.env });
			return Promise.resolve({ code: 0, out });
		},
	};
}

const PASS_LOG = "GREEN manifest producer_rc=0\nGREEN harness-gate producer_rc=0\nLADDER: GREEN\n";

test("TOOL1: a green ladder reports PASS with stages", async () => {
	const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
	const report = await checkInfraCandidate({ tool: "bun", version: "1.5.0", repoRoot: "/repo",
		pathPrefix: "/prefix/candidate", baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/op" },
		exec: fakeExec(PASS_LOG, seen) });
	expect(report.status).toBe("PASS");
	expect(report.failedStage).toBeNull();
	expect(report.stages.map(stage => stage.label)).toEqual(["manifest", "harness-gate"]);
});

test("TOOL1: the candidate prefix leads PATH and the base env is untouched", async () => {
	const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
	const baseEnv = { PATH: "/usr/bin:/bin", HOME: "/home/op" };
	await checkInfraCandidate({ tool: "bun", version: "1.5.0", repoRoot: "/repo",
		pathPrefix: "/prefix/candidate", baseEnv, exec: fakeExec(PASS_LOG, seen) });
	expect(seen).toHaveLength(1);
	expect(seen[0]!.env["PATH"]).toBe("/prefix/candidate/bin:/usr/bin:/bin");
	expect(seen[0]!.env["HOME"]).toBe("/home/op");
	expect(baseEnv["PATH"]).toBe("/usr/bin:/bin");
});

test("TOOL1 planted: a candidate that breaks one stage reports FAIL naming that stage", async () => {
	const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
	const report = await checkInfraCandidate({ tool: "bun", version: "9.9.9", repoRoot: "/repo",
		pathPrefix: "/prefix/candidate", baseEnv: { PATH: "/usr/bin:/bin" },
		exec: fakeExec("GREEN manifest producer_rc=0\nRED   harness-gate producer_rc=1 (private log /w/ladder-harness-gate.txt)\n", seen) });
	expect(report.status).toBe("FAIL");
	expect(report.failedStage).toBe("harness-gate");
});

test("TOOL1: a spawn failure reports FAIL as ladder-spawn", async () => {
	const report = await checkInfraCandidate({ tool: "bun", version: "9.9.9", repoRoot: "/repo",
		pathPrefix: "/prefix/candidate", baseEnv: {},
		exec: { run: () => Promise.reject(new Error("spawn ENOENT")) } });
	expect(report.status).toBe("FAIL");
	expect(report.failedStage).toBe("ladder-spawn");
});


const PINS = { tools: { bun: { version: "1.4.0", receipt: "ladder-A" } } };
const PASS_NEW = { tool: "bun", version: "1.5.0", status: "PASS" as const };
const PASS_OLD = { tool: "bun", version: "1.4.0", status: "PASS" as const };
const okInstall = (seen: string[]) => (_tool: string, version: string) => {
	seen.push(version);
	return Promise.resolve(true);
};

test("TOOL1 planted: promote without human authorization is REFUSED", async () => {
	const seen: string[] = [];
	const result = await promoteInfra({ tool: "bun", version: "1.5.0", pins: PINS,
		check: PASS_NEW, human: false, install: okInstall(seen) });
	expect(result.status).toBe("REFUSED");
	expect(seen).toEqual([]);
});

test("TOOL1 planted: promote without a passing check for the exact candidate is REFUSED", async () => {
	const seen: string[] = [];
	for (const check of [{ ...PASS_NEW, status: "FAIL" as const }, { ...PASS_OLD }]) {
		const result = await promoteInfra({ tool: "bun", version: "1.5.0", pins: PINS,
			check, human: true, install: okInstall(seen) });
		expect(result.status, JSON.stringify(check)).toBe("REFUSED");
	}
	expect(seen).toEqual([]);
});

test("TOOL1: promote installs, updates the pin and writes the receipt", async () => {
	const seen: string[] = [];
	const result = await promoteInfra({ tool: "bun", version: "1.5.0", pins: PINS,
		check: PASS_NEW, human: true, install: okInstall(seen), nowIso: "2026-10-05T21:45:00Z" });
	expect(seen).toEqual(["1.5.0"]);
	if (result.status !== "PROMOTED") throw new Error("expected PROMOTED");
	expect(result.pins.tools["bun"]!.version).toBe("1.5.0");
	expect(result.receipt).toEqual({ tool: "bun", from: "1.4.0", to: "1.5.0", check: "PASS", at: "2026-10-05T21:45:00Z" });
});

test("TOOL1: promote then undo restores the previous version", async () => {
	const seen: string[] = [];
	const promoted = await promoteInfra({ tool: "bun", version: "1.5.0", pins: PINS,
		check: PASS_NEW, human: true, install: okInstall(seen) });
	if (promoted.status !== "PROMOTED") throw new Error("expected PROMOTED");
	const undone = await undoPromote({ receipt: promoted.receipt, pins: promoted.pins,
		check: PASS_OLD, human: true, install: okInstall(seen) });
	if (undone.status !== "PROMOTED") throw new Error("expected PROMOTED undo");
	expect(undone.pins.tools["bun"]!.version).toBe("1.4.0");
	expect(seen).toEqual(["1.5.0", "1.4.0"]);
});

test("TOOL1: installer failure reports FAILED and leaves the pin", async () => {
	const result = await promoteInfra({ tool: "bun", version: "1.5.0", pins: PINS,
		check: PASS_NEW, human: true, install: () => Promise.resolve(false) });
	expect(result.status).toBe("FAILED");
});


const PINNED = `# toolchain pins (certified by ladder runs)
[tools.bun]
version = "1.4.0"
receipt = "ladder-A"

[tools.typescript-language-server]
version = "4.3.3"
receipt = "ladder-B"
`;

test("TOOL1: pin bump keeps receipt, comments and layout", () => {
	const bumped = updatePinVersion(PINNED, "bun", "1.5.0");
	expect(bumped).toContain('version = "1.5.0"');
	expect(bumped).toContain('receipt = "ladder-A"');
	expect(bumped).toContain("# toolchain pins");
	expect(bumped).toContain('version = "4.3.3"');
	expect(parseInfraPins(bumped!)?.tools["bun"]).toEqual({ version: "1.5.0", receipt: "ladder-A" });
});

test("TOOL1: pin bump on unknown tool or key fails closed", () => {
	expect(updatePinVersion(PINNED, "node", "22.0.0")).toBeNull();
	expect(updatePinVersion("[tools.bun]\nreceipt = \"ladder-A\"\n", "bun", "1.5.0")).toBeNull();
});

test("TOOL1: check report carries the log tail", async () => {
	const out = `${"x".repeat(5000)}\nLADDER: GREEN\n`;
	const report = await checkInfraCandidate({ tool: "bun", version: "1.5.0", repoRoot: "/repo",
		pathPrefix: "/prefix", baseEnv: {}, exec: { run: () => Promise.resolve({ code: 0, out }) } });
	expect(report.logTail.length).toBeLessThanOrEqual(2000);
	expect(report.logTail).toContain("LADDER: GREEN");
});


test("TOOL1: pin bump can rotate the certification receipt too", () => {
	const bumped = updatePinVersion(PINNED, "bun", "1.5.0", "ladder-C");
	expect(bumped).toContain('version = "1.5.0"');
	expect(bumped).toContain('receipt = "ladder-C"');
	expect(parseInfraPins(bumped!)?.tools["bun"]).toEqual({ version: "1.5.0", receipt: "ladder-C" });
});