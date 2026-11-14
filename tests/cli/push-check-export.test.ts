import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
/** Narrowed readers for the push-check JSON envelope (overall lives under data, errors top-level). */
function overallOf(body: Record<string, unknown>): unknown {
	const data = body.data;
	if (data !== null && typeof data === "object" && "overall" in data) return data.overall;
	return undefined;
}
function firstErrorCode(body: Record<string, unknown>): unknown {
	const errors = body.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const first = errors[0];
	if (first !== null && typeof first === "object" && "code" in first) return first.code;
	return undefined;
}


async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<{ rc: number; out: string; err: string }> {
	const r = await run(cmd, { cwd, deadline_s: fixtureDeadlineS(60), env: { ...process.env, ...(env ?? {}) } as Record<string, string> });
	if (r.rc !== 0) throw new Error(`${cmd.join(" ")} -> rc ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return { rc: r.rc, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

async function makeRepo(label: string, files: Record<string, string>): Promise<string> {
	const dir = ownedTmp(label).path;
	mkdirSync(dir, { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, contents);
	}
	await sh(["git", "init", "-q", "-b", "main", "."], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "fixture [test]"], dir);
	return dir;
}

async function pushCheck(dir: string, sha: string, env?: Record<string, string>): Promise<{ rc: number; body: Record<string, unknown> }> {
	const r = await run(["bun", "run", "--silent", CLI, "push-check", "--commit", sha, "--repo", dir, "--json"],
		{ cwd: dir, deadline_s: fixtureDeadlineS(300), env: { ...process.env, ...(env ?? {}) } as Record<string, string> });
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(new TextDecoder().decode(r.stdout));
	} catch {
		throw new Error(`push-check emitted invalid JSON (rc ${r.rc}): ${new TextDecoder().decode(r.stdout)}\n${new TextDecoder().decode(r.stderr)}`);
	}
	return { rc: r.rc ?? 1, body };
}

describe("push-check stream export", () => {
	test("stream: an archive larger than the old 512MiB cap exports through the pipe and the check runs", async () => {
		const dir = ownedTmp("push-check-stream-big").path;
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "note.txt"), "small\n");
		// Sparse 600 MiB member: one byte at the end, no bulk write. git stores the zeros
		// compactly, but `git archive` streams the full inflated member through the pipe.
		const fd = openSync(join(dir, "big.bin"), "w");
		writeSync(fd, Buffer.from([0]), 0, 1, 600 * 1024 * 1024 - 1);
		closeSync(fd);
		const check = join(dir, ".omp", "push-check");
		mkdirSync(join(dir, ".omp"), { recursive: true });
		writeFileSync(check, "#!/bin/sh\nset -eu\ntest -f big.bin\nexit 0\n");
		chmodSync(check, 0o755);
		await sh(["git", "init", "-q", "-b", "main", "."], dir);
		await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
		await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "fixture [test]"], dir);
		const sha = (await sh(["git", "rev-parse", "HEAD"], dir)).out.trim();
		const res = await pushCheck(dir, sha);
		expect(overallOf(res.body)).toBe("PASS");
		expect(res.rc).toBe(0);
	}, fixtureDeadlineS(300) * 1000);

	test("stream: a corrupt tar refuses export instead of passing", async () => {
		const dir = await makeRepo("push-check-stream-corrupt", {
			"note.txt": "small\n",
			".omp/push-check": "#!/bin/sh\nset -eu\nexit 0\n",
		});
	chmodSync(join(dir, ".omp", "push-check"), 0o755);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "note.txt", ".omp/push-check"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "check [test]"], dir);
	const sha = (await sh(["git", "rev-parse", "HEAD"], dir)).out.trim();
		const bin = join(dir, "fakebin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "tar"), "#!/bin/sh\necho 'planted: tar is broken' >&2\nexit 1\n");
		chmodSync(join(bin, "tar"), 0o755);
		const res = await pushCheck(dir, sha, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
		expect(overallOf(res.body)).toBe("UNRUN");
		expect(firstErrorCode(res.body)).toBe("PUSH_CHECK_EXPORT_UNAVAILABLE");
	});

	test("stream: producer failing after a valid tar still refuses without running the check", async () => {
		const dir = await makeRepo("push-check-stream-producer-fail", {
			"note.txt": "small\n",
			".omp/push-check": "#!/bin/sh\nset -eu\nexit 0\n",
		});
		chmodSync(join(dir, ".omp", "push-check"), 0o755);
		await sh(["git", "add", "note.txt", ".omp/push-check"], dir);
		await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "check [test]"], dir);
		const sha = (await sh(["git", "rev-parse", "HEAD"], dir)).out.trim();
		const realGit = (await sh(["sh", "-c", "command -v git"], dir)).out.trim();
		const bin = join(dir, "fakebin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "git"), "#!/bin/sh\nfor a in \"$@\"; do\n  if [ \"$a\" = archive ]; then\n    \"$REAL_GIT\" \"$@\"\n    exit 1\n  fi\ndone\nexec \"$REAL_GIT\" \"$@\"\n");
		chmodSync(join(bin, "git"), 0o755);
		const res = await pushCheck(dir, sha, { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, REAL_GIT: realGit });
		expect(overallOf(res.body)).toBe("UNRUN");
		expect(firstErrorCode(res.body)).toBe("PUSH_CHECK_EXPORT_UNAVAILABLE");
	});
});
