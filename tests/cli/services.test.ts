import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let agents = "";
let fakebin = "";
let environment: Record<string, string>;

const PLIST = (label: string, body: string): string =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${label}</string>\n${body}</dict>\n</plist>\n`;

function writePlist(label: string, body: string): void {
	writeFileSync(join(agents, `${label}.plist`), PLIST(label, body));
}

function writeProgram(name: string): string {
	const path = join(base, "progbin", name);
	mkdirSync(join(base, "progbin"), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

function writeLaunchctlList(rows: string): void {
	writeFileSync(join(fakebin, "launchctl-list.txt"),
		`PID\tStatus\tLabel\n${rows}\n`);
}

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(tmpdir(), "omp-kit-services-"));
	const release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	agents = join(base, "agents");
	fakebin = join(base, "fakebin");
	for (const directory of [join(release, "bin"), join(release, "scripts"), agents, fakebin, home,
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	const watch = writeProgram("omp-watch.sh");
	const uca = writeProgram("uca");
	const updater = writeProgram("localbench-omp-update");
	writePlist("com.example.omp-watch",
		`\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/bin/sh</string>\n\t\t<string>-c</string>\n\t\t<string>${watch}</string>\n\t</array>\n\t<key>StartInterval</key>\n\t<integer>10800</integer>\n`);
	writePlist("com.example.uca",
		`\t<key>Program</key>\n\t<string>${uca}</string>\n\t<key>KeepAlive</key>\n\t<true/>\n`);
	writePlist("dev.localbench.omp-update",
		`\t<key>Program</key>\n\t<string>${updater}</string>\n\t<key>StartInterval</key>\n\t<integer>3600</integer>\n`);
	writePlist("com.example.calendar",
		`\t<key>Program</key>\n\t<string>/bin/echo</string>\n\t<key>RunAtLoad</key>\n\t<true/>\n`);
	// "company"/"companion" contain the letters o-m-p but are not the omp token.
	writePlist("com.example.company",
		`\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/opt/example/company-tool</string>\n\t\t<string>--companion-sync</string>\n\t</array>\n\t<key>StartInterval</key>\n\t<integer>60</integer>\n`);
	writeLaunchctlList([
		`123\t0\tcom.example.omp-watch`,
		`-\t1\tcom.example.uca`,
		`-\t1\tdev.localbench.omp-update`,
	].join("\n"));
	const listFile = join(fakebin, "launchctl-list.txt");
	const printTable = join(fakebin, "launchctl-print.txt");
	// The stub is resolved via PATH, so $0 carries no directory: the table path is baked in.
	writeFileSync(join(fakebin, "launchctl"), [
		"#!/bin/sh",
		`if [ "$1" = "list" ]; then cat ${JSON.stringify(listFile)}; exit 0; fi`,
		`if [ "$1" = "print" ]; then hit=$(grep -F -e "$2 " ${JSON.stringify(printTable)} 2>/dev/null | head -n 1); if [ -z "$hit" ]; then exit 1; fi; echo "path = \${hit#* }"; exit 0; fi`,
		"exit 1",
	].join("\n"));
	chmodSync(join(fakebin, "launchctl"), 0o755);
	writeFileSync(join(home, "s3-logs-refresh.log"), "2026-10-01T11:00:00Z STALE work queued\n");
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(binary, 0o755);
	environment = {
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: `${fakebin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		OMP_KIT_SERVICES_DIRS: agents,
		OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

type ServicesEnvelope = {
	data?: {
		overall?: string;
		findings?: { component?: string; status?: string; reason?: string; evidence?: {
			rows?: { label?: string; class?: string; program_ok?: string; loaded_plist?: string | null; plist?: string | null; omp_related?: boolean; verified?: boolean }[];
			required?: { name?: string; label?: string; status?: string; detail?: string }[];
			duplicates?: { program?: string; labels?: string[] }[];
		} }[];
	};
	errors?: { code?: string }[];
};

function runCli(args: string[]): { exitCode: number; envelope: ServicesEnvelope } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as ServicesEnvelope };
}

function declaredFile(name: string, content: unknown): string {
	const path = join(base, name);
	writeFileSync(path, JSON.stringify(content));
	return path;
}

function evidenceOf(envelope: ServicesEnvelope) {
	const finding = (envelope.data?.findings ?? []).find(item => item.component === "services");
	return { finding, rows: finding?.evidence?.rows ?? [], required: finding?.evidence?.required ?? [],
		duplicates: finding?.evidence?.duplicates ?? [] };
}

test("inventory classifies rows and flags only OMP-related jobs", () => {
	const path = declaredFile("required.json", { schema_version: 1, jobs: [
		{ label: "com.example.omp-watch", name: "omp-watch" },
		{ label: "com.example.uca", name: "UCA" },
		{ label: "com.example.sbh", name: "sbh" },
		{ label: "dev.localbench.omp-update", name: "localbench omp-update",
			healthy_exit: [0, 1], log_file: "~/s3-logs-refresh.log", require_log_line_if_exit_1: "STALE" },
	] });
	const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--services", path, "--json"]);
	expect(exitCode).toBe(0);
	expect(envelope.data?.overall).toBe("DEGRADED");
	const { finding, rows, required } = evidenceOf(envelope);
	expect(finding?.status).toBe("DEGRADED");
	expect(rows.find(row => row.label === "com.example.omp-watch")).toMatchObject({ class: "RUNNING", omp_related: true });
	expect(rows.find(row => row.label === "com.example.uca")).toMatchObject({ class: "FAILING", omp_related: true });
	expect(rows.find(row => row.label === "com.example.calendar")).toMatchObject({ class: "NOT_LOADED", omp_related: false });
	expect(rows.find(row => row.label === "com.example.company")).toMatchObject({ omp_related: false });
	expect(required.find(item => item.name === "omp-watch")?.status).toBe("OK");
	expect(required.find(item => item.name === "UCA")?.status).toBe("UNHEALTHY");
	expect(required.find(item => item.name === "sbh")?.status).toBe("MISSING");
	const localbench = required.find(item => item.name === "localbench omp-update");
	expect(localbench?.status).toBe("OK");
	expect(localbench?.detail).toContain("required log line");
	expect(finding?.reason).not.toContain("calendar");
	expect(finding?.reason).not.toContain("localbench omp-update (FAILING)");
}, 120_000);

test("exit 1 without the required STALE line is UNHEALTHY, not silently healthy", () => {
	writeFileSync(join(home, "s3-logs-clean.log"), "2026-10-01T11:00:00Z all caught up\n");
	writeLaunchctlList([
		`123\t0\tcom.example.omp-watch`,
		`-\t1\tdev.localbench.omp-update`,
	].join("\n"));
	try {
		const path = declaredFile("required-nostale.json", { schema_version: 1, jobs: [
			{ label: "dev.localbench.omp-update", name: "localbench omp-update",
				healthy_exit: [0, 1], log_file: "~/s3-logs-clean.log", require_log_line_if_exit_1: "STALE" },
		] });
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--services", path, "--json"]);
		expect(exitCode).toBe(0);
		expect(envelope.data?.overall).toBe("DEGRADED");
		const { required } = evidenceOf(envelope);
		const localbench = required.find(item => item.name === "localbench omp-update");
		expect(localbench?.status).toBe("UNHEALTHY");
		expect(localbench?.detail).toContain("lacks required log line");
	} finally {
		writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `-\t1\tcom.example.uca`, `-\t1\tdev.localbench.omp-update`].join("\n"));
	}
}, 120_000);

test("DUPLICATE_WRAPPER_PLANT: shared wrapper scripts deduplicate on the resolved script", () => {
	const shared = writeProgram("shared-nightly.sh");
	const first = join(agents, "com.example.nightly-a.plist");
	const second = join(agents, "com.example.nightly-b.plist");
	for (const [file, label] of [[first, "com.example.nightly-a"], [second, "com.example.nightly-b"]] as const) {
		writeFileSync(file, PLIST(label,
			`\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/bin/sh</string>\n\t\t<string>${shared}</string>\n\t</array>\n\t<key>StartInterval</key>\n\t<integer>60</integer>\n`));
	}
	writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `7\t0\tcom.example.nightly-a`, `8\t0\tcom.example.nightly-b`].join("\n"));
	try {
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--json"]);
		expect(exitCode).toBe(0);
		const { duplicates } = evidenceOf(envelope);
		expect(duplicates.find(entry => entry.program === shared)?.labels).toEqual(["com.example.nightly-a", "com.example.nightly-b"]);
	} finally {
		rmSync(first, { force: true });
		rmSync(second, { force: true });
		writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `-\t1\tcom.example.uca`, `-\t1\tdev.localbench.omp-update`].join("\n"));
	}
}, 120_000);

test("unreadable plist and loaded job without a plist are reported, not hidden", () => {
	writeFileSync(join(agents, "com.example.broken.plist"), "not a plist at all {{{");
	writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `9\t0\tcom.example.orphan`].join("\n"));
	try {
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--json"]);
		expect(exitCode).toBe(0);
		const { rows } = evidenceOf(envelope);
		expect(rows.find(row => row.label === "com.example.broken.plist")).toMatchObject({ class: "BROKEN" });
		expect(rows.find(row => row.label === "com.example.orphan")).toMatchObject({ class: "LOADED_NO_PLIST" });
	} finally {
		rmSync(join(agents, "com.example.broken.plist"), { force: true });
		writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `-\t1\tcom.example.uca`, `-\t1\tdev.localbench.omp-update`].join("\n"));
	}
}, 120_000);

test("symlinked programs resolve through to their targets", () => {
	const target = writeProgram("link-target.sh");
	const linked = join(base, "progbin", "linked.sh");
	const dangling = join(base, "progbin", "dangling.sh");
	symlinkSync(target, linked);
	symlinkSync(join(base, "progbin", "absent-target.sh"), dangling);
	writePlist("com.example.linked",
		`\t<key>Program</key>\n\t<string>${linked}</string>\n\t<key>StartInterval</key>\n\t<integer>60</integer>\n`);
	writePlist("com.example.dangling",
		`\t<key>Program</key>\n\t<string>${dangling}</string>\n\t<key>StartInterval</key>\n\t<integer>60</integer>\n`);
	try {
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--json"]);
		expect(exitCode).toBe(0);
		const { rows } = evidenceOf(envelope);
		expect(rows.find(row => row.label === "com.example.linked")).toMatchObject({ program_ok: "ok" });
		expect(rows.find(row => row.label === "com.example.dangling")).toMatchObject({ class: "BROKEN", program_ok: "missing" });
	} finally {
		rmSync(join(agents, "com.example.linked.plist"), { force: true });
		rmSync(join(agents, "com.example.dangling.plist"), { force: true });
		rmSync(linked, { force: true });
		rmSync(dangling, { force: true });
	}
}, 120_000);

test("MISSING_REQUIRED_PLANT: a declared job with no inventory row is flagged", () => {
	const path = declaredFile("required-missing.json", { schema_version: 1, jobs: [
		{ label: "com.example.omp-watch", name: "omp-watch" },
		{ label: "com.example.sbh", name: "sbh" },
	] });
	const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--services", path, "--json"]);
	expect(exitCode).toBe(0);
	expect(envelope.data?.overall).toBe("DEGRADED");
	const { finding, required } = evidenceOf(envelope);
	expect(required.find(item => item.name === "sbh")).toMatchObject({ status: "MISSING" });
	expect(finding?.reason).toContain("sbh (MISSING)");
}, 120_000);

test("LOADED_PATH_MISMATCH_PLANT: a job loaded from a stale plist path is flagged with both paths", () => {
	const prog = writeProgram("stale-prog.sh");
	const label = "com.example.omp-stale";
	writePlist(label,
		`\t<key>Program</key>\n\t<string>${prog}</string>\n\t<key>StartInterval</key>\n\t<integer>60</integer>\n`);
	writeLaunchctlList([
		`123\t0\tcom.example.omp-watch`,
		`-\t1\tcom.example.uca`,
		`-\t1\tdev.localbench.omp-update`,
		`123\t0\t${label}`,
	].join("\n"));
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const onDisk = join(agents, `${label}.plist`);
	const stalePath = `/stale/loaded/${label}.plist`;
	writeFileSync(join(fakebin, "launchctl-print.txt"), `gui/${uid}/${label} ${stalePath}\n`);
	try {
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--json"]);
		expect(exitCode).toBe(0);
		expect(envelope.data?.overall).toBe("DEGRADED");
		const { finding, rows } = evidenceOf(envelope);
		const stale = rows.find(row => row.label === label);
		expect(stale).toMatchObject({ class: "LOADED_PATH_MISMATCH", program_ok: "ok" });
		expect(stale?.loaded_plist).toBe(stalePath);
		expect(finding?.reason).toContain(`${label} (LOADED_PATH_MISMATCH: loaded ${stalePath} != ${onDisk})`);
		const declared = declaredFile("required-stale.json", { schema_version: 1, jobs: [
			{ label, name: "omp-stale" },
		] });
		const checked = runCli(["doctor", "--scope", "services", "--services", declared, "--json"]);
		const req = evidenceOf(checked.envelope).required.find(item => item.name === "omp-stale");
		expect(req?.status).toBe("UNHEALTHY");
		expect(req?.detail).toContain("LOADED_PATH_MISMATCH");
		expect(req?.detail).toContain(stalePath);
		expect(req?.detail).toContain(onDisk);
	} finally {
		rmSync(join(agents, `${label}.plist`), { force: true });
		rmSync(join(fakebin, "launchctl-print.txt"), { force: true });
		writeLaunchctlList([`123\t0\tcom.example.omp-watch`, `-\t1\tcom.example.uca`, `-\t1\tdev.localbench.omp-update`].join("\n"));
	}
}, 120_000);

test("matching loaded plist path stays quiet", () => {
	const label = "com.example.omp-watch";
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const onDisk = join(agents, `${label}.plist`);
	writeFileSync(join(fakebin, "launchctl-print.txt"), `gui/${uid}/${label} ${onDisk}\n`);
	try {
		const { exitCode, envelope } = runCli(["doctor", "--scope", "services", "--json"]);
		expect(exitCode).toBe(0);
		const { finding, rows } = evidenceOf(envelope);
		const watch = rows.find(row => row.label === label);
		expect(watch).toMatchObject({ class: "RUNNING" });
		expect(watch?.loaded_plist).toBe(onDisk);
		expect(finding?.reason).not.toContain("LOADED_PATH_MISMATCH");
	} finally {
		rmSync(join(fakebin, "launchctl-print.txt"), { force: true });
	}
}, 120_000);

test("invalid declared files and misused flags refuse with named codes", () => {
	const bad = declaredFile("required-bad.json", { schema_version: 1, jobs: [{ label: "x" }] });
	const refused = runCli(["doctor", "--scope", "services", "--services", bad, "--json"]);
	expect(refused.exitCode).toBe(2);
	expect(refused.envelope.errors?.[0]?.code).toBe("INVALID_SERVICES_FILE");
	const relative = runCli(["doctor", "--scope", "services", "--services", "relative.json", "--json"]);
	expect(relative.exitCode).toBe(2);
	expect(relative.envelope.errors?.[0]?.code).toBe("INVALID_SERVICES");
	const scoped = runCli(["doctor", "--scope", "memory", "--services", bad, "--json"]);
	expect(scoped.exitCode).toBe(2);
	expect(scoped.envelope.errors?.[0]?.code).toBe("INVALID_FLAG");
	const projected = runCli(["doctor", "--scope", "services", "--project", home, "--json"]);
	expect(projected.exitCode).toBe(2);
	expect(projected.envelope.errors?.[0]?.code).toBe("INVALID_FLAG");
}, 120_000);
