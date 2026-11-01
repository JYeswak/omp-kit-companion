import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

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
		// The transition's unrelated replay/handoff admission is out of scope here.
		writeFileSync(join(scripts, "br-update-lint.py"), "raise SystemExit(0)\n");
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
		for (const reason of ["DONE k-pub evidence", "export 0000000000000000000000000000000000000000"]) {
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
	} finally {
		scratch.cleanup();
	}
}, CASE_BUDGET_MS);
