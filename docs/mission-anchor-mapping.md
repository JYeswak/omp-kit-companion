# Mission anchor mapping (ANCHOR1, ompkit-fp72.9)

One anchor, two faces. The live-doc Mission statement (a `Mission` heading plus an
approval line in the project doc) is the human source of truth for wording;
`.omp/mission.toml` is the machine record (Mission Protocol v0.1). They agree by
construction: `omp-kit mission anchor` embeds `mission validate` and reports `AGREE`
only when the record is `VALID` **and** the live doc carries the Mission statement,
its approval, and the recorded identity wording. Any disagreement is `DRIFT` with a
named reason. The anchor never launches checks, never writes approvals, and never
creates `.flywheel` content.

## The single command

`omp-kit mission anchor [--project PATH]... [--json]` — one repo per `--project`
flag (repeat per repo); a fleet sweep passes each repo:

```sh
omp-kit mission anchor --project ~/Developer/omp-kit --project ~/Developer/omp-kit-companion --json
```

Exit `0` on `AGREE`, `1` on `DRIFT`. `mission validate` covers the record half; the
anchor covers both halves, so the HEALTH prelude and `mission validate` agree on every
repo where the anchor agrees — disagreement surfaces as `DRIFT`, never as a silent pass.

## Live-doc resolution (documented mapping, option C)

1. The `Human text:` declaration in `.omp/mission.toml` names the anchor doc.
   If it resolves inside the project root, it is the doc.
2. Otherwise the first existing discovery candidate wins, in order:
   `ROADMAP.md`, `MISSION.md`, `docs/ROADMAP.md`,
   `.flywheel/MISSION.md`, `README.md`. A discovery fallback is reported with its
   path; it is diagnostic evidence, never a second anchor.
3. Numbered Mission headings (`## 0. Mission`) are recognized; deeper (`####`) or
   plural (`Missions`) headings are not.
4. The doc fails the anchor when it is missing (`ANCHOR_DOC_MISSING`), unreadable,
   still the generic init template (`ANCHOR_DOC_INIT_TEMPLATE`: lorem ipsum,
   `[replace…`, `<project-name>`, `your mission here`, unfilled `TODO:`/`FIXME:`),
   lacks a `Mission` heading (`ANCHOR_DOC_NO_MISSION_HEADING`), or lacks an approval
   line (`ANCHOR_DOC_APPROVAL_MISSING`).

## Flywheel doctor boundary

The foundry `bin/flywheel doctor_repo` checks `.flywheel/GOAL.md`/`STATE.md` presence
only and never checks `MISSION.md` or content; it is owned by foundry's director
(`fk-0rbcl`) and is out of scope here. Per canonical `S/omp-kit-orchestration`, the
native mission anchor supersedes the flywheel doctor: no worker revives the doctor or
creates `.flywheel` to make a check pass. Fleet HEALTH preludes shell
`omp-kit mission anchor`; the obsolete `.flywheel`-specific doctrine retires through
`fp72.47` (SKILLDRIFT1), not through this bead.

## Fleet adoption (criterion c)

Every fleet repo passes the single anchor through its own director: each director
authors (or pins via the `Human text:` declaration) a live doc carrying the Mission
heading, the recorded identity wording, and the owner approval, and keeps
`.omp/mission.toml` registered. A worker from another repo never edits a sibling
repo's anchor to manufacture green.
