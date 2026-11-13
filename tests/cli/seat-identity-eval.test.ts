import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paneKeyForEnv, seatNameForPaneKey } from "../../src/land.ts";
import { resolvePaneForSessionFileSync, resolveSeatNameFromSessionFileSync } from "../../src/seat-from-session.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();

const dirHandles: Array<{ path: string; cleanup(): void }> = [];
function scratch(label: string): string {
	const dir = ownedTmp(label);
	dirHandles.push(dir);
	return dir.path;
}

/** A HOME whose identity tree holds {"<hash>/tern-<pane>": body} fixture files. */
function fixtureHome(files: Record<string, string>): string {
	const home = scratch("seat-eval-home");
	for (const [rel, body] of Object.entries(files)) {
		const path = join(home, ".config", "agent-mail", "identity", rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, body);
	}
	return home;
}

/** A fake omp session file; its real path is what the Tern stub reports. */
function fixtureSession(): string {
	const path = join(scratch("seat-eval-session"), "omp-session.jsonl");
	writeFileSync(path, '{"type":"session","id":"eval-seat-session"}\n');
	return path;
}

function ternInspect(panes: Array<{ pane: string; sessionFile: string | null }>): string {
	return JSON.stringify({
		sessions: [{ id: "11", name: "eval", tabs: [{ id: "22", name: "t", blocks: panes.map((row) => ({ id: row.pane })) }] }],
		panes: panes.map((row) => ({
			pane: row.pane, cwd: "/repo", working: false, exited: null,
			...(row.sessionFile === null ? {} : { omp_session_file: row.sessionFile }),
		})),
	});
}

/** Stub io answering `tern inspect --json` with one canned snapshot. */
function stubIo(snapshot: string) {
	return { run: (_argv: string[]) => ({ code: 0, out: snapshot }) };
}

function refusalCode(value: { key: string } | { refusal: { errors?: Array<{ code?: string }> } }): string | null {
	return "refusal" in value ? (value.refusal.errors?.[0]?.code ?? null) : null;
}

test("EVALIDENTITY1: eval-shaped env resolves the one pane running PI_SESSION_FILE", () => {
	const session = fixtureSession();
	const home = fixtureHome({ "aaa/tern-7": '{"name":"OrangeRiver"}' });
	const env = { PI_SESSION_FILE: session };
	const io = stubIo(ternInspect([
		{ pane: "7", sessionFile: session },
		{ pane: "9", sessionFile: "/other/seat.jsonl" },
	]));
	expect(resolvePaneForSessionFileSync({ env, io })).toBe("7");
	expect(resolveSeatNameFromSessionFileSync({ env, io, home })).toEqual({ pane: "7", name: "OrangeRiver" });
	// land's owner lookup: the same env no longer refuses OWNER_UNKNOWN.
	const selected = paneKeyForEnv(env, { io });
	expect("key" in selected && selected.key).toBe("tern:7");
	expect(seatNameForPaneKey("tern:7", home)).toBe("OrangeRiver");
});

test("EVALIDENTITY1 planted: two panes on one session file keep OWNER_UNKNOWN", () => {
	const session = fixtureSession();
	const home = fixtureHome({ "aaa/tern-7": '{"name":"OrangeRiver"}', "aaa/tern-9": '{"name":"JadeHorizon"}' });
	const env = { PI_SESSION_FILE: session };
	const io = stubIo(ternInspect([
		{ pane: "7", sessionFile: session },
		{ pane: "9", sessionFile: session },
	]));
	expect(resolvePaneForSessionFileSync({ env, io })).toBeNull();
	expect(resolveSeatNameFromSessionFileSync({ env, io, home })).toBeNull();
	expect(refusalCode(paneKeyForEnv(env, { io }))).toBe("OWNER_UNKNOWN");
});

test("EVALIDENTITY1 planted: no matching pane keeps OWNER_UNKNOWN", () => {
	const session = fixtureSession();
	const env = { PI_SESSION_FILE: session };
	const io = stubIo(ternInspect([{ pane: "7", sessionFile: "/other/seat.jsonl" }]));
	expect(resolvePaneForSessionFileSync({ env, io })).toBeNull();
	expect(refusalCode(paneKeyForEnv(env, { io }))).toBe("OWNER_UNKNOWN");
	// No session file at all resolves nothing either.
	expect(resolvePaneForSessionFileSync({ env: {}, io })).toBeNull();
	expect(refusalCode(paneKeyForEnv({}, { io }))).toBe("OWNER_UNKNOWN");
});

/** Run the real br shim under an eval-shaped env; the stub br records its argv. */
async function shimArgv(options: { session: string | null; panes: Array<{ pane: string; sessionFile: string | null }>; identity: Record<string, string> }) {
	const dir = scratch("seat-eval-shim");
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const home = fixtureHome(options.identity);
	const argvLog = join(dir, "br-argv");
	const inspectJson = ternInspect(options.panes);
	writeFileSync(join(bin, "tern"), `#!/bin/sh\nprintf '%s' "$TERN_INSPECT_JSON"\n`, { mode: 0o755 });
	writeFileSync(join(bin, "br"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, { mode: 0o755 });
	const denied = runFixtureAsync(["sh", join(root, "scripts/br-shim.sh"), "list", "--status", "all"], {
		cwd: dir,
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: home,
			TERN_INSPECT_JSON: inspectJson,
			...(options.session === null ? {} : { PI_SESSION_FILE: options.session }),
		},
		floor_s: 30,
		label: "seat-eval-br-shim",
	});
	return { result: await denied, argvLog };
}

test("EVALIDENTITY1: the br shim resolves the eval seat and acts as its name", async () => {
	const session = fixtureSession();
	const { result, argvLog } = await shimArgv({
		session,
		panes: [
			{ pane: "7", sessionFile: session },
			{ pane: "9", sessionFile: "/other/seat.jsonl" },
		],
		identity: { "aaa/tern-7": '{"name":"OrangeRiver"}' },
	});
	expect(result.timed_out).toBe(false);
	expect(result.rc).toBe(0);
	const argv = (await Bun.file(argvLog).text()).trim().split("\n");
	expect(argv).toContain("--actor");
	expect(argv[argv.indexOf("--actor") + 1]).toBe("OrangeRiver");
});

test("EVALIDENTITY1 planted: the br shim keeps BR_SHIM_IDENTITY_REQUIRED without a unique pane", async () => {
	const session = fixtureSession();
	for (const panes of [
		[{ pane: "7", sessionFile: "/other/seat.jsonl" }],
		[
			{ pane: "7", sessionFile: session },
			{ pane: "9", sessionFile: session },
		],
	]) {
		const { result } = await shimArgv({
			session,
			panes,
			identity: { "aaa/tern-7": '{"name":"OrangeRiver"}', "aaa/tern-9": '{"name":"JadeHorizon"}' },
		});
		expect(result.timed_out).toBe(false);
		expect(result.rc).toBe(4);
		expect(decoder.decode(result.stderr)).toContain("BR_SHIM_IDENTITY_REQUIRED");
	}
});
