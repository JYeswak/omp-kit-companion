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
omp-kit scratch release DIR --bin throwaway
omp-kit scratch release DIR --bin evidence --ref file:docs/evidence/receipts/run.outputs.txt
omp-kit scratch release DIR --bin promote  --ref file:scripts/probe.ts
omp-kit scratch release DIR --bin evidence --ref bead:ompkit-774u.15
```

The release is the owner's act: the caller must be the owner (its process, a child of it, or the seat that holds the recorded session). The release marker records the bin and the reference next to the owner text, device and inode it already pins. Refusals name the reason without moving anything: `ref-required`, `ref-invalid`, `ref-outside-repo`, `ref-missing`, `ref-not-tracked`, `ref-bead-unverified`, `throwaway-takes-no-ref`, `ref-without-bin`, `hold-is-declared-at-creation` and `bin-needs-structured-owner` (a free-form legacy owner cannot be binned).

A release without `--bin` still works and is counted as unbinned.

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

`omp-kit scratch mine` lists the caller's own scratch dirs, read-only: those whose owner record names the caller's agent and a session it holds, or whose pid is the caller's or an ancestor's. Each row has a state (`unreleased`, `released`, `held`, `hold-expired`) and its bin. `overall` is `FINDINGS` while any dir is `unreleased` or its hold has `hold-expired`, otherwise `OK`; the exit code is 0 either way. Dirs of other owners and unowned dirs never appear.

## Scope of what exists today

The owner keys, the hold rule, `scratch release --bin/--ref`, the reap gap report (printed by `scratch apply`) and `scratch mine` are in. The daily measurement is a sitrep row (`scratch_waste`) in the private tracker. Still to come in ompkit-774u.15: the flag at the disposal points (the holder's close or `in_review`, and session end), which starts as a warning and becomes a refusal only after a week with no false flag.
