import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditReservationAge } from "../../src/reservation-age.ts";
import { checkHotCap, HOT_CAP_MINUTES, isHotPath, isReservationTool, parseHotPaths, readHotPaths } from "../../src/fleet-guard/hot-cap.ts";
import { check } from "../../src/fleet-guard/reservations.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function hotRepo(): string {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp/hotcap-"));
	dirs.push(root);
	mkdirSync(join(root, ".omp"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, ".omp", "hot-paths"), "# hot files\nsrc/cli.ts\nsrc/commands.ts\n");
	writeFileSync(join(root, "src", "cli.ts"), "x\n");
	writeFileSync(join(root, "src", "other.ts"), "y\n");
	return root;
}

const reserveEvent = (paths: string[], exclusive: boolean, ttlMinutes: number | undefined) => ({
	toolName: "xd://mcp__mcp_agent_mail_file_reservation_paths",
	arguments: { agent_name: "PlumRaven", paths, exclusive, ttl_seconds: ttlMinutes === undefined ? undefined : ttlMinutes * 60, reason: "ompkit-wodi" },
});

test("147-min exclusive on a hot path is refused naming cap and path", async () => {
	const root = hotRepo();
	const block = await check(reserveEvent(["src/cli.ts"], true, 147), { cwd: root, repoRoot: root });
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("30 min cap");
	expect(block?.reason).toContain("src/cli.ts");
});

test("20-min exclusive on a hot path passes", async () => {
	const root = hotRepo();
	const block = await check(reserveEvent(["src/cli.ts"], true, 20), { cwd: root, repoRoot: root });
	expect(block).toBeUndefined();
});

test("147-min exclusive on a non-hot path passes", async () => {
	const root = hotRepo();
	const block = await check(reserveEvent(["src/other.ts"], true, 147), { cwd: root, repoRoot: root });
	expect(block).toBeUndefined();
});

test("147-min renewal on a hot path is refused", async () => {
	const root = hotRepo();
	const block = await check({
		toolName: "xd://mcp__mcp_agent_mail_renew_file_reservations",
		arguments: { agent_name: "PlumRaven", paths: ["src/commands.ts"], exclusive: true, ttl_seconds: 147 * 60 },
	}, { cwd: root, repoRoot: root });
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("renewal");
});

test("non-exclusive long hold on a hot path passes", async () => {
	const root = hotRepo();
	const block = await check(reserveEvent(["src/cli.ts"], false, 147), { cwd: root, repoRoot: root });
	expect(block).toBeUndefined();
});

test("no hot-paths file means no cap", async () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp/hotcap-"));
	dirs.push(root);
	const block = await check(reserveEvent(["src/cli.ts"], true, 147), { cwd: root, repoRoot: root });
	expect(block).toBeUndefined();
	expect(readHotPaths(root)).toEqual([]);
});

test("hot-path matching: exact, dir prefix, and parsing", () => {
	expect(parseHotPaths("# c\n\nsrc/cli.ts\nsrc/\n")).toEqual(["src/cli.ts", "src/"]);
	expect(isHotPath(["src/cli.ts"], "src/cli.ts")).toBe("src/cli.ts");
	expect(isHotPath(["src/cli.ts"], "src/other.ts")).toBeNull();
	expect(isHotPath(["src/"], "src/cli.ts")).toBe("src/");
	expect(isHotPath([], "src/cli.ts")).toBeNull();
	expect(isReservationTool("xd://mcp__mcp_agent_mail_file_reservation_paths")).toBe("reserve");
	expect(isReservationTool("xd://mcp__mcp_agent_mail_renew_file_reservations")).toBe("renew");
	expect(isReservationTool("edit")).toBeNull();
	expect(HOT_CAP_MINUTES).toBe(30);
});

test("checkHotCap unit: cap boundary and message", () => {
	const hot = ["src/cli.ts"];
	expect(checkHotCap({ hotPaths: hot, request: { paths: ["src/cli.ts"], exclusive: true, ttlSeconds: 30 * 60, kind: "reserve" } }).blocked).toBe(false);
	const over = checkHotCap({ hotPaths: hot, request: { paths: ["src/cli.ts"], exclusive: true, ttlSeconds: 31 * 60, kind: "reserve" } });
	expect(over.blocked).toBe(true);
	expect(over.reason).toContain("src/cli.ts");
});


test("doctor audit lists only hot overdue holds when filtered", () => {
	const archive = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp/hotcap-age-"));
	dirs.push(archive);
	const project = "org/repo";
	const dir = join(archive, "projects", "org-repo", "file_reservations");
	mkdirSync(dir, { recursive: true });
	const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const fresh = new Date().toISOString();
	writeFileSync(join(dir, "a.json"), JSON.stringify({ exclusive: true, path_pattern: "src/cli.ts", agent_name: "A", created_ts: old, reason: "b1" }));
	writeFileSync(join(dir, "b.json"), JSON.stringify({ exclusive: true, path_pattern: "src/other.ts", agent_name: "B", created_ts: old, reason: "b2" }));
	writeFileSync(join(dir, "c.json"), JSON.stringify({ exclusive: true, path_pattern: "src/cli.ts", agent_name: "C", created_ts: fresh, reason: "b3" }));
	const all = auditReservationAge({ archiveRoot: archive, projectKey: project });
	expect(all.overdue.map(row => row.agent_name).sort()).toEqual(["A", "B"]);
	const hot = auditReservationAge({ archiveRoot: archive, projectKey: project, hotPaths: ["src/cli.ts"] });
	expect(hot.overdue.map(row => row.agent_name)).toEqual(["A"]);
});

test("renew via extend_seconds on a hot path is refused", async () => {
	const root = hotRepo();
	const block = await check({
		toolName: "xd://mcp__mcp_agent_mail_renew_file_reservations",
		arguments: { agent_name: "PlumRaven", paths: ["src/cli.ts"], exclusive: true, extend_seconds: 147 * 60 },
	}, { cwd: root, repoRoot: root });
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("147");
});

test("macro reservation cycle on a hot path is refused", async () => {
	const root = hotRepo();
	const block = await check({
		toolName: "xd://mcp__mcp_agent_mail_macro_file_reservation_cycle",
		arguments: { agent_name: "PlumRaven", paths: ["src/cli.ts"], exclusive: true, ttl_seconds: 147 * 60 },
	}, { cwd: root, repoRoot: root });
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("src/cli.ts");
});

test("glob path matching a hot file is refused; non-matching glob passes", async () => {
	const root = hotRepo();
	const bad = await check({
		toolName: "xd://mcp__mcp_agent_mail_file_reservation_paths",
		arguments: { agent_name: "PlumRaven", paths: ["src/*.ts"], exclusive: true, ttl_seconds: 147 * 60 },
	}, { cwd: root, repoRoot: root });
	expect(bad?.block).toBe(true);
	expect(bad?.reason).toContain("src/cli.ts");
	const ok = await check({
		toolName: "xd://mcp__mcp_agent_mail_file_reservation_paths",
		arguments: { agent_name: "PlumRaven", paths: ["docs/*.md"], exclusive: true, ttl_seconds: 147 * 60 },
	}, { cwd: root, repoRoot: root });
	expect(ok).toBeUndefined();
});

const MIN = 60_000;
const idOnlyRenew = (extra: Record<string, unknown>) => ({
	toolName: "xd://mcp__mcp_agent_mail_renew_file_reservations",
	arguments: { agent_name: "PlumRaven", project_key: "/repo", extend_seconds: 10 * 60, file_reservation_ids: [7], ...extra },
});

test("ID-only renewal of an exclusive hot hold past 30 min is refused", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check(idOnlyRenew({}), {
		cwd: root, repoRoot: root, now: () => now,
		activeHolds: [{ id: 7, path_pattern: "src/cli.ts", exclusive: true, agent_name: "PlumRaven", granted_ms: now - 31 * MIN, expires_ms: now + 10 * MIN }],
	});
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("hold 7");
	expect(block?.reason).toContain("src/cli.ts");
});

test("ID-only renewal of a young exclusive hot hold within cap passes", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check(idOnlyRenew({}), {
		cwd: root, repoRoot: root, now: () => now,
		activeHolds: [{ id: 7, path_pattern: "src/cli.ts", exclusive: true, agent_name: "PlumRaven", granted_ms: now - 5 * MIN, expires_ms: now + 10 * MIN }],
	});
	expect(block).toBeUndefined();
});

test("ID-only renewal of a non-exclusive hot hold passes", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check(idOnlyRenew({}), {
		cwd: root, repoRoot: root, now: () => now,
		activeHolds: [{ id: 7, path_pattern: "src/cli.ts", exclusive: false, agent_name: "PlumRaven", granted_ms: now - 60 * MIN, expires_ms: now + 10 * MIN }],
	});
	expect(block).toBeUndefined();
});

test("ID-only renewal scoped to another id ignores the hot hold", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check(idOnlyRenew({ file_reservation_ids: [9] }), {
		cwd: root, repoRoot: root, now: () => now,
		activeHolds: [{ id: 7, path_pattern: "src/cli.ts", exclusive: true, agent_name: "PlumRaven", granted_ms: now - 60 * MIN, expires_ms: now + 10 * MIN }],
	});
	expect(block).toBeUndefined();
});

const twoHolds = (now: number) => [
	{ id: 7, path_pattern: "src/cli.ts", exclusive: true, agent_name: "PlumRaven", granted_ms: now - 60 * MIN, expires_ms: now + 10 * MIN },
	{ id: 8, path_pattern: "src/other.ts", exclusive: true, agent_name: "PlumRaven", granted_ms: now - 60 * MIN, expires_ms: now + 10 * MIN },
];

test("path-scoped renewal of a non-hot hold passes despite an over-cap hot hold", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check({
		toolName: "xd://mcp__mcp_agent_mail_renew_file_reservations",
		arguments: { agent_name: "PlumRaven", project_key: "/repo", extend_seconds: 10 * 60, paths: ["src/other.ts"] },
	}, { cwd: root, repoRoot: root, now: () => now, activeHolds: twoHolds(now) });
	expect(block).toBeUndefined();
});

test("path-scoped renewal of the hot hold is still refused", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check({
		toolName: "xd://mcp__mcp_agent_mail_renew_file_reservations",
		arguments: { agent_name: "PlumRaven", project_key: "/repo", extend_seconds: 10 * 60, paths: ["src/cli.ts"] },
	}, { cwd: root, repoRoot: root, now: () => now, activeHolds: twoHolds(now) });
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("hold 7");
});

test("id-only renewal of the hot hold is still refused with a sibling hold present", async () => {
	const root = hotRepo();
	const now = Date.now();
	const block = await check(idOnlyRenew({}), {
		cwd: root, repoRoot: root, now: () => now, activeHolds: twoHolds(now),
	});
	expect(block?.block).toBe(true);
	expect(block?.reason).toContain("hold 7");
});