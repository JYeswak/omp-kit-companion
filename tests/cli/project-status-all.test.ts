// STATUSREAD1: real status/CLI consumers over isolated native-command and journal inputs.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStatus, type ProjectStatusResult } from "../../src/project-add.ts";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { cli, fixture, type Fixture } from "./project-add.helpers.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);

type Managed = { session: string; pane: string | null; workers?: string[]; numeric?: boolean };
type StatusRow = { session: string; ok: boolean; status?: ProjectStatusResult };

function statusInputs(f: Fixture, managed: Managed[], native: Managed[], nativeExit = 0, paneMetadata = true): string {
	const log = join(f.dir, "status-native-argv.jsonl");
	const sessions = managed.map(row => `{"session":${JSON.stringify(row.session)},"repo":${JSON.stringify(f.repo)},` +
		`"coordinatorSession":${JSON.stringify(row.session)},"coordinatorPane":${row.numeric && row.pane ? row.pane : JSON.stringify(row.pane ?? "")},` +
		`"workerPanes":[${(row.workers ?? []).map(id => row.numeric ? id : JSON.stringify(`tern:${id}`)).join(",")}]}`);
	writeFileSync(f.fleetWatchPath, `{"enabled":true,"intervalSeconds":120,"sessions":[${sessions.join(",")}]}\n`);
	const ids = [...new Set(native.flatMap(row => [row.pane, ...(row.workers ?? [])]).filter((id): id is string => id !== null))];
	for (const id of ids) {
		writeFileSync(f.sessionFile(id), JSON.stringify({ type: "session", version: 3, id: `owned-${id}`, cwd: f.repo }) + "\n" +
			JSON.stringify({ type: "mode_change", id: "paused", parentId: null, mode: "goal_paused", timestamp: "2026-01-01T00:00:00Z" }) + "\n");
	}
	const tabs = native.map(row => `{"name":${JSON.stringify(row.session)},"blocks":[${[row.pane, ...(row.workers ?? [])]
		.filter((id): id is string => id !== null).map(id => `{"id":${id}}`).join(",")}]}`);
	const panes = ids.map(id => `{"pane":${id},"cwd":${JSON.stringify(f.repo)}${paneMetadata ? `,"exited":null,"omp_session_file":${JSON.stringify(f.sessionFile(id))}` : ""}}`);
	const inspect = `{"sessions":[{"name":"owned-native-host","tabs":[${tabs.join(",")}]}],"panes":[${panes.join(",")}]}`;
	writeFileSync(join(f.bin, "tern"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const argv=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,exit:${nativeExit}})+"\\n");
if(argv.join("|")!=="inspect|--json")process.exit(91);
console.log(${JSON.stringify(inspect)});
process.exit(${nativeExit});
`);
	f.env.AM_BIN = join(f.bin, "am");
	writeFileSync(f.env.AM_BIN, `#!/usr/bin/env bun
const argv=process.argv.slice(2),id=String(argv[argv.indexOf("--pane")+1]??"").replace("tern:","");
if(!${JSON.stringify(ids)}.includes(id))process.exit(3);
console.log(JSON.stringify({agent_name:"OwnedSeat-"+id}));
`);
	return log;
}

function dispose(f: Fixture): void {
	f.killDecoys();
	f.mail.server.stop(true);
}

test("STATUSREAD1 exact numeric identities survive the actual status read", async () => {
	const f = await fixture();
	try {
		const row = { session: "numeric", pane: "9501489860968451", workers: ["9501489860968453"], numeric: true };
		statusInputs(f, [row], [row]);
		const result = await cli(f, ["project", "status", row.session, "--json"]);
		expect(result.code, result.err + result.out).toBe(0);
		const payload = JSON.parse(result.out);
		expect(payload.data.seats.map((seat: { pane: string }) => seat.pane)).toEqual([
			"tern:9501489860968451", "tern:9501489860968453",
		]);
		expect(payload.data.seats.every((seat: { goalPaused: boolean | null }) => seat.goalPaused === true)).toBe(true);
		expect(payload.data.coverage.state).toBe("OBSERVED");
	} finally { dispose(f); }
}, fixtureDeadlineS(90) * 1000);

test("STATUSREAD1 pane-less and missing caller metadata remain explicit, never empty healthy success", async () => {
	const f = await fixture();
	try {
		statusInputs(f, [{ session: "quiet", pane: null }], []);
		const result = await projectStatus({ session: "quiet", env: f.env });
		if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
		expect(result.status.session).toBe("quiet");
		expect(result.status.seats).toEqual([]);
		expect(result.status.panesRecorded).toBe(false);
		expect(result.status.coverage.state).toBe("UNKNOWN");
		const read = await cli(f, ["project", "status", "quiet", "--json"]);
		expect(read.code).not.toBe(0);
		expect(JSON.parse(read.out).data.coverage.state).toBe("UNKNOWN");
	} finally { dispose(f); }
}, fixtureDeadlineS(90) * 1000);

test("STATUSREAD1 incomplete native pane metadata is unknown, not a live unpaused seat", async () => {
	const f = await fixture();
	try {
		const row = { session: "CFS", pane: f.directorBlock };
		statusInputs(f, [row], [row], 0, false);
		const read = await cli(f, ["project", "status", row.session, "--json"]);
		const payload = JSON.parse(read.out);
		expect(read.code).not.toBe(0);
		expect(payload.data.seats[0].alive).toBeNull();
		expect(payload.data.seats[0].goalPaused).toBeNull();
		expect(payload.data.coverage.state).toBe("UNKNOWN");
	} finally { dispose(f); }
}, fixtureDeadlineS(90) * 1000);

test("AUDITCFS1 complete native coverage is readable without making a fleet-health claim", async () => {
	const f = await fixture();
	try {
		const expected = [{ session: "CFS", pane: f.directorBlock }, { session: "cfs", pane: f.workerBlock }];
		statusInputs(f, expected, expected);
		const read = await cli(f, ["project", "status", "--all", "--json"]);
		const payload = JSON.parse(read.out);
		expect(read.code, read.err + read.out).toBe(0);
		expect(payload.data.expected).toEqual(["CFS", "cfs"]);
		expect(payload.data.observed).toEqual(["CFS", "cfs"]);
		expect(payload.data.sessions.every((row: StatusRow) => row.status?.coverage.state === "OBSERVED")).toBe(true);
		expect(payload.data.observation_only).toBe(true);
	} finally { dispose(f); }
}, fixtureDeadlineS(120) * 1000);

test("AUDITCFS1 native CFS/cfs/unknown-tab coverage retains the independently declared expected set", async () => {
	const f = await fixture();
	try {
		const expected = [
			{ session: "CFS", pane: f.directorBlock },
			{ session: "cfs", pane: f.workerBlock },
			{ session: "unknown-tab", pane: "9501489860968453" },
		];
		const log = statusInputs(f, expected, expected.slice(0, 2));
		const read = await cli(f, ["project", "status", "--all", "--json"]);
		const payload = JSON.parse(read.out);
		expect(read.code, read.err + read.out).not.toBe(0);
		expect(payload.data.expected).toEqual(expected.map(row => row.session));
		expect(payload.data.observed).toEqual(["CFS", "cfs"]);
		expect(payload.data.sessions.map((row: StatusRow) => row.session)).toEqual(expected.map(row => row.session));
		expect(payload.data.sessions.find((row: StatusRow) => row.session === "unknown-tab").status.coverage.state).toBe("UNKNOWN");
		expect(payload.data.sessions.find((row: StatusRow) => row.session === "CFS").status.seats[0].pane).toBe(`tern:${f.directorBlock}`);
		expect(payload.data.sessions.find((row: StatusRow) => row.session === "cfs").status.seats[0].pane).toBe(`tern:${f.workerBlock}`);
		expect(payload.data.sources.every((source: { revision: string | null; observedAt: string; freshnessMs: number; cursor: { bytes: number } | null }) =>
			source.revision !== null && Number.isFinite(Date.parse(source.observedAt)) && source.freshnessMs > 0 && source.cursor !== null && source.cursor.bytes > 0)).toBe(true);
		const issued = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(issued).toEqual([{ argv: ["inspect", "--json"], exit: 0 }]);
		console.info("AUDITCFS1 native consumer", JSON.stringify({ argv: ["project", "status", "--all", "--json"], exit: read.code,
			expected: payload.data.expected, observed: payload.data.observed, sources: payload.data.sources }));
	} finally { dispose(f); }
}, fixtureDeadlineS(120) * 1000);

test("AUDITCFS1 failed native read and absent caller identity cannot become a zero denominator or empty OK", async () => {
	const f = await fixture();
	try {
		const expected = [{ session: "CFS", pane: f.directorBlock }, { session: "cfs", pane: f.workerBlock }];
		statusInputs(f, expected, [], 23);
		delete f.env.AGENT_NAME;
		delete f.env.TERN_PANE;
		writeFileSync(join(f.bin, "br"), "#!/usr/bin/env bun\nconsole.error('BR_SHIM_IDENTITY_REQUIRED: owned fixture caller');process.exit(5);\n");
		const read = await cli(f, ["project", "status", "--all", "--json"]);
		const payload = JSON.parse(read.out);
		expect(read.code).not.toBe(0);
		expect(payload.data.expected).toEqual(["CFS", "cfs"]);
		expect(payload.data.observed).toEqual([]);
		for (const row of payload.data.sessions) {
			expect(row.status.coverage.state).toBe("UNKNOWN");
			expect(row.status.beads.ready).toBeNull();
			expect(row.status.beads.inProgress).toBeNull();
			expect(row.status.beads.error).toContain("BR_SHIM_IDENTITY_REQUIRED");
			expect(row.status.seats[0].alive).toBeNull();
			expect(row.status.seats[0].goalPaused).toBeNull();
		}
		expect(payload.data.sources.find((source: { kind: string }) => source.kind === "tern").reason).toContain("23");
	} finally { dispose(f); }
}, fixtureDeadlineS(120) * 1000);

test("AUDITCFS1 an incomplete tracker envelope is unknown, not a measured empty count", async () => {
	const f = await fixture();
	try {
		const row = { session: "CFS", pane: f.directorBlock };
		statusInputs(f, [row], [row]);
		writeFileSync(join(f.bin, "br"), "#!/usr/bin/env bun\nconsole.log(JSON.stringify({issues:[],total:null,has_more:true}));\n");
		const read = await cli(f, ["project", "status", row.session, "--json"]);
		const payload = JSON.parse(read.out);
		expect(read.code).not.toBe(0);
		expect(payload.data.beads.ready).toBeNull();
		expect(payload.data.beads.inProgress).toBeNull();
		expect(payload.data.coverage.state).toBe("UNKNOWN");
	} finally { dispose(f); }
}, fixtureDeadlineS(90) * 1000);
