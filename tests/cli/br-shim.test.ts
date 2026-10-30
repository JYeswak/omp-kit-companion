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
		for (const module of ["kitlib_run.py", "pysafe.py"]) {
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
			const check = 'if len(cut) != 1 or cut[0]["blocking"] != (cut[0]["code"] != "CLAIM_CUT_ADMITTED"):\n    raise ValueError("claim authority did not return one consistent cut adjudication")';
			if (!source.includes(check)) throw new Error("CUTCLAIM1 consistency mutation did not match");
			source = source.replace(check, "");
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
	expect(allowed.rc).toBe(0);
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
		expect(result.rc).toBe(4);
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
