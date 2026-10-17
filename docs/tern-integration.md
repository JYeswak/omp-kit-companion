---
status: draft
---
# Tern integration: command, SDK, and proof boundaries

## What is built

Adapted from supplied `omp-kit-tern` bundle SHA-256
`5330617e644953da3c973984b342c9e553f9392a7dd88bf6e88b870b5ce90929`,
originally based on kit `033598f89e9b12c5449965ecf74e5e9baf024747`.
Reviewed SDK: `stencil-hq/tern-sdk@f3f9fee82bf692166c2a477a895a347ac2a47ca2`,
Git blob `0dcdd18378712fde1ae40322d18b7c022939950a` for `plugins/tern.d.luau`.
Installed Tern 0.9.0 declarations match that blob and the 255 mapped entries:
241 callable members plus 14 callback slots. This is declaration mapping,
**not 255 independently executed native semantics**.

The canonical surface has ten verbs under the existing omp-kit registry.
No standalone dispatcher, replacement package/tsconfig, duplicate TERNREF indexer,
generated binding tree, dependency, daemon or automatic plugin activation is added.
Root CLI wiring, compiled/release packaging and full repository acceptance remain
integration-owner obligations; examples describe the wired command contract,
not evidence those gates have passed at the revision you are reading.

## Why this is not 241 independent shell commands

The SDK contains calls with different execution contexts. A callback registration
is Luau code, not a JSON request. A layout snapshot is an opaque native object;
a SQLite connection is VM-owned. Serializing either and reconstructing it in the
next CLI process would change the contract. `api` keeps related steps in one Carly
Lua call; plugin-only methods and callbacks use generated native Luau modules or
caller-authored source. No function body is fabricated to make coverage look complete.

| Command | Behavior |
|---|---|
| `tern catalog` | Every mapped callable/callback, context, source, known discrepancy and native route |
| `tern doctor` | Native executable version and optional explicit control endpoint availability |
| `tern ctl` | One exact native control/scenario line over the documented local protocol |
| `tern script` | Sequential native script lines, with complete JSON replies rather than the native file display's truncated excerpt |
| `tern native` | Native Tern argument vector: plugin lifecycle, browser, shot, serve, ctl, help and explicit --control |
| `tern api` | One JSON-safe SDK call, or a same-VM multi-step program with opaque references |
| `tern sdk` | Context-specific forwarding module, native call/callback emission, or installed-declaration check |
| `tern coverage` | Independent declaration extraction, exact source fingerprint, and docs-census consumption |
| `tern surface` | Offline TSP encode/decode/blob diagnostics; nine wire verbs and twelve frame shapes |
| `tern render` | Delegation to an explicitly selected, separately installed official TypeScript SDK: plain/print/ask |

Use `omp-kit help tern` or `omp-kit tern catalog --help`, not `tern help`.
The descriptor drives help, capabilities and completion; bare `omp-kit tern`
defaults to the catalog. `--json` and `--robot` are kit-global presentation flags;
`--apply`, `--yes` and `--plan` are declared on effect-capable verbs.
`--endpoint` is explicit, not discovered from an ambient fleet target.

## Canonical integration and qualification

Run through the normal entry point after root registry/handler integration:

```sh
bun src/cli.ts tern catalog --json
bun src/cli.ts tern doctor --json
bun src/cli.ts tern coverage --json
```

Without Tern, doctor returns exit 3 / UNAVAILABLE. Without independent source,
coverage returns exit 3 / NOT_RUN. Neither manufactures a certificate.

The integration owner runs normal `bun test tests/cli` discovery, including
`tests/cli/tern-docs-census.test.ts`, and the manifest, fleet-guard, ladder, shell,
README and workflow gates required by AGENTS.md. Python 3 is required for the
independent crawler and its Bun-discovered subprocess regressions.

Release archives include the crawler and its adjacent
`scripts/tern-script-routes.json` inventory, native `plugins/omp-kit-tern/` assets,
and both supplied MIT notices. The core source notice at `src/tern/LICENSE`
installs as `licenses/tern-sdk/LICENSE`; the plugin notice stays at
`plugins/omp-kit-tern/LICENSE`. The compiled binary embeds the catalog; the
crawler remains a separately shipped Python helper.
Generate optional Luau modules on demand through `tern sdk --operation module`.
Do not ship stale duplicate bindings or the bundle's standalone harnesses.
Test the compiled command and installed archive, including the renderer's explicit
external official SDK import. Native effects are not generically undoable:
Git commits, killed sessions, SQL writes, screen actions and external processes
are not reversed by `omp-kit undo`.

### Bounded native observation

The integration owner's isolated Tern 0.9.0 fixture exercised doctor,
`cx.session.focused`/`pane`, and opaque layout snapshot capture(false) followed by
restore in the same VM. Through the official owned headless fixture loader
(`STENCIL_FIXTURE_ROOT` with plugin fixtures), it observed both palette commands,
the host block, inventory-command creation of a plugin pane, host rendering/settle,
and the Carly inventory export in a fresh context (zero agents, two panes).
These are bounded examples, not universal per-row or fleet certification.

Ordinary ephemeral plugin link/list readiness did **not** load the runtime.
Desktop/daemon install/reload, doctor's asynchronous callback, lens behavior,
event delivery and every native option combination remain **NOT_RUN**.
No shared plugin/configuration/service/fleet activation is authorized by this example.

## Native control and CLI

No default ambient socket is used. Supply an absolute Unix socket path or a numeric
loopback TCP port. The endpoint belongs to the Tern window you intend to control.
Tern is a trusted local service; this adapter adds no authentication or sandbox.

```sh
# These print plans. They perform no transport operation.
omp-kit tern ctl --endpoint /private/tern.sock --line 'state' --plan --json
omp-kit tern ctl --endpoint /private/tern.sock --line 'dump .sf-main' --plan --json

# Submit only after reviewing the target and native command.
omp-kit tern ctl --endpoint /private/tern.sock --line 'state' --apply --yes --json
omp-kit tern script --endpoint /private/tern.sock --file /absolute/read.scenario --apply --yes --json

omp-kit tern native --argv '["plugin","list"]' --plan --json
omp-kit tern native --argv '["plugin","list"]' --apply --yes --json
omp-kit tern native --argv '["plugin","types","/absolute/fresh/types"]' --apply --yes --json
omp-kit tern native --argv '["plugin","link","/absolute/checkout/plugins/omp-kit-tern"]' --plan --json
```

All eight documented native plugin verbs have routes: list, reload, dir, install,
remove, link, unlink, types. Subsequent argument validation belongs to native Tern.
Unknown plugin verbs refuse until audited. `shot`, `serve`, `ctl`, `browser`,
`help dev`, and `--control` retain their native argument vectors. Native processes
have a finite local deadline. The adapter is not a daemon supervisor: do not use a
short-lived `native serve` invocation as a promise of indefinite service ownership.

`ctl` preserves exact syntax. Control commands such as `dump` and `tree` take raw
selectors; they are not automatically shell-quoted or rewritten as scenario tokens.
Scenario strings use Tern's four documented escapes. The script runner skips blank
lines and whole-line comments but leaves native inline parsing to Tern.

**Acknowledgement is not effect verification.** `run` need not wait for command
completion; closes may open confirmation sheets; account/update/kickoff states can
be simulated. Successful plugin catalog operations can report reload failures on
stderr. A host Ready row does not certify a window entry. Raw native error replies
stop a batch; already executed earlier lines are not rolled back.

## Window/agent APIs

Canonical names are in [tern-verb-map.md](tern-verb-map.md) and [tern-coverage.tsv](tern-coverage.tsv). Native colon
methods keep their `self`; all native arguments and return values retain their
positions. Arguments are JSON, converted to escaped Luau literals rather than
concatenated as executable source.

```sh
omp-kit tern api --endpoint /private/tern.sock \
  --member cx.agents.list --args '[]' --apply --yes --json

omp-kit tern api --endpoint /private/tern.sock \
  --member cx.agents.transcript --args '[123,{"last":10}]' --plan --json

omp-kit tern api --endpoint /private/tern.sock \
  --file /absolute/agent-round.json --plan --json
```

Use a real pane ID observed from Tern, not `123` and not a tmux `%123`. Do not
arithmetically convert between Tern and tmux pane identifiers. A native OMP agent
can use Tern's structured start/ask/wait/interrupt/stop/transcript API instead of
pretending terminal text delivery equals acceptance of work.

A mutating multi-step example, for a disposable test checkout:

```json
{
  "context":"carly",
  "steps":[
    {"id":"started","member":"cx.agents.start","args":[{
      "prompt":"Read the supplied repository and report its test command; do not edit files.",
      "cwd":"/absolute/disposable/repo","command":"omp","how":"tab"
    }]},
    {"id":"finished","member":"cx.agents.wait","args":[
      {"$ref":"started"},{"timeout":30000}
    ]}
  ]
}
```

`wait` observes native idle/failure semantics; it does not independently verify the
agent's answer. A batch is sequential, not transactional. Earlier steps may have
executed if a later step fails. API execution uses `carly lua`, checks `carly ok`,
then reads the complete state answer. A random 128-bit result marker detects a
replaced last_tool result. This detects correlation loss; it does not make several
control lines an atomic multi-client transaction.

Positional JSON null represents an omitted Lua argument. Nested JSON null remains
`tern.json.null`; empty arrays stay tagged. `$ref` retains results inside this one
program, with optional `return` and `path` selectors. `$literal` escapes data that
would otherwise look like a reference. LayoutSnapshot, Agent and Database handles
are not exported as durable JSON IDs. Unknown members, wrong contexts and JSON
callback attempts refuse before sending anything.

Browser error envelopes, process status/timeouts and fetch transport errors are
handled explicitly. HTTP 404 is still a native HTTP response; false from a settings
getter is still a valid value. There is no indiscriminate "false means failure" rule.

## Host/window plugins and callbacks

```sh
omp-kit tern sdk --operation module --context host --json
omp-kit tern sdk --operation module --context window \
  --out /absolute/new/window-bindings.luau --apply --yes --json

omp-kit tern sdk --operation emit --context host-block \
  --member BlockDef.view --file /absolute/actual-view-function.luau
```

Generate modules on demand from canonical `src/tern/luau.ts` and `model.ts` for
host, window, Carly, host-effect, host-block and host-lens. The plugin does not
import generated bindings. BlockCx extends EffectCx; host-lens callbacks such as
open/event also receive EffectCx, so `effect.*` supports host-lens emission.
This does not allow window/Carly-only methods in host callbacks.

The supplied native plugin has a real host inventory block, an exact-pattern result
lens, two palette commands and a narrow Carly inventory export. It does not turn
on fleet-wide scheduling, register all possible events automatically, print secrets,
or replace AGENTS.md safety policy. Its asynchronous doctor command uses the fresh
callback context, not an expired window context. Only the isolated observations
above are native-qualified; the async doctor and result lens remain NOT_RUN.

Callback slots are mapped, not fabricated. A caller provides the native function
for BlockDef's seven, LensDef's five and CommandDef's two callbacks. The 18 context-
qualified event entries route through native `tern.on`. They include an SDK-declared
`agent_finished` event absent from the reviewed events reference. Host spawn hooks
and window overrides retain native deadline/failure behavior; they are not an OS
security boundary.

Plugin secret functions remain window-plugin-only. They cannot be called through
a Carly JSON program; generated native code is the proper context. Do not capture
secret values in test output or transcripts. Native plugin installation means
trusting code with filesystem, process and network capabilities.

## Surface Protocol

```sh
omp-kit tern surface --operation encode --file /absolute/frame.json --json
omp-kit tern surface --operation blob --file /absolute/image.png --mime image/png --json
omp-kit tern surface --operation decode --file /absolute/wire.capture --json

omp-kit tern render --sdk /absolute/native-tern-sdk/dist/index.js \
  --operation plain --file /absolute/surface-card.json --apply --yes --json
```

The offline codec covers all nine transport verb labels and all twelve documented
frame operation shapes, chunking, blob hashes, incremental decode, OSC 877 replies,
and bracketed-paste shielding. It is a diagnostic codec, not a replacement for the
native SDK's full handshake, credit controller, view diffing, event handlers and
terminal cleanup. Native document validation still checks vocabulary, actual IDs,
surrogate boundaries, negotiated features and limits.

Use the separately installed official TypeScript SDK for those session mechanics.
The renderer imports only the explicitly selected trusted module and delegates
fromJson/print/ask/plain; it does not install a package. Print/ask own a terminal and
are refused in JSON/robot mode to prevent interleaved protocol bytes and envelopes.
Native fallback is preserved: a helper returning successfully does not prove Tern
drew anything. Arbitrary interactive applications should import the official SDK
in their own TypeScript program; this wrapper does not claim one CLI command for
every export of all four language libraries.

Native frame application is draw-atomic, not a database transaction: a bad operation
can be rejected alone while others apply. The adapter must not report rollback of
previous operations on a frame or batch failure.

## Coverage confirmation and drift

Read [tern-verb-map.md](tern-verb-map.md) for every row and native script family.

- Installed 255-entry declaration mapping matches the reviewed Git blob: 241
  callable members plus 14 callback slots, not native semantic completion.
- Callable entries have native code-generation routes. Historical bundle forwarding
  stubs are not current-repository qualification or actual-native proof.
- Callback slots require caller-authored source. Eighteen context-qualified lifecycle
  events are cataloged; live delivery remains NOT_RUN.
- All 20 reviewed script families delegate exact grammar to native Tern.
  Navigation is not an exhaustive parser or semantic test of every leaf.
- Eight plugin verbs, nine TSP verb labels, twelve frame operation shapes and three
  official TypeScript render helpers have routes, not blanket native certification.
- Per-option conformance, compiled release acceptance and fleet activation remain
  separate gates; no bundle test-count claim qualifies this repository.

Run the **independent source checks** on a machine with the exact source available:

```sh
# Run Tern's native command into a new directory, then verify the emitted file.
tern plugin types /absolute/new-types-dir
omp-kit tern coverage --types /absolute/new-types-dir/tern.d.luau --json

# Fetch documentation with a standard-library-only crawler. First use exits 3,
# UNREVIEWED: inspect the source rows and hashes before accepting a lock.
python3 scripts/tern-docs-census.py --out /absolute/new-census.json
omp-kit tern coverage --docs-report /absolute/new-census.json --json
# After manual review, pass the lock explicitly to both independent consumers:
python3 scripts/tern-docs-census.py --lock /absolute/reviewed-lock.json --out /absolute/next-census.json
omp-kit tern coverage --docs-report /absolute/next-census.json \
  --docs-baseline /absolute/reviewed-lock.json --json
```

The declaration parser independently discovers extern methods, callable record
fields and globals. It compares them with the map; new, removed, unmapped or unknown
owners fail. The complete Git blob fingerprint must also match the reviewed source,
so a signature-only change fails even if all names are unchanged. Do not overwrite
the source pin or regenerate a golden to conceal a changed API. Review the change,
update bindings/tests and only then deliberately update the accepted pin.

The docs crawler follows newly linked script pages and preserves each Markdown
table first-cell, heading, line and SHA-256. Review the rows against source and
native routes. Both crawler `--lock` and kit `--docs-baseline` accept an explicit
JSON object with a `pages` map: keys are canonical `scripts/*.html` paths, values
are complete 64-character lowercase SHA-256 hashes of the Markdown bytes.
Include the index and every required family; inspect sources before manually
authoring the lock. Subsequent crawls fail changed/missing/new pages.
There is no automatic approval or lock-update flag. The kit compares the explicit
baseline independently; the embedded report `lock_status` is not trusted.
Without a baseline its source lock remains UNREVIEWED even if rows are inventoried.
Equality establishes source stability, not human approval or native semantics.
The manual navigation includes subactions/selectors, not independently verified
executable commands. The separate TERNREF indexer remains canonical for search.

The source discrepancies are explicit: secret functions and `agent_finished` in
the pinned SDK are absent from reviewed reference pages; ExportCall reply limits
differ between the reviewed page (16 KiB) and declaration (1 MiB). Neither limit
is arbitrarily treated as the verified installed-runtime value.

## Security, authority and failure semantics

Native Tern calls may change programs, files, sessions, SQL data, remote hosts,
Git state, settings and screens. `--apply --yes` is required for outbound commands,
including Carly reads because they change the conversation's tool state. `--robot`
is presentation, not authorization. Generated output files use exclusive creation.

This adapter is **not** proof of Agent Mail ownership, bead custody, caller identity,
current fleet generation, or a policy-preserving replacement for `omp-kit land`.
Do not route untrusted agents through arbitrary SDK calls as a way around the
existing single-main, reservation and destructive-operation policies. A controlled
fleet deployment must apply its authoritative admission before invoking native
mutations; generic plan/yes flags do not provide fencing or a sandbox.

Each approved outbound attempt writes a private hash-only subjournal in
`$XDG_STATE_HOME/omp-kit/tern-runs` (default `~/.local/state/omp-kit/tern-runs`). It
contains no raw arguments, code, answers or credentials. These are attempt records,
not invented receipts accepted by `omp-kit undo`. No exactly-once, power-loss
transactionality, remote-child cancellation or generic rollback is claimed.

After a timeout/disconnection/oversized reply **following dispatch**, or a native
client terminated by a signal or without a reported exit status, the state is
OUTCOME_UNKNOWN (exit 4). Inspect native state before retrying. Killing a local
client does not prove an already-submitted native operation or descendant stopped.
Explicit native reject/failure uses exit 1, usage/context/consent uses 2, unavailable uses 3.
Native values may contain private data: the result stream is not a public log.

## Acceptance before deployment

Run the included offline tests and the existing kit gates, then use a disposable
real Tern window. Verify a native state read, a correlated API answer, a real
host block and window command, a harmless change plus readback, wrong-context
refusal, client disconnection after submission, native error envelopes and a
compiled-release invocation. Retain runtime version, SDK byte hash, kit revision,
OS, target identity and exact producer result. Expand native per-verb scenarios
with real prerequisites and reversals; do not run every destructive verb merely
to fill a table. Live acceptance remains open until that evidence exists.

## Sources

- https://docs.stencil.so/tern/index.html#the-sdk
- https://docs.stencil.so/tern/reference/api.html
- https://docs.stencil.so/tern/reference/api-shared.html
- https://docs.stencil.so/tern/reference/api-host.html
- https://docs.stencil.so/tern/reference/api-window.html
- https://docs.stencil.so/tern/reference/events.html
- https://docs.stencil.so/tern/reference/cli.html
- https://docs.stencil.so/tern/scripts/index.html and the 20 pages in scripts/tern-script-routes.json
- https://docs.stencil.so/tern/protocol/transport.html
- https://docs.stencil.so/tern/protocol/documents.html
- https://docs.stencil.so/tern/protocol/sdks.html
- https://github.com/stencil-hq/tern-sdk/blob/f3f9fee82bf692166c2a477a895a347ac2a47ca2/plugins/tern.d.luau
- https://github.com/JYeswak/omp-kit-companion/blob/033598f89e9b12c5449965ecf74e5e9baf024747/src/commands.ts
- https://github.com/JYeswak/omp-kit-companion/blob/033598f89e9b12c5449965ecf74e5e9baf024747/src/cli.ts
