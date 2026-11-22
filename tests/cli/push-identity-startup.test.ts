// push-identity-startup.test.ts — PUSHIDENTITY1 (ompkit-fp72.135.3.75): the
// push hook resolves the pushing seat FIRST (before the gate) and fails fast
// with its remedy. Boxes [a][b] are proven here; [c][d] need owner-authorized
// live seats and stay untouched.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const checker = join(root, "scripts", "check-push-identity.sh");
const adapter = join(root, "scripts", "pre-push-gate.sh");
const decoder = new TextDecoder();

const BASE_ENV = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

function scratchEnv(scratch: string, home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { ...BASE_ENV, GIT_CEILING_DIRECTORIES: scratch, HOME: home, ...extra };
}

/** A HOME whose identity tree holds the given pane bindings. */
function fixtureHome(home: string, bindings: Record<string, Record<string, string>>): void {
	for (const [project, panes] of Object.entries(bindings)) {
		for (const [pane, body] of Object.entries(panes)) {
			const dir = join(home, ".config", "agent-mail", "identity", project);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `tern-${pane}`), body);
		}
	}
}

 /** A fixture push repo whose base archive carries the identity checker. */
 function pushFixture(scratch: string, env: Record<string, string | undefined>): { repo: string; base: string; tip: string } {
	const repo = join(scratch, "repo");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
	copyFileSync(checker, join(repo, "scripts", "check-push-identity.sh"));
	const git = (...argv: Array<string>) => {
		const res = runFixture(["git", ...argv], { cwd: repo, env });
		expect(res.rc).toBe(0);
		return decoder.decode(res.stdout).trim();
	};
	git("init", "-q", ".");
	git("config", "user.email", "test@invalid.example");
	git("config", "user.name", "Test");
	git("add", "scripts");
	git("commit", "-qm", "[test] base carries the identity checker");
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "data.txt"), "tip payload\n");
	git("add", "data.txt");
	git("commit", "-qm", "[test] pushed tip");
	const tip = git("rev-parse", "HEAD");
	return { repo, base, tip };
}

test("PUSHIDENTITY_FAST_REFUSAL: an unidentified push is refused before the gate with its remedy", async () => {
	const scratch = ownedTmp("pushid-fast-refusal", { bead: "ompkit-fp72.135.3.75" });
	try {
		// The checker needs no repo at all: refusal precedes every archive.
		const bare = await runFixtureAsync(["sh", checker], { cwd: scratch.path, env: { PATH: BASE_ENV.PATH } });
		expect(bare.rc).toBe(3);
		expect(decoder.decode(bare.stderr)).toContain("RED push-identity");
		expect(decoder.decode(bare.stderr)).toContain("AGENT_NAME");
		expect(decoder.decode(bare.stdout)).toBe("");

		// End to end: the adapter refuses before any judging stage runs.
		const env = scratchEnv(scratch.path, join(scratch.path, "home"));
		const { repo, base, tip } = pushFixture(scratch.path, env);
		const stdin = `refs/heads/main ${tip} refs/heads/main ${base}\n`;
		const res = await runFixtureAsync(["sh", adapter], { cwd: repo, env, stdin, floor_s: 120 });
		const out = decoder.decode(res.stdout) + decoder.decode(res.stderr);
		expect(res.rc).toBe(3);
		expect(out).toContain("RED push-identity");
		expect(out).toContain("AGENT_NAME");
		expect(out).not.toContain("gate-wiring");
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(120) * 1000);

test("PUSHIDENTITY_REGISTERED: a registered seat resolves and the gate admits the identity stage", async () => {
	const scratch = ownedTmp("pushid-registered", { bead: "ompkit-fp72.135.3.75" });
	try {
		// AGENT_NAME resolves directly.
		const agent = await runFixtureAsync(["sh", checker], {
			cwd: scratch.path,
			env: { PATH: BASE_ENV.PATH, AGENT_NAME: "PushSeat1" },
		});
		expect(agent.rc).toBe(0);
		expect(decoder.decode(agent.stdout)).toBe("seat=PushSeat1\n");

		// A single pane binding resolves when AGENT_NAME is absent.
		const home = join(scratch.path, "home");
		fixtureHome(home, { projA: { 7: '{"name":"PaneSeat7"}' } });
		const pane = await runFixtureAsync(["sh", checker], {
			cwd: scratch.path,
			env: { PATH: BASE_ENV.PATH, HOME: home, TERN_PANE: "7" },
		});
		expect(pane.rc).toBe(0);
		expect(decoder.decode(pane.stdout)).toBe("seat=PaneSeat7\n");

		// End to end: the identity stage greens and the gate proceeds past it.
		const env = scratchEnv(scratch.path, home, { AGENT_NAME: "GateSeat1" });
		const { repo, base, tip } = pushFixture(scratch.path, env);
		const stdin = `refs/heads/main ${tip} refs/heads/main ${base}\n`;
		const res = await runFixtureAsync(["sh", adapter], { cwd: repo, env, stdin, floor_s: 120 });
		const out = decoder.decode(res.stdout) + decoder.decode(res.stderr);
		expect(out).toContain("GREEN push-identity seat=GateSeat1");
		expect(out).toContain("SKIP gate-wiring");
		expect(res.rc).not.toBe(3);
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(120) * 1000);

test("PUSHIDENTITY planted: a malformed AGENT_NAME is refused naming the seat-name rule", async () => {
	const scratch = ownedTmp("pushid-malformed-agent", { bead: "ompkit-fp72.135.3.75" });
	try {
		const res = await runFixtureAsync(["sh", checker], {
			cwd: scratch.path,
			env: { PATH: BASE_ENV.PATH, AGENT_NAME: "bad name!" },
		});
		expect(res.rc).toBe(3);
		expect(decoder.decode(res.stderr)).toContain("not a seat name");
	} finally {
		scratch.cleanup();
	}
});

test("PUSHIDENTITY planted: two pane bindings refuse naming both seats", async () => {
	const scratch = ownedTmp("pushid-conflict", { bead: "ompkit-fp72.135.3.75" });
	try {
		const home = join(scratch.path, "home");
		fixtureHome(home, { projA: { 7: '{"name":"PaneSeat7"}' }, projB: { 7: "LegacySeat" } });
		const res = await runFixtureAsync(["sh", checker], {
			cwd: scratch.path,
			env: { PATH: BASE_ENV.PATH, HOME: home, TERN_PANE: "7" },
		});
		expect(res.rc).toBe(3);
		const err = decoder.decode(res.stderr);
		expect(err).toContain("PaneSeat7");
		expect(err).toContain("LegacySeat");
	} finally {
		scratch.cleanup();
	}
});

test("PUSHIDENTITY planted: a pane with no binding refuses naming the pane", async () => {
	const scratch = ownedTmp("pushid-no-binding", { bead: "ompkit-fp72.135.3.75" });
	try {
		const home = join(scratch.path, "home");
		fixtureHome(home, { projA: { 7: '{"name":"PaneSeat7"}' } });
		const res = await runFixtureAsync(["sh", checker], {
			cwd: scratch.path,
			env: { PATH: BASE_ENV.PATH, HOME: home, TERN_PANE: "9" },
		});
		expect(res.rc).toBe(3);
		expect(decoder.decode(res.stderr)).toContain("no identity file names tern-9");
	} finally {
		scratch.cleanup();
	}
});

 test("PUSHIDENTITY planted: the identity stage precedes gate-wiring in the adapter", () => {
 	const src = readFileSync(adapter, "utf8");
 	const identityAt = src.indexOf("== push-identity");
 	const judgingAt = src.indexOf('checker_contracts "$archive" candidate');
 	expect(identityAt).toBeGreaterThan(-1);
 	expect(judgingAt).toBeGreaterThan(-1);
 	expect(identityAt).toBeLessThan(judgingAt);
 	expect(identityAt).toBeLessThan(src.indexOf("gate-wiring.py --repo"));
 });
