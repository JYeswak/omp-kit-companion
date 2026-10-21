import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PublishedReleaseError, type ReleaseSnapshot, verifyPublishedBytes } from "../../scripts/verify-published.ts";

const bytes = new TextEncoder().encode("published bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const snapshot: ReleaseSnapshot = {
	tag: "v1.0.0",
	tagSha: "a".repeat(40),
	releaseId: 7,
	assets: [{ name: "omp-kit-v1.0.0-linux-x64-gnu.tar", size: bytes.length, sha256: digest }],
};
const run = (candidate: ReleaseSnapshot, data = new Map([[snapshot.assets[0]!.name, bytes]])) => {
	try {
		verifyPublishedBytes(candidate, snapshot, data, true, () => true);
		return null;
	} catch (error) {
		return error as PublishedReleaseError;
	}
};

describe("published release verification", () => {
	test("control accepts exact bytes and unchanged tag/release", () => expect(run(snapshot)).toBeNull());
	test("planted missing asset fails with typed reason", () => expect(run(snapshot, new Map())).toMatchObject({ reason: "ASSET_MISSING" }));
	test("planted digest mismatch fails with typed reason", () => expect(run(snapshot, new Map([[snapshot.assets[0]!.name, new Uint8Array(bytes.length).fill(0)]]))).toMatchObject({ reason: "ASSET_DIGEST_MISMATCH" }));
	test("planted moved tag fails with typed reason", () => expect(run({ ...snapshot, tagSha: "b".repeat(40) })).toMatchObject({ reason: "TAG_MOVED" }));
	test("signature and offline smoke are mandatory", () => {
		expect(() => verifyPublishedBytes(snapshot, snapshot, new Map([[snapshot.assets[0]!.name, bytes]]), false, () => true)).toThrow(/SIGNATURE_INVALID/);
		expect(() => verifyPublishedBytes(snapshot, snapshot, new Map([[snapshot.assets[0]!.name, bytes]]), true, () => false)).toThrow(/OFFLINE_SMOKE_FAILED/);
	});
});
