import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { RUN_TIME_CAPS_MS } from "../../src/service-run.ts";
import { canonicalCode, isNonRefusalGate, parseGateTs, readLoopCloseConfig, runLoopClose, type LoopCloseBrResult, type LoopCloseMail } from "../../src/loop-close.ts";
import { LIFECYCLE_PHASES } from "../../src/lifecycle.ts";

const NOW = Date.parse("2026-11-12T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function ledgerRow(gate: string, daysAgo: number, kind = "refuse"): string {
	return JSON.stringify({ gate, kind, ts: new Date(NOW - daysAgo * DAY_MS).toISOString(), event_id: `ev-${gate}-${daysAgo}` });
}

interface FakeBead { id: string; title: string; labels: string[]; status: string }

function makeTracker(failFirstCreateMatching?: string) {
	const calls: string[][] = [];
	const beads: FakeBead[] = [];
	let seq = 0;
	let failed = false;
	const runBr = async (argv: string[]): Promise<LoopCloseBrResult> => {
		calls.push(argv);
		if (argv[0] === "create") {
			const title = String(argv[1] ?? "");
			if (failFirstCreateMatching !== undefined && !failed && title.includes(failFirstCreateMatching)) {
				failed = true;
				return { rc: 1, stdout: "", stderr: "boom" };
			}
			seq += 1;
			const id = `loop-test.${seq}`;
			const flag = argv.indexOf("-l");
			const labels = flag >= 0 ? String(argv[flag + 1] ?? "").split(",") : [];
			beads.push({ id, title, labels, status: "open" });
			return { rc: 0, stdout: JSON.stringify({ id }), stderr: "" };
		}
		if (argv[0] === "list") return { rc: 0, stdout: JSON.stringify({ issues: beads }), stderr: "" };
		return { rc: 0, stdout: "{}", stderr: "" };
	};
	const created = () => calls.filter(argv => argv[0] === "create");
	const labelOf = (call: string[]) => String(call[call.indexOf("-l") + 1] ?? "");
	return { calls, created, labelOf, runBr, beads };
}

function makeMail() {
	const sent: LoopCloseMail[] = [];
	const sendMail = async (mail: LoopCloseMail) => {
		sent.push(mail);
		return { delivered: true, detail: "delivered" };
	};
	return { sent, sendMail };
}

function quietLiveback() {
	let readbacks = 0;
	return {
		readbacks: () => readbacks,
		listLiveReadbacks: async () => ["r1", "r2", "r3"],
		runLiveReadback: async () => {
			readbacks += 1;
			return { ok: true };
		},
	};
}

function readStreaks(statePath: string): Record<string, number> {
	const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
	if (parsed === null || typeof parsed !== "object" || !("redSince" in parsed)) return {};
	const redSince = parsed.redSince;
	if (redSince === null || typeof redSince !== "object" || Array.isArray(redSince)) return {};
	const out: Record<string, number> = {};
	for (const [name, firstSeen] of Object.entries(redSince)) {
		if (typeof firstSeen === "number" && Number.isFinite(firstSeen)) out[name] = firstSeen;
	}
	return out;
}

test("LOOPCLOSE1: one run files retire and red beads, wakes on new codes, reads back live; deleting state refiles nothing", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [
		ledgerRow("SILENT-OLD", 45),
		ledgerRow("SILENT-OLD", 31),
		ledgerRow("NEW-HOT", 1),
		ledgerRow("STEADY", 60),
		ledgerRow("STEADY", 29),
		ledgerRow("tool-error:unclassified", 40),
		"not-json",
		"",
	].join("\n"));
	const redSince = NOW - 25 * 60 * 60 * 1000;
	const tracker = makeTracker();
	const mail = makeMail();
	const live = quietLiveback();
	const statePath = join(root, "kit-state", "loop-close.json");
	const deps = {
		ledgerPath, statePath, home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [
			{ name: "cc", red: true, redSinceMs: redSince },
			{ name: "omp-watch", red: false, redSinceMs: null },
		],
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
	};

	const first = await runLoopClose(deps);
	expect(first.ok).toBe(true);
	expect(first.retiredFiled).toHaveLength(1);
	expect(first.redFiled).toHaveLength(1);
	expect(first.newCodes).toEqual(["NEW-HOT"]);
	expect(first.mail).toBe("SENT");
	expect(mail.sent).toHaveLength(1);
	expect(mail.sent[0]!.subject).toContain("REPORT");
	expect(mail.sent[0]!.bodyMd).toContain("NEW-HOT");
	expect(first.liveReadback).toEqual({ ok: true, visited: 3, skipped: 0 });
	const titles = tracker.created().map(argv => argv[1]);
	expect(titles.some(title => title !== undefined && title.includes("SILENT-OLD") && title.includes("RETIRE"))).toBe(true);
	expect(titles.some(title => title !== undefined && title.includes("cc"))).toBe(true);
	expect(titles.some(title => title !== undefined && title.includes("STEADY"))).toBe(false);
	// Every filing carries its stable backstop label; the red key carries the incident date.
	const labels = tracker.created().map(call => tracker.labelOf(call));
	expect(labels.some(label => label.includes("loop-close:retire-code:SILENT-OLD"))).toBe(true);
	expect(labels.some(label => label === `loop-close,loop-close:red-service:cc:${new Date(redSince).toISOString().slice(0, 10)}`)).toBe(true);
	expect(first.findings).toEqual([]);
	expect(first.deadlineMs).toBeNull();

	// Losing the state file must not refile: the tracker-side backstop adopts the open beads.
	rmSync(statePath);
	const second = await runLoopClose(deps);
	expect(tracker.created()).toHaveLength(2);
	expect(second.retiredFiled).toEqual([]);
	expect(second.redFiled).toEqual([]);
	expect(second.retiredUpdated).toHaveLength(1);
	expect(second.redUpdated).toHaveLength(1);

	const runs = readFileSync(join(root, "kit-state", "loop-close-runs.jsonl"), "utf8").trim().split("\n");
	expect(runs).toHaveLength(2);
});

test("LOOPCLOSE1: a br failure on the 2nd create persists the 1st and never refiles it", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("SILENT-A", 45), ledgerRow("SILENT-B", 40)].join("\n"));
	const tracker = makeTracker("SILENT-B");
	const mail = makeMail();
	const live = quietLiveback();
	const deps = {
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [],
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
	};
	const first = await runLoopClose(deps);
	expect(first.retiredFiled).toHaveLength(1);
	expect(first.findings.some(finding => finding.startsWith("TRACKER_FILE_FAILED"))).toBe(true);
	const persisted: unknown = JSON.parse(readFileSync(join(root, "kit-state", "loop-close.json"), "utf8"));
	expect(persisted !== null && typeof persisted === "object" && persisted !== null).toBe(true);

	const second = await runLoopClose(deps);
	expect(second.retiredUpdated).toHaveLength(1);
	expect(second.retiredFiled).toHaveLength(1);
	const aCreates = tracker.created().filter(argv => String(argv[1] ?? "").includes("SILENT-A"));
	expect(aCreates).toHaveLength(1);
});

test("LOOPCLOSE1: a truncated ledger still retires silent codes but skips the new-code REPORT", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	const junk = "{}\n".repeat(3_000_000);
	writeFileSync(ledgerPath, `${junk}${ledgerRow("SILENT-OLD", 45)}\n${ledgerRow("NEW-HOT", 1)}\n`);
	const tracker = makeTracker();
	const mail = makeMail();
	const live = quietLiveback();
	const result = await runLoopClose({
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test", ledgerMaxBytes: 8 * 1024 * 1024,
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [],
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
	});
	expect(result.ok).toBe(true);
	expect(result.retiredFiled).toHaveLength(1);
	expect(result.newCodes).toEqual(["NEW-HOT"]);
	expect(result.mail).toBe("SKIPPED-TRUNCATED");
	expect(mail.sent).toEqual([]);
	expect(result.findings.some(finding => finding.startsWith("MAIL_SKIPPED_TRUNCATED"))).toBe(true);
});

test("LOOPCLOSE1: a ledger past the old 8 MiB tail cap is read whole by default, so 30-day silence is judged on full history", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	// The old silent code sits at the head, 9 MB before the tail a tail-only read would keep.
	writeFileSync(ledgerPath, `${ledgerRow("SILENT-HEAD", 45)}\n${"{}\n".repeat(3_000_000)}${ledgerRow("NEW-HOT", 1)}\n`);
	const tracker = makeTracker();
	const mail = makeMail();
	const live = quietLiveback();
	const result = await runLoopClose({
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [],
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
	});
	expect(result.findings.some(finding => finding.startsWith("LEDGER_TRUNCATED"))).toBe(false);
	expect(result.retiredFiled).toHaveLength(1);
	expect(result.mail).not.toBe("SKIPPED-TRUNCATED");
});

test("LOOPCLOSE1: live readback stops at the cap and red services without an age are findings", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("tool-error:unclassified", 40)].join("\n"));
	const tracker = makeTracker();
	const mail = makeMail();
	let now = NOW;
	let visits = 0;
	const result = await runLoopClose({
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, capMs: 1500, clockMs: () => now,
		mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [{ name: "cc", red: true, redSinceMs: null }],
		listLiveReadbacks: async () => ["r1", "r2", "r3"],
		runLiveReadback: async () => {
			visits += 1;
			now += 1000;
			return { ok: true };
		},
	});
	expect(visits).toBe(2);
	expect(result.liveReadback).toEqual({ ok: true, visited: 2, skipped: 1 });
	expect(result.deadlineMs).toBe(NOW + 1500);
	expect(result.summary).toContain("visited=2 skipped=1");
	expect(result.redFiled).toEqual([]);
	expect(result.findings.some(finding => finding.startsWith("STATUS_AGE_UNKNOWN"))).toBe(true);
});

test("LOOPCLOSE1: a red streak files once it is 24 h old, updates while red, clears on green, and rekeys on a new incident", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("tool-error:unclassified", 40)].join("\n"));
	const tracker = makeTracker();
	const mail = makeMail();
	const live = quietLiveback();
	const statePath = join(root, "kit-state", "loop-close.json");
	let now = NOW;
	let green = false;
	const status = async () => green
		? [{ name: "cc", red: false, redSinceMs: null }]
		: [{ name: "cc", red: true, redSinceMs: now - 60 * 60 * 1000 }];
	const base = {
		ledgerPath, statePath, home: root, repo: root, actor: "loop-close-test",
		mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
		readServiceStatus: status,
	};

	// Day 1, red for an hour: the streak is recorded, nothing is filed yet.
	const day1 = await runLoopClose({ ...base, nowMs: now });
	expect(day1.redFiled).toEqual([]);
	expect(readStreaks(statePath)).toEqual({ cc: NOW - 60 * 60 * 1000 });

	// Day 2, still red: the streak is 25 h old, so one bead files under the day-1 date.
	now = NOW + 24 * DAY_MS;
	const day2 = await runLoopClose({ ...base, nowMs: now });
	expect(day2.redFiled).toHaveLength(1);
	const firstId = day2.redFiled[0]!;

	// Day 3, still red: the same incident updates, never refiles.
	now = NOW + 25 * 60 * 60 * 1000;
	const day3 = await runLoopClose({ ...base, nowMs: now });
	expect(day3.redFiled).toEqual([]);
	expect(day3.redUpdated).toEqual([firstId]);

	// Green clears the streak.
	now = NOW + 26 * 60 * 60 * 1000;
	green = true;
	const cleared = await runLoopClose({ ...base, nowMs: now });
	expect(cleared.redFiled).toEqual([]);
	expect(readStreaks(statePath)).toEqual({});

	// Red again is a new incident: a new bead once it ages past 24 h.
	green = false;
	now = NOW + 50 * 60 * 60 * 1000;
	const reRed = await runLoopClose({ ...base, nowMs: now });
	expect(reRed.redFiled).toEqual([]);
	now = NOW + 75 * 60 * 60 * 1000;
	const reAged = await runLoopClose({ ...base, nowMs: now });
	expect(reAged.redFiled).toHaveLength(1);
	expect(reAged.redFiled[0]).not.toBe(firstId);
	expect(tracker.created()).toHaveLength(2);

	// Losing state with the incident bead closed adopts the mapping without refiling.
	tracker.beads[1]!.status = "closed";
	rmSync(statePath);
	const adopted = await runLoopClose({ ...base, nowMs: now });
	expect(tracker.created()).toHaveLength(2);
	expect(adopted.redFiled).toEqual([]);
	expect(adopted.redUpdated).toEqual([]);
});

test("LOOPCLOSE1: service run loop-close passes a non-null deadline and files through the fixture tracker", async () => {
	expect(RUN_TIME_CAPS_MS["loop-close"]).toBe(1_800_000);
	const root = ownedTmp("loop-close-test").path;
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const real = resolveRealBr(process.env.PATH);
	if (!real.ok) throw new Error(real.reason);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(real.path, join(bin, "br"));
	const db = join(repo, ".beads", "beads.db");
	const childEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") childEnv[key] = value;
	}
	for (const key of ["BEADS_DIR", "BEADS_JSONL", "BEADS_CACHE_DIR", "BD_DB", "BD_DATABASE", "BR_REAL", "BR_BIN", "BR_ACTOR", "BR_AGENT_NAME", "BR_OUTPUT_FORMAT"]) delete childEnv[key];
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("SILENT-SVC", 45)].join("\n"));
	childEnv.HOME = root;
	childEnv.XDG_STATE_HOME = join(root, ".local", "state");
	childEnv.TMPDIR = join(root, "tmp");
	mkdirSync(childEnv.TMPDIR, { recursive: true });
	childEnv.PATH = `${bin}:${childEnv.PATH ?? ""}`;
	childEnv.AGENT_NAME = "LoopCloseFixture";
	childEnv.BEADS_DB = db;
	childEnv.LOOP_CLOSE_LEDGER = ledgerPath;
	childEnv.LOOP_CLOSE_REPO = repo;
	childEnv.OMP_KIT_LOAD_OVERRIDE = "0/8";
	childEnv.OMP_KIT_TEST_LABEL_NAMESPACE = `com.omp-kit.test.loopclose${Math.random().toString(36).slice(2, 8)}`;
	const init = await run(["br", "init", "--db", join(repo, ".beads", "beads.db")], { cwd: repo, deadline_s: fixtureDeadlineS(60), env: childEnv });
	expect(init.rc).toBe(0);
	const child = await runFixtureAsync([process.execPath, resolve(import.meta.dir, "..", "..", "src", "cli.ts"), "service", "run", "loop-close", "--json"], {
		cwd: root, env: childEnv, floor_s: 60, label: "service run loop-close",
	});
	const envelope = JSON.parse(new TextDecoder().decode(child.stdout));
	expect(child.rc).toBe(0);
	expect(typeof envelope.data.deadlineMs).toBe("number");
	expect(envelope.data.deadlineMs).toBeGreaterThan(Date.now());
	expect(envelope.data.retiredFiled).toHaveLength(1);
});

test("LOOPCLOSE1 planted negative: a code that fired 29 d ago files no retire bead", async () => {
	const root = ownedTmp("loop-close-test").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("ALMOST-DUE", 29)].join("\n"));
	const tracker = makeTracker();
	const mail = makeMail();
	const live = quietLiveback();
	const result = await runLoopClose({
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root, actor: "loop-close-test",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [],
		listLiveReadbacks: live.listLiveReadbacks,
		runLiveReadback: live.runLiveReadback,
	});
	expect(result.ok).toBe(true);
	expect(result.retiredFiled).toEqual([]);
	expect(result.newCodes).toEqual([]);
	expect(result.mail).toBe("SKIPPED-QUIET");
	expect(tracker.created()).toEqual([]);
	expect(mail.sent).toEqual([]);
});

test("LOOPCLOSE1: refusal-code canonicalisation matches turnline", () => {
	expect(isNonRefusalGate("tool-error:unclassified")).toBe(true);
	expect(isNonRefusalGate("validation:phase-name-required")).toBe(true);
	expect(isNonRefusalGate("kit-flywheel-guard")).toBe(true);
	expect(isNonRefusalGate("kit-flywheel-guard:")).toBe(true);
	expect(isNonRefusalGate("RESERVATION_REQUIRED")).toBe(false);
	expect(isNonRefusalGate("dcg-denied")).toBe(false);
	expect(canonicalCode("guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE")).toBe("WRITE_OWN_LOOKUP_UNAVAILABLE");
	expect(canonicalCode("commit-refusal:RESERVATION_REQUIRED")).toBe("RESERVATION_REQUIRED");
	expect(canonicalCode("dcg-denied")).toBe("dcg");
	expect(canonicalCode("core.filesystem.rm-rf-general")).toBe("dcg");
	expect(canonicalCode("slb-caution")).toBe("slb");
	expect(canonicalCode("slb-dangerous")).toBe("slb");
	expect(canonicalCode("SOME_CODE")).toBe("SOME_CODE");
	expect(parseGateTs("2026-11-12T00:00:00Z")).toBe(NOW);
	expect(parseGateTs("2026-11-12T00:00:00")).toBe(NOW);
	expect(parseGateTs("2026-11-12T05:00:00+05:00")).toBe(NOW);
	expect(parseGateTs("not-a-date")).toBeNull();
	expect(parseGateTs("")).toBeNull();
	expect(parseGateTs(null)).toBeNull();
});

// LOOPCLOSEWIRE1 (ompkit-1ra0d.224): the installed daily job files into the kit tracker
// instead of $HOME because the repo and mailbox were env-only. The loopClose key in
// fleet-watch.json configures {repo, mailTo, mailProject} with env override; an absent
// key is UNCONFIGURED in status/doctor/run instead of a run against $HOME.
test("LOOPCLOSEWIRE1: readLoopCloseConfig reads the loopClose key with env override; absent is UNCONFIGURED", () => {
	const root = ownedTmp("loop-close-wire").path;
	const configPath = join(root, ".config", "omp-kit", "fleet-watch.json");
	mkdirSync(dirname(configPath), { recursive: true });
	const read = (config: unknown, env: Record<string, string> = {}) => {
		if (config !== null) writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
		return readLoopCloseConfig(root, { OMP_KIT_FLEET_WATCH_CONFIG: configPath, ...env });
	};
	const configured = read({ loopClose: { repo: "/repo", mailTo: "lead", mailProject: "proj" } });
	expect(configured.ok).toBe(true);
	if (configured.ok) expect(configured.config).toEqual({ repo: "/repo", configPath, mailTo: "lead", mailProjectKey: "proj" });
	const withFrom = read({ loopClose: { repo: "/repo", mailTo: "lead", mailProject: "proj", mailFrom: "sender" } });
	expect(withFrom.ok).toBe(true);
	if (withFrom.ok) expect(withFrom.config).toEqual({ repo: "/repo", configPath, mailTo: "lead", mailProjectKey: "proj", mailFrom: "sender" });
	const envFrom = read({ loopClose: { repo: "/repo", mailTo: "lead", mailProject: "proj" } }, { LOOP_CLOSE_MAIL_FROM: "env-sender" });
	expect(envFrom.ok).toBe(true);
	if (envFrom.ok) expect(envFrom.config.mailFrom).toBe("env-sender");
	const overridden = read({ loopClose: { repo: "/repo", mailTo: "lead", mailProject: "proj" } },
		{ LOOP_CLOSE_REPO: "/env/repo", LOOP_CLOSE_MAIL_TO: "env-lead" });
	expect(overridden.ok).toBe(true);
	if (overridden.ok) expect(overridden.config).toEqual({ repo: "/env/repo", configPath, mailTo: "env-lead", mailProjectKey: "proj" });
	const envOnly = read({ sessions: [] }, { LOOP_CLOSE_REPO: "/env/repo" });
	expect(envOnly.ok).toBe(true);
	if (envOnly.ok) expect(envOnly.config.repo).toBe("/env/repo");
	expect(read({ sessions: [] })).toMatchObject({ ok: false, code: "LOOP_CLOSE_UNCONFIGURED" });
	expect(read(null)).toMatchObject({ ok: false, code: "LOOP_CLOSE_UNCONFIGURED" });
	rmSync(configPath);
	expect(read(null)).toMatchObject({ ok: false, code: "LOOP_CLOSE_UNCONFIGURED" });
	for (const bad of ["{not json", "[1]", `"str"`, { loopClose: "/repo" }, { loopClose: { repo: "relative" } },
		{ loopClose: { repo: "/repo", mailTo: "" } }, { loopClose: { repo: "/repo", mailProject: "a\nb" } },
		{ loopClose: { repo: "/repo", mailFrom: "" } }, { loopClose: { repo: "/repo", mailFrom: "a\nb" } }]) {
		expect(read(bad)).toMatchObject({ ok: false, code: "LOOP_CLOSE_CONFIG_INVALID" });
	}
});

function wireServiceEnv(home: string, configPath: string, extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	for (const key of ["BEADS_DIR", "BEADS_JSONL", "BEADS_CACHE_DIR", "BD_DB", "BD_DATABASE", "BR_REAL", "BR_BIN", "BR_ACTOR", "BR_AGENT_NAME", "BR_OUTPUT_FORMAT",
		"LOOP_CLOSE_REPO", "LOOP_CLOSE_MAIL_TO", "LOOP_CLOSE_MAIL_PROJECT", "LOOP_CLOSE_MAIL_FROM", "LOOP_CLOSE_LEDGER"]) delete env[key];
	return { ...env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), TMPDIR: join(home, "tmp"),
		OMP_KIT_FLEET_WATCH_CONFIG: configPath, OMP_KIT_LOAD_OVERRIDE: "0/8",
		OMP_KIT_TEST_LABEL_NAMESPACE: `com.omp-kit.test.loopwire${Math.random().toString(36).slice(2, 8)}`, ...extra };
}

function wireServiceHome(): { home: string; bin: string } {
	const home = ownedTmp("loop-close-wire", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	const bin = join(home, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(home, "tmp"), { recursive: true });
	writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return { home, bin };
}

// Planted negative: today's code defaults the repo to $HOME, so a keyless run files
// into the seat instead of refusing. The run/status/doctor/install assertions below
// all fail on that code (no LOOP_CLOSE_UNCONFIGURED, no UNCONFIGURED row).
test("LOOPCLOSEWIRE1: keyless service run refuses UNCONFIGURED and files nothing; status and doctor show it", () => {
	const { home } = wireServiceHome();
	const configPath = join(home, ".config", "omp-kit", "fleet-watch.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ sessions: [] }));
	const env = wireServiceEnv(home, configPath);
	const cli = [process.execPath, resolve(import.meta.dir, "..", "..", "src", "cli.ts")];
	const runKeyless = runSync([...cli, "service", "run", "loop-close", "--json"], { deadline_s: fixtureDeadlineS(30), cwd: home, env });
	expect(runKeyless.rc).toBe(2);
	const runEnvelope = JSON.parse(new TextDecoder().decode(runKeyless.stdout));
	expect(runEnvelope.errors[0].code).toBe("LOOP_CLOSE_UNCONFIGURED");
	expect(runEnvelope.errors[0].remediation).toContain('"loopClose"');
	expect(existsSync(join(home, ".beads"))).toBe(false);
	const status = runSync([...cli, "service", "status", "loop-close", "--json"], { deadline_s: fixtureDeadlineS(30), cwd: home, env });
	expect(status.rc).toBe(0);
	const statusRow = JSON.parse(new TextDecoder().decode(status.stdout)).data.status[0];
	expect(statusRow).toMatchObject({ name: "loop-close", state: "UNCONFIGURED", configured: "UNCONFIGURED" });
	const doctor = runSync([...cli, "service", "doctor", "loop-close", "--json"], { deadline_s: fixtureDeadlineS(30), cwd: home, env });
	const doctorEnvelope = JSON.parse(new TextDecoder().decode(doctor.stdout));
	expect(doctor.rc).toBe(1);
	expect(doctorEnvelope.data.checks.some((check: { id: string; status: string }) => check.id === "configured" && check.status === "WARN")).toBe(true);
	const install = runSync([...cli, "service", "install", "loop-close", "--plan", "--json"], { deadline_s: fixtureDeadlineS(30), cwd: home, env });
	expect(install.rc).toBe(2);
	expect(JSON.parse(new TextDecoder().decode(install.stdout)).errors[0].code).toBe("LOOP_CLOSE_UNCONFIGURED");
});

test("LOOPCLOSEWIRE1: configured service run files into the loopClose repo and addresses its mailbox", async () => {
	expect(RUN_TIME_CAPS_MS["loop-close"]).toBe(1_800_000);
	const root = ownedTmp("loop-close-wire").path;
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const real = resolveRealBr(process.env.PATH);
	if (!real.ok) throw new Error(real.reason);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(real.path, join(bin, "br"));
	const configPath = join(root, ".config", "omp-kit", "fleet-watch.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ loopClose: { repo, mailTo: "lead-test", mailProject: "proj-test" } }));
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("SILENT-SVC", 45), ledgerRow("NEW-HOT", 1)].join("\n"));
	const childEnv = wireServiceEnv(root, configPath, {
		PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_NAME: "LoopCloseWireFixture",
		BEADS_DB: join(repo, ".beads", "beads.db"), LOOP_CLOSE_LEDGER: ledgerPath,
	});
	mkdirSync(childEnv.TMPDIR, { recursive: true });
	const init = await run(["br", "init", "--db", join(repo, ".beads", "beads.db")], { cwd: repo, deadline_s: fixtureDeadlineS(60), env: childEnv });
	expect(init.rc).toBe(0);
	const child = await runFixtureAsync([process.execPath, resolve(import.meta.dir, "..", "..", "src", "cli.ts"), "service", "run", "loop-close", "--json"], {
		cwd: root, env: childEnv, floor_s: 60, label: "service run loop-close wire",
	});
	const envelope = JSON.parse(new TextDecoder().decode(child.stdout));
	// The retire bead files into the configured repo; the REPORT is attempted at the
	// configured mailbox and fails inside the fixture (no am route there), never skipped.
	expect(envelope.data.retiredFiled).toHaveLength(1);
	expect(envelope.data.mail).toBe("FAILED");
	expect(envelope.data.findings.some((finding: string) => finding.startsWith("MAIL_FAILED"))).toBe(true);
	expect(existsSync(join(repo, ".beads", "beads.db"))).toBe(true);
	expect(existsSync(join(root, ".beads"))).toBe(false);
}, fixtureDeadlineS(120) * 1_000);
// LOOPCLOSEFIX1 (ompkit-1ra0d.224 follow-up): the first live run filed nothing —
// every generated bead was refused by the tracker's create lint
// (d-negative-specimen, l-ac-phase:AC_PHASE_UNTAGGED) and the REPORT mail needed a
// launchd-absent AGENT_MAIL_SENDER_TOKEN. The bodies below go through the REAL
// scripts/br-create-lint.py the way the shim invokes it (br argv after the binary,
// BR_CREATE_REAL/PROJECT/DB from the guard contract); the planted negatives are
// today's refused bodies verbatim.
test("LOOPCLOSEFIX1: generated creates pass the real br-create-lint; today's bodies are refused", async () => {
	const root = ownedTmp("loop-close-fix").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [
		ledgerRow("SILENT-OLD", 45),
		ledgerRow("SILENT-OLD", 31),
		ledgerRow("NEW-HOT", 1),
	].join("\n"));
	const redSince = NOW - 25 * 60 * 60 * 1000;
	const tracker = makeTracker();
	const mail = makeMail();
	const docsDir = join(root, "docs");
	mkdirSync(docsDir, { recursive: true });
	writeFileSync(join(docsDir, "lifecycle.json"), JSON.stringify({
		version: 1,
		rows: LIFECYCLE_PHASES.map(phase => ({ phase, exit_criterion: "criterion holds", metric: "open" })),
	}));
	const statePath = join(root, "kit-state", "loop-close.json");
	const result = await runLoopClose({
		ledgerPath, statePath, home: root, repo: root, actor: "loop-close-fix",
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
		runBr: tracker.runBr, sendMail: mail.sendMail,
		readServiceStatus: async () => [{ name: "cc", red: true, redSinceMs: redSince }],
		listLiveReadbacks: async () => [],
	});
	expect(result.retiredFiled).toHaveLength(1);
	expect(result.redFiled).toHaveLength(1);
	expect(result.lifecycleFiled.length).toBeGreaterThan(0);
	const creates = tracker.created();
	expect(creates.length).toBe(result.retiredFiled.length + result.redFiled.length + result.lifecycleFiled.length);

	const real = resolveRealBr(process.env.PATH);
	if (!real.ok) throw new Error(real.reason);
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(real.path, join(bin, "br"));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	env.PATH = `${bin}:${env.PATH ?? ""}`;
	const trackerDir = join(root, "lint-tracker");
	mkdirSync(trackerDir, { recursive: true });
	const db = join(trackerDir, ".beads", "beads.db");
	const init = await runFixtureAsync(["br", "init", "--db", db], {
		cwd: trackerDir, floor_s: 60, label: "lint tracker init", env,
	});
	expect(init.rc).toBe(0);
	const lint = resolve(import.meta.dir, "..", "..", "scripts", "br-create-lint.py");
	const lintEnv = { ...env, BR_CREATE_REAL: real.path, BR_CREATE_PROJECT: trackerDir, BR_CREATE_DB: db };
	for (const create of creates) {
		const checked = await runFixtureAsync(["python3", lint, ...create], {
			cwd: trackerDir, floor_s: 60, label: "br-create-lint generated", env: lintEnv,
		});
		expect(checked.rc).toBe(0);
	}
	const refusedBodies = [
		'- [ ] Fill the doc for phase `discover` in docs/lifecycle.json\n- [ ] Run `bun scripts/lifecycle-check.ts --check` green\n- [ ] Close this bead when the gap row is complete',
		'- [ ] Retire the rule or hook behind `SILENT-OLD`, or record why it stays\n- [ ] Close this bead when the retirement lands',
		'- [ ] Repair or reinstall `cc` and confirm a green receipt\n- [ ] Close this bead when the service holds green',
	];
	for (const acceptance of refusedBodies) {
		const refused = await runFixtureAsync(["python3", lint, "create", "TODAY BODY", "-t", "task",
			"--description", "WHAT: today\n\nWHY: today",
			"--acceptance-criteria", acceptance, "--json", "--actor", "loop-close-fix"], {
			cwd: trackerDir, floor_s: 60, label: "br-create-lint planted negative", env: lintEnv,
		});
		expect(refused.rc).toBe(4);
		const stderr = new TextDecoder().decode(refused.stderr);
		expect(stderr).toContain("d-negative-specimen");
		expect(stderr).toContain("l-ac-phase");
	}
}, fixtureDeadlineS(120) * 1_000);

// LOOPCLOSEFIX1: the REPORT mail goes through the token-free `am mail send` route
// (the kit's existing CLI pattern), never AGENT_MAIL_SENDER_TOKEN. A fake `am`
// on PATH records the argv; the test asserts the shape and the absence of any
// token flag.
test("LOOPCLOSEFIX1: default mail sends through the token-free am CLI", async () => {
	const root = ownedTmp("loop-close-mail").path;
	const ledgerPath = join(root, "gate-events.jsonl");
	writeFileSync(ledgerPath, [ledgerRow("NEW-HOT", 1)].join("\n"));
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const argvLog = join(root, "am-argv.txt");
	writeFileSync(join(bin, "am"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argvLog + "\nexit 0\n");
	chmodSync(join(bin, "am"), 0o755);
	const tracker = makeTracker();
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	env.PATH = `${bin}:${env.PATH ?? ""}`;
	const result = await runLoopClose({
		ledgerPath, statePath: join(root, "kit-state", "loop-close.json"), home: root, repo: root,
		actor: "loop-close-mail", nowMs: NOW, env,
		mailTo: "lead-test", mailProjectKey: "proj-test", mailFrom: "sender-test",
		runBr: tracker.runBr,
		readServiceStatus: async () => [],
		listLiveReadbacks: async () => [],
		lifecycleManifestPath: join(root, "no-manifest.json"),
	});
	expect(result.mail).toBe("SENT");
	expect(result.findings).toHaveLength(0);
	const argv = readFileSync(argvLog, "utf8").trim().split("\n");
	expect(argv.slice(0, 8)).toEqual(["mail", "send", "--project", "proj-test", "--from", "sender-test", "--to", "lead-test"]);
	expect(argv).toContain("--subject");
	expect(argv).toContain("--body");
	expect(argv.some(part => part.toLowerCase().includes("token"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);
