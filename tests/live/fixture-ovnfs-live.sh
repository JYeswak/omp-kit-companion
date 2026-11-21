#!/usr/bin/env bash
# Protected live replay. Use instead of a separate release-verdict invocation for this cut.
set -euo pipefail
if [ "$#" -ne 0 ] || [ "${OMP_KIT_FIXTURE_OVNFS_LIVE:-}" != approved ] || [ -z "${OMP_KIT_FIXTURE_OVNFS_SOURCE:-}" ] || [ -z "${TMPDIR:-}" ]; then # tempsafe: read-only gate on executor-supplied owned TMPDIR; this script creates no temp dirs
  echo 'FIXTUREOVNFS1 NOT_RUN: authorized release executor must supply approved scope, exact published source and owned TMPDIR' >&2
  exit 77
fi
cd -- "$(dirname -- "$0")/../.."
exec bun --no-env-file - <<'TS'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { ownedTmp } from "./src/kitlib/tmp.ts";
import { pollUntil } from "./src/kitlib/poll.ts";
import { run } from "./src/kitlib/run.ts";

const source = process.env.OMP_KIT_FIXTURE_OVNFS_SOURCE ?? "";
if (!/^[0-9a-f]{40}$/.test(source)) throw new Error("FIXTUREOVNFS1: expected an exact 40-hex source SHA");
const root = realpathSync(process.cwd());
const tmp = realpathSync(process.env.TMPDIR ?? "");
const binName = Bun.which("ovnfs");
if (!binName) throw new Error("FIXTUREOVNFS1: real ovnfs is required");
const bin = realpathSync(binName);
const text = new TextDecoder();
const decode = (data) => text.decode(data);
const clean = (r) => !r.timed_out && !r.killed && !r.truncated && !r.total_truncated;
const checked = async (argv, options = {}) => {
  const r = await run(argv, { cwd: root, deadline_s: 10, ...options });
  if (!clean(r) || r.rc !== 0) throw new Error(argv.slice(0, 2).join(" ") + ": " + decode(r.stderr));
  return decode(r.stdout).trim();
};
const contains = (parent, path) => {
  const rel = relative(parent, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};
const status = async (prefix, env, deadline_s = 10) => {
  const r = await run([...prefix, "status", "--json"], {cwd:root, env, deadline_s});
  if (!clean(r)) throw new Error("FIXTUREOVNFS1: native status unavailable");
  if (r.rc === 1 && decode(r.stderr).trim() === "not running") return null;
  if (r.rc !== 0) throw new Error("FIXTUREOVNFS1: native status: " + decode(r.stderr));
  const s = JSON.parse(decode(r.stdout));
  if (!Number.isSafeInteger(s.pid) || s.pid <= 0 || !isAbsolute(s.state) || !isAbsolute(s.mount) || !isAbsolute(s.socket)) {
    throw new Error("FIXTUREOVNFS1: incomplete native daemon identity");
  }
  return {pid:s.pid, state:s.state, mount:s.mount, socket:s.socket, build:s.build_version ?? null};
};
const head = await checked(["git", "rev-parse", "HEAD"]);
const published = await checked(["git", "ls-remote", "origin", "refs/heads/main"], {deadline_s:30});
if (head !== source || published !== source + "\trefs/heads/main" || await checked(["git", "status", "--porcelain"])) {
  throw new Error("FIXTUREOVNFS1: exact clean published cut required");
}
const tree = await checked(["git", "rev-parse", "HEAD^{tree}"]);
const base = await status([bin]);
const defaultMount = base?.mount ?? join(homedir(), "checkouts");
if (contains(defaultMount, tmp)) throw new Error("FIXTUREOVNFS1: scratch lives on the user mount");
const scratch = ownedTmp("fixture-ovnfs-live", {root:tmp});
const home = join(scratch.path, "home");
const state = join(scratch.path, "state");
const mount = join(scratch.path, "mount");
const fixture = join(scratch.path, "fixture");
for (const path of [home, state, mount, fixture]) mkdirSync(path, {mode:0o700});
writeFileSync(join(fixture, "fixture.txt"), "candidate " + source + "\n");
const native = [bin, "--state", state, "--mount", mount];
const env = {...Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)),
  HOME:home, XDG_STATE_HOME:join(home, ".local", "state"), OVNFS_STATE:state, OVNFS_MOUNT:mount};
const proc = async (pid) => checked(["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="]);
const baseStart = base === null ? null : await proc(base.pid);
const census = async () => {
  const out = await checked(["ps", "-axww", "-o", "pid=", "-o", "lstart=", "-o", "command="], {max_output_bytes:4 << 20});
  return out.split("\n").filter(line => line.includes("ovnfs serve ") &&
    (line.includes(scratch.path) || (line.includes("/agent-tmp/sib-flag-home.") && line.includes(defaultMount))));
};
const before = await census();
if (before.length !== 0 || await status(native, env) !== null) throw new Error("FIXTUREOVNFS1: fixture daemon already present before test");
const mountDevice = () => checked([process.execPath, "-e", 'console.log(require("node:fs").statSync(process.argv[1]).dev)', mount]);
const originalDev = await mountDevice();
const controller = new AbortController();
const daemon = run([...native, "serve"], {cwd:scratch.path, env, deadline_s:120, signal:controller.signal}).catch(error => error);
let result;
try {
  const ready = await pollUntil(({attempt_timeout_s}) => status(native, env, attempt_timeout_s), {
    deadline_s:30, interval_s:0.2, attempt_timeout_s:3, classify: value => value === null ? "retry" : "success",
  });
  if (ready.outcome !== "success" || typeof ready.observation !== "object" || ready.observation === null ||
      ready.observation.state !== state || ready.observation.mount !== mount || ready.observation.socket !== join(state, "admin.sock") ||
      await mountDevice() === originalDev) throw new Error("FIXTUREOVNFS1: actual owned mount required");
  const started = await proc(ready.observation.pid);
  console.log(JSON.stringify({source, tree, launch:[...native,"serve"], daemon:ready.observation, processStartAndArgv:started}));
  await checked([...native, "new", "--name", "fixture-ovnfs-live", fixture], {env, deadline_s:20});
  const inventory = 'import { listRepoCheckouts } from "./src/ovnfs-checkouts.ts"; console.log(JSON.stringify(await listRepoCheckouts(process.argv[1])));';
  const observed = JSON.parse(await checked([process.execPath, "--no-env-file", "-e", inventory, fixture], {env, deadline_s:10}));
  if (observed.ovnfs !== "present" || !observed.checkouts.some(row => row.name === "fixture-ovnfs-live" && contains(mount, row.path))) throw new Error("FIXTUREOVNFS1: real configured inventory did not see its owned checkout");
  console.log(JSON.stringify({inventory:observed, fixture}));
  // Return genuine native status but retire only this owned peer before the
  // adapter dials it. The wrapper records and refuses any attempted ls/start.
  const shim = join(scratch.path, "bin");
  const raceEvidence = join(scratch.path, "status-before-disconnect");
  mkdirSync(shim);
  writeFileSync(join(shim, "ovnfs"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FIXTURE_RACE_EVIDENCE"
[ "$#" -eq 2 ] && [ "$1" = status ] && [ "$2" = --json ] || exit 89
reply=$("$FIXTURE_OVNFS_BIN" --state "$OVNFS_STATE" --mount "$OVNFS_MOUNT" status --json)
printf '%s\\n' "$reply" >>"$FIXTURE_RACE_EVIDENCE"
"$FIXTURE_OVNFS_BIN" --state "$OVNFS_STATE" --mount "$OVNFS_MOUNT" stop >&2
printf '%s\\n' "$reply"
`, {mode:0o700});
  const raceEnv = {...env, PATH:shim + ":" + (env.PATH ?? ""), FIXTURE_OVNFS_BIN:bin, FIXTURE_RACE_EVIDENCE:raceEvidence};
  const lost = JSON.parse(await checked([process.execPath, "--no-env-file", "-e", inventory, fixture], {env:raceEnv, deadline_s:25}));
  const [attempt, statusText, unexpected] = readFileSync(raceEvidence, "utf8").trimEnd().split("\n");
  const statusBeforeDisconnect = JSON.parse(statusText ?? "null");
  if (attempt !== "status --json" || unexpected !== undefined || lost.ovnfs !== "unavailable" ||
      statusBeforeDisconnect?.pid !== ready.observation.pid || statusBeforeDisconnect.state !== state || statusBeforeDisconnect.mount !== mount) {
    throw new Error("FIXTUREOVNFS1: disconnected inventory did not fail passive");
  }
  console.log(JSON.stringify({attempt, statusBeforeDisconnect, inventory:lost}));
  result = await daemon;
  if (result instanceof Error || !clean(result) || result.rc !== 0 || await status(native, env) !== null || await mountDevice() !== originalDev || (await census()).length !== 0) throw new Error("FIXTUREOVNFS1: owned daemon or mount did not retire");
  const stopped = JSON.parse(await checked([process.execPath, "--no-env-file", "-e", inventory, fixture], {env, deadline_s:10}));
  if (stopped.ovnfs !== "unavailable" || (await census()).length !== 0 || await status(native, env) !== null) throw new Error("FIXTUREOVNFS1: stopped fixture auto-started");
  console.log(JSON.stringify({stopped, mountDevice:originalDev, ownDaemons:[]}));
  const judge = await run(["sh", "scripts/release-verdict.sh", "--no-fetch", "--commit", source], {cwd:root, deadline_s:2100, max_output_bytes:4 << 20});
  process.stdout.write(judge.stdout); process.stderr.write(judge.stderr);
  const after = await census();
  const current = await status([bin]);
  const sameDaemon = JSON.stringify(current) === JSON.stringify(base) && (current === null || await proc(current.pid) === baseStart);
  console.log(JSON.stringify({source, tree, suiteExit:judge.rc, before, after, sameDaemon}));
  if (!clean(judge) || judge.rc !== 0 || !decode(judge.stdout).split("\n").some(line => line.startsWith("FULL-SUITE: VERDICT PASS tree=" + tree + " role=main ")) || after.length !== 0 || !sameDaemon) {
    throw new Error("FIXTUREOVNFS1: fresh exact release verdict and clean process readback required; cache/queued is not live proof");
  }
} finally {
  controller.abort();
  result ??= await daemon;
  const gone = await status(native, env) === null && await mountDevice() === originalDev && (await census()).length === 0;
  if (gone) scratch.cleanup();
  else throw new Error("FIXTUREOVNFS1: retain owned evidence; mount or daemon not verifiably retired: " + scratch.path);
}
TS
