import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { run } from "./kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "./kitlib/tmp.ts";
import type { Finding } from "./diagnostics.ts";

const GATEPLANE_BEAD = "ompkit-fp72.135.3.82";
const PYTHON_DRIVER = [
	"import json, os, sys",
	"sys.path.insert(0, os.environ['BR_GATEPLANE_SCRIPTS'])",
	"import kitlib_run",
	"result = kitlib_run.run(sys.argv[1:], deadline_s=30, cwd=os.environ['BR_SHIM_PROJECT'], env=dict(os.environ))",
	"print(json.dumps({'rc': result.rc, 'stdout': result.stdout.decode('utf-8', 'replace'), 'stderr': result.stderr.decode('utf-8', 'replace'), 'timed_out': result.timed_out}, separators=(',', ':')))"
].join("\n");

export type BrShimPathResult = { ok: true; bindir: string } | { ok: false; bindir: string; reason: string };

function brShimLink(home: string, scriptsDir: string): BrShimPathResult {
	const bindir = join(home, ".local", "share", "omp-kit", "agent-bin");
	const link = join(bindir, "br");
	try {
		if (!lstatSync(link).isSymbolicLink()) return { ok: false, bindir, reason: `${link} is not a symlink` };
		const actual = realpathSync(link);
		const expected = realpathSync(join(scriptsDir, "br-shim.sh"));
		if (actual !== expected) return { ok: false, bindir, reason: `${link} resolves to ${actual}, not this release's ${expected}` };
	} catch (error) {
		return { ok: false, bindir, reason: `${link} cannot be verified (${error instanceof Error ? error.message : String(error)})` };
	}
	return { ok: true, bindir };
}

export function projectAgentBrShimPath(env: Record<string, string | undefined>, home: string, scriptsDir: string): BrShimPathResult {
	const link = brShimLink(home, scriptsDir);
	if (!link.ok) return link;
	const entries = env.PATH ? env.PATH.split(delimiter) : [];
	env.PATH = [link.bindir, ...entries.filter((entry) => entry !== link.bindir)].join(delimiter);
	return link;
}

export function inspectAgentBrShimPath(env: Record<string, string | undefined>, home: string, scriptsDir: string): BrShimPathResult {
	const link = brShimLink(home, scriptsDir);
	if (!link.ok) return link;
	if (env.PATH?.split(delimiter)[0] !== link.bindir) {
		return { ok: false, bindir: link.bindir, reason: `${link.bindir} is not the first PATH entry` };
	}
	return link;
}

async function runPythonBr(project: string, env: Record<string, string>, argv: string[]): Promise<{ rc: number | null; stdout: string; stderr: string; timed_out: boolean; error?: string }> {
	try {
		const outer = await run(["python3", "-c", PYTHON_DRIVER, ...argv], { cwd: project, deadline_s: 45, env });
		if (outer.timed_out || outer.rc !== 0) {
			return { rc: outer.rc, stdout: "", stderr: new TextDecoder().decode(outer.stderr), timed_out: outer.timed_out, error: "Python kitlib runner did not complete" };
		}
		const parsed: unknown = JSON.parse(new TextDecoder().decode(outer.stdout));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Python kitlib runner returned a non-object result");
		const row = parsed as Record<string, unknown>;
		if ((typeof row.rc !== "number" && row.rc !== null) || typeof row.stdout !== "string" || typeof row.stderr !== "string" || typeof row.timed_out !== "boolean") {
			throw new Error("Python kitlib runner returned an incomplete result");
		}
		return { rc: row.rc, stdout: row.stdout, stderr: row.stderr, timed_out: row.timed_out };
	} catch (error) {
		return { rc: null, stdout: "", stderr: "", timed_out: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function asEnvironment(env: Record<string, string | undefined>): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) output[key] = value;
	return output;
}

export async function inspectGatePlane(input: { root: string; home: string; env?: Record<string, string | undefined> }): Promise<Finding> {
	const env = input.env ?? process.env;
	const scriptsDir = join(input.root, "scripts");
	const identity = env.AGENT_NAME?.trim();
	if (!identity) {
		return { component: "gates", status: "UNVERIFIED", reason: "GATEPLANE1 not run: AGENT_NAME is absent, so this is not an identified fleet seat.", recommended_action: "Run doctor --scope gates from an identified fleet seat.", evidence: { probe: "not-run", reason: "missing-identity" } };
	}
	const path = inspectAgentBrShimPath(env, input.home, scriptsDir);
	if (!path.ok) {
		return { component: "gates", status: "FAIL", reason: `GATEPLANE1 fail: ${path.reason}; Python and Bun children may resolve native br instead of the admission shim.`, recommended_action: "Start the seat with the release's agent-spawn environment and rerun doctor --scope gates.", evidence: { probe: "not-run", shim: join(path.bindir, "br"), reason: path.reason } };
	}

	let scratch: OwnedTmp;
	try {
		scratch = ownedTmp("gateplane1", { bead: GATEPLANE_BEAD });
	} catch (error) {
		return { component: "gates", status: "UNVERIFIED", reason: `GATEPLANE1 unverified: owned fixture directory unavailable (${error instanceof Error ? error.message : String(error)}).`, recommended_action: "Restore writable system temporary storage and rerun doctor --scope gates.", evidence: { probe: "fixture-unavailable" } };
	}

	let finding: Finding;
	let cleanupError: string | undefined;
	try {
		const project = join(scratch.path, "fixture-project");
		const beads = join(project, ".beads");
		const fakebin = join(scratch.path, "fakebin");
		const state = join(scratch.path, "state");
		const database = join(beads, "beads.db");
		const marker = join(scratch.path, "mutations.log");
		const fakeBr = join(fakebin, "br");
		const fakeAm = join(fakebin, "am");
		const replayable = "- [ ] [a] [build] fixture remains readable `true` -> rc 0; planted negative: broken fixture is refused";
		const unreplayable = "- [ ] [a] [build] fixture is valid; planted negative: missing command is refused";
		const description = "WHAT: exercise the gate. WHY: catch Python path bypass.";
		const created = new Date().toISOString();
		const rows = {
			"gate-review": { id: "gate-review", title: "Gate review fixture", status: "open", priority: 2, issue_type: "task", labels: ["gate"], description, acceptance_criteria: replayable, created_at: created, dependencies: [] },
			"gate-claim": { id: "gate-claim", title: "Gate claim fixture", status: "open", priority: 2, issue_type: "task", labels: ["gate"], description, acceptance_criteria: unreplayable, created_at: created, dependencies: [] }
		};
		mkdirSync(beads, { recursive: true });
		mkdirSync(fakebin, { recursive: true });
		mkdirSync(state, { recursive: true });
		writeFileSync(database, "");
		writeFileSync(marker, "");
		const cases = Object.entries(rows).map(([id, row]) => `\t\t${id}) printf '%s\\n' '${JSON.stringify(row)}' ;;`).join("\n");
		writeFileSync(fakeBr, `#!/bin/sh\nset -eu\ncase "\${1:-}" in\n\tshow)\n\t\tcase "\${2:-}" in\n${cases}\n\t\t*) exit 2 ;;\n\t\tesac\n\t\t;;\n\tlist) printf '%s\\n' '{"issues":[]}' ;;\n\tupdate) printf '%s\\n' "$*" >> "$BR_GATEPLANE_MARKER" ;;\n\tcreate) printf '%s\\n' "$*" >> "$BR_GATEPLANE_MARKER"; printf '%s\\n' '{"id":"created"}' ;;\n\t*) exit 2 ;;\nesac\n`);
		chmodSync(fakeBr, 0o755);
		writeFileSync(fakeAm, "#!/bin/sh\ncase \"${1:-}:${2:-}\" in\n\tagents:show) printf '{}\\n' ;;\n\tfile_reservations:conflicts) printf 'No conflicts detected.\\n' ;;\n\t*) exit 2 ;;\nesac\n");
		chmodSync(fakeAm, 0o755);

		const pathEntries = env.PATH?.split(delimiter) ?? [];
		const probeEnv: Record<string, string | undefined> = {
			...env,
			AGENT_NAME: identity,
			BR_REAL: fakeBr,
			BR_GATEPLANE_MARKER: marker,
			BR_GATEPLANE_SCRIPTS: scriptsDir,
			BR_SHIM_PROJECT: project,
			HOME: input.home,
			OMP_KIT_FLEET_WATCH_CONFIG: "",
			PATH: [path.bindir, fakebin, ...pathEntries.filter((entry) => entry !== path.bindir && entry !== fakebin)].join(delimiter),
			XDG_STATE_HOME: state
		};
		const childEnv = asEnvironment(probeEnv);
		const review = await runPythonBr(project, childEnv, ["br", "update", "gate-review", "--status", "in_review", "--db", database, "--actor", identity]);
		const claim = await runPythonBr(project, childEnv, ["br", "update", "gate-claim", "--claim", "--db", database, "--actor", identity]);
		const create = await runPythonBr(project, childEnv, ["br", "create", "Gate create fixture", "-t", "task", "-l", "gate", "-d", description, "--acceptance-criteria", unreplayable, "--db", database, "--actor", identity]);
		const control = await runPythonBr(project, childEnv, ["br", "update", "gate-control", "--priority", "2", "--db", database, "--actor", identity]);
		const mutations = readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
		const probes = {
			in_review: { rc: review.rc, refused: review.rc === 4 && review.stderr.includes("AC_UNTICKED_BUILD_LANDED") },
			claim: { rc: claim.rc, refused: claim.rc === 4 && claim.stderr.includes("REFUSED_NOT_REPLAYABLE") },
			create: { rc: create.rc, refused: create.rc === 4 && create.stderr.includes("r-verify-replayable") },
			control: { rc: control.rc, admitted: control.rc === 0 && mutations.length === 1 && mutations[0]!.startsWith("update gate-control ") }
		};
		const completed = [review, claim, create, control].every((probe) => !probe.error && !probe.timed_out);
		const passed = probes.in_review.refused && probes.claim.refused && probes.create.refused && probes.control.admitted;
		if (!completed) {
			finding = { component: "gates", status: "UNVERIFIED", reason: `GATEPLANE1 unverified: an owned-fixture Python probe did not complete (${[review, claim, create, control].map((probe) => probe.error ?? (probe.timed_out ? "timed out" : "completed")).join("; ")}).`, recommended_action: "Check Python, Bun and the release's gate helpers, then rerun doctor --scope gates.", evidence: { fixture: project, live_tracker_mutated: false, probes } };
		} else {
			finding = {
				component: "gates",
				status: passed ? "OK" : "FAIL",
				reason: passed
					? "GATEPLANE1 ok: fixture in_review refused AC_UNTICKED_BUILD_LANDED; claim refused REFUSED_NOT_REPLAYABLE; create refused r-verify-replayable; valid control reached native br."
					: `GATEPLANE1 fail: in_review=${probes.in_review.refused ? "refused" : `rc ${review.rc}`}; claim=${probes.claim.refused ? "refused" : `rc ${claim.rc}`}; create=${probes.create.refused ? "refused" : `rc ${create.rc}`}; control=${probes.control.admitted ? "admitted" : `rc ${control.rc}`}.`,
				recommended_action: passed ? "No action required." : "Restore the release br shim and its admission helpers, then rerun doctor --scope gates.",
				evidence: { fixture: project, live_tracker_mutated: false, probes, mutation_count: mutations.length }
			};
		}
	} catch (error) {
		finding = { component: "gates", status: "UNVERIFIED", reason: `GATEPLANE1 unverified: owned-fixture setup failed (${error instanceof Error ? error.message : String(error)}).`, recommended_action: "Check writable temporary storage and rerun doctor --scope gates.", evidence: { fixture: scratch.path, live_tracker_mutated: false } };
	} finally {
		try { scratch.cleanup(); } catch (error) { cleanupError = error instanceof Error ? error.message : String(error); }
	}
	if (cleanupError) {
		return { component: "gates", status: "UNVERIFIED", reason: `GATEPLANE1 unverified: owned fixture cleanup failed (${cleanupError}).`, recommended_action: "Remove the reported owned fixture after checking it, then rerun doctor --scope gates.", evidence: { live_tracker_mutated: false } };
	}
	return finding;
}
