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

## Scope of what exists today

The owner keys, the hold rule and `scratch release --bin/--ref` are in. The reap gap report, the flag at the disposal points (the holder's close or `in_review`, and session end) and the measurement row are the remaining parts of ompkit-774u.15.
