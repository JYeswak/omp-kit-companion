import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sha256, secretShapedName, tmuxSecretNames, digestSetFromFile, addSecretValueToDigestSet, findSecretNames, rcLiteralSecretNames, rcLiteralValue, liveProcessSecretNames, noAmbientSecretName, ompArgvCount } from "../../src/secrets-doctor.ts";

// Synthetic values only, minted per run: never a vault value, never in source text.
const fake = `fk${randomBytes(12).toString("hex")}`;
const root = join(process.cwd(), "var", "agent-tmp", `secrets-doctor.${process.pid}`);
mkdirSync(join(root, "scan"), { recursive: true });
writeFileSync(join(root, ".owner"), `pid=${process.pid} label=secrets-doctor-test repo=${process.cwd()}\n`);
const digests = join(root, "digests.tsv");
writeFileSync(digests, `${sha256(fake)}\tfake/prod:DEMO_API_KEY\t${fake.length}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
// OMP_KIT_SECRET_SCAN_RC_FILES="" and PROCESS_ENV=""/COUNT isolate the pre-existing tests from
// the operator's real rc files and live environment; the no-ambient guard has its own tests below.
function doctor(env: Record<string, string>, args: string[] = [], cwd = process.cwd()) {
	const run = spawnSync(process.execPath, [cli, "doctor", "--scope", "secrets", ...args, "--json"], { cwd, encoding: "utf8", env: { ...process.env, OMP_KIT_SECRET_DIGESTS_FILE: digests, OMP_KIT_SECRET_SCAN_ROOTS: join(root, "scan"), OMP_KIT_SECRET_SCAN_TMUX_ENV: "", OMP_KIT_SECRET_SCAN_RC_FILES: "", OMP_KIT_SECRET_SCAN_PROCESS_ENV: "", OMP_KIT_SECRET_SCAN_PROCESS_COUNT: "", ...env } });
	return { code: run.status, out: run.stdout + run.stderr, data: JSON.parse(run.stdout).data };
}

test("planted value FAILs naming file and vault NAME, never the value; removed -> PASS", () => {
	const planted = join(root, "scan", "demo.env");
	writeFileSync(planted, `export DEMO_API_KEY="${fake}"\n`);
	const red = doctor({});
	expect(red.code).toBe(1);
	expect(red.data.overall).toBe("FAIL");
	expect(red.data.hits).toEqual([{ path: expect.stringContaining("demo.env"), names: ["fake/prod:DEMO_API_KEY"] }]);
	expect(red.out).not.toContain(fake);
	rmSync(planted);
	const green = doctor({});
	expect(green.code).toBe(0);
	expect(green.data.overall).toBe("PASS");
});

test("unreachable Infisical is UNVERIFIED, never PASS", () => {
	const run = doctor({ OMP_KIT_SECRET_SCAN_UNREACHABLE: "1" });
	expect(run.code).toBe(3);
	expect(run.data.overall).toBe("UNVERIFIED");
});

test("tmux global environment: secret-shaped names fail, pointer names stay quiet", () => {
	expect(secretShapedName("OPENAI_API_KEY")).toBe(true);
	expect(secretShapedName("APPLE_ASC_API_KEY_ID_PRIMARY")).toBe(false);
	expect(secretShapedName("ZSCAST_YOUTUBE_OAUTH_CLIENT_ID")).toBe(false);
	expect(secretShapedName("MONKEY_BUSINESS")).toBe(false);
	const set = digestSetFromFile(digests);
	expect(tmuxSecretNames(`PATH=/bin\nGH_TOKEN=abc\n-REMOVED_SECRET\nPLAIN_VAR=${fake}\n`, set)).toEqual(["GH_TOKEN", "PLAIN_VAR"]);
	const run = doctor({ OMP_KIT_SECRET_SCAN_TMUX_ENV: "GH_TOKEN=abc\n" });
	expect(run.data.overall).toBe("FAIL");
	expect(run.data.tmux_secret_names).toEqual(["GH_TOKEN"]);
});

test("--staged scans index blobs only: staged plant blocks, clean staging passes", () => {
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(repo, "ok.txt"), "nothing here\n");
	git("add", "ok.txt");
	expect(doctor({}, ["--staged"], repo).code).toBe(0);
	writeFileSync(join(repo, "mcp.json"), JSON.stringify({ env: { DEMO_API_KEY: fake } }));
	expect(doctor({}, ["--staged"], repo).code).toBe(0); // unstaged: not scanned
	git("add", "mcp.json");
	const red = doctor({}, ["--staged"], repo);
	expect(red.code).toBe(1);
	expect(red.data.hits).toEqual([{ path: "mcp.json", names: ["fake/prod:DEMO_API_KEY"] }]);
});
test("provider slugs are excluded while credential tokens under the same name remain digestible", () => {
	const name = "NANGO_GOOGLE_PROVIDER_CONFIG_KEY";
	const label = `nango/prod:${name}`;
	const slug = "google-calendar-app";
	const mixedToken = `${"Ab3".repeat(10)}X9`;
	const set = { digests: new Map<string, Set<string>>(), lengths: new Set<number>(), source: "test", projects: 0, failed: [] };
	addSecretValueToDigestSet(set, name, slug, label);
	addSecretValueToDigestSet(set, name, mixedToken, label);

	expect(findSecretNames(slug, set)).toEqual([]);
	expect(findSecretNames(mixedToken, set)).toEqual([label]);
});
test("public key names stay out of the digest set while service-role keys remain", () => {
	const value = `${"Ab3".repeat(10)}X9`;
	const names = [
		"ALPS_SUPABASE_STAGING_ANON_KEY",
		"SUPABASE_PUBLISHABLE_KEY",
		"NEXT_PUBLIC_SUPABASE_API_KEY",
		"EXPO_PUBLIC_SUPABASE_API_KEY",
		"ALPS_SUPABASE_STAGING_SERVICE_ROLE_KEY",
	];
	const set = { digests: new Map<string, Set<string>>(), lengths: new Set<number>(), source: "test", projects: 0, failed: [] };
	for (const name of names) addSecretValueToDigestSet(set, name, value, `alps/prod:${name}`);

	expect(findSecretNames(value, set)).toEqual(["alps/prod:ALPS_SUPABASE_STAGING_SERVICE_ROLE_KEY"]);
});

test("rc line parser: literal exports flagged, references and pointers quiet", () => {
	expect(rcLiteralSecretNames(`export DEMO_API_KEY="Ab3Ab3Ab3Ab3X9"\n`)).toEqual(["DEMO_API_KEY"]);
	expect(rcLiteralSecretNames(`DEMO_API_TOKEN=Ab3Ab3Ab3Ab3X9\n`)).toEqual(["DEMO_API_TOKEN"]);
	expect(rcLiteralSecretNames(`export DEMO_API_KEY="$(cf-secret DEMO_API_KEY)"\n`)).toEqual([]);
	expect(rcLiteralSecretNames(`export DEMO_API_KEY="$DEMO_API_KEY"\n`)).toEqual([]);
	expect(rcLiteralSecretNames(`export DEMO_API_KEY=xxx\n`)).toEqual([]);
	expect(rcLiteralSecretNames(`export DEMO_CLIENT_ID="Ab3Ab3Ab3Ab3X9"\n`)).toEqual([]);
	expect(rcLiteralSecretNames(`# export DEMO_API_KEY="Ab3Ab3Ab3Ab3X9"\n`)).toEqual([]);
	expect(rcLiteralValue("$(cf-secret FOO)")).toBe(false);
	expect(rcLiteralValue("short")).toBe(false);
	expect(rcLiteralValue("Ab3Ab3Ab3Ab3X9")).toBe(true);
});

test("live process names: secret-shaped flagged, pointers and allowlist quiet", () => {
	expect(liveProcessSecretNames(["PATH", "DEMO_API_KEY", "DEMO_CLIENT_ID"])).toEqual(["DEMO_API_KEY"]);
	expect(liveProcessSecretNames(["DEMO_API_KEY"], new Set(["DEMO_API_KEY"]))).toEqual([]);
});

test("NOAMBIENT1 acceptance: planted rc export -> FAIL naming it, no value bytes; removal -> PASS", () => {
	const plantedValue = `zz${randomBytes(12).toString("hex")}Q9`;
	const rc = join(root, "planted.zsh");
	writeFileSync(rc, `export PLANTED_DEMO_API_KEY="${plantedValue}"\n`);
	const red = doctor({ OMP_KIT_SECRET_SCAN_RC_FILES: rc });
	expect(red.code).toBe(1);
	expect(red.data.overall).toBe("FAIL");
	expect(red.data.rc_secret_hits).toEqual([{ path: expect.stringContaining("planted.zsh"), names: ["PLANTED_DEMO_API_KEY"] }]);
	expect(red.out).not.toContain(plantedValue);
	rmSync(rc);
	const green = doctor({});
	expect(green.code).toBe(0);
	expect(green.data.overall).toBe("PASS");
	expect(green.data.rc_secret_hits).toEqual([]);
});

test("NOAMBIENT1 acceptance: planted tmux global -> FAIL; output holds no value bytes", () => {
	const plantedValue = `tt${randomBytes(12).toString("hex")}Q9`;
	const run = doctor({ OMP_KIT_SECRET_SCAN_TMUX_ENV: `PLANTED_DEMO_SECRET=${plantedValue}\n` });
	expect(run.code).toBe(1);
	expect(run.data.overall).toBe("FAIL");
	expect(run.data.tmux_secret_names).toEqual(["PLANTED_DEMO_SECRET"]);
	expect(run.out).not.toContain(plantedValue);
});

test("NOAMBIENT1 acceptance: live process names fail with a respawn count, never values", () => {
	const run = doctor({ OMP_KIT_SECRET_SCAN_PROCESS_ENV: "PATH:PLANTED_DEMO_TOKEN", OMP_KIT_SECRET_SCAN_PROCESS_COUNT: "7" });
	expect(run.code).toBe(1);
	expect(run.data.overall).toBe("FAIL");
	expect(run.data.live_process_secret_names).toEqual(["PLANTED_DEMO_TOKEN"]);
	expect(run.data.live_process_count).toBe(7);
	// Names only by construction: the seam passes environment NAMES, values never enter the doctor.
	expect(run.out).toContain("PLANTED_DEMO_TOKEN");
});

test("NOAMBIENT1 names mirror the zsh guard globs exactly (no broader _KEY rule)", () => {
	for (const name of ["OPENAI_API_KEY", "GH_TOKEN", "SENTRY_DSN", "AWS_ACCESS_KEY_ID", "DATABASE_URL", "GITHUB_APP_ID", "DB_PASSWORD", "MY_BEARER"]) {
		expect(noAmbientSecretName(name)).toBe(true);
	}
	// Planted negatives the guard does not strip: a doctor FAIL on them would be a false alarm.
	for (const name of ["TERN_WINDOW_KEY", "TOKEN_FILE", "api_key", "PATH", "SSH_AUTH_SOCK"]) {
		expect(noAmbientSecretName(name)).toBe(false);
	}
	expect(liveProcessSecretNames(["TERN_WINDOW_KEY", "GH_TOKEN", "HOME"])).toEqual(["GH_TOKEN"]);
	expect(rcLiteralSecretNames(`export TERN_WINDOW_KEY=abcdefgh1234\nexport GH_TOKEN=${fake}\n`)).toEqual(["GH_TOKEN"]);
});

test("omp process count is argv[0] basename omp, not any command mentioning omp", () => {
	const ps = ["omp --profile codex --resume /x", "/opt/bin/omp --profile claude", "  omp", "omp-kit scratch apply --apply",
		"python3 /Users/x/compdirt.py", "/bin/zsh -c omp --version", "ompx serve", ""].join("\n");
	expect(ompArgvCount(ps)).toBe(3);
	expect(ompArgvCount("")).toBe(0);
});
