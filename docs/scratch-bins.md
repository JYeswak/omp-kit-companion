# Scratch bins

Every scratch directory has an owner and, when its work ends, a destination. The destination is a *bin*. The kit stops treating the reaper as the way scratch gets cleaned up: the owner disposes of its own directory, and a reap is an emergency whose report names what failed to bin it.

## The four bins

| Bin | Where the content goes | Reference needed |
|---|---|---|
| `throwaway` | Deleted. Nothing in it is worth keeping. | none |
| `evidence` | Committed under the owner's repository (for example `docs/evidence/`) or written on a bead, then the directory goes. | `file:PATH` tracked by git in the owner's repo, or `bead:ID` that `br show` finds |
| `promote` | Committed to the repository that owns it: anything that is run again or instructs an agent. | same as `evidence` |
| `hold` | Kept, for a named bead, until an expiry no later than 14 days after the directory was made. | `bead=` and `expires=` in the owner record |

There is no `archive` bin: an off-machine copy is an open-ended hold under another name. Durability comes from the push.

## Declaring the bin when the directory is made

`.owner` accepts four optional keys, `bin`, `purpose`, `bead` and `expires`. A record without `bin` is *unbinned*: it still parses and is counted, never refused.

```
pid=84331
label=probe
repo=/Users/me/Developer/project
created=2026-10-18T17:32:44Z
bin=hold
purpose=cc7b-probe
bead=ompkit-fp72.120.16.11.1
expires=2026-10-25
```

- `purpose` is one token, at most 40 characters.
- `bead` is a bead id.
- `expires` is a date or a UTC date-time (`2026-10-25`, `2026-10-25T10:00:00Z`) and is allowed only on a hold.
- A hold needs both `bead` and `expires`, and `expires` must fall after `created` and no later than 14 days after it. A record that breaks any of this is malformed, which the reaper treats as unowned.

A hold outlives its dead owner until it expires, and shows as `LIVE held-by-bead` in `omp-kit scratch plan`. Once it expires it shows as `SKIP hold-expired-unbinned`, is flagged, and is never reaped: only a renewal on the bead can extend it.

## Disposing of a directory

```
omp-kit scratch release DIR --bin throwaway --now
omp-kit scratch release DIR --bin evidence --ref file:docs/evidence/receipts/run.outputs.txt --now
omp-kit scratch release DIR --bin promote  --ref file:scripts/probe.ts --now
omp-kit scratch release DIR --bin evidence --ref bead:ompkit-774u.15 --now
```

The release is the owner's act. The caller must hold one of these:

- the seat that holds the recorded session (agent and omp session id);
- the capability that `scratch new` returned for the directory;
- the owner process itself, or a child of it.

The release marker records the bin and the reference next to the owner text, device and inode it already pins.

An evidence or promote reference must prove the content arrived, not merely name a place (TRANSFER1). The directory's content has one token, `scratch-sha256:<digest>`. The digest covers every file below the directory (path and bytes) except the owner record and the release marker. The reference is accepted when:

- `bead:ID`: a comment on the bead contains the token, for example a comment that summarizes the results and cites it;
- `file:PATH`: the file is tracked in the owner's repo, has no staged or unstaged changes, matches the content on the upstream branch (it is pushed), and either contains the token or is a byte-identical copy of one of the directory's files.

An existing bead or an unrelated tracked file proves nothing. A refused release names the token, so the producer cites it and releases again. Refusals name the reason without moving anything: `ref-required`, `ref-invalid`, `ref-outside-repo`, `ref-missing`, `ref-not-tracked`, `ref-uncommitted`, `ref-unpushed`, `ref-transfer-unproven`, `ref-bead-unverified`, `ref-git-unverified`, `ref-content-unreadable`, `throwaway-takes-no-ref`, `ref-without-bin`, `hold-is-declared-at-creation`, `bin-needs-structured-owner` (a free-form legacy owner cannot be binned) and `now-needs-bin`.

`--now` retires the directory in the same turn, which is how a finished task disposes of its scratch (SCRATCHRETIRE1): a throwaway at once, evidence and promote only after their reference has been verified. It rechecks what the reaper's final delete checks: the same device and inode, the unchanged owner text, the owner inside the scratch root, and no open file. When any recheck fails, the directory and its marker stay, the command exits `SCRATCH_RELEASE_HELD` with the reason (`now-held-open-fds`, `now-held-lsof-unavailable`, `now-held-owner-changed`, ...), and the directory remains yours to retire: clear the cause and run the same release with `--now` again. The reaper is only a backstop. Without `--now` the release only marks the directory.

A release without `--bin` still works and is counted as unbinned; it cannot take `--now`.

### The release capability

`omp-kit scratch new --label X --json` returns `data.capability`. This is a random 256-bit token (64 hex characters). The kit returns it once, in that result (text mode prints the same fields), and never writes the token to disk. `.owner` keeps only its sha256, as `capability_sha256`.

Pass the token to a release from any later process:

```
omp-kit scratch release DIR --bin throwaway --now --capability TOKEN
OMP_KIT_SCRATCH_CAPABILITY=TOKEN omp-kit scratch release DIR --bin throwaway --now
```

- The flag wins over the environment variable.
- The token authorizes the release whatever the caller's seat or pid. This covers a dir made by a short-lived `scratch new` subprocess from an eval kernel or tool shell with no `AGENT_NAME`, whose recorded pid is gone by release time.
- The comparison is constant-time over the digests.
- A wrong or missing token, with no seat match, is refused with `SCRATCH_RELEASE_REFUSED: caller-not-owner`. The detail says whether no token was presented or the token did not match, and the remediation names `--capability`.
- A dir whose record has no `capability_sha256` (made before the capability existed) is released exactly as before.

## A reap is a gap report

`omp-kit scratch apply` (and the scheduled scratch-reaper) is the emergency path. Every dir it reaps or quarantines that its owner did not bin becomes one row, returned as `gapReport` and written to the reap log as a `gap` event:

| Field | Meaning |
|---|---|
| `agent`, `session`, `label` | Who made the dir and what it was called (the name before quarantine). |
| `role` | `chief` when the agent is the chief seat in the fleet-watch seat map; otherwise `UNKNOWN`. Never guessed from the name. |
| `bin` | The bin the owner record named, or `unbinned`. |
| `class` | `never-released` (a seat owner died without releasing), `pid-keyed-owner-never-released` (no agent or session in the owner record), `released-unbinned` (released without `--bin`), `unowned`, `mismatched-owner`. |
| `guard` | The bead whose guard should stop that class, or `NO GUARD: file one` when none exists. |

A dir the owner released into a bin is not a gap. The report also counts gaps per agent and per class, so the next reap names what to fix first. `omp-kit scratch apply --apply --yes --json` prints it as `data.gapReport`.

## What a session still owes

`omp-kit scratch mine` lists the caller's own scratch dirs: those whose owner record names the caller's agent and a session it holds, or whose pid is the caller's exact pid. A live process_start-matching owner is in-use and never owed; pid 1 and ancestor/sibling owners are nobody's. Each row has a state (`unreleased`, `released`, `held`, `hold-expired`) and its bin. `overall` is `FINDINGS` while any dir is owed, otherwise `OK`; the exit code is 0 either way. A dir is owed when it is `unreleased` or its hold has `hold-expired`, except the session's own dir (label `omp`, `bin=throwaway`), which its session releases at the end. Dirs of other owners and unowned dirs never appear. It reads the caller's session leases once per listing, so it runs in seconds over thousands of owner files.

`omp-kit scratch mine --at review|close|session-end` also appends one `flag` row to the reap log (`~/.local/state/omp-kit/scratch-reap-log.jsonl`) when something is owed: the disposal point and each owed dir with its state and bin. Without `--at` it is a pure read.

## The flag at in_review and close

When a session runs `br update ID --status in_review` or `br close ID`, the kit-flywheel-guard extension runs `omp-kit scratch mine --at review` (or `--at close`) and, if dirs are owed, adds a `SCRATCH_OWED` note to that command's context naming up to five of them and the release command. It is advice only: nothing is blocked, and a missing omp-kit, a failed or timed-out run, or an unparseable answer yields no note. It becomes a refusal only after the reap log shows a week of flags with no dir the caller did not own.

## The save refusal at session end

`kit-save-guard` reads `omp-kit scratch mine --json` at `session_stop` and blocks the end while the session holds an undisposed dir, naming up to five labels and the release command; binning a dir restarts the retry budget with the new demand. A missing or failing `omp-kit`, a timeout, or an unparseable answer never blocks: only a positive owed reading demands disposal. Over-budget alone does not block.

## Filing the gaps to their beads

`omp-kit scratch apply` prints `gapFileCommands`: the exact `br comments add` lines that file each guarded gap class to its owning bead. With `--file-gaps` (and `--db PATH`, else `br` auto-discovers or uses `BEADS_DB`) it runs them: one comment per bead listing the dirs no earlier run filed (cut at 15 with a count), then a `gap_filed` row in the reap log so the next run files only the delta. A failed `br` call is reported in `data.gapFiled` and retried next run; classes with no guard are never auto-filed. Without `--file-gaps` nothing is filed.

## The byte budget

Creation declares a byte budget (`budget=<bytes>` in `.owner`, via `createScratch`): absent means unbounded, and zero, negative or non-integer budgets are refused before anything is created. `scratch mine` reports each own dir's live bytes, budget and `overBudget`, with a count; the reap gap report marks reclaimed dirs past their budget. Over-budget is a flag, never a reap reason: the dir is still binned, held or reaped only by the ordinary rules.

## The session's own dir

Every omp session in a fleet repo makes `var/agent-tmp/omp.<pid>` and its `.owner` names `bin=throwaway`. When the session that recorded that dir (the agent and omp session id of its first tool call) ends, the fleet-guard extension releases the dir into the throwaway bin; the reaper then deletes it. A subagent's end, or a seat that never recorded an agent and session, releases nothing. A respawn is not an end. The respawn-intent marker is built and owned by `respawn_seat.py` (~/.claude 4bf70a30, the only contract): before the old omp is signalled it writes `respawn-intent.<oldpid>.json` next to handoffs.jsonl (`${XDG_STATE_HOME:-~/.local/state}/omp-kit-orchestration/`), atomically (temp plus rename), shaped `{"pid", "start" (ps lstart of the old pid), "agent", "session", "block", "at" (UTC ISO), "ttl_s": 900, "kind": "respawn"}`; it is removed in a finally once rehome_scratch is done and on every failed or aborted apply path, and dry runs write nothing. The extension skips disposal only when pid and start both match the exiting process and the marker is younger than `ttl_s`. No marker, a stale marker, or a start mismatch (a reused pid) means dispose.

## Scope of what exists today

The owner keys (with byte budget and the release capability's `capability_sha256`), the hold rule, `scratch release --bin/--ref/--capability`, the reap gap report (printed by `scratch apply`),
