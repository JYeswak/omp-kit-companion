import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { createHash } from "node:crypto";
import { nativeBr } from "./lib/native-br.ts";
import { unlinkSync } from "node:fs";
import { callerScratchRoot } from "../../src/runtime.ts";

const root = resolve(import.meta.dir, "../..");
const shimSource = readFileSync(join(root, "scripts/br-shim.sh"), "utf8");
const decoder = new TextDecoder();
// Admission tests are not latency benchmarks. Each case owns at most two 15s
// subprocesses plus their bounded reap and fixture cleanup; the file gate is unchanged.
const CASE_BUDGET_MS = 40_000;

type Scenario = {
	id?: string;
	extraIds?: string[];
	claimArgs?: string[];
	explicitDb?: boolean;
	disableCheck?: boolean;
	disableConsistency?: boolean;
	authority?: "source" | "failed" | "missing" | "stale" | "nonblocking-refusal" | "blocking-admitted" | "duplicate";
	config?: "cut" | "malformed" | "missing" | "default-missing" | "unlisted" | "no-milestone";
	labels?: string[];
};

/** Real shell bridge and real source CLI; only external tracker and mail services are fixtures. */
async function claim(options: Scenario = {}) {
	const scratch = ownedTmp("cutclaim-shell-test");
	try {
		const home = join(scratch.path, "home");
		const project = join(scratch.path, "tracker");
		const decoy = join(scratch.path, "unrelated-tracker");
		const release = join(scratch.path, "release");
		const bin = join(scratch.path, "bin");
		for (const path of [home, join(project, ".beads"), join(decoy, ".beads"), join(release, "scripts"), join(release, "bin"), bin]) {
			mkdirSync(path, { recursive: true });
		}
		for (const module of ["kitlib_run.py", "pysafe.py", "claim_verdict.py"]) {
			copyFileSync(join(root, "scripts", module), join(release, "scripts", module));
		}
		// Closed PATH prevents a standalone-Bun fallback; this fixture's authority loads the real source CLI.
		for (const utility of ["dirname", "basename", "python3"]) {
			const executable = Bun.which(utility);
			if (!executable) throw new Error(`CUTCLAIM1 fixture requires ${utility}`);
			symlinkSync(executable, join(bin, utility));
		}
		let source = shimSource;
		if (options.disableCheck) {
			const start = source.indexOf("# NEEDSDIRCLAIM1 / CUTCLAIM1:");
			const end = source.indexOf("# REPLAYABLE1 claim/review gate", start);
			if (start < 0 || end <= start) throw new Error("CUTCLAIM1 disabled-check mutation did not match");
			source = source.slice(0, start) + source.slice(end);
		}
		if (options.disableConsistency) {
			const verifier = join(release, "scripts/claim_verdict.py");
			const verdictSource = readFileSync(verifier, "utf8");
			const check = '    if len(cut) != 1 or cut[0]["blocking"] != (cut[0]["code"] != "CLAIM_CUT_ADMITTED"):\n        raise ValueError("claim authority did not return one consistent cut adjudication")';
			if (!verdictSource.includes(check)) throw new Error("CUTCLAIM1 consistency mutation did not match");
			writeFileSync(verifier, verdictSource.replace(check, ""));
		}
		const shim = join(release, "scripts/br-shim.sh");
		writeFileSync(shim, source);
		const mutations = join(scratch.path, "mutations.jsonl");
		const rows = ["k-1", "k-2"].map(id => ({
			id, title: `Claim ${id}`, status: "open", assignee: null,
			labels: options.labels ?? [], dependencies: [], updated_at: "2026-10-30T00:00:00Z",
			acceptance_criteria: "- [ ] [a] [build] claim path works `true` -> rc 0; planted negative: out-of-cut claim refused",
		}));
		const trackerData = join(scratch.path, "beads.json");
		writeFileSync(trackerData, JSON.stringify(rows));
		const realBr = join(bin, "br");
		writeFileSync(realBr, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const dbIndex = args.indexOf("--db");
const database = dbIndex < 0 ? process.env.BEADS_DB : args[dbIndex + 1];
if (database !== process.env.CUTCLAIM_TRACKER_DB) {
  console.error("wrong tracker database: " + database);
  process.exit(9);
}
if (dbIndex >= 0) args.splice(dbIndex, 2);
const rows = JSON.parse(readFileSync(process.env.CUTCLAIM_TRACKER_DATA, "utf8"));
if (args[0] === "show") {
  const bead = rows.find(row => row.id === args[1]);
  if (!bead) process.exit(2);
  console.log(JSON.stringify(bead));
} else if (args[0] === "list") {
  console.log(JSON.stringify(args.includes("--assignee") ? [] : rows));
} else if (args[0] === "dep" && args[1] === "list") {
  console.log("[]");
} else if (args[0] === "where") {
  console.log("database: " + database);
} else if (args[0] === "update" && args.includes("--claim")) {
  appendFileSync(process.env.CUTCLAIM_MUTATIONS, JSON.stringify({ id: args[1], database }) + "\\n");
} else {
  console.error("unexpected tracker command " + JSON.stringify(args));
  process.exit(8);
}
`, { mode: 0o755 });
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"CutClaimShellFixture"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		const authority = options.authority ?? "source";
		if (authority !== "missing") {
			// The installed-layout launcher executes C's actual CLI, not an echoed verdict.
			// Alter only real native findings to emulate stale or malformed authorities.
			const alteredLauncher = ["stale", "nonblocking-refusal", "blocking-admitted", "duplicate"].includes(authority) ? `#!${process.execPath}
import { run } from ${JSON.stringify(join(root, "src/kitlib/run.ts"))};
const result = await run([process.execPath, ${JSON.stringify(join(root, "src/cli.ts"))}, ...process.argv.slice(2)],
  { deadline_s: 30, cwd: process.cwd(), env: { ...process.env }, max_output_bytes: 4 * 1024 * 1024 });
if (result.timed_out || result.truncated || ![0, 1].includes(result.rc)) {
  throw new Error("real preflight fixture failed: " + new TextDecoder().decode(result.stderr));
}
const doc = JSON.parse(new TextDecoder().decode(result.stdout));
const cutCodes = ["CLAIM_CUT_ADMITTED", "CLAIM_OUT_OF_CUT", "CLAIM_CUT_UNKNOWN"];
const variant = ${JSON.stringify(authority)};
let findings = doc.data.findings;
if (variant === "stale") findings = findings.filter(finding => !cutCodes.includes(finding.code));
else if (variant === "duplicate") findings = [...findings, ...findings.filter(finding => cutCodes.includes(finding.code))];
else findings = findings.map(finding => cutCodes.includes(finding.code)
  ? { ...finding, blocking: variant === "blocking-admitted" } : finding);
doc.data.findings = findings;
doc.data.blocking = findings.filter(finding => finding.blocking).length;
doc.ok = doc.data.blocking === 0;
doc.data.overall = doc.ok ? "OK" : "FINDINGS";
console.log(JSON.stringify(doc));
process.exitCode = doc.ok ? 0 : 1;
` : "";
			const launcher = authority === "failed"
				? `#!${process.execPath}\nconsole.error("native authority unavailable"); process.exitCode = 7;\n`
				: alteredLauncher || `#!${process.execPath}\nimport { runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`;
			writeFileSync(join(release, "bin/omp-kit"), launcher, { mode: 0o755 });
		}
		const config = join(scratch.path, "fleet-watch.json");
		if (options.config === "malformed") writeFileSync(config, "{not JSON");
		else if (options.config !== "missing") {
			writeFileSync(config, JSON.stringify({ sessions: [
				{ repo: decoy, milestone: { epic: "decoy", due: "2026-11-01", declaredAt: "2026-10-30T00:00:00Z", pinned: ["k-2"] } },
				{ repo: options.config === "unlisted" ? join(scratch.path, "other-project") : project, ...(options.config === "no-milestone" ? {} : {
					milestone: { epic: "cut", due: "2026-11-01", declaredAt: "2026-10-30T00:00:00Z", pinned: ["k-1"] },
				}) },
			] }));
		}
		const db = join(project, ".beads/beads.db");
		const id = options.id ?? "k-2";
		const env = { ...process.env };
		delete env.OMP_KIT_FLEET_WATCH_CONFIG;
		const result = await run(["/bin/sh", shim, ...(options.explicitDb ? ["--db", db] : []), "update", id, ...(options.extraIds ?? []), "--claim", ...(options.claimArgs ?? [])], {
			cwd: decoy, deadline_s: 15,
			env: { ...env, HOME: home, PATH: bin, AGENT_NAME: "CutClaimShellFixture",
				XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
				...(options.config === "default-missing" ? {} : { OMP_KIT_FLEET_WATCH_CONFIG: config }), BR_REAL: realBr,
				BEADS_DB: options.explicitDb ? join(decoy, ".beads/beads.db") : db,
				CUTCLAIM_TRACKER_DB: db, CUTCLAIM_TRACKER_DATA: trackerData, CUTCLAIM_MUTATIONS: mutations,
				TMPDIR: scratch.path },
		});
		return { rc: result.rc, timedOut: result.timed_out,
			output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
			mutations: existsSync(mutations) ? readFileSync(mutations, "utf8") : "" };
	} finally {
		scratch.cleanup();
	}
}

test("CUTCLAIM1 actual shim admits k-1 and refuses k-2 on cut[k-1]", async () => {
	const denied = await claim();
	expect(denied.timedOut).toBe(false);
	expect(denied.rc).toBe(4);
	expect(denied.output).toContain("CLAIM_OUT_OF_CUT");
	expect(denied.output).toContain("k-1");
	expect(denied.mutations).toBe("");
	const allowed = await claim({ id: "k-1" });
	expect(allowed.timedOut).toBe(false);
	expect(allowed.rc).toBe(0);
	expect(allowed.mutations).toContain('"id":"k-1"');
}, CASE_BUDGET_MS);

test("CUTCLAIM1 explicit --db binds the actual tracker rather than cwd or the first session", async () => {
	const denied = await claim({ explicitDb: true });
	expect(denied.rc).toBe(4);
	expect(denied.output).toContain("CLAIM_OUT_OF_CUT");
	expect(denied.mutations).toBe("");
	const allowed = await claim({ explicitDb: true, id: "k-1" });
	expect(allowed.rc, allowed.output).toBe(0);
	expect(allowed.mutations).toContain('"id":"k-1"');
}, CASE_BUDGET_MS);

test("CUTCLAIM1 disabled-check mutant admits the same forbidden claim", async () => {
	const denied = await claim();
	expect(denied.rc).toBe(4);
	expect(denied.output).toContain("CLAIM_OUT_OF_CUT");
	const mutant = await claim({ disableCheck: true });
	expect(mutant.rc).toBe(0);
	expect(mutant.mutations).toContain('"id":"k-2"');
}, CASE_BUDGET_MS);

for (const authority of ["missing", "failed", "stale"] as const) {
	test(`CUTCLAIM1 ${authority} native authority cannot silently bypass admission`, async () => {
		const result = await claim({ authority, id: "k-1" });
		expect(result.rc).toBe(4);
		expect(result.output).toContain("CLAIM_CUT_UNKNOWN");
		expect(result.mutations).toBe("");
	}, CASE_BUDGET_MS);
}

test("CUTCLAIM1 malformed nonblocking refusal is rejected and disabling consistency exposes the bypass", async () => {
	const denied = await claim({ authority: "nonblocking-refusal" });
	expect(denied.rc).toBe(4);
	expect(denied.output).toContain("CLAIM_CUT_UNKNOWN");
	expect(denied.mutations).toBe("");
	const mutant = await claim({ authority: "nonblocking-refusal", disableConsistency: true });
	expect(mutant.rc).toBe(0);
	expect(mutant.mutations).toContain('"id":"k-2"');
}, CASE_BUDGET_MS);

for (const authority of ["blocking-admitted", "duplicate"] as const) {
	test(`CUTCLAIM1 ${authority} cut verdict is malformed and cannot admit`, async () => {
		const result = await claim({ authority, id: "k-1" });
		expect(result.rc, result.output).toBe(4);
		expect(result.output).toContain("CLAIM_CUT_UNKNOWN");
		expect(result.mutations).toBe("");
	}, CASE_BUDGET_MS);
}

test("CUTCLAIM1 multi-ID claim cannot forward an off-cut second target", async () => {
	const result = await claim({ id: "k-1", extraIds: ["k-2"] });
	expect(result.rc).toBe(4);
	expect(result.output).toContain("CLAIM_CUT_UNKNOWN");
	expect(result.output).toContain("multi-ID");
	expect(result.mutations).toBe("");
}, CASE_BUDGET_MS);

for (const config of ["missing", "malformed"] as const) {
	test(`CUTCLAIM1 ${config} configured cut input fails closed through actual shim`, async () => {
		const result = await claim({ config, id: "k-1" });
		expect(result.rc).toBe(4);
		expect(result.output).toContain("CLAIM_CUT_UNKNOWN");
		expect(result.mutations).toBe("");
	}, CASE_BUDGET_MS);
}

for (const config of ["default-missing", "unlisted", "no-milestone"] as const) {
	test(`CUTCLAIM1 ${config} admits an outsider without a pillar through the actual shim`, async () => {
		const allowed = await claim({ config });
		expect(allowed.timedOut).toBe(false);
		expect(allowed.rc).toBe(0);
		expect(allowed.mutations).toContain('"id":"k-2"');
	}, CASE_BUDGET_MS);
}

test("CUTCLAIM1 value flags do not become extra claim targets", async () => {
	const result = await claim({ id: "k-1", claimArgs: ["-p", "1", "--description", "ordinary claim metadata", "--add-label", "gate"] });
	expect(result.rc).toBe(0);
	expect(result.mutations).toContain('"id":"k-1"');
}, CASE_BUDGET_MS);
async function publicationGit(repo: string, args: string[]): Promise<string> {
	const result = await run(["git", "-C", repo, ...args], {
		deadline_s: 30, cwd: repo, env: { ...process.env }, max_output_bytes: 1024 * 1024,
	});
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`);
	return decoder.decode(result.stdout).trim();
}

test("PUBLISHGATE1 actual br shim refuses transitions until origin/main contains cited commits", async () => {
	const scratch = ownedTmp("publish-gate-shim");
	try {
		const repo = join(scratch.path, "repo");
		const origin = join(scratch.path, "origin.git");
		const bin = join(scratch.path, "bin");
		const scripts = join(scratch.path, "scripts");
		mkdirSync(repo, { recursive: true });
		mkdirSync(bin, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		await publicationGit(scratch.path, ["init", "--bare", origin]);
		await publicationGit(repo, ["init", "-q", "-b", "main"]);
		await publicationGit(repo, ["config", "user.email", "test@invalid.example"]);
		await publicationGit(repo, ["config", "user.name", "Test"]);
		await publicationGit(repo, ["commit", "--no-verify", "--allow-empty", "-m", "published parent"]);
		await publicationGit(repo, ["remote", "add", "origin", origin]);
		await publicationGit(repo, ["push", "--set-upstream", "origin", "main"]);
		await publicationGit(repo, ["commit", "--no-verify", "--allow-empty", "-m", "unpublished candidate", "-m", "Bead: k-pub", "-m", "Agent: Builder"]);
		const sha = await publicationGit(repo, ["rev-parse", "HEAD"]);
		const db = join(repo, ".beads/beads.db");
		mkdirSync(join(repo, ".beads"), { recursive: true });
		const mutations = join(scratch.path, "mutations.jsonl");
		const shim = join(scripts, "br-shim.sh");
		const guard = join(scripts, "close-guard.sh");
		writeFileSync(shim, readFileSync(join(root, "scripts/br-shim.sh"), "utf8"), { mode: 0o755 });
		writeFileSync(guard, readFileSync(join(root, "scripts/close-guard.sh"), "utf8"), { mode: 0o755 });
		writeFileSync(join(scripts, "br-update-lint.py"), `#!/usr/bin/env python3
import os, runpy, sys
real = ${JSON.stringify(join(root, "scripts/br-update-lint.py"))}
if sys.argv[1:2] == ["publication-citations"]:
    sys.path.insert(0, os.path.dirname(real))
    sys.argv[0] = real
    runpy.run_path(real, run_name="__main__")
else:
    raise SystemExit(0)
`, { mode: 0o755 });
		const fakeBr = join(bin, "br");
		writeFileSync(fakeBr, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--db") args.splice(0, 2);
if (args[0] === "show" && args[1] === "k-pub") {
  console.log(JSON.stringify({ id: "k-pub", assignee: "Builder", updated_at: "2026-11-01T00:00:00Z" }));
} else if (args[0] === "update" || args[0] === "close") {
  appendFileSync(process.env.PUBLISH_MUTATIONS, JSON.stringify(args) + "\\n");
} else {
  console.error("unexpected br command " + JSON.stringify(args));
  process.exit(2);
}
`, { mode: 0o755 });
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"Verifier"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		const runShim = async (args: string[]) => {
			const result = await run(["sh", shim, ...args], {
				deadline_s: 30, cwd: repo, env: {
					...process.env, AGENT_NAME: "Verifier", BEADS_DB: db, BR_REAL: fakeBr,
					PUBLISH_MUTATIONS: mutations,
					PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				}, max_output_bytes: 1024 * 1024,
			});
			return { rc: result.rc, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
		};
		const update = (reason: string) => runShim(["update", "k-pub", "--status", "in_review", "--transition-comment", reason]);
		const close = (reason: string) => runShim(["close", "k-pub", "--reason", reason]);
		for (const rejected of [
			await update(`DONE k-pub ${sha} evidence`),
			await close(`Lesson: none\nexport ${sha}`),
		]) {
			expect(rejected.rc, rejected.output).toBe(4);
			expect(rejected.output).toContain("NOT_PUBLISHED");
			expect(rejected.output).toContain(sha);
			expect(rejected.output).toContain("git_converge.py --push");
		}
		expect(existsSync(mutations)).toBe(false);
		for (const reason of ["export 0000000000000000000000000000000000000000"]) {
			const rejected = await update(reason);
			expect(rejected.rc, rejected.output).toBe(4);
			expect(rejected.output).toContain("NOT_PUBLISHED");
			expect(rejected.output).toContain("UNKNOWN");
		}
		await publicationGit(repo, ["push", "origin", "main"]);
		for (const admitted of [
			await update(`DONE k-pub ${sha} evidence`),
			await close(`Lesson: none\nexport ${sha}`),
		]) {
			expect(admitted.rc, admitted.output).toBe(0);
			expect(admitted.output).toContain("close-guard: OK");
		}
		const beforeFetchFailure = readFileSync(mutations, "utf8");
		await publicationGit(repo, ["remote", "set-url", "origin", join(scratch.path, "missing.git")]);
		const fetchFailure = await update(`DONE k-pub ${sha} evidence`);
		expect(fetchFailure.rc, fetchFailure.output).toBe(4);
		expect(fetchFailure.output).toContain("NOT_PUBLISHED");
		expect(fetchFailure.output).toContain("UNKNOWN");
		expect(readFileSync(mutations, "utf8")).toBe(beforeFetchFailure);
		const beforeNoCitation = readFileSync(mutations, "utf8");
		const noCitationClose = await close("Lesson: none");
		expect(noCitationClose.rc, noCitationClose.output).toBe(0);
		expect(noCitationClose.output).toContain("close-guard: OK");
		const afterNoCitation = readFileSync(mutations, "utf8");
		expect(afterNoCitation.slice(beforeNoCitation.length)).toBe(`${JSON.stringify(["close", "k-pub", "--reason", "Lesson: none", "--actor", "Verifier"])}\n`);
	} finally {
		scratch.cleanup();
	}
}, CASE_BUDGET_MS);

const HANDOFF_AC = "- [x] [a] [build] preserve the source payload; reject a missing payload `sh tests/replay.sh` -> rc 0";

/** Native Git and tracker state; only the optional external mail transport is a protocol fixture. */
async function handoffRepo(companion = false) {
	const scratch = ownedTmp("handoff-repo-native");
	const tracker = join(scratch.path, "tracker");
	const code = join(scratch.path, "source @ quoted'path");
	const bin = join(scratch.path, "bin");
	const origin = join(scratch.path, "origin.git");
	const backend = nativeBr();
	for (const path of [tracker, code, bin]) mkdirSync(path);
	const env: Record<string, string> = {
		HOME: scratch.path, TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
		XDG_CONFIG_HOME: join(scratch.path, "config"), PATH: `${bin}:${process.env.PATH ?? ""}`,
		AGENT_NAME: "HandoffAuthor", BR_REAL: backend, PYTHONDONTWRITEBYTECODE: "1",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
	};
	const checked = async (argv: string[], cwd = tracker) => {
		const result = await run(argv, { cwd, env, deadline_s: 30, max_output_bytes: 4 << 20 });
		if (result.rc !== 0 || result.timed_out || result.truncated) {
			throw new Error(`${argv.join(" ")}: ${result.rc}\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
		}
		return decoder.decode(result.stdout).trim();
	};
	try {
		symlinkSync(backend, join(bin, "br"));
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"HandoffAuthor"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		await checked(["git", "init", "--bare", "-q", "--template=", origin]);
		for (const repo of [tracker, code]) {
			await checked(["git", "init", "-q", "--template=", "-b", "main", repo]);
			await checked(["git", "-C", repo, "config", "user.name", "Fixture"]);
			await checked(["git", "-C", repo, "config", "user.email", "fixture@invalid.example"]);
			mkdirSync(join(repo, "tests"));
			writeFileSync(join(repo, "payload.txt"), "preserved\n");
			writeFileSync(join(repo, "tests/replay.sh"), "#!/bin/sh\ntest -f payload.txt\n");
		}
		if (companion) {
			mkdirSync(join(code, "scripts"));
			writeFileSync(join(code, "scripts/fresh-gate.sh"), "#!/bin/sh\nexit 97\n");
		}
		await checked(["git", "-C", code, "add", "payload.txt", "tests", ...(companion ? ["scripts"] : [])]);
		await checked(["git", "-C", code, "commit", "-qm", "owned source fixture", "-m", "Agent: HandoffAuthor"]);
		const commit = await checked(["git", "-C", code, "rev-parse", "HEAD"]);
		await checked(["git", "-C", code, "remote", "add", "origin", origin]);
		await checked(["git", "-C", code, "push", "-q", "--set-upstream", "origin", "main"]);
		const db = join(tracker, ".beads/beads.db");
		const br = (args: string[]) => checked([backend, "--db", db, "--no-auto-import", "--no-auto-flush", ...args]);
		await br(["init", "--prefix", "hh", "--actor", "HandoffAuthor"]);
		const beads = ["hh-owned", "hh-other"].map(id => ({
			id, title: "Preserve native source handoff", issue_type: "task", priority: 2,
			status: "in_progress", assignee: "HandoffAuthor", created_by: "HandoffAuthor",
			created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
			labels: ["fixture"], dependencies: [], comments: [],
			description: "WHAT: preserve the exact source handoff. WHY: a missing observation must refuse without changing native state.",
			acceptance_criteria: HANDOFF_AC,
		}));
		writeFileSync(join(tracker, ".beads/issues.jsonl"), beads.map(b => JSON.stringify(b)).join("\n") + "\n");
		await br(["sync", "--import-only", "--actor", "HandoffAuthor"]);
		mkdirSync(join(tracker, ".omp"));
		writeFileSync(join(tracker, ".omp/pregrade.json"), JSON.stringify({ required: false, hint: "sh tests/replay.sh" }));
		const recordDir = join(env.XDG_STATE_HOME, "omp-kit/pregrade");
		mkdirSync(recordDir, { recursive: true });
		const recordPath = join(recordDir, "hh-owned.json");
		const pregrade = (changes: Record<string, unknown> = {}) => {
			// Prior-observation protocol input, not a claim of an actual non-author review.
			writeFileSync(recordPath, JSON.stringify({
				schema: "omp-kit.pregrade.v1", bead: "hh-owned", repo: tracker,
				author: "HandoffAuthor", grader: "HandoffReviewer", at: new Date().toISOString(),
				candidate_commit: commit, verdict: "PASS",
				ac_sha256: createHash("sha256").update(HANDOFF_AC.replace("[x]", "[ ]")).digest("hex"),
				items: [{ ac: "AC1", phase: "build", status: "PASS" }], ...changes,
			}));
		};
		const shim = (args: string[], input?: string) => run(["sh", join(root, "scripts/br-shim.sh"), "--db", db, ...args], {
			cwd: code, env, deadline_s: 30, max_output_bytes: 4 << 20,
			...(input === undefined ? {} : { stdin: input }),
		});
		const status = async (id = "hh-owned") => {
			const values = JSON.parse(await br(["show", id, "--json"]));
			return (Array.isArray(values) ? values[0] : values).status;
		};
		const comments = async () => JSON.parse(await br(["comments", "list", "hh-owned", "--json"]));
		const green = () => {
			const dir = join(code, ".git/omp-kit");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "fresh-gate-runs.jsonl"), JSON.stringify({
				version: 2, commit, rc: 0, evidence: { complete: true },
			}) + "\n");
		};
		return { scratch, tracker, code, commit, recordPath, pregrade, shim, status, comments, green, checked, br, env,
			done: `DONE ${code}@${commit}: exact native source observation` };
	} catch (error) {
		scratch.cleanup();
		throw error;
	}
}

test("HANDOFFREPO1 exact non-companion pregrade admits the real native author handoff", async () => {
	const f = await handoffRepo();
	try {
		f.pregrade();
		const result = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(result.rc, decoder.decode(result.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 missing observation refuses without mutation and names the declared existing repo check", async () => {
	const f = await handoffRepo();
	try {
		const result = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		const out = decoder.decode(result.stderr);
		expect(result.rc).toBe(4);
		expect(out).toContain("HANDOFF_UNGATED");
		expect(out).toContain("sh tests/replay.sh");
		expect(out).not.toContain("sh scripts/fresh-gate.sh");
		expect(await f.status()).toBe("in_progress");
		const command = out.slice(out.lastIndexOf("run: ") + 5).trim();
		const declaredCwd = command.slice("cd ".length, command.indexOf(" && "));
		const repaired = await run(["sh", "tests/replay.sh"], { cwd: declaredCwd, env: f.env, deadline_s: 15 });
		expect(repaired.rc, decoder.decode(repaired.stderr)).toBe(0);
		unlinkSync(join(f.tracker, "payload.txt"));
		const negative = await run(["sh", "tests/replay.sh"], { cwd: declaredCwd, env: f.env, deadline_s: 15 });
		expect(negative.rc).toBe(1);
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 pregrade must bind the candidate, tracker, acceptance, non-author and passing build outcomes", async () => {
	const f = await handoffRepo();
	try {
		for (const changes of [
			{ candidate_commit: "0".repeat(40) }, { repo: f.code }, { ac_sha256: "changed" },
			{ grader: "HandoffAuthor" }, { items: [] },
		]) {
			f.pregrade(changes);
			const result = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
			expect(result.rc).toBe(4);
			expect(await f.status()).toBe("in_progress");
		}
		f.pregrade();
		const control = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(control.rc, decoder.decode(control.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 companion still requires its ledger even if its committed script is missing from the worktree", async () => {
	const f = await handoffRepo(true);
	try {
		f.pregrade();
		unlinkSync(join(f.code, "scripts/fresh-gate.sh"));
		const refused = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(refused.rc).toBe(4);
		expect(decoder.decode(refused.stderr)).toContain("sh scripts/fresh-gate.sh");
		expect(await f.status()).toBe("in_progress");
		f.green();
		const control = await f.shim(["update", "hh-owned", "--status", "in_review", "--transition-comment", f.done]);
		expect(control.rc, decoder.decode(control.stderr)).toBe(0);
		expect(await f.status()).toBe("in_review");
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 native positional, file and stdin DONE comments all use the same exact pregrade", async () => {
	const f = await handoffRepo();
	try {
		const file = join(f.scratch.path, "done.txt");
		writeFileSync(file, f.done);
		for (const [args, input] of [
			[["--message", f.done], undefined],
			[["--file", file], undefined],
			[["-f", "-"], f.done],
		] as const) {
			if (existsSync(f.recordPath)) unlinkSync(f.recordPath);
			const before = await f.comments();
			const refused = await f.shim(["comments", "add", "hh-owned", ...args], input);
			expect(refused.rc).toBe(4);
			expect(await f.comments()).toEqual(before);
			f.pregrade();
			const accepted = await f.shim(["comments", "add", "hh-owned", ...args], input);
			expect(accepted.rc, decoder.decode(accepted.stderr)).toBe(0);
			const after = await f.comments();
			expect(after.at(-1).text).toBe(f.done);
			expect(await f.status()).toBe("in_progress");
		}
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 one pregrade cannot admit an ambiguous multiple-bead update", async () => {
	const f = await handoffRepo();
	try {
		f.pregrade();
		const result = await f.shim(["update", "hh-owned", "hh-other", "--status", "in_review", "--transition-comment", f.done]);
		expect(result.rc).toBe(4);
		expect(await f.status()).toBe("in_progress");
		expect(await f.status("hh-other")).toBe("in_progress");
	} finally { f.scratch.cleanup(); }
}, 120_000);

test("HANDOFFREPO1 pregrade binds prospective acceptance in the same native update", async () => {
	const f = await handoffRepo();
	try {
		const next = HANDOFF_AC.replace("source payload", "exact source payload");
		f.pregrade();
		const args = ["update", "hh-owned", "--acceptance", next, "--status", "in_review", "--transition-comment", f.done];
		const refused = await f.shim(args);
		expect(refused.rc).toBe(4);
		const before = JSON.parse(await f.br(["show", "hh-owned", "--json"]))[0];
		expect(before.status).toBe("in_progress");
		expect(before.acceptance_criteria).toBe(HANDOFF_AC);
		f.pregrade({ ac_sha256: createHash("sha256").update(next.replace("[x]", "[ ]")).digest("hex") });
		const accepted = await f.shim(args);
		expect(accepted.rc, decoder.decode(accepted.stderr)).toBe(0);
		const after = JSON.parse(await f.br(["show", "hh-owned", "--json"]))[0];
		expect(after.status).toBe("in_review");
		expect(after.acceptance_criteria).toBe(next);
	} finally { f.scratch.cleanup(); }
}, 120_000);

type HermeticFixture = {
	path: string;
	database: string;
	env: Record<string, string>;
	backend: string;
	cleanup(): void;
};

function hermeticFixture(): HermeticFixture {
	const fixtureRoot = join(root, "var/agent-tmp");
	mkdirSync(fixtureRoot, { recursive: true });
	const scratch = ownedTmp("shim-hermetic-test", { root: fixtureRoot });
	const bin = join(scratch.path, "bin");
	mkdirSync(bin);
	// Only the external mail service is unavailable; the tracker is native br.
	writeFileSync(join(bin, "am"), "#!/bin/sh\nprintf 'fixture project is not registered\\n' >&2\nexit 2\n", { mode: 0o755 });
	const backend = nativeBr();
	return {
		path: scratch.path, database: join(scratch.path, ".beads/beads.db"), backend,
		env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: scratch.path,
			TMPDIR: scratch.path, XDG_STATE_HOME: join(scratch.path, "state"),
			OMP_KIT_CASE_CWD: root, BR_REAL: backend },
		cleanup: () => scratch.cleanup(),
	};
}

async function hermeticCall(fixture: HermeticFixture, args: string[], options: {
	shim?: string; env?: Record<string, string>; native?: boolean; implicit?: boolean;
} = {}) {
	const result = await run(options.native
		? [fixture.backend, "--db", fixture.database, ...args]
		: ["/bin/sh", options.shim ?? join(root, "scripts/br-shim.sh"), ...(options.implicit ? [] : ["--db", fixture.database]), ...args],
	{ cwd: fixture.path, env: options.env ?? fixture.env, deadline_s: 15, max_output_bytes: 1024 * 1024 });
	return { rc: result.rc, timedOut: result.timed_out, truncated: result.truncated,
		stdout: decoder.decode(result.stdout), output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

function fixtureOwnerFields(text: string): Record<string, string> {
	return Object.fromEntries(text.split("\n").filter(Boolean).map(line => {
		const separator = line.indexOf("=");
		if (separator < 0) throw new Error("Expected kitlib's key=value owner fixture");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
}

test.each(["identity-unset", "unregistered-actor", "json-owner"] as const)(
	"SHIMHERMETIC1 native init/create work for an owned %s fixture", async (mode: "identity-unset" | "unregistered-actor" | "json-owner") => {
		const fixture = hermeticFixture();
		try {
			if (mode === "json-owner") {
				const owner = join(fixture.path, ".owner");
				writeFileSync(owner, `\ufeff${JSON.stringify(fixtureOwnerFields(readFileSync(owner, "utf8")))}\ufeff`);
			}
			expect(callerScratchRoot(fixture.path, root)).toBe(fixture.path);
			const env = mode === "unregistered-actor" ? { ...fixture.env, AGENT_NAME: "UnregisteredPane" } : fixture.env;
			const initialized = await hermeticCall(fixture, ["init", "--prefix", "hx"], { env });
			expect(initialized.output).not.toContain("BR_SHIM_IDENTITY_REQUIRED");
			expect(initialized.rc).toBe(0);
			expect(initialized.timedOut || initialized.truncated).toBe(false);
			const created = await hermeticCall(fixture, ["create", "Owned native fixture task", "--actor", "FixtureAuthor", "--json"], { env });
			expect(created.rc).toBe(0);
			expect(created.timedOut || created.truncated).toBe(false);
			const id = JSON.parse(created.stdout).id;
			expect(id).toStartWith("hx-");
			const observed = await hermeticCall(fixture, ["show", id, "--json"], { native: true });
			expect(observed.rc).toBe(0);
			const row = JSON.parse(observed.stdout);
			const issue = Array.isArray(row) ? row[0] : row;
			expect({ id: issue.id, title: issue.title, status: issue.status, author: issue.created_by })
				.toEqual({ id, title: "Owned native fixture task", status: "open", author: "FixtureAuthor" });
		} finally { fixture.cleanup(); }
	}, CASE_BUDGET_MS,
);

test("SHIMHERMETIC1 owner/physical/production negatives preserve the native tracker", async () => {
	const fixture = hermeticFixture();
	const ownerPath = join(fixture.path, ".owner");
	const originalOwner = readFileSync(ownerPath, "utf8");
	try {
		const initialized = await hermeticCall(fixture, ["init", "--prefix", "hx"], { native: true });
		expect(initialized.rc).toBe(0);
		const created = await hermeticCall(fixture, ["create", "Protected native fixture task", "--json"], { native: true });
		expect(created.rc).toBe(0);
		const id = JSON.parse(created.stdout).id;
		const foreign = join(fixture.path, "foreign-workspace");
		mkdirSync(foreign);
		const alias = join(fixture.path, "scratch-alias");
		symlinkSync(fixture.path, alias);
		const savedOwner = join(fixture.path, "saved-owner");
		writeFileSync(savedOwner, originalOwner);
		for (const kind of ["symlink-root", "missing-owner", "foreign-owner", "symlink-owner", "oversize-owner", "numeric-owner-capability", "outside-workspace", "production-root"] as const) {
			let env = fixture.env;
			let database = fixture.database;
			if (kind === "symlink-root") database = join(alias, ".beads/beads.db");
			if (kind === "missing-owner") unlinkSync(ownerPath);
			if (kind === "foreign-owner") writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${foreign}`));
			if (kind === "symlink-owner") { unlinkSync(ownerPath); symlinkSync(savedOwner, ownerPath); }
			if (kind === "oversize-owner") writeFileSync(ownerPath, `${originalOwner}${" ".repeat(4097)}`);
			if (kind === "numeric-owner-capability") {
				writeFileSync(ownerPath, JSON.stringify({ ...fixtureOwnerFields(originalOwner), capability_sha256: Number("1".repeat(64)) }));
				expect(() => callerScratchRoot(fixture.path, root)).toThrow();
			}
			if (kind === "outside-workspace") {
				env = { ...fixture.env, OMP_KIT_CASE_CWD: foreign };
				writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${foreign}`));
			}
			if (kind === "production-root") {
				env = { ...fixture.env, OMP_KIT_CASE_CWD: fixture.path };
				writeFileSync(ownerPath, originalOwner.replace(`repo=${root}`, `repo=${fixture.path}`));
			}
			const before = createHash("sha256").update(readFileSync(fixture.database)).digest("hex");
			const denied = await hermeticCall({ ...fixture, database }, ["comments", "add", id, "-m", "must not reach native storage"], { env });
			expect({ kind, rc: denied.rc, incomplete: denied.timedOut || denied.truncated })
				.toEqual({ kind, rc: 4, incomplete: false });
			expect(denied.output.includes("BR_SHIM_IDENTITY_REQUIRED") || denied.output.includes("BR_SHIM_RESERVATION_UNKNOWN")).toBe(true);
			expect(createHash("sha256").update(readFileSync(fixture.database)).digest("hex")).toBe(before);
			if (existsSync(ownerPath) || kind === "symlink-owner") unlinkSync(ownerPath);
			writeFileSync(ownerPath, originalOwner);
		}
		const observed = await hermeticCall(fixture, ["comments", "list", id, "--json"], { native: true });
		expect(observed.rc).toBe(0);
		expect(JSON.parse(observed.stdout)).toEqual([]);
	} finally {
		if (existsSync(ownerPath)) unlinkSync(ownerPath);
		writeFileSync(ownerPath, originalOwner);
		fixture.cleanup();
	}
}, CASE_BUDGET_MS);

test("SHIMHERMETIC1 an always-false owner predicate loses the same native positive", async () => {
	const fixture = hermeticFixture();
	try {
		expect((await hermeticCall(fixture, ["init", "--prefix", "hx"], { native: true })).rc).toBe(0);
		const release = join(fixture.path, "release");
		mkdirSync(release);
		const shim = join(release, "br-shim.sh");
		copyFileSync(join(root, "scripts/br-shim.sh"), shim);
		const predicate = readFileSync(join(root, "scripts/br-fixture-scope.py"), "utf8");
		const boundary = '    """Fail closed on the physical root, marker, uid and canonical repo binding."""';
		if (!predicate.includes(boundary)) throw new Error("SHIMHERMETIC1 predicate mutation did not match");
		writeFileSync(join(release, "br-fixture-scope.py"), predicate.replace(boundary, `${boundary}\n    return False`));
		const args = ["create", "Paired owner predicate control", "--json"];
		const admitted = await hermeticCall(fixture, args);
		expect(admitted.rc).toBe(0);
		const id = JSON.parse(admitted.stdout).id;
		const before = createHash("sha256").update(readFileSync(fixture.database)).digest("hex");
		const denied = await hermeticCall(fixture, args, { shim });
		expect(denied.rc).toBe(4);
		expect(denied.output).toContain("BR_SHIM_IDENTITY_REQUIRED");
		expect(denied.timedOut || denied.truncated).toBe(false);
		expect(createHash("sha256").update(readFileSync(fixture.database)).digest("hex")).toBe(before);
		const observed = await hermeticCall(fixture, ["list", "--all", "--json"], { native: true });
		expect(observed.rc).toBe(0);
		const listed = JSON.parse(observed.stdout);
		const rows = Array.isArray(listed) ? listed : listed.issues;
		expect(rows.map((row: { id: string; title: string }) => ({ id: row.id, title: row.title })))
			.toEqual([{ id, title: "Paired owner predicate control" }]);
	} finally { fixture.cleanup(); }
}, CASE_BUDGET_MS);

test("SHIMHERMETIC1 actual DB selection preserves explicit, ambient and local fixture bindings", async () => {
	const a = hermeticFixture();
	const b = hermeticFixture();
	try {
		expect((await hermeticCall(a, ["init", "--prefix", "hxa"], { native: true })).rc).toBe(0);
		expect((await hermeticCall(b, ["init", "--prefix", "hxb"], { native: true })).rc).toBe(0);
		const env = { ...a.env, BEADS_DB: b.database };
		const explicit = await hermeticCall(a, ["create", "Explicit A beats ambient B", "--json"], { env });
		expect(explicit.rc).toBe(0);
		expect(JSON.parse(explicit.stdout).id).toStartWith("hxa-");
		const ambient = await hermeticCall(a, ["create", "Ambient B from A cwd", "--json"], { env, implicit: true });
		expect(ambient.rc).toBe(0);
		expect(JSON.parse(ambient.stdout).id).toStartWith("hxb-");
		const local = await hermeticCall(a, ["create", "Local A without an ambient selector", "--json"], { implicit: true });
		expect(local.rc).toBe(0);
		expect(JSON.parse(local.stdout).id).toStartWith("hxa-");
		for (const [fixture, expected] of [[a, ["Explicit A beats ambient B", "Local A without an ambient selector"]],
			[b, ["Ambient B from A cwd"]]] as const) {
			const observed = await hermeticCall(fixture, ["list", "--all", "--json"], { native: true });
			expect(observed.rc).toBe(0);
			const listed = JSON.parse(observed.stdout);
			const rows = Array.isArray(listed) ? listed : listed.issues;
			expect(rows.map((row: { title: string }) => row.title).sort()).toEqual([...expected].sort());
		}
	} finally { a.cleanup(); b.cleanup(); }
}, CASE_BUDGET_MS);
