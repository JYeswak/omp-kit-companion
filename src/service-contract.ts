import { isAbsolute } from "node:path";
import { looksSecret } from "./mcp-sources.ts";
import type { ServiceCheck } from "./service.ts";

/**
 * SVC1 contract checks over rendered/installed job definitions.
 *
 * Pure functions of plist/unit text: no launchd, no filesystem, no edits.
 * `service doctor` (service.ts `checkService`/`checkServiceLinux`, wired by its
 * holder) concats these after the existing presence/drift checks. Each check id
 * is namespaced `contract-*` so the contract doc maps one-to-one.
 *
 * Secret scanning reuses the canonical `looksSecret` from mcp-sources.ts;
 * findings name the key, never the value.
 */

function fail(id: string, message: string, remediation: string): ServiceCheck {
	return { id, status: "FAIL", message, remediation };
}

function pass(id: string, message: string): ServiceCheck {
	return { id, status: "PASS", message, remediation: "None." };
}

/** EnvironmentVariables entries of a launchd plist: key -> raw string value. */
function plistEnvironment(text: string): Record<string, string> {
	const entries: Record<string, string> = {};
	const dict = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
	if (!dict) return entries;
	const itemPattern = /<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(dict[1] ?? "")) !== null) {
		entries[match[1] ?? ""] = match[2] ?? "";
	}
	return entries;
}

function plistFlag(text: string, key: string): boolean | null {
	const match = text.match(new RegExp(`<key>${key}<\\/key>\\s*<(true|false)\\/>`));
	if (!match) return null;
	return match[1] === "true";
}

function plistString(text: string, key: string): string | null {
	const match = text.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]*)<\\/string>`));
	return match ? (match[1] ?? "") : null;
}

/** Env key names that must never appear in a rendered job definition. */
const SECRET_KEY_NAME = /(api[_-]?key|auth[_-]?token|bearer|credentials?|passwd|password|private[_-]?key|secret|token)/i;

function secretEnvKey(env: Record<string, string>): string | null {
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY_NAME.test(key)) return key;
		if (looksSecret(value)) return key;
	}
	return null;
}

/**
 * Static contract checks for one launchd plist. The contract (SVC1 box 1):
 * RunAtLoad false, ProcessType Background, explicit absolute PATH/HOME,
 * no secrets or secret paths, out/err log paths, low-priority shape.
 */
export function checkPlistContract(jobName: string, text: string): ServiceCheck[] {
	const checks: ServiceCheck[] = [];
	const runAtLoad = plistFlag(text, "RunAtLoad");
	checks.push(runAtLoad === false
		? pass("contract-run-at-load", "RunAtLoad is false; the job never fires at boot")
		: fail("contract-run-at-load",
			runAtLoad === null ? "RunAtLoad key is missing" : "RunAtLoad is true; the job fires at every boot",
			`Render ${jobName} with RunAtLoad false (SVC1 contract); boot-time stampedes are what the load gate cannot catch.`));
	const processType = plistString(text, "ProcessType");
	checks.push(processType === "Background"
		? pass("contract-processtype", "ProcessType is Background")
		: fail("contract-processtype",
			processType === null ? "ProcessType key is missing" : `ProcessType is ${processType}, not Background`,
			`Render ${jobName} with ProcessType Background (SVC1 contract).`));
	const env = plistEnvironment(text);
	const home = env["HOME"] ?? "";
	const path = env["PATH"] ?? "";
	checks.push(home !== "" && isAbsolute(home) && path !== "" && path.split(":").every(entry => entry === "" || isAbsolute(entry))
		? pass("contract-env", "HOME and PATH are explicit and absolute")
		: fail("contract-env",
			`HOME=${home === "" ? "(missing)" : "not absolute"} PATH=${path === "" ? "(missing)" : "has relative entries"}`,
			`Render ${jobName} with explicit absolute HOME and PATH from config; launchd jobs must not inherit a caller PATH.`));
	const secretKey = secretEnvKey(env);
	checks.push(secretKey === null
		? pass("contract-no-secrets", "No secret key names or secret-shaped values in EnvironmentVariables")
		: fail("contract-no-secrets",
			`EnvironmentVariables entry ${secretKey} is secret-named or secret-shaped`,
			`Remove ${secretKey} from the rendered ${jobName} definition (SVC1/PUB1: no secrets or secret paths in the plist). The value is never printed.`));
	const outPath = plistString(text, "StandardOutPath");
	const errPath = plistString(text, "StandardErrorPath");
	checks.push(outPath !== null && errPath !== null
		? pass("contract-log-paths", "StandardOutPath and StandardErrorPath are set")
		: fail("contract-log-paths", "Out/err log paths are missing; failures would be invisible",
			`Render ${jobName} with StandardOutPath/StandardErrorPath under Library/Logs/omp-kit.`));
	const nice = text.match(/<key>Nice<\/key>\s*<integer>(-?\d+)<\/integer>/);
	const lowIo = plistFlag(text, "LowPriorityIO");
	checks.push(nice !== null && Number(nice[1]) >= 10 && lowIo === true
		? { id: "contract-low-priority", status: "PASS", message: "Nice 10 with LowPriorityIO; the job yields to interactive work", remediation: "None." }
		: { id: "contract-low-priority", status: "WARN", message: "Job is not low-priority shaped (Nice 10 + LowPriorityIO)", remediation: `Render ${jobName} with Nice 10 and LowPriorityIO true.` });
	return checks;
}

/** Environment lines of a systemd unit: KEY -> raw (still quoted) value. */
function systemdEnvironment(text: string): Record<string, string> {
	const entries: Record<string, string> = {};
	const linePattern = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = linePattern.exec(text)) !== null) {
		entries[match[1] ?? ""] = match[2] ?? "";
	}
	return entries;
}

function unquoteUnit(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
		return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\").replace(/\$\$\$\$/g, "$").replace(/%%/g, "%");
	}
	return trimmed;
}

/**
 * Static contract checks for one systemd service unit. Mirrors the plist
 * contract: explicit absolute env, no secrets, oneshot with a start timeout
 * (the runtime time cap is enforced by `service run`, checked separately).
 */
export function checkSystemdContract(jobName: string, service: string): ServiceCheck[] {
	const checks: ServiceCheck[] = [];
	const env = systemdEnvironment(service);
	const home = unquoteUnit(env["HOME"] ?? "");
	const path = unquoteUnit(env["PATH"] ?? "");
	const tmpdir = unquoteUnit(env["TMPDIR"] ?? "");
	checks.push(home !== "" && isAbsolute(home) && path !== "" && tmpdir !== "" && isAbsolute(tmpdir)
		? pass("contract-systemd-env", "HOME, PATH and TMPDIR are explicit and absolute")
		: fail("contract-systemd-env", "HOME, PATH or TMPDIR is missing or not absolute",
			`Render omp-kit-${jobName}.service with explicit absolute HOME, PATH and TMPDIR.`));
	let secretKey: string | null = null;
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY_NAME.test(key) || looksSecret(unquoteUnit(value))) {
			secretKey = key;
			break;
		}
	}
	checks.push(secretKey === null
		? pass("contract-systemd-no-secrets", "No secret key names or secret-shaped values in Environment lines")
		: fail("contract-systemd-no-secrets",
			`Environment entry ${secretKey} is secret-named or secret-shaped`,
			`Remove ${secretKey} from omp-kit-${jobName}.service (SVC1/PUB1). The value is never printed.`));
	const typeLine = service.match(/^Type=(\S+)$/m)?.[1] ?? null;
	checks.push(typeLine === "oneshot"
		? pass("contract-systemd-oneshot", "Type is oneshot; the job cannot linger as a daemon")
		: fail("contract-systemd-oneshot",
			typeLine === null ? "Type line is missing" : `Type is ${typeLine}, not oneshot`,
			`Render omp-kit-${jobName}.service with Type=oneshot.`));
	const timeout = service.match(/^TimeoutStartSec=(\d+)$/m)?.[1] ?? null;
	checks.push(timeout !== null
		? pass("contract-systemd-timeout", `TimeoutStartSec is ${timeout}; a hung start is killed`)
		: fail("contract-systemd-timeout", "TimeoutStartSec is missing; a hung start runs unbounded",
			`Render omp-kit-${jobName}.service with TimeoutStartSec (SVC1 time-cap contract).`));
	return checks;
}
