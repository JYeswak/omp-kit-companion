// A loopback stand-in for api.github.com, the only network authority the installer and the updater read:
// the tag lookup (`Accept: application/vnd.github.sha`, a 40-byte body) and the attestation store.
// Tests import `startGithubApi`; shell tests start it through tests/fixtures/kit-release/github-api.sh, which runs this
// file with --serve. Modes script the failures the consumers must refuse; every request is recorded so a test can show
// what was sent (and that a token went nowhere but an api.github.com-shaped authority).
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_REPO = "JYeswak/omp-kit-companion";
/** The commit the synthetic verifier double (tests/fixtures/kit-release/gh) expects as --source-digest. */
export const FIXTURE_SOURCE_SHA = "a".repeat(40);

export interface GithubApiRequest { path: string; accept: string | null; authorization: string | null }
export interface GithubApiFixture {
	url: string;
	/** valid | download-failure | download-empty | bundle-wrong | source-hang | source-failure | source-rate-limit | source-flood | source-short | source-redirect-away | source-redirect-same */
	mode: string;
	/** Pads the bundle to this many bytes (0 = the exact synthetic control `{"fixture":true}`). */
	bundleBytes: number;
	sha: string;
	requests: GithubApiRequest[];
	/** Runs on every tag lookup, before the answer: the authority boundary a test may plant a substitution at. */
	onSourceLookup?: () => void;
	stop(): void;
}

function attestationBody(bundle: string, pad: number): Response {
	const prefix = '{"attestations":[{"bundle":', suffix = "}]}";
	let body = bundle;
	if (pad > 0) {
		const head = bundle.slice(0, -1) + ',"pad":"', tail = '"}';
		const size = Math.max(pad, prefix.length + head.length + tail.length + suffix.length);
		body = head + "x".repeat(size - prefix.length - head.length - tail.length - suffix.length) + tail;
	}
	return new Response(prefix + body + suffix, { headers: { "content-type": "application/json" } });
}

export function startGithubApi(options: { version?: string; sha?: string } = {}): GithubApiFixture {
	const api: GithubApiFixture = { url: "", mode: "valid", bundleBytes: 0, sha: options.sha ?? FIXTURE_SOURCE_SHA, requests: [], stop() { server.stop(true); } };
	const lookup = (path: string) => options.version === undefined
		? new RegExp(`^/repos/${FIXTURE_REPO}/commits/v[0-9A-Za-z.+-]+$`).test(path)
		: path === `/repos/${FIXTURE_REPO}/commits/v${options.version}`;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(request) {
			const url = new URL(request.url);
			api.requests.push({ path: url.pathname, accept: request.headers.get("accept"), authorization: request.headers.get("authorization") });
			if (url.pathname.startsWith(`/repos/${FIXTURE_REPO}/attestations/sha256:`)) {
				if (api.mode === "download-failure") return new Response("download refused", { status: 500 });
				if (api.mode === "download-empty") return Response.json({ attestations: [] });
				return attestationBody(api.mode === "bundle-wrong" ? '{"fixture":false}' : '{"fixture":true}', api.bundleBytes);
			}
			if (lookup(url.pathname)) {
				api.onSourceLookup?.();
				if (api.mode === "source-hang") return new Promise<Response>(() => {});
				if (api.mode === "source-failure") return new Response("source refused", { status: 500 });
				if (api.mode === "source-rate-limit") return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
				if (api.mode === "source-flood") return new Response(api.sha + " ".repeat(65537));
				if (api.mode === "source-short") return new Response("abc");
				if (api.mode === "source-redirect-away") return new Response(null, { status: 302, headers: { location: "https://example.invalid/steal" } });
				if (api.mode === "source-redirect-same" && !url.searchParams.has("moved")) return new Response(null, { status: 302, headers: { location: `${api.url}${url.pathname}?moved=1` } });
				return new Response(api.sha);
			}
			return new Response("not found", { status: 404 });
		},
	});
	api.url = `http://127.0.0.1:${server.port}`;
	server.unref();
	return api;
}

/**
 * The same double in its own process, for a test that blocks the event loop (`Bun.spawnSync` of the installer): an
 * in-process server could not answer while its owner waits. `replaceArchive` plants the original-path substitution at
 * the authority boundary: at the tag lookup the file is rewritten, exactly where the verified copy must already be private.
 */
export function startGithubApiProcess(options: { dir: string; version?: string; replaceArchive?: string }): { url: string; stop(): void } {
	const portFile = join(options.dir, `github-api-${process.pid}-${Date.now()}.port`);
	const argv = [process.execPath, import.meta.path, "--serve", "--port-file", portFile, "--parent-pid", String(process.pid)];
	if (options.version) argv.push("--version", options.version);
	if (options.replaceArchive) argv.push("--replace-archive", options.replaceArchive);
	// run() spawns before its first await, owns the server's process group and reaps it if this process dies; abort ends it.
	const stopper = new AbortController();
	void run(argv, { deadline_s: fixtureDeadlineS(600), grace_s: 1, signal: stopper.signal, max_output_bytes: 1 << 16 }).catch(() => undefined);
	let port = "";
	for (let waited = 0; !/^[0-9]{1,5}\n$/.test(port); waited += 50) {
		if (waited > 10_000) { stopper.abort(); throw new Error("GITHUB_API_FIXTURE_NOT_LISTENING"); }
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		port = existsSync(portFile) ? readFileSync(portFile, "utf8") : "";
	}
	return { url: `http://127.0.0.1:${port.trim()}`, stop() { stopper.abort(); rmSync(portFile, { force: true }); } };
}

// `bun tests/cli/github-api-fixture.ts --serve --port-file F [--parent-pid N] [--version V] [--replace-archive FILE]`: the
// shell-test form. The server writes its port once it listens and exits when its parent process (by default the shell
// that started it, by the kernel's own ppid: a shell's `$$` can be virtual) is gone, so a failed test never leaks it.
if (import.meta.main) {
	const argv = process.argv.slice(2);
	const flag = (name: string) => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
	const portFile = flag("--port-file"), parent = flag("--parent-pid") === undefined ? process.ppid : Number(flag("--parent-pid"));
	if (!argv.includes("--serve") || !portFile || !Number.isInteger(parent) || parent < 2) {
		console.error("usage: github-api-fixture.ts --serve --port-file FILE [--parent-pid PID] [--version V] [--replace-archive FILE]");
		process.exit(2);
	}
	const api = startGithubApi({ version: flag("--version") });
	const replace = flag("--replace-archive");
	if (replace) api.onSourceLookup = () => writeFileSync(replace, "substituted original archive");
	writeFileSync(portFile, `${new URL(api.url).port}\n`);
	setInterval(() => {
		try { process.kill(parent, 0); } catch { api.stop(); process.exit(0); }
	}, 500);
}
