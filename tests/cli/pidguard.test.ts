import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safePid } from "../../src/kitlib/proc";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process";

const root = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("pidguard", { root: process.env.TMPDIR });
afterAll(() => cleanupAllOwnedTmp());
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
async function command(argv: string[], cwd = root) {
	return runFixtureAsync(argv, { cwd, floor_s: 30 });
}

test("safePid refuses sentinel, empty, lossy and malformed targets", () => {
	for (const value of ["", " ", "0", "000", "1", "-1", "-2", 0, 1, -1, false, null, undefined, 2.5, Infinity, NaN, "2.5", "2e2", "0x20", "123junk", "9".repeat(100000), 2147483648]) {
		expect(() => safePid(value)).toThrow();
	}
	for (const [value, expected] of [[2, 2], ["002", 2], [" 123\n", 123], [2147483647, 2147483647]] as const) expect(safePid(value)).toBe(expected);
});

test("Python and shell guards refuse empty/zero before invoking any signal", async () => {
	const py = await command(["python3", "-B", "-c", String.raw`
import sys
sys.path.insert(0, 'scripts')
from kitlib_proc import safe_pid
bad = ['', ' ', '0', '000', '1', '-1', '-2', 0, 1, -1, False, None, 2.5, float('inf'), '2e2', '0x20', '9'*100000, 2147483648]
for value in bad:
    try: safe_pid(value)
    except ValueError: pass
    else: raise AssertionError(repr(value))
assert [safe_pid(v) for v in [2, '002', ' 123\n', 2147483647]] == [2,2,123,2147483647]
`]);
	expect(py.rc, decode(py.stderr)).toBe(0);
	const sh = await command(["sh", "-c", String.raw`
. scripts/kitlib-proc.sh
kill() { printf 'signal:%s\n' "$*"; }
for value in '' 0 000 1 -1 -2 '2.5' '2e2' 2147483648; do
  out=$(kitlib_signal KILL "$value" group); rc=$?
  [ "$rc" -eq 2 ] && [ -z "$out" ] || exit 1
done
[ "$(kitlib_signal TERM 002 group)" = 'signal:-TERM -2' ] || exit 2
[ "$(kitlib_signal KILL 123)" = 'signal:-KILL 123' ] || exit 3
`]);
	expect(sh.rc, decode(sh.stderr)).toBe(0);
}, fixtureDeadlineS(60) * 1000);

test("staged unsafe TS and shell additions refuse; guarded, literal and probe controls pass", async () => {
	const repo = join(scratch.path, "staged");
	mkdirSync(repo);
	async function git(...args: string[]) {
		const result = await command(["git", ...args], repo);
		expect(result.rc, decode(result.stderr)).toBe(0);
	}
	await git("init", "-q");
	await git("-c", "user.name=PIDGUARD1", "-c", "user.email=pidguard@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture base");
	const cases: [string, string, number][] = [
		["target.ts", "process.kill(Number(readFileSync(p, 'utf8')), 'SIGKILL');\n", 1],
		["target.ts", "process.kill(\n Number(readFileSync(p, 'utf8')),\n 'SIGKILL'\n);\n", 1],
		["target.ts", "import { safePid } from './src/kitlib/proc';\nprocess.kill(safePid(readFileSync(p, 'utf8')), 'SIGKILL');\n", 0],
		["target.ts", "import { safePid } from './src/kitlib/proc';\nprocess.kill(-safePid(p), 'SIGTERM');\n", 0],
		["target.ts", "import { safePid as checked } from './src/kitlib/proc';\nprocess.kill(checked(p), 'SIGTERM');\n", 0],
		["target.ts", "import * as proc from './src/kitlib/proc';\nprocess.kill(proc.safePid(p), 'SIGTERM');\n", 0],
		["target.ts", "function safePid(p) { return p; }\nprocess.kill(safePid(p), 'SIGTERM');\n", 1],
		["target.ts", "process.kill(pid, 0);\n", 0],
		["target.ts", "process.kill(123, 'SIGKILL');\n", 0],
		["target.ts", "// process.kill(pid, 'SIGKILL')\nconst doc = \"process.kill(pid, 'SIGKILL')\";\n", 0],
		["target.sh", '#!/bin/sh\nkill -9 "$(cat f)"\n', 1],
		["target.sh", '#!/bin/sh\nkill -9 "$pid"\n', 1],
		["target.sh", '#!/bin/sh\nkitlib_signal KILL "$(cat f)"\n', 0],
		["target.sh", '#!/bin/sh\nkill -0 "$pid"\n', 0],
		["target.sh", '#!/bin/sh\nkill -9 123\n', 0],
		["target.sh", '#!/bin/sh\necho "kill -9 $pid"\n', 0],
		["target.sh", '#!/bin/sh\nkill() { echo stub; }\n', 0],
		["target.sh", '#!/bin/sh\ncat <<EOF\nkill -9 $pid\nEOF\n', 0],
		["target.sh", '#!/bin/sh\ncat <<EOF\n$(kill -9 "$pid")\nEOF\n', 1],
		["target.sh", "#!/bin/sh\ncat <<'EOF'\n$(kill -9 \"$pid\")\nEOF\n", 0],
		["target.py", 'import os\nos.kill(int(open("f").read()), 9)\n', 1],
		["target.py", 'import os\nfrom kitlib_proc import safe_pid\nos.kill(safe_pid(open("f").read()), 9)\n', 0],
		["target.py", 'import os\nos.kill(pid, 0)\n', 0],
	];
	for (const [path, source, rc] of cases) {
		writeFileSync(join(repo, path), source);
		await git("add", path);
		const result = await command(["python3", "-B", join(root, "scripts/kitlib_ratchet.py"), "--staged", "--repo", repo]);
		expect(result.rc, `${path}: ${source}\n${decode(result.stderr)}${decode(result.stdout)}`).toBe(rc);
		if (rc) expect(decode(result.stdout) + decode(result.stderr)).toContain("unsafe-signal-pid");
		await git("rm", "--cached", "--", path);
	}
}, fixtureDeadlineS(120) * 1000);

test("real harness functions do not signal empty or zero pid files", async () => {
	const live = readFileSync(join(root, "scripts/e2e-live.sh"), "utf8");
	const verdict = readFileSync(join(root, "scripts/full-suite-verdict.sh"), "utf8");
	function shellFunction(source: string, name: string) {
		const start = source.indexOf(`${name}() {`);
		if (start < 0) throw new Error(`missing ${name}`);
		const end = source.indexOf("\n}", start);
		if (end < 0) throw new Error(`unclosed ${name}`);
		return source.slice(start, end + 2);
	}
	const pidFile = join(scratch.path, "pid");
	for (const value of ["", "0\n", "1\n", "-1\n"]) {
		writeFileSync(pidFile, value);
		const result = await command(["sh", "-c", [
			'. scripts/kitlib-proc.sh',
			'kill() { echo UNEXPECTED-SIGNAL; }',
			'sleep() { :; }',
			'ps() { echo UNEXPECTED-PS; }',
			shellFunction(live, "reap_group"),
			shellFunction(live, "on_signal"),
			shellFunction(verdict, "kill_tree"),
			'LIMIT_PGID_FILE=$1; OP=; MP=; WORKER_PIDS=',
			'reap_group',
			'kill_tree "$(cat "$1")" KILL; [ "$?" -eq 2 ] || exit 3',
			'(on_signal 143); [ "$?" -eq 143 ] || exit 4',
		].join("\n"), "sh", pidFile]);
		expect(result.rc, decode(result.stderr)).toBe(0);
		expect(decode(result.stdout)).not.toContain("UNEXPECTED");
	}
}, fixtureDeadlineS(60) * 1000);
