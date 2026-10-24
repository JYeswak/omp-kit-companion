import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ccServiceCommand } from "../../src/service.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// DEPLOYBOOT2 (fp72.120.16.53): `service run cc` starts cc.py from HEAD's
// committed bytes; an uncommitted syntax error in the working tree never runs.

const AGENT_TMP = join(import.meta.dir, "../../var/agent-tmp");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const COMMITTED = "import sys\nprint('BOOT=committed')\nprint('ARGV=' + repr(sys.argv))\nprint('FILE=' + __file__)\nsys.exit(0)\n";
const DIRTY = "def broken(:\n    pass\n";

function scratch(label: string): string {
	const root = ownedTmp(label, { root: AGENT_TMP }).path;
	roots.push(root);
	return root;
}
function env(parent: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: parent, GIT_CEILING_DIRECTORIES: parent,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}
function git(cwd: string, parent: string, ...args: string[]): void {
	const r = runSync(["git", ...args], { deadline_s: 30, cwd, env: env(parent) });
	if (r.rc !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
}
function run(argv: string[], parent: string) {
	const r = runSync(argv, { deadline_s: 30, env: env(parent) });
	const text = new TextDecoder();
	return { rc: r.rc, out: text.decode(r.stdout), err: text.decode(r.stderr) };
}
function fixtureCheckout(): { parent: string; checkout: string; adapter: string } {
	const parent = scratch("service-cc-boot");
	const checkout = join(parent, "fleet");
	mkdirSync(join(checkout, "scripts", "cc"), { recursive: true });
	const adapter = join(checkout, "scripts", "cc", "cc.py");
	writeFileSync(adapter, COMMITTED);
	git(checkout, parent, "init", "-q");
	git(checkout, parent, "add", "scripts/cc/cc.py");
	git(checkout, parent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "committed cc");
	writeFileSync(adapter, DIRTY);
	return { parent, checkout, adapter };
}

test("cc_boot_runs_head_bytes_not_dirty_worktree", () => {
	const { parent, adapter } = fixtureCheckout();
	const r = run(ccServiceCommand(parent, adapter).argv, parent);
	expect(r.err).not.toContain("SyntaxError");
	expect(r.rc).toBe(0);
	expect(r.out).toContain("BOOT=committed");
	expect(r.out).toContain(`ARGV=['${adapter}', 'serve', '--host', '127.0.0.1', '--port', '7474', '--lanes']`);
	expect(r.out).toContain(`FILE=${adapter}`);
});

test("cc_boot_planted_old_argv_compiles_dirty_worktree", () => {
	const { parent, adapter } = fixtureCheckout();
	const r = run(["python3", adapter, "serve", "--host", "127.0.0.1", "--port", "7474", "--lanes"], parent);
	expect(r.rc).not.toBe(0);
	expect(r.err).toContain("SyntaxError");
	expect(r.out).not.toContain("BOOT=committed");
});

test("cc_boot_fails_closed_when_checkout_not_git_top_level", () => {
	const parent = scratch("service-cc-boot-nogit");
	const checkout = join(parent, "fleet");
	mkdirSync(join(checkout, "scripts", "cc"), { recursive: true });
	const adapter = join(checkout, "scripts", "cc", "cc.py");
	writeFileSync(adapter, COMMITTED);
	const r = run(ccServiceCommand(parent, adapter).argv, parent);
	expect(r.rc).toBe(3);
	expect(JSON.parse(r.out.trim())).toEqual({ schema_version: "omp-kit.cc.cli.v1", ok: false, error: "DEPLOY_BOOT_GIT_FAILED" });
	expect(r.out).not.toContain("BOOT=committed");
});
