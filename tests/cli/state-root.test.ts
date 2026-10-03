import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../src/cli.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A legacy install: ~/.local/state/omp-kit created 0755 by the pre-CLI scripts, holding legacy files. */
function legacyHome() {
	const scratch = join(import.meta.dir, "../../var/agent-tmp");
	const home = mkdtempSync(join(scratch, "state-root-"));
	roots.push(home);
	const stateRoot = join(home, ".local", "state", "omp-kit");
	mkdirSync(join(stateRoot, "backups", "20260925T020733Z"), { recursive: true });
	writeFileSync(join(stateRoot, "installed.tsv"), "name\tsha256\tpack\tinstalled_utc\n");
	writeFileSync(join(stateRoot, "backups", "20260925T020733Z", "kit-test-skip.md"), "legacy backup\n");
	chmodSync(stateRoot, 0o755);
	return { home, stateRoot };
}

function run(home: string, args: string[]) {
	const { XDG_STATE_HOME: _unset, ...inherited } = process.env;
	const result = Bun.spawnSync([process.execPath, cli, ...args, "--json"], {
		env: { ...inherited, HOME: home }, stdout: "pipe", stderr: "pipe",
	});
	return { code: result.exitCode, envelope: JSON.parse(result.stdout.toString()), stderr: result.stderr.toString() };
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test("a 0755 legacy state root names its mode and the exact repair instead of a generic receipt error", () => {
	const { home, stateRoot } = legacyHome();
	const audit = run(home, ["audit"]);
	expect(audit.code, audit.stderr).toBe(2);
	expect(audit.envelope.errors[0]).toMatchObject({ code: "STATE_ROOT_PERMISSIONS" });
	expect(audit.envelope.errors[0].message).toContain(`${stateRoot} has mode 0755`);
	expect(audit.envelope.errors[0].remediation).toContain("omp-kit repair --scope state");
	expect(run(home, ["update", "--plan", "--version", "9.9.9", "--index", "/abs/i.json", "--archive", "/abs/a.tar"]).envelope.errors[0].code)
		.toBe("STATE_ROOT_PERMISSIONS");
	// test is read-only unless --record, which writes into the state root and so is gated like any receipt writer.
	expect(run(home, ["test", "--record"]).envelope.errors[0].code).toBe("STATE_ROOT_PERMISSIONS");
});

test("repair --scope state plans without writing, then restores 0700 and leaves legacy contents byte-identical", () => {
	const { home, stateRoot } = legacyHome();
	const installed = readFileSync(join(stateRoot, "installed.tsv"));
	const plan = run(home, ["repair", "--scope", "state", "--plan"]);
	expect(plan.code, plan.stderr).toBe(0);
	expect(plan.envelope.data).toMatchObject({ action: "PLAN", scope: "state", changes: 1, previous_mode: "0755",
		steps: [{ action: "chmod 0700", path: stateRoot }] });
	expect(mode(stateRoot)).toBe("755");
	const applied = run(home, ["repair", "--scope", "state", "--apply", "--yes"]);
	expect(applied.code, applied.stderr).toBe(0);
	expect(applied.envelope.data).toMatchObject({ action: "APPLIED", previous_mode: "0755" });
	expect(mode(stateRoot)).toBe("700");
	expect(readFileSync(join(stateRoot, "installed.tsv"))).toEqual(installed);
	const audit = run(home, ["audit"]);
	expect(audit.code, JSON.stringify(audit.envelope)).toBe(0);
	expect(run(home, ["repair", "--scope", "state", "--plan"]).envelope.data).toMatchObject({ action: "UNCHANGED", changes: 0 });
});

test("a symlinked state root is refused by name and never repaired", () => {
	const { home, stateRoot } = legacyHome();
	const elsewhere = join(home, "elsewhere");
	mkdirSync(elsewhere, { mode: 0o755 });
	chmodSync(elsewhere, 0o755);
	rmSync(stateRoot, { recursive: true });
	symlinkSync(elsewhere, stateRoot);
	const audit = run(home, ["audit"]);
	expect(audit.envelope.errors[0]).toMatchObject({ code: "STATE_UNSAFE" });
	expect(audit.envelope.errors[0].message).toContain("SYMLINK");
	const repair = run(home, ["repair", "--scope", "state", "--apply", "--yes"]);
	expect(repair.code).toBe(2);
	expect(repair.envelope.errors[0].code).toBe("STATE_UNSAFE");
	expect(mode(elsewhere)).toBe("755");
});

test("doctor reports the state root with its mode and the repair command", () => {
	const { home, stateRoot } = legacyHome();
	const doctor = run(home, ["doctor"]);
	const row = doctor.envelope.data.findings.find((item: { component: string }) => item.component === "state_root");
	expect(row, JSON.stringify(doctor.envelope).slice(0, 500)).toMatchObject({ status: "DEGRADED",
		evidence: { path: stateRoot, problem: "MODE", mode: "0755" } });
	expect(row.recommended_action).toContain("repair --scope state");
});
