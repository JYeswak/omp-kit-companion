# Source-bound Tern verb map

Reviewed 2026-10-16. SDK commit: `f3f9fee82bf692166c2a477a895a347ac2a47ca2`. Kit base: `033598f89e9b12c5449965ecf74e5e9baf024747`.

**Status:** routing reference adapted from bundle SHA-256 `5330617e644953da3c973984b342c9e553f9392a7dd88bf6e88b870b5ce90929`. Installed Tern 0.9.0 declaration blob `0dcdd18378712fde1ae40322d18b7c022939950a` matches 255 mappings (241 callable + 14 callbacks), not 255 native semantic proofs.

The proof column preserves **historical supplied-bundle reports only**.
Stub forwarding/emission claims are not current-checkout acceptance. `native NOT_RUN`
means no complete per-member/per-option qualification, conservatively including
members used by the bounded fixture in [tern-integration.md](tern-integration.md#bounded-native-observation).
Async doctor, lens, events, desktop/daemon lifecycle and fleet activation remain NOT_RUN.
Canonical verbs: `omp-kit tern catalog|doctor|ctl|script|native|api|sdk|coverage|surface|render`.
Kit-global `--json`/`--robot` do not authorize effects; help is `omp-kit help tern`.
Generate modules on demand with `tern sdk --operation module`, not a duplicate
binding tree. See [tern-coverage.tsv](tern-coverage.tsv) for machine-readable routes.

Contexts include inherited EffectCx availability: BlockCx extends EffectCx;
host-lens open/event callbacks receive EffectCx. Shared host globals are available
in host-block/host-lens/host-effect, not just the base host context.

## Luau callable members and callback slots

| Symbol | Native scope | Route | Historical supplied-bundle report (not current acceptance) |
|---|---|---|---|
| `tern.log.debug` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.log.info` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.log.warn` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.log.error` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.json.encode` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.json.decode` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.json.array` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.base64.encode` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.base64.decode` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.now` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.getenv` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.timer` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.sleep` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.kv.get` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.kv.set` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.secrets.get` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.secrets.set` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.read` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.write` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.list` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.exists` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.mkdir` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fs.remove` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.process.run` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.fetch` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.span` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.link` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.path` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.text` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.col` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.lines` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.row` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.card` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.section` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.rule` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.badge` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.kv` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.table` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.meter_cell` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.meter_parts_cell` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.tree` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.list` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.code` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.diff` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.md` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.meter` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.progress` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.bars` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.spark` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.ansi` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.diagnostic` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.test_summary` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.overflow` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.node` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.ui.el` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.parse.columns` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.parse.packed` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.parse.json_tree` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.parse.location` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.parse.size` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.block.define` | host | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.lens.define` | host | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.pane.write` | host | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.pane.list` | host | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.on` | host,window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.command` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.bind` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.override` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.route.open` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.route.link` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.chrome.tab_title` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.chrome.window_title` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.chrome.status` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.chrome.refresh` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.css` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.export` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.context` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.schedule` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.tasks` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.cancel` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `tern.carly.on_canvas` | carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.current` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.create` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.switch` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.rename` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.close` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.lock` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.sessions.unlock` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.current` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.add` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.switch` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.trust` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.disconnect` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.hosts.terminal` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.get` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.start` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.ask` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.wait` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.transcript` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.interrupt` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.agents.stop` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.find` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.children` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.signal` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.procs.profile` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.actions.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.actions.run` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.actions.keys` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.actions.describe` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.repo` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.status` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.log` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.diff` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.stage` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.unstage` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.commit` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.branches` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.checkout` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.create_branch` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.stash_push` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.stash_pop` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.git.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.get` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.set` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.set_many` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.describe` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.themes` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.keybinds` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.bind` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.settings.unbind` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.db.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.db.tables` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.db.schema` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.db.query` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.db.exec` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.boards` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.read` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.add` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.move` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.check` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.edit` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.remove` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.add_lane` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.rename_lane` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.board.remove_lane` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.browser.call` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.screen.displays` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.screen.share` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.screen.stop` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.screen.status` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.read` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.outline` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.write` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.edit` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.append` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.save` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.new_note` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.docs.search` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.canvas.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.canvas.set` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.canvas.get` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.canvas.list` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.whiteboard.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.whiteboard.read` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.whiteboard.edit` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.sessions` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.layout` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.find_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.find_session` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.tab_of` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.pane` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.read` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.surface` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.view` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.event` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.panes` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.tabs` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.focused` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.resolve` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.block_types` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.session.settle` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.new_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.split` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.focus` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.close` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.move` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.resize` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.move_to_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.move_to_new_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.float` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.dock` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.park` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.unpark` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.even` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.name_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.color_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.order_tab` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.rename_session` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.snapshot` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.restore` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.layout.arrange` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.cells` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.run` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.add` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.edit` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.kernel_status` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.notebook.kernel_restart` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.run` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.open` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.new_block` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.command` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.action` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.ask_carly` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `cx.pick` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.prompt` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.toast` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `cx.copy` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `effect.toast` | host-effect,host-block,host-lens | sdk module / sdk emit, in native plugin context | historical forwarding stubs; native NOT_RUN |
| `effect.open` | host-effect,host-block,host-lens | sdk module / sdk emit, in native plugin context | historical forwarding stubs; native NOT_RUN |
| `effect.copy` | host-effect,host-block,host-lens | sdk module / sdk emit, in native plugin context | historical forwarding stubs; native NOT_RUN |
| `block.render` | host-block | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `block.save` | host-block | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `block.exit` | host-block | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `block.frame` | host-block | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `block.blob` | host-block | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `handle.TimerHandle.cancel` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `handle.Awaitable.next` | host,window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `handle.ExportCall.reply` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `handle.ExportCall.fail` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `handle.ExportCall.wait` | window | sdk module / sdk emit, in native plugin context | executed forwarding with native stubs; native NOT_RUN |
| `handle.Agent.tocarly` | window,carly | api --member or same-VM program; sdk module | executed forwarding with native stubs; native NOT_RUN |
| `BlockDef.init` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.view` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.title` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.key` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.event` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.resize` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `BlockDef.save` | host-block | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `LensDef.open` | host-lens | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `LensDef.line` | host-lens | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `LensDef.finish` | host-lens | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `LensDef.view` | host-lens | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `LensDef.event` | host-lens | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `CommandDef.available` | window | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |
| `CommandDef.run` | window | sdk emit (caller supplies the callback) | emission tested; native NOT_RUN |

## Context-qualified lifecycle events

| Context/event | Native path |
|---|---|
| `host:spawn` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `host:command_started` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `host:command_finished` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `host:cwd` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `host:title` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `host:pane_exited` | `tern.on` in host VM; caller Luau; native NOT_RUN |
| `window:window_start` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:focus` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:pane_created` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:pane_closed` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:tab_created` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:tab_closed` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:command_started` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:command_finished` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:cwd` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:title` | `tern.on` in window VM; caller Luau; native NOT_RUN |
| `window:agent_finished` | `tern.on` in window VM; SDK/reference discrepancy; native NOT_RUN |
| `window:canvas_action` | `tern.on` in window VM; caller Luau; native NOT_RUN |

## Script families

All native one-line grammar passes through unchanged; exact flags, selectors, modes and error semantics are owned by Tern. This table establishes routing, not a semantic test of every leaf. The independent docs crawler includes table rows and newly linked pages; review them against this route map.

| Source page | Native roots | Adapter |
|---|---|---|
| [scripts/harness.html](https://docs.stencil.so/tern/scripts/harness.html) | `size`, `wait`, `freeze-anims`, `thaw`, `motion-at`, `shot`, `move`, `down`, `up`, `click`, `dblclick`, `hover`, `wheel`, `key`, `keydown`, `keyup`, `type`, `preedit`, `commit`, `window-focus`, `pinch`, `rotate`, `smart-magnify`, `swipe`, `force-click`, `touch`, `drop`, `drag-end`, `appearance`, `reduce-motion`, `reduce-transparency`, `increase-contrast`, `differentiate-without-color`, `target`, `menu`, `menu-close`, `a11y`, `dialog`, `haptic-reply`, `notification-click`, `global-shortcut`, `open-files`, `open-url`, `second-instance`, `power`, `share-finish`, `webview`, `spelling` | `tern ctl` / `tern script` |
| [scripts/control.html](https://docs.stencil.so/tern/scripts/control.html) | `dump`, `tree`, `pick`, `state`, `stats`, `layers`, `a11y`, `menus`, `system`, `css`, `perf`, `trace`, `resize`, `thaw`, `quit`, `webcall`, `webreports` | `tern ctl` / `tern script` |
| [scripts/terminal.html](https://docs.stencil.so/tern/scripts/terminal.html) | `ready`, `git-read`, `link-read`, `run`, `expect`, `completing`, `split`, `close`, `zoom`, `equalize`, `focus`, `resize`, `tab`, `rename`, `palette`, `find`, `context`, `layout`, `font`, `font-family`, `font-weight`, `adjust-cell-height`, `ui-font`, `code-font`, `decorations`, `theme`, `themes`, `scroll`, `copy`, `alert`, `inbox`, `peek`, `melt`, `feed`, `surface-play`, `plugins` | `tern ctl` / `tern script` |
| [scripts/navigation.html](https://docs.stencil.so/tern/scripts/navigation.html) | `tabs`, `filter`, `status-bar`, `pane-headers`, `style`, `interface-style`, `picker`, `goto`, `insert-path`, `running`, `drag-pane`, `move-pane`, `tidy`, `previous-tab`, `cross-session-click` | `tern ctl` / `tern script` |
| [scripts/sessions.html](https://docs.stencil.so/tern/scripts/sessions.html) | `session`, `sessions`, `confirm-close`, `block`, `agent-command`, `new-blocks` | `tern ctl` / `tern script` |
| [scripts/remote.html](https://docs.stencil.so/tern/scripts/remote.html) | `remote` | `tern ctl` / `tern script` |
| [scripts/prefs.html](https://docs.stencil.so/tern/scripts/prefs.html) | `prefs` | `tern ctl` / `tern script` |
| [scripts/browser.html](https://docs.stencil.so/tern/scripts/browser.html) | `browser`, `webview` | `tern ctl` / `tern script` |
| [scripts/pip.html](https://docs.stencil.so/tern/scripts/pip.html) | `pip` | `tern ctl` / `tern script` |
| [scripts/files.html](https://docs.stencil.so/tern/scripts/files.html) | `files` | `tern ctl` / `tern script` |
| [scripts/file.html](https://docs.stencil.so/tern/scripts/file.html) | `file` | `tern ctl` / `tern script` |
| [scripts/procs.html](https://docs.stencil.so/tern/scripts/procs.html) | `procs` | `tern ctl` / `tern script` |
| [scripts/screen.html](https://docs.stencil.so/tern/scripts/screen.html) | `screen` | `tern ctl` / `tern script` |
| [scripts/git.html](https://docs.stencil.so/tern/scripts/git.html) | `git` | `tern ctl` / `tern script` |
| [scripts/sqlite.html](https://docs.stencil.so/tern/scripts/sqlite.html) | `sqlite` | `tern ctl` / `tern script` |
| [scripts/notebook.html](https://docs.stencil.so/tern/scripts/notebook.html) | `notebook` | `tern ctl` / `tern script` |
| [scripts/board.html](https://docs.stencil.so/tern/scripts/board.html) | `board` | `tern ctl` / `tern script` |
| [scripts/profile.html](https://docs.stencil.so/tern/scripts/profile.html) | `profile` | `tern ctl` / `tern script` |
| [scripts/status.html](https://docs.stencil.so/tern/scripts/status.html) | `account`, `update`, `kickoff` | `tern ctl` / `tern script` |
| [scripts/carly.html](https://docs.stencil.so/tern/scripts/carly.html) | `carly` | `tern ctl` / `tern script` |

## Native subverb navigation index

Nested selector/action words are listed under their native family. They are not all standalone commands. Consult the cited page for mandatory arguments; this index is not a reconstruction of Tern's parser.

### remote

`loopback`, `state`, `identity`, `service`, `switch`, `disconnect`, `add`, `stage`, `peers`, `ssh-hosts`, `popover`, `hosts`, `setup`, `setup-step`, `setup-fail`, `setup-offer`, `rtt`, `hold`, `release`, `peer-join`, `peer-leave`

### prefs

`close`, `search`, `preview`, `known-hosts`

### browser

`open`, `address`

### webview

`title`, `url`, `loading`, `failed`, `history`, `focus`, `new-window`

### pip

`float`, `new`, `corner`, `focus`, `expand`, `resize`, `dock`, `fling`, `drag`, `release`, `stash`, `unstash`, `stash-all`, `fan`, `see`, `menu`

### files

`show`, `hide`, `toggle`, `focus`, `root`, `follow`, `width`, `expand`, `collapse`, `select`, `cursor`, `reveal`, `filter`, `fixture`, `model`, `touch`, `rm`, `storm`, `hold`, `release`, `poll`, `watch`, `wait`

### file

`open`, `scratch`, `fixture`, `mode`, `goto`, `offset`, `select`, `zoom`, `find`, `peek`, `save`, `disk`, `delete-on-disk`, `autosave`, `menu`, `choose`, `wait`, `loaded`, `saved`

### file choose

`compare`, `keep-mine`, `use-disk`, `recreate`, `close`, `discard`, `reveal`, `open-outside`, `retry`, `save-as`, `view-hex`, `view-text`, `save`, `revert`, `wrap`, `copy-path`, `copy-relative-path`, `create-folders`, `copy-markdown`

### procs

`open`, `sort`, `tree`, `filter`, `select`, `menu`, `quit`

### screen

`open`, `display`, `fit`, `actual`, `control`, `click`, `key`, `type`, `wait`

### git

`open`, `fixture`, `media`, `wait`, `loading`, `select`, `search`, `diff`, `find`, `pick`, `context`, `set`, `whitespace`, `tab`, `refs`, `ai`, `dialog`, `menu`, `peek`

### git dialog

`branch`, `rename`, `tag`, `message`, `remote`, `remote-url`, `init`, `clone`, `patch`, `stash`, `confirm`, `discard`, `ai-stage`

### sqlite

`fixture`, `open`, `new`, `memory`, `area`, `sheet`, `log`, `write`, `revert`, `undo`, `exec`, `close`

### sqlite structure

`open`, `fold`, `select`, `pick`, `menu`, `browse`, `modify`, `delete`, `copy-create`, `copy-name`, `copy-drop`, `refresh`, `counts`, `unfold-all`, `fold-all`, `menu-key`, `drop-sql`

### sqlite browse

`table`, `select`, `rows`, `edit`, `commit`, `set`, `key`, `copy`, `paste`, `find`, `replace`, `menu`, `tab`, `goto`, `jump`, `filter`, `global`, `sort`, `hide`, `show-all`, `rowid`, `freeze`, `width`, `format`, `format-dialog`, `condformat`, `condformats`, `condformats-add`, `condformats-save`, `fmt`, `select-col`, `findcol`, `findcol-next`, `findcol-prev`, `unlock`, `lock`, `encoding`, `saveview`, `header-menu`, `filter-menu`, `filter-help`

### sqlite browse key

`refresh`, `previous_table`, `next_table`, `new_tab`, `rename_tab`, `close_tab`, `new_record`, `insert_values`, `delete_records`, `duplicate_record`, `copy_above`, `set_null`, `clear_cells`, `delete`, `cut`, `copy_headers`, `copy_sql`, `select_all`, `edit_cell`, `find`, `replace`, `find_next`, `find_previous`, `replace_next`, `replace_all`, `adjust_rows`, `first_page`, `previous_page`, `next_page`, `last_page`, `goto_row`, `clear_filters`, `clear_sorting`, `focus_filter`, `global_filter`, `find_column`, `show_rowid`, `freeze_columns`, `hide_columns`, `show_all_columns`, `select_column`, `unlock_view`, `display_format`, `cond_formats`, `encoding_all`, `copy_column_name`, `format_toolbar`, `bold`, `italic`, `underline`, `align_left`, `align_center`, `align_right`, `align_justify`, `clear_format`, `save_as_view`, `export_csv`, `export_json`

### sqlite execute

`new`, `text`, `type`, `caret`, `select`, `run`, `line`, `stop`, `tab`, `close`, `rename`, `duplicate`, `move`, `complete`, `accept`, `pick`, `open`, `save`, `view`, `cell`, `copy`, `tiling`, `zoom`, `focus`, `chord`, `log-source`, `log-find`

### sqlite execute chord

`execute`, `execute_line`, `stop`, `new_tab`, `open_file`, `save_file`, `save_file_as`, `close_tab`, `rename_tab`, `duplicate_tab`, `next_tab`, `previous_tab`, `focus_editor`, `focus_results`, `complete`, `zoom_in`, `zoom_out`, `zoom_reset`, `copy_with_headers`, `copy_as_sql`, `export_csv`, `export_json`, `save_as_view`, `toggle_tiling`

### sqlite pragmas

`set`, `save`, `reset`, `refresh`

### sqlite cell

`load`, `mode`, `type`, `hex-goto`, `hex-type`, `apply`, `null`, `discard`, `import`, `import-ref`, `export`, `export-dump`, `external`, `external-apply`, `external-cancel`, `open-default`, `copy-hex`, `auto-switch`, `wrap`, `format`, `sort-keys`, `overwrite`

### sqlite plot

`x`, `y1`, `y2`, `color`, `line`, `point`, `legend`, `stacked`, `fixed`, `log-x`, `log-y`, `load-all`, `hover`, `pick`, `zoom`, `reset`, `save`, `copy`

### sqlite dialog

`create-table`, `edit-table`, `create-index`, `edit-index`, `add-record`, `import-csv`, `import-csv-text`, `import-sql`, `export-csv`, `export-json`, `export-query`, `export-sql`, `accept`, `cancel`

### sqlite table

`name`, `schema`, `without-rowid`, `strict`, `conflict`, `tab`, `add-field`, `remove-field`, `move-field`, `select`, `field`, `add-pk`, `add-unique`, `add-fk`, `add-check`, `key`, `fk`, `check`, `remove-key`, `remove-fk`, `remove-check`, `popover`, `columns`

### sqlite index

`name`, `table`, `unique`, `where`, `add`, `add-expr`, `remove`, `order`, `expr`, `up`, `down`

### sqlite record

`value`, `null`, `empty`, `default`, `restore`

### sqlite csv

`header`, `trim`, `separate`, `no-types`, `local`, `fail-missing`, `ignore-defaults`, `sanitize`, `advanced`, `separator`, `quote`, `encoding`, `conflict`, `table`, `file`, `all`, `match-similar`, `answer`

### sqlite export

`select`, `all`, `none`, `header`, `separator`, `quote`, `newline`, `pretty`, `what`, `column-names`, `multi-row`, `keep-original`, `keep-schema`

### sqlite tools

`compact`, `integrity`, `quick-check`, `fk-check`, `optimize`, `row-counts`, `save-project`, `save-all`, `close-project`, `detach-menu`, `save-project-as-dialog`, `save-database-as-dialog`, `pick`, `alias`, `ok`, `cancel`, `load-extension`, `attach`, `detach`, `open-project`, `save-project-as`, `save-database-as`, `drop`

### notebook

`fixture`, `new`, `open`, `select`, `edit`, `command`, `type`, `insert`, `kind`, `delete`, `undo`, `redo`, `move`, `merge`, `split`, `collapse`, `clear`, `save`, `run`, `interrupt`, `restart`, `wait`, `find`, `find-next`, `find-previous`, `replace`, `find-close`, `find-option`, `sheet`, `complete`, `accept`, `inspect`, `help`

### board

`fixture`, `new`, `open`, `write`, `wait`, `view`, `hide-done`, `select`, `lane`, `filter`, `fold`, `menu`, `type`, `commit`, `drag`, `key`

### board key

`up`, `down`, `left`, `right`, `first`, `last`, `move_up`, `move_down`, `move_left`, `move_right`, `toggle`, `edit`, `new_below`, `new_above`, `delete`, `undo`, `redo`, `details`, `filter`, `switch_view`, `hide_done`, `clear`, `new_lane`, `rename_lane`, `move_lane_left`, `move_lane_right`, `delete_lane`, `done_lane`, `open_markdown`

### profile

`fixture`, `open`, `record`, `stop`, `zoom`, `select`, `hover`, `pick`, `find`, `invert`, `idle`, `thread`, `sort`

### account

`signed-out`, `waiting`, `waitlisted`, `failed`, `signed-in`

### update

`idle`, `checking`, `downloading`, `ready`, `installed`, `failed`, `unsupported`

### kickoff

`packing`, `starting`, `installing`, `connecting`, `uploading`, `setting-up`, `off`

### carly

`open`, `close`, `new`, `paste`, `ask`, `queue`, `stream`, `reply`, `fail`, `step`, `command`, `tool`, `lua`, `context`, `last`, `ok`, `voice`, `heard`, `said`, `task`

### carly task

`add`, `fire`, `run`, `fail`, `event`

### carly tool

`inspect`, `configure`, `actions`, `processes`, `session`, `arrange`, `read_block`, `send_input`, `run_command`, `lua`

### webcall

`eval`, `capture`, `pdf`, `input`, `edit`, `cookies`, `setCookie`, `deleteCookie`, `scripts`, `agent`, `media`, `appearance`, `dialogs`, `dialog`, `files`, `downloads`, `allow`

### a11y

`click`, `focus`, `blur`, `scroll-into-view`, `scroll-up`, `scroll-down`, `scroll-left`, `scroll-right`, `show-context-menu`, `expand`, `collapse`, `increment`, `decrement`, `set-scroll-offset`, `set-text-selection`, `set-value`, `replace-selected-text`

### session

`new`, `switch`, `rename`, `close`, `lock`

## Further distinct surfaces

Native plugin lifecycle: `list`, `reload`, `dir`, `install`, `remove`, `link`, `unlink`, `types`.

TSP wire verbs: `q`, `o`, `f`, `b`, `t`, `s`, `x`, `r`, `e`. Frame operations: `add`, `set`, `text`, `splice`, `move`, `del`, `settle`, `focus`, `reveal`, `scroll`, `suspend`, `resume`.

Official TypeScript helper routes: `tern render --operation plain|print|ask`
with an explicit trusted `--sdk` entry. The offline codec does not replace official
handshake, credit control, event dispatch or terminal cleanup.

Whiteboard edit operation values (via `cx.whiteboard.edit`): `add`, `move`, `resize`, `rotate`, `text`, `style`, `delete`, `lock`, `unlock`, `group`, `ungroup`, `duplicate`, `order`, `align`, `distribute`, `layout`, `flip`, `look`, `paper`, `show`.

Dynamic palette action IDs and preferences are enumerated by `cx.actions.list/describe/keys` and `cx.settings.list/describe`; do not freeze a fabricated complete list. Full node vocabulary and style properties stay with native `tern.ui.node`, `tern.ui.el`, and the official TypeScript SDK. No claim is made that every Rust, Python, Go and TypeScript library export has a distinct CLI wrapper.

## Known source differences

- **tern.secrets.get/set** — SDK_DECLARED_REFERENCE_NOT_FOUND: Present in pinned declarations; not found in reviewed shared API page. Window plugin only, not Carly. Do not serialize secret values into evidence.
- **window:agent_finished** — SDK_DECLARED_REFERENCE_NOT_FOUND: Present in pinned event declaration commentary, absent in reviewed events reference.
- **ExportCall.reply** — DOC_SDK_CONFLICT: Reviewed window reference says 16 KiB; pinned declaration says 1 MiB and truncates oversized strings. Adapter does not certify either runtime bound.
