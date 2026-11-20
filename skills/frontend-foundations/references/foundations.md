<!-- Imported from zeststream-hq/design-system/foundations.md sha256:43e6ddba1b11679dcf1cc7f9128c2b8285d9a3d291e5b929ef79a0d1e84260.
Portable edition: ZestStream-private items stripped (machine paths, seat names,
client names, private repo/tool names). Owner verbatim quotes live only in the
client overlay (e.g. overlays/zeststream.json), never here. -->
# Front-end foundations

Every front end we ship must decide these 30 things.
Each foundation is one row: what it decides, the questions it must answer,
the default (used unless a project overrides it in writing — a client overlay
may override in writing), how a
program verifies it, the best-in-class reference, and the architecture layer
it lives in (L0 tokens, L1 primitives, L2
components/motion/data-viz, L3 patterns, doctrine, gates).

Stack rule (non-negotiable): one named static host plus one named compute/API
host, fewest dependencies.
Never invent data. Light, calm, one accent
(light canvas, one living visual, huge type, picture before number).

## Foundation checklist

| # | Foundation | One question it answers | Default | Verifier |
|---|---|---|---|---|
| F0 | Purpose and audience | Who is this for and what must they get in 10 seconds? | One screen, one verdict sentence, 10-second contract | Calibrated critic + owner accept |
| F1 | Data truth | Where does every number come from, and how old is it? | Named source + "as of" stamp on every number; no invented data | Rendered checker (every number has source + stamp) |
| F2 | Information architecture | Where am I, and how do I get back? | ≤5 sections; sidebar/nav, hash-anchored URLs, back-safe drill-in | Playwright nav test |
| F3 | Layout and grid | Where does everything sit at every width? | 12-col desktop / 4-col phone; 8-pt spacing; fold holds verdict + visual only | Rendered screenshot review 1440×900 + 390×844 |
| F4 | Typography | What do we read, and in what order? | Geometric sans (Inter/Geist-class); sentence 40–64 px; tabular numerals; ≤70ch lines | Quality-gate font + type checks |
| F5 | Colour and theming | What does colour mean? | Light canvas; 1 accent (base `#2B4FFF`); red/amber fire only on bad data; AA contrast | Contrast checker + token lint |
| F6 | Imagery and iconography | Picture or words? | Picture first, number second; one living visual per first view; SVG icons, no emoji-as-UI | Rendered checker + critic |
| F7 | Data visualization | Which picture for which data? | SVG-first, no chart lib; every number carries comparison + normal band; arcs/bars/maps over tables | Chart-honesty checklist in rendered review |
| F8 | Components and states | What does every part look like in every state? | 13 states specified per component; skeleton → content; stale and empty never blank | Playwright state-matrix test |
| F9 | Interaction model and drill-in | What happens when I point, tap, or type — and what does a click open? | Hover/tooltip, click opens a rich panel (side sheet or full section, animated, Esc closes, deep-linkable), full keyboard, ⌘K palette; 44 px targets; <100 ms feedback; undo + confirm on consequential | Playwright interaction test |
| F10 | Motion | What moves, and why? | Tokens 120/200/320/480 ms, ease-out standard; motion only for change/live/causality; reduced-motion = static | Quality-gate motion check + reduced-motion snapshot |
| F11 | Real-time and freshness | How live is this — what is live, how fast, over what transport, and what shows when it is not live? | Declared live set + per-type latency budget + transport + connection indicator + not-live state; cadence-relative stale ladder (fresh ≤1.3x, aging ≤3x, stale beyond + banner) | Rendered checker (stamps + stale labels + connection indicator) |
| F12 | Alerts and notifications | What wakes the user up? | 4 severities (P1 page → P4 digest); badge/banner/toast/push ladder; quiet hours 22:00–07:00 | Severity-ladder review (critic) |
| F13 | Actions and workflows | What can the user do here, and who approves? | Named actors + permissions; person presses Send; every action logged with actor + time | Audit-log check |
| F14 | Accessibility | Can everyone use it? | WCAG 2.2 AA; Radix behavior; focus-visible; 200% text; 44 px targets | axe-core + keyboard walkthrough |
| F15 | Devices | What does it look like on every screen? | Desktop 1440, laptop 1280, tablet 768, phone 390, wall/TV, print stylesheet | Playwright widths + print snapshot (wall/TV: UNVERIFIED) |
| F16 | Performance | How fast does it feel? | LCP <2.5 s, INP <200 ms, CLS <0.1; no chart lib, no canvas hero by default | Lighthouse budget (CI blocks) |
| F17 | Formatting and locale | How do numbers, dates, units read? | en-US default; UTC stamps + local in tooltip; relative time <24 h; ICU plurals | Rendered checker (format spot-check) |
| F18 | Voice and copy | How does it sound? | Verdict-first, short sentences; banned-word + claims gate; empty/error copy specified | Voice scorer (CI) |
| F19 | Trust, privacy, security | Is data separated and secret-free? | Auth + roles; client data separated per tenant; CSP; no secrets in page/bundle | Token/secret lint + CSP check |
| F20 | Personalization | What can the user keep their way? | Saved views + filters + pinned items; device-local by default; never silently | Settings round-trip test |
| F21 | Share, export, print | How does this leave the screen? | Copy-link with full state; CSV export; print stylesheet; screenshot-safe | Playwright share/export test |
| F22 | Event log, history, telemetry and learning | What happened, what changed since you last looked, and how do we learn from use? | Append-only event log per surface (schema + replay + live/1h/24h/7d windows + timeline); usage events; "this is wrong" button; experiments behind flags | UNVERIFIED: needs event pipeline |
| F23 | Quality gates | What stops bad work shipping? | Rendered review → critic ≥7.0 (no criterion <6.0) → owner accept; `--strict` blocks deploy | Frontend quality gate (self-enforcing) |
| F24 | Brand and client overlays | How does a client make it theirs? | One overlay file (hues, logo, type accent); structure/semantics/abnormal colours shared; never fork | Overlay diff check (base untouched) |
| F25 | Documentation and handoff | Can the next person run it? | README + decisions + data-source map per surface; ADRs for overrides | Docs-presence check in gate |
| F26 | Lifecycle and operations | How does it ship and who wakes up? | Named static host + functions via CLI; versioned; rollback = prior deploy; errors to host logs | Deploy + rollback drill |
| F27 | Storage and retention | Where does the data live, how big is it, how long do we keep it? | Named store + format + measured bytes/day + retention tiers + rollups + backup + per-tenant separation | Storage audit (store map + size/retention check) |
| F28 | Section identity and depth | Can I tell sections apart, and does each carry depth without a wall of text? | Kicker pill + icon + accent + alternating layout per section; one interactive explainer per section | Rendered section-identity review (critic) |
| F29 | Drill-in experience | What does a click open, where, how, and how deep does it go? | Rich panel (side sheet or full section) with motion-token animation, six-part scan layout, live example, prev/next, hash URL, Esc, focus restore, reduced-motion static | Playwright drill-in test (open/close/hash/keyboard) |

---

## F0 — Purpose and audience
- **Decides:** who the surface serves and the job it does.
- **Questions:** Who opens this? What are their 10-second questions? What decision does it drive? What is the one success metric?
- **Default:** one screen answers "are we OK?" in a single verdict sentence; ≤5 questions per surface; success = the glance test (answer from across the room in <3 s).
- **Verifies:** calibrated critic (10-second contract criterion) + owner accept.
- **Reference:** https://radar.cloudflare.com/ (one question per view); NN/g on task focus: https://www.nngroup.com/articles/task-analysis/
- **Layer:** L3 + doctrine.

## F1 — Content and data truth
- **Decides:** what is true, how fresh, and what "good" looks like.
- **Questions:** Source of every number? Freshness per number? Units? Time zone? Target/comparison band? What shows when data is missing — never a guess?
- **Default:** every number carries source + "as of" UTC stamp; every number carries its comparison and normal band (Few/Tufte rule); missing data shows "no data" with cause, never a zero or a plausible guess; a named system of record is the truth for client ops.
- **Verifies:** rendered checker — parse the DOM for numbers lacking source/stamp/band.
- **Reference:** Stephen Few, https://www.perceptualedge.com/ ; Tufte, https://www.edwardtufte.com/tufte/
- **Layer:** doctrine (real-data-dashboard content) + gate.

## F2 — Information architecture and navigation
- **Decides:** the page map and how state lives in the URL.
- **Questions:** Pages/sections list? Nav model (sidebar, tabs, command)? Which state is URL-addressable (filters, scope, window)? Back/forward safe? Search or ⌘K?
- **Default:** ≤5 sections; sidebar nav with hash anchors (`#overview`); scope + window in the URL; drill-in opens a drawer, back closes it; ⌘K palette on dashboards/portals.
- **Verifies:** Playwright nav test — every section reachable by URL, back button returns.
- **Reference:** GOV.UK Design System, information architecture: https://design-system.service.gov.uk/ ; Shopify Polaris navigation: https://polaris.shopify.com/components/navigation
- **Layer:** L3.

## F3 — Layout and grid
- **Decides:** placement at every width.
- **Questions:** Breakpoints? Grid columns? Spacing scale? Density (comfortable/compact)? What sits above the fold? Safe areas on phones?
- **Default:** breakpoints 390 / 768 / 1024 / 1440; 12-col desktop grid, 4-col phone; 8-pt spacing scale from L0; above the fold = verdict sentence + one living visual + quiet nav only; nothing else; phone respects safe-area insets.
- **Verifies:** rendered screenshot review at 1440×900 and 390×844.
- **Reference:** Material 3 layout: https://m3.material.io/foundations/layout/applying-layout ; Apple HIG layout: https://developer.apple.com/design/human-interface-guidelines/layout
- **Layer:** L0 (spacing tokens) + L3.

## F4 — Typography
- **Decides:** the reading order, set in type.
- **Questions:** Families? Scale? Weights? When tabular vs proportional numerals? Line length? Minimum size?
- **Default:** one geometric sans (Inter/Geist-class) everywhere, never monospace for prose; scale 12 / 14 / 16 / 20 / 28 / 40–64 (verdict sentence only); tabular numerals for all data; body ≤70ch; minimum 12 px UI, 14 px body.
- **Verifies:** quality-gate font + type checks (font loading, no unlisted families, tabular-nums on data).
- **Reference:** Material 3 type scale: https://m3.material.io/styles/typography/type-scale-tokens ; Vercel Geist: https://vercel.com/geist/introduction
- **Layer:** L0.

## F5 — Colour and theming
- **Decides:** what colour means, and what a client may change.
- **Questions:** Token roles? Semantic roles (good/warn/bad/info/neutral)? Contrast ratios? Colour-blind safety? Dark mode? What may a client overlay change?
- **Default:** light canvas (`#FAFAFA`-class), near-black ink, hairline borders; one saturated accent (base `#2B4FFF`, tint `#EDF0FF`); semantics: good green, warn amber `#B25E09`, bad red `#D92D20`, info = accent; colour never the only signal (label + shape too); text ≥4.5:1, large ≥3:1 (AA); no dark mode by default — a dark instrument is a separate committed direction (Gate 0); clients override hues/logo/type-accent only, abnormal colours stay shared.
- **Verifies:** contrast checker + token lint (no raw hex outside tokens).
- **Reference:** WCAG 2.2 contrast: https://www.w3.org/TR/WCAG22/#contrast-minimum ; IBM Carbon color: https://carbondesignsystem.com/elements/color/overview/ ; ISA-101 gray-calm / color-only-for-abnormal
- **Layer:** L0 + gate.

## F6 — Iconography, imagery, illustration and 3D
- **Decides:** when a picture replaces words, and what pictures are allowed.
- **Questions:** Icon set? Pictogram rules? When illustration vs photo vs 3D? Who owns the hero visual? Alt text policy?
- **Default:** picture first, number second; one living visual owns the first view (map, drawn line — SVG, pointer-parallax, static at rest); icons = one SVG set, 1.5 px stroke, labelled; 3D/WebGL only with a written reason and never the default (fails the render checker by policy); every meaningful image has alt text.
- **Verifies:** rendered checker (no `canvas` hero without exemption) + critic visual criterion.
- **Reference:** Cloudflare Radar: https://radar.cloudflare.com/
- **Layer:** L2 + doctrine.

## F7 — Data visualization
- **Decides:** the chart grammar — which picture for which data.
- **Questions:** Chart per data type (trend, share, status, map, table)? Target/band rules? Label and tooltip policy? Number formatting? How is uncertainty shown?
- **Default:** SVG-first hand components, no chart library by default (libraries need a written reason); trend = drawn line with target band, share = horizontal bars/pictograms, status = filled-pictogram counts, geo = choropleth; ≤2-point trends get chips not charts; tooltips show value + comparison + stamp; uncertainty = explicit band or "calm/volatile" caption, never false precision.
- **Verifies:** chart-honesty checklist in rendered review (comparison + band present, no bare values).
- **Reference:** Few, https://www.perceptualedge.com/ ; Tufte, https://www.edwardtufte.com/tufte/ ; Material 3 data viz: https://m3.material.io/styles/data-visualization/
- **Layer:** L2 + doctrine.

## F8 — Components and states
- **Decides:** the inventory and every state each component can be in.
- **Questions:** Component list? For each: default, hover, focus-visible, pressed, selected, disabled, loading/skeleton, empty, error, stale, partial, offline, just-updated?
- **Default:** built from L1 primitives (Radix behavior + token styling, copy-in); every async component ships a skeleton, an empty state ("no X yet — <cause>"), an error state (retry), and a stale state (dim + "as of"); just-updated pulses once (F10); nothing is ever blank.
- **Verifies:** Playwright state-matrix test — render each component in all 13 states, screenshot.
- **Reference:** Radix primitives: https://www.radix-ui.com/primitives ; Shopify Polaris components + states: https://polaris.shopify.com/components ; Atlassian ADS: https://atlassian.design/components
- **Layer:** L1 + L2.

## F9 — Interaction model and drill-in
- **Decides:** what every input does on every control, and what a click opens for a primary item.
- **Questions:** Hover/click/double-click/right-click/long-press/drag behaviors? Tab order? Shortcuts + palette? Touch gestures? Scroll behavior? Target sizes? Feedback latency? Undo? Confirmation for consequential actions? What does a click open, where does it open (side sheet, full section, drawer), how does it animate in and out, how does it close (Esc, backdrop, back button), how is it addressed (deep-linkable URL), and how much depth does it carry?
- **Default:** hover = tooltip/preview; click on a primary item = a rich panel (side sheet or full section, never an in-place expand of the same card — an in-place expand of the same card is not enough for a primary item), animated with the page's own motion tokens, Esc/backdrop/back closes it, focus trapped while open and restored on close, URL hash addresses the open item, prev/next moves between items; right-click/long-press = context menu where lists exist; full keyboard (tab order = visual order, Esc closes, ⌘K palette); targets ≥44 px; feedback <100 ms (NN/g limit), real work may take longer but acknowledges instantly; undo for edits, explicit confirm for send/publish/delete; touch = tap + swipe, no hover-dependent meaning.
- **Verifies:** Playwright interaction test (keyboard-only pass + hover/click matrix).
- **Reference:** Apple HIG interactions: https://developer.apple.com/design/human-interface-guidelines/ ; NN/g response times: https://www.nngroup.com/articles/response-times-3-important-limits ; Radix keyboard behavior: https://www.radix-ui.com/primitives
- **Layer:** L1 + L2.

## F10 — Motion system
- **Decides:** the tokens and the meaning rules.
- **Questions:** Duration/easing tokens? Enter/exit/choreography? What may move? What never moves? Reduced-motion behavior? Frame budget?
- **Default:** durations 120 / 200 / 320 / 480 ms; easings: standard `cubic-bezier(0.2,0,0,1)` (enter), emphasized `cubic-bezier(0.05,0.7,0.1,1)` (hero/draw), exit 120 ms linear-fade; stagger ≤6 items × 40 ms; motion only for change, live data, or causality — never decoration; `prefers-reduced-motion` = fully static; 60 fps, compositor properties (transform/opacity) only, zero layout shift.
- **Verifies:** quality-gate motion check (durations from tokens, reduced-motion snapshot identical to rest state).
- **Reference:** Material 3 motion: https://m3.material.io/styles/motion/overview ; Apple HIG motion: https://developer.apple.com/design/human-interface-guidelines/motion
- **Layer:** L0 (tokens) + L2.

## F11 — Real-time and freshness
- **Decides:** how live the surface is and how change shows.
- **Questions:** Per data type: what is live and what is snapshot, the latency budget from change to pixel, the transport (push/SSE vs poll, and the poll interval), the connection-state indicator, and what the user sees when it is not live. Producer cadence per data block? Push vs poll? What animates on change? Where is the stale banner threshold? "As of" stamps? "What changed since last visit?"
- **Default:** every block declares its producer cadence C (the tick that writes it, e.g. data snapshot every 15 min). Freshness is cadence-relative: fresh while age ≤ 1.3×C (one tick plus jitter), aging while age ≤ 3×C (two missed ticks, labelled + dimmed), stale beyond (visible banner naming the block, its last good stamp, and who owns the producer). Every changed value pulses once; a delta line under the verdict says what changed ("2 items idle need a named cause"). Worked example, C = 15 min: fresh < 20 min, aging 20–45 min, stale banner past 45 min.
- **Verifies:** rendered checker — every block declares C with a stamp; aging blocks labelled, stale blocks carry the banner.
- **Reference:** GOV.UK real-time patterns: https://design-system.service.gov.uk/ ; NN/g on system status visibility (heuristic #1): https://www.nngroup.com/articles/ten-usability-heuristics/
- **Layer:** L2 + L3.

## F12 — Feedback, alerts and notifications
- **Decides:** the severity ladder and how each level reaches the user.
- **Questions:** Severity levels? Badge vs banner vs toast vs push vs page? Escalation path? Quiet hours? Dismissal policy?
- **Default:** P1 (wake someone: page/call) / P2 (banner + push, act today) / P3 (toast/badge, act this week) / P4 (digest); in-surface: banner for page-level, toast for action results (auto-dismiss 6 s, kept in a log), badge for counts; quiet hours 22:00–07:00 local except P1; every alert names cause + next action, never just a red number.
- **Verifies:** severity-ladder review by the critic (every red element maps to a severity + action).
- **Reference:** Atlassian notification patterns: https://atlassian.design/ ; Material 3 snackbars/banners: https://m3.material.io/components/snackbar/overview
- **Layer:** L2 + L3.

## F13 — Actions and workflows
- **Decides:** what the user can do, with what permission and what trail.
- **Questions:** Actions per surface? Roles/permissions? Approval steps? Confirmation? Audit trail (who did what when)?
- **Default:** every action names its actor and required role; a person presses Send (automation drafts, humans commit); consequential actions confirm + log actor, action, time, before/after; client ops truth lives in a named system of record.
- **Verifies:** audit-log check — trigger each action in staging, confirm the log row.
- **Reference:** GOV.UK service patterns (never automate a commitment without a person): https://design-system.service.gov.uk/patterns/ ; Shopify Polaris resource actions: https://polaris.shopify.com/components/actions
- **Layer:** L3.

## F14 — Accessibility
- **Decides:** the bar every surface clears before ship.
- **Questions:** WCAG level? Screen-reader names for custom visuals? Focus order? 200% text? Target size? Motion?
- **Default:** WCAG 2.2 AA, no exceptions; Radix supplies keyboard/focus/ARIA (never hand-rolled); charts get text equivalents (verdict sentence + table toggle); focus-visible always; 200% text without overlap; targets ≥44 px; reduced-motion static (F10).
- **Verifies:** axe-core (zero serious/critical) + manual keyboard walkthrough in the gate.
- **Reference:** WCAG 2.2: https://www.w3.org/TR/WCAG22/ ; Apple HIG accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility ; Radix: https://www.radix-ui.com/primitives
- **Layer:** L1 (behavior) + gate.

## F15 — Responsiveness and devices
- **Decides:** the device matrix.
- **Questions:** Desktop/laptop/tablet/phone layouts? Wall/TV? Print? Input modalities per device (mouse, touch, remote)?
- **Default:** 1440 desktop (full), 1280 laptop (full, tighter air), 768 tablet (2-col, drawer drill-in), 390 phone (stacked, verdict + visual + top action only); wall/TV = verdict + visual, 3 m glance, no interaction; print stylesheet = verdict + tables, ink-friendly.
- **Verifies:** Playwright widths (390/768/1280/1440) + print snapshot; `UNVERIFIED: needs wall/TV device pass`.
- **Reference:** Material 3 window size classes: https://m3.material.io/foundations/layout/applying-layout/window-size-classes ; Apple HIG (multitasking/adaptivity): https://developer.apple.com/design/human-interface-guidelines/layout
- **Layer:** L3.

## F16 — Performance
- **Decides:** the budgets that block deploys.
- **Questions:** LCP/INP/CLS budgets? Payload budget? Animation frame budget? Caching/offline?
- **Default:** LCP <2.5 s, INP <200 ms, CLS <0.1; JS <150 KB gz on marketing/static, <300 KB on dashboards; no chart lib / no WebGL hero by default (the budget's friend); static shells cache-first on the host, data revalidates per F11; offline = last snapshot with stale labels, never an error wall.
- **Verifies:** Lighthouse budget in CI (blocks on red).
- **Reference:** web.dev Core Web Vitals: https://web.dev/articles/vital-thresholds ; web.dev INP: https://web.dev/articles/inp
- **Layer:** gate.

## F17 — Formatting and internationalization
- **Decides:** how values read in every locale we serve.
- **Questions:** Number/date/units formats? Relative vs absolute time? Time zones? Plurals? Locales shipped?
- **Default:** en-US first; UTC stamps with local-time tooltip; relative time under 24 h ("22 h left"), absolute after; ICU plural rules (never hand-rolled "s"); units always labelled (`18.93% free`, `21 h`); tabular numerals (F4); locale set by explicit switch, never geo-guess.
- **Verifies:** rendered checker — format spot-check on dates, plurals, units.
- **Reference:** Material 3 + Shopify Polaris i18n guidance: https://polaris.shopify.com/ ; GOV.UK dates/times style: https://www.gov.uk/guidance/style-guide
- **Layer:** L1 + doctrine (voice).

## F18 — Voice and copy
- **Decides:** how the surface sounds.
- **Questions:** Tone? Label rules? Microcopy? Empty/error copy? Jargon rules? Claim rules?
- **Default:** calm, plain, verdict-first ("9 of 10 services working. Next release due in 21 h."); sentences where persuasion is needed, fragments where scanning wins; banned words + approved claims enforced; empty states name the cause, error states name the next step; no jargon without a first-use gloss.
- **Verifies:** voice score gate (banned words + approved claims, CI).
- **Reference:** GOV.UK voice/content: https://www.gov.uk/guidance/content-design ; Shopify Polaris voice: https://polaris.shopify.com/content/voice-and-tone
- **Layer:** doctrine (voice).

## F19 — Trust, privacy and security
- **Decides:** who sees what, and what never ships in the page.
- **Questions:** Auth? Roles? Client data separation? PII handling? CSP? Secrets policy? Third-party scripts?
- **Default:** auth on everything except public marketing; role-gated actions (F13); one tenant's data never renders in another's view (overlay changes brand, never data scope); PII masked by default, revealed per role; strict CSP, no inline scripts; zero secrets/tokens in markup or bundles; third-party scripts need a written reason + sandbox review.
- **Verifies:** secret/token lint on built output + CSP header check in the gate.
- **Reference:** OWASP secure headers/CSP: https://owasp.org/www-project-secure-headers/ ; Apple HIG privacy: https://developer.apple.com/design/human-interface-guidelines/privacy
- **Layer:** gate + L3.

## F20 — Personalization and settings
- **Decides:** what the user may keep their way.
- **Questions:** Saved views/filters? Density? Pinned items? Where stored? Sync or device-local? Reset path?
- **Default:** saved views + filters + pinned items on dashboards; density comfortable/compact; stored device-local by default, synced only when signed in; every default restorable in one tap ("Reset view"); settings never change data, only presentation.
- **Verifies:** settings round-trip test (set → reload → persists → reset).
- **Reference:** Shopify Polaris preferences: https://polaris.shopify.com/ ; Material 3 customization: https://m3.material.io/foundations/customization
- **Layer:** L3.

## F21 — Share, export and print
- **Decides:** how the surface leaves the screen.
- **Questions:** Shareable links (what state travels)? PDF? CSV? Screenshot/embed? What is excluded (PII, secrets)?
- **Default:** copy-link carries scope + window + filters (recipient sees the same verdict); CSV export for every table/chart; print stylesheet (F15); embeds/screenshots carry the "as of" stamp; PII masked in exports by default.
- **Verifies:** Playwright share/export test (link replays the view; CSV parses).
- **Reference:** GOV.UK data download patterns: https://design-system.service.gov.uk/ ; Vercel Observability share views: https://vercel.com/products/observability
- **Layer:** L2 + L3.

## F22 — Event log, history, telemetry and learning
- **Decides:** what counts as an event, how history reads, and how the surface teaches us.
- **Questions:** What counts as an event, the event schema (actor, action, time, before/after), replay, the time windows (live / 1 h / 24 h / 7 d), "what changed since you last looked", and the event timeline the user actually sees. Usage events? "This is wrong" feedback? Experiment flags? Retention/anonymization?
- **Default:** events per surface (viewed, drilled-in, acted, exported); a "this is wrong" affordance on every data block feeding the negative-evidence file; experiments behind flags with a named owner and stop date; no PII in events.
- **Verifies:** `UNVERIFIED: needs event pipeline (no collector in the static-host stack yet)`.
- **Reference:** Atlassian experimentation: https://atlassian.design/ ; GOV.UK analytics guidance: https://design-system.service.gov.uk/
- **Layer:** doctrine + gate (when built).

## F23 — Quality gates and verification
- **Decides:** what stops bad work from shipping.
- **Questions:** Rendered checks? Visual regression? Glance test? Critic bar? a11y audit? Perf budget? Real devices? Owner accept?
- **Default:** rendered screenshot review (never words-about-design) → critic ≥7.0 with no criterion <6.0 → owner accept/reject naming criteria; frontend quality gate `--strict` blocks deploys; the rejected-screen calibration set must always score below the bar.
- **Verifies:** self-enforcing — the gate script + critic calibration fixtures.
- **Reference:** calibrated critic rubric + rejected-screen calibration set (the proof loop: rendered pixels, scored, accepted).
- **Layer:** gate.

## F24 — Brand and client overlays
- **Decides:** how a client becomes themselves without forking.
- **Questions:** Overlay file? What may change vs never? Who approves the overlay? Contribution-back rule?
- **Default:** one overlay file per client (brand hues, logo, type accent); structure, spacing, semantics, abnormal colours stay shared; a client needing a new pattern contributes it back to L2/L3; forks rejected in review.
- **Verifies:** overlay diff check — base tokens/components byte-identical, only the overlay differs.
- **Reference:** Material 3 dynamic color (one base, many expressions): https://m3.material.io/styles/color/dynamic-color/overview
- **Layer:** L0 (overlays).

## F25 — Documentation and handoff
- **Decides:** what ships with the surface so the next person can run it.
- **Questions:** README? Decision log? Data-source map? Override ADRs? Screenshots in the repo?
- **Default:** every surface ships README (run + deploy) + decisions (why this direction) + data-source map (F1 table) + ADRs for each default overridden; current 1440 + 390 screenshots in the repo; client handoff = walkthrough of F0–F14 against the live pixels.
- **Verifies:** docs-presence check in the gate (README + sources + screenshots exist and are current).
- **Reference:** GOV.UK service documentation: https://design-system.service.gov.uk/
- **Layer:** doctrine.

## F26 — Lifecycle and operations
- **Decides:** how it ships, versions, rolls back, and gets watched.
- **Questions:** Deploy path? Versions? Rollback? Monitoring? Error reporting? On-call?
- **Default:** static host + serverless functions via CLI (the project's approved path — e.g. Cloudflare Pages/Workers via wrangler); every deploy versioned with its screenshot pair; rollback = re-promote prior deploy (<5 min); health + errors in host logs/observability; P1 follows the F12 ladder with a named owner per surface.
- **Verifies:** deploy + rollback drill per surface (promote, verify, roll back, verify).
- **Reference:** Cloudflare Pages docs: https://developers.cloudflare.com/pages/ ; Vercel Observability (the bar for "watched"): https://vercel.com/products/observability
- **Layer:** gate (deploy blocks) + operations.

## F27 — Storage and retention
- **Decides:** where the surface's data lives, how big it gets, and how long each tier is kept.
- **Questions:** Where does data live (store per data class), in what format, measured size per day, retention tiers per class, rollup policy (raw → hourly → daily), backup and restore path, privacy and per-client (per-tenant) separation?
- **Default:** every surface ships a store map: each data class names its store (e.g. snapshot file, JSONL log, SQLite via CLI, host analytics), its format, its measured bytes per day, its retention tier (live window / 1 h / 24 h / 7 d / pinned), its rollup rule, and its backup; one tenant's data never stored in or readable from another's scope; PII minimized, masked in exports (F21); retention is a table, not a paragraph.
- **Verifies:** storage audit — store map present, sizes measured (not estimated), retention tiers enforced, tenant separation checked.
- **Reference:** Cloudflare Workers Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/ ; GOV.UK data retention guidance: https://www.gov.uk/guidance/data-retention
- **Layer:** L3 + operations.

## F28 — Section identity and depth
- **Decides:** how sections tell themselves apart, and how each carries depth without a wall of text.
- **Questions:** Kicker pill with icon per section? Own accent hue per section (from a harmonious set)? Alternating layout and rhythm per section? Ambient life that carries meaning (progress, status — never decorative noise)? And per section: the interactive explainer that demonstrates the idea instead of describing it?
- **Default:** every band is a distinct section: kicker pill with an icon, its own accent hue from one harmonious set, an alternating layout (cards / split / timeline / specimen), a big section title, a one-paragraph explanation, and one interactive explainer per section minimum; ambient details (section progress in nav, scroll-progress ring, registration-mark frames on example panels) carry meaning; no decorative noise; light canvas kept unless the section states in one line why it goes dark.
- **Verifies:** rendered section-identity review by the critic (sections told apart at a glance; depth demonstrated, not described).
- **Reference:** distinct per-section identities on sectioned product pages (kicker + accent + alternating rhythm).
- **Layer:** L2 + L3.

## F29 — Drill-in experience
- **Decides:** what a click opens, where, how it moves, and how deep it goes.
- **Questions:** What does a click open (rich panel: side sheet or full section — never just an in-place expand of the same card for a primary item)? Where does it open? How does it animate in and out (the page's own motion tokens)? How does it close (Esc, backdrop, back button)? How is it addressed (deep-linkable URL hash)? How does the user move between items (prev/next)? How much depth does it carry (scan layout of the six parts + a live example)? Is focus trapped and restored? What happens under reduced motion?
- **Default:** click on a primary item opens a rich panel (side sheet on desktop, full section on phone) with the motion-token animation (F10), carrying the six parts laid out for scanning plus the owner's verbatim question where one applies plus a live example; prev/next between items; hash URL per item; Esc/backdrop/back closes; focus trapped while open, restored to the card on close; reduced-motion = instant, fully static; an in-place expand of the same card is not enough for a primary item.
- **Verifies:** Playwright drill-in test — open by click and by hash, prev/next, Esc close, focus restore, reduced-motion static.
- **Reference:** Radix Dialog: https://www.radix-ui.com/primitives/docs/components/dialog ; Apple HIG modality: https://developer.apple.com/design/human-interface-guidelines/modality
- **Layer:** L1 + L2.

---

## Gaps today

Honest list — foundations with no default or verifier yet:

1. **F22 — event pipeline.** Event schema, windows (live / 1 h / 24 h / 7 d) and timeline are named, but no collector exists in the static-host stack. Nothing measures use today. Needs: an event sink (e.g. host analytics) + F27 retention tiers enforced.
2. **F27 — measured sizes.** The store map shape is specified, but no surface has measured bytes/day yet. First measurement lands with the event pipeline; until then sizes are estimates and say so.
3. **F15 — wall/TV and print device proof.** Widths and print snapshots are scripted; no wall/TV device is in the review loop, so the 3 m glance test is judgment, not evidence. Needs: a named TV/wall target or a photo-proof step.

Everything else has both a default and a named verifier. Error reporting rides host logs; if that proves too thin on the first incident, it joins this list.

## How a new project front end uses this

1. **Intake.** Capture F0 (audience + 10-second questions + success metric) and F1 (data sources, freshness, targets) in one brief. No brief, no build.
2. **Decide each foundation.** Walk F0–F29 top to bottom. The default applies everywhere the project does not override in writing; each override gets an ADR (F25) naming what changed and why.
3. **Brand overlay.** The client's look lands as one overlay file (F24) — hues, logo, type accent. Structure, semantics and abnormal colours stay shared.
4. **Build.** L0 tokens → L1 primitives (copy-in) → L2 components/motion/viz → L3 pattern. Copy-in, never a new component dependency; chart library and WebGL only with written reasons.
5. **Verify every row.** Run the checklist verifiers in order: rendered screenshots (F3) → contrast/token lint (F5) → state matrix (F8) → interaction + keyboard (F9) → reduced-motion pair (F10) → stamps/stale (F11) → axe + keyboard (F14) → widths + print (F15) → Lighthouse (F16) → voice score (F18) → secret/CSP lint (F19) → share/export (F21) → gate `--strict` (F23) → overlay diff (F24) → docs presence (F25) → deploy + rollback drill (F26). F22 and the F15 wall/TV step record UNVERIFIED evidence explicitly.
6. **Owner accept.** Rendered pixels beside the exemplar gallery; verdict names which criteria moved. Rejections file negative evidence and map to layer fixes — never a full restart.

---

## Evidence, approval, and the shipping gate

`frontend.foundations.json` (version 2) is the criteria: 30 decisions plus
`buildDir`, the served build directory results bind to. `omp-kit frontend check`
runs each foundation's `verifier.argv` itself: argv, bounded time, no shell.
It records the real exit plus a hash of the real output. Nothing recorded
is trusted: stored exits, saved-output snippets and legacy `evidence`
fields never pass anything.

Two digests bind a run: the build digest (sorted paths and contents of
`buildDir`) and the criteria digest (bytes of the decisions file). A sealed
run (`--write-evidence`) holds both digests plus per-foundation results;
presenting it later (`--evidence`) refuses anything whose digests no longer
match, or whose recorded exits disagree with a fresh live run.

Foundations that need a human — owner accept (F0), the UNVERIFIED event
pipeline (F22), anything marked `judge` — report NEEDS_JUDGE, never PASS.
For deploy the owner records the exact digests (`frontend.approval.json`
naming `decision: "approve"`, `buildDigest`, `criteriaDigest`, `approver`);
`omp-kit frontend check --require-approval --approval frontend.approval.json`
refuses a missing record or one naming other digests. This is an explicit
owner attestation, not an authenticated signature; the gate never creates it.

All `<skill>/scripts/…` commands resolve relative to the installed directory
containing this skill's `SKILL.md`, not the project root or a client checkout.
Run the absolute script path from the project directory. Preview with
`node <skill>/scripts/build-reference.mjs --out reference.html`; it resolves
this reference from its own skill directory and works with no `overlays/`
directory. Add `--overlay <file>` only for an intentional client overlay.
