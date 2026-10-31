// Controlled gh children test installer policy and cancellation, not live Sigstore cryptography.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkInstallerBootstrap } from "../../scripts/package-release";
import { run, type RunResult } from "../../src/kitlib/run";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp";

const root = resolve(import.meta.dir, "../..");
const installerSource = readFileSync(join(root, "installer/install.py"), "utf8");
const python = (() => {
	const found = Bun.which("python3");
	if (!found) throw new Error("installer bootstrap tests require Python 3");
	return realpathSync(found);
})();
const decoder = new TextDecoder();
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const version = "1.2.3";
const platform = `${process.platform}-${process.arch}-${process.platform === "darwin" ? "none" : "gnu"}`;
const fakeGh = `#!${python}
import json, os, signal, sys, time
from pathlib import Path
args = sys.argv[1:]
mode = os.environ.get("GH_CASE", "valid")
if args[:3] == ["api", "--hostname", "github.com"]:
    if "/attestations/sha256:" in args[3]:
        assert args[4:] == ["--jq", ".attestations[].bundle | tojson"], args
        size = int(os.environ.get("BUNDLE_BYTES", "0"))
        data = b'{"fixture":true}'
        if size:
            prefix, suffix = b'{"fixture":true,"pad":"', b'"}'
            data = prefix + b'x' * (size - len(prefix) - len(suffix)) + suffix
            assert len(data) == size
        if mode == "download-failure":
            os.write(2, b"\\xffdownload refused"); sys.exit(17)
        sys.stdout.buffer.write(data)
    else:
        assert args[3:] == ["repos/JYeswak/omp-kit-companion/commits/v1.2.3", "--jq", ".sha"], args
        if mode == "source-timeout":
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            child = os.fork()
            if child == 0:
                os.write(1, b"descendant-ready\\n")
                time.sleep(120)
                os._exit(0)
            Path(os.environ["CHILD_RECORD"]).write_text(json.dumps({"pid": child, "pgid": os.getpgrp()}))
            time.sleep(120)
        if mode == "source-failure":
            os.write(2, b"\\xffsource refused"); sys.exit(19)
        sys.stdout.write("a" * 40 + (" " * 65537 if mode == "source-flood" else "") + "\\n")
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

interface Fixture { work: string; scratch: OwnedTmp; env: Record<string, string> }

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
		work, scratch,
		env: { HOME: join(work, "home"), PATH: join(work, "bin"),
			TMPDIR: work, TMP: work, TEMP: work, SENTINEL_PRIVATE_ENV: "must-not-reach-probe" },
	};
}

async function invoke(f: Fixture, args: string[], mode: "isolated" | "file" | "shell" = "isolated", extra: Record<string, string> = {}, deadline = 15): Promise<RunResult> {
	const argv = mode === "isolated" ? [python, "-I", "-c", installerSource, ...args]
		: mode === "file" ? [python, "-I", join(f.work, "bootstrap/install.py"), ...args]
		: ["/bin/sh", join(f.work, "bootstrap/install.sh"), ...args];
	return run(argv, { cwd: f.work, env: { ...f.env, ...extra }, deadline_s: deadline, grace_s: 1, max_output_bytes: 1 << 20 });
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
		for (const [mode, code] of [["source-failure", "KIT_ATTESTATION_SOURCE_UNVERIFIED"], ["source-flood", "KIT_ATTESTATION_SOURCE_UNVERIFIED"],
			["verify-failure", "KIT_ATTESTATION_UNVERIFIED"], ["verify-flood", "KIT_ATTESTATION_UNVERIFIED"]]) {
			expectRefusal(await invoke(f, ["attestation", a.path, version, platform], "isolated", { GH_CASE: mode! }), code!);
		}
		writeFileSync(`${a.path}.sigstore.json`, '{"fixture":false}');
		expectRefusal(await invoke(f, ["attestation", a.path, version, platform]), "KIT_ATTESTATION_UNVERIFIED");
		writeFileSync(`${a.path}.sigstore.json`, "[]");
		expectRefusal(await invoke(f, ["attestation", a.path, version, platform]), "KIT_ATTESTATION_BUNDLE_INVALID");
		expectRefusal(await invoke(f, ["attestation", join(f.work, "missing"), version, platform]), "KIT_ATTESTATION_BUNDLE_MISSING");
	} finally { f.scratch.cleanup(); }
});

test("download keeps a complete 16 MiB valid bundle, refuses overflow and checked gh failure without writing", async () => {
	const f = fixture();
	try {
		const path = join(f.work, "download.tar");
		writeFileSync(path, "controlled archive digest input");
		expectSuccess(await invoke(f, ["bundle", path, version, platform], "isolated", { BUNDLE_BYTES: String(16 << 20) }));
		expect(readFileSync(`${path}.sigstore.json`).byteLength).toBe(16 << 20);
		expect(JSON.parse(readFileSync(`${path}.sigstore.json`, "utf8")).fixture).toBe(true);
		for (const [name, extra] of [["overflow", { BUNDLE_BYTES: String((16 << 20) + 1) }], ["failed", { GH_CASE: "download-failure" }]] as const) {
			const input = join(f.work, `${name}.tar`); writeFileSync(input, "input");
			expectRefusal(await invoke(f, ["bundle", input, version, platform], "isolated", extra), "KIT_ATTESTATION_BUNDLE_UNAVAILABLE");
			expect(existsSync(`${input}.sigstore.json`)).toBe(false);
		}
	} finally { f.scratch.cleanup(); }
}, 30_000);

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
});

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
    ns['_run']([sys.executable, '-I', '-c', 'import os; os.write(1, b"\\\\xffout"); os.write(2, b"\\\\xfeerr"); raise SystemExit(7)'], deadline_s=5, max_output_bytes=1024, check=True)
except subprocess.CalledProcessError as error:
    assert error.returncode == 7 and error.output == b'\\xffout' and error.stderr == b'\\xfeerr', repr(error)
else:
    raise AssertionError('checked failure accepted')
# These are real platform deadline/pipe semantics; fake timers cannot drive the child.
try:
    ns['_run']([sys.executable, '-I', '-c', 'import os,time; os.write(1, b"\\\\xffout"); os.write(2, b"\\\\xfeerr"); time.sleep(10)'], deadline_s=0.5, max_output_bytes=1024)
except subprocess.TimeoutExpired as error:
    assert error.output == b'\\xffout' and error.stderr == b'\\xfeerr', repr(error)
else:
    raise AssertionError('deadline result did not retain timeout exception semantics')
`;
		expectSuccess(await run([python, "-I", "-c", code], { cwd: f.work, env: f.env, deadline_s: 10, grace_s: 1, max_output_bytes: 65536 }));
	} finally { f.scratch.cleanup(); }
});

test("original 30-second tag lookup deadline kills a TERM-ignoring descendant and preserves unavailable classification", async () => {
	const f = fixture();
	const record = join(f.work, "owned-child.json");
	let needsCleanup = true;
	try {
		const a = archive(f);
		const result = await invoke(f, ["attestation", a.path, version, platform], "isolated", { GH_CASE: "source-timeout", CHILD_RECORD: record }, 40);
		expectRefusal(result, "KIT_ATTESTATION_VERIFIER_UNAVAILABLE");
		expect(decoder.decode(result.stderr)).toContain("timed out after 30 seconds");
		const child = JSON.parse(readFileSync(record, "utf8")) as { pid: number; pgid: number };
		const end = performance.now() + 3000;
		let alive = true;
		do {
			const observed = await run(["/bin/ps", "-p", String(child.pid), "-o", "stat="], { deadline_s: 2, grace_s: 0.1, max_output_bytes: 1024 });
			expect(observed.timed_out).toBe(false);
			expect([0, 1]).toContain(observed.rc);
			const state = decoder.decode(observed.stdout).trim();
			alive = state.length > 0 && !state.startsWith("Z");
			needsCleanup = alive;
			// A real OS process-group death/reap cannot be advanced by fake timers.
			if (alive) await Bun.sleep(50);
		} while (alive && performance.now() < end);
		expect(alive, "installer leaked its controlled descendant").toBe(false);
	} finally {
		// Only the process group created by this controlled gh fixture is eligible.
		if (needsCleanup && existsSync(record)) {
			const { pid, pgid } = JSON.parse(readFileSync(record, "utf8")) as { pid: number; pgid: number };
			const cleanup = await run([python, "-I", "-c", "import os,signal,sys\npid,pgid = map(int, sys.argv[1:])\ntry:\n    if os.getpgid(pid) == pgid and pgid != os.getpgrp(): os.killpg(pgid, signal.SIGKILL)\nexcept ProcessLookupError: pass", String(pid), String(pgid)],
				{ deadline_s: 3, grace_s: 0.1, max_output_bytes: 1024 });
			expectSuccess(cleanup);
		}
		f.scratch.cleanup();
	}
}, 45_000);

test("release preflight accepts canonical payload, rejects source drift, and explicit regeneration repairs only generated delivery", async () => {
	const f = fixture();
	try {
		const copy = join(f.work, "producer"); mkdirSync(copy);
		for (const directory of ["installer", "scripts"]) mkdirSync(join(copy, directory));
		for (const file of ["installer/install.py", "installer/embed-bootstrap.py", "scripts/pysafe.py", "scripts/kitlib_run.py"]) copyFileSync(join(root, file), join(copy, file));
		await checkInstallerBootstrap(copy);
		const path = join(copy, "scripts/kitlib_run.py");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n# controlled canonical-source drift\n`);
		await expect(checkInstallerBootstrap(copy)).rejects.toThrow("INSTALLER_BOOTSTRAP_STALE_OR_UNAVAILABLE");
		const generated = await run([python, "-I", join(copy, "installer/embed-bootstrap.py")], { cwd: copy, deadline_s: 10, grace_s: 1, max_output_bytes: 65536 });
		expectSuccess(generated);
		await checkInstallerBootstrap(copy);
		const once = readFileSync(join(copy, "installer/install.py"));
		expectSuccess(await run([python, "-I", join(copy, "installer/embed-bootstrap.py")], { cwd: copy, deadline_s: 10, grace_s: 1, max_output_bytes: 65536 }));
		expect(readFileSync(join(copy, "installer/install.py"))).toEqual(once);
	} finally { f.scratch.cleanup(); }
});
