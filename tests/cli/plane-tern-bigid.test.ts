import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTernSeatFromInspection, identifyTernSeat, parseTernInspection, parseTernProcess,
	resolveTernWindow } from "../../src/plane-tern.ts";
import type { TernObserverIo } from "../../src/plane-tern.ts";
import { deliverToTernSeat, routeSendTarget } from "../../src/send.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const first = "9297212626436099";
const second = "9297212626436100"; // Number(first) === Number(second): a lossy parser merges these seats.
const tmp = ownedTmp("plane-tern-bigid");
afterAll(() => tmp.cleanup());
const repo = join(tmp.path, "repo");
mkdirSync(repo);
const files = [join(tmp.path, "first.jsonl"), join(tmp.path, "second.jsonl")];
const seat = (id: string) => ({ session: "Default", pane: `tern:${id}`, windowKey: "", cwd: repo, identityProject: repo });

// Keep the wire tokens literal: constructing these ids as JS numbers would corrupt the fixture itself.
function inspection(): string {
	return `{"sessions":[{"id":7,"name":"Default","tabs":[
		{"id":8,"name":"first","blocks":[{"id":${first}}]},
		{"id":9,"name":"second","blocks":[{"id":${second}}]}]}],"panes":[
		{"pane":${first},"cwd":${JSON.stringify(repo)},"working":false,"exited":null,"omp_session_file":${JSON.stringify(files[0])}},
		{"pane":${second},"cwd":${JSON.stringify(repo)},"working":false,"exited":null,"omp_session_file":${JSON.stringify(files[1])}}]}`;
}

function processJson(id: string): string {
	return `{"pane":${id},"foreground":{"pid":1234,"name":"omp","argv":["omp"],"cwd":${JSON.stringify(repo)}}}`;
}

function resetJournals(): void {
	for (const [index, file] of files.entries()) writeFileSync(file, [
		JSON.stringify({ type: "session", version: 3, id: `session-${index}`, cwd: repo }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } }),
		"",
	].join("\n"));
}

function fixtureIo(id: string): { io: TernObserverIo; sent: string[][] } {
	const sent: string[][] = [];
	let pasted = "";
	const file = files[id === first ? 0 : 1]!;
	return { sent, io: {
		run(argv) {
			if (argv.includes("inspect")) return { code: 0, out: inspection() };
			if (argv.includes("process")) return { code: 0, out: processJson(argv[argv.indexOf("process") + 1]!) };
			if (argv[0] === "/bin/ps") return { code: 0, out: "Fri Nov 6 10:00:00 2026 omp AGENT_NAME=BigIdSeat" };
			if (argv[0] === "am") return { code: 0, out: JSON.stringify({ agent_name: "BigIdSeat", pane_id: argv[argv.indexOf("--pane") + 1],
				project_key: repo, binding: "verified-live" }) };
			if (argv.includes("send")) {
				const args = argv.slice(argv.indexOf("send") + 1);
				sent.push(args);
				if (args[0] !== id) return { code: 1, out: "wrong block" };
				if (args[1] === "paste") pasted = args[2]!;
				if (args[1] === "keys" && args[2] === "Enter") appendFileSync(file,
					JSON.stringify({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: pasted } }) + "\n");
				return { code: 0, out: "" };
			}
			return { code: 1, out: "unexpected command" };
		},
		readSessionFile: path => readFileSync(path, "utf8"),
		wait: async () => {},
	} };
}

test("TERNBIGID1: the odd 64-bit pane resolves its exact block and session file", () => {
	expect(parseTernInspection(inspection(), seat(first))).toMatchObject({ status: "FOUND", paneId: first, sessionFile: files[0] });
	expect(discoverTernSeatFromInspection(inspection(), `tern:${first}`)).toMatchObject({ status: "FOUND", seat: { pane: `tern:${first}`, session: "Default", cwd: repo } });
});

test("TERNBIGID1 planted negative: neighbouring ids beyond 2**53 never alias", () => {
	for (const [index, id] of [first, second].entries()) {
		expect(parseTernInspection(inspection(), { ...seat(id), session: index === 0 ? "first" : "second" }))
			.toMatchObject({ status: "FOUND", paneId: id, sessionFile: files[index] });
		expect(parseTernProcess(processJson(id === first ? second : first), repo, id))
			.toEqual({ status: "UNKNOWN", reason: "PROCESS_PANE_MISMATCH" });
	}
});

test("TERNBIGID1: command decoding and runtime identity retain exact pane strings", async () => {
	resetJournals();
	for (const id of [first, second]) {
		const { io } = fixtureIo(id);
		expect(resolveTernWindow(seat(id), io, {})).toMatchObject({ ok: true });
		expect(await identifyTernSeat(seat(id), io)).toMatchObject({ status: "IDENTIFIED", agent: "BigIdSeat", runtimeBinding: { paneId: id } });
	}
});

test("TERNBIGID1: send routes and submits to each exact pane, proving only its own journal entry", async () => {
	for (const [index, id] of [first, second].entries()) {
		resetJournals();
		const { io, sent } = fixtureIo(id);
		expect(routeSendTarget(`tern:${id}`)).toEqual({ route: "tern" });
		const result = await deliverToTernSeat({ seat: seat(id), text: "big-id regression", dropDir: join(tmp.path, `drop-${index}`), io,
			composer: () => ({ state: "EMPTY" }), env: {}, wait: async () => {}, pollMs: 1, deadlineMs: 50 });
		expect(result).toMatchObject({ status: "OK", code: "PROVEN", sessionFile: files[index], sends: 1 });
		expect(sent.map(args => args.slice(0, 2))).toEqual([[id, "paste"], [id, "keys"]]);
		expect(readFileSync(files[1 - index]!, "utf8")).not.toContain("big-id regression");
	}
});

test("TERNBIGID1: ids inside quoted titles are inert; invalid numeric tokens stay invalid", () => {
	const title = 'contains "id":9297212626436099 and \\"pane\\":9297212626436100';
	const raw = inspection().replace('"name":"Default"', `"name":${JSON.stringify(title)}`);
	expect(parseTernInspection(raw, { ...seat(first), session: title })).toMatchObject({ status: "FOUND", sessionName: title });
	for (const token of ["9297212626436099.5", "9297212626436099e1", "-9297212626436099", "01"]) {
		expect(parseTernInspection(inspection().replace(`"id":${first}`, `"id":${token}`), seat(first)).status).not.toBe("FOUND");
	}
	for (const id of ["0", "01", "+1", "1e3", "1.5", "1\n"]) expect(routeSendTarget(`tern:${id}`).route).toBe("refused");
});
