import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OmpIdentity } from "./paths.ts";
import { inspectStateRoot } from "./state-root.ts";

/**
 * OMP moves often (operators run updaters such as UCA every few hours). `test --record` stores which OMP the
 * kit was last tested against, so status/doctor can say "OMP changed since the last test" without a daemon,
 * and `examples omp-watch` renders an operator-installed launchd/systemd job that re-runs the test when the
 * OMP package changes.
 */
export type OmpFingerprint = { version: string | null; launcher_sha256: string | null };
export type TestReceipt = OmpFingerprint & {
	schema_version: 1; kit_version: string; scope: "fast" | "full"; status: string; recorded_at: string;
};

const RECEIPT_FILE = "last-test.json";

export function ompFingerprint(identity: Pick<OmpIdentity, "launcher" | "packageRoot">): OmpFingerprint {
	let version: string | null = null, launcher: string | null = null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") version = parsed.version;
	} catch { /* unreadable package: version unknown */ }
	try { launcher = createHash("sha256").update(readFileSync(identity.launcher)).digest("hex"); } catch { /* unreadable launcher */ }
	return { version, launcher_sha256: launcher };
}

/** Writes only into a private (0700, owned, real) state root; returns false instead of writing anywhere else. */
export function recordTestReceipt(stateRoot: string, receipt: TestReceipt): boolean {
	try { mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); } catch { return false; }
	if (inspectStateRoot(stateRoot)) return false;
	const path = join(stateRoot, RECEIPT_FILE), temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	return true;
}

export function readTestReceipt(stateRoot: string): TestReceipt | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(stateRoot, RECEIPT_FILE), "utf8"));
		return parsed && typeof parsed === "object" && (parsed as TestReceipt).schema_version === 1 ? parsed as TestReceipt : null;
	} catch { return null; }
}

export type OmpWatchInput = { kitLauncher: string; ompPackageJson: string; path: string };
export type OmpWatchRender = {
	label: string; watch_path: string; program_arguments: string[];
	launchd_plist: string; systemd_path_unit: string; systemd_service_unit: string;
	install: { macos: string[]; linux: string[] }; uninstall: { macos: string[]; linux: string[] }; guidance: string;
};

const LABEL = "com.omp-kit.omp-watch";
const MESSAGE = "omp-kit test did not pass after an OMP update. Run: omp-kit test --json";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** systemd.syntax(7) double-quoted value: C escapes for \ and ", %% for specifiers, $$ for env expansion. */
const systemdQuote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** Render-only: the kit never installs a scheduler or service; the operator copies these files deliberately. */
export function renderOmpWatch(input: OmpWatchInput): OmpWatchRender {
	// Both platforms run the same test; notifiers resolve from the job's PATH so a direct run can substitute them.
	const test = `${shellQuote(input.kitLauncher)} test --record --json >/dev/null 2>&1`;
	const program_arguments = ["/bin/sh", "-c",
		`${test} || { osascript -e ${shellQuote(`display notification "${MESSAGE}" with title "omp-kit"`)}; }`];
	const plistPath = `$HOME/Library/LaunchAgents/${LABEL}.plist`;
	const launchd_plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program_arguments.map((argument) => `\t\t<string>${xml(argument)}</string>`).join("\n")}
	</array>
	<key>WatchPaths</key>
	<array>
		<string>${xml(input.ompPackageJson)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(input.path)}</string>
	</dict>
	<key>ThrottleInterval</key>
	<integer>60</integer>
</dict>
</plist>
`;
	const systemd_path_unit = `[Unit]
Description=Re-test omp-kit rules when the installed OMP package changes

[Path]
PathChanged=${input.ompPackageJson.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
	const systemd_service_unit = `[Unit]
Description=omp-kit test after an OMP update

[Service]
Type=oneshot
Environment=${systemdQuote(`PATH=${input.path}`)}
ExecStart=/bin/sh -c ${systemdQuote(`${test} || { command -v notify-send >/dev/null && notify-send omp-kit ${shellQuote(MESSAGE)}; }`)}
`;
	return {
		label: LABEL, watch_path: input.ompPackageJson, program_arguments, launchd_plist, systemd_path_unit, systemd_service_unit,
		install: {
			macos: [`save launchd_plist as ${plistPath}`, `launchctl bootstrap gui/$(id -u) ${plistPath}`],
			linux: ["save systemd_path_unit as ~/.config/systemd/user/omp-kit-omp-watch.path",
				"save systemd_service_unit as ~/.config/systemd/user/omp-kit-omp-watch.service",
				"systemctl --user daemon-reload && systemctl --user enable --now omp-kit-omp-watch.path"],
		},
		uninstall: {
			macos: [`launchctl bootout gui/$(id -u)/${LABEL}`, `rm ${plistPath}`],
			linux: ["systemctl --user disable --now omp-kit-omp-watch.path",
				"rm ~/.config/systemd/user/omp-kit-omp-watch.path ~/.config/systemd/user/omp-kit-omp-watch.service"],
		},
		guidance: `Every OMP install or update (npm, bun, UCA) rewrites ${input.ompPackageJson}. On each change the job runs ${input.kitLauncher} test --record, which records the result for omp-kit status, and it notifies only when the test does not pass. Rendering installs nothing. The job's PATH is copied from this shell so it finds the same omp and omp-kit. UNVERIFIED: whether the trigger can fire before an updater finishes writing OMP; if a notification looks wrong, re-run omp-kit test --record.`,
	};
}
