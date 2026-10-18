// ompkit-774u.12 OWNERREG1 AC2: `omp-kit doctor --scope ownership --json` is reachable through the real CLI, reports per
// class records / no-live-owner / untracked / oldest age from disposable state, and changes nothing (planted check).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });

interface Finding { component: string; status: string; reason: string; evidence?: Record<string, unknown> }

function treeListing(root: string): string[] {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name), stat = statSync(path);
			if (stat.isDirectory()) { lines.push(`${path.slice(root.length)}/`); walk(path); }
			else lines.push(`${path.slice(root.length)} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return lines;
}

test("doctor --scope ownership reports untracked state from a disposable home and changes no file", () => {
	const home = mkdtempSync(join(repo, "var", "agent-tmp", "ownership-cli-"));
	cleanup.push(home);
	const state = join(home, ".local", "state");
	const leases = join(state, "rch", "job-leases");
	mkdirSync(leases, { recursive: true });
	mkdirSync(join(state, "ntm"), { recursive: true });
	mkdirSync(join(home, ".config"), { recursive: true });
	// A recovery lock with no record and a watcher lock whose holder is dead: both untracked.
	writeFileSync(join(leases, "rchw-orphan.recovery.lock"), "");
	writeFileSync(join(state, "ntm", "watcher-dead.lock"), "999999\n");
	// Bun keeps its own transpiler cache under HOME/Library when HOME is the fixture: that is the runtime's, not the doctor's.
	const before = treeListing(join(home, ".local"));
	// OMP_KIT_OMP_SRC_FETCH=0: in an empty HOME the kit would otherwise install OMP's source from npm, which is not the doctor's doing.
	const env = { ...process.env, HOME: home, XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(home, ".config"), OMP_KIT_OMP_SRC_FETCH: "0" };
	const child = Bun.spawnSync([process.execPath, "run", join(repo, "src", "cli.ts"), "doctor", "--scope", "ownership", "--json"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const out = child.stdout.toString();
	const parsed = JSON.parse(out) as { data: { findings: Finding[] } };
	const rows = parsed.data.findings.filter((row) => row.component.startsWith("OWNERSHIP"));
	const summary = rows.find((row) => row.component === "OWNERSHIP")!;
	expect(summary, out + child.stderr.toString()).toBeDefined();
	expect(summary.status).toBe("DEGRADED");
	const byId = (id: string) => rows.find((row) => row.component === `OWNERSHIP:${id}`)!;
	expect(byId("rch-job-lease").evidence).toMatchObject({ census: { records: 1, untracked: 1 } });
	expect(byId("ntm-watcher-lock").evidence).toMatchObject({ census: { records: 1, no_live_owner: 1, untracked: 1 } });
	expect(treeListing(join(home, ".local"))).toEqual(before);
}, 120_000);

test("doctor --scope ownership is a known scope: no INVALID_VALUE refusal", () => {
	const home = mkdtempSync(join(repo, "var", "agent-tmp", "ownership-cli-"));
	cleanup.push(home);
	const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".local", "state"), XDG_CONFIG_HOME: join(home, ".config"), OMP_KIT_OMP_SRC_FETCH: "0" };
	const child = Bun.spawnSync([process.execPath, "run", join(repo, "src", "cli.ts"), "doctor", "--scope", "ownership", "--json"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	expect(child.stdout.toString()).not.toContain("INVALID_VALUE");
}, 120_000);
