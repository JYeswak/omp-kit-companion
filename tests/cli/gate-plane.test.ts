import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlywheelHost } from "../fleet-guard/kit-flywheel-host.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = join(kitRoot, "scripts");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const driver = [
	"import json, os, sys",
	"sys.path.insert(0, os.environ['BR_GATEPLANE_SCRIPTS'])",
	"import kitlib_run",
	"result = kitlib_run.run(sys.argv[1:], deadline_s=30, cwd=os.environ['BR_SHIM_PROJECT'], env=dict(os.environ))",
	"print(json.dumps({'rc': result.rc, 'stdout': result.stdout.decode('utf-8', 'replace'), 'stderr': result.stderr.decode('utf-8', 'replace'), 'timed_out': result.timed_out}, separators=(',', ':')))",
].join("\n");

type BrResult = { rc: number | null; stdout: string; stderr: string; timed_out: boolean };

async function runPythonBr(project: string, env: Record<string, string | undefined>, argv: string[]): Promise<BrResult> {
	const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	const outer = await run(["python3", "-c", driver, ...argv], { cwd: project, deadline_s: 45, env: childEnv });
	if (outer.rc !== 0 || outer.timed_out) throw new Error(`Python kitlib runner failed rc=${outer.rc} timeout=${outer.timed_out}: ${decode(outer.stderr)}${decode(outer.stdout)}`);
	return JSON.parse(decode(outer.stdout)) as BrResult;
}

function fixtureBr(rows: Record<string, Record<string, unknown>>): string {
	const cases = Object.entries(rows).map(([id, row]) => `\t\t${id}) printf '%s\\n' '${JSON.stringify(row)}' ;;`).join("\n");
	return `#!/bin/sh\nset -eu\ncase "\${1:-}" in\n\tshow)\n\t\tcase "\${2:-}" in\n${cases}\n\t\t*) exit 2 ;;\n\t\tesac\n\t\t;;\n\tlist) printf '%s\\n' '{"issues":[]}' ;;\n\tupdate) printf '%s\\n' "$*" >> "$BR_GATEPLANE_MARKER" ;;\n\tcreate) printf '%s\\n' "$*" >> "$BR_GATEPLANE_MARKER"; printf '%s\\n' '{"id":"created"}' ;;\n\t*) exit 2 ;;\nesac\n`;
}

test("GATEPLANE1: session-start PATH makes Python br enforce review, claim, and create on owned fixtures", async () => {
	const owned = ownedTmp("gateplane1-test", { bead: "ompkit-fp72.135.3.82" });
	try {
		const base = owned.path;
		const home = join(base, "home");
		const bindir = join(home, ".local", "share", "omp-kit", "agent-bin");
		const project = join(base, "fixture-project");
		const beads = join(project, ".beads");
		const fakebin = join(base, "fakebin");
		const state = join(base, "state");
		const database = join(beads, "beads.db");
		const marker = join(base, "mutations.log");
		const fleetConfig = join(base, "fleet-watch.json");
		const agent = "GateProbe";
		const description = "WHAT: exercise the gate. WHY: catch Python path bypass.";
		const replayable = "- [ ] [a] [build] fixture is readable `true` -> rc 0; planted negative: broken fixture is refused";
		const unreplayable = "- [ ] [a] [build] fixture is valid; planted negative: missing command is refused";
		const now = new Date().toISOString();
		const rows = {
			"review-unticked": { id: "review-unticked", title: "Review fixture", status: "open", priority: 2, issue_type: "task", labels: ["gate"], description, acceptance_criteria: replayable, created_at: now, dependencies: [] },
			"claim-unreplayable": { id: "claim-unreplayable", title: "Claim fixture", status: "open", priority: 2, issue_type: "task", labels: ["gate"], description, acceptance_criteria: unreplayable, created_at: now, dependencies: [] },
		};
		mkdirSync(bindir, { recursive: true });
		mkdirSync(beads, { recursive: true });
		mkdirSync(fakebin, { recursive: true });
		mkdirSync(state, { recursive: true });
		writeFileSync(database, "");
		writeFileSync(marker, "");
		writeFileSync(fleetConfig, JSON.stringify({ sessions: [] }));
		const fakeBr = join(fakebin, "br");
		const fakeAm = join(fakebin, "am");
		writeFileSync(fakeBr, fixtureBr(rows));
		chmodSync(fakeBr, 0o755);
		writeFileSync(fakeAm, "#!/bin/sh\ncase \"${1:-}:${2:-}\" in\n\tagents:show) printf '{}\\n' ;;\n\tfile_reservations:conflicts) printf 'No conflicts detected.\\n' ;;\n\t*) exit 2 ;;\nesac\n");
		chmodSync(fakeAm, 0o755);
		// Keep native claim admission on this candidate, not an older installed CLI.
		writeFileSync(join(fakebin, "omp-kit"), `#!${process.execPath}
import { runCli } from ${JSON.stringify(join(kitRoot, "src/cli.ts"))};
process.exitCode = await runCli(process.argv.slice(2));
`, { mode: 0o755 });
		symlinkSync(join(scripts, "br-shim.sh"), join(bindir, "br"));

		const originalPath = process.env.PATH ?? "";
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			AGENT_NAME: agent,
			BR_REAL: fakeBr,
			BEADS_DB: database,
			BEADS_DIR: beads,
			BR_GATEPLANE_MARKER: marker,
			BR_GATEPLANE_SCRIPTS: scripts,
			BR_SHIM_PROJECT: project,
			OMP_KIT_FLEET_WATCH_CONFIG: fleetConfig,
			PYTHONPATH: scripts,
			XDG_STATE_HOME: state,
			TMPDIR: base,
			PATH: [fakebin, originalPath].filter(Boolean).join(delimiter),
		};
		const before = await runPythonBr(project, env, ["br", "update", "review-unticked", "--status", "in_review", "--db", database, "--actor", agent]);
		expect(before.rc).toBe(0);
		expect(readFileSync(marker, "utf8")).toContain("update review-unticked");

		const host = await createFlywheelHost(base, { env, home });
		await host.emit("session_start", { type: "session_start" }, host.ctx(project));
		const review = await runPythonBr(project, env, ["br", "update", "review-unticked", "--status", "in_review", "--db", database, "--actor", agent]);
		expect(review.rc).toBe(4);
		expect(review.stderr).toContain("AC_UNTICKED_BUILD_LANDED");
		expect(env.PATH?.split(delimiter)[0]).toBe(bindir);

		const claim = await runPythonBr(project, env, ["br", "update", "claim-unreplayable", "--claim", "--db", database, "--actor", agent]);
		expect(claim.rc).toBe(4);
		expect(claim.stderr).toContain("REFUSED_NOT_REPLAYABLE");

		const create = await runPythonBr(project, env, ["br", "create", "Create fixture", "-t", "task", "-l", "gate", "-d", description, "--acceptance-criteria", unreplayable, "--db", database, "--actor", agent]);
		expect(create.rc).toBe(4);
		expect(create.stderr).toContain("r-verify-replayable");

		const cliEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const doctor = await run([
			process.execPath, "run", "--no-env-file", "--config=/dev/null", join(kitRoot, "src/cli.ts"),
			"doctor", "--scope", "gates", "--json",
		], { cwd: kitRoot, deadline_s: 60, env: cliEnv });
		expect(doctor.rc).toBe(0);
		const body = JSON.parse(decode(doctor.stdout)) as {
			data: { findings: { component: string; status: string; reason: string; evidence?: Record<string, unknown> }[] };
		};
		const finding = body.data.findings.find((row) => row.component === "gates");
		expect(finding?.status).toBe("OK");
		expect(finding?.reason).toContain("GATEPLANE1 ok");
		expect(finding?.reason).toContain("AC_UNTICKED_BUILD_LANDED");
		expect(finding?.reason).toContain("REFUSED_NOT_REPLAYABLE");
		expect(finding?.reason).toContain("r-verify-replayable");
		const probeFixture = finding?.evidence?.fixture;
		expect(typeof probeFixture).toBe("string");
		if (typeof probeFixture === "string") {
			const tempRelative = relative(base, probeFixture);
			expect(tempRelative.startsWith("..")).toBe(false);
			expect(tempRelative).toContain("fixture-project");
			expect(probeFixture).not.toBe(project);
		}
		expect(finding?.evidence).toEqual(expect.objectContaining({
			live_tracker_mutated: false,
			probes: {
				in_review: { rc: 4, refused: true },
				claim: { rc: 4, refused: true },
				create: { rc: 4, refused: true },
				control: { rc: 0, admitted: true },
			},
		}));
	} finally {
		owned.cleanup();
	}
}, 90_000); // The doctor child is bounded at 60s; leave time to observe that result.
