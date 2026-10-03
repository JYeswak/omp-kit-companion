import { expect, test } from "bun:test";
import process from "node:process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

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
	const child = Bun.spawn(["sh", "scripts/e2e-live.sh"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ONLY: "canary-fire", OMP_KIT_TEST_NO_COVERAGE: "1", ...extraEnv },
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
		const mutant = await runE2e({ OLLAMA_HOST: host, OMP_KIT_TEST_NO_PROVIDER_PIN: "1" });
		expect(mutant.code).toBe(0);
		expect(recorder.requests.length).toBeGreaterThan(0);
		expect(recorder.requests.some(line => line.includes("/api/tags"))).toBe(true);
		recorder.requests.length = 0;
		const pinned = await runE2e({ OLLAMA_HOST: host });
		expect(pinned.code).toBe(0);
		expect(recorder.requests).toEqual([]);
	} finally {
		recorder.stop();
	}
}, 300_000);
