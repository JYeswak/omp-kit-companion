import { expect, test } from "bun:test";
import kitUpgradeNotice, {
	compareSemver,
	installedRelease,
	loadedRelease,
	sessionKey,
	upgradeGap,
	SELF_RESTART_COMMAND,
	SELF_RESTART_SCRIPT,
	upgradeNoticeMessage,
	type UpgradeNoticeApi,
	type UpgradeNoticeContext,
	type UpgradeNoticeDeps,
	UPGRADE_NOTICE,
} from "./kit-upgrade-notice.ts";

const LOADED = "/Users/josh/.local/opt/omp-kit/releases/0.2.57/extensions/kit-upgrade-notice.ts";
const INSTALLED_58 = "../releases/0.2.58/bin/omp-kit";
const INSTALLED_57 = "../releases/0.2.57/bin/omp-kit";

type Sent = { content: string; deliverAs: string | undefined };

function fakePi(ctx: UpgradeNoticeContext): { api: UpgradeNoticeApi; sent: Sent[]; handlers: Record<string, (e: unknown, c: UpgradeNoticeContext) => unknown> } {
	const sent: Sent[] = [];
	const handlers: Record<string, (e: unknown, c: UpgradeNoticeContext) => unknown> = {};
	return {
		sent,
		handlers,
		api: {
			on: (event: string, handler: (e: unknown, c: UpgradeNoticeContext) => unknown) => {
				handlers[event] = handler;
			},
			sendMessage: (message, options) => {
				sent.push({ content: message.content, deliverAs: options?.deliverAs });
			},
		} as UpgradeNoticeApi,
	};
}

function files(initial: Record<string, string> = {}): {
	deps: Pick<UpgradeNoticeDeps, "readFile" | "writeFile" | "readlink" | "isTTY">;
	store: Record<string, string>;
	writes: string[];
} {
	const store: Record<string, string> = { ...initial };
	const writes: string[] = [];
	return {
		store,
		writes,
		deps: {
			isTTY: true,
			readlink: () => INSTALLED_58,
			readFile: (path) => store[path],
			writeFile: (path, content) => {
				writes.push(path);
				store[path] = content;
			},
		},
	};
}

const IDLE: UpgradeNoticeContext = { sessionManager: { getSessionId: () => "seat-1" }, isIdle: () => true };
const BUSY: UpgradeNoticeContext = { sessionManager: { getSessionId: () => "seat-1" }, isIdle: () => false };

test("behind: installed newer than loaded reads a gap with both versions", () => {
	expect(upgradeGap("0.2.57", "0.2.58")).toEqual({ installed: "0.2.58", loaded: "0.2.57" });
});

test("planted (a): an up-to-date seat reads no gap", () => {
	expect(upgradeGap("0.2.57", "0.2.57")).toBeNull();
});

test("planted (b): a seat ahead of the install (rollback) reads no gap", () => {
	expect(upgradeGap("0.2.58", "0.2.57")).toBeNull();
});

test("planted (c): unknown either side reads no gap, never a notice", () => {
	expect(upgradeGap(null, "0.2.58")).toBeNull();
	expect(upgradeGap("0.2.57", null)).toBeNull();
});

test("loaded: installed extension path parses; checkout and junk paths read null", () => {
	expect(loadedRelease(LOADED)).toBe("0.2.57");
	expect(loadedRelease("/Users/josh/Developer/omp-kit-companion/extensions/kit-upgrade-notice.ts")).toBeNull();
	expect(loadedRelease("/x/releases/nightly/extensions/kit-upgrade-notice.ts")).toBeNull();
	expect(loadedRelease(undefined)).toBeNull();
	expect(loadedRelease("")).toBeNull();
});

test("installed: exact kit symlink target parses; anything else reads null", () => {
	expect(installedRelease(INSTALLED_58)).toBe("0.2.58");
	expect(installedRelease("../releases/0.2.58/bin/omp-kit ")).toBeNull();
	expect(installedRelease("/usr/local/bin/omp-kit")).toBeNull();
	expect(installedRelease("../releases/0.2.58/bin/omp-kit-extra")).toBeNull();
});

test("semver: numeric comparison (0.2.7 < 0.2.55 < 0.2.57); lexicographic order would lie", () => {
	expect(compareSemver("0.2.7", "0.2.55") < 0).toBe(true);
	expect(compareSemver("0.2.55", "0.2.57") < 0).toBe(true);
	expect(compareSemver("0.2.57", "0.2.57")).toBe(0);
	expect(upgradeGap("0.2.7", "0.2.55")).toEqual({ installed: "0.2.55", loaded: "0.2.7" });
});

test("message (fleet): the three self-restart steps in order, each with its exact command", () => {
	const msg = upgradeNoticeMessage("0.2.58", "0.2.57", true);
	expect(msg).toContain("omp-kit 0.2.58 is installed; this seat runs 0.2.57; upgrade now");
	const save = msg.indexOf("1. Save your work: `git commit --only");
	const run = msg.indexOf("2. Run the self-restart helper: `python3 ~/.claude/skills/omp-kit-orchestration/scripts/self_restart.py`");
	const end = msg.indexOf("3. End your turn now with no further tool call.");
	expect(save).toBeGreaterThan(-1);
	expect(run).toBeGreaterThan(save);
	expect(end).toBeGreaterThan(run);
	expect(SELF_RESTART_COMMAND).toBe("python3 ~/.claude/skills/omp-kit-orchestration/scripts/self_restart.py");
	expect(msg).toContain("`[pending]` commit");
	expect(msg).toContain("The helper pauses your goal (Esc), reloads this seat on omp-kit 0.2.58 and resumes your goal.");
	// Retired steps: no seat waits on the chief's sentinel, and no hand-written handoff ledger.
	expect(msg).not.toContain("loop_sentinel");
	expect(msg).not.toContain("handoff");
});

test("message (stock): only how to restart omp; no fleet command, sentinel or handoff", () => {
	const msg = upgradeNoticeMessage("0.2.58", "0.2.57");
	expect(msg).toBe(
		"kit-upgrade-notice UPGRADE_NOTICE: omp-kit 0.2.58 is installed; this seat runs 0.2.57; upgrade now.\n" +
			"To load the new release, restart omp: save your work, exit omp, then start it again with `omp --resume` " +
			"to continue this session on 0.2.58.",
	);
	for (const fleetOnly of ["self_restart", "respawn_seat", "loop_sentinel", "handoff", "git commit --only"]) {
		expect(msg).not.toContain(fleetOnly);
	}
});

test("mode: the installed self-restart helper under home selects fleet text; its absence selects stock", async () => {
	for (const installed of [true, false]) {
		const f = files();
		const probed: string[] = [];
		const { api, sent, handlers } = fakePi(IDLE);
		await kitUpgradeNotice(api, {
			selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps,
			isFile: (path) => { probed.push(path); return installed; },
		});
		handlers["session_start"]!(null, IDLE);
		expect(probed).toEqual([`/h/${SELF_RESTART_SCRIPT}`]);
		expect(sent.length).toBe(1);
		expect(sent[0]!.content).toBe(upgradeNoticeMessage("0.2.58", "0.2.57", installed));
		expect(sent[0]!.content.includes(SELF_RESTART_COMMAND)).toBe(installed);
	}
});

test("regex: a 1 MiB non-matching path completes without hanging", () => {
	const big = `/x/releases/${"9".repeat(1024 * 1024)}/extensions/kit-upgrade-notice.ts`;
	expect(loadedRelease(big)).toBeNull();
	expect(installedRelease(`../releases/${"8".repeat(1024 * 1024)}/bin/omp-kit`)).toBeNull();
});

test("live: a behind seat gets exactly one notice per release, idle nextTurn, busy aside", async () => {
	const f = files();
	const { api, sent, handlers } = fakePi(IDLE);
	await kitUpgradeNotice(api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	handlers["session_start"]!(null, IDLE);
	expect(sent.length).toBe(1);
	expect(sent[0]!.content).toContain("0.2.58 is installed; this seat runs 0.2.57");
	expect(sent[0]!.deliverAs).toBe("nextTurn");
	handlers["tool_execution_end"]!(null, BUSY);
	handlers["tool_execution_end"]!(null, IDLE);
	expect(sent.length).toBe(1);
	expect(f.writes.length).toBe(1);
});

test("planted (d): busy delivery goes aside, idle goes nextTurn", async () => {
	const f = files();
	const { api, sent, handlers } = fakePi(BUSY);
	await kitUpgradeNotice(api, { selfPath: LOADED, session: "seat-9", home: "/h", ...f.deps });
	handlers["session_start"]!(null, BUSY);
	expect(sent.length).toBe(1);
	expect(sent[0]!.deliverAs).toBe("aside");
});

test("planted (e): an up-to-date seat gets none on either event", async () => {
	const f = files();
	f.deps.readlink = () => INSTALLED_57;
	const { api, sent, handlers } = fakePi(IDLE);
	await kitUpgradeNotice(api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	handlers["session_start"]!(null, IDLE);
	handlers["tool_execution_end"]!(null, IDLE);
	expect(sent).toEqual([]);
	expect(f.writes).toEqual([]);
});

test("planted (f): a newer release re-notices once; the old release never repeats", async () => {
	const f = files();
	const first = fakePi(IDLE);
	await kitUpgradeNotice(first.api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	first.handlers["session_start"]!(null, IDLE);
	expect(first.sent.length).toBe(1);
	const second = fakePi(IDLE);
	await kitUpgradeNotice(second.api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	second.handlers["session_start"]!(null, IDLE);
	expect(second.sent).toEqual([]);
	f.deps.readlink = () => "../releases/0.2.59/bin/omp-kit";
	const third = fakePi(IDLE);
	await kitUpgradeNotice(third.api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	third.handlers["session_start"]!(null, IDLE);
	expect(third.sent.length).toBe(1);
	expect(third.sent[0]!.content).toContain("0.2.59 is installed");
});

test("planted (g): source-checkout path and missing symlink never notice", async () => {
	for (const deps of [
		{ selfPath: "/Users/josh/Developer/omp-kit-companion/extensions/kit-upgrade-notice.ts" },
		{ selfPath: LOADED, readlink: () => { throw new Error("ENOENT"); } },
	]) {
		const f = files();
		const { api, sent, handlers } = fakePi(IDLE);
		await kitUpgradeNotice(api, { selfPath: deps.selfPath, session: "seat-1", home: "/h", ...f.deps, ...deps });
		handlers["session_start"]!(null, IDLE);
		handlers["tool_execution_end"]!(null, IDLE);
		expect(sent).toEqual([]);
	}
});

test("markers: corrupt JSON reads as unsent, then records the send", async () => {
	const f = files();
	const { api, sent, handlers } = fakePi(IDLE);
	await kitUpgradeNotice(api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	handlers["session_start"]!(null, IDLE);
	expect(sent.length).toBe(1);
	const marker = Object.keys(f.store)[0]!;
	f.store[marker] = "not json{{{";
	const again = fakePi(IDLE);
	await kitUpgradeNotice(again.api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps });
	again.handlers["session_start"]!(null, IDLE);
	expect(again.sent.length).toBe(1);
	expect(JSON.parse(f.store[marker]!)).toEqual(["0.2.58"]);
});

test("planted (h): a headless print-mode run never notices and never consumes the marker", async () => {
	const f = files();
	const { api, sent, handlers } = fakePi(IDLE);
	await kitUpgradeNotice(api, { selfPath: LOADED, session: "seat-1", home: "/h", ...f.deps, isTTY: false });
	handlers["session_start"]!(null, IDLE);
	handlers["tool_execution_end"]!(null, IDLE);
	expect(sent).toEqual([]);
	expect(f.writes).toEqual([]);
});

test("planted (i): a run with no session identity never notices", async () => {
	const f = files();
	const { api, sent, handlers } = fakePi({ isIdle: () => true });
	await kitUpgradeNotice(api, { selfPath: LOADED, home: "/h", ...f.deps, isTTY: true });
	handlers["session_start"]!(null, { isIdle: () => true });
	expect(sent).toEqual([]);
	expect(f.writes).toEqual([]);
});

test("sessionKey: stable, hex, distinct per seat", () => {
	expect(sessionKey("seat-1")).toBe(sessionKey("seat-1"));
	expect(sessionKey("seat-1")).toMatch(/^[0-9a-f]{16}$/);
	expect(sessionKey("seat-1")).not.toBe(sessionKey("seat-2"));
	expect(UPGRADE_NOTICE).toBe("UPGRADE_NOTICE");
});
