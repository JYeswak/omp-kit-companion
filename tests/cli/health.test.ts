import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ompFingerprint, recordTestReceipt } from "../../src/omp-watch.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
const entry = resolve(import.meta.dir, "../../src/cli.ts");
const bases: string[] = [];
afterEach(() => { for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true }); });

interface Healthy { home: string; project: string; release: string; ompBin: string; binary: string }

function sculpt(): Healthy {
	const scratch = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratch, { recursive: true });
	const base = mkdtempSync(join(scratch, "health-"));
	bases.push(base);
	const release = join(base, "release");
	const home = join(base, "home");
	const project = join(base, "project");
	const ompPackage = join(base, "omp", "releases", "v1");
	const ompBin = join(base, "omp", "bin");
	const binary = join(release, "bin", "omp-kit");
	for (const dir of [
		join(release, "bin"), join(release, "rules"), join(release, "retired"), home, project, ompBin,
		join(ompPackage, "dist"), join(ompPackage, "src", "export"), join(ompPackage, "src", "capability"),
		join(ompPackage, "src", "discovery"), join(ompPackage, "node_modules", "@oh-my-pi", "pi-natives"),
	]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(ompPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.4.0" }));
	writeFileSync(join(ompPackage, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) writeFileSync(join(ompPackage, "src", file), "export {};\n");
	const launcher = join(ompPackage, "dist", "cli.js");
	writeFileSync(launcher, "#!/bin/sh\nexit 91\n");
	chmodSync(launcher, 0o755);
	symlinkSync(launcher, join(ompBin, "omp"));
	const rule = "# Rule A\n";
	writeFileSync(join(release, "rules", "rule-a.md"), rule);
	writeFileSync(join(release, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nrule-a\t${createHash("sha256").update(rule).digest("hex")}\ttripwire\tabc1234\n`);
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", entry, "--outfile", binary], {
		cwd: base, stdout: "pipe", stderr: "pipe",
	});
	if (build.exitCode !== 0) throw new Error(`health fixture compile failed: ${build.stderr.toString()}`);
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "rule-a.md"), rule);
	const stat = statSync(join(home, ".agents", "rules", "rule-a.md"));
	writeFileSync(join(home, ".agents", "omp-kit-ownership.json"), JSON.stringify({ version: 1,
		rules: { "rule-a": { sha256: createHash("sha256").update(rule).digest("hex"),
			size: stat.size, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid } } }), { mode: 0o600 });
	return { home, project, release, ompBin, binary };
}

function run(f: Healthy, args: string[]) {
	const result = Bun.spawnSync([f.binary, ...args, "--json"], {
		cwd: f.project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.home, "xdg-state"),
			XDG_CONFIG_HOME: join(f.home, "xdg-config"), XDG_DATA_HOME: join(f.home, "xdg-data"),
			XDG_CACHE_HOME: join(f.home, "xdg-cache"), PATH: `${f.ompBin}:/usr/bin:/bin`,
			OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
	});
	const stdout = result.stdout.toString();
	return { code: result.exitCode, data: JSON.parse(stdout), stderr: result.stderr.toString() };
}
function recordPass(f: Healthy) {
	expect(recordTestReceipt(join(f.home, "xdg-state", "omp-kit"), { schema_version: 1, kit_version: "0.0.0-test",
		scope: "fast", status: "PASS", recorded_at: "2026-10-01T00:00:00.000Z",
		...ompFingerprint(resolveOmpIdentity({ PATH: f.ompBin })) })).toBe(true);
}

type Row = { component: string; status: string; reason: string };

test("a healthy fixture install with a recorded passing test gives health exit 0 and lists structurally unprovable components as not judged", () => {
	const f = sculpt();
	recordPass(f);
	const health = run(f, ["health"]);
	expect(health.code, health.stderr).toBe(0);
	expect(health.data.data.overall).toBe("OK");
	expect(health.data.data.findings.find((row: Row) => row.component === "installed_rules").status).toBe("OK");
	expect(health.data.data.findings.find((row: Row) => row.component === "omp_drift").status).toBe("OK");
	const notJudged = health.data.data.not_judged as Row[];
	expect(notJudged.find((row) => row.component === "effective_profile")).toMatchObject({ status: "UNVERIFIED" });
	expect(notJudged.find((row) => row.component === "matcher")).toMatchObject({ status: "NOT_RUN" });
	expect(notJudged.every((row) => typeof row.reason === "string" && row.reason.length > 0)).toBe(true);
	expect(notJudged.some((row) => ["kit", "manifest", "omp", "state_root", "installed_rules", "omp_drift"].includes(row.component))).toBe(false);
	expect(health.data.data.findings.some((row: Row) => row.component === "effective_profile")).toBe(true);
	expect(health.stderr).toBe("");
});

test("no recorded test makes health exit 1 with omp_drift NOT_RUN naming test --record", () => {
	const health = run(sculpt(), ["health"]);
	expect(health.code).toBe(1);
	expect(health.data.data.overall).toBe("UNVERIFIED");
	const drift = health.data.data.findings.find((row: Row) => row.component === "omp_drift") as Row & { recommended_action: string };
	expect(drift.status).toBe("NOT_RUN");
	expect(drift.recommended_action).toContain("omp-kit test --record");
	expect(JSON.stringify(health.data)).toContain('"component":"omp_drift"');
	expect(health.data.data.not_judged.some((row: Row) => row.component === "matcher")).toBe(true);
});
test("planted manifest damage makes health exit 1 naming the manifest", () => {
	const f = sculpt();
	writeFileSync(join(f.release, "rules", "rule-a.md"), "tampered release\n");
	const health = run(f, ["health"]);
	expect(health.code).toBe(1);
	expect(health.data.data.findings.find((row: Row) => row.component === "manifest").status).toBe("FAIL");
	expect(health.data.errors[0].code).toBe("REQUIRED_FINDING_FAILED");
	expect(JSON.stringify(health.data)).toContain('"component":"manifest"');
	expect(health.data.data.not_judged.some((row: Row) => row.component === "effective_profile")).toBe(true);
});

test("a 0755 state root makes health exit 1 naming the state root", () => {
	const f = sculpt();
	recordPass(f);
	mkdirSync(join(f.home, "xdg-state", "omp-kit"), { recursive: true, mode: 0o755 });
	chmodSync(join(f.home, "xdg-state", "omp-kit"), 0o755);
	const health = run(f, ["health"]);
	expect(health.code).toBe(1);
	expect(health.data.data.overall).toBe("DEGRADED");
	expect(health.data.data.findings.find((row: Row) => row.component === "state_root").status).toBe("DEGRADED");
	expect(JSON.stringify(health.data)).toContain("755");
	expect(health.data.data.not_judged.some((row: Row) => row.component === "matcher")).toBe(true);
});
