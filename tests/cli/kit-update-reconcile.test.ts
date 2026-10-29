import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcilePendingUpdate } from "../../src/kit-update.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

// ompkit-3isy.1 UPDREC1: a supported reconcile path for PARTIAL receipts.

const repoRoot = resolve(import.meta.dir, "../..");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ID = "abcdef0123456789abcdef0123456789ab";

function makePrefix(root: string, name: string, version: string, bytes: Buffer): string {
	const prefix = join(root, name);
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "releases", version, "bin"), { recursive: true });
	writeFileSync(join(prefix, "releases", version, "bin", "omp-kit"), bytes, { mode: 0o755 });
	symlinkSync(`../releases/${version}/bin/omp-kit`, join(prefix, "bin", "omp-kit"));
	return prefix;
}

function fixture(options: { liveBytes: Buffer; recordedBytes: Buffer; withActivation?: boolean } = {
	liveBytes: Buffer.from("binary-0.2.17"),
	recordedBytes: Buffer.from("binary-0.2.17"),
}) {
	const root = ownedTmp("kit-update-reconcile", { root: join(repoRoot, "var", "agent-tmp") }).path;
	const prefix = makePrefix(root, "prefix", "0.2.17", options.liveBytes);
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(stateRoot, 0o700);
	const { recordedBytes } = options;
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

test("[1] positive: derived prefix reconciles matching postimages", () => {
	const ctx = fixture();
	try {
		const result = reconcilePendingUpdate({ stateRoot: ctx.stateRoot, id: ID });
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

test("CLI without --prefix reports relink failures and refuses tampered postimages", () => {
	for (const tampered of [false, true]) {
		const ctx = fixture({
			liveBytes: Buffer.from("binary-0.2.17"),
			recordedBytes: Buffer.from(tampered ? "binary-0.2.17-tampered" : "binary-0.2.17"),
		});
		try {
			const stateRoot = join(ctx.root, "omp-kit");
			renameSync(ctx.stateRoot, stateRoot);
			const result = Bun.spawnSync([
				process.execPath, join(repoRoot, "src", "cli.ts"),
				"update", "--reconcile", ID, "--yes", "--json",
			], {
				cwd: repoRoot,
				env: { ...process.env, HOME: ctx.root, XDG_STATE_HOME: ctx.root },
				stdout: "pipe", stderr: "pipe",
			});
			const output = JSON.parse(result.stdout.toString());
			expect(result.exitCode).toBe(1);
			expect(existsSync(join(stateRoot, "kit-update.pending.json"))).toBe(tampered);
			if (tampered) {
				expect(output.errors[0].code).toBe("PENDING_RECOVERY");
			} else {
				expect(output.data.action).toBe("RECONCILED");
				expect(output.data.overall).toBe("FINDINGS");
				expect(output.data.plugin_relink).toBe("NOT_RUN");
				expect(output.errors[0].code).toBe("PLUGIN_RELINK_FAILED");
				expect(output.data.verified.binary).toBe(join(ctx.prefix, "releases", "0.2.17", "bin", "omp-kit"));
			}
		} finally {
			rmSync(ctx.root, { recursive: true, force: true });
		}
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

test("[1b] explicit matching prefix reconciles through the override path", () => {
	const ctx = fixture();
	try {
		const result = reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: ctx.prefix, id: ID });
		expect(result.status).toBe("RECONCILED");
		expect(result.activeVersion).toBe("0.2.17");
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("[2b] planted: wrong explicit prefix refuses and stays pending", () => {
	const ctx = fixture();
	const other = makePrefix(ctx.root, "other", "0.2.16", Buffer.from("binary-0.2.16"));
	try {
		expect(() => reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: other, id: ID })).toThrow("PENDING_RECOVERY");
		expect(existsSync(join(ctx.stateRoot, "kit-update.pending.json"))).toBe(true);
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("malformed postimage binary path refuses without touching state", () => {
	const ctx = fixture();
	writeFileSync(join(ctx.stateRoot, `kit-activation-${ID}.json`), JSON.stringify({
		schema_version: 1, id: ID,
		before: { version: "0.2.16", sha256: sha(Buffer.from("old")), target: "../releases/0.2.16/bin/omp-kit", binary: join(ctx.prefix, "releases", "0.2.16", "bin", "omp-kit") },
		after: { version: "0.2.17", sha256: sha(Buffer.from("binary-0.2.17")), target: "../releases/0.2.17/bin/omp-kit", binary: "/weird/place" },
		state: "READY",
	}), { mode: 0o600 });
	try {
		expect(() => reconcilePendingUpdate({ stateRoot: ctx.stateRoot, id: ID })).toThrow("KIT_RECEIPT_INVALID");
		expect(existsSync(join(ctx.stateRoot, "kit-update.pending.json"))).toBe(true);
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

test("[1c] explicit relocated prefix records the observed binary path", () => {
	const ctx = fixture();
	const movedPrefix = makePrefix(ctx.root, "moved-prefix", "0.2.17", Buffer.from("binary-0.2.17"));
	try {
		const result = reconcilePendingUpdate({ stateRoot: ctx.stateRoot, prefix: movedPrefix, id: ID });
		const movedBinary = join(movedPrefix, "releases", "0.2.17", "bin", "omp-kit");
		expect(result.verified.binary).toBe(movedBinary);
		const recorded = JSON.parse(readFileSync(join(ctx.stateRoot, `kit-reconcile-${ID}.json`), "utf8")) as { verified: { binary: string } };
		expect(recorded.verified.binary).toBe(movedBinary);
	} finally {
		rmSync(ctx.root, { recursive: true, force: true });
	}
});

afterAll(() => cleanupAllOwnedTmp());
