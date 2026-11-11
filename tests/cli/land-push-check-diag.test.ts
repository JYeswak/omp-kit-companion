// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { command, expectLandSchema, fixture, landArgs, registerPushCheck, remoteHead, responseCode } from "./private-index-land.helpers.ts";

setDefaultTimeout(Math.round(fixtureDeadlineS(90) * 1000));

const STDOUT_SENTINEL = "LANDDIAG1_STDOUT_SENTINEL_7f3a9c";
const STDERR_SENTINEL = "LANDDIAG1_STDERR_SENTINEL_2b8e41";
const CREDENTIAL = `ghp_${"k".repeat(36)}`;

type DiagCheck = {
	status: string; exit_code: number | null; stdout_tail?: string | null; stderr_tail?: string | null;
	stdout_truncated?: boolean; stderr_truncated?: boolean; diagnostic_path?: string | null;
};

test("LANDDIAG1 a failing push-check refuses with bounded redacted streams and a durable diagnostic", () => {
	const { work, fakeBin } = fixture();
	registerPushCheck(work, [
		"#!/bin/bash",
		"set -eu",
		`printf '%s\\n' '${"x".repeat(6000)}'`,
		`printf '%s\\n' '${STDOUT_SENTINEL} ${CREDENTIAL}'`,
		`printf '%s\\n' '${"y".repeat(6000)}' >&2`,
		`printf '%s\\n' '${STDERR_SENTINEL}' >&2`,
		"exit 1",
	].join("\n") + "\n");
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const base = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CHECK_FAILED");
	const data = run.body.data as { overall: string; candidate_sha: string; check: DiagCheck };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("FAIL");
	expect(data.check.exit_code).toBe(1);
	expect(data.check.stdout_tail).toContain(STDOUT_SENTINEL);
	expect(data.check.stderr_tail).toContain(STDERR_SENTINEL);
	expect(data.check.stdout_tail).not.toContain(CREDENTIAL);
	expect(data.check.stderr_tail).not.toContain(CREDENTIAL);
	expect(data.check.stdout_truncated).toBe(true);
	expect(data.check.stderr_truncated).toBe(true);
	expect(data.check.stdout_tail).toContain("[truncated:");
	expect(data.check.stderr_tail).toContain("[truncated:");
	const diag = data.check.diagnostic_path;
	expect(typeof diag).toBe("string");
	expect(existsSync(diag!)).toBe(true);
	const body = readFileSync(diag!, "utf8");
	expect(body).toContain(STDOUT_SENTINEL);
	expect(body).toContain(STDERR_SENTINEL);
	expect(body).toContain("exit 1");
	expect(body).toContain(data.candidate_sha);
	expect(body).not.toContain(CREDENTIAL);
	const errors = run.body.errors as { message: string; remediation: string }[];
	expect(errors[0]!.message).toContain(diag!);
	expect(errors[0]!.remediation).toContain(diag!);
	expect(remoteHead(work)).toBe(base);
});

test("LANDDIAG1 a passing push-check still publishes with no diagnostic fields", () => {
	const { work, fakeBin } = fixture();
	registerPushCheck(work, "#!/bin/bash\nset -eu\nexit 0\n");
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; check: DiagCheck };
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.exit_code).toBe(0);
	expect(data.check.stdout_tail ?? null).toBeNull();
	expect(data.check.stderr_tail ?? null).toBeNull();
	expect(data.check.diagnostic_path ?? null).toBeNull();
});
