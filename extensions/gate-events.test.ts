import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateEventsPath, gateFromReason, recordGateEvent, trackerAct } from "./gate-events";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { captureMineReplay } from "../src/mine-replay.ts";

const base = ownedTmp("gate-events").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("trackerAct: the tracker acts the fleet measures, with their targets", () => {
	expect(trackerAct("br close ompkit-774u.1.3 --reason x")).toEqual({ act: "close", target: "ompkit-774u.1.3" });
	expect(trackerAct("cd x && br --db d update ompkit-fixjo --claim --actor y")).toEqual({ act: "claim", target: "ompkit-fixjo" });
	expect(trackerAct("AGENT_NAME=x br --db /p/beads.db update ompkit-fp72.135.3.1 --status in_review --actor z")).toEqual({ act: "in-review", target: "ompkit-fp72.135.3.1" });
	expect(trackerAct('br update ompkit-a1 --status open --assignee ""')).toEqual({ act: "release", target: "ompkit-a1" });
	expect(trackerAct("br create --title t")).toEqual({ act: "create", target: null });
});

test("trackerAct planted: words that are not an invocation are not acts", () => {
	for (const command of ["git commit -m close", "brew update x", "echo br close", "grep br close f", "br show ompkit-a1 --json"]) {
		expect(trackerAct(command)).toBeNull();
	}
});

test("gateFromReason: JSON code, prose code, and the guard name as fallback", () => {
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard", code: "CLAIM_REFUSED", refusal: {} }))).toBe("CLAIM_REFUSED");
	expect(gateFromReason("kit-flywheel-guard BEAD_LINT_REFUSED: `br update` would leave")).toBe("BEAD_LINT_REFUSED");
	expect(gateFromReason("[kit-agent-mail-guard] AM_IDENTITY_MISMATCH: y")).toBe("AM_IDENTITY_MISMATCH");
	expect(gateFromReason(JSON.stringify({ guard: "kit-flywheel-guard" }))).toBe("kit-flywheel-guard");
});

test("gateFromReason planted (KEEPALIVE2a): a refusal led by the constraint line keeps its line-2 header's code", () => {
	const waitRefusal = [
		"CONSTRAINT full-suite wall 900/600 clearing=fx-1 holder=FixtureBuilder",
		"kit-flywheel-guard WAIT_REFUSED: CopperTrout may not block its turn on its own background work (BGWAIT1): this call uses the `wait` tool.",
		"If your next action does not move this line ... send one NO-WORK line to your director and end the turn.",
	].join("\n");
	expect(gateFromReason(waitRefusal)).toBe("WAIT_REFUSED");
	expect(gateFromReason(`CONSTRAINT none declarer=Lead\nkit-flywheel-guard NO_WAIT_REFUSED: x`)).toBe("NO_WAIT_REFUSED");
	expect(gateFromReason(`CONSTRAINT none declarer=Lead\nNo valid constraint.\n[kit-agent-mail-guard] AM_IDENTITY_MISMATCH: y`)).toBe("AM_IDENTITY_MISMATCH");
	// Bounded: a header quoted past line 3 is not the refusal's own, so the first token stands.
	expect(gateFromReason("CONSTRAINT x\na\nb\nkit-flywheel-guard WAIT_REFUSED: quoted")).toBe("CONSTRAINT");
	// Linear on a long multi-line near-miss: only three lines are split and matched.
	const nearMiss = `kit-flywheel-guard ${"a".repeat(50_000)}\n`.repeat(200);
	const t0 = performance.now();
	expect(gateFromReason(nearMiss)).toBe("kit-flywheel-guard");
	expect(performance.now() - t0).toBeLessThan(500); // wallclock: p99=1.3ms headroom=380x (50 runs, 2026-11-04)
});

test("recordGateEvent appends one row per event under the state dir and never throws on a bad path", async () => {
	const env = { XDG_STATE_HOME: join(base, "state") };
	const path = gateEventsPath(env, base);
	expect(path).toBe(join(base, "state", "omp-kit", "gate-events.jsonl"));
	const first = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "SELF_CLOSE_REFUSED", kind: "refuse", detail: "x" }, { env, home: base });
	const second = await recordGateEvent({ seat: "PlumRaven", act: "close", target: "ompkit-a1", gate: "flywheel", kind: "pass" }, { env, home: base });
	expect(first).toMatchObject({ ok: true, path });
	expect(second).toMatchObject({ ok: true, path });
	const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows.map(r => [r.act, r.gate, r.kind, r.target])).toEqual([["close", "SELF_CLOSE_REFUSED", "refuse", "ompkit-a1"], ["close", "flywheel", "pass", "ompkit-a1"]]);
	expect(rows.every(r => typeof r.ts === "string" && r.seat === "PlumRaven")).toBe(true);
	expect(rows.every(r => "repo" in r && r.member === r.gate && Number.isFinite(Date.parse(r.started_at)) && r.duration_s >= 0)).toBe(true);
	// planted: a path whose parent is a file is reported, not thrown; the good ledger is untouched
	writeFileSync(join(base, "not-a-dir"), "x");
	const bad = await recordGateEvent({ seat: null, act: "claim", target: null, gate: "x", kind: "refuse" }, { path: join(base, "not-a-dir", "gate-events.jsonl") });
	expect(bad.ok).toBe(false);
	expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});

test("recordGateEvent retains sanitized replay and raw event identity before bounding", async () => {
	const path = join(base, "replay.jsonl");
	const sentinel = `ghp_${"7cX9".repeat(10)}`;
	const event = {
		seat: "PlumRaven", act: "bash", target: null, gate: "INPUT_REFUSED", kind: "refuse" as const,
		event_id: "native-tool-call-17",
		replay: {
			version: 1 as const, tool: "bash", arguments: { command: "echo ordinary", registration_token: "private-binding-value", oversized: `${"x".repeat(70000)} ${sentinel}` },
			cwd: "/repo", staged_paths: null, diff_sha256: null, message: null, custody: null,
			redacted: false, truncated: false, missing: ["staged_paths", "diff_sha256", "message", "custody"],
		},
	};
	expect((await recordGateEvent(event, { path })).ok).toBe(true);
	const row = JSON.parse(readFileSync(path, "utf8"));
	expect(row.event_id).toBe("native-tool-call-17");
	expect(row.replay.arguments.command).toBe("echo ordinary");
	expect(row.replay.redacted).toBe(true);
	expect(row.replay.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(row.replay))).toBeLessThanOrEqual(32768);
	expect(JSON.stringify(row)).not.toContain(sentinel);
	expect(JSON.stringify(row)).not.toContain("private-binding-value");
});

test("recordGateEvent records repo root and supplied check clock without replacing old fields", async () => {
	const repo = join(base, "timed-repo"), nested = join(repo, "nested");
	mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(nested);
	const path = join(base, "timed.jsonl"), started_at = "2026-11-03T12:00:00Z";
	await recordGateEvent({ seat: "Fixture", act: "publish", target: "main", gate: "40-full", kind: "pass",
		replay: captureMineReplay({ cwd: nested }), started_at, duration_s: 12.5 }, { path });
	expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ repo, member: "40-full", started_at, duration_s: 12.5,
		act: "publish", target: "main", gate: "40-full", kind: "pass" });
	expect((await recordGateEvent({ seat: null, act: "publish", target: null, gate: "bad", kind: "pass", duration_s: -1 }, { path })).ok).toBe(false);
});

test("recordGateEvent scrubs bounded metadata including unexpected credential-shaped IDs", async () => {
	const path = join(base, "metadata.jsonl");
	const sentinel = `ghp_${"7cX9".repeat(10)}`;
	await recordGateEvent({ seat: sentinel, act: sentinel, target: sentinel, gate: sentinel, kind: "refuse",
		attempt: sentinel, event_id: sentinel, detail: `${"x".repeat(70000)} ${sentinel}` }, { path });
	const raw = readFileSync(path, "utf8");
	const row = JSON.parse(raw);
	expect(raw).not.toContain(sentinel);
	expect(row.metadata_redacted).toBe(true);
	expect(row.metadata_truncated).toBe(true);
	expect(row.target).not.toBe(sentinel);
	expect(row.event_id).not.toBe(sentinel);
});

test("recordGateEvent rescreens split secret flags in untrusted retained argv", async () => {
	const path = join(base, "split-flags.jsonl");
	const replay = { ...captureMineReplay({ arguments: {} }), arguments: { argv: ["--api-key", "short-test-value", "--password=x", "-px", "--project", "visible-value", "--token"] } };
	await recordGateEvent({ seat: null, act: "commit", target: null, gate: "fixture", kind: "refuse", replay }, { path });
	const row = JSON.parse(readFileSync(path, "utf8"));
	expect(row.replay.arguments.argv).toEqual(["--api-key", "[REDACTED]", "--password=[REDACTED]", "-p[REDACTED]", "--project", "visible-value", "--token"]);
	expect(row.replay.redacted).toBe(true);
});
