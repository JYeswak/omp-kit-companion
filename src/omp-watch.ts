import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpIdentity } from "./paths.ts";
import { inspectStateRoot } from "./state-root.ts";

/**
 * OMP moves often (operators run updaters such as UCA every few hours). `test --record` stores which OMP the
 * kit was last tested against, so status/doctor can say "OMP changed since the last test" without a daemon,
 * and `service install omp-watch` owns the launchd/systemd job that re-runs the test when the
 * OMP package changes.
 */
export type OmpFingerprint = { version: string | null; launcher_sha256: string | null };
export type TestReceipt = OmpFingerprint & {
	schema_version: 1; kit_version: string; scope: "fast" | "full"; status: string; recorded_at: string;
};

const RECEIPT_FILE = "last-test.json";

export function ompFingerprint(identity: Pick<OmpIdentity, "launcher" | "packageRoot">): OmpFingerprint {
	let version: string | null = null, launcher: string | null = null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") version = parsed.version;
	} catch { /* unreadable package: version unknown */ }
	try { launcher = createHash("sha256").update(readFileSync(identity.launcher)).digest("hex"); } catch { /* unreadable launcher */ }
	return { version, launcher_sha256: launcher };
}

/** Writes only into a private (0700, owned, real) state root; returns false instead of writing anywhere else. */
export function recordTestReceipt(stateRoot: string, receipt: TestReceipt): boolean {
	try { mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); } catch { return false; }
	if (inspectStateRoot(stateRoot)) return false;
	const path = join(stateRoot, RECEIPT_FILE), temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	return true;
}

export function readTestReceipt(stateRoot: string): TestReceipt | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(stateRoot, RECEIPT_FILE), "utf8"));
		return parsed && typeof parsed === "object" && (parsed as TestReceipt).schema_version === 1 ? parsed as TestReceipt : null;
	} catch { return null; }
}
