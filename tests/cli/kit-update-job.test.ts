import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kitUpdateJobOverall, pollPublishedRelease, runKitUpdateJob, type KitUpdateJobConfig, type KitUpdateJobDependencies, type KitUpdateJobResult } from "../../src/kit-update-job.ts";
import { isLiveDeferredOnly, judgeKitPostcheck, reconcilePendingUpdate, type KitUpdateResult } from "../../src/kit-update.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import type { PluginReceipt } from "../../src/apply-plugin.ts";
import { resolveOmpLauncher } from "../../src/paths.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { binary, fixtureContractFiles, manifest, tar } from "./kit-update-fixture.ts";
import { liveHookRefreshIo, refreshFleetHooks } from "../../src/hook-refresh.ts";
import { runStartProbe, startProbeLoadFactor, START_PROBE_MAX_LOAD_FACTOR, type StartProbeOptions, type StartProbeResult } from "../../src/start-probe.ts";
const dirs: string[] = [];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function config(enabled = true): KitUpdateJobConfig {
	const root = realpathSync(ownedTmp("l8-job", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path); dirs.push(root);
	writeFileSync(join(root, ".owner"), `pid=${process.pid}\nlabel=ompkit-fp72.22-test\nrepo=${join(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return { enabled, prefix: root, stateRoot: join(root, "state"), home: root, platform: { os: "darwin", arch: "arm64", libc: "none" }, pollRelease: async () => ({ indexPath: join(root, "index.json"), archivePath: join(root, "kit.tar"), version: "1.2.4", sourceTag: "v1.2.4" }) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function pluginLink(home: string, profile: string): string {
	const profileRoot = profile === "default" ? join(home, ".omp", "plugins") : join(home, ".omp", "profiles", profile, "plugins");
	return join(profileRoot, "node_modules", "omp-kit-companion");
}

function writePluginStore(root: string, version: string): void {
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "omp-kit-companion", version }));
	writeFileSync(join(root, "rules", "rule-a.md"), `# ${version}\n`);
}

function preparePluginUpdate(value: KitUpdateJobConfig, skipLinkProfile = ""): {
	oldStore: string;
	newStore: string;
	uncoveredLink: string;
	exec: NonNullable<KitUpdateJobDependencies["exec"]>;
} {
	const oldStore = join(value.prefix, "releases", "1.2.3");
	const newStore = join(value.prefix, "releases", "1.2.4");
	const sentinelStore = join(value.prefix, "uncovered-store");
	writePluginStore(oldStore, "1.2.3");
	writePluginStore(newStore, "1.2.4");
	mkdirSync(sentinelStore);
	for (const profile of ["default", "claude", "codex", "muse"]) {
		const agent = profile === "default"
			? join(value.home, ".omp", "agent")
			: join(value.home, ".omp", "profiles", profile, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "ttsr:\n  disabledRules: []\n");
		const link = pluginLink(value.home, profile);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(oldStore, link);
	}
	const uncoveredLink = pluginLink(value.home, "not covered");
	mkdirSync(dirname(uncoveredLink), { recursive: true });
	symlinkSync(sentinelStore, uncoveredLink);

	const cliEntry = join(import.meta.dir, "../../src/cli.ts");
	mkdirSync(join(newStore, "bin"), { recursive: true });
	writeFileSync(join(newStore, "bin", "omp-kit"),
		`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${cliEntry.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
	const ompBin = join(value.prefix, "omp-bin");
	mkdirSync(ompBin);
	writeFileSync(join(ompBin, "omp"), String.raw`#!/bin/sh
set -e
profile=default
if [ "$1" = "--profile" ]; then profile=$2; shift 2; fi
if [ "$profile" = default ]; then plugin_dir="$HOME/.omp/plugins"; else plugin_dir="$HOME/.omp/profiles/$profile/plugins"; fi
link="$plugin_dir/node_modules/omp-kit-companion"
case "$1 $2" in
  "plugin list")
    if [ -L "$link" ]; then
      printf '{"npm":[{"name":"omp-kit-companion","path":"%s"}]}\n' "$(readlink "$link")"
    else
      printf '{"npm":[]}\n'
    fi
    ;;
  "plugin link")
    if [ "$OMP_FAKE_SKIP_LINK" = "$profile" ]; then exit 0; fi
    target=$3
    rm -f "$link"
    mkdir -p "$plugin_dir/node_modules"
    ln -s "$target" "$link"
    ;;
  "plugin uninstall")
    rm -f "$link"
    ;;
  "config get")
    printf '{"key":"ttsr.disabledRules","value":[]}\n'
    ;;
  *)
    printf 'unsupported OMP command\n' >&2
    exit 2
    ;;
esac
`, { mode: 0o755 });
	writeFileSync(join(ompBin, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "1.2.3" }));
	for (const relativePath of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		const sourcePath = join(ompBin, "src", relativePath);
		mkdirSync(dirname(sourcePath), { recursive: true });
		writeFileSync(sourcePath, "export {};\n");
	}
	const nativePackage = join(ompBin, "node_modules", "@oh-my-pi", "pi-natives");
	mkdirSync(nativePackage, { recursive: true });
	writeFileSync(join(nativePackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	const exec: NonNullable<KitUpdateJobDependencies["exec"]> = async argv => {
		const result = Bun.spawnSync([...argv], {
			cwd: value.home,
			env: {
				...process.env,
				HOME: value.home,
				XDG_CONFIG_HOME: join(value.prefix, "xdg-config"),
				XDG_STATE_HOME: join(value.prefix, "xdg-state"),
				XDG_DATA_HOME: join(value.prefix, "xdg-data"),
				XDG_CACHE_HOME: join(value.prefix, "xdg-cache"),
				PATH: `${ompBin}:/usr/bin:/bin`,
				OMP: "",
				OMP_BIN: "",
				OMP_PATH: "",
				OMP_SRC: "",
				NO_COLOR: "1",
				OMP_FAKE_SKIP_LINK: skipLinkProfile,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		return { exit: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	return { oldStore, newStore, uncoveredLink, exec };
}

test("kit-update job is disabled by default and does not poll", async () => {
	let polled = false; const value = config(false); value.pollRelease = async () => { polled = true; return await config().pollRelease(); };
	const result = await runKitUpdateJob(value);
	expect(result).toMatchObject({ status: "DISABLED", notification: false }); expect(polled).toBe(false);
});

test("fake newer certified release becomes UPDATED, relinks the plugin and notifies one line", async () => {
	const value = config(); let applied = false; const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY", current: { version: "1.2.3", sha256: "a".repeat(64), target: "../releases/1.2.3/bin/omp-kit", binary: "/x" }, release: {} } as never),
		apply: async () => { applied = true; return { status: "UPDATED", exitCode: 0, receiptId: "r1", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }; },
		relink: async (binary, store) => { expect(binary).toBe(join(value.prefix, "bin", "omp-kit")); expect(store).toBe(join(value.prefix, "releases", "1.2.4")); return { ok: true, detail: "linked", receiptId: "plugin-r1", undoCommand: "omp-kit undo plugin-r1 --yes" }; },
		reconcile: async binary => { expect(binary).toBe(join(value.prefix, "bin", "omp-kit")); return { ok: true, detail: "reconciled" }; },
		notify: message => { notes.push(message); },
	});
	expect(applied).toBe(true); expect(result).toMatchObject({ status: "UPDATED", receiptId: "r1", activeVersion: "1.2.4", notification: true, relink: "APPLIED", pluginReceiptId: "plugin-r1", pluginUndoCommand: "omp-kit undo plugin-r1 --yes", service: "APPLIED" });
	expect(notes).toHaveLength(1); expect(notes[0]).toContain("1.2.4"); expect(notes[0]).toContain("r1"); expect(notes[0]).toContain("plugin-r1"); expect(notes[0]).toContain("omp-kit undo plugin-r1 --yes");
	expect(readdirSync(value.stateRoot)).toHaveLength(1);
});

test("service update applies a receipt-backed plugin relink to covered profiles and undo restores them", async () => {
	await withPollEnv(null, async () => {
		const value = config();
		const { oldStore, newStore, uncoveredLink, exec } = preparePluginUpdate(value);
		installSymlink(value.prefix, "1.2.3");
		const stableLink = join(value.prefix, "bin", "omp-kit");
		const notes: string[] = [];
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				rmSync(stableLink);
				installSymlink(value.prefix, "1.2.4");
				return { status: "UPDATED", exitCode: 0, receiptId: "kit-r7", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" };
			},
			exec,
			reconcile: async () => ({ ok: true, detail: "" }),
			notify: message => { notes.push(message); },
		});
		// Bun's asymmetric matcher can rewrite fields; retain real recovery values first.
		const pluginReceiptId = result.pluginReceiptId;
		const pluginUndoCommand = result.pluginUndoCommand;
		expect(result).toMatchObject({ status: "UPDATED", receiptId: "kit-r7", pluginReceiptId: expect.any(String), pluginUndoCommand: expect.any(String), relink: "APPLIED", service: "APPLIED" });
		if (!pluginReceiptId || !pluginUndoCommand) throw new Error("plugin receipt recovery data is missing");
		const pluginReceiptPath = join(value.prefix, "xdg-state", "omp-kit", `plugin-${pluginReceiptId}.json`);
		const receipt = JSON.parse(readFileSync(pluginReceiptPath, "utf8")) as PluginReceipt;
		expect(receipt.rows.map(row => row.profile).sort()).toEqual(["claude", "codex", "default", "muse"]);
		expect(receipt.rows.every(row => row.status === "APPLIED" && row.before?.target === oldStore && row.after?.target === newStore)).toBe(true);
		for (const profile of ["default", "claude", "codex", "muse"]) expect(readlinkSync(pluginLink(value.home, profile))).toBe(newStore);
		expect(readlinkSync(uncoveredLink)).toBe(join(value.prefix, "uncovered-store"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain(pluginReceiptId);
		expect(notes[0]).toContain(pluginUndoCommand);

		const undone = await exec([stableLink, "undo", pluginReceiptId, "--yes", "--json"]);
		expect(undone.exit).toBe(0);
		for (const profile of ["default", "claude", "codex", "muse"]) expect(readlinkSync(pluginLink(value.home, profile))).toBe(oldStore);
		expect(readlinkSync(uncoveredLink)).toBe(join(value.prefix, "uncovered-store"));
	});
});

test("planted: an OMP no-op cannot claim a complete update when a profile remains on the old release", async () => {
	await withPollEnv(null, async () => {
		const value = config();
		const { oldStore, newStore, uncoveredLink, exec } = preparePluginUpdate(value, "claude");
		installSymlink(value.prefix, "1.2.3");
		const stableLink = join(value.prefix, "bin", "omp-kit");
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				rmSync(stableLink);
				installSymlink(value.prefix, "1.2.4");
				return { status: "UPDATED", exitCode: 0, receiptId: "kit-r8", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" };
			},
			exec,
			reconcile: async () => ({ ok: true, detail: "" }),
		});
		// Retain the receipt before the asymmetric matcher rewrites result fields.
		const pluginReceiptId = result.pluginReceiptId;
		expect(result).toMatchObject({ status: "UPDATED", reason: "PLUGIN_RELINK_FAILED", relink: "FAILED", pluginReceiptId: expect.any(String), pluginUndoCommand: expect.any(String) });
		expect(readlinkSync(pluginLink(value.home, "default"))).toBe(newStore);
		expect(readlinkSync(pluginLink(value.home, "claude"))).toBe(oldStore);
		expect(readlinkSync(uncoveredLink)).toBe(join(value.prefix, "uncovered-store"));
		if (!pluginReceiptId) throw new Error("partial plugin receipt is missing");
		const undone = await exec([stableLink, "undo", pluginReceiptId, "--yes", "--json"]);
		expect(undone.exit).toBe(0);
		for (const profile of ["default", "claude", "codex", "muse"]) expect(readlinkSync(pluginLink(value.home, profile))).toBe(oldStore);
	});
});

/** What applyKitUpdate leaves before its postcheck: the stable link on 1.2.4, a pending kit receipt and its READY activation record. */
function activate(value: KitUpdateJobConfig, recordedBinary?: Buffer, scope: "kit" | "all" = "kit"): string {
	rmSync(join(value.prefix, "bin", "omp-kit"));
	installSymlink(value.prefix, "1.2.4");
	const binary = (version: string) => join(value.prefix, "releases", version, "bin", "omp-kit");
	mkdirSync(dirname(binary("1.2.3")), { recursive: true });
	if (!existsSync(binary("1.2.3"))) writeFileSync(binary("1.2.3"), "known-good prior binary", { mode: 0o755 });
	const priorSha = sha(readFileSync(binary("1.2.3")));
	mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(value.stateRoot, 0o700);
	const lock = acquireKitUpdateLock(value.stateRoot);
	let id: string;
	try { id = beginKitUpdateReceipt(value.stateRoot, lock, { scope, identitySha256: priorSha, kitVersion: "1.2.3", ompVersion: null, channel: null }).id; }
	finally { lock.release(); }
	const path = join(value.stateRoot, `kit-activation-${id}.json`);
	writeFileSync(path, JSON.stringify({ schema_version: 1, id,
		before: { version: "1.2.3", sha256: priorSha, target: "../releases/1.2.3/bin/omp-kit", binary: binary("1.2.3") },
		after: { version: "1.2.4", sha256: sha(recordedBinary ?? readFileSync(binary("1.2.4"))), target: "../releases/1.2.4/bin/omp-kit", binary: binary("1.2.4") },
		state: "READY" }), { mode: 0o600 });
	chmodSync(path, 0o600);
	return id;
}

/** A full-test postcheck that failed only because a live fleet agent wrote the kit state root while it ran. */
function contaminatedPostcheck(changed: string): KitUpdateResult["postcheck"] {
	return { status: "FAIL", matcher: "PASS", live: "PASS", reason: "KIT_POSTCHECK_FAILED", report: {
		status: "FAIL", omp_version: "18.12.1", fast: { status: "PASS" }, current_stage: null, cause: null,
		stages: { "e2e-live": { status: "PASS", producer_rc: 0, duration_ms: 1 } },
		proofs: { G4_live: { status: "PASS", expected_scenarios: 110, observed_scenarios: 110, plant: "PASS" } },
		snapshots: { home: { changed_paths: [changed] }, project: { changed_paths: [] } },
		failures: [`Operator file changed during isolated test: ${changed}`],
	} as never };
}

test("KITREC1: safe PARTIAL automatically undoes to the prior release with compensated recovery and preserves failure detail", async () => {
	await withPollEnv(null, async () => {
		const value = config();
		const { oldStore, exec } = preparePluginUpdate(value);
		installSymlink(value.prefix, "1.2.3");
		let receiptId = "";
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				receiptId = activate(value);
				// A live agent's send-drop lands in the kit state root mid-postcheck, as at 16:05Z on 2026-10-18.
				mkdirSync(join(value.stateRoot, "send-drop"));
				writeFileSync(join(value.stateRoot, "send-drop", "cfsios-1.json"), "{}");
				return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", postcheck: contaminatedPostcheck("~/state/send-drop/cfsios-1.json"), provenance: "SIGSTORE_VERIFIED" };
			},
			exec,
			reconcile: async () => ({ ok: true, detail: "" }),
			notify: () => {},
		});
		const detail = result.postcheckDetail;
		expect(result).toMatchObject({ status: "UNDONE", receiptId, activeVersion: "1.2.3", receipt: "ABORTED_AFTER_COMPENSATION", postcheck: "FAIL",
			postcheckReason: "KIT_POSTCHECK_FAILED", relink: "NOT_RUN", service: "NOT_RUN" });
		expect(detail).toMatchObject({ changed_operator_paths: ["~/state/send-drop/cfsios-1.json"], failures: ["Operator file changed during isolated test: ~/state/send-drop/cfsios-1.json"] });
		expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
		expect(auditMutations(value.stateRoot)).toEqual(expect.arrayContaining([expect.objectContaining({ id: receiptId, status: "ABORTED_AFTER_COMPENSATION" })]));
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
		expect(JSON.parse(readFileSync(join(value.stateRoot, `kit-activation-${receiptId}.json`), "utf8")).state).toBe("RESTORED");
		for (const profile of ["default", "claude", "codex", "muse"]) expect(readlinkSync(pluginLink(value.home, profile))).toBe(oldStore);
		value.pollRelease = async () => null;
		expect(await runKitUpdateJob(value)).toMatchObject({ status: "CURRENT", activeVersion: "1.2.3" });
		const records = readdirSync(value.stateRoot).filter(name => name.startsWith("kit-update-job-"))
			.map(name => JSON.parse(readFileSync(join(value.stateRoot, name), "utf8")));
		expect(records.find(record => record.status === "UNDONE")).toMatchObject({ receipt: "ABORTED_AFTER_COMPENSATION",
			postcheckReason: "KIT_POSTCHECK_FAILED", postcheckDetail: { changed_operator_paths: ["~/state/send-drop/cfsios-1.json"] } });
	});
}, fixtureDeadlineS() * 1000);

test("planted: a live install that does not match its activation record stays PENDING and never relinks", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		mkdirSync(join(value.prefix, "releases", "1.2.4", "bin"), { recursive: true });
		writeFileSync(join(value.prefix, "releases", "1.2.4", "bin", "omp-kit"), "#!/bin/sh\n", { mode: 0o755 });
		const notes: string[] = []; let receiptId = ""; let relinked = false;
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				receiptId = activate(value, Buffer.from("bytes the activation recorded, not the live binary"));
				return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", postcheck: contaminatedPostcheck("~/state/send-drop/cfsios-1.json"), provenance: "SIGSTORE_VERIFIED" };
			},
			relink: async () => { relinked = true; return { ok: true, detail: "", receiptId: "plugin-r2", undoCommand: "omp-kit undo plugin-r2 --yes" }; },
			reconcile: async () => { throw new Error("service reconcile must not run for a pending receipt"); },
			notify: message => { notes.push(message); },
		});
		expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "POSTIMAGE_CHANGED", postcheck: "FAIL",
			postcheckReason: "KIT_POSTCHECK_FAILED", relink: "NOT_RUN", service: "NOT_RUN", notification: true });
		expect(relinked).toBe(false);
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
		expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("Inspect");
		expect(notes[0]).not.toContain("omp-kit undo");
	});
});

// PENDINGSTUCK1: a pending receipt with no deferred detail is finished by the tick only when a live recheck passes, so a fixture that
// expects it to stay PENDING says there is no live witness (the real ladder is never run here).
const noLiveWitness = async (): Promise<never> => { throw new Error("no live witness in this fixture"); };

test("KITREC1: a restarted tick exposes pending recovery before polling, even without a newer release", async () => {
	const value = config(); installSymlink(value.prefix, "1.2.3");
	preparePluginUpdate(value);
	const receiptId = activate(value);
	value.pollRelease = async () => { throw new Error("pending recovery must precede polling"); };
	const notes: string[] = [];
	const result = await runKitUpdateJob(value, { recheckLive: noLiveWitness, notify: message => { notes.push(message); } });
	expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "KIT_RECOVERY_UNVERIFIED",
		activeVersion: "1.2.4", relink: "NOT_RUN", service: "NOT_RUN" });
	expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
	expect(notes[0]).toContain(`omp-kit update --reconcile ${receiptId} --yes`);
	expect(notes[0]).not.toContain("omp-kit undo");
});

// PENDINGSTUCK1 (ompkit-hhqsz): a pending receipt the tick can verify is finished by the tick, not left for a hand `--reconcile`.
const seatOmpForRecovery = { launcher: "/seat/omp", version: "18.18.9", resolvedFrom: "tern-bundle" as const };
function recoveryDependencies(notes: string[], recheck: () => Promise<never>, relinked: { count: number }) {
	return {
		plan: async () => { throw new Error("a pending receipt must be recovered, never re-planned"); },
		apply: async () => { throw new Error("a pending receipt must be recovered, never re-applied"); },
		recheckLive: recheck,
		relink: async () => { relinked.count += 1; return { ok: true, detail: "", receiptId: "plugin-recovered", undoCommand: "omp-kit undo plugin-recovered --yes" }; },
		reconcile: async () => ({ ok: true, detail: "" }),
		omp: () => seatOmpForRecovery,
		notify: (message: string) => { notes.push(String(message)); },
	};
}

test("PENDINGSTUCK1: a pending receipt whose postimage verifies and whose live recheck passes is finished by the tick", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		const receiptId = activate(value);
		const notes: string[] = []; const relinked = { count: 0 };
		const result = await runKitUpdateJob(value, recoveryDependencies(notes, async () => passedLiveReport(), relinked));
		expect(result).toMatchObject({ status: "UPDATED", receiptId, activeVersion: "1.2.4", receipt: "RECONCILED", postcheck: "PASS",
			relink: "APPLIED", service: "APPLIED", pluginReceiptId: "plugin-recovered" });
		expect(relinked.count).toBe(1);
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
		expect(notes.some(note => note.includes("updated to 1.2.4"))).toBe(true);
		expect(kitUpdateJobOverall(result)).toBe("OK");
	});
}, fixtureDeadlineS() * 1000);

test("PENDINGSTUCK1 planted: a receipt whose postimage does not verify stays PENDING and is never reconciled or relinked, even when the live recheck passes", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		mkdirSync(join(value.prefix, "releases", "1.2.4", "bin"), { recursive: true });
		writeFileSync(join(value.prefix, "releases", "1.2.4", "bin", "omp-kit"), "#!/bin/sh\n", { mode: 0o755 });
		const receiptId = activate(value, Buffer.from("bytes the activation recorded, not the live binary"));
		const notes: string[] = []; const relinked = { count: 0 };
		const result = await runKitUpdateJob(value, recoveryDependencies(notes, async () => passedLiveReport(), relinked));
		expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "KIT_RECOVERY_UNVERIFIED", relink: "NOT_RUN", service: "NOT_RUN" });
		expect(relinked.count).toBe(0);
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	});
}, fixtureDeadlineS() * 1000);

test("PENDINGSTUCK1 planted: a failing live recheck leaves the receipt PENDING (nothing undone), and a recent attempt is not retried inside the window", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		const receiptId = activate(value);
		const notes: string[] = []; const relinked = { count: 0 };
		let rechecks = 0;
		const first = await runKitUpdateJob(value, recoveryDependencies(notes, async () => { rechecks += 1; return executedLivePostcheck().report as never; }, relinked));
		expect(first).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "KIT_RECOVERY_UNVERIFIED", relink: "NOT_RUN" });
		expect(rechecks).toBe(1);
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
		const second = await runKitUpdateJob(value, recoveryDependencies(notes, async () => { rechecks += 1; return passedLiveReport(); }, relinked));
		expect(second).toMatchObject({ status: "PENDING", receiptId, reason: "KIT_RECOVERY_UNVERIFIED", notification: false });
		expect(rechecks).toBe(1);
		expect(relinked.count).toBe(0);
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	});
}, fixtureDeadlineS() * 1000);

test("KITREC1 planted: an OMP-changed PARTIAL cannot be automatically reconciled or undone", async () => {
	const value = config(); installSymlink(value.prefix, "1.2.3");
	preparePluginUpdate(value);
	let receiptId = "";
	const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => {
			receiptId = activate(value);
			return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", provenance: "SIGSTORE_VERIFIED",
				postcheck: { status: "FAIL", matcher: "PASS", live: "PASS", reason: "OMP_CHANGED_DURING_KIT_UPDATE" } };
		},
		notify: message => { notes.push(message); },
	});
	expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "OMP_CHANGED_DURING_KIT_UPDATE" });
	expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	expect(notes[0]).toContain("Inspect OMP");
	expect(notes[0]).not.toContain("omp-kit undo");
});

test("KITREC1 planted: null activeVersion names bricked activation without offering an undo that must refuse", async () => {
	const value = config(); installSymlink(value.prefix, "1.2.3");
	preparePluginUpdate(value);
	let receiptId = "";
	const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => {
			receiptId = activate(value);
			rmSync(join(value.prefix, "bin", "omp-kit"));
			return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: null, provenance: "SIGSTORE_VERIFIED",
				postcheck: { status: "NOT_RUN", matcher: "NOT_RUN", live: "NOT_RUN", reason: "KIT_POSTIMAGE_CHANGED" } };
		},
		notify: message => { notes.push(message); },
	});
	expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "KIT_ACTIVATION_UNVERIFIED", activeVersion: null });
	expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	expect(notes[0]).toContain("known-good release binary");
	expect(notes[0]).not.toContain("omp-kit undo");
});

for (const plant of ["control", "all-scope", "not-ready", "prior-tamper", "reconciled", "missing-audit", "unsafe-reason", "unknown-reason", "deferred"] as const) {
	test(`KITREC1 strict automatic undo preconditions: ${plant}`, async () => {
		await withPollEnv(null, async () => {
			const value = config(); installSymlink(value.prefix, "1.2.3");
			preparePluginUpdate(value);
			let receiptId = "";
			const notes: string[] = [];
			const result = await runKitUpdateJob(value, {
				plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
				apply: async () => {
					receiptId = activate(value, undefined, plant === "all-scope" ? "all" : "kit");
					const activation = join(value.stateRoot, `kit-activation-${receiptId}.json`);
					if (plant === "not-ready") {
						const receipt = JSON.parse(readFileSync(activation, "utf8"));
						writeFileSync(activation, JSON.stringify({ ...receipt, state: "UNDO_PENDING" }));
					}
					if (plant === "prior-tamper") writeFileSync(join(value.prefix, "releases", "1.2.3", "bin", "omp-kit"), "tampered prior binary");
					if (plant === "reconciled") reconcilePendingUpdate({ stateRoot: value.stateRoot, prefix: value.prefix, id: receiptId });
					if (plant === "missing-audit") rmSync(join(value.stateRoot, "kit-update.pending.json"));
					const postcheck = contaminatedPostcheck("~/state/send-drop/event.json");
					if (plant === "unsafe-reason") postcheck.reason = "OMP_VERSION_UNVERIFIED";
					if (plant === "unknown-reason") postcheck.reason = "UNRECOGNIZED_POSTCHECK_FAILURE";
					if (plant === "deferred") { postcheck.status = "DEFERRED"; postcheck.reason = "KIT_POSTCHECK_DEFERRED"; }
					return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", postcheck, provenance: "SIGSTORE_VERIFIED" };
				},
				relink: async () => { throw new Error("PARTIAL must not change plugin links"); },
				reconcile: async () => { throw new Error("PARTIAL must not change the service"); },
				notify: message => { notes.push(message); },
			});
			if (plant === "control") {
				expect(result).toMatchObject({ status: "UNDONE", activeVersion: "1.2.3", receipt: "ABORTED_AFTER_COMPENSATION" });
				expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
				expect(auditMutations(value.stateRoot).find(row => row.id === receiptId)?.status).toBe("ABORTED_AFTER_COMPENSATION");
				expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
				expect(notes[0]).toContain("UNDONE");
			} else {
				const reason = plant === "prior-tamper" ? "PRIOR_RELEASE_CHANGED"
					: ["unsafe-reason", "unknown-reason", "deferred"].includes(plant) ? "KIT_AUTO_UNDO_UNSAFE_POSTCHECK"
					: plant === "all-scope" ? "KIT_AUTO_UNDO_SCOPE" : "KIT_RECEIPT_INVALID";
				expect(result).toMatchObject({ status: "PENDING", receiptId, activeVersion: "1.2.4", reason, relink: "NOT_RUN", service: "NOT_RUN" });
				expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
				expect(JSON.parse(readFileSync(join(value.stateRoot, `kit-activation-${receiptId}.json`), "utf8")).state).toBe(plant === "not-ready" ? "UNDO_PENDING" : "READY");
				expect(inspectPendingKitUpdate(value.stateRoot)?.id ?? null).toBe(["reconciled", "missing-audit"].includes(plant) ? null : receiptId);
				expect(notes[0]).not.toContain("UNDONE");
			}
			expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
		});
	});
}

test("the job never hands a project to plan or apply, even when its config carries one", async () => {
	const value = config(); const seen: object[] = [];
	await runKitUpdateJob({ ...value, project: value.home } as KitUpdateJobConfig, {
		plan: async input => { seen.push(input); return { ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never; },
		apply: async plan => { seen.push(plan); return { status: "UPDATED", exitCode: 0, receiptId: "r9", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "SIGSTORE_VERIFIED" }; },
		relink: async () => ({ ok: true, detail: "", receiptId: "plugin-r9", undoCommand: "omp-kit undo plugin-r9 --yes" }),
		reconcile: async () => ({ ok: true, detail: "" }),
	});
	expect(seen).toHaveLength(2);
	for (const input of seen) expect(Object.keys(input)).not.toContain("project");
});

test("a failed relink, service reconcile or postcheck after a verified activation is FINDINGS, never OK", () => {
	const activated: KitUpdateJobResult = { status: "UPDATED", receiptId: "r", activeVersion: "1.2.4", notification: true, receipt: "RECONCILED", postcheck: "PASS", relink: "APPLIED", service: "APPLIED" };
	expect(kitUpdateJobOverall(activated)).toBe("OK");
	expect(kitUpdateJobOverall({ ...activated, reason: "PLUGIN_RELINK_FAILED", relink: "FAILED" })).toBe("FINDINGS");
	expect(kitUpdateJobOverall({ ...activated, reason: "SERVICE_RECONCILE_FAILED", service: "FAILED" })).toBe("FINDINGS");
	expect(kitUpdateJobOverall({ ...activated, postcheck: "FAIL" })).toBe("FINDINGS");
	expect(kitUpdateJobOverall({ status: "CURRENT", receiptId: null, activeVersion: "1.2.4", notification: false, relink: "NOT_RUN" })).toBe("OK");
});

test("planted: relink failure keeps the update, reports BLOCKED and keeps the receipt", async () => {
	const value = config(); const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => ({ status: "UPDATED", exitCode: 0, receiptId: "r3", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }),
		notify: message => { notes.push(message); },
		relink: async () => ({ ok: false, detail: "exit 1: link refused", receiptId: "plugin-r3", undoCommand: "omp-kit undo plugin-r3 --yes" }),
	});
	expect(result).toMatchObject({ status: "UPDATED", receiptId: "r3", activeVersion: "1.2.4", notification: true, reason: "PLUGIN_RELINK_FAILED", relink: "FAILED", pluginReceiptId: "plugin-r3", pluginUndoCommand: "omp-kit undo plugin-r3 --yes" });
	expect(notes).toHaveLength(1); expect(notes[0]).toContain("BLOCKED"); expect(notes[0]).toContain("r3"); expect(notes[0]).toContain("plugin-r3"); expect(notes[0]).toContain("omp-kit undo plugin-r3 --yes");
	expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
});

test("planted: reconcile failure keeps the update, reports BLOCKED and keeps the receipt", async () => {
	const value = config(); const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ ...value, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
		apply: async () => ({ status: "UPDATED", exitCode: 0, receiptId: "r5", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }),
		notify: message => { notes.push(message); },
		relink: async () => ({ ok: true, detail: "", receiptId: "plugin-r5", undoCommand: "omp-kit undo plugin-r5 --yes" }),
		reconcile: async () => ({ ok: false, detail: "exit 1: bootstrap refused" }),
	});
	expect(result).toMatchObject({ status: "UPDATED", receiptId: "r5", activeVersion: "1.2.4", notification: true, reason: "SERVICE_RECONCILE_FAILED", relink: "APPLIED", pluginReceiptId: "plugin-r5", pluginUndoCommand: "omp-kit undo plugin-r5 --yes", service: "FAILED" });
	expect(notes).toHaveLength(1); expect(notes[0]).toContain("BLOCKED"); expect(notes[0]).toContain("r5"); expect(notes[0]).toContain("plugin-r5"); expect(notes[0]).toContain("omp-kit undo plugin-r5 --yes");
});

test("KITUPDATELIVE1: each run prunes old run records to the bound and keeps pending receipts", async () => {
	const value = config();
	mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
	const old = new Date(Date.now() - 30 * 86400000);
	for (let i = 0; i < 50; i++) {
		const path = join(value.stateRoot, `kit-update-job-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.json`);
		writeFileSync(path, JSON.stringify({ schema_version: 1, run_id: `old-${i}`, status: "REFUSED", receiptId: null, activeVersion: null, notification: false, reason: "KIT_TEST_OLD" }));
		utimesSync(path, old, old);
	}
	// Several wedged PENDING records: only the newest one is the recovery trail.
	const pendingNames = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map(stem =>
		`kit-update-job-${stem}-ffff-4000-8000-ffffffffffff.json`);
	pendingNames.forEach((pendingName, index) => {
		const pendingPath = join(value.stateRoot, pendingName);
		writeFileSync(pendingPath, JSON.stringify({ schema_version: 1, run_id: `old-pending-${index}`, status: "PENDING", receiptId: "old-receipt", activeVersion: "1.2.3", notification: true, reason: "KIT_RECOVERY_UNVERIFIED", receipt: "PENDING", relink: "NOT_RUN", service: "NOT_RUN" }));
		utimesSync(pendingPath, new Date(old.getTime() + index * 60000), new Date(old.getTime() + index * 60000));
	});
	// A hand-placed lookalike is not a run record: never parsed, never deleted. Shaped like an
	// old terminal record so a prefix-matching pruner would eat it.
	const backupPath = join(value.stateRoot, "kit-update-job-backup.json");
	const backupBytes = JSON.stringify({ schema_version: 1, run_id: "operator-copy", status: "REFUSED", receiptId: null, activeVersion: null, notification: false, reason: "KIT_TEST_OLD" });
	writeFileSync(backupPath, backupBytes);
	utimesSync(backupPath, old, old);
	const result = await runKitUpdateJob(value, {
		plan: async () => ({ status: "REFUSED", exitCode: 2, reason: "KIT_TEST_REFUSAL", provenance: "UNVERIFIED" } as never),
	});
	expect(result.status).toBe("REFUSED");
	const anchored = /^kit-update-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
	const records = readdirSync(value.stateRoot).filter(name => anchored.test(name));
	// The bound keeps the newest 30 terminal records plus the single newest PENDING receipt.
	expect(records.length).toBeLessThanOrEqual(31);
	expect(records).toContain(pendingNames[2]);
	expect(records).not.toContain(pendingNames[0]);
	expect(records).not.toContain(pendingNames[1]);
	expect(readFileSync(backupPath, "utf8")).toBe(backupBytes);
}, fixtureDeadlineS() * 1000);

function installSymlink(root: string, version: string): void {
	mkdirSync(join(root, "bin"), { recursive: true });
	mkdirSync(join(root, "releases", version, "bin"), { recursive: true });
	symlinkSync(`../releases/${version}/bin/omp-kit`, join(root, "bin", "omp-kit"));
}

function withPollEnv(repo: string | null, fn: () => Promise<void>): Promise<void> {
	const savedPoll = process.env.OMP_KIT_UPDATE_POLL, savedRepo = process.env.OMP_KIT_UPDATE_REPO;
	try {
		if (repo === null) { delete process.env.OMP_KIT_UPDATE_POLL; delete process.env.OMP_KIT_UPDATE_REPO; }
		else { process.env.OMP_KIT_UPDATE_POLL = "github"; process.env.OMP_KIT_UPDATE_REPO = repo; }
		return fn();
	} finally {
		if (savedPoll === undefined) delete process.env.OMP_KIT_UPDATE_POLL; else process.env.OMP_KIT_UPDATE_POLL = savedPoll;
		if (savedRepo === undefined) delete process.env.OMP_KIT_UPDATE_REPO; else process.env.OMP_KIT_UPDATE_REPO = savedRepo;
	}
}

test("poll is inert without OMP_KIT_UPDATE_POLL: the static tuple still flows", async () => {
	await withPollEnv(null, async () => {
		const value = config(); let polled = false;
		value.pollRelease = async () => { polled = true; return { indexPath: join(value.prefix, "i"), archivePath: join(value.prefix, "a"), version: "9.9.9", sourceTag: "v9.9.9" }; };
		const seen = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async () => { throw new Error("network must not be touched"); } });
		expect(seen).toBeNull(); expect(polled).toBe(false);
		const result = await runKitUpdateJob(value, { plan: async input => ({ ...input, status: "CURRENT", exitCode: 0, provenance: "INTEGRITY_ONLY", current: { version: "9.9.9", sha256: "b".repeat(64), target: "t", binary: "b" } } as never) });
		expect(polled).toBe(true); expect(result).toMatchObject({ status: "CURRENT", relink: "NOT_RUN" });
	});
});

test("poll downloads a newer published release into one directory", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		const calls: string[][] = [];
		const fetched: string[] = [];
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
			calls.push([...argv]);
			if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
			const dir = argv[argv.indexOf("--dir") + 1]!;
			mkdirSync(dir, { recursive: true });
			writePolledIndex(dir, "archive");
			writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
			return { exit: 0, stdout: "", stderr: "" };
		}, fetchBundle: bundleFetch(fetched, '{"fixture":true}\n') });
		expect(tuple).toMatchObject({ version: "1.2.4", sourceTag: "v1.2.4" });
		expect(tuple!.indexPath).toBe(join(value.stateRoot, "poll-1.2.4", "release-index.json"));
		expect(tuple!.archivePath).toBe(join(value.stateRoot, "poll-1.2.4", "omp-kit-v1.2.4-darwin-arm64-none.tar"));
		expect(readFileSync(`${tuple!.archivePath}.sigstore.json`, "utf8")).toBe('{"fixture":true}\n');
		// The bundle was asked for the published archive's bytes through the installer's anonymous fetch, never through `gh api`.
		expect(fetched).toEqual([sha("archive")]);
		expect(calls.some(argv => argv[1] === "api")).toBe(false);
		expect(calls[0]).toContain("view");
		expect(calls.filter(argv => argv[2] === "download").map(argv => argv[argv.indexOf("--pattern") + 1])).toEqual(["release-index.json", POLLED_ASSET]);
	});
});

const POLLED_ASSET = "omp-kit-v1.2.4-darwin-arm64-none.tar";
/** Writes the published index for `published` archive bytes into `dir`. */
function writePolledIndex(dir: string, published: string): void {
	writeFileSync(join(dir, "release-index.json"), JSON.stringify({ schema_version: 1, version: "1.2.4", source_tag: "v1.2.4", assets: {
		"darwin-arm64-none": { os: "darwin", arch: "arm64", libc: "none", filename: POLLED_ASSET, sha256: sha(published), manifest_sha256: "b".repeat(64) },
	} }));
}
/** The attestation-bundle fetch seam: records the sha256 of the archive bytes it is asked about and answers `bytes` as the bundle. */
function bundleFetch(seen: string[], bytes: string): NonNullable<KitUpdateJobDependencies["fetchBundle"]> {
	return async archivePath => { seen.push(sha(readFileSync(archivePath, "utf8"))); return Buffer.from(bytes); };
}
/** gh as it behaves: `release download` refuses an existing target file unless --clobber, then writes the published bytes. */
function publishedGh(calls: string[][], published: string): NonNullable<KitUpdateJobDependencies["exec"]> {
	return async argv => {
		calls.push([...argv]);
		if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
		const dir = argv[argv.indexOf("--dir") + 1]!;
		for (const name of ["release-index.json", POLLED_ASSET])
			if (existsSync(join(dir, name)) && !argv.includes("--clobber"))
				return { exit: 1, stdout: "", stderr: `${join(dir, name)} already exists (use \`--clobber\` to overwrite file or \`--skip-existing\` to skip file)` };
		writePolledIndex(dir, published);
		writeFileSync(join(dir, POLLED_ASSET), published);
		return { exit: 0, stdout: "", stderr: "" };
	};
}
/** The poll directory a cycle interrupted mid-poll leaves: the published index, `archive` bytes and a stale bundle. */
function interruptedPoll(stateRoot: string, published: string, archive: string): string {
	const dir = join(stateRoot, "poll-1.2.4");
	mkdirSync(dir, { recursive: true });
	writePolledIndex(dir, published);
	writeFileSync(join(dir, POLLED_ASSET), archive);
	writeFileSync(join(dir, `${POLLED_ASSET}.sigstore.json`), "stale");
	return join(dir, POLLED_ASSET);
}

test("an interrupted poll directory whose index and archive verify is reused: no download, a fresh bundle", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		const archivePath = interruptedPoll(value.stateRoot, "archive", "archive");
		const calls: string[][] = [];
		const fetched: string[] = [];
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: publishedGh(calls, "archive"), fetchBundle: bundleFetch(fetched, '{"fresh":true}\n') });
		expect(tuple).toMatchObject({ version: "1.2.4", sourceTag: "v1.2.4", archivePath });
		expect(calls.some(argv => argv[2] === "download")).toBe(false);
		expect(fetched).toEqual([sha("archive")]);
		expect(readFileSync(`${archivePath}.sigstore.json`, "utf8")).toBe('{"fresh":true}\n');
		expect(readdirSync(dirname(archivePath)).sort()).toEqual([POLLED_ASSET, `${POLLED_ASSET}.sigstore.json`, "release-index.json"].sort());
	});
});

test("planted: a corrupted archive in an interrupted poll directory is re-downloaded with --clobber, never reused", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		const archivePath = interruptedPoll(value.stateRoot, "archive", "archive cut short by a reboot");
		const calls: string[][] = [];
		const fetched: string[] = [];
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: publishedGh(calls, "archive"), fetchBundle: bundleFetch(fetched, '{"fresh":true}\n') });
		const downloads = calls.filter(argv => argv[2] === "download");
		expect(downloads.map(argv => argv[argv.indexOf("--pattern") + 1])).toEqual(["release-index.json", POLLED_ASSET]);
		expect(downloads.every(argv => argv.includes("--clobber"))).toBe(true);
		expect(tuple?.archivePath).toBe(archivePath);
		expect(readFileSync(archivePath, "utf8")).toBe("archive");
		// The bundle is fetched for the published bytes, never for the corrupted ones.
		expect(fetched).toEqual([sha("archive")]);
	});
});

test("published archive without retrievable provenance refuses before planning or activation", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform, {
			exec: async argv => {
				if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
				const dir = argv[argv.indexOf("--dir") + 1]!;
				mkdirSync(dir, { recursive: true });
				writePolledIndex(dir, "archive");
				writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
				return { exit: 0, stdout: "", stderr: "" };
			},
			fetchBundle: async () => { throw new Error("KIT_ATTESTATION_BUNDLE_UNAVAILABLE: attestation unavailable"); },
		})).rejects.toThrow("KIT_ATTESTATION_BUNDLE_UNAVAILABLE");
	});
});

test("planted: poll returns null when the published release is not newer (no downgrade, no download)", async () => {
	await withPollEnv("o/r", async () => {
		for (const installed of ["1.2.4", "1.2.9"]) {
			const value = config(); installSymlink(value.prefix, installed);
			let downloads = 0;
			const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
				if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
				downloads++;
				return { exit: 0, stdout: "", stderr: "" };
			} });
			expect(tuple).toBeNull(); expect(downloads).toBe(0);
		}
	});
});

test("planted: poll refuses a non-semver latest tag instead of installing it", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform,
			{ exec: async () => ({ exit: 0, stdout: "v1.2.4-rehearsal.1.1\n", stderr: "" }) })).rejects.toThrow("KIT_UPDATE_POLL_UNVERIFIED");
	});
});

test("planted: poll refuses a missing repo slug instead of querying blindly", async () => {
	await withPollEnv("not a slug!", async () => {
		const value = config();
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform,
			{ exec: async () => { throw new Error("network must not be touched"); } })).rejects.toThrow("KIT_UPDATE_POLL_CONFIG");
	});
});

test("planted: poll-only with the published tag equal to installed returns CURRENT with no download", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.4");
		value.pollRelease = async () => null;
		let downloads = 0;
		const result = await runKitUpdateJob(value, {
			exec: async argv => {
				if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
				downloads++;
				return { exit: 0, stdout: "", stderr: "" };
			},
			plan: async () => { throw new Error("plan must not run with no source"); },
		});
		expect(downloads).toBe(0);
		expect(result).toMatchObject({ status: "CURRENT", activeVersion: "1.2.4", notification: false, relink: "NOT_RUN", service: "NOT_RUN" });
	});
});

test("poll-only install uses the published tuple when the static fallback is null", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		value.pollRelease = async () => null;
		const seen: string[] = [];
		const result = await runKitUpdateJob(value, {
			exec: async argv => {
				if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
				const dir = argv[argv.indexOf("--dir") + 1]!;
				mkdirSync(dir, { recursive: true });
				writePolledIndex(dir, "archive");
				writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
				return { exit: 0, stdout: "", stderr: "" };
			},
			fetchBundle: async () => Buffer.from('{"fixture":true}\n'),
			plan: async input => { seen.push(input.version); return { ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never; },
			apply: async () => ({ status: "UPDATED", exitCode: 0, receiptId: "r6", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" }),
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-r6", undoCommand: "omp-kit undo plugin-r6 --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			notify: () => {},
		});
		expect(seen).toEqual(["1.2.4"]);
		expect(result).toMatchObject({ status: "UPDATED", receiptId: "r6", activeVersion: "1.2.4", relink: "APPLIED", pluginReceiptId: "plugin-r6", pluginUndoCommand: "omp-kit undo plugin-r6 --yes", service: "APPLIED" });
	});
});

/** A standalone omp install the kit matcher can bind: package, matcher source and natives. */
function ompInstall(root: string, version: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
	for (const relativePath of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		const sourcePath = join(root, "src", relativePath);
		mkdirSync(dirname(sourcePath), { recursive: true });
		writeFileSync(sourcePath, "export {};\n");
	}
	const nativePackage = join(root, "node_modules", "@oh-my-pi", "pi-natives");
	mkdirSync(nativePackage, { recursive: true });
	writeFileSync(join(nativePackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
}

type SeatOmpProbe = {
	selectUpdateOmp?: (env: Record<string, string | undefined>) => { launcher: string; version: string; resolvedFrom: "tern-bundle" | "path" } | null;
	updatePostcheckEnv?: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
};

test("KITUPDATEOMP1: the update postcheck judges the seat omp, not the stale service PATH", async () => {
	// Intentional module-loading boundary (not a literal-specifier shortcut):
	// the planted negative is that the unchanged code has no seat-aware
	// selection at all, so a static import would fail the whole file there
	// instead of failing just this test.
	const probed = await import("../../src/kit-update.ts") as unknown as SeatOmpProbe;
	expect(typeof probed.selectUpdateOmp).toBe("function");
	expect(typeof probed.updatePostcheckEnv).toBe("function");
	const selectUpdateOmp = probed.selectUpdateOmp!;
	const updatePostcheckEnv = probed.updatePostcheckEnv!;
	const root = realpathSync(ownedTmp("l8-seat-omp", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path); dirs.push(root);
	// The stale service PATH: a first-on-PATH omp no seat runs.
	const staleBin = join(root, "service-bin");
	mkdirSync(staleBin, { recursive: true });
	ompInstall(staleBin, "18.10.3");
	writeFileSync(join(staleBin, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// The seat's Tern bundle: the wrapper seats run plus its versioned binary.
	const home = join(root, "home");
	const ternBin = join(home, "Library", "Application Support", "Tern", "omp", "bin");
	const ternVersions = join(home, "Library", "Application Support", "Tern", "omp", "versions");
	mkdirSync(ternVersions, { recursive: true });
	mkdirSync(ternBin, { recursive: true });
	ompInstall(join(home, "Library", "Application Support", "Tern", "omp"), "18.18.8");
	writeFileSync(join(ternVersions, "18.18.8"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	symlinkSync(join("..", "versions", "18.18.8"), join(ternBin, "omp"));
	const staleEnv = { PATH: `${staleBin}:/usr/bin:/bin`, HOME: join(root, "no-tern-home") };
	const seatEnv = { PATH: `${staleBin}:/usr/bin:/bin`, HOME: home };
	// Planted negative, still true after the fix: the old PATH-first resolver
	// picks the stale binary the defect judged. The update must not use it.
	expect(resolveOmpLauncher(staleEnv)).toBe(realpathSync(join(staleBin, "omp")));
	expect(resolveOmpLauncher(seatEnv)).toBe(realpathSync(join(staleBin, "omp")));
	const selected = selectUpdateOmp(seatEnv);
	expect(selected).toMatchObject({ version: "18.18.8", resolvedFrom: "tern-bundle" });
	expect(selected!.launcher).toBe(realpathSync(join(ternBin, "omp")));
	// PATH stays the portable default where no Tern bundle is present.
	expect(selectUpdateOmp(staleEnv)).toMatchObject({ launcher: realpathSync(join(staleBin, "omp")), version: "18.10.3", resolvedFrom: "path" });
	// The postcheck child env judges the same launcher the parent selected.
	const childEnv = updatePostcheckEnv(seatEnv);
	expect(childEnv.PATH!.split(":")[0]).toBe(ternBin);
	expect(resolveOmpLauncher(childEnv)).toBe(selected!.launcher);
	expect(seatEnv.PATH).toBe(`${staleBin}:/usr/bin:/bin`);
	// A packaged version the launcher itself disagrees with is unverified, never stamped.
	const otherHome = join(root, "other-home");
	const otherBin = join(otherHome, "Library", "Application Support", "Tern", "omp", "bin");
	const otherVersions = join(otherHome, "Library", "Application Support", "Tern", "omp", "versions");
	mkdirSync(otherVersions, { recursive: true });
	mkdirSync(otherBin, { recursive: true });
	ompInstall(join(otherHome, "Library", "Application Support", "Tern", "omp"), "18.18.8");
	writeFileSync(join(otherVersions, "18.18.8"), "#!/bin/sh\nprintf '18.10.3\\n'\n", { mode: 0o755 });
	symlinkSync(join("..", "versions", "18.18.8"), join(otherBin, "omp"));
	expect(selectUpdateOmp({ PATH: `${staleBin}:/usr/bin:/bin`, HOME: otherHome })).toBeNull();

});

test("KITUPDATEOMP1-once: a second scheduled run after an UNDONE for the same cause skips without unpacking", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
		writeFileSync(join(value.stateRoot, "kit-update-job-11111111-1111-4111-8111-111111111111.json"), JSON.stringify({
			schema_version: 1, run_id: "11111111-1111-4111-8111-111111111111", status: "UNDONE", receiptId: "r-old", activeVersion: "1.2.3",
			notification: true, receipt: "ABORTED_AFTER_COMPENSATION", postcheck: "FAIL", postcheckReason: "KIT_LIVE_TEST_FAILED",
			targetVersion: "1.2.4", ompResolvedFrom: "path", ompVersion: "18.10.3", ompLauncher: "/service/omp", relink: "NOT_RUN", service: "NOT_RUN",
		}));
		const staleOmp = { launcher: "/service/omp", version: "18.10.3", resolvedFrom: "path" as const };
		const notes: string[] = [];
		let applied = 0;
		const skipped = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { applied++; throw new Error("a suppressed repeat must not unpack or postcheck"); },
			omp: () => staleOmp,
			notify: message => { notes.push(String(message)); },
		});
		expect(applied).toBe(0);
		expect(notes).toHaveLength(0);
		expect(skipped).toMatchObject({ status: "SKIPPED", targetVersion: "1.2.4", postcheckReason: "KIT_LIVE_TEST_FAILED",
			ompResolvedFrom: "path", ompVersion: "18.10.3", ompLauncher: "/service/omp", notification: false, reason: "KIT_UPDATE_REPEAT_SUPPRESSED" });
		expect(kitUpdateJobOverall(skipped)).toBe("OK");
		// A changed omp version retries the same target instead of skipping.
		const freshOmp = { launcher: "/seat/omp", version: "18.18.8", resolvedFrom: "tern-bundle" as const };
		const retried = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { applied++; return { status: "UPDATED", exitCode: 0, receiptId: "r-new", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: freshOmp }; },
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-new", undoCommand: "omp-kit undo plugin-new --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => freshOmp,
			notify: message => { notes.push(String(message)); },
		});
		expect(applied).toBe(1);
		expect(retried).toMatchObject({ status: "UPDATED", targetVersion: "1.2.4", ompResolvedFrom: "tern-bundle", ompVersion: "18.18.8" });
		// A changed kit version retries even when the omp is unchanged.
		value.pollRelease = async () => ({ indexPath: join(value.prefix, "i"), archivePath: join(value.prefix, "a"), version: "1.2.5", sourceTag: "v1.2.5" });
		const newer = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { applied++; return { status: "UPDATED", exitCode: 0, receiptId: "r-newer", activeVersion: "1.2.5", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: freshOmp }; },
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-newer", undoCommand: "omp-kit undo plugin-newer --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => freshOmp,
			notify: message => { notes.push(String(message)); },
		});
		expect(applied).toBe(2);
		expect(newer).toMatchObject({ status: "UPDATED", targetVersion: "1.2.5" });
	});
});

test("UPGRADEHOLD1: an active upgrade hold keeps the installed release (nothing polled, planned or installed, no run record), and the job installs once the hold file is gone", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
		const holdFile = join(value.stateRoot, "upgrade-hold.json");
		writeFileSync(holdFile, JSON.stringify({ reason: "consent prompt pending", by: "PeachLeopard", until: new Date(Date.now() + 3_600_000).toISOString() }));
		const freshOmp = { launcher: "/seat/omp", version: "18.18.8", resolvedFrom: "tern-bundle" as const };
		let planned = 0;
		let applied = 0;
		const dependencies: KitUpdateJobDependencies = {
			plan: async input => { planned++; return { ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never; },
			apply: async () => { applied++; return { status: "UPDATED", exitCode: 0, receiptId: "r-held", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: freshOmp }; },
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-held", undoCommand: "omp-kit undo plugin-held --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => freshOmp,
		};
		const held = await runKitUpdateJob(value, dependencies);
		expect(held).toMatchObject({ status: "SKIPPED", reason: "KIT_UPDATE_HELD", notification: false, activeVersion: "1.2.3" });
		expect(kitUpdateJobOverall(held)).toBe("OK");
		expect({ planned, applied }).toEqual({ planned: 0, applied: 0 });
		expect(readdirSync(value.stateRoot).filter(name => name.startsWith("kit-update-job-"))).toEqual([]);
		rmSync(holdFile);
		const released = await runKitUpdateJob(value, dependencies);
		expect(applied).toBe(1);
		expect(released).toMatchObject({ status: "UPDATED", targetVersion: "1.2.4" });
	});
});

test("KITUPDATEOMP1-once: transient causes retry after six hours, deterministic causes never do", async () => {
	await withPollEnv(null, async () => {
		const staleOmp = { launcher: "/service/omp", version: "18.10.3", resolvedFrom: "path" as const };
		const old = new Date(Date.now() - 7 * 3600 * 1000);
		const seedUndone = (value: KitUpdateJobConfig, postcheckReason: string, postcheckDetail?: unknown) => {
			mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
			const name = "kit-update-job-22222222-2222-4222-8222-222222222222.json";
			writeFileSync(join(value.stateRoot, name), JSON.stringify({ schema_version: 1, run_id: "22222222-2222-4222-8222-222222222222",
				status: "UNDONE", receiptId: "r-old", activeVersion: "1.2.3", notification: true, receipt: "ABORTED_AFTER_COMPENSATION",
				postcheck: "FAIL", postcheckReason, ...(postcheckDetail === undefined ? {} : { postcheckDetail }),
				targetVersion: "1.2.4", ompResolvedFrom: "path", ompVersion: "18.10.3", ompLauncher: "/service/omp", relink: "NOT_RUN", service: "NOT_RUN" }));
			utimesSync(join(value.stateRoot, name), old, old);
		};
		const skipRun = (value: KitUpdateJobConfig, notes: string[], applied: { count: number }) => runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { applied.count++; throw new Error("a suppressed repeat must not unpack or postcheck"); },
			omp: () => staleOmp,
			notify: message => { notes.push(String(message)); },
		});
		// A transient live-test failure older than the window retries.
		const aged = config(); installSymlink(aged.prefix, "1.2.3"); seedUndone(aged, "KIT_LIVE_TEST_FAILED");
		const agedNotes: string[] = []; const agedApplied = { count: 0 };
		const retried = await runKitUpdateJob(aged, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { agedApplied.count++; return { status: "UPDATED", exitCode: 0, receiptId: "r-new", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: staleOmp }; },
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-new", undoCommand: "omp-kit undo plugin-new --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => staleOmp,
			notify: message => { agedNotes.push(String(message)); },
		});
		expect(agedApplied.count).toBe(1);
		expect(retried).toMatchObject({ status: "UPDATED", targetVersion: "1.2.4" });
		// A deterministic omp cause never retries, however old.
		const deterministic = config(); installSymlink(deterministic.prefix, "1.2.3"); seedUndone(deterministic, "OMP_VERSION_MISMATCH");
		const deterministicNotes: string[] = []; const deterministicApplied = { count: 0 };
		const deterministicSkipped = await skipRun(deterministic, deterministicNotes, deterministicApplied);
		expect(deterministicApplied.count).toBe(0);
		expect(deterministicNotes).toHaveLength(0);
		expect(deterministicSkipped).toMatchObject({ status: "SKIPPED", postcheckReason: "OMP_VERSION_MISMATCH" });
		expect(kitUpdateJobOverall(deterministicSkipped)).toBe("OK");
		// A cause that names the judged omp never retries, however old.
		const named = config(); installSymlink(named.prefix, "1.2.3");
		seedUndone(named, "KIT_POSTCHECK_FAILED", { status: "FAIL", omp_version: "18.10.3",
			live: { status: "FAIL", expected_scenarios: 1, observed_scenarios: 0, plant: "NOT_RUN" }, failed_stages: [], deferred_stages: [],
			current_stage: null, cause: { cause_code: "Error", cause_name: "Error", cause_message: "live check against judged omp 18.10.3 failed", cause_stack_head: null },
			changed_operator_paths: [], live_state_paths: [], failures: ["live check against judged omp 18.10.3 failed"] });
		const namedNotes: string[] = []; const namedApplied = { count: 0 };
		const namedSkipped = await skipRun(named, namedNotes, namedApplied);
		expect(namedApplied.count).toBe(0);
		expect(namedSkipped).toMatchObject({ status: "SKIPPED", postcheckReason: "KIT_POSTCHECK_FAILED" });
	});
});


/** KITLIVEDEFER1: run ec8c4268 shaped as a fixture: harness-gate deferred, live NOT_RUN, no failed stage. */
function deferredOnlyReport(): never {
	const deferral = "Stage harness-gate deferred by heavy admission (producer_rc=75): queue timeout";
	return { status: "FAIL", exitCode: 1, omp_version: "18.18.9",
		fast: { status: "PASS", proofs: { G1_registration: { status: "PASS" }, G2_payload: { status: "PASS" }, G3_quiet_prefix: { status: "PASS" } } }, fast_duration_ms: 1,
		stages: {
			manifest: { status: "PASS", producer_rc: 0, duration_ms: 1 },
			"harness-gate": { status: "DEFERRED", producer_rc: 75, duration_ms: 1, reason: "omp-kit heavy deferred the stage before it ran: queue timeout" },
			"e2e-live": { status: "NOT_RUN", producer_rc: null, duration_ms: null },
			"e2e-plant": { status: "NOT_RUN", producer_rc: null, duration_ms: null },
		},
		current_stage: null, cause: null,
		proofs: { G4_live: { status: "NOT_RUN", expected_scenarios: 149, observed_scenarios: 0, plant: "NOT_RUN" } },
		live_scenarios: { expected_ids: [], observed_ids: [], status: "NOT_RUN" },
		snapshots: { release: { unchanged: true, complete: true }, home: { changed_paths: ["~/state/send-drop/cfsios-1.json"], complete: true }, project: { changed_paths: [], complete: true } },
		failures: [deferral, "Operator file changed during isolated test: ~/state/send-drop/cfsios-1.json"],
	} as never;
}

function deferredOnlyPostcheck(): KitUpdateResult["postcheck"] {
	return { status: "FAIL", matcher: "PASS", live: "FAIL", reason: "KIT_LIVE_TEST_FAILED", report: deferredOnlyReport() } as never;
}

function executedLivePostcheck(): KitUpdateResult["postcheck"] {
	return { status: "FAIL", matcher: "PASS", live: "FAIL", reason: "KIT_LIVE_TEST_FAILED", report: {
		status: "FAIL", exitCode: 1, omp_version: "18.18.9",
		fast: { status: "PASS", proofs: { G1_registration: { status: "PASS" }, G2_payload: { status: "PASS" }, G3_quiet_prefix: { status: "PASS" } } }, fast_duration_ms: 1,
		stages: {
			manifest: { status: "PASS", producer_rc: 0, duration_ms: 1 },
			"harness-gate": { status: "PASS", producer_rc: 0, duration_ms: 1 },
			"e2e-live": { status: "FAIL", producer_rc: 1, duration_ms: 1, reason: "scenario failed" },
			"e2e-plant": { status: "PASS", producer_rc: 0, duration_ms: 1 },
		},
		current_stage: null, cause: null,
		proofs: { G4_live: { status: "FAIL", expected_scenarios: 149, observed_scenarios: 149, plant: "PASS" } },
		live_scenarios: { expected_ids: [], observed_ids: [], status: "FAIL" },
		snapshots: { release: { unchanged: true, complete: true }, home: { changed_paths: [], complete: true }, project: { changed_paths: [], complete: true } },
		failures: ["FAIL  close-bare-fire :: expected RED"],
	} } as never;
}

test("KITLIVEDEFER1: deferred live with no failed stage keeps the new version active as PENDING", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		let receiptId = "";
		const notes: string[] = [];
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				receiptId = activate(value);
				return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", postcheck: deferredOnlyPostcheck(), provenance: "SIGSTORE_VERIFIED" };
			},
			relink: async () => { throw new Error("PARTIAL must not change plugin links"); },
			reconcile: async () => { throw new Error("PARTIAL must not change the service"); },
			notify: message => { notes.push(String(message)); },
		});
		expect(result).toMatchObject({ status: "PENDING", receiptId, activeVersion: "1.2.4", receipt: "PENDING", reason: "KIT_POSTCHECK_DEFERRED", relink: "NOT_RUN", service: "NOT_RUN" });
		expect(result.postcheckDetail).toMatchObject({ failed_stages: [], deferred_stages: ["harness-gate"] });
		expect(isLiveDeferredOnly(result.postcheckDetail)).toBe(true);
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
		expect(notes[0]).toContain("harness-gate");
		expect(notes[0]).toContain(`omp-kit update --reconcile ${receiptId} --yes`);
		expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1: one executed failing scenario still compensates to UNDONE", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		let receiptId = "";
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				receiptId = activate(value);
				return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4", postcheck: executedLivePostcheck(), provenance: "SIGSTORE_VERIFIED" };
			},
			relink: async () => { throw new Error("PARTIAL must not change plugin links"); },
			reconcile: async () => { throw new Error("PARTIAL must not change the service"); },
			notify: () => {},
		});
		expect(result).toMatchObject({ status: "UNDONE", receiptId, activeVersion: "1.2.3", receipt: "ABORTED_AFTER_COMPENSATION", postcheck: "FAIL", postcheckReason: "KIT_LIVE_TEST_FAILED", relink: "NOT_RUN", service: "NOT_RUN" });
		expect(isLiveDeferredOnly(result.postcheckDetail)).toBe(false);
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1 planted: current scoring still marks deferred-plus-noise as FAIL KIT_LIVE_TEST_FAILED", async () => {
	const postcheck = judgeKitPostcheck(deferredOnlyReport(), { identityKnown: true, changed: false });
	expect(postcheck).toMatchObject({ status: "FAIL", live: "FAIL", reason: "KIT_LIVE_TEST_FAILED" });
	expect(isLiveDeferredOnly({ status: "FAIL", omp_version: "18.18.9",
		live: { status: "NOT_RUN", expected_scenarios: 149, observed_scenarios: 0, plant: "NOT_RUN" },
		failed_stages: [], deferred_stages: ["harness-gate"], current_stage: null, cause: null,
		changed_operator_paths: [], live_state_paths: [],
		failures: ["Stage harness-gate deferred by heavy admission (producer_rc=75): queue timeout"] })).toBe(true);
	expect(isLiveDeferredOnly({ status: "FAIL", omp_version: "18.18.9",
		live: { status: "FAIL", expected_scenarios: 149, observed_scenarios: 149, plant: "PASS" },
		failed_stages: ["e2e-live"], deferred_stages: [], current_stage: null, cause: null,
		changed_operator_paths: [], live_state_paths: [], failures: ["FAIL  close-bare-fire :: expected RED"] })).toBe(false);
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1: a deferred-only UNDONE does not suppress the retry", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
		writeFileSync(join(value.stateRoot, "kit-update-job-33333333-3333-4333-8333-333333333333.json"), JSON.stringify({
			schema_version: 1, run_id: "33333333-3333-4333-8333-333333333333", status: "UNDONE", receiptId: "r-old", activeVersion: "1.2.3",
			notification: true, receipt: "ABORTED_AFTER_COMPENSATION", postcheck: "FAIL", postcheckReason: "KIT_LIVE_TEST_FAILED",
			postcheckDetail: { status: "FAIL", omp_version: "18.10.3",
				live: { status: "NOT_RUN", expected_scenarios: 149, observed_scenarios: 0, plant: "NOT_RUN" },
				failed_stages: [], deferred_stages: ["harness-gate"], current_stage: null,
				cause: { cause_code: "Error", cause_name: "Error", cause_message: "KIT_LIVE_TEST_FAILED", cause_stack_head: null },
				changed_operator_paths: [], live_state_paths: [],
				failures: ["Stage harness-gate deferred by heavy admission (producer_rc=75): queue timeout"] },
			targetVersion: "1.2.4", ompResolvedFrom: "path", ompVersion: "18.10.3", ompLauncher: "/service/omp", relink: "NOT_RUN", service: "NOT_RUN",
		}));
		const staleOmp = { launcher: "/service/omp", version: "18.10.3", resolvedFrom: "path" as const };
		let applied = 0;
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => { applied++; return { status: "UPDATED", exitCode: 0, receiptId: "r-new", activeVersion: "1.2.4", postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY", omp: staleOmp }; },
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-new", undoCommand: "omp-kit undo plugin-new --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => staleOmp,
			notify: () => {},
		});
		expect(applied).toBe(1);
		expect(result).toMatchObject({ status: "UPDATED", targetVersion: "1.2.4" });
	});
}, fixtureDeadlineS() * 1000);

function passedLiveReport(): never {
	return { status: "PASS", exitCode: 0, omp_version: "18.18.9",
		fast: { status: "PASS", proofs: { G1_registration: { status: "PASS" }, G2_payload: { status: "PASS" }, G3_quiet_prefix: { status: "PASS" } } }, fast_duration_ms: 1,
		stages: {
			manifest: { status: "PASS", producer_rc: 0, duration_ms: 1 },
			"harness-gate": { status: "PASS", producer_rc: 0, duration_ms: 1 },
		},
		current_stage: null, cause: null,
		proofs: { G4_live: { status: "PASS", expected_scenarios: 149, observed_scenarios: 149, plant: "PASS" } },
		live_scenarios: { expected_ids: [], observed_ids: [], status: "PASS" },
		snapshots: { release: { unchanged: true, complete: true }, home: { changed_paths: [], complete: true }, project: { changed_paths: [], complete: true } },
		failures: [],
	} as never;
}

/** A deferred-live PENDING run record for this receipt, as the deferred PARTIAL tick writes it. */
function seedPendingDeferred(value: KitUpdateJobConfig, receiptId: string): void {
	mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(value.stateRoot, "kit-update-job-44444444-4444-4434-8444-444444444444.json"), JSON.stringify({
		schema_version: 1, run_id: "44444444-4444-4434-8444-444444444444", status: "PENDING", receiptId, activeVersion: "1.2.4",
		notification: true, reason: "KIT_POSTCHECK_DEFERRED", receipt: "PENDING", postcheck: "FAIL", postcheckReason: "KIT_LIVE_TEST_FAILED",
		postcheckDetail: { status: "FAIL", omp_version: "18.18.9",
			live: { status: "NOT_RUN", expected_scenarios: 149, observed_scenarios: 0, plant: "NOT_RUN" },
			failed_stages: [], deferred_stages: ["harness-gate"], current_stage: null, cause: null,
			changed_operator_paths: [], live_state_paths: [],
			failures: ["Stage harness-gate deferred by heavy admission (producer_rc=75): queue timeout"] },
		relink: "NOT_RUN", service: "NOT_RUN",
	}));
}

test("KITLIVEDEFER1: matcher FAIL with deferred-only detail still compensates to UNDONE", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		let receiptId = "";
		const result = await runKitUpdateJob(value, {
			plan: async input => ({ ...input, status: "UPDATE_AVAILABLE", exitCode: 0, provenance: "INTEGRITY_ONLY" } as never),
			apply: async () => {
				receiptId = activate(value);
				return { status: "PARTIAL", exitCode: 1, receiptId, activeVersion: "1.2.4",
					postcheck: { ...deferredOnlyPostcheck(), matcher: "FAIL", reason: "KIT_FAST_TEST_FAILED" }, provenance: "SIGSTORE_VERIFIED" };
			},
			relink: async () => { throw new Error("PARTIAL must not change plugin links"); },
			reconcile: async () => { throw new Error("PARTIAL must not change the service"); },
			notify: () => {},
		});
		expect(result).toMatchObject({ status: "UNDONE", receiptId, activeVersion: "1.2.3", receipt: "ABORTED_AFTER_COMPENSATION",
			postcheck: "FAIL", postcheckReason: "KIT_FAST_TEST_FAILED", relink: "NOT_RUN", service: "NOT_RUN" });
		// The detail is still deferred-only: the matcher gate, not the detail, forced compensation.
		expect(isLiveDeferredOnly(result.postcheckDetail)).toBe(true);
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1 finish: a passing live recheck reconciles and completes the activation", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		const receiptId = activate(value);
		seedPendingDeferred(value, receiptId);
		const notes: string[] = [];
		const seatOmp = { launcher: "/seat/omp", version: "18.18.9", resolvedFrom: "tern-bundle" as const };
		const result = await runKitUpdateJob(value, {
			plan: async () => { throw new Error("a deferred-live PENDING must recheck, never re-plan"); },
			apply: async () => { throw new Error("a deferred-live PENDING must recheck, never re-apply"); },
			recheckLive: async () => passedLiveReport(),
			relink: async () => ({ ok: true, detail: "", receiptId: "plugin-finish", undoCommand: "omp-kit undo plugin-finish --yes" }),
			reconcile: async () => ({ ok: true, detail: "" }),
			omp: () => seatOmp,
			notify: message => { notes.push(String(message)); },
		});
		expect(result).toMatchObject({ status: "UPDATED", receiptId, activeVersion: "1.2.4", receipt: "RECONCILED",
			postcheck: "PASS", relink: "APPLIED", service: "APPLIED", pluginReceiptId: "plugin-finish" });
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
		expect(notes.some(note => note.includes("updated to 1.2.4"))).toBe(true);
		expect(kitUpdateJobOverall(result)).toBe("OK");
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1 finish: another deferral stays PENDING without re-notifying", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		const receiptId = activate(value);
		seedPendingDeferred(value, receiptId);
		const notes: string[] = [];
		const seatOmp = { launcher: "/seat/omp", version: "18.18.9", resolvedFrom: "tern-bundle" as const };
		const result = await runKitUpdateJob(value, {
			plan: async () => { throw new Error("a deferred-live PENDING must recheck, never re-plan"); },
			apply: async () => { throw new Error("a deferred-live PENDING must recheck, never re-apply"); },
			recheckLive: async () => deferredOnlyReport(),
			omp: () => seatOmp,
			notify: message => { notes.push(String(message)); },
		});
		expect(result).toMatchObject({ status: "PENDING", receiptId, activeVersion: "1.2.4", receipt: "PENDING",
			reason: "KIT_POSTCHECK_DEFERRED", notification: false, relink: "NOT_RUN", service: "NOT_RUN" });
		expect(result.postcheckDetail).toMatchObject({ failed_stages: [], deferred_stages: ["harness-gate"] });
		expect(notes).toHaveLength(0);
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.4/bin/omp-kit");
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1 finish: an executed live failure compensates to UNDONE", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		const receiptId = activate(value);
		seedPendingDeferred(value, receiptId);
		const seatOmp = { launcher: "/seat/omp", version: "18.18.9", resolvedFrom: "tern-bundle" as const };
		const result = await runKitUpdateJob(value, {
			plan: async () => { throw new Error("a deferred-live PENDING must recheck, never re-plan"); },
			apply: async () => { throw new Error("a deferred-live PENDING must recheck, never re-apply"); },
			recheckLive: async () => (executedLivePostcheck().report as never),
			omp: () => seatOmp,
			notify: () => {},
		});
		expect(result).toMatchObject({ status: "UNDONE", receiptId, activeVersion: "1.2.3", receipt: "ABORTED_AFTER_COMPENSATION",
			postcheck: "FAIL", postcheckReason: "KIT_LIVE_TEST_FAILED", relink: "NOT_RUN", service: "NOT_RUN" });
		expect(readlinkSync(join(value.prefix, "bin", "omp-kit"))).toBe("../releases/1.2.3/bin/omp-kit");
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
	});
}, fixtureDeadlineS() * 1000);

test("KITLIVEDEFER1: a recorded PENDING is not notified again", async () => {
	await withPollEnv(null, async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		preparePluginUpdate(value);
		activate(value);
		const notes: string[] = [];
		const first = await runKitUpdateJob(value, { recheckLive: noLiveWitness, notify: message => { notes.push(String(message)); } });
		expect(first).toMatchObject({ status: "PENDING", reason: "KIT_RECOVERY_UNVERIFIED", notification: true });
		expect(notes).toHaveLength(1);
		const second = await runKitUpdateJob(value, { recheckLive: noLiveWitness, notify: message => { notes.push(String(message)); } });
		expect(second).toMatchObject({ status: "PENDING", reason: "KIT_RECOVERY_UNVERIFIED", notification: false });
		expect(notes).toHaveLength(1);
	});
}, fixtureDeadlineS() * 1000);


const HOOK_EVIDENCE_MEMBER = "hooks.d/pre-commit/40-omp-kit-evidence";
const HOOK_EVIDENCE_OLD = "# managed hook before update\n";
const HOOK_EVIDENCE_NEW = "# managed hook after update\n";
const HOOK_EVIDENCE_ASSERTION = "HOOKJOBEVIDENCE1 persisted member evidence";
type HookEvidenceMode = "untracked" | "tracked-and-failed";
type HookEvidenceContext = {
	value: Pick<KitUpdateJobConfig, "enabled" | "prefix" | "stateRoot" | "home" | "platform">;
	release: { indexPath: string; archivePath: string; version: string; sourceTag: string };
	files: { name: string; file: string }[];
	oldBinary: string;
	repos: { repo: string; source: string; dest: string; tracked: boolean; kind: "managed" | "owner" | "never" }[];
	service: string;
	notes: string;
};

function hookEvidenceEnv(root: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, TMP: root, TEMP: root, KITLIB_TMP_ROOT: root,
		XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_STATE_HOME: join(root, "xdg-state"),
		XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: root, NO_COLOR: "1" };
}

async function hookEvidenceGit(repo: string, args: string[]): Promise<string> {
	const result = await runFixtureAsync(["git", "-C", repo, ...args], {
		cwd: repo, env: hookEvidenceEnv(dirname(repo)), floor_s: 30,
	});
	if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}

function hookEvidenceBinary(): Buffer {
	const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
	const info = JSON.stringify({ version: "1.2.4", source_tag: "v1.2.4", platform: { os: "darwin", arch: "arm64" } });
	return Buffer.from("#!/bin/sh\ncase \"$1 $2\" in\n'--info ') printf '%s\\n' " + quote(info)
		+ ";;\n'--version ') printf '%s\\n' 1.2.4;;\n'apply plugin') exec "
		+ quote(process.execPath) + " --no-env-file " + quote(join(import.meta.dir, "../../src/cli.ts"))
		+ " \"$@\";;\n*) printf '%s\\n' 'fixture refuses unexpected executable command' >&2; exit 2;;\nesac\n");
}

async function prepareHookEvidence(mode: HookEvidenceMode) {
	const value = config();
	const root = value.prefix;
	const payload = [...fixtureContractFiles(),
		{ name: "package.json", bytes: Buffer.from(JSON.stringify({ name: "omp-kit-companion", version: "1.2.4" })) },
		{ name: "scripts/evidence-member.sh", bytes: Buffer.from(HOOK_EVIDENCE_NEW) }];
	const executable = hookEvidenceBinary();
	const releaseManifest = manifest("1.2.4", executable, payload);
	const entries = [{ name: "bin/omp-kit", bytes: executable }, ...payload,
		{ name: "release-manifest.json", bytes: releaseManifest }];
	const source = join(root, "source");
	mkdirSync(source);
	const files = entries.map((entry, index) => {
		const file = join(source, `payload-${index}`);
		writeFileSync(file, entry.bytes);
		return { name: entry.name, file };
	});
	const archivePath = join(source, "omp-kit-v1.2.4-darwin-arm64-none.tar");
	const archive = tar(entries);
	writeFileSync(archivePath, archive);
	const indexPath = join(source, "release-index.json");
	writeFileSync(indexPath, JSON.stringify({ schema_version: 1, version: "1.2.4", source_tag: "v1.2.4", assets: {
		"darwin-arm64-none": { ...value.platform, filename: "omp-kit-v1.2.4-darwin-arm64-none.tar",
			sha256: sha(archive), manifest_sha256: sha(releaseManifest) },
	} }));
	const oldBinary = join(source, "old-binary");
	writeFileSync(oldBinary, binary("1.2.3"));
	const rows: { name: string; tracked: boolean; kind: "managed" | "owner" | "never" }[] = mode === "untracked"
		? [{ name: "enrolled repo", tracked: false, kind: "managed" }, { name: "never enrolled", tracked: false, kind: "never" }]
		: [{ name: "tracked repo", tracked: true, kind: "managed" }, { name: "owner modified", tracked: false, kind: "owner" },
			{ name: "never enrolled", tracked: false, kind: "never" }];
	const repos: HookEvidenceContext["repos"] = [];
	const before = new Map<string, { bytes: string | null; head: string }>();
	for (const row of rows) {
		const repo = join(root, row.name);
		mkdirSync(repo);
		await hookEvidenceGit(repo, ["init", "-q"]);
		if (row.tracked) await hookEvidenceGit(repo, ["config", "core.hooksPath", ".githooks"]);
		const hooks = row.tracked ? join(repo, ".githooks") : join(repo, ".git", "hooks");
		const dest = join(hooks, HOOK_EVIDENCE_MEMBER);
		const bytes = row.kind === "never" ? null : row.kind === "owner" ? "# owner modified hook\n" : HOOK_EVIDENCE_OLD;
		if (bytes !== null) {
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, bytes);
		}
		if (row.tracked) await hookEvidenceGit(repo, ["add", "--", ".githooks"]);
		await hookEvidenceGit(repo, ["-c", "user.name=HookFixture", "-c", "user.email=hook@example.invalid",
			"commit", "-q", "--allow-empty", "-m", "owned hook fixture"]);
		before.set(repo, { bytes, head: await hookEvidenceGit(repo, ["rev-parse", "HEAD"]) });
		repos.push({ repo, dest, tracked: row.tracked, kind: row.kind, source: `owned:${mode}` });
	}
	const context: HookEvidenceContext = { value: { enabled: true, prefix: root, stateRoot: value.stateRoot,
		home: value.home, platform: value.platform }, release: { indexPath, archivePath, version: "1.2.4", sourceTag: "v1.2.4" },
		files, oldBinary, repos, service: join(root, "service-reconciled.json"), notes: join(root, "notifications.json") };
	const contextPath = join(root, "consumer-context.json");
	writeFileSync(contextPath, JSON.stringify(context));
	const runner = join(root, "consumer.test.ts");
	writeFileSync(runner, `import { test } from "bun:test";
import { hookJobEvidenceConsumer } from ${JSON.stringify(join(import.meta.dir, "kit-update-job.test.ts"))};
import { fixtureDeadlineS } from ${JSON.stringify(join(import.meta.dir, "fixture-process.ts"))};
test("HOOKJOBEVIDENCE1_PROCESS", () => hookJobEvidenceConsumer(${JSON.stringify(contextPath)}), fixtureDeadlineS(120) * 1000);
`);
	return { context, runner, before };
}

/** The generated owned-process driver imports this helper; ordinary test cases remain filtered out. */
export async function hookJobEvidenceConsumer(contextPath: string): Promise<void> {
	const context: HookEvidenceContext = JSON.parse(readFileSync(contextPath, "utf8"));
	const value: KitUpdateJobConfig = { ...context.value, pollRelease: async () => context.release };
	const oldStore = join(value.prefix, "releases", "1.2.3");
	const newStore = join(value.prefix, "releases", "1.2.4");
	let pluginExec: KitUpdateJobDependencies["exec"];
	mkdirSync(join(oldStore, "bin"), { recursive: true });
	copyFileSync(context.oldBinary, join(oldStore, "bin", "omp-kit"));
	chmodSync(join(oldStore, "bin", "omp-kit"), 0o755);
	writeFileSync(join(oldStore, "release-manifest.json"), manifest("1.2.3", readFileSync(context.oldBinary)));
	installSymlink(value.prefix, "1.2.3");
	const notes: string[] = [];
	const result = await runKitUpdateJob(value, {
		apply: async () => {
			const prepared = preparePluginUpdate(value);
			pluginExec = prepared.exec;
			for (const entry of context.files) {
				const dest = join(newStore, entry.name);
				mkdirSync(dirname(dest), { recursive: true });
				copyFileSync(entry.file, dest);
			}
			chmodSync(join(newStore, "bin", "omp-kit"), 0o755);
			const id = activate(value);
			reconcilePendingUpdate({ stateRoot: value.stateRoot, prefix: value.prefix, id });
			return { status: "UPDATED", exitCode: 0, receiptId: id, activeVersion: "1.2.4",
				postcheck: { status: "PASS", matcher: "PASS", live: "PASS" }, provenance: "INTEGRITY_ONLY" };
		},
		exec: async argv => {
			if (!pluginExec) throw new Error("owned job invoked plugin commands before activation");
			return pluginExec(argv);
		},
		omp: () => null,
		reconcile: async binaryPath => {
			if (readlinkSync(pluginLink(value.home, "codex")) !== newStore)
				throw new Error("hook fixture service reconcile preceded plugin relink");
			writeFileSync(context.service, JSON.stringify({ binary: binaryPath }));
			return { ok: true, detail: "owned service boundary" };
		},
		refreshHooks: async (store, home) => {
			if (store !== newStore || home !== value.home || !existsSync(context.service))
				throw new Error("hook fixture refresh preceded successful activation/relink/reconcile");
			const live = liveHookRefreshIo(home, store);
			const source = join(store, "scripts", "evidence-member.sh");
			const selected = (repo: string) => {
				const row = context.repos.find(candidate => candidate.repo === repo);
				if (!row) throw new Error("hook fixture rejects a foreign repository");
				return row;
			};
			return refreshFleetHooks({ ...live, pullRepos: () => context.repos,
				check: async repo => {
					const { dest } = selected(repo);
					return existsSync(dest) && readFileSync(dest).equals(readFileSync(source))
						? { rc: 0, output: "" }
						: { rc: 3, output: `install-commit-msg-bead: STALE installed member: ${dest} differs from ${source}; rerun install-commit-msg-bead.sh\n` };
				},
				runInstaller: repo => {
					const { dest } = selected(repo);
					if (readFileSync(dest, "utf8") !== HOOK_EVIDENCE_OLD)
						return { ok: false, detail: "owned installer refuses an owner-modified postimage" };
					copyFileSync(source, dest);
					return { ok: true, detail: "owned filesystem member copied" };
				},
			});
		},
		notify: message => { notes.push(message); writeFileSync(context.notes, JSON.stringify(notes)); },
	});
	if (result.status !== "UPDATED" || inspectPendingKitUpdate(value.stateRoot) !== null)
		throw new Error(`owned job did not finish its valid activation: ${JSON.stringify(result)}`);
}

async function assertHookEvidence(mode: HookEvidenceMode): Promise<void> {
	const { context, runner, before } = await prepareHookEvidence(mode);
	const preload = process.env.HOOKJOBEVIDENCE1_TEST_PRELOAD;
	const result = await runFixtureAsync([process.execPath, "--no-env-file", "test", ...(preload ? ["--preload", preload] : []),
		runner, "-t", "^HOOKJOBEVIDENCE1_PROCESS$"], {
		cwd: context.value.prefix, env: hookEvidenceEnv(context.value.prefix), floor_s: 120,
	});
	const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
	expect(result.rc, output).toBe(0);
	const files = readdirSync(context.value.stateRoot).filter(name => name.startsWith("kit-update-job-") && name.endsWith(".json"));
	expect(files).toHaveLength(1);
	const record: KitUpdateJobResult = JSON.parse(readFileSync(join(context.value.stateRoot, files[0]!), "utf8"));
	const expected = context.repos.map(row => expect.objectContaining({
		repo: row.repo, source: row.source, hooks_dir: dirname(dirname(dirname(row.dest))), tracked: row.tracked,
		status: row.kind === "never" ? "FRESH" : row.kind === "owner" ? "FAILED" : row.tracked ? "PENDING_COMMIT" : "REFRESHED",
		paths: row.kind === "managed" ? [row.dest] : [],
		members: row.kind === "managed" ? [{ member: HOOK_EVIDENCE_MEMBER,
			before_sha256: sha(before.get(row.repo)!.bytes!), after_sha256: sha(HOOK_EVIDENCE_NEW), refreshed: true }] : [],
	}));
	expect(record.hooks?.results, HOOK_EVIDENCE_ASSERTION).toEqual(expect.arrayContaining(expected));
	expect(record.hooks?.results?.map(row => row.repo).sort()).toEqual(context.repos.map(row => row.repo).sort());
	for (const row of context.repos) {
		const prior = before.get(row.repo)!;
		expect(existsSync(row.dest) ? readFileSync(row.dest, "utf8") : null).toBe(
			row.kind === "managed" ? HOOK_EVIDENCE_NEW : prior.bytes);
		expect(await hookEvidenceGit(row.repo, ["rev-parse", "HEAD"])).toBe(prior.head);
	}
	const activations = readdirSync(context.value.stateRoot).filter(name => name.startsWith("kit-activation-") && name.endsWith(".json"));
	expect(activations).toHaveLength(1);
	const activation = JSON.parse(readFileSync(join(context.value.stateRoot, activations[0]!), "utf8"));
	expect(record).toMatchObject({ status: "UPDATED", receiptId: activation.id, receipt: "RECONCILED",
		activeVersion: context.release.version, targetVersion: context.release.version, relink: "APPLIED", service: "APPLIED",
		hooks: { repos: context.repos.length, pending_commit: mode === "untracked" ? 0 : 1, failed: mode === "untracked" ? 0 : 1 } });
	expect(activation.after.sha256).toBe(sha(readFileSync(join(context.value.prefix, "releases", "1.2.4", "bin", "omp-kit"))));
	expect(activation.after.target).toBe("../releases/1.2.4/bin/omp-kit");
	expect(readlinkSync(pluginLink(context.value.home, "codex"))).toBe(join(context.value.prefix, "releases", "1.2.4"));
	expect(JSON.parse(readFileSync(context.service, "utf8")).binary).toBe(join(context.value.prefix, "bin", "omp-kit"));
	const notes: string[] = JSON.parse(readFileSync(context.notes, "utf8"));
	expect(notes).toHaveLength(1);
	expect(notes[0]).toContain(record.receiptId!);
}

test("HOOKJOBEVIDENCE1: untracked producer outcomes survive the completed job process", () => assertHookEvidence("untracked"), fixtureDeadlineS(180) * 1000);
test("HOOKJOBEVIDENCE1: tracked and failed producer outcomes survive the completed job process", () => assertHookEvidence("tracked-and-failed"), fixtureDeadlineS(180) * 1000);

test("HOOKJOBEVIDENCE1_MUTANT: losing only member retention fails the unchanged persisted consumers", async () => {
	const scratch = ownedTmp("hook-job-retention-mutant");
	try {
		const target = realpathSync(join(import.meta.dir, "../../src/kit-update-job.ts"));
		const preload = join(scratch.path, "drop-member-results.ts");
		const loaded = join(scratch.path, "mutant-loaded");
		writeFileSync(preload, `
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const target = ${JSON.stringify(target)};
const loaded = ${JSON.stringify(loaded)};
Bun.plugin({ name: "hook-job-member-retention-only", setup(builder) {
	builder.onLoad({ filter: /kit-update-job\\.ts$/ }, args => {
		if (realpathSync(args.path) !== target) return;
		const source = readFileSync(target, "utf8");
		const needle = "results: report.results,";
		if (source.split(needle).length !== 2) throw new Error("hook retention mutant site is not unique");
		writeFileSync(loaded, "member-results-removed");
		return { contents: source.replace(needle, ""), loader: "ts", resolveDir: dirname(target) };
	});
}});
`);
		const argv = [process.execPath, "--no-env-file", "test", join(import.meta.dir, "kit-update-job.test.ts"), "-t", "^HOOKJOBEVIDENCE1:"];
		const env = hookEvidenceEnv(scratch.path);
		const healthy = await runFixtureAsync(argv, { cwd: scratch.path, env, floor_s: 300 });
		const healthyOutput = new TextDecoder().decode(healthy.stdout) + new TextDecoder().decode(healthy.stderr);
		expect(healthy.rc, healthyOutput).toBe(0);
		expect(healthyOutput).toContain("2 pass");
		const mutant = await runFixtureAsync(argv, { cwd: scratch.path,
			env: { ...env, HOOKJOBEVIDENCE1_TEST_PRELOAD: preload }, floor_s: 300 });
		const mutantOutput = new TextDecoder().decode(mutant.stdout) + new TextDecoder().decode(mutant.stderr);
		expect(mutant.rc, mutantOutput).toBe(1);
		expect(existsSync(loaded), mutantOutput).toBe(true);
		expect(readFileSync(loaded, "utf8")).toBe("member-results-removed");
		expect(mutantOutput).toContain(HOOK_EVIDENCE_ASSERTION);
		expect(mutantOutput).toContain("2 fail");
		console.log("HOOKJOBEVIDENCE1_MUTANT_WITNESS " + JSON.stringify({
			healthy_rc: healthy.rc, mutant_rc: mutant.rc,
			persisted_member_assertion_failed: mutantOutput.includes(HOOK_EVIDENCE_ASSERTION),
			two_original_consumers_failed: mutantOutput.includes("2 fail"),
		}));
	} finally { scratch.cleanup(); }
}, fixtureDeadlineS(600) * 1000);

afterAll(() => cleanupAllOwnedTmp());

// PENDINGSTUCK1-probe (ompkit-hhqsz box [b]): the default start-probe deadline grows with load per CPU, and a start that never finishes still holds.
async function probeWithFakeOmp(body: string, options: StartProbeOptions): Promise<StartProbeResult> {
	const dir = realpathSync(ownedTmp("start-probe-fake", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path); dirs.push(dir);
	writeFileSync(join(dir, "omp"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	const savedPath = process.env.PATH; const savedDeadline = process.env.OMP_KIT_START_PROBE_DEADLINE_S;
	process.env.PATH = `${dir}:${savedPath ?? ""}`; delete process.env.OMP_KIT_START_PROBE_DEADLINE_S;
	try { return await runStartProbe(options); } finally {
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		if (savedDeadline !== undefined) process.env.OMP_KIT_START_PROBE_DEADLINE_S = savedDeadline;
	}
}

test("PENDINGSTUCK1-probe: the load factor is 1 up to one CPU's worth of load per CPU, grows with it, and stops at the cap", () => {
	expect(startProbeLoadFactor(0, 12)).toBe(1);
	expect(startProbeLoadFactor(12, 12)).toBe(1);
	expect(startProbeLoadFactor(24, 12)).toBe(2);
	expect(startProbeLoadFactor(400, 12)).toBe(START_PROBE_MAX_LOAD_FACTOR);
	expect(startProbeLoadFactor(Number.NaN, 12)).toBe(1);
	expect(startProbeLoadFactor(30, 0)).toBe(1);
});

test("PENDINGSTUCK1-probe: a slow start on a loaded host finishes inside the scaled deadline, while the same start on an idle host holds", async () => {
	const slowStart = "sleep 2\nexit 1";
	const loaded = await probeWithFakeOmp(slowStart, { load1: 48, cpus: 12, baseDeadlineS: 1 });
	expect(loaded).toMatchObject({ started: true, timedOut: false, exit: 1 });
	const idle = await probeWithFakeOmp(slowStart, { load1: 0, cpus: 12, baseDeadlineS: 1 });
	expect(idle.timedOut).toBe(true);
}, fixtureDeadlineS() * 1000);

test("PENDINGSTUCK1-probe planted: a probe that never finishes still holds, however loaded the host", async () => {
	const hung = await probeWithFakeOmp("sleep 30", { load1: 48, cpus: 12, baseDeadlineS: 1 });
	expect(hung).toMatchObject({ started: true, timedOut: true });
}, fixtureDeadlineS() * 1000);
