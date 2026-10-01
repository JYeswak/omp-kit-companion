import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkService, checkServiceLinux, installService, installSystemd, parseLaunchctlPrint, planInstall, plistDiff, renderLaunchdPlist, renderSystemdUnits, uninstallService, uninstallSystemd, validateLabel, type ServiceJobDef, type ServiceRunResult } from "../../src/service.ts";

const job: ServiceJobDef = { name: "omp-watch", label: "com.omp-kit.omp-watch", kind: "watch", intervalSeconds: 0 };
const intervalJob: ServiceJobDef = { name: "scratch-reaper", label: "com.omp-kit.scratch-reaper", kind: "interval", intervalSeconds: 86400 };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { home: string; launcher: string; watch: string } {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-"));
  roots.push(home);
  const launcher = join(home, ".local", "bin", "omp-kit");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(launcher, 0o755);
  const watch = join(home, "pkg.json");
  writeFileSync(watch, "{}\n");
  return { home, launcher, watch };
}

function runner(calls: string[][], behavior?: (args: readonly string[]) => ServiceRunResult) {
  return (args: readonly string[]): ServiceRunResult => {
    calls.push([...args]);
    if (behavior) return behavior(args);
    if (args[0] === "plutil") return { code: 0, stdout: "OK", stderr: "" };
    if (args[1] === "bootout") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "bootstrap") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "print") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

function healthyPrint(plist: string): string {
  return ["path = " + plist, "state = running", "pid = 123", "runs = 5", "last exit code = 0", ""].join("\n");
}
function healthyInput(home: string, launcher: string, watch: string) {
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), rendered);
  mkdirSync(join(home, "Library", "Logs", "omp-kit"), { recursive: true, mode: 0o750 });
  chmodSync(join(home, "Library", "Logs", "omp-kit"), 0o750);
  return { home, job, launcher, watch, rendered,
    installed: { path: "x", text: rendered },
    print: parseLaunchctlPrint(healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`))) };
}

test("labels accept dots and reject spaces and shell metacharacters", () => {
  expect(validateLabel("com.omp-kit.omp-watch")).toBe(true);
  expect(validateLabel("bad label!")).toBe(false);
  expect(validateLabel("x;rm")).toBe(false);
  expect(validateLabel("")).toBe(false);
});

test("rendered plist calls the stable launcher directly with fixed env and watch trigger", () => {
  const { home, launcher, watch } = fixture();
  const text = renderLaunchdPlist(home, job, launcher, watch).text;
  expect(text).toContain(`<string>${launcher}</string>`);
  expect(text).toContain("<string>service</string>");
  expect(text).toContain("<string>run</string>");
  expect(text).not.toContain("/bin/sh -c");
  expect(text).toContain("~/.local/bin:~/.bun/bin:~/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(text).toContain(`<string>${watch}</string>`);
  expect(text).toContain("<integer>60</integer>");
});

test("rendered plist escapes XML metacharacters in paths", () => {
  const { home, launcher } = fixture();
  const text = renderLaunchdPlist(home, job, launcher, "/pkg/a&b.json").text;
  expect(text).toContain("a&amp;b.json");
  expect(text).not.toContain("a&b.json");
});

test("interval jobs render StartInterval instead of WatchPaths", () => {
  const { home, launcher } = fixture();
  const text = renderLaunchdPlist(home, intervalJob, launcher, null).text;
  expect(text).toContain("<key>StartInterval</key>");
  expect(text).toContain("<integer>86400</integer>");
  expect(text).not.toContain("WatchPaths");
});

test("rendered plist passes plutil -lint on macOS", () => {
  if (process.platform !== "darwin") {
    console.info("skip: plutil exists only on macOS");
    return;
  }
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch);
  const file = join(home, "lint.plist");
  writeFileSync(file, rendered.text);
  const lint = Bun.spawnSync(["plutil", "-lint", file], { stdout: "pipe", stderr: "pipe" });
  expect(lint.exitCode).toBe(0);
});

test("identical plists diff empty; drifted plists diff both ways", () => {
  const { home, launcher, watch } = fixture();
  const text = renderLaunchdPlist(home, job, launcher, watch).text;
  expect(plistDiff(text, text)).toEqual([]);
  expect(plistDiff(text, text.replace("ThrottleInterval", "Other"))).not.toEqual([]);
});

test("launchctl print parses state, pid, runs and last exit", () => {
  const parsed = parseLaunchctlPrint("path = /x.plist\nstate = running\npid = 123\nruns = 5\nlast exit code = 0\n");
  expect(parsed).toMatchObject({ loaded: true, path: "/x.plist", state: "running", pid: 123, runs: 5, lastExit: 0 });
  expect(parseLaunchctlPrint("").loaded).toBe(false);
});

test("install is a no-op without touching launchctl when bytes match and the job is loaded", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const calls: string[][] = [];
  const print = parseLaunchctlPrint(healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)));
  const result = installService(home, job, launcher, watch, { path: "x", text: rendered }, print, runner(calls));
  expect(result).toMatchObject({ ok: true, changed: false, backup: null });
  expect(calls).toEqual([]);
});

test("install backs up replaced bytes and runs bootout, bootstrap and verify in order", () => {
  const { home, launcher, watch } = fixture();
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const old = renderLaunchdPlist(home, job, launcher, watch).text.replace("ThrottleInterval", "Other");
  const result = installService(home, job, launcher, watch, { path: "x", text: old }, { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null }, run);
  expect(result.ok).toBe(true);
  expect(result.changed).toBe(true);
  expect(result.backup).toContain("service-backups");
  expect(readFileSync(result.backup!, "utf8")).toBe(old);
	expect(calls.map(call => call[1])).toEqual(["bootout", "-lint", "bootstrap", "print"]);
});

test("install boots out with a single domain/label target", () => {
  const { home, launcher, watch } = fixture();
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const result = installService(home, job, launcher, watch, null, { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null }, run);
  expect(result.ok).toBe(true);
  // Separate domain and label arguments fail with exit 5; launchctl wants one target.
  const bootouts = calls.filter(call => call[1] === "bootout");
  expect(bootouts.length).toBeGreaterThan(0);
  for (const call of bootouts) expect(call).toHaveLength(3);
});

test("install unloads before replacing bytes so launchd never sees a hot swap", () => {
  const { home, launcher, watch } = fixture();
  const calls: string[][] = [];
  let bytesAtBootout: string | null = null;
  const run = runner(calls, args => {
    if (args[1] === "bootout") bytesAtBootout = readFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), "utf8");
    if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
	const old = renderLaunchdPlist(home, job, launcher, watch).text.replace("ThrottleInterval", "Other");
	mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
	writeFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), old);
  const result = installService(home, job, launcher, watch, { path: "x", text: old }, { loaded: true, path: join(home, "Library", "LaunchAgents", `${job.label}.plist`), state: "running", pid: 1, runs: 1, lastExit: 0 }, run);
  expect(result.ok).toBe(true);
  expect(bytesAtBootout).toBe(old);
});

test("install retries bootout plus bootstrap when already loaded", () => {
  const { home, launcher, watch } = fixture();
  const calls: string[][] = [];
  let bootstraps = 0;
  const run = runner(calls, args => {
    if (args[1] === "bootstrap" && bootstraps++ === 0) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: already loaded" };
    if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const result = installService(home, job, launcher, watch, null, { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null }, run);
  expect(result.ok).toBe(true);
  expect(calls.filter(call => call[1] === "bootstrap")).toHaveLength(2);
  expect(calls.filter(call => call[1] === "bootout")).toHaveLength(2);
});

test("uninstall on an absent job reports already_absent and still bootouts", () => {
  const { home } = fixture();
  const calls: string[][] = [];
  const result = uninstallService(home, job, runner(calls), false);
  expect(result).toMatchObject({ ok: true, changed: false, alreadyAbsent: true });
  expect(calls.map(call => call[1])).toEqual(["bootout"]);
});

test("uninstall moves the plist into the backup dir outside LaunchAgents", () => {
  const { home, launcher, watch } = fixture();
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const installed = installService(home, job, launcher, watch, null, { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null }, run);
  expect(installed.ok).toBe(true);
  const dest = join(home, "Library", "LaunchAgents", `${job.label}.plist`);
  const removed = uninstallService(home, job, runner(calls), false);
  expect(removed.ok).toBe(true);
  expect(removed.backup).toContain("service-backups");
  expect(() => readFileSync(dest, "utf8")).toThrow();
  expect(readFileSync(removed.backup!, "utf8")).toContain(job.label);
});

test("a healthy install passes every doctor check", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  const byId = Object.fromEntries(checkService(input).map(check => [check.id, check]));
  for (const id of ["plist-present", "plist-valid", "plist-matches-renderer", "binary-resolves", "loaded",
    "last-exit", "crash-loop", "duplicate-jobs", "log-dir-logs", "trigger-target-exists", "scope-sanity"]) {
    expect(byId[id]?.status, id).toBe("PASS");
  }
});

function planted(id: string, mutate: (input: {
  home: string; launcher: string; watch: string | null; rendered: string;
  installed: { path: string; text: string } | null;
}) => void): string {
  const { home, launcher, watch } = fixture();
  const boxed = { home, job, launcher, watch: watch as string | null, rendered: "",
    installed: null as { path: string; text: string } | null };
  mutate(boxed);
  if (!boxed.rendered) boxed.rendered = renderLaunchdPlist(home, job, boxed.launcher, boxed.watch).text;
  if (boxed.installed === null && id !== "plist-present") {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), boxed.rendered);
    boxed.installed = { path: "x", text: boxed.rendered };
  }
  const print = parseLaunchctlPrint(healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)));
  const found = checkService({ home: boxed.home, job, launcher: boxed.launcher, watch: boxed.watch, installed: boxed.installed, print, rendered: boxed.rendered }).find(check => check.id === id);
  if (!found) throw new Error(`check ${id} missing`);
  return found.status;
}

test("planted: absent plist fails plist-present", () => {
  expect(planted("plist-present", () => {})).toBe("FAIL");
});
test("planted: mismatched label fails plist-valid", () => {
  expect(planted("plist-valid", boxed => {
    boxed.installed = { path: "x", text: boxed.rendered.replace(job.label, "com.evil.other") };
  })).toBe("FAIL");
});

test("planted: drifted bytes warn on plist-matches-renderer", () => {
  expect(planted("plist-matches-renderer", boxed => {
    boxed.installed = { path: "x", text: boxed.rendered.replace("ThrottleInterval", "Other") };
  })).toBe("WARN");
});

test("planted: missing launcher fails binary-resolves", () => {
  expect(planted("binary-resolves", boxed => { boxed.launcher = join(boxed.home, "nope"); })).toBe("FAIL");
});

test("planted: versioned symlink target warns on binary-resolves", () => {
  expect(planted("binary-resolves", boxed => {
    const target = join(boxed.home, "releases", "v9", "bin", "omp-kit");
    mkdirSync(join(boxed.home, "releases", "v9", "bin"), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    rmSync(boxed.launcher);
    symlinkSync(target, boxed.launcher);
  })).toBe("WARN");
});

test("planted: unloaded job fails loaded", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const found = checkService({ home, job, launcher, watch, rendered,
    installed: { path: "x", text: rendered },
    print: { loaded: false, path: null, state: null, pid: null, runs: null, lastExit: null } }).find(check => check.id === "loaded");
  expect(found?.status).toBe("FAIL");
});

test("planted: foreign plist path fails loaded", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const found = checkService({ home, job, launcher, watch, rendered,
    installed: { path: "x", text: rendered },
    print: { loaded: true, path: "/tmp/evil.plist", state: "running", pid: 1, runs: 1, lastExit: 0 } }).find(check => check.id === "loaded");
  expect(found?.status).toBe("FAIL");
});

test("planted: nonzero last exit warns on last-exit", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const found = checkService({ home, job, launcher, watch, rendered,
    installed: { path: "x", text: rendered },
    print: { loaded: true, path: "x", state: "running", pid: 1, runs: 3, lastExit: 1 } }).find(check => check.id === "last-exit");
  expect(found?.status).toBe("WARN");
});

test("planted: spawn-scheduled flood fails crash-loop", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const found = checkService({ home, job, launcher, watch, rendered,
    installed: { path: "x", text: rendered },
    print: { loaded: true, path: "x", state: "spawn scheduled", pid: null, runs: 30966, lastExit: 2 } }).find(check => check.id === "crash-loop");
  expect(found?.status).toBe("FAIL");
});

test("planted: second label on the same binary fails duplicate-jobs", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  writeFileSync(join(home, "Library", "LaunchAgents", "com.omp-kit.shadow.plist"),
    renderLaunchdPlist(home, { ...job, label: "com.omp-kit.shadow" }, launcher, watch).text.replace(job.label, "com.omp-kit.shadow"));
  const found = checkService(input).find(check => check.id === "duplicate-jobs");
  expect(found?.status).toBe("FAIL");
});

test("planted: stale bak sibling fails duplicate-jobs", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  writeFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist.bak-1`), "stale\n");
  const found = checkService(input).find(check => check.id === "duplicate-jobs");
  expect(found?.status).toBe("FAIL");
});

test("planted: foreign disabled file passes duplicate-jobs", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  writeFileSync(join(home, "Library", "LaunchAgents", "ai.example.other.plist.DISABLED-duplicate-server-20260830T141426Z"), "foreign\n");
  const found = checkService(input).find(check => check.id === "duplicate-jobs");
  expect(found?.status).toBe("PASS");
});

test("planted: oversized own log warns on log-dir-logs", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  const big = join(home, "Library", "Logs", "omp-kit", `${job.name}.err.log`);
  writeFileSync(big, "x");
  truncateSync(big, 51 * 1024 * 1024);
  const found = checkService(input).find(check => check.id === "log-dir-logs");
  expect(found?.status).toBe("WARN");
});

test("planted: unknown watch target fails trigger-target-exists", () => {
  const { home, launcher } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, null).text;
  const found = checkService({ home, job, launcher, watch: null, rendered,
    installed: { path: "x", text: rendered },
    print: { loaded: true, path: "x", state: "running", pid: 1, runs: 1, lastExit: 0 } }).find(check => check.id === "trigger-target-exists");
  expect(found?.status).toBe("FAIL");
});

test("linux units render service plus path trigger with fixed env", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  expect(units.service).toContain(`ExecStart=${launcher} service run omp-watch`);
  expect(units.service).toContain("Environment=PATH=");
  expect(units.path).toContain(`PathChanged=${watch}`);
  expect(units.path).toContain("WantedBy=default.target");
});

test("linux install is a no-op when bytes match and the trigger is enabled", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[2] === "is-enabled") return { code: 0, stdout: "enabled", stderr: "" };
    if (args[2] === "is-active") return { code: 0, stdout: "active", stderr: "" };
    if (args[2] === "show") return { code: 0, stdout: join(home, ".config", "systemd", "user", `omp-kit-${job.name}.service`) + "\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `omp-kit-${job.name}.service`), units.service);
  const result = installSystemd(home, job, units, run);
  expect(result).toMatchObject({ ok: true, changed: false });
  expect(calls.some(call => call.includes("daemon-reload"))).toBe(false);
});

test("linux uninstall moves units to the backup dir", () => {
  const { home } = fixture();
  const calls: string[][] = [];
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `omp-kit-${job.name}.service`), "unit\n");
  const result = uninstallSystemd(home, job, runner(calls));
  expect(result.ok).toBe(true);
  expect(result.backup).toContain("service-backups");
  expect(() => readFileSync(join(dir, `omp-kit-${job.name}.service`), "utf8")).toThrow();
});

test("linux doctor flags a missing unit and a stopped trigger", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  const found = checkServiceLinux({ home, job, launcher, unit: `omp-kit-${job.name}.service`, timer: null, pathUnit: null,
    renderedService: units.service, enabled: false, active: false, fragmentPath: null }).filter(check => check.status !== "PASS").map(check => check.id).sort();
  expect(found).toEqual(["loaded", "unit-matches-renderer", "unit-present"]);
});

function cli(args: string[], home: string) {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
    cwd: home, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
}

test("service run executes the stable launcher and writes a job receipt", () => {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-run-"));
  roots.push(home);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\necho '{\"ok\":true}'\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "omp-kit"), 0o755);
  mkdirSync(join(home, ".local", "state", "omp-kit"), { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".local", "state", "omp-kit"), 0o700);
  const result = cli(["service", "run", "omp-watch"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data).toMatchObject({ overall: "OK", job: "omp-watch" });
  const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "jobs", "omp-watch.json"), "utf8"));
  expect(receipt).toMatchObject({ exit: 0 });
  expect(typeof receipt.started_at).toBe("string");
  expect(result.stderr).toBe("");
});

test("service run maps a failing launcher to FINDINGS without losing the receipt", () => {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-run-"));
  roots.push(home);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp-kit"), "#!/bin/sh\necho boom >&2\nexit 3\n", { mode: 0o755 });
  chmodSync(join(bin, "omp-kit"), 0o755);
  mkdirSync(join(home, ".local", "state", "omp-kit"), { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".local", "state", "omp-kit"), 0o700);
  const result = cli(["service", "run", "omp-watch"], home);
  expect(result.code).toBe(1);
  expect(result.envelope.data).toMatchObject({ overall: "FINDINGS", job: "omp-watch" });
  expect(result.envelope.errors[0].code).toBe("JOB_FAILED");
  const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "jobs", "omp-watch.json"), "utf8"));
  expect(receipt.exit).toBe(3);
});

test("service status reports HOME-scoped install state from source", () => {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-run-"));
  roots.push(home);
  const status = cli(["service", "status", "omp-watch"], home);
  expect(status.envelope.data.job).toBe("omp-watch");
  expect(status.envelope.data.status[0]).toMatchObject({ name: "omp-watch", installed: false });
  expect(["OK", "FINDINGS"]).toContain(status.envelope.data.overall);
});

function prodLabelLoaded(): boolean {
  const child = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid?.() ?? 501}/${job.label}`], { stdout: "pipe", stderr: "pipe" });
  return child.exitCode === 0;
}

test("service install without --apply refuses and writes no plist", () => {
  const { home } = fixture();
  const result = cli(["service", "install", "omp-watch"], home);
  expect(result.code).toBe(2);
  expect(result.envelope.errors[0].code).toBe("INSTALL_REQUIRES_APPLY");
  expect(() => readFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), "utf8")).toThrow();
});

test("service uninstall without --apply refuses and keeps the plist", () => {
  const { home } = fixture();
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const dest = join(home, "Library", "LaunchAgents", `${job.label}.plist`);
  writeFileSync(dest, "stale-bytes\n");
  const result = cli(["service", "uninstall", "omp-watch"], home);
  expect(result.code).toBe(2);
  expect(result.envelope.errors[0].code).toBe("UNINSTALL_REQUIRES_APPLY");
  expect(readFileSync(dest, "utf8")).toBe("stale-bytes\n");
});

test("service uninstall reports already_absent through the CLI wire", () => {
  if (prodLabelLoaded()) return; // never bootout a live production job; CI never has it loaded
  const { home } = fixture();
  const result = cli(["service", "uninstall", "omp-watch", "--apply", "--yes"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data).toMatchObject({ overall: "OK", job: "omp-watch", already_absent: true });
});

test("service uninstall moves a stale plist to backup through the CLI wire", () => {
  if (prodLabelLoaded()) return; // never bootout a live production job; CI never has it loaded
  const { home } = fixture();
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const dest = join(home, "Library", "LaunchAgents", `${job.label}.plist`);
  writeFileSync(dest, "stale-bytes\n");
  const result = cli(["service", "uninstall", "omp-watch", "--apply", "--yes"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data.backup).toContain("service-backups");
  expect(() => readFileSync(dest, "utf8")).toThrow();
  expect(readFileSync(result.envelope.data.backup, "utf8")).toBe("stale-bytes\n");
});

test("systemd install addresses real unit names and backs up replaced bytes", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[2] === "is-enabled") return { code: 0, stdout: "enabled", stderr: "" };
    if (args[2] === "is-active") return { code: 0, stdout: "active", stderr: "" };
    if (args[2] === "show") return { code: 0, stdout: join(home, ".config", "systemd", "user", `omp-kit-${job.name}.service`) + "\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `omp-kit-${job.name}.service`), "old-bytes\n");
  const result = installSystemd(home, job, units, run);
  expect(result.ok).toBe(true);
  expect(result.backup).toContain("service-backups");
  expect(readFileSync(join(result.backup!, `omp-kit-${job.name}.service`), "utf8")).toBe("old-bytes\n");
  expect(readFileSync(join(dir, `omp-kit-${job.name}.path`), "utf8")).toBe(units.path);
  for (const call of calls) for (const word of call) expect(word).not.toContain("[object Object]");
  expect(calls.some(call => call.at(-1) === `omp-kit-${job.name}.path`)).toBe(true);
});

test("systemd uninstall disables both path and timer triggers", () => {
  const { home } = fixture();
  const calls: string[][] = [];
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `omp-kit-${job.name}.service`), "unit\n");
  const result = uninstallSystemd(home, job, runner(calls));
  expect(result.ok).toBe(true);
  const disabled = calls.filter(call => call[2] === "disable").map(call => call.at(-1)).sort();
  expect(disabled).toEqual([`omp-kit-${job.name}.path`, `omp-kit-${job.name}.timer`]);
});

test("examples omp-watch renders the managed plist and installs nothing", () => {
  const { home } = fixture();
  const result = cli(["examples", "omp-watch"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data.label).toBe(job.label);
  expect(result.envelope.data.launchd_plist).toContain("<string>service</string>");
  expect(result.envelope.data.launchd_plist).not.toContain("/bin/sh -c");
  expect(result.envelope.data.systemd_service_unit).toContain("service run omp-watch");
  expect(() => readFileSync(join(home, "Library", "LaunchAgents", `${job.label}.plist`), "utf8")).toThrow();
});
