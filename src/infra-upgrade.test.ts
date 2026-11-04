import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "./kitlib/tmp.ts";
import {
	defaultUpgradeRunner, dependentBinaries, findRepoPins, installedDependents, planUpgrade, verifyDependents,
	type FileReader, type UpgradeRunner,
} from "./infra-upgrade.ts";

const parent = join(resolve(import.meta.dir, ".."), "var", "agent-tmp");
mkdirSync(parent, { recursive: true });
const scratch = ownedTmp("infra-upgrade-test", { root: parent, bead: "ompkit-fp72.120.16.148" });
afterAll(() => scratch.cleanup());

function files(map: Record<string, string>): FileReader {
	return (path) => map[path] ?? null;
}

test("planted pinned tool: plan refuses naming every pin", () => {
	const read = files({
		"/r/a/.bun-version": "1.4.3\n",
		"/r/a/package.json": JSON.stringify({ engines: { bun: ">=1.4.3" }, packageManager: "bun@1.4.3" }),
		"/r/b/.rch/config.toml": `run = "rch exec --require-tool bun@1.4.3 -- bun test"`,
	});
	const pins = ["/r/a", "/r/b"].flatMap((repo) => findRepoPins(repo, "bun", read));
	expect(pins.map((pin) => `${pin.repo}/${pin.file}:${pin.kind}:${pin.version}`)).toEqual([
		"/r/a/.bun-version:version-file:1.4.3",
		"/r/a/package.json:engines:>=1.4.3",
		"/r/a/package.json:packageManager:1.4.3",
		"/r/b/.rch/config.toml:require-tool:1.4.3",
	]);
	const refused = planUpgrade(pins, [], undefined);
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.uncovered.map((pin) => pin.file)).toContain(".bun-version");
	// A plan naming only one pin file still refuses the rest.
	const partial = planUpgrade(pins, [], "bump /r/a/.bun-version to 1.4.4");
	expect(partial.ok).toBe(false);
	if (!partial.ok) expect(partial.uncovered.map((pin) => `${pin.repo}/${pin.file}`)).toEqual(["/r/a/package.json", "/r/a/package.json", "/r/b/.rch/config.toml"]);
	expect(planUpgrade(pins, [], "bump /r/a/.bun-version /r/a/package.json /r/b/.rch/config.toml").ok).toBe(true);
});

test("control: unpinned tool passes the plan", () => {
	const read = files({ "/r/a/.bun-version": "1.4.3", "/r/a/package.json": JSON.stringify({ packageManager: "bunx@1" }) });
	const pins = findRepoPins("/r/a", "jq", read);
	expect(pins).toEqual([]);
	expect(planUpgrade(pins, [], undefined).ok).toBe(true);
	// bunx@ is not bun@: no prefix false pin.
	expect(findRepoPins("/r/a", "bun", read).map((pin) => pin.kind)).toEqual(["version-file"]);
});

test("require-tool pattern rejects a near miss and stays linear on long input", () => {
	const near = `--require-tool bunx@1 ${"--require-tool bun".repeat(20_000)}`;
	const started = performance.now();
	expect(findRepoPins("/r", "bun", files({ "/r/rch.toml": near }))).toEqual([]);
	expect(performance.now() - started).toBeLessThan(500);
});

test("dependents come from brew uses --installed and their bin files", () => {
	const calls: string[] = [];
	const run: UpgradeRunner = (args) => {
		calls.push(args.join(" "));
		if (args[1] === "uses") return { code: 0, stdout: "node\n", stderr: "" };
		return { code: 0, stdout: "/opt/homebrew/Cellar/node/25/bin/node\n/opt/homebrew/Cellar/node/25/share/doc/x\n/opt/homebrew/Cellar/node/25/libexec/lib/node_modules/npm/bin/npm.cmd\n", stderr: "" };
	};
	const dependents = installedDependents("simdjson", run);
	expect(dependents).toEqual(["node"]);
	expect(dependentBinaries(dependents!, run)).toEqual([{ formula: "node", binary: "/opt/homebrew/Cellar/node/25/bin/node" }]);
	expect(calls[0]).toBe("brew uses --installed --recursive simdjson");
	expect(installedDependents("x", () => ({ code: 1, stdout: "", stderr: "no brew" }))).toBeNull();
});

test("planted library with a broken dependent binary: post-check names the dependent", () => {
	const broken = join(scratch.path, "node");
	writeFileSync(broken, "#!/bin/sh\necho 'dyld[1]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.26.dylib' >&2\nkill -ABRT $$\n");
	chmodSync(broken, 0o755);
	const healthy = join(scratch.path, "rejects-version");
	writeFileSync(healthy, "#!/bin/sh\necho 'unknown flag' >&2\nexit 2\n");
	chmodSync(healthy, 0o755);
	const failures = verifyDependents([
		{ formula: "node", binary: broken },
		{ formula: "fine", binary: healthy },
	], defaultUpgradeRunner);
	expect(failures.map((entry) => entry.formula)).toEqual(["node"]);
	expect(failures[0]!.reason).toContain("Library not loaded");
});
