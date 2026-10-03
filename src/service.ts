import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { resolveOmpIdentity } from "./paths.ts";

/**
 * Operator service lifecycle (launchd + systemd) per the consensus in
 * var/agent-tmp/reality-check.20260930/fleet/launchd-patterns/PATTERNS.md.
 * omp-kit owns only its own labels; everything else is read-only findings.
 */

export type ServiceCheckStatus = "PASS" | "WARN" | "FAIL";
export interface ServiceCheck { id: string; status: ServiceCheckStatus; message: string; remediation: string }
export interface ServiceRunResult { code: number; stdout: string; stderr: string }
export type ServiceRunner = (args: readonly string[]) => ServiceRunResult;

export interface ServiceJobDef { name: string; label: string; kind: "watch" | "interval"; intervalSeconds: number; runAtLoad?: boolean }
export const KNOWN_JOBS: Record<string, ServiceJobDef> = {
	"omp-watch": { name: "omp-watch", label: "com.omp-kit.omp-watch", kind: "watch", intervalSeconds: 0 },
	"scratch-reaper": { name: "scratch-reaper", label: "com.omp-kit.scratch-reaper", kind: "interval", intervalSeconds: 21600, runAtLoad: true },
	"kit-update": { name: "kit-update", label: "com.omp-kit.kit-update", kind: "interval", intervalSeconds: 3600, runAtLoad: false },
	"fleet-watch": { name: "fleet-watch", label: "com.omp-kit.fleet-watch", kind: "interval", intervalSeconds: 120, runAtLoad: true },
};

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const FIXED_PATH = "~/.local/bin:~/.bun/bin:~/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const LOG_THRESHOLD_BYTES = 50 * 1024 * 1024;

export function validateLabel(label: string): boolean {
	return LABEL_PATTERN.test(label) && label.length > 0 && label.length <= 255;
}

const TEST_NAMESPACE_PATTERN = /^com\.omp-kit\.test\.[A-Za-z0-9._-]+$/;

/**
 * The launchd/systemd label for a job. Production is always `com.omp-kit.<name>`.
 * Tests and smoke runs set OMP_KIT_TEST_LABEL_NAMESPACE to a unique
 * `com.omp-kit.test.<random>` value so even real launchctl calls can never address
 * a production label: an isolated HOME does not isolate the per-uid launchd domain.
 * Anything else set (including empty segments) throws instead of touching prod.
 */
export function serviceLabel(name: string): string {
	const namespace = process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
	if (namespace === undefined || namespace === "") return `com.omp-kit.${name}`;
	if (!TEST_NAMESPACE_PATTERN.test(namespace)) throw new Error(`refusing to build a service label from OMP_KIT_TEST_LABEL_NAMESPACE=${namespace}`);
	return `${namespace}.${name}`;
}

export function serviceHome(home?: string): string {
	const resolved = home ?? process.env.HOME ?? "";
	if (!isAbsolute(resolved)) throw new Error("service commands need an absolute HOME");
	return resolved;
}

export function stableLauncher(home: string): string {
	return join(home, ".local", "bin", "omp-kit");
}

export function agentsDir(home: string): string {
	return join(home, "Library", "LaunchAgents");
}

export function plistPath(home: string, label: string): string {
	return join(agentsDir(home), `${label}.plist`);
}

export function backupDir(home: string): string {
	const root = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	return join(root, "omp-kit", "service-backups");
}

export function jobsDir(home: string): string {
	const root = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	return join(root, "omp-kit", "jobs");
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RenderedPlist { label: string; text: string; launcher: string; watchPath: string | null }

export function renderLaunchdPlist(home: string, job: ServiceJobDef, launcher: string, watchPath: string | null): RenderedPlist {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		"<plist version=\"1.0\">",
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${xml(job.label)}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		`\t\t<string>${xml(launcher)}</string>`,
		"\t\t<string>service</string>",
		"\t\t<string>run</string>",
		`\t\t<string>${xml(job.name)}</string>`,
		"\t</array>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		`\t\t<key>HOME</key>`,
		`\t\t<string>${xml(home)}</string>`,
		"\t\t<key>TMPDIR</key>",
		`\t\t<string>${xml(tmpdir())}</string>`,
		"\t\t<key>PATH</key>",
		`\t\t<string>${xml(FIXED_PATH)}</string>`,
		"\t\t<key>OMP_KIT_JOB</key>",
		`\t\t<string>${xml(job.name)}</string>`,
		"\t</dict>",
		`\t<key>StandardOutPath</key>`,
		`\t<string>${xml(join(home, "Library", "Logs", "omp-kit", `${job.name}.out.log`))}</string>`,
		`\t<key>StandardErrorPath</key>`,
		`\t<string>${xml(join(home, "Library", "Logs", "omp-kit", `${job.name}.err.log`))}</string>`,
		...(job.kind === "watch" && watchPath
			? ["\t<key>WatchPaths</key>", "\t<array>", `\t\t<string>${xml(watchPath)}</string>`, "\t</array>", "\t<key>RunAtLoad</key>", "\t<false/>"]
			: ["\t<key>StartInterval</key>", `\t<integer>${job.intervalSeconds}</integer>`, "\t<key>RunAtLoad</key>", job.runAtLoad ? "\t<true/>" : "\t<false/>"]),
		"\t<key>ThrottleInterval</key>",
		"\t<integer>60</integer>",
		"\t<key>ProcessType</key>",
		"\t<string>Background</string>",
		"\t<key>Nice</key>",
		"\t<integer>10</integer>",
		"\t<key>LowPriorityIO</key>",
		"\t<true/>",
		`\t<key>WorkingDirectory</key>`,
		`\t<string>${xml(home)}</string>`,
		"</dict>",
		"</plist>",
		"",
	];
	return { label: job.label, text: lines.join("\n"), launcher, watchPath };
}

export interface RenderedSystemd { service: string; timer: string | null; path: string | null }

function systemdQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function renderSystemdUnits(home: string, job: ServiceJobDef, launcher: string, watchPath: string | null): RenderedSystemd {
	const env = [
		`Environment=HOME=${systemdQuote(home)}`,
		`Environment=PATH=${systemdQuote(FIXED_PATH.replaceAll("~", home))}`,
		`Environment=TMPDIR=${systemdQuote(tmpdir())}`,
		`Environment=OMP_KIT_JOB=${systemdQuote(job.name)}`,
	];
	const service = [
		"[Unit]",
		`Description=omp-kit ${job.name}`,
		"",
		"[Service]",
		"Type=oneshot",
		"TimeoutStartSec=600",
		`ExecStart=${launcher} service run ${job.name}`,
		...env,
		`WorkingDirectory=${home}`,
		"",
	].join("\n");
	if (job.kind === "watch" && watchPath) {
		return { service, timer: null,
			path: ["[Unit]", `Description=omp-kit ${job.name} trigger`, "", "[Path]", `PathChanged=${watchPath}`, "", "[Install]", "WantedBy=default.target", ""].join("\n") };
	}
	return { service, timer: null,
		path: null };
}

export function systemdTimer(job: ServiceJobDef): string {
	if (job.intervalSeconds <= 0) {
		return ["[Unit]", `Description=omp-kit ${job.name} schedule`, "", "[Timer]", "OnCalendar=daily", "Persistent=true", "RandomizedDelaySec=180", "", "[Install]", "WantedBy=default.target", ""].join("\n");
	}
	return ["[Unit]", `Description=omp-kit ${job.name} schedule`, "", "[Timer]",
		...(job.runAtLoad ? ["OnBootSec=0"] : []), `OnUnitActiveSec=${job.intervalSeconds}s`,
		"Persistent=true", "RandomizedDelaySec=180", "", "[Install]", "WantedBy=default.target", ""].join("\n");
}

export interface LaunchctlPrint { loaded: boolean; path: string | null; state: string | null; pid: number | null; runs: number | null; lastExit: number | null }

export function parseLaunchctlPrint(stdout: string): LaunchctlPrint {
	const path = /^\s*path\s*=\s*(.+?)\s*$/m.exec(stdout)?.[1]?.trim() ?? null;
	const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(stdout)?.[1]?.trim() ?? null;
	const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout);
	const runs = /^\s*runs\s*=\s*(\d+)\s*$/m.exec(stdout);
	const lastExit = /^\s*last exit code\s*=\s*(-?\d+)\s*$/m.exec(stdout);
	return { loaded: path !== null, path,
		state, pid: pid ? Number(pid[1]) : null, runs: runs ? Number(runs[1]) : null,
		lastExit: lastExit ? Number(lastExit[1]) : null };
}

function serviceOutputText(result: ServiceRunResult): string {
	return `${result.stdout}\n${result.stderr}`;
}

/** Bootout/bootstrap verdicts where no loaded job exists (launchctl exit 113, or exit 3 "No such process"). */
function isAbsentService(result: ServiceRunResult): boolean {
	const text = serviceOutputText(result);
	return result.code !== 0 && (/Could not find service/i.test(text) || /No such process/i.test(text) || result.code === 113 || result.code === 3);
}

/** Launchd IPC failures (exit 5 "Input/output error") worth one bounded retry before giving up. */
function isTransientLaunchctl(result: ServiceRunResult): boolean {
	return result.code === 5 || /Input\/output error/i.test(serviceOutputText(result));
}

/** Bootstrap verdicts where the job is already loaded; the caller re-boots out and retries once. */
function isAlreadyLoaded(result: ServiceRunResult): boolean {
	const text = serviceOutputText(result);
	return /already loaded/i.test(text) || /Bootstrap failed: 5\b/.test(text);
}

function sleepMs(ms: number): void {
	if ("Bun" in globalThis && typeof globalThis.Bun === "object" && globalThis.Bun !== null &&
		"sleepSync" in globalThis.Bun && typeof globalThis.Bun.sleepSync === "function") {
		globalThis.Bun.sleepSync(ms);
		return;
	}
	const end = Date.now() + ms;
	while (Date.now() < end) { /* bounded CLI wait for launchd to settle */ }
}

export function defaultRunner(args: readonly string[]): ServiceRunResult {
	const child = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" });
	return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}


export function domain(): string {
	return `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

export function executableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
export function queryPrint(label: string, run: ServiceRunner = defaultRunner): LaunchctlPrint {
	const result = run(["launchctl", "print", `${domain()}/${label}`]);
	if (result.code !== 0) return { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null };
	const parsed = parseLaunchctlPrint(result.stdout);
	return parsed.loaded ? parsed : { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null };
}

export function oversizedOwnLogs(home: string, job: ServiceJobDef): string[] {
	const big: string[] = [];
	for (const file of [`${job.name}.out.log`, `${job.name}.err.log`]) {
		try {
			if (statSync(join(home, "Library", "Logs", "omp-kit", file)).size > LOG_THRESHOLD_BYTES) big.push(join(home, "Library", "Logs", "omp-kit", file));
		} catch { /* absent logs are fine */ }
	}
	return big;
}

export interface InstalledPlist { path: string; text: string }

export function readInstalledPlist(home: string, label: string): InstalledPlist | null {
	const path = plistPath(home, label);
	try {
		if (!statSync(path).isFile() || isSymlink(path)) return null;
	} catch {
		return null;
	}
	const text = readText(path);
	return text === null ? null : { path, text };
}

export function normalizedPlistLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith("<!--"));
}

export function plistDiff(expected: string, installed: string): string[] {
	const want = normalizedPlistLines(expected);
	const have = normalizedPlistLines(installed);
	return have.filter(line => !want.includes(line)).concat(want.filter(line => !have.includes(line)));
}

export interface DoctorInput {
	home: string; job: ServiceJobDef; launcher: string; watch: string | null;
	installed: InstalledPlist | null; print: LaunchctlPrint; rendered: string;
}

export function checkService(input: DoctorInput): ServiceCheck[] {
	const checks: ServiceCheck[] = [];
	const expectedPath = plistPath(input.home, input.job.label);
	if (!input.installed) {
		checks.push({ id: "plist-present", status: "FAIL", message: `No plist at ${expectedPath}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	} else {
		checks.push({ id: "plist-present", status: "PASS", message: `Plist present at ${expectedPath}`, remediation: "None." });
	}
	if (!input.installed) {
		checks.push({ id: "plist-valid", status: "FAIL", message: "No plist to validate", remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	} else if (!input.installed.text.includes(`<string>${input.job.label}</string>`)) {
		checks.push({ id: "plist-valid", status: "FAIL", message: "Label does not match the filename stem", remediation: `Run omp-kit service install ${input.job.name} --apply --yes to rewrite it.` });
	} else {
		checks.push({ id: "plist-valid", status: "PASS", message: "Label matches the filename stem", remediation: "None." });
	}
	if (!input.installed) {
		checks.push({ id: "plist-matches-renderer", status: "FAIL", message: "No installed plist to compare", remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	} else {
		const diff = plistDiff(input.rendered, input.installed.text);
		checks.push(diff.length === 0
			? { id: "plist-matches-renderer", status: "PASS", message: "Installed plist matches the renderer", remediation: "None." }
			: { id: "plist-matches-renderer", status: "WARN", message: `Installed plist drifts by ${diff.length} normalized line(s): ${diff.slice(0, 3).join(" | ")}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to rewrite it with a backup.` });
	}
	const hasTmpdir = input.installed !== null && /<key>TMPDIR<\/key>\s*<string>[^<]+<\/string>/.test(input.installed.text);
	checks.push(hasTmpdir
		? { id: "tmpdir-present", status: "PASS", message: "Installed plist sets TMPDIR", remediation: "None." }
		: { id: "tmpdir-present", status: "FAIL", message: "Installed plist is missing TMPDIR", remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	if (!executableFile(input.launcher)) {
		checks.push({ id: "binary-resolves", status: "FAIL", message: `Launcher ${input.launcher} is missing or not executable`, remediation: "Reinstall the kit at the stable path, then reinstall the job." });
	} else {
		let versioned = false;
		try {
			const target = readlinkSync(input.launcher);
			versioned = /releases\/v|\/v\d+\.\d+/.test(target) || /releases\/v|\/v\d+\.\d+/.test(input.launcher);
		} catch {
			versioned = /releases\/v|\/v\d+\.\d+/.test(input.launcher);
		}
		checks.push(versioned
			? { id: "binary-resolves", status: "WARN", message: `Launcher resolves to a versioned path; upgrades may orphan the job`, remediation: "Point the stable launcher path at an unversioned binary, then reinstall the job." }
			: { id: "binary-resolves", status: "PASS", message: `Launcher ${input.launcher} exists and is executable`, remediation: "None." });
	}
	if (!input.print.loaded) {
		checks.push({ id: "loaded", status: "FAIL", message: `launchctl print cannot find ${input.job.label}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to bootstrap it.` });
	} else if (input.print.path !== expectedPath) {
		checks.push({ id: "loaded", status: "FAIL", message: `Loaded job points at ${input.print.path ?? "unknown"}, not ${expectedPath}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to re-point it.` });
	} else {
		checks.push({ id: "loaded", status: "PASS", message: `Loaded from ${expectedPath}`, remediation: "None." });
	}
	if (input.print.lastExit !== null && input.print.lastExit !== 0) {
		checks.push({ id: "last-exit", status: "WARN", message: `Last exit code ${input.print.lastExit} after ${input.print.runs ?? "?"} run(s)`, remediation: `Run omp-kit service logs ${input.job.name} --errors to inspect the failure.` });
	} else {
		checks.push({ id: "last-exit", status: "PASS", message: `Last exit code ${input.print.lastExit ?? "unknown (never ran)"}`, remediation: "None." });
	}
	if ((input.print.runs ?? 0) > 100 && (input.print.state ?? "") === "spawn scheduled") {
		checks.push({ id: "crash-loop", status: "FAIL", message: `state = spawn scheduled with ${input.print.runs} runs: crash loop`, remediation: `Run omp-kit service logs ${input.job.name} --errors, fix the cause, then reinstall the job.` });
	} else {
		checks.push({ id: "crash-loop", status: "PASS", message: `No crash loop (${input.print.runs ?? 0} runs)`, remediation: "None." });
	}
	const dir = agentsDir(input.home);
	let duplicates: string[] = [];
	let staleSiblings: string[] = [];
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".plist") || name === `${input.job.label}.plist`) continue;
			const text = readText(join(dir, name));
			if (text !== null && text.includes(input.launcher) && text.includes(`<string>run</string>`) && text.includes(`<string>${input.job.name}</string>`)) duplicates.push(name);
		}
		for (const name of readdirSync(dir)) {
			if (name.startsWith(`${input.job.label}.`) && name !== `${input.job.label}.plist`) staleSiblings.push(name);
		}
	} catch { /* unreadable dir: no duplicate evidence */ }
	if (duplicates.length > 0 || staleSiblings.length > 0) {
		checks.push({ id: "duplicate-jobs", status: "FAIL", message: `Duplicates: ${duplicates.join(", ") || "none"}; stale siblings: ${staleSiblings.join(", ") || "none"}. omp-kit never removes foreign labels.`, remediation: "Unload and remove the duplicate with its owning tool, keeping one label per job." });
	} else {
		checks.push({ id: "duplicate-jobs", status: "PASS", message: "No duplicate labels or stale siblings", remediation: "None." });
	}
	const logs = join(input.home, "Library", "Logs", "omp-kit");
	let logMessage = "Log directory is missing";
	let logStatus: ServiceCheckStatus = "WARN";
	try {
		const stat = statSync(logs);
		if (stat.isDirectory() && (stat.mode & 0o777 & 0o022) === 0) {
			const sizes: string[] = [];
			for (const file of [`${input.job.name}.out.log`, `${input.job.name}.err.log`]) {
				try {
					sizes.push(`${file}=${statSync(join(logs, file)).size}B`);
				} catch {
					sizes.push(`${file}=absent`);
				}
			}
			const big = sizes.some(entry => {
				const bytes = Number(entry.split("=")[1]?.replace("B", ""));
				return Number.isFinite(bytes) && bytes > LOG_THRESHOLD_BYTES;
			});
			logStatus = "PASS";
			logMessage = `Log dir private (${(stat.mode & 0o777).toString(8)}); ${sizes.join(", ")}`;
			if (big) {
				logStatus = "WARN";
				logMessage += `; over ${LOG_THRESHOLD_BYTES}B: rotate omp-kit-owned logs`;
			}
		} else {
			logMessage = "Log directory is group/other-accessible or missing";
		}
	} catch {
		logMessage = "Log directory is missing";
	}
	checks.push({ id: "log-dir-logs", status: logStatus, message: logMessage, remediation: logStatus === "PASS" ? "None." : `Run omp-kit service install ${input.job.name} --apply --yes to create it, or rotate the large log.` });
	if (input.job.kind === "watch") {
		if (!input.watch) {
			checks.push({ id: "trigger-target-exists", status: "FAIL", message: "Watch target is unknown (OMP package not resolvable)", remediation: "Install OMP, then reinstall the job." });
		} else if (!existsSync(input.watch)) {
			checks.push({ id: "trigger-target-exists", status: "FAIL", message: `Watch target ${input.watch} is missing; the job is silently dead`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to re-point it.` });
		} else {
			checks.push({ id: "trigger-target-exists", status: "PASS", message: `Watch target ${input.watch} exists`, remediation: "None." });
		}
	}
	try {
		const daemon = join("/", "Library", "LaunchDaemons", `${input.job.label}.plist`);
		if (existsSync(daemon)) {
			checks.push({ id: "scope-sanity", status: "FAIL", message: `Same label installed system-wide at ${daemon}; user scope only`, remediation: "Remove the system copy with its installer; this command reports only." });
		} else {
			checks.push({ id: "scope-sanity", status: "PASS", message: "User scope only", remediation: "None." });
		}
	} catch {
		checks.push({ id: "scope-sanity", status: "PASS", message: "User scope only", remediation: "None." });
	}
	return checks;
}
export interface LinuxUnitInput {
	home: string; job: ServiceJobDef; launcher: string; unit: string; timer: string | null; pathUnit: string | null;
	renderedService: string; enabled: boolean; active: boolean; fragmentPath: string | null;
}

export function checkServiceLinux(input: LinuxUnitInput): ServiceCheck[] {
	const checks: ServiceCheck[] = [];
	const dir = join(input.home, ".config", "systemd", "user");
	const serviceFile = join(dir, `omp-kit-${input.job.name}.service`);
	let installed: string | null = null;
	try {
		if (statSync(serviceFile).isFile() && !isSymlink(serviceFile)) installed = readText(serviceFile);
	} catch { /* absent */ }
	if (installed === null) {
		checks.push({ id: "unit-present", status: "FAIL", message: `No unit at ${serviceFile}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	} else {
		checks.push({ id: "unit-present", status: "PASS", message: `Unit present at ${serviceFile}`, remediation: "None." });
	}
	if (installed === null) {
		checks.push({ id: "unit-matches-renderer", status: "FAIL", message: "No installed unit to compare", remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	} else {
		const diff = plistDiff(input.renderedService, installed);
		checks.push(diff.length === 0
			? { id: "unit-matches-renderer", status: "PASS", message: "Installed unit matches the renderer", remediation: "None." }
			: { id: "unit-matches-renderer", status: "WARN", message: `Installed unit drifts by ${diff.length} normalized line(s)`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to rewrite it with a backup.` });
	}
	const hasTmpdir = installed !== null && /^Environment=TMPDIR="[^"]+.*"$/m.test(installed);
	checks.push(hasTmpdir
		? { id: "tmpdir-present", status: "PASS", message: "Installed unit sets TMPDIR", remediation: "None." }
		: { id: "tmpdir-present", status: "FAIL", message: "Installed unit is missing TMPDIR", remediation: `Run omp-kit service install ${input.job.name} --apply --yes.` });
	if (!executableFile(input.launcher)) {
		checks.push({ id: "binary-resolves", status: "FAIL", message: `Launcher ${input.launcher} is missing or not executable`, remediation: "Reinstall the kit at the stable path, then reinstall the job." });
	} else {
		checks.push({ id: "binary-resolves", status: "PASS", message: `Launcher ${input.launcher} exists and is executable`, remediation: "None." });
	}
	if (!input.enabled && !input.active) {
		checks.push({ id: "loaded", status: "FAIL", message: `${input.unit} is neither enabled nor active`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to enable it.` });
	} else if (input.fragmentPath !== null && input.fragmentPath !== serviceFile) {
		checks.push({ id: "loaded", status: "FAIL", message: `Loaded unit is ${input.fragmentPath}, not ${serviceFile}`, remediation: `Run omp-kit service install ${input.job.name} --apply --yes to re-point it.` });
	} else {
		checks.push({ id: "loaded", status: "PASS", message: `${input.unit} enabled=${input.enabled} active=${input.active}`, remediation: "None." });
	}
	checks.push({ id: "logs", status: "PASS", message: "Output goes to the journal; use omp-kit service logs (journalctl) to inspect", remediation: "None." });
	return checks;
}
export interface SystemdState { enabled: boolean; active: boolean; fragmentPath: string | null }

export function systemctlState(job: ServiceJobDef, run: ServiceRunner): SystemdState {
	const trigger = `omp-kit-${job.name}.${job.kind === "watch" ? "path" : "timer"}`;
	const enabled = run(["systemctl", "--user", "is-enabled", trigger]);
	const active = run(["systemctl", "--user", "is-active", trigger]);
	const show = run(["systemctl", "--user", "show", `omp-kit-${job.name}.service`, "-p", "FragmentPath", "--value"]);
	const fragment = show.code === 0 && show.stdout.trim() ? show.stdout.trim() : null;
	return { enabled: enabled.code === 0, active: active.code === 0, fragmentPath: fragment };
}

export function installSystemd(home: string, job: ServiceJobDef, units: RenderedSystemd, run: ServiceRunner, replace = false): LifecycleResult {
	const dir = join(home, ".config", "systemd", "user");
	const serviceFile = join(dir, `omp-kit-${job.name}.service`);
	const triggerFile = units.path ? join(dir, `omp-kit-${job.name}.path`) : join(dir, `omp-kit-${job.name}.timer`);
	const triggerUnit = units.path ? `omp-kit-${job.name}.path` : `omp-kit-${job.name}.timer`;
	const have = readText(serviceFile);
	const loaded = systemctlState(job, run);
	if (loaded.fragmentPath !== null && loaded.fragmentPath !== serviceFile && !replace) {
		// Same shared-domain hazard as launchd: systemctl --user is per user, not per HOME.
		return { ok: false, changed: false, backup: null,
			detail: `Unit omp-kit-${job.name}.service is already enabled from ${loaded.fragmentPath}, not ${serviceFile}. Re-run with --replace to take it over (a backup is kept).`,
			error: "LABEL_LOADED_ELSEWHERE" };
	}
	if (have !== null && have === units.service && loaded.enabled && loaded.fragmentPath === serviceFile) {
		return { ok: true, changed: false, backup: null, detail: "Identical bytes and enabled; no-op." };
	}
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const triggerText = units.path ?? systemdTimer(job);
	let backup: string | null = null;
	for (const [dest, text] of [[serviceFile, units.service], [triggerFile, triggerText]] as const) {
		const have = readText(dest);
		if (have !== null && have !== text) {
			if (!backup) {
				backup = join(backupDir(home), `${job.name}.${new Date().toISOString().replace(/[:.]/g, "-")}.unit`);
				mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
				mkdirSync(backup, { recursive: true, mode: 0o700 });
			}
			writeFileSync(join(backup, dest.split("/").at(-1) ?? "unit"), have, { mode: 0o600 });
		}
	}
	const stamp = (text: string, dest: string): void => {
		const temp = `${dest}.${process.pid}.tmp`;
		writeFileSync(temp, text, { mode: 0o644 });
		renameSync(temp, dest);
	};
	stamp(units.service, serviceFile);
	stamp(triggerText, triggerFile);
	const reload = run(["systemctl", "--user", "daemon-reload"]);
	if (reload.code !== 0) return { ok: false, changed: true, backup, detail: `daemon-reload failed: ${reload.stderr.trim() || reload.stdout.trim()}` };
	const enable = run(["systemctl", "--user", "enable", triggerUnit]);
	if (enable.code !== 0) return { ok: false, changed: true, backup, detail: `enable failed: ${enable.stderr.trim() || enable.stdout.trim()}` };
	const restart = run(["systemctl", "--user", "restart", triggerUnit]);
	if (restart.code !== 0) return { ok: false, changed: true, backup, detail: `restart failed: ${restart.stderr.trim() || restart.stdout.trim()}` };
	const state = systemctlState(job, run);
	if (!state.enabled) return { ok: false, changed: true, backup, detail: "enable did not stick." };
	return { ok: true, changed: true, backup, detail: backup ? `Replaced with backup at ${backup}.` : "Installed and enabled." };
}

export function uninstallSystemd(home: string, job: ServiceJobDef, run: ServiceRunner): LifecycleResult & { alreadyAbsent: boolean } {
	const dir = join(home, ".config", "systemd", "user");
	const files = [join(dir, `omp-kit-${job.name}.service`), join(dir, `omp-kit-${job.name}.path`), join(dir, `omp-kit-${job.name}.timer`)].filter(path => existsSync(path));
	run(["systemctl", "--user", "disable", "--now", `omp-kit-${job.name}.path`]);
	run(["systemctl", "--user", "disable", "--now", `omp-kit-${job.name}.timer`]);
	run(["systemctl", "--user", "stop", `omp-kit-${job.name}.service`]);
	if (files.length === 0) {
		return { ok: true, changed: false, backup: null, alreadyAbsent: true, detail: "Already absent." };
	}
	const backup = join(backupDir(home), `${job.name}.${new Date().toISOString().replace(/[:.]/g, "-")}.unit`);
	mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
	mkdirSync(backup, { recursive: true, mode: 0o700 });
	for (const file of files) renameSync(file, join(backup, file.split("/").at(-1) ?? "unit"));
	run(["systemctl", "--user", "daemon-reload"]);
	return { ok: true, changed: true, backup, alreadyAbsent: false, detail: `Moved ${files.length} unit file(s) to ${backup}.` };
}


export interface InstallPlan { label: string; plist: string; diff: string[]; backup: string | null; alreadyInstalled: boolean }

export function planInstall(home: string, job: ServiceJobDef, launcher: string, watchPath: string | null, installed: InstalledPlist | null): InstallPlan {
	const rendered = renderLaunchdPlist(home, job, launcher, watchPath);
	if (installed && installed.text === rendered.text) {
		return { label: job.label, plist: rendered.text, diff: [], backup: null, alreadyInstalled: true };
	}
	return { label: job.label, plist: rendered.text,
		diff: installed ? plistDiff(rendered.text, installed.text) : [],
		backup: installed ? join(backupDir(home), `${job.label}.${new Date().toISOString().replace(/[:.]/g, "-")}.plist`) : null,
		alreadyInstalled: false };
}

export interface LifecycleResult { ok: boolean; changed: boolean; backup: string | null; detail: string; error?: string }

export function ensureLogDir(home: string, jobName: string): void {
	const dir = join(home, "Library", "Logs", "omp-kit");
	mkdirSync(dir, { recursive: true, mode: 0o750 });
	chmodSync(dir, 0o750);
	for (const file of [`${jobName}.out.log`, `${jobName}.err.log`]) {
		const path = join(dir, file);
		if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
	}
}

export function installService(home: string, job: ServiceJobDef, launcher: string, watchPath: string | null,
	installed: InstalledPlist | null, print: LaunchctlPrint, run: ServiceRunner, replace = false): LifecycleResult {
	const dest = plistPath(home, job.label);
	if (print.loaded && print.path !== dest && !replace) {
		// An isolated HOME does not isolate the per-uid launchd domain: replacing a label
		// loaded from anywhere else would silently take over (or shadow) a foreign job.
		return { ok: false, changed: false, backup: null,
			detail: `Label ${job.label} is already loaded from ${print.path ?? "an unknown plist"}, not ${dest}. Re-run with --replace to take it over (a backup is kept).`,
			error: "LABEL_LOADED_ELSEWHERE" };
	}
	const plan = planInstall(home, job, launcher, watchPath, installed);
	if (plan.alreadyInstalled && print.loaded && print.path === dest) {
		return { ok: true, changed: false, backup: null, detail: "Identical bytes and loaded; no-op." };
	}
	if (plan.backup && installed) {
		mkdirSync(dirname(plan.backup), { recursive: true, mode: 0o700 });
		writeFileSync(plan.backup, installed.text, { mode: 0o600 });
	}
	// Unload before replacing bytes so launchd never runs a half-replaced
	// definition. bootout takes a single domain/label target; separate domain
	// and label arguments fail with exit 5.
	const target = `${domain()}/${job.label}`;
	let out = run(["launchctl", "bootout", target]);
	for (let attempt = 0; isTransientLaunchctl(out) && attempt < 2; attempt++) {
		sleepMs(1000);
		out = run(["launchctl", "bootout", target]);
	}
	const bootoutAbsent = isAbsentService(out);
	if (!bootoutAbsent && out.code !== 0) {
		return { ok: false, changed: true, backup: plan.backup, detail: `bootout failed: ${out.stderr.trim() || out.stdout.trim()}` };
	}
	mkdirSync(dirname(dest), { recursive: true });
	const temp = `${dest}.${process.pid}.tmp`;
	writeFileSync(temp, plan.plist, { mode: 0o600 });
	const lint = run(["plutil", "-lint", temp]);
	if (lint.code !== 0) {
		return { ok: false, changed: true, backup: plan.backup, detail: `plutil -lint refused the rendered plist: ${lint.stderr.trim() || lint.stdout.trim()}` };
	}
	renameSync(temp, dest);
	chmodSync(dest, 0o644);
	const bootOne = run(["launchctl", "bootstrap", domain(), dest]);
	let boot = bootOne;
	if (boot.code !== 0 && !isAlreadyLoaded(boot)) {
		for (let attempt = 0; isTransientLaunchctl(boot) && attempt < 2; attempt++) {
			sleepMs(1000);
			boot = run(["launchctl", "bootstrap", domain(), dest]);
		}
	}
	if (boot.code !== 0 && !isAlreadyLoaded(boot)) {
		return { ok: false, changed: true, backup: plan.backup, detail: `bootstrap failed: ${boot.stdout.trim() || boot.stderr.trim()}` };
	}
	if (boot.code !== 0) {
		const redoBootout = run(["launchctl", "bootout", target]);
		if (redoBootout.code !== 0 && !isAbsentService(redoBootout) && !isTransientLaunchctl(redoBootout)) {
			return { ok: false, changed: true, backup: plan.backup, detail: `bootstrap retry bootout failed: ${redoBootout.stderr.trim() || redoBootout.stdout.trim()}` };
		}
		const retry = run(["launchctl", "bootstrap", domain(), dest]);
		if (retry.code !== 0) {
			return { ok: false, changed: true, backup: plan.backup, detail: `bootstrap retry failed: ${retry.stdout.trim() || retry.stderr.trim()}` };
		}
	}
	const verify = run(["launchctl", "print", `${domain()}/${job.label}`]);
	const parsed = parseLaunchctlPrint(verify.stdout);
	if (verify.code !== 0 || !parsed.loaded || parsed.path !== dest) {
		return { ok: false, changed: true, backup: plan.backup, detail: `verify print failed or points elsewhere: ${verify.stdout.trim().slice(0, 200) || verify.stderr.trim().slice(0, 200)}` };
	}
	return { ok: true, changed: true, backup: plan.backup, detail: plan.backup ? `Replaced with backup at ${plan.backup}.` : "Installed and verified." };
}

export function uninstallService(home: string, job: ServiceJobDef, run: ServiceRunner, purgeLogs: boolean): LifecycleResult & { alreadyAbsent: boolean } {
	const dest = plistPath(home, job.label);
	const present = existsSync(dest);
	run(["launchctl", "bootout", `${domain()}/${job.label}`]);
	if (!present) {
		return { ok: true, changed: false, backup: null, alreadyAbsent: true, detail: "Already absent." };
	}
	const backup = join(backupDir(home), `${job.label}.${new Date().toISOString().replace(/[:.]/g, "-")}.plist`);
	mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
	renameSync(dest, backup);
	if (purgeLogs) {
		for (const file of [`${job.name}.out.log`, `${job.name}.err.log`]) {
			try {
				unlinkSync(join(home, "Library", "Logs", "omp-kit", file));
			} catch { /* absent logs are fine */ }
		}
	}
	return { ok: true, changed: true, backup, alreadyAbsent: false, detail: `Moved to ${backup}.` };
}

export function resolveWatchTarget(): string | null {
	try {
		return join(resolveOmpIdentity(process.env).packageRoot, "package.json");
	} catch {
		return null;
	}
}

export function jobReceiptPath(home: string, job: string): string {
	const root = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
	return join(root, "omp-kit", "jobs", `${job}.json`);
}

export interface JobReceipt { started_at: string; finished_at: string; exit: number; omp_version: string | null }

export interface NotifyResult { attempted: boolean; method: "osascript" | "notify-send" | "none" }

export interface NotifyInput { title: string; message: string; platform: string; run: ServiceRunner; notifySendPresent: boolean }

/**
 * Desktop failure notification for watched jobs, in-process (no sh -c).
 * Best-effort: a failed notifier never fails the job; the receipt keeps the verdict.
 */
export function notifyJobFailure(input: NotifyInput): NotifyResult {
	try {
		if (input.platform === "darwin") {
			const apple = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const out = input.run(["osascript", "-e", `display notification "${apple(input.message)}" with title "${apple(input.title)}"`]);
			return { attempted: out.code === 0, method: "osascript" };
		}
		if (input.platform === "linux" && input.notifySendPresent) {
			const out = input.run(["notify-send", input.title, input.message]);
			return { attempted: out.code === 0, method: "notify-send" };
		}
	} catch { /* notification never fails the job */ }
	return { attempted: false, method: "none" };
}
