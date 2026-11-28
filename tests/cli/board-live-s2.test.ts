import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultMailBackend, inspectMailBackend } from "../../src/diagnostics.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import type { OwnedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

// BOARDLIVE1-S2 (ompkit-tnqyr.1): seats post and read on the Board as themselves.
const ROOT = resolve(import.meta.dir, "..", "..");
const SPAWN_ENV = join(ROOT, "scripts", "agent-spawn-env.sh");
const SEAT = "PeachLeopard";
const TOKEN = "fixture-only";

const owned: OwnedTmp[] = [];
afterEach(() => { for (const tmp of owned.splice(0)) tmp.cleanup(); });
function scratch(label: string): string {
	const tmp = ownedTmp(label);
	owned.push(tmp);
	return tmp.path;
}

/** The launcher's Board projection for a seat, as the env a launched seat would carry. */
function launchEnv(dir: string, backend: string | undefined, agent = SEAT, extra: Record<string, string> = {}) {
	const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: dir, FLEET_MAIL_BACKEND: backend, ...extra };
	const result = runFixture(["sh", SPAWN_ENV, "--agent", agent, "--board-env"], { cwd: dir, env, label: "agent-spawn-env --board-env" });
	const carried: Record<string, string> = {};
	for (const line of Buffer.from(result.stdout).toString("utf8").split("\n")) {
		const match = /^export ([A-Z_]+)=(.*)$/.exec(line);
		if (match) carried[match[1]!] = match[2]!;
	}
	return { rc: result.rc, env: carried, stderr: Buffer.from(result.stderr).toString("utf8") };
}

/** A stand-in Board CLI that answers whoami as whatever BOARD_PROFILE it was launched with. */
function fakeBoardCli(dir: string): string {
	const path = join(dir, "vb");
	writeFileSync(path, '#!/bin/sh\n[ "$BOARD_TOKEN" = "fixture-only" ] && [ "$BOARD_URL" = "http://127.0.0.1:4178/api/board" ] || exit 1\nif [ -z "${BOARD_PROFILE:-}" ]; then printf \'{"profile":null}\\n\'; exit 0; fi\nprintf \'{"actor":"x+%s","profile":"%s"}\\n\' "$BOARD_PROFILE" "$BOARD_PROFILE"\n');
	chmodSync(path, 0o755);
	return path;
}

test("BOARDLIVE-S2 launch env carries BOARD_URL and BOARD_PROFILE equal to the Agent Mail name", () => {
	const dir = scratch("boardlive-s2-env");
	const launched = launchEnv(dir, "board");
	expect(launched.rc).toBe(0);
	expect(launched.env).toEqual({ BOARD_URL: "http://127.0.0.1:4178/api/board", BOARD_PROFILE: SEAT });
});

test("BOARDLIVE-S2 backend unset or am changes nothing; unknown backend refuses", () => {
	const dir = scratch("boardlive-s2-off");
	for (const backend of [undefined, "", "am"]) {
		const launched = launchEnv(dir, backend);
		expect(launched.rc).toBe(0);
		expect(launched.env).toEqual({});
	}
	expect(launchEnv(dir, "mattermost").rc).toBe(4);
});

test("BOARDLIVE-S2 BOARD_URL comes from the fleet overlay [board] url; a bad name or url refuses", () => {
	const dir = scratch("boardlive-s2-url");
	const overlay = join(dir, "fleet.toml");
	writeFileSync(overlay, '[fleet]\nurl = "http://decoy.invalid"\n\n[board]\nurl = "http://127.0.0.1:4999/api/board"  # local\n');
	const launched = launchEnv(dir, "board", SEAT, { OMP_KIT_FLEET_CONFIG: overlay });
	expect(launched.env.BOARD_URL).toBe("http://127.0.0.1:4999/api/board");
	writeFileSync(overlay, '[board]\nurl = "not a url"\n');
	const bad = launchEnv(dir, "board", SEAT, { OMP_KIT_FLEET_CONFIG: overlay });
	expect(bad.rc).toBe(4);
	expect(bad.stderr).toContain("BOARD_URL_INVALID");
	const name = launchEnv(dir, "board", "bad name");
	expect(name.rc).toBe(4);
	expect(name.stderr).toContain("BOARD_PROFILE_INVALID");
});

test("BOARDLIVE-S2 doctor mail_backend is ok only when the Board answers as BOARD_PROFILE", () => {
	const dir = scratch("boardlive-s2-doctor");
	const vb = fakeBoardCli(dir);
	const carried = launchEnv(dir, "board").env;
	const env = { PATH: process.env.PATH, HOME: dir, FLEET_MAIL_BACKEND: "board", OMP_KIT_BOARD_CLI: vb, BOARD_TOKEN: TOKEN, ...carried };
	const row = inspectMailBackend(defaultMailBackend(env));
	expect(row.status).toBe("OK");
	expect(row.evidence?.profile).toBe(SEAT);
});

test("BOARDLIVE1-S6 doctor checks the default Board, with AGENT_NAME as a profile fallback", () => {
	const dir = scratch("boardlive-s6-doctor");
	const vb = fakeBoardCli(dir);
	const env = { PATH: process.env.PATH, HOME: dir, AGENT_NAME: SEAT, BOARD_PROFILE: "", OMP_KIT_BOARD_CLI: vb };
	const missing = inspectMailBackend(defaultMailBackend(env));
	expect(missing.evidence).toMatchObject({ backend: "board", reason_code: "BOARD_URL_MISSING" });
	expect(missing.status).toBe("FAIL");
	const missingIdentity = inspectMailBackend(defaultMailBackend({ ...env, AGENT_NAME: "" }));
	expect(missingIdentity.evidence).toMatchObject({ backend: "board", reason_code: "BOARD_PROFILE_MISSING" });
	expect(missingIdentity.status).toBe("FAIL");
	const credentials = join(dir, ".local", "share", "omp-kit", "board-trial", "xdg", "board", "local");
	mkdirSync(credentials, { recursive: true });
	writeFileSync(join(credentials, "fixture.json"), JSON.stringify({ url: "http://127.0.0.1:4178/api/board", token: TOKEN }));
	const resolved = inspectMailBackend(defaultMailBackend(env));
	expect(resolved.status).toBe("OK");
	expect(resolved.evidence).toMatchObject({ backend: "board", profile: SEAT, proof: "BOARD_WHOAMI" });
});

test("BOARDLIVE1-S6 explicit am still has no Board dependency; unknown mail backends fail", () => {
	const am = inspectMailBackend(defaultMailBackend({ FLEET_MAIL_BACKEND: "am" }));
	expect(am.status).toBe("OK");
	expect(am.evidence).toMatchObject({ backend: "am", proof: "ENV_ONLY" });
	const unknown = inspectMailBackend(defaultMailBackend({ FLEET_MAIL_BACKEND: "mattermost" }));
	expect(unknown.status).toBe("FAIL");
	expect(unknown.evidence?.reason_code).toBe("MAIL_BACKEND_UNKNOWN");
});

test("BOARDLIVE-S2 PLANT: profile dropped from the launch env fails the doctor check with a named reason", () => {
	const dir = scratch("boardlive-s2-plant");
	const vb = fakeBoardCli(dir);
	const carried = launchEnv(dir, "board").env;
	delete carried.BOARD_PROFILE;
	const missing = inspectMailBackend(defaultMailBackend({ PATH: process.env.PATH, HOME: dir, FLEET_MAIL_BACKEND: "board", OMP_KIT_BOARD_CLI: vb, ...carried }));
	expect(missing.status).toBe("FAIL");
	expect(missing.evidence?.reason_code).toBe("BOARD_PROFILE_MISSING");
	expect(missing.reason).toContain("BOARD_PROFILE");
	// Wrong profile: the Board answers as someone else.
	const other = inspectMailBackend({ env: { HOME: dir, FLEET_MAIL_BACKEND: "board", BOARD_URL: "http://127.0.0.1:4178/api/board", BOARD_TOKEN: TOKEN, BOARD_PROFILE: SEAT }, whoami: () => ({ rc: 0, timedOut: false, stdout: '{"profile":"OtherSeat"}' }) });
	expect(other.evidence?.reason_code).toBe("BOARD_PROFILE_MISMATCH");
	// Unreachable Board, timeout, unstartable CLI, unparseable answer.
	const base = { HOME: dir, FLEET_MAIL_BACKEND: "board", BOARD_URL: "http://127.0.0.1:4178/api/board", BOARD_TOKEN: TOKEN, BOARD_PROFILE: SEAT };
	expect(inspectMailBackend({ env: base, whoami: () => ({ rc: 1, timedOut: false, stdout: "" }) }).evidence?.reason_code).toBe("BOARD_WHOAMI_FAILED");
	expect(inspectMailBackend({ env: base, whoami: () => ({ rc: null, timedOut: true, stdout: "" }) }).evidence?.reason_code).toBe("BOARD_WHOAMI_TIMEOUT");
	expect(inspectMailBackend({ env: base, whoami: () => ({ rc: null, timedOut: false, stdout: "" }) }).evidence?.reason_code).toBe("BOARD_CLI_UNAVAILABLE");
	expect(inspectMailBackend({ env: base, whoami: () => ({ rc: 0, timedOut: false, stdout: "nope" }) }).evidence?.reason_code).toBe("BOARD_WHOAMI_UNPARSEABLE");
	// Real default whoami against a missing CLI fails closed, not open.
	expect(inspectMailBackend(defaultMailBackend({ ...base, PATH: process.env.PATH, OMP_KIT_BOARD_CLI: join(dir, "absent") })).status).toBe("FAIL");
});

test.each([
	["env", "http://board.invalid/api/board"],
	["file", "http://board.invalid/api/board"],
	["env", "http://user:fixture@127.0.0.1/api/board"],
])("BOARDLOOP doctor refuses unsafe credentials from %s without invoking vb (%s)", (source, url) => {
	const home = scratch("boardlive-local-only");
	const vb = join(home, "vb");
	const invoked = join(home, "vb-called");
	writeFileSync(vb, '#!/bin/sh\nprintf invoked > "$HOME/vb-called"\nexit 1\n');
	chmodSync(vb, 0o755);
	const env = { PATH: process.env.PATH, HOME: home, AGENT_NAME: SEAT, OMP_KIT_BOARD_CLI: vb };
	if (source === "file") {
		const dir = join(home, ".config", "board", "local");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "fixture.json"), JSON.stringify({ url, token: TOKEN }));
	}
	const configured = source === "env" ? { ...env, BOARD_URL: url, BOARD_TOKEN: TOKEN } : env;
	const finding = inspectMailBackend(defaultMailBackend(configured));
	expect(existsSync(invoked)).toBe(false);
	expect(finding.status).toBe("FAIL");
	expect(finding.evidence?.reason_code).toBe("BOARD_URL_MISSING");
});

test("BOARDLOOP doctor guards the CLI sink even if credential discovery is bypassed", () => {
	const home = scratch("boardlive-cli-local-only");
	const vb = fakeBoardCli(home);
	const deps = defaultMailBackend({ PATH: process.env.PATH, HOME: home, OMP_KIT_BOARD_CLI: vb });
	expect(deps.whoami(SEAT, { url: "http://board.invalid/api/board", token: TOKEN })).toBeNull();
});
