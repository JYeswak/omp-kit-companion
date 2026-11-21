// Controlled gh children test installer policy and verification, a loopback API stands in for api.github.com, none touch live Sigstore cryptography.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkInstallerBootstrap } from "../../scripts/package-release";
import { run, runSync, type RunResult } from "../../src/kitlib/run";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS, fixtureLoad } from "./fixture-process.ts";
import { startGithubApi, type GithubApiFixture } from "./github-api-fixture.ts";

const root = resolve(import.meta.dir, "../..");
const installerSource = readFileSync(join(root, "installer/install.py"), "utf8");
const decoder = new TextDecoder();
// HERMPATH1: on macOS /usr/bin/python3 is one inode with ~78 names (git, make, pip3, ...), an
// xcode-select stub that picks its tool from argv[0]. realpath of a hard link may report any of
// those names, so realpathSync once turned python3 into /usr/bin/git and all nine tests ran git
// (`git: unknown option: -I`, rc 129). Use the path the interpreter reports for itself, and
// require that exact path to run as Python 3.
function python3Probe(command: string): { major: string; executable: string; detail: string } {
	const result = runSync([command, "-I", "-c", "import sys; print(sys.version_info[0]); print(sys.executable)"], { deadline_s: fixtureDeadlineS(), max_output_bytes: 4096 });
	const [major = "", executable = ""] = decoder.decode(result.stdout).split("\n");
	return { major: result.rc === 0 ? major : "", executable, detail: `rc=${result.rc} timed_out=${result.timed_out} stderr=${JSON.stringify(decoder.decode(result.stderr).slice(-400))}` };
}
const python = (() => {
	const found = Bun.which("python3");
	if (!found) throw new Error("INSTALLER_TEST_PYTHON3_UNRESOLVED: no python3 on PATH");
	const reported = python3Probe(found);
	if (reported.major !== "3" || !reported.executable.startsWith("/"))
		throw new Error(`INSTALLER_TEST_PYTHON3_UNRESOLVED: ${found} is not Python 3 or reports no absolute sys.executable (major=${JSON.stringify(reported.major)} executable=${JSON.stringify(reported.executable)} ${reported.detail})`);
	const direct = python3Probe(reported.executable);
	if (direct.major !== "3")
		throw new Error(`INSTALLER_TEST_PYTHON3_UNRESOLVED: ${reported.executable} (sys.executable of ${found}) does not run as Python 3 (major=${JSON.stringify(direct.major)} ${direct.detail})`);
	return reported.executable;
})();
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const version = "1.2.3";
const platform = `${process.platform}-${process.arch}-${process.platform === "darwin" ? "none" : "gnu"}`;
const fakeGh = `#!${python}
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
mode = os.environ.get("GH_CASE", "valid")
if os.environ.get("GH_CALL_LOG"):
    with open(os.environ["GH_CALL_LOG"], "a") as log:
        log.write(json.dumps(args) + "\\n")
if mode == "old-gh" and args[:2] == ["attestation", "verify"]:
    # A distro gh (Ubuntu 24.04 ships 2.45) has no \`attestation\` command: it prints its whole usage and exits 1.
    os.write(2, b'unknown command "attestation" for "gh"\\n\\nUsage:  gh <command> <subcommand> [flags]\\n\\nAvailable commands:\\n  alias\\n  api\\n'); sys.exit(1)
if args[:1] == ["api"]:
    # OUTSIDERAUTH1: the installer fetches the tag and the bundle itself; a call to \`gh api\` (which needs a login) is a regression.
    os.write(2, b"fake gh: the installer must not call gh api"); sys.exit(41)
elif args[:2] == ["attestation", "verify"]:
    expected = {"--hostname":"github.com", "--repo":"JYeswak/omp-kit-companion",
                "--cert-oidc-issuer":"https://token.actions.githubusercontent.com",
                "--signer-workflow":"JYeswak/omp-kit-companion/.github/workflows/release.yml",
                "--source-digest":"a" * 40, "--predicate-type":"https://slsa.dev/provenance/v1"}
    assert dict(zip(args[3::2], args[4::2])) == dict(expected, **{"--bundle":args[args.index("--bundle") + 1]}), args
    bundles = [json.loads(line) for line in Path(args[args.index("--bundle") + 1]).read_text().splitlines()]
    if not bundles or not all(item.get("fixture") is True for item in bundles) or mode == "verify-failure":
        os.write(2, b"\\xffsignature refused"); sys.exit(23)
    sys.stdout.write("verified" + ("x" * (1024 * 1024) if mode == "verify-flood" else ""))
else:
    raise AssertionError(args)
`;

interface Fixture { work: string; scratch: OwnedTmp; env: Record<string, string>; api: GithubApiFixture }

// The loopback stand-in for api.github.com (tests/cli/github-api-fixture.ts): every request is recorded so the tests
// can show what the installer sent.
const apis = new Set<GithubApiFixture>();
afterAll(() => { for (const api of apis) api.stop(); });
function startApi(): GithubApiFixture {
	const api = startGithubApi({ version });
	apis.add(api);
	return api;
}

function fixture(): Fixture {
	const scratch = ownedTmp("installer-bootstrap");
	const work = realpathSync(scratch.path);
	for (const directory of ["home", "bin", "bootstrap", "assets"]) mkdirSync(join(work, directory), { mode: 0o700 });
	for (const file of ["install.py", "install.sh"]) copyFileSync(join(root, "installer", file), join(work, "bootstrap", file));
	const poison = "raise RuntimeError('untrusted sibling/installed runner imported')\n";
	for (const name of ["pysafe.py", "kitlib_run.py"]) writeFileSync(join(work, "bootstrap", name), poison);
	writeFileSync(join(work, "bin/gh"), fakeGh, { mode: 0o700 });
	symlinkSync(python, join(work, "bin/python3"));
	for (const name of ["dirname", "uname", "getconf"]) {
		const command = Bun.which(name);
		if (!command) throw new Error(`installer shell tests require ${name}`);
		symlinkSync(command, join(work, "bin", name));
	}
	return {
		work, scratch, api: startApi(),
		env: { HOME: join(work, "home"), PATH: join(work, "bin"),
			TMPDIR: work, TMP: work, TEMP: work, SENTINEL_PRIVATE_ENV: "must-not-reach-probe" },
	};
}

async function invoke(f: Fixture, args: string[], mode: "isolated" | "file" | "shell" = "isolated", extra: Record<string, string> = {}, deadline = fixtureDeadlineS(15)): Promise<RunResult> {
	const argv = mode === "isolated" ? [python, "-I", "-c", installerSource, ...args]
		: mode === "file" ? [python, "-I", join(f.work, "bootstrap/install.py"), ...args]
		: ["/bin/sh", join(f.work, "bootstrap/install.sh"), ...args];
	return run(argv, { cwd: f.work, env: { ...f.env, OMP_KIT_GITHUB_API: f.api.url, ...extra }, deadline_s: deadline, grace_s: 1, max_output_bytes: 1 << 20 });
}

function expectSuccess(result: RunResult): void {
	expect(result.timed_out, decoder.decode(result.stderr)).toBe(false);
	expect(result.truncated).toBe(false);
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
}
function expectRefusal(result: RunResult, code: string): void {
	expect(result.timed_out, decoder.decode(result.stderr)).toBe(false);
	expect(result.rc).toBe(2);
	expect(decoder.decode(result.stderr)).toContain(code);
}

// A real USTAR archive with controlled executable bytes; the hash and inventory
// controls run unchanged. Candidate Python modules are deliberately poisonous.
function archive(f: Fixture, probe?: string) {
	const info = JSON.stringify({ data: { version, platform: { os: process.platform, arch: process.arch }, release: { source_tag: `v${version}` } } });
	const binary = probe ?? `#!/bin/sh\nset -eu\n[ "$*" = '--info --json' ]\n[ -z "\${SENTINEL_PRIVATE_ENV:-}" ]\n[ "$HOME" = "$PWD" ]\n[ "$TMPDIR" = "$PWD" ]\n[ "$TMP" = "$PWD" ]\n[ "$TEMP" = "$PWD" ]\nfor directory in "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"; do [ -d "$directory" ]; done\nprintf '%s\\n' '${info}'\n`;
	const files: Record<string, Buffer> = {
		"bin/omp-kit": Buffer.from(binary),
		"scripts/pysafe.py": Buffer.from("raise RuntimeError('candidate pysafe must not be imported')\n"),
		"scripts/kitlib_run.py": Buffer.from("raise RuntimeError('candidate kitlib_run must not be imported')\n"),
	};
	const manifest = Buffer.from(JSON.stringify({ schema_version: 1, version, source_tag: `v${version}`,
		files: Object.keys(files).sort().map(path => ({ path, sha256: digest(files[path]!) })) }));
	files["release-manifest.json"] = manifest;
	const blocks: Buffer[] = [];
	for (const [name, data] of Object.entries(files)) {
		const header = Buffer.alloc(512);
		header.write(name);
		for (const [offset, width, value] of [[100, 8, 0o755], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]] as const) {
			header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
		}
		header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257, 6, "ascii");
		header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	const bytes = Buffer.concat(blocks);
	const filename = `omp-kit-v${version}-${platform}.tar`;
	const path = join(f.work, "assets", filename);
	const index = join(f.work, "assets/index.json");
	writeFileSync(path, bytes);
	writeFileSync(`${path}.sigstore.json`, '{"fixture":true}');
	writeFileSync(index, JSON.stringify({ schema_version: 1, version, source_tag: `v${version}`, assets: { [platform]: {
		os: process.platform, arch: process.arch, libc: process.platform === "darwin" ? "none" : "gnu", filename,
		sha256: digest(bytes), manifest_sha256: digest(manifest),
	} } }));
	return { path, index, bytes, binary: Buffer.from(binary), prefix: join(f.work, "prefix") };
}

for (const mode of ["isolated", "file", "shell"] as const) {
	test(`fresh standalone ${mode} bootstrap validates and installs without importing candidate or sibling helpers`, async () => {
		const f = fixture();
		try {
			const a = archive(f);
			const args = mode === "shell" ? ["--version", version, "--index", a.index, "--offline", a.path, "--prefix", a.prefix]
				: ["install", a.index, version, platform, a.path, a.prefix, "0"];
			expectSuccess(await invoke(f, args, mode));
			expect(readlinkSync(join(a.prefix, "bin/omp-kit"))).toBe(`../releases/${version}/bin/omp-kit`);
			expect(readFileSync(join(a.prefix, `releases/${version}/bin/omp-kit`))).toEqual(a.binary);
		} finally { f.scratch.cleanup(); }
	});
}

test("isolated attestation accepts JSON-lines policy control, rejects invalid/missing bundles and source/verifier errors", async () => {
	const f = fixture();
	try {
		const a = archive(f);
		writeFileSync(`${a.path}.sigstore.json`, '{"fixture":true}\n{"fixture":true}\n');
		expectSuccess(await invoke(f, ["attestation", a.path, version, platform]));
		expectRefusal(await invoke(f, ["attestation", a.path, version, platform], "isolated", { PATH: "/nonexistent-installer-test-bin" }), "KIT_ATTESTATION_VERIFIER_UNAVAILABLE");
		for (const mode of ["source-failure", "source-flood", "source-short", "source-rate-limit", "source-redirect-away"]) {
			f.api.mode = mode;
			expectRefusal(await invoke(f, ["attestation", a.path, version, platform]), "KIT_ATTESTATION_SOURCE_UNVERIFIED");
		}
		// A redirect that stays on the API base (a renamed repository) is followed.
		f.api.mode = "source-redirect-same";
		expectSuccess(await invoke(f, ["attestation", a.path, version, platform]));
		f.api.mode = "valid";
		for (const [mode, code] of [["verify-failure", "KIT_ATTESTATION_UNVERIFIED"], ["verify-flood", "KIT_ATTESTATION_UNVERIFIED"]]) {
			expectRefusal(await invoke(f, ["attestation", a.path, version, platform], "isolated", { GH_CASE: mode! }), code!);
		}
		// A gh too old to verify attestations is a missing verifier with a remedy, not a verdict on the archive, and its usage dump is cut.
		const oldGh = await invoke(f, ["attestation", a.path, version, platform], "isolated", { GH_CASE: "old-gh" });
		expectRefusal(oldGh, "KIT_ATTESTATION_VERIFIER_UNAVAILABLE");
		const oldText = decoder.decode(oldGh.stderr);
		expect(oldText).toContain("2.69");
		expect(oldText).toContain("https://cli.github.com");
		expect(oldText).not.toContain("Available commands");
		expect(oldText).not.toContain("KIT_ATTESTATION_UNVERIFIED");
		const absent = await invoke(f, ["attestation", a.path, version, platform], "isolated", { PATH: "/nonexistent-installer-test-bin" });
		expect(decoder.decode(absent.stderr)).toContain("https://cli.github.com");
		writeFileSync(`${a.path}.sigstore.json`, '{"fixture":false}');
		expectRefusal(await invoke(f, ["attestation", a.path, version, platform]), "KIT_ATTESTATION_UNVERIFIED");
		writeFileSync(`${a.path}.sigstore.json`, "[]");
		expectRefusal(await invoke(f, ["attestation", a.path, version, platform]), "KIT_ATTESTATION_BUNDLE_INVALID");
		expectRefusal(await invoke(f, ["attestation", join(f.work, "missing"), version, platform]), "KIT_ATTESTATION_BUNDLE_MISSING");
	} finally { f.scratch.cleanup(); }
});

test("download keeps a complete 16 MiB valid answer, refuses overflow, an empty store and a checked API failure without writing", async () => {
	const f = fixture();
	try {
		const path = join(f.work, "download.tar");
		writeFileSync(path, "controlled archive digest input");
		f.api.bundleBytes = 16 << 20;
		expectSuccess(await invoke(f, ["bundle", path, version, platform], "isolated", {}, fixtureDeadlineS(30)));
		const written = readFileSync(`${path}.sigstore.json`);
		expect(written.byteLength).toBeLessThanOrEqual(16 << 20);
		expect(written.byteLength).toBeGreaterThan((16 << 20) - 4096);
		expect(JSON.parse(written.toString("utf8")).fixture).toBe(true);
		for (const [name, mode, bytes] of [["overflow", "valid", (16 << 20) + 1], ["failed", "download-failure", 0], ["empty", "download-empty", 0]] as const) {
			f.api.mode = mode; f.api.bundleBytes = bytes;
			const input = join(f.work, `${name}.tar`); writeFileSync(input, "input");
			expectRefusal(await invoke(f, ["bundle", input, version, platform], "isolated", {}, fixtureDeadlineS(30)), "KIT_ATTESTATION_BUNDLE_UNAVAILABLE");
			expect(existsSync(`${input}.sigstore.json`)).toBe(false);
		}
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(60) * 1000);

test("staged identity probe preserves checked failures and never activates truncated or tampered candidate bytes", async () => {
	const f = fixture();
	try {
		let a = archive(f, "#!/bin/sh\nprintf 'not-json\\n'\nprintf 'checked failure\\n' >&2\nexit 29\n");
		expectRefusal(await invoke(f, ["install", a.index, version, platform, a.path, a.prefix, "0"]), "returned non-zero exit status 29");
		expect(existsSync(join(a.prefix, "bin/omp-kit"))).toBe(false);
		const paddedInfo = JSON.stringify({ data: { version, platform: { os: process.platform, arch: process.arch }, release: { source_tag: `v${version}` } } });
		a = archive(f, `#!${python}\nimport sys\nsys.stdout.write(${JSON.stringify(paddedInfo)} + ' ' * (1024 * 1024 + 1))\n`);
		expectRefusal(await invoke(f, ["install", a.index, version, platform, a.path, a.prefix, "0"]), "staged binary output exceeds capture limit");
		expect(existsSync(join(a.prefix, "bin/omp-kit"))).toBe(false);
		a = archive(f); const changed = Buffer.from(a.bytes); changed[512] = changed[512]! ^ 1; writeFileSync(a.path, changed);
		expectRefusal(await invoke(f, ["install", a.index, version, platform, a.path, a.prefix, "0"]), "archive SHA-256 mismatch");
		expect(existsSync(join(a.prefix, "bin/omp-kit"))).toBe(false);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(60) * 1000);

test("in-memory bootstrap isolates existing module/path state and preserves raw checked exception bytes", async () => {
	const f = fixture();
	try {
		const code = `import os, subprocess, sys, types
poison = types.ModuleType('pysafe')
sys.modules['pysafe'] = poison
before = sys.path[:]
ns = {'__name__': 'installer_contract'}
exec(compile(${JSON.stringify(installerSource)}, '<standalone installer>', 'exec'), ns)
assert sys.modules['pysafe'] is poison and sys.path == before
try:
    ns['_run']([sys.executable, '-I', '-c', 'import os; os.write(1, b"\\\\xffout"); os.write(2, b"\\\\xfeerr"); raise SystemExit(7)'], deadline_s=${fixtureDeadlineS(5)}, max_output_bytes=1024, check=True)
except subprocess.CalledProcessError as error:
    assert error.returncode == 7 and error.output == b'\\xffout' and error.stderr == b'\\xfeerr', repr(error)
else:
    raise AssertionError('checked failure accepted')
# These are real platform deadline/pipe semantics; fake timers cannot drive the child. The child must
# start and write before the deadline (load slows that), and the deadline stays far below its 10 s sleep.
try:
    ns['_run']([sys.executable, '-I', '-c', 'import os,time; os.write(1, b"\\\\xffout"); os.write(2, b"\\\\xfeerr"); time.sleep(10)'], deadline_s=${fixtureDeadlineS(0.5)}, max_output_bytes=1024)
except subprocess.TimeoutExpired as error:
    assert error.output == b'\\xffout' and error.stderr == b'\\xfeerr', repr(error)
else:
    raise AssertionError('deadline result did not retain timeout exception semantics')
`;
		expectSuccess(await run([python, "-I", "-c", code], { cwd: f.work, env: f.env, deadline_s: fixtureDeadlineS(10), grace_s: 1, max_output_bytes: 65536 }));
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(15) * 1000);

// OUTSIDERAUTH1: the tag lookup and the bundle fetch speak to the public GitHub API with the standard library, so a
// machine with `gh` but no GitHub login installs. The helper is exercised in memory against loopback servers.
function githubGetProbe(f: Fixture, body: string): Promise<RunResult> {
	const code = `import json, sys
ns = {'__name__': 'installer_api_contract'}
exec(compile(${JSON.stringify(installerSource)}, '<standalone installer>', 'exec'), ns)
def attempt(**kw):
    try:
        data = ns['github_get']('repos/JYeswak/omp-kit-companion/commits/v1.2.3', accept='application/vnd.github.sha', **kw)
        return ['ok', data.decode()[:60]]
    except (OSError, ValueError) as error:
        return [type(error).__name__, str(error)[:160]]
${body}
`;
	return run([python, "-I", "-c", code], { cwd: f.work, env: { ...f.env, OMP_KIT_GITHUB_API: f.api.url }, deadline_s: fixtureDeadlineS(25), grace_s: 1, max_output_bytes: 65536 });
}

function answers(result: RunResult): Record<string, string[]> {
	expectSuccess(result);
	return JSON.parse(decoder.decode(result.stdout)) as Record<string, string[]>;
}

test("OUTSIDERAUTH1 github_get answers only complete in-cap responses inside its deadline and never follows a redirect off its base", async () => {
	const f = fixture();
	try {
		f.api.mode = "source-hang";
		const hang = answers(await githubGetProbe(f, `print(json.dumps({'hang': attempt(deadline_s=${fixtureDeadlineS(1)}, max_bytes=4096)}))`)).hang!;
		expect(hang[0]).not.toBe("ok"); // a server that never answers is refused at the deadline, not waited on
		f.api.mode = "source-flood";
		const flood = answers(await githubGetProbe(f, `print(json.dumps({'flood': attempt(deadline_s=${fixtureDeadlineS(10)}, max_bytes=4096), 'roomy': attempt(deadline_s=${fixtureDeadlineS(10)}, max_bytes=1 << 20)}))`));
		expect(flood.flood).toEqual(["ValueError", "response exceeds 4096 bytes"]); // the cap is on the body, not on a slice of it
		expect(flood.roomy![0]).toBe("ok");
		f.api.mode = "source-redirect-away";
		expect(answers(await githubGetProbe(f, `print(json.dumps({'away': attempt(deadline_s=${fixtureDeadlineS(10)}, max_bytes=4096)}))`)).away![0]).toBe("OSError");
		f.api.mode = "source-rate-limit";
		const limited = answers(await githubGetProbe(f, `print(json.dumps({'limited': attempt(deadline_s=${fixtureDeadlineS(10)}, max_bytes=4096)}))`)).limited!;
		expect(limited[1]).toContain("HTTP 403");
		expect(limited[1]).toContain("(rate limited)");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(60) * 1000);

test("OUTSIDERAUTH1 an installer with gh but no login fetches anonymously, never calls gh api, and sends a token only to api.github.com", async () => {
	const f = fixture();
	try {
		const a = archive(f);
		const log = join(f.work, "gh-calls.jsonl");
		const env = { GH_CALL_LOG: log, GH_CONFIG_DIR: join(f.work, "empty-gh-config") };
		expectSuccess(await invoke(f, ["attestation", a.path, version, platform], "isolated", env));
		const input = join(f.work, "fetch.tar"); writeFileSync(input, "controlled archive digest input");
		expectSuccess(await invoke(f, ["bundle", input, version, platform], "isolated", env));
		// The lookup and the bundle fetch asked the fixture API, with the documented media types and no credential.
		expect(f.api.requests.map(r => [r.path.replace(/sha256:[0-9a-f]{64}/, "sha256:DIGEST"), r.accept])).toEqual([
			["/repos/JYeswak/omp-kit-companion/commits/v1.2.3", "application/vnd.github.sha"],
			["/repos/JYeswak/omp-kit-companion/attestations/sha256:DIGEST", "application/vnd.github+json"],
		]);
		expect(f.api.requests.every(r => r.authorization === null)).toBe(true);
		// A token in the environment still never reaches a non-GitHub base.
		expectSuccess(await invoke(f, ["attestation", a.path, version, platform], "isolated", { ...env, GH_TOKEN: "ghp_fixture_token_must_not_leave_the_machine" }));
		expect(f.api.requests.every(r => r.authorization === null)).toBe(true);
		// gh was only ever asked to verify: a regression to `gh api` shows here and in the fake's own refusal.
		const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every(call => call[0] === "attestation" && call[1] === "verify")).toBe(true);
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(40) * 1000);

test("OUTSIDERAUTH1 an untrusted API base is refused before any request, and an unreachable one is a named, actionable refusal", async () => {
	const f = fixture();
	try {
		const a = archive(f);
		for (const base of ["https://evil.example", "http://example.com:80", "http://127.0.0.1:80@evil.example", "http://127.0.0.1", "ftp://127.0.0.1:21", "https://api.github.com.evil.example"]) {
			expectRefusal(await invoke(f, ["attestation", a.path, version, platform], "isolated", { OMP_KIT_GITHUB_API: base }), "KIT_ATTESTATION_API_UNTRUSTED");
		}
		expect(f.api.requests).toEqual([]);
		// Nothing listens on port 1: the refusal names the code and the remedy, and no longer demands `gh auth login`.
		const down = await invoke(f, ["attestation", a.path, version, platform], "isolated", { OMP_KIT_GITHUB_API: "http://127.0.0.1:1" });
		expectRefusal(down, "KIT_ATTESTATION_SOURCE_UNVERIFIED");
		expect(decoder.decode(down.stderr)).toContain("so no `gh auth login` is needed");
		expect(decoder.decode(down.stderr)).not.toContain("run `gh auth login` first");
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(30) * 1000);

test("release preflight accepts canonical payload, rejects source drift, and explicit regeneration repairs only generated delivery", async () => {
	const f = fixture();
	try {
		const copy = join(f.work, "producer"); mkdirSync(copy);
		for (const directory of ["installer", "scripts", "src/kitlib"]) mkdirSync(join(copy, directory), { recursive: true });
		for (const file of ["installer/install.py", "installer/embed-bootstrap.py", "scripts/pysafe.py", "scripts/kitlib_run.py", "src/kitlib/pysafe-source.ts"]) copyFileSync(join(root, file), join(copy, file));
		await checkInstallerBootstrap(copy);
		const path = join(copy, "scripts/kitlib_run.py");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n# controlled canonical-source drift\n`);
		await expect(checkInstallerBootstrap(copy)).rejects.toThrow("INSTALLER_BOOTSTRAP_STALE_OR_UNAVAILABLE");
		const generated = await run([python, "-I", join(copy, "installer/embed-bootstrap.py")], { cwd: copy, deadline_s: fixtureDeadlineS(10), grace_s: 1, max_output_bytes: 65536 });
		expectSuccess(generated);
		await checkInstallerBootstrap(copy);
		const once = readFileSync(join(copy, "installer/install.py"));
		expectSuccess(await run([python, "-I", join(copy, "installer/embed-bootstrap.py")], { cwd: copy, deadline_s: fixtureDeadlineS(10), grace_s: 1, max_output_bytes: 65536 }));
		expect(readFileSync(join(copy, "installer/install.py"))).toEqual(once);
		// GROUPREAP1: run.ts's embedded reaper source is generated delivery too; drift is refused and regeneration restores it.
		const embed = join(copy, "src/kitlib/pysafe-source.ts");
		writeFileSync(embed, `${readFileSync(embed, "utf8")}// controlled embed drift\n`);
		await expect(checkInstallerBootstrap(copy)).rejects.toThrow("INSTALLER_BOOTSTRAP_STALE_OR_UNAVAILABLE");
		expectSuccess(await run([python, "-I", join(copy, "installer/embed-bootstrap.py")], { cwd: copy, deadline_s: fixtureDeadlineS(10), grace_s: 1, max_output_bytes: 65536 }));
		expect(readFileSync(embed)).toEqual(readFileSync(join(root, "src/kitlib/pysafe-source.ts")));
	} finally { f.scratch.cleanup(); }
});

// EMBEDDEP1 (ompkit-fp72.120.16.197): 2b7a914010 changed scripts/pysafe.py without regenerating
// installer/install.py and passed the commit gate; every release preflight then refused it. The
// staged-embed pre-commit member judges the INDEX with the staged producer's own --check.
test("EMBEDDEP1 staging a pysafe.py change without regenerating installer/install.py is refused, naming the command; regenerated and staged, it is admitted", () => {
	const scratch = ownedTmp("installer-bootstrap-embed");
	try {
		const work = realpathSync(scratch.path);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
		env.TMPDIR = work;
		const git = (repo: string, ...args: string[]) => {
			const result = runSync(["git", "-C", repo, "-c", "user.name=embed test", "-c", "user.email=embed@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { env, deadline_s: fixtureDeadlineS(30) });
			expect(result.rc, decoder.decode(result.stderr)).toBe(0);
		};
		const members = join(work, "hooks"); mkdirSync(members);
		copyFileSync(join(root, "scripts/check-staged-embed.sh"), join(members, "56-omp-kit-staged-embed"));
		for (const helper of ["pysafe.py", "kitlib-tmp.sh"]) copyFileSync(join(root, "scripts", helper), join(members, helper));
		const member = (repo: string) => {
			const started = Date.now();
			const result = runSync(["sh", join(members, "56-omp-kit-staged-embed")], { cwd: repo, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 65536 });
			return { rc: result.rc, err: decoder.decode(result.stderr), seconds: (Date.now() - started) / 1000 };
		};
		const repo = join(work, "repo"); mkdirSync(repo);
		for (const directory of ["installer", "scripts", "src/kitlib"]) mkdirSync(join(repo, directory), { recursive: true });
		for (const file of ["installer/install.py", "installer/embed-bootstrap.py", "scripts/pysafe.py", "scripts/kitlib_run.py", "src/kitlib/pysafe-source.ts"]) copyFileSync(join(root, file), join(repo, file));
		writeFileSync(join(repo, "README.md"), "# fixture\n");
		git(repo, "init", "-q");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "fixture");
		// An unrelated staged path has no embed obligation.
		writeFileSync(join(repo, "README.md"), "# fixture, edited\n");
		git(repo, "add", "README.md");
		expect(member(repo).rc).toBe(0);
		// The planted escape: pysafe.py staged, installer/install.py not regenerated.
		const pysafe = join(repo, "scripts/pysafe.py");
		writeFileSync(pysafe, `${readFileSync(pysafe, "utf8")}\n# planted EMBEDDEP1 drift\n`);
		git(repo, "add", "scripts/pysafe.py");
		const stale = member(repo);
		expect(stale.rc, stale.err).toBe(1);
		expect(stale.err).toContain("staged-embed: REFUSED: the staged generated files do not match their staged inputs (worktree ignored)");
		expect(stale.err).toContain("installer/install.py (from scripts/pysafe.py, scripts/kitlib_run.py)");
		// GROUPREAP1: run.ts's embedded reaper source is the second output of pysafe.py.
		expect(stale.err).toContain("src/kitlib/pysafe-source.ts (from scripts/pysafe.py)");
		expect(stale.err).toContain("python3 -I installer/embed-bootstrap.py");
		// Regenerated in the worktree only: the index is still stale, so it is still refused.
		const generated = runSync([python, "-I", join(repo, "installer/embed-bootstrap.py")], { cwd: repo, env, deadline_s: fixtureDeadlineS(10) });
		expect(generated.rc, decoder.decode(generated.stderr)).toBe(0);
		expect(member(repo).rc).toBe(1);
		git(repo, "add", "installer/install.py");
		// One regenerated output staged, the other still stale: refused.
		expect(member(repo).rc).toBe(1);
		git(repo, "add", "src/kitlib/pysafe-source.ts");
		const admitted = member(repo);
		expect(admitted.rc, admitted.err).toBe(0);
		// The 15 s staged-check budget, scaled by machine load like every fixture deadline here.
		expect(admitted.seconds).toBeLessThan(fixtureDeadlineS(15));
		// A repo whose index has no producer has no embed obligation.
		const plain = join(work, "plain"); mkdirSync(plain);
		writeFileSync(join(plain, "pysafe.py"), "X = 1\n");
		git(plain, "init", "-q");
		git(plain, "add", "-A");
		expect(member(plain).rc).toBe(0);
		// Planted negatives: renaming the map away, or dropping the producer, never disables the check.
		git(repo, "commit", "-q", "-m", "regenerated");
		const producerPath = join(repo, "installer/embed-bootstrap.py");
		const producerSource = readFileSync(producerPath, "utf8");
		expect(producerSource).toContain("\nEMBEDS = {\n");
		writeFileSync(producerPath, producerSource.replaceAll("EMBEDS", "GENERATED"));
		git(repo, "add", "installer/embed-bootstrap.py");
		const unmapped = member(repo);
		expect(unmapped.rc, unmapped.err).toBe(1);
		expect(unmapped.err).toContain("staged-embed: REFUSED: the staged installer/embed-bootstrap.py declares no EMBEDS map");
		writeFileSync(producerPath, producerSource);
		git(repo, "add", "installer/embed-bootstrap.py");
		expect(member(repo).rc).toBe(0);
		git(repo, "rm", "-q", "--cached", "installer/embed-bootstrap.py");
		const removed = member(repo);
		expect(removed.rc, removed.err).toBe(1);
		expect(removed.err).toContain("staged-embed: REFUSED: the commit removes installer/embed-bootstrap.py");
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(120) * 1000);


async function embeddedReaperConsumer(f: Fixture, restoreFileLaunch = false): Promise<RunResult> {
	const code = `import json, os, signal, subprocess, sys
ns = {"__name__": "installer_reaper_consumer"}
exec(compile(${JSON.stringify(installerSource)}, "<standalone installer>", "exec"), ns)
native = ns["kitlib_run"].pysafe
${restoreFileLaunch ? "native._reaper_source = None" : ""}

def finish_reaper():
    state = native._reaper_state
    fd, proc = state["fd"], state["proc"]
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
    state.update(owner=None, fd=None, proc=None)
    if proc is not None:
        try:
            proc.wait(timeout=${fixtureDeadlineS(5)})
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=${fixtureDeadlineS(2)})
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=${fixtureDeadlineS(2)})

try:
    # EOF must execute the actual canonical reaper, not a nonexistent __file__.
    native._reaper_start()
    entry = native._reaper_state["proc"]
    finish_reaper()
    if entry.returncode != 0:
        raise RuntimeError("INSTALLREAPER1_REAPER_EXIT:" + str(entry.returncode))

    observed = bytearray()
    registry_closed = False
    parent_reaper = None
    def observe(index, chunk):
        global registry_closed, parent_reaper
        if index == 0:
            observed.extend(chunk)
        if not registry_closed and b"READY\\n" in observed:
            parent_reaper = native._reaper_state["proc"]
            os.close(native._reaper_state["fd"])
            registry_closed = True

    # Closing only this process's registry simulates parent death. A no-op reaper
    # would leave the real child alive until run_bounded's separate timeout.
    result = native.run_bounded(
        [sys.executable, "-I", "-c", "import os,time; os.write(1,b'READY\\\\n'); time.sleep(120)"],
        timeout=${fixtureDeadlineS(10)}, grace=1, cap_bytes=4096, on_chunk=observe)
    if not registry_closed or result.outcome != native.OK or result.returncode != -signal.SIGKILL:
        raise RuntimeError("INSTALLREAPER1_SUPERVISION:" + repr(result))
    reaper_exit = parent_reaper.wait(timeout=${fixtureDeadlineS(5)})
    if reaper_exit != 0:
        raise RuntimeError("INSTALLREAPER1_REAPER_EXIT:" + str(reaper_exit))
    print(json.dumps({"reaper_exit": reaper_exit, "child_exit": result.returncode,
                      "child_ready": b"READY\\n" in result.stdout,
                      "child_timed_out": result.outcome == native.TIMEOUT}))
finally:
    finish_reaper()
`;
	return run([python, "-I", "-c", code], {
		cwd: f.work, env: f.env, deadline_s: fixtureDeadlineS(25), grace_s: 1, max_output_bytes: 65536,
	});
}

function expectEmbeddedReaperConsumer(result: RunResult): void {
	expectSuccess(result);
	expect(JSON.parse(decoder.decode(result.stdout))).toEqual({
		reaper_exit: 0, child_exit: -9, child_ready: true, child_timed_out: false,
	});
}

test("INSTALLREAPER1: standalone embedded reaper executes and reaps its supervised child at parent-registry EOF", async () => {
	const f = fixture();
	try {
		expectEmbeddedReaperConsumer(await embeddedReaperConsumer(f));
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(35) * 1000);

test("INSTALLREAPER1_MUTANT: restoring only the file-backed launch loses the unchanged embedded consumer", async () => {
	const f = fixture();
	try {
		expectEmbeddedReaperConsumer(await embeddedReaperConsumer(f));
		const mutant = await embeddedReaperConsumer(f, true);
		expect(mutant.timed_out).toBe(false);
		expect(mutant.rc).not.toBe(0);
		expect(decoder.decode(mutant.stderr)).toContain("INSTALLREAPER1_REAPER_EXIT:2");
		expect(() => expectEmbeddedReaperConsumer(mutant)).toThrow();
	} finally { f.scratch.cleanup(); }
}, fixtureDeadlineS(60) * 1000);
