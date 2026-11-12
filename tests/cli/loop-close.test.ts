import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { RUN_TIME_CAPS_MS } from "../../src/service-run.ts";
import { canonicalCode, isNonRefusalGate, parseGateTs, runLoopClose, type LoopCloseBrResult, type LoopCloseMail } from "../../src/loop-close.ts";

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
		nowMs: NOW, mailTo: "lead-test", mailProjectKey: "proj-test",
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
