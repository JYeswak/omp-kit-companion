import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const entry = join(root, "src/cli.ts");
const scratch = ownedTmp("explain-cli-tests");
afterAll(() => scratch.cleanup());
let sequence = 0;
const decoder = new TextDecoder();
interface ExplainFixture {
	repo: string;
	secret: string;
	env: Record<string, string | undefined>;
	ledger: string;
}

async function fixture(withEvents = true, extraRefusals = 0, includeInterleaved = false): Promise<ExplainFixture> {
	const base = join(scratch.path, `case-${++sequence}`);
	const home = join(base, "home"), state = join(home, "state"), repo = join(home, "Developer", "repo");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(state, { recursive: true, mode: 0o700 });
	mkdirSync(repo, { recursive: true, mode: 0o700 });
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		XDG_STATE_HOME: state,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
		TMPDIR: base,
		PATH: "/usr/bin:/bin",
		AGENT_NAME: "FoggyTower",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		NO_COLOR: "1",
	};
	const initialized = await runFixtureAsync(["git", "init", "-q", "--template="], { cwd: repo, env, floor_s: 10 });
	if (initialized.rc !== 0) throw new Error(`fixture git init failed: ${decoder.decode(initialized.stderr)}`);

	const member = "pre-commit/49-explain-fixture";
	const hook = join(repo, ".git", "hooks", "hooks.d", "pre-commit", "49-explain-fixture");
	mkdirSync(dirname(hook), { recursive: true, mode: 0o700 });
	writeFileSync(hook, "#!/bin/sh\n# Refuses: stale tree\n# Comply: add only the intended paths and retry\nexit 1\n", { mode: 0o700 });
	chmodSync(hook, 0o755);

	const ledger = join(state, "omp-kit", "gate-events.jsonl");
	mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
	chmodSync(state, 0o700);
	chmodSync(dirname(ledger), 0o700);
	const repoPath = realpathSync(repo);
	const now = Date.now();
	const ts = (deltaMs: number) => new Date(now - deltaMs).toISOString();
	const secret = `ghp_${"a".repeat(36)}`;
	const replay = {
		version: 1,
		tool: "bash",
		arguments: { command: `git commit -m ${secret}` },
		cwd: repoPath,
		staged_paths: ["src/change.ts"],
		diff_sha256: null,
		message: null,
		custody: null,
		redacted: false,
		truncated: false,
		missing: [],
	};
	const refusal = (attempt: string, deltaMs: number, detail: string, eventId: string, gate = "STALE_WORKTREE_REFUSED") => ({
		ts: ts(deltaMs), seat: "FoggyTower", act: "commit", target: "main", gate,
		kind: "refuse", repo: repoPath, member, attempt, event_id: eventId, detail, replay,
	});
	const rows = [
		refusal("commit-a", 5000, `STALE_WORKTREE_REFUSED ${secret}`, "event-a1"),
		refusal("commit-a", 4900, `duplicate recorder row ${secret}`, "event-a2"),
		refusal("commit-b", 4000, "STALE_WORKTREE_REFUSED: tree changed", "event-b"),
		{ ts: ts(3000), seat: "FoggyTower", act: "commit", target: "main", gate: "pre-commit", kind: "pass", repo: repoPath, member, attempt: "commit-c", event_id: "event-c" },
		{ ts: ts(2000), seat: "OtherSeat", act: "commit", target: "main", gate: "OTHER_REFUSED", kind: "refuse", repo: repoPath, member, attempt: "other-a", event_id: "other-event", detail: "other seat only" },
	];
	const extraRows = Array.from({ length: extraRefusals }, (_, index) => {
		const cause = `EXTRA_CAUSE_${index}`;
		return refusal(`extra-${index}`, 10_000 + index, `${cause} blocked`, `extra-event-${index}`, cause);
	});
	const interleavedRows = includeInterleaved ? [
		refusal("shared-attempt", 8000, "INTERLEAVED_REFUSED first gate", "interleaved-a1", "INTERLEAVED_REFUSED"),
		{ ts: ts(7900), seat: "FoggyTower", act: "commit", target: "main", gate: "pre-commit", kind: "pass", repo: repoPath, member, attempt: "other-interleaved", event_id: "interleaved-b" },
		refusal("shared-attempt", 7800, "INTERLEAVED_REFUSED second gate", "interleaved-a2", "INTERLEAVED_REFUSED"),
		{ ts: ts(7900), seat: "FoggyTower", act: "commit", target: "main", gate: "RULE_FIRE", kind: "inject", repo: repoPath, member: "rule-in-window", attempt: "inject-in-window", event_id: "inject-in-window" },
		{ ts: ts(20_000), seat: "FoggyTower", act: "commit", target: "main", gate: "RULE_FIRE", kind: "inject", repo: repoPath, member: "rule-outside-window", attempt: "inject-outside-window", event_id: "inject-outside-window" },
	] : [];
	if (withEvents) {
		const oldRows = `${JSON.stringify({ ts: ts(60_000), seat: "OldSeat", act: "commit", target: "main", gate: "OLD_PASS", kind: "pass", attempt: "old", repo: repoPath, member })}\n`.repeat(12_000);
		writeFileSync(ledger, oldRows + [...rows, ...extraRows, ...interleavedRows].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
	}
	return { repo, secret, env, ledger };
}

async function invoke(f: ExplainFixture, args: string[]) {
	const result = await runFixtureAsync([
		process.execPath, "run", "--no-env-file", "--config=/dev/null", entry, ...args,
	], { cwd: f.repo, env: f.env, floor_s: 20, label: "omp-kit explain" });
	return { code: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

test("EXPLAIN1 groups recent seat refusals, reports commit first-try, reuses Comply, and redacts secrets", async () => {
	const f = await fixture();
	const result = await invoke(f, ["explain", "--last", "3", "--json"]);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.data.overall).toBe("PARTIAL");
	expect(envelope.data.seat).toBe("FoggyTower");
	expect(envelope.data.refusals).toHaveLength(1);
	expect(envelope.data.refusals[0]).toEqual(expect.objectContaining({
		cause: "STALE_WORKTREE_REFUSED",
		count: 2,
		compliant: expect.stringContaining("add only the intended paths and retry"),
	}));
	expect(envelope.data.commit_first_try).toEqual(expect.objectContaining({
		attempts: 3,
		passed: 1,
		rate_pct: 33.3,
	}));
	expect(envelope.data.window.complete).toBe(false);
	expect(envelope.data.commit_first_try.status).toBe("PARTIAL");
	expect(envelope.data.sources.gate_events.status).toBe("PARTIAL");
	expect(envelope.data.sources.gate_events.tail_window_bytes).toBeLessThanOrEqual(1024 * 1024);
	expect(envelope.data.sources.gate_events.rows_read).toBeLessThanOrEqual(10_000);
	expect(envelope.data.sources.dcg.status).toBe("UNATTRIBUTED");
	expect(envelope.data.text).toContain("DCG coverage: Not read:");
	expect(envelope.data.sources.rule_fires.status).toBe("UNAVAILABLE");
	expect(envelope.data.sources.rule_fires.records).toBeNull();
	expect(envelope.data.text).toContain("Rule-fire coverage: No inject rows in this action window");
	expect(result.stdout).not.toContain(f.secret);
	expect(result.stdout).not.toContain("other seat only");
	expect(result.stdout).not.toContain("OldSeat");
});
test("EXPLAIN1 accepts the 64-character seat boundary and rejects longer selectors", async () => {
	const f = await fixture(false);
	const boundary = `A${"b".repeat(63)}`;
	const accepted = await invoke(f, ["explain", "--seat", boundary, "--json"]);
	expect(accepted.code).toBe(0);
	expect(JSON.parse(accepted.stdout).data.seat).toBe(boundary);
	const rejected = await invoke(f, ["explain", "--seat", `${boundary}b`, "--json"]);
	expect(rejected.code).toBe(2);
	expect(JSON.parse(rejected.stdout).errors[0].code).toBe("INVALID_SEAT");
	const trailingNewline = await invoke(f, ["explain", "--seat", "FoggyTower\n", "--json"]);
	expect(trailingNewline.code).toBe(2);
	expect(JSON.parse(trailingNewline.stdout).errors[0].code).toBe("INVALID_SEAT");
});
test("EXPLAIN1 groups non-adjacent rows sharing an attempt ID", async () => {
	const f = await fixture(true, 0, true);
	const result = await invoke(f, ["explain", "--seat", "FoggyTower", "--last", "10", "--json"]);
	expect(result.code).toBe(0);
	const data = JSON.parse(result.stdout).data;
	expect(data.commit_first_try).toEqual(expect.objectContaining({ attempts: 5, passed: 2, refused: 3, rate_pct: 40 }));
	expect(data.refusals.find((row: { cause: string }) => row.cause === "INTERLEAVED_REFUSED")).toEqual(expect.objectContaining({ count: 1 }));
	expect(data.rule_fires).toHaveLength(1);
	expect(data.sources.rule_fires.records).toBeNull();
	expect(data.rule_fires[0]).toEqual(expect.objectContaining({ member: "rule-in-window", count: 1 }));
	expect(data.rule_fires.some((row: { member: string | null }) => row.member === "rule-outside-window")).toBe(false);
});
test("EXPLAIN1 bounds refusal groups and reports omitted causes", async () => {
	const f = await fixture(true, 150);
	const result = await invoke(f, ["explain", "--seat", "FoggyTower", "--last", "500", "--json"]);
	expect(result.code).toBe(0);
	const data = JSON.parse(result.stdout).data;
	expect(data.refusals).toHaveLength(100);
	expect(data.refusal_groups_omitted).toBe(51);
	expect(data.sources.gate_contracts.status).toBe("PARTIAL");
	expect(data.text).toContain("51 refusal groups omitted");
	expect(result.stdout).not.toContain(f.secret);
});

test("EXPLAIN1 refuses contract lookup outside trusted repository roots", async () => {
	const f = await fixture(false);
	const untrustedRepo = join(dirname(dirname(f.repo)), "untrusted");
	mkdirSync(untrustedRepo, { recursive: true, mode: 0o700 });
	const initialized = await runFixtureAsync(["git", "init", "-q", "--template="], { cwd: untrustedRepo, env: f.env, floor_s: 10 });
	if (initialized.rc !== 0) throw new Error(`untrusted fixture git init failed: ${decoder.decode(initialized.stderr)}`);
	const member = "pre-commit/49-untrusted";
	const hook = join(untrustedRepo, ".git", "hooks", "hooks.d", "pre-commit", "49-untrusted");
	mkdirSync(dirname(hook), { recursive: true, mode: 0o700 });
	const marker = "UNTRUSTED_CONTRACT_ONLY_SHOULD_NOT_APPEAR";
	writeFileSync(hook, `#!/bin/sh\n# Refuses: untrusted repo\n# Comply: ${marker}\nexit 1\n`, { mode: 0o755 });
	chmodSync(hook, 0o755);
	const row = {
		ts: new Date().toISOString(), seat: "FoggyTower", act: "commit", target: "main", gate: "UNTRUSTED_REFUSAL",
		kind: "refuse", repo: realpathSync(untrustedRepo), member, attempt: "untrusted-attempt",
		event_id: "untrusted-event", detail: "UNTRUSTED_REFUSAL blocked",
	};
	writeFileSync(f.ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 });
	const result = await invoke(f, ["explain", "--seat", "FoggyTower", "--json"]);
	expect(result.code).toBe(0);
	const data = JSON.parse(result.stdout).data;
	expect(data.refusals).toHaveLength(1);
	expect(data.refusals[0]).toEqual(expect.objectContaining({ compliant: null, remedy_status: "UNAVAILABLE" }));
	expect(data.sources.gate_contracts.status).toBe("UNAVAILABLE");
	expect(data.sources.gate_contracts.reason).toContain("outside trusted fleet roots");
	expect(result.stdout).not.toContain(marker);
});
test("EXPLAIN1 help exposes the seat and bounded-history flags", async () => {
	const f = await fixture(false);
	const result = await invoke(f, ["explain", "--help"]);
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("Usage: omp-kit explain");
	expect(result.stdout).toContain("--seat");
	expect(result.stdout).toContain("--last");
});

test("EXPLAIN1 groups unclassified tool failures by redacted message prefix", async () => {
	const f = await fixture(false);
	const repo = realpathSync(f.repo);
	const now = new Date().toISOString();
	const rows = [
		{ ts: now, seat: "FoggyTower", act: "bash", gate: "tool-error:unclassified", kind: "refuse", repo, attempt: "unclassified-a", event_id: "unclassified-a", detail: `ENOENT: missing file ${f.secret}` },
		{ ts: now, seat: "FoggyTower", act: "bash", gate: "tool-error:unclassified", kind: "refuse", repo, attempt: "unclassified-b", event_id: "unclassified-b", detail: `EACCES: permission denied ${f.secret}` },
		{ ts: now, seat: "FoggyTower", act: "bash", gate: "tool-error:unclassified", kind: "refuse", repo, attempt: "unclassified-c", event_id: "unclassified-c", detail: `ENOENT: another file ${f.secret}` },
		{ ts: now, seat: "FoggyTower", act: "bash", gate: "tool-error:unclassified", kind: "refuse", repo, attempt: "unclassified-control", event_id: "unclassified-control", detail: `\u001b[2J: ${f.secret}` },
	];
	writeFileSync(f.ledger, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
	const result = await invoke(f, ["explain", "--seat", "FoggyTower", "--last", "10", "--json"]);
	expect(result.code).toBe(0);
	const data = JSON.parse(result.stdout).data;
	expect(data.refusals).toHaveLength(3);
	expect(data.refusals).toEqual(expect.arrayContaining([
		expect.objectContaining({ cause: "tool-error:unclassified: ENOENT", count: 2 }),
		expect.objectContaining({ cause: "tool-error:unclassified: EACCES", count: 1 }),
	]));
	expect(result.stdout).not.toContain(f.secret);
	expect(data.text.includes("\u001b")).toBe(false);
});
