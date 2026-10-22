import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kitUpdateJobOverall, pollPublishedRelease, runKitUpdateJob, type KitUpdateJobConfig, type KitUpdateJobDependencies, type KitUpdateJobResult } from "../../src/kit-update-job.ts";
import type { KitUpdateResult } from "../../src/kit-update.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import type { PluginReceipt } from "../../src/apply-plugin.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
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
function activate(value: KitUpdateJobConfig, recordedBinary?: Buffer): string {
	rmSync(join(value.prefix, "bin", "omp-kit"));
	installSymlink(value.prefix, "1.2.4");
	mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(value.stateRoot, 0o700);
	const lock = acquireKitUpdateLock(value.stateRoot);
	let id: string;
	try { id = beginKitUpdateReceipt(value.stateRoot, lock, { scope: "kit", identitySha256: "a".repeat(64), kitVersion: "1.2.3", ompVersion: null, channel: null }).id; }
	finally { lock.release(); }
	const binary = (version: string) => join(value.prefix, "releases", version, "bin", "omp-kit");
	const path = join(value.stateRoot, `kit-activation-${id}.json`);
	writeFileSync(path, JSON.stringify({ schema_version: 1, id,
		before: { version: "1.2.3", sha256: "a".repeat(64), target: "../releases/1.2.3/bin/omp-kit", binary: binary("1.2.3") },
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

test("a postcheck the live fleet contaminated cannot strand a verified activation: RECONCILED, plugins relinked, reason kept", async () => {
	await withPollEnv(null, async () => {
		const value = config();
		const { newStore, exec } = preparePluginUpdate(value);
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
		expect(result).toMatchObject({ status: "UPDATED", receiptId, activeVersion: "1.2.4", receipt: "RECONCILED", postcheck: "FAIL",
			postcheckReason: "KIT_POSTCHECK_FAILED", relink: "APPLIED", service: "APPLIED" });
		expect(detail).toMatchObject({ changed_operator_paths: ["~/state/send-drop/cfsios-1.json"], failures: ["Operator file changed during isolated test: ~/state/send-drop/cfsios-1.json"] });
		expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
		expect(inspectPendingKitUpdate(value.stateRoot)).toBeNull();
		expect(auditMutations(value.stateRoot)).toEqual(expect.arrayContaining([expect.objectContaining({ id: receiptId, status: "RECONCILED" })]));
		for (const profile of ["default", "claude", "codex", "muse"]) expect(readlinkSync(pluginLink(value.home, profile))).toBe(newStore);
		const records = readdirSync(value.stateRoot).filter(name => name.startsWith("kit-update-job-"));
		expect(records).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(value.stateRoot, records[0]!), "utf8"))).toMatchObject({ receipt: "RECONCILED",
			postcheckReason: "KIT_POSTCHECK_FAILED", postcheckDetail: { changed_operator_paths: ["~/state/send-drop/cfsios-1.json"] } });
	});
});

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
		expect(result).toMatchObject({ status: "PENDING", receiptId, receipt: "PENDING", reason: "PENDING_RECOVERY", postcheck: "FAIL",
			postcheckReason: "KIT_POSTCHECK_FAILED", relink: "NOT_RUN", service: "NOT_RUN", notification: true });
		expect(relinked).toBe(false);
		expect(inspectPendingKitUpdate(value.stateRoot)?.id).toBe(receiptId);
		expect(kitUpdateJobOverall(result)).toBe("FINDINGS");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain(`omp-kit undo ${receiptId} --yes`);
		expect(notes[0]).not.toContain("automatic undo");
	});
});

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
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
			calls.push([...argv]);
			if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
			if (argv[1] === "api") return { exit: 0, stdout: '{"fixture":true}\n', stderr: "" };
			const dir = argv[argv.indexOf("--dir") + 1]!;
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "release-index.json"), "{}");
			writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
			return { exit: 0, stdout: "", stderr: "" };
		} });
		expect(tuple).toMatchObject({ version: "1.2.4", sourceTag: "v1.2.4" });
		expect(tuple!.indexPath).toBe(join(value.stateRoot, "poll-1.2.4", "release-index.json"));
		expect(tuple!.archivePath).toBe(join(value.stateRoot, "poll-1.2.4", "omp-kit-v1.2.4-darwin-arm64-none.tar"));
		expect(readFileSync(`${tuple!.archivePath}.sigstore.json`, "utf8")).toBe('{"fixture":true}\n');
		expect(calls[2]).toContain("api");
		expect(calls[0]).toContain("view");
		expect(calls[1]).not.toContain("--clobber");
	});
});

const POLLED_ASSET = "omp-kit-v1.2.4-darwin-arm64-none.tar";
/** Writes the published index for `published` archive bytes into `dir`. */
function writePolledIndex(dir: string, published: string): void {
	writeFileSync(join(dir, "release-index.json"), JSON.stringify({ schema_version: 1, version: "1.2.4", source_tag: "v1.2.4", assets: {
		"darwin-arm64-none": { os: "darwin", arch: "arm64", libc: "none", filename: POLLED_ASSET, sha256: sha(published), manifest_sha256: "b".repeat(64) },
	} }));
}
/** gh as it behaves: `release download` refuses an existing target file unless --clobber, then writes the published bytes. */
function publishedGh(calls: string[][], published: string): NonNullable<KitUpdateJobDependencies["exec"]> {
	return async argv => {
		calls.push([...argv]);
		if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
		if (argv[1] === "api") return { exit: 0, stdout: '{"fresh":true}\n', stderr: "" };
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
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: publishedGh(calls, "archive") });
		expect(tuple).toMatchObject({ version: "1.2.4", sourceTag: "v1.2.4", archivePath });
		expect(calls.some(argv => argv[2] === "download")).toBe(false);
		expect(calls.find(argv => argv[1] === "api")).toContain(`repos/o/r/attestations/sha256:${sha("archive")}`);
		expect(readFileSync(`${archivePath}.sigstore.json`, "utf8")).toBe('{"fresh":true}\n');
		expect(readdirSync(dirname(archivePath)).sort()).toEqual([POLLED_ASSET, `${POLLED_ASSET}.sigstore.json`, "release-index.json"].sort());
	});
});

test("planted: a corrupted archive in an interrupted poll directory is re-downloaded with --clobber, never reused", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		const archivePath = interruptedPoll(value.stateRoot, "archive", "archive cut short by a reboot");
		const calls: string[][] = [];
		const tuple = await pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: publishedGh(calls, "archive") });
		const downloads = calls.filter(argv => argv[2] === "download");
		expect(downloads).toHaveLength(1);
		expect(downloads[0]).toContain("--clobber");
		expect(tuple?.archivePath).toBe(archivePath);
		expect(readFileSync(archivePath, "utf8")).toBe("archive");
		// The bundle is fetched for the published bytes, never for the corrupted ones.
		expect(calls.find(argv => argv[1] === "api")).toContain(`repos/o/r/attestations/sha256:${sha("archive")}`);
	});
});

test("published archive without retrievable provenance refuses before planning or activation", async () => {
	await withPollEnv("o/r", async () => {
		const value = config(); installSymlink(value.prefix, "1.2.3");
		await expect(pollPublishedRelease(value.prefix, value.stateRoot, value.platform, { exec: async argv => {
			if (argv[2] === "view") return { exit: 0, stdout: "v1.2.4\n", stderr: "" };
			if (argv[1] === "api") return { exit: 1, stdout: "", stderr: "attestation unavailable" };
			const dir = argv[argv.indexOf("--dir") + 1]!;
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "release-index.json"), "{}");
			writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
			return { exit: 0, stdout: "", stderr: "" };
		} })).rejects.toThrow("KIT_ATTESTATION_BUNDLE_UNAVAILABLE");
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
				if (argv[1] === "api") return { exit: 0, stdout: '{"fixture":true}\n', stderr: "" };
				const dir = argv[argv.indexOf("--dir") + 1]!;
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "release-index.json"), "{}");
				writeFileSync(join(dir, "omp-kit-v1.2.4-darwin-arm64-none.tar"), "archive");
				return { exit: 0, stdout: "", stderr: "" };
			},
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

afterAll(() => cleanupAllOwnedTmp());
