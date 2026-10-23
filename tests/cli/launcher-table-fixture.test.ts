import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pollUntil } from "../../src/kitlib/poll.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureLauncherTableBin } from "./launcher-table-fixture.ts";

const LAUNCHER_TABLE = fixtureLauncherTableBin();
const AGENT_TMP = resolve(import.meta.dir, "../../var/agent-tmp");
afterAll(() => cleanupAllOwnedTmp());

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("fixture launcher table hides only service run rows outside this test process's tree", () => {
	// A synthetic host behind the table: 9001 and its child 9003 descend from this test
	// process; 9002 is another fixture's or a live job's launcher; 9004 is unrelated.
	const host = ownedTmp("launcher-table-host", { root: AGENT_TMP }).path;
	writeFileSync(join(host, "ps"), [
		"#!/bin/sh",
		"case \"$*\" in",
		`"-axo pid=,ppid=") printf '%s\\n' '${process.pid} 1' '9001 ${process.pid}' '9002 1' '9003 9001' '9004 1' ;;`,
		"\"-axo pid=,args=\") printf '%s\\n' '9001 bun cli.ts service run omp-watch --json' '9002 /home/other/.local/bin/omp-kit service run omp-watch' '9003 sh -c service run omp-watch' '9004 /usr/bin/helper --daemon' ;;",
		"*) echo 'ps: no such process' >&2; exit 1 ;;",
		"esac",
		"",
	].join("\n"), { mode: 0o700 });
	const env = { PATH: `${LAUNCHER_TABLE}:${host}:/usr/bin:/bin` };
	const table = runSync([join(LAUNCHER_TABLE, "ps"), "-axo", "pid=,args="], { deadline_s: 30, env });
	expect({ rc: table.rc, stderr: decode(table.stderr) }).toEqual({ rc: 0, stderr: "" });
	expect(decode(table.stdout)).toBe([
		"9001 bun cli.ts service run omp-watch --json",
		"9003 sh -c service run omp-watch",
		"9004 /usr/bin/helper --daemon",
		"",
	].join("\n"));
	const missing = runSync([join(LAUNCHER_TABLE, "ps"), "-o", "pid=", "-p", "9999"], { deadline_s: 30, env });
	expect({ rc: missing.rc, stdout: decode(missing.stdout), stderr: decode(missing.stderr) })
		.toEqual({ rc: 1, stdout: "", stderr: "ps: no such process\n" });
});

test("planted: a second live launcher in the fixture's own tree still refuses SKIPPED-ADMISSION", async () => {
	const home = ownedTmp("launcher-table-run", { root: AGENT_TMP }).path;
	mkdirSync(join(home, ".local", "bin"), { recursive: true });
	writeFileSync(join(home, ".local", "bin", "omp-kit"), "#!/bin/sh\necho boom >&2\nexit 3\n", { mode: 0o755 });
	mkdirSync(join(home, ".local", "state", "omp-kit"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".local", "state", "omp-kit"), 0o700);
	const marker = `launcher-table-sleeper-${process.pid}`;
	const stop = new AbortController();
	// The planted second launcher is a real child process that must stay alive until aborted below;
	// its argv carries `service run omp-watch`. No test step waits on its sleep.
	const sleeper = run([process.execPath, "-e", `await Bun.sleep(60000) // ${marker}`, "service", "run", "omp-watch"],
		{ deadline_s: 90, signal: stop.signal });
	try {
		const seen = await pollUntil(() => decode(runSync([join(LAUNCHER_TABLE, "ps"), "-axo", "pid=,args="], { deadline_s: 10 }).stdout),
			{ deadline_s: 30, interval_s: 0.05, classify: table => table.includes(marker) ? "success" : "retry" });
		expect(seen.outcome).toBe("success");
		const refused = await run([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "service", "run", "omp-watch", "--json"], {
			deadline_s: 60, cwd: home,
			env: { PATH: `${LAUNCHER_TABLE}:/usr/bin:/bin`, HOME: home, TMPDIR: home,
				XDG_STATE_HOME: join(home, ".local", "state"), OMP_KIT_LOAD_OVERRIDE: "0/1" },
		});
		const envelope = JSON.parse(decode(refused.stdout));
		expect(refused.rc, decode(refused.stderr)).toBe(4);
		expect(envelope.data).toMatchObject({ job: "omp-watch", status: "SKIPPED-ADMISSION", receipt: { exit: 4, status: "SKIPPED-ADMISSION" } });
	} finally {
		const stopped = new Error("planted launcher stopped");
		stop.abort(stopped);
		await sleeper.catch(error => { if (error !== stopped) throw error; });
	}
}, 120000);
