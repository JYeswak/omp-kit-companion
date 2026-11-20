#!/usr/bin/env node
// Renders the interactive foundations reference page from references/foundations.md
// plus an optional client overlay (bands, tokens, owner quotes). Without one
// it renders the stock look — light canvas, one accent — so the preview works
// with no client files present. The .md is the source of
// truth: checklist table supplies number, name, one-question, default, verifier;
// the F-sections supply all six parts. Drift gates below keep page and .md in sync.
// Usage: node build-reference.mjs [--in foundations.md] [--overlay overlay.json] [--out reference.html]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const inPath = resolve(process.cwd(), opt("--in", join(here, "../references/foundations.md")));
const outPath = resolve(process.cwd(), opt("--out", join(here, "reference.html")));
// The overlay is optional: a client overlay changes hues, logo and type accent
// only. With no --overlay argument the page renders the stock look,
// so the preview works with no client files present.
const STOCK = {
  brand: { name: "Front-end" },
  quoteLabel: "Owner note",
  tokens: {},
  quotes: {},
  bands: [
    { title: "Truth & purpose", icon: "◎", accent: "#2B4FFF", ink: "#1E36C8", soft: "#EDF0FF", ids: ["F0", "F1", "F18"], blurb: "Who it is for, where every number comes from, and how it sounds." },
    { title: "Structure", icon: "▦", accent: "#0E7C6B", ink: "#0B5F53", soft: "#E3F3EF", ids: ["F2", "F3", "F15", "F21"], blurb: "Where everything sits, how you move, and how it leaves the screen." },
    { title: "Look & feel", icon: "◑", accent: "#9333EA", ink: "#7A28C7", soft: "#F3E8FF", ids: ["F4", "F5", "F6", "F7", "F28"], blurb: "Type, colour, pictures, and the identity of each section." },
    { title: "Behaviour", icon: "◈", accent: "#B25E09", ink: "#8A4A07", soft: "#FBF1E2", ids: ["F8", "F9", "F10", "F11", "F12", "F13", "F20", "F29"], blurb: "What everything does in every state, and how it moves." },
    { title: "Quality & trust", icon: "✓", accent: "#0E7C6B", ink: "#0B5F53", soft: "#E3F3EF", ids: ["F14", "F16", "F17", "F19", "F23"], blurb: "The checks that stop bad work shipping." },
    { title: "Operations & memory", icon: "◫", accent: "#2B4FFF", ink: "#1E36C8", soft: "#EDF0FF", ids: ["F22", "F27", "F24", "F25", "F26"], blurb: "How it ships, where data lives, and what the next person reads." },
  ],
};
const overlayArg = (() => { const i = args.indexOf("--overlay"); return i >= 0 && args[i + 1] ? args[i + 1] : null; })();
const overlayPath = overlayArg !== null ? resolve(process.cwd(), overlayArg) : null;
let overlay = STOCK;
const stockLook = overlayPath === null;
if (overlayPath !== null) {
  try {
    overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) throw new Error("not an object");
  } catch {
    console.error("cannot read valid overlay " + overlayPath + " (omit --overlay for stock preview)");
    process.exit(1);
  }
}
const BRAND = (overlay.brand && overlay.brand.name) || overlay.name || "Front-end";
const TOK = overlay.tokens || {};
const QUOTE_LABEL = overlay.quoteLabel || "Owner note";
const SOURCE_NOTE = stockLook ? "references/foundations.md (stock look, no overlay)" : "references/foundations.md + overlay";

const md = readFileSync(inPath, "utf8");
const esc = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// ---------- checklist table: | F0 | Name | Question | Default | Verifier | ----------
const rows = [];
for (const line of md.split("\n")) {
  // Cells never cross a pipe, so negated classes keep this linear (regexploit:
  // no repeated span may sit beside what follows it). Trim in code, not in pattern.
  const m = line.match(/^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|$/);
  if (!m) continue;
  const cells = m.slice(1, 6).map((c) => c.trim());
  if (!/^F\d+$/.test(cells[0])) continue;
  rows.push({ id: cells[0], name: cells[1], question: cells[2], deflt: cells[3], verifier: cells[4] });
}
if (rows.length === 0) { console.error("no checklist rows parsed from " + inPath); process.exit(1); }

// ---------- sections: ## F0 — Name + six "- **Key:** value" bullets ----------
const full = {};
const secRe = /^##\s+(F\d+)\s+[—–-]\s+(.+?)\s*$/gm;
let sm;
while ((sm = secRe.exec(md)) !== null) {
  const start = sm.index + sm[0].length;
  const next = md.indexOf("\n## ", start);
  const body = md.slice(start, next === -1 ? undefined : next);
  const parts = {};
  for (const line of body.split("\n")) {
    const b = line.match(/^-\s+\*\*(.+?):\*\*\s*(.+?)\s*$/);
    if (b) parts[b[1].trim()] = b[2].trim();
  }
  full[sm[1]] = { name: sm[2].trim(), parts };
}

// ---------- drift gates: the generated page must stay in sync ----------
const SIX = ["Decides", "Questions", "Default", "Verifies", "Reference", "Layer"];
let drift = 0;
for (const r of rows) {
  const f = full[r.id];
  if (!f) { console.error("drift: checklist " + r.id + " has no ## section"); drift++; continue; }
  for (const k of SIX) {
    if (!f.parts[k]) { console.error("drift: " + r.id + " missing part: " + k); drift++; }
  }
}
for (const id of Object.keys(full)) {
  if (!rows.find(r => r.id === id)) { console.error("drift: section " + id + " has no checklist row"); drift++; }
}
if (drift > 0) { console.error("drift: " + drift + " finding(s) — fix foundations.md"); process.exit(1); }

// ---------- bands + owner quotes: from the overlay, never the .md ----------
// The overlay brands the page (section identities, tokens, verbatim owner quotes).
// Drift gates above still pin every foundation to the .md.
const BANDS = overlay.bands;
if (!Array.isArray(BANDS) || BANDS.length === 0) { console.error("overlay " + overlayPath + " names no bands"); process.exit(1); }
const seen = BANDS.flatMap(b => b.ids);
for (const r of rows) {
  if (!seen.includes(r.id)) { console.error("unbanded foundation: " + r.id); process.exit(1); }
}

// Owner verbatim quotes, surfaced in the panel where one applies.
// They live only in the overlay, never in the portable .md.
const QUOTES = (overlay.quotes && typeof overlay.quotes === "object") ? overlay.quotes : {};

// ---------- live examples ----------
// interactive: true = hands-on widget; false = static illustration.
const EXAMPLES = {
  F0: { t: "Glance test", i: 1, h: `<p class="ex-sub">Type a verdict, then blur it to 3&nbsp;m distance.</p><input class="ex-input" data-w="verdict" value="9 of 10 services working. Next release due in 21 h." aria-label="Verdict sentence"><div class="ex-out" data-w="verdictOut"></div><button class="ex-btn" data-w="verdictBlur">Simulate across-the-room glance</button>` },
  F1: { t: "Stamp ager", i: 1, h: `<p class="ex-sub">Drag the age. Cadence C = 15 min: fresh ≤ 20 min, aging ≤ 45 min, stale beyond.</p><input type="range" min="0" max="90" value="6" data-w="age" aria-label="Data age in minutes"><div class="ex-out" data-w="ageOut"></div>` },
  F2: { t: "Addressable section", i: 1, h: `<p class="ex-sub">Each section owns a hash. Open one, copy the URL, hand it to someone.</p><div class="ex-row"><button class="ex-btn" data-w="hash" data-h="#band-3">Open #band-3</button><button class="ex-btn" data-w="hash" data-h="#F11">Open #F11</button></div><div class="ex-out" data-w="hashOut">Current hash: (none)</div>` },
  F3: { t: "Breakpoint squeezer", i: 1, h: `<p class="ex-sub">Resize the mini-frame through 390 / 768 / 1024 / 1440.</p><input type="range" min="320" max="900" value="700" data-w="frame" aria-label="Frame width"><div class="ex-frame" data-w="frameOut"><div class="ex-frame-verdict">9 of 10 services working</div><div class="ex-frame-cards"><span></span><span></span><span></span></div></div>` },
  F4: { t: "Type specimen", i: 1, h: `<p class="ex-sub">Slide through the scale. Data always sets tabular.</p><input type="range" min="12" max="64" value="28" data-w="type" aria-label="Type size"><div class="ex-out ex-spec" data-w="typeOut">9 of 10 services working — 18.93%</div>` },
  F5: { t: "Contrast checker", i: 1, h: `<p class="ex-sub">Pick ink and paper from the real palette. AA needs ≥ 4.5:1.</p><div class="ex-row"><select data-w="fg" aria-label="Text colour"><option value="#111318">Ink #111318</option><option value="#2B4FFF">Accent #2B4FFF</option><option value="#B25E09">Warn #B25E09</option><option value="#D92D20">Bad #D92D20</option><option value="#8A93A3">Faint #8A93A3</option></select><select data-w="bgc" aria-label="Background colour"><option value="#FFFFFF">Paper #FFFFFF</option><option value="#FAFAFA">Canvas #FAFAFA</option><option value="#EDF0FF">Accent tint</option><option value="#111318">Ink #111318</option></select></div><div class="ex-out" data-w="contrastOut"></div>` },
  F6: { t: "Picture first", i: 1, h: `<p class="ex-sub">Same fact, two forms. Which answers faster?</p><button class="ex-btn" data-w="picToggle">Toggle digits / pictograms</button><div class="ex-out" data-w="picOut"></div>` },
  F7: { t: "Chart grammar", i: 1, h: `<p class="ex-sub">One dataset, three honest pictures — each with comparison + band.</p><div class="ex-row"><button class="ex-btn" data-w="chart" data-c="trend">Trend</button><button class="ex-btn" data-w="chart" data-c="share">Share</button><button class="ex-btn" data-w="chart" data-c="status">Status</button></div><svg class="ex-chart" data-w="chartOut" viewBox="0 0 300 110" role="img" aria-label="Sample chart"></svg>` },
  F8: { t: "State matrix", i: 1, h: `<p class="ex-sub">One component, all 13 states. Nothing is ever blank.</p><div class="ex-row"><button class="ex-btn" data-w="statePrev">←</button><div class="ex-out ex-state" data-w="stateOut"></div><button class="ex-btn" data-w="stateNext">→</button></div><div class="ex-sub" data-w="stateName"></div>` },
  F9: { t: "Feedback latency", i: 1, h: `<p class="ex-sub">Press it. Acknowledgement lands under 100 ms; real work follows.</p><button class="ex-btn" data-w="ack">Publish change</button><div class="ex-out" data-w="ackOut">Idle.</div>` },
  F10: { t: "Motion tokens", i: 1, h: `<p class="ex-sub">The four durations, on one dot. Standard ease in, 120 ms fade out.</p><div class="ex-row"><button class="ex-btn" data-w="motion" data-d="120">120</button><button class="ex-btn" data-w="motion" data-d="200">200</button><button class="ex-btn" data-w="motion" data-d="320">320</button><button class="ex-btn" data-w="motion" data-d="480">480</button></div><div class="ex-track"><span class="ex-dot" data-w="dot"></span></div>` },
  F11: { t: "Stale ladder", i: 1, h: `<p class="ex-sub">Sample data, labelled. Values marked sample never drive decisions.</p><input type="range" min="0" max="90" value="12" data-w="stale" aria-label="Minutes since producer tick"><div class="ex-out" data-w="staleOut"></div>` },
  F12: { t: "Severity ladder", i: 1, h: `<p class="ex-sub">Click each severity: how it reaches you, and when it stays quiet.</p><div class="ex-row"><button class="ex-btn" data-w="sev" data-s="P1">P1</button><button class="ex-btn" data-w="sev" data-s="P2">P2</button><button class="ex-btn" data-w="sev" data-s="P3">P3</button><button class="ex-btn" data-w="sev" data-s="P4">P4</button></div><div class="ex-out" data-w="sevOut">Pick a severity.</div>` },
  F13: { t: "Audit trail", i: 1, h: `<p class="ex-sub">A person presses Send. Every commit logs actor, action, time.</p><button class="ex-btn" data-w="send">Approve + Send</button><table class="ex-log" data-w="auditLog"><tr><th>Actor</th><th>Action</th><th>Time</th></tr></table>` },
  F14: { t: "Keyboard path", i: 0, h: `<p class="ex-sub">Static map of the tab order through this panel: card → title → example → prev/next → close. Focus-visible ring on every stop; Esc closes; focus returns to the card. Verified by the keyboard walkthrough, not by looking.</p>` },
  F15: { t: "Device matrix", i: 0, h: `<p class="ex-sub">Static contract: 1440 full · 1280 tighter air · 768 two-column + drawer · 390 stacked (verdict + visual + top action) · wall/TV verdict-only at 3 m · print verdict + tables. Wall/TV proof: UNVERIFIED — no device in the loop yet.</p>` },
  F16: { t: "Budget bars", i: 0, h: `<p class="ex-sub">Static budgets that block deploy: LCP &lt; 2.5 s · INP &lt; 200 ms · CLS &lt; 0.1 · JS &lt; 150 KB gz static / &lt; 300 KB dashboard. This page: zero dependencies, one file, no chart lib.</p>` },
  F17: { t: "Time formatter", i: 1, h: `<p class="ex-sub">Under 24 h reads relative; after, absolute UTC with local tooltip.</p><div class="ex-row"><button class="ex-btn" data-w="time" data-m="5">5 min ago</button><button class="ex-btn" data-w="time" data-m="300">5 h ago</button><button class="ex-btn" data-w="time" data-m="3000">50 h ago</button></div><div class="ex-out" data-w="timeOut">Pick an age.</div>` },
  F18: { t: "Voice scorer", i: 1, h: `<p class="ex-sub">Type copy. Banned words and naked claims get flagged.</p><input class="ex-input" data-w="copy" value="Our revolutionary solution leverages synergy to disrupt." aria-label="Copy to score"><div class="ex-out" data-w="copyOut"></div>` },
  F19: { t: "Secret lint", i: 1, h: `<p class="ex-sub">Paste a line of markup. Token shapes get caught before ship.</p><input class="ex-input" data-w="secret" value="token = &quot;demo&quot;" aria-label="Markup line"><div class="ex-out" data-w="secretOut"></div>` },
  F20: { t: "Saved view", i: 0, h: `<p class="ex-sub">Static contract: saved views + filters + pinned items, device-local by default, synced only when signed in, one-tap “Reset view”. Settings never change data — presentation only.</p>` },
  F21: { t: "Share envelope", i: 0, h: `<p class="ex-sub">Static contract: copy-link carries scope + window + filters; every table exports CSV; print stylesheet; embeds carry the “as of” stamp; PII masked in exports by default.</p>` },
  F22: { t: "Event timeline", i: 1, h: `<p class="ex-sub">Sample events. Press replay: live → 1 h → 24 h → 7 d windows.</p><button class="ex-btn" data-w="replay">Replay sample stream</button><div class="ex-timeline" data-w="timeline"></div>` },
  F23: { t: "Gate ladder", i: 0, h: `<p class="ex-sub">Static order: rendered review → critic ≥ 7.0 (no criterion &lt; 6.0) → owner accept. --strict blocks deploy; the rejected-screen calibration set must always score below the bar.</p>` },
  F24: { t: "Overlay switcher", i: 1, h: `<p class="ex-sub">One overlay file changes hues, logo, type accent — structure untouched.</p><div class="ex-row"><button class="ex-btn" data-w="overlay" data-a="#2B4FFF">Default</button><button class="ex-btn" data-w="overlay" data-a="#0E7C6B">Harbour</button><button class="ex-btn" data-w="overlay" data-a="#9333EA">Violet</button></div><div class="ex-overlay" data-w="overlayOut"><b>Client name</b><span>verdict-first · calm · picture before number</span></div>` },
  F25: { t: "Handoff packet", i: 0, h: `<p class="ex-sub">Static checklist per surface: README (run + deploy) · decisions · data-source map · ADRs per override · current 1440 + 390 screenshots. Missing one fails the docs-presence check.</p>` },
  F26: { t: "Ship + rollback", i: 0, h: `<p class="ex-sub">Static path: static host + functions via CLI · every deploy versioned with its screenshot pair · rollback = re-promote prior deploy (&lt; 5 min) · health + errors in host logs.</p>` },
  F27: { t: "Retention tiers", i: 0, h: `<p class="ex-sub">Static shape, per data class: store · format · measured bytes/day · tier (live / 1 h / 24 h / 7 d / pinned) · rollup (raw → hourly → daily) · backup · tenant scope. First measured sizes land with the F22 pipeline; until then estimates say so.</p>` },
  F28: { t: "Identity mixer", i: 1, h: `<p class="ex-sub">Restyle this section header: kicker, icon, accent, layout rhythm.</p><div class="ex-row"><button class="ex-btn" data-w="ident" data-a="#2B4FFF">Blue</button><button class="ex-btn" data-w="ident" data-a="#0E7C6B">Lagoon</button><button class="ex-btn" data-w="ident" data-a="#C2410C">Ember</button></div><div class="ex-ident" data-w="identOut"><span class="ex-kicker">◑ Look &amp; feel</span><b>Big section title</b><i>one-paragraph explanation</i></div>` },
  F29: { t: "Panel anatomy", i: 0, h: `<p class="ex-sub">Static map of this very panel: six parts for scanning · verbatim question · live example · prev/next · hash URL · Esc/backdrop/back close · focus trapped + restored · reduced-motion static. You are inside the example.</p>` },
};
const interactiveCount = Object.values(EXAMPLES).filter(e => e.i).length;
const spark = pts => `<svg class="mini" viewBox="0 0 120 36" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>`;
const MINI = {
  F0: `<div class="mini verdict" aria-hidden="true"><b>9<small>/10</small></b><span class="mbar"><span style="width:90%"></span></span></div>`,
  F1: `<div class="mini" aria-hidden="true"><span class="mdot pulse"></span><span class="mtxt">as of 01:55Z</span></div>`,
  F2: `<div class="mini" aria-hidden="true"><span class="mchip">#ov</span><span class="mchip">#F11</span><span class="mchip">#gap</span></div>`,
  F3: `<div class="mini" aria-hidden="true"><span class="mframe"><span></span><span></span><span></span></span><span class="mtxt">390→1440</span></div>`,
  F4: `<div class="mini" aria-hidden="true"><span style="font-size:18px;font-weight:750">Aa</span><span style="font-size:11px">Aa</span><span class="mtxt">tabular 18.93%</span></div>`,
  F5: `<div class="mini" aria-hidden="true"><span class="msw" style="background:#2B4FFF"></span><span class="msw" style="background:#FAFAFA;border:1px solid var(--line)"></span><span class="mtxt">6.9:1</span></div>`,
  F6: `<div class="mini" aria-hidden="true"><span class="mpic">⬤⬤⬤⬤◯</span></div>`,
  F7: spark("2,30 22,26 42,28 62,16 82,18 102,8 118,10"),
  F8: `<div class="mini" aria-hidden="true"><span class="mdot"></span><span class="mdot"></span><span class="mdot dim"></span><span class="mdot"></span></div>`,
  F9: `<div class="mini" aria-hidden="true"><span class="mack">ack 12ms</span><span class="mcur"></span></div>`,
  F10: `<div class="mini" aria-hidden="true"><span class="mtok" style="width:14px"></span><span class="mtok" style="width:22px"></span><span class="mtok" style="width:34px"></span><span class="mtok" style="width:50px"></span></div>`,
  F11: `<div class="mini" aria-hidden="true"><span class="mseg ok"></span><span class="mseg warn"></span><span class="mseg bad"></span></div>`,
  F12: `<div class="mini" aria-hidden="true"><span class="msev p1">P1</span><span class="msev">P2</span><span class="msev">P3</span><span class="msev">P4</span></div>`,
  F13: `<div class="mini" aria-hidden="true"><span class="mlog"></span><span class="mlog short"></span></div>`,
  F14: `<div class="mini" aria-hidden="true"><span class="mfocus">Tab</span></div>`,
  F15: `<div class="mini" aria-hidden="true"><span class="mdev wide"></span><span class="mdev"></span></div>`,
  F16: `<div class="mini" aria-hidden="true"><span class="mbar"><span style="width:38%"></span></span><span class="mtxt">LCP 1.9s</span></div>`,
  F17: `<div class="mini" aria-hidden="true"><span class="mtxt">5 h ago · UTC</span></div>`,
  F18: `<div class="mini" aria-hidden="true"><span class="mtxt">calm · verdict-first</span></div>`,
  F19: `<div class="mini" aria-hidden="true"><span class="mtxt">0 secrets · CSP ✓</span></div>`,
  F20: `<div class="mini" aria-hidden="true"><span class="mtoggle"><span></span></span><span class="mtxt">saved view</span></div>`,
  F21: `<div class="mini" aria-hidden="true"><span class="mtxt">⧉ link · CSV · print</span></div>`,
  F22: `<div class="mini" aria-hidden="true"><span class="mtl"><span></span><span></span><span></span><span></span><span></span></span></div>`,
  F23: `<div class="mini" aria-hidden="true"><span class="mtxt">≥7.0 · ✓✓✓✓</span></div>`,
  F24: `<div class="mini" aria-hidden="true"><span class="msw" style="background:#2B4FFF"></span><span class="msw" style="background:#0E7C6B"></span><span class="msw" style="background:#9333EA"></span></div>`,
  F25: `<div class="mini" aria-hidden="true"><span class="mlog"></span><span class="mlog"></span><span class="mlog short"></span></div>`,
  F26: `<div class="mini" aria-hidden="true"><span class="mtxt">v418 → rollback &lt;5 min</span></div>`,
  F27: `<div class="mini" aria-hidden="true"><span class="mbar"><span style="width:64%"></span></span><span class="mtxt">24 h · 41 MB/d</span></div>`,
  F28: `<div class="mini" aria-hidden="true"><span class="mchip">◑ kicker</span><span class="msw" style="background:#C2410C"></span></div>`,
  F29: `<div class="mini" aria-hidden="true"><span class="mframe"><span></span></span><span class="mtxt">sheet · #F11 · Esc</span></div>`,
};

const data = rows.map(r => {
  const f = full[r.id];
  return { ...r, parts: f.parts, quote: QUOTES[r.id] || null,
    ex: EXAMPLES[r.id] || { t: "Illustration", i: 0, h: "<p class='ex-sub'>See the six parts above.</p>" } };
});

const VIS = [
  `<div class="band-visual dense" aria-hidden="true"><span class="hud">LIVE · SAMPLE · C = 15 MIN</span><div class="bv-truth"><div class="bvtnum">9<small>/10</small><span>services working</span></div><div class="bvsrc"><b>Ops truth · system of record</b><span data-age>as of --:--:--Z · fresh — sample</span></div><svg viewBox="0 0 220 64" preserveAspectRatio="none"><path id="bp0" d="M4,32 H120 C170,32 150,10 216,10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 5" class="flow"/><circle r="6" fill="currentColor"><animateMotion dur="6s" repeatCount="indefinite"><mpath href="#bp0"/></animateMotion></circle></svg></div><div class="bv-ager"><span></span></div><span class="hud">FRESH LE 20 MIN · AGING LE 45 · STALE + BANNER</span></div>`,
  `<div class="band-visual dense" aria-hidden="true"><span class="hud">ONE LAYOUT · EVERY WIDTH</span><div class="bv-chrome"><span></span><span></span><span></span></div><div class="bv-viewport"><div class="bv-reflow"><span></span><span></span><span></span></div><span class="bv-view"></span></div><div class="bv-cols"><span>nav</span><span>main</span><span>side</span></div><div class="bv-bps"><span>1440 · 3-col</span><span>768 · 2-col</span><span>390 · stacked</span></div></div>`,
  `<div class="band-visual dense" aria-hidden="true"><span class="hud">SPECIMEN · AA GE 4.5:1</span><div class="bv-type"><b>Aa</b><span>verdict 40-64 · tabular 18.93%</span></div><div class="bv-sw5"><span style="--c:#111318"><i></i>Ink 16.6</span><span style="--c:#2B4FFF"><i></i>Accent 6.9</span><span style="--c:#0E7C6B"><i></i>Lagoon 4.9</span><span style="--c:#B25E09"><i></i>Warn 4.7</span><span style="--c:#D92D20"><i></i>Bad 4.8</span></div><div class="bv-contrast"><span class="c1"><b>Aa</b>ink on paper · 16.6 ✓</span><span class="c2"><b>Aa</b>accent on tint · 6.9 ✓</span><span class="c3"><b>Aa</b>warn on paper · 4.7 ✓</span></div></div>`,
  `<div class="band-visual dense" aria-hidden="true"><span class="hud">EVENT TO TIMELINE · CAUSE TO EFFECT</span><div class="bv-src-row"><span class="bv-chip">svc-7 idle</span><span class="bv-chip">deploy ab12</span><span class="bv-chip">tick ok</span></div><svg viewBox="0 0 300 46" preserveAspectRatio="none"><path id="bp3" d="M8,8 C120,8 130,38 292,38" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 5" class="flow"/><circle r="6" fill="currentColor"><animateMotion dur="4.5s" repeatCount="indefinite"><mpath href="#bp3"/></animateMotion></circle></svg><div class="bv-rows"><span>01:55:20 · F11 aging — labelled</span><span>01:56:01 · deploy — rollback ready</span><span>01:57:44 · P2 banner — named cause</span></div></div>`,
  `<div class="band-visual dense gates" aria-hidden="true"><span class="hud">GATES · ALL GREEN TO SHIP</span><div class="bv-gate"><b>rendered review</b><span>pixels beat words · 8.2</span><i>ok</i></div><div class="bv-gate"><b>critic GE 7.0</b><span>no criterion below 6.0 · 7.8</span><i>ok</i></div><div class="bv-gate"><b>axe zero-serious</b><span>contrast + names · 0</span><i>ok</i></div><div class="bv-gate hold"><b>owner accept</b><span>names the criteria · …</span><i>…</i></div></div>`,
  `<div class="band-visual dense" aria-hidden="true"><span class="hud">COLLECTOR TO LOG TO ROLLUP TO PAGE</span><div class="bv-pipe"><span>collect</span><span>log</span><span>rollup</span><span>page</span><svg viewBox="0 0 300 30" preserveAspectRatio="none"><path id="bp5" d="M2,15 H298" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="6 6" class="flow"/><circle r="5" fill="currentColor"><animateMotion dur="3s" repeatCount="indefinite"><mpath href="#bp5"/></animateMotion></circle><circle r="5" fill="currentColor" opacity=".65"><animateMotion dur="3s" begin="-1s" repeatCount="indefinite"><mpath href="#bp5"/></animateMotion></circle><circle r="5" fill="currentColor" opacity=".35"><animateMotion dur="3s" begin="-2s" repeatCount="indefinite"><mpath href="#bp5"/></animateMotion></circle></svg></div><div class="bv-gauge"><span></span></div><div class="bv-bytes"><b data-bytes>41.0 MB/d</b><span>retention 7 d · rollup raw to hour to day</span></div><div class="bv-tiers"><span>live</span><span>1 h</span><span>24 h</span><span class="on">7 d</span><span>pinned</span></div><div class="bv-meta"><span>backup nightly</span><span>per-tenant scope</span><span>PII minimized</span></div></div>`,
];
const bandsHtml = BANDS.map((b, bi) => {
  const cards = b.ids.map(id => {
    const r = rows.find(x => x.id === id);
    if (!r) { console.error("checklist missing " + id); process.exit(1); }
    return `<button class="card" data-open="${esc(id)}" style="--acc:${b.accent};--acctext:${b.ink || b.accent};--accsoft:${b.soft}">` +
      `<span class="num">${esc(id)}</span>` +
      `<span class="cname">${esc(r.name)}</span>` +
      `<span class="q">${esc(r.question)}</span>` +
      (MINI[id] || "") + `</button>`;
  }).join("\n");
  const flip = bi % 2 === 1 ? " flip" : "";
  return `<section class="band${flip}" id="band-${bi}" data-band="${bi}" style="--acc:${b.accent};--acctext:${b.ink || b.accent};--accsoft:${b.soft}">` +
    `<div class="band-head"><div class="band-text"><span class="kicker"><span class="kicon" aria-hidden="true">${b.icon}</span>${esc(b.title)}</span>` +
    `<h2>${esc(b.title)}</h2><p>${esc(b.blurb)}</p>` +
    `<span class="count">${b.ids.length} foundations</span></div>` + VIS[bi] + `</div>` +
    `<div class="grid">${cards}</div></section>`;
}).join("\n");

const unverified = rows.filter(r => /UNVERIFIED/i.test(r.verifier)).length;
const navLinks = BANDS.map((b, bi) =>
  `<a href="#band-${bi}" data-nav="${bi}"><span class="nicon" aria-hidden="true">${b.icon}</span>${esc(b.title)}<span class="nprog"><span></span></span></a>`
).join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(BRAND)} front-end foundations — ${rows.length} things decided before ship</title>
<style>
::root{
  --ink:${TOK.ink || "#111318"}; --sub:#4B5563; --faint:#667085; --line:#e4e7ec; --line-soft:#eef0f4;
  --bg:${TOK.canvas || "#FAFAFA"}; --card:#ffffff;
  --accent:${TOK.accent || "#2b4fff"}; --accent-ink:${TOK.accentInk || "#1e36c8"}; --accent-soft:${TOK.accentSoft || "#edf0ff"};
  --good:#178a4c; --good-soft:#e9f7ef; --warn:#b25e09; --warn-soft:#fdf3e3; --bad:#d92d20; --bad-soft:#fdecea;
  --radius:${TOK.radius || "20px"}; --mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
  --ease:cubic-bezier(0.2,0,0,1); --ease-em:cubic-bezier(0.05,0.7,0.1,1);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,"SF Pro Display","Inter","Helvetica Neue",sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.45}
.topbar{display:flex;align-items:center;gap:10px;padding:12px 28px;border-bottom:1px solid var(--line);background:rgba(250,250,250,.94);position:sticky;top:0;z-index:60}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.02em;font-size:15px}
.brand .mark{width:22px;height:22px;border-radius:50%;background:conic-gradient(from 200deg,var(--accent),#9db1ff,var(--accent));position:relative}
.brand .mark::after{content:"";position:absolute;inset:7px;background:#fff;border-radius:50%}
.brand small{font-weight:600;color:var(--sub);border:1px solid var(--line);border-radius:6px;padding:1px 7px;font-size:11px}
.topbar .spacer{flex:1}
.pill{border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;color:var(--sub);background:#fff;white-space:nowrap}
.pill b{color:var(--ink);font-weight:700}
.ring{width:26px;height:26px;transform:rotate(-90deg)}
.ring .bg{stroke:var(--line)} .ring .fg{stroke:var(--accent);stroke-linecap:round;transition:stroke-dashoffset .12s linear}
.sitenav{position:sticky;top:53px;z-index:55;display:flex;gap:6px;overflow-x:auto;padding:10px 28px;background:rgba(250,250,250,.94);border-bottom:1px solid var(--line-soft)}
.sitenav a{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:var(--sub);text-decoration:none;border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;white-space:nowrap;position:relative}
.sitenav a .nicon{font-size:12px}
.sitenav a.on{color:var(--ink);border-color:var(--ink)}
.sitenav a.done{color:var(--accent-ink);border-color:var(--accent)}
.sitenav a .nprog{position:absolute;left:12px;right:12px;bottom:3px;height:2px;background:var(--line-soft);border-radius:2px;overflow:hidden}
.sitenav a .nprog span{display:block;height:100%;width:0;background:currentColor}
.main{max-width:1180px;margin:0 auto;padding:34px 34px 90px}
.eyebrow{font-size:12.5px;font-weight:700;letter-spacing:.14em;color:var(--sub);text-transform:uppercase;margin-bottom:14px}
h1.sentence{font-size:46px;line-height:1.08;letter-spacing:-.025em;font-weight:750;max-width:24ch}
h1.sentence .okay{color:var(--accent)}
.subline{margin:12px 0 8px;color:var(--sub);font-size:15px;max-width:70ch}
 .band{margin-top:56px;border-top:2px solid var(--acc);padding-top:22px;scroll-margin-top:120px}
 .js .band{opacity:0;transform:translateY(26px)}
 .js .band.in{opacity:1;transform:none;transition:opacity .6s var(--ease),transform .6s var(--ease-em)}
 .kicker{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--acctext,var(--acc));background:var(--accsoft);border:1px solid color-mix(in srgb,var(--acc) 25%,#fff);border-radius:999px;padding:5px 14px;width:fit-content}
 .kicon{font-size:13px}
 .band h2{font-size:34px;font-weight:750;letter-spacing:-.02em}
 .band-head p{color:var(--sub);font-size:15px;max-width:62ch}
 .band-text .count{font-size:12.5px;font-weight:700;color:var(--sub)}
 .band-head{display:grid;grid-template-columns:1.05fr .95fr;gap:28px;align-items:center;margin-bottom:18px}
 .band.flip .band-head{grid-template-columns:.95fr 1.05fr}
 .band.flip .band-text{order:2}
 .band-text{display:grid;gap:8px;align-content:start}
 .band.flip .band-text{justify-items:end;text-align:right}
 .band-visual{position:relative;border:1px solid var(--line);border-radius:18px;background-color:#fff;background-image:radial-gradient(var(--line) 1.1px,transparent 1.2px);background-size:15px 15px;padding:20px 20px 16px;display:grid;gap:12px;align-content:start;min-height:300px;overflow:hidden;color:var(--acctext,var(--acc))}
 .band-visual::before,.band-visual::after{content:"+";position:absolute;font-family:var(--mono);color:var(--faint);font-size:14px;z-index:2}
 .band-visual::before{top:6px;left:10px}.band-visual::after{bottom:2px;right:10px}
 .hud{font-family:var(--mono);font-size:10px;font-weight:800;letter-spacing:.18em;color:var(--faint);text-transform:uppercase}
 .flow{stroke-dashoffset:22;animation:dashmove 1.6s linear infinite}
 @keyframes dashmove{to{stroke-dashoffset:0}}
 .bv-truth{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:end}
 .bvtnum{font-size:46px;font-weight:750;letter-spacing:-.02em;color:var(--ink);line-height:1}
 .bvtnum small{font-size:18px;color:var(--sub)}
 .bvtnum span{display:block;font-size:12px;font-weight:600;color:var(--sub);letter-spacing:0}
 .bv-truth svg{grid-column:1/-1;width:100%;height:60px}
 .bvsrc{font-size:12.5px;color:var(--sub)}
 .bvsrc b{color:var(--ink);display:block}
 .bvsrc span[data-age]{font-family:var(--mono);font-size:12px}
 .bv-ager{height:10px;border-radius:6px;background:var(--line-soft);overflow:hidden}
 .bv-ager span{display:block;height:100%;width:0;background:currentColor;border-radius:6px;animation:agefill 6s linear infinite}
 @keyframes agefill{0%{width:4%}70%{width:66%}100%{width:100%}}
 .bv-chrome{display:flex;gap:6px}
 .bv-chrome span{height:12px;border-radius:6px;background:var(--line-soft)}
 .bv-chrome span:nth-child(1){width:52px}.bv-chrome span:nth-child(2){flex:1}.bv-chrome span:nth-child(3){width:30px;background:var(--accsoft)}
 .bv-reflow{display:grid;grid-template-columns:1fr 2fr 1fr;gap:8px}
 .bv-viewport{position:relative;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px;overflow:hidden}
 .bv-reflow{display:grid;grid-template-columns:1fr 2fr 1fr;gap:8px}
 .bv-reflow span{display:block;height:70px;border-radius:8px;background:var(--accsoft);border:1px solid var(--line)}
 .bv-view{position:absolute;top:6px;bottom:6px;left:6px;border:2px solid currentColor;border-radius:10px;animation:viewport 6s var(--ease) infinite}
 @keyframes viewport{0%,100%{right:6px}45%{right:62%}55%{right:62%}90%{right:6px}}
 .bv-cols{display:grid;grid-template-columns:1fr 2fr 1fr;gap:8px;font-family:var(--mono);font-size:12px;font-weight:800;color:var(--sub)}
 .bv-bps{position:relative;height:20px;font-family:var(--mono);font-size:12px;font-weight:800;color:var(--sub)}
 .bv-bps span{position:absolute;inset:0;opacity:0;animation:bpswap 6s infinite}
 .bv-bps span:nth-child(2){animation-delay:2s}.bv-bps span:nth-child(3){animation-delay:4s}
 @keyframes bpswap{0%{opacity:0}5%{opacity:1}30%{opacity:1}38%{opacity:0}100%{opacity:0}}
 .bv-type{display:flex;align-items:baseline;gap:10px}
 .bv-type b{font-size:52px;font-weight:750;letter-spacing:-.03em;color:var(--ink);animation:tint 6s infinite}
 @keyframes tint{0%,100%{color:var(--ink)}25%{color:#2B4FFF}50%{color:#0E7C6B}75%{color:#9333EA}}
 .bv-type span{font-size:12.5px;color:var(--sub)}
 .bv-sw5{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;font-family:var(--mono);font-size:12px;font-weight:800;color:var(--sub)}
 .bv-sw5 span{display:grid;gap:6px;justify-items:center;border-radius:10px;padding:8px 4px;border:1px solid transparent;animation:sweep 5s infinite}
 .bv-sw5 span:nth-child(2){animation-delay:1s}.bv-sw5 span:nth-child(3){animation-delay:2s}.bv-sw5 span:nth-child(4){animation-delay:3s}.bv-sw5 span:nth-child(5){animation-delay:4s}
 @keyframes sweep{0%,100%{border-color:transparent;background:transparent}12%{border-color:var(--line);background:#fff}28%{border-color:transparent;background:transparent}}
 .bv-sw5 i{width:100%;height:34px;border-radius:8px;background:var(--c);border:1px solid rgba(0,0,0,.1)}
 .bv-contrast{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px}
 .bv-contrast span{border-radius:10px;padding:8px 10px;color:var(--ink)}
 .bv-contrast b{font-size:16px;margin-right:6px}
 .bv-contrast .c1{background:#fff;border:1px solid var(--line)}
 .bv-contrast .c2{background:#EDF0FF;color:#1E36C8}
 .bv-contrast .c3{background:#FDF3E3;color:#7A4A06}
 .bv-tiers{display:flex;gap:6px}
 .bv-tiers span{font-family:var(--mono);font-size:12px;font-weight:800;border:1px solid var(--line);background:#fff;border-radius:999px;padding:4px 12px;color:var(--sub)}
 .bv-tiers .on{background:var(--ink);border-color:var(--ink);color:#fff}
 .bv-meta{display:flex;gap:14px;font-family:var(--mono);font-size:12px;color:var(--sub)}
 .bv-meta span::before{content:"✓ ";color:var(--good);font-weight:800}
 .bv-src-row{display:flex;gap:8px;flex-wrap:wrap}
 .bv-chip{font-family:var(--mono);font-size:12px;font-weight:800;border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 12px;color:var(--sub)}
 .bv-chip:first-child{border-color:currentColor;color:var(--acctext,var(--acc))}
 .band-visual svg{width:100%}
 .bv-rows{display:grid;gap:6px}
 .bv-rows span{font-family:var(--mono);font-size:12px;background:#fff;border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:8px;padding:8px 12px;color:var(--sub);animation:rowpulse 4.5s infinite}
 .bv-rows span:nth-child(2){animation-delay:1.5s}.bv-rows span:nth-child(3){animation-delay:3s}
 @keyframes rowpulse{0%,100%{background:#fff;color:var(--sub)}8%{background:var(--accsoft);color:var(--ink)}30%{background:var(--accsoft);color:var(--ink)}40%{background:#fff;color:var(--sub)}}
 .bv-gate{display:grid;grid-template-columns:1fr auto auto;gap:4px 10px;align-items:center;font-size:12.5px;border:1px solid transparent;background:var(--good-soft);border-radius:10px;padding:8px 12px;color:#0C5A2C}
 .bv-gate b{font-weight:750}
 .bv-gate span{font-size:12px;opacity:.85}
 .bv-gate i{font-style:normal;font-weight:800}
 .bv-gate.hold{background:#fff;border-color:var(--line);color:var(--sub)}
 @media (prefers-reduced-motion: no-preference){
 .bv-gate:not(.hold){animation:gate 6s ease infinite}
 .bv-gate:nth-child(3){animation-delay:1.2s}.bv-gate:nth-child(4){animation-delay:2.4s}
 }
 @keyframes gate{0%{background:#fff;border-color:var(--line-soft);color:var(--sub)}18%{background:var(--good-soft);border-color:transparent;color:#0C5A2C}82%{background:var(--good-soft);border-color:transparent;color:#0C5A2C}100%{background:#fff;border-color:var(--line-soft);color:var(--sub)}}
 .bv-pipe{display:grid;grid-template-columns:repeat(4,auto);gap:6px;font-family:var(--mono);font-size:12px;font-weight:800;color:var(--sub)}
 .bv-pipe svg{grid-column:1/-1;width:100%;height:30px}
 .bv-gauge{height:14px;border-radius:8px;background:var(--line-soft);overflow:hidden}
 .bv-gauge span{display:block;height:100%;width:20%;background:var(--acc);border-radius:8px;animation:gauge 6s var(--ease) infinite alternate}
 @keyframes gauge{from{width:18%}to{width:96%}}
 .bv-bytes{display:flex;align-items:baseline;gap:10px}
 .bv-bytes b{font-size:22px;font-weight:750;color:var(--ink);font-variant-numeric:tabular-nums}
 .bv-bytes span{font-size:12px;color:var(--sub)}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
 .band.flip .grid{direction:rtl}.band.flip .grid>*{direction:ltr}
 .card{font:inherit;text-align:left;background:var(--card);border:1px solid var(--line);border-left:5px solid var(--acc);border-radius:var(--radius);padding:16px 18px;cursor:pointer;display:flex;flex-direction:column;gap:8px;transition:transform .2s var(--ease),box-shadow .2s var(--ease)}
 .card:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(17,19,24,.10)}
 .card:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
 .num{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:800;color:var(--acctext,var(--acc));background:var(--accsoft);border-radius:6px;padding:2px 8px;width:fit-content}
 .cname{font-size:17px;font-weight:750;letter-spacing:-.01em}
 .q{font-size:14px;font-weight:600}
 .mini{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--acctext,var(--acc));min-height:36px}
 .mini svg.mini{width:120px;height:36px}
 .mini .mtxt{font-family:var(--mono);font-size:11px;color:var(--sub)}
 .mini .mbar{flex:1;height:10px;border-radius:6px;background:var(--line-soft);overflow:hidden}
 .mini .mbar span{display:block;height:100%;background:currentColor}
 .mini .mdot{width:12px;height:12px;border-radius:50%;background:currentColor}
 .mini .mdot.dim{opacity:.3}
 .mini .mdot.pulse{animation:blink 1.6s steps(2) infinite}
 .mini .mchip{font-family:var(--mono);font-size:11px;font-weight:800;border:1px solid var(--line);border-radius:6px;padding:2px 8px;color:var(--sub)}
 .mini .mframe{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
 .mini .mframe span{height:26px;border-radius:6px;background:var(--accsoft);border:1px solid var(--line)}
 .mini .msw{width:22px;height:22px;border-radius:7px}
 .mini .mpic{letter-spacing:2px;font-size:13px}
 .mini .mseg{width:30px;height:10px;border-radius:5px}
 .mini .mseg.ok{background:var(--good)}.mini .mseg.warn{background:var(--warn)}.mini .mseg.bad{background:var(--bad)}
 .mini .msev{font-family:var(--mono);font-size:10px;font-weight:800;border-radius:5px;padding:2px 6px;background:var(--line-soft);color:var(--sub)}
 .mini .msev.p1{background:var(--bad);color:#fff}
 .mini .mlog{display:block;width:100%;height:8px;border-radius:4px;background:var(--line-soft);margin:2px 0}
 .mini .mlog.short{width:55%}
 .mini .mfocus{font-family:var(--mono);font-size:11px;border:2px solid currentColor;border-radius:6px;padding:2px 10px}
 .mini .mdev{width:22px;height:34px;border:2px solid currentColor;border-radius:5px}
 .mini .mdev.wide{width:48px;height:30px}
 .mini .mack{font-family:var(--mono);font-size:11px;color:#0C5A2C;font-weight:800}
 .mini .mcur{width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}
 @keyframes spin{to{transform:rotate(360deg)}}
 .mini .mtok{height:10px;border-radius:5px;background:currentColor;opacity:.85}
 .mini .mtoggle{width:40px;height:22px;border-radius:12px;background:currentColor;position:relative;opacity:.85}
 .mini .mtoggle span{position:absolute;top:3px;right:3px;width:16px;height:16px;border-radius:50%;background:#fff}
 .mini .mtl{display:flex;gap:5px;align-items:flex-end}
 .mini .mtl span{width:8px;border-radius:3px;background:currentColor;opacity:.8}
 .mini .mtl span:nth-child(1){height:12px}.mini .mtl span:nth-child(2){height:20px}.mini .mtl span:nth-child(3){height:14px}.mini .mtl span:nth-child(4){height:24px}.mini .mtl span:nth-child(5){height:18px}
 .mini.verdict b{font-size:22px;color:var(--ink)}
 .scrim{position:fixed;inset:0;background:rgba(17,19,24,.4);opacity:0;pointer-events:none;transition:opacity .2s var(--ease);z-index:80}
 .scrim.show{opacity:1;pointer-events:auto}
 .sheet{position:fixed;top:0;right:0;bottom:0;width:min(620px,100vw);background:#fff;border-left:1px solid var(--line);z-index:90;transform:translateX(102%);transition:transform .32s var(--ease-em);display:flex;flex-direction:column;box-shadow:-24px 0 60px rgba(17,19,24,.18)}
 .sheet.show{transform:none}
 .sheet-head{padding:20px 24px 14px;border-bottom:1px solid var(--line-soft)}
 .sheet-head .kicker{margin-bottom:10px}
 .sheet-head .qline{color:var(--sub);font-size:14px;margin-top:4px}
 .sheet-body{overflow-y:auto;padding:18px 24px 24px;display:grid;gap:14px;align-content:start}
 .mini.verdict small{font-size:12px;color:var(--sub)}
 .sheet-head h3:focus{outline:none}
 .sheet-head h3:focus-visible{outline:2px solid var(--acc);outline-offset:4px;border-radius:8px}
 .example{position:relative;border:1px solid var(--line);border-radius:16px;padding:16px;background:var(--bg);display:grid;gap:10px;align-content:start}
 .example::before,.example::after{content:"+";position:absolute;font-family:var(--mono);color:var(--faint);font-size:14px}
 .example::before{top:6px;left:10px}.example::after{bottom:2px;right:10px}
 .example h4{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
 .example h4 .tag{font-weight:700;letter-spacing:0;text-transform:none;background:#111318;color:#fff;border-radius:6px;padding:1px 8px;font-size:11px}
 .example h4 .tag.static{background:#fff;color:var(--sub);border:1px solid var(--line)}
 .example.hero{min-height:200px}
 @media (min-width:700px){.example.hero{min-height:320px}}
 .pull{font-size:14px;color:var(--sub);border-left:3px solid var(--acc);padding:2px 0 2px 12px}
 .pull span{display:block;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:2px}
 .decides{font-size:14.5px}
 .cols{display:grid;grid-template-columns:1.15fr .85fr;gap:10px;align-items:start}
 .col{display:grid;gap:10px;align-content:start}
 .col.compact .srow{padding:8px 12px;font-size:12.5px}
 .sheet-head h3{font-size:24px;letter-spacing:-.02em;font-weight:750}
.ex-sub{font-size:13px;color:var(--sub)}
.ex-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ex-btn{font:inherit;font-size:13px;font-weight:700;border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 14px;cursor:pointer;min-height:44px}
.ex-btn:hover{border-color:#111318}
.ex-input{font:inherit;font-size:14px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%;background:#fff}
.ex-out{font-size:14px;border:1px dashed var(--line);border-radius:10px;padding:10px 12px;background:#fff;min-height:44px}
.ex-out.stale-bad{background:var(--bad-soft)} .ex-out.stale-warn{background:var(--warn-soft)} .ex-out.stale-ok{background:var(--good-soft)}
select{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:10px;padding:9px 10px;background:#fff;min-height:44px}
input[type=range]{width:100%;min-height:44px;accent-color:var(--accent)}
.ex-frame{border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px;overflow:hidden}
.ex-frame-verdict{font-weight:750;font-size:15px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ex-frame-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.ex-frame-cards span{display:block;height:44px;border-radius:8px;background:var(--accsoft);border:1px solid var(--line)}
.ex-spec{font-weight:750}
.ex-track{height:34px;border:1px solid var(--line);border-radius:999px;background:#fff;position:relative;overflow:hidden}
.ex-dot{position:absolute;top:50%;left:8px;width:18px;height:18px;border-radius:50%;background:var(--accent);transform:translateY(-50%)}
.ex-chart{width:100%;height:110px;background:#fff;border:1px solid var(--line);border-radius:10px}
.ex-state{font-size:15px;font-weight:700}
.ex-timeline{display:grid;gap:6px}
.ex-ev{font-size:12.5px;font-family:var(--mono);border-left:3px solid var(--accent);background:#fff;border-radius:0 8px 8px 0;padding:6px 10px;opacity:0;transform:translateX(-8px);transition:opacity .2s var(--ease),transform .2s var(--ease)}
.ex-ev.lit{opacity:1;transform:none}
.ex-log{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff}
.ex-log th,.ex-log td{border:1px solid var(--line-soft);padding:6px 8px;text-align:left}
.ex-overlay{border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px;display:grid;gap:2px}
.ex-overlay b{font-size:16px} .ex-overlay span{font-size:12.5px;color:var(--sub)}
.ex-ident{border:1px solid var(--line);border-radius:12px;background:#fff;padding:12px;display:grid;gap:4px}
.ex-ident .ex-kicker{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.ex-ident b{font-size:20px} .ex-ident i{font-style:normal;font-size:13px;color:var(--sub)}
.sheet-foot{display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--line-soft)}
.sheet-foot .sp{flex:1}
.sheet-foot .pos{font-size:12.5px;color:var(--faint);font-family:var(--mono)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer.page{margin-top:48px;color:var(--sub);font-size:12.5px}
@media (max-width:900px){
  .main{padding:22px 16px 70px}
  h1.sentence{font-size:30px}
  .grid{grid-template-columns:1fr}
  .topbar{padding:10px 14px}
  .sitenav{top:49px;padding:8px 14px}
  .sheet{width:100vw;border-left:none}
  .band-head{grid-template-columns:1fr;gap:14px}
  .band.flip .band-text{order:0;justify-items:start;text-align:left}
  .cols{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  .js .band{opacity:1;transform:none}
  .band-visual *,.mini *{animation:none !important}
  .sheet{transform:none;display:none}
  .sheet.show{display:flex}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><span class="mark" aria-hidden="true"></span>${esc(BRAND.toUpperCase())} <small>FOUNDATIONS</small></div>
  <div class="spacer"></div>
  <span class="pill"><b>${rows.length}</b>&nbsp;foundations</span>
  <span class="pill"><b>${unverified}</b>&nbsp;unverified</span>
  <svg class="ring" viewBox="0 0 26 26" role="img" aria-label="Scroll progress"><circle class="bg" cx="13" cy="13" r="10" fill="none" stroke-width="3"/><circle class="fg" cx="13" cy="13" r="10" fill="none" stroke-width="3" stroke-dasharray="62.8" stroke-dashoffset="62.8" data-ring/></svg>
</header>
<nav class="sitenav" aria-label="Sections">${navLinks}</nav>
<main class="main">
  <div class="eyebrow">Front-end foundations</div>
  <h1 class="sentence">${rows.length} things every ${esc(BRAND)} front end <span class="okay">decides before it ships</span>.</h1>
  <p class="subline">${BANDS.length} sections, each with its own identity. Open any card for the full six parts plus a live example you can touch. Source: ${SOURCE_NOTE} — this page is generated, never hand-edited.</p>
  ${bandsHtml}
  <footer class="page"><span>Generated from references/foundations.md by build-reference.mjs — edit the .md, rebuild, never hand-edit. ${interactiveCount} interactive examples, ${rows.length - interactiveCount} static illustrations.</span></footer>
</main>
<div class="scrim" data-scrim></div>
<aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" aria-label="Foundation detail panel" data-sheet hidden>
  <div class="sheet-head"><span class="kicker" data-sheet-kicker></span><h3 id="sheetTitle" data-sheet-title tabindex="-1"></h3><p class="qline" data-sheet-q></p></div>
  <div class="sheet-body" data-sheet-body></div>
  <div class="sheet-foot">
    <button class="ex-btn" data-prev>← Prev</button>
    <button class="ex-btn" data-next>Next →</button>
    <span class="sp"></span><span class="pos" data-pos></span>
    <button class="ex-btn" data-close>Close (Esc)</button>
  </div>
</aside>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
const ORDER = DATA.map(d => d.id);
const $ = (s, r) => (r || document).querySelector(s);
const sheet = $("[data-sheet]"), scrim = $("[data-scrim]");
const body = $("[data-sheet-body]");
let current = null, lastFocus = null;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function open(id, push) {
  const d = DATA.find(x => x.id === id);
  if (!d) return;
  current = id;
  lastFocus = lastFocus || document.activeElement;
  $("[data-sheet-kicker]").textContent = d.id + " · " + d.name;
  $("[data-sheet-title]").textContent = d.id + " — " + d.name;
  $("[data-sheet-q]").textContent = d.question;
  const pull = d.quote ? '<p class="pull"><span>' + QUOTE_LABEL + '</span>“' + d.quote + '”</p>' : "";
  const tag = d.ex.i ? "live" : "static";
  body.innerHTML =
    '<div class="example hero"><h4>' + d.ex.t + '<span class="tag ' + tag + '">' + (d.ex.i ? "live example" : "static illustration") + '</span></h4>' + d.ex.h + "</div>" +
    pull +
    '<p class="decides"><b>' + d.id + ' decides.</b> ' + d.parts.Decides + '</p>' +
    '<div class="cols"><div class="col">' +
    '<div class="srow"><div class="k">Questions</div><div class="v">' + d.parts.Questions + '</div></div>' +
    '<div class="srow"><div class="k">Default</div><div class="v">' + d.parts.Default + '</div></div>' +
    '</div><div class="col compact">' +
    '<div class="srow"><div class="k">Verifies</div><div class="v">' + d.parts.Verifies + '</div></div>' +
    '<div class="srow"><div class="k">Reference</div><div class="v">' + d.parts.Reference + '</div></div>' +
    '<div class="srow"><div class="k">Layer</div><div class="v">' + d.parts.Layer + '</div></div>' +
    '</div></div>';
  $("[data-pos]").textContent = (ORDER.indexOf(id) + 1) + " / " + ORDER.length;
  sheet.hidden = false;
  requestAnimationFrame(() => { sheet.classList.add("show"); scrim.classList.add("show"); });
  if (push !== false) history.replaceState(null, "", "#" + id);
  initWidgets(body, d.id);
  if (!reduced) {
    if (d.id === "F22") { const rr = body.querySelector('[data-w="replay"]'); if (rr) rr.click(); }
    if (d.id === "F10") { const mm = body.querySelector('[data-w="motion"][data-d="320"]'); if (mm) setTimeout(() => mm.click(), 350); }
  }
  $("[data-sheet-title]").focus({ preventScroll: true });
  document.addEventListener("keydown", trapKeys);
}
function close(pop) {
  if (!current) return;
  current = null;
  sheet.classList.remove("show"); scrim.classList.remove("show");
  document.removeEventListener("keydown", trapKeys);
  setTimeout(() => { sheet.hidden = true; }, reduced ? 0 : 340);
  if (pop !== false) history.replaceState(null, "", location.pathname);
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
function trapKeys(e) {
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key !== "Tab") return;
  const f = sheet.querySelectorAll("button, input, select, [tabindex], a[href]");
  const list = [...f].filter(el => !el.disabled && el.offsetParent !== null);
  if (!list.length) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function step(dir) {
  const i = ORDER.indexOf(current);
  const n = (i + dir + ORDER.length) % ORDER.length;
  open(ORDER[n]);
}
document.addEventListener("click", e => {
  const opener = e.target.closest("[data-open]");
  if (opener) { open(opener.getAttribute("data-open")); return; }
  if (e.target.closest("[data-close]") || e.target === scrim) { close(); return; }
  if (e.target.closest("[data-prev]")) { step(-1); return; }
  if (e.target.closest("[data-next]")) { step(1); return; }
});
if (location.hash) {
  const id = location.hash.slice(1).toUpperCase();
  if (ORDER.includes(id)) open(id, false);
  else if (id.startsWith("BAND-")) document.getElementById(id.toLowerCase())?.scrollIntoView();
}
addEventListener("hashchange", () => {
  const id = location.hash.slice(1).toUpperCase();
  if (ORDER.includes(id) && id !== current) open(id, false);
  else if (!ORDER.includes(id)) close(false);
});

 document.documentElement.classList.add("js");
if (matchMedia("(prefers-reduced-motion: reduce)").matches) document.querySelectorAll("svg").forEach(sv => { if (sv.pauseAnimations) sv.pauseAnimations(); });
// ---- scroll progress ring + section progress in nav ----
const ring = $("[data-ring]");
const bands = [...document.querySelectorAll("[data-band]")];
const navAs = [...document.querySelectorAll("[data-nav]")];
let ticking = false;
function onScroll() {
  if (ticking) return; ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const h = document.documentElement;
    const p = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
    ring.setAttribute("stroke-dashoffset", String(62.8 * (1 - p)));
    let cur = -1;
    bands.forEach((b, i) => { if (b.getBoundingClientRect().top < innerHeight * 0.4) cur = i; });
    navAs.forEach((a, i) => {
      a.classList.toggle("on", i === cur);
      a.classList.toggle("done", i < cur);
      const b = bands[i], r = b.getBoundingClientRect();
      const seen = Math.min(1, Math.max(0, (innerHeight * 0.4 - r.top) / Math.max(1, r.height)));
      a.querySelector(".nprog span").style.width = (seen * 100).toFixed(1) + "%";
    });
  });
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();
 // ---- reveal each section once ----
 const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.12 });
 bands.forEach(b => io.observe(b));
 // ---- ticking "as of" stamps in Truth visuals ----
 // ---- ticking stamps, aging loop, byte counter ----
 let tickN = 0;
 if (!reduced) setInterval(() => {
   tickN++;
   const t = new Date().toISOString().slice(11, 19) + "Z";
   document.querySelectorAll("[data-tick]").forEach(el => { el.textContent = "as of " + t; });
   const age = tickN % 51;
   const band = age <= 20 ? "fresh" : age <= 45 ? "aging — labelled + dimmed" : "STALE — banner";
   document.querySelectorAll("[data-age]").forEach(el => { el.textContent = "as of " + t + " · " + age + " min · " + band + " — sample"; });
   document.querySelectorAll("[data-bytes]").forEach(el => { el.textContent = (38 + (tickN % 30) / 10).toFixed(1) + " MB/d"; });
 }, 1000);

// ---- widgets ----
function lum(hex) {
  const c = hex.replace("#", "");
  const v = [0, 2, 4].map(i => { const x = parseInt(c.slice(i, i + 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)); }
const STATES = ["default", "hover", "focus-visible", "pressed", "selected", "disabled", "loading / skeleton", "empty", "error", "stale", "partial", "offline", "just-updated"];
const SEV = { P1: "Page now — call the owner. Loud, breaks quiet hours.", P2: "Banner + push — act today. Cause + next action named.", P3: "Toast + badge — act this week. Auto-dismiss 6 s, kept in the log.", P4: "Digest only — read Friday. Never a red number without a job." };
function initWidgets(root, id) {
  const q = s => root.querySelector('[data-w="' + s + '"]');
  const sample = v => v; // values here are labelled sample in the surrounding copy
  if (id === "F0") {
    const inp = q("verdict"), out = q("verdictOut");
    const render = blurred => { out.innerHTML = ""; out.textContent = inp.value || "(empty — fails the glance test)"; out.style.filter = blurred ? "blur(3px)" : "none"; };
    inp.addEventListener("input", () => render(false));
    q("verdictBlur").addEventListener("click", () => { render(true); setTimeout(() => render(false), 1600); });
    render(false);
  }
  if (id === "F1" || id === "F11") {
    const key = id === "F1" ? "age" : "stale";
    const slider = q(key), out = q(key === "age" ? "ageOut" : "staleOut");
    const render = () => {
      const m = +slider.value;
      const band = m <= 20 ? ["fresh — sample", "stale-ok"] : m <= 45 ? ["aging — labelled + dimmed (sample)", "stale-warn"] : ["STALE — banner: producer snapshot 45+ min old, owner: data tick (sample)", "stale-bad"];
      out.className = "ex-out " + band[1];
      out.textContent = "as of 2026-11-19T01:55Z · age " + m + " min · " + band[0];
    };
    slider.addEventListener("input", render); render();
  }
  if (id === "F2") {
    const out = q("hashOut");
    root.querySelectorAll('[data-w="hash"]').forEach(b => b.addEventListener("click", () => {
      location.hash = b.getAttribute("data-h"); out.textContent = "Current hash: " + location.hash + " — share it, it replays this view.";
    }));
  }
  if (id === "F3") {
    const slider = q("frame"), frame = q("frameOut");
    const render = () => {
      frame.style.maxWidth = slider.value + "px";
      const w = +slider.value;
      const bp = w < 480 ? "phone · stacked" : w < 700 ? "tablet · 2-col" : "desktop · 12-col";
      frame.querySelector(".ex-frame-verdict").textContent = "9 of 10 services working · " + bp;
      frame.querySelector(".ex-frame-cards").style.gridTemplateColumns = w < 480 ? "1fr" : "repeat(3,1fr)";
    };
    slider.addEventListener("input", render); render();
  }
  if (id === "F4") {
    const slider = q("type"), out = q("typeOut");
    const render = () => { out.style.fontSize = slider.value + "px"; out.style.fontVariantNumeric = "tabular-nums"; };
    slider.addEventListener("input", render); render();
  }
  if (id === "F5") {
    const fg = q("fg"), bg = q("bgc"), out = q("contrastOut");
    const render = () => {
      const r = ratio(fg.value, bg.value);
      out.textContent = "Sample " + fg.value + " on " + bg.value + " → " + r.toFixed(2) + ":1 — " + (r >= 4.5 ? "PASS AA" : r >= 3 ? "large text only" : "FAIL");
      out.className = "ex-out " + (r >= 4.5 ? "stale-ok" : r >= 3 ? "stale-warn" : "stale-bad");
    };
    fg.addEventListener("change", render); bg.addEventListener("change", render); render();
  }
  if (id === "F6") {
    const out = q("picOut"); let pic = true;
    const render = () => {
      out.innerHTML = pic
        ? "<div style='display:flex;gap:4px;font-size:22px' aria-label='8 of 10 filled'>🤖🤖🤖🤖🤖🤖🤖🤖▫️▫️</div><div class='ex-sub'>8 of 10 filled — share as pictograms, not digits (sample).</div>"
        : "<b>80%</b> <span class='ex-sub'>bare digit — no comparison, no band (sample).</span>";
    };
    q("picToggle").addEventListener("click", () => { pic = !pic; render(); }); render();
  }
  if (id === "F7") {
    const svg = q("chartOut");
    const draw = c => {
      if (c === "trend") svg.innerHTML = "<line x1='0' y1='90' x2='300' y2='90' stroke='#e4e7ec'/><rect x='10' y='30' width='280' height='30' fill='#EDF0FF'/><polyline points='10,70 80,60 150,64 220,40 290,44' fill='none' stroke='#2B4FFF' stroke-width='3'/><text x='12' y='22' font-size='10' fill='#5b6472'>target band + value + stamp (sample)</text>";
      if (c === "share") svg.innerHTML = "<rect x='10' y='15' width='200' height='16' fill='#2B4FFF'/><rect x='10' y='40' width='120' height='16' fill='#8A93A3'/><rect x='10' y='65' width='60' height='16' fill='#D92D20'/><text x='220' y='28' font-size='10' fill='#111318'>64% bots (sample)</text>";
      if (c === "status") svg.innerHTML = "<g font-size='20'><text x='10' y='60'>⬤⬤⬤⬤⬤⬤⬤⬤⬤◯</text></g><text x='10' y='90' font-size='10' fill='#5b6472'>9 of 10 services working (sample)</text>";
    };
    root.querySelectorAll('[data-w="chart"]').forEach(b => b.addEventListener("click", () => draw(b.getAttribute("data-c"))));
    draw("trend");
  }
  if (id === "F8") {
    const out = q("stateOut"), name = q("stateName"); let i = 0;
    const render = () => { out.textContent = "Service card"; out.style.opacity = ["loading / skeleton", "disabled", "stale", "offline"].includes(STATES[i]) ? ".45" : "1"; name.textContent = "State " + (i + 1) + " / 13: " + STATES[i]; };
    q("statePrev").addEventListener("click", () => { i = (i + STATES.length - 1) % STATES.length; render(); });
    q("stateNext").addEventListener("click", () => { i = (i + 1) % STATES.length; render(); });
    render();
  }
  if (id === "F9") {
    const out = q("ackOut");
    q("ack").addEventListener("click", () => {
      const t = performance.now();
      out.textContent = "Acknowledged in " + Math.max(1, Math.round(performance.now() - t)) + " ms — working…";
      setTimeout(() => { out.textContent = "Done. Change published + logged (sample)."; }, 900);
    });
  }
  if (id === "F10") {
    const dot = q("dot");
    root.querySelectorAll('[data-w="motion"]').forEach(b => b.addEventListener("click", () => {
      const d = +b.getAttribute("data-d");
      dot.style.transition = "none"; dot.style.left = "8px";
      void dot.offsetWidth;
      dot.style.transition = "left " + d + "ms cubic-bezier(0.2,0,0,1)";
      dot.style.left = "calc(100% - 26px)";
    }));
  }
  if (id === "F12") {
    const out = q("sevOut");
    root.querySelectorAll('[data-w="sev"]').forEach(b => b.addEventListener("click", () => { out.textContent = b.getAttribute("data-s") + ": " + SEV[b.getAttribute("data-s")] + " (sample)"; }));
  }
  if (id === "F13") {
    const log = q("auditLog");
    q("send").addEventListener("click", () => {
      const tr = document.createElement("tr");
      const t = new Date().toISOString().slice(11, 19) + "Z";
      tr.innerHTML = "<td>owner (approver)</td><td>approve + send</td><td>" + t + "</td>";
      log.appendChild(tr);
    });
  }
  if (id === "F17") {
    const out = q("timeOut");
    root.querySelectorAll('[data-w="time"]').forEach(b => b.addEventListener("click", () => {
      const m = +b.getAttribute("data-m");
      out.textContent = m < 1440 ? m >= 60 ? Math.round(m / 60) + " h ago (relative)" : m + " min ago (relative)" : "2026-11-17T01:55Z (absolute UTC · hover for local) — sample";
    }));
  }
  if (id === "F18") {
    const inp = q("copy"), out = q("copyOut");
    const banned = ["revolutionary", "leverage", "synergy", "disrupt", "cutting-edge", "game-changer"];
    const render = () => {
      const hits = banned.filter(w => inp.value.toLowerCase().includes(w));
      out.textContent = hits.length ? "Flagged: " + hits.join(", ") + " — rewrite plainly." : "Clean: verdict-first, short, no naked claims.";
      out.className = "ex-out " + (hits.length ? "stale-warn" : "stale-ok");
    };
    inp.addEventListener("input", render); render();
  }
  if (id === "F19") {
    const inp = q("secret"), out = q("secretOut");
    const render = () => {
      const hit = /(sk-live|api_key|bearer|-----BEGIN|token\\s*=)/i.test(inp.value);
      out.textContent = hit ? "BLOCKED: token-shaped value in markup — move to env, never the bundle." : "Clean: no token shapes detected.";
      out.className = "ex-out " + (hit ? "stale-bad" : "stale-ok");
    };
    inp.addEventListener("input", render); render();
  }
  if (id === "F22") {
    const tl = q("timeline");
    const evs = ["01:55:02 tick complete — 30 foundations, 0 refused (sample)", "01:55:20 F11 aged to aging — labelled + dimmed (sample)", "01:56:01 deploy ab12cd3 — rollback ready (sample)", "01:57:44 P2 banner — 2 services idle need a named cause (sample)", "01:58:10 owner accept — F9 drill-in panel (sample)"];
    q("replay").addEventListener("click", () => {
      tl.innerHTML = evs.map(e => '<div class="ex-ev">' + e + "</div>").join("");
      const nodes = [...tl.children];
      nodes.forEach((n, i) => setTimeout(() => n.classList.add("lit"), reduced ? 0 : 250 * (i + 1)));
    });
  }
  if (id === "F24") {
    const out = q("overlayOut");
    root.querySelectorAll('[data-w="overlay"]').forEach(b => b.addEventListener("click", () => {
      out.style.borderColor = b.getAttribute("data-a");
      out.querySelector("b").style.color = b.getAttribute("data-a");
    }));
  }
  if (id === "F28") {
    const out = q("identOut");
    root.querySelectorAll('[data-w="ident"]').forEach(b => b.addEventListener("click", () => {
      const a = b.getAttribute("data-a");
      out.querySelector(".ex-kicker").style.color = a;
      out.querySelector("b").style.color = a;
    }));
  }
}
</script>
</body>
</html>
`;

writeFileSync(outPath, html);
console.log("wrote " + outPath + " (" + rows.length + " cards, " + interactiveCount + " interactive, " + unverified + " unverified)");
