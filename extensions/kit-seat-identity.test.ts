import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import kitSeatIdentity, { paneSeatName } from "./kit-seat-identity";

const dirs: Array<{ path: string; cleanup(): void }> = [];
afterEach(() => { for (const d of dirs.splice(0)) d.cleanup(); });

/** A home whose identity tree holds `files` ({"<project hash>/tern-<pane>": body}). */
function home(files: Record<string, string>): string {
	const dir = ownedTmp("seat-identity-test");
	dirs.push(dir);
	for (const [rel, body] of Object.entries(files)) {
		const path = join(dir.path, ".config", "agent-mail", "identity", rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, body);
	}
	return dir.path;
}

async function load(env: Record<string, string | undefined>, h: string): Promise<Record<string, string | undefined>> {
	await kitSeatIdentity({}, { env, home: h });
	return env;
}

test("SEATNAME1: a restored seat without AGENT_NAME takes the one name its own pane's identity files give", async () => {
	const h = home({ "aaa/tern-929": '{"name":"OrangeRiver"}', "bbb/tern-929": '{"name":"orangeriver"}', "ccc/tern-930": '{"name":"Other"}' });
	expect((await load({ TERN_PANE: "929" }, h)).AGENT_NAME).toBe("OrangeRiver");
	// legacy bare-name body
	expect((await load({ TERN_PANE: "7" }, home({ "aaa/tern-7": "JadeDuck\n" }))).AGENT_NAME).toBe("JadeDuck");
});

test("SEATNAME1 planted: an existing AGENT_NAME is never replaced", async () => {
	const h = home({ "aaa/tern-929": '{"name":"OrangeRiver"}' });
	expect((await load({ TERN_PANE: "929", AGENT_NAME: "PeachLeopard" }, h)).AGENT_NAME).toBe("PeachLeopard");
	expect(paneSeatName({ TERN_PANE: "929", AGENT_NAME: "PeachLeopard" }, h)).toEqual({ kind: "kept", name: "PeachLeopard" });
});

test("SEATNAME1 planted: ambiguity, malformed names, a missing or foreign pane leave AGENT_NAME unset", async () => {
	const cases: Array<[Record<string, string | undefined>, Record<string, string>, string]> = [
		[{ TERN_PANE: "929" }, { "aaa/tern-929": '{"name":"OrangeRiver"}', "bbb/tern-929": '{"name":"JadeHorizon"}' }, "bound to"],
		[{ TERN_PANE: "929" }, { "aaa/tern-929": '{"name":"../evil"}' }, "malformed"],
		[{ TERN_PANE: "929" }, { "aaa/tern-929": '{"name":"Orange River"}' }, "malformed"],
		[{ TERN_PANE: "929" }, { "aaa/tern-930": '{"name":"Other"}' }, "no identity file"],
		[{ TERN_PANE: "../929" }, { "aaa/tern-929": '{"name":"OrangeRiver"}' }, "no Tern pane"],
		[{}, { "aaa/tern-929": '{"name":"OrangeRiver"}' }, "no Tern pane"],
	];
	for (const [env, files, why] of cases) {
		const h = home(files);
		const seat = paneSeatName(env, h);
		expect(seat.kind, JSON.stringify(files)).toBe("none");
		expect(seat.kind === "none" ? seat.why : "", JSON.stringify(files)).toContain(why);
		expect((await load({ ...env }, h)).AGENT_NAME, JSON.stringify(files)).toBeUndefined();
	}
	expect(paneSeatName({ TERN_PANE: "929" }, join(home({}), "missing")).kind).toBe("none");
});
