import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { incarnationSync, normalizeStart, PID_MAX, probeIncarnationSync, type Incarnation, type Probe, type ProbeSeamSync } from "./proc.ts";

/** Process start identifies an incarnation for liveness only; it never grants release or reap authority. */
export interface OwnerIdentity {
	pid: number;
	process_start: string;
}

/** The release secret is returned once; persistent owner records store only sha256. */
export interface OwnerCapability {
	token: string;
	sha256: string;
}

/** Normalize an already-observed owner process start; a missing start is never an identity. */
export function ownerIdentityFromStart(pid: number, processStart: string | null): OwnerIdentity | null {
	if (!Number.isSafeInteger(pid) || pid < 1 || pid > PID_MAX || typeof processStart !== "string" || normalizeStart(processStart) === "") return null;
	return { pid, process_start: normalizeStart(processStart) };
}

/** Read the current process incarnation. A missing/unreadable identity refuses creation. */
export function ownerIdentity(pid: number): OwnerIdentity | null {
	try {
		const identity = incarnationSync(pid);
		return identity === null ? null : ownerIdentityFromStart(identity.pid, identity.start);
	} catch {
		return null;
	}
}

export interface OwnerLivenessDeps {
	probe?: (owner: Incarnation) => Probe;
	seam?: ProbeSeamSync;
}

/** Observe the recorded process incarnation. `unknown` is never dead and cannot authorize cleanup. */
export function ownerLiveness(identity: OwnerIdentity, deps: OwnerLivenessDeps = {}): Probe {
	const normalized = ownerIdentityFromStart(identity.pid, identity.process_start);
	if (normalized === null) throw new TypeError("owner liveness requires a valid process identity");
	const incarnation = { pid: normalized.pid, start: normalized.process_start };
	return deps.probe ? deps.probe(incarnation) : probeIncarnationSync(incarnation, deps.seam);
}

/** Mint one 256-bit capability. Callers retain the token; owner files store only the hash. */
export function mintOwnerCapability(): OwnerCapability {
	const token = randomBytes(32).toString("hex");
	return { token, sha256: createHash("sha256").update(token, "utf8").digest("hex") };
}

/** Constant-time comparison of a presented capability with a stored SHA-256 digest. */
export function ownerCapabilityAuthorizes(storedSha256: string | null | undefined, token: string | undefined): boolean {
	if (typeof storedSha256 !== "string" || storedSha256.length !== 64 || token === undefined || token === "") return false;
	for (const char of storedSha256) if (!((char >= "0" && char <= "9") || (char >= "a" && char <= "f"))) return false;
	const presented = createHash("sha256").update(token, "utf8").digest();
	const recorded = Buffer.from(storedSha256, "hex");
	return recorded.length === presented.length && timingSafeEqual(presented, recorded);
}
