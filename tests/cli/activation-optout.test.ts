import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run as runCommand } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const entry = realpathSync(resolve(import.meta.dir, "../../src/cli.ts"));
const roots: string[] = [];
afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home(): string {
	const tmp = ownedTmp("activation-optout");
	roots.push(tmp.path);
	return tmp.path;
}

async function run(args: string[], root: string, cliEntry = entry, extraEnv: Record<string, string> = {}) {
	const result = await runCommand([process.execPath, cliEntry, ...args], {
		deadline_s: 60,
		cwd: root,
		env: { ...process.env, HOME: root, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"), ...extraEnv },
	});
	return { code: result.rc, stdout: Buffer.from(result.stdout).toString(), stderr: Buffer.from(result.stderr).toString() };
}

const optOutFile = (root: string) => join(root, ".config", "omp-kit", "activation-optouts.json");
async function doctorFixture(): Promise<{ home: string; entry: string; env: Record<string, string> }> {
	const owned = ownedTmp("activation-doctor-cli");
	roots.push(owned.path);
	const home = realpathSync(owned.path);
	const release = join(home, "release");
	const sourceRoot = realpathSync(resolve(import.meta.dir, "../../"));
	const manifestBuild = await runCommand(["sh", join(sourceRoot, "scripts", "build-manifest.sh")], {
		deadline_s: 120,
		cwd: sourceRoot,
		env: { ...process.env },
	});
	if (manifestBuild.rc !== 0) {
		throw new Error(`failed to build activation manifest fixtures (exit ${manifestBuild.rc}): ${Buffer.from(manifestBuild.stderr).toString()}`);
	}
	const entry = join(release, "src", "cli.ts");
	const bin = join(home, "bin");
	mkdirSync(join(release, "src"), { recursive: true });
	for (const directory of ["rules", "rules-fleet", "retired", "extensions"]) {
		cpSync(join(sourceRoot, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "MANIFEST.fleet.tsv", "package.json"]) {
		cpSync(join(sourceRoot, file), join(release, file));
	}
	const installedFleet = join(home, ".agents", "rules");
	cpSync(join(release, "rules-fleet"), installedFleet, { recursive: true });
	rmSync(join(installedFleet, "kit-no-live-tracker-sqlite.md"));
	const sourceEntry = realpathSync(resolve(sourceRoot, "src", "cli.ts"));
	writeFileSync(entry, `import { runCli } from ${JSON.stringify(sourceEntry)};\nprocess.exitCode = await runCli();\n`);
	const pluginLink = join(home, ".omp", "plugins", "node_modules", "omp-kit-companion");
	mkdirSync(dirname(pluginLink), { recursive: true });
	symlinkSync(release, pluginLink);
	writeFileSync(join(home, "fleet-watch.json"), JSON.stringify({ repos: [] }));
	mkdirSync(dirname(optOutFile(home)), { recursive: true });
	writeFileSync(optOutFile(home), JSON.stringify({ version: 1, optouts: [] }));
	mkdirSync(bin, { recursive: true });
	const launchctl = join(bin, "launchctl");
	writeFileSync(launchctl, "#!/bin/sh\nif [ \"$1\" = list ]; then printf 'PID Status Label\\n'; exit 0; fi\nexit 113\n");
	chmodSync(launchctl, 0o755);
	return {
		home,
		entry,
		env: { PATH: `${bin}:/usr/bin:/bin`, OMP_KIT_FLEET_WATCH_CONFIG: join(home, "fleet-watch.json") },
	};
}

test("activation opt-out records item, reason, actor and time", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "host has no launchd", "--json"], root);
	expect(out.code).toBe(0);
	const body = JSON.parse(out.stdout);
	expect(body.data.overall).toBe("OK");
	expect(body.data.optout.item).toBe("service:kit-fleet-watch");
	expect(body.data.optout.reason).toBe("host has no launchd");
	expect(typeof body.data.optout.by).toBe("string");
	expect(typeof body.data.optout.at).toBe("string");
	const stored = JSON.parse(readFileSync(optOutFile(root), "utf8"));
	expect(stored.version).toBe(1);
	expect(stored.optouts).toHaveLength(1);
	expect(stored.optouts[0].item).toBe("service:kit-fleet-watch");
});

test("planted: an opt-out with an empty reason is refused and nothing is written", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "   ", "--json"], root);
	expect(out.code).toBe(2);
	expect(out.stdout + out.stderr).toContain("OPT_OUT_REASON_REQUIRED");
	expect(existsSync(optOutFile(root))).toBe(false);
});

test("planted: a missing item is refused and nothing is written", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--reason", "no launchd", "--json"], root);
	expect(out.code).toBe(2);
	expect(out.stdout + out.stderr).toContain("OPT_OUT_ITEM_REQUIRED");
	expect(existsSync(optOutFile(root))).toBe(false);
});

test("planted: a corrupt opt-out record fails closed and is never appended to", async () => {
	const root = home();
	mkdirSync(dirname(optOutFile(root)), { recursive: true });
	writeFileSync(optOutFile(root), "{nope");
	const before = readFileSync(optOutFile(root), "utf8");
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "no launchd", "--json"], root);
	expect(out.code).toBe(2);
	expect(readFileSync(optOutFile(root), "utf8")).toBe(before);
});

test("doctor --scope activation reports each manifest item: a removed fleet rule stays unreasoned until that same item has an opt-out", async () => {
	const fixture = await doctorFixture();
	const targetId = "rule:rules-fleet/kit-no-live-tracker-sqlite";
	const first = await run(["doctor", "--scope", "activation", "--json"], fixture.home, fixture.entry, fixture.env);
	expect(first.code).toBe(1);
	if (!first.stdout) throw new Error(`doctor CLI emitted no JSON (exit ${first.code}): ${first.stderr}`);
	const initial = JSON.parse(first.stdout);
	expect(initial.data.overall).toBe("FAIL");
	expect(initial.data.findings[0].component).toBe("activation");
	const initialEvidence = initial.data.findings[0].evidence;
	expect(initialEvidence.manifest_issue).toBeNull();
	const items = initialEvidence.items as { item: string; status: string; detail: string; apply: string; readback: string }[];
	for (const item of items) {
		expect(item.apply.length).toBeGreaterThan(0);
		expect(item.readback.length).toBeGreaterThan(0);
		expect(["ON", "OFF_WITH_REASON", "OFF_NO_REASON"]).toContain(item.status);
	}
	const target = items.find((item) => item.item === targetId);
	expect(target?.status).toBe("OFF_NO_REASON");
	expect(target?.detail).toContain("installed is absent");

	writeFileSync(optOutFile(fixture.home), JSON.stringify({
		version: 1,
		optouts: items.filter((item) => item.item !== targetId && item.status === "OFF_NO_REASON").map((item, index) => ({
			item: item.item,
			reason: "fixture isolates the removed fleet rule",
			by: "test",
			at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
		})),
	}));
	const isolated = await run(["doctor", "--scope", "activation", "--json"], fixture.home, fixture.entry, fixture.env);
	expect(isolated.code).toBe(1);
	const isolatedEvidence = JSON.parse(isolated.stdout).data.findings[0].evidence;
	expect(isolatedEvidence.items.filter((item: { status: string }) => item.status === "OFF_NO_REASON").map((item: { item: string }) => item.item)).toEqual([targetId]);

	const recorded = await run(["activation", "opt-out", "--item", targetId, "--reason", "fixture fleet is intentionally absent", "--json"],
		fixture.home, fixture.entry, fixture.env);
	expect(recorded.code).toBe(0);
	const second = await run(["doctor", "--scope", "activation", "--json"], fixture.home, fixture.entry, fixture.env);
	expect(second.code).toBe(0);
	const result = JSON.parse(second.stdout);
	expect(result.data.overall).toBe("PASS");
	expect(result.data.findings[0].evidence.items.find((item: { item: string }) => item.item === targetId).status).toBe("OFF_WITH_REASON");
}, 120_000);
