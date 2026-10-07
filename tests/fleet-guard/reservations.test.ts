import { beforeEach, describe, expect, test } from "bun:test";
import { check, clearReservationCache, exportAgentMailStorageRoot, reservationLookupFromResponse, storageRootFromEnvironment } from "../../src/fleet-guard/reservations.ts";

type Event = { toolName: string; arguments?: Record<string, unknown> };
const repo = "/workspace/repo";
const base = { cwd: repo, projectRoot: repo, agentName: "Alice", projectKey: repo };

beforeEach(() => clearReservationCache());

const LIVE_OWN_ACTIVE_RESPONSE = {
	conflict_free: true,
	conflicts: [],
	own_active: [
		{ id: 119032, path_pattern: "src/fleet-guard/reservations.ts", exclusive: true, expires_ts: "2026-10-02T05:22:42.041824Z" },
		{ id: 119033, path_pattern: "tests/fleet-guard/reservations.test.ts", exclusive: true, expires_ts: "2026-10-02T05:22:42.041824Z" },
	],
	clear_paths: ["src/fleet-guard/reservations.ts"],
	checked_paths: 1,
	total_conflicting_reservations: 0,
	project: "/fixture/omp-kit-companion",
	snapshot_ts: "2026-10-02T04:22:49.240281Z",
	authoritative_source: "database_snapshot",
	read_only: true,
};

describe("fleet guard reservation checks", () => {
	test("blocks tracked edit/write without an active exclusive reservation", async () => {
		const result = await check({ toolName: "edit", arguments: { path: "src/main.ts" } }, {
			...base,
			isTrackedPath: async () => true,
			lookupReservations: async () => ({ covered: false, conflicts: [] }),
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("file_reservation_paths");
	});

	test("parses the live own_active response by requested path", async () => {
		const lookupReservations = async (input: { path: string }) => reservationLookupFromResponse(LIVE_OWN_ACTIVE_RESPONSE, input.path);
		const context = { ...base, isTrackedPath: async () => true, lookupReservations };
		expect(await check({ toolName: "write", arguments: { path: "src/fleet-guard/reservations.ts" } }, context)).toBeUndefined();
		expect(await check({ toolName: "write", arguments: { path: "src/main.ts" } }, context)).toMatchObject({ block: true });
	});

	test("allows a covered tracked path, reads, and untracked writes", async () => {
		const lookup = async () => ({ covered: true, conflicts: [] });
		expect(await check({ toolName: "write", arguments: { path: "src/main.ts" } }, { ...base, isTrackedPath: async () => true, lookupReservations: lookup })).toBeUndefined();
		expect(await check({ toolName: "read", arguments: { path: "src/main.ts" } }, { ...base, isTrackedPath: async () => true, lookupReservations: async () => ({ covered: false, conflicts: [] }) })).toBeUndefined();
		expect(await check({ toolName: "write", arguments: { path: "new.ts" } }, { ...base, isTrackedPath: async () => false, lookupReservations: async () => ({ covered: false, conflicts: [] }) })).toBeUndefined();
	});

	test("fails open and warns when Agent Mail is unavailable", async () => {
		const warnings: string[] = [];
		const result = await check({ toolName: "edit", arguments: { path: "src/main.ts" } }, {
			...base,
			isTrackedPath: async () => true,
			lookupReservations: async () => { throw new Error("offline"); },
			warn: (message: string) => warnings.push(message),
		});
		expect(result).toBeUndefined();
		expect(warnings.join(" ")).toContain("fail-open");
	});

	test("caches reservation lookup for the path", async () => {
		let calls = 0;
		const lookupReservations = async () => { calls += 1; return { covered: true, conflicts: [] }; };
		const context = { ...base, isTrackedPath: async () => true, lookupReservations };
		await check({ toolName: "edit", arguments: { path: "src/main.ts" } }, context);
		await check({ toolName: "edit", arguments: { path: "src/main.ts" } }, context);
		expect(calls).toBe(1);
	});

	test("a reservation granted after a refusal allows the edit inside the cache window", async () => {
		let covered = false;
		let calls = 0;
		const lookupReservations = async () => { calls += 1; return { covered, conflicts: [] }; };
		let now = 1_000_000;
		const context = { ...base, isTrackedPath: async () => true, lookupReservations, now: () => now };
		expect(await check({ toolName: "edit", arguments: { path: "src/fresh.ts" } }, context)).toMatchObject({ block: true });
		covered = true;
		now += 5_000;
		expect(await check({ toolName: "edit", arguments: { path: "src/fresh.ts" } }, context)).toBeUndefined();
		expect(calls).toBe(2);
	});

	test("another agent's hold never allows the edit, however often it is rechecked", async () => {
		let calls = 0;
		const lookupReservations = async () => { calls += 1; return { covered: false, conflicts: [{ agent: "YellowSalmon" }] }; };
		let now = 2_000_000;
		const context = { ...base, isTrackedPath: async () => true, lookupReservations, now: () => now };
		expect(await check({ toolName: "edit", arguments: { path: "src/fresh.ts" } }, context)).toMatchObject({ block: true });
		now += 5_000;
		expect(await check({ toolName: "edit", arguments: { path: "src/fresh.ts" } }, context)).toMatchObject({ block: true });
		expect(calls).toBe(2);
	});

	test("derives the live storage root from the Agent Mail environment resource", () => {
		expect(storageRootFromEnvironment({ database_url: "sqlite:////fixture/user-home/.local/share/mcp-agent-mail-rust-live/storage.sqlite3" })).toBe("/fixture/user-home/.local/share/mcp-agent-mail-rust-live");
		expect(storageRootFromEnvironment({ database_url: "postgres://localhost/db" })).toBeUndefined();
	});

	test("exports the live storage root from the Agent Mail environment resource", async () => {
		const saved = { url: process.env.AGENTMAIL_HTTP_URL, token: process.env.AGENTMAIL_HTTP_BEARER_TOKEN, root: process.env.AGENT_MAIL_STORAGE_ROOT };
		const server = Bun.serve({ port: 0, async fetch(request) {
			const body = await request.json() as { params?: { uri?: string } };
			if (body.params?.uri !== "resource://config/environment") return Response.json({ error: { message: "unknown" } });
			return Response.json({ result: { contents: [{ text: JSON.stringify({ database_url: "sqlite:////tmp/am1-proof/storage.sqlite3" }) }] } });
		} });
		process.env.AGENTMAIL_HTTP_URL = `http://127.0.0.1:${server.port}/api`;
		process.env.AGENTMAIL_HTTP_BEARER_TOKEN = "proof-token";
		delete process.env.AGENT_MAIL_STORAGE_ROOT;
		try {
			await expect(exportAgentMailStorageRoot()).resolves.toBe("/tmp/am1-proof");
			expect(process.env.AGENT_MAIL_STORAGE_ROOT).toBe("/tmp/am1-proof");
		} finally {
			server.stop(true);
			if (saved.url === undefined) delete process.env.AGENTMAIL_HTTP_URL; else process.env.AGENTMAIL_HTTP_URL = saved.url;
			if (saved.token === undefined) delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN; else process.env.AGENTMAIL_HTTP_BEARER_TOKEN = saved.token;
			if (saved.root === undefined) delete process.env.AGENT_MAIL_STORAGE_ROOT; else process.env.AGENT_MAIL_STORAGE_ROOT = saved.root;
		}
	});
});

