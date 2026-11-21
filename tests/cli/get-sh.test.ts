// OUTSIDERONE1: installer/get.sh is the one command a newcomer runs. A loopback server stands in for github.com (the
// /releases/latest redirect, the release downloads) and raw.githubusercontent.com (the tag's installer files); the
// installer it hands over to is a recording stub, because install.py's own verification has its own tests
// (installer-bootstrap.test.ts). What is pinned here is what get.sh alone decides: which tag, which files, which refusals.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, type RunResult } from "../../src/kitlib/run";
import { ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const realGetSh = join(root, "installer/get.sh");
const decoder = new TextDecoder();

interface Scenario { tag: string; latest: "redirect" | "missing"; installExit: number; installPy: "ok" | "missing"; requests: string[] }
const state: Scenario = { tag: "v9.9.9", latest: "redirect", installExit: 0, installPy: "ok", requests: [] };
const server = Bun.serve({
	hostname: "127.0.0.1", port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		state.requests.push(`${request.method} ${path}`);
		if (path === "/releases/latest")
			return state.latest === "missing" ? new Response("no release", { status: 404 }) : new Response(null, { status: 302, headers: { location: `/releases/tag/${state.tag}` } });
		if (path.startsWith("/releases/tag/")) return new Response("release page");
		const raw = /^\/raw\/([^/]+)\/installer\/(install\.sh|install\.py)$/.exec(path);
		if (!raw) return new Response("not found", { status: 404 });
		if (raw[2] === "install.py") return state.installPy === "ok" ? new Response("# stub\n") : new Response("not found", { status: 404 });
		return new Response(`#!/bin/sh\nprintf '%s\\n' "$*" > "$GETSH_ARGS_LOG"\nexit ${state.installExit}\n`);
	},
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

interface Outcome { rc: number | null; stderr: string; requests: string[]; args: string | null; leftover: string[] }
async function runGet(script: string, scenario: Partial<Scenario> = {}, env: Record<string, string> = {}, args: string[] = []): Promise<Outcome> {
	Object.assign(state, { tag: "v9.9.9", latest: "redirect", installExit: 0, installPy: "ok", requests: [] }, scenario);
	const scratch = ownedTmp("get-sh");
	try {
		const work = realpathSync(scratch.path);
		for (const dir of ["home", "tmp"]) mkdirSync(join(work, dir), { mode: 0o700 });
		const log = join(work, "args.log");
		const result: RunResult = await run(["/bin/sh", script, ...args], {
			cwd: work, deadline_s: fixtureDeadlineS(20), grace_s: 1, max_output_bytes: 1 << 20,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(work, "home"), TMPDIR: join(work, "tmp"), GETSH_ARGS_LOG: log,
				KIT_RELEASES_URL: `${base}/releases`, KIT_RAW_URL: `${base}/raw`, ...env },
		});
		expect(result.timed_out, decoder.decode(result.stderr)).toBe(false);
		return { rc: result.rc, stderr: decoder.decode(result.stderr), requests: [...state.requests], args: existsSync(log) ? readFileSync(log, "utf8").trim() : null, leftover: readdirSync(join(work, "tmp")) };
	} finally { scratch.cleanup(); }
}
const rawRequests = (o: Outcome) => o.requests.filter(r => r.includes("/raw/"));

test("OUTSIDERONE1: resolves the newest tag, fetches THAT TAG's installer (never main's) and hands over", async () => {
	const o = await runGet(realGetSh);
	expect(o.rc, o.stderr).toBe(0);
	expect(o.args).toMatch(new RegExp(`^--version 9\\.9\\.9 --index ${base}/releases/download/v9\\.9\\.9/release-index\\.json --prefix \\S+/home/\\.local/opt/omp-kit$`));
	expect(rawRequests(o)).toEqual(["GET /raw/v9.9.9/installer/install.sh", "GET /raw/v9.9.9/installer/install.py"]);
	expect(o.requests.some(r => r.includes("/main/"))).toBe(false);
	expect(o.stderr).toContain("installing omp-kit 9.9.9");
	expect(o.stderr).toMatch(/installed\. Add it to your PATH: export PATH="\S+\/home\/\.local\/opt\/omp-kit\/bin:\$PATH"/);
	expect(o.leftover).toEqual([]);
});

test("OUTSIDERONE1: KIT_PREFIX chooses the prefix; the installer, not get.sh, enforces that it is absolute", async () => {
	const o = await runGet(realGetSh, {}, { KIT_PREFIX: "/opt/somewhere" });
	expect(o.rc, o.stderr).toBe(0);
	expect(o.args).toEndWith("--prefix /opt/somewhere");
});

test("OUTSIDERONE1: an unresolvable latest release fails closed before any installer file is fetched", async () => {
	const o = await runGet(realGetSh, { latest: "missing" });
	expect(o.rc).toBe(1);
	expect(o.stderr).toContain("could not resolve the latest omp-kit release");
	expect(o.stderr).toContain("nothing was installed");
	expect(rawRequests(o)).toEqual([]);
	expect(o.args).toBeNull();
});

for (const tag of ["nightly", "v1.2.3-rc.1", "v1.2", "v1.2.3.4", "v1..2.3", "v1.2.3.", "v1.2.3%0Aevil"]) {
	test(`OUTSIDERONE1: the tag ${tag} is not a plain vX.Y.Z release: refused before any fetch`, async () => {
		const o = await runGet(realGetSh, { tag });
		expect(o.rc).toBe(1);
		expect(o.stderr).toContain("not a plain vX.Y.Z version");
		expect(rawRequests(o)).toEqual([]);
		expect(o.args).toBeNull();
	});
}

test("OUTSIDERONE1: a failing installer propagates its status, prints no PATH advice and leaves no temp files", async () => {
	const o = await runGet(realGetSh, { installExit: 3 });
	expect(o.rc).toBe(3);
	expect(o.args).not.toBeNull();
	expect(o.stderr).not.toContain("Add it to your PATH");
	expect(o.leftover).toEqual([]);
});

test("OUTSIDERONE1: a missing install.py stops before install.sh runs", async () => {
	const o = await runGet(realGetSh, { installPy: "missing" });
	expect(o.rc).toBe(1);
	expect(o.stderr).toContain("could not fetch install.py at v9.9.9");
	expect(o.args).toBeNull();
	expect(o.leftover).toEqual([]);
});

for (const [name, env] of [
	["a plain-HTTP raw override", { KIT_RAW_URL: "http://example.invalid/raw" }],
	["a plain-HTTP releases override", { KIT_RELEASES_URL: "http://10.0.0.1/releases" }],
] as const) {
	test(`OUTSIDERONE1: ${name} that is not loopback is refused with no request`, async () => {
		const o = await runGet(realGetSh, {}, env);
		expect(o.rc).toBe(1);
		expect(o.stderr).toContain("neither HTTPS nor loopback");
		expect(o.requests).toEqual([]);
	});
}

test("OUTSIDERONE1: get.sh takes no arguments", async () => {
	const o = await runGet(realGetSh, {}, {}, ["--dry-run"]);
	expect(o.rc).toBe(2);
	expect(o.stderr).toContain("takes no arguments");
	expect(o.requests).toEqual([]);
});

test("OUTSIDERONE1 mutants: with the tag check or the override check removed the refusals above are not produced", async () => {
	const source = readFileSync(realGetSh, "utf8");
	const scratch = ownedTmp("get-sh-mutants");
	try {
		const dir = realpathSync(scratch.path);
		const tagMutant = join(dir, "no-tag-check.sh");
		const noTagCheck = source.replace('badtag() { die "the latest release tag is not a plain vX.Y.Z version: $tag"; }', "badtag() { :; }");
		expect(noTagCheck).not.toBe(source);
		writeFileSync(tagMutant, noTagCheck, { mode: 0o700 });
		const tag = await runGet(tagMutant, { tag: "nightly" });
		expect(tag.rc, tag.stderr).toBe(0);
		expect(rawRequests(tag).length).toBe(2);

		const overrideMutant = join(dir, "no-override-check.sh");
		const noOverrideCheck = source.replace('    *) die "refusing an override that is neither HTTPS nor loopback: $url" ;;', "    *) ;;");
		expect(noOverrideCheck).not.toBe(source);
		writeFileSync(overrideMutant, noOverrideCheck, { mode: 0o700 });
		const override = await runGet(overrideMutant, {}, { KIT_RAW_URL: "http://example.invalid/raw" });
		expect(override.stderr).not.toContain("neither HTTPS nor loopback");
	} finally { scratch.cleanup(); }
});
