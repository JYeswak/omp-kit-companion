import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkService, checkServiceLinux, installService, installSystemd, KNOWN_JOBS, notifyJobFailure, parseLaunchctlPrint, planInstall, plistDiff, renderLaunchdPlist, renderSystemdUnits, serviceLabel, systemctlState, systemdTimer, uninstallService, uninstallSystemd, validateLabel, type ServiceJobDef, type ServiceRunResult } from "../../src/service.ts";
import { superviseScratchJob } from "../../src/service.ts";
import { checkPlistContract, checkSystemdContract } from "../../src/service-contract.ts";
import { collectBrowserProcesses } from "../../src/browser-doctor.ts";
// Fresh clones have no var/agent-tmp; mkdtemp below requires its parent to exist.

// Every CLI spawn below inherits this namespace, so even real launchctl calls address
// test-only labels: an isolated HOME does not isolate the per-uid launchd domain.
const testNamespace = `com.omp-kit.test.s1${Math.random().toString(36).slice(2, 10)}`;
process.env.OMP_KIT_TEST_LABEL_NAMESPACE = testNamespace;
const testLabel = `${testNamespace}.omp-watch`;

const job: ServiceJobDef = { name: "omp-watch", label: "com.omp-kit.omp-watch", kind: "watch", intervalSeconds: 0 };
const intervalJob = KNOWN_JOBS["scratch-reaper"]!;
const fleetWatchJob = KNOWN_JOBS["fleet-watch"]!;
const savedXdgStateHome = process.env.XDG_STATE_HOME;
const savedTmuxTmpDir = process.env.TMUX_TMPDIR;
const SERVICE_TMP_OWNER = "owner=omp-kit\npurpose=service-tmp\nversion=1\n";
function serviceTmpDir(home: string): string {
  return join(home, ".local", "state", "omp-kit", "service-tmp");
}
function seedServiceTmp(home: string): void {
  const dir = serviceTmpDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const owner = join(dir, ".owner");
  writeFileSync(owner, SERVICE_TMP_OWNER, { mode: 0o600 });
  chmodSync(owner, 0o600);
}
function expectPrivateServiceTmp(home: string): void {
  const dir = serviceTmpDir(home);
  expect(existsSync(dir)).toBe(true);
  if (!existsSync(dir)) return;
  expect(statSync(dir).isDirectory()).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const owner = join(dir, ".owner");
  expect(existsSync(owner)).toBe(true);
  if (!existsSync(owner)) return;
  expect(statSync(owner).mode & 0o777).toBe(0o600);
  expect(readFileSync(owner, "utf8")).toBe(SERVICE_TMP_OWNER);
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdgStateHome;
  if (savedTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = savedTmuxTmpDir;
});

function fixture(): { home: string; launcher: string; watch: string } {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-"));
  roots.push(home);
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
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
  seedServiceTmp(home);
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
  const expectedPath = [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  expect(text).toContain(`<string>${expectedPath}</string>`);
  expect(text).toContain(`<string>${watch}</string>`);
  expect(text).toContain("<integer>60</integer>");
});
test("fleet-watch plist captures TMUX_TMPDIR from the install environment", () => {
  const { home, launcher, watch } = fixture();
  const tmuxTmpDir = join(home, "tmux-sockets");
  mkdirSync(tmuxTmpDir);
  process.env.TMUX_TMPDIR = tmuxTmpDir;
  const text = renderLaunchdPlist(home, fleetWatchJob, launcher, watch).text;
  expect(text).toContain(`<key>TMUX_TMPDIR</key>\n\t\t<string>${tmuxTmpDir}</string>`);
});

test("planted: fleet-watch doctor fails when the installed TMUX_TMPDIR is unresolved", () => {
  const { home, launcher, watch } = fixture();
  const tmuxTmpDir = join(home, "tmux-sockets");
  mkdirSync(tmuxTmpDir);
  process.env.TMUX_TMPDIR = tmuxTmpDir;
  const rendered = renderLaunchdPlist(home, fleetWatchJob, launcher, watch).text;
  const plistPath = join(home, "Library", "LaunchAgents", `${fleetWatchJob.label}.plist`);
  const input = {
    home, job: fleetWatchJob, launcher, watch, rendered,
    installed: { path: plistPath, text: rendered },
    print: parseLaunchctlPrint(healthyPrint(plistPath)),
  };
  expect(checkService(input).find(check => check.id === "tmux-tmpdir-resolves")?.status).toBe("PASS");
  const broken = rendered.replace(`<string>${tmuxTmpDir}</string>`, `<string>${join(home, "missing-sockets")}</string>`);
  expect(checkService({ ...input, installed: { path: plistPath, text: broken } })
    .find(check => check.id === "tmux-tmpdir-resolves")?.status).toBe("FAIL");
});

test("rendered plist uses private service scratch under the XDG state root", () => {
  const { home, launcher, watch } = fixture();
  const text = renderLaunchdPlist(home, job, launcher, watch).text;
  expect(text).toContain(`<key>TMPDIR</key>\n\t\t<string>${serviceTmpDir(home)}</string>`);
  expect(text).toContain(`<key>XDG_STATE_HOME</key>\n\t\t<string>${join(home, ".local", "state")}</string>`);
});

test("launchd no-op install provisions private service scratch with an owner marker", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text;
  const dest = join(home, "Library", "LaunchAgents", `${job.label}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(dest, rendered);
  const result = installService(home, job, launcher, watch, { path: dest, text: rendered },
    { loaded: true, path: dest, state: "running", pid: 1, runs: 1, lastExit: 0 }, runner([]));
  expect(result).toMatchObject({ ok: true, changed: false });
  expectPrivateServiceTmp(home);
});

test("rendered plist escapes XML metacharacters in paths", () => {
  const { home, launcher } = fixture();
  const text = renderLaunchdPlist(home, job, launcher, "/pkg/a&b.json").text;
  expect(text).toContain("a&amp;b.json");
  expect(text).not.toContain("a&b.json");
});

test("interval jobs render their configured cadence without run-at-load", () => {
  const { home, launcher } = fixture();
  const text = renderLaunchdPlist(home, intervalJob, launcher, null).text;
  expect(text).toContain("<key>StartInterval</key>");
  expect(text).toContain("<integer>21600</integer>");
  expect(text).toContain("<key>RunAtLoad</key>\n\t<false/>");
  expect(text).not.toContain("WatchPaths");
});
test("fleet-lessons is a six-hour interval without run-at-load", () => {
  expect(Object.hasOwn(KNOWN_JOBS, "fleet-lessons")).toBe(true);
  const job = KNOWN_JOBS["fleet-lessons"]!;
  expect(job).toMatchObject({ kind: "interval", intervalSeconds: 21600, runAtLoad: false });
  const { home, launcher } = fixture();
  const plist = renderLaunchdPlist(home, job, launcher, null).text;
  expect(plist).toContain("<string>fleet-lessons</string>");
  expect(plist).toContain("<integer>21600</integer>");
  const units = renderSystemdUnits(home, job, launcher, null);
  expect(units.service).toContain("service run fleet-lessons");
  expect(systemdTimer(job)).toContain("OnUnitActiveSec=21600s");
});

test("systemd scratch timer repeats at the configured interval without a boot start", () => {
  const timer = systemdTimer(intervalJob);
  expect(timer).not.toContain("OnBootSec=0");
  expect(timer).toContain("OnUnitActiveSec=21600s");
  expect(timer).not.toContain("OnCalendar=daily");
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
  for (const id of ["plist-present", "plist-valid", "plist-matches-renderer", "binary-resolves", "loaded", "tmpdir-present",
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

test("planted: a matching launchd plist without TMPDIR fails tmpdir-present", () => {
  const { home, launcher, watch } = fixture();
  const rendered = renderLaunchdPlist(home, job, launcher, watch).text
    .replace(/\t<key>TMPDIR<\/key>\n\t\t<string>[^<]*<\/string>\n/, "");
  const plistPath = join(home, "Library", "LaunchAgents", `${job.label}.plist`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, rendered);
  const checks = checkService({ home, job, launcher, watch, rendered,
    installed: { path: plistPath, text: rendered },
    print: parseLaunchctlPrint(healthyPrint(plistPath)) });
  expect(checks.find(check => check.id === "plist-matches-renderer")?.status).toBe("PASS");
  expect(checks.find(check => check.id === "tmpdir-present")?.status).toBe("FAIL");
});
test("planted: launchd doctor rejects TMPDIR outside private state scratch", () => {
  const { home, launcher, watch } = fixture();
  const input = healthyInput(home, launcher, watch);
  for (const wrong of ["/var/folders/aa/bb/T/omp-kit", "/tmp"]) {
    const installed = { ...input.installed!, text: input.installed!.text.replace(serviceTmpDir(home), wrong) };
    const check = checkService({ ...input, installed }).find(row => row.id === "tmpdir-present");
    expect(check?.status, wrong).toBe("FAIL");
  }
});

test("linux units render service plus path trigger with fixed env", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  expect(units.service).toContain(`ExecStart=${launcher} service run omp-watch`);
  expect(units.service).toContain("Environment=PATH=");
  expect(units.path).toContain(`PathChanged=${watch}`);
  expect(units.path).toContain("WantedBy=default.target");
});

test("linux service uses private service scratch under the XDG state root", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  expect(units.service).toContain(`Environment=TMPDIR="${serviceTmpDir(home)}"`);
  expect(units.service).toContain(`Environment=XDG_STATE_HOME="${join(home, ".local", "state")}"`);
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
  expectPrivateServiceTmp(home);
  expect(calls.some(call => call.includes("daemon-reload"))).toBe(false);
});
test("linux interval lifecycle state uses the timer trigger", () => {
  const { home, launcher } = fixture();
  const units = renderSystemdUnits(home, intervalJob, launcher, null);
  const serviceFile = join(home, ".config", "systemd", "user", `omp-kit-${intervalJob.name}.service`);
  const timerUnit = `omp-kit-${intervalJob.name}.timer`;
  const calls: string[][] = [];
  const run = runner(calls, args => {
    if (args[2] === "is-enabled" || args[2] === "is-active") {
      return args[3] === timerUnit
        ? { code: 0, stdout: args[2] === "is-enabled" ? "enabled" : "active", stderr: "" }
        : { code: 1, stdout: "", stderr: "trigger absent" };
    }
    if (args[2] === "show") return { code: 0, stdout: `${serviceFile}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const installed = installSystemd(home, intervalJob, units, run);
  expect(installed.ok).toBe(true);
  const state = systemctlState(intervalJob, run);
  expect(state).toEqual({ enabled: true, active: true, fragmentPath: serviceFile });
  const triggerQueries = calls.filter(call => call[2] === "is-enabled" || call[2] === "is-active").map(call => call[3]);
  expect(triggerQueries.length).toBeGreaterThan(0);
  expect(triggerQueries.every(trigger => trigger === timerUnit)).toBe(true);
  const doctorChecks = checkServiceLinux({
    home, job: intervalJob, launcher, unit: `omp-kit-${intervalJob.name}.service`,
    timer: timerUnit, pathUnit: null, renderedService: units.service, ...state,
  });
  expect(doctorChecks.find(check => check.id === "loaded")?.status).toBe("PASS");
  const watchCalls: string[][] = [];
  systemctlState(job, runner(watchCalls));
  expect(watchCalls.filter(call => call[2] === "is-enabled" || call[2] === "is-active").map(call => call[3]))
    .toEqual([`omp-kit-${job.name}.path`, `omp-kit-${job.name}.path`]);
  expect(readFileSync(join(home, ".config", "systemd", "user", `omp-kit-${intervalJob.name}.timer`), "utf8"))
    .toBe(systemdTimer(intervalJob));
});

test("Linux service status and doctor read interval timer state", () => {
  if (process.platform !== "linux") {
    console.info("skip: systemd CLI integration requires Linux; timer state is covered by the runner test");
    return;
  }
  const { home, launcher } = fixture();
  seedServiceTmp(home);
  const units = renderSystemdUnits(home, intervalJob, launcher, null);
  const unitDir = join(home, ".config", "systemd", "user");
  const serviceFile = join(unitDir, `omp-kit-${intervalJob.name}.service`);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(serviceFile, units.service);
  writeFileSync(join(unitDir, `omp-kit-${intervalJob.name}.timer`), systemdTimer(intervalJob));
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "systemctl"), [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"',
    'case "$2" in',
    '  is-enabled|is-active) [ "$3" = "omp-kit-scratch-reaper.timer" ] || exit 1; echo "$2"; exit 0 ;;',
    '  show) printf "%s\\n" "$SYSTEMD_SERVICE_FILE"; exit 0 ;;',
    '  *) exit 0 ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(join(fakeBin, "systemctl"), 0o755);
  const log = join(home, "systemctl.log");
  const env = {
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    SYSTEMCTL_LOG: log,
    SYSTEMD_SERVICE_FILE: serviceFile,
  };
  const status = cli(["service", "status", intervalJob.name], home, env);
  expect(status.code).toBe(0);
  expect(status.envelope.data.status[0]).toMatchObject({ installed: true, loaded: true, state: "active" });
  const doctor = cli(["service", "doctor", intervalJob.name], home, env);
  expect(doctor.code).toBe(0);
  expect(doctor.envelope.data.checks.find((check: { id: string }) => check.id === "loaded")?.status).toBe("PASS");
  const triggerCalls = readFileSync(log, "utf8").trim().split("\n").map(call => call.split(" "));
  const stateQueries = triggerCalls.filter(call => call[1] === "is-enabled" || call[1] === "is-active");
  expect(stateQueries.length).toBeGreaterThan(0);
  expect(stateQueries.every(call => call[2] === `omp-kit-${intervalJob.name}.timer`)).toBe(true);
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
  expect(found).toEqual(["loaded", "tmpdir-present", "unit-matches-renderer", "unit-present"]);
});

test("planted: a matching systemd unit without TMPDIR fails tmpdir-present", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  const rendered = units.service.replace(/^Environment=TMPDIR=.*\n/m, "");
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const serviceFile = join(unitDir, `omp-kit-${job.name}.service`);
  writeFileSync(serviceFile, rendered);
  const checks = checkServiceLinux({ home, job, launcher, unit: `omp-kit-${job.name}.service`, timer: null, pathUnit: null,
    renderedService: rendered, enabled: true, active: true, fragmentPath: serviceFile });
  expect(checks.find(check => check.id === "unit-matches-renderer")?.status).toBe("PASS");
  expect(checks.find(check => check.id === "tmpdir-present")?.status).toBe("FAIL");
});
test("planted: systemd doctor rejects TMPDIR outside private state scratch", () => {
  const { home, launcher, watch } = fixture();
  seedServiceTmp(home);
  const units = renderSystemdUnits(home, job, launcher, watch);
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const serviceFile = join(unitDir, `omp-kit-${job.name}.service`);
  for (const wrong of ["/var/folders/aa/bb/T/omp-kit", "/tmp"]) {
    writeFileSync(serviceFile, units.service.replace(`Environment=TMPDIR="${serviceTmpDir(home)}"`, `Environment=TMPDIR="${wrong}"`));
    const checks = checkServiceLinux({ home, job, launcher, unit: `omp-kit-${job.name}.service`, timer: null, pathUnit: null,
      renderedService: units.service, enabled: true, active: true, fragmentPath: serviceFile });
    expect(checks.find(check => check.id === "tmpdir-present")?.status, wrong).toBe("FAIL");
  }
});

function cli(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"], {
    cwd: home, env: { ...process.env, HOME: home, XDG_STATE_HOME: extraEnv.XDG_STATE_HOME ?? join(home, ".local", "state"), ...extraEnv }, stdout: "pipe", stderr: "pipe",
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
  // Pinned quiet: the gate reads the live machine, which CI runners can spike.
  const result = cli(["service", "run", "omp-watch"], home, { OMP_KIT_LOAD_OVERRIDE: "0.05/8" });
  expect(result.code).toBe(0);
  expect(result.envelope.data).toMatchObject({ overall: "OK", job: "omp-watch", status: "OK" });
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
  const result = cli(["service", "run", "omp-watch"], home, { OMP_KIT_LOAD_OVERRIDE: "0.05/8" });
  expect(result.code).toBe(1);
  expect(result.envelope.data).toMatchObject({ overall: "FINDINGS", job: "omp-watch", status: "FAILED" });
  expect(result.envelope.errors[0].code).toBe("JOB_FAILED");
  const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "jobs", "omp-watch.json"), "utf8"));
  expect(receipt.exit).toBe(3);
});

test("REAP1 whole scheduled scratch job preempts a synchronous owner read and releases single-flight", () => {
  const { home } = fixture();
  const root = join(home, "var", "agent-tmp");
  const blocked = join(root, "blocked.59999");
  const untouched = join(root, "unrelated");
  mkdirSync(blocked, { recursive: true });
  mkdirSync(untouched);
  writeFileSync(join(untouched, "keep"), "not ours to reclaim");
  const fifo = Bun.spawnSync(["mkfifo", join(blocked, ".owner")], { stdout: "pipe", stderr: "pipe" });
  expect(fifo.exitCode).toBe(0);
  const bin = join(home, ".local", "bin");
  writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const started = Date.now();
  const result = cli(["service", "run", "scratch-reaper"], home, {
    OMP_KIT_SCRATCH_ROOTS: root, TMPDIR: home, OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "600",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(result.code).toBe(1);
  expect(result.envelope.data.status).toBe("TIMEOUT");
  expect(result.envelope.data.interruptedAction).toMatchObject({ action: "INSPECT", path: blocked });
  expect(result.envelope.data.receipt).toMatchObject({ status: "TIMEOUT", exit: 1, cap_ms: 600 });
  expect(result.envelope.errors[0].code).toBe("TIMEOUT");
  expect(existsSync(join(blocked, ".owner"))).toBe(true);
  expect(readFileSync(join(untouched, "keep"), "utf8")).toBe("not ours to reclaim");
  expect(existsSync(join(home, ".local", "state", "omp-kit", "jobs", "scratch-reaper.lock"))).toBe(false);
  const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "jobs", "scratch-reaper.json"), "utf8"));
  expect(receipt.status).toBe("TIMEOUT");
});

test("REAP1 supervisor caps synchronous browser work and kills its owned process group", async () => {
  const { home } = fixture();
  const blocked = join(home, "browser-probe");
  expect(Bun.spawnSync(["mkfifo", blocked]).exitCode).toBe(0);
  const browserModule = resolve(import.meta.dir, "../../src/browser-doctor.ts");
  const code = `import {collectBrowserProcesses} from ${JSON.stringify(browserModule)}; const {readFileSync,writeFileSync}=require("node:fs"); collectBrowserProcesses(() => { writeFileSync(${JSON.stringify(join(home, "entered"))},String(process.pid)); readFileSync(${JSON.stringify(blocked)}); return {exitCode:1,stdout:""}; });`;
  const result = await superviseScratchJob([process.execPath, "-e", code], { ...process.env, HOME: home }, 500);
  expect(result.status).toBe("TIMEOUT");
  expect(result.elapsedMs).toBeLessThan(2000);
  const pid = Number(readFileSync(join(home, "entered"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(existsSync(blocked)).toBe(true);
});

test("service status reports HOME-scoped install state from source", () => {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-run-"));
  roots.push(home);
  const status = cli(["service", "status", "omp-watch"], home);
  expect(status.envelope.data.job).toBe("omp-watch");
  expect(status.envelope.data.status[0]).toMatchObject({ name: "omp-watch", installed: false });
  expect(["OK", "FINDINGS"]).toContain(status.envelope.data.overall);
});

test("service install without --apply refuses and writes no plist", () => {
  const { home } = fixture();
  const result = cli(["service", "install", "omp-watch"], home);
  expect(result.code).toBe(2);
  expect(result.envelope.errors[0].code).toBe("INSTALL_REQUIRES_APPLY");
  expect(() => readFileSync(join(home, "Library", "LaunchAgents", `${testLabel}.plist`), "utf8")).toThrow();
});

test("fleet-watch install refuses when its config is absent", () => {
  const { home } = fixture();
  const tmuxTmpDir = join(home, "tmux-sockets");
  mkdirSync(tmuxTmpDir);
  const result = cli(["service", "install", "fleet-watch", "--dry-run"], home, { TMUX_TMPDIR: tmuxTmpDir });
  expect(result.code).toBe(2);
  expect(result.envelope.errors?.[0]?.code).toBe("FLEET_WATCH_CONFIG_MISSING");
});

test("fleet-watch dry-run captures TMUX_TMPDIR into the plist", () => {
  const { home } = fixture();
  const tmuxTmpDir = join(home, "tmux-sockets");
  mkdirSync(tmuxTmpDir);
  const configDir = join(home, ".config", "omp-kit");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "fleet-watch.json"), JSON.stringify({
    enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
    sessions: [{ session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: home, workerPanes: ["%1"] }],
  }));
  const result = cli(["service", "install", "fleet-watch", "--dry-run"], home, { TMUX_TMPDIR: tmuxTmpDir });
  expect(result.code).toBe(0);
  const renderedService = process.platform === "linux" ? result.envelope.data.service : result.envelope.data.plist;
  expect(renderedService).toContain(process.platform === "linux"
    ? `Environment=TMUX_TMPDIR="${tmuxTmpDir}"`
    : `<key>TMUX_TMPDIR</key>\n\t\t<string>${tmuxTmpDir}</string>`);
});

test("fleet-watch install refuses when TMUX_TMPDIR is unset", () => {
  const { home } = fixture();
  const configDir = join(home, ".config", "omp-kit");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "fleet-watch.json"), "{}\n");
  const result = cli(["service", "install", "fleet-watch", "--dry-run"], home, { TMUX_TMPDIR: "" });
  expect(result.code).toBe(2);
  expect(result.envelope.errors?.[0]?.code).toBe("FLEET_WATCH_TMUX_TMPDIR_MISSING");
});

test("fleet-watch install refuses relative and unresolved TMUX_TMPDIR values", () => {
  const { home } = fixture();
  const configDir = join(home, ".config", "omp-kit");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "fleet-watch.json"), JSON.stringify({
    enabled: true, intervalSeconds: 120, noDecisionChecks: 5,
    sessions: [{ session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: home, workerPanes: ["%1"] }],
  }));
  for (const tmuxTmpDir of ["relative-sockets", join(home, "missing-sockets")]) {
    const result = cli(["service", "install", "fleet-watch", "--dry-run"], home, { TMUX_TMPDIR: tmuxTmpDir });
    expect(result.code, tmuxTmpDir).toBe(2);
    expect(result.envelope.errors?.[0]?.code, tmuxTmpDir).toBe("FLEET_WATCH_TMUX_TMPDIR_INVALID");
  }
});

test("service uninstall without --apply refuses and keeps the plist", () => {
  const { home } = fixture();
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const dest = join(home, "Library", "LaunchAgents", `${testLabel}.plist`);
  writeFileSync(dest, "stale-bytes\n");
  const result = cli(["service", "uninstall", "omp-watch"], home);
  expect(result.code).toBe(2);
  expect(result.envelope.errors[0].code).toBe("UNINSTALL_REQUIRES_APPLY");
  expect(readFileSync(dest, "utf8")).toBe("stale-bytes\n");
});

test("service uninstall reports already_absent through the CLI wire", () => {
  const { home } = fixture();
  const result = cli(["service", "uninstall", "omp-watch", "--apply", "--yes"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data).toMatchObject({ overall: "OK", job: "omp-watch", label: testLabel, already_absent: true });
  expect("alreadyAbsent" in result.envelope.data).toBe(false);
});

test("service uninstall moves a stale install to backup through the CLI wire", () => {
  const { home } = fixture();
  if (process.platform === "darwin") {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const dest = join(home, "Library", "LaunchAgents", `${testLabel}.plist`);
    writeFileSync(dest, "stale-bytes\n");
    const result = cli(["service", "uninstall", "omp-watch", "--apply", "--yes"], home);
    expect(result.code).toBe(0);
    expect(result.envelope.data.label).toBe(testLabel);
    expect(result.envelope.data.backup).toContain("service-backups");
    expect(() => readFileSync(dest, "utf8")).toThrow();
    expect(readFileSync(result.envelope.data.backup, "utf8")).toBe("stale-bytes\n");
    return;
  }
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "omp-kit-omp-watch.service"), "stale-service\n");
  writeFileSync(join(dir, "omp-kit-omp-watch.path"), "stale-path\n");
  const result = cli(["service", "uninstall", "omp-watch", "--apply", "--yes"], home);
  expect(result.code).toBe(0);
  expect(result.envelope.data.label).toBe(testLabel);
  expect(result.envelope.data.backup).toContain("service-backups");
  expect(() => readFileSync(join(dir, "omp-kit-omp-watch.service"), "utf8")).toThrow();
  expect(() => readFileSync(join(dir, "omp-kit-omp-watch.path"), "utf8")).toThrow();
  expect(readFileSync(join(result.envelope.data.backup, "omp-kit-omp-watch.service"), "utf8")).toBe("stale-service\n");
  expect(readFileSync(join(result.envelope.data.backup, "omp-kit-omp-watch.path"), "utf8")).toBe("stale-path\n");
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

test("fleet-watch systemd unit captures TMUX_TMPDIR and doctor rejects an unresolved directory", () => {
  const { home, launcher, watch } = fixture();
  const tmuxTmpDir = join(home, "tmux-sockets");
  mkdirSync(tmuxTmpDir);
  process.env.TMUX_TMPDIR = tmuxTmpDir;
  const units = renderSystemdUnits(home, fleetWatchJob, launcher, watch);
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const serviceFile = join(dir, `omp-kit-${fleetWatchJob.name}.service`);
  writeFileSync(serviceFile, units.service);
  expect(units.service).toContain(`Environment=TMUX_TMPDIR="${tmuxTmpDir}"`);
  const expectedPath = [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  expect(units.service).toContain(`Environment=PATH="${expectedPath}"`);
  const input = {
    home, job: fleetWatchJob, launcher, unit: `omp-kit-${fleetWatchJob.name}.service`,
    timer: null, pathUnit: null, renderedService: units.service,
    enabled: true, active: true, fragmentPath: serviceFile,
  };
  expect(checkServiceLinux(input).find(check => check.id === "tmux-tmpdir-resolves")?.status).toBe("PASS");
  const broken = units.service.replace(
    `Environment=TMUX_TMPDIR="${tmuxTmpDir}"`,
    `Environment=TMUX_TMPDIR="${join(home, "missing-sockets")}"`,
  );
  writeFileSync(serviceFile, broken);
  expect(checkServiceLinux(input).find(check => check.id === "tmux-tmpdir-resolves")?.status).toBe("FAIL");
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
  // Planted anchor: drop the test namespace and this label is the production one.
  expect(result.envelope.data.label).toBe(testLabel);
  expect(result.envelope.data.launchd_plist).toContain(`<string>${testLabel}</string>`);
  expect(result.envelope.data.launchd_plist).toContain("<string>service</string>");
  expect(result.envelope.data.launchd_plist).not.toContain("/bin/sh -c");
  expect(result.envelope.data.systemd_service_unit).toContain("service run omp-watch");
  expect(() => readFileSync(join(home, "Library", "LaunchAgents", `${testLabel}.plist`), "utf8")).toThrow();
});

test("service labels stay production without the test namespace and namespace under it", () => {
  const saved = process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
  delete process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
  expect(serviceLabel("omp-watch")).toBe("com.omp-kit.omp-watch");
  process.env.OMP_KIT_TEST_LABEL_NAMESPACE = testNamespace;
  expect(serviceLabel("omp-watch")).toBe(testLabel);
  expect(() => { process.env.OMP_KIT_TEST_LABEL_NAMESPACE = "com.omp-kit.omp-watch"; serviceLabel("omp-watch"); }).toThrow();
  expect(() => { process.env.OMP_KIT_TEST_LABEL_NAMESPACE = "evil;rm"; serviceLabel("omp-watch"); }).toThrow();
  if (saved === undefined) delete process.env.OMP_KIT_TEST_LABEL_NAMESPACE;
  else process.env.OMP_KIT_TEST_LABEL_NAMESPACE = saved;
});

test("service commands refuse a non-test label namespace", () => {
  const { home } = fixture();
  const result = cli(["service", "status", "omp-watch"], home, { OMP_KIT_TEST_LABEL_NAMESPACE: "com.evil.job" });
  expect(result.code).toBe(2);
  expect(result.envelope.errors[0].code).toBe("TEST_LABEL_NAMESPACE_INVALID");
});

test("install refuses a label loaded from a different plist and names both paths", () => {
  const { home, launcher, watch } = fixture();
  const foreign = { loaded: true, path: "/tmp/foreign.plist", state: "running", pid: 1, runs: 1, lastExit: 0 };
  const refused = installService(home, job, launcher, watch, null, foreign, runner([]));
  expect(refused.ok).toBe(false);
  expect(refused.error).toBe("LABEL_LOADED_ELSEWHERE");
  expect(refused.detail).toContain("/tmp/foreign.plist");
  expect(refused.detail).toContain(join(home, "Library", "LaunchAgents", `${job.label}.plist`));
  const calls: string[][] = [];
  const taken = installService(home, job, launcher, watch, null, foreign,
    runner(calls, args => {
      if (args[1] === "print") return { code: 0, stdout: healthyPrint(join(home, "Library", "LaunchAgents", `${job.label}.plist`)), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }), true);
  expect(taken.ok).toBe(true);
});

test("systemd install refuses a unit enabled from elsewhere unless replaced", () => {
  const { home, launcher, watch } = fixture();
  const units = renderSystemdUnits(home, job, launcher, watch);
  const foreign = (args: readonly string[]): ServiceRunResult => {
    if (args[2] === "is-enabled" || args[2] === "is-active") return { code: 0, stdout: "yes", stderr: "" };
    if (args[2] === "show") return { code: 0, stdout: "/etc/systemd/user/foreign.service\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const refused = installSystemd(home, job, units, foreign);
  expect(refused.ok).toBe(false);
  expect(refused.error).toBe("LABEL_LOADED_ELSEWHERE");
  const taken = installSystemd(home, job, units, foreign, true);
  expect(taken.ok).toBe(true);
});

test("notify posts osascript on darwin failure, notify-send on linux, and nothing elsewhere", () => {
  const calls: string[][] = [];
  const run = (code: number) => (args: readonly string[]): ServiceRunResult => {
    calls.push([...args]);
    return { code, stdout: "", stderr: "" };
  };
  const quote = notifyJobFailure({ title: "omp-kit", message: 'bad "quote" \\ back', platform: "darwin", run: run(0), notifySendPresent: false });
  expect(quote).toEqual({ attempted: true, method: "osascript" });
  expect(calls[0]?.[2]).toContain('\\"quote\\"');
  const failed = notifyJobFailure({ title: "t", message: "m", platform: "darwin", run: run(3), notifySendPresent: false });
  expect(failed).toEqual({ attempted: false, method: "osascript" });
  const linux = notifyJobFailure({ title: "t", message: "m", platform: "linux", run: run(0), notifySendPresent: true });
  expect(linux).toEqual({ attempted: true, method: "notify-send" });
  const headless = notifyJobFailure({ title: "t", message: "m", platform: "linux", run: run(0), notifySendPresent: false });
  expect(headless).toEqual({ attempted: false, method: "none" });
  const throwing = notifyJobFailure({ title: "t", message: "m", platform: "darwin", run: () => { throw new Error("nope"); }, notifySendPresent: false });
  expect(throwing).toEqual({ attempted: false, method: "none" });
});

function fakebin(): { dir: string; log: string } {
  const dir = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "fakebin-"));
  roots.push(dir);
  const log = join(dir, "notify.log");
  const shim = "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$NOTIFY_LOG\"\nexit 0\n";
  writeFileSync(join(dir, "osascript"), shim, { mode: 0o755 });
  chmodSync(join(dir, "osascript"), 0o755);
  writeFileSync(join(dir, "notify-send"), shim, { mode: 0o755 });
  chmodSync(join(dir, "notify-send"), 0o755);
  return { dir, log };
}

function runHome(exitCode: number): string {
  const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "service-run-"));
  roots.push(home);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "omp-kit"), `#!/bin/sh\necho failing >&2\nexit ${exitCode}\n`, { mode: 0o755 });
  chmodSync(join(bin, "omp-kit"), 0o755);
  mkdirSync(join(home, ".local", "state", "omp-kit"), { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".local", "state", "omp-kit"), 0o700);
  return home;
}

test("service run notifies on failure and stays silent on success", () => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.info("skip: desktop notification only exists on macOS and Linux");
    return;
  }
  const { dir, log } = fakebin();
  const path = `${dir}:${process.env.PATH ?? ""}`;
  const failing = cli(["service", "run", "omp-watch"], runHome(3), { PATH: path, NOTIFY_LOG: log, OMP_KIT_LOAD_OVERRIDE: "0.05/8" });
  expect(failing.code).toBe(1);
  expect(failing.envelope.data.notification.attempted).toBe(true);
  expect(readFileSync(log, "utf8")).toContain("omp-kit test did not pass after an OMP update");
  rmSync(log, { force: true });
  const passing = cli(["service", "run", "omp-watch"], runHome(0), { PATH: path, NOTIFY_LOG: log, OMP_KIT_LOAD_OVERRIDE: "0.05/8" });
  expect(passing.code).toBe(0);
  expect(passing.envelope.data.notification).toEqual({ attempted: false, method: "none" });
  expect(existsSync(log)).toBe(false);
});

function realLaunchctlPath(label: string): { code: number; path: string | null } {
  const child = Bun.spawnSync(["launchctl", "print", `gui/${process.getuid?.() ?? 501}/${label}`], { stdout: "pipe", stderr: "pipe" });
  const line = child.stdout.toString().split("\n").find(entry => entry.trim().startsWith("path ="));
  return { code: child.exitCode, path: line?.trim() ?? null };
}

test("a fixture install never takes over a foreign label, and --replace does it openly", () => {
  if (process.platform !== "darwin") {
    console.info("skip: launchd labels exist only on macOS");
    return;
  }
  const prodBefore = realLaunchctlPath("com.omp-kit.omp-watch");
  const first = fixture();
  const second = fixture();
  try {
    const installed = cli(["service", "install", "omp-watch", "--apply", "--yes"], first.home);
    expect(installed.envelope.data.label).toBe(testLabel);
    expect(installed.code).toBe(0);
    expect(realLaunchctlPath(testLabel).path).toContain(join(first.home, "Library", "LaunchAgents", `${testLabel}.plist`));
    const refused = cli(["service", "install", "omp-watch", "--apply", "--yes"], second.home);
    expect(refused.code).toBe(1);
    expect(refused.envelope.errors[0].code).toBe("LABEL_LOADED_ELSEWHERE");
    expect(refused.envelope.errors[0].message).toContain(first.home);
    expect(refused.envelope.errors[0].message).toContain(second.home);
    const replaced = cli(["service", "install", "omp-watch", "--apply", "--yes", "--replace"], second.home);
    expect(replaced.code).toBe(0);
    expect(realLaunchctlPath(testLabel).path).toContain(join(second.home, "Library", "LaunchAgents", `${testLabel}.plist`));
  } finally {
    Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${testLabel}`], { stdout: "pipe", stderr: "pipe" });
  }
  expect(realLaunchctlPath(testLabel).code).not.toBe(0);
  expect(realLaunchctlPath("com.omp-kit.omp-watch")).toEqual(prodBefore);
});

test("REAP1 contract refuses empty PATH components and relative log paths", () => {
  const { home } = fixture();
  const rendered = renderLaunchdPlist(home, KNOWN_JOBS["scratch-reaper"]!, join(home, ".local/bin/omp-kit"), null).text;
  const emptyPath = rendered.replace("<key>PATH</key>\n\t\t<string>", "<key>PATH</key>\n\t\t<string>:");
  expect(checkPlistContract("scratch-reaper", emptyPath).find(row => row.id === "contract-env")?.status).toBe("FAIL");
  const relativeLogs = rendered.replace(join(home, "Library", "Logs", "omp-kit", "scratch-reaper.out.log"), "relative.out.log");
  expect(checkPlistContract("scratch-reaper", relativeLogs).find(row => row.id === "contract-log-paths")?.status).toBe("FAIL");
  const unit = renderSystemdUnits(home, KNOWN_JOBS["scratch-reaper"]!, join(home, ".local/bin/omp-kit"), null).service;
  expect(checkSystemdContract("scratch-reaper", unit.replace("Environment=PATH=\"", "Environment=PATH=\":")).find(row => row.id === "contract-systemd-env")?.status).toBe("FAIL");
});

test("scheduled kit-update persists only its validated local tuple, not arbitrary environment", () => {
  const { home } = fixture();
  const tuple = {
    OMP_KIT_UPDATE_ENABLED: "1",
    OMP_KIT_UPDATE_INDEX: join(home, "durable&assets", "index.json"),
    OMP_KIT_UPDATE_ARCHIVE: join(home, "durable&assets", "omp-kit.tar.gz"),
    OMP_KIT_UPDATE_VERSION: "0.2.10",
    OMP_KIT_UPDATE_SOURCE_TAG: "v0.2.10",
  };
  const keys = [...Object.keys(tuple), "NONSECRET_UNRELATED_RENDER_INPUT"];
  const prior = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, tuple, { NONSECRET_UNRELATED_RENDER_INPUT: "must-not-persist" });
    const plist = renderLaunchdPlist(home, KNOWN_JOBS["kit-update"]!, join(home, ".local/bin/omp-kit"), null).text;
    expect(plist).not.toContain("must-not-persist");
    if (process.platform === "darwin") {
      const path = join(home, "kit-update.plist");
      writeFileSync(path, plist);
      const readback = Bun.spawnSync(["plutil", "-extract", "EnvironmentVariables", "json", "-o", "-", path]);
      expect(readback.exitCode).toBe(0);
      const installedEnvironment = JSON.parse(readback.stdout.toString());
      for (const [key, value] of Object.entries(tuple)) expect(installedEnvironment[key]).toBe(value);
    }
    const systemd = renderSystemdUnits(home, KNOWN_JOBS["kit-update"]!, join(home, ".local/bin/omp-kit"), null).service;
    expect(systemd).not.toContain("must-not-persist");
    for (const [key, value] of Object.entries(tuple)) expect(systemd.split("\n")).toContain(`Environment=${key}="${value}"`);
    process.env.OMP_KIT_UPDATE_ARCHIVE = join(home, "different-parent", "omp-kit.tar.gz");
    expect(() => renderLaunchdPlist(home, KNOWN_JOBS["kit-update"]!, join(home, ".local/bin/omp-kit"), null)).toThrow("KIT_UPDATE_LOCAL_TUPLE_REQUIRED");
    Object.assign(process.env, tuple);
    delete process.env.OMP_KIT_UPDATE_VERSION;
    expect(() => renderSystemdUnits(home, KNOWN_JOBS["kit-update"]!, join(home, ".local/bin/omp-kit"), null)).toThrow("KIT_UPDATE_LOCAL_TUPLE_REQUIRED");
    for (const key of Object.keys(tuple)) delete process.env[key];
    expect(renderLaunchdPlist(home, KNOWN_JOBS["kit-update"]!, join(home, ".local/bin/omp-kit"), null).text).not.toContain("<key>OMP_KIT_UPDATE_ENABLED</key>");
  } finally {
    keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
  }
});

test("REAP1 failed process census is explicit UNKNOWN evidence rather than an empty success", () => {
  const inventory = collectBrowserProcesses(() => ({ exitCode: 1, stdout: "", stderr: "permission denied" }));
  expect(inventory.probeError).toBe("browser-ps-probe-failed: exit 1; permission denied");
  expect(inventory.processes).toEqual([]);
  expect(inventory.clones).toEqual([]);
});

test("REAP1 concurrent actual service invocation cannot enter a blocked scratch worker", async () => {
  const { home } = fixture();
  const root = join(home, "var", "agent-tmp");
  const blocked = join(root, "blocked.59999");
  mkdirSync(blocked, { recursive: true });
  expect(Bun.spawnSync(["mkfifo", join(blocked, ".owner")]).exitCode).toBe(0);
  const bin = join(home, ".local", "bin");
  writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const extraEnv = { OMP_KIT_SCRATCH_ROOTS: root, TMPDIR: home, OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "1200", PATH: `${bin}:${process.env.PATH ?? ""}` };
  // A separate CLI process exercises the real platform deadline; parent fake timers cannot drive it.
  const jobs = join(home, ".local", "state", "omp-kit", "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const ready = Promise.withResolvers<void>();
  const watcher = watch(jobs, { recursive: true }, () => { if (existsSync(join(jobs, "scratch-reaper.lock", "pid"))) ready.resolve(); });
  const first = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "service", "run", "scratch-reaper", "--json"], {
    cwd: home, env: { ...process.env, ...extraEnv, HOME: home, XDG_STATE_HOME: join(home, ".local", "state") }, stdout: "pipe", stderr: "pipe",
  });
  const firstOutput = new Response(first.stdout).text();
  const firstErrors = new Response(first.stderr).text();
  try {
    const lock = join(jobs, "scratch-reaper.lock");
    await Promise.race([ready.promise, first.exited.then(() => { throw new Error("first job exited before its live single-flight marker"); })]);
    expect(existsSync(lock)).toBe(true);
    const overlap = cli(["service", "run", "scratch-reaper"], home, extraEnv);
    expect(overlap.envelope.data).toMatchObject({ status: "SKIPPED-OVERLAP", receipt: { status: "SKIPPED-OVERLAP" } });
    expect(await first.exited).toBe(1);
    const terminal = JSON.parse(await firstOutput);
    expect(terminal.data).toMatchObject({ status: "TIMEOUT", receipt: { status: "TIMEOUT" } });
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(blocked, ".owner"))).toBe(true);
  } finally {
    watcher.close();
    if (first.exitCode === null) first.kill("SIGTERM");
    await first.exited;
    await firstErrors;
  }
});
