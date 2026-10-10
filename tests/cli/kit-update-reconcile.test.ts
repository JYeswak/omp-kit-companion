import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcilePendingUpdate } from "../../src/kit-update.ts";

// ompkit-3isy.1 UPDREC1: a supported reconcile path for PARTIAL receipts.

const repoRoot = resolve(import.meta.dir, "../..");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ID = "abcdef0123456789abcdef0123456789ab";

function fixture(options: { liveBytes: Buffer; recordedBytes: Buffer; withActivation?: boolean } = {
	liveBytes: Buffer.from("binary-0.2.17"),
	recordedBytes: Buffer.from("binary-0.2.17"),
}) {
	const root = mkdtempSync(join(repoRoot, "var", "agent-tmp", "kit-update-reconcile-"));
	const prefix = join(root, "prefix"), stateRoot = join(root, "state");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "releases", "0.2.17", "bin"), { recursive: true });
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(stateRoot, 0o700);
	const { liveBytes, recordedBytes } = options;
	writeFileSync(join(prefix, "releases", "0.2.17", "bin", "omp-kit"), liveBytes, { mode: 0o755 });
	symlinkSync("../releases/0.2.17/bin/omp-kit", join(prefix, "bin", "omp-kit"));
	writeFileSync(join(stateRoot, "kit-update.pending.json"), JSON.stringify({
		scope: "kit", identitySha256: sha(Buffer.from("old")), kitVersion: "0.2.16",
		ompVersion: null, channel: null, id: ID, state: "PENDING",
	}), { mode: 0o600 });
	chmodSync(join(stateRoot, "kit-update.pending.json"), 0o600);
	if (options.withActivation !== false) {
		writeFileSync(join(stateRoot, `kit-activation-${ID}.json`), JSON.stringify({
			schema_version: 1, id: ID,
			before: { version: "0.2.16", sha256: sha(Buffer.from("old")), target: "../releases/0.2.16/bin/omp-kit", binary: join(prefix, "releases", "0.2.16", "bin", "omp-kit") },
			after: { version: "0.2.17", sha256: sha(recordedBytes), target: "../releases/0.2.17/bin/omp-kit", binary: join(prefix, "releases", "0.2.17", "bin", "omp-kit") },
			state: "READY",
		}), { mode: 0o600 });
		chmodSync(join(stateRoot, `kit-activation-${ID}.json`), 0o600);
	}
	return { root, prefix, stateRoot };
}

test("[1] positive: matching postimages reconcile and record the verification", () => {
	const ctx = fixture();
	try {
		const result = reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: ctx.prefix, id: ID });
		expect(result.status).toBe("RECONCILED");
		expect(result.activeVersion).toBe("0.2.17");
		expect(result.verified.sha256).toBe(sha(Buffer.from("binary-0.2.17")));
		expect(existsSync(join(ctx.stateRoot, "kit-update.pending.json"))).toBe(false);
		expect(existsSync(join(ctx.stateRoot, "receipts", `update-${ID}.json`))).toBe(true);
		expect(existsSync(join(ctx.stateRoot, `kit-reconcile-${ID}.json`))).toBe(true);
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("[2] planted: differing active bytes refuse and stay pending", () => {
	const ctx = fixture({ liveBytes: Buffer.from("binary-0.2.17"), recordedBytes: Buffer.from("binary-0.2.17-tampered") });
	try {
		expect(() => reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: ctx.prefix, id: ID })).toThrow("PENDING_RECOVERY");
		expect(existsSync(join(ctx.stateRoot, "kit-update.pending.json"))).toBe(true);
		expect(existsSync(join(ctx.stateRoot, `kit-reconcile-${ID}.json`))).toBe(false);
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("unknown receipt id and missing activation record refuse", () => {
	const ctx = fixture();
	try {
		expect(() => reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: ctx.prefix, id: "00000000000000000000000000000000" })).toThrow("KIT_RECEIPT_INVALID");
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
	const bare = fixture({ liveBytes: Buffer.from("b"), recordedBytes: Buffer.from("b"), withActivation: false });
	try {
		expect(() => reconcilePendingUpdate({ stateRoot: bare.stateRoot, prefix: bare.prefix, id: ID })).toThrow("KIT_RECEIPT_INVALID");
	} finally {
		rmSync(bare.root, { recursive: true, force: true });
	}
});
