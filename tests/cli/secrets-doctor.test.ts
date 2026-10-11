import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sha256, secretShapedName, tmuxSecretNames, digestSetFromFile, addSecretValueToDigestSet, findSecretNames } from "../../src/secrets-doctor.ts";

// Synthetic values only, minted per run: never a vault value, never in source text.
const fake = `fk${randomBytes(12).toString("hex")}`;
const root = join(process.cwd(), "var", "agent-tmp", `secrets-doctor.${process.pid}`);
mkdirSync(join(root, "scan"), { recursive: true });
writeFileSync(join(root, ".owner"), `pid=${process.pid} label=secrets-doctor-test repo=${process.cwd()}\n`);
const digests = join(root, "digests.tsv");
writeFileSync(digests, `${sha256(fake)}\tfake/prod:DEMO_API_KEY\t${fake.length}\n`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
function doctor(env: Record<string, string>, args: string[] = [], cwd = process.cwd()) {
	const run = spawnSync(process.execPath, [cli, "doctor", "--scope", "secrets", ...args, "--json"], { cwd, encoding: "utf8", env: { ...process.env, OMP_KIT_SECRET_DIGESTS_FILE: digests, OMP_KIT_SECRET_SCAN_ROOTS: join(root, "scan"), OMP_KIT_SECRET_SCAN_TMUX_ENV: "", ...env } });
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
