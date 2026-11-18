import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

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
	const recorder = await startRecorder();
	const host = `http://127.0.0.1:${recorder.port}`;
	try {
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
		recorder.stop();
	}
}, 300_000);
