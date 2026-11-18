import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
afterAll(() => cleanupAllOwnedTmp());

// Integration test: exercises real OMP provider discovery against a
// recording listener on the platform clock. Fake timers cannot work: the
// connections come from a live subprocess, not in-process timers.

interface Recorder {
	port: number;
	requests: string[];
	stop(): void;
}

/** Real-listener Ollama stand-in: accepts every connection, answers model
 * listing with an empty set (a hanging or 404-only listener stalls OMP),
 * and logs request lines. Closes each connection so nothing is held. */
async function startRecorder(): Promise<Recorder> {
	const requests: string[] = [];
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, data) {
				const first = Buffer.from(data).toString("utf8").split("\r\n")[0] ?? "";
				requests.push(first);
				const known = first.includes("/api/tags") || first.includes("/api/version");
				const body = known ? JSON.stringify({ models: [] }) : "{}";
				const status = known ? "200 OK" : "404 Not Found";
				socket.write(`HTTP/1.1 ${status}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
				socket.end();
			},
			error() {},
		},
	});
	return { port: server.port, requests, stop: () => server.stop() };
}

async function runE2e(extraEnv: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
	const nativeOmp = process.env.OMP || Bun.which("omp");
	if (!nativeOmp) throw new Error("real OMP is required for provider isolation");
	const work = ownedTmp("e2e-provider-discovery", { root: process.env.TMPDIR, bead: "ompkit-upgradeloop-qum98.10" });
	const launcher = join(work.path, "omp");
	// Startup discovery is fire-and-forget. Explicit listing awaits the real
	// registry under the E2E child's own HOME and disabledProviders policy.
	writeFileSync(launcher, `#!/bin/sh
for arg do
  case "$arg" in
    -p|--print)
      "$OMP_KIT_PROVIDER_NATIVE" models ls ollama --json --no-extensions || exit "$?"
      break
      ;;
  esac
done
exec "$OMP_KIT_PROVIDER_NATIVE" "$@"
`, { mode: 0o755 });
	const child = Bun.spawn(["sh", "scripts/e2e-live.sh"], {
		cwd: REPO_ROOT,
		// Machine-readable scenario IDs must survive a caller forcing ANSI color.
		env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: "1", ONLY: "unsafe-router-fire", OMP_KIT_TEST_NO_COVERAGE: "1",
			OMP: launcher, OMP_KIT_PROVIDER_NATIVE: nativeOmp, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text().then(() => ""),
	]);
	return { code, stderr };
}

test("unpinned OMP probes OLLAMA_HOST; the e2e pin silences it", async () => {
	const dotGit = join(REPO_ROOT, ".git");
	let gitDir: string | null = null;
	if (!existsSync(dotGit)) {
		// Match the fresh/full suite's contributor checkout setup, but only for
		// the native verifier's disposable source export, never an installed kit.
		const parent = process.env.GRADE_WAVE_SCRATCH;
		if (!parent || realpathSync(REPO_ROOT) !== join(realpathSync(parent), "export") ||
			!readFileSync(join(parent, ".owner"), "utf8").split("\n").includes("label=verify")) {
			throw new Error("provider isolation needs a checkout or an owned native verify export");
		}
		const scratch = ownedTmp("e2e-provider-git", { root: parent, bead: "ompkit-upgradeloop-qum98.10" });
		const privateGit = join(realpathSync(scratch.path), "git");
		const env = Object.fromEntries(Object.entries(process.env)
			.filter((entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined));
		const result = await run(["git", "init", "--quiet", "--template=", "--separate-git-dir", privateGit], {
			cwd: REPO_ROOT, env, deadline_s: fixtureDeadlineS(30),
		});
		if (result.rc !== 0) throw new Error(`provider isolation fixture git init: ${new TextDecoder().decode(result.stderr)}`);
		gitDir = privateGit;
	}
	let recorder: Recorder | undefined;
	try {
		recorder = await startRecorder();
		const host = `http://127.0.0.1:${recorder.port}`;
		const endpoints = { OLLAMA_HOST: host, OLLAMA_BASE_URL: host, LLAMA_CPP_BASE_URL: host, LM_STUDIO_BASE_URL: `${host}/v1` };
		const mutant = await runE2e({ ...endpoints, OMP_KIT_TEST_NO_PROVIDER_PIN: "1" });
		expect(mutant.code, mutant.stderr).toBe(0);
		expect(recorder.requests.length).toBeGreaterThan(0);
		expect(recorder.requests.some(line => line.includes("/api/tags"))).toBe(true);
		recorder.requests.length = 0;
		const pinned = await runE2e(endpoints);
		expect(pinned.code, pinned.stderr).toBe(0);
		expect(recorder.requests).toEqual([]);
	} finally {
		recorder?.stop();
		if (gitDir !== null) {
			if (readFileSync(dotGit, "utf8") !== `gitdir: ${gitDir}\n`) throw new Error("provider isolation fixture Git pointer changed");
			unlinkSync(dotGit);
		}
	}
}, 300_000);
