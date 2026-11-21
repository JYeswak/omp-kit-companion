import { join } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { parseProbeMounts, selfOpenProbe, type ScratchRunner } from "./scratch.ts";

/**
 * TCCPROMPT1 (ompkit-7pfj1): `omp-kit doctor --scope access`.
 *
 * On 2026-11-21 a macOS consent prompt ("omp-kit would like to access files on a network volume") sat unanswered on the Studio screen.
 * While it was pending, open() on ~/Desktop, ~/Documents and the ovnfs NFS mount blocked (stat, `ls -d` and realpath(1) still answered), every
 * new omp start hung at `Still starting - phase: preloadPluginRoots`, and the scheduled scratch reaper hung on its first checkout root. No tool
 * named the cause for about an hour. This scope opens each protected folder and each network or removable mount with the kit's own binary
 * under a deadline, so a blocked open is named as TCC_CONSENT_PENDING instead of being read as a slow disk.
 */
export const ACCESS_PROBE_TIMEOUT_MS = 5000;

export type AccessState = "OK" | "TCC_CONSENT_PENDING" | "DENIED" | "ABSENT" | "ERROR";
export interface AccessRow { target: string; kind: "folder" | "mount"; state: AccessState; ms: number; detail?: string }

export interface AccessDeps {
	home: string;
	run: ScratchRunner;
	timeoutMs?: number;
	/** The command that opens one path and exits; defaults to the kit's own binary (selfOpenProbe). */
	probe?: (path: string) => { args: readonly string[]; env?: Record<string, string> };
}

function firstLine(text: string): string {
	return text.split("\n").map(line => line.trim()).find(line => line.length > 0)?.slice(0, 200) ?? "";
}

function classify(result: { code: number | null; stdout: string; stderr: string }): { state: AccessState; detail?: string } {
	if (result.code === null) return { state: "TCC_CONSENT_PENDING" };
	if (result.code === 0) return { state: "OK" };
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
	const detail = firstLine(result.stderr) || firstLine(result.stdout);
	if (["eperm", "eacces", "operation not permitted", "permission denied"].some(word => text.includes(word))) return { state: "DENIED", detail };
	if (["enoent", "no such file"].some(word => text.includes(word))) return { state: "ABSENT", detail };
	return { state: "ERROR", detail };
}

export function probeAccess(deps: AccessDeps): { rows: AccessRow[]; mountsListed: boolean } {
	const timeoutMs = deps.timeoutMs ?? ACCESS_PROBE_TIMEOUT_MS;
	const probe = deps.probe ?? selfOpenProbe;
	const targets: { target: string; kind: "folder" | "mount" }[] = [
		{ target: join(deps.home, "Desktop"), kind: "folder" },
		{ target: join(deps.home, "Documents"), kind: "folder" },
	];
	let mountsListed = false;
	try {
		const listed = deps.run(["mount"], { timeoutMs: 10_000 });
		if (listed.code === 0) {
			mountsListed = true;
			for (const mount of [...new Set(parseProbeMounts(listed.stdout))]) targets.push({ target: mount, kind: "mount" });
		}
	} catch { /* an unreadable mount table leaves the folders probed and the mounts unverified */ }
	const rows: AccessRow[] = [];
	for (const { target, kind } of targets) {
		const command = probe(target);
		const started = Date.now();
		let verdict: { state: AccessState; detail?: string };
		try {
			verdict = classify(deps.run(command.args, { timeoutMs, ...(command.env === undefined ? {} : { env: command.env }) }));
		} catch (error) {
			verdict = { state: "ERROR", detail: error instanceof Error ? error.message : String(error) };
		}
		rows.push({ target, kind, state: verdict.state, ms: Date.now() - started, ...(verdict.detail === undefined ? {} : { detail: verdict.detail }) });
	}
	return { rows, mountsListed };
}

export function inspectAccess(deps: AccessDeps): Finding {
	const timeoutMs = deps.timeoutMs ?? ACCESS_PROBE_TIMEOUT_MS;
	const { rows, mountsListed } = probeAccess(deps);
	const pending = rows.filter(row => row.state === "TCC_CONSENT_PENDING");
	const denied = rows.filter(row => row.state === "DENIED");
	const failed = rows.filter(row => row.state === "ERROR");
	const evidence = { timeout_ms: timeoutMs, rows, mounts_listed: mountsListed };
	if (pending.length > 0) {
		return { component: "access", status: "FAIL", reason: `TCC_CONSENT_PENDING: an open of ${pending.map(row => row.target).join(", ")} returned nothing within ${timeoutMs} ms; a macOS consent prompt is probably waiting for a person, and every new omp start hangs at "Still starting - phase: preloadPluginRoots" until it is answered`, recommended_action: "A person answers the macOS permission dialog on the Studio screen (Allow for omp-kit: network volume, Desktop, Documents). Until then do not restart, respawn or upgrade seats, and hold the kit-update job. No tool clicks the dialog.", evidence };
	}
	if (denied.length > 0) {
		return { component: "access", status: "DEGRADED", reason: `DENIED: ${denied.map(row => row.target).join(", ")} refused an open with a permission error (the answer was No, or the grant was reset); tools that need it fail fast`, recommended_action: "Grant omp-kit access in System Settings > Privacy & Security (Files and Folders, Network Volumes, Removable Volumes) if the fleet needs this path.", evidence };
	}
	if (failed.length > 0) {
		return { component: "access", status: "UNVERIFIED", reason: `${failed.length} probe(s) ended in an error that is neither a block nor a permission refusal: ${failed.map(row => `${row.target}: ${row.detail ?? "unknown"}`).join("; ")}`, recommended_action: "Rerun omp-kit doctor --scope access --json and read evidence.rows.", evidence };
	}
	if (!mountsListed) {
		return { component: "access", status: "UNVERIFIED", reason: "the mount table could not be read, so network and removable volumes were not probed; the Desktop and Documents folders opened", recommended_action: "Rerun omp-kit doctor --scope access --json.", evidence };
	}
	return { component: "access", status: "OK", reason: `Opened ${rows.filter(row => row.state === "OK").length} protected folder(s) and mount(s) within ${timeoutMs} ms`, recommended_action: "No action required.", evidence };
}
