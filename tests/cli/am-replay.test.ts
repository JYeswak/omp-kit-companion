// AMREPLAY1 (ompkit-wy0ka): the load-watch tick replays or discards Agent Mail
// UNSENT artifacts. Fixture pending/archive dirs plus a stub am-bin keep every
// run hermetic: no live server, no real mail.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { checkAmReplay } from "../../src/am-watch";
import { fixtureDeadlineS, runFixture } from "./fixture-process";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "am_replay.py");

afterAll(cleanupAllOwnedTmp);

const STUB_AM = `#!/bin/sh
# stub am: replay/discard write terminal siblings like the real verbs.
log="$STUB_AM_LOG"
verb="$1"; shift
if [ "$verb" = "mail" ]; then
	sub="$1"; shift
	if [ "$sub" = "replay-queued" ]; then
		artifact=""
		while [ $# -gt 0 ]; do case "$1" in --artifact) artifact="$2"; shift 2;; *) shift;; esac; done
		printf 'sent-stub %s\\n' "$artifact" >>"$log"
		printf '{"sent_ts":"stub"}\\n' >"\${artifact%.json}.sent.json"
		exit 0
	fi
	if [ "$sub" = "discard-queued" ]; then
		artifact=""; reason=""
		while [ $# -gt 0 ]; do case "$1" in --artifact) artifact="$2"; shift 2;; --reason) reason="$2"; shift 2;; *) shift;; esac; done
		printf 'discard-stub %s %s\\n' "$artifact" "$reason" >>"$log"
		printf '{"discarded":true}\\n' >"\${artifact%.json}.discarded.json"
		exit 0
	fi
fi
exit 1
`;

function isoAgoMs(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

function artifact(createdIso: string, subject: string, project = "/proj/a"): string {
	return JSON.stringify({
		status: "UNSENT_UNTIL_REPLAY", created_ts: createdIso,
		envelope: { project_key: project, sender: "Teal", to: ["Rose"], subject },
		failure: { class: "pool_exhaustion" },
	});
}

function setup(): { pending: string; archive: string; stub: string } {
	const base = realpathSync(ownedTmp("am-replay-test").path);
	const pending = join(base, "pending");
	const archive = join(base, "archive");
	mkdirSync(pending, { recursive: true });
	mkdirSync(archive, { recursive: true });
	const stub = join(base, "stub-am.sh");
	writeFileSync(stub, STUB_AM, { mode: 0o700 });
	return { pending, archive, stub };
}

function plantArchive(archive: string, project: string, subject: string, createdIso: string): void {
	const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const now = new Date();
	const dir = join(archive, slug, "messages", String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"));
	mkdirSync(dir, { recursive: true });
	const stamp = createdIso.replace(/[-:]/g, "-").replace(/\..+/, "Z");
	const file = join(dir, `${stamp}__${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}__1.md`);
	const meta = JSON.stringify({ from: "Teal", subject, created: createdIso, to: ["Rose"] });
	writeFileSync(file, `---json\n${meta}\n---\nbody\n`);
}

function runTick(pending: string, archive: string, stub: string, extra: string[] = []) {
	const env = { ...process.env, STUB_AM_LOG: join(pending, "..", "stub.log"), PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const result = runFixture(["python3", "-B", SCRIPT, "tick", "--pending", pending, "--archive", archive,
		"--am-bin", stub, ...extra], { cwd: pending, env, floor_s: fixtureDeadlineS(120) });
	expect(result.rc).toBe(0);
	return JSON.parse(new TextDecoder().decode(result.stdout));
}

test("AMREPLAY1: young undelivered replays once; delivered and stale discard; second tick replays nothing", () => {
	const { pending, archive, stub } = setup();
	writeFileSync(join(pending, "young.json"), artifact(isoAgoMs(30 * 60_000), "Young land request"));
	const deliveredAt = isoAgoMs(2 * 3_600_000);
	writeFileSync(join(pending, "delivered.json"), artifact(deliveredAt, "Old already sent"));
	plantArchive(archive, "/proj/a", "Old already sent", new Date(Date.now() - 3_600_000).toISOString());
	writeFileSync(join(pending, "stale.json"), artifact(isoAgoMs(80 * 3_600_000), "Ancient request"));

	const first = runTick(pending, archive, stub);
	expect(first.replayed).toEqual(["young.json"]);
	expect(first.discarded).toEqual([
		{ artifact: "delivered.json", reason: "delivered" },
		{ artifact: "stale.json", reason: "stale" },
	]);
	expect(existsSync(join(pending, "young.sent.json"))).toBe(true);
	expect(existsSync(join(pending, "delivered.discarded.json"))).toBe(true);
	expect(existsSync(join(pending, "stale.discarded.json"))).toBe(true);

	const second = runTick(pending, archive, stub);
	expect(second.replayed).toEqual([]);
	expect(second.discarded).toEqual([]);
	expect(second.unsent_count).toBe(0);
}, fixtureDeadlineS(180) * 1000);

test("AMREPLAY1-report: counts, oldest age, P1 old, no P1 fresh", () => {
	const { pending, archive, stub } = setup();
	writeFileSync(join(pending, "fresh-a.json"), artifact(isoAgoMs(20 * 60_000), "Fresh one"));
	writeFileSync(join(pending, "fresh-b.json"), artifact(isoAgoMs(40 * 60_000), "Fresh two"));
	const listed = runTick(pending, archive, stub, ["--list-only"]);
	expect(listed.unsent_count).toBe(2);
	expect(listed.oldest_age_hours).toBeGreaterThan(0.5);
	expect(listed.oldest_age_hours).toBeLessThan(1);
	expect(listed.p1).toBe(false);
	expect(listed.replayed).toEqual([]);

	writeFileSync(join(pending, "old.json"), artifact(isoAgoMs(2 * 3_600_000), "Old waiting"));
	const withOld = runTick(pending, archive, stub, ["--list-only"]);
	expect(withOld.unsent_count).toBe(3);
	expect(withOld.oldest_age_hours).toBeGreaterThan(1);
	expect(withOld.p1).toBe(true);
}, fixtureDeadlineS(180) * 1000);

test("AMREPLAY1 tick step: skips without healthy am, maps replay output, never throws", () => {
	const skipped = checkAmReplay("/nonexistent-state", false, { run: () => { throw new Error("must not run"); } });
	expect(skipped.status).toBe("SKIPPED-UNHEALTHY");
	const report = { schema_version: "am-replay-report.v1", unsent_count: 1, oldest_age_hours: 2.5,
		replayed: ["a.json"], discarded: [], held: [], errors: [], p1: true };
	const replayed = checkAmReplay("/nonexistent-state", true, {
		run: () => ({ code: 0, stdout: JSON.stringify(report), stderr: "" }),
	});
	expect(replayed.status).toBe("REPLAYED");
	expect(replayed.unsentCount).toBe(1);
	expect(replayed.p1).toBe(true);
	const clean = checkAmReplay("/nonexistent-state", true, {
		run: () => ({ code: 0, stdout: JSON.stringify({ ...report, unsent_count: 0, oldest_age_hours: 0, replayed: [], p1: false }), stderr: "" }),
	});
	expect(clean.status).toBe("CLEAN");
	const broken = checkAmReplay("/nonexistent-state", true, {
		run: () => ({ code: 0, stdout: "not json", stderr: "" }),
	});
	expect(broken.status).toBe("UNKNOWN");
	const throwing = checkAmReplay("/nonexistent-state", true, {
		run: () => { throw new Error("spawn exploded"); },
	});
	expect(throwing.status).toBe("UNKNOWN");
}, fixtureDeadlineS(60) * 1000);
