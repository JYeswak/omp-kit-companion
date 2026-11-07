import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOL_MANIFEST, verifyTool, verifyToolArtifact } from "../../src/tools-manifest.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const work = ownedTmp("tools-manifest");
const pin = TOOL_MANIFEST.ovnfs.platforms.darwin_arm64;
const artifact = join(work.path, pin.name);
let real: Buffer;
beforeAll(async () => {
	// Original upstream artifact, not a re-packed fixture or regenerated golden.
	const response = await fetch(pin.url, { signal: AbortSignal.timeout(fixtureDeadlineS(60) * 1000) });
	if (!response.ok) throw new Error(`publisher download HTTP ${response.status}`);
	real = Buffer.from(await response.arrayBuffer());
	writeFileSync(artifact, real);
}, fixtureDeadlineS(90) * 1000);
afterAll(() => work.cleanup());

function cli(args: string[]) {
	const home = join(work.path, "home");
	mkdirSync(home, { recursive: true });
	const result = runFixture([process.execPath, "src/cli.ts", "tools", "verify", ...args, "--json"], {
		cwd: root, floor_s: 30,
		env: { ...process.env, HOME: home, TMPDIR: work.path,
			XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
			OMP_KIT_CC_SPOOL: undefined, OMP_KIT_FLEET_WATCH_CONFIG: join(home, "absent.json") },
	});
	const stdout = new TextDecoder().decode(result.stdout);
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	return { rc: result.rc, envelope: JSON.parse(stdout) };
}

test("real upstream ovnfs artifact verifies archive and binary without executing it", async () => {
	expect(await verifyTool("ovnfs", { artifact, platform: "darwin_arm64" })).toEqual({ overall: "VERIFIED", field: null, expected: null, actual: null });
	const result = cli(["ovnfs", "--artifact", artifact, "--platform", "darwin_arm64"]);
	expect(result.rc).toBe(0);
	expect(result.envelope.data.overall).toBe("VERIFIED");
	expect(readFileSync(artifact)).toEqual(real);
});

test("planted changed artifact refuses publisher_sha256 before parsing and leaves inputs intact", () => {
	const bad = join(work.path, "planted.tar.gz");
	const planted = Buffer.from(real);
	planted[planted.length - 1] = planted[planted.length - 1]! ^ 1;
	writeFileSync(bad, planted);
	const before = readdirSync(work.path).sort();
	const result = cli(["ovnfs", "--artifact", bad, "--platform", "darwin_arm64"]);
	expect(result.rc).toBe(2);
	expect(result.envelope.data).toMatchObject({ overall: "REFUSED", field: "publisher_sha256", expected: pin.publisher_sha256,
		actual: createHash("sha256").update(planted).digest("hex") });
	expect(readFileSync(bad)).toEqual(planted);
	expect(readdirSync(work.path).sort()).toEqual(before);
});

test("matching archive hash does not excuse a mismatched binary pin or missing binary", () => {
	expect(verifyToolArtifact(real, { ...pin, binary_sha256: "0".repeat(64) })).toMatchObject({ overall: "REFUSED", field: "binary_sha256", actual: pin.binary_sha256 });
	expect(verifyToolArtifact(real, { ...pin, binary_path: "missing" })).toMatchObject({ overall: "REFUSED", field: "binary_path" });
});

test("invalid archive refuses even when its outer digest matches", () => {
	const bytes = Buffer.from("not a tar archive");
	expect(verifyToolArtifact(bytes, { ...pin, publisher_sha256: createHash("sha256").update(bytes).digest("hex") })).toMatchObject({ overall: "REFUSED", field: "archive" });
});

test("unknown tool, unpinned platform and unreadable artifact never verify", async () => {
	expect(await verifyTool("untrusted", { artifact })).toMatchObject({ overall: "REFUSED", field: "name" });
	expect(await verifyTool("ovnfs", { platform: "linux_arm64", artifact })).toMatchObject({ overall: "REFUSED", field: "platform" });
	expect(await verifyTool("ovnfs", { platform: "darwin_arm64", artifact: join(work.path, "absent") })).toMatchObject({ overall: "REFUSED", field: "artifact" });
});
