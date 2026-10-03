
export type BrowserProcess = {
	pid: number;
	ppid: number;
	command: string;
	startedAt: number;
	userDataDir: string | null;
	codeSignClones: string[];
};
export type BrowserSession = { pid: number; alive: boolean };
export type BrowserFinding = BrowserProcess & { status: "ORPHAN" | "LIVE"; reason: string; ageMs: number };
export type BrowserDoctorReport = { status: "OK" | "WARN"; browsers: BrowserFinding[]; orphaned: BrowserFinding[]; clones: string[] };

const CHROME = /(?:^|\/)(?:Google Chrome|Chromium|chrome|chromium)(?:$|\s)/i;
const BROKER = /__omp_worker_daemon_broker/;
const USER_DATA = /--user-data-dir=([^\s"']+)/;
const CLONE = /(?:^|\s)(\/[^\s]*code_sign_clone[^\s]*)/g;

/** Pure classification: only headless Chrome descendants of OMP broker processes qualify. */
export function inspectBrowserProcesses(processes: readonly BrowserProcess[], sessions: readonly BrowserSession[], now = Date.now()): BrowserDoctorReport {
	const byPid = new Map(processes.map(process => [process.pid, process]));
	const liveSessions = new Set(sessions.filter(session => session.alive).map(session => session.pid));
	const browsers = processes.filter(process => CHROME.test(process.command) && /--headless(?:=|\s|$)/i.test(process.command)
		&& isBrokerDescendant(process, byPid));
	const classified = browsers.map(browser => {
		const sessionAlive = liveSessions.has(browser.ppid) || liveSessions.has(byPid.get(browser.ppid)?.ppid ?? -1);
		return { ...browser, status: sessionAlive ? "LIVE" as const : "ORPHAN" as const,
			reason: sessionAlive ? "owning OMP session is live" : "owning OMP session is absent", ageMs: Math.max(0, now - browser.startedAt) };
	});
	const orphaned = classified.filter(browser => browser.status === "ORPHAN");
	const clones = [...new Set(orphaned.flatMap(browser => browser.codeSignClones))];
	return { status: orphaned.length ? "WARN" : "OK", browsers: classified, orphaned, clones };
}
function isBrokerDescendant(process: BrowserProcess, byPid: ReadonlyMap<number, BrowserProcess>): boolean {
	const seen = new Set<number>();
	for (let pid = process.ppid; pid > 0 && !seen.has(pid); pid = byPid.get(pid)?.ppid ?? 0) {
		seen.add(pid);
		if (BROKER.test(byPid.get(pid)?.command ?? "")) return true;
	}
	return false;
}


/** Read the local process table; no process is killed or mutated. */
export function collectBrowserProcesses(run: (args: readonly string[]) => { exitCode: number | null; stdout: string } = args => { const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }); return { exitCode: result.exitCode, stdout: result.stdout.toString() }; }): { processes: BrowserProcess[]; sessions: BrowserSession[] } {
	const result = run(["ps", "-axo", "pid=,ppid=,etimes=,command="]);
	if (result.exitCode !== 0) return { processes: [], sessions: [] };
	const rows: BrowserProcess[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]), ppid = Number(match[2]), elapsed = Number(match[3]);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(elapsed)) continue;
		rows.push(parseBrowserCommand(pid, ppid, match[4]!, Date.now() - elapsed * 1000));
	}
	const pids = new Set(rows.map(row => row.pid));
	return { processes: rows, sessions: rows.filter(row => BROKER.test(row.command)).map(row => ({ pid: row.pid, alive: pids.has(row.pid) })) };
}

/** Build a recorded-PID-only reap plan; no pattern matching or kill occurs here. */
export function planBrowserReap(report: BrowserDoctorReport): { pid: number; clones: string[] }[] {
	return report.orphaned.map(browser => ({ pid: browser.pid, clones: browser.codeSignClones }));
}

export type BrowserReapDeps = { kill: (pid: number) => boolean; quarantine: (path: string) => boolean };
export function applyBrowserReap(plan: readonly { pid: number; clones: string[] }[], deps: BrowserReapDeps): { killed: number[]; quarantined: string[] } {
	const killed: number[] = [], quarantined: string[] = [];
	for (const entry of plan) {
		if (deps.kill(entry.pid)) killed.push(entry.pid);
		for (const clone of entry.clones) if (deps.quarantine(clone)) quarantined.push(clone);
	}
	return { killed, quarantined };
}

export function parseBrowserCommand(pid: number, ppid: number, command: string, startedAt: number): BrowserProcess {
	const userDataDir = command.match(USER_DATA)?.[1] ?? null;
	const codeSignClones: string[] = [];
	for (const match of command.matchAll(CLONE)) codeSignClones.push(match[1]!);
	return { pid, ppid, command, startedAt, userDataDir, codeSignClones };
}
