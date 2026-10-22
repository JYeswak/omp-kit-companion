// One registry of every fleet integration point that leaves state behind a process (ompkit-774u.12 OWNERREG1,
// J-2026-10-18-08): what keys the state, what survives a respawn, how it is cancelled, how it ends after a crash,
// and which producer proves the terminal outcome. `omp-kit doctor --scope ownership` reads it; the lint in
// src/ownership-lint.ts refuses a persisted pid-keyed record whose writer is not registered here.
//
// The rows come from the 2026-10-18 pid-keyed state inventory: every row that is not class NONE has an entry.

export type OwnershipClass = "REHOME" | "REAP" | "RELEASE";
export type OwnerKey = "agent+session" | "pid+start" | "pid+start+session" | "pid+token" | "pid" | "wrapper-pid+birth" | "pid+ref-token" | "process-group" | "ppid";
/** What the keyed process is: a seat survives a respawn as the same agent, the others do not outlive their run. */
export type OwnerScope = "seat" | "service" | "cli-run" | "child-process" | "external-tool";
export type TerminalOutcome = "handed-over" | "released" | "reaped" | "self-heals";
export type CensusId =
	| "scratch-dirs" | "scratch-quarantine" | "harness-orphans" | "service-claims" | "heavy-queue" | "send-locks"
	| "converge-locks" | "rch-leases" | "ntm-watcher-locks";

export interface OwnershipEntry {
	id: string;
	title: string;
	/** Rows of docs/evidence/pid-keyed-state-inventory-20261018.md (omp-kit private repo) this entry accounts for. */
	rows: readonly number[];
	class: OwnershipClass;
	ownerKey: OwnerKey;
	scope: OwnerScope;
	/** True when the key still names the owner after the seat is respawned under a new pid. */
	survivesRespawn: boolean;
	/** Source files that persist the record (repo-relative), or an `external:` note for tools outside this repo. */
	writers: readonly string[];
	cancel: string;
	crash: string;
	respawn: string;
	terminal: { outcome: TerminalOutcome; producer: string };
	/** The census the doctor runs for this entry; null when no durable record can be counted from here. */
	census: CensusId | null;
	/** Why there is no census, when census is null. */
	noCensus?: string;
	/** Bead that owns repairing untracked records of this class; null until one exists. */
	ownerBead: string | null;
}

export const OWNERSHIP_REGISTRY: readonly OwnershipEntry[] = [
	{
		id: "scratch-seat-dir", title: "Seat and agent scratch dirs var/agent-tmp/<label>.<pid>/.owner",
		rows: [1, 2, 3], class: "REHOME", ownerKey: "agent+session", scope: "seat", survivesRespawn: true,
		writers: ["src/fleet-guard/scratch.ts", "extensions/fleet-guard.ts", "src/scratch.ts"],
		cancel: "omp-kit scratch release DIR by the same agent holding the owner's omp session (any pid)",
		crash: "reaper: dead pid, no live seat for the named session and no open file descriptors is REAP; an unprovable seat is never reaped",
		respawn: "the successor holds the same session lease, so the dir stays LIVE and releasable; legacy pid-only records are handed over by respawn_seat.py until their seats restart on the guard that writes agent+session",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply (scratch-reaper job): quarantine, TTL, delete, with a JSONL receipt" },
		census: "scratch-dirs", ownerBead: "ompkit-774u.9.3",
	},
	{
		id: "scratch-quarantine", title: "Scratch quarantine ~/.local/state/omp-kit/scratch-quarantine",
		rows: [1, 2], class: "REAP", ownerKey: "agent+session", scope: "service", survivesRespawn: true,
		writers: ["src/scratch.ts"],
		cancel: "none: entries are already released or reaped dirs awaiting their TTL",
		crash: "the next scratch-reaper run deletes entries past the configured TTL (default 24 h) after owner and lsof rechecks",
		respawn: "not applicable: the entry no longer has a live owner by construction",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply (applyQuarantineExpiry) with a JSONL receipt" },
		census: "scratch-quarantine", ownerBead: "ompkit-7e9g.1",
	},
	{
		id: "scratch-work-dir", title: "omp-kit-work dirs from runtime-adapter (.owner with pid=$PPID and process_start)",
		rows: [4], class: "REAP", ownerKey: "pid+start", scope: "cli-run", survivesRespawn: false,
		writers: ["scripts/runtime-adapter.sh", "src/scratch.ts"],
		cancel: "the run ends and its dir is released or reaped",
		crash: "reaper: dead or reused owner and no open file descriptors is REAP",
		respawn: "the owner is the invoking shell, not the seat; a respawn makes a finished run reapable, which is correct",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply" },
		census: null, noCensus: "its dirs sit in the same scratch roots and are counted once, by scratch-seat-dir", ownerBead: "ompkit-774u.9.3",
	},
	{
		id: "tracker-recovery-lease", title: "Tracker-recovery lease (.omp-kit-recovery-lease.json)",
		rows: [5], class: "RELEASE", ownerKey: "pid+start+session", scope: "service", survivesRespawn: false,
		writers: ["src/tracker-recovery.ts"],
		cancel: "the holder releases the lease when the recovery pass ends",
		crash: "the next pass sees a dead holder (pid, start time and session id) and takes the lease over",
		respawn: "the holder is the fleet-watch service process, not a seat",
		terminal: { outcome: "self-heals", producer: "src/tracker-recovery.ts stale-lease takeover" },
		census: null, noCensus: "leases live in per-repo br run directories that this doctor does not enumerate", ownerBead: null,
	},
	{
		id: "service-job-claim", title: "Service job claim ~/.local/state/omp-kit/jobs/<job>.lock/pid",
		rows: [6], class: "RELEASE", ownerKey: "pid+token", scope: "service", survivesRespawn: false,
		writers: ["src/service-run.ts", "src/cli.ts"],
		cancel: "the keeper releases the claim when the job returns",
		crash: "a dead pid is reclaimed by the next run of the job",
		respawn: "the keeper is a service process, not a seat",
		terminal: { outcome: "self-heals", producer: "src/service-run.ts acquireRunLock reclaim" },
		census: "service-claims", ownerBead: "ompkit-774u.12.6",
	},
	{
		id: "heavy-queue", title: "Heavy queue lock owner.json and job records ~/.local/state/omp-kit/load",
		rows: [7], class: "REAP", ownerKey: "pid+start", scope: "cli-run", survivesRespawn: false,
		writers: ["src/heavy.ts"],
		cancel: "omp-kit heavy removes its job row when the child exits",
		crash: "the load doctor drops a job whose pid is dead or whose start time changed",
		respawn: "the job dies with its process tree",
		terminal: { outcome: "self-heals", producer: "src/heavy.ts and src/load-doctor.ts job pruning" },
		census: "heavy-queue", ownerBead: null,
	},
	{
		id: "pane-send-lock", title: "Pane send lock ~/.local/state/omp-kit/send-locks/<session>-<pane>.lock (holder pid)",
		rows: [8], class: "RELEASE", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: ["src/send.ts"],
		cancel: "the sender removes the lock when the send ends",
		crash: "a holder that is gone (ESRCH) is taken over and the lock removed",
		respawn: "a short-lived CLI lock, not a seat",
		terminal: { outcome: "self-heals", producer: "src/send.ts acquirePaneLock takeover" },
		census: "send-locks", ownerBead: "ompkit-774u.12.6",
	},
	{
		id: "converge-lock", title: "Converge lock <git dir>/git_converge.lock plus refs/omp-kit/converge-lock",
		rows: [9], class: "RELEASE", ownerKey: "pid+ref-token", scope: "cli-run", survivesRespawn: false,
		writers: ["src/converge.ts"],
		cancel: "the converge run releases the PID file and deletes the ref token",
		crash: "a stale holder is taken over by compare-and-swap on the ref token",
		respawn: "a short-lived CLI lock, not a seat",
		terminal: { outcome: "self-heals", producer: "src/converge.ts takeLock stale takeover" },
		census: "converge-locks", ownerBead: "ompkit-774u.12.5",
	},
	{
		id: "browser-orphan-chrome", title: "Headless Chrome under a dead broker session",
		rows: [10], class: "REAP", ownerKey: "ppid", scope: "child-process", survivesRespawn: false,
		writers: ["src/browser-doctor.ts"],
		cancel: "the broker closes its browsers at teardown",
		crash: "the browser doctor classes Chrome under a dead session ORPHAN and kills only the recorded pid",
		respawn: "not applicable: a browser belongs to its broker session",
		terminal: { outcome: "reaped", producer: "omp-kit browser doctor" },
		census: null, noCensus: "no persisted record: orphans are found from the process table by omp-kit doctor --scope browsers", ownerBead: null,
	},
	{
		id: "harness-orphan-server", title: "Kit harness servers left at ppid 1 (mock-model.mjs, external-live.mjs)",
		rows: [11], class: "REAP", ownerKey: "ppid", scope: "child-process", survivesRespawn: false,
		writers: ["src/scratch.ts"],
		cancel: "the test that started the server stops it",
		crash: "the scratch reaper kills a harness server at ppid 1 older than one hour",
		respawn: "not applicable",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply (killOrphan)" },
		census: "harness-orphans", ownerBead: "ompkit-7e9g.1",
	},
	{
		id: "e2e-pgid-file", title: "e2e process-group file (LIMIT_PGID_FILE)",
		rows: [12], class: "REAP", ownerKey: "process-group", scope: "child-process", survivesRespawn: false,
		writers: ["external: scripts/limit-process-tree.sh, scripts/e2e-live.sh"],
		cancel: "e2e-live.sh kills the recorded group when the run ends",
		crash: "the file lives in the run's scratch dir and goes with it",
		respawn: "not applicable: a test harness",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply (the owning scratch dir)" },
		census: null, noCensus: "lives inside a scratch dir; counted by scratch-seat-dir", ownerBead: null,
	},
	{
		id: "kit-temp-names", title: "Kit temp files and harness .owner files named with process.pid",
		rows: [13], class: "REAP", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: [
			"src/cli.ts", "src/diagnostics.ts", "src/disk-stage.ts", "src/fleet-lessons.ts", "src/fleet-watch.ts", "src/full-test-runner.ts", "src/integrations.ts",
			"src/mechanical-admission.ts", "src/mutations.ts", "src/omp-recert.ts", "src/omp-source-cache.ts", "src/omp-watch.ts", "src/service.ts",
		],
		cancel: "each writer renames or removes its temp file in the same call",
		crash: "a leftover temp file sits in repo scratch or the state root and is reaped with it",
		respawn: "the pid is only part of a unique name; no owner is inferred from it",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply, or the writer's own rename" },
		census: null, noCensus: "a name, not an ownership record: nothing reads the pid back", ownerBead: null,
	},
	{
		id: "history-remove-owner", title: "history_remove_apply.py recovery owner (pid, process_start, nonce)",
		rows: [15], class: "RELEASE", ownerKey: "pid+start", scope: "cli-run", survivesRespawn: false,
		writers: ["external: omp-kit-orchestration skill scripts/history_remove_apply.py"],
		cancel: "the operator run clears its owner record when it finishes",
		crash: "a dead owner falls through to recovery",
		respawn: "operator-invoked, not a seat",
		terminal: { outcome: "self-heals", producer: "history_remove_apply.py recovery path" },
		census: null, noCensus: "the writer lives in the chief skill, outside this repository", ownerBead: null,
	},
	{
		id: "ternwatch-state-temp", title: "ternwatch_lite.py state temp file named with the pid",
		rows: [17], class: "REAP", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: ["external: omp-kit-orchestration skill scripts/ternwatch_lite.py"],
		cancel: "the script renames the temp file over its state file",
		crash: "a leftover temp file is reaped with its scratch dir",
		respawn: "a one-shot script",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply" },
		census: null, noCensus: "the writer lives in the chief skill, outside this repository", ownerBead: null,
	},
	{
		id: "selftest-pid-state", title: "git_converge, sitrep, idle_wait, afw-index and cc self-test pid files and $$ temp names",
		rows: [18], class: "REAP", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: ["external: omp-kit scripts/git_converge.py, scripts/sitrep.sh, scripts/idle_wait_selftest.py, scripts/afw-index.sh, scripts/cc"],
		cancel: "each one-shot script removes its file when it exits",
		crash: "leftovers sit in scratch or the git dir and are reaped or taken over like the converge lock",
		respawn: "one-shot processes",
		terminal: { outcome: "reaped", producer: "omp-kit scratch apply; git_converge.py stale-lock path" },
		census: null, noCensus: "writers live in the private tracker repo's scripts", ownerBead: null,
	},
	{
		id: "rch-job-lease", title: "rch job leases job-leases/rchw-*.json and the rchw-*.recovery.lock pile",
		rows: [20], class: "RELEASE", ownerKey: "wrapper-pid+birth", scope: "external-tool", survivesRespawn: false,
		writers: ["external: rch binary (~/.local/state/rch/job-leases); read by src/rch-cycle.ts"],
		cancel: "the wrapper marks its lease terminal_acknowledged when the build ends",
		crash: "a lease whose wrapper is dead and that is not terminal is recovered by rch from its recovery record",
		respawn: "the wrapper is a child of the seat's shell and dies with it",
		terminal: { outcome: "released", producer: "rch: terminal_acknowledged lease or a recover-consumed marker" },
		census: "rch-leases", ownerBead: "ompkit-774u.12.3",
	},
	{
		id: "ntm-watcher-lock", title: "ntm watcher locks ~/.local/state/ntm/watcher-<session>.lock (plain pid)",
		rows: [21], class: "RELEASE", ownerKey: "pid", scope: "external-tool", survivesRespawn: false,
		writers: ["external: ntm binary"],
		cancel: "ntm removes the lock when its watcher stops",
		crash: "unknown: no source on disk; a lock whose pid is gone is stale",
		respawn: "a watcher process, not a seat",
		terminal: { outcome: "released", producer: "ntm" },
		census: "ntm-watcher-locks", ownerBead: "ompkit-774u.12.4",
	},
	{
		id: "detached-process-groups", title: "omp eval kernels and DAP adapters started as detached process groups",
		rows: [24], class: "REAP", ownerKey: "process-group", scope: "child-process", survivesRespawn: false,
		writers: ["external: omp src/eval/kernel-base.ts, src/dap/client.ts"],
		cancel: "omp kills each group at session teardown",
		crash: "[INFERENCE] a seat that dies without teardown leaves its groups running",
		respawn: "the groups belong to the dead process, not the successor",
		terminal: { outcome: "reaped", producer: "none observed" },
		census: null, noCensus: "no recorded identity: groups cannot be attributed to a seat from the process table", ownerBead: null,
	},
	{
		id: "omp-temp-names", title: "omp internal temp names with process.pid (settings, gc, update, skill descriptions, blob broker)",
		rows: [25], class: "REAP", ownerKey: "pid", scope: "external-tool", survivesRespawn: false,
		writers: ["external: omp settings.ts, gc-cli.ts, update-cli.ts, skill-descriptions.ts, blob-broker"],
		cancel: "omp renames or removes each temp file in the same call",
		crash: "a leftover temp file is reaped with the system temp dir",
		respawn: "the pid is only part of a unique name",
		terminal: { outcome: "reaped", producer: "omp (temp-name hygiene)" },
		census: null, noCensus: "a name, not an ownership record, in a tool outside this repository", ownerBead: null,
	},
	{
		id: "rch-baseline-atomic-tmp", title: "rch socket baseline atomic-write temp rch-socket-ino.json.<pid>.tmp",
		rows: [], class: "REAP", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: ["src/diagnostics.ts"],
		cancel: "the write renames the temp onto the baseline in the same call, or removes it on failure",
		crash: "a crash between write and rename leaves a <pid>.tmp orphan; the next successful write sweeps stale tmps first",
		respawn: "the pid names only a unique temp file, never the owner",
		terminal: { outcome: "reaped", producer: "writeRchSocketBaseline stale-tmp sweep" },
		census: null, noCensus: "transient temp name: gone after rename except for crash orphans the sweep reaps", ownerBead: "ompkit-774u.12",
	},
	{
		id: "report-atomic-tmp", title: "report inject atomic-write temp <report>.<pid>.<rand>.tmp",
		rows: [], class: "REAP", ownerKey: "pid", scope: "cli-run", survivesRespawn: false,
		writers: ["src/report-inject-job.ts"],
		cancel: "atomicReplace renames the temp onto the report in the same call, or unlinks it on failure",
		crash: "a crash between write and rename leaves a <pid>.<rand>.tmp orphan; the next run sweeps stale tmps first",
		respawn: "the pid names only a unique temp file, never the owner",
		terminal: { outcome: "reaped", producer: "atomicReplace stale-tmp sweep" },
		census: null, noCensus: "transient temp name: gone after rename except for crash orphans the sweep reaps", ownerBead: "ompkit-774u.12",
	},
	{
		id: "composer-state", title: "Seat composer state ~/.local/state/omp-kit/composer/<sha1(session file)>.json (writer pid, empty, idle) and its <record>.<pid>.tmp",
		rows: [], class: "REHOME", ownerKey: "agent+session", scope: "seat", survivesRespawn: true,
		writers: ["extensions/kit-composer-state.ts"],
		cancel: "the extension clears its timer and removes its record at session_shutdown",
		crash: "a crashed seat leaves its record; respawn_seat.composer_record uses a record only when it is fresh (COMPOSER_RECORD_MAX_AGE_S) and its writer pid is alive, else falls back to the fail-closed screen check",
		respawn: "keyed by the seat's session file, so the successor that resumes the session rewrites the same record with its own pid at session start",
		terminal: { outcome: "self-heals", producer: "extensions/kit-composer-state.ts rewrite at session start and turn boundaries, removal at shutdown" },
		census: null, noCensus: "one small record per live seat session, rewritten in place every 5 s; nothing accumulates to count", ownerBead: "ompkit-hznvg",
	},
];

/** Entries that account for an inventory row, for the coverage test and the doctor's row lookup. */
export function entriesForRow(row: number): OwnershipEntry[] {
	return OWNERSHIP_REGISTRY.filter(entry => entry.rows.includes(row));
}
