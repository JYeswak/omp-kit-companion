import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { RUN_TIME_CAPS_MS } from "./service-run.ts";
import { runSync } from "./kitlib/run.ts";

export type LoadVerdict = "OK" | "CONTENDED";
export type MemoryPressureLevel = "normal" | "warn" | "critical" | "unknown";
export interface MemoryPressure { level: MemoryPressureLevel; free_pct: number | null }
export interface LoadProcess { pid: number; ppid: number; cpu_pct: number; rss_bytes: number; command: string; cwd?: string; start_time?: string; stat?: string }
export interface LoadPane { session: string; pane: string; pid: number; cwd?: string }
export interface LoadJob { id: string; pid: number; process_start?: string; label: string; repo: string; cwd: string; agent: string; tmux_pane: string; state: "queued" | "running"; queued_at?: string; started_at?: string; max_runtime_s?: number }
export interface LoadMachine { load1: number; load5: number; load15: number; ncpu: number; cpu_user_pct: number | null; cpu_sys_pct: number | null; cpu_idle_pct: number | null; memory_pressure: MemoryPressure; disk_iops: number | null }
export interface LoadConsumer { session: string; pane: string; agent: string; repo: string; cpu_pct: number; rss_bytes: number; pids: number[] }
export interface LoadSystemGroup { group: string; cpu_pct: number; rss_bytes: number; pids: number[] }
export interface LoadProcessFinding extends LoadProcess { owner: string; elapsed_s: number | null; cause_class: "active" | "over-budget" | "suspended-work" | "orphaned-work" | "aged-session-mcp" | "zombie" | "unreaped-children"; zombie_children: number; job_id?: string }
export interface LoadCensus { schema_version: 1; sampled_at: string; verdict: LoadVerdict; reason: string; machine: LoadMachine; consumers: LoadConsumer[]; system_groups: LoadSystemGroup[]; processes: LoadProcessFinding[]; cause_classes: string[]; lsp_counts: { total: number; by_session: Record<string, number> }; heavy_jobs: LoadJob[]; stale_jobs_reaped: string[]; contention_streak: number; sample_cost_ms: number; text: string }
export interface LoadDoctorInput { processes?: readonly LoadProcess[]; panes?: readonly LoadPane[]; jobs?: readonly LoadJob[]; stateRoot?: string; machine?: Partial<LoadMachine>; now?: Date }

function runText(args: readonly string[]): string {
	try {
		const child = runSync(args, { deadline_s: 10, max_output_bytes: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
		return child.rc === 0 && !child.truncated ? new TextDecoder().decode(child.stdout) : "";
	} catch {
		return "";
	}
}

function cpuTimeMs(started: NodeJS.CpuUsage): number {
	const usage = process.cpuUsage(started);
	return (usage.user + usage.system) / 1000;
}

export function measureCpuMs(work: () => void): number {
	const started = process.cpuUsage();
	work();
	return cpuTimeMs(started);
}
export function parsePsSnapshot(output: string, withState = false): LoadProcess[] {
	const rows: LoadProcess[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
		if (!match) continue;
		const rest = match[5]!.trim();
		const started = rest.match(/^(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
		let command = started?.[2] ?? rest;
		let stat: string | undefined;
		if (withState && started) {
			const at = command.indexOf(" ");
			if (at < 1) continue;
			stat = command.slice(0, at);
			command = command.slice(at + 1).trimStart();
		}
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu_pct: Number(match[3]), rss_bytes: Number(match[4]) * 1024,
			command, ...(started ? { start_time: started[1] } : {}), ...(stat ? { stat } : {}) });
	}
	return rows;
}

export function parseTmuxSnapshot(output: string): LoadPane[] {
	const panes: LoadPane[] = [];
	for (const line of output.split("\n")) {
		const fields = line.split("|");
		const pid = Number(fields[2]);
		if (fields.length < 3 || !fields[0] || !fields[1] || !Number.isInteger(pid)) continue;
		panes.push({ session: fields[0]!, pane: `${fields[0]} ${fields[1]}`, pid, cwd: fields[3] });
	}
	return panes;
}

export function parseMemoryPressure(output: string): MemoryPressure {
	const freeMatch = output.match(/free percentage:\s*([\d.]+)%/i);
	const free_pct = freeMatch ? Number(freeMatch[1]) : null;
	const explicit = output.match(/\b(critical|warning|warn|normal)\b/i)?.[1]?.toLowerCase();
	const level: MemoryPressureLevel = explicit === "critical" ? "critical" : explicit === "warning" || explicit === "warn" ? "warn" : explicit === "normal" ? "normal" : free_pct === null ? "unknown" : free_pct < 10 ? "critical" : free_pct < 20 ? "warn" : "normal";
	return { level, free_pct: free_pct !== null && Number.isFinite(free_pct) ? free_pct : null };
}

export function parseDiskIops(output: string): number | null {
	const line = output.split("\n").map(item => item.trim()).filter(Boolean).at(-1);
	if (!line) return null;
	const numbers = [...line.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/g)].map(match => Number(match[1]));
	if (numbers.length < 2) return null;
	let total = 0;
	for (let index = 1; index < numbers.length; index += 3) total += numbers[index]!;
	return Number.isFinite(total) ? total : null;
}

function systemGroup(command: string): string | null {
	if (/Spotlight|mds|mdworker/i.test(command)) return "Spotlight";
	if (/backupd|Time Machine/i.test(command)) return "Time Machine";
	if (/softwareupdate|installd|system_installd/i.test(command)) return "softwareupdate";
	if (/WindowServer/i.test(command)) return "WindowServer";
	if (/Terminal|tmux|ntm internal-monitor/i.test(command)) return "Terminal/tmux";
	if (/index-lock-watch/i.test(command)) return "index-lock-watch";
	if (/omp.*daemon|__omp_worker_daemon/i.test(command)) return "OMP daemons";
	return null;
}

function isLsp(command: string): boolean {
	return /typescript-language-server|tsserver|pyright|pylsp|rust-analyzer/i.test(command);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function agentFromCommand(command: string): string | null {
	const profile = command.match(/(?:--profile\s+|--profile=)([^\s]+)/i)?.[1];
	if (profile) return profile;
	if (/\bcodex\b/i.test(command)) return "codex";
	if (/\bgrok\b/i.test(command)) return "grok";
	if (/\bclaude\b/i.test(command)) return "claude";
	if (/\bgemini\b/i.test(command)) return "gemini";
	if (/\bomp\b/i.test(command)) return "omp";
	return null;
}

function isDescendantOf(pid: number, ancestor: number, parent: ReadonlyMap<number, number>): boolean {
	let cursor = pid;
	const seen = new Set<number>();
	while (!seen.has(cursor)) {
		if (cursor === ancestor) return true;
		seen.add(cursor);
		const next = parent.get(cursor);
		if (!next || next === cursor) return false;
		cursor = next;
	}
	return false;
}

function paneAgent(pane: LoadPane, processes: readonly LoadProcess[], parent: ReadonlyMap<number, number>, jobs: readonly LoadJob[]): string {
	const commands = processes.filter(item => isDescendantOf(item.pid, pane.pid, parent)).map(item => item.command);
	for (const command of commands) {
		const agent = agentFromCommand(command);
		if (agent) return agent;
	}
	const job = jobs.find(item => item.tmux_pane === pane.pane);
	return job?.agent ?? "shell";
}

function collectMachine(): LoadMachine {
	const loads = loadavg();
	const top = runText(["top", "-l", "1", "-n", "0"]);
	const cpu = top.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/i);
	const pressure = parseMemoryPressure(runText(["memory_pressure", "-Q"]));
	const disk_iops = parseDiskIops(runText(["iostat", "-d"]));
	return { load1: loads[0] ?? 0, load5: loads[1] ?? 0, load15: loads[2] ?? 0, ncpu: cpus().length, cpu_user_pct: cpu ? Number(cpu[1]) : null, cpu_sys_pct: cpu ? Number(cpu[2]) : null, cpu_idle_pct: cpu ? Number(cpu[3]) : null, memory_pressure: pressure, disk_iops };
}

function defaultStateRoot(): string {
	return join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state"), "omp-kit", "load");
}

function readJobs(stateRoot: string, processes: readonly LoadProcess[]): { jobs: LoadJob[]; stale: string[] } {
	const dir = join(stateRoot, "jobs");
	const processByPid = new Map(processes.map(item => [item.pid, item]));
	const jobs: LoadJob[] = [];
	const stale: string[] = [];
	try {
		for (const file of readdirSync(dir).filter(name => name.endsWith(".json")).sort()) {
			const path = join(dir, file);
			try {
				const job = JSON.parse(readFileSync(path, "utf8")) as LoadJob;
				const current = processByPid.get(job.pid);
				if (!current || !alive(job.pid) || (job.process_start && current.start_time && job.process_start !== current.start_time)) {
					stale.push(job.id);
					try { unlinkSync(path); } catch {}
				} else {
					jobs.push(job);
				}
			} catch {
				stale.push(file);
				try { unlinkSync(path); } catch {}
			}
		}
	} catch {}
	return { jobs, stale };
}

/** Read-only lifetime diagnosis. Age alone is not authority to signal a process. */
function processFindings(processes: readonly LoadProcess[], panes: readonly LoadPane[], jobs: readonly LoadJob[], now: Date): LoadProcessFinding[] {
	const byPid = new Map(processes.map(item => [item.pid, item]));
	const zombieCounts = new Map<number, number>();
	for (const item of processes) if (item.stat?.startsWith("Z")) zombieCounts.set(item.ppid, (zombieCounts.get(item.ppid) ?? 0) + 1);
	const age = (item: LoadProcess): number | null => {
		const start = item.start_time ? Date.parse(item.start_time) : NaN;
		return Number.isFinite(start) ? Math.max(0, (now.getTime() - start) / 1000) : null;
	};
	return processes.map(item => {
		let cursor: LoadProcess | undefined = item;
		let pane: LoadPane | undefined;
		let job: LoadJob | undefined;
		let service: string | undefined;
		let session: string | undefined;
		let serviceAge: number | null = null;
		const seen = new Set<number>();
		while (cursor && !seen.has(cursor.pid)) {
			seen.add(cursor.pid);
			pane ??= panes.find(entry => entry.pid === cursor!.pid);
			job ??= jobs.find(entry => entry.pid === cursor!.pid);
			const words = cursor.command.split(" ");
			for (const flag of ["--resume", "--session"]) {
				const at = words.indexOf(flag);
				if (at >= 0 && words[at + 1]?.endsWith(".jsonl")) session ??= `session=${words[at + 1]}`;
			}
			const runAt = words.indexOf("service");
			if (runAt >= 0 && words[runAt + 1] === "run" && words[runAt + 2] && service === undefined) {
				service = `com.omp-kit.${words[runAt + 2]}`;
				serviceAge = age(cursor);
			}
			if (cursor.command.includes("loop_sentinel.py")) service ??= "com.omp-kit.loop-sentinel";
			if (words.some(word => word.endsWith("/cron") || word === "cron")) service ??= `cron: ${item.command}`;
			cursor = byPid.get(cursor.ppid);
		}
		const elapsed_s = age(item);
		const jobAge = job?.started_at ? (now.getTime() - Date.parse(job.started_at)) / 1000 : null;
		const serviceCap = service?.startsWith("com.omp-kit.") ? RUN_TIME_CAPS_MS[service.slice("com.omp-kit.".length)] : undefined;
		const zombie_children = zombieCounts.get(item.pid) ?? 0;
		const workload = ["bun test", "full-suite-verdict", "grader", "worker", "mcp", "verdict"].some(word => item.command.includes(word));
		const mcp = ["sympy-mcp", "mcp-z3-prover", "mathlas-mcp"].some(word => item.command.includes(word));
		let cause_class: LoadProcessFinding["cause_class"] = "active";
		if (item.stat?.startsWith("Z")) cause_class = "zombie";
		else if (zombie_children) cause_class = "unreaped-children";
		else if (job?.max_runtime_s !== undefined && jobAge !== null && jobAge > job.max_runtime_s) cause_class = "over-budget";
		else if (serviceCap !== undefined && serviceAge !== null && serviceAge * 1000 > serviceCap) cause_class = "over-budget";
		else if (item.stat?.includes("T") && workload) cause_class = "suspended-work";
		else if (item.ppid === 1 && workload) cause_class = "orphaned-work";
		else if (mcp && elapsed_s !== null && elapsed_s >= 86400 && (age(byPid.get(item.ppid) ?? item) ?? 0) >= 86400) cause_class = "aged-session-mcp";
		const owner = job ? `${job.agent}; pane=${job.tmux_pane || "none"}; job=${job.label}` : pane?.pane ?? service ?? session ?? "unattributed";
		return { ...item, owner, elapsed_s, cause_class, zombie_children, ...(job ? { job_id: job.id } : {}) };
	}).sort((a, b) => Number(b.cause_class !== "active") - Number(a.cause_class !== "active") || b.cpu_pct - a.cpu_pct);
}

export function censusLoad(input: LoadDoctorInput = {}): LoadCensus {
	const startedCpu = process.cpuUsage();
	const processes = [...(input.processes ?? parsePsSnapshot(runText(["ps", "-axo", "pid=,ppid=,%cpu=,rss=,lstart=,stat=,command="]), true))];
	const panes = [...(input.panes ?? parseTmuxSnapshot(runText(["tmux", "list-panes", "-a", "-F", "#{session_name}|#{window_index}.#{pane_index}|#{pane_pid}|#{pane_current_path}"])))];
	const ledger = input.jobs ? { jobs: [...input.jobs], stale: [] as string[] } : readJobs(input.stateRoot ?? defaultStateRoot(), processes);
	const parent = new Map(processes.map(item => [item.pid, item.ppid]));
	const paneByPid = new Map(panes.map(item => [item.pid, item]));
	const paneByCwd = new Map(panes.filter(item => item.cwd).map(item => [item.cwd!, item]));
	const jobByPid = new Map(ledger.jobs.map(job => [job.pid, job]));
	const paneIdentity = new Map(panes.map(pane => [pane.pid, { agent: paneAgent(pane, processes, parent, ledger.jobs), repo: pane.cwd ?? ledger.jobs.find(job => job.tmux_pane === pane.pane)?.repo ?? "unattributed" }]));
	const consumers = new Map<string, LoadConsumer>();
	const system = new Map<string, LoadSystemGroup>();
	const lsp: Record<string, number> = {};
	for (const item of processes) {
		let cursor = item.pid;
		let pane: LoadPane | undefined;
		const seen = new Set<number>();
		while (!seen.has(cursor)) {
			seen.add(cursor);
			pane = paneByPid.get(cursor);
			if (pane) break;
			const next = parent.get(cursor);
			if (!next || next === cursor) break;
			cursor = next;
		}
		pane ??= item.cwd ? paneByCwd.get(item.cwd) : undefined;
		if (isLsp(item.command)) {
			const key = pane?.session ?? "system";
			lsp[key] = (lsp[key] ?? 0) + 1;
		}
		const group = pane ? `${pane.session}|${pane.pane}` : systemGroup(item.command);
		if (!group) continue;
		if (!pane) {
			const current = system.get(group) ?? { group, cpu_pct: 0, rss_bytes: 0, pids: [] };
			current.cpu_pct += item.cpu_pct;
			current.rss_bytes += item.rss_bytes;
			current.pids.push(item.pid);
			system.set(group, current);
			continue;
		}
		const job = jobByPid.get(item.pid) ?? ledger.jobs.find(entry => entry.tmux_pane === pane!.pane);
		const identity = paneIdentity.get(pane.pid)!;
		const current = consumers.get(group) ?? { session: pane.session, pane: pane.pane, agent: identity.agent, repo: identity.repo, cpu_pct: 0, rss_bytes: 0, pids: [] };
		current.cpu_pct += item.cpu_pct;
		current.rss_bytes += item.rss_bytes;
		current.pids.push(item.pid);
		if (job && current.agent === "shell") current.agent = job.agent;
		consumers.set(group, current);
	}
	const machine: LoadMachine = input.machine ? { load1: input.machine.load1 ?? 0, load5: input.machine.load5 ?? 0, load15: input.machine.load15 ?? 0, ncpu: input.machine.ncpu ?? cpus().length, cpu_user_pct: input.machine.cpu_user_pct ?? null, cpu_sys_pct: input.machine.cpu_sys_pct ?? null, cpu_idle_pct: input.machine.cpu_idle_pct ?? null, memory_pressure: input.machine.memory_pressure ?? { level: "unknown", free_pct: null }, disk_iops: input.machine.disk_iops ?? null } : collectMachine();
	const loadPerCore = machine.load1 / Math.max(1, machine.ncpu);
	const reason = loadPerCore > 2.5 ? `load/core ${loadPerCore.toFixed(2)} (>2.50)` : "within Machine load rule";
	const ordered = [...consumers.values()].sort((a, b) => b.cpu_pct - a.cpu_pct);
	const systemGroups = [...system.values()].sort((a, b) => b.cpu_pct - a.cpu_pct);
	const verdict: LoadVerdict = loadPerCore > 2.5 ? "CONTENDED" : "OK";
	const heavyJobs = ledger.jobs.filter(job => job.state === "running" || job.state === "queued");
	const heavyText = heavyJobs.length === 0 ? "heavy jobs: none registered (LOAD1 not installed)" : `heavy jobs: ${heavyJobs.length}`;
	const findings = processFindings(processes, panes, ledger.jobs, input.now ?? new Date());
	const causeClasses: string[] = [...new Set(findings.filter(item => item.cause_class !== "active").map(item => item.cause_class))];
	if (causeClasses.length) causeClasses.unshift("leftover-process");
	else causeClasses.push(findings.length ? "active-work" : "unknown");
	const causes = findings.slice(0, 5).map(item => `pid=${item.pid} ${item.owner} ${item.cpu_pct.toFixed(1)}% age=${item.elapsed_s ?? "unknown"}s ${item.cause_class} ${item.command}`).join(", ");
	const sampleCostMs = cpuTimeMs(startedCpu);
	return { schema_version: 1, sampled_at: (input.now ?? new Date()).toISOString(), verdict, reason, machine, consumers: ordered, system_groups: systemGroups, processes: findings, cause_classes: causeClasses, lsp_counts: { total: Object.values(lsp).reduce((a, b) => a + b, 0), by_session: lsp }, heavy_jobs: heavyJobs, stale_jobs_reaped: ledger.stale, contention_streak: verdict === "CONTENDED" ? 1 : 0, sample_cost_ms: sampleCostMs, text: `${verdict}: ${reason}; ${heavyText}; top=${causes}` };
}

export function writeCensus(stateRoot: string, census: LoadCensus): void {
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const jsonl = join(stateRoot, "census.jsonl");
	try {
		if (statSync(jsonl).size >= 10 * 1024 * 1024) renameSync(jsonl, `${jsonl}.1`);
	} catch {}
	const streakPath = join(stateRoot, "contention.json");
	let prior = 0;
	try { prior = Number(JSON.parse(readFileSync(streakPath, "utf8")).streak) || 0; } catch {}
	census.contention_streak = census.verdict === "CONTENDED" ? prior + 1 : 0;
	writeFileSync(streakPath, `${JSON.stringify({ streak: census.contention_streak })}\n`, { mode: 0o600 });
	writeFileSync(join(stateRoot, "census.json"), `${JSON.stringify(census)}\n`, { mode: 0o600 });
	writeFileSync(jsonl, `${JSON.stringify(census)}\n`, { flag: "a", mode: 0o600 });
}
